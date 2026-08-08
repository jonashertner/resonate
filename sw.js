// sw.js — the shell, kept so the atlas opens without a network.
// Network first, because the field should never be stale when a network exists.

const V = 'v=rf80';
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
  // the film is not precached: it is a first-visit welcome, and installing
  // it costs a quarter of a megabyte to every device including the ones that
  // have asked for less movement and will never see it
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Promise.all, not allSettled. A shell that cannot be cached whole must not
    // install: activate deletes every other cache, so a half filled one throws
    // away the last copy that worked and leaves the app broken with no network.
    // Better to keep the old worker and try again on the next visit.
    .then(c => Promise.all(SHELL.map(u => c.add(u))))
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

// A share is a title, a note and a link, and each of those has a real ceiling.
// 2048 is what an address bar carries in practice; 300 outruns any page title
// worth keeping, since the app clips a name to 140 anyway; 2000 holds a
// generous selection of text. The sum is bounded as well, because the sum is
// what lands in the store, and the link is served first: the coordinates live
// there. A body past a megabyte is not a share, so it is never parsed at all.
const CAP = { url: 2048, title: 300, text: 2000 };
const CAP_TOTAL = 4096;
const CAP_BODY = 1024 * 1024;

// Each field cut to its own ceiling and then to whatever is left of the total.
// `shortened` travels with the record so the app can say a share was kept in
// part rather than pretend it arrived whole.
function boundShare(form) {
  const kept = { title: '', text: '', url: '', shortened: false };
  let budget = CAP_TOTAL;
  for (const field of ['url', 'title', 'text']) {
    const raw = String(form.get(field) ?? '');
    kept[field] = raw.slice(0, Math.min(CAP[field], budget));
    if (kept[field].length < raw.length) kept.shortened = true;
    budget -= kept[field].length;
  }
  return kept;
}

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
      const home = shareUrl.origin + shareUrl.pathname.replace(/share-target$/, '');
      let kept = false;
      try {
        const size = Number(e.request.headers.get('content-length') || 0);
        if (!(size > CAP_BODY)) {
          const share = boundShare(await e.request.formData());
          // three blank fields are not a share, and the write itself can fail:
          // either way nothing is waiting, and the app must not be told it is.
          // blank is measured the way the app's parser measures it, on the
          // trimmed field, so the two never disagree about what arrived.
          if (share.title.trim() || share.text.trim() || share.url.trim()) {
            kept = await inboxPut({ ...share, at: new Date().toISOString() });
          }
        }
      } catch { /* nothing legible arrived */ }
      // straight back into the app, with nothing of the share in the address:
      // one digit for whether anything is waiting, and not a word of the place
      return Response.redirect(home + (kept ? '?shared=1' : '?shared=0'), 303);
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
