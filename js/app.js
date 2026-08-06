// app.js — Resonate: state, rendering, events. Pages of one atlas.

import { store, newPlace, newTag, demoData, TAG_COLORS } from './store.js';
import { searchGeo, reverseGeo, fmtDMS, haversineKm, fmtDistance } from './geocode.js';
import * as mapView from './map.js';
import { initFrame, setCoords } from './frame.js';
import { makeShareUrl, parseShareHash, clearShareHash } from './share.js';

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

// tag colors reach the DOM inside style attributes — only ever accept real colors
function safeColor(c) {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(c ?? '')) ? c : '#5C6A77';
}

// external links may arrive via share payloads — only http(s) becomes an anchor
function safeUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch { return false; }
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function starsText(r) {
  return r > 0 ? '★'.repeat(r) : '';
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return ''; }
}

// ---------- state ----------

const state = {
  filters: { tags: new Set(), status: 'all' },
  sort: 'recent',
  selectedId: null,
  readOnly: false,
  shared: null,
};

function allPlaces() { return state.readOnly ? state.shared.places : store.places; }
function allTags() { return state.readOnly ? state.shared.tags : store.tags; }
function tagById(id) { return allTags().find(t => t.id === id); }
function placeById(id) { return allPlaces().find(p => p.id === id); }

// accession numbers: chronological, stable — the order places entered the atlas
// (id tiebreak keeps numbering deterministic when dates coincide)
function accessionMap() {
  const sorted = [...allPlaces()].sort((a, b) =>
    (a.createdAt || '').localeCompare(b.createdAt || '') || String(a.id).localeCompare(String(b.id)));
  const m = new Map();
  sorted.forEach((p, i) => m.set(p.id, i + 1));
  return m;
}

function fmtNo(n) { return String(n).padStart(2, '0'); }

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
    // "by newest" must run in exact reverse accession order, ties included
    default: list.sort((a, b) => nos.get(b.id) - nos.get(a.id));
  }
  return list;
}

// ---------- theme ----------

const media = window.matchMedia('(prefers-color-scheme: dark)');

function resolvedTheme() {
  const t = store.settings.theme;
  return t === 'auto' ? (media.matches ? 'dark' : 'light') : t;
}

function applyTheme(animated = false) {
  const mode = resolvedTheme();
  if (animated) {
    document.documentElement.classList.add('theming');
    setTimeout(() => document.documentElement.classList.remove('theming'), 340);
  }
  document.documentElement.dataset.theme = mode;
  mapView.setBasemap(mode);
}

media.addEventListener('change', () => { if (store.settings.theme === 'auto') applyTheme(); });

// ---------- rendering ----------

function renderCount() {
  const n = allPlaces().length;
  $('#placeCount').textContent = n ? `${n} ${n === 1 ? 'entry' : 'entries'}` : 'unwritten';
}

function renderChips() {
  const wrap = $('#filterChips');
  const tags = allTags();
  if (!tags.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = tags.map(t => {
    const n = allPlaces().reduce((k, p) => k + (p.tags.includes(t.id) ? 1 : 0), 0);
    const on = state.filters.tags.has(t.id);
    return `<button class="ix-filter ${on ? 'active' : ''}" data-tag="${esc(t.id)}" style="--tag-color:${safeColor(t.color)}">
      ${esc(t.name)}<sup>${n}</sup>
    </button>`;
  }).join('');
  $$('[data-tag]', wrap).forEach(chip => chip.addEventListener('click', () => {
    const id = chip.dataset.tag;
    state.filters.tags.has(id) ? state.filters.tags.delete(id) : state.filters.tags.add(id);
    renderChips(); renderList(); syncMarkers();
  }));
}

function emptyStateHTML() {
  if (allPlaces().length === 0) {
    return `<div class="frontis">
      <svg class="empty-rings" viewBox="0 0 24 24"><use href="#i-rings"/></svg>
      <span class="frontis-brand">Resonate</span>
      <h3>A Personal Atlas</h3>
      <hr>
      <p>Being a record of the places that have resonated — and of those still projected.</p>
      <button class="act-link" id="emptyAdd">Begin the atlas →</button>
      <button class="alt-link" id="emptyDemo">or open a specimen atlas</button>
    </div>`;
  }
  return `<div class="frontis">
    <svg class="empty-rings" viewBox="0 0 24 24" style="width:40px;height:40px;color:var(--ink-3)"><use href="#i-rings"/></svg>
    <h3>Nothing charted here.</h3>
    <hr>
    <p>No entries match the present arrangement.</p>
    <button class="act-link quiet" id="emptyClear">Clear the filters</button>
  </div>`;
}

function renderList() {
  const wrap = $('#listView');
  const places = filteredPlaces();
  if (!places.length) {
    wrap.innerHTML = emptyStateHTML();
    $('#emptyAdd')?.addEventListener('click', openPalette);
    $('#emptyDemo')?.addEventListener('click', seedDemo);
    $('#emptyClear')?.addEventListener('click', clearFilters);
    return;
  }
  const nos = accessionMap();
  const center = mapView.getCenter();
  const booting = document.body.classList.contains('boot');
  wrap.innerHTML = places.map((p, i) => {
    const tag = tagById(p.tags[0]);
    const locale = [p.city, p.country].filter(Boolean).join(' · ') || p.address || fmtDMS(p.lat, p.lng);
    const datum = p.rating > 0
      ? `<span class="ix-datum">${starsText(p.rating)}</span>`
      : `<span class="ix-datum plain">${fmtDistance(haversineKm(center, p))}</span>`;
    const marks = [];
    marks.push(p.status === 'visited' ? '<i class="st-been">▲</i>' : '<i class="st-wish">△</i>');
    if (tag) marks.push(`<i class="ix-tag" style="color:${safeColor(tag.color)}">${esc(tag.name)}</i>`);
    if (p.note) marks.push('<i>✎</i>');
    if (p.photos?.length) marks.push(`<i>${p.photos.length} ph.</i>`);
    return `<button class="ix-entry ${p.status === 'wishlist' ? 'wish' : ''} ${p.id === state.selectedId ? 'selected' : ''}"
      data-id="${esc(p.id)}" role="listitem" ${booting ? `style="--bi:${Math.min(i, 8)}"` : ''}>
      <span class="ix-no">${fmtNo(nos.get(p.id))}</span>
      <span class="ix-body">
        <span class="ix-l1">
          <span class="ix-name">${esc(p.name)}</span>
          <span class="ix-leader"></span>
          ${datum}
        </span>
        <span class="ix-l2">
          <span class="ix-locale">${esc(locale)}</span>
          <span class="ix-marks">${marks.join(' ')}</span>
        </span>
      </span>
    </button>`;
  }).join('');
  $$('.ix-entry', wrap).forEach(card =>
    card.addEventListener('click', () => selectPlace(card.dataset.id, { fly: true })));
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

// ---------- selection & the plate page ----------

function selectPlace(id, { fly = false, edit = false } = {}) {
  const prev = state.selectedId;
  state.selectedId = id;
  const place = placeById(id);
  if (!place) return;
  if (prev && placeById(prev)) mapView.refreshMarkerIcon(placeById(prev), tagById, false);
  mapView.refreshMarkerIcon(place, tagById, true);
  if (fly) mapView.flyToPlace(place);
  renderDetail(place, { edit });
  $('#listView').hidden = true;
  $('#detailView').hidden = false;
  $$('.ix-entry').forEach(c => c.classList.toggle('selected', c.dataset.id === id));
  if (window.innerWidth <= 760) setSheetTall(true);
}

function closeDetail() {
  const prev = state.selectedId;
  state.selectedId = null;
  if (prev && placeById(prev)) mapView.refreshMarkerIcon(placeById(prev), tagById, false);
  $('#detailView').hidden = true;
  $('#listView').hidden = false;
  renderList();
  // returning to the index re-frames the whole survey
  const places = filteredPlaces();
  if (places.length) mapView.fitAll(places);
  if (window.innerWidth <= 760) setSheetTall(false);
}

function setSheetTall(tall) {
  $('#rail').classList.toggle('tall', tall);
  document.body.classList.toggle('sheet-tall', tall);
}

function renderDetail(place, { edit = false } = {}) {
  const wrap = $('#detailView');
  const ro = state.readOnly;
  const no = accessionMap().get(place.id) || 0;

  const tagWords = allTags().map(t => {
    const on = place.tags.includes(t.id);
    return `<button class="ix-filter ${on ? 'active' : ''}" data-dtag="${esc(t.id)}" style="--tag-color:${safeColor(t.color)}" ${ro ? 'disabled' : ''}>
      ${esc(t.name)}
    </button>`;
  }).join('');

  const stars = [1, 2, 3, 4, 5].map(i =>
    `<button data-star="${i}" class="${place.rating >= i ? 'on' : ''}" ${ro ? 'disabled' : ''}
      aria-label="${i} star${i > 1 ? 's' : ''}">★</button>`).join('');

  const photos = (place.photos || []).map((src, i) =>
    `<figure class="fig">
      <img src="${esc(src)}" alt="Figure ${i + 1} for ${esc(place.name)}">
      <figcaption>Fig. ${i + 1}</figcaption>
      ${ro ? '' : `<button class="ph-x" data-phx="${i}" aria-label="Remove photo"><svg><use href="#i-x"/></svg></button>`}
    </figure>`).join('');

  wrap.innerHTML = `
    <div class="plate-top">
      <button class="act-link quiet" id="dBack">← Index</button>
    </div>
    <div class="plate-eyebrow">
      <span class="plate-no">Plate Nº ${fmtNo(no)}</span>
      <button class="plate-coords mono" id="dCoords" title="Copy coordinates">${fmtDMS(place.lat, place.lng)}</button>
    </div>
    <hr class="plate-rule">
    <h1 class="detail-name" id="dName" ${ro ? '' : 'contenteditable="plaintext-only" spellcheck="false"'}>${esc(place.name)}</h1>
    <div class="detail-address">${esc([place.address,
      place.address?.toLowerCase().includes((place.city || '~').toLowerCase()) ? '' : place.city,
      place.country].filter(Boolean).join(' · '))}</div>

    <div class="status-line" id="dStatus">
      <button class="opt ${place.status === 'visited' ? 'active' : ''}" data-st="visited" ${ro ? 'disabled' : ''}>Been</button>
      <button class="opt ${place.status === 'wishlist' ? 'active' : ''}" data-st="wishlist" ${ro ? 'disabled' : ''}>Want to go</button>
      <span class="stars-input" id="dStars">${stars}</span>
    </div>

    <div class="plate-section">
      <div class="rulehead"><span class="sc-head">Tags</span></div>
      <div class="tag-words" id="dTags">${tagWords}
        ${ro ? '' : `<button class="ix-filter" id="dNewTag">＋ new</button>`}
      </div>
    </div>

    <div class="plate-section">
      <div class="rulehead"><span class="sc-head">Notes</span></div>
      <textarea class="note-input" id="dNote" placeholder="What makes this place worth remembering…" ${ro ? 'readonly' : ''}>${esc(place.note)}</textarea>
    </div>

    <div class="plate-section">
      <div class="rulehead"><span class="sc-head">Figures</span></div>
      <div class="photo-grid" id="dPhotos">
        ${photos}
        ${ro ? '' : `<button class="photo-add" id="dAddPhoto" aria-label="Add photo"><svg><use href="#i-camera"/></svg></button>`}
      </div>
    </div>

    <div class="plate-section">
      <div class="rulehead"><span class="sc-head">Link</span></div>
      <input class="text-input" id="dUrl" type="url" placeholder="https://…" value="${esc(place.url)}" ${ro ? 'readonly' : ''}>
    </div>

    <div class="act-row">
      <button class="act-link" id="dDirections">Directions ↗</button>
      ${safeUrl(place.url) ? `<a class="act-link" id="dWebsite" href="${esc(place.url)}" target="_blank" rel="noopener">Website ↗</a>` : ''}
      ${ro ? '' : `<button class="act-link danger" id="dDelete">Remove</button>`}
    </div>

    <div class="colophon-line">Added ${fmtDate(place.createdAt)} · Nº ${fmtNo(no)}</div>`;

  // wiring
  $('#dBack').addEventListener('click', closeDetail);
  $('#dCoords').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(`${place.lat}, ${place.lng}`); toast('Coordinates copied'); }
    catch { toast('Could not copy'); }
  });
  $('#dDirections').addEventListener('click', () => {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`, '_blank', 'noopener');
  });

  if (ro) return;

  const save = (patch) => {
    store.updatePlace(place.id, patch);
    Object.assign(place, patch);
    mapView.refreshMarkerIcon(place, tagById, true);
    renderCount(); renderChips();
  };

  const nameEl = $('#dName');
  nameEl.addEventListener('blur', () => {
    const v = nameEl.textContent.trim();
    if (v && v !== place.name) save({ name: v });
    else nameEl.textContent = place.name;
  });
  nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });

  $('#dStatus').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-st]');
    if (!btn) return;
    save({ status: btn.dataset.st });
    renderDetail(place); renderList(); syncMarkers();
  });

  $('#dStars').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-star]');
    if (!btn) return;
    const v = parseInt(btn.dataset.star, 10);
    save({ rating: place.rating === v ? 0 : v });
    renderDetail(place); renderList();
  });

  $('#dTags').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-dtag]');
    if (chip) {
      const id = chip.dataset.dtag;
      const tags = place.tags.includes(id) ? place.tags.filter(t => t !== id) : [...place.tags, id];
      save({ tags });
      renderDetail(place); renderList(); syncMarkers();
      return;
    }
    if (e.target.closest('#dNewTag')) {
      const row = $('#dTags');
      const input = document.createElement('input');
      input.className = 'text-input';
      input.style.maxWidth = '140px';
      input.placeholder = 'Tag name ↵';
      row.replaceChild(input, $('#dNewTag'));
      input.focus();
      const done = () => {
        const name = input.value.trim();
        if (name) {
          const tag = store.addTag(newTag({ name, emoji: '📍', color: TAG_COLORS[store.tags.length % TAG_COLORS.length] }));
          save({ tags: [...place.tags, tag.id] });
        }
        renderDetail(place); renderChips(); renderList(); syncMarkers();
      };
      input.addEventListener('keydown', (e2) => { if (e2.key === 'Enter') done(); if (e2.key === 'Escape') renderDetail(place); });
      input.addEventListener('blur', done);
    }
  });

  $('#dNote').addEventListener('input', debounce((e) => save({ note: e.target.value }), 400));
  $('#dUrl').addEventListener('change', (e) => { save({ url: e.target.value.trim() }); renderDetail(place); });

  $('#dAddPhoto')?.addEventListener('click', () => {
    const file = $('#photoFile');
    file.onchange = async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      try {
        const dataUri = await compressImage(f);
        const photos = [...(place.photos || []), dataUri];
        store.updatePlace(place.id, { photos });
        place.photos = photos;
        if (!store.savePlaces()) toast('Storage is full — photo not saved');
        renderDetail(place); renderList();
      } catch { toast('Could not read that image'); }
    };
    file.click();
  });

  $$('#dPhotos .ph-x').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const i = parseInt(btn.dataset.phx, 10);
    const photos = place.photos.filter((_, k) => k !== i);
    save({ photos });
    renderDetail(place); renderList();
  }));

  $('#dDelete').addEventListener('click', () => {
    if (!confirm(`Remove “${place.name}” from your atlas?`)) return;
    store.removePlace(place.id);
    state.selectedId = null;
    closeDetail();
    renderAll();
    toast('Entry removed');
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

// ---------- image compression ----------

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
  selectPlace(place.id, { fly: true, edit: false });
  setTimeout(() => mapView.stampFix(place.lat, place.lng), 700);
  toast('Entered into the atlas');
  return place;
}

async function addPlaceAt(lat, lng) {
  const draft = { name: 'Dropped pin', lat, lng, address: '', city: '', country: '', countryCode: '' };
  try {
    const r = await reverseGeo(lat, lng);
    if (r) Object.assign(draft, {
      name: r.name || 'Dropped pin', address: r.address || r.sub || '',
      city: r.city, country: r.country, countryCode: r.countryCode,
    });
  } catch { /* offline is fine — keep the pin */ }
  const place = store.addPlace(newPlace({ ...draft, status: 'wishlist' }));
  store.settings.seeded = true;
  store.saveSettings();
  renderAll();
  mapView.stampFix(lat, lng);
  selectPlace(place.id, { fly: false, edit: true });
}

function seedDemo() {
  const demo = demoData();
  demo.tags.forEach(t => store.addTag(t));
  demo.places.forEach(p => store.addPlace(p));
  store.settings.seeded = true;
  store.saveSettings();
  renderAll();
  mapView.fitAll(store.places);
  toast('Specimen atlas loaded — make it yours');
}

function clearFilters() {
  state.filters.tags.clear();
  state.filters.status = 'all';
  $$('#statusSeg button').forEach(b => b.classList.toggle('active', b.dataset.status === 'all'));
  renderChips(); renderList(); syncMarkers();
}

// ---------- gazetteer (command palette) ----------

const palette = {
  overlay: null, input: null, results: null,
  hl: 0, rows: [], remoteAbort: null,
};

function openPalette() {
  palette.overlay.hidden = false;
  palette.input.value = '';
  palette.input.focus();
  renderPaletteResults('');
}

function closePalette() {
  palette.overlay.hidden = true;
  palette.remoteAbort?.abort();
}

function localMatches(q) {
  if (!q) return allPlaces().slice(0, 6);
  const needle = q.toLowerCase();
  return allPlaces().filter(p =>
    p.name.toLowerCase().includes(needle) ||
    p.city?.toLowerCase().includes(needle) ||
    p.country?.toLowerCase().includes(needle) ||
    p.note?.toLowerCase().includes(needle) ||
    p.tags.some(id => tagById(id)?.name.toLowerCase().includes(needle))
  ).slice(0, 6);
}

function paletteRowHTML(item, i) {
  if (item.kind === 'local') {
    const p = item.place;
    const side = p.rating > 0 ? starsText(p.rating) : (p.status === 'wishlist' ? 'want to go' : 'been');
    return `<button class="palette-row ${i === palette.hl ? 'hl' : ''}" data-i="${i}">
      <span class="row-main">
        <span class="row-name">${esc(p.name)}</span>
        <span class="row-sub">${esc([p.city, p.country].filter(Boolean).join(' · ') || p.address)}</span>
      </span>
      <span class="row-side">${side}</span>
    </button>`;
  }
  const r = item.result;
  return `<button class="palette-row ${i === palette.hl ? 'hl' : ''}" data-i="${i}">
    <span class="row-main">
      <span class="row-name">${esc(r.name)}</span>
      <span class="row-sub">${esc(r.sub)}</span>
    </span>
    <span class="row-side add-badge">+ enter</span>
  </button>`;
}

function paintPalette(sections) {
  palette.rows = [];
  let html = '';
  for (const s of sections) {
    if (!s.items.length) continue;
    html += `<div class="palette-section"><div class="rulehead"><span class="sc-head">${s.title}</span></div></div>`;
    for (const item of s.items) {
      html += paletteRowHTML(item, palette.rows.length);
      palette.rows.push(item);
    }
  }
  if (!html) {
    const q = palette.input.value.trim();
    html = `<div class="palette-hint">${q ? 'Consulting the gazetteer…' : 'Search your places — or anywhere on Earth.'}</div>`;
  }
  palette.results.innerHTML = html;
  $$('.palette-row', palette.results).forEach(row =>
    row.addEventListener('click', () => activatePaletteRow(parseInt(row.dataset.i, 10))));
}

function activatePaletteRow(i) {
  const item = palette.rows[i];
  if (!item) return;
  closePalette();
  if (item.kind === 'local') selectPlace(item.place.id, { fly: true });
  else if (!state.readOnly) addPlaceFromResult(item.result);
}

const remoteSearch = debounce(async (q) => {
  if (!q || q.length < 2 || state.readOnly) return;
  palette.remoteAbort?.abort();
  palette.remoteAbort = new AbortController();
  try {
    const results = await searchGeo(q, { signal: palette.remoteAbort.signal });
    if (palette.input.value.trim() !== q) return;
    const locals = localMatches(q).map(p => ({ kind: 'local', place: p }));
    const localKeys = new Set(locals.map(l => `${l.place.lat.toFixed(4)},${l.place.lng.toFixed(4)}`));
    const remote = results
      .filter(r => !localKeys.has(`${r.lat.toFixed(4)},${r.lng.toFixed(4)}`))
      .map(r => ({ kind: 'remote', result: r }));
    palette.hl = 0;
    if (!locals.length && !remote.length) {
      palette.rows = [];
      palette.results.innerHTML = `<div class="palette-hint">Nothing found for “${esc(q)}” — try the place’s full name.</div>`;
      return;
    }
    paintPalette([
      { title: 'In your atlas', items: locals },
      { title: 'The gazetteer', items: remote },
    ]);
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('search failed', e);
  }
}, 420);

function renderPaletteResults(q) {
  const locals = localMatches(q).map(p => ({ kind: 'local', place: p }));
  palette.hl = 0;
  paintPalette([
    { title: q ? 'In your atlas' : 'Recently entered', items: locals },
  ]);
  remoteSearch(q);
}

// ---------- the census (stats) ----------

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
    body.innerHTML = `<p class="stat-opening">Nothing charted yet. The sheet is all margins — <em>go fill it in.</em></p>`;
    return;
  }
  const tagRows = allTags()
    .map(t => ({ t, n: places.reduce((k, p) => k + (p.tags.includes(t.id) ? 1 : 0), 0) }))
    .filter(r => r.n > 0)
    .sort((a, b) => b.n - a.n);
  const countryList = [...countries.entries()].sort((a, b) => b[1] - a[1]);

  body.innerHTML = `
    <p class="stat-opening">${places.length} place${places.length === 1 ? '' : 's'} across
      ${countries.size} countr${countries.size === 1 ? 'y' : 'ies'} —
      ${visited.length} been, <em>${wish.length} still to go.</em></p>
    <div class="stat-band">
      <div class="stat-cell"><div class="stat-num">${places.length}</div><div class="stat-lbl">Places</div></div>
      <div class="stat-cell"><div class="stat-num">${countries.size}</div><div class="stat-lbl">Countries</div></div>
      <div class="stat-cell"><div class="stat-num">${cities.size}</div><div class="stat-lbl">Cities</div></div>
    </div>
    ${tagRows.length ? `<div class="census-section">
      <div class="rulehead"><span class="sc-head">By tag</span></div>
      ${tagRows.map(({ t, n }) => `
        <div class="tally" style="--tag-color:${safeColor(t.color)}">
          <span class="tick"></span>
          <span class="name">${esc(t.name)}</span>
          <span class="lead"></span>
          <span class="n">${n}</span>
        </div>`).join('')}
    </div>` : ''}
    ${countryList.length ? `<div class="census-section">
      <div class="rulehead"><span class="sc-head">Countries</span></div>
      <div class="country-cols">${countryList.map(([c, n]) => `
        <div class="tally">
          <span class="name">${esc(c)}</span>
          <span class="lead"></span>
          <span class="n">${n}</span>
        </div>`).join('')}
      </div>
    </div>` : ''}`;
}

// ---------- the colophon (settings) ----------

function renderSettings() {
  const body = $('#settingsBody');
  const theme = store.settings.theme;
  body.innerHTML = `
    <div class="set-section">
      <div class="rulehead"><span class="sc-head">Appearance</span></div>
      <div class="set-row">
        <div><div class="set-row-label">Theme</div><div class="set-row-sub">The chart is inked to match.</div></div>
        <div class="theme-opts" id="themeSeg">
          ${['auto', 'light', 'dark'].map(m =>
            `<button data-mode="${m}" class="ix-filter ${theme === m ? 'active' : ''}">${m}</button>`).join('')}
        </div>
      </div>
    </div>

    <div class="set-section">
      <div class="rulehead"><span class="sc-head">Tags</span></div>
      <div class="tagman" id="tagman">
        ${store.tags.map(t => `
          <div class="tagman-row" data-tid="${esc(t.id)}">
            <span class="tag-ring" style="--tag-color:${safeColor(t.color)}"></span>
            <span class="tm-name">${esc(t.name)}</span>
            <span class="tm-lead"></span>
            <span class="tm-count">${store.tagCount(t.id)}</span>
            <button class="icon-btn" data-edit aria-label="Edit tag"><svg><use href="#i-pencil"/></svg></button>
            <button class="icon-btn" data-del aria-label="Delete tag"><svg><use href="#i-trash"/></svg></button>
          </div>`).join('')}
      </div>
      <div class="tagman-add">
        <input class="text-input" id="tagEmoji" maxlength="4" placeholder="◌" style="text-align:center" aria-label="Tag emoji">
        <input class="text-input" id="tagName" placeholder="New tag name" aria-label="Tag name">
        <button class="act-link" id="tagAdd">Add</button>
      </div>
      <div class="color-dots" id="tagColors">
        ${TAG_COLORS.map((c, i) => `<button class="color-dot ${i === 0 ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="Tag colour ${c}"></button>`).join('')}
      </div>
    </div>

    <div class="set-section">
      <div class="rulehead"><span class="sc-head">Your data</span></div>
      <div class="set-actions">
        <button class="act-link quiet" id="expJson">Export JSON</button>
        <button class="act-link quiet" id="expGeo">Export GeoJSON</button>
        <button class="act-link quiet" id="impJson">Import</button>
      </div>
      <div class="set-row" style="margin-top:6px">
        <div class="set-row-sub">Everything lives in this browser. Export before switching devices — or send yourself the share link.</div>
      </div>
    </div>

    <div class="set-section">
      <div class="rulehead"><span class="sc-head">Danger</span></div>
      <div class="set-actions">
        <button class="act-link danger" id="clearAll">Erase this atlas</button>
      </div>
    </div>`;

  $('#themeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    store.settings.theme = btn.dataset.mode;
    store.saveSettings();
    applyTheme(true);
    renderSettings();
  });

  let pickedColor = TAG_COLORS[0];
  $('#tagColors').addEventListener('click', (e) => {
    const dot = e.target.closest('[data-color]');
    if (!dot) return;
    pickedColor = dot.dataset.color;
    $$('#tagColors .color-dot').forEach(d => d.classList.toggle('on', d === dot));
  });

  $('#tagAdd').addEventListener('click', () => {
    const name = $('#tagName').value.trim();
    if (!name) { $('#tagName').focus(); return; }
    const emoji = $('#tagEmoji').value.trim() || '📍';
    store.addTag(newTag({ name, emoji, color: pickedColor }));
    renderSettings(); renderChips();
    toast(`Tag “${name}” added`);
  });
  $('#tagName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#tagAdd').click(); });

  $('#tagman').addEventListener('click', (e) => {
    const row = e.target.closest('.tagman-row');
    if (!row) return;
    const id = row.dataset.tid;
    const tag = store.tagById(id);
    if (e.target.closest('[data-del]')) {
      const n = store.tagCount(id);
      if (!confirm(`Delete tag “${tag.name}”${n ? ` and remove it from ${n} place${n === 1 ? '' : 's'}` : ''}?`)) return;
      store.removeTag(id);
      renderSettings(); renderAll();
      return;
    }
    if (e.target.closest('[data-edit]')) {
      const name = prompt('Tag name', tag.name);
      if (name === null) return;
      const emoji = prompt('Emoji', tag.emoji);
      if (emoji === null) return;
      store.updateTag(id, { name: name.trim() || tag.name, emoji: emoji.trim() || tag.emoji });
      renderSettings(); renderAll();
    }
  });

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
          toast(added ? `${added} place${added === 1 ? '' : 's'} imported` : 'Nothing new to import');
        } catch { toast('That file isn’t a Resonate export'); }
      };
      reader.readAsText(f);
    };
    file.click();
  });

  $('#clearAll').addEventListener('click', () => {
    if (!confirm('Erase every place and tag in this atlas? Export first if you want a backup.')) return;
    if (!confirm('This cannot be undone. Really erase everything?')) return;
    store.clearAll();
    state.selectedId = null;
    closeOverlay($('#settingsOverlay'));
    closeDetail();
    renderAll();
    toast('Atlas erased');
  });
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- overlays ----------

function openOverlay(el) { el.hidden = false; }
function closeOverlay(el) { el.hidden = true; }

function wireOverlay(el) {
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close]')) closeOverlay(el);
  });
}

// ---------- share / read-only ----------

async function shareMap() {
  const url = makeShareUrl(allTags(), allPlaces());
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied — your whole atlas travels in it');
  } catch {
    prompt('Copy this link:', url);
  }
}

function enterReadOnly(payload) {
  state.readOnly = true;
  state.shared = {
    // share payloads are untrusted input — normalize the fields that reach markup
    tags: (payload.tags || []).map(t => newTag({ ...t, color: safeColor(t.color) })),
    places: (payload.places || [])
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .map(p => newPlace({ ...p, photos: [] })),
  };
  $('#shareBanner').hidden = false;
  $('#fabAdd').style.display = 'none';
  $('#btnShare').style.display = 'none';
  $('#btnSettings').style.display = 'none';
  $('#btnSaveCopy').addEventListener('click', () => {
    const added = store.merge({ tags: state.shared.tags, places: state.shared.places });
    clearShareHash();
    toast(added ? `Saved — ${added} place${added === 1 ? '' : 's'} added to your atlas` : 'Already in your atlas');
    setTimeout(() => location.reload(), 900);
  });
  $('#btnExitShared').addEventListener('click', () => {
    clearShareHash();
    location.reload();
  });
}

// ---------- init ----------

function init() {
  store.load();

  const payload = parseShareHash();
  if (payload) enterReadOnly(payload);

  const leafletMap = mapView.initMap({
    onMarkerClick: (id) => selectPlace(id, { fly: false }),
    onAddHere: state.readOnly ? null : (lat, lng) => addPlaceAt(lat, lng),
    onPointerMove: (lat, lng) => setCoords(lat, lng, true),
    onViewChange: debounce((view) => {
      if (state.readOnly) return;
      store.settings.lastView = view;
      store.saveSettings();
      if (state.sort === 'distance') renderList();
    }, 400),
  });
  applyTheme();
  initFrame(leafletMap);

  const places = allPlaces();
  if (state.readOnly && places.length) mapView.fitAll(places);
  else if (store.settings.lastView) mapView.setView(store.settings.lastView);
  else if (places.length) mapView.fitAll(places);

  const c = mapView.getCenter();
  setCoords(c.lat, c.lng);

  renderAll();

  // end of the drafting sequence
  setTimeout(() => document.body.classList.remove('boot'), 980);

  // gazetteer
  palette.overlay = $('#paletteOverlay');
  palette.input = $('#paletteInput');
  palette.results = $('#paletteResults');
  $('#btnSearch').addEventListener('click', openPalette);
  $('#fabAdd').addEventListener('click', openPalette);
  palette.overlay.addEventListener('click', (e) => { if (e.target === palette.overlay) closePalette(); });
  palette.input.addEventListener('input', () => renderPaletteResults(palette.input.value.trim()));
  palette.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      palette.hl = Math.max(0, Math.min(palette.rows.length - 1, palette.hl + dir));
      $$('.palette-row', palette.results).forEach((r, i) => r.classList.toggle('hl', i === palette.hl));
      $$('.palette-row', palette.results)[palette.hl]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activatePaletteRow(palette.hl);
    } else if (e.key === 'Escape') {
      closePalette();
    }
  });

  // instruments
  $('#btnZoomIn').addEventListener('click', mapView.zoomIn);
  $('#btnZoomOut').addEventListener('click', mapView.zoomOut);
  $('#btnFitAll').addEventListener('click', () => {
    const places2 = filteredPlaces();
    places2.length ? mapView.fitAll(places2) : toast('Nothing to frame yet');
  });
  $('#btnLocate').addEventListener('click', () => {
    mapView.locate(null, () => toast('Location unavailable'));
  });
  $('#btnTheme').addEventListener('click', () => {
    store.settings.theme = resolvedTheme() === 'dark' ? 'light' : 'dark';
    store.saveSettings();
    applyTheme(true);
  });
  $('#btnShare').addEventListener('click', shareMap);
  $('#btnStats').addEventListener('click', () => { renderStats(); openOverlay($('#statsOverlay')); });
  $('#btnSettings').addEventListener('click', () => { renderSettings(); openOverlay($('#settingsOverlay')); });
  wireOverlay($('#statsOverlay'));
  wireOverlay($('#settingsOverlay'));

  // status + arrangement
  $('#statusSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-status]');
    if (!btn) return;
    state.filters.status = btn.dataset.status;
    $$('#statusSeg button').forEach(b => b.classList.toggle('active', b === btn));
    renderList(); syncMarkers();
  });
  const arrangedNames = { recent: 'By newest', name: 'A – Z', distance: 'By nearest', rating: 'Top rated' };
  $('#sortSelect').addEventListener('change', (e) => {
    state.sort = e.target.value;
    $('#arrangedLabel').textContent = `${arrangedNames[state.sort]} ▾`;
    renderList();
  });

  // mobile sheet
  $('#railHandle').addEventListener('click', () => {
    setSheetTall(!$('#rail').classList.contains('tall'));
  });

  window.addEventListener('resize', debounce(() => mapView.invalidate(), 150));

  // keyboard
  document.addEventListener('keydown', (e) => {
    const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) ||
      document.activeElement?.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palette.overlay.hidden ? openPalette() : closePalette();
      return;
    }
    if (e.key === '/' && !inField && palette.overlay.hidden) {
      e.preventDefault();
      openPalette();
      return;
    }
    if (e.key === 'Escape') {
      mapView.closeAddPopup();
      if (!palette.overlay.hidden) return closePalette();
      if (!$('#statsOverlay').hidden) return closeOverlay($('#statsOverlay'));
      if (!$('#settingsOverlay').hidden) return closeOverlay($('#settingsOverlay'));
      if (!$('#detailView').hidden) return closeDetail();
    }
  });

  // pwa
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
