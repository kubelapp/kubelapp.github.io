-- KUBEL 34 · El Repaso «Visita al Cliente» de una visita planificada se envía solo (06/11/2026, decisión del usuario)
-- Antes nacía como borrador y esperaba a «Aprobar y enviar». Ahora nace aprobado y sale al momento, si:
--   · la visita tiene hora y es futura (día + hora posteriores a ahora, hora de Madrid), y
--   · SIGMA no pide la fecha de contacto con el cliente (estado 15 o partes.sigma_pide_contacto), o ya está puesta.
-- Si falta la fecha de contacto, queda en borrador; en cuanto la oficina la pone (al planificar o en la tarjeta),
-- se aprueba sola. Al mover la visita, el borrador o el error pendiente se actualiza y también se envía solo.
-- Sin cambios: el Repaso hecho a mano desde la ficha, Confirmación y mensajes a tramitación siguen con aprobación;
-- servicios bloqueados (IVA, estado 6 / 16), cerrados o anulados siguen sin Repaso.
-- Como en SQL 30: aprobado_por vacío y aprobado_en con la hora = enviado sin aprobación de una persona.

create or replace function public.sigma_repaso_auto_ok(parte uuid, f date, h time, contacto timestamptz)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
  select h is not null
     and (f + h) > (now() at time zone 'Europe/Madrid')
     and (contacto is not null or (coalesce(p.sigma_estado, '') <> '15' and p.sigma_pide_contacto is not true))
    from public.partes p where p.id = parte
$$;

create or replace function public.sigma_borrador_desde_asignacion()
 returns trigger language plpgsql security definer set search_path to 'public'
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

-- Al poner la fecha de contacto en un Repaso de planificación en borrador → se aprueba solo
create or replace function public.sigma_repaso_auto_al_contacto()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.tipo = 'repaso' and new.origen = 'planificacion' and new.estado = 'borrador' and new.contacto_en is not null
     and old.contacto_en is distinct from new.contacto_en
     and public.sigma_repaso_auto_ok(new.parte_id, new.fecha, new.hora, new.contacto_en) then
    update public.sigma_envios set estado = 'aprobado', aprobado_por = null, aprobado_en = now() where id = new.id and estado = 'borrador';
  end if;
  return new;
end $$;
create or replace trigger sigma_envios_repaso_auto_contacto
after update of contacto_en on public.sigma_envios
for each row execute function public.sigma_repaso_auto_al_contacto();

-- El disparador de envío inmediato en altas aprobadas: también Repasos
create or replace trigger sigma_envios_disparar_alta
after insert on public.sigma_envios
for each row when (new.tipo in ('informar_cita', 'repaso') and new.estado = 'aprobado')
execute function privado.disparar_envio_sigma();
