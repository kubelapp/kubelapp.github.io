-- KUBEL · SQL 43 · TASHO (portal S.I.C.I.) — 11/11/2026
-- Servicios de TASHO volcados por el robot `tasho-sync` (compañía 3).
-- Nº del servicio = nº de expediente de la compañía final (Generali, Sigma, AXA…).
-- Un expediente puede tener varios partes de TASHO (uno por gremio/cita) → tasho_partes.
-- APLICADO el 11/11/2026 (todo el archivo). Robot: supabase/functions/tasho-sync (v1.1).

-- 1) Origen «tasho»
alter table public.partes drop constraint if exists partes_origen_check;
alter table public.partes add constraint partes_origen_check check (origen = any (array['manual','sigma','onred','tasho']));

-- 2) Columnas (solo las escribe el robot, salvo tasho_pedir)
alter table public.partes
  add column if not exists tasho_id_exp      text,          -- «Id Exp.» de TASHO
  add column if not exists tasho_empresa     text,          -- Generali, Sigma, AXA… (compañía final)
  add column if not exists tasho_estado      text,          -- no_informado / pendiente_cita / informado / retirado
  add column if not exists tasho_partes      jsonb,         -- [{parte, fecha, franja, tramitador, primera_cita, bandeja, lista}]
  add column if not exists tasho_datos       jsonb,         -- último bloque leído (titular, dirección, teléfonos, descripción, trabajos…)
  add column if not exists tasho_mensajes    jsonb,         -- mensajes con la tramitación [{id, parte, texto, autor, fecha, de: tasho|kubel}]
  add column if not exists tasho_cita        timestamptz,   -- próxima cita (la más cercana) que marca TASHO
  add column if not exists tasho_importe     numeric(10,2), -- suma de «Trabajos realizados» (sin IVA)
  add column if not exists tasho_trabajos    jsonb,         -- líneas de «Trabajos realizados» [{fecha, codigo, texto, precio, cantidad, total}]
  add column if not exists tasho_visto_en    timestamptz,   -- última vez que salió en «no informados» / «pendiente cita»
  add column if not exists tasho_cierre      jsonb,         -- {auto, motivo, en, estado_antes}
  add column if not exists tasho_pedir       boolean not null default false, -- «↻ Comprobar en TASHO»
  add column if not exists tasho_comprobado_en timestamptz;

alter table public.partes drop constraint if exists partes_tasho_estado_check;
alter table public.partes add constraint partes_tasho_estado_check
  check (tasho_estado is null or tasho_estado = any (array['no_informado','pendiente_cita','informado','retirado']));

create index if not exists partes_tasho_abiertos on public.partes (compania_id) where origen = 'tasho';

-- 3) Registro de pasadas del robot
create table if not exists public.tasho_sincronizaciones (
  id bigint generated always as identity primary key,
  inicio timestamptz not null default now(),
  fin timestamptz,
  ok boolean,
  resumen jsonb,
  error text
);
alter table public.tasho_sincronizaciones enable row level security;
drop policy if exists "oficina y admin leen tasho_sincronizaciones" on public.tasho_sincronizaciones;
create policy "oficina y admin leen tasho_sincronizaciones" on public.tasho_sincronizaciones
  for select to authenticated using (exists (select 1 from public.perfiles p where p.id = auth.uid() and p.rol in ('oficina','admin')));

-- 4) Importe de «Trabajos realizados» → Facturación
--    Solo en líneas no liquidadas cuyo importe esté vacío o venga de TASHO (nunca pisa lo escrito a mano).
create or replace function public.facturacion_por_tasho()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.origen <> 'tasho' or new.estado = 'anulado' or new.tasho_importe is null then return null; end if;
  update public.facturacion f set
    importe = new.tasho_importe,
    importe_origen = 'tasho',
    importe_nota = case when f.importe is not null and f.importe <> new.tasho_importe
                        then 'Trabajos realizados en TASHO: de ' || public.euros(f.importe) || ' a ' || public.euros(new.tasho_importe)
                        else f.importe_nota end,
    importe_leido_en = now()
  where f.parte_id = new.id and not f.liquidado
    and (f.importe is null or f.importe_origen = 'tasho')
    and f.importe is distinct from new.tasho_importe;
  return null;
end $$;

create or replace trigger partes_facturacion_tasho
  after update of estado, tasho_importe on public.partes
  for each row when (new.origen = 'tasho') execute function public.facturacion_por_tasho();

-- 5) «↻ Comprobar en TASHO» desde la ficha (oficina): marca y llama al robot al momento
create or replace function public.comprobar_tasho(p_parte uuid)
returns void language plpgsql security definer set search_path to 'public','privado' as $$
begin
  if not exists (select 1 from public.perfiles p where p.id = auth.uid() and p.rol in ('oficina','admin')) then
    raise exception 'Solo la oficina puede comprobar en TASHO';
  end if;
  update public.partes set tasho_pedir = true where id = p_parte and origen = 'tasho';
  if not found then raise exception 'Este servicio no es de TASHO'; end if;
  perform privado.lanzar_tasho('{}'::jsonb);
end $$;
revoke all on function public.comprobar_tasho(uuid) from public, anon;
grant execute on function public.comprobar_tasho(uuid) to authenticated;

-- 6) Lanzador (pg_net → Edge Function con la cabecera secreta)
create or replace function privado.lanzar_tasho(p jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path to 'public','privado','extensions' as $$
declare s text; i bigint;
begin
  select valor into s from privado.ajustes where clave = 'notif_secreto';
  select net.http_post(
    url := 'https://hytmotuhdxbzpustnlzx.supabase.co/functions/v1/tasho-sync',
    params := coalesce(p, '{}'::jsonb), body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kubel-secreto', s),
    timeout_milliseconds := 150000) into i;
  return i;
end $$;
revoke all on function privado.lanzar_tasho(jsonb) from public, anon, authenticated;

-- 7) Robot cada 15 min de 7:00 a 21:00 (hora de Madrid; pg_cron va en UTC → 5–20 UTC y la función filtra la hora)
create or replace function privado.lanzar_tasho_cron() returns void
language plpgsql security definer set search_path to 'public','privado' as $$
declare h int := extract(hour from now() at time zone 'Europe/Madrid');
begin
  if h >= 7 and h < 21 then perform privado.lanzar_tasho('{}'::jsonb); end if;
end $$;
revoke all on function privado.lanzar_tasho_cron() from public, anon, authenticated;
select cron.unschedule('kubel-tasho-sync') where exists (select 1 from cron.job where jobname = 'kubel-tasho-sync');
select cron.schedule('kubel-tasho-sync', '3,18,33,48 5-20 * * *', 'select privado.lanzar_tasho_cron()');

-- 8) (11/11, oficina v2.67) Tiempo real del indicador «TASHO hace…» de la cabecera
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'tasho_sincronizaciones') then
    alter publication supabase_realtime add table public.tasho_sincronizaciones;
  end if; end $$;
