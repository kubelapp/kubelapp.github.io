-- KUBEL · SQL 46 · ONRED en Facturación (12/11/2026)
-- Parte 1 (aplicada 12/11 16:40): un servicio de ONRED entra en Facturación en cuanto el operario hace la visita
--   (no al cerrarse), con un comentario «PDTE…» propio de ONRED.
-- Parte 2: importe automático desde la «Valoración» de ONRED (botón Valoración de la ficha de gestión,
--   VerServicio.aspx?id=3_<nº>_6191). La lee el lector (v5) y la analiza onred-recibir (v4): onred_servicios.valoracion
--   → privado.onred_valoracion_volcar → partes.onred_importe (= aceptado + pendiente de aceptar, sin IVA)
--   → disparador partes_facturacion_onred → facturacion.importe (importe_origen = 'onred').
--   Lo liquidado, lo corregido a mano y lo que venga de una factura no se toca.

-- ───────────── Parte 1 ─────────────
create or replace function public.pdte_onred(p_estado text, p_onred text)
returns text language plpgsql immutable as $$
begin
  return public.pdte_onred(p_estado, p_onred, null::numeric);
end $$;

-- p_pend: importe de la Valoración pendiente de aceptar por ONRED
create or replace function public.pdte_onred(p_estado text, p_onred text, p_pend numeric)
returns text language plpgsql immutable as $$
begin
  if p_estado in ('cerrado','anulado') then return null; end if;
  if p_onred ilike '%confirmaci%' then return 'PDTE CONFIRMACIÓN EN ONRED'; end if;
  if p_onred ilike '%terminar%' then return 'PDTE TERMINAR EN ONRED'; end if;
  if coalesce(p_pend, 0) > 0 then return 'PDTE ACEPTAR VALORACIÓN ONRED'; end if;
  if p_estado = 'terminado' then return 'PDTE CIERRE EN ONRED'; end if;
  if p_estado = 'en_curso' then return 'PDTE TERMINAR REPARACIÓN'; end if;
  if coalesce(trim(p_onred),'') = '' then return null; end if;
  return 'PDTE: ' || upper(p_onred);
end $$;

-- ───────────── Parte 2: columnas ─────────────
alter table public.facturacion drop constraint if exists facturacion_importe_origen_check,
  add constraint facturacion_importe_origen_check check (importe_origen = any (array['presupuesto','manual','excel','factura','tasho','onred']));

alter table public.onred_servicios
  add column if not exists valoracion jsonb,           -- {siniestro, servicios:[{numero, profesion, estado, pend, acep, rech, total}], partidas:[…], totales}
  add column if not exists valoracion_en timestamptz,
  add column if not exists valoracion_error text;

alter table public.partes
  add column if not exists onred_valoracion jsonb,     -- la fila de este servicio + sus partidas
  add column if not exists onred_importe numeric(12,2),-- aceptado + pendiente (sin IVA); null = sin valorar
  add column if not exists onred_valoracion_en timestamptz;

create or replace function public.pdte_regla(p_parte uuid)
returns text language plpgsql stable security definer set search_path to 'public' as $$
declare p record;
begin
  select estado, sigma_estado, sigma_iva_pendiente, compania_id, onred_estado, onred_valoracion into p from public.partes where id = p_parte;
  if not found then return null; end if;
  if p.compania_id = 4 then
    return public.pdte_onred(p.estado, p.onred_estado, (p.onred_valoracion ->> 'pend')::numeric);
  end if;
  return public.pdte_de_parte(p.estado, p.sigma_estado, p.sigma_iva_pendiente);
end $$;

create or replace function public.facturacion_comentario_pdte()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare v text;
begin
  if new.liquidado then
    if new.comentario_auto is not null and new.comentario = new.comentario_auto then new.comentario := null; end if;
    new.comentario_auto := null; new.comentario_regla := null;
    return new;
  end if;
  if new.parte_id is null then return new; end if;
  if not exists (select 1 from public.partes where id = new.parte_id) then return new; end if;
  v := public.pdte_regla(new.parte_id);
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
end $function$;

create or replace function public.partes_comentario_pdte()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare v text; cierra boolean; f record;
begin
  v := case when new.compania_id = 4
            then public.pdte_onred(new.estado, new.onred_estado, (new.onred_valoracion ->> 'pend')::numeric)
            else public.pdte_de_parte(new.estado, new.sigma_estado, new.sigma_iva_pendiente) end;
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
end $function$;

create or replace trigger partes_comentario_pdte
after update of estado, sigma_estado, sigma_iva_pendiente, onred_estado, onred_valoracion on public.partes
for each row when (old.estado is distinct from new.estado or old.sigma_estado is distinct from new.sigma_estado
  or old.sigma_iva_pendiente is distinct from new.sigma_iva_pendiente or old.onred_estado is distinct from new.onred_estado
  or (old.onred_valoracion ->> 'pend') is distinct from (new.onred_valoracion ->> 'pend'))
execute function public.partes_comentario_pdte();

-- Visita hecha → ONRED entra en Facturación (el importe llega después con la Valoración)
create or replace function public.asignaciones_facturacion()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
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
    if exists (select 1 from public.partes p where p.id = new.parte_id and p.compania_id = 4 and p.estado <> 'anulado')
       and not exists (select 1 from public.facturacion where parte_id = new.parte_id) then
      perform public.facturacion_alta(new.parte_id, new.fecha, null);
      perform public.facturacion_por_onred_parte(new.parte_id);
    end if;
    perform public.facturacion_ultima_visita(new.parte_id);
  end if;
  return null;
end; $function$;

-- ───────────── Parte 2: importe ─────────────
-- Pasa el importe de la Valoración (partes.onred_importe) a la línea de Facturación
create or replace function public.facturacion_por_onred_parte(p_parte uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare p record;
begin
  select id, estado, compania_id, onred_importe, onred_valoracion into p from public.partes where id = p_parte;
  if not found or p.compania_id <> 4 or p.estado = 'anulado' or p.onred_importe is null then return; end if;
  update public.facturacion f set
    importe = p.onred_importe,
    importe_origen = 'onred',
    importe_nota = case
      when f.importe is not null and f.importe <> p.onred_importe
        then 'Valoración de ONRED cambiada: de ' || public.euros(f.importe) || ' a ' || public.euros(p.onred_importe)
      when coalesce((p.onred_valoracion ->> 'pend')::numeric, 0) > 0
        then 'Valoración ONRED: ' || public.euros(coalesce((p.onred_valoracion ->> 'acep')::numeric, 0)) || ' aceptado, '
             || public.euros((p.onred_valoracion ->> 'pend')::numeric) || ' pendiente de aceptar'
      else 'Valoración ONRED aceptada' end,
    importe_leido_en = now()
  where f.parte_id = p.id and not f.liquidado
    and (f.importe is null or f.importe_origen = 'onred')
    and (f.importe is distinct from p.onred_importe or f.importe_nota is null);
end $$;

create or replace function public.facturacion_por_onred()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.facturacion_por_onred_parte(new.id);
  return null;
end $$;

create or replace trigger partes_facturacion_onred
after update of estado, onred_importe, onred_valoracion on public.partes
for each row when (new.compania_id = 4)
execute function public.facturacion_por_onred();

-- Al cerrarse, la línea nueva coge también el importe (facturacion_por_cierre la crea antes en el mismo UPDATE:
-- el orden alfabético de disparadores hace que partes_facturacion vaya antes que partes_facturacion_onred).

-- Vuelca lo leído en onred_servicios.valoracion a partes (la fila del propio servicio)
create or replace function privado.onred_valoracion_volcar(p_numeros text[] default null)
returns int language plpgsql security definer set search_path = public, privado as $$
declare s record; v jsonb; fila jsonb; imp numeric; n int := 0;
begin
  for s in select o.numero, o.valoracion, o.valoracion_en from onred_servicios o
           where o.valoracion is not null and (p_numeros is null or o.numero = any(p_numeros)) loop
    select x into fila from jsonb_array_elements(coalesce(s.valoracion -> 'servicios', '[]')) as t(x)
     where x ->> 'numero' = s.numero limit 1;
    if fila is null then continue; end if;
    v := fila || jsonb_build_object(
           'siniestro', s.valoracion ->> 'siniestro',
           'partidas', coalesce((select jsonb_agg(x) from jsonb_array_elements(coalesce(s.valoracion -> 'partidas', '[]')) as t(x)
                                  where x ->> 'Servicio' = s.numero), '[]'::jsonb));
    imp := coalesce((fila ->> 'acep')::numeric, 0) + coalesce((fila ->> 'pend')::numeric, 0);
    if imp <= 0 then imp := null; end if;     -- 0 = aún sin valorar
    update partes set onred_valoracion = v, onred_importe = imp, onred_valoracion_en = s.valoracion_en
     where compania_id = 4 and numero_servicio = s.numero
       and (onred_valoracion is distinct from v or onred_importe is distinct from imp);
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Servicios cuya Valoración quiere KUBEL (los pide onred-recibir en la ronda 1): los de ONRED con línea de
-- Facturación sin liquidar cuyo importe no está puesto a mano; cada 3 h; los más antiguos antes.
create or replace function privado.onred_valorar(p_max int default 12)
returns text[] language sql stable security definer set search_path = public, privado as $$
  select coalesce(array_agg(numero), '{}') from (
    select p.numero_servicio as numero
      from partes p
      join facturacion f on f.parte_id = p.id and not f.liquidado and (f.importe is null or f.importe_origen = 'onred')
      left join onred_servicios o on o.numero = p.numero_servicio
     where p.compania_id = 4 and p.estado <> 'anulado' and p.numero_servicio ~ '^[0-9]{6,8}$'
       -- sin la 1.ª visita marcada en ONRED no hay Valoración (y pedir su ficha de gestión cierra la sesión)
       and coalesce(p.onred_estado, '') !~* '^(pendiente de cita|citado)'
       and (o.valoracion_en is null or o.valoracion_en < now() - interval '3 hours')   -- valoracion_en = último intento
     order by o.valoracion_en nulls first, (p.onred_estado is not null), f.fecha
     limit p_max) x
$$;
