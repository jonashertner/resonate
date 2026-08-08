// store.js — persistence, models, demo data

import { normImport, readArchive, readLocal, losses, normPlace, normRoute, normRoutes, normFolioRefs, SCHEMA_VERSION } from './schema.js?v=rf70';
import { measure } from './route.js?v=rf70';
import { buildDisclosure } from './share.js?v=rf70';

const K_PLACES = 'resonate.places.v1';
const K_TAGS = 'resonate.tags.v1';
const K_SETTINGS = 'resonate.settings.v1';
const K_CORR = 'resonate.correspondents.v1';
const K_ROUTES = 'resonate.routes.v1';
const K_FOLIOS = 'resonate.folios.v1';

// the tag wheel: eight hue stations that survive full-viewport takeover.
// hue is the stored truth; hex is kept only for interop with old exports/links.
export const TAG_STATIONS = [
  { hue: 12, name: 'rosewood', hex: '#8A3B47' },
  { hue: 42, name: 'ember', hex: '#8A5226' },
  { hue: 95, name: 'moss', hex: '#6E6320' },
  { hue: 155, name: 'spruce', hex: '#2F6B4F' },
  { hue: 205, name: 'petrol', hex: '#2A6578' },
  { hue: 242, name: 'cobalt', hex: '#3D5A9E' },
  { hue: 278, name: 'iris', hex: '#5F4DA8' },
  { hue: 318, name: 'orchid', hex: '#8A3F86' },
];
export const TAG_COLORS = TAG_STATIONS.map(s => s.hex);

export function hexToHue(hex) {
  const m = /^#([0-9a-fA-F]{6})/.exec(String(hex || ''));
  if (!m) return 205;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const M = Math.max(r, g, b), mn = Math.min(r, g, b), d = M - mn;
  if (!d) return 205;
  let h = M === r ? ((g - b) / d) % 6 : M === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

export function nearestStation(hue) {
  return TAG_STATIONS.reduce((best, s) => {
    const dist = Math.min(Math.abs(s.hue - hue), 360 - Math.abs(s.hue - hue));
    return dist < best.dist ? { dist, s } : best;
  }, { dist: 361, s: TAG_STATIONS[4] }).s;
}

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9));
}

// ---------- unreadable keys ----------
//
// A key that will not parse is not an empty key.
//
// This used to catch the error and hand back an empty array. The app then
// drew an empty atlas, and the very next edit called savePlaces(), which
// wrote that empty array over the damaged bytes. One corrupt byte became a
// blank life, permanently, on the next keystroke, and nobody was told.
//
// Now the damaged bytes are left exactly where they are. A copy is set aside
// under a name that says what it is, the key is sealed against writing, and
// the app is expected to say so out loud. An atlas that cannot be read is a
// bad day. An atlas that cannot be read and is then overwritten is the end of
// the thing this app is for.
const sealed = new Map(); // key -> { at, bytes }

export function unreadableKeys() {
  return [...sealed.entries()].map(([key, v]) => ({ key, at: v.at, bytes: v.bytes }));
}

// a person who has been told, and has decided, may release a key. the set
// aside copy stays where it is: releasing is a decision to move on, not a
// decision to destroy.
export function releaseUnreadable(key) { return sealed.delete(key); }

function read(key, fallback) {
  let raw = null;
  try { raw = localStorage.getItem(key); } catch { return fallback; }
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    sealed.set(key, { at: new Date().toISOString(), bytes: raw.length });
    // keep the original where a person or a support session can still reach
    // it, and never over a copy already set aside by an earlier load
    try {
      const keep = `${key}.unreadable`;
      if (localStorage.getItem(keep) === null) localStorage.setItem(keep, raw);
    } catch { /* no room to set it aside; the original is still untouched */ }
    return fallback;
  }
}

// a refused write must be heard: the app sets onWriteFailed to say so out loud
export let onWriteFailed = null;
export function setWriteFailedHandler(fn) { onWriteFailed = fn; }

function write(key, value) {
  if (sealed.has(key)) {
    // the damaged bytes stay. this is a refusal, not a failure, and it is
    // reported through the same channel so the app already knows how to speak
    onWriteFailed?.(key, new Error('this key could not be read, and will not be written over'));
    return false;
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('Storage write failed', e);
    onWriteFailed?.(key, e);
    return false;
  }
}

// a place arriving from a link, a file, or the commons is a stranger.
// schema.js decides what a place is; this keeps the old name for callers.
export function sanePlace(p) {
  return normPlace({ lat: 0, lng: 0, ...p }) || normPlace({ lat: 0, lng: 0 });
}

export function newPlace(partial = {}) {
  const now = new Date().toISOString();
  return {
    id: uid(),
    name: 'Untitled place',
    lat: 0,
    lng: 0,
    address: '',
    city: '',
    country: '',
    countryCode: '',
    tags: [],
    status: 'wishlist', // 'visited' | 'wishlist'
    private: false,     // true: it never leaves this device
    rating: 0,          // read from old links, never written
    note: '',
    url: '',
    photos: [],
    ...partial,
    // a caller passing id: undefined must still get a real, unique id
    ...(partial.id ? {} : { id: uid() }),
    // A link carries no diary of when, so a place arriving from one has empty
    // dates. It was entered into THIS atlas now, which is the honest answer,
    // and an empty date must never survive into the record.
    createdAt: partial.createdAt || now,
    updatedAt: partial.updatedAt || now,
  };
}

// A way is stored with the shape it was given.
//
// This used to run simplify() over every path that passed through, which
// looked harmless and was not: simplify is not idempotent on a path carrying
// elevation, so a way lost a few percent of itself every time it came home
// from an archive, and again the next time, and again. A record that changes
// by being read is not a record.
//
// Thinning belongs where a shape is first captured (the gpx importer does it
// before it calls here) and where a shape has to fit in a link (packRoutes
// does it on the way out). Never in between.
export function newRoute(partial = {}) {
  const now = new Date().toISOString();
  const path = Array.isArray(partial.path) ? partial.path : [];
  const m = measure(path);
  return {
    id: uid(),
    kind: 'route',
    name: 'Untitled way',
    path,
    city: '', country: '',
    tags: [],
    status: 'wishlist',
    rating: 0,
    note: '', url: '',
    km: m.km, ascent: m.ascent, descent: m.descent,
    high: m.high, low: m.low, hours: m.hours, loop: m.loop,
    walkedAt: '',
    private: false,
    trimEnds: false,
    ...partial,
    path,
    ...(partial.id ? {} : { id: uid() }),
    // a way from a link carries no dates either: it entered here, now
    createdAt: partial.createdAt || now,
    updatedAt: partial.updatedAt || now,
  };
}

// a folio on the shelf: a titled slice, kept as references so it stays
// current as the atlas improves. it copies nothing until it is handed over.
export function newFolio(partial = {}) {
  const now = new Date().toISOString();
  return {
    id: uid(),
    title: 'Untitled folio',
    dedication: '',
    placeIds: [],
    routeIds: [],
    createdAt: now,
    updatedAt: now,
    ...partial,
    ...(partial.id ? {} : { id: uid() }),
  };
}

export function newTag(partial = {}) {
  const t = {
    id: uid(),
    name: 'Tag',
    emoji: '',
    color: TAG_STATIONS[4].hex,
    ...partial,
  };
  if (!Number.isFinite(t.hue)) t.hue = nearestStation(hexToHue(t.color)).hue;
  return t;
}

// ---------- hiding the ends of a way ----------
//
// A quarter of a kilometre from each end, which is enough to lose a door.
//
// This used to give up when a path held fewer than eight points and hand the
// way over whole. A straight thirteen kilometre walk simplifies to two points,
// so the one case where a person most wants their door hidden was the case
// where both ends went out untouched, under a sentence promising otherwise.
// Point count says nothing about ground. Distance is the only measure here,
// and a new end is interpolated inside the segment that crosses the mark, so
// two points are enough to trim.
//
// It fails closed. A way too short to lose both ends is not handed over half
// redacted and not handed over whole: trimWay returns null and the surface
// says why.
const TRIM_KM = 0.25;
const R_KM = 6371, RAD = Math.PI / 180;

function step(a, b) {
  const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(s));
}

// the point f of the way along a segment, elevation carried with it.
// the longitudes are brought within half a turn of each other first, or a
// segment stepping over the antimeridian would interpolate the long way round
// and put the new end in the middle of the Pacific.
function between(a, b, f) {
  let dLng = b.lng - a.lng;
  if (dLng > 180) dLng -= 360;
  if (dLng < -180) dLng += 360;
  let lng = a.lng + dLng * f;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  const pt = { lat: a.lat + (b.lat - a.lat) * f, lng };
  if (Number.isFinite(a.ele) && Number.isFinite(b.ele)) pt.ele = a.ele + (b.ele - a.ele) * f;
  else if (Number.isFinite(a.ele)) pt.ele = a.ele;
  return pt;
}

// Walk in from the start until you are TRIM_KM from the door, and return the
// path from exactly there.
//
// Two measures have to agree here, and only one of them is the point. Walking
// TRIM_KM of recorded line says nothing about how far you have got: a track
// that circles the block, or wanders the garden, or simply jitters while the
// receiver settles, can spend a quarter kilometre of line and still be
// standing at the front door. So the line is walked, and the new head is
// pushed on until it is also TRIM_KM away from where the track began. What is
// being hidden is a place, not a length.
function fromHead(path, km) {
  const origin = path[0];
  let run = 0;
  for (let i = 1; i < path.length; i++) {
    const d = step(path[i - 1], path[i]);
    if (run + d >= km) {
      const f = d > 0 ? (km - run) / d : 1;
      const head = between(path[i - 1], path[i], f);
      // far enough along the line; now far enough from the door as well
      if (step(origin, head) >= km) return [head, ...path.slice(i)];
      for (let j = i; j < path.length; j++) {
        if (step(origin, path[j]) >= km) return path.slice(j);
      }
      return null; // the whole track stays within the stretch to hide
    }
    run += d;
  }
  return null; // the whole way is shorter than the stretch to hide
}

const reversed = a => [...a].reverse();

export function trimWay(r) {
  if (!r?.trimEnds || !Array.isArray(r.path) || r.path.length < 2) return r;
  const head = fromHead(r.path, TRIM_KM);
  if (!head || head.length < 2) return null;
  const both = fromHead(reversed(head), TRIM_KM);
  if (!both || both.length < 2) return null;
  const path = reversed(both);
  // the shape handed over is shorter than the one walked, so the numbers
  // beside it are the shorter shape's. a distance that describes a stretch
  // the recipient was not given is a quiet way of giving it to them.
  const m = measure(path);
  return {
    ...r, path,
    km: m.km, ascent: m.ascent, descent: m.descent,
    high: m.high, low: m.low, hours: m.hours, loop: m.loop,
  };
}

const DEFAULT_SETTINGS = { theme: 'auto', hue: 300, lastView: null, seeded: false, authorName: '', clubKey: '', clubUrl: '', clubSeq: 0, clubSealedAt: '' };

export const store = {
  places: [],
  routes: [],
  folios: [],
  tags: [],
  correspondents: [],
  settings: { ...DEFAULT_SETTINGS },
  // set by the last reading of a person's own archive: everything in the file
  // that could not be kept exactly, named. empty after any other kind of merge
  lastLost: [],

  load() {
    // records adopted before this carry an empty date, which read back as
    // "Invalid Date": give them the day they are first seen, once
    const sane = (v) => !!v && !Number.isNaN(new Date(v).getTime());
    const dated = (r) => (sane(r.createdAt) ? r
      : { ...r, createdAt: sane(r.updatedAt) ? r.updatedAt : new Date().toISOString() });
    this.places = readLocal(read(K_PLACES, []), 'places').map(dated);
    this.routes = readLocal(read(K_ROUTES, []), 'routes').map(dated);
    this.folios = readLocal(read(K_FOLIOS, []), 'folios');
    this.tags = read(K_TAGS, []);
    this.correspondents = read(K_CORR, []);
    this.settings = { ...DEFAULT_SETTINGS, ...read(K_SETTINGS, {}) };
    // whatever was healed above is written down, so it heals only once
    if (this.places.some(p => p.createdAt) || this.routes.some(r => r.createdAt)) {
      const needsWrite = read(K_PLACES, []).some(p => !sane(p.createdAt))
        || read(K_ROUTES, []).some(r => !sane(r.createdAt));
      if (needsWrite) { this.savePlaces(); this.saveRoutes(); }
    }
    // migrate hex-era tags onto the hue wheel
    let migrated = false;
    this.tags.forEach(t => {
      if (!Number.isFinite(t.hue)) { t.hue = nearestStation(hexToHue(t.color)).hue; migrated = true; }
    });
    if (migrated) this.saveTags();
  },

  savePlaces() { return write(K_PLACES, this.places); },
  saveTags() { return write(K_TAGS, this.tags); },
  saveSettings() { return write(K_SETTINGS, this.settings); },
  saveCorrespondents() { return write(K_CORR, this.correspondents); },
  saveRoutes() { return write(K_ROUTES, this.routes); },
  saveFolios() { return write(K_FOLIOS, this.folios); },

  folioById(id) { return this.folios.find(f => f.id === id); },

  addFolio(folio) {
    this.folios.unshift(folio);
    if (!this.saveFolios()) { this.folios.shift(); return null; }
    return folio;
  },

  updateFolio(id, patch) {
    const f = this.folioById(id);
    if (!f) return null;
    const before = { ...f };
    Object.assign(f, patch, { updatedAt: new Date().toISOString() });
    if (!this.saveFolios()) { Object.assign(f, before); return null; }
    return f;
  },

  removeFolio(id) {
    const before = this.folios;
    this.folios = this.folios.filter(f => f.id !== id);
    if (!this.saveFolios()) this.folios = before;
  },

  // a folio materializes at the moment it is needed: missing places have
  // been removed from the atlas and silently fall out of the slice
  resolveFolio(id) {
    const f = this.folioById(id);
    if (!f) return null;
    return {
      ...f,
      places: f.placeIds.map(pid => this.placeById(pid)).filter(Boolean),
      routes: f.routeIds.map(rid => this.routeById(rid)).filter(Boolean),
    };
  },

  routeById(id) { return this.routes.find(r => r.id === id); },

  addRoute(route) {
    this.routes.unshift(route);
    if (!this.saveRoutes()) { this.routes.shift(); return null; }
    return route;
  },

  updateRoute(id, patch) {
    const r = this.routeById(id);
    if (!r) return null;
    const before = { ...r };
    Object.assign(r, patch, { updatedAt: new Date().toISOString() });
    if (!this.saveRoutes()) { Object.assign(r, before); return null; }
    return r;
  },

  removeRoute(id) {
    const before = this.routes;
    this.routes = this.routes.filter(r => r.id !== id);
    if (!this.saveRoutes()) this.routes = before;
  },

  // ---------- correspondents: kept atlases from people whose taste you've measured ----------

  addCorrespondent({ name, tags, places, hue }) {
    const c = {
      id: uid(),
      name: name || 'Unnamed correspondent',
      hue: Number.isFinite(hue) ? hue : TAG_STATIONS[(this.correspondents.length + 2) % TAG_STATIONS.length].hue,
      visible: true,
      addedAt: new Date().toISOString(),
      tags: (tags || []).map(t => newTag(t)),
      places: (places || [])
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .map(p => newPlace({ ...p, photos: [] })),
    };
    this.correspondents.push(c);
    if (!this.saveCorrespondents()) { this.correspondents.pop(); return null; }
    return c;
  },

  updateCorrespondent(id, patch) {
    const c = this.correspondents.find(x => x.id === id);
    if (!c) return null;
    const before = { ...c };
    Object.assign(c, patch);
    if (!this.saveCorrespondents()) { Object.assign(c, before); return null; }
    return c;
  },

  removeCorrespondent(id) {
    const before = this.correspondents;
    this.correspondents = this.correspondents.filter(c => c.id !== id);
    if (!this.saveCorrespondents()) this.correspondents = before;
  },

  tagById(id) { return this.tags.find(t => t.id === id); },
  placeById(id) { return this.places.find(p => p.id === id); },

  // a mutation that cannot be written is not a mutation: roll it back so the
  // screen never shows a place the device refused to keep
  addPlace(place) {
    this.places.unshift(place);
    if (!this.savePlaces()) { this.places.shift(); return null; }
    return place;
  },

  updatePlace(id, patch) {
    const p = this.placeById(id);
    if (!p) return null;
    const before = { ...p };
    Object.assign(p, patch, { updatedAt: new Date().toISOString() });
    if (!this.savePlaces()) { Object.assign(p, before); return null; }
    return p;
  },

  removePlace(id) {
    const before = this.places;
    this.places = this.places.filter(p => p.id !== id);
    if (!this.savePlaces()) this.places = before;
  },

  addTag(tag) {
    this.tags.push(tag);
    if (!this.saveTags()) { this.tags.pop(); return null; }
    return tag;
  },

  updateTag(id, patch) {
    const t = this.tagById(id);
    if (!t) return null;
    const before = { ...t };
    Object.assign(t, patch);
    if (!this.saveTags()) { Object.assign(t, before); return null; }
    return t;
  },

  removeTag(id) {
    this.tags = this.tags.filter(t => t.id !== id);
    this.places.forEach(p => { p.tags = p.tags.filter(tid => tid !== id); });
    this.saveTags();
    this.savePlaces();
  },

  tagCount(id) {
    return this.places.reduce((n, p) => n + (p.tags.includes(id) ? 1 : 0), 0);
  },

  // erase means erase: every resonate key leaves the device
  clearAll() {
    this.places = [];
    this.routes = [];
    this.folios = [];
    this.tags = [];
    this.correspondents = [];
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('resonate.'))
        .forEach(k => localStorage.removeItem(k));
    } catch { /* nothing left to do */ }
    // an erased atlas is not a new one: a specimen must never grow back over
    // it. the club key survives an erase; the club room holds the word that
    // forgets it on purpose.
    const { clubKey, clubUrl, clubSeq, clubSealedAt } = this.settings;
    this.settings = { ...DEFAULT_SETTINGS, seeded: true, erasedAt: new Date().toISOString(), clubKey, clubUrl, clubSeq, clubSealedAt };
    this.saveSettings();
  },

  // Read a person's own archive and refuse it if anything at all was lost in
  // the reading. Returns { value, lost: [...] }; `lost` is the whole list, so
  // a caller can name the record and the field rather than say "some".
  readOwn(raw) {
    const read = readArchive(raw);
    if (!read) return { value: null, lost: [] };
    return { value: read.value, lost: losses(read) };
  },

  // merge imported data, deduping by id; imported fields that reach markup are normalized
  // `own` marks a person's own archive coming home: read through the door
  // that shortens nothing. Returns null when the archive lost something in
  // the reading or the device refused the write, a count otherwise.
  merge(raw, { own = false } = {}) {
    const read = own ? this.readOwn(raw) : null;
    // everything the file carried that could not be kept exactly. an archive
    // that lost anything is not merged at all: the caller is handed the list
    // and the person is told what and where.
    this.lastLost = own ? (read?.lost ?? []) : [];
    if (own && this.lastLost.length) return null;
    const data = own ? read?.value : normImport(raw);
    if (!data) return 0;
    // held so the whole import can be undone if any part of it is refused
    const before = {
      places: [...this.places], tags: [...this.tags],
      routes: [...this.routes], folios: [...this.folios],
      correspondents: [...this.correspondents],
      settings: { ...this.settings },
    };
    const tagIds = new Set(this.tags.map(t => t.id));
    const placeIds = new Set(this.places.map(p => p.id));
    let added = 0;
    // same name, same domain: never two Restaurants with different ids
    const byName = new Map(this.tags.map(t => [t.name.trim().toLowerCase(), t.id]));
    const remap = new Map();
    data.tags.forEach(t => {
      if (tagIds.has(t.id)) return;
      const existing = byName.get(t.name.trim().toLowerCase());
      if (existing) { remap.set(t.id, existing); return; }
      added++;
      this.tags.push(newTag(t));
      tagIds.add(t.id);
      byName.set(t.name.trim().toLowerCase(), t.id);
    });
    const repoint = (ids) => ids.map(id => remap.get(id) || id);
    data.places.forEach(p => {
      if (!placeIds.has(p.id)) {
        this.places.push(newPlace({ ...p, tags: repoint(p.tags) }));
        placeIds.add(p.id);
        added++;
      }
    });
    const routeIds = new Set(this.routes.map(r => r.id));
    data.routes.forEach(r => {
      if (!routeIds.has(r.id)) {
        this.routes.push(newRoute({ ...r, tags: repoint(r.tags) }));
        routeIds.add(r.id);
        added++;
      }
    });
    const folioIds = new Set(this.folios.map(f => f.id));
    data.folios.forEach(f => {
      if (!folioIds.has(f.id)) {
        this.folios.push(newFolio(f));
        folioIds.add(f.id);
        added++;
      }
    });
    // an export carries the whole atlas back, correspondents and signature included
    const corrIds = new Set(this.correspondents.map(c => c.id));
    data.correspondents.forEach(c => {
      if (!corrIds.has(c.id)) {
        this.correspondents.push({
          ...c,
          hue: Number.isFinite(c.hue) ? c.hue : TAG_STATIONS[(this.correspondents.length + 2) % TAG_STATIONS.length].hue,
          tags: c.tags.map(t => newTag(t)),
        });
        corrIds.add(c.id);
        added++;
      }
    });
    // a merge adds; it does not repaint an atlas that already has a look.
    // only what this device has not decided for itself is taken.
    if (!this.settings.authorName && data.settings.authorName) {
      this.settings.authorName = data.settings.authorName;
    }
    // the look is a decision this device made and a merge is not the place to
    // overturn it. only an atlas that has never been dressed takes the file's
    // colour; restore, which is the operation that means "be this file", sets
    // the whole of it.
    const undressed = !this.settings.chosen && !this.places.length;
    if (undressed) {
      if (data.settings.theme) this.settings.theme = data.settings.theme;
      if (Number.isFinite(Number(data.settings.hue))) this.settings.hue = Number(data.settings.hue);
      if (Number.isFinite(Number(data.settings.split))) this.settings.split = Number(data.settings.split);
    }
    // an import is one act: if any part of it cannot be written, none of it
    // is kept, and the caller is told nothing came in
    const ok = this.savePlaces() && this.saveTags() && this.saveRoutes()
      && this.saveFolios() && this.saveCorrespondents();
    if (!ok) {
      this.places = before.places;
      this.tags = before.tags;
      this.routes = before.routes;
      this.folios = before.folios;
      this.correspondents = before.correspondents;
      this.settings = before.settings;
      this.savePlaces(); this.saveTags(); this.saveRoutes(); this.saveFolios(); this.saveCorrespondents();
      return null; // refused is not the same as nothing new
    }
    this.saveSettings();
    return added;
  },

  // ---------- restore ----------
  //
  // Merge and restore are not the same operation, and pretending they were is
  // why "import backup" could not bring back an older note, a damaged place,
  // a photograph that had been removed, or an earlier shape of a way. A merge
  // adds what is missing and touches nothing that already exists. A restore
  // says: this file is the atlas now.
  //
  // Restore replaces. It refuses an archive that lost anything in the reading,
  // it refuses to write half of one, and it puts everything back exactly as it
  // was if any part of the write is refused. What it cannot do is undo itself
  // afterwards: the caller takes a snapshot first, and the surface says so.
  //
  // Returns { ok, lost, was, now } — `was` and `now` are counts, so a person
  // can be shown what this will cost before they agree to it.
  restore(raw) {
    const read = this.readOwn(raw);
    this.lastLost = read.lost;
    if (!read.value) return { ok: false, lost: read.lost, reason: 'unreadable' };
    if (read.lost.length) return { ok: false, lost: read.lost, reason: 'lossy' };
    const d = read.value;

    const before = {
      places: [...this.places], tags: [...this.tags], routes: [...this.routes],
      folios: [...this.folios], correspondents: [...this.correspondents],
      settings: { ...this.settings },
    };
    const was = {
      places: before.places.length, routes: before.routes.length,
      tags: before.tags.length, folios: before.folios.length,
      correspondents: before.correspondents.length,
    };

    this.places = d.places.map(p => newPlace({ ...p }));
    this.routes = d.routes.map(r => newRoute({ ...r }));
    this.tags = d.tags.map(t => newTag(t));
    this.folios = d.folios.map(f => newFolio(f));
    this.correspondents = d.correspondents.map(c => ({
      ...c, tags: (c.tags || []).map(t => newTag(t)),
    }));
    // the club key is this device's own credential and belongs to the device,
    // not to the file; the rest of the look and the byline come from the file
    const { clubKey, clubUrl, clubSeq, clubSealedAt } = this.settings;
    this.settings = {
      ...DEFAULT_SETTINGS, ...d.settings,
      seeded: true, chosen: true,
      clubKey, clubUrl, clubSeq, clubSealedAt,
    };

    const ok = this.savePlaces() && this.saveTags() && this.saveRoutes()
      && this.saveFolios() && this.saveCorrespondents() && this.saveSettings();
    if (!ok) {
      this.places = before.places;
      this.tags = before.tags;
      this.routes = before.routes;
      this.folios = before.folios;
      this.correspondents = before.correspondents;
      this.settings = before.settings;
      this.savePlaces(); this.saveTags(); this.saveRoutes();
      this.saveFolios(); this.saveCorrespondents(); this.saveSettings();
      return { ok: false, lost: [], reason: 'refused', was, now: was };
    }
    return {
      ok: true, lost: [], was,
      now: {
        places: this.places.length, routes: this.routes.length,
        tags: this.tags.length, folios: this.folios.length,
        correspondents: this.correspondents.length,
      },
    };
  },

  // What a merge would change, without changing anything. A person deciding
  // between adding and replacing deserves to see the difference first.
  compare(raw) {
    const read = this.readOwn(raw);
    if (!read.value) return null;
    const d = read.value;
    const mine = new Map(this.places.map(p => [p.id, p]));
    const mineWays = new Map(this.routes.map(r => [r.id, r]));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // a photograph is the same photograph whether the file inlines it or this
    // device holds it under an id. counting that as a difference would tell a
    // person their atlas had changed when only its carrier had.
    const carrier = p => ({ ...p, sample: false, photos: (p.photos || []).length });
    let fresh = 0, differ = 0, identical = 0;
    for (const p of d.places) {
      const held = mine.get(p.id);
      if (!held) fresh += 1;
      else if (same(carrier(held), carrier({ ...newPlace({ ...p }), id: held.id }))) identical += 1;
      else differ += 1;
    }
    for (const r of d.routes) {
      const held = mineWays.get(r.id);
      if (!held) fresh += 1; else if (same(held.path, r.path)) identical += 1; else differ += 1;
    }
    // restore replaces folios, voices and domains too, so a warning that
    // counted only places and ways was telling a person less than it destroys
    const theirs = new Set([
      ...d.places.map(p => p.id), ...d.routes.map(r => r.id),
      ...d.folios.map(f => f.id), ...d.correspondents.map(c => c.id), ...d.tags.map(t => t.id),
    ]);
    const onlyHere = [...this.places, ...this.routes, ...this.folios, ...this.correspondents, ...this.tags]
      .filter(x => !theirs.has(x.id)).length;
    return { fresh, differ, identical, onlyHere, lost: read.lost };
  },

  // what may be handed to someone else: the atlas without the private layer.
  // the share surface promises photographs never leave the device, and a file
  // offered in place of a link has to keep that promise.
  // the first and last stretch of a way is where a person lives: when asked,
  // the shape handed over begins and ends a quarter kilometre in
  trimWay(r) { return trimWay(r); },

  // What a stranger may be given, in a file.
  //
  // This used to spread whole records and hand over every domain in the
  // atlas, while the link beside it was an explicit field list. Same panel,
  // same promise, two different disclosures: the file quietly added the dates
  // every record was made and touched, domains the person had never used, and
  // any field a later release happened to add. It is the same object as the
  // link now. Only the carrier differs.
  outward() {
    const places = this.places.filter(p => !p.private);
    // a way whose ends cannot be hidden is not handed over at all
    const routes = this.routes.filter(r => !r.private).map(trimWay).filter(Boolean);
    const used = new Set([...places, ...routes].flatMap(x => x.tags || []));
    const tags = this.tags.filter(t => used.has(t.id));
    return buildDisclosure({ places, routes, tags, author: this.settings.authorName || '' });
  },

  exportShareJSON() {
    // `kind` is the payload's kind, the one normPayload reads. the file used
    // to say 'share' here, which nothing read and which normPayload treated
    // as an atlas anyway; saying 'atlas' is the same behaviour, said plainly.
    return JSON.stringify({
      app: 'resonate',
      exportedAt: new Date().toISOString(),
      ...this.outward(),
    }, null, 2);
  },

  // the records alone, for a snapshot: the pictures are already durable
  recordsJSON() {
    return JSON.stringify({
      app: 'resonate', version: SCHEMA_VERSION, at: new Date().toISOString(),
      tags: this.tags, places: this.places, routes: this.routes,
      folios: this.folios, correspondents: this.correspondents,
    });
  },

  // everything, for yourself: photographs, voices and settings included
  // the file a member keeps for themselves carries the photographs, so the
  // ids are resolved back into data urls on the way out. inline entries from
  // before the move pass through untouched.
  async exportJSON(inline = null) {
    const places = inline ? await inline(this.places) : this.places;
    return JSON.stringify({
      app: 'resonate',
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      tags: this.tags,
      places,
      routes: this.routes,
      folios: this.folios,
      correspondents: this.correspondents,
      // the club key is a bearer credential for the vault itself: it never
      // rides in a file that leaves this device
      settings: { ...this.settings, clubKey: '' },
    }, null, 2);
  },

  // An atlas must be able to leave for anywhere, in formats nobody owns.
  // Each of these carries what may travel: never a place or a way marked as
  // never leaving, and never the ends of a way whose ends are trimmed.

  // kml, for google earth and everything that reads it
  exportKML() {
    const esc = t => String(t ?? '').replace(/[<>&'"]/g, c => (
      { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
    const marks = this.places.filter(p => !p.private).map(p => `    <Placemark>
      <name>${esc(p.name)}</name>
      <description>${esc([p.note, [p.address, p.city, p.country].filter(Boolean).join(', ')].filter(Boolean).join('\n\n'))}</description>
      <Point><coordinates>${p.lng},${p.lat},0</coordinates></Point>
    </Placemark>`).join('\n');
    const lines = this.routes.filter(r => !r.private).map(trimWay).filter(Boolean).map(r => `    <Placemark>
      <name>${esc(r.name)}</name>
      <LineString><tessellate>1</tessellate><coordinates>${r.path.map(pt => `${pt.lng},${pt.lat},${pt.ele ?? 0}`).join(' ')}</coordinates></LineString>
    </Placemark>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Resonate</name>
${[marks, lines].filter(Boolean).join('\n')}
  </Document>
</kml>`;
  },

  // csv, for a spreadsheet and for anything at all
  exportCSV() {
    const cell = v => {
      const t = String(v ?? '');
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const head = ['name', 'latitude', 'longitude', 'address', 'city', 'country', 'tags', 'been', 'note', 'link'];
    const rows = this.places.filter(p => !p.private).map(p => [
      p.name, p.lat, p.lng, p.address, p.city, p.country,
      p.tags.map(id => this.tagById(id)?.name).filter(Boolean).join('; '),
      p.status === 'visited' ? 'yes' : 'no',
      p.note, p.url,
    ].map(cell).join(','));
    return [head.join(','), ...rows].join('\n');
  },

  // markdown, so an atlas outlives every program that can read the rest
  exportMarkdown() {
    const byCity = new Map();
    this.places.filter(p => !p.private).forEach(p => {
      const key = p.city || p.country || 'elsewhere';
      if (!byCity.has(key)) byCity.set(key, []);
      byCity.get(key).push(p);
    });
    const out = ['# An atlas', '', `${this.places.filter(p => !p.private).length} places, kept in a browser and written out on ${new Date().toISOString().slice(0, 10)}.`, ''];
    [...byCity.keys()].sort().forEach(city => {
      out.push(`## ${city}`, '');
      byCity.get(city).sort((a, b) => a.name.localeCompare(b.name)).forEach(p => {
        out.push(`### ${p.name}`);
        const facts = [
          [p.address, p.country].filter(Boolean).join(', '),
          p.status === 'visited' ? 'been' : 'want to go',
          p.tags.map(id => this.tagById(id)?.name).filter(Boolean).join(', '),
          `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`,
        ].filter(Boolean);
        out.push('', facts.join(' · '), '');
        if (p.note) out.push(p.note, '');
        if (p.url) out.push(`<${p.url}>`, '');
        if (p.provenance) {
          const road = [...(p.provenance.chain || []).map(h => h.name), p.provenance.name].filter(Boolean);
          out.push(`_after ${road.reverse().join(', who had it from ')}_`, '');
        }
      });
    });
    const ways = this.routes.filter(r => !r.private).map(trimWay).filter(Boolean);
    if (ways.length) {
      out.push('## Ways', '');
      ways.forEach(r => {
        out.push(`### ${r.name}`, '');
        out.push([r.km ? `${r.km.toFixed(1)} km` : '', r.ascent ? `${r.ascent} m up` : '', r.loop ? 'a loop' : ''].filter(Boolean).join(' · '), '');
        if (r.note) out.push(r.note, '');
      });
    }
    return out.join('\n');
  },

  exportGeoJSON() {
    return JSON.stringify({
      type: 'FeatureCollection',
      features: this.places.filter(p => !p.private).map(p => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: {
          name: p.name,
          address: p.address,
          city: p.city,
          country: p.country,
          tags: p.tags.map(id => this.tagById(id)?.name).filter(Boolean),
          status: p.status,
          visited: p.status === 'visited',
          note: p.note,
          url: p.url,
        },
      })),
    }, null, 2);
  },
};

// ---------- the starting vocabulary ----------
//
// An atlas with no domains cannot file anything, so even an empty start is
// given these. They are ordinary tags: rename them, recolour them, remove them.

export function baseTags() {
  // eight domains onto the eight stations of the wheel, one each, stated
  // rather than derived: two domains that land on the same hue would ink the
  // world identically and stop telling you anything
  const at = (i, name, emoji) =>
    newTag({ name, emoji, hue: TAG_STATIONS[i].hue, color: TAG_STATIONS[i].hex });
  return {
    food: at(0, 'Restaurants', '🍽️'),
    cafe: at(1, 'Cafés', '☕'),
    // ground that is protected, and asks something of you in return
    reserve: at(2, 'Reserves', '🌿'),
    nature: at(3, 'Nature', '⛰️'),
    culture: at(4, 'Culture', '🖼️'),
    // a hut is what turns a long day into two: a roof, a meal, a bunk high up
    hut: at(5, 'Huts', '🛖'),
    bar: at(6, 'Bars', '🍸'),
    shop: at(7, 'Shops', '🧺'),
  };
}

// ---------- demo dataset ----------

export function demoData() {
  const t = baseTags();
  const day = 86400000;
  const ago = n => new Date(Date.now() - n * day).toISOString();
  const P = (partial, daysAgo) => newPlace({ ...partial, createdAt: ago(daysAgo), updatedAt: ago(daysAgo) });

  const places = [
    P({ name: 'Fondation Beyeler', lat: 47.58487, lng: 7.65098, city: 'Riehen', country: 'Switzerland', countryCode: 'ch',
        address: 'Baselstrasse 101, 4125 Riehen', tags: [t.culture.id], status: 'visited',
        note: 'Monet water lilies in front of the pond window. Go on a weekday morning and have the Rothko room to yourself.' }, 4),
    P({ name: 'Kunstmuseum Basel', lat: 47.55437, lng: 7.59417, city: 'Basel', country: 'Switzerland', countryCode: 'ch',
        address: 'St. Alban-Graben 16, 4051 Basel', tags: [t.culture.id], status: 'visited',
        note: 'The Holbein rooms. Quiet on Friday evenings.' }, 21),
    P({ name: 'Rheinbad Breite', lat: 47.55330, lng: 7.60530, city: 'Basel', country: 'Switzerland', countryCode: 'ch',
        address: 'St. Alban-Rheinweg 195, 4052 Basel', tags: [t.nature.id], status: 'visited',
        note: 'Drop in here, float past the Münster, out at Dreirosen. The whole city swims home in summer.' }, 9),
    P({ name: 'Markthalle Basel', lat: 47.54790, lng: 7.58750, city: 'Basel', country: 'Switzerland', countryCode: 'ch',
        address: 'Steinentorberg 20, 4051 Basel', tags: [t.food.id], status: 'visited',
        note: 'Lunch under the dome. The momo stand first, always.' }, 60),
    P({ name: 'Shakespeare and Company', lat: 48.85258, lng: 2.34710, city: 'Paris', country: 'France', countryCode: 'fr',
        address: '37 Rue de la Bûcherie, 75005 Paris', tags: [t.shop.id, t.culture.id], status: 'visited',
        note: 'Upstairs, the reading nook facing Notre-Dame. They stamp the books at the till.' }, 130),
    P({ name: 'Septime', lat: 48.85310, lng: 2.38390, city: 'Paris', country: 'France', countryCode: 'fr',
        address: '80 Rue de Charonne, 75011 Paris', tags: [t.food.id], status: 'wishlist',
        note: 'Book three weeks ahead, lunch is the way in.' }, 130),
    P({ name: 'Noma', lat: 55.68286, lng: 12.61033, city: 'Copenhagen', country: 'Denmark', countryCode: 'dk',
        address: 'Refshalevej 96, 1432 København', tags: [t.food.id], status: 'wishlist',
        note: 'Vegetable season, if it ever works out.' }, 200),
    P({ name: 'La Colombe d’Or', lat: 43.69690, lng: 7.12190, city: 'Saint-Paul-de-Vence', country: 'France', countryCode: 'fr',
        address: 'Place du Général de Gaulle, 06570 Saint-Paul-de-Vence', tags: [t.food.id, t.culture.id], status: 'wishlist',
        note: 'Légers and Picassos on the terrace walls. Lunch under the fig tree.' }, 88),
    P({ name: 'Meguro River cherry blossoms', lat: 35.64430, lng: 139.69830, city: 'Tokyo', country: 'Japan', countryCode: 'jp',
        address: 'Nakameguro, Meguro City, Tokyo', tags: [t.nature.id], status: 'wishlist',
        note: 'Late March, dusk, lanterns on. Walk from Nakameguro station south.' }, 300),
    P({ name: 'Onibus Coffee Nakameguro', lat: 35.64440, lng: 139.69940, city: 'Tokyo', country: 'Japan', countryCode: 'jp',
        address: '2-14-1 Kamimeguro, Meguro City, Tokyo', tags: [t.cafe.id], status: 'wishlist',
        note: 'The little house by the tracks. Upstairs window seat.' }, 300),
    P({ name: 'Bethesda Terrace', lat: 40.77400, lng: -73.97080, city: 'New York', country: 'United States', countryCode: 'us',
        address: 'Central Park, New York, NY', tags: [t.nature.id], status: 'visited',
        note: 'The tiled arcade underneath, when a cellist is playing.' }, 400),
    P({ name: 'Café Sabarsky', lat: 40.78110, lng: -73.96010, city: 'New York', country: 'United States', countryCode: 'us',
        address: '1048 5th Ave, New York, NY', tags: [t.cafe.id], status: 'visited',
        note: 'Viennese breakfast before the Klimts upstairs.' }, 400),
    P({ name: 'Vernazza', lat: 44.13500, lng: 9.68400, city: 'Vernazza', country: 'Italy', countryCode: 'it',
        address: 'Cinque Terre, Liguria', tags: [t.nature.id], status: 'visited',
        note: 'Hike in from Monterosso, swim off the harbour rocks, then anchovies and white wine.' }, 500),
    P({ name: 'Bar Basso', lat: 45.47850, lng: 9.22270, city: 'Milan', country: 'Italy', countryCode: 'it',
        address: 'Via Plinio 39, 20133 Milano', tags: [t.bar.id], status: 'wishlist',
        note: 'The negroni sbagliato was invented here. Giant glasses.' }, 45),
  ];

  places.push(
    P({ name: 'Cabane de Moiry', lat: 46.10750, lng: 7.57470, city: 'Grimentz', country: 'Switzerland', countryCode: 'ch',
        tags: [t.hut.id, t.nature.id], status: 'wishlist',
        note: 'On the rock above the glacier, 2825 m. Book the half board and the dormitory; the last stretch is a ladder in places. Wardened from June.' }, 9),
    P({ name: 'Berggasthaus Aescher', lat: 47.28360, lng: 9.41810, city: 'Appenzell', country: 'Switzerland', countryCode: 'ch',
        tags: [t.hut.id, t.food.id], status: 'wishlist',
        note: 'Built against the cliff under the Ebenalp. Walk in, do not take the cable car down at the last minute.' }, 15),
    P({ name: 'Schweizerischer Nationalpark', lat: 46.65800, lng: 10.17500, city: 'Zernez', country: 'Switzerland', countryCode: 'ch',
        tags: [t.reserve.id, t.nature.id], status: 'wishlist',
        note: 'The strictest reserve in the Alps: stay on the marked paths, no fires, no dogs, nothing picked or taken. Ibex and bearded vulture. Val Trupchun in the rut, late September.' }, 12),
    P({ name: 'Camargue', lat: 43.50000, lng: 4.45000, city: 'Arles', country: 'France', countryCode: 'fr',
        tags: [t.reserve.id, t.nature.id], status: 'wishlist',
        note: 'Salt, horses, flamingoes. The reserve proper is the Étang de Vaccarès; keep to the dykes and go at first light.' }, 26),
  );

  // a sample way: up to a col and back down, so the ground can be read at once
  const path = [];
  for (let i = 0; i <= 240; i++) {
    const u = i / 240;
    const ele = u < 0.52
      ? 1690 + (2790 - 1690) * Math.pow(u / 0.52, 1.2)
      : 2790 - (2790 - 1780) * Math.pow((u - 0.52) / 0.48, 0.95);
    path.push({
      lat: 46.0894 + u * 0.0380 + Math.sin(u * 19) * 0.0016,
      lng: 7.5566 + u * 0.0455 + Math.cos(u * 14) * 0.0019,
      ele,
    });
  }
  const routes = [newRoute({
    name: 'Col de Sorebois to the Moiry hut',
    path,
    city: 'Val d’Anniviers', country: 'Switzerland',
    tags: [t.hut.id, t.nature.id],
    status: 'wishlist',
    createdAt: ago(9), updatedAt: ago(9),
    note: 'The high traverse under the Dent Blanche. Snow lies on the col into July; ask the warden before you commit.',
  })];

  return { tags: Object.values(t), places, routes };
}
