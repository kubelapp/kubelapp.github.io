-- 50 · Comentario «PDTE…» de Facturación para compañías sin reglas SIGMA (12/11/2026)
-- TASHO (3): ya no sale «PDTE CIERRE EN SIGMA». Terminado → «PDTE INFORMAR PARTE EN TASHO»;
--   en curso → «PDTE TERMINAR REPARACIÓN»; pendiente de cita en TASHO → «PDTE CITA EN TASHO».
-- HomeServe (2) y YAVOI (5): solo «PDTE TERMINAR REPARACIÓN» si siguen en curso
--   (rama del 12/11 que había quedado pisada por el SQL 46).
-- ONRED (4) y SIGMA: sin cambios.

create or replace function public.pdte_sin_robot(p_estado text, p_tasho text)
returns text language plpgsql immutable as $f$
begin
  if p_estado in ('cerrado','anulado') then return null; end if;
  if p_tasho is not null then
    if p_estado = 'terminado' then return 'PDTE INFORMAR PARTE EN TASHO'; end if;
    if p_estado = 'en_curso' then return 'PDTE TERMINAR REPARACIÓN'; end if;
    if p_tasho = 'pendiente_cita' then return 'PDTE CITA EN TASHO'; end if;
    return null;
  end if;
  if p_estado = 'en_curso' then return 'PDTE TERMINAR REPARACIÓN'; end if;
  return null;
end $f$;

create or replace function public.pdte_regla(p_parte uuid)
 returns text language plpgsql stable security definer set search_path to 'public'
as $function$
declare p record;
begin
  select estado, sigma_estado, sigma_iva_pendiente, compania_id, onred_estado, onred_valoracion, tasho_estado into p from public.partes where id = p_parte;
  if not found then return null; end if;
  if p.compania_id = 4 then
    return public.pdte_onred(p.estado, p.onred_estado, (p.onred_valoracion ->> 'pend')::numeric);
  end if;
  if p.compania_id = 3 then return public.pdte_sin_robot(p.estado, coalesce(p.tasho_estado, '')); end if;
  if p.compania_id in (2, 5) then return public.pdte_sin_robot(p.estado, null); end if;
  return public.pdte_de_parte(p.estado, p.sigma_estado, p.sigma_iva_pendiente);
end $function$;

create or replace function public.partes_comentario_pdte()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v text; cierra boolean; f record;
begin
  v := case when new.compania_id = 4
            then public.pdte_onred(new.estado, new.onred_estado, (new.onred_valoracion ->> 'pend')::numeric)
            when new.compania_id = 3 then public.pdte_sin_robot(new.estado, coalesce(new.tasho_estado, ''))
            when new.compania_id in (2, 5) then public.pdte_sin_robot(new.estado, null)
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

-- Rehacer los comentarios automáticos abiertos de TASHO / HomeServe / YAVOI
update public.facturacion f set comentario = r.v, comentario_auto = r.v, comentario_regla = r.v
from (select f2.id, public.pdte_regla(f2.parte_id) v from public.facturacion f2 join public.partes p on p.id = f2.parte_id
      where not f2.liquidado and p.compania_id in (2,3,5)) r
where f.id = r.id and r.v is distinct from f.comentario_regla
  and (coalesce(trim(f.comentario),'') = '' or f.comentario = f.comentario_auto);
