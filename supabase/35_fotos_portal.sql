-- KUBEL · SQL 35 (06/11/2026) — Fotos de SIGMA traídas a KUBEL
-- El robot sigma-fotos (?importar=1) lee la pestaña «Fotografías» del portal de cada servicio SIGMA,
-- apunta cada foto en fotos_portal y descarga la imagen a Storage (bucket fotos, carpeta portal/<parte>/).
-- Solo lectura en el portal. La oficina las ve en la ficha del servicio (pestaña «📷 Fotos SIGMA»).
-- Las que subió la propia KUBEL (fotos.sigma_resultado «… · foto NNN») no se descargan otra vez:
-- quedan como estado 'kubel' con la ruta de la foto original.

create table if not exists public.fotos_portal (
  id uuid primary key default gen_random_uuid(),
  parte_id uuid not null references public.partes(id) on delete cascade,
  codigo text not null,                 -- código de la foto en SIGMA
  momento text,                         -- antes / despues / ?
  fecha_foto date,                      -- «Fecha en la que realizó la foto»
  habitacion text, afectado text, comentario text, tamano text,
  enlace text,                          -- pdf.php?… del portal
  ruta text,                            -- ruta en Storage (bucket fotos)
  mime text, bytes int,
  foto_id uuid references public.fotos(id) on delete set null, -- si la subió KUBEL
  estado text not null default 'pendiente'
    check (estado in ('pendiente','descargada','kubel','error','retirada')),
  intentos int not null default 0,
  intentado_en timestamptz,
  error text,
  descargada_en timestamptz,
  creado_en timestamptz not null default now(),
  unique (parte_id, codigo)
);
create index if not exists fotos_portal_pend on public.fotos_portal (creado_en) where estado = 'pendiente';
create index if not exists fotos_portal_parte on public.fotos_portal (parte_id);

alter table public.fotos_portal enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'fotos_portal' and policyname = 'oficina ve fotos del portal') then
    create policy "oficina ve fotos del portal" on public.fotos_portal for select to authenticated using (public.es_oficina());
  end if;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.fotos_portal;
exception when duplicate_object then null; end $$;

alter table public.partes
  add column if not exists sigma_fotos_importar_en timestamptz,     -- última lectura de la pestaña para traer fotos
  add column if not exists sigma_fotos_importar_pedir timestamptz,  -- «↻ Traer de SIGMA» de la oficina
  add column if not exists sigma_fotos_importar_error text;

-- Llama al robot en modo importar solo si queda algo por hacer (o si se fuerza)
create or replace function privado.lanzar_fotos_importar(forzar boolean default false) returns void
language plpgsql security definer set search_path = public, privado, extensions as $$
declare s text;
begin
  if not forzar
     and not exists (select 1 from public.fotos_portal where estado = 'pendiente')
     and not exists (select 1 from public.partes where sigma_cuenta is not null and (
           sigma_fotos_importar_pedir is not null or sigma_fotos_importar_en is null
           or (estado not in ('cerrado','anulado') and sigma_fotos_importar_en < now() - interval '12 hours'))) then return; end if;
  select valor into s from privado.ajustes where clave = 'notif_secreto';
  perform net.http_post(
    url := 'https://hytmotuhdxbzpustnlzx.supabase.co/functions/v1/sigma-fotos?importar=1',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kubel-secreto', s),
    timeout_milliseconds := 150000);
end $$;

-- «↻ Traer de SIGMA» desde la ficha
create or replace function public.traer_fotos_portal(parte uuid) returns void
language plpgsql security definer set search_path = public, privado as $$
begin
  if not public.es_oficina() then raise exception 'Solo la oficina'; end if;
  update public.partes set sigma_fotos_importar_pedir = now() where id = parte and sigma_cuenta is not null;
  perform privado.lanzar_fotos_importar(true);
end $$;
revoke all on function public.traer_fotos_portal(uuid) from public, anon;
grant execute on function public.traer_fotos_portal(uuid) to authenticated;

-- Cada 5 min de 05 a 19 h UTC (minutos 1, 6, 11…; no coincide con kubel-sigma-fotos en los pares)
select cron.schedule('kubel-sigma-fotos-importar', '1-56/5 5-19 * * *', 'select privado.lanzar_fotos_importar()');
