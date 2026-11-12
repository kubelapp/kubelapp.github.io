-- 48 · OnRed que llega por TASHO (12/11/2026)
-- TASHO (gestora) también pasa a KUBEL servicios de OnRed, con nº de 7 cifras igual que los de nuestra propia
-- cuenta de ONRED (profesional 6191). Son de TASHO (los paga TASHO; en KUBEL: compañía Tasho, aseguradora OnRed).
-- Reglas:
--   · tasho-sync v1.4 adopta un alta manual con compañía OnRed que el lector de ONRED no conoce y que TASHO trae
--     (pasa a compañía Tasho y su línea de Facturación a TASHO).
--   · Un alta o cambio A MANO no puede repetir un nº que ya es de la otra vía (aviso claro en la web).

create or replace function public.partes_tasho_onred()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_num text := replace(new.numero_servicio, ' ', '');
begin
  if new.origen <> 'manual' or new.compania_id not in (3, 4) then return new; end if;
  if new.compania_id = 4 and (
       exists (select 1 from public.partes p where p.compania_id = 3 and p.id <> new.id and replace(p.numero_servicio, ' ', '') = v_num)
       or exists (select 1 from public.tasho_trabajos t where t.expediente = v_num)
       or exists (select 1 from public.tasho_alias a where a.expediente = v_num)) then
    raise exception 'El nº % es un servicio de OnRed que llega por TASHO: dalo de alta con la compañía Tasho (aseguradora OnRed), no como ONRED.', new.numero_servicio;
  end if;
  if new.compania_id = 3 and (
       exists (select 1 from public.partes p where p.compania_id = 4 and p.id <> new.id and replace(p.numero_servicio, ' ', '') = v_num)
       or exists (select 1 from public.onred_servicios o where o.numero = v_num)) then
    raise exception 'El nº % es de nuestra cuenta de ONRED (no llega por TASHO): dalo de alta con la compañía OnRed.', new.numero_servicio;
  end if;
  return new;
end $$;

create or replace trigger partes_tasho_onred
  before insert or update of numero_servicio, compania_id on public.partes
  for each row execute function public.partes_tasho_onred();
