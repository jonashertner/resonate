// store.js — persistence, models, demo data

import { normImport, normPlace, normRoute, normRoutes, normFolioRefs, SCHEMA_VERSION } from './schema.js?v=rf33';
import { measure, simplify } from './route.js?v=rf33';

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

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// a refused write must be heard: the app sets onWriteFailed to say so out loud
export let onWriteFailed = null;
export function setWriteFailedHandler(fn) { onWriteFailed = fn; }

function write(key, value) {
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
    rating: 0,
    note: '',
    url: '',
    photos: [],
    createdAt: now,
    updatedAt: now,
    ...partial,
    // a caller passing id: undefined must still get a real, unique id
    ...(partial.id ? {} : { id: uid() }),
  };
}

export function newRoute(partial = {}) {
  const now = new Date().toISOString();
  const path = simplify(Array.isArray(partial.path) ? partial.path : [], 0.012);
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
    createdAt: now,
    updatedAt: now,
    walkedAt: '',
    ...partial,
    path,
    ...(partial.id ? {} : { id: uid() }),
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

const DEFAULT_SETTINGS = { theme: 'auto', lastView: null, seeded: false, authorName: '' };

export const store = {
  places: [],
  routes: [],
  folios: [],
  tags: [],
  correspondents: [],
  settings: { ...DEFAULT_SETTINGS },

  load() {
    this.places = read(K_PLACES, []).map(p => normPlace(p)).filter(Boolean);
    this.routes = normRoutes(read(K_ROUTES, []));
    this.folios = normFolioRefs(read(K_FOLIOS, []));
    this.tags = read(K_TAGS, []);
    this.correspondents = read(K_CORR, []);
    this.settings = { ...DEFAULT_SETTINGS, ...read(K_SETTINGS, {}) };
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
    // an erased atlas is not a new one: a specimen must never grow back over it
    this.settings = { ...DEFAULT_SETTINGS, seeded: true, erasedAt: new Date().toISOString() };
    this.saveSettings();
  },

  // merge imported data, deduping by id; imported fields that reach markup are normalized
  merge(raw) {
    const data = normImport(raw);
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
    data.tags.forEach(t => {
      if (!tagIds.has(t.id)) {
        this.tags.push(newTag(t));
        tagIds.add(t.id);
      }
    });
    data.places.forEach(p => {
      if (!placeIds.has(p.id)) {
        this.places.push(newPlace(p));
        placeIds.add(p.id);
        added++;
      }
    });
    const routeIds = new Set(this.routes.map(r => r.id));
    data.routes.forEach(r => {
      if (!routeIds.has(r.id)) {
        this.routes.push(newRoute(r));
        routeIds.add(r.id);
        added++;
      }
    });
    const folioIds = new Set(this.folios.map(f => f.id));
    data.folios.forEach(f => {
      if (!folioIds.has(f.id)) {
        this.folios.push(newFolio(f));
        folioIds.add(f.id);
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
      }
    });
    if (!this.settings.authorName && data.settings.authorName) {
      this.settings.authorName = data.settings.authorName;
    }
    if (data.settings.theme) this.settings.theme = data.settings.theme;
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
      return 0;
    }
    this.saveSettings();
    return added;
  },

  // what may be handed to someone else: the atlas without the private layer.
  // the share surface promises photographs never leave the device, and a file
  // offered in place of a link has to keep that promise.
  exportShareJSON() {
    return JSON.stringify({
      app: 'resonate',
      kind: 'share',
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      tags: this.tags,
      places: this.places.map(({ photos, ...rest }) => rest),
      routes: this.routes,
    }, null, 2);
  },

  // everything, for yourself: photographs, voices and settings included
  exportJSON() {
    return JSON.stringify({
      app: 'resonate',
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      tags: this.tags,
      places: this.places,
      routes: this.routes,
      folios: this.folios,
      correspondents: this.correspondents,
      settings: this.settings,
    }, null, 2);
  },

  exportGeoJSON() {
    return JSON.stringify({
      type: 'FeatureCollection',
      features: this.places.map(p => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: {
          name: p.name,
          address: p.address,
          city: p.city,
          country: p.country,
          tags: p.tags.map(id => this.tagById(id)?.name).filter(Boolean),
          status: p.status,
          rating: p.rating,
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
        address: 'Baselstrasse 101, 4125 Riehen', tags: [t.culture.id], status: 'visited', rating: 5,
        note: 'Monet water lilies in front of the pond window. Go on a weekday morning and have the Rothko room to yourself.' }, 4),
    P({ name: 'Kunstmuseum Basel', lat: 47.55437, lng: 7.59417, city: 'Basel', country: 'Switzerland', countryCode: 'ch',
        address: 'St. Alban-Graben 16, 4051 Basel', tags: [t.culture.id], status: 'visited', rating: 4,
        note: 'The Holbein rooms. Quiet on Friday evenings.' }, 21),
    P({ name: 'Rheinbad Breite', lat: 47.55330, lng: 7.60530, city: 'Basel', country: 'Switzerland', countryCode: 'ch',
        address: 'St. Alban-Rheinweg 195, 4052 Basel', tags: [t.nature.id], status: 'visited', rating: 5,
        note: 'Drop in here, float past the Münster, out at Dreirosen. The whole city swims home in summer.' }, 9),
    P({ name: 'Markthalle Basel', lat: 47.54790, lng: 7.58750, city: 'Basel', country: 'Switzerland', countryCode: 'ch',
        address: 'Steinentorberg 20, 4051 Basel', tags: [t.food.id], status: 'visited', rating: 4,
        note: 'Lunch under the dome. The momo stand first, always.' }, 60),
    P({ name: 'Shakespeare and Company', lat: 48.85258, lng: 2.34710, city: 'Paris', country: 'France', countryCode: 'fr',
        address: '37 Rue de la Bûcherie, 75005 Paris', tags: [t.shop.id, t.culture.id], status: 'visited', rating: 5,
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
        address: 'Central Park, New York, NY', tags: [t.nature.id], status: 'visited', rating: 4,
        note: 'The tiled arcade underneath, when a cellist is playing.' }, 400),
    P({ name: 'Café Sabarsky', lat: 40.78110, lng: -73.96010, city: 'New York', country: 'United States', countryCode: 'us',
        address: '1048 5th Ave, New York, NY', tags: [t.cafe.id], status: 'visited', rating: 4,
        note: 'Viennese breakfast before the Klimts upstairs.' }, 400),
    P({ name: 'Vernazza', lat: 44.13500, lng: 9.68400, city: 'Vernazza', country: 'Italy', countryCode: 'it',
        address: 'Cinque Terre, Liguria', tags: [t.nature.id], status: 'visited', rating: 5,
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
        tags: [t.hut.id, t.food.id], status: 'wishlist', rating: 0,
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
