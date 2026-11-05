-- KUBEL 30 · El «Informar cita» del informe del operario se envía solo (05/11/2026, decisión del usuario)
-- Antes se creaba como borrador y esperaba a «Aprobar y enviar» en la oficina. Ahora nace aprobado y sale al momento.
-- Sigue pasando por la bandeja como borrador si no trae comentario (el portal lo exige).
-- No cambia: Informar cita de «no realizado», Repaso, Confirmación y mensajes a tramitación siguen con aprobación.
-- aprobado_por queda vacío y aprobado_en con la hora: así se distingue de lo aprobado por una persona.
-- Requiere sigma-sync v28 (nunca informa una cita posterior a la visita).

create or replace function public.sigma_borrador_desde_informe()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare p record; a record; mot text; mtx text; auto boolean;
begin
  select id, sigma_cuenta, estado into p from public.partes where id = new.parte_id;
  if p.sigma_cuenta is null or p.estado in ('cerrado', 'anulado') then return new; end if;
  select fecha, hora into a from public.asignaciones where id = new.asignacion_id;
  if new.trabajo_terminado then mot := '609'; mtx := 'Finalizado reparación no requiere nueva cita.';
  elsif new.necesita_repaso then mot := '601'; mtx := 'Reparado parcialmente, requiere nueva cita';
  else mot := '604'; mtx := 'No reparado requiere nueva cita.';
  end if;
  auto := coalesce(trim(new.texto), '') <> '';
  insert into public.sigma_envios (parte_id, asignacion_id, informe_id, tipo, origen, resolucion, resolucion_motivo, motivo_texto, cita_fecha, cita_hora, comentario, estado, aprobado_en)
  values (new.parte_id, new.asignacion_id, new.id, 'informar_cita', 'informe', 'V', mot, mtx, a.fecha, a.hora, new.texto,
          case when auto then 'aprobado' else 'borrador' end, case when auto then now() end);
  return new;
end; $function$;

-- El disparador de envío inmediato solo miraba los cambios de estado: ahora también las altas ya aprobadas
create or replace function privado.disparar_envio_sigma()
 returns trigger language plpgsql security definer set search_path to 'public', 'privado', 'extensions'
as $function$
declare s text; cta text;
begin
  if new.estado <> 'aprobado' or (tg_op = 'UPDATE' and old.estado = 'aprobado') then return new; end if;
  select sigma_cuenta into cta from public.partes where id = new.parte_id;
  select valor into s from privado.ajustes where clave = 'notif_secreto';
  begin
    perform net.http_post(
      url := 'https://hytmotuhdxbzpustnlzx.supabase.co/functions/v1/sigma-sync?enviar=1&cuenta=' || coalesce(cta, ''),
      body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-kubel-secreto', s),
      timeout_milliseconds := 120000);
  exception when others then raise warning 'disparar_envio_sigma: %', sqlerrm;
  end;
  return new;
end; $function$;

create or replace trigger sigma_envios_disparar_alta
after insert on public.sigma_envios
for each row when (new.tipo = 'informar_cita' and new.estado = 'aprobado')
execute function privado.disparar_envio_sigma();
