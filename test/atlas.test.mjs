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

// ---------- ways ----------

const route = await import('../js/route.js?v=test');

test('the line keeps its shape and loses its noise', () => {
  // a straight run with jitter: most points say nothing and should go
  const pts = [];
  for (let i = 0; i <= 200; i++) {
    pts.push({ lat: 46 + i * 0.0002, lng: 8 + (i % 2 ? 0.000004 : -0.000004), ele: 1000 + i });
  }
  const s = route.simplify(pts, 0.012);
  assert.ok(s.length < pts.length / 5, `expected heavy thinning, got ${s.length} of ${pts.length}`);
  assert.deepEqual(s[0], pts[0]);
  assert.deepEqual(s[s.length - 1], pts[pts.length - 1]);
});

test('thinning the line does not flatten the climb', () => {
  // a walk up to a col and down the other side: simplifying from above must
  // not lose the summit, which is what makes a walk what it is
  const pts = [];
  for (let i = 0; i <= 900; i++) {
    const t = i / 900;
    const ele = t < 0.55
      ? 1180 + (2260 - 1180) * Math.pow(t / 0.55, 1.15)
      : 2260 - (2260 - 1420) * Math.pow((t - 0.55) / 0.45, 0.9);
    pts.push({ lat: 46 + i * 0.0002, lng: 8 + i * 0.00021, ele });
  }
  const full = route.measure(pts);
  const thin = route.measure(route.simplify(pts, 0.012));
  assert.ok(thin.length !== 0);
  assert.ok(Math.abs(thin.high - full.high) <= 5, `summit lost: ${thin.high} vs ${full.high}`);
  assert.ok(Math.abs(thin.ascent - full.ascent) / full.ascent < 0.08,
    `climb flattened: ${thin.ascent} vs ${full.ascent}`);
  assert.ok(Math.abs(thin.km - full.km) / full.km < 0.02, `distance drifted: ${thin.km} vs ${full.km}`);
});

test('a climb is measured, and a barometer twitch is not', () => {
  // 100 steps up 5 m each, with one metre of noise on every reading
  const pts = [];
  for (let i = 0; i <= 100; i++) {
    pts.push({ lat: 46 + i * 0.0009, lng: 8, ele: 1000 + i * 5 + (i % 2 ? 1 : -1) });
  }
  const m = route.measure(pts);
  assert.ok(m.km > 9 && m.km < 11, `distance ${m.km}`);
  assert.ok(Math.abs(m.ascent - 500) < 40, `ascent ${m.ascent} should be near 500`);
  assert.ok(m.descent < 40, `descent ${m.descent} should be near nothing`);
  // the summit is what the instrument read, not a peak flattened by smoothing
  assert.ok(Math.abs(m.high - 1500) <= 2, `high ${m.high} should be the real summit`);
  assert.ok(Math.abs(m.low - 1000) <= 2, `low ${m.low}`);
  assert.ok(m.hours > 0 && m.hours < 24);
  assert.equal(m.loop, false);
});

test('a loop knows it is a loop', () => {
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    pts.push({ lat: 46 + Math.sin(a) * 0.01, lng: 8 + Math.cos(a) * 0.01, ele: 800 });
  }
  assert.equal(route.measure(pts).loop, true);
});

test('a line survives being carried in a link', () => {
  const pts = [
    { lat: 46.5721, lng: 8.0034, ele: 1204 },
    { lat: 46.5799, lng: 8.0121, ele: 1388 },
    { lat: 46.5844, lng: 8.0203, ele: 1502 },
  ];
  const back = route.decodePath(route.encodePath(pts));
  assert.equal(back.length, 3);
  back.forEach((p, i) => {
    assert.ok(Math.abs(p.lat - pts[i].lat) < 1e-5, `lat ${p.lat}`);
    assert.ok(Math.abs(p.lng - pts[i].lng) < 1e-5, `lng ${p.lng}`);
    assert.equal(p.ele, pts[i].ele);
  });
});

test('an encoded line is far smaller than the points it stands for', () => {
  const pts = Array.from({ length: 800 }, (_, i) => ({ lat: 46 + i * 0.0001, lng: 8 + i * 0.0001, ele: 1000 + (i % 60) }));
  const enc = route.encodePath(pts);
  assert.ok(enc.length < JSON.stringify(pts).length / 6,
    `encoded ${enc.length} vs json ${JSON.stringify(pts).length}`);
});

test('a hostile line is refused like anything else from outside', () => {
  assert.equal(schema.normRoute({ path: [{ lat: 1, lng: 1 }] }), null, 'one point is not a way');
  assert.equal(schema.normRoute({ path: 'nope' }), null);
  assert.equal(schema.normRoute(null), null);
  const r = schema.normRoute({
    path: [{ lat: 1, lng: 1 }, { lat: 99, lng: 1 }, { lat: 2, lng: 2 }],
    name: 'x'.repeat(999), url: 'javascript:alert(1)', rating: 1e9, km: 1e12,
  });
  assert.equal(r.path.length, 2, 'the off-globe point is dropped');
  assert.equal(r.url, '');
  assert.equal(r.rating, 5);
  assert.ok(r.km <= 100000);
});

test('an atlas link carries no diary of when', () => {
  const url = share.makeShareUrl(
    [{ id: 't1', name: 'Wine', hue: 12 }],
    [{ id: 'p1', name: 'Septime', lat: 48.85, lng: 2.38, tags: ['t1'], status: 'visited',
       rating: 5, note: 'book ahead', url: '', address: '', city: 'Paris', country: 'France',
       countryCode: 'fr', photos: [], createdAt: '2024-01-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' }],
    'Ada', []);
  location.hash = new URL(url).hash;
  const back = share.parseShareHash();
  assert.ok(back && back.places.length === 1, 'the link round-trips');
  const raw = JSON.stringify(back.places[0]);
  assert.ok(!raw.includes('2024-01-01'), 'no created date travels');
  assert.ok(!raw.includes('2026-08-01'), 'no updated date travels');
});

test('a way in a link is bounded', () => {
  const many = Array.from({ length: 9000 }, (_, i) => ({ lat: 46 + i * 1e-5, lng: 8 }));
  const r = schema.normRoute({ path: many });
  assert.equal(r.path.length, schema.LIMITS.routePoints);
});


test('a place keeps its whole road, not only its last carrier', () => {
  // Ana found it, Mira passed it on, and it reaches a third atlas
  const fromMira = schema.normPlace({
    name: 'Septime', lat: 48.85, lng: 2.38,
    prov: [{ name: 'Ana', at: '2026-01-01' }, { name: 'Mira', at: '2026-06-01' }],
  });
  assert.equal(fromMira.provenance.name, 'Mira', 'the last hand is the one that gave it to you');
  assert.deepEqual(fromMira.provenance.chain.map(h => h.name), ['Ana'], 'and Ana is not forgotten');
});

test('the road is bounded, however long the journey', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `Carrier ${i}`, at: '2026-01-01' }));
  const p = schema.normPlace({ name: 'Much travelled', lat: 46, lng: 8, prov: many });
  assert.ok(p.provenance.chain.length <= 4, 'four before the last, five in all');
  assert.equal(p.provenance.name, 'Carrier 11');
});

test('a hostile road is filtered rather than trusted', () => {
  const p = schema.normPlace({
    name: 'Suspect', lat: 46, lng: 8,
    prov: [{ name: '' }, 'not an object', { name: 'x'.repeat(500) }, { name: 'Real' }],
  });
  const names = [...p.provenance.chain.map(h => h.name), p.provenance.name];
  assert.ok(names.every(n => n && n.length <= 60), names.join('|'));
});
