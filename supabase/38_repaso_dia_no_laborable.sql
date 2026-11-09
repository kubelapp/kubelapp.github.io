-- KUBEL · SQL 38 (09/11/2026) — Días no laborables de la agenda SIGMA
-- SIGMA rechaza el Repaso con 5091 «Debe introducir fecha laborable» si el día no es laborable en la agenda de la cuenta
-- (11/11/2026 en VLL, 29511179 y 29273266; ni «a) mantener la fecha / hora» lo admite en el portal).
-- · sigma-sync v34 apunta esos días: al recibir un 5091 y al ver la lista de huecos del Repaso (un lunes–viernes que falta
--   en la lista no es laborable). Si un día vuelve a salir en la lista o un Repaso se guarda en él, se borra.
-- · Un disparador NO deja planificar una visita de un servicio SIGMA abierto en un día no laborable de su cuenta
--   (Asignar visita, arrastrar en Planificación y editar la visita) → el error no vuelve a salir en Envíos a SIGMA.
-- · Los envíos ya en error con 5091 se reintentan solos cada 30 min (7–21 h) por si SIGMA habilita el día.

create table if not exists public.sigma_dias_no_laborables (
  cuenta    text not null,
  fecha     date not null,
  visto_en  timestamptz not null default now(),
  primary key (cuenta, fecha)
);
alter table public.sigma_dias_no_laborables enable row level security;
create policy "oficina lee días no laborables" on public.sigma_dias_no_laborables
  for select to authenticated using (public.es_oficina());

insert into public.sigma_dias_no_laborables (cuenta, fecha) values ('VLL', '2026-11-11') on conflict do nothing;

create or replace function privado.asignacion_dia_laborable_sigma()
returns trigger
language plpgsql
security definer
set search_path = public, privado
as $$
declare p record;
begin
  if new.estado <> 'pendiente' then return new; end if;
  if tg_op = 'UPDATE' and new.fecha is not distinct from old.fecha and new.parte_id is not distinct from old.parte_id then return new; end if;
  select numero_servicio, sigma_cuenta, estado into p from public.partes where id = new.parte_id;
  if p.sigma_cuenta is null or p.estado in ('cerrado', 'anulado') then return new; end if;
  if exists (select 1 from public.sigma_dias_no_laborables d where d.cuenta = p.sigma_cuenta and d.fecha = new.fecha) then
    raise exception 'SIGMA no admite el % como día laborable en la cuenta %: no se puede citar al cliente ese día (el Repaso daría el error 5091). Elige otro día.',
      to_char(new.fecha, 'DD/MM/YYYY'), case p.sigma_cuenta when 'VLL' then 'SIGMA VALLADOLID' when 'PAL' then 'SIGMA PALENCIA' else p.sigma_cuenta end
      using errcode = 'P0001';
  end if;
  return new;
end; $$;
revoke execute on function privado.asignacion_dia_laborable_sigma() from public, anon, authenticated;

create or replace trigger asignaciones_dia_laborable_sigma
  before insert or update on public.asignaciones
  for each row execute function privado.asignacion_dia_laborable_sigma();

create or replace function privado.reintentar_repasos_no_laborables()
returns integer
language plpgsql
security definer
set search_path = public, privado
as $$
declare n integer; ahora timestamp := now() at time zone 'Europe/Madrid';
begin
  if extract(hour from ahora) < 7 or extract(hour from ahora) >= 21 then return 0; end if;
  update public.sigma_envios
     set estado = 'aprobado', aprobado_en = now()
   where tipo = 'repaso' and estado = 'error'
     and resultado like '%código 5091 de SIGMA%'
     and fecha is not null
     and (case when hora is null then fecha > ahora::date else (fecha + hora) > ahora end)
     and actualizado_en < now() - interval '25 minutes';
  get diagnostics n = row_count;
  return n;
end; $$;
revoke execute on function privado.reintentar_repasos_no_laborables() from public, anon, authenticated;

select cron.schedule('kubel-repasos-no-laborables', '*/30 * * * *', 'select privado.reintentar_repasos_no_laborables()');

notify pgrst, 'reload schema';
