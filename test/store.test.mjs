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

const { store, newPlace, newTag, newRoute, newFolio, demoData,
  trimWay, unreadableKeys, releaseUnreadable, setWriteFailedHandler } = await import('../js/store.js?v=test');
// the same measure the store uses, so a trimmed way can be checked against
// the ground it actually covers rather than against a number copied from it
const { measure } = await import('../js/route.js?v=test');

function fresh() {
  storage.map.clear();
  storage.refuse = false;
  store.places = []; store.routes = []; store.folios = []; store.tags = []; store.correspondents = [];
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

test('erasing the atlas does not burn the membership key', () => {
  fresh();
  store.settings.clubKey = 'tc_testkey0000000000000';
  store.settings.clubSeq = 4;
  store.saveSettings();
  store.clearAll();
  assert.equal(store.settings.clubKey, 'tc_testkey0000000000000', 'the key survives an erase');
  assert.equal(store.settings.clubSeq, 4, 'and so does what was sealed under it');
  assert.equal(store.places.length, 0, 'while the atlas itself is gone');
});

test('the full export never carries the club key', async () => {
  fresh();
  store.settings.clubKey = 'tc_testkey0000000000000';
  store.saveSettings();
  const out = JSON.parse(await store.exportJSON());
  assert.equal(out.settings.clubKey, '', 'a bearer credential rides in no file');
});

test('a refused merge says null, never a quiet zero', () => {
  fresh();
  storage.refuse = true;
  const got = store.merge({
    version: 3,
    places: [{ id: 'mp1', name: 'Cafe', lat: 47.5, lng: 7.6, tags: [], photos: [], voices: [] }],
    tags: [], settings: {},
  });
  assert.equal(got, null, 'refusal is distinguishable from nothing new');
  assert.equal(store.places.length, 0, 'and the rollback held');
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
  assert.equal(added, null, 'an import that could not be written says so, distinctly from nothing new');
  assert.equal(store.places.length, before, 'and left the atlas exactly as it was');
  assert.equal(store.tags.length, 0);
});

test('a photo id survives a reload, exactly as an inline picture does', () => {
  fresh();
  const p = store.addPlace(aPlace('With pictures'));
  store.updatePlace(p.id, { photos: ['ph_msj14t2y11u6v', 'data:image/png;base64,iVBORw0KGgo='] });
  // what a reload does
  store.load();
  const back = store.placeById(p.id);
  assert.deepEqual(back.photos, ['ph_msj14t2y11u6v', 'data:image/png;base64,iVBORw0KGgo='],
    'the id is a photograph like any other, or every migrated picture dies on reload');
});

test('an imported atlas keeps its photo ids too', () => {
  fresh();
  const added = store.merge({
    app: 'resonate', version: 4,
    places: [{ id: 'ip1', name: 'Theirs', lat: 45, lng: 9, photos: ['ph_abc123'], tags: [] }],
    tags: [], settings: {},
  });
  assert.equal(added, 1);
  assert.deepEqual(store.placeById('ip1').photos, ['ph_abc123']);
});

test('a photo id that is not one is still refused', () => {
  fresh();
  const p = store.addPlace(aPlace('Hostile'));
  store.updatePlace(p.id, { photos: ['ph_../../etc', 'javascript:alert(1)', 'PH_UPPER', 'ph_ok1'] });
  store.load();
  assert.deepEqual(store.placeById(p.id).photos, ['ph_ok1'], 'only the well-formed id survives');
});

// ---------- the words a place is held in ----------

test('an atlas from the age of stars keeps its places and drops the score', () => {
  fresh();
  localStorage.setItem('resonate.places.v1', JSON.stringify([
    { id: 'w5', name: 'Loved', lat: 46, lng: 8, tags: [], status: 'visited', rating: 5 },
    { id: 'w0', name: 'Wanted', lat: 46, lng: 8, tags: [], status: 'wishlist', rating: 0 },
  ]));
  store.load();
  assert.equal(store.places.length, 2, 'nothing is lost to the change');
  assert.equal(store.placeById('w5').status, 'visited', 'having been is the fact that survives');
  assert.equal(store.placeById('w0').status, 'wishlist');
  assert.equal('word' in store.placeById('w5'), false, 'and no verdict is stored beside it');
});

test('a verdict a hostile link invents is not kept', () => {
  fresh();
  const added = store.merge({
    app: 'resonate', version: 4,
    places: [{ id: 'h1', name: 'Theirs', lat: 45, lng: 9, tags: [], word: 'essential', relation: 'regular' }],
    tags: [], settings: {},
  });
  assert.equal(added, 1);
  const p = store.placeById('h1');
  assert.equal('word' in p, false);
  assert.equal('relation' in p, false);
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
  // the file said kind 'share', which nothing read and which the payload gate
  // treated as an atlas anyway. it says what it is now.
  assert.equal(share.kind, 'atlas');
  assert.equal(share.places.length, 1);
  assert.equal(share.places[0].name, 'Fondation Beyeler');
  assert.equal(share.places[0].note, 'the pond window', 'the recommendation itself still travels');
  assert.equal('photos' in share.places[0], false, 'no photograph leaves the device');
  assert.ok(!JSON.stringify(share).includes('data:image/'));
  assert.equal(share.correspondents, undefined, 'no voice is handed on');
  assert.equal(share.settings, undefined, 'and no signature or setting');
});

test('the backup kept for yourself carries everything', async () => {
  fresh();
  store.addPlace(newPlace({ name: 'A place', lat: 46, lng: 8, photos: ['data:image/png;base64,iVBORw0KGgo='] }));
  store.addCorrespondent({ name: 'Marta', tags: [], places: [] });
  store.settings.authorName = 'Jonas';

  const backup = JSON.parse(await store.exportJSON());
  assert.ok(JSON.stringify(backup).includes('data:image/'), 'a backup without photographs is not a backup');
  assert.equal(backup.correspondents.length, 1);
  assert.equal(backup.settings.authorName, 'Jonas');
});

test('a place marked never leaves is in no file a stranger is given', () => {
  fresh();
  store.addPlace(newPlace({ name: 'Public', lat: 46, lng: 8 }));
  const home = store.addPlace(newPlace({ name: 'Home', lat: 47, lng: 8 }));
  store.updatePlace(home.id, { private: true });

  const share = JSON.parse(store.exportShareJSON());
  assert.equal(share.places.length, 1, 'only the one that may travel');
  assert.equal(share.places[0].name, 'Public');
  assert.ok(!JSON.stringify(share).includes('Home'), 'not by name, not by coordinate');
});

test('a way handed over carries no record of when it was walked', () => {
  fresh();
  const r = store.addRoute(newRoute({ name: 'The ridge', path: [{ lat: 46, lng: 8 }, { lat: 46.1, lng: 8.1 }] }));
  store.updateRoute(r.id, { status: 'walked', walkedAt: '2026-08-01T09:00:00Z' });
  const share = JSON.parse(store.exportShareJSON());
  assert.equal('walkedAt' in share.routes[0], false, 'a routine is not a recommendation');
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

// ---------- the shelf: folios kept for yourself ----------

test('a kept folio shares nothing: it holds references, not copies', () => {
  fresh();
  const a = store.addPlace(newPlace({ name: 'Markthalle', lat: 47.5479, lng: 7.5875, note: 'the momo stand' }));
  const b = store.addPlace(newPlace({ name: 'Rheinbad', lat: 47.5533, lng: 7.6053 }));
  const f = store.addFolio(newFolio({ title: 'Basel, the good part', placeIds: [a.id, b.id] }));
  assert.ok(f);
  const raw = localStorage.getItem('resonate.folios.v1');
  assert.ok(!raw.includes('47.54'), 'no coordinate is copied into the shelf');
  assert.ok(!raw.includes('momo'), 'and no note either');
});

test('a folio follows the atlas as it improves', () => {
  fresh();
  const a = store.addPlace(newPlace({ name: 'Markthalle', lat: 47.5479, lng: 7.5875 }));
  const f = store.addFolio(newFolio({ title: 'Basel', placeIds: [a.id] }));
  store.updatePlace(a.id, { name: 'Markthalle (the momo stand)', rating: 5 });
  const resolved = store.resolveFolio(f.id);
  assert.equal(resolved.places[0].name, 'Markthalle (the momo stand)');
  assert.equal(resolved.places[0].rating, 5, 'the folio was never a snapshot');
});

test('a place removed from the atlas falls quietly out of its folios', () => {
  fresh();
  const a = store.addPlace(newPlace({ name: 'Gone', lat: 46, lng: 8 }));
  const b = store.addPlace(newPlace({ name: 'Stays', lat: 46.1, lng: 8.1 }));
  const f = store.addFolio(newFolio({ title: 'Two', placeIds: [a.id, b.id] }));
  store.removePlace(a.id);
  const resolved = store.resolveFolio(f.id);
  assert.equal(resolved.places.length, 1);
  assert.equal(resolved.places[0].name, 'Stays');
});

test('taking a folio off the shelf leaves every place in the atlas', () => {
  fresh();
  const a = store.addPlace(newPlace({ name: 'Kept', lat: 46, lng: 8 }));
  const f = store.addFolio(newFolio({ title: 'A folio', placeIds: [a.id] }));
  store.removeFolio(f.id);
  assert.equal(store.folios.length, 0);
  assert.equal(store.places.length, 1, 'the shelf held references, so removing it removed nothing');
});

test('a folio the device refuses is not on the shelf', () => {
  fresh();
  storage.refuse = true;
  assert.equal(store.addFolio(newFolio({ title: 'Nope' })), null);
  assert.equal(store.folios.length, 0);
});

test('the shelf comes home in a backup and not in a share', async () => {
  fresh();
  const a = store.addPlace(newPlace({ name: 'A', lat: 46, lng: 8 }));
  store.addFolio(newFolio({ title: 'Mine', placeIds: [a.id] }));
  assert.equal(JSON.parse(await store.exportJSON()).folios.length, 1);
  assert.equal(JSON.parse(store.exportShareJSON()).folios, undefined,
    'a folio is a private arrangement; what you hand over is its contents');
});

// ---------- imports do not double the vocabulary ----------

test('an import with the same domains under different ids keeps one of each', () => {
  fresh();
  const mine = store.addTag(newTag({ name: 'Restaurants' }));
  store.addPlace(newPlace({ name: 'Mine', lat: 46, lng: 8, tags: [mine.id] }));

  const added = store.merge({
    tags: [{ id: 'their-tag', name: 'restaurants' }, { id: 'their-new', name: 'Vinyl' }],
    places: [{ id: 'their-place', name: 'Theirs', lat: 45, lng: 9, tags: ['their-tag', 'their-new'] }],
  });
  // one place and one genuinely new domain: an import reports everything it
  // brought, never only the places, or it can say nothing came in while
  // storage changed underneath
  assert.equal(added, 2);
  assert.equal(store.tags.filter(t => t.name.toLowerCase() === 'restaurants').length, 1,
    'same name is the same domain');
  const theirs = store.placeById('their-place');
  assert.ok(theirs.tags.includes(mine.id), 'the imported place points at the kept domain');
  assert.ok(store.tags.some(t => t.name === 'Vinyl'), 'a genuinely new domain still arrives');
});


// ---------- an atlas can leave for anywhere ----------

test('every open format carries the places, and never a private one', () => {
  fresh();
  store.addTag(newTag({ name: 'Culture' }));
  const t = store.tags[0].id;
  store.addPlace(newPlace({ name: 'Fondation Beyeler', lat: 47.58, lng: 7.65, city: 'Riehen',
    country: 'Switzerland', tags: [t], status: 'visited', note: 'the pond window' }));
  const home = store.addPlace(newPlace({ name: 'My Own Door', lat: 47.55, lng: 7.59, city: 'Basel' }));
  store.updatePlace(home.id, { private: true });

  for (const [what, text] of [
    ['geojson', store.exportGeoJSON()],
    ['kml', store.exportKML()],
    ['csv', store.exportCSV()],
    ['markdown', store.exportMarkdown()],
  ]) {
    assert.ok(text.includes('Fondation Beyeler'), `${what} carries the place`);
    assert.ok(!text.includes('My Own Door'), `${what} leaves the private one behind`);
    assert.ok(!text.includes('47.55'), `${what} does not leak its coordinate either`);
  }
});

test('the open formats survive a hostile name', () => {
  fresh();
  store.addPlace(newPlace({ name: 'Bar <script>alert(1)</script> & "co"', lat: 46, lng: 8, note: 'a, comma\nand a line' }));
  const kml = store.exportKML();
  assert.ok(!kml.includes('<script>'), 'kml escapes its markup');
  assert.ok(kml.includes('&lt;script&gt;'));
  const csv = store.exportCSV();
  const lines = csv.split('\n');
  assert.equal(lines[0].split(',')[0], 'name');
  assert.ok(csv.includes('""co""'), 'csv doubles its quotes');
});


// ---------- a date is a date, or it is nothing ----------

test('a record arriving without dates is dated when it arrives', () => {
  fresh();
  // exactly what a place from a share link looks like: the diary was stripped
  const fromLink = store.addPlace(newPlace({
    id: undefined, name: 'From a link', lat: 46, lng: 8, createdAt: '', updatedAt: '',
  }));
  assert.ok(fromLink.createdAt, 'it entered this atlas at a real moment');
  assert.ok(!Number.isNaN(new Date(fromLink.createdAt).getTime()), fromLink.createdAt);

  const way = store.addRoute(newRoute({
    name: 'A way from a link', path: [{ lat: 46, lng: 8 }, { lat: 46.1, lng: 8.1 }], createdAt: '',
  }));
  assert.ok(!Number.isNaN(new Date(way.createdAt).getTime()), way.createdAt);
});

test('a record that carries its own dates keeps them', () => {
  fresh();
  const p = store.addPlace(newPlace({ name: 'Old', lat: 46, lng: 8, createdAt: '2024-05-12T09:00:00Z' }));
  assert.equal(p.createdAt, '2024-05-12T09:00:00Z', 'a real date is never overwritten');
});

test('a date that is not one is healed on the way in', () => {
  fresh();
  localStorage.setItem('resonate.places.v1', JSON.stringify([
    { id: 'd1', name: 'Empty', lat: 46, lng: 8, tags: [], createdAt: '' },
    { id: 'd2', name: 'Nonsense', lat: 46, lng: 8, tags: [], createdAt: 'not a date at all' },
    { id: 'd3', name: 'Fine', lat: 46, lng: 8, tags: [], createdAt: '2024-05-12T09:00:00Z' },
  ]));
  store.load();
  const ok = v => !Number.isNaN(new Date(v).getTime());
  assert.ok(ok(store.placeById('d1').createdAt), 'an empty date becomes a real one');
  assert.ok(ok(store.placeById('d2').createdAt), 'and so does a nonsense one');
  assert.equal(store.placeById('d3').createdAt, '2024-05-12T09:00:00Z', 'a real one is left alone');
});


// ---------- the three doors ----------

test('a private archive comes home whole, or not at all', () => {
  fresh();
  const places = Array.from({ length: 501 }, (_, i) => ({
    id: 'p' + i, name: 'Place ' + i, lat: 46, lng: 8, tags: [],
    note: i === 0 ? 'n'.repeat(4001) : '',
  }));
  const got = store.merge({ app: 'resonate', version: 4, places, tags: [] }, { own: true });
  assert.equal(got, 501, 'every place, including the five hundred and first');
  assert.equal(store.places.length, 501);
  assert.equal(store.placeById('p0').note.length, 4001, 'and a long memory is not shortened');
});

test('a stranger is still held to the hard caps', () => {
  fresh();
  const places = Array.from({ length: 501 }, (_, i) => ({
    id: 's' + i, name: 'S' + i, lat: 46, lng: 8, tags: [], note: 'n'.repeat(4001),
  }));
  store.merge({ app: 'resonate', version: 4, places, tags: [] });
  assert.equal(store.places.length, 500, 'a hostile payload may not spend this device');
  assert.equal(store.placeById('s0').note.length, 4000);
});

test('an archive with a record that cannot be read is refused whole', () => {
  fresh();
  const places = [
    { id: 'g1', name: 'Good', lat: 46, lng: 8, tags: [] },
    { id: 'b1', name: 'No coordinates', tags: [] },
    { id: 'b2', name: 'Off the globe', lat: 999, lng: 8, tags: [] },
    { id: 'g2', name: 'Also good', lat: 47, lng: 9, tags: [] },
  ];
  const got = store.merge({ app: 'resonate', version: 4, places, tags: [] }, { own: true });
  assert.equal(got, null, 'two thirds of an archive is not an archive');
  assert.equal(store.places.length, 0, 'and not one record of it was written');
  assert.deepEqual(store.lastLost.map(l => l.id), ['b1', 'b2'],
    'every loss is named, so a person is told which record and not merely how many');
  assert.deepEqual(store.lastLost.map(l => l.kind), ['place', 'place']);
  assert.ok(store.lastLost.every(l => l.reason), 'and each one says why');
});

test('a stranger’s payload leaves no loss list behind that belonged to an archive', () => {
  fresh();
  const refused = store.merge({ app: 'resonate', version: 4, places: [{ id: 'x', name: 'X', tags: [] }], tags: [] }, { own: true });
  assert.equal(refused, null);
  assert.equal(store.lastLost.length, 1);
  const added = store.merge({ app: 'resonate', version: 4, places: [{ id: 'y', name: 'Y', lat: 1, lng: 2, tags: [] }], tags: [] });
  assert.equal(added, 1, 'the stranger still gets in, clipped and in silence');
  assert.deepEqual(store.lastLost, [], 'a stranger’s payload never speaks for an archive');
});

test('a load never shrinks the atlas it reads', () => {
  fresh();
  const many = Array.from({ length: 700 }, (_, i) => ({
    id: 'L' + i, name: 'L' + i, lat: 46, lng: 8, tags: [], createdAt: '2026-01-01T00:00:00Z',
  }));
  localStorage.setItem('resonate.places.v1', JSON.stringify(many));
  store.load();
  assert.equal(store.places.length, 700, 'an atlas that loads smaller than it saved is a leak');
});


// ---------- the loss table ----------
//
// Every row here is a field that used to come home shorter than it left,
// under numbers chosen so that loss would be rare rather than impossible.
// Rare is not the standard. One file carries all five so that a build which
// fixes the top level and forgets a depth cannot pass.

const theLossTable = () => ({
  app: 'resonate', app: 'resonate',
  version: 4,
  places: [{
    id: 'big', name: 'Everything at once', lat: 46, lng: 8, tags: [],
    photos: Array.from({ length: 201 }, (_, i) => 'ph_' + i.toString(36)),
    note: 'n'.repeat(200001),
  },
  // the folio below names these, and an archive whose folio points at places
  // it does not carry is refused now, so the fixture carries them
  ...Array.from({ length: 501 }, (_, i) => ({ id: 'fp' + i, name: 'F' + i, lat: 46, lng: 8, tags: [] }))],
  routes: [{
    id: 'way', name: 'The long one', tags: [],
    path: Array.from({ length: 1475 }, (_, i) => ({
      lat: 46 + i * 0.0001, lng: 8 + i * 0.0001, ele: 1000 + (i % 60),
    })),
  }],
  folios: [{
    id: 'fol', title: 'A wide folio', routeIds: [],
    placeIds: Array.from({ length: 501 }, (_, i) => 'fp' + i),
  }],
  correspondents: [{
    id: 'voice', name: 'Mira', tags: [],
    places: Array.from({ length: 501 }, (_, i) => ({ id: 'vp' + i, name: 'V' + i, lat: 46, lng: 8, tags: [] })),
  }],
  tags: [],
  settings: {},
});

test('a person’s own archive comes home to the last photograph, character and point', () => {
  fresh();
  const file = theLossTable();
  const added = store.merge(file, { own: true });
  // a place, a way, a folio, a voice, and the 501 places the folio names,
  // which the fixture carries because an archive whose folio points at
  // records it does not contain is refused
  assert.equal(added, 505, 'everything in the file came in');
  assert.deepEqual(store.lastLost, [], 'and nothing at all was shortened on the way in');

  const p = store.placeById('big');
  assert.equal(p.photos.length, 201, 'the two hundred and first photograph is the whole point');
  assert.deepEqual(p.photos, file.places[0].photos, 'and it is the same two hundred and one');
  assert.equal(p.note.length, 200001, 'there is no length at which a note stops being a person’s own');
  assert.equal(store.folios[0].placeIds.length, 501, 'a dropped reference is a place that left a collection');
  assert.equal(store.correspondents[0].places.length, 501, 'a voice is kept as it was handed over');
  assert.equal(store.routes[0].path.length, 1475);
  assert.deepEqual(store.routes[0].path, file.routes[0].path, 'and the way keeps its exact shape');
});

test('a stranger handing over that same file is clipped at every one of those depths', () => {
  fresh();
  const file = theLossTable();
  // a route long enough to meet the stranger’s bound, which 1475 points is not
  file.routes[0].path = Array.from({ length: 3001 }, (_, i) => ({ lat: 46 + i * 0.00001, lng: 8 }));
  const added = store.merge(file);
  // the stranger's door caps places at 500, so the fixture's 502 arrive as
  // 500, plus the way, the folio and the voice
  assert.equal(added, 503);
  assert.deepEqual(store.lastLost, [], 'a stranger is clipped in silence, which is what a cap is for');
  assert.equal(store.placeById('big').photos.length, 12);
  assert.equal(store.placeById('big').note.length, 4000);
  assert.equal(store.folios[0].placeIds.length, 500);
  assert.equal(store.correspondents[0].places.length, 500);
  assert.equal(store.routes[0].path.length, 3000, 'a hostile link may not spend this device');
});


// ---------- a way is stored with the shape it was given ----------

test('a way comes home the same shape however many times it comes home', () => {
  fresh();
  // a jittery recorded track: exactly the shape simplify() thins hardest, so
  // if anything on this road still thins, this is where it shows
  const path = Array.from({ length: 501 }, (_, i) => ({
    lat: 46 + i * 0.0002, lng: 8 + (i % 2 ? 0.000004 : -0.000004), ele: 1000 + i,
  }));

  let r = newRoute({ path });
  for (let pass = 0; pass < 3; pass++) r = newRoute({ ...r });
  assert.deepEqual(r.path, path, 'a record that changes by being read is not a record');

  store.addRoute(newRoute({ id: 'w1', path }));
  store.load();
  assert.deepEqual(store.routeById('w1').path, path, 'and a reload is a reading like any other');
});


// ---------- hiding the ends of a way ----------

// a straight line due north of a given length, in the two points a recorded
// straight walk actually reduces to
const KM_PER_DEG = 6371 * Math.PI / 180;
const straight = (km) => [{ lat: 46, lng: 8 }, { lat: 46 + km / KM_PER_DEG, lng: 8 }];

test('a straight thirteen kilometre way is trimmed at both ends, on two points', () => {
  fresh();
  const path = straight(13);
  const out = trimWay({ ...newRoute({ name: 'The long straight', path }), trimEnds: true });
  assert.ok(out, 'a way this long is not too short to lose its ends');
  assert.equal(out.path.length, 2, 'point count was never the question; ground is');
  const head = measure([path[0], out.path[0]]).km;
  const tail = measure([path[1], out.path[1]]).km;
  assert.ok(Math.abs(head - 0.25) < 0.001, `the start moved ${head} km, which is not a quarter`);
  assert.ok(Math.abs(tail - 0.25) < 0.001, `the end moved ${tail} km, which is not a quarter`);
});

test('a way too short to lose both ends is refused rather than half hidden', () => {
  fresh();
  assert.equal(trimWay({ ...newRoute({ path: straight(0.4) }), trimEnds: true }), null,
    'a quarter off each end of four hundred metres leaves a door still on the map');
  assert.equal(trimWay({ ...newRoute({ path: straight(0.2) }), trimEnds: true }), null);
  const open = newRoute({ path: straight(0.4) });
  assert.equal(trimWay(open), open, 'while a way never asked to hide its ends is handed over as it is');
});

test('a way whose ends cannot be hidden is handed to a stranger not at all', () => {
  fresh();
  const r = store.addRoute(newRoute({ name: 'Round the block', path: straight(0.4) }));
  store.updateRoute(r.id, { trimEnds: true });
  assert.deepEqual(JSON.parse(store.exportShareJSON()).routes, [], 'half a redaction is no redaction');
});

test('a trimmed way carries the trimmed shape’s measurements, not the walk’s', () => {
  fresh();
  const path = [];
  for (let i = 0; i <= 400; i++) {
    const u = i / 400;
    path.push({
      lat: 46 + u * 0.09, lng: 8 + u * 0.02,
      ele: u < 0.5 ? 1000 + u * 2000 : 2000 - (u - 0.5) * 1600,
    });
  }
  const walked = newRoute({ name: 'Up and over', path });
  const out = trimWay({ ...walked, trimEnds: true });
  assert.ok(out);
  const m = measure(out.path);
  assert.equal(out.km, m.km,
    'a distance describing ground the recipient never got is that ground, given away');
  assert.equal(out.ascent, m.ascent);
  assert.equal(out.descent, m.descent);
  assert.equal(out.high, m.high);
  assert.equal(out.low, m.low);
  assert.equal(out.hours, m.hours);
  assert.equal(out.loop, m.loop);
  assert.ok(out.km < walked.km - 0.49, `half a kilometre was hidden but ${out.km} is not less than ${walked.km}`);
});


// ---------- restore says: this file is the atlas now ----------

test('a restore replaces the atlas rather than adding to it', () => {
  fresh();
  store.addPlace(newPlace({ id: 'old1', name: 'Old one', lat: 46, lng: 8 }));
  store.addPlace(newPlace({ id: 'old2', name: 'Old two', lat: 47, lng: 9 }));
  store.settings.clubKey = 'tc_testkey0000000000000';

  const out = store.restore({
    app: 'resonate', version: 4,
    places: [{ id: 'new1', name: 'New one', lat: 45, lng: 7, tags: [] }],
    tags: [], settings: { theme: 'dark', hue: 120, authorName: 'Mira' },
  });

  assert.equal(out.ok, true);
  assert.deepEqual(out.lost, []);
  assert.equal(out.was.places, 2, 'a person is shown what this costs before they agree to it');
  assert.equal(out.now.places, 1);
  assert.deepEqual(store.places.map(p => p.id), ['new1'], 'a restore that adds is a merge wearing its name');
  assert.equal(store.settings.theme, 'dark', 'and the atlas comes back in its own colour');
  assert.equal(store.settings.hue, 120);
  assert.equal(store.settings.authorName, 'Mira');
  assert.equal(store.settings.clubKey, 'tc_testkey0000000000000', 'while the device keeps its own credential');
});

test('a restore the device refuses puts every record back', () => {
  fresh();
  store.addPlace(newPlace({ id: 'keep', name: 'Keep', lat: 46, lng: 8 }));
  store.addTag(newTag({ id: 'kt', name: 'Huts' }));
  const shape = () => JSON.stringify({ places: store.places, tags: store.tags, settings: store.settings });
  const before = shape();

  storage.refuse = true;
  const out = store.restore({ app: 'resonate', version: 4, places: [{ id: 'nope', name: 'Nope', lat: 45, lng: 7, tags: [] }], tags: [] });
  storage.refuse = false;

  assert.equal(out.ok, false);
  assert.equal(out.reason, 'refused');
  assert.deepEqual(out.now, out.was, 'nothing moved, so the counts did not move either');
  assert.equal(shape(), before, 'a restore is one act: refused in part, kept in none');
});

test('a restore refuses an archive that lost anything in the reading', () => {
  fresh();
  store.addPlace(newPlace({ id: 'keep', name: 'Keep', lat: 46, lng: 8 }));
  const out = store.restore({
    app: 'resonate', version: 4, tags: [],
    places: [
      { id: 'good', name: 'Good', lat: 45, lng: 7, tags: [] },
      { id: 'bad', name: 'No coordinates', tags: [] },
    ],
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'lossy');
  assert.deepEqual(out.lost.map(l => l.id), ['bad'], 'and names the record rather than a number');
  assert.deepEqual(store.places.map(p => p.id), ['keep'], 'the atlas is exactly as it was');
  assert.equal(store.restore('not a file at all').reason, 'unreadable',
    'a file that is not an archive is told apart from an archive that lost something');
});

test('comparing a file with the atlas changes neither', () => {
  fresh();
  store.addPlace(newPlace({ id: 'a', name: 'A', lat: 46, lng: 8 }));
  store.addPlace(newPlace({ id: 'b', name: 'B', lat: 47, lng: 9 }));
  store.addPlace(newPlace({ id: 'c', name: 'C', lat: 48, lng: 10 }));
  store.addRoute(newRoute({ id: 'w', path: [{ lat: 46, lng: 8 }, { lat: 46.1, lng: 8.1 }] }));

  const file = JSON.parse(store.recordsJSON());
  const held = file.places.find(p => p.id === 'a');
  file.places = [
    held,
    { ...file.places.find(p => p.id === 'b'), note: 'a sentence it did not have' },
    { ...held, id: 'n1', name: 'Newcomer' },
  ];

  const shape = () => JSON.stringify({ places: store.places, routes: store.routes });
  const before = shape();
  const onDisk = localStorage.getItem('resonate.places.v1');

  const seen = store.compare(file);
  assert.deepEqual(seen, { fresh: 1, differ: 1, identical: 2, onlyHere: 1, lost: [] });
  assert.equal(shape(), before, 'a comparison that changes what it compares is not a comparison');
  assert.equal(localStorage.getItem('resonate.places.v1'), onDisk, 'and nothing was written on the way past');
});


// ---------- a key that will not parse ----------
//
// The seal lives in module state rather than in storage, so every test here
// releases what it sealed. A seal left behind would silently refuse every
// write in the tests that follow.

test('a corrupt key is set aside, and no later edit can write over it', () => {
  fresh();
  const damaged = '[{"id":"p1","name":"Half a pl';
  localStorage.setItem('resonate.places.v1', damaged);
  store.load();

  assert.equal(store.places.length, 0, 'nothing readable came out of it');
  const sealed = unreadableKeys();
  assert.deepEqual(sealed.map(s => s.key), ['resonate.places.v1'], 'the app is told which key, by name');
  assert.equal(sealed[0].bytes, damaged.length, 'and how much of it is still there');
  assert.ok(sealed[0].at, 'and when it was found');
  assert.equal(localStorage.getItem('resonate.places.v1.unreadable'), damaged,
    'a copy is set aside under a name that says what it is');

  // the keystroke that used to be fatal
  assert.equal(store.addPlace(aPlace('The next keystroke')), null, 'the write is refused, not attempted');
  assert.equal(store.places.length, 0, 'and the refusal rolls back like any other');
  assert.equal(localStorage.getItem('resonate.places.v1'), damaged,
    'one corrupt byte must not become a blank life');

  // and every other road into that key is refused the same way
  assert.equal(store.merge({ app: 'resonate', version: 4, tags: [], places: [{ id: 'm1', name: 'M', lat: 46, lng: 8 }] }), null);
  assert.equal(store.restore({ app: 'resonate', version: 4, tags: [], places: [{ id: 'r1', name: 'R', lat: 46, lng: 8 }] }).ok, false);
  assert.equal(localStorage.getItem('resonate.places.v1'), damaged, 'still exactly as it was found');

  releaseUnreadable('resonate.places.v1');
});

test('the copy set aside on the first load is not replaced on the second', () => {
  fresh();
  localStorage.setItem('resonate.places.v1', 'the damage as first found');
  store.load();
  localStorage.setItem('resonate.places.v1', 'something later, and worse');
  store.load();
  assert.equal(localStorage.getItem('resonate.places.v1.unreadable'), 'the damage as first found',
    'the earliest copy is the one worth keeping');
  releaseUnreadable('resonate.places.v1');
});

test('releasing a sealed key lets the atlas be written again, and keeps the copy', () => {
  fresh();
  const damaged = '{ not json at all';
  localStorage.setItem('resonate.places.v1', damaged);
  store.load();
  assert.equal(store.addPlace(aPlace('Refused')), null);

  assert.equal(releaseUnreadable('resonate.places.v1'), true, 'a person who has been told may decide');
  assert.deepEqual(unreadableKeys(), [], 'and the seal is gone');

  assert.ok(store.addPlace(aPlace('Kept')), 'the key takes a write again');
  assert.ok(localStorage.getItem('resonate.places.v1').includes('Kept'));
  assert.equal(localStorage.getItem('resonate.places.v1.unreadable'), damaged,
    'releasing is a decision to move on, not a decision to destroy');
});

test('a write refused because a key is sealed is announced, not swallowed', () => {
  fresh();
  localStorage.setItem('resonate.tags.v1', 'not json');
  store.load();

  const heard = [];
  setWriteFailedHandler((key, err) => heard.push([key, err.message]));
  assert.equal(store.addTag(newTag({ name: 'Huts' })), null);
  setWriteFailedHandler(null);

  assert.equal(heard.length, 1, 'a refusal nobody hears is the silence this was built against');
  assert.equal(heard[0][0], 'resonate.tags.v1');
  assert.match(heard[0][1], /will not be written over/);

  releaseUnreadable('resonate.tags.v1');
  assert.deepEqual(unreadableKeys(), [], 'nothing is left sealed for the next test');
});

// ---------- what the adversarial pass over rf67 turned up ----------

test('a way that spends its first quarter kilometre near the door still loses the door', () => {
  fresh();
  // a track that circles the block before setting off: 300 m of line covered,
  // 40 m of ground gained. measuring the line alone hands over the doorstep.
  const door = { lat: 46, lng: 8 };
  const ring = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    ring.push({ lat: 46 + Math.sin(a) * 0.0004, lng: 8 + Math.cos(a) * 0.0004 });
  }
  const away = Array.from({ length: 40 }, (_, i) => ({ lat: 46 + 0.0004 + i * 0.0006, lng: 8 }));
  const back = Array.from({ length: 40 }, (_, i) => ({ lat: 46 + 0.0004 + (39 - i) * 0.0006, lng: 8.004 }));
  const r = newRoute({ name: 'from my door', path: [door, ...ring, ...away, ...back], trimEnds: true });
  const out = trimWay(r);
  assert.ok(out, 'the way is long enough to trim');
  const km = (a, b) => {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  assert.ok(km(door, out.path[0]) >= 0.2499,
    `the new start is ${(km(door, out.path[0]) * 1000).toFixed(0)} m from the door, and a quarter kilometre was promised`);
  assert.ok(km(r.path[r.path.length - 1], out.path[out.path.length - 1]) >= 0.2499,
    'and the same at the far end');
});

test('a segment stepping over the antimeridian is trimmed along the way it was walked', () => {
  fresh();
  // a walk from 179.9E to 179.9W: eight kilometres of ground, not forty thousand
  const path = [];
  for (let i = 0; i <= 40; i++) path.push({ lat: 0, lng: 179.8 + i * 0.01 > 180 ? 179.8 + i * 0.01 - 360 : 179.8 + i * 0.01 });
  const out = trimWay(newRoute({ name: 'the date line', path, trimEnds: true }));
  assert.ok(out, 'it is long enough to trim');
  for (const pt of out.path) {
    assert.ok(Math.abs(pt.lng) > 179, `a trimmed point landed at ${pt.lng}, which is halfway across the pacific`);
  }
});

test('a merge does not repaint an atlas that already has a look', () => {
  fresh();
  store.settings.chosen = true;
  store.settings.hue = 300;
  store.settings.theme = 'dark';
  store.addPlace(aPlace('Mine'));
  store.merge({ app: 'resonate', version: 4, tags: [], places: [{ id: 'x', name: 'Theirs', lat: 1, lng: 2, tags: [] }],
    settings: { hue: 74, theme: 'light', authorName: 'someone else' } }, { own: true });
  assert.equal(store.settings.hue, 300, 'a file brought in beside your atlas does not choose its colour');
  assert.equal(store.settings.theme, 'dark');
});

test('a restore is the operation that does set the whole look', () => {
  fresh();
  store.settings.chosen = true;
  store.settings.hue = 300;
  const r = store.restore({ app: 'resonate', version: 4, tags: [], routes: [],
    places: [{ id: 'x', name: 'Theirs', lat: 1, lng: 2, tags: [] }],
    settings: { hue: 74, theme: 'light', authorName: 'ada' } });
  assert.equal(r.ok, true);
  assert.equal(store.settings.hue, 74, 'being the file means being its colour too');
  assert.equal(store.settings.authorName, 'ada');
});

test('comparing counts the folios and voices a replace would also destroy', () => {
  fresh();
  store.addPlace(newPlace({ id: 'p1', name: 'Held', lat: 46, lng: 8 }));
  store.addFolio(newFolio({ id: 'f1', title: 'Mine alone', placeIds: ['p1'] }));
  store.addCorrespondent({ id: 'c1', name: 'Marta', tags: [], places: [] });
  const seen = store.compare({ app: 'resonate', version: 4, tags: [], routes: [], folios: [], correspondents: [],
    places: [{ id: 'p1', name: 'Held', lat: 46, lng: 8, tags: [] }] });
  assert.ok(seen.onlyHere >= 2,
    `the folio and the voice a replace would take are not counted: onlyHere is ${seen.onlyHere}`);
});

test('a photograph is the same photograph whether the file inlines it or this device holds it', () => {
  fresh();
  const p = store.addPlace(newPlace({ id: 'ph1', name: 'With a picture', lat: 46, lng: 8 }));
  store.updatePlace('ph1', { photos: ['ph_msj14t2y11u6v'] });
  // the same record as a full backup writes it, with the picture inlined
  const asFile = { ...store.placeById('ph1'), photos: ['data:image/png;base64,iVBORw0KGgo='] };
  const seen = store.compare({ app: 'resonate', version: 4, tags: [], routes: [], places: [asFile] });
  assert.equal(seen.differ, 0, 'only the carrier differs, and a carrier is not a change');
  assert.equal(seen.identical, 1);
});

// ---------- valid json of the wrong shape is corruption too ----------

test('a collection stored as the wrong kind of thing is sealed, not crashed into', () => {
  fresh();
  // perfectly good json, and not a list of records. this used to sail through
  // read() and throw on the next line that touched it, on every load
  localStorage.setItem('resonate.tags.v1', '{}');
  store.load();
  assert.deepEqual(store.tags, [], 'nothing half formed is left where the app will use it');
  const sealed = unreadableKeys().map(k => k.key);
  assert.ok(sealed.includes('resonate.tags.v1'), `the key was not sealed: ${sealed.join(', ')}`);
  assert.equal(localStorage.getItem('resonate.tags.v1'), '{}', 'and the bytes are exactly where they were');
  releaseUnreadable('resonate.tags.v1');
});

test('one record the reader turns down holds back the whole collection', () => {
  fresh();
  // two places, one without coordinates. the reader keeps one; keeping one and
  // then healing dates over the top used to write the shorter list back and
  // destroy the other
  const both = JSON.stringify([
    { id: 'ok', name: 'Kept', lat: 46, lng: 8, tags: [] },
    { id: 'bad', name: 'No coordinates', tags: [] },
  ]);
  localStorage.setItem('resonate.places.v1', both);
  store.load();
  assert.equal(store.places.length, 0, 'a collection is all of its records or none');
  assert.equal(localStorage.getItem('resonate.places.v1'), both, 'and the original is byte for byte where it was');
  const why = unreadableKeys().find(k => k.key === 'resonate.places.v1')?.why || '';
  assert.match(why, /1 of 2/, `the person is told how much: ${why}`);
  releaseUnreadable('resonate.places.v1');
});

test('settings stored as a list do not become the settings', () => {
  fresh();
  localStorage.setItem('resonate.settings.v1', '["not", "settings"]');
  store.load();
  assert.equal(store.settings.theme, 'auto', 'the defaults stand');
  assert.ok(unreadableKeys().some(k => k.key === 'resonate.settings.v1'));
  releaseUnreadable('resonate.settings.v1');
});

test('a collection that reads whole is loaded whole, and still heals its dates', () => {
  fresh();
  localStorage.setItem('resonate.places.v1', JSON.stringify([
    { id: 'd1', name: 'One', lat: 46, lng: 8, tags: [], createdAt: '' },
    { id: 'd2', name: 'Two', lat: 47, lng: 9, tags: [], createdAt: '2024-05-12T09:00:00Z' },
  ]));
  store.load();
  assert.equal(store.places.length, 2, 'nothing is sealed when nothing is wrong');
  assert.deepEqual(unreadableKeys(), []);
  assert.ok(store.placeById('d1').createdAt, 'and the empty date was still healed');
});

// ---------- a loan is not a recommendation ----------

test('a sample record is in nothing a stranger is handed', async () => {
  fresh();
  store.addPlace(newPlace({ id: 'mine', name: 'My Own Place', lat: 46, lng: 8 }));
  store.addPlace(newPlace({ id: 'lent', name: 'A Demonstration', lat: 47, lng: 9, sample: true }));
  store.addRoute(newRoute({ id: 'lentway', name: 'A Demonstration Path', sample: true,
    path: Array.from({ length: 20 }, (_, i) => ({ lat: 46 + i * 0.01, lng: 8 })) }));

  const outward = [store.exportShareJSON(), store.exportKML(), store.exportCSV(),
    store.exportMarkdown(), store.exportGeoJSON()];
  for (const text of outward) {
    assert.equal(text.includes('A Demonstration'), false, 'a place on loan travelled as the sender’s own');
    assert.ok(text.includes('My Own Place'), 'and the real record still travels');
  }

  // the person's own device and their own backup keep everything
  const full = JSON.parse(await store.exportJSON());
  assert.equal(full.places.length, 2, 'a backup is not the place to tidy up');
  assert.ok(JSON.parse(store.recordsJSON()).places.some(p => p.sample), 'and neither is a snapshot');
});

// ---------- a file has to say what it is ----------

test('a file that is not a resonate archive is refused, not read as an empty one', () => {
  fresh();
  const r = store.restore({ app: 'some-other-program', version: 4, places: [], tags: [] });
  assert.equal(r.ok, false);
  assert.match(r.lost.map(l => l.reason).join(' '), /not by resonate/);
});

test('a file from a newer resonate is refused rather than quietly narrowed', () => {
  fresh();
  // it carries fields this build cannot see. reading it here would drop them
  // and then write the shorter thing back as though it were the whole atlas
  const r = store.restore({
    app: 'resonate', version: 99, tags: [], routes: [],
    places: [{ id: 'p1', name: 'From the future', lat: 46, lng: 8, tags: [], mood: 'quiet' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.lost.map(l => l.reason).join(' '), /newer resonate/);
});

test('two records sharing one id are refused, because only one could be reached', () => {
  fresh();
  const twice = { id: 'dup', name: 'Twice', lat: 46, lng: 8, tags: [] };
  const r = store.restore({ app: 'resonate', version: 4, tags: [], routes: [], places: [twice, { ...twice }] });
  assert.equal(r.ok, false);
  assert.match(r.lost.map(l => l.reason).join(' '), /share one id/);
});

test('a folio naming records the file does not carry is refused', () => {
  fresh();
  const r = store.restore({
    app: 'resonate', version: 4, tags: [], routes: [],
    places: [{ id: 'p1', name: 'Here', lat: 46, lng: 8, tags: [] }],
    folios: [{ id: 'f1', title: 'Points at nothing', placeIds: ['p1', 'gone'], routeIds: [] }],
  });
  assert.equal(r.ok, false);
  assert.match(r.lost.map(l => l.reason).join(' '), /does not contain/);
});

test('a file this build wrote is still read without complaint', async () => {
  fresh();
  store.addPlace(newPlace({ id: 'p1', name: 'Mine', lat: 46, lng: 8 }));
  store.addFolio(newFolio({ id: 'f1', title: 'A folio', placeIds: ['p1'] }));
  const file = JSON.parse(await store.exportJSON());
  fresh();
  const r = store.restore(file);
  assert.equal(r.ok, true, `a round trip must not trip its own gate: ${JSON.stringify(r.lost)}`);
  assert.equal(store.places.length, 1);
  assert.equal(store.folios.length, 1);
});
