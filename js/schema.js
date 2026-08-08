// schema.js — one gate for everything that arrives from outside.
//
// A share link, an imported file, and a folio from the commons are the same
// kind of stranger. They pass through here or they do not pass. Nothing
// downstream may assume a field exists, has a type, or has a sane size:
// this is the only place that decides.

import { decodePath } from './route.js?v=rf67';

export const SCHEMA_VERSION = 4;

// What a person's own record may hold: everything it holds.
//
// The previous build wrote generous numbers here and called them safe because
// nobody would meet them. Someone met them. Two hundred photographs came home
// as two hundred, and the two hundred and first was gone without a word. A
// limit chosen so that loss is rare is still a limit that loses.
//
// There is no length at which a person's own note stops being theirs. What
// bounds an archive is the total number of records it may carry, checked
// before anything is written, and the witness below, which makes any
// shortening visible instead of silent. Nothing here is ever quietly cut.
const ALL = Infinity;
export const OWN = {
  note: ALL, name: ALL, url: ALL, id: ALL,
  photos: ALL, photoBytes: ALL,
  tagsPerPlace: ALL, routePoints: ALL,
  address: ALL, city: ALL, country: ALL,
  author: ALL, title: ALL, dedication: ALL,
  placeIds: ALL, routeIds: ALL, tags: ALL, places: ALL, chain: ALL,
};

// What a stranger may hand this device. Every one of these is a real bound,
// and a stranger's payload is clipped to them in silence, which is correct:
// a hostile link may not spend a person's browser to make a point.
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
  // named here rather than written into the normalizers, so that an own
  // archive is never held to a stranger's measure by an oversight
  id: 64,
  address: 200,
  city: 120,
  country: 120,
  chain: 5,
  placeIds: 500,
  routeIds: 200,
};

// An atlas holds the places that matter to you. Keeping one IS the
// recommendation, so nothing here asks for a verdict beside it: only whether
// you have been, which is a fact, and the note, where a sentence says what a
// label never could. The old five-star number is still read from links sealed
// before this, and is never written again.

export const PHOTO_ID = /^ph_[a-z0-9]{1,40}$/;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => String(v ?? '').slice(0, n);

// ---------- the witness ----------
//
// A cap that shortens without saying so is exactly how an archive comes home
// smaller than it left. Every bounded field passes through here. A stranger's
// payload carries no witness and is clipped quietly, which is the point of a
// cap. A person's own archive always carries one, and any entry in it stops
// the restore before a single record is written.
//
// With OWN every cap is Infinity, so on an own archive the witness stays
// empty by construction. That is the assertion, not the hope: if a bound ever
// creeps back into this file, the witness fires and the restore refuses
// rather than quietly keeping the shorter copy.

// a string, cut only if it must be, and never in silence
function cutStr(w, kind, id, field, v, cap) {
  const s = String(v ?? '');
  if (s.length <= cap) return s;
  w?.push({ kind, id, field, given: s.length, kept: cap,
    reason: `${field} is ${s.length} characters and this build holds ${cap}` });
  return s.slice(0, cap);
}

// a list, likewise
function cutArr(w, kind, id, field, arr, cap) {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= cap) return arr;
  w?.push({ kind, id, field, given: arr.length, kept: cap,
    reason: `${arr.length} ${field} and this build holds ${cap}` });
  return arr.slice(0, cap);
}

// the tail of a list, for a road that keeps its most recent hops
function cutTail(w, kind, id, field, arr, cap) {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= cap) return arr;
  w?.push({ kind, id, field, given: arr.length, kept: cap,
    reason: `${arr.length} ${field} and this build holds ${cap}` });
  return arr.slice(-cap);
}

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

// an id is identity, so shortening one does not shorten a record: it makes it
// a different record. the witness hears about this one too.
function id(v, fallback, w, kind, cap = LIMITS.id) {
  const s = cutStr(w, kind, String(v ?? '') || fallback, 'id', v, cap).trim();
  return s && !FORBIDDEN.has(s) ? s : fallback;
}

export function normPlace(raw, i = 0, caps = LIMITS, w = null) {
  if (!isObj(raw)) return null;
  const p = safeKeys(raw);
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const pid = String(p.id ?? '') || `p${i}`;

  // a photograph is either an inline picture or an id into this device's own
  // store. both are strings, both are bounded, and neither reaches markup.
  const legible = Array.isArray(p.photos)
    ? p.photos.filter(s => typeof s === 'string' && (s.startsWith('data:image/') || PHOTO_ID.test(s)))
    : [];
  // a picture too large to hold is not shortened, it is dropped, so it is the
  // loudest kind of loss and must be reported as one
  const small = legible.filter(s => PHOTO_ID.test(s) || s.length <= caps.photoBytes);
  if (small.length < legible.length) {
    w?.push({ kind: 'place', id: pid, field: 'photos', given: legible.length, kept: small.length,
      reason: `${legible.length - small.length} photograph${legible.length - small.length === 1 ? ' is' : 's are'} larger than this build holds` });
  }
  const photos = cutArr(w, 'place', pid, 'photos', small, caps.photos);

  const out = {
    id: id(p.id, `p${i}`, w, 'place', caps.id ?? LIMITS.id),
    name: cutStr(w, 'place', pid, 'name', p.name, caps.name) || 'Untitled place',
    lat,
    lng,
    address: cutStr(w, 'place', pid, 'address', p.address, caps.address ?? LIMITS.address),
    city: cutStr(w, 'place', pid, 'city', p.city, caps.city ?? LIMITS.city),
    country: cutStr(w, 'place', pid, 'country', p.country, caps.country ?? LIMITS.country),
    countryCode: str(p.countryCode, 8),
    tags: cutArr(w, 'place', pid, 'tags',
      Array.isArray(p.tags) ? p.tags.filter(t => typeof t === 'string' && !FORBIDDEN.has(t)) : [],
      caps.tagsPerPlace),
    status: p.status === 'visited' ? 'visited' : 'wishlist',
    // a place marked this way is kept out of every link, folio and publish
    private: p.private === true,
    // the number survives only so links and files from before the words still
    // open; nothing writes it, and no surface shows it
    rating: Math.max(0, Math.min(5, Math.floor(Number(p.rating) || 0))),
    note: cutStr(w, 'place', pid, 'note', p.note, caps.note),
    url: /^https?:\/\//i.test(String(p.url ?? '')) ? cutStr(w, 'place', pid, 'url', p.url, caps.url) : '',
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
      const before = road.slice(0, -1);
      const cap = caps.chain ?? LIMITS.chain;
      out.provenance = {
        chain: cutTail(w, 'place', pid, 'earlier bylines', before, Math.max(0, cap - 1)),
        name: last.name, sig: 0, adoptedAt: last.at,
      };
    }
  }

  // provenance reaches an attribute in the marker: rebuilt, never carried.
  // the chain is who it passed through before, oldest first, five at most:
  // Ana handed it to Mira who handed it to you, and all three are kept.
  if (isObj(p.provenance)) {
    out.provenance = {
      chain: cutTail(w, 'place', pid, 'earlier bylines',
        Array.isArray(p.provenance.chain)
          ? p.provenance.chain
            .filter(isObj)
            .map(h => ({ name: cutStr(w, 'place', pid, 'a byline', h.name, caps.author ?? LIMITS.author), at: str(h.at, 40) }))
            .filter(h => h.name)
          : [],
        caps.chain ?? LIMITS.chain),
      name: cutStr(w, 'place', pid, 'byline', p.provenance.name, caps.author ?? LIMITS.author),
      sig: Number(p.provenance.sig) || 0,
      adoptedAt: str(p.provenance.adoptedAt, 40),
    };
  }
  return out;
}

// a route arrives either as a list of points or as an encoded line; both are
// bounded here, because a line is the one thing in this app that can be long
export function normRoute(raw, i = 0, decode = null, caps = LIMITS, w = null) {
  if (!isObj(raw)) return null;
  const r = safeKeys(raw);
  const rid = String(r.id ?? '') || `r${i}`;

  let path = [];
  if (Array.isArray(r.path)) {
    path = r.path;
  } else if (typeof r.p === 'string' && decode) {
    path = decode(r.p);
  }
  path = cutArr(w, 'way', rid, 'points', Array.isArray(path) ? path : [], caps.routePoints)
    .map(pt => {
      if (!isObj(pt)) return null;
      const lat = Number(pt.lat), lng = Number(pt.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
      // a point with no elevation reading is written by the gpx importer as
      // ele: null, and Number(null) is 0, so every unmeasured point used to
      // come back from a reload as a measured sea level reading. a record
      // that changes by being read is not a record.
      const out = { lat, lng };
      if (pt.ele !== null && pt.ele !== undefined && pt.ele !== '') {
        const ele = Number(pt.ele);
        if (Number.isFinite(ele) && Math.abs(ele) <= 9000) out.ele = ele;
      }
      return out;
    })
    .filter(Boolean);
  if (path.length < 2) return null;

  // the same rule for a way's measurements: null means unknown, and unknown
  // must not become zero on the way through
  const nn = (v, lim) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(-lim, Math.min(lim, n)) : null;
  };

  const out = {
    id: id(r.id, `r${i}`, w, 'way', caps.id ?? LIMITS.id),
    kind: 'route',
    name: cutStr(w, 'way', rid, 'name', r.name, caps.name) || 'Untitled way',
    path,
    city: cutStr(w, 'way', rid, 'city', r.city, caps.city ?? LIMITS.city),
    country: cutStr(w, 'way', rid, 'country', r.country, caps.country ?? LIMITS.country),
    tags: cutArr(w, 'way', rid, 'tags',
      Array.isArray(r.tags) ? r.tags.filter(t => typeof t === 'string' && !FORBIDDEN.has(t)) : [],
      caps.tagsPerPlace),
    status: r.status === 'walked' ? 'walked' : 'wishlist',
    // a track shows a routine, a door, an hour: it needs the same word a
    // place has, and one more for the ends that give a home away
    private: r.private === true,
    trimEnds: r.trimEnds === true,
    rating: Math.max(0, Math.min(5, Math.floor(Number(r.rating) || 0))),
    note: cutStr(w, 'way', rid, 'note', r.note, caps.note),
    url: /^https?:\/\//i.test(String(r.url ?? '')) ? cutStr(w, 'way', rid, 'url', r.url, caps.url) : '',
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
      chain: cutTail(w, 'way', rid, 'earlier bylines',
        Array.isArray(r.provenance.chain)
          ? r.provenance.chain
            .filter(isObj)
            .map(h => ({ name: cutStr(w, 'way', rid, 'a byline', h.name, caps.author ?? LIMITS.author), at: str(h.at, 40) }))
            .filter(h => h.name)
          : [],
        caps.chain ?? LIMITS.chain),
      name: cutStr(w, 'way', rid, 'byline', r.provenance.name, caps.author ?? LIMITS.author),
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

export function normTag(raw, i = 0, caps = LIMITS, w = null) {
  if (!isObj(raw)) return null;
  const t = safeKeys(raw);
  const tid = String(t.id ?? '') || `t${i}`;
  const name = cutStr(w, 'domain', tid, 'name', t.name, caps === LIMITS ? 60 : (caps.name ?? 60)).trim();
  if (!name) return null;
  const hue = Number(t.hue);
  return {
    id: id(t.id, `t${i}`, w, 'domain', caps.id ?? LIMITS.id),
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

export function normCorrespondent(raw, i = 0, caps = LIMITS, w = null) {
  if (!isObj(raw)) return null;
  const c = safeKeys(raw);
  const cid = String(c.id ?? '') || `c${i}`;
  const hue = Number(c.hue);
  // a voice holds someone else's atlas as it was handed over. on this
  // device it is the person's own record of that gift, and it is kept whole
  const keep = (arr, fn, field, cap, decode) => {
    const src = cutArr(w, 'voice', cid, field, Array.isArray(arr) ? arr : [], cap);
    const out = [];
    for (let n = 0; n < src.length; n++) {
      const v = decode ? fn(src[n], n, decode, caps, w) : fn(src[n], n, caps, w);
      if (v) out.push(v);
    }
    return out;
  };
  return {
    id: id(c.id, `c${i}`, w, 'voice', caps.id ?? LIMITS.id),
    name: cutStr(w, 'voice', cid, 'name', c.name, caps.author ?? LIMITS.author) || 'Unnamed correspondent',
    hue: Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : NaN,
    visible: c.visible !== false,
    addedAt: str(c.addedAt, 40),
    tags: keep(c.tags, normTag, 'domains', caps.tags ?? LIMITS.tags),
    places: keep(c.places, normPlace, 'places', caps.places ?? LIMITS.places),
  };
}

// What travels in a person's own archive, named exactly.
//
// The file says it carries your settings, so it has to carry them. This used
// to keep the byline and the theme and drop the rest, which meant a restored
// atlas came back in someone else's colour. Anything not named here is device
// state or a credential, and is left behind on purpose: the club key is a
// bearer token, and where the map was last looking is not a memory.
export function normSettings(raw, caps = LIMITS, w = null) {
  if (!isObj(raw)) return {};
  const s = safeKeys(raw);
  const out = {};
  if (typeof s.authorName === 'string') {
    out.authorName = cutStr(w, 'settings', 'settings', 'byline', s.authorName, caps.author ?? LIMITS.author);
  }
  if (s.theme === 'light' || s.theme === 'dark' || s.theme === 'auto') out.theme = s.theme;
  // the colour the whole atlas is drawn in, and the angle between its two
  // halves: as much a part of how an atlas looks as anything in it
  const hue = Number(s.hue);
  if (Number.isFinite(hue)) out.hue = ((hue % 360) + 360) % 360;
  const split = Number(s.split);
  if (Number.isFinite(split)) out.split = Math.max(-180, Math.min(180, split));
  if (typeof s.words === 'boolean') out.words = s.words;
  if (typeof s.introSeen === 'boolean') out.introSeen = s.introSeen;
  if (typeof s.lastExportAt === 'string') out.lastExportAt = str(s.lastExportAt, 40);
  if (typeof s.erasedAt === 'string') out.erasedAt = str(s.erasedAt, 40);
  return out;
}

// the fields above, so a caller can say what a file will and will not carry
// without reading this function
export const PORTABLE_SETTINGS = ['authorName', 'theme', 'hue', 'split', 'words', 'introSeen', 'lastExportAt', 'erasedAt'];

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
export function normFolioRef(raw, i = 0, caps = LIMITS, w = null) {
  if (!isObj(raw)) return null;
  const f = safeKeys(raw);
  const fid = String(f.id ?? '') || `f${i}`;
  const title = cutStr(w, 'folio', fid, 'title', f.title, caps.title ?? LIMITS.title).trim();
  if (!title) return null;
  // a folio is a list of references, and a reference that is dropped is a
  // place that quietly left the collection it belonged to
  const ids = (arr, field, cap) => cutArr(w, 'folio', fid, field,
    Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && !FORBIDDEN.has(x)) : [], cap);
  return {
    id: id(f.id, `f${i}`, w, 'folio', caps.id ?? LIMITS.id),
    title,
    dedication: cutStr(w, 'folio', fid, 'dedication', f.dedication, caps.dedication ?? LIMITS.dedication),
    placeIds: ids(f.placeIds, 'places', caps.placeIds ?? LIMITS.placeIds),
    routeIds: ids(f.routeIds, 'ways', caps.routeIds ?? LIMITS.routeIds),
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
// own memory coming home: nothing in it is shortened, and if anything in it
// cannot be kept exactly, the whole restore stops before a single record is
// written. They used to be the same function, so restoring a backup of 501
// places gave back 500 and called it success. Then the generous numbers did
// the same thing one level down, at 201 photographs. A limit chosen so that
// loss is rare is still a limit that loses; this door has none.

// how many of each kind a stranger may hand over at once
const SHARE_CAPS = {
  places: LIMITS.places, routes: LIMITS.routes,
  folios: LIMITS.folios, tags: LIMITS.tags, correspondents: LIMITS.correspondents,
};
// a person's own archive: as many as it carries
const ARCHIVE_CAPS = {
  places: ALL, routes: ALL, folios: ALL, tags: ALL, correspondents: ALL,
};

function gather(arr, fn, cap, decode, caps, w) {
  if (!Array.isArray(arr)) return { kept: [], given: 0, rejected: [], cut: 0 };
  const kept = [];
  const rejected = [];
  for (let i = 0; i < arr.length && kept.length < cap; i++) {
    const v = decode ? fn(arr[i], i, decode, caps, w) : fn(arr[i], i, caps, w);
    if (v) kept.push(v);
    else rejected.push({ at: i, id: String(arr[i]?.id ?? '') || null });
  }
  return { kept, given: arr.length, rejected, cut: Math.max(0, arr.length - cap) };
}

const KINDS = { tags: 'domain', places: 'place', routes: 'way', folios: 'folio', correspondents: 'voice' };

// { value, cut, rejected, clipped }
//
// cut      — whole collections truncated at the top level
// rejected — records that could not be read at all, named
// clipped  — fields that had to be shortened, named
//
// For an own archive all three are empty or the restore does not happen.
function readAtlas(raw, caps, fieldCaps = LIMITS, witness = null) {
  if (!isObj(raw)) return null;
  const d = safeKeys(raw);
  const w = witness;
  const parts = {
    tags: gather(d.tags, normTag, caps.tags, null, fieldCaps, w),
    places: gather(d.places, normPlace, caps.places, null, fieldCaps, w),
    routes: gather(d.routes, normRoute, caps.routes, decodePath, fieldCaps, w),
    folios: gather(d.folios, normFolioRef, caps.folios, null, fieldCaps, w),
    correspondents: gather(d.correspondents, normCorrespondent, caps.correspondents, null, fieldCaps, w),
  };
  const cut = Object.entries(parts).filter(([, p]) => p.cut > 0)
    .map(([k, p]) => ({ of: k, given: p.given, kept: p.kept.length }));
  const rejected = Object.entries(parts).flatMap(([k, p]) => p.rejected.map(r => ({
    kind: KINDS[k] || k, id: r.id, at: r.at, field: null,
    reason: 'this record could not be read: it is missing something it cannot be without, or it is not the shape a record has',
  })));
  return {
    value: {
      tags: parts.tags.kept, places: parts.places.kept, routes: parts.routes.kept,
      folios: parts.folios.kept, correspondents: parts.correspondents.kept,
      settings: normSettings(d.settings, fieldCaps, w),
    },
    cut, rejected, clipped: w || [],
  };
}

// a stranger's payload: capped hard, silence is fine
export function normImport(raw) {
  const r = readAtlas(raw, SHARE_CAPS);
  return r ? r.value : null;
}

// a person's own archive coming home. Nothing is shortened. Whatever could
// not be kept exactly is named, and the caller refuses on any of it.
export function readArchive(raw) {
  return readAtlas(raw, ARCHIVE_CAPS, OWN, []);
}

// everything an own archive lost, in one list a person can be shown. Empty is
// the only acceptable answer for a restore.
export function losses(read) {
  if (!read) return [];
  const out = [];
  for (const c of read.cut || []) {
    out.push({ kind: c.of, id: null, field: null,
      reason: `${c.given} ${c.of} in the file and only ${c.kept} could be held` });
  }
  for (const r of read.rejected || []) out.push(r);
  for (const c of read.clipped || []) {
    out.push({ kind: c.kind, id: c.id, field: c.field, reason: c.reason });
  }
  return out;
}

// what this device already holds: never capped, or an atlas would shrink
// every time it was loaded
export function readLocal(arr, kind) {
  const fn = { places: normPlace, routes: normRoute, tags: normTag,
    folios: normFolioRef, correspondents: normCorrespondent }[kind];
  const r = gather(arr, fn, ALL, kind === 'routes' ? decodePath : null, OWN, null);
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
