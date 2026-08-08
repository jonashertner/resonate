// schema.js — one gate for everything that arrives from outside.
//
// A share link, an imported file, and a folio from the commons are the same
// kind of stranger. They pass through here or they do not pass. Nothing
// downstream may assume a field exists, has a type, or has a sane size:
// this is the only place that decides.

import { decodePath } from './route.js?v=rf66';

export const SCHEMA_VERSION = 4;

// What a person's own record may hold. Generous enough that nobody meets it,
// so an archive never comes home shorter than it left. A stranger's payload
// is held to LIMITS instead.
export const OWN = {
  note: 200_000,
  name: 400,
  url: 2_000,
  photos: 200,
  photoBytes: 12_000_000,
  tagsPerPlace: 200,
  routePoints: 100_000,
};

export const LIMITS = {
  folios: 120,
  routes: 200,
  routePoints: 3000,
  places: 500,
  tags: 64,
  correspondents: 64,
  tagsPerPlace: 24,
  name: 140,
  note: 4000,
  url: 500,
  title: 80,
  dedication: 140,
  author: 60,
  question: 120,
  photos: 12,
  photoBytes: 3_000_000,
};

// An atlas holds the places that matter to you. Keeping one IS the
// recommendation, so nothing here asks for a verdict beside it: only whether
// you have been, which is a fact, and the note, where a sentence says what a
// label never could. The old five-star number is still read from links sealed
// before this, and is never written again.

export const PHOTO_ID = /^ph_[a-z0-9]{1,40}$/;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => String(v ?? '').slice(0, n);

// keys that would poison an object literal on assignment
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function safeKeys(o) {
  const out = {};
  for (const k of Object.keys(o)) {
    if (FORBIDDEN.has(k)) continue;
    out[k] = o[k];
  }
  return out;
}

function id(v, fallback) {
  const s = str(v, 64).trim();
  return s && !FORBIDDEN.has(s) ? s : fallback;
}

export function normPlace(raw, i = 0, caps = LIMITS) {
  if (!isObj(raw)) return null;
  const p = safeKeys(raw);
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  // a photograph is either an inline picture or an id into this device's own
  // store. both are strings, both are bounded, and neither reaches markup.
  const photos = Array.isArray(p.photos)
    ? p.photos
      .filter(s => typeof s === 'string' && (
        (s.startsWith('data:image/') && s.length <= caps.photoBytes)
        || PHOTO_ID.test(s)))
      .slice(0, caps.photos)
    : [];

  const out = {
    id: id(p.id, `p${i}`),
    name: str(p.name, caps.name) || 'Untitled place',
    lat,
    lng,
    address: str(p.address, 200),
    city: str(p.city, 120),
    country: str(p.country, 120),
    countryCode: str(p.countryCode, 8),
    tags: Array.isArray(p.tags)
      ? p.tags.filter(t => typeof t === 'string' && !FORBIDDEN.has(t)).slice(0, caps.tagsPerPlace)
      : [],
    status: p.status === 'visited' ? 'visited' : 'wishlist',
    // a place marked this way is kept out of every link, folio and publish
    private: p.private === true,
    // the number survives only so links and files from before the words still
    // open; nothing writes it, and no surface shows it
    rating: Math.max(0, Math.min(5, Math.floor(Number(p.rating) || 0))),
    note: str(p.note, caps.note),
    url: /^https?:\/\//i.test(String(p.url ?? '')) ? str(p.url, caps.url) : '',
    photos,
    createdAt: str(p.createdAt, 40),
    updatedAt: str(p.updatedAt, 40),
    // a seeded place is marked until it is adopted or edited; the flag is
    // local only and never travels in a link
    sample: p.sample === true,
  };

  // a link carries the road as `prov`: the names it passed through, in order
  if (!isObj(p.provenance) && Array.isArray(p.prov) && p.prov.length) {
    const road = p.prov.filter(isObj).map(h => ({ name: str(h.name, LIMITS.author), at: str(h.at, 40) })).filter(h => h.name);
    if (road.length) {
      const last = road[road.length - 1];
      out.provenance = { chain: road.slice(0, -1).slice(-4), name: last.name, sig: 0, adoptedAt: last.at };
    }
  }

  // provenance reaches an attribute in the marker: rebuilt, never carried.
  // the chain is who it passed through before, oldest first, five at most:
  // Ana handed it to Mira who handed it to you, and all three are kept.
  if (isObj(p.provenance)) {
    out.provenance = {
      chain: Array.isArray(p.provenance.chain)
        ? p.provenance.chain
          .filter(isObj)
          .map(h => ({ name: str(h.name, LIMITS.author), at: str(h.at, 40) }))
          .filter(h => h.name)
          .slice(-5)
        : [],
      name: str(p.provenance.name, LIMITS.author),
      sig: Number(p.provenance.sig) || 0,
      adoptedAt: str(p.provenance.adoptedAt, 40),
    };
  }
  return out;
}

// a route arrives either as a list of points or as an encoded line; both are
// bounded here, because a line is the one thing in this app that can be long
export function normRoute(raw, i = 0, decode = null, caps = LIMITS) {
  if (!isObj(raw)) return null;
  const r = safeKeys(raw);

  let path = [];
  if (Array.isArray(r.path)) {
    path = r.path;
  } else if (typeof r.p === 'string' && decode) {
    path = decode(r.p);
  }
  path = (Array.isArray(path) ? path : [])
    .slice(0, caps.routePoints)
    .map(pt => {
      if (!isObj(pt)) return null;
      const lat = Number(pt.lat), lng = Number(pt.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
      const ele = Number(pt.ele);
      const out = { lat, lng };
      if (Number.isFinite(ele) && Math.abs(ele) <= 9000) out.ele = ele;
      return out;
    })
    .filter(Boolean);
  if (path.length < 2) return null;

  const nn = (v, lim) => { const n = Number(v); return Number.isFinite(n) ? Math.max(-lim, Math.min(lim, n)) : null; };

  const out = {
    id: id(r.id, `r${i}`),
    kind: 'route',
    name: str(r.name, caps.name) || 'Untitled way',
    path,
    city: str(r.city, 120),
    country: str(r.country, 120),
    tags: Array.isArray(r.tags)
      ? r.tags.filter(t => typeof t === 'string' && !FORBIDDEN.has(t)).slice(0, caps.tagsPerPlace)
      : [],
    status: r.status === 'walked' ? 'walked' : 'wishlist',
    // a track shows a routine, a door, an hour: it needs the same word a
    // place has, and one more for the ends that give a home away
    private: r.private === true,
    trimEnds: r.trimEnds === true,
    rating: Math.max(0, Math.min(5, Math.floor(Number(r.rating) || 0))),
    note: str(r.note, caps.note),
    url: /^https?:\/\//i.test(String(r.url ?? '')) ? str(r.url, caps.url) : '',
    km: nn(r.km, 100000),
    ascent: nn(r.ascent, 30000),
    descent: nn(r.descent, 30000),
    high: nn(r.high, 9000),
    low: nn(r.low, 9000),
    hours: nn(r.hours, 400),
    loop: r.loop === true,
    createdAt: str(r.createdAt, 40),
    updatedAt: str(r.updatedAt, 40),
    walkedAt: str(r.walkedAt, 40),
    sample: r.sample === true,
  };
  if (isObj(r.provenance)) {
    out.provenance = {
      chain: Array.isArray(r.provenance.chain)
        ? r.provenance.chain
          .filter(isObj)
          .map(h => ({ name: str(h.name, LIMITS.author), at: str(h.at, 40) }))
          .filter(h => h.name)
          .slice(-5)
        : [],
      name: str(r.provenance.name, LIMITS.author),
      sig: Number(r.provenance.sig) || 0,
      adoptedAt: str(r.provenance.adoptedAt, 40),
    };
  }
  return out;
}

export function normRoutes(arr, decode = null) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (let i = 0; i < arr.length && out.length < LIMITS.routes; i++) {
    const v = normRoute(arr[i], i, decode);
    if (v) out.push(v);
  }
  return out;
}

const HEX = /^#[0-9a-fA-F]{3,8}$/;

export function normTag(raw, i = 0) {
  if (!isObj(raw)) return null;
  const t = safeKeys(raw);
  const name = str(t.name, 60).trim();
  if (!name) return null;
  const hue = Number(t.hue);
  return {
    id: id(t.id, `t${i}`),
    name,
    emoji: str(t.emoji, 8),
    color: HEX.test(String(t.color ?? '')) ? String(t.color) : '',
    hue: Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : NaN,
  };
}

function normList(arr, fn, cap) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (let i = 0; i < arr.length && out.length < cap; i++) {
    const v = fn(arr[i], i);
    if (v) out.push(v);
  }
  return out;
}

export function normPlaces(arr) { return normList(arr, normPlace, LIMITS.places); }
export function normTags(arr) { return normList(arr, normTag, LIMITS.tags); }

export function normCorrespondent(raw, i = 0) {
  if (!isObj(raw)) return null;
  const c = safeKeys(raw);
  const hue = Number(c.hue);
  return {
    id: id(c.id, `c${i}`),
    name: str(c.name, LIMITS.author) || 'Unnamed correspondent',
    hue: Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : NaN,
    visible: c.visible !== false,
    addedAt: str(c.addedAt, 40),
    tags: normTags(c.tags),
    places: normPlaces(c.places),
  };
}

export function normSettings(raw) {
  if (!isObj(raw)) return {};
  const s = safeKeys(raw);
  const out = {};
  if (typeof s.authorName === 'string') out.authorName = str(s.authorName, LIMITS.author);
  if (s.theme === 'light' || s.theme === 'dark' || s.theme === 'auto') out.theme = s.theme;
  return out;
}

// ---------- the payloads ----------
//
// Each kind states its own shape. A payload that does not satisfy its kind is
// rejected here and never reaches a renderer.

export function normPayload(raw) {
  if (!isObj(raw)) return null;
  const p = safeKeys(raw);
  const kind = p.kind === 'folio' || p.kind === 'ask' ? p.kind : 'atlas';
  const v = Number(p.v);

  if (kind === 'ask') {
    const q = str(p.q, LIMITS.question).trim();
    if (!q) return null;
    return { v: Number.isFinite(v) ? v : 1, kind, from: str(p.from, LIMITS.author), q };
  }

  const places = normPlaces(p.places);
  const routes = normRoutes(p.routes, decodePath);
  if (!places.length && !routes.length) return null;
  const base = {
    v: Number.isFinite(v) ? v : 1,
    kind,
    author: str(p.author, LIMITS.author),
    tags: normTags(p.tags),
    places,
    routes,
  };
  if (kind === 'folio') {
    const title = str(p.title, LIMITS.title).trim();
    if (!title) return null;
    return { ...base, title, dedication: str(p.dedication, LIMITS.dedication) };
  }
  return base;
}

// a kept folio is a named slice of the atlas: references, never copies
export function normFolioRef(raw, i = 0) {
  if (!isObj(raw)) return null;
  const f = safeKeys(raw);
  const title = str(f.title, LIMITS.title).trim();
  if (!title) return null;
  const ids = (arr, cap) => Array.isArray(arr)
    ? arr.filter(x => typeof x === 'string' && !FORBIDDEN.has(x)).slice(0, cap)
    : [];
  return {
    id: id(f.id, `f${i}`),
    title,
    dedication: str(f.dedication, LIMITS.dedication),
    placeIds: ids(f.placeIds, LIMITS.places),
    routeIds: ids(f.routeIds, LIMITS.routes),
    createdAt: str(f.createdAt, 40),
    updatedAt: str(f.updatedAt, 40),
    // when this folio was offered to the newsstand, so the shelf can say so
    offeredAt: str(f.offeredAt, 40),
  };
}

export function normFolioRefs(arr) {
  return normList(arr, normFolioRef, LIMITS.folios);
}

// an exported file, on its way back in
// Three doors, not one.
//
// A share link is a stranger: it is capped hard, because a hostile payload
// must not be able to spend this device. A private archive is the person's
// own memory coming home: it is bounded only by honesty, and it must never
// come back smaller than it left without saying so. They used to be the same
// function, so restoring a backup of 501 places gave back 500 and called it
// success. That is the one failure a keeper of memory may never have.

// how many of each kind a stranger may hand over at once
const SHARE_CAPS = {
  places: LIMITS.places, routes: LIMITS.routes,
  folios: LIMITS.folios, tags: LIMITS.tags, correspondents: LIMITS.correspondents,
};
// what a person's own archive may hold: enough that nobody meets it
const ARCHIVE_CAPS = {
  places: 100_000, routes: 20_000,
  folios: 10_000, tags: 5_000, correspondents: 10_000,
};

function gather(arr, fn, cap, decode, caps) {
  if (!Array.isArray(arr)) return { kept: [], given: 0, dropped: 0, cut: 0 };
  const kept = [];
  let dropped = 0;
  for (let i = 0; i < arr.length && kept.length < cap; i++) {
    const v = decode ? fn(arr[i], i, decode, caps) : fn(arr[i], i, caps);
    if (v) kept.push(v); else dropped += 1;
  }
  return { kept, given: arr.length, dropped, cut: Math.max(0, arr.length - cap) };
}

// { value, cut: [...], dropped: n } — cut is always empty for an archive
function readAtlas(raw, caps, fieldCaps = LIMITS) {
  if (!isObj(raw)) return null;
  const d = safeKeys(raw);
  const parts = {
    tags: gather(d.tags, normTag, caps.tags),
    places: gather(d.places, normPlace, caps.places, null, fieldCaps),
    routes: gather(d.routes, normRoute, caps.routes, decodePath, fieldCaps),
    folios: gather(d.folios, normFolioRef, caps.folios),
    correspondents: gather(d.correspondents, normCorrespondent, caps.correspondents),
  };
  const cut = Object.entries(parts).filter(([, p]) => p.cut > 0)
    .map(([k, p]) => ({ of: k, given: p.given, kept: p.kept.length }));
  const dropped = Object.values(parts).reduce((a, p) => a + p.dropped, 0);
  return {
    value: {
      tags: parts.tags.kept, places: parts.places.kept, routes: parts.routes.kept,
      folios: parts.folios.kept, correspondents: parts.correspondents.kept,
      settings: normSettings(d.settings),
    },
    cut, dropped,
  };
}

// a stranger's payload: capped hard, silence is fine
export function normImport(raw) {
  const r = readAtlas(raw, SHARE_CAPS);
  return r ? r.value : null;
}

// a person's own archive coming home: nothing is cut, and anything that could
// not be read at all is counted so the caller can refuse
export function readArchive(raw) {
  return readAtlas(raw, ARCHIVE_CAPS, OWN);
}

// what this device already holds: never capped, or an atlas would shrink
// every time it was loaded
export function readLocal(arr, kind) {
  const fn = { places: normPlace, routes: normRoute, tags: normTag,
    folios: normFolioRef, correspondents: normCorrespondent }[kind];
  const r = gather(arr, fn, Number.MAX_SAFE_INTEGER, kind === 'routes' ? decodePath : null, OWN);
  return r.kept;
}

// one row of the newsstand index, which the commons machine writes
export function normFolioCard(raw) {
  if (!isObj(raw)) return null;
  const f = safeKeys(raw);
  const file = str(f.file, 80);
  // the index names a file inside the folios directory and nothing else
  if (!/^[A-Za-z0-9_-]+\.json$/.test(file)) return null;
  const title = str(f.title, LIMITS.title).trim();
  if (!title) return null;
  const strList = (a, n, cap) => Array.isArray(a)
    ? a.filter(x => typeof x === 'string').map(x => str(x, n)).slice(0, cap) : [];
  return {
    id: id(f.id, file),
    file,
    title,
    author: str(f.author, LIMITS.author) || 'no byline',
    dedication: str(f.dedication, LIMITS.dedication),
    n: Math.max(0, Math.min(LIMITS.places, Math.floor(Number(f.n) || 0))),
    cities: strList(f.cities, 120, 12),
    countries: strList(f.countries, 120, 8),
    tags: strList(f.tags, 60, 12),
    publishedAt: str(f.publishedAt, 40),
    // what a public folio must declare about itself, so a reader can weigh it
    pov: str(f.pov, 200),
    scope: str(f.scope, 80),
    reviewedAt: str(f.reviewedAt, 40),
    visitedAll: f.visitedAll === true,
    language: str(f.language, 8),
  };
}

export function normIndex(raw) {
  return normList(raw, normFolioCard, 500);
}
