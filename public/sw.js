const CACHE = 'chamakids-v2';
const BASE = ['/', '/painel', '/manifest.webmanifest', '/icon-192.png', '/logo.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// Rede primeiro; se estiver offline, abre a última versão guardada.
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).pathname === '/events') return;
  e.respondWith(
    fetch(request)
      .then((r) => { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(request, copia)); return r; })
      .catch(() => caches.match(request))
  );
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      const aberta = lista.find((c) => c.url.includes('/painel'));
      return aberta ? aberta.focus() : self.clients.openWindow('/painel');
    })
  );
});
