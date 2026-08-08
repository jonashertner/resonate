// photos.js — where the pictures live, and the snapshots beside them.
//
// Records stay in localStorage, where every mutator is synchronous and a
// refused write rolls back whole. Photographs are ninety-nine per cent of the
// bytes and the entire quota hazard, so they move here alone: a place keeps
// photo ids, strings like any other, and the blobs live in IndexedDB.
//
// Nothing here throws at the caller. A browser that refuses IndexedDB (a
// private window, an old engine, a wedged database) gets null, and the app
// keeps the picture inline as it always did. The promise does not change.

const DB = 'resonate';
const VERSION = 1;
const PHOTOS = 'photos';
const SNAPS = 'snapshots';

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB, VERSION); }
    catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PHOTOS)) db.createObjectStore(PHOTOS);
      if (!db.objectStoreNames.contains(SNAPS)) db.createObjectStore(SNAPS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbp;
}

// In IndexedDB a request that succeeds has been staged, not written. A write
// therefore answers on the transaction's commit, never before: the caller may
// destroy the only other copy of a picture on the strength of this promise.
function act(store, mode, fn) {
  return open().then(db => {
    if (!db) return null;
    return new Promise((resolve) => {
      let tx;
      try { tx = db.transaction(store, mode); }
      catch { return resolve(null); }
      let value;
      let failed = false;
      const req = fn(tx.objectStore(store));
      if (req) {
        req.onsuccess = () => { value = req.result; };
        req.onerror = () => { failed = true; };
      }
      tx.onabort = () => resolve(null);
      tx.onerror = () => resolve(null);
      tx.oncomplete = () => resolve(failed ? null : (req ? value : true));
    });
  });
}

export function available() { return typeof indexedDB !== 'undefined'; }

// ---------- photographs ----------

let seq = 0;
function mintId() {
  seq += 1;
  return `ph_${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// a data url becomes a blob without a network round trip
export function blobFromDataURL(uri) {
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const head = uri.slice(0, comma);
  const type = (/data:([^;]+)/.exec(head) || [])[1] || 'image/jpeg';
  if (!/;base64$/.test(head)) return null;
  const bin = atob(uri.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type });
}

export function dataURLFromBlob(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

// A picture is kept as bytes and a type, never as a Blob.
//
// Safari refuses a Blob in IndexedDB: the transaction aborts with an
// UnknownError, put() answers null, and the app falls back to keeping the
// picture inline as a data url in the small store, which is the exact
// pressure moving photographs here was meant to relieve. So every photograph
// a person took on an iPhone quietly went nowhere useful. An ArrayBuffer
// stores everywhere, has none of that history, and costs one line each way.
//
// Records written before this are plain Blobs; read() takes either, so
// nobody's pictures need migrating.
export async function put(blob) {
  const id = mintId();
  let value = blob;
  try { value = { type: blob.type || 'image/jpeg', buf: await blob.arrayBuffer() }; }
  catch { /* a browser with no arrayBuffer() keeps the older shape */ }
  const ok = await act(PHOTOS, 'readwrite', s => s.put(value, id));
  return ok === null ? null : id;
}

export async function get(id) {
  const held = await act(PHOTOS, 'readonly', s => s.get(id));
  if (!held) return null;
  // the shape written before this release, and the shape written now
  if (held instanceof Blob) return held;
  if (held.buf) return new Blob([held.buf], { type: held.type || 'image/jpeg' });
  return null;
}
export function del(id) { return act(PHOTOS, 'readwrite', s => s.delete(id)); }
export function keys() { return act(PHOTOS, 'readonly', s => s.getAllKeys()); }

// object urls, made once per id and revoked together when the atlas is erased
const urls = new Map();
export async function urlFor(id) {
  if (urls.has(id)) return urls.get(id);
  const blob = await get(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urls.set(id, url);
  return url;
}

export function isId(v) { return typeof v === 'string' && v.startsWith('ph_'); }

// ---------- snapshots: the records, quietly, three deep ----------

export function snapshotPut(json) {
  return act(SNAPS, 'readwrite', s => s.put({ at: new Date().toISOString(), json }, new Date().toISOString()));
}
export function snapshotKeys() { return act(SNAPS, 'readonly', s => s.getAllKeys()); }
export function snapshotGet(key) { return act(SNAPS, 'readonly', s => s.get(key)); }

export async function snapshotPrune(keep = 3) {
  const keys = (await snapshotKeys()) || [];
  const doomed = keys.sort().slice(0, Math.max(0, keys.length - keep));
  for (const k of doomed) await act(SNAPS, 'readwrite', s => s.delete(k));
  return doomed.length;
}

// ---------- everything gone ----------

export async function clear() {
  for (const u of urls.values()) { try { URL.revokeObjectURL(u); } catch { /* fine */ } }
  urls.clear();
  await act(PHOTOS, 'readwrite', s => s.clear());
  await act(SNAPS, 'readwrite', s => s.clear());
}

// ---------- how much room is left ----------

export async function estimate() {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e) return null;
    return { used: e.usage ?? null, quota: e.quota ?? null };
  } catch { return null; }
}

export async function persisted() {
  try { return await navigator.storage?.persisted?.() ?? null; }
  catch { return null; }
}
