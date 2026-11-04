-- KUBEL 26 · En Facturación solo entra lo que un operario ha hecho (04/11/2026)
-- Antes bastaba una visita con fecha <= hoy aunque siguiera pendiente, y una visita cancelada dejaba la línea dentro.
-- Ahora, con el servicio abierto, hace falta una visita HECHA (la marca el informe del operario).
-- Los servicios que SIGMA cierra siguen entrando al cerrarse.

create or replace function public.tiene_visita(p_parte uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.asignaciones a where a.parte_id = p_parte and a.estado = 'hecho');
$$;

-- Fecha y operario de la línea = última visita hecha. Sin ninguna (servicio cerrado sin informe), la última ya
-- pasada y no «no realizado». Las futuras o «no realizado» nunca cuentan.
create or replace function public.facturacion_alta(p_parte uuid, p_fecha date, p_operario uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  p record; v_comp text; v_op text; v_prov text; v_dir text; v_fecha date;
begin
  select * into p from public.partes where id = p_parte;
  if not found then return; end if;
  select nombre into v_comp from public.companias where id = p.compania_id;
  v_comp := upper(coalesce(v_comp, ''));
  select a.fecha, pf.nombre into v_fecha, v_op from public.asignaciones a left join public.perfiles pf on pf.id = a.operario_id
   where a.parte_id = p_parte
     and (a.estado = 'hecho' or (a.estado <> 'no_realizado' and a.fecha <= (now() at time zone 'Europe/Madrid')::date))
   order by (a.estado = 'hecho') desc, a.fecha desc, a.hora desc nulls last limit 1;
  if p_operario is not null then select nombre into v_op from public.perfiles where id = p_operario; end if;
  v_fecha := coalesce(v_fecha, case when p_fecha > current_date - 365 then p_fecha end, (now() at time zone 'Europe/Madrid')::date);
  v_prov := case left(coalesce(p.codigo_postal, ''), 2) when '47' then 'VALLADOLID' when '34' then 'PALENCIA'
            else case p.sigma_cuenta when 'VLL' then 'VALLADOLID' when 'PAL' then 'PALENCIA' else null end end;
  v_dir := upper(trim(coalesce(p.direccion, '') ||
           case when p.poblacion is not null and upper(p.poblacion) not in ('VALLADOLID', 'PALENCIA')
                then ' ' || p.poblacion else '' end));

  if exists (select 1 from public.facturacion where parte_id = p_parte) then return; end if;
  -- Fila del histórico (Excel / manual) con el mismo nº: se enlaza sin tocarla
  update public.facturacion set parte_id = p_parte
   where id = (select id from public.facturacion
                where parte_id is null and servicio = p.numero_servicio
                  and (compania is null or upper(compania) = v_comp)
                order by fecha desc nulls last, creado_en desc limit 1);
  if found then return; end if;

  insert into public.facturacion (parte_id, servicio, fecha, operario, compania, direccion, provincia, origen)
  values (p_parte, p.numero_servicio, v_fecha, upper(v_op), v_comp, nullif(v_dir, ''), v_prov, 'auto')
  on conflict do nothing;
end; $$;

-- Sustituye a la versión de SQL 25: «visita real» pasa a ser visita hecha.
create or replace function public.facturacion_seguir_visita(p_parte uuid, p_fecha date, p_operario uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_nombre text; v_estado text; v_fecha date; v_op text; f record;
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

  -- ¿Sigue habiendo una visita hecha ese día con ese operario?
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

revoke all on function public.facturacion_seguir_visita(uuid, date, uuid) from public, anon, authenticated;
