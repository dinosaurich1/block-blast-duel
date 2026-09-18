const CACHE = 'bbd-v5';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/socket.io/socket.io.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(ASSETS.map(a => c.add(a).catch(() => { })))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Игнорируем всё, что не наш домен
  if (url.origin !== location.origin) return;
  // Socket.io и API всегда идут напрямую
  if (url.pathname.startsWith('/socket.io/')) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/admin')) return;
  if (req.method !== 'GET') return;

  e.respondWith(
    fetch(req)
      .then(function(resp) {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          try {
            const copy = resp.clone();
            caches.open(CACHE).then(function(c) { c.put(req, copy); }).catch(function() {});
          } catch (e) {}
        }
        return resp;
      })
      .catch(function() {
        return caches.match(req).then(function(r) {
          return r || caches.match('/');
        });
      })
  );
});
