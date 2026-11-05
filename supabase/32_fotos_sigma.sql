-- =====================================================================
-- KUBEL · 32 · Fotos a SIGMA desde la pestaña «Pasos SIGMA» de la ficha (06/11/2026)
-- La oficina elige qué fotos del servicio van al portal (las del operario o las que
-- sube ella desde el ordenador) y pulsa «Enviar a SIGMA» → el robot sigma-fotos las
-- añade en la pestaña Fotografías del servicio (Asegurado, Antes/Después).
-- Estados de fotos.sigma_estado:
--   null      = sin enviar        aprobado = en cola        enviando = subiendo ahora
--   enviado   = ya está en SIGMA  error    = falló (ver sigma_resultado)
--   omitido   = no se sube (factura, servicio cerrado…)
-- partes.sigma_fotos = lo que hay en el portal { total, antes, despues } (lo lee el robot).
-- =====================================================================

alter table public.fotos
  add column if not exists sigma_estado text check (sigma_estado in ('aprobado','enviando','enviado','error','omitido')),
  add column if not exists sigma_resultado text,
  add column if not exists sigma_intentos int not null default 0,
  add column if not exists sigma_aprobado_por uuid references public.perfiles(id),
  add column if not exists sigma_aprobado_en timestamptz,
  add column if not exists sigma_enviado_en timestamptz,
  add column if not exists sigma_actualizado_en timestamptz;
create index if not exists fotos_sigma_cola on public.fotos (sigma_estado) where sigma_estado in ('aprobado','enviando');

alter table public.partes
  add column if not exists sigma_fotos jsonb,
  add column if not exists sigma_fotos_en timestamptz,
  add column if not exists sigma_fotos_pedir timestamptz;

-- La oficina sube fotos para SIGMA a fotos/sigma/<servicio>/<uuid>.jpg
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'oficina sube fotos para SIGMA') then
    create policy "oficina sube fotos para SIGMA" on storage.objects for insert to authenticated
      with check (bucket_id = 'fotos' and (storage.foldername(name))[1] = 'sigma' and public.es_oficina());
  end if;
end $$;

-- Protecciones: el operario no puede marcar estados de SIGMA; no se cambia el tipo de una foto
-- en cola o ya enviada; no se borra una foto mientras se está subiendo.
create or replace function privado.fotos_proteger_sigma() returns trigger
language plpgsql security definer set search_path = public, privado as $$
begin
  if tg_op = 'DELETE' then
    if old.sigma_estado = 'enviando' then raise exception 'Esta foto se está subiendo a SIGMA ahora mismo: espera un momento'; end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if auth.uid() is not null and not public.es_oficina() then
      new.sigma_estado := null; new.sigma_resultado := null; new.sigma_intentos := 0;
      new.sigma_aprobado_por := null; new.sigma_aprobado_en := null; new.sigma_enviado_en := null;
    end if;
    return new;
  end if;
  if new.tipo is distinct from old.tipo and old.sigma_estado in ('aprobado','enviando','enviado') then
    raise exception 'No se puede cambiar Antes/Después de una foto en cola o ya enviada a SIGMA';
  end if;
  return new;
end $$;
create or replace trigger fotos_proteger_sigma before insert or update or delete on public.fotos
  for each row execute function privado.fotos_proteger_sigma();

-- Llama al robot solo si hay algo que hacer (o si se fuerza)
create or replace function privado.lanzar_fotos(forzar boolean default false) returns void
language plpgsql security definer set search_path = public, privado, extensions as $$
declare s text;
begin
  if not forzar
     and not exists (select 1 from public.fotos where sigma_estado in ('aprobado','enviando'))
     and not exists (select 1 from public.partes where sigma_fotos_pedir is not null) then return; end if;
  select valor into s from privado.ajustes where clave = 'notif_secreto';
  perform net.http_post(
    url := 'https://hytmotuhdxbzpustnlzx.supabase.co/functions/v1/sigma-fotos',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kubel-secreto', s),
    timeout_milliseconds := 150000);
end $$;

-- «Enviar a SIGMA»: pone en cola las fotos elegidas (sin enviar o con error) y lanza el robot
create or replace function public.aprobar_fotos_sigma(ids uuid[]) returns int
language plpgsql security definer set search_path = public, privado as $$
declare n int;
begin
  if not public.es_oficina() then raise exception 'Solo la oficina puede enviar fotos a SIGMA'; end if;
  update public.fotos f set sigma_estado = 'aprobado', sigma_resultado = null,
         sigma_aprobado_por = auth.uid(), sigma_aprobado_en = now(), sigma_actualizado_en = now()
    from public.partes p
   where f.id = any(ids) and p.id = f.parte_id
     and (f.sigma_estado is null or f.sigma_estado = 'error')
     and f.tipo in ('antes','despues')
     and p.sigma_cuenta is not null and p.estado not in ('cerrado','anulado');
  get diagnostics n = row_count;
  if n > 0 then perform privado.lanzar_fotos(true); end if;
  return n;
end $$;

-- Quitar de la cola (solo las que aún no se están subiendo)
create or replace function public.retirar_fotos_sigma(ids uuid[]) returns int
language plpgsql security definer set search_path = public, privado as $$
declare n int;
begin
  if not public.es_oficina() then raise exception 'Solo la oficina'; end if;
  update public.fotos set sigma_estado = null, sigma_resultado = null, sigma_actualizado_en = now()
   where id = any(ids) and sigma_estado = 'aprobado';
  get diagnostics n = row_count;
  return n;
end $$;

-- «↻ Comprobar en SIGMA»: el robot lee cuántas fotos tiene el servicio en el portal
create or replace function public.comprobar_fotos_sigma(parte uuid) returns void
language plpgsql security definer set search_path = public, privado as $$
begin
  if not public.es_oficina() then raise exception 'Solo la oficina'; end if;
  update public.partes set sigma_fotos_pedir = now() where id = parte and sigma_cuenta is not null;
  perform privado.lanzar_fotos(true);
end $$;

revoke all on function public.aprobar_fotos_sigma(uuid[]), public.retirar_fotos_sigma(uuid[]), public.comprobar_fotos_sigma(uuid) from public, anon;
grant execute on function public.aprobar_fotos_sigma(uuid[]), public.retirar_fotos_sigma(uuid[]), public.comprobar_fotos_sigma(uuid) to authenticated;

-- Por si algo queda en cola (el robot sube de una en una con tope de tiempo)
select cron.schedule('kubel-sigma-fotos', '*/2 * * * *', 'select privado.lanzar_fotos()');
