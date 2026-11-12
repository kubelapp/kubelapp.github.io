-- 46 · Eventos SIGMA (12/11/2026)
-- SIGMA paga aparte («eventos») las URGENCIAS y las VISITAS FALLIDAS. Se mandan al delegado de zona
-- en un Excel por cuenta (VLL / PAL) antes del día 20; él las mete en la facturación siguiente.
-- Periodo de un envío = del 20 del mes anterior al 19 del mes del envío (periodo '2026-12' = 20/11–19/12).
-- Reglas (todo automático, solo SIGMA, compañía 1):
--   · URGENCIA: servicio urgente que pasa a «cerrado». Día de visita = primera visita HECHA (null si no hay;
--     el admin la puede poner a mano). Periodo según la fecha de cierre de SIGMA.
--     Si se reabre o deja de ser urgente → la línea se quita (salvo enviada al delegado o con fecha a mano).
--   · VISITA FALLIDA: visita que el operario marca «No se pudo realizar» (asignaciones.estado = 'no_realizado').
--     Día de visita = la fecha de esa visita; periodo según ese día. Si la visita cambia de estado o se borra → se quita
--     (salvo enviada).
-- Solo admin (como Facturación). En tiempo real.

create table if not exists public.eventos_sigma (
  id             uuid primary key default gen_random_uuid(),
  tipo           text not null check (tipo in ('URGENCIA', 'VISITA FALLIDA')),
  parte_id       uuid references public.partes(id) on delete set null,
  asignacion_id  uuid references public.asignaciones(id) on delete set null,
  servicio       text,
  cuenta         text,                 -- VLL / PAL
  direccion      text,
  poblacion      text,
  operario       text,
  fecha_visita   date,
  fecha_manual   boolean not null default false,   -- el admin escribió el día: la BD ya no lo cambia
  fecha_ref      date,                 -- cierre (urgencia) o día de la visita (fallida): decide el periodo
  periodo        text,                 -- 'AAAA-MM' = mes en que se manda al delegado
  aviso          text,                 -- lo pone la BD (p. ej. «SIN VISITA HECHA EN KUBEL»)
  comentario     text,
  origen         text not null default 'auto' check (origen in ('auto', 'manual')),
  enviado_en     timestamptz,          -- marcado como mandado al delegado
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create unique index if not exists eventos_sigma_urg_uni on public.eventos_sigma (parte_id) where tipo = 'URGENCIA' and parte_id is not null;
create unique index if not exists eventos_sigma_asig_uni on public.eventos_sigma (asignacion_id) where asignacion_id is not null;
create index if not exists eventos_sigma_periodo_idx on public.eventos_sigma (periodo);

alter table public.eventos_sigma enable row level security;
drop policy if exists "eventos solo admin" on public.eventos_sigma;
create policy "eventos solo admin" on public.eventos_sigma for all using (public.es_admin()) with check (public.es_admin());

-- Periodo de envío: del 20 en adelante cuenta para el mes siguiente
create or replace function public.evento_periodo(f date) returns text
language sql immutable as $$
  select case when f is null then null
              when extract(day from f) >= 20 then to_char((date_trunc('month', f) + interval '1 month')::date, 'YYYY-MM')
              else to_char(f, 'YYYY-MM') end
$$;

-- Fecha y periodo coherentes al escribir (también lo que cambia el admin)
create or replace function public.eventos_sigma_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.fecha_visita is distinct from old.fecha_visita and coalesce(current_setting('kubel.eventos_bd', true), '') <> '1' then
    new.fecha_manual := new.fecha_visita is not null;   -- lo escribió el admin
  end if;
  -- Una línea a mano sin fecha de referencia toma la de la visita
  if new.fecha_ref is null then new.fecha_ref := coalesce(new.fecha_visita, current_date); end if;
  if tg_op = 'INSERT' or new.fecha_ref is distinct from old.fecha_ref or new.periodo is null then
    if tg_op = 'INSERT' and new.periodo is not null then null;   -- periodo puesto a mano al crear
    else new.periodo := public.evento_periodo(new.fecha_ref); end if;
  end if;
  new.actualizado_en := now();
  return new;
end; $$;
create or replace trigger eventos_sigma_antes before insert or update on public.eventos_sigma
  for each row execute function public.eventos_sigma_antes();

-- URGENCIA de un servicio: crea, actualiza o quita su línea
create or replace function public.evento_urgencia(p_parte uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p public.partes; v_primera date; v_op text; v_cierre date;
begin
  perform set_config('kubel.eventos_bd', '1', true);
  select * into p from public.partes where id = p_parte;
  if not found or p.compania_id <> 1 or not coalesce(p.urgente, false) or p.estado <> 'cerrado' then
    delete from public.eventos_sigma
     where parte_id = p_parte and tipo = 'URGENCIA' and origen = 'auto' and enviado_en is null and not fecha_manual;
    perform set_config('kubel.eventos_bd', '', true);
    return;
  end if;
  select a.fecha, pf.nombre into v_primera, v_op
    from public.asignaciones a left join public.perfiles pf on pf.id = a.operario_id
   where a.parte_id = p.id and a.estado = 'hecho'
   order by a.fecha, a.hora nulls last limit 1;
  v_cierre := coalesce(public.fecha_cierre_sigma(p.sigma_ficha), (now() at time zone 'Europe/Madrid')::date);
  insert into public.eventos_sigma as e (tipo, parte_id, servicio, cuenta, direccion, poblacion, operario, fecha_visita, fecha_ref, aviso)
  values ('URGENCIA', p.id, p.numero_servicio, p.sigma_cuenta, p.direccion, p.poblacion, v_op, v_primera, v_cierre,
          case when v_primera is null then 'SIN VISITA HECHA EN KUBEL' end)
  on conflict (parte_id) where tipo = 'URGENCIA' and parte_id is not null do update set
    servicio = excluded.servicio, cuenta = excluded.cuenta, direccion = excluded.direccion, poblacion = excluded.poblacion,
    operario = case when e.fecha_manual then e.operario else excluded.operario end,
    fecha_visita = case when e.fecha_manual then e.fecha_visita else excluded.fecha_visita end,
    aviso = case when e.fecha_manual then null else excluded.aviso end,
    fecha_ref = case when e.enviado_en is not null then e.fecha_ref else excluded.fecha_ref end;
  perform set_config('kubel.eventos_bd', '', true);
end; $$;

-- VISITA FALLIDA de una visita: crea, actualiza o quita su línea
create or replace function public.evento_fallida(p_asig uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  a public.asignaciones; p public.partes; v_op text;
begin
  perform set_config('kubel.eventos_bd', '1', true);
  select * into a from public.asignaciones where id = p_asig;
  if found then select * into p from public.partes where id = a.parte_id; end if;
  if a.id is null or a.estado <> 'no_realizado' or p.id is null or p.compania_id <> 1 then
    delete from public.eventos_sigma
     where asignacion_id = p_asig and origen = 'auto' and enviado_en is null;
    perform set_config('kubel.eventos_bd', '', true);
    return;
  end if;
  select nombre into v_op from public.perfiles where id = a.operario_id;
  insert into public.eventos_sigma as e (tipo, parte_id, asignacion_id, servicio, cuenta, direccion, poblacion, operario, fecha_visita, fecha_ref)
  values ('VISITA FALLIDA', p.id, a.id, p.numero_servicio, p.sigma_cuenta, p.direccion, p.poblacion, v_op, a.fecha, a.fecha)
  on conflict (asignacion_id) where asignacion_id is not null do update set
    servicio = excluded.servicio, cuenta = excluded.cuenta, direccion = excluded.direccion, poblacion = excluded.poblacion,
    operario = excluded.operario,
    fecha_visita = case when e.fecha_manual then e.fecha_visita else excluded.fecha_visita end,
    fecha_ref = case when e.enviado_en is not null then e.fecha_ref else excluded.fecha_ref end;
  perform set_config('kubel.eventos_bd', '', true);
end; $$;

-- Disparadores
create or replace function public.partes_eventos() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.compania_id = 1 or old.compania_id = 1 then perform public.evento_urgencia(new.id); end if;
  return null;
end; $$;
create or replace trigger partes_eventos after update of estado, urgente, compania_id on public.partes
  for each row when (new.estado is distinct from old.estado or new.urgente is distinct from old.urgente or new.compania_id is distinct from old.compania_id)
  execute function public.partes_eventos();

create or replace function public.asignaciones_eventos() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform set_config('kubel.eventos_bd', '1', true);
    delete from public.eventos_sigma where asignacion_id = old.id and origen = 'auto' and enviado_en is null;
    perform set_config('kubel.eventos_bd', '', true);
    perform public.evento_urgencia(old.parte_id);
    return old;
  end if;
  perform public.evento_fallida(new.id);
  -- La primera visita hecha de una urgencia cerrada puede cambiar
  if exists (select 1 from public.eventos_sigma where parte_id = new.parte_id and tipo = 'URGENCIA') then
    perform public.evento_urgencia(new.parte_id);
  end if;
  return null;
end; $$;
create or replace trigger asignaciones_eventos after insert or update of estado, fecha, hora, operario_id on public.asignaciones
  for each row execute function public.asignaciones_eventos();
create or replace trigger asignaciones_eventos_borrar before delete on public.asignaciones
  for each row execute function public.asignaciones_eventos();

-- Tiempo real
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'eventos_sigma') then
    alter publication supabase_realtime add table public.eventos_sigma;
  end if;
end $$;

-- Relleno inicial con lo que ya hay
select public.evento_urgencia(id) from public.partes where compania_id = 1 and urgente and estado = 'cerrado';
select public.evento_fallida(a.id) from public.asignaciones a join public.partes p on p.id = a.parte_id
 where p.compania_id = 1 and a.estado = 'no_realizado';
