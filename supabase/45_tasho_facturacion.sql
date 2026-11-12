-- 45 · TASHO → Facturación del panel admin (12/11/2026)
-- «Trabajos realizados» de TASHO (líneas valoradas por expediente) se guardan tal cual en
-- public.tasho_trabajos y privado.tasho_volcar_facturacion() las vuelca en Facturación:
--   · rellena el importe de las líneas TASHO que ya existen (Excel, altas a mano, cierres de KUBEL)
--   · crea la línea de los expedientes de TASHO que no tienen ninguna (desde el 01/08/2026)
--   · «facturado» en TASHO = cobrado → LIQUIDADO (una sola vez: si el admin lo quita, no se vuelve a poner)
-- Reglas: un importe escrito a mano (importe_origen = 'manual' u otro que no sea 'tasho') no se toca;
-- en líneas liquidadas solo se rellena el importe si estaba vacío. Con varias líneas del mismo
-- expediente (una por visita, como en el Excel), cada partida va a la línea de fecha más cercana.
-- Sustituye al disparador partes_facturacion_tasho (SQL 43), que queda desactivado.

-- 1) Líneas de «Trabajos realizados»
create table if not exists public.tasho_trabajos (
  id              bigserial primary key,
  clave           text not null unique,          -- md5 de id_exp|expediente|fecha|texto|precio|cantidad|total|nº de repetición
  id_exp          text not null,                 -- «ID» de TASHO (Id Exp.)
  expediente      text,                          -- nº de la compañía final (sin prefijo)
  prefijo         text,                          -- GE, SG, OR, PY, PRY…
  empresa         text,                          -- empresa que factura (Tasho S.L. / Repayma) cuando está facturado
  fecha           date,
  texto           text,
  precio          numeric,
  cantidad        numeric,
  total           numeric,
  facturado       boolean not null default false,
  primera_vez     timestamptz not null default now(),
  visto_en        timestamptz not null default now(),
  facturacion_id  uuid references public.facturacion(id) on delete set null
);
create index if not exists tasho_trabajos_exp_idx on public.tasho_trabajos (id_exp);
create index if not exists tasho_trabajos_fecha_idx on public.tasho_trabajos (fecha);
alter table public.tasho_trabajos enable row level security;
drop policy if exists tasho_trabajos_admin on public.tasho_trabajos;
create policy tasho_trabajos_admin on public.tasho_trabajos for select to authenticated
  using (exists (select 1 from public.perfiles p where p.id = auth.uid() and p.rol in ('admin', 'oficina')));

-- 2) Marca de «liquidado por TASHO» (para no volver a liquidar lo que el admin desmarca)
alter table public.facturacion add column if not exists tasho_liquidado_en timestamptz;
-- 'tasho' como origen de la línea y del importe (el SQL 43 lo usaba sin admitirlo en los check)
alter table public.facturacion
  drop constraint if exists facturacion_importe_origen_check,
  add constraint facturacion_importe_origen_check check (importe_origen = any (array['presupuesto','manual','excel','factura','tasho'])),
  drop constraint if exists facturacion_origen_check,
  add constraint facturacion_origen_check check (origen = any (array['auto','manual','excel','factura','tasho']));

-- 3) El volcado
create or replace function privado.tasho_volcar_facturacion(p_desde date default date '2026-08-01')
returns jsonb language plpgsql security definer set search_path to 'public', 'privado' as $$
declare
  e record; v_parte uuid; v_n int; v_dir text; v_cp text; l record;
  r_nuevas int := 0; r_importes int := 0; r_liquidadas int := 0; r_exps int := 0;
begin
  for e in
    select t.id_exp, max(t.expediente) as expediente, max(t.fecha) as fecha
      from public.tasho_trabajos t
     group by t.id_exp
    having max(t.fecha) >= p_desde
  loop
    r_exps := r_exps + 1;
    -- servicio de KUBEL (compañía Tasho = 3)
    select p.id into v_parte from public.partes p
     where p.compania_id = 3
       and (p.tasho_id_exp = e.id_exp or p.numero_servicio in (e.expediente, e.id_exp))
     order by (p.tasho_id_exp = e.id_exp) desc nulls last, p.creado_en desc limit 1;

    select count(*) into v_n from public.facturacion f
     where upper(coalesce(f.compania, '')) = 'TASHO'
       and (f.servicio in (e.expediente, e.id_exp) or (v_parte is not null and f.parte_id = v_parte));

    if v_n = 0 then
      if v_parte is not null then
        perform public.facturacion_alta(v_parte, e.fecha, null);   -- con fecha y operario de su última visita
      end if;
      if not exists (select 1 from public.facturacion f where upper(coalesce(f.compania, '')) = 'TASHO'
                      and (f.servicio in (e.expediente, e.id_exp) or (v_parte is not null and f.parte_id = v_parte))) then
        select substring(t.texto from '\(([^()]*)\)\s*$') into v_dir from public.tasho_trabajos t
         where t.id_exp = e.id_exp order by t.fecha desc, t.id desc limit 1;
        v_cp := substring(coalesce(v_dir, '') from '\m(\d{5})\M');
        insert into public.facturacion (servicio, fecha, compania, direccion, provincia, origen)
        values (coalesce(e.expediente, e.id_exp), e.fecha, 'TASHO', nullif(upper(trim(v_dir)), ''),
                case left(coalesce(v_cp, ''), 2) when '47' then 'VALLADOLID' when '34' then 'PALENCIA' end, 'tasho');
      end if;
      r_nuevas := r_nuevas + 1;
    end if;

    -- cada partida → la línea TASHO del expediente con la fecha más cercana (empate: la más reciente)
    update public.tasho_trabajos t set facturacion_id = (
      select f.id from public.facturacion f
       where upper(coalesce(f.compania, '')) = 'TASHO'
         and (f.servicio in (e.expediente, e.id_exp) or (v_parte is not null and f.parte_id = v_parte))
       order by abs(coalesce(f.fecha, t.fecha) - t.fecha), f.fecha desc nulls last, f.creado_en desc limit 1)
     where t.id_exp = e.id_exp;

    for l in
      select f.id, f.importe, f.importe_origen, f.liquidado, f.tasho_liquidado_en,
             round(sum(t.total), 2) as total, bool_and(t.facturado) as facturado, count(*) as partidas
        from public.tasho_trabajos t join public.facturacion f on f.id = t.facturacion_id
       where t.id_exp = e.id_exp
       group by f.id, f.importe, f.importe_origen, f.liquidado, f.tasho_liquidado_en
    loop
      if (l.importe is null or (l.importe_origen = 'tasho' and not l.liquidado)) and l.importe is distinct from l.total then
        update public.facturacion set
          importe = l.total, importe_origen = 'tasho', importe_leido_en = now(),
          importe_nota = case when l.importe is not null
                              then 'Trabajos realizados en TASHO: de ' || public.euros(l.importe) || ' a ' || public.euros(l.total)
                              else 'Trabajos realizados en TASHO: ' || l.partidas || ' partida' || case when l.partidas > 1 then 's' else '' end end
         where id = l.id;
        r_importes := r_importes + 1;
      end if;
      if l.facturado and not l.liquidado and l.tasho_liquidado_en is null then
        update public.facturacion set liquidado = true, tasho_liquidado_en = now(),
               factura = coalesce(factura, 'TASHO')
         where id = l.id;
        r_liquidadas := r_liquidadas + 1;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('expedientes', r_exps, 'lineas_nuevas', r_nuevas, 'importes', r_importes, 'liquidadas', r_liquidadas);
end $$;
revoke all on function privado.tasho_volcar_facturacion(date) from public, anon, authenticated;

-- 4) El disparador antiguo (importe del servicio entero a su línea) queda sustituido por el volcado
alter table public.partes disable trigger partes_facturacion_tasho;

-- ═════════════ 5) (12/11, 2.ª parte) Líneas con otro nº: alias, duplicadas y sin valorar ═════════════
-- En Facturación hay líneas TASHO con el nº de Parte, el Id Exp. o un nº mal escrito (Excel). El robot
-- busca cada nº desconocido en el buscador de TASHO (hasta 8 por pasada) y apunta a qué expediente
-- pertenece (public.tasho_alias); el volcado usa también esos números.
create table if not exists public.tasho_alias (
  numero      text primary key,          -- el nº tal como está en Facturación
  id_exp      text,                      -- null = no encontrado en TASHO
  expediente  text,
  parte       text,
  informado   boolean,
  fuente      text not null default 'robot',   -- robot / manual
  buscado_en  timestamptz not null default now()
);
alter table public.tasho_alias enable row level security;
drop policy if exists tasho_alias_ver on public.tasho_alias;
create policy tasho_alias_ver on public.tasho_alias for select to authenticated
  using (exists (select 1 from public.perfiles p where p.id = auth.uid() and p.rol in ('admin', 'oficina')));

create or replace function privado.tasho_volcar_facturacion(p_desde date default date '2026-08-01')
returns jsonb language plpgsql security definer set search_path to 'public', 'privado' as $$
declare
  e record; v_parte uuid; v_n int; v_dir text; v_cp text; l record; v_lineas uuid[]; v_principal record;
  r_nuevas int := 0; r_importes int := 0; r_liquidadas int := 0; r_exps int := 0; r_fusionadas int := 0; r_cero int := 0;
begin
  for e in
    select t.id_exp, max(t.expediente) as expediente, max(t.fecha) as fecha
      from public.tasho_trabajos t group by t.id_exp having max(t.fecha) >= p_desde
  loop
    r_exps := r_exps + 1;
    select p.id into v_parte from public.partes p
     where p.compania_id = 3 and (p.tasho_id_exp = e.id_exp or p.numero_servicio in (e.expediente, e.id_exp))
     order by (p.tasho_id_exp = e.id_exp) desc nulls last, p.creado_en desc limit 1;

    -- líneas TASHO del expediente: por nº de expediente, Id Exp., servicio de KUBEL o alias (parte / nº mal escrito)
    select array_agg(f.id) into v_lineas from public.facturacion f
     where upper(coalesce(f.compania, '')) = 'TASHO'
       and (f.servicio in (e.expediente, e.id_exp)
            or (v_parte is not null and f.parte_id = v_parte)
            or replace(f.servicio, ' ', '') in (select a.numero from public.tasho_alias a where a.id_exp = e.id_exp));
    v_n := coalesce(array_length(v_lineas, 1), 0);

    -- una línea creada por el volcado sobra si el expediente ya tiene otra (Excel, a mano, cierre de KUBEL)
    if v_n > 1 then
      with borr as (
        delete from public.facturacion f
         where f.id = any (v_lineas) and f.origen = 'tasho' and f.operario is null and f.comentario is null
           and coalesce(f.importe_origen, 'tasho') = 'tasho'
           and exists (select 1 from public.facturacion o where o.id = any (v_lineas) and o.origen <> 'tasho')
        returning f.id, f.liquidado, f.tasho_liquidado_en)
      select count(*) into v_n from borr;
      r_fusionadas := r_fusionadas + v_n;
      -- lo liquidado por TASHO se pasa a la que queda (se recalcula abajo con tasho_liquidado_en vacío)
      select array_agg(f.id) into v_lineas from public.facturacion f where f.id = any (v_lineas);
      v_n := coalesce(array_length(v_lineas, 1), 0);
    end if;

    if v_n = 0 then
      if v_parte is not null then perform public.facturacion_alta(v_parte, e.fecha, null); end if;
      select array_agg(f.id) into v_lineas from public.facturacion f
       where upper(coalesce(f.compania, '')) = 'TASHO'
         and (f.servicio in (e.expediente, e.id_exp) or (v_parte is not null and f.parte_id = v_parte));
      if v_lineas is null then
        select substring(t.texto from '\(([^()]*)\)\s*$') into v_dir from public.tasho_trabajos t
         where t.id_exp = e.id_exp order by t.fecha desc, t.id desc limit 1;
        v_cp := substring(coalesce(v_dir, '') from '\m(\d{5})\M');
        insert into public.facturacion (servicio, fecha, compania, direccion, provincia, origen)
        values (coalesce(e.expediente, e.id_exp), e.fecha, 'TASHO', nullif(upper(trim(v_dir)), ''),
                case left(coalesce(v_cp, ''), 2) when '47' then 'VALLADOLID' when '34' then 'PALENCIA' end, 'tasho')
        returning array[id] into v_lineas;
      end if;
      r_nuevas := r_nuevas + 1;
    end if;

    -- cada partida → la línea con la fecha más cercana (empate: la más reciente)
    update public.tasho_trabajos t set facturacion_id = (
      select f.id from public.facturacion f where f.id = any (v_lineas)
       order by abs(coalesce(f.fecha, t.fecha) - t.fecha), f.fecha desc nulls last, f.creado_en desc limit 1)
     where t.id_exp = e.id_exp;

    for l in
      select f.id, f.importe, f.importe_origen, f.liquidado, f.tasho_liquidado_en,
             round(sum(t.total), 2) as total, bool_and(t.facturado) as facturado, count(*) as partidas
        from public.tasho_trabajos t join public.facturacion f on f.id = t.facturacion_id
       where t.id_exp = e.id_exp
       group by f.id, f.importe, f.importe_origen, f.liquidado, f.tasho_liquidado_en
    loop
      if (l.importe is null or (l.importe_origen = 'tasho' and not l.liquidado)) and l.importe is distinct from l.total then
        update public.facturacion set importe = l.total, importe_origen = 'tasho', importe_leido_en = now(),
          importe_nota = case when l.importe is not null
                              then 'Trabajos realizados en TASHO: de ' || public.euros(l.importe) || ' a ' || public.euros(l.total)
                              else 'Trabajos realizados en TASHO (Id Exp. ' || e.id_exp || '): ' || l.partidas || ' partida' || case when l.partidas > 1 then 's' else '' end end
         where id = l.id;
        r_importes := r_importes + 1;
      end if;
      if l.facturado and not l.liquidado and l.tasho_liquidado_en is null then
        update public.facturacion set liquidado = true, tasho_liquidado_en = now(), factura = coalesce(factura, 'TASHO') where id = l.id;
        r_liquidadas := r_liquidadas + 1;
      end if;
    end loop;

    -- otras líneas del mismo expediente (otra visita) sin partidas propias → 0 €, con aviso de dónde está el importe
    select f.fecha, bool_and(t.facturado) as facturado into v_principal
      from public.tasho_trabajos t join public.facturacion f on f.id = t.facturacion_id
     where t.id_exp = e.id_exp group by f.id, f.fecha order by sum(t.total) desc limit 1;
    update public.facturacion f set importe = 0, importe_origen = 'tasho', importe_leido_en = now(),
           importe_nota = 'Sin partidas propias en TASHO (Id Exp. ' || e.id_exp || '): el importe va en la línea del ' || to_char(v_principal.fecha, 'DD/MM/YYYY'),
           liquidado = f.liquidado or (v_principal.facturado and f.tasho_liquidado_en is null),
           tasho_liquidado_en = case when not f.liquidado and v_principal.facturado and f.tasho_liquidado_en is null then now() else f.tasho_liquidado_en end
     where f.id = any (v_lineas) and f.importe is null
       and not exists (select 1 from public.tasho_trabajos t where t.facturacion_id = f.id);
    get diagnostics v_n = row_count; r_cero := r_cero + v_n;
  end loop;

  -- expedientes INFORMADOS en TASHO sin ninguna partida valorada (rebote, sin cobertura…): 0 € pasado un mes
  update public.facturacion f set importe = 0, importe_origen = 'tasho', importe_leido_en = now(),
         importe_nota = 'Informado en TASHO sin trabajos valorados (Id Exp. ' || a.id_exp || coalesce(', parte ' || a.parte, '') || ')'
    from public.tasho_alias a
   where upper(coalesce(f.compania, '')) = 'TASHO' and f.importe is null and a.informado and a.id_exp is not null
     and replace(f.servicio, ' ', '') = a.numero and f.fecha < current_date - 30
     and not exists (select 1 from public.tasho_trabajos t where t.id_exp = a.id_exp);
  get diagnostics v_n = row_count; r_cero := r_cero + v_n;

  -- nº que TASHO no conoce: se avisa en la línea
  update public.facturacion f set importe_nota = 'Nº no encontrado en TASHO: revisar el nº del servicio'
    from public.tasho_alias a
   where upper(coalesce(f.compania, '')) = 'TASHO' and f.importe is null and a.id_exp is null
     and replace(f.servicio, ' ', '') = a.numero and f.importe_nota is distinct from 'Nº no encontrado en TASHO: revisar el nº del servicio';

  return jsonb_build_object('expedientes', r_exps, 'lineas_nuevas', r_nuevas, 'importes', r_importes, 'liquidadas', r_liquidadas,
                            'fusionadas', r_fusionadas, 'a_cero', r_cero);
end $$;
revoke all on function privado.tasho_volcar_facturacion(date) from public, anon, authenticated;

-- Líneas TASHO sin importe cuyo nº aún no se ha buscado (las pide el robot, hasta 8 por pasada)
create or replace function privado.tasho_alias_pendientes(p_max int default 8)
returns table (numero text) language sql security definer set search_path to 'public' as $$
  select distinct replace(f.servicio, ' ', '') from public.facturacion f
   where upper(coalesce(f.compania, '')) = 'TASHO' and f.importe is null and f.fecha >= date '2026-08-01'
     and not exists (select 1 from public.tasho_trabajos t where t.id_exp = replace(f.servicio, ' ', '') or t.expediente = replace(f.servicio, ' ', ''))
     and not exists (select 1 from public.tasho_alias a where a.numero = replace(f.servicio, ' ', '')
                      and (a.id_exp is not null and (a.informado or a.buscado_en > now() - interval '1 day')
                           or a.buscado_en > now() - interval '7 days'))
   limit p_max
$$;
revoke all on function privado.tasho_alias_pendientes(int) from public, anon, authenticated;
