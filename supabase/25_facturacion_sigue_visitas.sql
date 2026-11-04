-- KUBEL 25 · Facturación sigue a la visita (04/11/2026)
-- Una línea automática guardaba la fecha y el operario de la visita al entrar y no volvía a mirarlos.
-- Ahora, al mover, quitar o marcar «no realizado» la visita a la que apunta una línea automática sin liquidar:
--   · si el servicio tiene otra visita real (hecha, o con fecha <= hoy y no «no realizado») → la línea pasa a esa visita;
--   · si no la tiene y el servicio sigue abierto → la línea sale de Facturación (presupuesto aceptado sin visita no entra;
--     volverá sola cuando haya visita). Si el admin le había puesto factura, comentario o importe propio, no se borra:
--     se deja con un aviso para revisarla;
--   · si el servicio está cerrado → la línea se queda como está (entró por el cierre).
-- Solo actúa si la línea apunta a esa visita (mismo día y operario), así se respetan las correcciones a mano
-- y no cambia la fecha de una línea cuando se añade o se mueve un repaso posterior.

create or replace function public.facturacion_seguir_visita(p_parte uuid, p_fecha date, p_operario uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_nombre text; v_estado text; v_fecha date; v_op text; f record;
  v_hoy date := (now() at time zone 'Europe/Madrid')::date;
begin
  select estado into v_estado from public.partes where id = p_parte;
  if not found then return; end if; -- se está borrando el servicio
  select nombre into v_nombre from public.perfiles where id = p_operario;
  if v_nombre is null then return; end if;

  select * into f from public.facturacion
   where parte_id = p_parte and origen = 'auto' and not liquidado
     and fecha = p_fecha and upper(operario) = upper(v_nombre)
   limit 1;
  if not found then return; end if;

  -- ¿Sigue habiendo una visita real ese día con ese operario?
  if exists (select 1 from public.asignaciones a
              where a.parte_id = p_parte and a.fecha = p_fecha and a.operario_id = p_operario
                and a.fecha <= v_hoy and a.estado <> 'no_realizado') then return; end if;

  select a.fecha, pf.nombre into v_fecha, v_op
    from public.asignaciones a left join public.perfiles pf on pf.id = a.operario_id
   where a.parte_id = p_parte and a.fecha <= v_hoy and a.estado <> 'no_realizado'
   order by (a.estado = 'hecho') desc, a.fecha desc, a.hora desc nulls last limit 1;

  if found then
    update public.facturacion set fecha = v_fecha, operario = upper(v_op) where id = f.id;
  elsif v_estado <> 'cerrado' then
    if f.comentario is null and f.factura is null and coalesce(f.importe_origen, 'presupuesto') = 'presupuesto' then
      delete from public.facturacion where id = f.id;
    else
      update public.facturacion set importe_nota = 'La visita se quitó o se cambió de fecha: revisar esta línea' where id = f.id;
    end if;
  end if;
exception when others then
  -- Facturación nunca debe impedir que la oficina cambie una visita
  raise warning 'facturacion_seguir_visita(%): %', p_parte, sqlerrm;
end; $$;

create or replace function public.asignaciones_facturacion()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op = 'DELETE'
     or old.fecha is distinct from new.fecha
     or old.operario_id is distinct from new.operario_id
     or old.parte_id is distinct from new.parte_id
     or (new.estado = 'no_realizado' and old.estado is distinct from 'no_realizado') then
    perform public.facturacion_seguir_visita(old.parte_id, old.fecha, old.operario_id);
  end if;
  return null;
end; $$;

create or replace trigger asignaciones_facturacion
  after update of fecha, operario_id, parte_id, estado or delete on public.asignaciones
  for each row execute function public.asignaciones_facturacion();

revoke all on function public.facturacion_seguir_visita(uuid, date, uuid) from public, anon, authenticated;
