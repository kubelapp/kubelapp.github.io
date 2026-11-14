-- 54 · Storage: el bucket «fotos» admite JPEG y PDF (antes solo image/jpeg,
-- por eso fallaban los PDF de «Pasos SIGMA · 3 Documentos»). Solo PDF, sin Word ni Excel (decisión del usuario). Límite 6 MB.
update storage.buckets set allowed_mime_types = array['image/jpeg','application/pdf'] where id = 'fotos';
