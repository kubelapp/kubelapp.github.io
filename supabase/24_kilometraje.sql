-- =====================================================================
--  24 · Kilometraje (04/11/2026) · panel admin → página «Kilometraje»
--  Una línea por operario y día con visitas en Planificación:
--    Valladolid (km 0) → visitas del día en orden (hora, orden) → vuelta a Valladolid.
--  Distancias por carretera entre PUEBLOS (no direcciones): dentro del mismo
--  pueblo (también Valladolid capital) cuenta 0. Cuentan todas las visitas
--  planificadas del día (pendiente, hecho y no realizado: el operario se desplazó).
--  El cálculo lo hace la Edge Function `kilometraje` (pueblos con Nominatim /
--  OpenStreetMap; distancias con OSRM), guardados aquí para no repetirlos.
--  Precio por km: ALEJANDRO 0,15 €; resto 0,20 € (km_tarifas). El precio se
--  guarda en cada línea al calcularla.
--  El admin puede corregir los km de un día (km_manual + comentario): el robot
--  nunca los pisa.
--  Solo admin (RLS es_admin()); el robot escribe con la service_role.
-- =====================================================================

-- ---------- Pueblos (coordenadas) ----------
create table if not exists public.km_lugares (
  clave        text primary key,              -- p. ej. 'VENTA DE BANOS|34' o 'CP|47130'
  nombre       text not null,                 -- como se muestra
  provincia    text,
  lat          double precision,
  lon          double precision,
  encontrado   text,                          -- lo que devolvió el mapa (para comprobar)
  origen       text,                          -- 'nombre' / 'cp' / 'manual' / 'no_encontrado'
  actualizado_en timestamptz not null default now()
);
alter table public.km_lugares enable row level security;
create policy "admin lee pueblos km" on public.km_lugares for select to authenticated using (public.es_admin());

-- ---------- Distancias por carretera entre dos pueblos (par ordenado a < b) ----------
create table if not exists public.km_distancias (
  a   text not null,
  b   text not null,
  km  numeric(7,1) not null,
  calculado_en timestamptz not null default now(),
  primary key (a, b)
);
alter table public.km_distancias enable row level security;
create policy "admin lee distancias km" on public.km_distancias for select to authenticated using (public.es_admin());

-- ---------- Precio por km ('*' = todos los demás; o el id del operario) ----------
create table if not exists public.km_tarifas (
  clave      text primary key,
  euros_km   numeric(5,3) not null,
  actualizado_en timestamptz not null default now()
);
alter table public.km_tarifas enable row level security;
create policy "admin gestiona tarifas km" on public.km_tarifas for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
insert into public.km_tarifas (clave, euros_km) values ('*', 0.20) on conflict (clave) do nothing;
insert into public.km_tarifas (clave, euros_km)
  select id::text, 0.15 from public.perfiles where upper(nombre) = 'ALEJANDRO' and rol = 'operario'
  on conflict (clave) do nothing;

-- ---------- Kilometraje por operario y día ----------
create table if not exists public.kilometraje (
  id            uuid primary key default gen_random_uuid(),
  operario_id   uuid not null references public.perfiles (id) on delete cascade,
  fecha         date not null,
  operario      text,                         -- nombre (para listar sin cruzar tablas)
  visitas       int not null default 0,
  ruta          jsonb not null default '[]',  -- [{de, a, km}] tramo a tramo
  km            numeric(7,1),                 -- calculado
  km_manual     numeric(7,1),                 -- corrección del admin (manda sobre km)
  comentario    text,
  tarifa        numeric(5,3),                 -- €/km al calcular
  sin_ubicar    int not null default 0,       -- visitas sin pueblo reconocible (no suman)
  calculado_en  timestamptz,
  editado_en    timestamptz,
  unique (operario_id, fecha)
);
alter table public.kilometraje enable row level security;
create policy "admin gestiona kilometraje" on public.kilometraje for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create index if not exists kilometraje_fecha on public.kilometraje (fecha);
alter publication supabase_realtime add table public.kilometraje;

-- ---------- Días que hay que (re)calcular ----------
create table if not exists public.km_pendientes (
  operario_id uuid not null,
  fecha       date not null,
  marcado_en  timestamptz not null default now(),
  primary key (operario_id, fecha)
);
alter table public.km_pendientes enable row level security;   -- sin políticas: solo el robot

create or replace function public.km_marcar(op uuid, f date)
returns void language sql security definer set search_path = public as $$
  insert into public.km_pendientes (operario_id, fecha) values (op, f)
  on conflict (operario_id, fecha) do update set marcado_en = now();
$$;
revoke execute on function public.km_marcar(uuid, date) from public, anon, authenticated;

-- Al crear, cambiar o quitar una visita → ese día (y el anterior si cambió de día u operario)
create or replace function public.asignaciones_km()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('INSERT', 'UPDATE') and new.operario_id is not null and new.fecha is not null then
    perform public.km_marcar(new.operario_id, new.fecha);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.operario_id is not null and old.fecha is not null
     and (tg_op = 'DELETE' or old.operario_id is distinct from new.operario_id or old.fecha is distinct from new.fecha) then
    perform public.km_marcar(old.operario_id, old.fecha);
  end if;
  return null;
end $$;
create or replace trigger asignaciones_km
  after insert or update of operario_id, fecha, hora, orden, parte_id or delete on public.asignaciones
  for each row execute function public.asignaciones_km();

-- Si cambia el pueblo o el código postal de un servicio → los días de sus visitas
create or replace function public.partes_km()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.km_pendientes (operario_id, fecha)
    select distinct operario_id, fecha from public.asignaciones
    where parte_id = new.id and operario_id is not null and fecha is not null
  on conflict (operario_id, fecha) do update set marcado_en = now();
  return null;
end $$;
create or replace trigger partes_km
  after update of poblacion, codigo_postal on public.partes
  for each row when (old.poblacion is distinct from new.poblacion or old.codigo_postal is distinct from new.codigo_postal)
  execute function public.partes_km();

-- ---------- Lanzar el robot (solo si hay días pendientes) ----------
create or replace function privado.lanzar_kilometraje(forzar boolean default false)
returns void language plpgsql security definer set search_path = public, privado, extensions as $$
declare s text;
begin
  if not forzar and not exists (select 1 from public.km_pendientes) then return; end if;
  select valor into s from privado.ajustes where clave = 'notif_secreto';
  perform net.http_post(
    url := 'https://hytmotuhdxbzpustnlzx.supabase.co/functions/v1/kilometraje',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kubel-secreto', s),
    timeout_milliseconds := 150000
  );
end; $$;
revoke execute on function privado.lanzar_kilometraje(boolean) from public, anon, authenticated;

select cron.schedule('kubel-kilometraje', '*/5 * * * *', 'select privado.lanzar_kilometraje()');

-- Botón «Recalcular» del panel admin: marca días (todos o un rango) y lanza el robot
create or replace function public.km_recalcular(desde date default null, hasta date default null)
returns int language plpgsql security definer set search_path = public, privado as $$
declare n int;
begin
  if not public.es_admin() then raise exception 'Solo el administrador'; end if;
  insert into public.km_pendientes (operario_id, fecha)
    select distinct operario_id, fecha from public.asignaciones
    where operario_id is not null and fecha is not null
      and (desde is null or fecha >= desde) and (hasta is null or fecha <= hasta)
  on conflict (operario_id, fecha) do update set marcado_en = now();
  get diagnostics n = row_count;
  perform privado.lanzar_kilometraje(true);
  return n;
end $$;
revoke execute on function public.km_recalcular(date, date) from public, anon;
grant execute on function public.km_recalcular(date, date) to authenticated;

-- Primera carga: todos los días ya planificados
insert into public.km_pendientes (operario_id, fecha)
  select distinct operario_id, fecha from public.asignaciones where operario_id is not null and fecha is not null
on conflict do nothing;
