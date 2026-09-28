/* Service Worker – Visor Murcia PWA */
const CACHE_NAME = 'visor-murcia-v2';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Instalación: cachea el app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

// Activación: limpia cachés viejas
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: Cache First para app shell, Network First para API/datos
self.addEventListener('fetch', (event) => {
  // Nunca cachear POSTs (p. ej. /api/fetch-dataset-content): solo van a red.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // No interceptar peticiones a CKAN, al backend ni a proxies CORS (siempre red)
  if (url.hostname.includes('regiondemurcia.es') ||
      url.hostname.includes('vercel.app') ||
      url.hostname.includes('onrender.com') ||
      url.hostname.includes('corsproxy.io') ||
      url.hostname.includes('allorigins') ||
      url.hostname.includes('codetabs.com')) {
    return;
  }

  // Para el resto: Network First con fallback a caché (funciona offline)
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return resp;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('./index.html')))
  );
});
