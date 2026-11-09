-- KUBEL · SQL 38 (09/11/2026) — Repaso rechazado por SIGMA con 5091 «Debe introducir fecha laborable»
-- SIGMA no admite ese día en la agenda de la cuenta (visto con el 11/11/2026 en VLL: 29511179 y 29273266).
-- El robot (sigma-sync v34) ya intenta guardarlo sin control de agenda; si SIGMA sigue rechazándolo:
--   · el envío queda en error con el motivo claro;
--   · cada 30 min (07–21 h de Madrid) se vuelve a intentar solo, por si se quita el bloqueo del día en SIGMA;
--   · si la oficina mueve la visita, el Repaso se reenvía solo (SQL 34);
--   · si la cita pasa sin enviarse, kubel-repasos-caducados lo descarta (SQL 19).
-- La fecha y hora de la oficina nunca se cambian.

create or replace function privado.reintentar_repasos_no_laborables()
returns integer
language plpgsql
security definer
set search_path = public, privado
as $$
declare n integer; ahora timestamp := now() at time zone 'Europe/Madrid';
begin
  if extract(hour from ahora) < 7 or extract(hour from ahora) >= 21 then return 0; end if;
  update public.sigma_envios
     set estado = 'aprobado', aprobado_en = now()
   where tipo = 'repaso' and estado = 'error'
     and resultado like '%código 5091 de SIGMA%'
     and fecha is not null
     and (case when hora is null then fecha > ahora::date else (fecha + hora) > ahora end)
     and actualizado_en < now() - interval '25 minutes';
  get diagnostics n = row_count;
  return n;
end; $$;

revoke execute on function privado.reintentar_repasos_no_laborables() from public, anon, authenticated;

select cron.schedule('kubel-repasos-no-laborables', '*/30 * * * *', 'select privado.reintentar_repasos_no_laborables()');
