-- 54 · Storage: el bucket «fotos» admite cualquier tipo de archivo (antes solo image/jpeg,
-- por eso fallaban los PDF de «Pasos SIGMA · 3 Documentos»). Se mantiene el límite de 6 MB.
update storage.buckets set allowed_mime_types = null where id = 'fotos';
