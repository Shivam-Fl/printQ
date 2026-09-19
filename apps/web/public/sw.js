/* PrintQ service worker: push notifications + app-shell/asset caching. */
const SHELL_CACHE = 'printq-shell-v2';
const ASSET_CACHE = 'printq-assets-v2';

// Firebase web configuration identifies this public web application; it is
// intentionally passed only when FCM is enabled for the current environment.
// Do not add API secrets, user identity, document metadata, or location here.
const fcmParams = new URL(self.location.href).searchParams;
const fcmConfig = {
  apiKey: fcmParams.get('apiKey'),
  authDomain: fcmParams.get('authDomain'),
  projectId: fcmParams.get('projectId'),
  appId: fcmParams.get('appId'),
  messagingSenderId: fcmParams.get('messagingSenderId'),
};
const fcmEnabled = Object.values(fcmConfig).every(Boolean);

if (fcmEnabled) {
  importScripts(
    'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js',
  );
  firebase.initializeApp(fcmConfig);
  firebase.messaging().onBackgroundMessage((payload) => {
    const data = payload.data || {};
    return self.registration.showNotification(payload.notification?.title || 'PrintQ', {
      body: payload.notification?.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { url: data.url || '/' },
      tag: data.eventKey || data.url || 'printq-notification',
    });
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(['/'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // navigations: network-first, cached shell as the offline fallback
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }

  // built JS/CSS/fonts (Vite's content-hashed /assets/*): cache-first — the
  // hash in the filename already busts the cache on every new deploy
  if (url.origin === self.location.origin && url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ??
          fetch(req).then((res) => {
            if (res.ok) caches.open(ASSET_CACHE).then((c) => c.put(req, res.clone()));
            return res;
          }),
      ),
    );
  }
});

self.addEventListener('push', (event) => {
  if (fcmEnabled) return;
  let data = { title: 'PrintQ', body: '', url: '/' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* keep defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      vibrate: [100, 50, 100],
      data: { url: data.url },
      tag: data.url, // updates for the same job replace, not stack
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const win of wins) {
        if ('focus' in win) {
          win.navigate(url);
          return win.focus();
        }
      }
      return clients.openWindow(url);
    }),
  );
});
