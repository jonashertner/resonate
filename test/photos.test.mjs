// photos.test.mjs — the pictures move out of the records, once, safely.
//
// A stand-in IndexedDB, in the spirit of the FakeStorage beside it: it can be
// made to refuse, so the interrupted migration is not hypothetical.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// A transaction here behaves like a real one: the request settles first, and
// the transaction commits after. `abortAtCommit` models the case that matters
// most, a write that looks fine and then fails to land.
class FakeReq {
  constructor(tx) { this.onsuccess = null; this.onerror = null; this.result = undefined; this.tx = tx; }
  settle(result, failed = false) {
    this.result = result;
    queueMicrotask(() => {
      if (failed) this.onerror?.(); else this.onsuccess?.();
      queueMicrotask(() => {
        if (this.tx.db.abortAtCommit) this.tx.onabort?.();
        else this.tx.oncomplete?.();
      });
    });
  }
}

class FakeStore {
  constructor(map, db, tx) { this.map = map; this.db = db; this.tx = tx; }
  put(v, k) {
    const r = new FakeReq(this.tx);
    if (this.db.refuse) { r.settle(undefined, true); return r; }
    if (!this.db.abortAtCommit) this.map.set(k, v);
    r.settle(k);
    return r;
  }
  get(k) { const r = new FakeReq(this.tx); r.settle(this.map.get(k)); return r; }
  delete(k) { const r = new FakeReq(this.tx); this.map.delete(k); r.settle(true); return r; }
  clear() { const r = new FakeReq(this.tx); this.map.clear(); r.settle(true); return r; }
  getAllKeys() { const r = new FakeReq(this.tx); r.settle([...this.map.keys()]); return r; }
}

class FakeDB {
  constructor() {
    this.stores = { photos: new Map(), snapshots: new Map() };
    this.refuse = false; this.abortAtCommit = false;
    this.objectStoreNames = { contains: () => true };
  }
  transaction(name) {
    const tx = { oncomplete: null, onabort: null, onerror: null, db: this };
    tx.objectStore = () => new FakeStore(this.stores[name], this, tx);
    return tx;
  }
}

const db = new FakeDB();
globalThis.indexedDB = {
  open() {
    const r = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: db };
    queueMicrotask(() => r.onsuccess?.());
    return r;
  },
};
// A stand-in that lies is worse than no stand-in. This one used to drop the
// options bag and have no arrayBuffer(), so the store's own "keep it as bytes
// and a type" path could not run here at all and the test agreed with itself
// about nothing. It carries what a Blob carries.
globalThis.Blob = class Blob {
  constructor(parts, opts = {}) {
    this.parts = parts;
    this.type = opts.type || '';
    const first = parts[0];
    this.size = first?.byteLength ?? first?.length ?? 0;
  }
  async arrayBuffer() {
    const first = this.parts[0];
    if (first?.byteLength !== undefined && !first.buffer) return first;
    return first?.buffer ?? new Uint8Array(0).buffer;
  }
};
globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');

const photos = await import('../js/photos.js?v=test');

test('a data url becomes bytes, and a bad one becomes nothing', () => {
  const blob = photos.blobFromDataURL('data:image/png;base64,iVBORw0KGgo=');
  assert.ok(blob, 'a real data url yields a blob');
  assert.equal(photos.blobFromDataURL('not a data url'), null);
  assert.equal(photos.blobFromDataURL('data:image/png,notbase64'), null, 'only base64 payloads');
});

test('a kept picture answers to its id, and only its id', async () => {
  db.refuse = false;
  const id = await photos.put(photos.blobFromDataURL('data:image/png;base64,iVBORw0KGgo='));
  assert.ok(photos.isId(id), id);
  const back = await photos.get(id);
  assert.ok(back, 'it comes back');
  // it is kept as bytes and a type, because safari refuses a blob in
  // indexeddb, and it comes back as a blob either way
  assert.ok(back instanceof Blob, 'a caller is handed a picture, not the shape it was stored in');
  assert.equal(back.type, 'image/png', 'and it remembers what kind of picture it is');
  assert.equal(await photos.get('ph_nothing'), null);
  assert.equal(photos.isId('data:image/png;base64,x'), false, 'an inline picture is not an id');
});

test('a browser that refuses says so, and the caller keeps the picture inline', async () => {
  db.refuse = true;
  const id = await photos.put(photos.blobFromDataURL('data:image/png;base64,iVBORw0KGgo='));
  assert.equal(id, null, 'null, never a broken id');
  db.refuse = false;
});

test('the snapshot ring keeps exactly three', async () => {
  db.refuse = false;
  db.stores.snapshots.clear();
  for (const at of ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05']) {
    db.stores.snapshots.set(at, { at, json: '{}' });
  }
  const dropped = await photos.snapshotPrune(3);
  assert.equal(dropped, 2);
  const keys = (await photos.snapshotKeys()).sort();
  assert.deepEqual(keys, ['2026-08-03', '2026-08-04', '2026-08-05'], 'the oldest go first');
});

test('erasing reaches the pictures and the snapshots', async () => {
  db.refuse = false;
  await photos.put(photos.blobFromDataURL('data:image/png;base64,iVBORw0KGgo='));
  await photos.snapshotPut('{}');
  await photos.clear();
  assert.equal(db.stores.photos.size, 0);
  assert.equal(db.stores.snapshots.size, 0);
});


test('a write that stages and then fails to commit is reported as a failure', async () => {
  db.refuse = false;
  db.abortAtCommit = true;
  const id = await photos.put(photos.blobFromDataURL('data:image/png;base64,iVBORw0KGgo='));
  db.abortAtCommit = false;
  assert.equal(id, null, 'a staged write is not a kept write: the caller must not destroy its copy');
  assert.equal(db.stores.photos.size, 0, 'and nothing landed');
});

test('a picture is kept as bytes and a type, because safari refuses a blob', async () => {
  db.refuse = false;
  const id = await photos.put(photos.blobFromDataURL('data:image/jpeg;base64,/9j/4AAQ'));
  // what actually went into the store: not a Blob, which webkit aborts on
  const held = db.stores.photos.get(id);
  assert.equal(held instanceof Blob, false, 'a blob in indexeddb is what safari refuses');
  assert.ok(held.buf, 'the bytes are there');
  assert.equal(held.type, 'image/jpeg', 'and so is what kind of picture they are');
  const back = await photos.get(id);
  assert.equal(back.type, 'image/jpeg', 'and a caller still gets a picture back');
});

test('a picture kept in the older shape still comes home', async () => {
  db.refuse = false;
  // what releases before this wrote: the blob itself
  const older = photos.blobFromDataURL('data:image/png;base64,iVBORw0KGgo=');
  db.stores.photos.set('ph_older', older);
  const back = await photos.get('ph_older');
  assert.ok(back, 'nobody has to migrate their pictures for this');
  assert.equal(back.type, 'image/png');
});
