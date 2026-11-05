-- KUBEL 31 · Envíos a SIGMA sin cortes (05/11/2026). Requiere sigma-sync v29.
-- Con muchos envíos aprobados a la vez, el robot agotaba su tiempo y los últimos quedaban en «Envío interrumpido»
-- (29307848, 29308613…). Ahora el robot se para a tiempo y deja el resto en «aprobado»; este cron lo vuelve a lanzar.

-- Más margen a la llamada que lanza el robot (la función puede durar hasta 150 s)
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
      timeout_milliseconds := 150000);
  exception when others then raise warning 'disparar_envio_sigma: %', sqlerrm;
  end;
  return new;
end; $function$;

-- Lanza el robot si hay envíos aprobados esperando más de 1 min o alguno a medias más de 10 min. Sin nada pendiente no llama a nadie.
create or replace function privado.relanzar_envios_sigma()
 returns integer language plpgsql security definer set search_path to 'public', 'privado', 'extensions'
as $function$
declare s text; cta text; n integer := 0;
begin
  select valor into s from privado.ajustes where clave = 'notif_secreto';
  for cta in
    select distinct p.sigma_cuenta from public.sigma_envios e join public.partes p on p.id = e.parte_id
     where p.sigma_cuenta is not null
       and ((e.estado = 'aprobado' and e.actualizado_en < now() - interval '1 minute')
         or (e.estado = 'enviando' and e.actualizado_en < now() - interval '10 minutes'))
  loop
    perform net.http_post(
      url := 'https://hytmotuhdxbzpustnlzx.supabase.co/functions/v1/sigma-sync?enviar=1&cuenta=' || cta,
      body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-kubel-secreto', s),
      timeout_milliseconds := 150000);
    n := n + 1;
  end loop;
  return n;
end; $function$;
revoke all on function privado.relanzar_envios_sigma() from public, anon, authenticated;

select cron.schedule('kubel-sigma-envios-cola', '*/2 * * * *', 'select privado.relanzar_envios_sigma()');
