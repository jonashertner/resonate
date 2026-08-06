// app.js — THE RESONANT FIELD
// The map is the interface. Four corner marks, one command line,
// summoned posters. One field, one ink — and one counter-ink for
// the voices of other people.

import { store, newPlace, newTag, demoData, TAG_STATIONS, setWriteFailedHandler } from './store.js?v=rf25';
import { searchGeo, reverseGeo, fmtDMS, haversineKm, fmtDistance } from './geocode.js?v=rf25';
import * as mapView from './map.js?v=rf25';
import { makeShareUrl, makeFolioUrl, makeAskUrl, parseShareHash, clearShareHash } from './share.js?v=rf25';
import { normPayload, normIndex, SCHEMA_VERSION } from './schema.js?v=rf25';
import { resonance, verdict, evidenceLines } from './kinship.js?v=rf25';
import { exifGPS } from './exif.js?v=rf25';

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
function toast(msg, ms = 2800) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return ''; }
}

function starsText(r) {
  const n = Math.max(0, Math.min(5, Math.floor(Number(r) || 0)));
  return n > 0 ? '★'.repeat(n) : '';
}
function fmtNo(n) { return String(n).padStart(2, '0'); }

// ---------- state ----------

const state = {
  filters: { tags: new Set(), status: 'all' },
  sort: 'recent',
  selectedId: null,
  foreign: null, // { corrId?, name, sig, place } — a place from someone else's atlas
  visiting: null, // temp correspondent-shaped object when "just looking" at a share
  pendingAdd: null, // {lat, lng, name?, photo?} awaiting confirm
};

function allPlaces() { return store.places; }
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
    case 'rating': list.sort((a, b) => (b.rating || 0) - (a.rating || 0) || a.name.localeCompare(b.name)); break;
    default: list.sort((a, b) => nos.get(b.id) - nos.get(a.id));
  }
  return list;
}

// ---------- the world: hue engine ----------

const rootStyle = document.documentElement.style;

function setWorld({ hue, split = 0, tint = 1 }) {
  rootStyle.setProperty('--hue', hue);
  rootStyle.setProperty('--split', split);
  rootStyle.setProperty('--tint', tint);
  document.documentElement.dataset.hueband = (hue >= 120 && hue <= 170) ? 'green' : '';
}

function clearWorld() {
  rootStyle.removeProperty('--hue');
  rootStyle.removeProperty('--split');
  rootStyle.removeProperty('--tint');
  document.documentElement.dataset.hueband = '';
}

// the world's color follows attention: selection > filter > rest
function applyWorldState() {
  const sel = state.selectedId && placeById(state.selectedId);
  if (sel && sel.tags[0]) {
    const t = tagById(sel.tags[0]);
    if (t) return setWorld({ hue: t.hue, tint: 0.62 });
  }
  if (state.filters.tags.size) {
    const first = tagById([...state.filters.tags][0]);
    if (first) return setWorld({ hue: first.hue, tint: 1 });
  }
  clearWorld();
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
  if (w) w.textContent = resolvedTheme() === 'dark' ? 'day' : 'night';
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
  const app = $('#app');
  if (!app) return;
  if (on) { app.setAttribute('inert', ''); app.setAttribute('aria-hidden', 'true'); }
  else { app.removeAttribute('inert'); app.removeAttribute('aria-hidden'); }
}

// a dialog that does not live on the surface stack still behaves like one
function raiseDialog(el, label) {
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  if (label) el.setAttribute('aria-label', label);
  el.hidden = false;
  setBackgroundInert(true);
  const first = el.querySelector(FOCUSABLE);
  (first || el).focus?.();
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
    const items = focusables(el);
    (items[0] || el).focus?.();
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
  if (id === 'plate') { state.selectedId = null; state.foreign = null; state.proposal = null; mapView.clearPreview(); syncMarkers(); applyWorldState(); }
  restoreFocus(id);
}

function topSurface() { return surfaces[surfaces.length - 1]; }

// ---------- rendering: count, index ----------

function renderCount() {
  const n = allPlaces().length;
  $('#placeCount').textContent = n || '';
  $('#ixN').textContent = n;
  const who = store.settings.authorName;
  const small = $('.index-count small');
  if (small) small.textContent = who ? `places · ${who}` : 'places';
}

function renderChips() {
  const wrap = $('#filterChips');
  wrap.innerHTML = allTags().map(t => {
    const n = allPlaces().reduce((k, p) => k + (p.tags.includes(t.id) ? 1 : 0), 0);
    const on = state.filters.tags.has(t.id);
    return `<button data-tag="${esc(t.id)}" aria-pressed="${on}">${esc(t.name)}<sup>${n}</sup></button>`;
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
  if (!places.length) {
    wrap.innerHTML = allPlaces().length === 0
      ? `<div class="ix-empty">Every place that ever <b>resonated</b>, held in one field.
          <p>Press <b>/</b> and name a place. Drop a photo on the field. Or open a
          <button class="word-btn" id="emptyDemo" style="font-size:inherit;letter-spacing:0;text-transform:none">specimen atlas</button>.</p>
        </div>`
      : `<div class="ix-empty">Nothing answers this arrangement.
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
    const datum = p.rating > 0 ? starsText(p.rating) : fmtDistance(haversineKm(center, p));
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
  $$('.ix', wrap).forEach(b => b.addEventListener('click', () => {
    closeSurface('indexOverlay');
    selectPlace(b.dataset.id, { fly: true });
  }));
}

function syncMarkers() {
  mapView.renderMarkers(filteredPlaces(), tagById, state.selectedId);
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
  mapView.ripple(place.lat, place.lng);
  if (fly) mapView.flyToPlace(place);
  renderPlate(place, { edit });
  openSurface('plate');
}

function renderPlate(place, { edit = false, foreign = null } = {}) {
  const wrap = $('#plate');
  const ro = !!foreign;
  const no = ro ? null : accessionMap().get(place.id);
  const tagWords = allTags().map(t => `
    <button data-dtag="${esc(t.id)}" aria-pressed="${place.tags.includes(t.id)}" ${ro ? 'disabled' : ''}>${esc(t.name)}</button>`).join('');
  const stars = [1, 2, 3, 4, 5].map(i =>
    `<button data-star="${i}" class="${place.rating >= i ? 'on' : ''}" ${ro ? 'disabled' : ''} aria-label="${i} star${i > 1 ? 's' : ''}">★</button>`).join('');
  const photos = (place.photos || []).map((src, i) => `
    <figure class="fig"><img src="${esc(src)}" alt="Photograph ${i + 1} of ${esc(place.name)}">
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
    ${place.provenance ? `<div class="plate-prov prov">after <b>${esc(place.provenance.name)}</b> · adopted ${fmtDate(place.provenance.adoptedAt)}</div>` : ''}

    ${ro ? `
      ${place.rating ? `<div class="stars-line">${starsText(place.rating).split('').map(() => '<button class="on" disabled>★</button>').join('')}</div>` : ''}
      ${place.note ? `<div class="plate-sec"><div class="plate-sec-head"><span>their note</span></div><p class="note-input" style="border-left-color:var(--counter)">${esc(place.note)}</p></div>` : ''}
      <div class="plate-acts">
        <button class="word-btn" id="pAdopt">adopt, after ${esc(foreign.name)}</button>
        <button class="word-btn quiet" id="pDirections">directions ↗</button>
      </div>`
    : `
      <div class="plate-words" id="pStatus">
        <button data-st="visited" aria-pressed="${place.status === 'visited'}">been</button>
        <button data-st="wishlist" aria-pressed="${place.status === 'wishlist'}">want to go</button>
      </div>
      <div class="stars-line" id="pStars">${stars}</div>

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
  $('#pDirections')?.addEventListener('click', () => {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`, '_blank', 'noopener');
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

  const nameEl = $('#pName');
  nameEl.addEventListener('blur', () => {
    const v = nameEl.textContent.trim();
    if (v && v !== place.name) save({ name: v });
    else nameEl.textContent = place.name;
  });
  nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });

  $('#pStatus').addEventListener('click', (e) => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    save({ status: b.dataset.st });
    renderPlate(place); renderList(); syncMarkers();
  });

  $('#pStars').addEventListener('click', (e) => {
    const b = e.target.closest('[data-star]');
    if (!b) return;
    const v = parseInt(b.dataset.star, 10);
    save({ rating: place.rating === v ? 0 : v });
    renderPlate(place); renderList();
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
          save({ tags: [...place.tags, tag.id] });
          applyWorldState();
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
        const photos = [...(place.photos || []), dataUri];
        save({ photos });
        if (!store.savePlaces()) toast('storage is full, photo not kept');
        renderPlate(place); renderList();
      } catch { toast('could not read that image'); }
    };
    file.click();
  });

  $$('#pPhotos .ph-x').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const i = parseInt(btn.dataset.phx, 10);
    save({ photos: place.photos.filter((_, k) => k !== i) });
    renderPlate(place); renderList();
  }));

  $('#pDelete').addEventListener('click', () => {
    if (!confirm(`Remove “${place.name}” from your atlas?`)) return;
    store.removePlace(place.id);
    closeSurface('plate');
    renderAll();
    toast('removed');
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
  const draft = { name: 'From a photograph', lat: fix.lat, lng: fix.lng, address: '', city: '', country: '', countryCode: '' };
  try {
    const r = await reverseGeo(fix.lat, fix.lng);
    if (r) Object.assign(draft, { name: r.name || draft.name, address: r.address || r.sub || '', city: r.city, country: r.country, countryCode: r.countryCode });
  } catch { /* offline is fine */ }
  const place = store.addPlace(newPlace({ ...draft, status: 'visited', photos: dataUri ? [dataUri] : [] }));
  if (!store.savePlaces()) toast('storage is full, photo not kept');
  store.settings.seeded = true;
  store.saveSettings();
  renderAll();
  selectPlace(place.id, { fly: true, edit: true });
  toast('the photograph found its place');
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
    addPlaceFromResult(r);
    toast('kept. make it true');
  });
  $('#ppDirections').addEventListener('click', () => {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}`, '_blank', 'noopener');
  });
}

function addPlaceFromResult(r) {
  const place = store.addPlace(newPlace({
    name: r.name, lat: r.lat, lng: r.lng,
    address: r.address || r.sub || '', city: r.city, country: r.country, countryCode: r.countryCode,
    status: 'wishlist',
  }));
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
  store.settings.seeded = true;
  store.saveSettings();
  renderAll();
  closeSurface('indexOverlay');
  mapView.fitAll(store.places);
  if (!quiet) toast('a sample atlas. edit anything and it becomes yours');
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
    out.push(made.id);
  }
  return [...new Set(out)];
}

function adoptPlace(place, foreign, foreignTags = null) {
  const adopted = store.addPlace(newPlace({
    ...place,
    id: undefined,
    photos: [],
    tags: graftTags(place.tags, foreignTags || foreign.tags),
    provenance: { name: foreign.name, sig: foreign.sig, adoptedAt: new Date().toISOString() },
  }));
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
  setWorld({ hue: c.hue, tint: 0.62 });
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
        <div class="hue-stations" role="radiogroup" aria-label="Their color">
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
      setWorld({ hue: parseInt(b.dataset.hue, 10), tint: 0.62 });
      setTimeout(clearWorld, 1600);
    }));
  });
}

// ---------- the resonance report ----------

function openReport(payload) {
  if (payload.kind === 'folio') return openFolioReport(payload);
  if (payload.kind === 'ask') return openAskReport(payload);
  return openAtlasReport(payload);
}

// a folio arrives: an envelope, not a feed item
function openFolioReport(payload) {
  const author = String(payload.author || '').trim() || 'unsigned';
  const places = (payload.places || [])
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map(p => newPlace({ ...p, photos: [] }));
  const held = places.filter(holdAlready);
  const fresh = places.filter(p => !holdAlready(p));
  const sig = mapView.sigAngle(author);
  setWorld({ hue: 42, tint: 0.55 });

  const el = $('#reportOverlay');
  el.innerHTML = `
    <div class="rp-eyebrow">a folio from ${esc(author)}</div>
    <h1 class="rp-name">${esc(payload.title || 'untitled')}</h1>
    ${payload.dedication ? `<p class="rp-ded">“${esc(payload.dedication)}”</p>` : ''}
    <ul class="rp-evidence mono">
      <li><b>${places.length}</b> place${places.length === 1 ? '' : 's'} enclosed</li>
      ${held.length ? `<li><b>${held.length}</b> you already hold, you can trust the rest</li>` : ''}
      ${fresh.length ? `<li><b>${fresh.length}</b> new to your field</li>` : ''}
    </ul>
    <div class="rp-case">
      ${places.map((p, i) => `
        <div class="rp-pick">
          <span class="no">${fmtNo(i + 1)}</span>
          <span class="nm">${esc(p.name)}</span>
          <span class="why">${esc(p.city || '')}${p.rating ? ' · ' + starsText(p.rating) : ''}</span>
          ${holdAlready(p)
            ? '<span class="held">you hold this</span>'
            : `<button class="adopt" data-adopt="${i}">adopt</button>`}
        </div>`).join('')}
    </div>
    <div class="rp-foot">
      ${fresh.length ? `<button class="word-btn" id="rpTakeAll">take all ${fresh.length}</button>` : ''}
      <button class="word-btn quiet" id="rpPrint">print, or save as pdf</button>
      <button class="word-btn quiet" id="rpLeave">open my atlas</button>
    </div>`;
  raiseDialog(el, 'Resonance report');
  requestAnimationFrame(() => el.querySelector('.rp-name').style.setProperty('--rp-w', 650));

  const ref = { name: author, sig };
  const foreignTags = payload.tags || [];
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
    renderAll();
    clearShareHash();
    dropDialog(el);
    clearWorld();
    mapView.fitAll(store.places);
    toast(remaining.length
      ? `${remaining.length} place${remaining.length === 1 ? '' : 's'} taken, after ${author}`
      : 'you already hold them all');
  });
  $('#rpLeave').addEventListener('click', () => { clearShareHash(); location.reload(); });
  $('#rpPrint').addEventListener('click', () => {
    const theirTags = new Map((payload.tags || []).map(t => [t.id, t.name]));
    printSheet({
      title: payload.title || 'untitled',
      dedication: payload.dedication || '',
      author,
      places,
      tagName: (id) => theirTags.get(id),
    });
  });
}

// an ask arrives: your atlas has already drafted the reply
function openAskReport(payload) {
  const from = String(payload.from || '').trim() || 'someone';
  const q = String(payload.q || '').trim();
  const matches = q ? queryMyAtlas(q) : [];
  setWorld({ hue: 155, tint: 0.55 });

  const el = $('#reportOverlay');
  el.innerHTML = `
    <div class="rp-eyebrow">an ask, from ${esc(from)}</div>
    <h1 class="rp-name">${esc(q || 'anything')}</h1>
    <ul class="rp-evidence mono">
      <li>your atlas holds <b>${matches.length}</b> answer${matches.length === 1 ? '' : 's'}</li>
    </ul>
    <div class="rp-foot">
      ${matches.length ? `<button class="word-btn" id="askCompose">compose the folio for ${esc(from)}</button>` : ''}
      <button class="word-btn quiet" id="rpLeave">open my atlas</button>
    </div>`;
  raiseDialog(el, 'Resonance report');
  requestAnimationFrame(() => el.querySelector('.rp-name').style.setProperty('--rp-w', 650));

  $('#askCompose')?.addEventListener('click', () => {
    clearShareHash();
    dropDialog(el);
    clearWorld();
    openFolioComposer({
      title: q,
      dedication: `for ${from}, who asked`,
      places: matches,
    });
  });
  $('#rpLeave').addEventListener('click', () => { clearShareHash(); location.reload(); });
}

function openAtlasReport(payload) {
  const theirs = {
    tags: (payload.tags || []).map(t => newTag(t)),
    places: (payload.places || [])
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .map(p => newPlace({ ...p, photos: [] })),
  };
  const name = String(payload.author || '').trim() || 'an unsigned atlas';
  const r = resonance(myAtlas(), theirs);
  const v = verdict(r);
  const ev = evidenceLines(r, name);
  const picks = r.picks.slice(0, 7);
  const sig = mapView.sigAngle(name);

  setWorld({ hue: 278, tint: 0.55 });

  const el = $('#reportOverlay');
  el.innerHTML = `
    <div class="rp-eyebrow">an atlas offered to yours</div>
    <h1 class="rp-name">${esc(name)}</h1>
    <p class="rp-verdict">${v.word}<span class="rp-sub">${v.sub}</span></p>
    <ul class="rp-evidence mono">${ev.map(l => `<li>${l}</li>`).join('')}</ul>
    ${picks.length ? `<div class="rp-case">
      <div class="sec-head">the case for you</div>
      ${picks.map((pk, i) => `
        <div class="rp-pick" data-i="${i}">
          <span class="no">${fmtNo(i + 1)}</span>
          <span class="nm">${esc(pk.place.name)}</span>
          <span class="why">${pk.expands ? 'new ground' : esc((pk.domainLabels[0] || '').toLowerCase())}${pk.place.rating ? ' · ' + starsText(pk.place.rating) : ''}</span>
          <button class="adopt" data-adopt="${i}">adopt</button>
        </div>`).join('')}
    </div>` : ''}
    <div class="rp-foot">
      ${store.places.length < 3 ? `<button class="word-btn" id="rpBegin">begin with a copy of this atlas</button>` : ''}
      <button class="word-btn ${store.places.length < 3 ? 'quiet' : ''}" id="rpKeep">keep ${esc(name)} as a correspondent</button>
      <button class="word-btn quiet" id="rpLook">just look around</button>
      <button class="word-btn quiet" id="rpLeave">open my atlas</button>
    </div>`;
  raiseDialog(el, 'Resonance report');
  requestAnimationFrame(() => el.querySelector('.rp-name').style.setProperty('--rp-w', 650));

  const foreignRef = { name, sig };
  $$('[data-adopt]', el).forEach(b => b.addEventListener('click', () => {
    const pk = picks[parseInt(b.dataset.adopt, 10)];
    if (!pk) return;
    adoptPlace(pk.place, foreignRef, theirs.tags);
    b.replaceWith(Object.assign(document.createElement('span'), { className: 'why', textContent: 'yours' }));
  }));
  $('#rpBegin')?.addEventListener('click', () => {
    const added = store.merge({ tags: theirs.tags, places: theirs.places });
    clearShareHash();
    toast(`${added} places are yours now. make them true`);
    setTimeout(() => location.reload(), 900);
  });
  $('#rpKeep').addEventListener('click', () => {
    const finalName = prompt('Keep this atlas under which name?', name === 'an unsigned atlas' ? '' : name);
    if (finalName === null) return;
    store.addCorrespondent({ name: finalName || name, tags: theirs.tags, places: theirs.places });
    pushCorrespondentsToMap();
    clearShareHash();
    dropDialog(el);
    clearWorld();
    renderAll();
    toast(`${finalName || name} is now a correspondent. their marks are on your field`);
  });
  $('#rpLook').addEventListener('click', () => {
    state.visiting = { id: 'visit-' + Date.now(), name, hue: 278, visible: true, tags: theirs.tags, places: theirs.places };
    mapView.setCorrespondents([...store.correspondents, state.visiting]);
    el.hidden = true;
    mapView.fitAll(theirs.places);
    toast('visiting. your atlas is untouched. esc to leave');
  });
  $('#rpLeave').addEventListener('click', () => { clearShareHash(); location.reload(); });
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

// a signature is asked for at the moment it is used, never at the door
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

function openFolioComposer({ title = '', dedication = '', places = null } = {}) {
  const pool = places || filteredPlaces();
  const chosen = new Set(pool.map(p => p.id));
  const body = $('#folioBody');

  const paint = () => {
    body.innerHTML = `
      <div class="fol-field"><input class="fol-title" id="folTitle" placeholder="Lisbon, the good part" value="${esc(title)}" maxlength="80"></div>
      <div class="fol-field"><input class="fol-ded" id="folDed" placeholder="for whom, and why. one line" value="${esc(dedication)}" maxlength="140"></div>
      <div class="fol-count">${chosen.size} of ${pool.length} places enclosed</div>
      ${pool.map(p => `
        <button class="fol-row" data-fid="${esc(p.id)}" aria-pressed="${chosen.has(p.id)}">
          <span class="in">${chosen.has(p.id) ? 'in' : 'out'}</span>
          <span class="nm">${esc(p.name)}</span>
          <span class="sub">${esc(p.city || '')}${p.rating ? ' · ' + starsText(p.rating) : ''}</span>
        </button>`).join('')}
      <div class="fol-acts">
        <button class="word-btn" id="folCopy">copy the folio link</button>
        <button class="word-btn quiet" id="folPublish">publish to the newsstand</button>
        <button class="word-btn quiet" id="folPrint">print, or save as pdf</button>
        <button class="word-btn quiet" id="folAll">everything in</button>
      </div>`;

    $$('.fol-row', body).forEach(row => row.addEventListener('click', () => {
      const id = row.dataset.fid;
      chosen.has(id) ? chosen.delete(id) : chosen.add(id);
      title = $('#folTitle').value;
      dedication = $('#folDed').value;
      paint();
    }));
    $('#folAll').addEventListener('click', () => {
      pool.forEach(p => chosen.add(p.id));
      title = $('#folTitle').value;
      dedication = $('#folDed').value;
      paint();
    });
    $('#folCopy').addEventListener('click', async () => {
      const t = $('#folTitle').value.trim();
      if (!t) { $('#folTitle').focus(); return toast('a folio needs a title'); }
      if (!chosen.size) return toast('nothing enclosed yet');
      const author = await ensureAuthor();
      const sel = pool.filter(p => chosen.has(p.id));
      const tagIds = new Set(sel.flatMap(p => p.tags));
      const url = makeFolioUrl({
        title: t,
        dedication: $('#folDed').value.trim(),
        author,
        tags: allTags().filter(x => tagIds.has(x.id)),
        places: sel,
      });
      try { await navigator.clipboard.writeText(url); toast('folio copied. hand it to one person'); }
      catch { prompt('Copy this folio:', url); }
    });
    $('#folPrint').addEventListener('click', () => {
      const t = $('#folTitle').value.trim();
      if (!t) { $('#folTitle').focus(); return toast('a folio needs a title'); }
      if (!chosen.size) return toast('nothing enclosed yet');
      printSheet({
        title: t,
        dedication: $('#folDed').value.trim(),
        places: pool.filter(p => chosen.has(p.id)),
      });
    });
    $('#folPublish').addEventListener('click', async () => {
      const t = $('#folTitle').value.trim();
      if (!t) { $('#folTitle').focus(); return toast('a folio needs a title'); }
      if (!chosen.size) return toast('nothing enclosed yet');
      const author = await ensureAuthor();
      const sel = pool.filter(p => chosen.has(p.id));
      const block = '```json\n' + publishBlock(t, $('#folDed').value.trim(), author, sel) + '\n```';
      try { await navigator.clipboard.writeText(block); } catch { return prompt('Copy this, then paste it into the issue:', block); }
      const issueUrl = 'https://github.com/jonashertner/resonate-commons/issues/new'
        + '?title=' + encodeURIComponent('folio: ' + t)
        + '&body=' + encodeURIComponent('Paste the folio below this line. It is already on your clipboard.\n\n');
      window.open(issueUrl, '_blank', 'noopener');
      toast('the folio is on your clipboard. paste it into the issue and submit');
    });
  };
  paint();
  openSurface('folioOverlay');
}

async function composeAsk() {
  const q = prompt('Ask for… (a city, a taste, anything)', '');
  if (!q || !q.trim()) return;
  const from = await ensureAuthor();
  const url = makeAskUrl({ from, q: q.trim() });
  try { await navigator.clipboard.writeText(url); toast('ask copied. send it to someone whose taste you trust'); }
  catch { prompt('Copy this ask:', url); }
}

// ---------- the sheet: the atlas typeset for paper, or pdf ----------

const DOC_TITLE = document.title;

function buildSheet({ title, dedication = '', author = store.settings.authorName, places, tagName = null }) {
  const nameOf = tagName || ((id) => tagById(id)?.name);
  const groups = new Map();
  places.forEach(p => {
    const key = [p.city, p.country].filter(Boolean).join(', ') || 'off the map';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });
  const signed = [
    author ? `kept by ${author}` : '',
    fmtDate(new Date().toISOString()).toLowerCase(),
    `${places.length} place${places.length === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ');

  let no = 0;
  const entry = (p) => {
    no += 1;
    const meta = [
      p.tags.map(nameOf).filter(Boolean).join(', ').toLowerCase(),
      p.rating ? starsText(p.rating) : (p.status === 'wishlist' ? 'want to go' : ''),
    ].filter(Boolean).join(' · ');
    return `<article class="sh-entry">
      <div class="sh-line"><span class="sh-no mono">${fmtNo(no)}</span><h3 class="sh-name">${esc(p.name)}</h3></div>
      ${meta ? `<div class="sh-meta">${esc(meta)}</div>` : ''}
      ${p.note ? `<p class="sh-note">${esc(p.note).replace(/\n/g, '<br>')}</p>` : ''}
      <div class="sh-coords mono">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
    </article>`;
  };

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
    <footer class="sh-colophon mono">resonate · jonashertner.github.io/resonate</footer>`;
}

function atlasSheetOpts() {
  const author = store.settings.authorName;
  return { title: author ? `the atlas of ${author}` : 'an atlas', places: filteredPlaces() };
}

function printSheet(opts) {
  if (!opts.places.length) return toast('nothing to print yet');
  buildSheet(opts);
  document.title = `resonate — ${opts.title}`;
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
      body.innerHTML = `<div class="news-note">The newsstand is unreachable right now. Try again with a connection.</div>`;
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
      : `<div class="news-note">nothing on the stand answers “${esc(q)}” yet. publish the folio that should.</div>`}
      <div class="news-note">Ranking happens here, against your own atlas. The newsstand never learns what you like.
      Publish from any folio you compose (&gt;folio).</div>`;
    const input = $('#newsQ');
    input.addEventListener('input', debounce(() => paint(input.value), 250));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    $$('.news-row', body).forEach(row => row.addEventListener('click', async () => {
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
      status: p.status, rating: p.rating, note: p.note,
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

function handOver(url, what) {
  const send = async () => {
    if (navigator.share) {
      try { await navigator.share({ text: url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast(`${what} copied`); }
    catch { window.prompt('Copy this:', url); }
  };
  send();
}

async function shareMap() {
  const places = allPlaces();
  if (!places.length) return toast('nothing to hand over yet');
  const author = await ensureAuthor();
  const url = makeShareUrl(allTags(), places, author);
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
        <li>addresses, cities, countries, tags, been or want to go, stars</li>
        ${withNotes ? `<li><b>${withNotes}</b> note${withNotes === 1 ? '' : 's'}, in full</li>` : ''}
        ${withLinks ? `<li><b>${withLinks}</b> link${withLinks === 1 ? '' : 's'} you saved</li>` : ''}
        <li>${author ? `signed <b>${esc(author)}</b>` : 'unsigned'}</li>
      </ul>
      <div class="sec-head">what stays</div>
      <ul class="sh-list"><li>your photos. they never leave this device.</li></ul>
      <p class="sh-warn">Anyone holding this link can read all of it. There is no undo:
      a link cannot be recalled once it is sent.</p>
      <p class="sh-size mono">${(bytes / 1024).toFixed(1)} kB of link${long ? ' · long enough that some apps will break it' : ''}</p>
    </div>
    <div class="word-row">
      ${tooLong ? '' : '<button class="word-btn" id="shGo">hand over the whole atlas</button>'}
      <button class="word-btn ${tooLong ? '' : 'quiet'}" id="shFolio">compose a folio instead</button>
      <button class="word-btn quiet" id="shFile">send a file instead</button>
    </div>
    ${tooLong ? '<p class="sh-warn">This atlas is too long to travel as a link. Hand over a folio, or send the file.</p>' : ''}`;

  $('#shGo')?.addEventListener('click', () => { closeSurface('shareOverlay'); handOver(url, 'your atlas'); });
  $('#shFolio').addEventListener('click', () => { closeSurface('shareOverlay'); openFolioComposer(); });
  $('#shFile').addEventListener('click', () => {
    closeSurface('shareOverlay');
    download('resonate-atlas.json', store.exportJSON(), 'application/json');
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
    body.innerHTML = `<p class="stat-opening">Nothing counted yet. <em>The field is waiting.</em></p>`;
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
      <div class="country-cols">${countryList.map(([c, n]) => `<div class="tally"><span class="name">${esc(c)}</span><span class="n">${n}</span></div>`).join('')}</div>` : ''}`;
}

// yours: signature and data, nothing else
function renderSettings() {
  const body = $('#settingsBody');
  body.innerHTML = `
    <div class="set-sec">
      <div class="sec-head">signature</div>
      <div class="set-row">
        <div class="set-row-sub">Your atlas signs its share links with this name.</div>
        <input class="text-input" id="authorName" style="max-width:220px" placeholder="unsigned" value="${esc(store.settings.authorName)}">
      </div>
    </div>

    <div class="set-sec">
      <div class="sec-head">your data</div>
      <div class="word-row">
        <button class="word-btn quiet" id="expJson">export json</button>
        <button class="word-btn quiet" id="expGeo">export geojson</button>
        <button class="word-btn quiet" id="expPdf">print, or save as pdf</button>
        <button class="word-btn quiet" id="impJson">import</button>
        <button class="word-btn quiet" id="eraseAll">erase this atlas</button>
      </div>
      <div class="set-row-sub" style="margin-top:10px">Everything lives in this browser. Export before switching devices, or send yourself the share link.</div>
    </div>`;

  $('#authorName').addEventListener('change', (e) => {
    store.settings.authorName = e.target.value.trim();
    store.saveSettings();
  });
  $('#expJson').addEventListener('click', () => download('resonate-atlas.json', store.exportJSON(), 'application/json'));
  $('#expGeo').addEventListener('click', () => download('resonate-atlas.geojson', store.exportGeoJSON(), 'application/geo+json'));
  $('#expPdf').addEventListener('click', () => printSheet(atlasSheetOpts()));
  $('#impJson').addEventListener('click', () => {
    const file = $('#importFile');
    file.onchange = () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
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
  $('#eraseAll').addEventListener('click', () => {
    if (!confirm('Erase every place and tag in this atlas? Export first if you want a keepsake.')) return;
    if (!confirm('This cannot be undone. Really erase everything?')) return;
    store.clearAll();
    state.selectedId = null;
    state.foreign = null;
    state.visiting = null;
    state.filters.tags.clear();
    closeSurface('settingsOverlay');
    pushCorrespondentsToMap();
    clearWorld();
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
    setWorld({ hue: picked.hue, tint: 0.8 });
    setTimeout(() => { applyWorldState(); }, 1400);
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
      if (!confirm(`Remove tag “${tag.name}”${n ? ` from ${n} place${n === 1 ? '' : 's'}` : ''}?`)) return;
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

const VERBS = {
  share: { run: shareMap, hint: 'hand your atlas to someone' },
  census: { run: () => openSurface('statsOverlay', renderStats), hint: 'the story so far' },
  stats: { run: () => openSurface('statsOverlay', renderStats), hint: 'the story so far' },
  yours: { run: () => openSurface('settingsOverlay', renderSettings), hint: 'signature, your data, erase' },
  kept: { run: () => openSurface('settingsOverlay', renderSettings), hint: 'signature, your data, erase' },
  settings: { run: () => openSurface('settingsOverlay', renderSettings), hint: 'signature, your data, erase' },
  tags: { run: () => openSurface('tagsOverlay', renderTags), hint: 'the domains of your taste' },
  voices: { run: () => openSurface('corrOverlay', renderVoices), hint: 'your correspondents' },
  keys: { run: () => openSurface('keysOverlay', renderKeys), hint: 'the keyboard' },
  frame: { run: () => mapView.fitAll(filteredPlaces()), hint: 'fit everything in view' },
  locate: { run: () => mapView.locate(null, () => toast('location unavailable')), hint: 'find me' },
  dark: { run: () => setTheme('dark'), hint: 'night field' },
  light: { run: () => setTheme('light'), hint: 'day field' },
  photo: { run: () => $('#shootFile').click(), hint: 'a photo becomes a place' },
  export: { run: () => download('resonate-atlas.json', store.exportJSON(), 'application/json'), hint: 'your data, yours' },
  print: { run: () => printSheet(atlasSheetOpts()), hint: 'the atlas typeset, to paper or pdf' },
  pdf: { run: () => printSheet(atlasSheetOpts()), hint: 'the atlas typeset, to paper or pdf' },
  import: { run: () => { openSurface('settingsOverlay', renderSettings); $('#impJson').click(); }, hint: 'bring an atlas in' },
  been: { run: () => setStatusFilter('visited'), hint: 'only places you’ve been' },
  want: { run: () => setStatusFilter('wishlist'), hint: 'only places still to go' },
  all: { run: () => setStatusFilter('all'), hint: 'everything' },
  specimen: { run: seedDemo, hint: 'a demo atlas to play with' },
  folio: { run: () => openFolioComposer(), hint: 'compose a slice to hand someone' },
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
  const m = q.match(/^(-?\d{1,2}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)$/);
  if (m) return { kind: 'coords', lat: +m[1], lng: +m[2] };
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
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name">${esc(item.p.name)} <span class="after">· after ${esc(item.c.name)}</span></span><span class="row-sub">${esc([item.p.city, item.p.country].filter(Boolean).join(' · '))}${item.p.rating ? ' · ' + starsText(item.p.rating) : ''}</span></button>`;
  }
  if (item.kind === 'local') {
    const p = item.place;
    const side = p.rating > 0 ? starsText(p.rating) : (p.status === 'wishlist' ? 'want to go' : 'been');
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
  paint([], 'asking the world…');
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
    return paint(items, items.length ? '' : store.correspondents.length ? 'no such voice' : 'no correspondents yet. >share to begin the exchange');
  }
  if (r.kind === 'coords') return paint([{ kind: 'coords', lat: r.lat, lng: r.lng }]);
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
  paint([...locals, ...voices, ...stand, ...world], '');
}


// ---------- the first evening ----------

const DISSOLVE_S = 1.4;   // matches #intro.dissolve in the stylesheet
const FILM_IN = 1.6;      // enter the evening already in motion
const FILM_TAIL = 0.9;    // the dissolve opens this long before the last frame,
                          // so the face at the end of the shot is still there

function runIntro(onDone) {
  const el = $('#intro');
  const video = $('#introVideo');
  const canvas = $('#introCanvas');
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // the evening opens every visit, not only the first
  if (RM) { onDone(); return; }
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
    store.settings.introSeen = true;
    store.saveSettings();
    document.body.classList.add('entering');
    el.classList.add('dissolve');
    clearTimeout(cutoff);
    setTimeout(() => {
      cancelAnimationFrame(raf);
      try { video.pause(); } catch { /* fine */ }
      el.hidden = true;
      document.body.classList.remove('entering');
      onDone();
    }, DISSOLVE_S * 1000);
  };

  // the film is the evening; the drawn scene only stands in until it arrives,
  // or for good if it never does
  let filmUp = false;
  cutoff = setTimeout(finish, 6200);

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
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') { finish(); document.removeEventListener('keydown', esc); }
  });
}

// ---------- init ----------

function init() {
  setWriteFailedHandler(() => toast('this browser refused to save. export your atlas before you lose it', 6000));
  store.load();

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
  // an atlas that already exists has answered this question; and someone
  // arriving on a link is answering a person, not starting an atlas
  runIntro(() => {
    if (store.settings.chosen || store.places.length || !$('#reportOverlay').hidden) return;
    openThreshold();
  });
  if (!store.settings.indexSeen && !store.settings.hintShown) {
    $('#fmHint').hidden = false;
    store.settings.hintShown = true;
    store.saveSettings();
    setTimeout(() => { $('#fmHint').hidden = true; }, 12000);
  }

  // the name waits in the middle of the field until the field is used
  const leaveHero = () => {
    if (!document.body.classList.contains('hero')) return;
    document.body.classList.remove('hero');
    $('#fmHint').hidden = true;
  };
  if (!location.hash.startsWith('#m=')) {
    document.body.classList.add('hero');
    mapView.onFirstUse(leaveHero);
    ['keydown', 'wheel'].forEach(ev =>
      document.addEventListener(ev, leaveHero, { once: true, passive: true }));
    $('#fmCommand').addEventListener('click', leaveHero, { once: true });
    $('#fmIndex').addEventListener('click', leaveHero, { once: true });
  }

  // plain words, then a choice: nothing is seeded and nobody is named until
  // the visitor has said which start they want
  function openThreshold() {
    const th = $('#threshold');
    const done = (fn) => {
      store.settings.chosen = true;
      store.saveSettings();
      dropDialog(th);
      fn?.();
    };
    $('#thSample').addEventListener('click', () => done(() => {
      seedDemo();
      toast('a sample atlas. edit anything and it becomes yours');
    }));
    $('#thEmpty').addEventListener('click', () => done(() => {
      toast('the field is yours. press the middle, or find or add below');
    }));
    $('#thHow').addEventListener('click', () => done(() => openSurface('howOverlay')));
    raiseDialog(th, 'What Resonate is');
  }

  setTimeout(() => document.body.classList.remove('boot'), 700);
  document.body.classList.add('greet');
  setTimeout(() => document.body.classList.remove('greet'), 5600);

  // shared atlas → the resonance report
  const payload = parseShareHash();
  if (payload) openReport(payload);

  // corner marks
  $('#fmIndex').addEventListener('click', () => {
    $('#indexOverlay').hidden ? openIndex() : closeSurface('indexOverlay');
  });
  $('#fmCommand').addEventListener('click', togglePalette);
  $('#indexClose').addEventListener('click', () => closeSurface('indexOverlay'));
  $('#themeWord').addEventListener('click', () => {
    setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark');
  });
  $('#indexKeys').addEventListener('click', () => {
    closeSurface('indexOverlay');
    openSurface('keysOverlay', renderKeys);
  });

  // the index is the hub: every surface reachable as a word
  $('#indexGo').addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    closeSurface('indexOverlay');
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
  let dragDepth = 0;
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) document.body.classList.add('dropping'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dropping');
    const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
    if (f) addFromPhoto(f);
  });

  // mobile: swipe up from the bottom edge = index
  let edgeY = 0;
  addEventListener('touchstart', (e) => {
    const y = e.touches[0].clientY;
    edgeY = (innerHeight - y < 34 && innerHeight - y > 6) ? y : 0;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (edgeY && edgeY - e.touches[0].clientY > 56) { openIndex(); edgeY = 0; }
  }, { passive: true });
  visualViewport?.addEventListener('resize', () => {
    $('#paletteOverlay').style.paddingBottom = `${Math.max(0, innerHeight - visualViewport.height) + 20}px`;
  });

  window.addEventListener('resize', debounce(() => mapView.invalidate(), 150));

  // keyboard
  document.addEventListener('keydown', (e) => {
    const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) ||
      document.activeElement?.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); togglePalette(); return; }
    if (e.key === 'Escape') {
      if (state.pendingAdd) { state.pendingAdd = null; $('#addConfirm').hidden = true; return; }
      if (state.visiting) { clearShareHash(); location.reload(); return; }
      if (!$('#reportOverlay').hidden) { dropDialog($('#reportOverlay')); clearWorld(); clearShareHash(); return; }
      if (popSurface()) return;
    }
    if (inField) return;
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
