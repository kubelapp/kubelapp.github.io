-- KUBEL — SQL 41 (11/11/2026): ONRED, primera fase SOLO LECTURA.
-- El «lector» del servidor kubel-onred (Clouding, Barcelona) entra en ONRED, descarga las listas
-- (Pendiente de cita, Citado pendiente de atención, En curso) y la ficha de cada servicio, y se las
-- manda a la Edge Function onred-recibir, que las analiza y las guarda AQUÍ (todavía no en partes).
-- Así se comprueba lo que llega antes de volcarlo en Servicios.

-- Servicios vistos en ONRED (uno por nº de servicio onRed)
create table if not exists public.onred_servicios (
  numero          text primary key,            -- nº servicio onRed (7 cifras)
  lista           text,                        -- pendiente_cita / citado / en_curso; null = ya no sale en ninguna
  columnas        jsonb,                       -- la fila de la lista tal cual (Fecha Cita, Fec.Caduca, Población…)
  ficha           jsonb,                       -- {datos, otros, comentarios, gremios} de VerServicio.aspx
  ficha_en        timestamptz,
  ficha_error     text,
  primera_vez     timestamptz not null default now(),
  visto_en        timestamptz,                 -- última lectura en la que salía en alguna lista
  desaparecido_en timestamptz,                 -- dejó de salir en las tres listas
  parte_id        uuid references public.partes(id) on delete set null  -- (fase 2) servicio de KUBEL
);

-- Registro de cada pasada del lector
create table if not exists public.onred_lecturas (
  id            bigserial primary key,
  en            timestamptz not null default now(),
  ok            boolean not null,
  error         text,
  profesional   text,
  lector        text,                          -- versión del programa del servidor
  listas        jsonb,                         -- nº de filas por lista
  fichas        int,
  nuevos        int,
  desaparecidos int,
  segundos      numeric
);
create index if not exists onred_lecturas_en on public.onred_lecturas (en desc);

alter table public.onred_servicios enable row level security;
alter table public.onred_lecturas enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'onred_servicios' and policyname = 'oficina ve onred') then
    create policy "oficina ve onred" on public.onred_servicios for select to authenticated using (public.es_oficina());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'onred_lecturas' and policyname = 'oficina ve lecturas onred') then
    create policy "oficina ve lecturas onred" on public.onred_lecturas for select to authenticated using (public.es_oficina());
  end if;
end $$;

-- Secreto del lector: en la BD solo se guarda su huella SHA-256 (el secreto vive solo en el servidor,
-- en /etc/kubel-onred.env). Se pone con:
--   insert into privado.ajustes (clave, valor) values ('onred_lector_hash', '<huella>')
--   on conflict (clave) do update set valor = excluded.valor;

-- Limpieza: registro de lecturas 30 días
select cron.schedule('kubel-onred-limpiar', '40 3 * * *',
  $$delete from public.onred_lecturas where en < now() - interval '30 days'$$);
