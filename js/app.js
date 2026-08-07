// app.js — THE RESONANT FIELD
// The map is the interface. Four corner marks, one command line,
// summoned posters. One field, one ink — and one counter-ink for
// the voices of other people.

import { store, newPlace, newTag, newRoute, newFolio, demoData, baseTags, TAG_STATIONS, setWriteFailedHandler } from './store.js?v=rf56';
import { parseGPX, simplify, measure, profile, encodePath, fmtKm, fmtHours, effort } from './route.js?v=rf56';
import { searchGeo, reverseGeo, fmtDMS, haversineKm, fmtDistance } from './geocode.js?v=rf56';
import * as mapView from './map.js?v=rf56';
import { makeShareUrl, makeFolioUrl, makeAskUrl, parseShareHash, clearShareHash } from './share.js?v=rf56';
import { normPayload, normIndex, SCHEMA_VERSION } from './schema.js?v=rf56';
import { resonance, verdict, evidenceLines, grounds } from './kinship.js?v=rf56';
import { exifGPS } from './exif.js?v=rf56';
import { seal, unseal, makeClient, burnPatch, syncGuard, CLUB_URL, JOIN_URL } from './club.js?v=rf56';
import * as photoStore from './photos.js?v=rf56';
import { readShared, coordsIn, alreadyHeld } from './capture.js?v=rf56';

// ---------- helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function safeUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch { return false; }
}

let toastTimer;
let lastToastAt = 0;
function toast(msg, ms = 2800, act = null) {
  lastToastAt = Date.now();
  const el = $('#toast');
  el.textContent = msg;
  if (act) {
    const b = document.createElement('button');
    b.className = 'toast-act';
    b.textContent = act.word;
    b.addEventListener('click', () => { el.hidden = true; act.run(); });
    el.append(' ', b);
    ms = Math.max(ms, 9000);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return ''; }
}

// An atlas holds the places that matter to you, so keeping one is already
// the recommendation. Nothing here asks for a verdict beside it: only whether
// you have been, and the note.

// what a place says of itself in one line, wherever it is listed
function datumWord(p) {
  return p.status === 'wishlist' ? 'want to go' : 'been';
}
function fmtNo(n) { return String(n).padStart(2, '0'); }

// ---------- state ----------

const state = {
  filters: { tags: new Set(), status: 'all' },
  sort: 'recent',
  selectedId: null,
  selectedRouteId: null,
  foreign: null, // { corrId?, name, sig, place } a place from someone else's atlas
  visiting: null, // temp correspondent-shaped object when "just looking" at a share
  pendingAdd: null, // {lat, lng, name?, photo?} awaiting confirm
};

function allPlaces() { return store.places; }
// the pool anything may be handed from: a place that never leaves is not in it
function sharablePlaces() { return store.places.filter(p => !p.private); }
function allTags() { return store.tags; }
function tagById(id) { return allTags().find(t => t.id === id); }
function placeById(id) { return allPlaces().find(p => p.id === id); }

function accessionMap() {
  const sorted = [...allPlaces()].sort((a, b) =>
    (a.createdAt || '').localeCompare(b.createdAt || '') || String(a.id).localeCompare(String(b.id)));
  const m = new Map();
  sorted.forEach((p, i) => m.set(p.id, i + 1));
  return m;
}

function filteredPlaces() {
  let list = allPlaces().filter(p => {
    if (state.filters.status !== 'all' && p.status !== state.filters.status) return false;
    if (state.filters.tags.size && !p.tags.some(t => state.filters.tags.has(t))) return false;
    return true;
  });
  const center = mapView.getCenter();
  const nos = accessionMap();
  switch (state.sort) {
    case 'name': list.sort((a, b) => a.name.localeCompare(b.name)); break;
    case 'distance': list.sort((a, b) => haversineKm(center, a) - haversineKm(center, b)); break;
    case 'city':
      // an atlas is read by where things are: cities in order, and the
      // placeless gathered at the end rather than scattered through it
      list.sort((a, b) => {
        const ac = (a.city || a.country || '').trim();
        const bc = (b.city || b.country || '').trim();
        if (!ac !== !bc) return ac ? -1 : 1;
        return ac.localeCompare(bc) || a.name.localeCompare(b.name);
      });
      break;
    default: list.sort((a, b) => nos.get(b.id) - nos.get(a.id));
  }
  return list;
}

// ---------- photographs: ids here, blobs in their own store ----------

// A place's photos are ids; a file that leaves carries the pictures
// themselves. A picture this device cannot read back is COUNTED, never
// dropped in silence: a backup missing photographs must say so before it is
// trusted, and must never be sealed over one that still has them.
let lastInlineMisses = 0;
async function inlinePhotos(places) {
  lastInlineMisses = 0;
  const out = [];
  for (const p of places) {
    if (!p.photos?.some(photoStore.isId)) { out.push(p); continue; }
    const photos = [];
    for (const entry of p.photos) {
      if (!photoStore.isId(entry)) { photos.push(entry); continue; }
      const blob = await photoStore.get(entry);
      const uri = blob ? await photoStore.dataURLFromBlob(blob) : null;
      if (uri) photos.push(uri); else lastInlineMisses += 1;
    }
    out.push({ ...p, photos });
  }
  return out;
}

// { json, misses }: the caller decides what an incomplete copy is worth
async function fullExport() {
  const json = await store.exportJSON(inlinePhotos);
  return { json, misses: lastInlineMisses };
}

// The way back in: an arriving atlas carries its pictures inline, and they
// belong in the store, not in the records. Anything the store refuses stays
// inline, exactly as it would have before any of this.
async function absorbPhotos(atlas) {
  if (!atlas?.places?.length || !photoStore.available()) return atlas;
  const places = [];
  for (const p of atlas.places) {
    const inline = (p.photos || []).filter(x => typeof x === 'string' && x.startsWith('data:'));
    if (!inline.length) { places.push(p); continue; }
    const photos = [];
    for (const entry of p.photos) {
      if (!(typeof entry === 'string' && entry.startsWith('data:'))) { photos.push(entry); continue; }
      const blob = photoStore.blobFromDataURL(entry);
      const id = blob ? await photoStore.put(blob) : null;
      photos.push(id || entry);
    }
    places.push({ ...p, photos });
  }
  return { ...atlas, places };
}

// the pictures move out of the records once, and survive interruption: an id
// replaces a data url only after the blob is safely kept, and any inline
// entry still renders, forever.
async function migratePhotos() {
  if (!photoStore.available()) return 0;
  let moved = 0;
  for (const place of store.places) {
    const inline = (place.photos || []).filter(x => typeof x === 'string' && x.startsWith('data:'));
    if (!inline.length) continue;
    const next = [...place.photos];
    for (let i = 0; i < next.length; i++) {
      if (!(typeof next[i] === 'string' && next[i].startsWith('data:'))) continue;
      const blob = photoStore.blobFromDataURL(next[i]);
      if (!blob) continue;
      const id = await photoStore.put(blob);
      if (!id) return moved; // this browser will not keep blobs; leave them inline
      next[i] = id;
      if (!store.updatePlace(place.id, { photos: next })) { await photoStore.del(id); return moved; }
      moved += 1;
    }
  }
  if (moved) renderAll();
  return moved;
}

// an img drawn with a photo id gets its picture when the store answers
function paintPhotos(root) {
  $$('img[data-ph]', root).forEach(async (img) => {
    const url = await photoStore.urlFor(img.dataset.ph);
    if (url) img.src = url; else img.closest('.fig')?.remove();
  });
}

// the map a person actually uses: their platform's own, then the web's
function directionsURL(lat, lng, name = '') {
  const ua = navigator.userAgent;
  const q = encodeURIComponent(name || `${lat},${lng}`);
  if (/iPhone|iPad|iPod|Macintosh/.test(ua)) return `https://maps.apple.com/?daddr=${lat},${lng}&q=${q}`;
  if (/Android/.test(ua)) return `geo:${lat},${lng}?q=${lat},${lng}(${q})`;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

// ---------- a place arrives from elsewhere ----------
//
// A share sheet, a pasted link, a set of coordinates. One surface answers all
// of them: what we understood, one choice, one press. Nothing is demanded
// that the source did not already carry.

const INBOX_KEY = 'resonate.inbox.v1';

function inboxRead() {
  try { return JSON.parse(localStorage.getItem(INBOX_KEY) || '[]'); } catch { return []; }
}
function inboxWrite(list) {
  try { localStorage.setItem(INBOX_KEY, JSON.stringify(list.slice(-20))); } catch { /* full is full */ }
}

async function receiveShared(raw) {
  const found = readShared(raw);
  if (!found) return toast('nothing in that to keep');

  const held = alreadyHeld(found, allPlaces());
  if (held) {
    selectPlace(held.id, { fly: true });
    return toast('you hold this already');
  }

  // coordinates in hand: propose it on the field, as any found place
  if (found.at) {
    const named = found.name || 'this point';
    proposePlace({ name: named, lat: found.at.lat, lng: found.at.lng,
      sub: found.address || found.source, address: found.address || '', url: found.url || '' });
    if (!found.name || !found.address) {
      // the world can fill in what the link did not carry, once
      reverseGeo(found.at.lat, found.at.lng).then(g => {
        if (!g || !state.proposal) return;
        state.proposal = { ...state.proposal, city: g.city, country: g.country,
          countryCode: g.countryCode, address: state.proposal.address || g.address };
        $('.plate-sub') && ($('.plate-sub').textContent = [g.city, g.country].filter(Boolean).join(' · '));
      }).catch(() => { /* offline is fine; the point stands */ });
    }
    return;
  }

  // a name and no point: ask the world where it is, once, on this press
  if (!navigator.onLine) {
    inboxWrite([...inboxRead(), { ...found, at: null, arrivedAt: new Date().toISOString() }]);
    return toast('kept for later. it will be placed when there is a network');
  }
  toast('looking for it…');
  try {
    const results = await searchGeo(found.name, 1);
    if (results?.length) return proposePlace({ ...results[0], url: found.url || '' });
  } catch { /* the world did not answer */ }
  toast(`nothing found for “${found.name}”. try the command line`);
}

// what waited for a network, offered when there is one
async function drainInbox() {
  const waiting = inboxRead();
  if (!waiting.length || !navigator.onLine) return;
  toast(`${waiting.length} share${waiting.length === 1 ? '' : 's'} waiting to be placed`, 5000, {
    word: 'place them',
    run: async () => {
      inboxWrite([]);
      for (const item of waiting) { await receiveShared(item); break; } // one at a time, gently
      const rest = waiting.slice(1);
      if (rest.length) inboxWrite(rest);
    },
  });
}

// ---------- the world: hue engine ----------

const rootStyle = document.documentElement.style;

// One rule holds the whole palette together: on the field, colour means a
// mark and the domain it belongs to. Nothing else moves. The interface wears
// a single tone, the one you chose, and it stays where you put it — a chrome
// that changed with every selection was colour saying nothing at all.
const FIELD_TONES = [
  { name: 'plum', hue: 300 },
  { name: 'iris', hue: 265 },
  { name: 'sea', hue: 228 },
  { name: 'moss', hue: 152 },
  { name: 'olive', hue: 116 },
  { name: 'amber', hue: 74 },
  { name: 'clay', hue: 40 },
  { name: 'rose', hue: 12 },
];

function fieldTone() {
  const h = Number(store.settings.hue);
  return FIELD_TONES.find(t => t.hue === h) || FIELD_TONES[0];
}

function applyWorldState() {
  rootStyle.setProperty('--hue', fieldTone().hue);
}

// pressing the tone word walks the wheel, and the word is the only label
function turnField() {
  const i = FIELD_TONES.indexOf(fieldTone());
  const next = FIELD_TONES[(i + 1) % FIELD_TONES.length];
  store.settings.hue = next.hue;
  store.saveSettings();
  applyWorldState();
  renderFieldWord();
}

function renderFieldWord() {
  const b = $('#fieldWord');
  if (b) b.textContent = fieldTone().name;
}

// ---------- theme ----------

const media = window.matchMedia('(prefers-color-scheme: dark)');

function resolvedTheme() {
  const t = store.settings.theme;
  return t === 'auto' ? (media.matches ? 'dark' : 'light') : t;
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
  mapView.setBasemap(resolvedTheme());
  const w = $('#themeWord');
  if (w) {
    const mode = store.settings.theme;
    w.textContent = mode === 'auto' ? `auto · ${resolvedTheme() === 'dark' ? 'night' : 'day'}` : mode === 'dark' ? 'night' : 'day';
    w.setAttribute('aria-label', `Light and dark: ${w.textContent}. Press to change.`);
    w.title = 'day, night, or follow this device';
  }
}

function setTheme(mode) {
  store.settings.theme = mode;
  store.saveSettings();
  applyTheme();
}

media.addEventListener('change', () => { if (store.settings.theme === 'auto') applyTheme(); });

// ---------- surfaces ----------

const surfaces = [];
const surfaceEl = id => $(`#${id}`);

// a surface is a dialog: it announces itself, takes the focus, keeps it while
// it stands, and hands it back to whatever summoned it
const returnFocus = new Map();

// a one-shot hook for a surface that must hand the floor back when it closes
let onHowClosed = null;

// the name waits in the middle of the field only until the field is used.
// summoning anything at all counts as using it.
let leaveHero = () => {};
function setHeroExit(fn) { leaveHero = fn; }

// the first-run door, reachable from anywhere that needs to offer it again
let openThreshold = () => {};
function setThresholdOpener(fn) { openThreshold = fn; }

// reading the opening again: the same words, without the first-run choices,
// since the choosing is long done
function showOpening() {
  const th = $('#threshold');
  th.classList.toggle('revisited', store.places.length > 0 || !!store.settings.chosen);
  openThreshold();
}

// the plate stands beside a living map and must never deaden it: you go on
// tapping marks while it is open. only a surface that covers the field
// takes the field out of reach.
const NON_MODAL = new Set(['plate']);

function modalUp() {
  if (!$('#reportOverlay').hidden) return true;
  if (!$('#threshold')?.hidden) return true;
  if (!$('#nameAsk').hidden) return true;
  return surfaces.some(id => !NON_MODAL.has(id));
}

// while anything covers the field, it is not reachable by tab, by screen
// reader, or by pointer
function setBackgroundInert(on) {
  // the plate is a sibling of the field, not a child: a modal has to reach
  // both, or a column left standing behind it stays clickable
  [$('#app'), $('#plate')].forEach(el => {
    if (!el) return;
    if (on) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); }
    else { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); }
  });
}

// a dialog that does not live on the surface stack still behaves like one
function raiseDialog(el, label) {
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  if (label) el.setAttribute('aria-label', label);
  el.hidden = false;
  setBackgroundInert(true);
  el.setAttribute('tabindex', '-1');
  el.focus?.();
}

function dropDialog(el) {
  el.hidden = true;
  el.removeAttribute('aria-modal');
  if (!modalUp()) setBackgroundInert(false);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

function focusables(el) {
  return [...el.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null || n === document.activeElement);
}

// whichever dialog is in front holds the focus: the surface stack, or a
// report or prompt raised beside it
function frontDialog() {
  for (const id of ['nameAsk', 'threshold', 'reportOverlay']) {
    const el = document.getElementById(id);
    if (el && !el.hidden) return el;
  }
  for (let i = surfaces.length - 1; i >= 0; i--) {
    if (!NON_MODAL.has(surfaces[i])) return surfaceEl(surfaces[i]);
  }
  return null;
}

function trapFocus(e) {
  if (e.key !== 'Tab') return;
  const el = frontDialog();
  if (!el) return;
  const items = focusables(el);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
}
document.addEventListener('keydown', trapFocus, true);

function openSurface(id, onShow) {
  leaveHero();
  if ((id === 'indexOverlay' && topSurface() === 'plate') ||
      (id === 'plate' && topSurface() === 'indexOverlay')) popSurface();
  if (surfaces.includes(id)) return;
  returnFocus.set(id, document.activeElement);
  surfaces.push(id);
  const el = surfaceEl(id);
  el.hidden = false;
  const modal = !NON_MODAL.has(id);
  el.setAttribute('role', modal ? 'dialog' : 'complementary');
  if (modal) el.setAttribute('aria-modal', 'true'); else el.removeAttribute('aria-modal');
  if (modal) setBackgroundInert(true);
  el.classList.add('opening');
  setTimeout(() => el.classList.remove('opening'), 700);
  onShow?.();
  if (modal && id !== 'paletteOverlay') {
    el.setAttribute('tabindex', '-1');
    el.focus?.();
  }
}

function restoreFocus(id) {
  const back = returnFocus.get(id);
  returnFocus.delete(id);
  if (!modalUp()) setBackgroundInert(false);
  // the plate never stole the focus, so it never hands it back
  if (NON_MODAL.has(id)) return;
  if (back && document.contains(back)) back.focus();
}

function popSurface() {
  const id = surfaces.pop();
  if (!id) return false;
  surfaceEl(id).hidden = true;
  if (id === 'howOverlay') onHowClosed?.();
  if (id === 'plate') { state.selectedId = null; state.foreign = null; state.proposal = null; mapView.clearPreview(); syncMarkers(); applyWorldState(); }
  if (id === 'paletteOverlay') palette.remoteAbort?.abort();
  restoreFocus(id);
  return true;
}

function closeSurface(id) {
  const i = surfaces.indexOf(id);
  if (i === -1) return;
  surfaces.splice(i, 1);
  surfaceEl(id).hidden = true;
  if (id === 'howOverlay') onHowClosed?.();
  if (id === 'plate') { state.selectedId = null; state.foreign = null; state.proposal = null; mapView.clearPreview(); syncMarkers(); applyWorldState(); }
  restoreFocus(id);
}

function topSurface() { return surfaces[surfaces.length - 1]; }

// ---------- rendering: count, index ----------

function renderCount() {
  const n = allPlaces().length;
  const w = allRoutes().length;
  $('#placeCount').textContent = n || '';
  $('#ixN').textContent = n;
  const ways = $('#ixWays');
  if (ways) { ways.textContent = w ? `${w} way${w === 1 ? '' : 's'}` : ''; ways.hidden = !w; }
  const who = store.settings.authorName;
  const small = $('.index-count small');
  if (small) small.textContent = who ? `places · ${who}` : 'places';
}

function renderChips() {
  const wrap = $('#filterChips');
  wrap.innerHTML = allTags().map(t => {
    const n = allPlaces().reduce((k, p) => k + (p.tags.includes(t.id) ? 1 : 0), 0);
    const on = state.filters.tags.has(t.id);
    const h = Number(t.hue);
    return `<button data-tag="${esc(t.id)}" aria-pressed="${on}"${Number.isFinite(h) ? ` style="--mk-hue:${h}"` : ''}>${esc(t.name)}<sup>${n}</sup></button>`;
  }).join('') + `<button class="edit-tags" id="editTags">edit</button>`;
  $('#editTags').addEventListener('click', () => {
    closeSurface('indexOverlay');
    openSurface('tagsOverlay', renderTags);
  });
  $$('[data-tag]', wrap).forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.tag;
    state.filters.tags.has(id) ? state.filters.tags.delete(id) : state.filters.tags.add(id);
    renderChips(); renderList(); syncMarkers(); applyWorldState();
  }));
}

function renderList() {
  const wrap = $('#listView');
  const places = filteredPlaces();
  // an arrangement answered only by ways is not nothing
  if (!places.length && !filteredRoutes().length) {
    wrap.innerHTML = allPlaces().length === 0
      ? `<div class="ix-empty">Every place that ever <b>resonated</b>, held in one field.
          <p>Press <b>/</b> and name a place. Drop a photo, or a <b>gpx</b> from any
          walking app, on the field. Or open a
          <button class="word-btn" id="emptyDemo" style="font-size:inherit;letter-spacing:0;text-transform:none">sample atlas</button>.</p>
        </div>`
      : `<div class="ix-empty">nothing answers this arrangement.
          <p><button class="word-btn quiet" id="emptyClear">clear the filters</button></p>
        </div>`;
    $('#emptyDemo')?.addEventListener('click', () => { seedDemo(); });
    $('#emptyClear')?.addEventListener('click', clearFilters);
    return;
  }
  const nos = accessionMap();
  const center = mapView.getCenter();
  wrap.innerHTML = places.map((p, i) => {
    const tag = tagById(p.tags[0]);
    const locale = [p.city, p.country].filter(Boolean).join(' · ');
    const datum = fmtDistance(haversineKm(center, p));
    const prov = p.provenance ? `<span class="prov">after <b>${esc(p.provenance.name)}</b></span>` : '';
    return `<button class="ix ${p.status === 'wishlist' ? 'wish' : ''} ${p.id === state.selectedId ? 'selected' : ''}"
      data-id="${esc(p.id)}" style="--i:${i}">
      <span class="ix-l1">
        <span class="ix-no">${fmtNo(nos.get(p.id))}</span>
        <span class="ix-name">${esc(p.name)}</span>${p.sample ? '<span class="ix-sample">sample</span>' : ''}
        <span class="ix-datum">${datum}</span>
      </span>
      <span class="ix-meta">
        ${locale ? `<span>${esc(locale)}</span>` : ''}
        ${tag ? `<span>${esc(tag.name)}</span>` : ''}
        ${p.status === 'wishlist' ? '<span>want to go</span>' : ''}
        ${prov}
      </span>
    </button>`;
  }).join('');

  // ways stand after the marks: same list, plainly told apart
  const ways = filteredRoutes();
  if (ways.length) {
    wrap.insertAdjacentHTML('beforeend', `<div class="ix-band mono">ways · ${ways.length}</div>` + ways.map((r, i) => {
      const tag = tagById(r.tags[0]);
      const locale = [r.city, r.country].filter(Boolean).join(' · ');
      return `<button class="ix way ${r.status === 'wishlist' ? 'wish' : ''} ${r.id === state.selectedRouteId ? 'selected' : ''}"
        data-rid="${esc(r.id)}" style="--i:${i}">
        <span class="ix-l1">
          <span class="ix-no">${r.loop ? '◯' : '⟋'}</span>
          <span class="ix-name">${esc(r.name)}</span>${r.sample ? '<span class="ix-sample">sample</span>' : ''}
          <span class="ix-datum">${esc(fmtKm(r.km))}</span>
        </span>
        <span class="ix-meta">
          ${locale ? `<span>${esc(locale)}</span>` : ''}
          ${Number.isFinite(r.ascent) ? `<span>${r.ascent} m up</span>` : ''}
          <span>${esc(fmtHours(r.hours))}</span>
          ${tag ? `<span>${esc(tag.name)}</span>` : ''}
          ${r.status === 'wishlist' ? '<span>want to walk</span>' : ''}
        </span>
      </button>`;
    }).join(''));
  }

  $$('.ix', wrap).forEach(b => b.addEventListener('click', () => {
    closeSurface('indexOverlay');
    if (b.dataset.rid) selectRoute(b.dataset.rid, { fly: true });
    else selectPlace(b.dataset.id, { fly: true });
  }));
}

function syncMarkers() {
  mapView.renderMarkers(filteredPlaces(), tagById, state.selectedId);
  mapView.renderRoutes(filteredRoutes(), tagById, state.selectedRouteId);
}

// ways obey the same filters the marks do
function allRoutes() { return store.routes; }
function routeById(id) { return allRoutes().find(r => r.id === id); }

function filteredRoutes() {
  return allRoutes().filter(r => {
    if (state.filters.status === 'visited' && r.status !== 'walked') return false;
    if (state.filters.status === 'wishlist' && r.status !== 'wishlist') return false;
    if (state.filters.tags.size && !r.tags.some(t => state.filters.tags.has(t))) return false;
    return true;
  });
}

function renderAll() {
  renderCount();
  renderChips();
  renderList();
  syncMarkers();
}

function openIndex() {
  renderList();
  openSurface('indexOverlay');
  if (!store.settings.indexSeen) {
    store.settings.indexSeen = true;
    store.saveSettings();
    $('#fmHint').hidden = true;
  }
}

function clearFilters() {
  state.filters.tags.clear();
  state.filters.status = 'all';
  $$('#statusSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.status === 'all')));
  renderChips(); renderList(); syncMarkers(); applyWorldState();
}

// ---------- selection & the plate ----------

function selectPlace(id, { fly = false, edit = false, quiet = false } = {}) {
  const prev = state.selectedId;
  state.selectedId = id;
  state.foreign = null;
  const place = placeById(id);
  if (!place) return;
  if (prev && placeById(prev)) mapView.refreshMarkerIcon(placeById(prev), tagById, false);
  mapView.refreshMarkerIcon(place, tagById, true);
  // quiet: mark it on the field, but raise no plate behind whatever stands in front
  if (quiet) return;
  applyWorldState();
  mapView.rippleWhenSettled(place.lat, place.lng);
  if (fly) mapView.flyToPlace(place);
  renderPlate(place, { edit });
  openSurface('plate');
}

function renderPlate(place, { edit = false, foreign = null } = {}) {
  const wrap = $('#plate');
  // re-rendering the same card must not throw the reader back to the top
  const keepScroll = wrap.dataset.pid === place.id ? wrap.scrollTop : 0;
  wrap.dataset.pid = place.id;
  const ro = !!foreign;
  const no = ro ? null : accessionMap().get(place.id);
  const tagWords = allTags().map(t => `
    <button data-dtag="${esc(t.id)}" aria-pressed="${place.tags.includes(t.id)}" ${ro ? 'disabled' : ''}>${esc(t.name)}</button>`).join('');
  const photos = (place.photos || []).map((src, i) => `
    <figure class="fig"><img ${photoStore.isId(src) ? `data-ph="${esc(src)}"` : `src="${esc(src)}"`} alt="Photograph ${i + 1} of ${esc(place.name)}">
      ${ro ? '' : `<button class="ph-x" data-phx="${i}">remove</button>`}</figure>`).join('');
  const canDictate = !ro && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window);

  wrap.innerHTML = `
    <div class="plate-eyebrow">
      <span>${ro ? `from ${esc(foreign.name)}’s atlas` : `№ ${fmtNo(no)}`}</span>
      <button id="pCoords" title="Copy coordinates">${fmtDMS(place.lat, place.lng)}</button>
      <button id="pClose">close</button>
    </div>
    <h1 class="plate-name" id="pName" ${ro ? '' : 'contenteditable="plaintext-only" spellcheck="false" role="textbox" aria-label="The name of this place"'}>${esc(place.name)}</h1>${place.sample && !ro ? '<span class="p-sample">sample</span>' : ''}
    <div class="plate-sub">${esc([place.address, place.city, place.country].filter(Boolean).slice(0, 2).join(' · '))}</div>
    ${place.provenance ? `<div class="plate-prov prov">after <b>${esc(place.provenance.name)}</b>${place.provenance.chain?.length ? `, who had it from ${place.provenance.chain.map(h => esc(h.name)).reverse().join(', who had it from ')}` : ''} · adopted ${fmtDate(place.provenance.adoptedAt)}</div>` : ''}

    ${ro ? `
      <div class="plate-words"><button aria-pressed="true" disabled>${esc(datumWord(place))}</button></div>
      ${place.note ? `<div class="plate-sec"><div class="plate-sec-head"><span>their note</span></div><p class="note-input" style="border-left-color:var(--counter)">${esc(place.note)}</p></div>` : ''}
      <div class="plate-acts">
        <button class="word-btn" id="pAdopt">adopt, after ${esc(foreign.name)}</button>
        <button class="word-btn quiet" id="pDirections">directions ↗</button>
      </div>`
    : `
      <div class="plate-words" id="pStatus">
        <button data-st="visited" aria-pressed="${place.status === 'visited'}">been</button>
        <button data-st="wishlist" aria-pressed="${place.status === 'wishlist'}">want to go</button>
        <button data-private class="reco" aria-pressed="${place.private === true}"
          title="kept out of every link, folio and publish">never leaves</button>
      </div>

      <div class="plate-sec">
        <div class="plate-sec-head"><span>tags</span></div>
        <div class="plate-words" id="pTags">${tagWords}<button id="pNewTag">＋ new</button></div>
      </div>

      <div class="plate-sec">
        <div class="plate-sec-head"><span>notes</span>${canDictate ? '<button class="dictate" id="pDictate">◉ dictate</button>' : ''}</div>
        <textarea class="note-input" id="pNote" aria-label="Your note on this place" placeholder="What makes it worth remembering…">${esc(place.note)}</textarea>
      </div>

      <div class="plate-sec">
        <div class="plate-sec-head"><span>figures</span></div>
        <div class="photo-grid" id="pPhotos">${photos}
          <button class="photo-add" id="pAddPhoto">＋ photo</button>
        </div>
      </div>

      <div class="plate-sec">
        <div class="plate-sec-head"><span>link</span></div>
        <input class="text-input" id="pUrl" type="url" aria-label="A link for this place" placeholder="https://…" value="${esc(place.url)}">
      </div>

      <div class="plate-acts">
        <button class="word-btn" id="pDirections">directions ↗</button>
        <button class="word-btn quiet" id="pFolio">file into a folio</button>
        ${safeUrl(place.url) ? `<a class="word-btn" href="${esc(place.url)}" target="_blank" rel="noopener">website ↗</a>` : ''}
        <button class="word-btn quiet" id="pDelete">remove</button>
      </div>
      <div class="plate-foot">entered ${fmtDate(place.createdAt)}</div>`}
  `;

  $('#pClose').addEventListener('click', () => closeSurface('plate'));
  $('#pCoords').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(`${place.lat}, ${place.lng}`); toast('coordinates copied'); }
    catch { toast('could not copy'); }
  });
  $('#pFolio')?.addEventListener('click', () => fileIntoFolio(place.id));
  $('#pDirections')?.addEventListener('click', () => {
    window.open(directionsURL(place.lat, place.lng, place.name), '_blank', 'noopener');
  });

  if (ro) {
    $('#pAdopt').addEventListener('click', () => {
      const c = store.correspondents.find(x => x.id === foreign.corrId) ||
        (state.visiting && state.visiting.id === foreign.corrId ? state.visiting : null);
      adoptPlace(place, foreign, c?.tags);
    });
    return;
  }

  // the store decides whether an edit happened; the view only reports it.
  // a write the device refused must never look like a write that succeeded.
  const save = (patch) => {
    const saved = store.updatePlace(place.id, { ...patch, sample: false });
    if (!saved) { renderPlate(placeById(place.id) || place, { edit: true }); return false; }
    mapView.refreshMarkerIcon(saved, tagById, true);
    renderCount(); renderChips();
    return true;
  };

  paintPhotos(wrap);

  if (keepScroll) wrap.scrollTop = keepScroll;

  const nameEl = $('#pName');
  nameEl.addEventListener('blur', () => {
    const v = nameEl.textContent.trim();
    if (v && v !== place.name) save({ name: v });
    else nameEl.textContent = place.name;
  });
  nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });

  $('#pStatus').addEventListener('click', (e) => {
    const st = e.target.closest('[data-st]');
    if (st) {
      save({ status: st.dataset.st });
      renderPlate(placeById(place.id)); renderList(); syncMarkers();
      return;
    }
    if (!e.target.closest('[data-private]')) return;
    const now = !place.private;
    save({ private: now });
    renderPlate(placeById(place.id)); renderList();
    toast(now ? 'this place never leaves the device' : 'this place may travel again');
  });



  $('#pTags').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-dtag]');
    if (chip) {
      const id = chip.dataset.dtag;
      const tags = place.tags.includes(id) ? place.tags.filter(t => t !== id) : [...place.tags, id];
      save({ tags });
      applyWorldState();
      renderPlate(place); renderList(); syncMarkers();
      return;
    }
    if (e.target.closest('#pNewTag')) {
      const input = document.createElement('input');
      input.className = 'text-input';
      input.style.maxWidth = '140px';
      input.placeholder = 'tag name ↵';
      e.target.replaceWith(input);
      input.focus();
      const done = () => {
        const name = input.value.trim();
        if (name) {
          const station = TAG_STATIONS[store.tags.length % TAG_STATIONS.length];
          const tag = store.addTag(newTag({ name, hue: station.hue, color: station.hex }));
          if (tag) {
            save({ tags: [...place.tags, tag.id] });
            applyWorldState();
          }
        }
        renderPlate(place); renderChips(); renderList(); syncMarkers();
      };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') done(); if (ev.key === 'Escape') renderPlate(place); });
      input.addEventListener('blur', done);
    }
  });

  $('#pNote').addEventListener('input', debounce((e) => save({ note: e.target.value }), 400));
  $('#pUrl').addEventListener('change', (e) => { save({ url: e.target.value.trim() }); renderPlate(place); });

  $('#pDictate')?.addEventListener('click', () => dictateInto($('#pNote'), $('#pDictate'), (text) => save({ note: text })));

  $('#pAddPhoto').addEventListener('click', () => {
    const file = $('#photoFile');
    file.onchange = async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      try {
        const dataUri = await compressImage(f);
        const blob = photoStore.blobFromDataURL(dataUri);
        const id = blob ? await photoStore.put(blob) : null;
        const entry = id || dataUri; // no blob store here: keep it inline, as before
        const photos = [...(place.photos || []), entry];
        if (!save({ photos })) { if (id) await photoStore.del(id); toast('this browser refused to keep it'); return; }
        renderPlate(placeById(place.id)); renderList();
      } catch { toast('could not read that image'); }
    };
    file.click();
  });

  $$('#pPhotos .ph-x').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const i = parseInt(btn.dataset.phx, 10);
    const kept = place.photos[i];
    save({ photos: place.photos.filter((_, k) => k !== i) });
    renderPlate(place); renderList();
    toast('photo removed.', 9000, { word: 'take it back', run: () => {
      const p2 = placeById(place.id);
      if (!p2) return;
      const back = p2.photos.slice(); back.splice(Math.min(i, back.length), 0, kept);
      store.updatePlace(p2.id, { photos: back });
      if (!$('#plate').hidden && state.selectedId === place.id) renderPlate(placeById(place.id));
      renderList();
    } });
  }));

  $('#pDelete').addEventListener('click', () => {
    const inFolios = store.folios.filter(f => f.placeIds.includes(place.id));
    const warn = inFolios.length
      ? ` ${inFolios.length === 1 ? 'One folio encloses it and' : `${inFolios.length} folios enclose it and`} will stop saying it.`
      : '';
    if (!confirm(`Remove “${place.name}” from your atlas?${warn} A link already sent keeps its copy.`)) return;
    const kept = { place: { ...place, photos: place.photos.slice() }, folioIds: inFolios.map(f => f.id) };
    store.removePlace(place.id);
    closeSurface('plate');
    renderAll();
    toast('removed.', 9000, { word: 'take it back', run: () => {
      const back = store.addPlace(kept.place);
      if (!back) return toast('this browser refused to take it back');
      kept.folioIds.forEach(id => {
        const f = store.folioById(id);
        if (f && !f.placeIds.includes(back.id)) store.updateFolio(id, { placeIds: [...f.placeIds, back.id] });
      });
      renderAll();
      toast('back where it was');
    } });
  });

  if (edit) {
    nameEl.focus();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// ---------- dictation ----------

let recog = null;
function dictateInto(textarea, btn, onFinal) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('dictation is not available in this browser');
  if (recog) { recog.stop(); return; }
  recog = new SR();
  recog.lang = navigator.language || 'en-US';
  recog.interimResults = true;
  recog.continuous = true;
  const base = textarea.value ? textarea.value.replace(/\s*$/, '') + ' ' : '';
  btn.classList.add('listening');
  btn.textContent = '◉ listening…';
  recog.onresult = (e) => {
    let text = '';
    for (const res of e.results) text += res[0].transcript;
    textarea.value = base + text.trim();
  };
  const stop = () => {
    btn.classList.remove('listening');
    btn.textContent = '◉ dictate';
    recog = null;
    onFinal(textarea.value);
  };
  recog.onend = stop;
  recog.onerror = () => { stop(); toast('dictation stopped'); };
  recog.start();
}

// ---------- image handling ----------

function compressImage(file, maxDim = 1280, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

// a photo that knows where it was taken becomes a place
async function addFromPhoto(file) {
  toast('reading the photo…');
  const fix = await exifGPS(file);
  if (!fix) {
    toast('no location in this photo. add the place first, then attach it');
    return;
  }
  let dataUri = null;
  try { dataUri = await compressImage(file); } catch { /* keep the fix anyway */ }
  const place = store.addPlace(newPlace({
    name: 'From a photograph', lat: fix.lat, lng: fix.lng,
    status: 'visited', photos: dataUri ? [dataUri] : [],
  }));
  if (!place) return toast('this browser refused to keep it. the photograph is large; export and free some room');
  store.settings.seeded = true;
  store.saveSettings();
  renderAll();
  selectPlace(place.id, { fly: true, edit: true });
  toast('kept by its own fix. the name is on its way');
  // the ground names itself when the network allows; the keep never waited
  try {
    const r = await reverseGeo(fix.lat, fix.lng);
    if (r) {
      const still = placeById(place.id);
      if (still && still.name === 'From a photograph') {
        store.updatePlace(place.id, {
          name: r.name || still.name, address: r.address || r.sub || '',
          city: r.city, country: r.country, countryCode: r.countryCode,
        });
        renderAll();
        if (state.selectedId === place.id) renderPlate(placeById(place.id), { edit: true });
      }
    }
  } catch { /* offline is fine; the fix stands */ }
}

// ---------- adding places ----------

// a found place is opened, not taken: you decide on the plate
function proposePlace(r) {
  state.proposal = r;
  mapView.previewPin(r.lat, r.lng);
  mapView.flyToPlace(r);
  const wrap = $('#plate');
  wrap.innerHTML = `
    <div class="plate-eyebrow">
      <span>found. not yet yours</span>
      <span>${fmtDMS(r.lat, r.lng)}</span>
      <button id="ppClose">close</button>
    </div>
    <h1 class="plate-name">${esc(r.name)}</h1>
    <div class="plate-sub">${esc(r.sub || r.address || '')}</div>
    <div class="plate-acts">
      <button class="word-btn" id="ppKeep">keep in your atlas</button>
      <button class="word-btn quiet" id="ppDirections">directions ↗</button>
    </div>`;
  openSurface('plate');
  const settle = () => { mapView.clearPreview(); state.proposal = null; };
  $('#ppClose').addEventListener('click', () => { settle(); closeSurface('plate'); });
  $('#ppKeep').addEventListener('click', () => {
    settle();
    if (addPlaceFromResult(r)) toast('kept. make it true');
  });
  $('#ppDirections').addEventListener('click', () => {
    window.open(directionsURL(r.lat, r.lng, r.name), '_blank', 'noopener');
  });
}

function addPlaceFromResult(r) {
  const place = store.addPlace(newPlace({
    name: r.name, lat: r.lat, lng: r.lng,
    address: r.address || r.sub || '', city: r.city, country: r.country, countryCode: r.countryCode,
    status: 'wishlist',
  }));
  if (!place) { toast('this browser refused to keep it'); return null; }
  store.settings.seeded = true;
  store.saveSettings();
  renderAll();
  selectPlace(place.id, { fly: true });
  return place;
}

async function proposeAdd(lat, lng) {
  const el = $('#addConfirm');
  state.pendingAdd = { lat, lng, name: 'this point' };
  $('#addConfirmName').textContent = '…';
  $('#addConfirmCoords').textContent = fmtDMS(lat, lng);
  el.hidden = false;
  try {
    const r = await reverseGeo(lat, lng);
    if (r && state.pendingAdd && state.pendingAdd.lat === lat) {
      state.pendingAdd.name = r.name || 'this point';
      Object.assign(state.pendingAdd, { address: r.address || r.sub || '', city: r.city, country: r.country, countryCode: r.countryCode });
      $('#addConfirmName').textContent = state.pendingAdd.name;
    }
  } catch { $('#addConfirmName').textContent = 'this point'; }
}

function commitAdd() {
  const p = state.pendingAdd;
  if (!p) return;
  state.pendingAdd = null;
  $('#addConfirm').hidden = true;
  const place = store.addPlace(newPlace({
    name: p.name === 'this point' ? 'Unnamed fix' : p.name,
    lat: p.lat, lng: p.lng,
    address: p.address || '', city: p.city || '', country: p.country || '', countryCode: p.countryCode || '',
    status: 'wishlist',
  }));
  if (!place) return toast('this browser refused to keep it');
  store.settings.seeded = true;
  store.saveSettings();
  renderAll();
  selectPlace(place.id, { fly: false, edit: true });
}

function seedDemo({ quiet = false } = {}) {
  const demo = demoData();
  demo.tags.forEach(t => store.addTag(t));
  // every seeded place carries the word sample until it is adopted or edited
  demo.places.forEach(p => store.addPlace({ ...p, sample: true }));
  (demo.routes || []).forEach(r => store.addRoute({ ...r, sample: true }));
  store.settings.seeded = true;
  store.saveSettings();
  renderAll();
  closeSurface('indexOverlay');
  mapView.fitAll(store.places);
  if (!quiet) toast('a sample atlas. edit anything and it becomes yours');
}

// ---------- ways: the plate, and the ground drawn as a section ----------

function selectRoute(id, { fly = true } = {}) {
  const r = routeById(id);
  if (!r) return;
  state.selectedRouteId = id;
  state.selectedId = null;
  syncMarkers();
  if (fly) mapView.frameRoute(r);
  renderRoutePlate(r);
  openSurface('plate');
}

// the profile is not a chart. it is a section through the hill: a ridge over
// close hatching whose weight follows the steepness, so a wall reads as a wall.
function profileSVG(pf) {
  if (!pf) return '';
  const hatch = pf.hatch.map(h =>
    `<line class="pf-hatch" x1="${h.x.toFixed(1)}" y1="${h.y.toFixed(1)}" x2="${h.x.toFixed(1)}" y2="${pf.height}" style="--g:${h.w.toFixed(2)}"/>`
  ).join('');
  return `<svg class="pf" viewBox="0 0 ${pf.width} ${pf.height}" preserveAspectRatio="none" aria-hidden="true">
      <g class="pf-hatches">${hatch}</g>
      <path class="pf-ridge" d="${pf.ridge}"/>
      <circle class="pf-high" cx="${pf.high.x.toFixed(1)}" cy="${pf.high.y.toFixed(1)}" r="7"/>
      <line class="pf-rule" x1="0" y1="0" x2="0" y2="${pf.height}" hidden/>
    </svg>`;
}

function renderRoutePlate(route) {
  const wrap = $('#plate');
  const keepScroll = wrap.dataset.pid === route.id ? wrap.scrollTop : 0;
  wrap.dataset.pid = route.id;
  const m = {
    km: route.km, ascent: route.ascent, descent: route.descent,
    high: route.high, low: route.low, hours: route.hours,
  };
  const pf = profile(route.path, { width: 1000, height: 200 });
  const tagWords = allTags().map(t =>
    `<button data-rtag="${esc(t.id)}" class="${route.tags.includes(t.id) ? 'on' : ''}">${esc(t.name)}</button>`).join('');

  wrap.innerHTML = `
    <div class="plate-eyebrow mono">
      <span>${route.loop ? 'a loop' : 'a way'}${route.sample ? '' : ''}</span>
      <span>${esc(effort(m))}</span>
      <button id="pClose">close</button>
    </div>
    <h1 class="plate-name" id="pRouteName" contenteditable="plaintext-only" spellcheck="false"
        role="textbox" aria-label="The name of this way">${esc(route.name)}</h1>
    ${route.sample ? '<span class="p-sample">sample</span>' : ''}
    <div class="plate-sub">${esc([route.city, route.country].filter(Boolean).join(' · '))}</div>
    ${route.provenance ? `<div class="plate-prov prov">after <b>${esc(route.provenance.name)}</b></div>` : ''}

    <dl class="way-measure mono">
      <div><dt>distance</dt><dd>${esc(fmtKm(m.km))}</dd></div>
      ${Number.isFinite(m.ascent) ? `<div><dt>ascent</dt><dd>${m.ascent} m</dd></div>` : ''}
      ${Number.isFinite(m.descent) ? `<div><dt>descent</dt><dd>${m.descent} m</dd></div>` : ''}
      ${Number.isFinite(m.high) ? `<div><dt>high point</dt><dd>${m.high} m</dd></div>` : ''}
      <div><dt>on foot</dt><dd>${esc(fmtHours(m.hours))}</dd></div>
    </dl>

    ${pf ? `
    <div class="plate-sec">
      <div class="plate-sec-head"><span>the ground</span><span class="pf-read mono" id="pfRead"></span></div>
      <div class="pf-wrap" id="pfWrap" role="img"
        aria-label="Elevation along the way: ${Math.round(m.low)} to ${Math.round(m.high)} metres over ${esc(fmtKm(m.km))}">
        ${profileSVG(pf)}
      </div>
      <div class="pf-axis mono"><span>0</span><span>${esc(fmtKm(m.km))}</span></div>
    </div>` : ''}

    <div class="plate-words" id="pRouteStatus">
      <button data-rst="walked" aria-pressed="${route.status === 'walked'}">walked</button>
      <button data-rst="wishlist" aria-pressed="${route.status === 'wishlist'}">want to walk</button>
    </div>

    <div class="plate-sec">
      <div class="plate-sec-head"><span>tags</span></div>
      <div class="plate-words" id="pRouteTags">${tagWords}</div>
    </div>

    <div class="plate-sec">
      <div class="plate-sec-head"><span>notes</span></div>
      <textarea class="note-input" id="pRouteNote" aria-label="Your note on this way"
        placeholder="When to walk it, where to start, what it asks of you…">${esc(route.note)}</textarea>
    </div>

    <div class="plate-acts">
      <button class="word-btn quiet" id="pRouteGpx">export gpx</button>
      <button class="word-btn quiet" id="pRouteRemove">remove</button>
    </div>`;

  if (keepScroll) wrap.scrollTop = keepScroll;

  const save = (patch) => {
    const saved = store.updateRoute(route.id, { ...patch, sample: false });
    if (!saved) { renderRoutePlate(routeById(route.id) || route); return false; }
    syncMarkers(); renderCount(); renderList();
    return true;
  };

  const nameEl = $('#pRouteName');
  nameEl.addEventListener('blur', () => {
    const v = nameEl.textContent.trim();
    if (v && v !== route.name) save({ name: v });
    else nameEl.textContent = route.name;
  });
  $('#pClose').addEventListener('click', () => { state.selectedRouteId = null; popSurface(); syncMarkers(); applyWorldState(); });
  $$('#pRouteStatus [data-rst]').forEach(b => b.addEventListener('click', () => {
    if (save({ status: b.dataset.rst })) renderRoutePlate(routeById(route.id));
  }));
  $$('#pRouteTags button').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.rtag;
    const tags = route.tags.includes(id) ? route.tags.filter(t => t !== id) : [...route.tags, id];
    if (save({ tags })) renderRoutePlate(routeById(route.id));
  }));
  $('#pRouteNote').addEventListener('input', debounce((e) => save({ note: e.target.value }), 400));
  $('#pRouteGpx').addEventListener('click', () => downloadGPX(route));
  $('#pRouteRemove').addEventListener('click', () => {
    const wayFolios = store.folios.filter(f => f.routeIds.includes(route.id)).length;
    if (!confirm(`Remove “${route.name}” from your atlas?${wayFolios ? ` ${wayFolios === 1 ? 'One folio encloses it' : `${wayFolios} folios enclose it`} and will stop saying it.` : ''} A link already sent keeps its copy.`)) return;
    store.removeRoute(route.id);
    state.selectedRouteId = null;
    popSurface();
    renderAll();
    toast('the way is gone');
  });

  if (pf) bindProfile(pf);
}

// a finger along the section puts a light on the hill, and says where it is
function bindProfile(pf) {
  const wrap = $('#pfWrap');
  const read = $('#pfRead');
  const rule = wrap.querySelector('.pf-rule');
  if (!wrap) return;

  const move = (clientX) => {
    const box = wrap.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
    const at = pf.at(t * pf.total);
    rule.hidden = false;
    rule.setAttribute('x1', (t * pf.width).toFixed(1));
    rule.setAttribute('x2', (t * pf.width).toFixed(1));
    read.textContent = `${fmtKm(t * pf.total)} · ${Math.round(at.ele)} m`;
    mapView.setRouteCursor(at.lat, at.lng);
  };
  const leave = () => {
    rule.hidden = true;
    read.textContent = '';
    mapView.setRouteCursor(null);
  };

  wrap.addEventListener('pointermove', (e) => move(e.clientX));
  wrap.addEventListener('pointerdown', (e) => { wrap.setPointerCapture?.(e.pointerId); move(e.clientX); });
  wrap.addEventListener('pointerleave', leave);
  wrap.addEventListener('pointercancel', leave);
}

// ---------- taking a way in ----------

async function addFromGPX(file) {
  let text;
  try { text = await file.text(); } catch { return toast('could not read that file'); }
  const parsed = parseGPX(text);
  if (!parsed) return toast('that file has no track in it');

  const m = measure(parsed.points);
  const path = simplify(parsed.points, 0.012);
  const mid = path[Math.floor(path.length / 2)];
  const route = newRoute({
    name: parsed.name || file.name.replace(/\.gpx$/i, '') || 'Untitled way',
    path,
    km: m.km, ascent: m.ascent, descent: m.descent,
    high: m.high, low: m.low, hours: m.hours, loop: m.loop,
    walkedAt: parsed.walkedAt,
    status: parsed.walkedAt ? 'walked' : 'wishlist',
  });
  const made = store.addRoute(route);
  if (!made) return toast('this browser refused to keep it. a long walk is large; export and free some room');
  renderAll();
  selectRoute(made.id);
  toast(`${fmtKm(m.km)}${Number.isFinite(m.ascent) ? `, ${m.ascent} m up` : ''}. ${effort(m)}`);

  // the ground names itself, once, quietly
  try {
    const rev = await reverseGeo(mid.lat, mid.lng);
    if (rev) {
      store.updateRoute(made.id, { city: rev.city || '', country: rev.country || '' });
      if (state.selectedRouteId === made.id) renderRoutePlate(routeById(made.id));
    }
  } catch { /* the walk stands without a name for its valley */ }
}

function downloadGPX(route) {
  const pts = route.path.map(p =>
    `    <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">${Number.isFinite(p.ele) ? `<ele>${p.ele.toFixed(1)}</ele>` : ''}</trkpt>`
  ).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Resonate" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${esc(route.name)}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>`;
  const safe = route.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60) || 'way';
  download(`${safe}.gpx`, gpx, 'application/gpx+xml');
}

// ---------- correspondents ----------

function corrShaped(c) { return { tags: c.tags, places: c.places }; }
function myAtlas() { return { tags: store.tags, places: store.places }; }

function pushCorrespondentsToMap() {
  mapView.setCorrespondents(store.correspondents);
}

// a place keeps its domains when it changes hands: foreign tag names are
// matched to yours by name, and the ones you lack are adopted alongside it
function graftTags(foreignTagIds, foreignTags) {
  if (!Array.isArray(foreignTagIds) || !foreignTags) return [];
  const byId = new Map(foreignTags.map(t => [t.id, t]));
  const out = [];
  for (const fid of foreignTagIds) {
    const ft = byId.get(fid);
    if (!ft) continue;
    const name = String(ft.name || '').trim();
    if (!name) continue;
    const mine = store.tags.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (mine) { out.push(mine.id); continue; }
    const made = store.addTag(newTag({ name, hue: ft.hue, color: ft.color }));
    if (made) out.push(made.id);
  }
  return [...new Set(out)];
}

// A place remembers its whole road, not only its last carrier. Ana handed it
// to Mira, who handed it to you: flattening that to "after Mira" loses the
// person who found it. Five hops are kept, oldest first.
function extendChain(prior, foreign) {
  const before = prior
    ? [...(prior.chain || []), { name: prior.name, at: prior.adoptedAt }].filter(h => h.name)
    : [];
  return {
    chain: before.slice(-4),
    name: foreign.name,
    sig: foreign.sig,
    adoptedAt: new Date().toISOString(),
  };
}

function adoptPlace(place, foreign, foreignTags = null) {
  const adopted = store.addPlace(newPlace({
    ...place,
    id: undefined,
    photos: [],
    tags: graftTags(place.tags, foreignTags || foreign.tags),
    provenance: extendChain(place.provenance, foreign),
  }));
  if (!adopted) { toast('this browser refused to keep it'); return null; }
  renderAll();
  // the report still stands in front: select quietly, do not raise a plate behind it
  if (topSurface() === 'plate') closeSurface('plate');
  const reportUp = !$('#reportOverlay').hidden;
  selectPlace(adopted.id, { fly: false, quiet: reportUp });
  toast(`yours now, after ${foreign.name}`);
  return adopted;
}

function openForeignPlate(corrId, placeId) {
  const c = store.correspondents.find(x => x.id === corrId) ||
    (state.visiting && state.visiting.id === corrId ? state.visiting : null);
  const p = c?.places.find(x => x.id === placeId);
  if (!c || !p) return;
  state.foreign = { corrId, name: c.name, sig: mapView.sigAngle(c.id), place: p };
  renderPlate(p, { foreign: state.foreign });
  openSurface('plate');
}

function renderVoices() {
  const body = $('#corrBody');
  if (!store.correspondents.length) {
    body.innerHTML = `<div class="corr-empty">
      <p class="ce-law">Resonance is exchanged, not followed.</p>
      <p class="ce-how">Hand your atlas to one person whose taste you trust. When theirs comes back,
      open the link here. the field will tell you what you have in common.</p>
      <div class="word-row">
        <button class="word-btn" id="ceShare">copy my atlas link</button>
        <button class="word-btn quiet" id="ceImport">open one sent to me</button>
      </div>
    </div>`;
    $('#ceShare').addEventListener('click', shareMap);
    $('#ceImport').addEventListener('click', () => {
      const url = prompt('Paste the link you were sent:');
      if (url && url.includes('#m=')) location.href = url.slice(url.indexOf('#m='));
      if (url && url.includes('#m=')) location.reload();
    });
    return;
  }
  body.innerHTML = store.correspondents.map(c => {
    const r = resonance(myAtlas(), corrShaped(c));
    const v = verdict(r);
    const ev = evidenceLines(r, c.name);
    const sig = mapView.sigAngle(c.id);
    return `<div class="corr-row" data-cid="${esc(c.id)}">
      <div class="corr-row-head">
        <svg class="corr-glyph" width="34" height="34" viewBox="0 0 30 30" style="--sig:${sig}deg">
          <circle class="corr-arcs" cx="15" cy="15" r="9" pathLength="360"/>
          <circle class="corr-pole" cx="15" cy="15" r="1.8"/>
        </svg>
        <h3 class="corr-name" contenteditable="plaintext-only" spellcheck="false" role="textbox" aria-label="This voice's name">${esc(c.name)}</h3>
      </div>
      <div class="corr-meta">since ${fmtDate(c.addedAt)} · ${c.places.length} marks · ${v.word}</div>
      <div class="corr-ev">${ev.map(l => `<div>${l}</div>`).join('')}</div>
      <div class="corr-ctl">
        <div class="hue-stations" role="group" aria-label="Their color">
          ${TAG_STATIONS.map(s => `<button data-hue="${s.hue}" aria-pressed="${c.hue === s.hue}">${s.name}</button>`).join('')}
        </div>
        <button class="word-btn quiet" data-vis>${c.visible === false ? 'muted' : 'audible'}</button>
        <button class="word-btn quiet" data-part>part ways</button>
      </div>
    </div>`;
  }).join('');

  $$('.corr-row', body).forEach(row => {
    const id = row.dataset.cid;
    const c = store.correspondents.find(x => x.id === id);
    row.querySelector('.corr-name').addEventListener('blur', (e) => {
      const v = e.target.textContent.trim();
      if (v) { store.updateCorrespondent(id, { name: v }); renderAll(); }
    });
    row.querySelector('[data-vis]').addEventListener('click', (e) => {
      store.updateCorrespondent(id, { visible: c.visible === false });
      pushCorrespondentsToMap();
      renderVoices();
    });
    row.querySelector('[data-part]').addEventListener('click', () => {
      if (!confirm(`Part ways with ${c.name}? Their marks leave your field. Places you adopted stay yours, and still say “after ${c.name}”.`)) return;
      store.removeCorrespondent(id);
      pushCorrespondentsToMap();
      renderVoices();
      toast(`parted ways with ${c.name}`);
    });
    row.querySelectorAll('[data-hue]').forEach(b => b.addEventListener('click', () => {
      store.updateCorrespondent(id, { hue: parseInt(b.dataset.hue, 10) });
      renderVoices();
      syncMarkers();
    }));
  });
}

// ---------- the resonance report ----------

// a visit ends by putting the borrowed marks away, not by reloading
function leaveVisit() {
  state.visiting = null;
  clearShareHash();
  $('#visitBar').hidden = true;
  pushCorrespondentsToMap();
  applyWorldState();
  renderAll();
  if (store.places.length) mapView.fitAll(store.places);
  toast('their marks are put away');
}

// leaving a report opens the atlas it was offered to, rather than reloading
// the page out from under the reader
// The strongest loop this app has is not publishing. It is: someone sends
// you places, you keep two, and you send three back. The ask is bounded on
// purpose. Three is a kindness; an open request is a chore.
function askForThree(author) {
  if (!author || author === 'no byline') return false;
  const asked = new Set(store.settings.answered || []);
  const key = author.toLowerCase();
  if (asked.has(key)) return false;
  if (store.places.filter(p => !p.private).length < 3) return false;

  const bar = $('#answerBar');
  $('#answerWho').textContent = `answer with three, for ${author}`;
  bar.hidden = false;
  const close = () => {
    bar.hidden = true;
    store.settings.answered = [...asked, key];
    store.saveSettings();
  };
  $('#answerGo').onclick = () => {
    close();
    openFolioComposer({
      fresh: true, cap: 3,
      title: `three for ${author}`,
      dedication: `after yours`,
    });
  };
  $('#answerNo').onclick = close;
  return true;
}

function leaveReport(el, author = '') {
  clearShareHash();
  dropDialog(el);
  if (author && askForThree(author)) return;
  applyWorldState();
  state.visiting = null;
  pushCorrespondentsToMap();
  renderAll();
  if (store.places.length || store.routes.length) {
    mapView.fitAll([...store.places, ...store.routes.flatMap(r => r.path)]);
    toast('your atlas');
  } else if (!store.settings.chosen) {
    openThreshold();
  } else {
    toast('your field is still empty. press the middle, or find or add below');
  }
}

function openReport(payload) {
  if (payload.kind === 'folio') return openFolioReport(payload);
  if (payload.kind === 'ask') return openAskReport(payload);
  return openAtlasReport(payload);
}

// a folio arrives: an envelope, not a feed item
function openFolioReport(payload) {
  const author = String(payload.author || '').trim() || 'no byline';
  const places = (payload.places || [])
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map(p => newPlace({ ...p, photos: [] }));
  const ways = payload.routes || [];
  const held = places.filter(holdAlready);
  const fresh = places.filter(p => !holdAlready(p));
  const sig = mapView.sigAngle(author);

  const el = $('#reportOverlay');
  el.innerHTML = `
    <button class="rp-x" id="rpX">close</button>
    <div class="rp-eyebrow">a folio from ${esc(author)}</div>
    <h1 class="rp-name">${esc(payload.title || 'untitled')}</h1>
    ${payload.dedication ? `<p class="rp-ded">“${esc(payload.dedication)}”</p>` : ''}
    <ul class="rp-evidence mono">
      <li><b>${places.length}</b> place${places.length === 1 ? '' : 's'} enclosed</li>
      ${ways.length ? `<li><b>${ways.length}</b> way${ways.length === 1 ? '' : 's'} to walk</li>` : ''}
      ${held.length ? `<li><b>${held.length}</b> you already hold, you can trust the rest</li>` : ''}
      ${fresh.length ? `<li><b>${fresh.length}</b> new to your field</li>` : ''}
    </ul>
    <div class="rp-case">
      ${places.map((p, i) => `
        <div class="rp-pick">
          <span class="no">${fmtNo(i + 1)}</span>
          <span class="nm">${esc(p.name)}</span>
          <span class="why">${esc(p.city || '')}</span>
          <a class="adopt quiet" href="${esc(directionsURL(p.lat, p.lng, p.name))}" target="_blank" rel="noopener">directions</a>
          ${holdAlready(p)
            ? '<span class="held">you hold this</span>'
            : `<button class="adopt" data-adopt="${i}">adopt</button>`}
        </div>`).join('')}
      ${ways.map((r, i) => `
        <div class="rp-pick">
          <span class="no">${r.loop ? '◯' : '⟋'}</span>
          <span class="nm">${esc(r.name)}</span>
          <span class="why">${esc(fmtKm(r.km))}${Number.isFinite(r.ascent) ? ` · ${r.ascent} m up` : ''}</span>
          <button class="adopt" data-adopt-way="${i}">adopt</button>
        </div>`).join('')}
    </div>
    <div class="rp-foot">
      ${places.length ? '<button class="word-btn" id="rpField">see them on the field</button>' : ''}
      ${fresh.length ? `<button class="word-btn" id="rpTakeAll">take all ${fresh.length}</button>` : ''}
      <button class="word-btn quiet" id="rpGeo">download as geojson</button>
      <button class="word-btn quiet" id="rpPrint">print, or save as pdf</button>
      <button class="word-btn quiet" id="rpLeave">${store.places.length || store.routes.length ? 'open my atlas' : 'begin my own atlas'}</button>
    </div>
    <p class="rp-foot-note">These places are yours to keep, to walk to, or to take away in a file. Nothing here has touched your own atlas.</p>`;
  raiseDialog(el, 'Resonance report');
  requestAnimationFrame(() => el.querySelector('.rp-name').style.setProperty('--rp-w', 650));

  const ref = { name: author, sig };
  const foreignTags = payload.tags || [];
  // a way is adopted whole, with its provenance, like a place
  const adoptWay = (r) => {
    const made = store.addRoute(newRoute({
      ...r, id: undefined, sample: false,
      tags: graftTags(r.tags || [], foreignTags),
      provenance: extendChain(r.provenance, { name: author, sig }),
    }));
    if (!made) { toast('this browser refused to keep it'); return null; }
    renderAll();
    return made;
  };
  $$('[data-adopt-way]', el).forEach(b => b.addEventListener('click', () => {
    const r = ways[parseInt(b.dataset.adoptWay, 10)];
    if (!r) return;
    if (adoptWay(r)) {
      b.replaceWith(Object.assign(document.createElement('span'), { className: 'held', textContent: 'yours' }));
      toast(`the way is yours, after ${author}`);
    }
  }));
  $$('[data-adopt]', el).forEach(b => b.addEventListener('click', () => {
    const p = places[parseInt(b.dataset.adopt, 10)];
    if (!p) return;
    adoptPlace(p, ref, foreignTags);
    b.replaceWith(Object.assign(document.createElement('span'), { className: 'held', textContent: 'yours' }));
  }));
  $('#rpTakeAll')?.addEventListener('click', () => {
    // whatever was taken one at a time is already yours: never take it twice
    const remaining = fresh.filter(p => !holdAlready(p));
    remaining.forEach(p => adoptPlace(p, ref, foreignTags));
    // untouched ways come along with take-all; adopted ones show 'yours'
    $$('[data-adopt-way]', el).forEach(b => { if (b.tagName === 'BUTTON') adoptWay(ways[parseInt(b.dataset.adoptWay, 10)]); });
    renderAll();
    clearShareHash();
    dropDialog(el);
    applyWorldState();
    mapView.fitAll(store.places);
    toast(remaining.length
      ? `${remaining.length} place${remaining.length === 1 ? '' : 's'} taken, after ${author}`
      : 'you already hold them all');
    setTimeout(() => askForThree(author), 1400);
  });
  $('#rpField')?.addEventListener('click', () => {
    // their marks on a field of yours that is untouched: the visiting pattern
    state.visiting = { id: 'visit-' + Date.now(), name: author, hue: 278, visible: true,
      tags: foreignTags, places };
    mapView.setCorrespondents([...store.correspondents, state.visiting]);
    dropDialog(el);
    mapView.fitAll(places);
    const bar = $('#visitBar');
    bar.hidden = false;
    $('#visitWho').textContent = `visiting ${author}`;
    toast('their places, on a field of yours that is untouched');
  });

  $('#rpGeo').addEventListener('click', () => {
    const fc = {
      type: 'FeatureCollection',
      features: places.map(p => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { name: p.name, city: p.city, country: p.country, note: p.note, from: author },
      })),
    };
    download(`${(payload.title || 'folio').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.geojson`,
      JSON.stringify(fc, null, 2), 'application/geo+json');
  });

  $('#rpLeave').addEventListener('click', () => leaveReport(el, author));
  $('#rpPrint').addEventListener('click', () => {
    const theirTags = new Map((payload.tags || []).map(t => [t.id, t.name]));
    printSheet({
      title: payload.title || 'untitled',
      dedication: payload.dedication || '',
      author,
      places,
      routes: ways,
      tagName: (id) => theirTags.get(id),
    });
  });
}

// an ask arrives: your atlas has already drafted the reply
function openAskReport(payload) {
  const from = String(payload.from || '').trim() || 'someone';
  const q = String(payload.q || '').trim();
  const matches = q ? queryMyAtlas(q) : [];

  const el = $('#reportOverlay');
  el.innerHTML = `
    <button class="rp-x" id="rpX">close</button>
    <div class="rp-eyebrow">an ask, from ${esc(from)}</div>
    <h1 class="rp-name">${esc(q || 'anything')}</h1>
    <ul class="rp-evidence mono">
      <li>your atlas holds <b>${matches.length}</b> answer${matches.length === 1 ? '' : 's'}</li>
    </ul>
    <div class="rp-foot">
      ${matches.length ? `<button class="word-btn" id="askCompose">compose the folio for ${esc(from)}</button>` : ''}
      <button class="word-btn quiet" id="rpLeave">${store.places.length || store.routes.length ? 'open my atlas' : 'begin my own atlas'}</button>
    </div>`;
  raiseDialog(el, 'Resonance report');
  requestAnimationFrame(() => el.querySelector('.rp-name').style.setProperty('--rp-w', 650));

  $('#askCompose')?.addEventListener('click', () => {
    clearShareHash();
    dropDialog(el);
    applyWorldState();
    openFolioComposer({
      title: q,
      dedication: `for ${from}, who asked`,
      places: matches,
    });
  });
  $('#rpLeave').addEventListener('click', () => leaveReport(el));
}

function openAtlasReport(payload) {
  const theirs = {
    tags: (payload.tags || []).map(t => newTag(t)),
    places: (payload.places || [])
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .map(p => newPlace({ ...p, photos: [] })),
  };
  const theirWays = payload.routes || [];
  const name = String(payload.author || '').trim() || 'an atlas without a byline';
  const r = resonance(myAtlas(), theirs);
  const v = verdict(r);
  const ev = evidenceLines(r, name);
  const picks = r.picks.slice(0, 7);
  const sig = mapView.sigAngle(name);

  const el = $('#reportOverlay');
  el.innerHTML = `
    <button class="rp-x" id="rpX">close</button>
    <div class="rp-eyebrow">an atlas offered to yours</div>
    <h1 class="rp-name">${esc(name)}</h1>
    <p class="rp-verdict">${v.word}<span class="rp-sub">${v.sub}</span></p>
    <ul class="rp-evidence mono">${ev.map(l => `<li>${l}</li>`).join('')}</ul>
    <details class="rp-grounds">
      <summary>the grounds for that word</summary>
      <ul class="rp-evidence mono">
        ${grounds(r).map(g => `<li><b>${g.n}</b> ${esc(g.of)}${g.detail ? `: <i>${esc(g.detail)}</i>` : ''}</li>`).join('')}
      </ul>
      <p class="set-row-sub">Every one of these is counted here, on this device, from the two atlases in front of it. The method is written down at <a href="METHOD.md">/METHOD.md</a>, and nothing about it leaves.</p>
    </details>
    ${picks.length ? `<div class="rp-case">
      <div class="sec-head">the case for you</div>
      ${picks.map((pk, i) => `
        <div class="rp-pick" data-i="${i}">
          <span class="no">${fmtNo(i + 1)}</span>
          <span class="nm">${esc(pk.place.name)}</span>
          <span class="why">${pk.expands ? 'new ground' : esc((pk.domainLabels[0] || '').toLowerCase())}</span>
          <button class="adopt" data-adopt="${i}">adopt</button>
        </div>`).join('')}
    </div>` : ''}
    ${theirWays.length ? `<div class="rp-case">
      <div class="sec-head">the ways they walk</div>
      ${theirWays.map((r, i) => `
        <div class="rp-pick">
          <span class="no">${r.loop ? '◯' : '⟋'}</span>
          <span class="nm">${esc(r.name)}</span>
          <span class="why">${esc(fmtKm(r.km))}${Number.isFinite(r.ascent) ? ` · ${r.ascent} m up` : ''}</span>
          <button class="adopt" data-adopt-way="${i}">adopt</button>
        </div>`).join('')}
    </div>` : ''}
    <div class="rp-foot">
      ${store.places.length < 3 ? `<button class="word-btn" id="rpBegin">begin with a copy of this atlas</button>` : ''}
      <button class="word-btn ${store.places.length < 3 ? 'quiet' : ''}" id="rpKeep">keep ${esc(name)} as a voice</button>
      <button class="word-btn quiet" id="rpLook">just look around</button>
      <button class="word-btn quiet" id="rpLeave">${store.places.length || store.routes.length ? 'open my atlas' : 'begin my own atlas'}</button>
    </div>`;
  raiseDialog(el, 'Resonance report');
  requestAnimationFrame(() => el.querySelector('.rp-name').style.setProperty('--rp-w', 650));

  const foreignRef = { name, sig };
  $$('[data-adopt-way]', el).forEach(b => b.addEventListener('click', () => {
    const r = theirWays[parseInt(b.dataset.adoptWay, 10)];
    if (!r) return;
    const made = store.addRoute(newRoute({
      ...r, id: undefined, sample: false,
      tags: graftTags(r.tags || [], theirs.tags),
      provenance: extendChain(r.provenance, { name, sig }),
    }));
    if (!made) return toast('this browser refused to keep it');
    renderAll();
    b.replaceWith(Object.assign(document.createElement('span'), { className: 'held', textContent: 'yours' }));
    toast(`the way is yours, after ${name}`);
  }));
  $$('[data-adopt]', el).forEach(b => b.addEventListener('click', () => {
    const pk = picks[parseInt(b.dataset.adopt, 10)];
    if (!pk) return;
    adoptPlace(pk.place, foreignRef, theirs.tags);
    b.replaceWith(Object.assign(document.createElement('span'), { className: 'why', textContent: 'yours' }));
  }));
  $('#rpBegin')?.addEventListener('click', () => {
    const added = store.merge({ tags: theirs.tags, places: theirs.places });
    if (!added) return toast('this browser refused to keep them');
    store.settings.chosen = true;
    store.saveSettings();
    leaveReport(el);
    toast(`${added} places are yours now. make them true`);
  });
  $('#rpKeep').addEventListener('click', () => {
    const finalName = prompt('Keep this atlas under which name?', name === 'an atlas without a byline' ? '' : name);
    if (finalName === null) return;
    const kept = store.addCorrespondent({ name: finalName || name, tags: theirs.tags, places: theirs.places });
    if (!kept) return toast('this browser refused to keep them');
    pushCorrespondentsToMap();
    clearShareHash();
    dropDialog(el);
    applyWorldState();
    renderAll();
    // fly to where their marks actually are, so the toast tells the truth
    if (kept.places.length) mapView.fitAll(kept.places);
    toast(`${finalName || name} is now a voice. these are their marks`);
  });
  $('#rpLook').addEventListener('click', () => {
    state.visiting = { id: 'visit-' + Date.now(), name, hue: 278, visible: true, tags: theirs.tags, places: theirs.places };
    mapView.setCorrespondents([...store.correspondents, state.visiting]);
    dropDialog(el);
    mapView.fitAll(theirs.places);
    const bar = $('#visitBar');
    bar.hidden = false;
    $('#visitWho').textContent = `visiting ${name}`;
    toast('their marks, on a field of yours that is untouched');
  });
  $('#rpLeave').addEventListener('click', () => leaveReport(el));
}

// ---------- folios: the atomic recommendation ----------

function holdAlready(p) {
  // do I already hold this place? (proximity + name family)
  return store.places.some(mp => {
    if (haversineKm(mp, p) > 0.15) return false;
    const a = mp.name.toLowerCase(), b = p.name.toLowerCase();
    return a.includes(b) || b.includes(a) || haversineKm(mp, p) < 0.04;
  });
}

// a byline is asked for at the moment it is used, never at the door
function ensureAuthor() {
  if (store.settings.authorName) return Promise.resolve(store.settings.authorName);
  const ask = $('#nameAsk');
  const input = $('#nameAskInput');
  return new Promise((resolve) => {
    const done = (name) => {
      go.removeEventListener('click', onGo);
      later.removeEventListener('click', onLater);
      input.removeEventListener('keydown', onKey);
      if (name) { store.settings.authorName = name; store.saveSettings(); renderCount(); }
      dropDialog(ask);
      resolve(store.settings.authorName || '');
    };
    const onGo = () => done(input.value.trim());
    const onLater = () => done('');
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim()); }
      if (e.key === 'Escape') { e.preventDefault(); done(''); }
    };
    const go = $('#nameAskGo');
    const later = $('#nameAskLater');
    go.addEventListener('click', onGo);
    later.addEventListener('click', onLater);
    input.addEventListener('keydown', onKey);
    input.value = '';
    raiseDialog(ask, 'Your name');
    input.focus();
  });
}

// ---------- folios: the shelf, and the composer ----------
//
// A folio is a titled slice of the atlas, kept as references so it stays
// current as places improve. Keeping shares nothing. Handing over, publishing
// and printing are each their own explicit act, from the same page.

function openFolioShelf() {
  const body = $('#folioBody');
  const shelf = store.folios;
  body.innerHTML = `
    ${shelf.length ? shelf.map(f => {
      const r = store.resolveFolio(f.id);
      const names = r.places.slice(0, 3).map(p => p.name).join(' · ');
      const n = r.places.length + r.routes.length;
      return `<button class="fol-shelf-row" data-open="${esc(f.id)}">
        <span class="fs-title">${esc(f.title)}</span>
        <span class="fs-meta mono">${n} enclosed${r.routes.length ? ` · ${r.routes.length} way${r.routes.length > 1 ? 's' : ''}` : ''} · ${fmtDate(f.updatedAt)}</span>
        ${names ? `<span class="fs-names">${esc(names)}${r.places.length > 3 ? ' …' : ''}</span>` : ''}
        ${f.dedication ? `<span class="fs-ded">${esc(f.dedication)}</span>` : ''}
      </button>`;
    }).join('') : `<div class="ix-empty">A folio is a titled set of places, kept here <b>for yourself</b>.
      <p>Hand it to one person as a link, publish it, or print it, whenever you
      choose. Nothing is shared by keeping it.</p>
    </div>`}
    <div class="fol-acts">
      <button class="word-btn" id="folNew">compose a new folio</button>
    </div>`;
  $$('[data-open]', body).forEach(b => b.addEventListener('click', () => openFolioComposer({ folioId: b.dataset.open })));
  $('#folNew').addEventListener('click', () => openFolioComposer({ fresh: true }));
  openSurface('folioOverlay');
}

function openFolioComposer({ folioId = null, title = '', dedication = '', places = null, fresh = false, preselect = [], cap = 0 } = {}) {
  const kept = folioId ? store.folioById(folioId) : null;
  const pool = (kept || fresh ? allPlaces() : (places || filteredPlaces())).filter(p => !p.private);
  const wayPool = allRoutes();
  const chosen = new Set(
    kept ? kept.placeIds.filter(id => placeById(id))
      : fresh ? preselect.filter(id => placeById(id))
        : pool.map(p => p.id));
  const chosenWays = new Set(kept ? kept.routeIds.filter(id => routeById(id)) : []);
  if (kept) { title = kept.title; dedication = kept.dedication; }
  const body = $('#folioBody');

  const readHead = () => {
    title = $('#folTitle').value;
    dedication = $('#folDed').value;
  };
  const selection = () => pool.filter(p => chosen.has(p.id));
  const wraySelection = () => wayPool.filter(r => chosenWays.has(r.id));
  const needsTitle = () => {
    const t = $('#folTitle').value.trim();
    if (!t) { $('#folTitle').focus(); toast('a folio needs a title'); return null; }
    if (!chosen.size && !chosenWays.size) { toast('nothing enclosed yet'); return null; }
    return t;
  };

  const paint = () => {
    body.innerHTML = `
      ${store.folios.length || kept ? `<button class="fol-back mono" id="folBack">‹ the shelf</button>` : ''}
      <div class="fol-field"><input class="fol-title" id="folTitle" placeholder="Lisbon, the good part" value="${esc(title)}" maxlength="80" aria-label="The folio's title"></div>
      <div class="fol-field"><input class="fol-ded" id="folDed" placeholder="for whom, and why. one line" value="${esc(dedication)}" maxlength="140" aria-label="Its dedication"></div>
      <div class="fol-count">${cap
        ? `${chosen.size} of ${cap} chosen`
        : `${chosen.size + chosenWays.size} of ${pool.length + wayPool.length} enclosed`}</div>
      ${pool.map(p => `
        <button class="fol-row" data-fid="${esc(p.id)}" aria-pressed="${chosen.has(p.id)}">
          <span class="in">${chosen.has(p.id) ? 'in' : 'out'}</span>
          <span class="nm">${esc(p.name)}</span>
          <span class="sub">${esc(p.city || '')}</span>
        </button>`).join('')}
      ${wayPool.length ? wayPool.map(r => `
        <button class="fol-row" data-wid="${esc(r.id)}" aria-pressed="${chosenWays.has(r.id)}">
          <span class="in">${chosenWays.has(r.id) ? 'in' : 'out'}</span>
          <span class="nm">${esc(r.name)}</span>
          <span class="sub">${esc(fmtKm(r.km))}${Number.isFinite(r.ascent) ? ` · ${r.ascent} m up` : ''}</span>
        </button>`).join('') : ''}
      <div class="fol-acts">
        ${cap ? '' : `<button class="word-btn" id="folKeep">${kept ? 'keep the changes' : 'keep this folio'}</button>`}
        <button class="word-btn${cap ? '' : ' quiet'}" id="folCopy">${cap ? 'send them back' : 'hand it over as a link'}</button>
        ${cap ? '' : '<button class="word-btn quiet" id="folPublish">offer it to the newsstand</button>'}
        ${cap ? '' : '<button class="word-btn quiet" id="folPrint">print, or save as pdf</button>'}
        ${cap ? '' : '<button class="word-btn quiet" id="folAll">everything in</button>'}
        <button class="word-btn quiet" id="folNone">${cap ? 'start over' : 'everything out'}</button>
        ${kept && !cap ? '<button class="word-btn quiet" id="folRemove">remove from the shelf</button>' : ''}
      </div>
      ${kept?.offeredAt ? `<div class="news-note">offered to the newsstand ${fmtDate(kept.offeredAt).toLowerCase()}. a folio comes down the way it went up: <button class="word-btn quiet" id="folRetract" style="display:inline">ask for its removal</button></div>` : ''}
      <div class="news-note">Keeping shares nothing: the folio stays here, and follows your atlas as it
      improves. A link carries a copy of what is enclosed today, without photographs.</div>`;

    $('#folBack')?.addEventListener('click', () => { openFolioShelf(); });
    $$('.fol-row', body).forEach(row => row.addEventListener('click', () => {
      readHead();
      const pid = row.dataset.fid, wid = row.dataset.wid;
      if (pid && cap && !chosen.has(pid) && chosen.size >= cap) {
        return toast(`three is the ask. take one out to put another in`);
      }
      if (pid) chosen.has(pid) ? chosen.delete(pid) : chosen.add(pid);
      if (wid) chosenWays.has(wid) ? chosenWays.delete(wid) : chosenWays.add(wid);
      paint();
    }));
    $('#folAll')?.addEventListener('click', () => {
      readHead();
      pool.forEach(p => chosen.add(p.id));
      wayPool.forEach(r => chosenWays.add(r.id));
      paint();
    });
    $('#folNone').addEventListener('click', () => {
      readHead();
      chosen.clear();
      chosenWays.clear();
      paint();
    });

    $('#folKeep')?.addEventListener('click', () => {
      const t = needsTitle();
      if (!t) return;
      const patch = {
        title: t,
        dedication: $('#folDed').value.trim(),
        placeIds: [...chosen],
        routeIds: [...chosenWays],
      };
      const saved = kept ? store.updateFolio(kept.id, patch) : store.addFolio(newFolio(patch));
      if (!saved) return toast('this browser refused to keep it');
      toast(kept ? 'kept' : 'on your shelf now. yours until you hand it over');
      openFolioComposer({ folioId: saved.id });
    });

    $('#folCopy').addEventListener('click', async () => {
      const t = needsTitle();
      if (!t) return;
      const author = await ensureAuthor();
      const sel = selection();
      const tagIds = new Set(sel.flatMap(p => p.tags));
      const url = makeFolioUrl({
        title: t,
        dedication: $('#folDed').value.trim(),
        author,
        tags: allTags().filter(x => tagIds.has(x.id)),
        places: sel,
        routes: wraySelection(),
      });
      if (url.length > LINK_HARD_LIMIT) {
        return toast('this folio is too long to travel as one link. fewer places, or print it');
      }
      handOver(url, 'the folio', {
        title: t,
        text: `${t}${author ? `, a folio from ${author}` : ', a folio'}`,
      });
    });
    $('#folPrint')?.addEventListener('click', () => {
      const t = needsTitle();
      if (!t) return;
      printSheet({
        title: t,
        dedication: $('#folDed').value.trim(),
        places: selection(),
        routes: wraySelection(),
      });
    });
    $('#folPublish')?.addEventListener('click', async () => {
      const t = needsTitle();
      if (!t) return;
      const author = await ensureAuthor();
      const block = '```json\n' + publishBlock(t, $('#folDed').value.trim(), author, selection()) + '\n```';
      try { await navigator.clipboard.writeText(block); } catch { return prompt('Copy this, then paste it into the issue:', block); }
      const issueUrl = 'https://github.com/jonashertner/resonate-commons/issues/new'
        + '?title=' + encodeURIComponent('folio: ' + t)
        + '&body=' + encodeURIComponent('Paste the folio below this line. It is already on your clipboard.\n\n');
      window.open(issueUrl, '_blank', 'noopener');
      if (kept) { store.updateFolio(kept.id, { offeredAt: new Date().toISOString() }); }
      toast('on your clipboard. paste it in and submit, and a person reads it before it goes up');
    });
    $('#folRetract')?.addEventListener('click', () => {
      const subject = `take down: ${kept.title}`;
      const bodyTx = 'please take this folio off the stand.';
      const issue = 'https://github.com/jonashertner/resonate-commons/issues/new'
        + '?title=' + encodeURIComponent(subject)
        + '&body=' + encodeURIComponent(bodyTx);
      window.open(issue, '_blank', 'noopener');
    });
    $('#folRemove')?.addEventListener('click', () => {
      if (!confirm(`Take “${kept.title}” off the shelf? The places themselves stay in your atlas.${kept.offeredAt ? ' A copy offered to the newsstand stays there until you ask for its removal.' : ''}`)) return;
      store.removeFolio(kept.id);
      toast('off the shelf. every place is still yours');
      openFolioShelf();
    });
  };
  paint();
  openSurface('folioOverlay');
}

// filing a place into a folio, from the place itself: the gesture a library
// grows by. one tap for the shelf, one for the folio.
function fileIntoFolio(placeId) {
  const body = $('#folioBody');
  const rows = store.folios.map(f => {
    const inIt = f.placeIds.includes(placeId);
    return `<button class="fol-row" data-file="${esc(f.id)}" aria-pressed="${inIt}">
      <span class="in">${inIt ? 'in' : 'out'}</span>
      <span class="nm">${esc(f.title)}</span>
      <span class="sub">${f.placeIds.length + f.routeIds.length} enclosed</span>
    </button>`;
  }).join('');
  body.innerHTML = `
    <div class="fol-count">file “${esc(placeById(placeId)?.name || '')}” into</div>
    ${rows || '<div class="news-note">no folios on the shelf yet.</div>'}
    <div class="fol-acts">
      <button class="word-btn quiet" id="folNewWith">a new folio, starting with it</button>
    </div>`;
  $$('[data-file]', body).forEach(b => b.addEventListener('click', () => {
    const f = store.folioById(b.dataset.file);
    const has = f.placeIds.includes(placeId);
    const saved = store.updateFolio(f.id, {
      placeIds: has ? f.placeIds.filter(x => x !== placeId) : [...f.placeIds, placeId],
    });
    if (!saved) return toast('this browser refused to keep it');
    toast(has ? `out of “${f.title}”` : `into “${f.title}”`);
    fileIntoFolio(placeId);
  }));
  $('#folNewWith').addEventListener('click', () => {
    openFolioComposer({ fresh: true, preselect: [placeId] });
  });
  openSurface('folioOverlay');
}

async function composeAsk() {
  const q = prompt('Ask for… (a city, a taste, anything)', '');
  if (!q || !q.trim()) return;
  const from = await ensureAuthor();
  const url = makeAskUrl({ from, q: q.trim() });
  handOver(url, 'the ask', { title: `an ask from ${from}`, text: `${from} asks: ${q.trim()}` });
}

// ---------- the sheet: the atlas typeset for paper, or pdf ----------

const DOC_TITLE = document.title;

function buildSheet({ title, dedication = '', author = store.settings.authorName, places, routes = [], tagName = null }) {
  const nameOf = tagName || ((id) => tagById(id)?.name);
  const groups = new Map();
  places.forEach(p => {
    const key = [p.city, p.country].filter(Boolean).join(', ') || 'off the map';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });
  const nWays = routes.length;
  const signed = [
    author ? `kept by ${author}` : '',
    fmtDate(new Date().toISOString()).toLowerCase(),
    places.length ? `${places.length} place${places.length === 1 ? '' : 's'}` : '',
    nWays ? `${nWays} way${nWays === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');

  let no = 0;
  const entry = (p) => {
    no += 1;
    const meta = [
      p.tags.map(nameOf).filter(Boolean).join(', ').toLowerCase(),
      datumWord(p),
    ].filter(Boolean).join(' · ');
    return `<article class="sh-entry">
      <div class="sh-line"><span class="sh-no mono">${fmtNo(no)}</span><h3 class="sh-name">${esc(p.name)}</h3></div>
      ${meta ? `<div class="sh-meta">${esc(meta)}</div>` : ''}
      ${p.note ? `<p class="sh-note">${esc(p.note).replace(/\n/g, '<br>')}</p>` : ''}
      <div class="sh-coords mono">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
    </article>`;
  };

  const ways = routes.map((r, i) => {
    const pf = profile(r.path, { width: 1000, height: 150, columns: 96 });
    const meta = [
      fmtKm(r.km),
      Number.isFinite(r.ascent) ? `${r.ascent} m up` : '',
      fmtHours(r.hours),
      r.loop ? 'a loop' : '',
    ].filter(Boolean).join(' · ');
    return `<article class="sh-entry">
      <div class="sh-line"><span class="sh-no mono">${r.loop ? 'O' : '/'}</span><h3 class="sh-name">${esc(r.name)}</h3></div>
      <div class="sh-meta">${esc(meta)}</div>
      ${r.note ? `<p class="sh-note">${esc(r.note).replace(/\n/g, '<br>')}</p>` : ''}
      ${pf ? `<div class="sh-profile">${profileSVG(pf)}</div>` : ''}
    </article>`;
  }).join('');

  $('#sheet').innerHTML = `
    <header class="sh-head">
      <div class="sh-mast mono">resonate</div>
      <h1 class="sh-title">${esc(title)}</h1>
      ${dedication ? `<p class="sh-ded">${esc(dedication)}</p>` : ''}
      <div class="sh-signed mono">${esc(signed)}</div>
    </header>
    ${[...groups.entries()].map(([city, list]) =>
      `${groups.size > 1 || city !== 'off the map' ? `<h2 class="sh-city mono">${esc(city.toLowerCase())}</h2>` : ''}
       ${list.map(entry).join('')}`).join('')}
    ${ways ? `<h2 class="sh-city mono">ways</h2>${ways}` : ''}
    <footer class="sh-colophon mono">resonate · resonate.select</footer>`;
}

function atlasSheetOpts() {
  const author = store.settings.authorName;
  return {
    title: author ? `the atlas of ${author}` : 'an atlas',
    places: filteredPlaces(),
    routes: filteredRoutes(),
  };
}

function printSheet(opts) {
  if (!opts.places.length && !(opts.routes || []).length) return toast('nothing to print yet');
  buildSheet(opts);
  document.title = `resonate · ${opts.title}`;
  window.print();
}

// the system print command should never catch the raw map: typeset first
window.addEventListener('beforeprint', () => {
  if (!$('#sheet').innerHTML) buildSheet(atlasSheetOpts());
});
window.addEventListener('afterprint', () => {
  $('#sheet').innerHTML = '';
  document.title = DOC_TITLE;
});

// ---------- the newsstand: the commons, ranked by your own resonance ----------

const COMMONS = 'https://jonashertner.github.io/resonate-commons';
let newsIndex = null;

function myDomainNames() {
  return new Set(allTags().map(t => t.name.toLowerCase()));
}
function myCityNames() {
  return new Set(allPlaces().map(p => (p.city || '').toLowerCase()).filter(Boolean));
}

function rankFolios(index, q) {
  const needle = q.trim().toLowerCase();
  const domains = myDomainNames();
  const cities = myCityNames();
  return index
    .map(f => {
      const hay = [f.title, f.author, f.dedication, ...(f.cities || []), ...(f.countries || []), ...(f.tags || [])].join(' ').toLowerCase();
      if (needle && !hay.includes(needle)) return null;
      const sharedDomains = (f.tags || []).filter(t => domains.has(t.toLowerCase()));
      const knownCities = (f.cities || []).filter(c => cities.has(c.toLowerCase()));
      const why = knownCities.length ? `your ${knownCities[0].toLowerCase()}`
        : sharedDomains.length ? `${sharedDomains.length} shared domain${sharedDomains.length > 1 ? 's' : ''}`
        : 'new ground';
      const score = (needle ? 1 : 0) + knownCities.length * 0.8 + sharedDomains.length * 0.45 +
        (Date.parse(f.publishedAt) || 0) / 1e15;
      return { f, why, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

async function openNewsstand(initialQ = '') {
  openSurface('newsOverlay');
  const body = $('#newsBody');
  body.innerHTML = `<div class="news-note">consulting the newsstand…</div>`;
  if (!newsIndex) {
    try {
      newsIndex = normIndex(await (await fetch(`${COMMONS}/index.json`, { cache: 'no-cache' })).json());
    } catch {
      body.innerHTML = `<div class="news-note">the newsstand is unreachable right now. try again with a connection.</div>`;
      return;
    }
  }
  const paint = (q) => {
    const ranked = rankFolios(newsIndex, q);
    body.innerHTML = `
      <input class="news-search" id="newsQ" placeholder="a city, a taste, a name…" value="${esc(q)}">
      ${ranked.length ? ranked.map(({ f, why }) => `
        <button class="news-row" data-file="${esc(f.file)}">
          <span class="t1"><span class="nm">${esc(f.title)}</span><span class="by">${esc(f.author)} · ${f.n}</span></span>
          <span class="t2">
            ${(f.cities || []).slice(0, 3).map(c => `<span>${esc(c)}</span>`).join('')}
            <span class="why">${esc(why)}</span>
          </span>
        </button>`).join('')
      : `<div class="news-note">nothing on the stand answers “${esc(q)}” yet. offer the folio that should.</div>`}
      <div class="news-note">Ranking happens here, against your own atlas. The newsstand never learns what you like.
      Publish from any folio you compose (&gt;folio).</div>`;
    const input = $('#newsQ');
    input.addEventListener('input', debounce(() => paint(input.value), 250));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    $$('.news-row', body).forEach(row => row.addEventListener('click', async () => {
      if (row.classList.contains('busy')) return;
      row.classList.add('busy');
      row.setAttribute('aria-busy', 'true');
      try {
        const rec = await (await fetch(`${COMMONS}/folios/${row.dataset.file}`, { cache: 'no-cache' })).json();
        // the commons keeps domains by name; give them ids so an adopted
        // place can carry its domains home
        const names = [...new Set((rec.places || [])
          .flatMap(p => (Array.isArray(p.tags) ? p.tags : []))
          .filter(n => typeof n === 'string' && n.trim()))].slice(0, 24);
        const idOf = new Map(names.map((n, i) => [n, `cf${i}`]));
        const payload = normPayload({
          v: SCHEMA_VERSION,
          kind: 'folio',
          title: rec.title,
          dedication: rec.dedication,
          author: rec.author,
          tags: names.map(n => ({ id: idOf.get(n), name: n })),
          places: (rec.places || []).map(p => ({
            ...p,
            tags: (Array.isArray(p.tags) ? p.tags : []).map(n => idOf.get(n)).filter(Boolean),
          })),
        });
        if (!payload) { toast('that folio did not read as a folio'); return; }
        closeSurface('newsOverlay');
        openFolioReport(payload);
      } catch { toast('could not open that folio'); }
      finally { row.classList.remove('busy'); row.removeAttribute('aria-busy'); }
    }));
  };
  paint(initialQ);
}

function publishBlock(title, dedication, author, sel) {
  const tagName = new Map(allTags().map(t => [t.id, t.name]));
  return JSON.stringify({
    title, dedication, author,
    places: sel.map(p => ({
      name: p.name, lat: p.lat, lng: p.lng, address: p.address, city: p.city,
      country: p.country, tags: p.tags.map(t => tagName.get(t)).filter(Boolean),
      status: p.status, note: p.note,
    })),
  }, null, 1);
}

function queryMyAtlas(q) {
  const needle = q.toLowerCase();
  const words = needle.split(/[\s,]+/).filter(Boolean);
  return allPlaces().filter(p => {
    const hay = [p.name, p.city, p.country, p.note, ...p.tags.map(t => tagById(t)?.name || '')].join(' ').toLowerCase();
    return words.some(w => hay.includes(w));
  });
}

// ---------- share ----------

// a link is a disclosure: it is read before it is made, never after.
// long fragments break in messaging apps and histories long before a browser
// refuses them, so a large atlas is offered as a file instead.
const LINK_SOFT_LIMIT = 8000;
const LINK_HARD_LIMIT = 16000;

function handOver(url, what, { title = '', text = '' } = {}) {
  const send = async () => {
    // where a system sheet exists it is the one true door: mail, whatsapp,
    // messages, whatever the device holds, chosen by its owner
    if (navigator.share) {
      try {
        await navigator.share(title || text ? { title, text, url } : { url });
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    // no sheet: the link is copied when the device allows, and the two
    // rails stand at the foot either way
    let copied = true;
    try { await navigator.clipboard.writeText(url); } catch { copied = false; }
    raiseHandBar(url, what, { title, text, copied });
  };
  send();
}

function raiseHandBar(url, what, { title = '', text = '', copied = true } = {}) {
  const bar = $('#handBar');
  $('#hbCopied').textContent = copied ? `${what} copied` : what;
  const cp = $('#hbCopy');
  cp.hidden = copied;
  cp.onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      $('#hbCopied').textContent = `${what} copied`;
      cp.hidden = true;
    } catch { window.prompt('Copy this:', url); }
  };
  $('#hbMail').href = 'mailto:?subject=' + encodeURIComponent(title || what)
    + '&body=' + encodeURIComponent((text ? text + '\n\n' : '') + url);
  $('#hbWa').href = 'https://wa.me/?text=' + encodeURIComponent((text ? text + '\n' : '') + url);
  // some desktop mail clients cut a body around two thousand characters;
  // said here, once, rather than discovered in a broken paste
  $('#hbNote').hidden = url.length <= 1800;
  bar.hidden = false;
  clearTimeout(raiseHandBar.t);
  raiseHandBar.t = setTimeout(() => { bar.hidden = true; }, 14000);
}

async function shareMap() {
  const places = sharablePlaces();
  const kept = allPlaces().length - places.length;
  if (!places.length) return toast(kept ? 'every place here is marked as never leaving' : 'nothing to hand over yet');
  const author = await ensureAuthor();
  const routes = allRoutes();
  const url = makeShareUrl(allTags(), places, author, routes);
  const bytes = url.length;
  const withNotes = places.filter(p => p.note).length;
  const withLinks = places.filter(p => p.url).length;
  const tooLong = bytes > LINK_HARD_LIMIT;
  const long = bytes > LINK_SOFT_LIMIT;

  const body = $('#shareBody');
  body.innerHTML = `
    <div class="sh-what">
      <div class="sec-head">what travels</div>
      <ul class="sh-list">
        <li><b>${places.length}</b> place${places.length === 1 ? '' : 's'}: names and coordinates</li>
        ${routes.length ? `<li><b>${routes.length}</b> way${routes.length === 1 ? '' : 's'}: the whole line walked, and its climb</li>` : ''}
        <li>addresses, cities, countries, tags, been or want to go</li>
        ${withNotes ? `<li><b>${withNotes}</b> note${withNotes === 1 ? '' : 's'}, in full</li>` : ''}
        ${withLinks ? `<li><b>${withLinks}</b> link${withLinks === 1 ? '' : 's'} you saved</li>` : ''}
        <li>${author ? `byline <b>${esc(author)}</b>` : 'no byline'}</li>
      </ul>
      <div class="sec-head">what stays</div>
      <ul class="sh-list">
        <li>your photographs. they never leave this device, by link or by file.</li>
        <li>your voices, and everything under yours.</li>
      </ul>
      <p class="sh-warn">Anyone holding this link can read all of it. There is no undo:
      a link cannot be recalled once it is sent.</p>
      ${kept ? `<p class="sh-warn">${kept} place${kept === 1 ? '' : 's'} marked <b>never leaves</b> stay${kept === 1 ? 's' : ''} behind. Mark any place that way from its own plate.</p>` : ''}
      <p class="sh-size mono">${(bytes / 1024).toFixed(1)} kB of link${long ? ' · long enough that some apps will break it' : ''}</p>
    </div>
    <div class="word-row">
      <button class="word-btn" id="shFolio">compose a folio</button>
      ${tooLong ? '' : '<button class="word-btn quiet" id="shGo">hand over the whole atlas</button>'}
      <button class="word-btn quiet" id="shFile">send it as a file</button>
    </div>
    ${tooLong ? '<p class="sh-warn">This atlas is too long to travel as a link. Hand over a folio, or send the file.</p>' : ''}`;

  $('#shGo')?.addEventListener('click', () => {
    closeSurface('shareOverlay');
    handOver(url, 'your atlas', {
      title: author ? `the atlas of ${author}` : 'an atlas',
      text: author ? `${author} hands you their atlas` : 'an atlas, handed to you',
    });
  });
  $('#shFolio').addEventListener('click', () => { closeSurface('shareOverlay'); openFolioComposer(); });
  $('#shFile').addEventListener('click', () => {
    closeSurface('shareOverlay');
    // the same promise as the link: no photographs, no voices, no settings
    download('resonate-atlas.json', store.exportShareJSON(), 'application/json');
    toast('a file of the same places. your photos stayed here');
  });
  openSurface('shareOverlay');
}

// ---------- posters: census & kept ----------

function renderStats() {
  const body = $('#statsBody');
  const places = allPlaces();
  const visited = places.filter(p => p.status === 'visited');
  const wish = places.filter(p => p.status === 'wishlist');
  const countries = new Map();
  const cities = new Set();
  places.forEach(p => {
    if (p.country) countries.set(p.country, (countries.get(p.country) || 0) + 1);
    if (p.city) cities.add(p.city);
  });
  if (!places.length) {
    body.innerHTML = `<p class="stat-opening">nothing counted yet. <em>the field is waiting.</em></p>`;
    return;
  }
  const tagRows = allTags()
    .map(t => ({ t, n: places.reduce((k, p) => k + (p.tags.includes(t.id) ? 1 : 0), 0) }))
    .filter(r => r.n > 0).sort((a, b) => b.n - a.n);
  const countryList = [...countries.entries()].sort((a, b) => b[1] - a[1]);

  body.innerHTML = `
    <p class="stat-opening">${places.length} places across ${countries.size} countr${countries.size === 1 ? 'y' : 'ies'}.
      ${visited.length} been, <em>${wish.length} still to go.</em></p>
    <div class="stat-band">
      <div class="stat-cell"><div class="stat-num">${places.length}</div><div class="stat-lbl">places</div></div>
      <div class="stat-cell"><div class="stat-num">${countries.size}</div><div class="stat-lbl">countries</div></div>
      <div class="stat-cell"><div class="stat-num">${cities.size}</div><div class="stat-lbl">cities</div></div>
    </div>
    ${tagRows.length ? `<div class="sec-head">by tag</div>
      ${tagRows.map(({ t, n }) => `<div class="tally"><span class="name">${esc(t.name)}</span><span class="n">${n}</span></div>`).join('')}` : ''}
    ${countryList.length ? `<div class="sec-head">countries</div>
      <div class="country-cols">${countryList.map(([c, n]) => `<div class="tally"><span class="name">${esc(c)}</span><span class="n">${n}</span></div>`).join('')}</div>` : ''}
    <div class="sec-head">kept where</div>
    <div class="set-row-sub mono" id="statKept">counting…</div>`;
  paintKept('#statKept');
}

// what this browser is holding, and whether it has promised to keep it
async function keptWhere() {
  const bytes = (await photoStore.estimate())?.used ?? null;
  const promised = await photoStore.persisted();
  const mb = bytes === null ? null : (bytes / 1_048_576).toFixed(bytes > 10_485_760 ? 0 : 1);
  const last = store.settings.lastExportAt;
  return [
    `${store.places.length} place${store.places.length === 1 ? '' : 's'}`,
    store.routes.length ? `${store.routes.length} way${store.routes.length === 1 ? '' : 's'}` : '',
    store.folios.length ? `${store.folios.length} folio${store.folios.length === 1 ? '' : 's'}` : '',
    store.correspondents.length ? `${store.correspondents.length} voice${store.correspondents.length === 1 ? '' : 's'}` : '',
    mb === null ? '' : `${mb} mb here`,
    promised === true ? 'the browser has promised to keep it'
      : promised === false ? 'no promise from the browser yet' : '',
    last ? `last exported ${fmtDate(last).toLowerCase()}` : 'never exported',
  ].filter(Boolean).join(' · ');
}

function paintKept(sel) {
  keptWhere().then(line => { const el = $(sel); if (el) el.textContent = line; });
}

// yours: the byline and the data, nothing else
function renderSettings() {
  const body = $('#settingsBody');
  body.innerHTML = `
    <div class="set-sec">
      <div class="sec-head">your byline</div>
      <div class="set-row">
        <div class="set-row-sub">This name rides as the byline on what you hand over. A typed name, nothing more.</div>
        <input class="text-input" id="authorName" style="max-width:220px" placeholder="no byline" value="${esc(store.settings.authorName)}">
      </div>
    </div>

    <div class="set-sec">
      <div class="sec-head">your data</div>
      <div class="word-row">
        <button class="word-btn quiet" id="expJson">export everything</button>
        <button class="word-btn quiet" id="expGeo">export geojson</button>
        <button class="word-btn quiet" id="expPdf">print, or save as pdf</button>
        <button class="word-btn quiet" id="impJson">import</button>
        <button class="word-btn quiet" id="eraseAll">erase this atlas</button>
      </div>
      <div class="set-row-sub" style="margin-top:10px">Everything lives in this browser. <b>Export everything</b> is your backup: it carries your photographs, your voices and your settings, so keep it to yourself. A file handed to someone else, from <b>hand over</b>, carries none of those.</div>
    </div>

    <div class="set-sec">
      <div class="sec-head">kept where</div>
      <div class="set-row-sub mono" id="setKept">counting…</div>
      <div class="word-row" style="margin-top:14px">
        <button class="word-btn quiet" id="snapRestore">the snapshots on this device</button>
      </div>
      <div class="set-row-sub" style="margin-top:10px">This device keeps its three most recent snapshots of the records, taken quietly as you work. Photographs are not in them; they are already kept apart. A snapshot brings back what it holds and this atlas lacks, and deletes nothing.</div>
    </div>`;
  paintKept('#setKept');

  $('#snapRestore').addEventListener('click', async () => {
    const keys = (await photoStore.snapshotKeys()) || [];
    if (!keys.length) return toast('no snapshot has been taken on this device yet');
    const newest = keys.sort().reverse();
    const when = newest.map(k => fmtDate(k).toLowerCase());
    const pick = prompt(`Snapshots on this device:\n${when.map((w, i) => `${i + 1}. ${w}`).join('\n')}\n\nBring home which one? Nothing is deleted.`, '1');
    const i = parseInt(pick, 10) - 1;
    if (!Number.isFinite(i) || i < 0 || i >= newest.length) return;
    const rec = await photoStore.snapshotGet(newest[i]);
    if (!rec?.json) return toast('that snapshot could not be read');
    let brought = null;
    try { brought = store.merge(await absorbPhotos(JSON.parse(rec.json))); }
    catch { return toast('that snapshot could not be read'); }
    if (brought === null) return toast('this device refused the merge; nothing changed');
    if (brought) renderAll();
    toast(brought ? `${brought} record${brought === 1 ? '' : 's'} came home from ${when[i]}` : 'that snapshot holds nothing this atlas lacks');
  });

  $('#authorName').addEventListener('change', (e) => {
    store.settings.authorName = e.target.value.trim();
    store.saveSettings();
  });
  $('#expJson').addEventListener('click', async () => {
    const { json, misses } = await fullExport();
    download('resonate-atlas.json', json, 'application/json');
    store.settings.lastExportAt = new Date().toISOString(); store.saveSettings();
    paintKept('#setKept');
    if (misses) toast(`${misses} photograph${misses === 1 ? '' : 's'} could not be read back and are not in this file`, 6000);
  });
  $('#expGeo').addEventListener('click', () => download('resonate-atlas.geojson', store.exportGeoJSON(), 'application/geo+json'));
  $('#expPdf').addEventListener('click', () => printSheet(atlasSheetOpts()));
  $('#impJson').addEventListener('click', () => {
    const file = $('#importFile');
    file.onchange = () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = await absorbPhotos(JSON.parse(reader.result));
          const added = store.merge(data);
          renderSettings(); renderAll();
          if (store.places.length) mapView.fitAll(store.places);
          toast(added ? `${added} place${added === 1 ? '' : 's'} imported` : 'nothing new to import');
        } catch { toast('that file isn’t a resonate export'); }
      };
      reader.readAsText(f);
    };
    file.click();
  });
  $('#eraseAll').addEventListener('click', async () => {
    if (!confirm('Erase every place and tag in this atlas? Export first if you want a keepsake.')) return;
    if (!confirm('Gone means gone here. Links sent, files exported, and envelopes at the club are not reached; the club key is kept so a backup can come home. Really erase?')) return;
    store.clearAll();
    await photoStore.clear();
    state.selectedId = null;
    state.foreign = null;
    state.visiting = null;
    state.filters.tags.clear();
    closeSurface('settingsOverlay');
    pushCorrespondentsToMap();
    applyWorldState();
    renderAll();
    toast('the field is blank again');
  });
}

// tags: the domains of your taste, kept on their own page
function renderTags() {
  const body = $('#tagsBody');
  body.innerHTML = `
    <div class="tag-rows">
      ${store.tags.map(t => `
        <div class="tally" data-tid="${esc(t.id)}">
          <span class="name">${esc(t.name)}</span>
          <button class="word-btn quiet" data-rename>rename</button>
          <button class="word-btn quiet" data-del>remove</button>
          <span class="n">${store.tagCount(t.id)}</span>
        </div>`).join('')}
    </div>
    <div class="tag-add">
      <input class="text-input" id="tagName" placeholder="new tag name">
      <div class="hue-stations" id="tagHues">
        ${TAG_STATIONS.map((s, i) => `<button data-hue="${s.hue}" data-hex="${s.hex}" aria-pressed="${i === 4}">${s.name}</button>`).join('')}
      </div>
      <button class="word-btn" id="tagAdd">add the tag</button>
    </div>`;

  let picked = TAG_STATIONS[4];
  $('#tagHues').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hue]');
    if (!b) return;
    picked = { hue: parseInt(b.dataset.hue, 10), hex: b.dataset.hex };
    $$('#tagHues button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  $('#tagAdd').addEventListener('click', () => {
    const name = $('#tagName').value.trim();
    if (!name) return $('#tagName').focus();
    const made = store.addTag(newTag({ name, hue: picked.hue, color: picked.hex }));
    if (!made) return;
    renderTags(); renderChips();
    toast(`tag “${name}” added`);
  });
  $('#tagName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#tagAdd').click(); });

  $('.tag-rows', body).addEventListener('click', (e) => {
    const row = e.target.closest('[data-tid]');
    if (!row) return;
    const id = row.dataset.tid;
    const tag = store.tagById(id);
    if (e.target.closest('[data-del]')) {
      const n = store.tagCount(id);
      if (!confirm(`Remove tag “${tag.name}”${n ? ` from ${n} place${n === 1 ? '' : 's'}` : ''}? The places keep their other tags.`)) return;
      store.removeTag(id);
      renderTags(); renderAll();
    }
    if (e.target.closest('[data-rename]')) {
      const name = prompt('Tag name', tag.name);
      if (name === null) return;
      store.updateTag(id, { name: name.trim() || tag.name });
      renderTags(); renderAll();
    }
  });
}

function renderKeys() {
  const rows = [
    ['/', 'command line'], ['⌘K', 'command line'], ['i', 'the index'],
    ['j · k', 'next · previous place'], ['esc', 'close one surface'],
    ['+ · −', 'zoom'], ['0', 'frame everything'], ['t', 'day / night'],
    ['g', 'find me'], ['s', 'share this atlas'], ['1–9', 'toggle tag worlds'],
    ['right-click', 'propose a place'], ['drop a photo', 'file it by its own fix'],
    ['drop a gpx', 'a walk becomes a way'],
  ];
  $('#keysBody').innerHTML = `<div class="keys-grid">
    ${rows.map(([k, d]) => `<div class="key-row"><kbd>${k}</kbd><span>${d}</span></div>`).join('')}
  </div>`;
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- the command line ----------

const palette = { input: null, results: null, hl: 0, rows: [], remoteAbort: null };

// ---------- the travellers club ----------
//
// The one rule, said everywhere it matters: the envelope is sealed on this
// device before it travels, and the phrase never leaves. The club is a
// keeper of bytes it cannot read.

const clubBase = () => store.settings.clubUrl || CLUB_URL;
const clubClient = () => makeClient(clubBase(), () => store.settings.clubKey);

function renderClub() {
  const body = $('#clubBody');
  const key = store.settings.clubKey;

  if (!clubBase()) {
    body.innerHTML = `
      <div class="set-sec">
        <p class="ce-law">The door is not open yet.</p>
        <div class="set-row-sub" style="max-width:52ch">When it opens, membership will keep a sealed backup of your whole atlas, photographs included, and carry it to your other devices. Sealed here, with a phrase only you know. The club will never be able to read what it keeps.</div>
      </div>`;
    return;
  }

  if (!key) {
    body.innerHTML = `
      <div class="set-sec">
        <div class="sec-head">join</div>
        ${JOIN_URL ? `<div class="word-row"><a class="word-btn" href="${esc(JOIN_URL)}" rel="noopener">become a member</a></div>
        <div class="set-row-sub" style="margin-top:10px">One subscription. On the other side of the door you are handed a key, once.</div>`
        : `<div class="set-row-sub">The door is not open yet. If you already hold a key, it works below.</div>`}
      </div>
      <div class="set-sec">
        <div class="sec-head">already a member</div>
        <div class="set-row">
          <input class="text-input mono" id="clubKeyIn" style="max-width:320px" placeholder="tc_…" autocomplete="off" spellcheck="false" aria-label="Your membership key">
          <button class="word-btn quiet" id="clubKeyKeep">keep the key on this device</button>
        </div>
      </div>`;
    $('#clubKeyKeep').addEventListener('click', async () => {
      const v = $('#clubKeyIn').value.trim();
      if (/^cs_/.test(v)) {
        // a checkout session pasted whole: walk it through the door
        try {
          const got = await clubClient().door(v);
          store.settings.clubKey = got.key; store.saveSettings();
          toast('the door opened. your key is kept on this device');
          renderClub();
        } catch (e) { toast(String(e.message || 'the door did not answer')); }
        return;
      }
      if (!/^tc_[0-9a-z]{20,27}$/.test(v)) return toast('a key reads tc_ and then its letters');
      store.settings.clubKey = v; store.saveSettings();
      renderClub();
    });
    return;
  }

  body.innerHTML = `
    <div class="set-sec">
      <div class="sec-head">membership</div>
      <div class="set-row-sub mono" id="clubStanding">asking the club…</div>
      <div class="set-row-sub mono" style="margin-top:6px">${esc(key)}</div>
      <div class="set-row-sub" style="margin-top:6px">This is the key. Write it somewhere that is not this browser: it is how another device, or this one after an erase, reaches the vault.</div>
    </div>
    <div class="set-sec">
      <div class="sec-head">the envelope</div>
      <div class="set-row">
        <input class="text-input" type="password" id="clubPhrase" style="max-width:320px" placeholder="the sealing phrase. yours alone, never stored" autocomplete="off" aria-label="Sealing phrase">
      </div>
      <div class="word-row" style="margin-top:14px">
        <button class="word-btn" id="clubSync">sync now</button>
        <button class="word-btn quiet" id="clubPrev">the envelope before</button>
      </div>
      <div class="set-row-sub" id="clubMeta" style="margin-top:10px"></div>
      <div class="set-row-sub" style="margin-top:10px">Sync brings home what the envelope holds and this atlas lacks, then seals everything back. Nothing is deleted by sync. Lose the phrase and the envelope is lost with it; nobody can open it for you.</div>
    </div>
    <div class="set-sec">
      <div class="sec-head">leaving</div>
      <div class="word-row">
        <button class="word-btn quiet" id="clubBurn">the envelopes, gone</button>
        <button class="word-btn quiet" id="clubForget">forget the key on this device</button>
      </div>
    </div>`;

  (async () => {
    try {
      const m = await clubClient().membership();
      const until = m.until ? new Date(m.until * 1000).toISOString().slice(0, 10) : '';
      $('#clubStanding').textContent =
        m.standing === 'good' ? `in good standing${until ? ` until ${until}` : ''}${m.leaving ? '. leaving at the period’s end' : ''}`
        : m.standing === 'lapsed' ? 'lapsed. the envelope stays yours; renewing lets you seal again'
        : m.standing === 'left' ? 'the membership has ended. the envelope stays yours'
        : 'the club does not know this key';
      const got = await clubClient().getVault().catch(() => null);
      $('#clubMeta').textContent = got?.at ? `last sealed ${got.at.slice(0, 10)}, ${got.bytes.length.toLocaleString()} bytes` : 'nothing sealed yet';
    } catch { $('#clubStanding').textContent = 'the club did not answer'; }
  })();

  $('#clubSync').addEventListener('click', clubSync);
  $('#clubPrev').addEventListener('click', async () => {
    const phrase = $('#clubPhrase').value;
    if (phrase.length < 8) return toast('a sealing phrase of at least eight characters');
    const btn = $('#clubPrev');
    btn.disabled = true;
    try {
      const got = await clubClient().getVault(true);
      if (!got) return toast('the club keeps no envelope before this one');
      let text;
      try { text = await unseal(got.bytes, phrase, { bind: store.settings.clubKey }); }
      catch (e) {
        return toast(e.message === 'wrong-phrase' ? 'that phrase does not open this envelope'
          : e.message === 'sealed-for-another-key' ? 'this envelope was sealed under a different key'
          : e.message === 'this-device-cannot-open-it' ? 'the envelope is fine; this device cannot open it. a newer browser, or another device, can'
          : 'what the club holds is not an envelope');
      }
      let wrapper;
      try { wrapper = JSON.parse(text); } catch { return toast('the envelope opened but its content is unreadable'); }
      const atlas = wrapper.atlas ?? wrapper;
      const nHeld = (atlas.places?.length ?? 0) + (atlas.routes?.length ?? 0);
      const when = wrapper.sealedAt ? fmtDate(wrapper.sealedAt).toLowerCase() : 'before the last';
      if (!confirm(`The envelope before was sealed ${when} and holds ${nHeld} record${nHeld === 1 ? '' : 's'}. Bring home what it holds and this atlas lacks? Nothing here is deleted, and nothing is sealed until you sync.`)) return;
      const brought = store.merge(await absorbPhotos(atlas));
      if (brought === null) return toast('this device refused the merge; nothing changed');
      if (brought) renderAll();
      toast(brought ? `${brought} record${brought === 1 ? '' : 's'} came home from the envelope before` : 'this atlas already holds everything the envelope before does');
    } catch { toast('the vault did not answer'); }
    finally { btn.disabled = false; }
  });
  $('#clubBurn').addEventListener('click', async () => {
    if (!confirm('Burn both envelopes at the club? Your atlas here is untouched, and the key stays so you can seal again. If an envelope would not open on this device, burning still destroys it everywhere.')) return;
    try {
      await clubClient().delVault();
      // an emptied vault must be sealable again: the count starts over
      Object.assign(store.settings, burnPatch());
      store.saveSettings();
      toast('the envelopes are gone'); renderClub();
    }
    catch { toast('the vault did not answer'); }
  });
  $('#clubForget').addEventListener('click', () => {
    store.settings.clubKey = ''; store.settings.clubSeq = 0; store.settings.clubSealedAt = '';
    store.saveSettings();
    toast('forgotten here. the membership itself lives on');
    renderClub();
  });
}

async function clubSync() {
  const phrase = $('#clubPhrase').value;
  if (phrase.length < 8) return toast('a sealing phrase of at least eight characters');
  const btn = $('#clubSync');
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = 'sealing…';
  try {
    const c = clubClient();
    const got = await c.getVault();
    const lastSeq = Number(store.settings.clubSeq) || 0;

    // an empty answer over a vault this device has already sealed is not
    // trusted: it is a stale edge or a hollowed club, and pushing over it
    // would demote the real envelope. nothing is written on a doubt.
    if (syncGuard(!!got, lastSeq) === 'refuse-empty') {
      toast('the club answered empty, but something was sealed before. nothing written; try again shortly');
      return;
    }

    let brought = 0;
    let remoteSeq = 0;
    if (got) {
      let text;
      try { text = await unseal(got.bytes, phrase, { bind: store.settings.clubKey }); }
      catch (e) {
        toast(e.message === 'wrong-phrase' ? 'that phrase does not open this envelope'
          : e.message === 'sealed-for-another-key' ? 'this envelope was sealed under a different key'
          : e.message === 'this-device-cannot-open-it' ? 'the envelope is fine; this device cannot open it. a newer browser, or another device, can'
          : 'what the club holds is not an envelope');
        return;
      }
      // the envelope carries its own count. an older envelope than this
      // device has already seen is never sealed over.
      let wrapper;
      try { wrapper = JSON.parse(text); } catch {
        toast('the envelope opened but its content is unreadable. nothing written');
        return;
      }
      remoteSeq = Number(wrapper.seq) || 0;
      const atlas = wrapper.atlas ?? wrapper;
      if (remoteSeq < lastSeq) {
        toast('the club returned an older envelope than this device has seen. nothing written; try again shortly');
        return;
      }
      brought = store.merge(await absorbPhotos(atlas));
      if (brought === null) {
        // the device refused the write and rolled back: sealing now would
        // keep the poorer atlas. the promise on this panel holds.
        toast('this device refused the merge, so nothing was sealed over the envelope');
        return;
      }
      if (brought) renderAll();
    }

    const seq = Math.max(remoteSeq, lastSeq) + 1;
    const { json, misses } = await fullExport();
    if (misses) {
      // an envelope short of photographs must never replace one that has them
      toast(`${misses} photograph${misses === 1 ? '' : 's'} could not be read from this device, so nothing was sealed`, 7000);
      return;
    }
    const sealed = await seal(JSON.stringify({
      v: 2, seq, sealedAt: new Date().toISOString(), atlas: JSON.parse(json),
    }), phrase, { bind: store.settings.clubKey });
    const meta = await c.putVault(sealed);
    store.settings.clubSeq = seq;
    store.settings.clubSealedAt = meta.at;
    store.saveSettings();
    $('#clubMeta').textContent = `last sealed ${meta.at.slice(0, 10)}, ${meta.bytes.toLocaleString()} bytes, ${sealed[5] === 2 ? 'argon2id' : 'pbkdf2'}`;
    toast(brought
      ? `${brought} place${brought === 1 ? '' : 's'} came home. everything sealed and kept`
      : 'sealed and kept');
  } catch (e) {
    toast(e.message === 'lapsed' ? 'the membership has lapsed. renewing lets you seal again'
      : e.message === 'too-large' ? 'the atlas is too large for one envelope'
      : 'the club did not answer');
  } finally {
    btn.disabled = false; btn.textContent = 'sync now';
  }
}

const VERBS = {
  share: { run: shareMap, hint: 'hand your atlas to someone' },
  census: { run: () => openSurface('statsOverlay', renderStats), hint: 'the story so far' },
  stats: { run: () => openSurface('statsOverlay', renderStats), hint: 'the story so far' },
  yours: { run: () => openSurface('settingsOverlay', renderSettings), hint: 'your byline, your data, erase' },
  kept: { run: () => openSurface('settingsOverlay', renderSettings), hint: 'your byline, your data, erase' },
  settings: { run: () => openSurface('settingsOverlay', renderSettings), hint: 'your byline, your data, erase' },
  tags: { run: () => openSurface('tagsOverlay', renderTags), hint: 'the domains of your taste' },
  voices: { run: () => openSurface('corrOverlay', renderVoices), hint: 'the atlases you keep' },
  club: { run: () => openSurface('clubOverlay', renderClub), hint: 'the travellers club. backup and sync, sealed' },
  keys: { run: () => openSurface('keysOverlay', renderKeys), hint: 'the keyboard' },
  frame: { run: () => mapView.fitAll(filteredPlaces()), hint: 'fit everything in view' },
  locate: { run: () => mapView.locate(null, () => toast('location unavailable')), hint: 'find me' },
  dark: { run: () => setTheme('dark'), hint: 'night field' },
  light: { run: () => setTheme('light'), hint: 'day field' },
  photo: { run: () => $('#shootFile').click(), hint: 'a photo becomes a place' },
  hike: { run: () => $('#gpxFile').click(), hint: 'a gpx from any walking app becomes a way' },
  route: { run: () => $('#gpxFile').click(), hint: 'a gpx from any walking app becomes a way' },
  walk: { run: () => $('#gpxFile').click(), hint: 'a gpx from any walking app becomes a way' },
  export: { run: async () => {
    const { json, misses } = await fullExport();
    download('resonate-atlas.json', json, 'application/json');
    store.settings.lastExportAt = new Date().toISOString(); store.saveSettings();
    if (misses) toast(`${misses} photograph${misses === 1 ? '' : 's'} could not be read back and are not in this file`, 6000);
  }, hint: 'your data, yours' },
  print: { run: () => printSheet(atlasSheetOpts()), hint: 'the atlas typeset, to paper or pdf' },
  pdf: { run: () => printSheet(atlasSheetOpts()), hint: 'the atlas typeset, to paper or pdf' },
  import: { run: () => { openSurface('settingsOverlay', renderSettings); $('#impJson').click(); }, hint: 'bring an atlas in' },
  been: { run: () => setStatusFilter('visited'), hint: 'only places you’ve been' },
  want: { run: () => setStatusFilter('wishlist'), hint: 'only places still to go' },
  all: { run: () => setStatusFilter('all'), hint: 'everything' },
  specimen: { run: seedDemo, hint: 'a sample atlas, yours to edit' },
  sample: { run: seedDemo, hint: 'a sample atlas, yours to edit' },
  folio: { run: () => openFolioShelf(), hint: 'your kept folios, and the composer' },
  folios: { run: () => openFolioShelf(), hint: 'your kept folios, and the composer' },
  ask: { run: composeAsk, hint: 'request someone’s taste' },
  newsstand: { run: () => openNewsstand(), hint: 'published folios, ranked by your resonance' },
  how: { run: () => openSurface('howOverlay'), hint: 'what this is, what it keeps, what it shares' },
  about: { run: () => openSurface('howOverlay'), hint: 'what this is, what it keeps, what it shares' },
  commons: { run: () => openNewsstand(), hint: 'published folios, ranked by your resonance' },
};

function setStatusFilter(status) {
  state.filters.status = status;
  $$('#statusSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.status === status)));
  renderList(); syncMarkers();
}

function route(q) {
  if (q[0] === '>') return { kind: 'verb', rest: q.slice(1).trim().toLowerCase() };
  if (q[0] === '#') return { kind: 'tag', rest: q.slice(1).trim().toLowerCase() };
  if (q[0] === '@') return { kind: 'voice', rest: q.slice(1).trim().toLowerCase() };
  const at = coordsIn(q);
  if (at) return { kind: 'coords', lat: at.lat, lng: at.lng };
  if (/^https?:\/\//i.test(q)) return { kind: 'link', rest: q };
  return { kind: 'search', rest: q };
}

function openPalette() {
  openSurface('paletteOverlay');
  palette.input.value = '';
  palette.input.focus();
  renderPaletteResults('');
}
function togglePalette() {
  if (topSurface() === 'paletteOverlay') popSurface();
  else openPalette();
}

function localMatches(q) {
  if (!q) return allPlaces().slice(0, 6);
  const needle = q.toLowerCase();
  return allPlaces().filter(p =>
    p.name.toLowerCase().includes(needle) ||
    p.city?.toLowerCase().includes(needle) ||
    p.country?.toLowerCase().includes(needle) ||
    p.note?.toLowerCase().includes(needle)
  ).slice(0, 6);
}

function corrMatches(q) {
  if (!q) return [];
  const needle = q.toLowerCase();
  const out = [];
  for (const c of store.correspondents) {
    for (const p of c.places) {
      const hay = [p.name, p.city, p.country, p.note].join(' ').toLowerCase();
      if (hay.includes(needle)) out.push({ kind: 'corrplace', c, p });
      if (out.length >= 6) return out;
    }
  }
  return out;
}

function rowHTML(item, i) {
  const hl = i === palette.hl ? ' hl' : '';
  if (item.kind === 'corrplace') {
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name">${esc(item.p.name)} <span class="after">· after ${esc(item.c.name)}</span></span><span class="row-sub">${esc([item.p.city, item.p.country].filter(Boolean).join(' · '))}</span></button>`;
  }
  if (item.kind === 'local') {
    const p = item.place;
    const side = datumWord(p);
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name">${esc(p.name)}</span><span class="row-sub">${esc([p.city, p.country].filter(Boolean).join(' · ') || side)}</span></button>`;
  }
  if (item.kind === 'remote') {
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name">${esc(item.r.name)}</span><span class="row-sub">${esc(item.r.sub)} · ↵ add</span></button>`;
  }
  if (item.kind === 'verb') {
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name">&gt; ${item.verb}</span><span class="row-sub">${esc(item.hint)}</span></button>`;
  }
  if (item.kind === 'tag') {
    const on = state.filters.tags.has(item.tag.id);
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name"># ${esc(item.tag.name)}</span><span class="row-sub">${item.n} places · ${on ? 'filtered, ↵ clears' : '↵ inks the world'}</span></button>`;
  }
  if (item.kind === 'voice') {
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name">@ ${esc(item.c.name)}</span><span class="row-sub">${item.c.places.length} marks · ${item.c.visible === false ? 'muted' : 'audible'}</span></button>`;
  }
  if (item.kind === 'coords') {
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name">${item.lat.toFixed(4)}, ${item.lng.toFixed(4)}</span><span class="row-sub">↵ propose a place here</span></button>`;
  }
  if (item.kind === 'link') {
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name">a link</span><span class="row-sub">${esc(item.host)} · ↵ read it for a place</span></button>`;
  }
  if (item.kind === 'stand') {
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name">the newsstand answers</span><span class="row-sub">${item.n} folio${item.n > 1 ? 's' : ''} · ↵ open</span></button>`;
  }
  if (item.kind === 'world') {
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name">“${esc(item.q)}”, in the world</span><span class="row-sub">↵ ask openstreetmap</span></button>`;
  }
  return '';
}

function paint(items, hint) {
  palette.rows = items;
  palette.hl = 0;
  palette.results.innerHTML =
    (hint ? `<div class="cmd-hint">${hint}</div>` : '') +
    items.map((it, i) => rowHTML(it, i)).join('');
  $$('.cmd-row', palette.results).forEach(r =>
    r.addEventListener('click', () => activateRow(parseInt(r.dataset.i, 10))));
}

function activateRow(i) {
  const item = palette.rows[i];
  if (!item) return;
  if (item.kind === 'local') { popSurface(); selectPlace(item.place.id, { fly: true }); return; }
  if (item.kind === 'corrplace') { popSurface(); openForeignPlate(item.c.id, item.p.id); return; }
  if (item.kind === 'remote') { popSurface(); proposePlace(item.r); return; }
  if (item.kind === 'verb') { popSurface(); item.run(); return; }
  if (item.kind === 'coords') { popSurface(); proposeAdd(item.lat, item.lng); return; }
  if (item.kind === 'link') { popSurface(); receiveShared({ url: item.url }); return; }
  if (item.kind === 'tag') {
    const id = item.tag.id;
    state.filters.tags.has(id) ? state.filters.tags.delete(id) : state.filters.tags.add(id);
    renderChips(); renderList(); syncMarkers(); applyWorldState();
    renderPaletteResults(palette.input.value.trim());
    return;
  }
  if (item.kind === 'voice') { popSurface(); openSurface('corrOverlay', renderVoices); return; }
  if (item.kind === 'stand') { popSurface(); openNewsstand(item.q); return; }
  if (item.kind === 'world') { runWorldSearch(item.q); return; }
}

// the world answers only when asked: one request per explicit press,
// never as-you-type (the nominatim policy forbids autocomplete)
async function runWorldSearch(q) {
  if (!q || q.length < 2) return;
  palette.remoteAbort?.abort();
  palette.remoteAbort = new AbortController();
  // your own matches stay on screen while the world is asked
  {
    const locals = localMatches(q).map(p => ({ kind: 'local', place: p }));
    const voices = corrMatches(q);
    let stand = [];
    if (newsIndex) {
      const nOnStand = rankFolios(newsIndex, q).length;
      if (nOnStand) stand = [{ kind: 'stand', q, n: nOnStand }];
    }
    paint([...locals, ...voices, ...stand], 'asking the world…');
  }
  try {
    const results = await searchGeo(q, { signal: palette.remoteAbort.signal });
    if (palette.input.value.trim() !== q) return;
    const locals = localMatches(q).map(p => ({ kind: 'local', place: p }));
    const voices = corrMatches(q);
    const keys = new Set(locals.map(l => `${l.place.lat.toFixed(4)},${l.place.lng.toFixed(4)}`));
    const remote = results
      .filter(r => !keys.has(`${r.lat.toFixed(4)},${r.lng.toFixed(4)}`))
      .map(r => ({ kind: 'remote', r }));
    let stand = [];
    if (newsIndex) {
      const nOnStand = rankFolios(newsIndex, q).length;
      if (nOnStand) stand = [{ kind: 'stand', q, n: nOnStand }];
    }
    // column-reverse: first row sits nearest the input
    paint([...locals, ...voices, ...stand, ...remote],
      (!locals.length && !voices.length && !remote.length) ? `nothing answers “${esc(q)}”` : '');
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.warn('search failed', e);
    // never leave the palette holding an empty promise: give the rows back
    if (palette.input.value.trim() !== q) return;
    const locals = localMatches(q).map(p => ({ kind: 'local', place: p }));
    const voices = corrMatches(q);
    paint([...locals, ...voices, { kind: 'world', q }], 'the world did not answer. try again');
  }
}

function renderPaletteResults(q) {
  const r = route(q);
  if (r.kind === 'verb') {
    const items = Object.entries(VERBS)
      .filter(([v]) => v.startsWith(r.rest))
      .map(([verb, def]) => ({ kind: 'verb', verb, run: def.run, hint: def.hint }));
    return paint(items, items.length ? '' : 'no such verb');
  }
  if (r.kind === 'tag') {
    const items = allTags()
      .filter(t => t.name.toLowerCase().includes(r.rest))
      .map(t => ({ kind: 'tag', tag: t, n: allPlaces().filter(p => p.tags.includes(t.id)).length }));
    return paint(items, items.length ? '' : 'no such tag');
  }
  if (r.kind === 'voice') {
    const items = store.correspondents
      .filter(c => c.name.toLowerCase().includes(r.rest))
      .map(c => ({ kind: 'voice', c }));
    return paint(items, items.length ? '' : store.correspondents.length ? 'no such voice' : 'no voices yet. >share to begin the exchange');
  }
  if (r.kind === 'coords') return paint([{ kind: 'coords', lat: r.lat, lng: r.lng }]);
  if (r.kind === 'link') {
    let host = 'that address';
    try { host = new URL(r.rest).hostname.replace(/^www\./, ''); } catch { /* it will still be read */ }
    return paint([{ kind: 'link', url: r.rest, host }]);
  }
  const locals = localMatches(r.rest).map(p => ({ kind: 'local', place: p }));
  const voices = corrMatches(r.rest);
  if (!r.rest) {
    paint([...locals, ...voices], '');
    palette.results.insertAdjacentHTML('afterbegin',
      `<div class="cmd-teach"><b>find.</b> type a city or a craving. yours, your voices, and the newsstand answer.</div>
       <div class="cmd-teach"><b>keep.</b> type a place to add it. or drop a photo, or press long on the map.</div>`);
    return;
  }
  let stand = [];
  if (newsIndex) {
    const nOnStand = rankFolios(newsIndex, r.rest).length;
    if (nOnStand) stand = [{ kind: 'stand', q: r.rest, n: nOnStand }];
  }
  const world = r.rest.length >= 2 ? [{ kind: 'world', q: r.rest }] : [];
  // an empty answer is an answer: say it, rather than leaving a silence
  const hint = (!locals.length && !voices.length && !stand.length && r.rest.length >= 2)
    ? `nothing of yours answers “${esc(r.rest)}” yet`
    : '';
  paint([...locals, ...voices, ...stand, ...world], hint);
}


// ---------- the first evening ----------

const DISSOLVE_S = 1.4;   // matches #intro.dissolve in the stylesheet
const FILM_IN = 1.6;      // enter the evening already in motion
const FILM_TAIL = 0.9;    // the dissolve opens this long before the last frame,
                          // so the face at the end of the shot is still there

function runIntro(onDone, { brief = false, skip = false } = {}) {
  const el = $('#intro');
  const video = $('#introVideo');
  const canvas = $('#introCanvas');
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // the evening opens every visit, but only the first one plays out. someone
  // arriving on a link came for the sender, and gets no film at all.
  if (skip || RM) { store.settings.introSeen = true; store.saveSettings(); onDone(); return; }
  el.classList.toggle('brief', brief);
  el.hidden = false;
  let raf = 0;
  let finished = false;
  let cutoff = 0;

  // the generated scene: a long table at dusk, spoken in bokeh
  function startScene() {
    const ctx = canvas.getContext('2d');
    const fit = () => { canvas.width = innerWidth; canvas.height = innerHeight; };
    fit();
    const R = (a, b) => a + Math.random() * (b - a);
    const lights = Array.from({ length: 22 }, (_, i) => ({
      x: Math.random(), y: 0.35 + Math.random() * 0.5,
      r: R(0.02, 0.11), hue: R(22, 44), sat: R(60, 90), lum: R(48, 64),
      drift: R(-0.006, 0.006), flick: R(2, 6), phase: R(0, 6.28), deep: i % 3 === 0,
    }));
    const t0 = performance.now();
    const draw = (now) => {
      const t = (now - t0) / 1000;
      const w = canvas.width, h = canvas.height;
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#171019');
      sky.addColorStop(0.55, '#2b1a1a');
      sky.addColorStop(0.8, '#4a2c17');
      sky.addColorStop(1, '#241309');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (const L of lights) {
        const fl = 0.55 + 0.45 * Math.sin(t * L.flick + L.phase) * Math.sin(t * 0.7 + L.phase);
        const x = ((L.x + t * L.drift) % 1 + 1) % 1 * w;
        const y = L.y * h + Math.sin(t * 0.4 + L.phase) * 6;
        const r = L.r * Math.min(w, h) * (L.deep ? 1.9 : 1);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const alpha = (L.deep ? 0.10 : 0.22) * fl;
        g.addColorStop(0, `hsla(${L.hue}, ${L.sat}%, ${L.lum}%, ${alpha})`);
        g.addColorStop(1, 'hsla(30, 60%, 30%, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 6.29);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      const vg = ctx.createRadialGradient(w / 2, h * 0.62, Math.min(w, h) * 0.28, w / 2, h * 0.62, Math.max(w, h) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(8,4,4,0.7)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    addEventListener('resize', fit, { once: true });
  }

  const finish = () => {
    if (finished) return;
    finished = true;
    // whatever ended the film, its listeners go with it: a capturing key
    // handler left behind would swallow the next Enter in the whole app
    cleanupIntro();
    store.settings.introSeen = true;
    store.saveSettings();
    document.body.classList.add('entering');
    el.classList.add('dissolve');
    clearTimeout(cutoff);
    onDone();
    setTimeout(() => {
      cancelAnimationFrame(raf);
      try { video.pause(); } catch { /* fine */ }
      el.hidden = true;
      document.body.classList.remove('entering');
    }, (brief ? 0.6 : DISSOLVE_S) * 1000);
  };

  // the film is the evening; the drawn scene only stands in until it arrives,
  // or for good if it never does
  let filmUp = false;
  cutoff = setTimeout(finish, brief ? 1600 : 6200);

  // Enter, Escape and Space belong to the film while it is running, and are
  // handed back the moment it is not
  function onIntroKey(e) {
    if (e.key !== 'Enter' && e.key !== 'Escape' && e.key !== ' ') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    finish();
  }
  function cleanupIntro() {
    document.removeEventListener('keydown', onIntroKey, true);
    video.removeEventListener('playing', armCutoff);
    video.removeEventListener('seeked', armCutoff);
    clearTimeout(cutoff);
  }

  const armCutoff = () => {
    if (finished) return;
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 6;
    const left = Math.min(dur, 12) - video.currentTime;
    clearTimeout(cutoff);
    cutoff = setTimeout(finish, Math.max(1.8, left - FILM_TAIL) * 1000);
  };

  const raiseFilm = () => {
    if (filmUp) return;
    filmUp = true;
    el.classList.add('has-video');
    cancelAnimationFrame(raf);
    video.muted = true;
    // open on a frame that is already in motion, not on the first still
    try { if (video.duration > FILM_IN + 2) video.currentTime = FILM_IN; } catch { /* fine */ }
    const started = video.play();
    // if the browser refuses to roll the film, the drawn scene stays rather
    // than leaving a frozen frame on screen
    if (started && started.catch) {
      started.catch(() => {
        if (video.currentTime > 0) return;
        filmUp = false;
        el.classList.remove('has-video');
        startScene();
      });
    }
    // the field arrives while the table is still alive: the dissolve begins
    // partway through, so the film never ends on screen
    clearTimeout(cutoff);
    // stay to the end of the shot: the dissolve opens over the last of it.
    // measured from where the film actually starts, since a server without
    // range requests will refuse the seek and simply begin at zero
    armCutoff();
    video.addEventListener('playing', armCutoff);
    video.addEventListener('seeked', armCutoff);
  };

  // canplay may already have fired on a warm cache, so ask the element directly
  if (video.readyState >= 2) raiseFilm();
  video.addEventListener('loadeddata', raiseFilm);
  video.addEventListener('canplay', raiseFilm);
  video.addEventListener('error', () => {}, { once: true });
  video.load();
  startScene();

  el.addEventListener('click', finish);
  $('#introSkip')?.addEventListener('click', (e) => { e.stopPropagation(); finish(); });
  document.addEventListener('keydown', onIntroKey, true);
}

// ---------- init ----------

function init() {
  setWriteFailedHandler(() => {
    // callers give their own, more specific sentence; this net catches the rest
    setTimeout(() => {
      if (Date.now() - lastToastAt > 450) {
        toast('this browser refused to save. export your atlas before you lose it', 6000);
      }
    }, 80);
  });
  store.load();
  applyWorldState();
  renderFieldWord();

  // the durable work happens after the field is standing, never in its way
  setTimeout(async () => {
    const moved = await migratePhotos();
    if (moved) console.info(`${moved} photograph${moved === 1 ? '' : 's'} moved to their own store`);
    const keys = (await photoStore.snapshotKeys()) || [];
    const newest = keys.sort().pop();
    const stale = !newest || (Date.now() - Date.parse(newest)) > 24 * 3600 * 1000;
    if (stale && store.places.length) {
      await photoStore.snapshotPut(store.recordsJSON());
      await photoStore.snapshotPrune(3);
    }
  }, 2500);

  // something was shared into the app: read it, then wipe the url clean
  const q = new URLSearchParams(location.search);
  if (q.has('title') || q.has('text') || q.has('url')) {
    const shared = { title: q.get('title') || '', text: q.get('text') || '', url: q.get('url') || '' };
    history.replaceState(null, '', location.pathname + location.hash);
    setTimeout(() => receiveShared(shared), 1200);
  } else {
    setTimeout(drainInbox, 3000);
  }

  // a member returns from the door with a checkout session on the url.
  // the session becomes a key, the url is wiped clean of it.
  const backFromDoor = new URLSearchParams(location.search).get('club');
  if (backFromDoor && clubBase() && !store.settings.clubKey) {
    (async () => {
      try {
        const got = await clubClient().door(backFromDoor);
        store.settings.clubKey = got.key; store.saveSettings();
        openSurface('clubOverlay', renderClub);
        toast(got.again ? 'welcome back. the key was already on this side' : 'welcome. your key is kept on this device');
      } catch (e) {
        toast(`${e.message || 'the door did not answer'}. the club room, from the index, can take the session again`);
      }
      history.replaceState(null, '', location.pathname + location.hash);
    })();
  } else if (backFromDoor) {
    if (store.settings.clubKey) openSurface('clubOverlay', renderClub);
    history.replaceState(null, '', location.pathname + location.hash);
  }

  mapView.setRouteClickHandler((id) => selectRoute(id, { fly: false }));
  mapView.initMap({
    onMarkerClick: (id) => selectPlace(id, { fly: false }),
    onCorrClick: (corrId, placeId) => openForeignPlate(corrId, placeId),
    onLongPress: (lat, lng) => proposeAdd(lat, lng),
    onPointerMove: (lat, lng) => { $('#coordsReadout').textContent = fmtDMS(lat, lng); },
    onViewChange: debounce((view) => {
      store.settings.lastView = view;
      store.saveSettings();
      const c = mapView.getCenter();
      $('#coordsReadout').textContent = fmtDMS(c.lat, c.lng);
      if (state.sort === 'distance' && !$('#indexOverlay').hidden) renderList();
    }, 300),
  });
  applyTheme();
  pushCorrespondentsToMap();

  const places = allPlaces();
  if (store.settings.lastView) mapView.setView(store.settings.lastView);
  else if (places.length) mapView.fitAll(places);

  const c0 = mapView.getCenter();
  $('#coordsReadout').textContent = fmtDMS(c0.lat, c0.lng);

  renderAll();

  // the welcome: the hint that teaches the one gesture, and the name's pulse.
  // it starts when the field is actually revealed, never behind a cover, so
  // it is never burned invisible and marked as shown.
  const startWelcome = () => {
    if (!store.settings.indexSeen && !store.settings.hintShown) {
      $('#fmHint').hidden = false;
      store.settings.hintShown = true;
      store.saveSettings();
      setTimeout(() => { $('#fmHint').hidden = true; }, 12000);
    }
    document.body.classList.add('greet');
    setTimeout(() => document.body.classList.remove('greet'), 5600);
  };

  // read the link first: a visitor who was handed something is answering a
  // person, not starting an atlas, and must never be offered a first-run
  // choice over the top of it. an atlas that already exists has answered
  // that question too.
  const payload = parseShareHash();
  if (payload) openReport(payload);

  runIntro(() => {
    if (store.settings.chosen || store.places.length || payload) {
      if (!payload) startWelcome();
      return;
    }
    openThreshold();
  }, { brief: !!store.settings.introSeen, skip: !!payload });

  setHeroExit(() => {
    if (!document.body.classList.contains('hero')) return;
    document.body.classList.remove('hero');
    $('#fmHint').hidden = true;
  });
  if (!location.hash.startsWith('#m=')) {
    document.body.classList.add('hero');
    const exit = () => {
      if (!$('#intro').hidden || modalUp()) {
        ['keydown', 'wheel'].forEach(ev =>
          document.addEventListener(ev, exit, { once: true, passive: true }));
        return;
      }
      leaveHero();
    };
    mapView.onFirstUse(exit);
    ['keydown', 'wheel'].forEach(ev =>
      document.addEventListener(ev, exit, { once: true, passive: true }));
    $('#fmCommand').addEventListener('click', exit, { once: true });
    $('#fmIndex').addEventListener('click', exit, { once: true });
  }

  // plain words, then a choice: nothing is seeded and nobody is named until
  // the visitor has said which start they want
  let thresholdWired = false;
  setThresholdOpener(function openThreshold() {
    const th = $('#threshold');
    if (thresholdWired) return raiseDialog(th, 'What Resonate is');
    thresholdWired = true;
    const done = (fn) => {
      store.settings.chosen = true;
      store.saveSettings();
      dropDialog(th);
      // ask the browser to treat this data as worth keeping, now that it exists
      navigator.storage?.persist?.().catch?.(() => {});
      fn?.();
      startWelcome();
    };
    $('#thSample').addEventListener('click', () => done(() => {
      seedDemo();
      toast('a sample atlas. edit anything and it becomes yours');
    }));
    $('#thEmpty').addEventListener('click', () => done(() => {
      // an atlas with no domains cannot file anything: the vocabulary comes
      // even when the places do not
      if (!store.tags.length) {
        Object.values(baseTags()).forEach(t => store.addTag(t));
        renderAll();
      }
      toast('the field is yours. press the middle, or find or add below');
    }));
    // the third way in: this browser is new, but the atlas is not
    $('#thImport').addEventListener('click', () => {
      const file = $('#importFile');
      file.onchange = () => {
        const f = file.files?.[0];
        file.value = '';
        if (!f) return;
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const added = store.merge(await absorbPhotos(JSON.parse(reader.result)));
            if (!added) return toast('that file brought nothing in');
            done(() => {
              renderAll();
              if (store.places.length) mapView.fitAll(store.places);
              toast(`welcome back. ${added} place${added === 1 ? '' : 's'} are home`);
            });
          } catch { toast('that file isn’t a resonate export'); }
        };
        reader.readAsText(f);
      };
      file.click();
    });
    $('#thHow').addEventListener('click', () => {
      // reading is not choosing: the door reopens when the reading is done
      dropDialog(th);
      const spared = leaveHero;
      setHeroExit(() => {});
      onHowClosed = () => {
        onHowClosed = null;
        setHeroExit(spared);
        if (!store.settings.chosen && !store.places.length) raiseDialog(th, 'What Resonate is');
      };
      openSurface('howOverlay');
    });
    raiseDialog(th, 'What Resonate is');
  });

  setTimeout(() => document.body.classList.remove('boot'), 700);

  $('#howOpening')?.addEventListener('click', () => {
    closeSurface('howOverlay');
    closeSurface('indexOverlay');
    showOpening();
  });

  $('#visitLeave').addEventListener('click', leaveVisit);

  // corner marks
  $('#fmIndex').addEventListener('click', () => {
    $('#indexOverlay').hidden ? openIndex() : closeSurface('indexOverlay');
  });
  $('#fmCommand').addEventListener('click', togglePalette);
  $('#hbDone').addEventListener('click', () => { $('#handBar').hidden = true; });
  // a report's close word, present in every letter, wired here once
  $('#reportOverlay').addEventListener('click', (e) => {
    if (e.target.id !== 'rpX') return;
    dropDialog($('#reportOverlay'));
    applyWorldState();
    clearShareHash();
  });
  $('#indexClose').addEventListener('click', () => closeSurface('indexOverlay'));
  $('#fieldWord').addEventListener('click', turnField);
  $('#themeWord').addEventListener('click', () => {
    // day, night, or whatever this device is doing: one press moves along,
    // so following the system is somewhere you can get back to
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(store.settings.theme) + 1) % order.length];
    setTheme(next);
  });
  $('#indexKeys').addEventListener('click', () => {
    openSurface('keysOverlay', renderKeys);
  });

  // the index is the hub: every surface reachable as a word
  $('#indexGo').addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    // the index stays open beneath: closing what you opened returns you to it,
    // so reading one explanation does not cost you the others
    VERBS[b.dataset.go]?.run();
  });

  // tapping the open field puts the plate away
  mapView.getMap().on('click', () => {
    if (!$('#plate').hidden) closeSurface('plate');
    if (state.pendingAdd) { state.pendingAdd = null; $('#addConfirm').hidden = true; }
  });

  // command line
  palette.input = $('#paletteInput');
  palette.results = $('#paletteResults');
  $('#paletteOverlay').addEventListener('click', (e) => { if (e.target === $('#paletteOverlay')) popSurface(); });
  palette.input.addEventListener('input', () => renderPaletteResults(palette.input.value.trim()));
  palette.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      // results are column-reversed: down moves visually down = earlier index
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      palette.hl = Math.max(0, Math.min(palette.rows.length - 1, palette.hl + dir));
      $$('.cmd-row', palette.results).forEach((r, i) => r.classList.toggle('hl', i === palette.hl));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // act on what is visibly highlighted, never on a stale index
      const el = palette.results.querySelector('.cmd-row.hl') || palette.results.querySelector('.cmd-row');
      if (el) activateRow(parseInt(el.dataset.i, 10));
    }
  });

  // index controls
  $('#statusSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    setStatusFilter(b.dataset.status);
  });
  $('#sortLine').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    state.sort = b.dataset.sort;
    $$('#sortLine button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderList();
  });

  // posters close
  $$('.poster [data-close]').forEach(b => b.addEventListener('click', () => {
    const poster = b.closest('.poster');
    closeSurface(poster.id);
  }));

  // add-confirm
  $('#addConfirm').addEventListener('click', commitAdd);

  // photo capture + drop
  $('#shootFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) addFromPhoto(f);
  });
  $('#gpxFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) addFromGPX(f);
  });
  let dragDepth = 0;
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) document.body.classList.add('dropping'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])];
    const gpx = files.find(x => /\.gpx$/i.test(x.name) || x.type.includes('gpx'));
    if (gpx) return addFromGPX(gpx);
    const img = files.find(x => x.type.startsWith('image/'));
    if (img) addFromPhoto(img);
  });

  // mobile: swipe up from the bottom edge = index
  let edgeY = 0;
  addEventListener('touchstart', (e) => {
    if (modalUp() || surfaces.length) { edgeY = 0; return; }
    const t = e.touches[0];
    if (document.elementFromPoint(t.clientX, t.clientY)?.closest('.fm')) { edgeY = 0; return; }
    const y = t.clientY;
    edgeY = (innerHeight - y < 34 && innerHeight - y > 6) ? y : 0;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (edgeY && edgeY - e.touches[0].clientY > 56) { openIndex(); edgeY = 0; }
  }, { passive: true });
  visualViewport?.addEventListener('resize', () => {
    $('#paletteOverlay').style.paddingBottom = `${Math.max(0, innerHeight - visualViewport.height) + 20}px`;
  });

  window.addEventListener('resize', debounce(() => mapView.invalidate(), 150));

  // another tab wrote the atlas: take its truth rather than overwriting it
  window.addEventListener('storage', debounce((e) => {
    if (e && e.key && !String(e.key).startsWith('resonate.')) return;
    store.load();
    renderAll();
    pushCorrespondentsToMap();
  }, 250));

  // an atlas that already exists deserves the browser's protection
  if (store.settings.chosen || store.places.length) {
    navigator.storage?.persist?.().catch?.(() => {});
  }

  // keyboard
  document.addEventListener('keydown', (e) => {
    const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) ||
      document.activeElement?.isContentEditable;
    // the command line is a shortcut like any other: it may not open behind
    // a dialog that has the floor. escape alone reaches past everything.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      if (modalUp() && topSurface() !== 'paletteOverlay') return;
      e.preventDefault(); togglePalette(); return;
    }
    if (e.key === 'Escape') {
      if (state.pendingAdd) { state.pendingAdd = null; $('#addConfirm').hidden = true; return; }
      if (state.visiting) { leaveVisit(); return; }
      if (!$('#reportOverlay').hidden) { dropDialog($('#reportOverlay')); applyWorldState(); clearShareHash(); return; }
      const th = $('#threshold');
      if (th && !th.hidden && th.classList.contains('revisited')) { dropDialog(th); return; }
      if (popSurface()) return;
    }
    if (inField) return;
    // a shortcut may not act on a field that a dialog has taken out of reach
    if (modalUp()) return;
    if (e.key === '/') { e.preventDefault(); togglePalette(); return; }
    const acc = [...accessionMap().entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    const step = (d) => {
      if (!acc.length) return;
      const i = acc.indexOf(state.selectedId);
      const id = acc[(i + d + acc.length) % acc.length] ?? acc[0];
      selectPlace(id, { fly: true });
    };
    const keys = {
      i: () => $('#indexOverlay').hidden ? openIndex() : closeSurface('indexOverlay'),
      j: () => step(1), k: () => step(-1),
      '+': mapView.zoomIn, '=': mapView.zoomIn, '-': mapView.zoomOut,
      0: () => mapView.fitAll(filteredPlaces()),
      t: () => setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark'),
      g: VERBS.locate.run, s: shareMap,
      '?': () => openSurface('keysOverlay', renderKeys),
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); return; }
    if (/^[1-9]$/.test(e.key)) {
      const t = allTags()[+e.key - 1];
      if (!t) return;
      state.filters.tags.has(t.id) ? state.filters.tags.delete(t.id) : state.filters.tags.add(t.id);
      renderChips(); renderList(); syncMarkers(); applyWorldState();
    }
  });

  fetch(`${COMMONS}/index.json`, { cache: 'no-cache' })
    .then(r => r.json()).then(ix => { newsIndex = normIndex(ix); }).catch(() => {});

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
