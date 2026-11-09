-- KUBEL · SQL 37 (09/11/2026) · Pasos SIGMA · 2 Confirmación: la RÁPIDA también se aprueba desde la ficha
-- (con o sin informe del operario). aprobar_confir_sigma pone la variante según lo último leído de SIGMA
-- (partes.sigma_confir.estado); sigma-sync decide siempre por lo que diga el portal al enviar.
-- datos (completa) admite además perito y videoExpertise (videoperitación, sigma-sync v33).

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
    values (parte, 'confirmacion', 'manual', 'borrador', case when p.sigma_confir->>'estado' = 'rapida' then 'rapida' else 'completa' end, '{}'::jsonb, '', auth.uid()) returning id into eid;
  end if;
  update public.sigma_envios set
    confir_variante = case when p.sigma_confir->>'estado' = 'rapida' then 'rapida' else 'completa' end,
    confir_datos = case when p.sigma_confir->>'estado' = 'rapida' then coalesce(confir_datos, '{}'::jsonb)
      else coalesce(confir_datos, '{}'::jsonb) || jsonb_build_object('kubel', coalesce(datos, '{}'::jsonb),
        'clasificador', p.sigma_confir -> 'clasificador') end,
    cita_fecha = pv_fecha, cita_hora = pv_hora, contacto_en = contacto, resultado = null
  where id = eid;
  update public.sigma_envios set estado = 'aprobado' where id = eid; -- dispara sigma-sync (sigma_envios_disparar)
  return eid;
end $$;
revoke all on function public.aprobar_confir_sigma(uuid, jsonb, date, time, timestamptz) from public, anon;
grant execute on function public.aprobar_confir_sigma(uuid, jsonb, date, time, timestamptz) to authenticated;

