-- 49 · Eventos SIGMA: DESATASCO CAMIÓN CUBA (12/11/2026)
-- El delegado de SIGMA también abona aparte los desatascos con camión cuba. Nuevo tipo de evento, que va en el
-- mismo Excel por cuenta (VLL / PAL) y con el mismo periodo (20 → 19) que las urgencias y las visitas fallidas.
-- De momento se apuntan A MANO desde el panel admin («+ Añadir evento»): la BD no los detecta sola.

alter table public.eventos_sigma drop constraint if exists eventos_sigma_tipo_check;
alter table public.eventos_sigma add constraint eventos_sigma_tipo_check
  check (tipo in ('URGENCIA', 'VISITA FALLIDA', 'DESATASCO CAMIÓN CUBA'));
