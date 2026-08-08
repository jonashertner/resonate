// schema.test.mjs: the gate, examined at the gate.
//
// store.test.mjs asks what the device does with a file. These ask the narrower
// question underneath: what schema.js says a file lost. A loss invented here
// is a restore refused for nothing. A loss missed here is an archive that
// comes home smaller and reports that it came home whole, which is the exact
// failure the witness exists to make impossible.
//
// Nothing in schema.js touches storage or the page, so no shim is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  OWN, LIMITS, PORTABLE_SETTINGS,
  readArchive, losses, normImport, normPlace, normSettings,
} = await import('../js/schema.js?v=test');

// the same file store.test.mjs sends through the store, kept here so the two
// levels can disagree loudly rather than pass together by accident
const theLossTable = () => ({
  version: 4,
  places: [{
    id: 'big', name: 'Everything at once', lat: 46, lng: 8, tags: [],
    photos: Array.from({ length: 201 }, (_, i) => 'ph_' + i.toString(36)),
    note: 'n'.repeat(200001),
  }],
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


// ---------- the two doors ----------

test('every cap on a person’s own record is no cap at all', () => {
  const bounded = Object.entries(OWN).filter(([, v]) => v !== Infinity);
  assert.deepEqual(bounded, [], 'a bound crept back into the door that is supposed to have none');
  // and the stranger’s door still has real numbers behind it, or the two
  // doors have quietly become one
  assert.ok(Object.values(LIMITS).every(v => Number.isFinite(v) && v > 0),
    'a cap a hostile payload cannot meet is not a cap');
});

test('an own archive loses nothing at any depth, and its witness stays empty', () => {
  const read = readArchive(theLossTable());
  assert.deepEqual(read.cut, [], 'no collection was truncated');
  assert.deepEqual(read.rejected, [], 'no record was unreadable');
  assert.deepEqual(read.clipped, [], 'and no field was shortened');
  assert.deepEqual(losses(read), []);

  // the depths themselves, so an empty witness cannot pass by reading nothing
  assert.equal(read.value.places[0].photos.length, 201);
  assert.equal(read.value.places[0].note.length, 200001);
  assert.equal(read.value.routes[0].path.length, 1475);
  assert.equal(read.value.folios[0].placeIds.length, 501);
  assert.equal(read.value.correspondents[0].places.length, 501);
});

test('the stranger’s door clips the same file at every one of those depths', () => {
  const file = theLossTable();
  file.routes[0].path = Array.from({ length: 3001 }, (_, i) => ({ lat: 46 + i * 0.00001, lng: 8 }));
  const v = normImport(file);
  assert.equal(v.places[0].photos.length, LIMITS.photos);
  assert.equal(v.places[0].note.length, LIMITS.note);
  assert.equal(v.routes[0].path.length, LIMITS.routePoints);
  assert.equal(v.folios[0].placeIds.length, LIMITS.placeIds);
  assert.equal(v.correspondents[0].places.length, LIMITS.places);
});

test('a byline is bounded for a stranger and unbounded for its author', () => {
  const long = 'A'.repeat(500);
  const read = readArchive({ places: [], settings: { authorName: long } });
  assert.equal(read.value.settings.authorName.length, 500);
  assert.deepEqual(read.clipped, []);
  assert.equal(normImport({ places: [], settings: { authorName: long } }).settings.authorName.length,
    LIMITS.author);
});


// ---------- the witness ----------

test('the witness names the field and the record when a cap does bite', () => {
  // called with the stranger’s numbers on purpose: this is what proves the
  // silence on an own archive means "nothing was cut" and not "nobody looked"
  const w = [];
  const p = normPlace({
    id: 'p1', lat: 46, lng: 8,
    note: 'n'.repeat(LIMITS.note + 1),
    photos: Array.from({ length: LIMITS.photos + 1 }, (_, i) => 'ph_' + i),
  }, 0, LIMITS, w);

  assert.equal(p.note.length, LIMITS.note);
  assert.equal(p.photos.length, LIMITS.photos);
  assert.deepEqual(w.map(e => e.field).sort(), ['note', 'photos']);
  assert.ok(w.every(e => e.kind === 'place' && e.id === 'p1'), 'a loss without a record is not a loss anyone can act on');
  assert.ok(w.every(e => typeof e.reason === 'string' && e.reason), 'and each says why, in words');
});

test('losses flattens the three ways a file comes home shorter into one list', () => {
  const flat = losses({
    cut: [{ of: 'places', given: 501, kept: 500 }],
    rejected: [{ kind: 'way', id: 'r9', at: 3, field: null, reason: 'this record could not be read' }],
    clipped: [{ kind: 'place', id: 'p1', field: 'note', given: 4001, kept: 4000, reason: 'the note is 4001 characters' }],
  });
  assert.equal(flat.length, 3, 'a caller reads one list, not three');
  assert.deepEqual(flat.map(l => l.kind), ['places', 'way', 'place']);
  assert.deepEqual(flat.map(l => l.id), [null, 'r9', 'p1']);
  assert.deepEqual(flat.map(l => l.field), [null, null, 'note']);
  assert.ok(flat.every(l => typeof l.reason === 'string' && l.reason));
  assert.deepEqual(losses(null), [], 'and nothing read lost nothing');
});

test('a record that cannot be read is named, so a person is told which', () => {
  const read = readArchive({
    places: [
      { id: 'ok', name: 'Fine', lat: 46, lng: 8 },
      { id: 'nowhere', name: 'No coordinates' },
      { id: 'offworld', name: 'Off the globe', lat: 999, lng: 8 },
    ],
  });
  assert.equal(read.value.places.length, 1);
  assert.deepEqual(read.rejected.map(r => r.id), ['nowhere', 'offworld']);
  assert.deepEqual(read.rejected.map(r => r.kind), ['place', 'place']);
  assert.deepEqual(read.rejected.map(r => r.at), [1, 2], 'and where in the file to look');
  assert.equal(losses(read).length, 2);
});

test('a file that is not an object is not an archive', () => {
  assert.equal(readArchive(null), null);
  assert.equal(readArchive('an atlas'), null);
  assert.equal(readArchive([]), null);
  // an empty archive is a different thing from no archive, and must read as one
  const empty = readArchive({});
  assert.deepEqual(empty.value.places, []);
  assert.deepEqual(losses(empty), []);
});


// ---------- what a file says about the look ----------

test('a file carries exactly the settings PORTABLE_SETTINGS names', () => {
  const out = normSettings({
    authorName: 'Mira', theme: 'dark', hue: 400, split: 999, words: false,
    introSeen: true, lastExportAt: '2026-01-01T00:00:00Z', erasedAt: '2025-12-24T00:00:00Z',
    clubKey: 'tc_secret', lastView: { z: 4 }, seeded: true, chosen: true,
  });
  assert.deepEqual(Object.keys(out).sort(), [...PORTABLE_SETTINGS].sort(),
    'the file says it carries your settings, so it has to carry them, and only them');
  assert.equal(out.hue, 40, 'a hue is an angle');
  assert.equal(out.split, 180, 'and the angle between the halves is bounded');
  assert.equal(out.words, false, 'a false is a decision, not an absence');
  assert.equal('clubKey' in out, false, 'a bearer credential is not a setting');
  assert.equal('lastView' in out, false, 'and where the map was last looking is not a memory');
});

test('settings that say nothing are carried as nothing', () => {
  assert.deepEqual(normSettings({}), {});
  assert.deepEqual(normSettings(null), {});
  assert.deepEqual(normSettings({ theme: 'chartreuse', hue: 'blue' }), {},
    'a value that is not one of the answers is no answer');
});

test('a point with no elevation reading does not become a reading of sea level', () => {
  // parseGPX writes ele: null for a trackpoint with no <ele>. Number(null) is
  // 0, which is finite, so an unmeasured point used to come back from every
  // reload as a measured sea level reading, and the way's climb with it.
  const raw = {
    version: 4, tags: [], places: [],
    routes: [{
      id: 'w1', name: 'flat', ascent: null, descent: null, high: null, low: null,
      path: [{ lat: 46, lng: 8, ele: null }, { lat: 46.01, lng: 8.01, ele: null }],
    }],
  };
  const read = readArchive(raw);
  const way = read.value.routes[0];
  assert.equal('ele' in way.path[0], false, 'unknown is not zero');
  assert.equal(way.ascent, null, 'and an unknown climb is not a flat one');
  assert.equal(way.high, null);
  assert.deepEqual(losses(read), [], 'and nothing was lost in saying so');
});

test('a point that really is at sea level keeps its reading', () => {
  const read = readArchive({
    version: 4, tags: [], places: [],
    routes: [{ id: 'w2', name: 'the shore', path: [{ lat: 46, lng: 8, ele: 0 }, { lat: 46.01, lng: 8.01, ele: 2 }] }],
  });
  assert.equal(read.value.routes[0].path[0].ele, 0, 'zero written on purpose is still zero');
});

test('the loss report names a record by the word a person sees', () => {
  // the kind strings in losses() are read out loud in the app, so they are
  // copy: they were "way" and the app now says "path" everywhere else
  const read = readArchive({
    version: 4, tags: [],
    places: [{ id: 'good', name: 'Kept', lat: 46, lng: 8, tags: [] }, { id: 'bad', name: 'No coordinates' }],
    routes: [{ id: 'stub', name: 'One point', path: [{ lat: 46, lng: 8 }] }],
  });
  const kinds = losses(read).map(l => l.kind);
  assert.ok(kinds.includes('place'), 'a place is called a place');
  assert.ok(kinds.includes('path'), `a path is called a path, not: ${kinds.join(', ')}`);
  assert.equal(kinds.includes('way'), false, 'and never the old word');
});
