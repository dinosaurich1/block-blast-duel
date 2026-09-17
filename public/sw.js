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

  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/socket.io/')) return;
  if (url.pathname.startsWith('/api/')) return;
  if (req.method !== 'GET') return;

  e.respondWith(
    fetch(req).then(resp => {
      if (resp && resp.status === 200) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => { });
      }
      return resp;
    }).catch(() =>
      caches.match(req).then(r => r || caches.match('/'))
    )
  );
});
