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
