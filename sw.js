// Service worker: houdt de app offline beschikbaar.
const CACHE = 'woordjes-v16';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/app.js',
  'js/db.js',
  'js/srs.js',
  'js/session.js',
  'js/check.js',
  'js/parse.js',
  'js/image.js',
  'js/ocr.js',
  'js/claude.js',
  'js/config.js',
  'js/merge.js',
  'js/sync.js',
  'js/cheer.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'api.anthropic.com' || url.hostname.endsWith('googleapis.com') || url.hostname === 'accounts.google.com') return;

  if (url.origin === location.origin) {
    // Eigen bestanden: eerst netwerk (voor updates), anders uit de cache.
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  // Externe bibliotheken (OCR, Claude SDK): eerst cache, zodat ze offline blijven werken.
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'esm.sh') {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
  }
});
