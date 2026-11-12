// Service worker: permite instalar la app y abrirla aunque falle la cobertura.
// Siempre intenta la red primero (para tener lo último) y si no hay, usa la copia guardada.
const CACHE = 'kubel-operario-v2.6';
const BASICOS = ['./', 'index.html', 'manifest.webmanifest', 'iconos/icono-192.png', '../comun/config.js', '../comun/cargar-supabase.js', '../comun/avisos.js', '../comun/acceso.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASICOS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k.startsWith('kubel-operario')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const propio = url.origin === location.origin;
  const libreria = /supabase-js@/.test(url.href);
  if (!propio && !libreria) return; // datos del servidor: nunca de caché
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
  );
});

// ---------- Notificaciones push ----------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'KUBEL', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'KUBEL', {
    body: d.body || '', tag: d.tag, renotify: !!d.tag,
    icon: 'iconos/icono-192.png', badge: 'iconos/badge-96.png',
    data: { url: d.url || self.registration.scope },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) {
      if (c.url.startsWith(self.registration.scope)) {
        c.postMessage({ tipo: 'notificacion', url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
