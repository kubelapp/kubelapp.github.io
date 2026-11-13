-- 52 · Eventos SIGMA: MATERIAL (13/11/2026)
-- Nuevo tipo de evento «MATERIAL», en el mismo Excel por cuenta (VLL / PAL) y con el mismo periodo (20 → 19).
-- Solo a mano desde el panel admin («+ Añadir evento»): la BD no lo apunta sola.

alter table public.eventos_sigma drop constraint if exists eventos_sigma_tipo_check,
  add constraint eventos_sigma_tipo_check
  check (tipo in ('URGENCIA', 'VISITA FALLIDA', 'DESATASCO CAMIÓN CUBA', 'MATERIAL'));
