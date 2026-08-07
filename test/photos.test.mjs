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
globalThis.Blob = class Blob {
  constructor(parts) { this.parts = parts; this.size = parts[0]?.length ?? 0; }
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
  assert.ok(await photos.get(id), 'it comes back');
  assert.equal(await photos.get('ph_nothing'), undefined);
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
