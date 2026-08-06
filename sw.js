// sw.js — offline app shell for Resonate

const CACHE = 'resonate-shell-v3';
const SHELL = [
  '.',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/store.js',
  'js/map.js',
  'js/frame.js',
  'js/geocode.js',
  'js/share.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/markercluster/leaflet.markercluster.js',
  'vendor/markercluster/MarkerCluster.css',
  'vendor/lz/lz-string.min.js',
  'icons/icon.svg',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// same-origin: network-first so updates land immediately, cache fallback for offline;
// cross-origin (tiles, geocoding, fonts): network, falling back to cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      fetch(e.request).then(res => {
        if (url.hostname.endsWith('basemaps.cartocdn.com') || url.hostname.includes('fonts.')) {
          const copy = res.clone();
          caches.open(CACHE + '-ext').then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
  }
});
