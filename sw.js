// sw.js — the shell, kept so the atlas opens without a network.
// Network first, because the field should never be stale when a network exists.

const V = 'v=rf66';
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
  `./js/route.js?${V}`,
  `./js/kinship.js?${V}`,
  `./js/geocode.js?${V}`,
  `./js/exif.js?${V}`,
  `./js/club.js?${V}`,
  `./js/photos.js?${V}`,
  `./js/capture.js?${V}`,
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/markercluster/leaflet.markercluster.js',
  './vendor/markercluster/MarkerCluster.css',
  './vendor/lz/lz-string.min.js',
  './vendor/argon2/argon2.umd.min.js',
  './fonts/bricolage-latin.woff2',
  './fonts/bricolage-latin-ext.woff2',
  './fonts/bricolage-vietnamese.woff2',
  './fonts/fragment-latin.woff2',
  './fonts/fragment-latin-ext.woff2',
  './fonts/fragment-cyrillic-ext.woff2',
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

// A place shared into the app is the one thing a share target must not put on
// the wire. The form posts to this worker, which keeps it here and answers
// with the app itself: the title, the text and the address never leave the
// device, not even as a request the host could log.
const INBOX_DB = 'resonate-share';

function inboxPut(item) {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(INBOX_DB, 1); } catch { return resolve(false); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('shared')) db.createObjectStore('shared', { autoIncrement: true });
    };
    req.onsuccess = () => {
      try {
        const tx = req.result.transaction('shared', 'readwrite');
        tx.objectStore('shared').add(item);
        tx.oncomplete = () => resolve(true);
        tx.onabort = tx.onerror = () => resolve(false);
      } catch { resolve(false); }
    };
    req.onerror = () => resolve(false);
  });
}

self.addEventListener('fetch', (e) => {
  const shareUrl = new URL(e.request.url);
  if (e.request.method === 'POST' && shareUrl.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        await inboxPut({
          title: String(form.get('title') || ''),
          text: String(form.get('text') || ''),
          url: String(form.get('url') || ''),
          at: new Date().toISOString(),
        });
      } catch { /* nothing legible arrived */ }
      // straight back into the app, with nothing in the address
      return Response.redirect(shareUrl.origin + shareUrl.pathname.replace(/share-target$/, '') + '?shared=1', 303);
    })());
    return;
  }
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
