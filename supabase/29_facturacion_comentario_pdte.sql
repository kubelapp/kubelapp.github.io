-- KUBEL 29 · Facturación: el Comentario dice de qué está pendiente la línea (04/11/2026)
-- Cambia solo con el estado del servicio y se borra al cerrarse o anularse.
-- comentario_auto = último texto puesto por este automatismo (si coincide con comentario, no está escrito a mano).
-- comentario_regla = texto que toca según el estado (evita reescribir lo escrito a mano o repetir escrituras).
-- Lo escrito a mano se respeta con el servicio abierto, pero también se borra al cerrarse o anularse.
-- Al liquidar se borra el automático y se conserva lo escrito a mano. Al reabrir vuelve el automático.

alter table public.facturacion
  add column if not exists comentario_auto text,
  add column if not exists comentario_regla text;

create or replace function public.pdte_de_parte(p_estado text, p_sigma text, p_iva timestamptz)
returns text language plpgsql stable security definer set search_path to 'public' as $f$
declare v text;
begin
  if p_estado in ('cerrado','anulado') then return null; end if;
  if p_iva is not null or p_sigma = '88' then return 'PDTE VALIDAR DOC. IVA'; end if;
  case p_sigma
    when '6'  then return 'PDTE PERITO / COMPAÑÍA';
    when '7'  then return 'PDTE OTRA REPARACIÓN MA';
    when '16' then return 'PDTE CONFIRMACIÓN MA';
    when '12' then return 'PDTE ACEPTAR PRESUPUESTO';
    when '3'  then return 'PDTE ENTREGA PRESUPUESTO';
    when '74' then return 'PDTE CIERRE EN SIGMA';
    when '37' then return 'PDTE NUEVA CITA';
    when '43' then return 'PDTE NUEVA CITA';
    when '26' then return 'PDTE LOCALIZAR CLIENTE';
    else null;
  end case;
  if p_estado = 'terminado' then return 'PDTE CIERRE EN SIGMA'; end if;
  if p_estado = 'en_curso' then return 'PDTE TERMINAR REPARACIÓN'; end if;
  if p_sigma = '2' then return 'PDTE VISITA'; end if;
  if p_sigma in ('1','15') then return 'PDTE CONTACTO CON CLIENTE'; end if;
  if p_sigma is null then return null; end if;
  select texto into v from public.sigma_codigos where tipo = 'estado' and codigo = p_sigma;
  return case when v is null then null else 'PDTE: ' || upper(v) end;
end $f$;
revoke all on function public.pdte_de_parte(text,text,timestamptz) from public, anon, authenticated;

-- Al cambiar el estado de un servicio: se recalcula; al cerrarse o anularse se borra el comentario.
create or replace function public.partes_comentario_pdte()
returns trigger language plpgsql security definer set search_path to 'public' as $f$
declare v text; cierra boolean; f record;
begin
  v := public.pdte_de_parte(new.estado, new.sigma_estado, new.sigma_iva_pendiente);
  cierra := new.estado in ('cerrado','anulado') and old.estado is distinct from new.estado
            and old.estado not in ('cerrado','anulado');
  for f in select id, comentario, comentario_auto, comentario_regla from public.facturacion
            where not liquidado and (parte_id = new.id or (parte_id is null and servicio = new.numero_servicio))
  loop
    if cierra then
      update public.facturacion set comentario = null, comentario_auto = null, comentario_regla = null
       where id = f.id and (comentario is not null or comentario_auto is not null or comentario_regla is not null);
    elsif v is distinct from f.comentario_regla then
      if coalesce(trim(f.comentario),'') = '' or f.comentario = f.comentario_auto then
        update public.facturacion set comentario = v, comentario_auto = v, comentario_regla = v where id = f.id;
      else
        update public.facturacion set comentario_regla = v where id = f.id;
      end if;
    end if;
  end loop;
  return null;
exception when others then
  raise warning 'partes_comentario_pdte(%): %', new.id, sqlerrm;
  return null;
end $f$;

-- Línea nueva, enganchada a un servicio o marcada/desmarcada como liquidada.
create or replace function public.facturacion_comentario_pdte()
returns trigger language plpgsql security definer set search_path to 'public' as $f$
declare p record; v text;
begin
  if new.liquidado then
    if new.comentario_auto is not null and new.comentario = new.comentario_auto then new.comentario := null; end if;
    new.comentario_auto := null; new.comentario_regla := null;
    return new;
  end if;
  if new.parte_id is null then return new; end if;
  select estado, sigma_estado, sigma_iva_pendiente into p from public.partes where id = new.parte_id;
  if not found then return new; end if;
  v := public.pdte_de_parte(p.estado, p.sigma_estado, p.sigma_iva_pendiente);
  if v is distinct from new.comentario_regla then
    new.comentario_regla := v;
    if coalesce(trim(new.comentario),'') = '' or new.comentario = new.comentario_auto then
      new.comentario := v; new.comentario_auto := v;
    end if;
  end if;
  return new;
exception when others then
  raise warning 'facturacion_comentario_pdte(%): %', new.id, sqlerrm;
  return new;
end $f$;

-- Sustituye a la versión de SQL 26: un comentario automático no impide retirar la línea al quitar la visita.
create or replace function public.facturacion_seguir_visita(p_parte uuid, p_fecha date, p_operario uuid)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  v_nombre text; v_estado text; v_fecha date; v_op text; f record;
begin
  select estado into v_estado from public.partes where id = p_parte;
  if not found then return; end if;
  select nombre into v_nombre from public.perfiles where id = p_operario;
  if v_nombre is null then return; end if;

  select * into f from public.facturacion
   where parte_id = p_parte and origen = 'auto' and not liquidado
     and fecha = p_fecha and upper(operario) = upper(v_nombre)
   limit 1;
  if not found then return; end if;

  if exists (select 1 from public.asignaciones a
              where a.parte_id = p_parte and a.fecha = p_fecha and a.operario_id = p_operario
                and a.estado = 'hecho') then return; end if;

  select a.fecha, pf.nombre into v_fecha, v_op
    from public.asignaciones a left join public.perfiles pf on pf.id = a.operario_id
   where a.parte_id = p_parte and a.estado = 'hecho'
   order by a.fecha desc, a.hora desc nulls last limit 1;

  if found then
    update public.facturacion set fecha = v_fecha, operario = upper(v_op) where id = f.id;
  elsif v_estado <> 'cerrado' then
    if (f.comentario is null or f.comentario = f.comentario_auto) and f.factura is null and coalesce(f.importe_origen, 'presupuesto') = 'presupuesto' then
      delete from public.facturacion where id = f.id;
    else
      update public.facturacion set importe_nota = 'La visita se quitó o se cambió de fecha: revisar esta línea' where id = f.id;
    end if;
  end if;
exception when others then
  raise warning 'facturacion_seguir_visita(%): %', p_parte, sqlerrm;
end; $function$;

create or replace trigger facturacion_comentario_pdte before insert or update of parte_id, liquidado on public.facturacion
  for each row execute function public.facturacion_comentario_pdte();
create or replace trigger partes_comentario_pdte after update of estado, sigma_estado, sigma_iva_pendiente on public.partes
  for each row when (old.estado is distinct from new.estado or old.sigma_estado is distinct from new.sigma_estado or old.sigma_iva_pendiente is distinct from new.sigma_iva_pendiente)
  execute function public.partes_comentario_pdte();

-- Puesta en marcha (04/11/2026, ya aplicada una vez; NO repetir): los comentarios de ese día quedaron marcados
-- como automáticos, los de servicios cerrados se vaciaron y los escritos a mano se conservaron.
