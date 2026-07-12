// Bump this whenever the shell files change — it forces a refresh on both phones.
const VERSION = 'v4';
const SHELL = `shell-${VERSION}`;

// The app shell: the files needed to draw the UI. Data is NEVER cached.
const SHELL_FILES = [
  '/',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

// Drop every old cache version so a redeploy can't leave stale code behind.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Only handle our own origin.
  if (url.origin !== self.location.origin) return;

  // NEVER cache the API. Custody days, appointments and pending approvals must
  // always be live — a stale answer here is worse than an error message.
  if (url.pathname.startsWith('/api/')) return;

  // Non-GET always goes to the network.
  if (req.method !== 'GET') return;

  // App shell: network-first so a redeploy is picked up immediately,
  // falling back to cache when the phone is offline.
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(hit => hit || caches.match('/'))
      )
  );
});
