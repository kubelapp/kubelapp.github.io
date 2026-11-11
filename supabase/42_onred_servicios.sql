-- KUBEL — SQL 42 (11/11/2026): ONRED fase 2 — volcar en Servicios (partes) lo que trae el lector.
-- * Un servicio por nº onRed y compañía OnRed (id 4). Si ya existe (dado de alta a mano) se UNIFICA:
--   solo se rellenan los huecos (población, CP, gremio, aseguradora, póliza, cliente, teléfonos, descripción);
--   lo escrito por la oficina no se pisa.
-- * Teléfonos: no hay campo en la ficha de ONRED → se sacan de comentarios, descripción y observaciones.
-- * Cierre: si deja de salir en las listas y su ficha dice terminado / cerrado / revisado / facturado →
--   cerrado (anulado → anulado). Si vuelve a salir en las listas, se reabre al estado que tenía.
-- * La cita de ONRED se guarda como dato (onred_cita); las visitas a operarios las sigue poniendo la oficina.
-- * 1695583 estaba dado de alta en Tasho y es de ONRED (Mutua de Propietarios) → pasa a OnRed.
-- La llama la Edge Function onred-recibir tras guardar cada envío del lector.

alter table public.partes drop constraint if exists partes_origen_check;
alter table public.partes add constraint partes_origen_check check (origen = any (array['manual', 'sigma', 'onred']));

alter table public.partes
  add column if not exists onred_estado text,          -- estado del gremio en ONRED («Citado Pendiente de atención»…)
  add column if not exists onred_lista text,           -- pendiente_cita / citado / en_curso; null = no sale en las listas
  add column if not exists onred_en_curso boolean,     -- sale en alguna lista
  add column if not exists onred_cita text,            -- «12/11/2026 11:00:00 - 12:00» o «… Llamar para quedar»
  add column if not exists onred_ficha jsonb,          -- {datos, otros, gremios} de VerServicio.aspx
  add column if not exists onred_bitacora jsonb,       -- comentarios [{Fecha, Texto, Usuario, Tipo}]
  add column if not exists onred_ficha_en timestamptz,
  add column if not exists onred_estado_antes text;    -- estado KUBEL antes de cerrarlo el robot (para reabrir)

update public.partes set compania_id = 4 where numero_servicio = '1695583' and compania_id = 3;

-- Gremio de KUBEL a partir de la «Profesión» de ONRED
create or replace function privado.onred_gremio(prof text) returns text language sql immutable as $$
  select case
    when prof is null or prof = '' then null
    when prof ~* '^fontan' then 'Fontanería'
    when prof ~* '^pint' then 'Pintura'
    when prof ~* '^alba' then 'Albañilería'
    when prof ~* '^electric' then 'Electricidad'
    when prof ~* '^carpint' then 'Carpintería'
    when prof ~* '^escayol' then 'Escayolista'
    else initcap(prof) end $$;

-- Teléfonos españoles (fijos y móviles, sin 90x) que aparecen en un texto, en orden y sin repetir
create or replace function privado.onred_telefonos(t text) returns text[] language sql immutable as $$
  select coalesce(array_agg(n order by pos), '{}') from (
    select n, min(pos) pos from (
      select regexp_replace(m[1], '\D', '', 'g') n, row_number() over () pos
      from regexp_matches(coalesce(t, ''),
        '(?:^|[^\d+])(?:\+?34[ .]?)?([6789]\d{8}|[6789]\d{2}[ .]\d{3}[ .]\d{3}|[6789]\d{2}[ .]\d{2}[ .]\d{2}[ .]\d{2})(?!\d)', 'g') m
    ) x
    where n !~ '^90' group by n
  ) y $$;

create or replace function privado.onred_volcar(p_numeros text[] default null)
returns jsonb language plpgsql security definer set search_path = public, privado as $$
declare
  s record; d jsonb; g jsonb; pid uuid; p record; nuevos jsonb := '[]'; cerrados jsonb := '[]'; unidos jsonb := '[]';
  est text; dir text; tels text[]; textos text; t1 text; t2 text; nuevo_estado text;
  dig text;
begin
  for s in select * from onred_servicios
           where ficha is not null and (p_numeros is null or numero = any(p_numeros)) loop
    d := s.ficha -> 'datos';
    g := null;
    select v into g from jsonb_array_elements(coalesce(s.ficha -> 'gremios', '[]')) as t(v)
      where v ->> 'N.Servicio' = s.numero limit 1;
    if g is null then g := s.ficha -> 'gremios' -> 0; end if;
    est := nullif(g ->> 'Estado', '');
    dir := nullif(trim(concat_ws(' ', d ->> 'direccion', d ->> 'numero_via', d ->> 'piso')), '');
    select string_agg(coalesce(v ->> 'Texto del Comentario', v ->> 'Texto'), ' | ') into textos from jsonb_array_elements(coalesce(s.ficha -> 'comentarios', '[]')) as t(v);
    tels := privado.onred_telefonos(concat_ws(' | ', d ->> 'descripcion', d ->> 'obs_domicilio', textos));

    select * into p from partes where compania_id = 4 and numero_servicio = s.numero;
    if not found then
      if s.lista is null then continue; end if;   -- solo se dan de alta los que están vivos en ONRED
      insert into partes (compania_id, numero_servicio, origen, estado, asegurado, direccion, poblacion, codigo_postal,
                          gremio, descripcion, urgente, aseguradora, poliza, telefono, telefono2)
      values (4, s.numero, 'onred', 'pendiente', d ->> 'cliente', dir, d ->> 'poblacion', d ->> 'cp',
              privado.onred_gremio(d ->> 'profesion'), d ->> 'descripcion', coalesce(d ->> 'urgente', '') ~* '^s',
              d ->> 'procedencia', d ->> 'poliza', tels[1], tels[2])
      returning id into pid;
      nuevos := nuevos || jsonb_build_object('numero', s.numero, 'gremio', privado.onred_gremio(d ->> 'profesion'),
                  'direccion', concat_ws(', ', dir, d ->> 'poblacion'), 'urgente', coalesce(d ->> 'urgente', '') ~* '^s');
      select * into p from partes where id = pid;
    elsif p.onred_ficha_en is null then
      unidos := unidos || to_jsonb(s.numero);
    end if;

    -- Teléfonos: solo los que no estén ya escritos en el servicio
    dig := regexp_replace(concat_ws(' ', p.telefono, p.telefono2, p.telefono_perjudicado, p.telefono_perjudicado2), '\D', '', 'g');
    t1 := p.telefono; t2 := p.telefono2;
    if tels is not null then
      for i in 1 .. coalesce(array_length(tels, 1), 0) loop
        continue when position(right(tels[i], 9) in dig) > 0;
        if coalesce(t1, '') = '' then t1 := tels[i]; dig := dig || tels[i];
        elsif coalesce(t2, '') = '' then t2 := tels[i]; dig := dig || tels[i]; end if;
      end loop;
    end if;

    -- Cierre / reapertura
    nuevo_estado := p.estado;
    if s.lista is null and est ~* 'anulad' and p.estado not in ('cerrado', 'anulado') then
      nuevo_estado := 'anulado';
    elsif s.lista is null and est ~* '(termin|cerrad|revisad|factur|liquid)' and p.estado not in ('cerrado', 'anulado') then
      nuevo_estado := 'cerrado';
    elsif s.lista is not null and p.estado in ('cerrado', 'anulado') and p.onred_estado_antes is not null then
      nuevo_estado := p.onred_estado_antes;
    end if;
    if nuevo_estado <> p.estado and nuevo_estado in ('cerrado', 'anulado') then
      cerrados := cerrados || jsonb_build_object('numero', s.numero, 'estado', nuevo_estado);
    end if;

    update partes set
      onred_estado = est, onred_lista = s.lista, onred_en_curso = s.lista is not null,
      onred_cita = d ->> 'cita', onred_ficha = s.ficha - 'comentarios', onred_bitacora = s.ficha -> 'comentarios',
      onred_ficha_en = s.ficha_en,
      onred_estado_antes = case when nuevo_estado in ('cerrado', 'anulado') and p.estado not in ('cerrado', 'anulado') then p.estado
                                when nuevo_estado not in ('cerrado', 'anulado') then null else p.onred_estado_antes end,
      estado = nuevo_estado,
      asegurado = coalesce(nullif(p.asegurado, ''), d ->> 'cliente'),
      direccion = coalesce(nullif(p.direccion, ''), dir),
      poblacion = coalesce(nullif(p.poblacion, ''), d ->> 'poblacion'),
      codigo_postal = coalesce(nullif(p.codigo_postal, ''), d ->> 'cp'),
      gremio = coalesce(nullif(p.gremio, ''), privado.onred_gremio(d ->> 'profesion')),
      descripcion = coalesce(nullif(p.descripcion, ''), d ->> 'descripcion'),
      aseguradora = coalesce(nullif(p.aseguradora, ''), d ->> 'procedencia'),
      poliza = coalesce(nullif(p.poliza, ''), d ->> 'poliza'),
      urgente = p.urgente or coalesce(d ->> 'urgente', '') ~* '^s',
      telefono = t1, telefono2 = t2
    where id = p.id
      and (onred_ficha_en is distinct from s.ficha_en or onred_lista is distinct from s.lista or estado <> nuevo_estado
           or telefono is distinct from t1 or telefono2 is distinct from t2);
    update onred_servicios set parte_id = p.id where numero = s.numero and parte_id is distinct from p.id;
  end loop;

  -- Servicios ya enlazados que han dejado de salir en las listas (sin ficha nueva todavía)
  update partes pa set onred_lista = null, onred_en_curso = false
  from onred_servicios os
  where os.parte_id = pa.id and os.lista is null and pa.onred_en_curso is distinct from false
    and (p_numeros is null or os.numero = any(p_numeros));

  return jsonb_build_object('nuevos', nuevos, 'cerrados', cerrados, 'unidos', unidos);
end; $$;
revoke execute on function privado.onred_volcar(text[]) from public, anon, authenticated;
