// Bump this whenever the shell files change — it forces a refresh on both phones.
const VERSION = 'v14';
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

// A calendar change arrived while the app wasn't open — show a system notification.
// Emergency alerts (kind:'alert') get the loud treatment instead: they stick on screen,
// re-alert on every repeat the server sends, and vibrate hard. The server keeps
// re-sending until the alert is acknowledged, which is what makes the phone carry on
// making noise — one push can only ever produce one sound.
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  const title = data.title || 'Our Calendar';
  const url = data.url || '/';
  const isAlert = data.kind === 'alert';

  const opts = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url, alertId: data.alertId || null, kind: data.kind || null }
  };
  if (isAlert) {
    // tag + renotify: one emergency never stacks into a wall of notifications, but each
    // repeat still re-alerts (sound + vibration) instead of silently updating in place.
    opts.tag = 'emergency';
    opts.renotify = true;
    opts.requireInteraction = true;   // don't auto-dismiss — it has to be dealt with
    opts.silent = false;
    opts.vibrate = [400, 150, 400, 150, 400, 150, 900];
    opts.actions = [{ action: 'ack', title: "I've seen it" }];
  } else if (data.kind === 'alert-cleared') {
    // Same tag, but quiet: it takes the emergency's place on screen instead of leaving
    // it there shouting on a device that never got opened.
    opts.tag = 'emergency';
    opts.renotify = false;
    opts.requireInteraction = false;
  }

  e.waitUntil(Promise.all([
    self.registration.showNotification(title, opts),
    // If the app happens to be open in the background, wake it so the in-app alarm and
    // the full-screen takeover start immediately rather than at the next poll.
    isAlert ? self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => list.forEach(c => c.postMessage({ type: 'emergency', alertId: data.alertId })))
      : null
  ]));
});

// Tapping the notification should focus an already-open tab rather than always
// opening a new one. Both the body and the "I've seen it" action open the app —
// acknowledging happens there, where the session token lives (a service worker
// can't read localStorage, so it can't call the API on its own).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const info = e.notification.data || {};
  const isAlert = info.kind === 'alert';
  const url = isAlert ? '/?alert=' + (info.alertId || '1') : (info.url || '/');
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          if (isAlert) client.postMessage({ type: 'emergency', alertId: info.alertId });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
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

