-- KUBEL — SQL 44 (11/11/2026): indicador «ONRED hace…» de la oficina (v2.68).
-- Tiempo real para el registro de pasadas del lector (la oficina ya lo puede leer por SQL 41).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'onred_lecturas') then
    alter publication supabase_realtime add table public.onred_lecturas;
  end if;
end $$;
