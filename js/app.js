// app.js — THE RESONANT FIELD
// The map is the interface. Four corner marks, one command line,
// summoned posters. One field, one ink — and one counter-ink for
// the voices of other people.

import { store, newPlace, newTag, demoData, TAG_STATIONS } from './store.js?v=rf1';
import { searchGeo, reverseGeo, fmtDMS, haversineKm, fmtDistance } from './geocode.js?v=rf1';
import * as mapView from './map.js?v=rf1';
import { makeShareUrl, parseShareHash, clearShareHash } from './share.js?v=rf1';
import { resonance, verdict, evidenceLines } from './kinship.js?v=rf1';
import { exifGPS } from './exif.js?v=rf1';

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

function starsText(r) { return r > 0 ? '★'.repeat(r) : ''; }
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

function openSurface(id, onShow) {
  if ((id === 'indexOverlay' && topSurface() === 'plate') ||
      (id === 'plate' && topSurface() === 'indexOverlay')) popSurface();
  if (surfaces.includes(id)) return;
  surfaces.push(id);
  const el = surfaceEl(id);
  el.hidden = false;
  el.classList.add('opening');
  setTimeout(() => el.classList.remove('opening'), 700);
  onShow?.();
}

function popSurface() {
  const id = surfaces.pop();
  if (!id) return false;
  surfaceEl(id).hidden = true;
  if (id === 'plate') { state.selectedId = null; state.foreign = null; syncMarkers(); applyWorldState(); }
  if (id === 'paletteOverlay') palette.remoteAbort?.abort();
  return true;
}

function closeSurface(id) {
  const i = surfaces.indexOf(id);
  if (i === -1) return;
  surfaces.splice(i, 1);
  surfaceEl(id).hidden = true;
  if (id === 'plate') { state.selectedId = null; state.foreign = null; syncMarkers(); applyWorldState(); }
}

function topSurface() { return surfaces[surfaces.length - 1]; }

// ---------- rendering: count, index ----------

function renderCount() {
  const n = allPlaces().length;
  $('#placeCount').textContent = n || '';
  $('#ixN').textContent = n;
}

function renderChips() {
  const wrap = $('#filterChips');
  wrap.innerHTML = allTags().map(t => {
    const n = allPlaces().reduce((k, p) => k + (p.tags.includes(t.id) ? 1 : 0), 0);
    const on = state.filters.tags.has(t.id);
    return `<button data-tag="${esc(t.id)}" aria-pressed="${on}">${esc(t.name)}<sup>${n}</sup></button>`;
  }).join('');
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
      ? `<div class="ix-empty">Every place that ever <b>resonated</b> — held in one field.
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
      data-id="${esc(p.id)}" role="listitem" style="--i:${i}">
      <span class="ix-l1">
        <span class="ix-no">${fmtNo(nos.get(p.id))}</span>
        <span class="ix-name">${esc(p.name)}</span>
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
}

function clearFilters() {
  state.filters.tags.clear();
  state.filters.status = 'all';
  $$('#statusSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.status === 'all')));
  renderChips(); renderList(); syncMarkers(); applyWorldState();
}

// ---------- selection & the plate ----------

function selectPlace(id, { fly = false, edit = false } = {}) {
  const prev = state.selectedId;
  state.selectedId = id;
  state.foreign = null;
  const place = placeById(id);
  if (!place) return;
  if (prev && placeById(prev)) mapView.refreshMarkerIcon(placeById(prev), tagById, false);
  mapView.refreshMarkerIcon(place, tagById, true);
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
    <figure class="fig"><img src="${esc(src)}" alt="">
      ${ro ? '' : `<button class="ph-x" data-phx="${i}">remove</button>`}</figure>`).join('');
  const canDictate = !ro && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window);

  wrap.innerHTML = `
    <div class="plate-eyebrow">
      <span>${ro ? `from ${esc(foreign.name)}’s atlas` : `№ ${fmtNo(no)}`}</span>
      <button id="pCoords" title="Copy coordinates">${fmtDMS(place.lat, place.lng)}</button>
      <button id="pClose">close</button>
    </div>
    <h1 class="plate-name" id="pName" ${ro ? '' : 'contenteditable="plaintext-only" spellcheck="false"'}>${esc(place.name)}</h1>
    <div class="plate-sub">${esc([place.address, place.city, place.country].filter(Boolean).slice(0, 2).join(' · '))}</div>
    ${place.provenance ? `<div class="plate-prov prov">after <b>${esc(place.provenance.name)}</b> · adopted ${fmtDate(place.provenance.adoptedAt)}</div>` : ''}

    ${ro ? `
      ${place.rating ? `<div class="stars-line">${starsText(place.rating).split('').map(() => '<button class="on" disabled>★</button>').join('')}</div>` : ''}
      ${place.note ? `<div class="plate-sec"><div class="plate-sec-head"><span>their note</span></div><p class="note-input" style="border-left-color:var(--counter)">${esc(place.note)}</p></div>` : ''}
      <div class="plate-acts">
        <button class="word-btn" id="pAdopt">adopt — after ${esc(foreign.name)}</button>
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
        <textarea class="note-input" id="pNote" placeholder="What makes it worth remembering…">${esc(place.note)}</textarea>
      </div>

      <div class="plate-sec">
        <div class="plate-sec-head"><span>figures</span></div>
        <div class="photo-grid" id="pPhotos">${photos}
          <button class="photo-add" id="pAddPhoto">＋ photo</button>
        </div>
      </div>

      <div class="plate-sec">
        <div class="plate-sec-head"><span>link</span></div>
        <input class="text-input" id="pUrl" type="url" placeholder="https://…" value="${esc(place.url)}">
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
    $('#pAdopt').addEventListener('click', () => adoptPlace(place, foreign));
    return;
  }

  const save = (patch) => {
    store.updatePlace(place.id, patch);
    Object.assign(place, patch);
    mapView.refreshMarkerIcon(place, tagById, true);
    renderCount(); renderChips();
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
        if (!store.savePlaces()) toast('storage is full — photo not kept');
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
    toast('no location in this photo — add the place first, then attach it');
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
  if (!store.savePlaces()) toast('storage is full — photo not kept');
  store.settings.seeded = true;
  store.saveSettings();
  renderAll();
  selectPlace(place.id, { fly: true, edit: true });
  toast('the photograph found its place');
}

// ---------- adding places ----------

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

function seedDemo() {
  const demo = demoData();
  demo.tags.forEach(t => store.addTag(t));
  demo.places.forEach(p => store.addPlace(p));
  store.settings.seeded = true;
  store.saveSettings();
  renderAll();
  closeSurface('indexOverlay');
  mapView.fitAll(store.places);
  toast('a specimen atlas — make it yours');
}

// ---------- correspondents ----------

function corrShaped(c) { return { tags: c.tags, places: c.places }; }
function myAtlas() { return { tags: store.tags, places: store.places }; }

function pushCorrespondentsToMap() {
  mapView.setCorrespondents(store.correspondents);
}

function adoptPlace(place, foreign) {
  const adopted = store.addPlace(newPlace({
    ...place,
    id: undefined,
    photos: [],
    provenance: { name: foreign.name, sig: foreign.sig, adoptedAt: new Date().toISOString() },
  }));
  renderAll();
  closeSurface('plate');
  selectPlace(adopted.id, { fly: false });
  toast(`yours now — after ${foreign.name}`);
}

function openForeignPlate(corrId, placeId) {
  const c = store.correspondents.find(x => x.id === corrId);
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
      open the link — the field will tell you what you have in common.</p>
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
        <h3 class="corr-name" contenteditable="plaintext-only" spellcheck="false">${esc(c.name)}</h3>
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
      if (!confirm(`Part ways with ${c.name}? Their marks leave your field. Places you adopted stay yours — and still say “after ${c.name}”.`)) return;
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
      <button class="word-btn" id="rpKeep">keep ${esc(name)} as a correspondent</button>
      <button class="word-btn quiet" id="rpLook">just look around</button>
      <button class="word-btn quiet" id="rpLeave">open my atlas</button>
    </div>`;
  el.hidden = false;
  requestAnimationFrame(() => el.querySelector('.rp-name').style.setProperty('--rp-w', 650));

  const foreignRef = { name, sig };
  $$('[data-adopt]', el).forEach(b => b.addEventListener('click', () => {
    const pk = picks[parseInt(b.dataset.adopt, 10)];
    if (!pk) return;
    adoptPlace(pk.place, foreignRef);
    b.replaceWith(Object.assign(document.createElement('span'), { className: 'why', textContent: 'yours' }));
  }));
  $('#rpKeep').addEventListener('click', () => {
    const finalName = prompt('Keep this atlas under which name?', name === 'an unsigned atlas' ? '' : name);
    if (finalName === null) return;
    store.addCorrespondent({ name: finalName || name, tags: theirs.tags, places: theirs.places });
    pushCorrespondentsToMap();
    clearShareHash();
    el.hidden = true;
    clearWorld();
    renderAll();
    toast(`${finalName || name} is now a correspondent — their marks are on your field`);
  });
  $('#rpLook').addEventListener('click', () => {
    state.visiting = { id: 'visit-' + Date.now(), name, hue: 278, visible: true, tags: theirs.tags, places: theirs.places };
    mapView.setCorrespondents([...store.correspondents, state.visiting]);
    el.hidden = true;
    mapView.fitAll(theirs.places);
    toast('visiting — your atlas is untouched · esc to leave');
  });
  $('#rpLeave').addEventListener('click', () => { clearShareHash(); location.reload(); });
}

// ---------- share ----------

async function shareMap() {
  let author = store.settings.authorName;
  if (!author) {
    author = prompt('Sign your atlas as…', '') || '';
    store.settings.authorName = author;
    store.saveSettings();
  }
  const url = makeShareUrl(allTags(), allPlaces(), author);
  try {
    await navigator.clipboard.writeText(url);
    toast('link copied — your whole atlas travels in it');
  } catch {
    prompt('Copy this link:', url);
  }
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
    body.innerHTML = `<p class="stat-opening">Nothing counted yet — <em>the field is waiting.</em></p>`;
    return;
  }
  const tagRows = allTags()
    .map(t => ({ t, n: places.reduce((k, p) => k + (p.tags.includes(t.id) ? 1 : 0), 0) }))
    .filter(r => r.n > 0).sort((a, b) => b.n - a.n);
  const countryList = [...countries.entries()].sort((a, b) => b[1] - a[1]);

  body.innerHTML = `
    <p class="stat-opening">${places.length} places across ${countries.size} countr${countries.size === 1 ? 'y' : 'ies'} —
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

function renderSettings() {
  const body = $('#settingsBody');
  const theme = store.settings.theme;
  body.innerHTML = `
    <div class="set-sec">
      <div class="sec-head">appearance</div>
      <div class="set-row">
        <div><div class="set-row-label">Theme</div><div class="set-row-sub">The field is inked to match.</div></div>
        <div class="word-row" id="themeSeg">
          ${['auto', 'light', 'dark'].map(m => `<button class="word-btn ${theme === m ? '' : 'quiet'}" data-mode="${m}">${m}</button>`).join('')}
        </div>
      </div>
      <div class="set-row">
        <div><div class="set-row-label">Signature</div><div class="set-row-sub">Your atlas signs its share links with this name.</div></div>
        <input class="text-input" id="authorName" style="max-width:220px" placeholder="unsigned" value="${esc(store.settings.authorName)}">
      </div>
    </div>

    <div class="set-sec">
      <div class="sec-head">tags</div>
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
        <input class="text-input" id="tagName" style="max-width:220px" placeholder="new tag name">
        <div class="hue-stations" id="tagHues">
          ${TAG_STATIONS.map((s, i) => `<button data-hue="${s.hue}" data-hex="${s.hex}" aria-pressed="${i === 4}">${s.name}</button>`).join('')}
        </div>
        <button class="word-btn" id="tagAdd">add</button>
      </div>
    </div>

    <div class="set-sec">
      <div class="sec-head">voices</div>
      <div class="set-row">
        <div class="set-row-sub">${store.correspondents.length
          ? `${store.correspondents.length} correspondent${store.correspondents.length > 1 ? 's' : ''} on your field.`
          : 'No correspondents yet — resonance is exchanged, not followed.'}</div>
        <button class="word-btn" id="openVoices">open the correspondence</button>
      </div>
    </div>

    <div class="set-sec">
      <div class="sec-head">your data</div>
      <div class="word-row">
        <button class="word-btn quiet" id="expJson">export json</button>
        <button class="word-btn quiet" id="expGeo">export geojson</button>
        <button class="word-btn quiet" id="impJson">import</button>
        <button class="word-btn quiet" id="eraseAll">erase this atlas</button>
      </div>
      <div class="set-row-sub" style="margin-top:10px">Everything lives in this browser. Export before switching devices — or send yourself the share link.</div>
    </div>`;

  $('#themeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    setTheme(b.dataset.mode);
    renderSettings();
  });
  $('#authorName').addEventListener('change', (e) => {
    store.settings.authorName = e.target.value.trim();
    store.saveSettings();
  });

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
    store.addTag(newTag({ name, hue: picked.hue, color: picked.hex }));
    renderSettings(); renderChips();
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
      renderSettings(); renderAll();
    }
    if (e.target.closest('[data-rename]')) {
      const name = prompt('Tag name', tag.name);
      if (name === null) return;
      store.updateTag(id, { name: name.trim() || tag.name });
      renderSettings(); renderAll();
    }
  });

  $('#openVoices').addEventListener('click', () => { closeSurface('settingsOverlay'); openSurface('corrOverlay', renderVoices); });
  $('#expJson').addEventListener('click', () => download('resonate-atlas.json', store.exportJSON(), 'application/json'));
  $('#expGeo').addEventListener('click', () => download('resonate-atlas.geojson', store.exportGeoJSON(), 'application/geo+json'));
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
    closeSurface('settingsOverlay');
    renderAll();
    toast('the field is blank again');
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
  kept: { run: () => openSurface('settingsOverlay', renderSettings), hint: 'settings & data' },
  settings: { run: () => openSurface('settingsOverlay', renderSettings), hint: 'settings & data' },
  voices: { run: () => openSurface('corrOverlay', renderVoices), hint: 'your correspondents' },
  keys: { run: () => openSurface('keysOverlay', renderKeys), hint: 'the keyboard' },
  frame: { run: () => mapView.fitAll(filteredPlaces()), hint: 'fit everything in view' },
  locate: { run: () => mapView.locate(null, () => toast('location unavailable')), hint: 'find me' },
  dark: { run: () => setTheme('dark'), hint: 'night field' },
  light: { run: () => setTheme('light'), hint: 'day field' },
  photo: { run: () => $('#shootFile').click(), hint: 'a photo becomes a place' },
  export: { run: () => download('resonate-atlas.json', store.exportJSON(), 'application/json'), hint: 'your data, yours' },
  import: { run: () => { openSurface('settingsOverlay', renderSettings); $('#impJson').click(); }, hint: 'bring an atlas in' },
  been: { run: () => setStatusFilter('visited'), hint: 'only places you’ve been' },
  want: { run: () => setStatusFilter('wishlist'), hint: 'only places still to go' },
  all: { run: () => setStatusFilter('all'), hint: 'everything' },
  specimen: { run: seedDemo, hint: 'a demo atlas to play with' },
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

function rowHTML(item, i) {
  const hl = i === palette.hl ? ' hl' : '';
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
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name"># ${esc(item.tag.name)}</span><span class="row-sub">${item.n} places · ${on ? 'filtered — ↵ clears' : '↵ inks the world'}</span></button>`;
  }
  if (item.kind === 'voice') {
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name">@ ${esc(item.c.name)}</span><span class="row-sub">${item.c.places.length} marks · ${item.c.visible === false ? 'muted' : 'audible'}</span></button>`;
  }
  if (item.kind === 'coords') {
    return `<button class="cmd-row${hl}" data-i="${i}"><span class="row-name">${item.lat.toFixed(4)}, ${item.lng.toFixed(4)}</span><span class="row-sub">↵ propose a place here</span></button>`;
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
  if (item.kind === 'remote') { popSurface(); addPlaceFromResult(item.r); return; }
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
}

const remoteSearch = debounce(async (q) => {
  if (!q || q.length < 2) return;
  palette.remoteAbort?.abort();
  palette.remoteAbort = new AbortController();
  try {
    const results = await searchGeo(q, { signal: palette.remoteAbort.signal });
    if (palette.input.value.trim() !== q) return;
    const locals = localMatches(q).map(p => ({ kind: 'local', place: p }));
    const keys = new Set(locals.map(l => `${l.place.lat.toFixed(4)},${l.place.lng.toFixed(4)}`));
    const remote = results
      .filter(r => !keys.has(`${r.lat.toFixed(4)},${r.lng.toFixed(4)}`))
      .map(r => ({ kind: 'remote', r }));
    // column-reverse: first row sits nearest the input
    paint([...locals, ...remote], (!locals.length && !remote.length) ? `nothing answers “${esc(q)}”` : '');
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('search failed', e);
  }
}, 420);

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
    return paint(items, items.length ? '' : store.correspondents.length ? 'no such voice' : 'no correspondents yet — >share to begin the exchange');
  }
  if (r.kind === 'coords') return paint([{ kind: 'coords', lat: r.lat, lng: r.lng }]);
  const locals = localMatches(r.rest).map(p => ({ kind: 'local', place: p }));
  paint(locals, r.rest ? '' : 'name a place — or  #tag   >verb   @voice');
  remoteSearch(r.rest);
}

// ---------- init ----------

function init() {
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
  setTimeout(() => document.body.classList.remove('boot'), 700);

  // shared atlas → the resonance report
  const payload = parseShareHash();
  if (payload) openReport(payload);

  // corner marks
  $('#fmIndex').addEventListener('click', () => {
    $('#indexOverlay').hidden ? openIndex() : closeSurface('indexOverlay');
  });
  $('#fmCommand').addEventListener('click', togglePalette);

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
      activateRow(palette.hl);
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
      if (!$('#reportOverlay').hidden) { $('#reportOverlay').hidden = true; clearWorld(); clearShareHash(); return; }
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

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
