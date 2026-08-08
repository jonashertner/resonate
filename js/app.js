// app.js — THE RESONANT FIELD
// The map is the interface. Four corner marks, one command line,
// summoned posters. One field, one ink — and one counter-ink for
// the voices of other people.

import { store, newPlace, newTag, newRoute, newFolio, demoData, baseTags, TAG_STATIONS, setWriteFailedHandler, unreadableKeys, releaseUnreadable, mayLeave } from './store.js?v=rf77';
import { parseGPX, simplify, measure, profile, encodePath, fmtKm, fmtHours, effort } from './route.js?v=rf77';
import { searchGeo, reverseGeo, fmtDMS, haversineKm, fmtDistance } from './geocode.js?v=rf77';
import * as mapView from './map.js?v=rf77';
import { makeShareUrl, makeFolioUrl, makeAskUrl, parseShareHash, clearShareHash, buildDisclosure, disclosureCounts, packDisclosure } from './share.js?v=rf77';
import { normPayload, normIndex, SCHEMA_VERSION } from './schema.js?v=rf77';
import { resonance, verdict, evidenceLines, grounds } from './kinship.js?v=rf77';
import { exifGPS } from './exif.js?v=rf77';
import { seal, unseal, makeClient, burnPatch, syncGuard, CLUB_URL, JOIN_URL } from './club.js?v=rf77';
import * as photoStore from './photos.js?v=rf77';
import { readShared, coordsIn, alreadyHeld } from './capture.js?v=rf77';

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

// ---------- writing that survives the tab closing ----------
//
// A note used to be saved on a 400ms debounce and nothing else. Type a
// sentence and close the tab inside that breath and the sentence was gone:
// the timer never fired, and nothing on screen had suggested the words were
// not yet kept. A debounce is a courtesy to the disk, and it must never be
// the only thing standing between a person and their own writing.
//
// So a pending write is held here rather than in a closure, and anything that
// means "this moment is over" flushes it first: leaving the field, closing
// the plate, hiding the tab, or the page going away. pagehide and
// visibilitychange are the last events a browser reliably gives, and on a
// phone they are often the only ones.
const pending = new Map();

function later(key, fn, ms = 400) {
  const held = pending.get(key);
  if (held) clearTimeout(held.timer);
  const timer = setTimeout(() => { pending.delete(key); fn(); }, ms);
  pending.set(key, { timer, fn });
}

function flushWrites() {
  for (const [key, { timer, fn }] of [...pending]) {
    clearTimeout(timer);
    pending.delete(key);
    try { fn(); } catch { /* the next flush is not this one's to lose */ }
  }
}

// a field that writes on a delay, and gives the words up the moment the
// person looks away from it
function writesLater(el, key, fn, ms = 400) {
  el.addEventListener('input', () => later(key, () => fn(el.value), ms));
  el.addEventListener('blur', () => flushWrites());
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

// An archive that came home short of what it carried says so. A file can be
// damaged, and a record inside it can be unreadable while the rest is fine:
// the rest is kept, and the loss is named rather than absorbed. Said after
// the first sentence has been read, so the good news is not stepped on.
// An archive that could not be handed over exactly is not handed over at all,
// and the person is told which record and which part of it stopped the
// restore. "Some of it did not fit" is not an answer a keeper of memory gives.
async function sayWhatWasLost(lost, { verb = 'bring in' } = {}) {
  const n = lost?.length || 0;
  if (!n) return;
  const lines = lost.slice(0, 6).map(l =>
    `${l.kind || 'a record'}${l.id ? ` ${l.id}` : ''}: ${l.reason}`).join('\n');
  await ask(
    `This atlas did not ${verb}, and nothing on this device changed.\n\n${lines}`
    + (n > 6 ? `\n\nand ${n - 6} more` : '')
    + '\n\nThe file is untouched. Keep it, and say what you see here: an archive that cannot come home whole is a fault in this app, not in your file.',
    { yes: 'i see', no: '' });
}

// An unparseable date does not throw: toLocaleDateString hands back the
// string "Invalid Date", which then reads as though the app knew something.
// It says nothing instead, and every caller must be ready for nothing.
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try { return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
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
function sharablePlaces() { return store.places.filter(mayLeave); }
// A way whose ends cannot be hidden is not handed over.
//
// Trimming used to give up on any path with fewer than eight points and hand
// the way over whole, which is the worst possible answer: a straight walk
// simplifies to two points, so the case where a person most wants their door
// hidden was exactly the case where both ends went out untouched, under a
// sentence promising otherwise. It fails closed now, and the ways it refuses
// are named on the surface rather than silently missing.
function sharableWays() {
  const ways = [];
  const tooShort = [];
  for (const r of store.routes) {
    if (!mayLeave(r)) continue;
    const out = store.trimWay(r);
    if (out) ways.push(out); else tooShort.push(r);
  }
  return { ways, tooShort };
}
function sharableRoutes() { return sharableWays().ways; }
const tooTitles = rs => rs.slice(0, 3).map(r => esc(r.name)).join(', ') + (rs.length > 3 ? `, and ${rs.length - 3} more` : '');
// only the domains the outgoing records actually use: an unused tag, or one
// used solely on a place that never leaves, has no business travelling
function tagsFor(places, routes) {
  const used = new Set([...places, ...routes].flatMap(r => r.tags || []));
  return allTags().filter(t => used.has(t.id));
}
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
async function fullExport(extra = null) {
  const json = await store.exportJSON(inlinePhotos, extra);
  return { json, misses: lastInlineMisses };
}

// A backup is not a backup if part of it is missing.
//
// The club refuses to seal an envelope short of photographs, and rightly:
// replacing a good copy with a poorer one is the failure that feature exists
// to prevent. The file on this side did the opposite. It wrote the incomplete
// file, downloaded it, recorded the day as a successful backup, and then
// mentioned in passing that some photographs were not in it. Someone reading
// "last backed up today" had no reason to look again, which is the worst
// thing a line like that can do.
async function exportEverything() {
  const { json, misses } = await fullExport();
  if (!misses) {
    download('resonate-atlas.json', json, 'application/json');
    store.settings.lastExportAt = new Date().toISOString();
    store.saveSettings();
    toast('your atlas is in that file, whole');
    return true;
  }
  const go = await ask(
    `This device could not read ${misses} photograph${misses === 1 ? '' : 's'}, so no backup was made.\n\n`
    + 'A file missing part of your atlas is worse than no file, because it looks like one. A browser that is busy or short of room often answers on the second ask.\n\n'
    + 'A rescue copy holds everything that could be read. It is named so you can tell it apart, it says inside itself that it is incomplete, and it does not count as your last backup.',
    { yes: 'try again', also: 'take a rescue copy', no: 'not now' });
  if (go === true) return exportEverything();
  if (go === 'also') {
    const day = new Date().toISOString().slice(0, 10);
    const rescue = await fullExport({ incomplete: true, missingPhotographs: misses });
    download(`resonate-incomplete-rescue-${day}.json`, rescue.json, 'application/json');
    toast(`a rescue copy, without ${misses} photograph${misses === 1 ? '' : 's'}. your last backup is still the one before this`, 7000);
  }
  return false;
}

// ---------- the way back in ----------
//
// An import is four steps in this order: read, decide, stage, commit.
//
// It used to be two, in the wrong order. Every photograph in the file was
// decoded and written into the picture store first, and whatever came out was
// handed to the validator afterwards. Storage happened before validation,
// which cost three things. A file that was then refused had already spent the
// room, and nothing ever gave it back. The same file imported twice minted
// fresh blobs, then discovered every record id was already held and kept none
// of them, so the pictures sat there with nothing pointing at them. And a
// file nobody had checked yet was decoded on the strength of the person
// having selected it, which is not the same as it being safe.
//
// Now nothing is written until the whole archive has been read and the
// mutation is known. Pictures are staged only for the records that will
// actually be kept, and if the commit does not happen the staged pictures go
// with it.

// the same picture twice in one file is one picture. this is a cheap fix for
// the common case, an archive that carries a photograph on two places; it does
// not reach across imports, and does not pretend to.
async function fingerprint(blob) {
  try {
    const buf = await blob.arrayBuffer();
    const sum = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(sum)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

// Put the pictures of `wanted` records into the store, and hand back an atlas
// whose records point at them. Nothing else is touched. `undo` removes every
// blob this call minted, so a commit that does not happen leaves no trace.
async function stagePhotos(atlas, wanted = null) {
  const minted = [];
  const undo = async () => {
    for (const id of minted) { try { await photoStore.del(id); } catch { /* it may already be gone */ } }
  };
  if (!atlas?.places?.length || !photoStore.available()) return { atlas, minted, undo };
  const seen = new Map(); // fingerprint -> id, within this one file
  const places = [];
  for (const p of atlas.places) {
    const inline = (p.photos || []).filter(x => typeof x === 'string' && x.startsWith('data:'));
    // a record that is not going to be written needs no pictures kept for it
    if (!inline.length || (wanted && !wanted.has(p.id))) { places.push(p); continue; }
    const photos = [];
    for (const entry of p.photos) {
      if (!(typeof entry === 'string' && entry.startsWith('data:'))) { photos.push(entry); continue; }
      const blob = photoStore.blobFromDataURL(entry);
      if (!blob) { photos.push(entry); continue; }
      const print = await fingerprint(blob);
      if (print && seen.has(print)) { photos.push(seen.get(print)); continue; }
      const id = await photoStore.put(blob);
      if (id) { minted.push(id); if (print) seen.set(print, id); }
      // a store that refused leaves the picture inline, which still renders
      photos.push(id || entry);
    }
    places.push({ ...p, photos });
  }
  return { atlas: { ...atlas, places }, minted, undo };
}

// Read, decide, stage, commit. Returns
//   { ok, added, why, lost, was, now }
// where `why` is one of 'unreadable' | 'lossy' | 'refused', and `lost` names
// every record and field the file could not hand over exactly.
async function bringHome(parsed, { replace = false } = {}) {
  const read = store.readOwn(parsed);
  if (!read.value) return { ok: false, why: 'unreadable', lost: [] };
  if (read.lost.length) return { ok: false, why: 'lossy', lost: read.lost };

  // a merge writes only what this atlas lacks, so only those records need
  // their pictures kept. a restore writes everything.
  let wanted = null;
  if (!replace) {
    const held = new Set(store.places.map(p => p.id));
    wanted = new Set(read.value.places.filter(p => !held.has(p.id)).map(p => p.id));
  }
  const staged = await stagePhotos(read.value, wanted);

  if (replace) {
    const r = store.restore(staged.atlas);
    if (!r.ok) { await staged.undo(); return { ok: false, why: r.reason, lost: r.lost || [] }; }
    await sweepPhotos();
    return { ok: true, added: r.now.places + r.now.routes, was: r.was, now: r.now, lost: [] };
  }
  const added = store.merge(staged.atlas, { own: true });
  if (added === null) { await staged.undo(); return { ok: false, why: 'refused', lost: store.lastLost || [] }; }
  // anything staged that the merge did not end up pointing at goes now, not
  // in some later session that may never come
  await sweepPhotos();
  return { ok: true, added, lost: [] };
}

// Something on this device will not read, and the app is not going to pretend
// otherwise. Nothing has been written over: the damaged bytes are still here,
// a copy is set aside, and the person chooses what happens next.
const KEY_NAMES = {
  'resonate.places.v1': 'your places',
  'resonate.routes.v1': 'your paths',
  'resonate.tags.v1': 'your domains',
  'resonate.folios.v1': 'your folios',
  'resonate.correspondents.v1': 'your voices',
  'resonate.settings.v1': 'your settings',
};

async function tellAboutDamage(damaged) {
  // say which part, and what is wrong with it: "your places" alone leaves a
  // person guessing whether the file is gone or merely refused
  const named = damaged
    .map(d => `${KEY_NAMES[d.key] || d.key}${d.why ? ` (${d.why})` : ''}`)
    .join('\n');
  const go = await ask(
    `Something on this device will not read: ${named}.\n\n`
    + 'It has not been thrown away and it has not been written over. A copy of the exact bytes is set aside on this device, and nothing will be saved into this part of your atlas until you choose.\n\n'
    + 'The rest of your atlas still works. Export what you can read before anything else, and keep that file.',
    { yes: 'export what still reads', also: 'start this part fresh', no: 'leave it for now' });
  if (go === true) {
    const { json } = await fullExport();
    download('resonate-rescued.json', json, 'application/json');
    return toast('what could be read is in that file. keep it somewhere safe', 6000);
  }
  if (go === 'also') {
    const sure = await ask(
      'Start these parts fresh? The set aside copy stays on this device, so this is not a deletion; it means this app stops waiting and begins writing again.',
      { yes: 'start fresh', no: 'stop' });
    if (!sure) return;
    damaged.forEach(d => releaseUnreadable(d.key));
    store.savePlaces(); store.saveTags(); store.saveRoutes();
    store.saveFolios(); store.saveCorrespondents(); store.saveSettings();
    renderAll();
    toast('writing again. the unreadable copy is still on this device', 5000);
  }
}

// A file the person chose is still a file. It is read whole into a string and
// parsed on the thread that draws the field, so the only honest place to say
// no is before any of that begins. Above this the tab simply stops answering
// for a few seconds, and past a browser's own string limit the read comes
// back empty and the app used to call a perfectly good archive "not a
// resonate export".
const ARCHIVE_BYTES = 96 * 1024 * 1024;

function readArchiveFile(file, onParsed) {
  if (file.size > ARCHIVE_BYTES) {
    const mb = n => `${(n / (1024 * 1024)).toFixed(0)} MB`;
    return ask(
      `That file is ${mb(file.size)}, and this build reads up to ${mb(ARCHIVE_BYTES)} in one go.\n\n`
      + 'It is not refused because anything is wrong with it. Reading it here would stop this tab answering for several seconds and could still end with the browser refusing to keep the result, which is a worse way to find out. A smaller export, or the club, will carry it.',
      { yes: 'i see', no: '' });
  }
  const reader = new FileReader();
  reader.onerror = () => toast('this device could not read that file. nothing changed');
  reader.onload = async () => {
    const text = String(reader.result || '');
    if (!text) {
      return toast('that file could not be read whole on this device. nothing changed', 6000);
    }
    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch { return toast('that file isn’t a resonate export'); }
    await onParsed(parsed);
  };
  reader.readAsText(file);
  return null;
}

// ---------- an archive arrives ----------
//
// Two operations, named, because they were never one operation.
//
// "Bring in what is missing" adds records this atlas does not have and
// touches nothing it does. "Make this atlas the file" replaces. Import used
// to be only the first, under a word that promised the second: a backup could
// not bring back an older note, a photograph that had been removed, an
// earlier shape of a way, or an atlas edited by mistake. It could only ever
// add, and a person restoring a backup had no way to learn that.
//
// The counts are shown before either word is pressed, because replacing is
// not undoable by the app and a person is owed the size of it first.
async function openArchive(parsed) {
  const seen = store.compare(parsed);
  if (!seen) return toast('that file isn’t a resonate export');
  if (seen.lost.length) return sayWhatWasLost(seen.lost);

  const held = store.places.length + store.routes.length;
  const lines = [
    `${seen.fresh} record${seen.fresh === 1 ? '' : 's'} this atlas does not have`,
    seen.differ ? `${seen.differ} it has, differently` : '',
    seen.identical ? `${seen.identical} already the same` : '',
    seen.onlyHere ? `${seen.onlyHere} here that the file does not have` : '',
  ].filter(Boolean).join('\n');

  const word = await ask(
    `This file and this atlas, side by side:\n\n${lines}\n\n`
    + 'Bring in what is missing, and nothing you already have changes. '
    + `Make this atlas the file, and the ${held} record${held === 1 ? '' : 's'} here are replaced by the ${seen.fresh + seen.differ + seen.identical} in it. `
    + 'A snapshot is taken first either way.',
    { yes: 'bring in what is missing', also: 'make this atlas the file', no: 'never mind' });
  if (!word) return;

  // whichever way this goes, the atlas as it stands is written down first
  try { await photoStore.snapshotPut(store.recordsJSON()); await photoStore.snapshotPrune(3); }
  catch { /* a device with no room for a snapshot still gets the choice */ }

  if (word === 'also') {
    const sure = await ask(
      `Replace ${held} record${held === 1 ? '' : 's'} with what is in this file? `
      + `${seen.onlyHere} record${seen.onlyHere === 1 ? '' : 's'} here that the file does not have will be gone. `
      + 'The snapshot just taken is on this device, under yours, and can be brought back.',
      { yes: 'replace this atlas', no: 'stop' });
    if (!sure) return;
  }

  const r = await bringHome(parsed, { replace: word === 'also' });
  if (!r.ok) {
    if (r.why === 'lossy') return sayWhatWasLost(r.lost, { verb: word === 'also' ? 'replace this one' : 'bring in' });
    if (r.why === 'unreadable') return toast('that file isn’t a resonate export');
    return toast('this device refused the write, so nothing changed');
  }
  renderSettings(); renderAll();
  if (store.places.length) mapView.fitAll(store.places);
  if (word === 'also') {
    toast(`this atlas is the file now. ${r.now.places} place${r.now.places === 1 ? '' : 's'}, ${r.now.routes} path${r.now.routes === 1 ? '' : 's'}`, 5000);
  } else {
    toast(r.added ? `${r.added} record${r.added === 1 ? '' : 's'} came in` : 'nothing in that file this atlas lacks');
  }
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

// A picture whose record is gone is a picture nobody can ever see again, and
// it still counts against the room. This runs after the undo window has
// closed, and only deletes what no record anywhere points at.
async function sweepPhotos() {
  if (!photoStore.available()) return 0;
  const held = new Set(store.places.flatMap(p => p.photos || []).filter(photoStore.isId));
  // A snapshot holds ids, not bytes, so a picture the atlas has stopped
  // pointing at may still be the only copy a snapshot can bring back. Anything
  // a snapshot names is spoken for; unreferenced does not mean unwanted.
  for (const key of (await photoStore.snapshotKeys()) || []) {
    const rec = await photoStore.snapshotGet(key);
    if (!rec?.json) continue;
    try {
      for (const p of JSON.parse(rec.json).places || []) {
        for (const ph of p.photos || []) if (photoStore.isId(ph)) held.add(ph);
      }
    } catch { /* an unreadable snapshot speaks for nothing */ }
  }
  const kept = (await photoStore.keys()) || [];
  let gone = 0;
  for (const id of kept) {
    if (held.has(id)) continue;
    await photoStore.del(id);
    gone += 1;
  }
  return gone;
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

// ---------- the house asks, rather than the browser ----------
//
// A native confirm escapes the focus trap, ignores the inert background, and
// wears the operating system's clothes in an app that has none. These do not.

// true, false, or the third word when one is offered. A question with two
// real answers and a way out needs three words, not a `no` doing both jobs:
// "replace everything" must never be the button that also means "never mind".
function ask(question, { yes = 'yes', no = 'no', also = '' } = {}) {
  const box = $('#askBox');
  $('#askWhat').textContent = question;
  $('#askInput').hidden = true;
  $('#askGo').textContent = yes;
  // a statement a person can only acknowledge gets one word, not a refusal
  $('#askNo').textContent = no;
  $('#askNo').hidden = !no;
  const third = $('#askAlso');
  third.textContent = also;
  third.hidden = !also;
  return new Promise((resolve) => {
    const done = (v) => {
      $('#askGo').onclick = null; $('#askNo').onclick = null; third.onclick = null;
      box.onkeydown = null;
      third.hidden = true;
      $('#askNo').hidden = false;
      dropDialog(box);
      resolve(v);
    };
    $('#askGo').onclick = () => done(true);
    $('#askNo').onclick = () => done(false);
    third.onclick = () => done('also');
    box.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    raiseDialog(box, question);
    $('#askGo').focus();
  });
}

function askText(question, { value = '', yes = 'keep', no = 'never mind', placeholder = '' } = {}) {
  const box = $('#askBox');
  const input = $('#askInput');
  $('#askWhat').textContent = question;
  input.hidden = false;
  input.value = value;
  input.placeholder = placeholder;
  $('#askGo').textContent = yes;
  $('#askNo').textContent = no;
  return new Promise((resolve) => {
    const done = (v) => {
      $('#askGo').onclick = null; $('#askNo').onclick = null; box.onkeydown = null;
      input.hidden = true;
      dropDialog(box);
      resolve(v);
    };
    $('#askGo').onclick = () => done(input.value.trim());
    $('#askNo').onclick = () => done(null);
    box.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim()); }
    };
    raiseDialog(box, question);
    input.focus(); input.select();
  });
}

// ---------- a place arrives from elsewhere ----------
//
// A share sheet, a pasted link, a set of coordinates. One surface answers all
// of them: what we understood, one choice, one press. Nothing is demanded
// that the source did not already carry.

const INBOX_KEY = 'resonate.inbox.v1';
const SHARE_DB = 'resonate-share';

function openShareDB() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(SHARE_DB, 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('shared')) db.createObjectStore('shared', { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

// What the service worker caught, one item at a time.
//
// This used to read everything and clear the store inside the same
// transaction. The transaction committed, and only then did the app try to do
// anything with what it held: a crash, a reload, or a closed tab in that gap
// took the shares with it, and the person who had just shared a place from
// their phone had no way to know it was gone. An item is taken only after the
// app has said it has it.
async function peekShared() {
  const db = await openShareDB();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('shared', 'readonly');
      const s = tx.objectStore('shared');
      const keys = s.getAllKeys();
      const vals = s.getAll();
      tx.oncomplete = () => resolve((keys.result || []).map((k, i) => ({ key: k, item: (vals.result || [])[i] })));
      tx.onabort = tx.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

function forgetShared(key) {
  return new Promise(async (resolve) => {
    const db = await openShareDB();
    if (!db) return resolve(false);
    try {
      const tx = db.transaction('shared', 'readwrite');
      tx.objectStore('shared').delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onabort = tx.onerror = () => resolve(false);
    } catch { resolve(false); }
  });
}

// erase means erase: the inbox is a separate database and was surviving it
function wipeShareDB() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(SHARE_DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve(true);
    } catch { resolve(false); }
  });
}

function inboxRead() {
  try { return JSON.parse(localStorage.getItem(INBOX_KEY) || '[]'); } catch { return []; }
}
function inboxWrite(list) {
  try { localStorage.setItem(INBOX_KEY, JSON.stringify(list.slice(-20))); } catch { /* full is full */ }
}

async function receiveShared(raw) {
  const found = readShared(raw);
  if (!found) return toast('nothing in that to keep');
  // the worker bounds what it keeps, and says when it had to. a shortened
  // share is still a share; it is not silently a whole one.
  if (raw?.shortened) toast('that share was long. the beginning of it was kept', 5000);

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

  // A name and no point. The page promises that the world is asked only when
  // a person presses for it, so a share does not quietly become a search:
  // the name is put in the command line, and the press is theirs.
  openPalette();
  palette.input.value = found.name;
  renderPaletteResults(found.name);
  toast('press to ask the world where this is');
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
  if (!$('#askBox').hidden) return true;
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
  // offsetParent is null for anything position: fixed, which the closes and
  // the bars all are: measure the box instead, or the trap loses them
  return [...el.querySelectorAll(FOCUSABLE)]
    .filter(n => n.getClientRects().length > 0 || n === document.activeElement);
}

// whichever dialog is in front holds the focus: the surface stack, or a
// report or prompt raised beside it
function frontDialog() {
  for (const id of ['askBox', 'nameAsk', 'threshold', 'reportOverlay']) {
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
  // a surface closing is a moment ending: anything half written goes down now
  flushWrites();
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
  flushWrites();
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
  const small = $('.index-count small');
  if (small) small.textContent = 'places';
  // The tally counts. It used to end with the byline, bare and uppercase with
  // nothing in front of it, which read as a word nobody could place: it sat
  // there unlabelled long enough that the person who wrote it had to ask what
  // it meant. Naming it ("kept by ada") only moved the problem, since the
  // words are wide enough at this letterspacing to wrap and orphan the name
  // on a narrow screen. The truth is it was never earning the room. This is
  // your index, showing your atlas; you know whose it is. A byline is for
  // what leaves, and it is on all of that already: the plate, the hand-over
  // panel, the printed sheet, and every link and file you give away.
  const rest = [];
  if (w) rest.push(`${w} path${w === 1 ? '' : 's'}`);
  const ways = $('#ixWays');
  if (ways) { ways.textContent = rest.join(' · '); ways.hidden = !rest.length; }
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
    wrap.insertAdjacentHTML('beforeend', `<div class="ix-band mono">paths · ${ways.length}</div>` + ways.map((r, i) => {
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

  wrap.innerHTML = `
    <div class="plate-eyebrow">
      <span>${ro ? `from ${esc(foreign.name)}’s atlas` : `№ ${fmtNo(no)}`}</span>
      <button id="pCoords" title="Copy coordinates">${fmtDMS(place.lat, place.lng)}</button>
      <button id="pClose">close</button>
    </div>
    <h1 class="plate-name" id="pName" ${ro ? '' : 'contenteditable="plaintext-only" spellcheck="false" role="textbox" aria-label="The name of this place"'}>${esc(place.name)}</h1>${place.sample && !ro ? '<span class="p-sample">sample</span>' : ''}
    <div class="plate-sub">${esc([place.address, place.city, place.country].filter(Boolean).slice(0, 2).join(' · '))}</div>
    ${place.provenance ? `<div class="plate-prov prov">after <b>${esc(place.provenance.name)}</b>${place.provenance.chain?.length ? `, who had it from ${place.provenance.chain.map(h => esc(h.name)).reverse().join(', who had it from ')}` : ''} ${fmtDate(place.provenance.adoptedAt) ? `· adopted ${fmtDate(place.provenance.adoptedAt)}` : ''}</div>` : ''}
    ${place.private && !ro ? '<div class="plate-prov held-back">this one never leaves the device</div>' : ''}

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
      </div>

      <div class="plate-sec">
        <div class="plate-sec-head"><span>tags</span></div>
        <div class="plate-words" id="pTags">${tagWords}<button id="pNewTag">＋ new</button></div>
      </div>

      <div class="plate-sec">
        <div class="plate-sec-head"><span>notes</span></div>
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
        <button class="word-btn quiet" id="pPrivate">${place.private ? 'let it travel again' : 'keep it off every link'}</button>
        <button class="word-btn quiet" id="pDelete">remove</button>
      </div>
      ${fmtDate(place.createdAt) ? `<div class="plate-foot">entered ${fmtDate(place.createdAt)}</div>` : ''}`}
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
    if (!st) return;
    save({ status: st.dataset.st });
    renderPlate(placeById(place.id)); renderList(); syncMarkers();
  });

  $('#pPrivate').addEventListener('click', () => {
    const now = !place.private;
    save({ private: now });
    renderPlate(placeById(place.id)); renderList();
    toast(now
      ? 'kept off every link, folio and publish'
      : 'this place may travel again');
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

  writesLater($('#pNote'), `note:${place.id}`, (v) => save({ note: v }));
  $('#pUrl').addEventListener('change', (e) => { save({ url: e.target.value.trim() }); renderPlate(place); });


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

  $('#pDelete').addEventListener('click', async () => {
    const inFolios = store.folios.filter(f => f.placeIds.includes(place.id));
    const warn = inFolios.length
      ? ` ${inFolios.length === 1 ? 'One folio encloses it and' : `${inFolios.length} folios enclose it and`} will stop saying it.`
      : '';
    if (!await ask(`Remove “${place.name}” from your atlas?${warn} A link already sent keeps its copy.`, { yes: 'remove it', no: 'keep it' })) return;
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
  // the blob goes where the room is BEFORE the record is written: putting a
  // three megabyte data url into the small store first fails precisely when
  // the small store is nearly full, which is when it matters
  let entry = null;
  try {
    const dataUri = await compressImage(file);
    const blob = photoStore.blobFromDataURL(dataUri);
    const id = blob ? await photoStore.put(blob) : null;
    entry = id || dataUri;
  } catch { /* keep the fix anyway */ }
  const place = store.addPlace(newPlace({
    name: 'From a photograph', lat: fix.lat, lng: fix.lng,
    status: 'visited', photos: entry ? [entry] : [],
  }));
  if (!place && photoStore.isId(entry)) await photoStore.del(entry);
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

// A point the world has no name for is still a place: a trailhead, a bench, a
// door with no sign, a spring. The field is always there and always focused,
// so the interaction is one shape whether the world answers or not, and a
// keyboard can finish it. What the world finds only fills a field the person
// has not started typing into.
let markRequest = 0;
async function proposeAdd(lat, lng) {
  const request = ++markRequest;
  const el = $('#addConfirm');
  const input = $('#addConfirmInput');
  const status = $('#addConfirmStatus');

  state.pendingAdd = { lat, lng, name: '' };
  input.value = '';
  input.dataset.typed = '';
  status.textContent = 'asking the world what is here';
  $('#addConfirmCoords').textContent = fmtDMS(lat, lng);
  el.hidden = false;
  // the point is shown and gone to, so a person can see what they are naming
  mapView.previewPin(lat, lng);
  mapView.flyToMark(lat, lng);
  input.focus();

  let r = null;
  try { r = await reverseGeo(lat, lng); }
  catch { /* offline, or the world declined: the point is still good */ }

  // A late answer must never touch a newer mark.
  if (request !== markRequest || !state.pendingAdd) return;
  // What the world knows is kept either way: the address and the city belong
  // to the point, not to the sentence on screen.
  if (r) {
    Object.assign(state.pendingAdd, {
      address: r.address || r.sub || '', city: r.city, country: r.country, countryCode: r.countryCode,
    });
  }
  // Only the words wait. Press add with an empty name while the world is
  // still being asked, and the sentence telling you to give it a name used to
  // be replaced a moment later by the world's shrug, leaving no reason on
  // screen for why nothing had happened. The app does not talk over itself.
  if (state.pendingAdd.spoke) return;
  if (r?.name && !input.dataset.typed) {
    input.value = r.name;
    status.textContent = 'the world calls it this. change it if you like';
  } else if (!r?.name) {
    status.textContent = 'the world has no name for this point';
  } else {
    status.textContent = '';
  }
}

function cancelAdd() {
  markRequest += 1;
  state.pendingAdd = null;
  $('#addConfirm').hidden = true;
  mapView.clearPreview?.();
}

function commitAdd() {
  const p = state.pendingAdd;
  if (!p) return;
  // a place is never kept under a name nobody chose
  const typed = $('#addConfirmInput').value.trim();
  if (!typed) {
    $('#addConfirmStatus').textContent = 'give it a name, and it is yours';
    // the world's answer, if it is still coming, does not get to erase this
    p.spoke = true;
    $('#addConfirmInput').focus();
    return;
  }
  p.name = typed;
  markRequest += 1;
  state.pendingAdd = null;
  $('#addConfirm').hidden = true;
  // the proposal becomes a real mark a line below; two rings on one point
  // would read as two places
  mapView.clearPreview?.();
  const place = store.addPlace(newPlace({
    name: p.name,
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
  if (!quiet) toast('a sample atlas. edit anything and it becomes yours, and there is a word under yours that clears the rest', 5500);
}

// A sample is a loan, and a loan can be given back.
//
// The demo records went into the same store as a person's own, marked with a
// flag that drew a small chip and did nothing else. So eighteen places
// somebody had never been to rode along in every export, every link, every
// folio and every club envelope as theirs, and the only way to be rid of them
// was to erase the atlas, which took their own records with it. The flag is
// cleared the moment a record is edited, so this removes exactly what is
// still untouched.
function untouchedSample() {
  return [
    ...store.places.filter(p => p.sample),
    ...store.routes.filter(r => r.sample),
  ];
}

async function dropSample() {
  const loose = untouchedSample();
  if (!loose.length) return toast('nothing here is on loan: every record is yours');
  const mine = (store.places.length + store.routes.length) - loose.length;
  const go = await ask(
    `Clear the ${loose.length} sample record${loose.length === 1 ? '' : 's'} you have not touched? `
    + (mine ? `The ${mine} you made or edited stay.` : 'Nothing else is here, so the field will be empty.'),
    { yes: 'clear the sample', no: 'keep it' });
  if (!go) return;
  for (const p of store.places.filter(x => x.sample)) store.removePlace(p.id);
  for (const r of store.routes.filter(x => x.sample)) store.removeRoute(r.id);
  renderAll();
  toast(mine ? 'the sample is gone. what is left is yours' : 'the field is yours to start');
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
      <span>${route.loop ? 'a loop' : 'a path'}${route.sample ? '' : ''}</span>
      <span>${esc(effort(m))}</span>
      <button id="pClose">close</button>
    </div>
    <h1 class="plate-name" id="pRouteName" contenteditable="plaintext-only" spellcheck="false"
        role="textbox" aria-label="The name of this path">${esc(route.name)}</h1>
    ${route.sample ? '<span class="p-sample">sample</span>' : ''}
    <div class="plate-sub">${esc([route.city, route.country].filter(Boolean).join(' · '))}</div>
    ${route.provenance ? `<div class="plate-prov prov">after <b>${esc(route.provenance.name)}</b></div>` : ''}
    ${route.private ? '<div class="plate-prov held-back">this path never leaves the device</div>' : ''}
    ${!route.private && route.trimEnds ? '<div class="plate-prov held-back">handed over without its first and last quarter kilometre</div>' : ''}

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
        aria-label="Elevation along the path: ${Math.round(m.low)} to ${Math.round(m.high)} metres over ${esc(fmtKm(m.km))}">
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
      <textarea class="note-input" id="pRouteNote" aria-label="Your note on this path"
        placeholder="When to walk it, where to start, what it asks of you…">${esc(route.note)}</textarea>
    </div>

    <div class="plate-acts">
      <button class="word-btn quiet" id="pRouteGpx">export gpx</button>
      <button class="word-btn quiet" id="pRoutePrivate">${route.private ? 'let it travel again' : 'keep it off every link'}</button>
      ${route.private ? '' : `<button class="word-btn quiet" id="pRouteTrim">${route.trimEnds ? 'hand over the whole line' : 'hide where it starts and ends'}</button>`}
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
  writesLater($('#pRouteNote'), `note:${route.id}`, (v) => save({ note: v }));
  $('#pRouteGpx').addEventListener('click', () => downloadGPX(route));
  $('#pRoutePrivate').addEventListener('click', () => {
    const now = !route.private;
    if (save({ private: now })) renderRoutePlate(routeById(route.id));
    toast(now ? 'kept off every link, folio and publish' : 'this path may travel again');
  });
  $('#pRouteTrim')?.addEventListener('click', () => {
    const now = !route.trimEnds;
    if (save({ trimEnds: now })) renderRoutePlate(routeById(route.id));
    toast(now ? 'its ends stay here. the middle travels' : 'the whole line travels');
  });
  $('#pRouteRemove').addEventListener('click', async () => {
    const wayFolios = store.folios.filter(f => f.routeIds.includes(route.id)).length;
    if (!await ask(`Remove “${route.name}” from your atlas?${wayFolios ? ` ${wayFolios === 1 ? 'One folio encloses it' : `${wayFolios} folios enclose it`} and will stop saying it.` : ''} A link already sent keeps its copy.`, { yes: 'remove it', no: 'keep it' })) return;
    store.removeRoute(route.id);
    state.selectedRouteId = null;
    popSurface();
    renderAll();
    toast('the path is gone');
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
    name: parsed.name || file.name.replace(/\.gpx$/i, '') || 'Untitled path',
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
  const safe = route.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60) || 'path';
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
    $('#ceImport').addEventListener('click', async () => {
      const url = await askText('Paste the link you were sent.', { yes: 'open it', placeholder: 'https://resonate.select/#…' });
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
      <div class="corr-meta">${fmtDate(c.addedAt) ? `since ${fmtDate(c.addedAt)} · ` : ''}${c.places.length} marks · ${v.word}</div>
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
    row.querySelector('[data-part]').addEventListener('click', async () => {
      if (!await ask(`Part ways with ${c.name}? Their marks leave your field. Places you adopted stay yours, and still say “after ${c.name}”.`, { yes: 'part ways', no: 'keep them' })) return;
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
      ${ways.length ? `<li><b>${ways.length}</b> path${ways.length === 1 ? '' : 's'} to walk</li>` : ''}
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
          <span class="no" aria-label="${r.loop ? 'a loop' : 'there and back'}">${r.loop ? '◯' : '⟋'}</span>
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
      toast(`the path is yours, after ${author}`);
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
      <div class="sec-head">the paths they walk</div>
      ${theirWays.map((r, i) => `
        <div class="rp-pick">
          <span class="no" aria-label="${r.loop ? 'a loop' : 'there and back'}">${r.loop ? '◯' : '⟋'}</span>
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
    toast(`the path is yours, after ${name}`);
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
  $('#rpKeep').addEventListener('click', async () => {
    const finalName = await askText('Keep this atlas under which name?', { value: name === 'an atlas without a byline' ? '' : name, yes: 'keep as a voice' });
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
        <span class="fs-meta mono">${n} enclosed${r.routes.length ? ` · ${r.routes.length} path${r.routes.length > 1 ? 's' : ''}` : ''}${fmtDate(f.updatedAt) ? ` · ${fmtDate(f.updatedAt)}` : ''}</span>
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
  const pool = (kept || fresh ? allPlaces() : (places || filteredPlaces())).filter(mayLeave);
  const wayPool = allRoutes().filter(mayLeave);
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
      const picked = wraySelection();
      const ways = picked.map(r => store.trimWay(r)).filter(Boolean);
      // a way too short to lose its ends does not travel half hidden
      const refused = picked.length - ways.length;
      if (refused) {
        const go = await ask(
          `${refused} enclosed path${refused === 1 ? ' asks' : 's ask'} to hide ${refused === 1 ? 'its ends' : 'their ends'} and ${refused === 1 ? 'is' : 'are'} too short to lose half a kilometre. `
          + `${refused === 1 ? 'It stays' : 'They stay'} out of this folio rather than travelling whole.`,
          { yes: 'hand over the rest', no: 'go back' });
        if (!go) return;
        if (!sel.length && !ways.length) return toast('nothing left to enclose');
      }
      const url = makeFolioUrl({
        title: t,
        dedication: $('#folDed').value.trim(),
        author,
        // a folio of ways alone still needs its vocabulary
        tags: tagsFor(sel, ways),
        places: sel,
        routes: ways,
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
      const pov = await askText('Where do you stand? One line, so a reader knows whose eyes these are.',
        { yes: 'that is it', no: 'never mind', placeholder: 'a decade of sunday mornings in basel' });
      if (pov === null) return;
      const visitedAll = await ask('Have you stood in every place enclosed?',
        { yes: 'every one', no: 'not all of them' });
      const block = '```json\n' + publishBlock(t, $('#folDed').value.trim(), author, selection(), { pov, visitedAll }) + '\n```';
      try { await navigator.clipboard.writeText(block); }
      catch { return askText('Copy this, then paste it into the issue.', { value: block, yes: 'done', no: 'close' }); }
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
    $('#folRemove')?.addEventListener('click', async () => {
      if (!await ask(`Take “${kept.title}” off the shelf? The places themselves stay in your atlas.${kept.offeredAt ? ' A copy offered to the newsstand stays there until you ask for its removal.' : ''}`, { yes: 'take it off', no: 'keep it' })) return;
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
  const q = await askText('Ask for a city, a taste, anything.', { yes: 'make the ask', placeholder: 'wine bars in lisbon' });
  if (!q || !q.trim()) return;
  const from = await ensureAuthor();
  const url = makeAskUrl({ from, q: q.trim() });
  handOver(url, 'the ask', { title: `an ask from ${from}`, text: `${from} asks: ${q.trim()}` });
}

// ---------- the sheet: the atlas typeset for paper, or pdf ----------

const DOC_TITLE = document.title;

// Photographs are typeset only here.
//
// They are the one thing in an atlas that never travels: not in a link, not in
// a file, not on the stand. A printed page is the exception that costs nothing
// to be exact about. It is handed over deliberately, one copy at a time, by a
// person standing there; there is no address that outlives the intention and
// nothing to ask to have taken down later. So the picture that reminds you is
// allowed onto the paper you give away, and nowhere else.
//
// `pictures` is a map of photograph id to a source the browser has already
// decoded. buildSheet stays synchronous, so print() is never called over an
// image that has not arrived; printSheet does the waiting.
// `spare` is the sheet a browser's own Print command gets: names, cities and
// nothing else. That path cannot ask a question, because beforeprint is
// already the last moment, so it must be the one that assumes least.
function buildSheet({ title, dedication = '', author = store.settings.authorName, places, routes = [], tagName = null, pictures = null, spare = false }) {
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
    nWays ? `${nWays} path${nWays === 1 ? '' : 's'}` : '',
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
      ${!spare && p.note ? `<p class="sh-note">${esc(p.note).replace(/\n/g, '<br>')}</p>` : ''}
      ${spare ? '' : sheetFigures(p, pictures)}
      ${spare ? '' : `<div class="sh-coords mono">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>`}
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
    ${ways ? `<h2 class="sh-city mono">paths</h2>${ways}` : ''}
    <footer class="sh-colophon mono">resonate · resonate.select</footer>`;
}

// A sheet is a hand-over like any other, so the same word decides what is on
// it. This used to read the filtered lists straight, which meant a place
// marked never leaves, and every untouched sample record, was typeset with
// its coordinates under the person's own byline. `mayLeave` had been applied
// to the files and the links and not to the paper.
function atlasSheetOpts({ spare = false } = {}) {
  const author = store.settings.authorName;
  return {
    title: author ? `the atlas of ${author}` : 'an atlas',
    places: filteredPlaces().filter(mayLeave),
    routes: filteredRoutes().filter(mayLeave).map(r => store.trimWay(r)).filter(Boolean),
    author,
    spare,
  };
}

// a row of pictures under an entry, at most four, so the page stays a page
// and does not become an album
function sheetFigures(p, pictures) {
  if (!pictures) return '';
  const found = (p.photos || []).map(ph => pictures.get(ph)).filter(Boolean).slice(0, 4);
  if (!found.length) return '';
  return `<div class="sh-figs">${found.map(src =>
    `<figure class="sh-fig"><img src="${esc(src)}" alt="Photograph of ${esc(p.name)}"></figure>`).join('')}</div>`;
}

// the pictures a set of places holds, resolved to something the browser can
// draw. an id the store cannot answer for is simply absent from the map, and
// the page is typeset without it rather than with a gap where it was.
async function sheetPictures(places) {
  const out = new Map();
  for (const p of places) {
    for (const ph of p.photos || []) {
      if (out.has(ph)) continue;
      if (!photoStore.isId(ph)) { out.set(ph, ph); continue; }
      const url = await photoStore.urlFor(ph);
      if (url) out.set(ph, url);
    }
  }
  return out;
}

// Printing is the one way out of here that carries photographs, and it was
// the one with nothing to read first. Every other exit states what it is
// about to hand over; this went from a button straight to the system dialog.
// A sheet is given to one person by hand, which is the reasoning that lets
// photographs onto it at all, but the same button says "or save as pdf", and
// a pdf is a file like any other. So the count is shown, and the pictures are
// a choice rather than an assumption.
async function printSheet(opts) {
  if (!opts.places.length && !(opts.routes || []).length) return toast('nothing to print yet');
  const pictures = await sheetPictures(opts.places);

  const nPics = [...pictures.values()].length;
  const notes = opts.places.filter(p => p.note).length + (opts.routes || []).filter(r => r.note).length;
  const lines = [
    `${opts.places.length} place${opts.places.length === 1 ? '' : 's'}`,
    (opts.routes || []).length ? `${opts.routes.length} path${opts.routes.length === 1 ? '' : 's'}` : '',
    notes ? `${notes} note${notes === 1 ? '' : 's'}, in full` : '',
    'exact coordinates',
    (opts.author ?? store.settings.authorName) ? `the byline ${opts.author ?? store.settings.authorName}` : '',
  ].filter(Boolean).join(' · ');

  let withPictures = false;
  if (nPics) {
    const word = await ask(
      `This sheet carries ${lines}.\n\n`
      + `${nPics} photograph${nPics === 1 ? '' : 's'} can go on it too. A sheet is handed to one person by someone standing there, which is why they are allowed on paper at all. Saved as a pdf it is a file like any other, and a file can be copied, forwarded and searched. Resonate cannot recall either one.`,
      { yes: 'print with the photographs', also: 'print without them', no: 'not now' });
    if (!word) return;
    withPictures = word === true;
  } else {
    if (!await ask(`This sheet carries ${lines}. It can be copied, scanned or forwarded, and Resonate cannot recall it.`,
      { yes: 'print it', no: 'not now' })) return;
  }

  buildSheet({ ...opts, pictures: withPictures ? pictures : null });
  // print() does not wait for an image, so the page waits here instead. a
  // picture that will not decode is dropped rather than printed as a hole.
  await Promise.all([...$$('#sheet img')].map(img => img.decode().catch(() => {
    img.closest('.sh-fig')?.remove();
  })));
  if (!$$('#sheet .sh-fig').length) $$('#sheet .sh-figs').forEach(el => el.remove());
  document.title = `resonate · ${opts.title}`;
  window.print();
}

// The system print command should never catch the raw map: typeset first.
//
// This path cannot wait for anything, because beforeprint is already the last
// moment. So a sheet built here carries no photographs: a picture that has not
// arrived would print as a hole, and a hole is worse than a page of words. The
// app's own print word goes through printSheet, which does wait.
// The browser's own Print command, which arrives with no chance to ask
// anything. It gets the spare sheet: what a person marked as travelling, by
// name and city, with no note, no photograph, no link, no road it came by and
// no coordinate. Anything richer than that is chosen from inside the app,
// where there is a sentence to read first.
window.addEventListener('beforeprint', () => {
  if (!$('#sheet').innerHTML) buildSheet(atlasSheetOpts({ spare: true }));
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

// The stand is a shelf, and a shelf has sections. These are computed here,
// from the same signals the ranking uses, so a reader can find the folio that
// is unlike them as easily as the one that is not.
function shelve(ranked) {
  const domains = myDomainNames();
  const cities = myCityNames();
  const now = Date.now();
  const fresh = f => f.reviewedAt && (now - Date.parse(f.reviewedAt)) < 90 * 864e5;
  const voices = new Set(store.correspondents.map(c => c.name.toLowerCase()));

  const shelves = [
    { head: 'likely to resonate', pick: ({ score }) => score > 0.8 },
    { head: 'from voices you keep', pick: ({ f }) => voices.has((f.author || '').toLowerCase()) },
    { head: 'near you', pick: ({ f }) => (f.cities || []).some(c => cities.has(c.toLowerCase())) },
    { head: 'small and specific', pick: ({ f }) => f.n > 0 && f.n <= 7 && (f.cities || []).length <= 1 },
    { head: 'recently reviewed', pick: ({ f }) => fresh(f) },
    { head: 'deliberately unlike your atlas', pick: ({ f }) => !(f.tags || []).some(t => domains.has(t.toLowerCase())) },
  ];
  const seen = new Set();
  const out = [];
  for (const sh of shelves) {
    const rows = ranked.filter(r => !seen.has(r.f.file) && sh.pick(r)).slice(0, 4);
    rows.forEach(r => seen.add(r.f.file));
    if (rows.length) out.push({ head: sh.head, rows });
  }
  const rest = ranked.filter(r => !seen.has(r.f.file));
  if (rest.length) out.push({ head: 'the rest of the stand', rows: rest });
  return out;
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
      ${ranked.length ? (q ? [{ head: '', rows: ranked }] : shelve(ranked)).map(sec => `
        ${sec.head ? `<div class="sec-head">${esc(sec.head)}</div>` : ''}
        ${sec.rows.map(({ f, why }) => `
        <button class="news-row" data-file="${esc(f.file)}">
          <span class="t1"><span class="nm">${esc(f.title)}</span><span class="by">${esc(f.author)} · ${f.n}</span></span>
          <span class="t2">
            ${(f.cities || []).slice(0, 3).map(c => `<span>${esc(c)}</span>`).join('')}
            ${f.visitedAll ? '<span>stood in every one</span>' : ''}
            ${f.reviewedAt ? `<span>reviewed ${esc(fmtDate(f.reviewedAt).toLowerCase())}</span>` : ''}
            <span class="why">${esc(why)}</span>
          </span>
          ${f.pov ? `<span class="t2"><span class="why">${esc(f.pov)}</span></span>` : ''}
        </button>`).join('')}`).join('')
      : `<div class="news-note">nothing on the stand answers “${esc(q)}” yet. offer the folio that should.</div>`}
      <div class="news-note">The shelves and their order are computed here, against your own atlas, from cities you
      both keep places in and domains you share. The newsstand never learns what you like. Every folio on it says
      where its author stands and whether they have been to every place in it. Standards: <a href="COMMONS.md">/COMMONS.md</a>.
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

function publishBlock(title, dedication, author, sel, decl = {}) {
  const tagName = new Map(allTags().map(t => [t.id, t.name]));
  return JSON.stringify({
    title, dedication, author,
    // what a public folio declares about itself
    pov: decl.pov || '', scope: decl.scope || '',
    visitedAll: decl.visitedAll === true,
    reviewedAt: new Date().toISOString().slice(0, 10),
    language: (navigator.language || 'en').slice(0, 2),
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
    } catch { askText('Copy this link.', { value: url, yes: 'done', no: 'close' }); }
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
  const { ways: routes, tooShort } = sharableWays();
  // an atlas of ways and no places is still an atlas. this used to stop at
  // the places and never look at the ways it had just finished computing, so
  // a person who kept only walks could not hand over anything at all.
  const kept = (allPlaces().length - places.length) + (allRoutes().length - routes.length - tooShort.length);
  if (!places.length && !routes.length) {
    return toast(kept || tooShort.length
      ? 'everything here is marked as never leaving, or is too short to hide its ends'
      : 'nothing to hand over yet');
  }
  const author = await ensureAuthor();
  const tags = tagsFor(places, routes);
  // the panel and the payload read the same object, so they cannot disagree
  const disclosure = buildDisclosure({ places, routes, tags, author, forLink: true });
  const count = disclosureCounts(disclosure);
  const url = packDisclosure(disclosure);
  const bytes = url.length;
  const tooLong = bytes > LINK_HARD_LIMIT;
  const long = bytes > LINK_SOFT_LIMIT;

  const body = $('#shareBody');
  body.innerHTML = `
    <div class="sh-what">
      <div class="sec-head">what travels</div>
      <ul class="sh-list">
        ${count.places ? `<li><b>${count.places}</b> place${count.places === 1 ? '' : 's'}: names and coordinates</li>` : ''}
        ${count.routes ? `<li><b>${count.routes}</b> path${count.routes === 1 ? '' : 's'}: a shape, its distance and its climb${routes.some(r => r.trimEnds) ? ', without the ends you hid' : ''}</li>` : ''}
        <li>addresses, cities, countries, tags, been or want to go</li>
        ${count.notes ? `<li><b>${count.notes}</b> note${count.notes === 1 ? '' : 's'}, in full, on places and paths alike</li>` : ''}
        ${count.links ? `<li><b>${count.links}</b> link${count.links === 1 ? '' : 's'} you saved</li>` : ''}
        ${count.bylines ? `<li><b>${count.bylines}</b> earlier byline${count.bylines === 1 ? '' : 's'}: the road these places travelled to reach you</li>` : ''}
        <li>${author ? `byline <b>${esc(author)}</b>` : 'no byline'}</li>
      </ul>
      <div class="sec-head">what stays</div>
      <ul class="sh-list">
        <li>your photographs. nothing handed over from here carries one, by link or by file. only a page you print does.</li>
        <li>your voices, and everything under yours.</li>
      </ul>
      <p class="sh-warn">Anyone holding this link can read all of it. There is no undo:
      a link cannot be recalled once it is sent.</p>
      ${kept ? `<p class="sh-warn">${kept} record${kept === 1 ? '' : 's'} marked <b>never leaves</b> stay${kept === 1 ? 's' : ''} behind. Mark any place or path that way from its own plate.</p>` : ''}
      ${tooShort.length ? `<p class="sh-warn">${tooShort.length} path${tooShort.length === 1 ? '' : 's'} asked to hide ${tooShort.length === 1 ? 'its ends' : 'their ends'} but ${tooShort.length === 1 ? 'is' : 'are'} too short to lose half a kilometre. ${tooShort.length === 1 ? 'It stays' : 'They stay'} behind rather than travelling whole: ${tooTitles(tooShort)}.</p>` : ''}
      <p class="sh-size mono">${(bytes / 1024).toFixed(1)} kB of link${long ? ' · long enough that some apps will break it' : ''}${routes.length ? ' · a link carries a coarser shape than the file' : ''}</p>
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
    // the same object the link carries, written out rather than encoded. the
    // file used to be built somewhere else entirely, so it disclosed more
    // than the panel above it described: every domain in the atlas, and the
    // dates every record was made and last touched.
    const file = buildDisclosure({ places, routes, tags, author });
    download('resonate-atlas.json',
      JSON.stringify({ app: 'resonate', exportedAt: new Date().toISOString(), ...file }, null, 2),
      'application/json');
    toast('a file of the same places, with the paths drawn in full. your photographs stayed here', 4500);
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
    store.routes.length ? `${store.routes.length} path${store.routes.length === 1 ? '' : 's'}` : '',
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
        <button class="word-btn quiet" id="expGeo">geojson</button>
        <button class="word-btn quiet" id="expKml">kml</button>
        <button class="word-btn quiet" id="expCsv">csv</button>
        <button class="word-btn quiet" id="expMd">markdown</button>
        <button class="word-btn quiet" id="expPdf">print, or save as pdf</button>
        <button class="word-btn quiet" id="impJson">bring a file in</button>
        ${untouchedSample().length ? '<button class="word-btn quiet" id="dropSample">clear the sample</button>' : ''}
        <button class="word-btn quiet" id="eraseAll">erase this atlas</button>
      </div>
      <div class="set-row-sub" style="margin-top:10px">An atlas must be able to leave for anywhere: geojson for maps, kml for google earth, csv for a spreadsheet, markdown for a person to read in fifty years. None of them carries a place you marked as never leaving. Everything lives in this browser. <b>Export everything</b> is your backup: it carries your photographs, your voices and your settings, so keep it to yourself. A file handed to someone else, from <b>hand over</b>, carries none of those.</div>
      <div class="set-row-sub" style="margin-top:10px"><b>Bring a file in</b> asks which you mean before it does anything: add what this atlas is missing, or make this atlas the file. The second replaces, and is how a backup actually comes home; a snapshot of what is here is taken first either way.${untouchedSample().length ? ` <b>Clear the sample</b> removes the ${untouchedSample().length} demonstration record${untouchedSample().length === 1 ? '' : 's'} you have not edited. Anything you touched is yours and stays.` : ''}</div>
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
    // No sweeping here. This used to let go of every picture no current record
    // pointed at, one breath before offering to bring back the records that
    // pointed at them: a person who deleted a place and then reached for a
    // snapshot got the place back with its photographs already destroyed. The
    // snapshots hold ids, not bytes, so the pictures they name are exactly the
    // ones an unreferenced sweep would take.
    const keys = (await photoStore.snapshotKeys()) || [];
    if (!keys.length) return toast('no snapshot has been taken on this device yet');
    const newest = keys.sort().reverse();
    const when = newest.map(k => fmtDate(k).toLowerCase());
    const pick = await askText(`Snapshots on this device: ${when.map((w, i) => `${i + 1}. ${w}`).join(' · ')}. Which one?`, { value: '1', yes: 'look at it' });
    const i = parseInt(pick, 10) - 1;
    if (!Number.isFinite(i) || i < 0 || i >= newest.length) return;
    const rec = await photoStore.snapshotGet(newest[i]);
    if (!rec?.json) return toast('that snapshot could not be read');
    let parsed = null;
    try { parsed = JSON.parse(rec.json); }
    catch { return toast('that snapshot could not be read'); }

    // A snapshot is an archive like any other, so it gets the same two words a
    // file does. It used to offer one operation under a word that promised the
    // other: "bring it home" ran an additive merge, which cannot bring back an
    // older note, an earlier shape, a photograph you removed or a place you
    // edited by mistake. It only ever helped when a record was entirely gone,
    // which is not what a person reaching for a snapshot is usually afraid of.
    const seen = store.compare(parsed);
    if (!seen) return toast('that snapshot could not be read');
    if (seen.lost.length) return sayWhatWasLost(seen.lost, { verb: 'come home' });
    const held = store.places.length + store.routes.length;
    const word = await ask(
      `The snapshot from ${when[i]}, beside this atlas:\n\n`
      + [`${seen.fresh} record${seen.fresh === 1 ? '' : 's'} this atlas no longer has`,
        seen.differ ? `${seen.differ} it has, differently` : '',
        seen.identical ? `${seen.identical} already the same` : '',
        seen.onlyHere ? `${seen.onlyHere} here that the snapshot does not have` : ''].filter(Boolean).join('\n')
      + `\n\nBring back what is missing, and nothing you have now changes. Go back to the snapshot, and the ${held} record${held === 1 ? '' : 's'} here are replaced by what it holds. A snapshot of now is taken first either way.`,
      { yes: 'bring back what is missing', also: 'go back to this snapshot', no: 'never mind' });
    if (!word) return;

    try { await photoStore.snapshotPut(store.recordsJSON()); await photoStore.snapshotPrune(4); }
    catch { /* a device with no room for one more still gets the choice */ }

    if (word === 'also') {
      const sure = await ask(
        `Replace ${held} record${held === 1 ? '' : 's'} with the snapshot from ${when[i]}? `
        + `${seen.onlyHere} record${seen.onlyHere === 1 ? '' : 's'} made since then will be gone. The snapshot just taken holds them.`,
        { yes: 'go back', no: 'stop' });
      if (!sure) return;
    }

    const r = await bringHome(parsed, { replace: word === 'also' });
    if (!r.ok) {
      if (r.why === 'lossy') return sayWhatWasLost(r.lost, { verb: 'come home' });
      return toast('this device refused the write, so nothing changed');
    }
    renderAll();
    toast(word === 'also'
      ? `this atlas is the snapshot from ${when[i]}. ${r.now.places} place${r.now.places === 1 ? '' : 's'}`
      : (r.added ? `${r.added} record${r.added === 1 ? '' : 's'} came home from ${when[i]}` : 'that snapshot holds nothing this atlas lacks'));
  });

  $('#authorName').addEventListener('change', (e) => {
    store.settings.authorName = e.target.value.trim();
    store.saveSettings();
  });
  $('#expJson').addEventListener('click', async () => {
    await exportEverything();
    paintKept('#setKept');
  });
  $('#expGeo').addEventListener('click', () => download('resonate-atlas.geojson', store.exportGeoJSON(), 'application/geo+json'));
  $('#expKml').addEventListener('click', () => download('resonate-atlas.kml', store.exportKML(), 'application/vnd.google-earth.kml+xml'));
  $('#expCsv').addEventListener('click', () => download('resonate-atlas.csv', store.exportCSV(), 'text/csv'));
  $('#expMd').addEventListener('click', () => download('resonate-atlas.md', store.exportMarkdown(), 'text/markdown'));
  $('#expPdf').addEventListener('click', () => printSheet(atlasSheetOpts()));
  $('#impJson').addEventListener('click', () => {
    const file = $('#importFile');
    file.onchange = () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      readArchiveFile(f, openArchive);
    };
    file.click();
  });
  $('#dropSample')?.addEventListener('click', async () => { await dropSample(); renderSettings(); });
  $('#eraseAll').addEventListener('click', async () => {
    if (!await ask('Erase every place and tag in this atlas? Export first if you want a keepsake.', { yes: 'go on', no: 'not yet' })) return;
    if (!await ask('Gone means gone here. Links sent, files exported, and envelopes at the club are not reached; the club key is kept so a backup can come home. Really erase?', { yes: 'erase everything', no: 'stop' })) return;
    store.clearAll();
    await photoStore.clear();
    // the share inbox is a database of its own, and was surviving an erase:
    // a place shared in from a phone and not yet placed would still have been
    // sitting there afterwards, which is not what the word means
    await wipeShareDB();
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

  $('.tag-rows', body).addEventListener('click', async (e) => {
    const row = e.target.closest('[data-tid]');
    if (!row) return;
    const id = row.dataset.tid;
    const tag = store.tagById(id);
    if (e.target.closest('[data-del]')) {
      const n = store.tagCount(id);
      if (!await ask(`Remove tag “${tag.name}”${n ? ` from ${n} place${n === 1 ? '' : 's'}` : ''}? The places keep their other tags.`, { yes: 'remove it', no: 'keep it' })) return;
      store.removeTag(id);
      renderTags(); renderAll();
    }
    if (e.target.closest('[data-rename]')) {
      const name = await askText('What should this domain be called?', { value: tag.name, yes: 'rename it' });
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
    ['drop a gpx', 'a walk becomes a path'],
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
        <button class="word-btn" id="clubSync">back it up now</button>
        <button class="word-btn quiet" id="clubPrev">the envelope before</button>
      </div>
      <div class="set-row-sub" id="clubMeta" style="margin-top:10px"></div>
      <div class="set-row-sub" style="margin-top:10px">This is a backup, not a sync, and the word matters. It brings home what the envelope holds and this atlas lacks, then seals everything back. It never changes a record this device already has, and it never carries a deletion: remove a place here and the envelope still holds it until this device seals again. Two devices are not kept in step; each one adds to the envelope and neither overwrites the other. Lose the phrase and the envelope is lost with it; nobody can open it for you.</div>
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
      if (!await ask(`The envelope before was sealed ${when} and holds ${nHeld} record${nHeld === 1 ? '' : 's'}. Bring home what it holds and this atlas lacks? Nothing here is deleted, and nothing is sealed until you back up again.`, { yes: 'bring it home', no: 'leave it' })) return;
      const r = await bringHome(atlas);
      if (!r.ok) {
        if (r.why === 'lossy') return sayWhatWasLost(r.lost, { verb: 'come home' });
        return toast('this device refused the write, so nothing changed');
      }
      if (r.added) renderAll();
      toast(r.added ? `${r.added} record${r.added === 1 ? '' : 's'} came home from the envelope before` : 'this atlas already holds everything the envelope before does');
    } catch { toast('the vault did not answer'); }
    finally { btn.disabled = false; }
  });
  $('#clubBurn').addEventListener('click', async () => {
    if (!await ask('Burn both envelopes at the club? Your atlas here is untouched, and the key stays so you can seal again. If an envelope would not open on this device, burning still destroys it everywhere.', { yes: 'burn them', no: 'keep them' })) return;
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
  // The vault refuses a seal written over a revision this device did not read.
  // That refusal is the whole point: two devices used to be able to read the
  // same envelope and then overwrite one another, and the loser's records went
  // with no trace. A refusal means someone else sealed in the seconds since
  // this device looked, and the answer is to look again rather than to insist.
  // One retry, then a sentence; never a blind rewrite.
  try {
    let done = await sealOnce(phrase);
    if (done === 'stale') done = await sealOnce(phrase);
    if (done === 'stale') toast('another device sealed while this one was reading. nothing written; try once more', 6000);
  } catch (e) {
    toast(e.message === 'lapsed' ? 'the membership has lapsed. renewing lets you seal again'
      : e.message === 'too-large' ? 'the atlas is too large for one envelope'
      : 'the club did not answer');
  } finally {
    btn.disabled = false; btn.textContent = 'back it up now';
  }
}

// one read, one merge, one seal. returns 'stale' when the club refused because
// the envelope moved underneath, and undefined otherwise.
async function sealOnce(phrase) {
  {
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
      const home = await bringHome(atlas);
      if (!home.ok) {
        // an envelope this device could not read whole must never be sealed
        // over by one it wrote from a poorer copy. the promise on this panel
        // is that the envelope is safer than the device, and this is where
        // that promise is either kept or quietly broken.
        if (home.why === 'lossy') {
          await sayWhatWasLost(home.lost, { verb: 'come home' });
          toast('nothing was sealed over the envelope', 6000);
        } else {
          toast('this device refused the write, so nothing was sealed over the envelope', 6000);
        }
        return;
      }
      brought = home.added;
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
    let meta;
    try { meta = await c.putVault(sealed); }
    catch (e) { if (e.message === 'stale') return 'stale'; throw e; }
    store.settings.clubSeq = seq;
    store.settings.clubSealedAt = meta.at;
    store.saveSettings();
    $('#clubMeta').textContent = `last sealed ${meta.at.slice(0, 10)}, ${meta.bytes.toLocaleString()} bytes, ${sealed[5] === 2 ? 'argon2id' : 'pbkdf2'}`;
    toast(brought
      ? `${brought} place${brought === 1 ? '' : 's'} came home. everything sealed and kept`
      : 'sealed and kept');
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
  club: { run: () => openSurface('clubOverlay', renderClub), hint: 'the travellers club. an encrypted backup, off this device' },
  keys: { run: () => openSurface('keysOverlay', renderKeys), hint: 'the keyboard' },
  mark: { run: () => { const c = mapView.getCenter(); proposeAdd(c.lat, c.lng); }, hint: 'mark the middle of the field, named by you' },
  here: { run: () => { const c = mapView.getCenter(); proposeAdd(c.lat, c.lng); }, hint: 'mark the middle of the field, named by you' },
  drop: { run: () => { const c = mapView.getCenter(); proposeAdd(c.lat, c.lng); }, hint: 'mark the middle of the field, named by you' },
  frame: { run: () => mapView.fitAll(filteredPlaces()), hint: 'fit everything in view' },
  locate: { run: () => mapView.locate(null, () => toast('location unavailable')), hint: 'find me' },
  dark: { run: () => setTheme('dark'), hint: 'night field' },
  light: { run: () => setTheme('light'), hint: 'day field' },
  photo: { run: () => $('#shootFile').click(), hint: 'a photo becomes a place' },
  hike: { run: () => $('#gpxFile').click(), hint: 'a gpx from any walking app becomes a path' },
  route: { run: () => $('#gpxFile').click(), hint: 'a gpx from any walking app becomes a path' },
  walk: { run: () => $('#gpxFile').click(), hint: 'a gpx from any walking app becomes a path' },
  path: { run: () => $('#gpxFile').click(), hint: 'a gpx from any walking app becomes a path' },
  paths: { run: () => $('#gpxFile').click(), hint: 'a gpx from any walking app becomes a path' },
  export: { run: exportEverything, hint: 'your data, yours' },
  print: { run: () => printSheet(atlasSheetOpts()), hint: 'the atlas typeset, to paper or pdf' },
  pdf: { run: () => printSheet(atlasSheetOpts()), hint: 'the atlas typeset, to paper or pdf' },
  import: { run: () => { openSurface('settingsOverlay', renderSettings); $('#impJson').click(); }, hint: 'bring an atlas in' },
  been: { run: () => setStatusFilter('visited'), hint: 'only places you’ve been' },
  want: { run: () => setStatusFilter('wishlist'), hint: 'only places still to go' },
  all: { run: () => setStatusFilter('all'), hint: 'everything' },
  specimen: { run: seedDemo, hint: 'a sample atlas, yours to edit' },
  sample: { run: seedDemo, hint: 'a sample atlas, yours to edit' },
  clear: { run: dropSample, hint: 'clear the sample records you never touched' },
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


// Did this visit begin with something in hand? A link someone sent, a place
// shared in from a phone, or the walk back from the club door. All of those
// are errands, and an errand is not the moment for a welcome.
function arrivedHolding() {
  if (location.hash.startsWith('#m=')) return true;
  const q = new URLSearchParams(location.search);
  return q.has('shared') || q.has('title') || q.has('text') || q.has('url') || q.has('club');
}

// ---------- the name walks to its corner ----------
//
// It used to get there by transitioning left, top, font-size and letter
// spacing at once. Every one of those makes the browser lay the page out
// again, and two of them make it re-shape a variable typeface, sixty times a
// second, over a live map, under four text shadows. It arrived. It did not
// glide.
//
// So it is measured instead: where the word is now, where it belongs, and
// the difference played back as one transform, which is the only thing a
// compositor can carry by itself. The origin is set to the word's own centre
// so the scale happens about the letters rather than about the button's box,
// and the scale is taken from the word's width, because the tracking is tight
// when the name is large and open when it is small: the two states are not a
// pure scale of one another, and width is what the eye follows.
// A word crossing the whole field wants to be followed, not flung. The house
// easing is a hard ease-out, which is right for a panel arriving from just
// off screen and wrong here: it put the name eighty five percent of the way
// home in the first third, so the eye caught a blur and then a long settle.
// This leaves gently, spends the middle of the journey actually in the
// middle, and comes to rest without a bump.
const NAME_WALK_MS = 1400;
const NAME_WALK_EASE = 'cubic-bezier(0.5, 0, 0.15, 1)';

function walkNameHome() {
  const el = $('#fmIndex');
  const word = $('.fm-word', el);
  const hint = $('#fmHint');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // the hint belongs to the middle of the field and does not travel
  if (hint) hint.hidden = true;
  const from = word?.getBoundingClientRect();

  document.body.classList.remove('hero');

  if (still || !from || !word || !el.animate) return;
  const to = word.getBoundingClientRect();
  const scale = from.width / to.width;
  if (!Number.isFinite(scale) || scale <= 0) return;

  const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
  const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
  const box = el.getBoundingClientRect();
  el.style.transformOrigin =
    `${to.left + to.width / 2 - box.left}px ${to.top + to.height / 2 - box.top}px`;

  const walk = el.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
    { transform: 'translate(0, 0) scale(1)' },
  ], {
    duration: NAME_WALK_MS,
    easing: NAME_WALK_EASE,
  });
  walk.finished.catch(() => {}).then(() => { el.style.transformOrigin = ''; });
}

// ---------- the first evening ----------

const DISSOLVE_S = 1.4;   // matches #intro.dissolve in the stylesheet
// the asset is cut to its second half, so it already opens in motion and this
// seek finds nothing to skip. it stays for a longer cut, and costs nothing.
const FILM_IN = 1.6;
const FILM_TAIL = 0.9;    // the dissolve opens this long before the last frame,
                          // so the face at the end of the shot is still there

function runIntro(onDone, { brief = false, skip = false } = {}) {
  const el = $('#intro');
  const video = $('#introVideo');
  const canvas = $('#introCanvas');
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // one exception, and it is not ours to make: a device asking for less
  // movement is a person telling us something, and a full screen film is
  // exactly what they mean. `skip` stays for callers that have their own
  // reason; nothing passes it today.
  if (skip || RM) {
    // nothing to undo: the element was given no source, so no film has been
    // asked for and none will be
    store.settings.introSeen = true; store.saveSettings(); onDone(); return;
  }
  // the film is wanted, so now it may be fetched. autoplay is set here rather
  // than in the markup for the same reason the source is: a programmatic
  // play() with no gesture behind it is refused often enough to leave a
  // frozen frame, and the attribute is what makes a muted film reliable.
  video.autoplay = true;
  video.preload = 'auto';
  if (!video.getAttribute('src')) { video.setAttribute('src', 'assets/intro.mp4'); video.load(); }
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
  // The same patience either way. `brief` shortens the dissolve, and it used
  // to shorten this too, which was harmless while the film was precached and
  // is not now that it is fetched when wanted: a returning visitor on a cold
  // cache would have had the drawn scene cut in over a film that was merely
  // still arriving. armCutoff replaces this the moment the film is ready.
  cutoff = setTimeout(finish, 6200);

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
    // open on a frame that is already in motion, not on the first still. a
    // film short enough to be all middle is left where it starts.
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
  // If a stored key would not parse, the store has sealed it rather than
  // handing back an empty list, and nothing will be written over it until a
  // person says so. This is the loudest thing the app can say, and it is said
  // before anything else happens, because the alternative is an atlas that
  // looks empty and becomes empty on the next keystroke.
  const damaged = unreadableKeys();
  if (damaged.length) setTimeout(() => tellAboutDamage(damaged), 400);
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

  // something was shared into the app. the worker kept it here rather than
  // putting it on the wire, so it is read out of this device's own store.
  const q = new URLSearchParams(location.search);
  const shareFailed = q.get('shared') === '0';
  if (q.has('shared') || q.has('title') || q.has('text') || q.has('url')) {
    // an older install may still arrive by query: honour it, then wipe it
    const fromQuery = (q.has('title') || q.has('text') || q.has('url'))
      ? { title: q.get('title') || '', text: q.get('text') || '', url: q.get('url') || '' }
      : null;
    history.replaceState(null, '', location.pathname + location.hash);
    // the worker says plainly when it could not keep what was shared. a
    // person who shared a place is owed that, rather than an app that opens
    // as though nothing had happened.
    if (shareFailed) {
      setTimeout(() => toast('this device had no room to keep what you shared. nothing was sent anywhere; try again, or type it in', 7000), 900);
    }
    setTimeout(async () => {
      const waiting = await peekShared();
      const first = waiting[0];
      // taken only once the app has it in hand
      if (first) { await forgetShared(first.key); receiveShared(first.item); }
      else if (fromQuery) receiveShared(fromQuery);
      for (const rest of waiting.slice(1)) {
        inboxWrite([...inboxRead(), rest.item]);
        await forgetShared(rest.key);
      }
    }, 1000);
  } else {
    setTimeout(async () => {
      for (const w of await peekShared()) {
        inboxWrite([...inboxRead(), w.item]);
        await forgetShared(w.key);
      }
      drainInbox();
    }, 3000);
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

  // plain words, then a choice: nothing is seeded and nobody is named until
  // the visitor has said which start they want
  let thresholdWired = false;

  // The first-run door is wired before the film, not after it.
  //
  // runIntro calls its callback synchronously when it decides not to play,
  // which it does for anyone whose device asks for less movement. The
  // callback's openThreshold() therefore used to resolve to the module level
  // no-op above, and a brand new visitor on such a device met an empty field
  // with a wordmark on it and no way in but a question mark in the corner.
  // Nothing threw. `chosen` stayed false, so it happened again every visit.
  //
  // Order is the whole fix: nothing that opens a surface may be handed to
  // something that might call it back before this function has finished.
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
        readArchiveFile(f, async (parsed) => {
          const r = await bringHome(parsed, { replace: true });
          if (!r.ok) {
            if (r.why === 'lossy') return sayWhatWasLost(r.lost, { verb: 'come home' });
            if (r.why === 'unreadable') return toast('that file isn’t a resonate export');
            return toast('this device refused the write, so nothing changed');
          }
          done(() => {
            renderAll();
            if (store.places.length) mapView.fitAll(store.places);
            const n = r.now.places;
            toast(`welcome back. ${n} place${n === 1 ? '' : 's'} are home`);
          });
        });
      };
      file.click();
    });
    $('#thKeys').addEventListener('click', () => openSurface('keysOverlay', renderKeys));
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

  // read the link first: a visitor who was handed something is answering a
  // person, not starting an atlas, and must never be offered a first-run
  // choice over the top of it. an atlas that already exists has answered
  // that question too.
  const payload = parseShareHash();
  if (payload) openReport(payload);

  // The evening opens every visit.
  //
  // It is short, it is the same each time, and it is the first thing this app
  // is: an hour at a long table, dissolving into a map. The only person who
  // does not get it is the one whose device has asked for less movement, and
  // that is their instruction rather than our guess. A returning visitor gets
  // the shorter fade at the end, which is the whole of what "brief" means.
  runIntro(() => {
    if (store.settings.chosen || store.places.length || payload) {
      if (!payload) startWelcome();
      return;
    }
    openThreshold();
    // Someone who arrived holding something did not come for a title
    // sequence. A folio, an ask, an atlas, a place shared in from a phone, or
    // a return from the club door: the thing they came for is already
    // rendered underneath, and the film would be sitting on top of it. The
    // evening is for arriving at Resonate, not for arriving at a person.
  }, { brief: !!store.settings.introSeen, skip: arrivedHolding() });

  setHeroExit(() => {
    if (!document.body.classList.contains('hero')) return;
    walkNameHome();
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
  $('#fmHelp').addEventListener('click', () => {
    // wherever you are, the opening is one press away
    closeSurface('indexOverlay'); closeSurface('howOverlay');
    showOpening();
  });
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
    if (state.pendingAdd) cancelAdd();
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
  // a form submits: by its button, by enter, by whatever a person's device does
  $('#addConfirm').addEventListener('submit', (e) => { e.preventDefault(); commitAdd(); });
  $('#addConfirmCancel').addEventListener('click', cancelAdd);
  $('#addConfirm').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelAdd(); }
  });
  $('#addConfirmInput').addEventListener('input', (e) => { e.target.dataset.typed = '1'; });

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

  // The last events a browser reliably gives before a page goes away, and on
  // a phone often the only ones: a tab switched, an app backgrounded, a
  // window closed. Whatever is still on its way to disk goes now.
  addEventListener('pagehide', flushWrites);
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushWrites(); });
  addEventListener('beforeunload', flushWrites);

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
    // while the film stands, no key opens anything behind it. the film keeps
    // enter, escape and space for itself; without this the others would open a
    // surface nobody can see and hand it a keyboard nobody can use. the test is
    // written the long way round on purpose: no film means no bar, never a
    // keyboard that does nothing
    if ($('#intro')?.hidden === false) return;
    const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) ||
      document.activeElement?.isContentEditable;
    // the command line is a shortcut like any other: it may not open behind
    // a dialog that has the floor. escape alone reaches past everything.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      if (modalUp() && topSurface() !== 'paletteOverlay') return;
      e.preventDefault(); togglePalette(); return;
    }
    if (e.key === 'Escape') {
      if (state.pendingAdd) { cancelAdd(); return; }
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
      // the mark in the corner and this key are the same question, so they
      // must be the same answer
      '?': () => { closeSurface('indexOverlay'); closeSurface('howOverlay'); showOpening(); },
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); return; }
    if (/^[1-9]$/.test(e.key)) {
      const t = allTags()[+e.key - 1];
      if (!t) return;
      state.filters.tags.has(t.id) ? state.filters.tags.delete(t.id) : state.filters.tags.add(t.id);
      renderChips(); renderList(); syncMarkers(); applyWorldState();
    }
  });

  // The commons is not asked for at boot.
  //
  // The how page tells a reader the newsstand list comes from a separate
  // address "only when you open the stand", and this line made that untrue:
  // every cold load of a private atlas reached out to github before the
  // person had asked for anything public. A small request and a large
  // contradiction. The newsstand fetches it for itself when it opens.

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
