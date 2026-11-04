-- KUBEL 27 · Con varias visitas, el importe es del operario de la última visita hecha (04/11/2026)
-- Al hacerse o moverse una visita, la línea automática sin liquidar pasa a la fecha y el operario de la última visita hecha.
-- En servicios cerrados solo cuentan las visitas hasta el día del cierre: las posteriores son internas (SQL 22).
-- Una línea corregida a mano (que no coincide con ninguna visita del servicio) no se toca.

create or replace function public.facturacion_ultima_visita(p_parte uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_parte record; v_tope date; v_fecha date; v_op text; f record;
begin
  select estado, sigma_ficha into v_parte from public.partes where id = p_parte;
  if not found or v_parte.estado = 'anulado' then return; end if;
  if v_parte.estado = 'cerrado' then
    v_tope := public.fecha_cierre_sigma(v_parte.sigma_ficha);
    if v_tope is null then return; end if;
  end if;

  select * into f from public.facturacion where parte_id = p_parte and origen = 'auto' and not liquidado limit 1;
  if not found then return; end if;

  -- Corregida a mano o sin operario: no apunta a ninguna visita
  if not exists (select 1 from public.asignaciones a join public.perfiles pf on pf.id = a.operario_id
                  where a.parte_id = p_parte and a.fecha = f.fecha and upper(pf.nombre) = upper(f.operario)) then return; end if;

  select a.fecha, pf.nombre into v_fecha, v_op
    from public.asignaciones a left join public.perfiles pf on pf.id = a.operario_id
   where a.parte_id = p_parte and a.estado = 'hecho' and (v_tope is null or a.fecha <= v_tope)
   order by a.fecha desc, a.hora desc nulls last limit 1;
  if not found then return; end if;

  update public.facturacion set fecha = v_fecha, operario = upper(v_op)
   where id = f.id and (fecha is distinct from v_fecha or operario is distinct from upper(v_op));
exception when others then
  raise warning 'facturacion_ultima_visita(%): %', p_parte, sqlerrm;
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
  if tg_op = 'UPDATE' and new.estado = 'hecho'
     and (old.estado is distinct from 'hecho' or old.fecha is distinct from new.fecha or old.operario_id is distinct from new.operario_id) then
    perform public.facturacion_ultima_visita(new.parte_id);
  end if;
  return null;
end; $$;

revoke all on function public.facturacion_ultima_visita(uuid) from public, anon, authenticated;
