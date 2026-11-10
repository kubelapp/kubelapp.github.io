-- =====================================================================
--  40 · Gastos (10/11/2026) · panel admin → página «Gastos»
--  Sustituye a la hoja «Transacciones → Gastos» del Excel de ingresos y gastos.
--  · Cada línea: fecha, proveedor, descripción, categoría, base (sin IVA), % IVA, IVA y total.
--    En la web se escribe el importe sin IVA o con IVA y el otro se calcula.
--  · DESACTIVADO por decisión del usuario (10/11/2026): foto/PDF de la factura de papel
--    (bucket `gastos`; bloque comentado más abajo). Los gastos se meten a mano.
--  · ACTIVADO el 11/11/2026 (al final del archivo): cada informe del operario con
--    «IMPORTE TOTAL DE LA FACTURA» o foto de factura crea un BORRADOR (Materiales, 21 %,
--    importe = con IVA) que el admin revisa y confirma en Gastos.
--  · Gastos fijos del mes (alquiler, seguros, sueldos…) desde las categorías marcadas «fijo».
--  Solo admin (RLS es_admin()).
-- =====================================================================

-- ---------- Categorías ----------
create table if not exists public.gasto_categorias (
  nombre        text primary key,
  grupo         text not null default 'variable' check (grupo in ('variable', 'fijo', 'sueldo', 'impuestos')),
  iva_def       numeric(4,1) not null default 21,     -- % de IVA que se propone
  fijo          boolean not null default false,       -- entra en «Generar fijos del mes»
  fijo_importe  numeric(10,2),                        -- importe sin IVA que se propone cada mes
  previsto      numeric(10,2),                        -- presupuesto mensual (sin IVA)
  orden         int not null default 100,
  activa        boolean not null default true,
  creado_en     timestamptz not null default now()
);
alter table public.gasto_categorias enable row level security;
create policy "admin gestiona categorias de gasto" on public.gasto_categorias for all to authenticated
  using (public.es_admin()) with check (public.es_admin());

insert into public.gasto_categorias (nombre, grupo, iva_def, fijo, orden) values
  ('Materiales',              'variable',  21, false, 10),
  ('Maquinas',                'variable',  21, false, 20),
  ('LUIS NAVAS ELECTRICISTA', 'variable',  21, false, 30),
  ('Desescombro',             'variable',  21, false, 40),
  ('Gasolina',                'variable',  21, false, 50),
  ('Alquiler Locales',        'fijo',      21, true,  60),
  ('Seguro Locales',          'fijo',       0, true,  70),
  ('Seguro Furgo',            'fijo',       0, true,  80),
  ('DIGI',                    'fijo',      21, true,  90),
  ('DOKIFY',                  'fijo',      21, true, 100),
  ('CANNON YAVOI',            'fijo',      21, true, 110),
  ('GESTORIA',                'fijo',      21, true, 120),
  ('Sueldo Aitor',            'sueldo',     0, true, 200),
  ('Sueldo Alejandro',        'sueldo',     0, true, 210),
  ('Sueldo Said',             'sueldo',     0, true, 220),
  ('Autónomos',               'impuestos',  0, true, 300),
  ('S.S',                     'impuestos',  0, true, 310),
  ('IRPF Trimestral',         'impuestos',  0, false, 320),
  ('Otros',                   'variable',  21, false, 900)
on conflict (nombre) do nothing;

-- ---------- Gastos ----------
create table if not exists public.gastos (
  id           uuid primary key default gen_random_uuid(),
  fecha        date not null default current_date,
  proveedor    text,
  descripcion  text,
  categoria    text references public.gasto_categorias (nombre) on update cascade,
  base         numeric(10,2),                 -- sin IVA
  iva_pct      numeric(4,1) not null default 21,
  iva          numeric(10,2),
  total        numeric(10,2),                 -- con IVA
  factura      text,                          -- nº de factura del proveedor
  adjuntos     text[] not null default '{}',  -- 'gastos:<ruta>' (subidas aquí) o 'fotos:<ruta>' (foto de factura del operario)
  pagado       boolean not null default true,
  estado       text not null default 'ok' check (estado in ('borrador', 'ok')),
  origen       text not null default 'manual' check (origen in ('manual', 'informe', 'fijo', 'excel')),
  parte_id     uuid references public.partes (id) on delete set null,
  servicio     text,                          -- nº de servicio (texto, para listar sin leer partes)
  operario     text,
  informe_id   uuid unique references public.informes (id) on delete set null,
  comentario   text,
  creado_por   uuid default auth.uid(),
  creado_en    timestamptz not null default now(),
  editado_en   timestamptz
);
alter table public.gastos enable row level security;
create policy "admin gestiona gastos" on public.gastos for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create index if not exists gastos_fecha on public.gastos (fecha);
alter publication supabase_realtime add table public.gastos;

-- ---------- Gastos fijos del mes ----------
-- Crea en borrador un gasto por cada categoría «fijo» activa que aún no tenga gasto ese mes.
create or replace function public.generar_gastos_fijos(p_mes date)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.es_admin() then raise exception 'Solo el administrador.'; end if;
  insert into gastos (fecha, descripcion, categoria, base, iva_pct, iva, total, estado, origen)
  select date_trunc('month', p_mes)::date, c.nombre, c.nombre, c.fijo_importe, c.iva_def,
         round(c.fijo_importe * c.iva_def / 100, 2), c.fijo_importe + round(c.fijo_importe * c.iva_def / 100, 2),
         'borrador', 'fijo'
    from gasto_categorias c
   where c.fijo and c.activa
     and not exists (select 1 from gastos g where g.categoria = c.nombre
                       and date_trunc('month', g.fecha) = date_trunc('month', p_mes));
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.generar_gastos_fijos(date) from public, anon;
grant execute on function public.generar_gastos_fijos(date) to authenticated;

-- ---------- Datos iniciales ----------
-- Octubre 2026 del Excel «Gastos e Ingresos OCTUBRE» (importes sin IVA, 21 %)
insert into public.gastos (fecha, proveedor, descripcion, categoria, base, iva_pct, iva, total, origen, comentario)
select v.f::date, v.prov, v.d, v.c, v.b, 21, round(v.b * 0.21, 2), v.b + round(v.b * 0.21, 2), 'excel', 'Del Excel de octubre'
  from (values
    ('2026-10-10', 'LUIS NAVAS', '3 FACTS LUIS NAVAS CHISPAS', 'LUIS NAVAS ELECTRICISTA', 152.78),
    ('2026-10-06', null,         'SELLOS',                     'Materiales',               299.00),
    ('2026-10-04', null,         'LOCAL PALOMARES 1',          'Materiales',               288.00),
    ('2026-10-01', 'LUIS NAVAS', '1 FACT LUIS NAVAS',          'LUIS NAVAS ELECTRICISTA',  32.84),
    ('2026-10-09', 'KAGOO',      'kagoo',                      'Gasolina',                 100.00),
    ('2026-10-19', null,         'placa policarbonato',        'Materiales',               65.74),
    ('2026-10-19', null,         'ordenadores',                'Materiales',               670.00)
  ) v(f, prov, d, c, b)
 where not exists (select 1 from public.gastos where origen = 'excel');

-- =====================================================================
--  DESACTIVADO (10/11/2026): fotos/PDF de facturas de papel. NO se ha ejecutado. Para activarlo,
--  quitar los «-- » de cada línea y ejecutarlo; en la web, G_ARCHIVOS = true.
-- =====================================================================
-- -- ---------- Archivos: facturas de papel (fotos o PDF) ----------
-- insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
-- values ('gastos', 'gastos', false, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
-- on conflict (id) do nothing;
-- create policy "admin ve facturas de gasto" on storage.objects for select to authenticated
--   using (bucket_id = 'gastos' and public.es_admin());
-- create policy "admin sube facturas de gasto" on storage.objects for insert to authenticated
--   with check (bucket_id = 'gastos' and public.es_admin());
-- create policy "admin borra facturas de gasto" on storage.objects for delete to authenticated
--   using (bucket_id = 'gastos' and public.es_admin());
-- -- El admin ve SOLO las fotos de factura de los informes (no el resto de fotos de servicios)
-- create policy "admin ve fotos de factura" on storage.objects for select to authenticated
--   using (bucket_id = 'fotos' and public.es_admin()
--          and exists (select 1 from public.fotos f where f.ruta = storage.objects.name and f.tipo = 'factura'));
--

-- =====================================================================
--  ACTIVADO (11/11/2026): borradores desde las facturas del operario
--  (sin `drop`: create or replace trigger). Ejecutado tal cual.
-- =====================================================================
-- Borrador desde el informe del operario
-- Crea o actualiza (si sigue en borrador) el gasto de un informe con importe o foto de factura.
create or replace function privado.gasto_de_informe(p_informe uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  i record; adj text[]; v_total numeric; v_base numeric; g record;
begin
  select inf.id, inf.parte_id, inf.importe_gastos, inf.creado_en, p.numero_servicio, pf.nombre as operario
    into i
    from informes inf
    left join partes p on p.id = inf.parte_id
    left join perfiles pf on pf.id = inf.operario_id
   where inf.id = p_informe;
  if not found then return; end if;
  select coalesce(array_agg('fotos:' || f.ruta order by f.creado_en), '{}') into adj
    from fotos f where f.informe_id = p_informe and f.tipo = 'factura';
  if coalesce(i.importe_gastos, 0) <= 0 and cardinality(adj) = 0 then return; end if;

  v_total := case when i.importe_gastos > 0 then round(i.importe_gastos, 2) end;
  v_base  := case when v_total is not null then round(v_total / 1.21, 2) end;

  select * into g from gastos where informe_id = p_informe;
  if not found then
    insert into gastos (fecha, descripcion, categoria, base, iva_pct, iva, total, adjuntos, estado, origen,
                        parte_id, servicio, operario, informe_id, creado_por)
    values ((i.creado_en at time zone 'Europe/Madrid')::date, 'Factura del operario', 'Materiales',
            v_base, 21, v_total - v_base, v_total, adj, 'borrador', 'informe',
            i.parte_id, i.numero_servicio, i.operario, p_informe, null);
  elsif g.estado = 'borrador' then
    update gastos set
      adjuntos = (select coalesce(array_agg(distinct x), '{}') from unnest(g.adjuntos || adj) x),
      total = coalesce(v_total, total),
      base  = case when v_total is not null then round(v_total / (1 + iva_pct / 100), 2) else base end,
      iva   = case when v_total is not null then v_total - round(v_total / (1 + iva_pct / 100), 2) else iva end
    where id = g.id;
  else
    -- Ya confirmado: solo se añaden fotos nuevas, nunca se tocan los importes
    update gastos set adjuntos = (select coalesce(array_agg(distinct x), '{}') from unnest(g.adjuntos || adj) x)
     where id = g.id;
  end if;
end $$;
revoke execute on function privado.gasto_de_informe(uuid) from public, anon, authenticated;

create or replace function privado.t_gasto_informe() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform privado.gasto_de_informe(new.id);
  return new;
end $$;
create or replace function privado.t_gasto_foto() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tipo = 'factura' and new.informe_id is not null then
    perform privado.gasto_de_informe(new.informe_id);
  end if;
  return new;
end $$;
create or replace trigger informes_gasto after insert or update of importe_gastos on public.informes
  for each row execute function privado.t_gasto_informe();
create or replace trigger fotos_gasto after insert on public.fotos
  for each row execute function privado.t_gasto_foto();


select privado.gasto_de_informe(id) from public.informes
 where importe_gastos > 0 or exists (select 1 from public.fotos f where f.informe_id = informes.id and f.tipo = 'factura');
