-- 50 · Eventos SIGMA: DESATASCO CAMIÓN CUBA automático (12/11/2026)
-- Regla del usuario: el camión cuba con SIGMA va por el gremio 22A; se apunta un evento cada vez que en un 22A se
-- factura el baremo F45. KUBEL lo ve en el presupuesto que lee el robot sigma-presupuestos (partes.sigma_ptto_lineas):
--   · servicio SIGMA (compañía 1), sigma_gremio = '22A' y una partida F45 ACEPTADA → una línea por servicio.
--   · Día de visita = primera visita HECHA en KUBEL (si no hay, el día en que se aceptó la F45, con aviso).
--   · Periodo según el día en que se aceptó la F45 (fecha de la partida).
--   · Si la F45 desaparece o deja de estar aceptada → la línea se quita (salvo enviada o con fecha a mano).
-- Las líneas a mano de este tipo (SQL 49) siguen valiendo; si ya hay una a mano con el mismo nº, no se duplica.

create unique index if not exists eventos_sigma_cuba_uni on public.eventos_sigma (parte_id)
  where tipo = 'DESATASCO CAMIÓN CUBA' and parte_id is not null;

create or replace function public.evento_cuba(p_parte uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p public.partes; v_f45 date; v_hay boolean := false; v_primera date; v_op text;
begin
  perform set_config('kubel.eventos_bd', '1', true);
  select * into p from public.partes where id = p_parte;
  if found and p.compania_id = 1 and upper(coalesce(p.sigma_gremio, '')) = '22A'
     and jsonb_typeof(p.sigma_ptto_lineas) = 'array' then
    select count(*) > 0, max(nullif(l->>'fecha', '')::date) into v_hay, v_f45
      from jsonb_array_elements(p.sigma_ptto_lineas) l
     where upper(trim(l->>'baremo')) = 'F45' and upper(coalesce(l->>'estado', '')) like 'ACEPTAD%';
  end if;
  if not coalesce(v_hay, false) then
    delete from public.eventos_sigma
     where parte_id = p_parte and tipo = 'DESATASCO CAMIÓN CUBA' and origen = 'auto' and enviado_en is null and not fecha_manual;
    perform set_config('kubel.eventos_bd', '', true);
    return;
  end if;
  -- Ya apuntado a mano (mismo nº de servicio) → no se duplica
  if exists (select 1 from public.eventos_sigma where tipo = 'DESATASCO CAMIÓN CUBA' and origen = 'manual'
              and (parte_id = p.id or servicio = p.numero_servicio)) then
    perform set_config('kubel.eventos_bd', '', true);
    return;
  end if;
  v_f45 := coalesce(v_f45, (now() at time zone 'Europe/Madrid')::date);
  select a.fecha, pf.nombre into v_primera, v_op
    from public.asignaciones a left join public.perfiles pf on pf.id = a.operario_id
   where a.parte_id = p.id and a.estado = 'hecho'
   order by a.fecha, a.hora nulls last limit 1;
  insert into public.eventos_sigma as e (tipo, parte_id, servicio, cuenta, direccion, poblacion, operario, fecha_visita, fecha_ref, aviso)
  values ('DESATASCO CAMIÓN CUBA', p.id, p.numero_servicio, p.sigma_cuenta, p.direccion, p.poblacion, v_op,
          coalesce(v_primera, v_f45), v_f45,
          case when v_primera is null then 'SIN VISITA EN KUBEL: DÍA DE LA F45' end)
  on conflict (parte_id) where tipo = 'DESATASCO CAMIÓN CUBA' and parte_id is not null do update set
    servicio = excluded.servicio, cuenta = excluded.cuenta, direccion = excluded.direccion, poblacion = excluded.poblacion,
    operario = case when e.fecha_manual then e.operario else excluded.operario end,
    fecha_visita = case when e.fecha_manual then e.fecha_visita else excluded.fecha_visita end,
    aviso = case when e.fecha_manual then null else excluded.aviso end,
    fecha_ref = case when e.enviado_en is not null then e.fecha_ref else excluded.fecha_ref end;
  perform set_config('kubel.eventos_bd', '', true);
end; $$;

-- Disparador: cambia el presupuesto, el gremio o la compañía
create or replace function public.partes_eventos_cuba() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.compania_id = 1 or old.compania_id = 1 then perform public.evento_cuba(new.id); end if;
  return null;
end; $$;
create or replace trigger partes_eventos_cuba after update of sigma_ptto_lineas, sigma_gremio, compania_id on public.partes
  for each row when (new.sigma_ptto_lineas is distinct from old.sigma_ptto_lineas or new.sigma_gremio is distinct from old.sigma_gremio
                     or new.compania_id is distinct from old.compania_id)
  execute function public.partes_eventos_cuba();

-- Visitas: la primera visita hecha puede cambiar el día del evento (amplía el de SQL 47)
create or replace function public.asignaciones_eventos() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform set_config('kubel.eventos_bd', '1', true);
    delete from public.eventos_sigma where asignacion_id = old.id and origen = 'auto' and enviado_en is null;
    perform set_config('kubel.eventos_bd', '', true);
    perform public.evento_urgencia(old.parte_id);
    if exists (select 1 from public.eventos_sigma where parte_id = old.parte_id and tipo = 'DESATASCO CAMIÓN CUBA') then
      perform public.evento_cuba(old.parte_id);
    end if;
    return old;
  end if;
  perform public.evento_fallida(new.id);
  if exists (select 1 from public.eventos_sigma where parte_id = new.parte_id and tipo = 'URGENCIA') then
    perform public.evento_urgencia(new.parte_id);
  end if;
  if exists (select 1 from public.eventos_sigma where parte_id = new.parte_id and tipo = 'DESATASCO CAMIÓN CUBA') then
    perform public.evento_cuba(new.parte_id);
  end if;
  return null;
end; $$;

-- Relleno con lo que ya hay
select public.evento_cuba(id) from public.partes
 where compania_id = 1 and upper(coalesce(sigma_gremio, '')) = '22A' and sigma_ptto_lineas::text ilike '%F45%';
