// store.test.mjs — what the device promises about keeping and handing over.
//
// These run against the real store with a stand-in for browser storage, so a
// refused write can be produced on demand: quota exhaustion is not
// hypothetical when photographs are involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeStorage {
  constructor() { this.map = new Map(); this.refuse = false; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    if (this.refuse) {
      const e = new Error('quota');
      e.name = 'QuotaExceededError';
      throw e;
    }
    this.map.set(k, String(v));
  }
  removeItem(k) { this.map.delete(k); }
  key(i) { return [...this.map.keys()][i]; }
  get length() { return this.map.size; }
}

const storage = new FakeStorage();
globalThis.localStorage = new Proxy(storage, {
  ownKeys: (t) => [...t.map.keys()],
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  get: (t, p) => (typeof t[p] === 'function' ? t[p].bind(t) : t[p]),
});

const { store, newPlace, newTag, newRoute, demoData } = await import('../js/store.js?v=test');

function fresh() {
  storage.map.clear();
  storage.refuse = false;
  store.places = []; store.routes = []; store.tags = []; store.correspondents = [];
  store.settings = { theme: 'auto', lastView: null, seeded: false, authorName: '' };
}

const aPlace = (n = 'A place') => newPlace({ name: n, lat: 46, lng: 8 });

// ---------- a refused write changes nothing ----------

test('a place the device refuses is not kept, in memory or on disk', () => {
  fresh();
  storage.refuse = true;
  const made = store.addPlace(aPlace());
  assert.equal(made, null, 'the caller is told plainly');
  assert.equal(store.places.length, 0, 'nothing is left in memory to render');
});

test('a tag, a way and a voice all refuse the same way', () => {
  fresh();
  storage.refuse = true;
  assert.equal(store.addTag(newTag({ name: 'Huts' })), null);
  assert.equal(store.tags.length, 0);
  assert.equal(store.addRoute(newRoute({ path: [{ lat: 46, lng: 8 }, { lat: 46.1, lng: 8.1 }] })), null);
  assert.equal(store.routes.length, 0);
  assert.equal(store.addCorrespondent({ name: 'Marta', tags: [], places: [] }), null);
  assert.equal(store.correspondents.length, 0);
});

test('an edit the device refuses leaves the record as it was', () => {
  fresh();
  const p = store.addPlace(aPlace('Enoteca'));
  assert.ok(p);
  storage.refuse = true;
  const out = store.updatePlace(p.id, { name: 'Renamed', rating: 5 });
  assert.equal(out, null);
  assert.equal(store.placeById(p.id).name, 'Enoteca', 'the old name is restored');
  assert.equal(store.placeById(p.id).rating, 0);
});

test('a removal the device refuses puts the record back', () => {
  fresh();
  const p = store.addPlace(aPlace('Kept'));
  storage.refuse = true;
  store.removePlace(p.id);
  assert.equal(store.places.length, 1, 'it is still here, because it was never really gone');
  assert.equal(store.places[0].name, 'Kept');
});

test('an import is one act: refused in part, kept in none', () => {
  fresh();
  store.addPlace(aPlace('Mine'));
  const before = store.places.length;
  storage.refuse = true;
  const added = store.merge({
    places: [{ id: 'i1', name: 'Theirs', lat: 45, lng: 9 }, { id: 'i2', name: 'Also theirs', lat: 44, lng: 9 }],
    tags: [{ id: 't1', name: 'Wine' }],
  });
  assert.equal(added, 0, 'an import that could not be written imported nothing');
  assert.equal(store.places.length, before, 'and left the atlas exactly as it was');
  assert.equal(store.tags.length, 0);
});

// ---------- two exports, two promises ----------

test('the file offered in place of a link carries no photograph, no voice, no setting', () => {
  fresh();
  store.addTag(newTag({ name: 'Culture' }));
  store.addPlace(newPlace({
    name: 'Fondation Beyeler', lat: 47.58, lng: 7.65,
    photos: ['data:image/png;base64,iVBORw0KGgo='],
    note: 'the pond window',
  }));
  store.addCorrespondent({ name: 'Marta', tags: [], places: [] });
  store.settings.authorName = 'Jonas';

  const share = JSON.parse(store.exportShareJSON());
  assert.equal(share.kind, 'share');
  assert.equal(share.places.length, 1);
  assert.equal(share.places[0].name, 'Fondation Beyeler');
  assert.equal(share.places[0].note, 'the pond window', 'the recommendation itself still travels');
  assert.equal('photos' in share.places[0], false, 'no photograph leaves the device');
  assert.ok(!JSON.stringify(share).includes('data:image/'));
  assert.equal(share.correspondents, undefined, 'no voice is handed on');
  assert.equal(share.settings, undefined, 'and no signature or setting');
});

test('the backup kept for yourself carries everything', () => {
  fresh();
  store.addPlace(newPlace({ name: 'A place', lat: 46, lng: 8, photos: ['data:image/png;base64,iVBORw0KGgo='] }));
  store.addCorrespondent({ name: 'Marta', tags: [], places: [] });
  store.settings.authorName = 'Jonas';

  const backup = JSON.parse(store.exportJSON());
  assert.ok(JSON.stringify(backup).includes('data:image/'), 'a backup without photographs is not a backup');
  assert.equal(backup.correspondents.length, 1);
  assert.equal(backup.settings.authorName, 'Jonas');
});

// ---------- erase means erase ----------

test('an erased atlas does not grow a sample back', () => {
  fresh();
  const demo = demoData();
  demo.tags.forEach(t => store.addTag(t));
  demo.places.forEach(p => store.addPlace({ ...p, sample: true }));
  assert.ok(store.places.length > 5);

  store.clearAll();
  assert.equal(store.places.length, 0);
  assert.equal(store.tags.length, 0);
  assert.equal(store.settings.seeded, true, 'the browser is marked as used, not as new');
  assert.ok(store.settings.erasedAt, 'and remembers when it was emptied');

  // what a reload would do
  store.load();
  assert.equal(store.places.length, 0, 'still empty after coming back');
  assert.equal(store.settings.seeded, true);
});

// ---------- the vocabulary ----------

test('every domain inks the world differently', () => {
  fresh();
  const { tags } = demoData();
  const hues = tags.map(t => t.hue);
  assert.equal(new Set(hues).size, hues.length, `two domains share a hue: ${hues.join(', ')}`);
  const names = tags.map(t => t.name);
  assert.ok(names.includes('Huts'));
  assert.ok(names.includes('Reserves'));
});

test('a way is kept with its measure and comes back whole', () => {
  fresh();
  const { routes } = demoData();
  assert.ok(routes.length, 'the sample shows a walk, not only points');
  const r = store.addRoute({ ...routes[0], sample: true });
  assert.ok(r.km > 0 && r.ascent > 0 && r.high > r.low);
  store.load();
  const back = store.routes[0];
  assert.equal(back.name, routes[0].name);
  assert.ok(back.path.length >= 2);
  assert.equal(Math.round(back.ascent), Math.round(r.ascent));
});
