-- KUBEL · SQL 39 (10/11/2026) — Se puede citar en KUBEL en un día no laborable de SIGMA
-- Cambia la decisión del 09/11 (SQL 38): KUBEL ya NO impide planificar una visita en un día que SIGMA no admite
-- (festivo / no laborable de su agenda, error 5091). La visita se guarda y el operario la ve como cualquier otra.
-- · Ese día no se crea el Repaso «Visita al Cliente» para SIGMA (daría 5091): si había un borrador o un Repaso en error
--   de esa visita, se descarta con el motivo. Si la visita se mueve a un día laborable, el Repaso vuelve a crearse solo.
-- · Se mantiene la tabla sigma_dias_no_laborables (la sigue llenando sigma-sync) y el reintento de los Repasos en 5091.

alter table public.asignaciones disable trigger asignaciones_dia_laborable_sigma;

create or replace function public.sigma_borrador_desde_asignacion()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare p record; b uuid; bc timestamptz; com text; motivo_bloqueo text; ya_enviado boolean; auto boolean;
begin
  select id, sigma_cuenta, sigma_estado, sigma_iva_pendiente, estado into p from public.partes where id = new.parte_id;
  if p.sigma_cuenta is null then return new; end if;
  if tg_op = 'UPDATE' and new.fecha is not distinct from old.fecha and new.hora is not distinct from old.hora then
    return new;
  end if;
  if p.estado in ('cerrado', 'anulado') then
    update public.sigma_envios
       set estado = 'descartado', resultado = 'Servicio ' || p.estado || ': visita solo interna, sin Repaso en SIGMA'
     where asignacion_id = new.id and tipo = 'repaso' and estado in ('borrador', 'error');
    return new;
  end if;
  motivo_bloqueo := case
    when p.sigma_iva_pendiente is not null then 'documento de IVA pendiente de validar'
    when p.sigma_estado = '6' then 'estado 6 «Aplazamiento Pte. Cia./Perito»'
    when p.sigma_estado = '16' then 'estado 16 «Introducción ptto./Confirmación por MA»'
  end;
  if motivo_bloqueo is not null then
    update public.sigma_envios
       set estado = 'descartado', resultado = 'Repaso bloqueado por SIGMA (' || motivo_bloqueo || '): no se crea al planificar'
     where asignacion_id = new.id and tipo = 'repaso' and origen = 'planificacion' and estado in ('borrador', 'error');
    return new;
  end if;
  -- (SQL 39) Día no laborable de SIGMA para su cuenta: visita solo en KUBEL, sin Repaso
  if exists (select 1 from public.sigma_dias_no_laborables d where d.cuenta = p.sigma_cuenta and d.fecha = new.fecha) then
    update public.sigma_envios
       set estado = 'descartado',
           resultado = 'SIGMA no admite el ' || to_char(new.fecha, 'DD/MM/YYYY') || ' como día laborable (error 5091): visita solo en KUBEL, sin Repaso en SIGMA'
     where asignacion_id = new.id and tipo = 'repaso' and estado in ('borrador', 'error');
    return new;
  end if;
  ya_enviado := exists (select 1 from public.sigma_envios
                         where parte_id = new.parte_id and tipo = 'repaso'
                           and estado in ('aprobado','enviando','enviado')
                           and fecha = new.fecha and hora is not distinct from new.hora);
  com := 'Visita al cliente programada el ' || to_char(new.fecha, 'DD/MM/YYYY')
         || coalesce(' a las ' || to_char(new.hora, 'HH24:MI'), '');
  select id, contacto_en into b, bc from public.sigma_envios
   where asignacion_id = new.id and tipo = 'repaso' and estado in ('borrador', 'error') limit 1;
  if b is not null then
    if ya_enviado then
      update public.sigma_envios
         set estado = 'descartado', resultado = 'Descartado solo: ya se ha mandado a SIGMA un Repaso para esta cita'
       where id = b;
    elsif exists (select 1 from public.sigma_envios
                where parte_id = new.parte_id and id <> b and tipo = 'repaso' and origen = 'planificacion'
                  and estado in ('borrador', 'error') and fecha = new.fecha and hora is not distinct from new.hora) then
      update public.sigma_envios set estado = 'descartado', resultado = 'Duplicado: ya hay un borrador para esta cita'
       where id = b;
    else
      auto := public.sigma_repaso_auto_ok(new.parte_id, new.fecha, new.hora, bc);
      update public.sigma_envios set fecha = new.fecha, hora = new.hora, comentario = com, resultado = null,
             estado = case when auto then 'aprobado' else 'borrador' end,
             aprobado_por = case when auto then null else aprobado_por end,
             aprobado_en = case when auto then now() else aprobado_en end
       where id = b;
    end if;
  elsif not ya_enviado and not exists (select 1 from public.sigma_envios
                     where parte_id = new.parte_id and tipo = 'repaso' and origen = 'planificacion'
                       and estado in ('borrador', 'error') and fecha = new.fecha and hora is not distinct from new.hora) then
    auto := public.sigma_repaso_auto_ok(new.parte_id, new.fecha, new.hora, null);
    insert into public.sigma_envios (parte_id, asignacion_id, tipo, origen, motivo_codigo, motivo_texto, fecha, hora, comentario, estado, aprobado_en)
    values (new.parte_id, new.id, 'repaso', 'planificacion', '2', 'Visita al Cliente', new.fecha, new.hora, com,
            case when auto then 'aprobado' else 'borrador' end, case when auto then now() end);
  end if;
  return new;
end; $function$;

notify pgrst, 'reload schema';
