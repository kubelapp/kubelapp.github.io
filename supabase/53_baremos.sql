-- =====================================================================
--  53 · Baremos (13/11/2026)
--  Menú «Baremos ▾» de la oficina: una página por tabla de baremos de una
--  compañía (SIGMA, ONRED…), con sus gremios, partidas, precios y normas.
--  Solo lectura para la oficina y el admin; se cargan desde el PDF de la
--  compañía (la carga la hace Claude; los datos NO van en este repo, que es
--  público: el baremo de SIGMA es «Internal»).
--  Añadir otro baremo = una fila en baremo_tablas + sus gremios en baremos.
-- =====================================================================
create table if not exists public.baremo_tablas (
  id            text primary key,              -- 'sigma', 'onred'…
  nombre        text not null,                 -- lo que sale en el menú
  titulo        text not null,                 -- cabecera de la página
  fuente        text,                          -- PDF del que sale
  vigencia      text,                          -- p. ej. '2026'
  orden         int  not null default 0,
  activa        boolean not null default true,
  actualizado_en timestamptz not null default now()
);

create table if not exists public.baremos (
  id            bigserial primary key,
  tabla         text not null references public.baremo_tablas (id) on update cascade on delete cascade,
  orden         int  not null,
  gremio        text not null,
  -- [{t:'sec', x}, {t:'tabla', titulo, cols:[…], filas:[{c: código, d: descripción, p:[precios]}]}, {t:'nota', x:[párrafos]}]
  bloques       jsonb not null default '[]',
  unique (tabla, orden)
);

alter table public.baremo_tablas enable row level security;
alter table public.baremos enable row level security;

drop policy if exists "oficina y admin leen baremo_tablas" on public.baremo_tablas;
create policy "oficina y admin leen baremo_tablas" on public.baremo_tablas
  for select to authenticated using (public.es_oficina() or public.es_admin());
drop policy if exists "oficina y admin leen baremos" on public.baremos;
create policy "oficina y admin leen baremos" on public.baremos
  for select to authenticated using (public.es_oficina() or public.es_admin());

insert into public.baremo_tablas (id, nombre, titulo, fuente, vigencia, orden) values
  ('sigma', 'SIGMA', 'Baremo SIGMA (Multiasistencia)', 'BAREMOS_SIGMA.pdf', null, 1),
  ('onred', 'ONRED', 'Baremo onRed 2026 · Profesionales', 'Baremo_onRed_2026_AProfesionales.pdf', '2026', 2)
on conflict (id) do nothing;
