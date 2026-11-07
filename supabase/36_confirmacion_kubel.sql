-- KUBEL · SQL 36 (07/11/2026) · Paso 2 de «✅ Pasos SIGMA»: la Confirmación (también la COMPLETA) desde KUBEL.
-- La oficina abre el clasificador de daños de SIGMA con su enlace firmado (fuera del portal), pulsa «Leer de SIGMA»
-- (el robot sigma-fotos v7 lee el resultado y el formulario que rellena el portal) y luego «Aprobar y confirmar»:
-- el envío 'confirmacion' (variante completa) lleva en confir_datos.kubel lo que la oficina ha puesto y sigma-sync v32
-- manda confirm-fnol. La cobertura la sigue decidiendo el clasificador de SIGMA.

alter table public.partes
  add column if not exists sigma_confir jsonb,              -- lo último que leyó el robot de la pestaña Confirmación
  add column if not exists sigma_confir_en timestamptz,
  add column if not exists sigma_confir_pedir timestamptz;  -- la oficina ha pedido «Leer de SIGMA»

-- «Leer de SIGMA» (solo lectura en el portal)
create or replace function public.leer_confir_sigma(parte uuid) returns void
language plpgsql security definer set search_path = public, privado as $$
begin
  if not public.es_oficina() then raise exception 'Solo la oficina'; end if;
  update public.partes set sigma_confir_pedir = now() where id = parte and sigma_cuenta is not null;
  perform privado.lanzar_fotos(true);
end $$;
revoke all on function public.leer_confir_sigma(uuid) from public, anon;
grant execute on function public.leer_confir_sigma(uuid) to authenticated;

-- «Aprobar y confirmar» desde Pasos SIGMA: usa el envío vivo de Confirmación (o crea uno) y lo aprueba.
-- datos = { respsin, tipo, nombre, apellido1, apellido2, telefono, direccion, cp, poblacion, txtlocalizacion }
create or replace function public.aprobar_confir_sigma(parte uuid, datos jsonb, pv_fecha date, pv_hora time, contacto timestamptz default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare eid uuid; p record;
begin
  if not public.es_oficina() then raise exception 'Solo la oficina'; end if;
  select id, estado, sigma_cuenta, sigma_confir into p from public.partes where id = parte;
  if p.id is null or p.sigma_cuenta is null then raise exception 'El servicio no es de SIGMA'; end if;
  if p.estado in ('cerrado', 'anulado') then raise exception 'El servicio está %', p.estado; end if;
  if exists (select 1 from public.sigma_envios where parte_id = parte and tipo = 'confirmacion' and estado in ('aprobado', 'enviando')) then
    raise exception 'Ya hay una confirmación de este servicio enviándose a SIGMA';
  end if;
  select id into eid from public.sigma_envios where parte_id = parte and tipo = 'confirmacion' and estado in ('borrador', 'error')
    order by creado_en desc limit 1;
  if eid is null then
    insert into public.sigma_envios (parte_id, tipo, origen, estado, confir_variante, confir_datos, comentario, creado_por)
    values (parte, 'confirmacion', 'manual', 'borrador', 'completa', '{}'::jsonb, '', auth.uid()) returning id into eid;
  end if;
  update public.sigma_envios set
    confir_variante = 'completa',
    confir_datos = coalesce(confir_datos, '{}'::jsonb) || jsonb_build_object('kubel', coalesce(datos, '{}'::jsonb),
      'clasificador', p.sigma_confir -> 'clasificador'),
    cita_fecha = pv_fecha, cita_hora = pv_hora, contacto_en = contacto, resultado = null
  where id = eid;
  update public.sigma_envios set estado = 'aprobado' where id = eid; -- dispara sigma-sync (sigma_envios_disparar)
  return eid;
end $$;
revoke all on function public.aprobar_confir_sigma(uuid, jsonb, date, time, timestamptz) from public, anon;
grant execute on function public.aprobar_confir_sigma(uuid, jsonb, date, time, timestamptz) to authenticated;

-- El robot sigma-fotos se llama también si hay una lectura de Confirmación pedida
create or replace function privado.lanzar_fotos(forzar boolean default false) returns void
language plpgsql security definer set search_path = public, privado, extensions as $$
declare s text;
begin
  if not forzar
     and not exists (select 1 from public.fotos where sigma_estado in ('aprobado','enviando'))
     and not exists (select 1 from public.documentos_sigma where sigma_estado in ('aprobado','enviando'))
     and not exists (select 1 from public.partes where sigma_fotos_pedir is not null or sigma_confir_pedir is not null) then return; end if;
  select valor into s from privado.ajustes where clave = 'notif_secreto';
  perform net.http_post(
    url := 'https://hytmotuhdxbzpustnlzx.supabase.co/functions/v1/sigma-fotos',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kubel-secreto', s),
    timeout_milliseconds := 150000);
end $$;

notify pgrst, 'reload schema';
