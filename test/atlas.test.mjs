// atlas.test.mjs — the invariants a hostile link must never break.
// Run: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// the browser globals these modules stand on
globalThis.location = { origin: 'https://example.test', pathname: '/resonate/', hash: '' };
globalThis.history = { replaceState() {} };
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
const lz = readFileSync(join(root, 'vendor/lz/lz-string.min.js'), 'utf8');
new Function(lz + '\nglobalThis.LZString = LZString;')();

const { sanePlace } = await import('../js/store.js?v=test');
const share = await import('../js/share.js?v=test');

test('a rating from a link cannot exceed five stars', () => {
  assert.equal(sanePlace({ rating: 1e9 }).rating, 5);
  assert.equal(sanePlace({ rating: -4 }).rating, 0);
  assert.equal(sanePlace({ rating: 'four' }).rating, 0);
  assert.equal(sanePlace({ rating: 3.7 }).rating, 3);
});

test('tags are always an array of strings', () => {
  assert.deepEqual(sanePlace({ tags: 5 }).tags, []);
  assert.deepEqual(sanePlace({ tags: null }).tags, []);
  assert.deepEqual(sanePlace({ tags: { a: 1 } }).tags, []);
  assert.deepEqual(sanePlace({ tags: ['a', 7, 'b'] }).tags, ['a', 'b']);
});

test('provenance is rebuilt, so sig can never leave its attribute', () => {
  const evil = sanePlace({ provenance: { name: 'x', sig: '0deg"/><img src=x onerror=alert(1)>' } });
  assert.equal(evil.provenance.sig, 0);
  assert.equal(typeof evil.provenance.sig, 'number');
});

test('a place with no provenance does not grow one', () => {
  assert.equal('provenance' in sanePlace({ name: 'a' }), false);
});

test('an ask link round-trips, carrying no places', () => {
  const url = share.makeAskUrl({ from: 'Ada', q: 'wine bars in lisbon' });
  globalThis.location.hash = url.slice(url.indexOf('#'));
  const back = share.parseShareHash();
  assert.equal(back.kind, 'ask');
  assert.equal(back.from, 'Ada');
  assert.equal(back.q, 'wine bars in lisbon');
  assert.equal(back.places, undefined);
});

test('a folio link round-trips with its places intact', () => {
  const url = share.makeFolioUrl({
    title: 'Milan', dedication: 'for you', author: 'Ada',
    tags: [{ id: 't1', name: 'wine', hue: 12, color: '#8A3B47' }],
    places: [{ id: 'p1', name: 'Enoteca', lat: 45.46, lng: 9.19, tags: ['t1'], status: 'visited', rating: 5 }],
  });
  globalThis.location.hash = url.slice(url.indexOf('#'));
  const back = share.parseShareHash();
  assert.equal(back.kind, 'folio');
  assert.equal(back.places.length, 1);
  assert.equal(back.places[0].name, 'Enoteca');
});

test('a payload that is not an atlas is refused', () => {
  globalThis.location.hash = '#m=' + globalThis.LZString.compressToEncodedURIComponent('null');
  assert.equal(share.parseShareHash(), null);
  globalThis.location.hash = '#m=notcompressedatall';
  assert.equal(share.parseShareHash(), null);
  globalThis.location.hash = '';
  assert.equal(share.parseShareHash(), null);
});

test('the evidence lines escape a hostile domain name', async () => {
  const { evidenceLines } = await import('../js/kinship.js?v=test');
  const lines = evidenceLines({
    common: [], loved: 0, alignment: 0.9, alignedDomains: ['<img src=x onerror=alert(1)>'],
    expansionDomains: ['<script>bad</script>'], picks: [{ expands: true }],
  }, '<b>Ada</b>');
  const all = lines.join(' ');
  assert.ok(!all.includes('<img'), 'an img tag survived into the evidence');
  assert.ok(!all.includes('<script'), 'a script tag survived into the evidence');
  assert.ok(all.includes('&lt;img'), 'the hostile name should appear as text');
});

// ---------- the shared protocol ----------

const schema = await import('../js/schema.js?v=test');

test('a payload without a kind it can satisfy is refused', () => {
  assert.equal(schema.normPayload(null), null);
  assert.equal(schema.normPayload('atlas'), null);
  assert.equal(schema.normPayload({ kind: 'atlas', places: [] }), null);
  assert.equal(schema.normPayload({ kind: 'folio', title: '', places: [{ lat: 1, lng: 1 }] }), null);
  assert.equal(schema.normPayload({ kind: 'ask', q: '   ' }), null);
});

test('a place off the globe is not a place', () => {
  assert.equal(schema.normPlace({ lat: 91, lng: 0 }), null);
  assert.equal(schema.normPlace({ lat: 0, lng: 181 }), null);
  assert.equal(schema.normPlace({ lat: 'x', lng: 0 }), null);
  assert.equal(schema.normPlace({ lat: NaN, lng: 0 }), null);
  assert.ok(schema.normPlace({ lat: -89.9, lng: 179.9 }));
});

test('malformed places are dropped, not carried into a crash', () => {
  const p = schema.normPayload({
    kind: 'atlas',
    places: [null, 'nope', { lat: 1, lng: 1, name: 'real' }, { lat: 999, lng: 1 }],
    tags: [null, 7, { name: 'wine' }],
  });
  assert.equal(p.places.length, 1);
  assert.equal(p.places[0].name, 'real');
  assert.equal(p.tags.length, 1);
  // every place has an array of tags, so tags.map can never throw downstream
  assert.ok(p.places.every(x => Array.isArray(x.tags)));
});

test('the payload is bounded, however long the link', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ lat: 1, lng: i / 1000, name: 'x' }));
  const p = schema.normPayload({ kind: 'atlas', places: many });
  assert.equal(p.places.length, schema.LIMITS.places);
  const long = schema.normPlace({ lat: 1, lng: 1, name: 'n'.repeat(9999), note: 'x'.repeat(99999) });
  assert.equal(long.name.length, schema.LIMITS.name);
  assert.equal(long.note.length, schema.LIMITS.note);
});

test('a prototype cannot be poisoned through a link', () => {
  const p = schema.normPayload(JSON.parse('{"kind":"atlas","places":[{"lat":1,"lng":1,"__proto__":{"pwned":true}}]}'));
  assert.equal({}.pwned, undefined);
  assert.equal(Object.prototype.pwned, undefined);
  assert.equal(p.places[0].pwned, undefined);
});

test('a javascript url never survives as a link', () => {
  assert.equal(schema.normPlace({ lat: 1, lng: 1, url: 'javascript:alert(1)' }).url, '');
  assert.equal(schema.normPlace({ lat: 1, lng: 1, url: 'data:text/html,x' }).url, '');
  assert.equal(schema.normPlace({ lat: 1, lng: 1, url: 'https://ok.test/x' }).url, 'https://ok.test/x');
});

test('a newsstand row cannot point outside the folios it names', () => {
  assert.equal(schema.normFolioCard({ file: '../../etc/passwd', title: 't' }), null);
  assert.equal(schema.normFolioCard({ file: 'a/b.json', title: 't' }), null);
  assert.equal(schema.normFolioCard({ file: 'abc123.json', title: '' }), null);
  assert.ok(schema.normFolioCard({ file: 'abc123.json', title: 'Milan' }));
});

test('a photo that is not a photo does not reach the atlas', () => {
  const p = schema.normPlace({ lat: 1, lng: 1, photos: ['data:image/png;base64,AAA', 'https://x.test/a.png', 42] });
  assert.deepEqual(p.photos, ['data:image/png;base64,AAA']);
});
