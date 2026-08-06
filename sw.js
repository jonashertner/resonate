// sw.js — the shell, kept so the atlas opens without a network.
// Network first, because the field should never be stale when a network exists.

const V = 'v=rf22';
const CACHE = `resonate-shell-${V}`;

// everything the first paint needs, at the exact URLs the page asks for
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  `./css/style.css?${V}`,
  `./js/app.js?${V}`,
  `./js/store.js?${V}`,
  `./js/map.js?${V}`,
  `./js/share.js?${V}`,
  `./js/schema.js?${V}`,
  `./js/kinship.js?${V}`,
  `./js/geocode.js?${V}`,
  `./js/exif.js?${V}`,
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/markercluster/leaflet.markercluster.js',
  './vendor/markercluster/MarkerCluster.css',
  './vendor/lz/lz-string.min.js',
  './assets/intro.mp4',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // tiles and geocoding belong to the network; only our own shell is ours
  if (url.origin !== self.location.origin) return;
  // and only this app's path: the origin carries other sites
  const scope = new URL('./', self.location.href).pathname;
  if (!url.pathname.startsWith(scope)) return;

  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        // the version query changes with every deploy, so a cached answer is
        // matched without it rather than not at all
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        // the shell stands in for a page, never for a script, a style, or an
        // image: those must fail honestly so the app can say so
        if (req.mode === 'navigate') {
          const shell = await caches.match('./index.html', { ignoreSearch: true });
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
