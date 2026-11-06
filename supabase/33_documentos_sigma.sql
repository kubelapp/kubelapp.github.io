-- =====================================================================
-- KUBEL · 33 · Documentos a SIGMA desde «Pasos SIGMA» → 3 · Documentos (06/11/2026)
-- La oficina elige el tipo (mismo desplegable que el portal + «Albarán»), adjunta el
-- archivo (PDF o imagen, ≤ 3 MB) y pulsa «Enviar a SIGMA». El robot sigma-fotos lo sube:
--   · Albarán        → docservicio.php «Adjuntar albarán» (uno por servicio)
--   · Resto de tipos → docservicio.php «Nuevo Documento» (listatipo = código del portal)
-- Estados como las fotos: null · aprobado · enviando · enviado · error.
-- partes.sigma_docs = lo que hay en el portal { albaran: true|false|null, docs: [...] }.
-- =====================================================================

create table if not exists public.documentos_sigma (
  id uuid primary key default gen_random_uuid(),
  parte_id uuid not null references public.partes(id) on delete cascade,
  tipo_codigo text not null,           -- 'ALB' = albarán; si no, código listatipo del portal
  tipo_nombre text not null,
  comentario text,
  ruta text not null,                  -- bucket fotos: sigma/<parte>/docs/<uuid>.<ext>
  nombre text,                         -- nombre original del archivo
  mime text,
  tamano int,
  subido_por uuid references public.perfiles(id) default auth.uid(),
  creado_en timestamptz not null default now(),
  sigma_estado text check (sigma_estado in ('aprobado','enviando','enviado','error')),
  sigma_resultado text,
  sigma_intentos int not null default 0,
  sigma_aprobado_por uuid references public.perfiles(id),
  sigma_aprobado_en timestamptz,
  sigma_enviado_en timestamptz,
  sigma_actualizado_en timestamptz
);
create index if not exists documentos_sigma_parte on public.documentos_sigma (parte_id);
create index if not exists documentos_sigma_cola on public.documentos_sigma (sigma_estado) where sigma_estado in ('aprobado','enviando');
alter table public.documentos_sigma enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'documentos_sigma' and policyname = 'oficina gestiona documentos sigma') then
    create policy "oficina gestiona documentos sigma" on public.documentos_sigma for all to authenticated
      using (public.es_oficina()) with check (public.es_oficina());
  end if;
end $$;

alter table public.partes add column if not exists sigma_docs jsonb;

-- No se borra un documento mientras se sube
create or replace function privado.docs_proteger_sigma() returns trigger
language plpgsql security definer set search_path = public, privado as $$
begin
  if old.sigma_estado = 'enviando' then raise exception 'Este documento se está subiendo a SIGMA ahora mismo: espera un momento'; end if;
  return old;
end $$;
create or replace trigger documentos_sigma_proteger before delete on public.documentos_sigma
  for each row execute function privado.docs_proteger_sigma();

-- El robot también se lanza si hay documentos en cola
create or replace function privado.lanzar_fotos(forzar boolean default false) returns void
language plpgsql security definer set search_path = public, privado, extensions as $$
declare s text;
begin
  if not forzar
     and not exists (select 1 from public.fotos where sigma_estado in ('aprobado','enviando'))
     and not exists (select 1 from public.documentos_sigma where sigma_estado in ('aprobado','enviando'))
     and not exists (select 1 from public.partes where sigma_fotos_pedir is not null) then return; end if;
  select valor into s from privado.ajustes where clave = 'notif_secreto';
  perform net.http_post(
    url := 'https://hytmotuhdxbzpustnlzx.supabase.co/functions/v1/sigma-fotos',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kubel-secreto', s),
    timeout_milliseconds := 150000);
end $$;

-- «Enviar a SIGMA» de documentos (sin enviar o con error)
create or replace function public.aprobar_docs_sigma(ids uuid[]) returns int
language plpgsql security definer set search_path = public, privado as $$
declare n int;
begin
  if not public.es_oficina() then raise exception 'Solo la oficina puede enviar documentos a SIGMA'; end if;
  update public.documentos_sigma d set sigma_estado = 'aprobado', sigma_resultado = null,
         sigma_aprobado_por = auth.uid(), sigma_aprobado_en = now(), sigma_actualizado_en = now()
    from public.partes p
   where d.id = any(ids) and p.id = d.parte_id
     and (d.sigma_estado is null or d.sigma_estado = 'error')
     and p.sigma_cuenta is not null and p.estado not in ('cerrado','anulado');
  get diagnostics n = row_count;
  if n > 0 then perform privado.lanzar_fotos(true); end if;
  return n;
end $$;
revoke all on function public.aprobar_docs_sigma(uuid[]) from public, anon;
grant execute on function public.aprobar_docs_sigma(uuid[]) to authenticated;
