-- KUBEL — SQL 55 (14/11/2026): teléfonos de ONRED desde «Personas Relacionadas».
-- El lector v8 manda la ficha con la tabla «Personas Relacionadas» abierta (onred-recibir la guarda en ficha.personas).
-- privado.onred_volcar: asegurado = personas que no son perjudicados (o lo son pero son el asegurado) + los números de
-- descripción, observaciones y comentarios; perjudicado = el resto de personas. Se rellenan solo las casillas vacías y los
-- números de más se añaden a la casilla 2 con « - ». Nunca se borra ni se cambia un teléfono ya escrito.

create or replace function privado.onred_volcar(p_numeros text[] default null)
returns jsonb language plpgsql security definer set search_path = public, privado as $$
declare
  s record; d jsonb; g jsonb; pid uuid; p record; nuevos jsonb := '[]'; cerrados jsonb := '[]'; unidos jsonb := '[]';
  est text; dir text; tels text[]; textos text; t1 text; t2 text; nuevo_estado text;
  dig text; perj text[]; tp1 text; tp2 text; x text;
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
    -- Teléfonos: 1.º «Personas Relacionadas» (lector v8); perjudicados aparte salvo que la persona sea el asegurado.
    -- Después, los que aparezcan en descripción, observaciones y comentarios (van con el asegurado).
    select privado.onred_telefonos(string_agg(concat_ws(' ', v ->> 'Tlf. 1', v ->> 'Tlf. 2'), ' | ')) into perj
      from jsonb_array_elements(coalesce(s.ficha -> 'personas', '[]')) as t(v)
      where coalesce(v ->> 'Relación', '') ~* 'perjudic' and coalesce(v ->> 'Persona Rel.', '') !~* 'asegurad';
    tels := privado.onred_telefonos(concat_ws(' | ',
      (select string_agg(concat_ws(' ', v ->> 'Tlf. 1', v ->> 'Tlf. 2'), ' | ') from jsonb_array_elements(coalesce(s.ficha -> 'personas', '[]')) as t(v)
        where not (coalesce(v ->> 'Relación', '') ~* 'perjudic' and coalesce(v ->> 'Persona Rel.', '') !~* 'asegurad')),
      d ->> 'descripcion', d ->> 'obs_domicilio', textos));
    tels := array(select n from unnest(tels) n where n <> all(coalesce(perj, '{}')));

    select * into p from partes where compania_id = 4 and numero_servicio = s.numero;
    if not found then
      if s.lista is null then continue; end if;   -- solo se dan de alta los que están vivos en ONRED
      insert into partes (compania_id, numero_servicio, origen, estado, asegurado, direccion, poblacion, codigo_postal,
                          gremio, descripcion, urgente, aseguradora, poliza, telefono, telefono2)
      values (4, s.numero, 'onred', 'pendiente', d ->> 'cliente', dir, d ->> 'poblacion', d ->> 'cp',
              privado.onred_gremio(d ->> 'profesion'), d ->> 'descripcion', coalesce(d ->> 'urgente', '') ~* '^s',
              d ->> 'procedencia', d ->> 'poliza', null, null)
      returning id into pid;
      nuevos := nuevos || jsonb_build_object('numero', s.numero, 'gremio', privado.onred_gremio(d ->> 'profesion'),
                  'direccion', concat_ws(', ', dir, d ->> 'poblacion'), 'urgente', coalesce(d ->> 'urgente', '') ~* '^s');
      select * into p from partes where id = pid;
    elsif p.onred_ficha_en is null then
      unidos := unidos || to_jsonb(s.numero);
    end if;

    -- Teléfonos: solo los que no estén ya escritos en el servicio. El 1.º en su casilla; los demás se añaden
    -- a la casilla 2 separados por « - » (la oficina los separa al llamar).
    dig := regexp_replace(concat_ws(' ', p.telefono, p.telefono2, p.telefono_perjudicado, p.telefono_perjudicado2), '\D', '', 'g');
    t1 := p.telefono; t2 := p.telefono2; tp1 := p.telefono_perjudicado; tp2 := p.telefono_perjudicado2;
    foreach x in array coalesce(tels, '{}') loop
      continue when position(right(x, 9) in dig) > 0;
      if coalesce(t1, '') = '' then t1 := x; else t2 := concat_ws(' - ', nullif(t2, ''), x); end if;
      dig := dig || x;
    end loop;
    foreach x in array coalesce(perj, '{}') loop
      continue when position(right(x, 9) in dig) > 0;
      if coalesce(tp1, '') = '' then tp1 := x; else tp2 := concat_ws(' - ', nullif(tp2, ''), x); end if;
      dig := dig || x;
    end loop;

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
      telefono = t1, telefono2 = t2, telefono_perjudicado = tp1, telefono_perjudicado2 = tp2
    where id = p.id
      and (onred_ficha_en is distinct from s.ficha_en or onred_lista is distinct from s.lista or estado <> nuevo_estado
           or telefono is distinct from t1 or telefono2 is distinct from t2
           or telefono_perjudicado is distinct from tp1 or telefono_perjudicado2 is distinct from tp2);
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
