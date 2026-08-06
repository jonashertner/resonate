// store.js — persistence, models, demo data

const K_PLACES = 'resonate.places.v1';
const K_TAGS = 'resonate.tags.v1';
const K_SETTINGS = 'resonate.settings.v1';
const K_CORR = 'resonate.correspondents.v1';

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

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('Storage write failed', e);
    return false;
  }
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

export const store = {
  places: [],
  tags: [],
  correspondents: [],
  settings: { theme: 'auto', lastView: null, seeded: false, authorName: '' },

  load() {
    this.places = read(K_PLACES, []);
    this.tags = read(K_TAGS, []);
    this.correspondents = read(K_CORR, []);
    this.settings = { theme: 'auto', lastView: null, seeded: false, authorName: '', ...read(K_SETTINGS, {}) };
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
    this.saveCorrespondents();
    return c;
  },

  updateCorrespondent(id, patch) {
    const c = this.correspondents.find(x => x.id === id);
    if (!c) return null;
    Object.assign(c, patch);
    this.saveCorrespondents();
    return c;
  },

  removeCorrespondent(id) {
    this.correspondents = this.correspondents.filter(c => c.id !== id);
    this.saveCorrespondents();
  },

  tagById(id) { return this.tags.find(t => t.id === id); },
  placeById(id) { return this.places.find(p => p.id === id); },

  addPlace(place) {
    this.places.unshift(place);
    this.savePlaces();
    return place;
  },

  updatePlace(id, patch) {
    const p = this.placeById(id);
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: new Date().toISOString() });
    this.savePlaces();
    return p;
  },

  removePlace(id) {
    this.places = this.places.filter(p => p.id !== id);
    this.savePlaces();
  },

  addTag(tag) {
    this.tags.push(tag);
    this.saveTags();
    return tag;
  },

  updateTag(id, patch) {
    const t = this.tagById(id);
    if (!t) return null;
    Object.assign(t, patch);
    this.saveTags();
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

  clearAll() {
    this.places = [];
    this.tags = [];
    this.savePlaces();
    this.saveTags();
  },

  // merge imported data, deduping by id; imported fields that reach markup are normalized
  merge(data) {
    const okColor = c => /^#[0-9a-fA-F]{3,8}$/.test(String(c ?? '')) ? c : TAG_COLORS[0];
    const okPhotos = ph => Array.isArray(ph) ? ph.filter(s => typeof s === 'string' && s.startsWith('data:image/')) : [];
    const tagIds = new Set(this.tags.map(t => t.id));
    const placeIds = new Set(this.places.map(p => p.id));
    let added = 0;
    (data.tags || []).forEach(t => {
      if (t && t.id && !tagIds.has(t.id)) {
        this.tags.push(newTag({ ...t, color: okColor(t.color) }));
        tagIds.add(t.id);
      }
    });
    (data.places || []).forEach(p => {
      if (p && p.id && !placeIds.has(p.id) && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
        this.places.push(newPlace({ ...p, photos: okPhotos(p.photos) }));
        placeIds.add(p.id);
        added++;
      }
    });
    this.savePlaces();
    this.saveTags();
    return added;
  },

  exportJSON() {
    return JSON.stringify({
      app: 'resonate',
      version: 1,
      exportedAt: new Date().toISOString(),
      tags: this.tags,
      places: this.places,
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

// ---------- demo dataset ----------

export function demoData() {
  const t = {
    food: newTag({ name: 'Restaurants', emoji: '🍽️', color: '#D64B33' }),
    cafe: newTag({ name: 'Cafés', emoji: '☕', color: '#8A5A3B' }),
    bar: newTag({ name: 'Bars', emoji: '🍸', color: '#7B5AA6' }),
    culture: newTag({ name: 'Culture', emoji: '🖼️', color: '#3E6E91' }),
    nature: newTag({ name: 'Nature', emoji: '⛰️', color: '#2F6B5E' }),
    shop: newTag({ name: 'Shops', emoji: '🧺', color: '#B85C79' }),
  };
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

  return { tags: Object.values(t), places };
}
