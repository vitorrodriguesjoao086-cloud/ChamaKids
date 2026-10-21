const CACHE = 'chamakids-v3';
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
// Fecha a notificação do chamado depois do tempo combinado (só a notificação daquele chamado).
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.tipo !== 'fechar-chamada') return;
  e.waitUntil(new Promise((ok) => setTimeout(async () => {
    try {
      const lista = await self.registration.getNotifications({ tag: 'chamada' });
      lista.forEach((n) => { if (n.data && n.data.em === d.em) n.close(); });
    } catch {}
    ok();
  }, d.ms || 10000)));
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