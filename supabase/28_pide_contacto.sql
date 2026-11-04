-- KUBEL 28 · SIGMA exige la fecha de contacto con el cliente también fuera del estado 15 (04/11/2026)
-- El robot sigma-sync (v27) lee esa exigencia del Repaso en el portal (solo lectura) y la guarda aquí, para que la oficina
-- la pida al hacer el Repaso y no al fallar el envío. null = aún no se sabe (p. ej. el portal no deja abrir el Repaso).
alter table public.partes add column if not exists sigma_pide_contacto boolean;
comment on column public.partes.sigma_pide_contacto is 'SIGMA exige la fecha de contacto con el cliente al hacer Repaso (leído por el robot). null = aún no se sabe';
