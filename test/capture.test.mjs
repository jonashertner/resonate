// capture.test.mjs — what a shared link is understood to mean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readShared, coordsIn, alreadyHeld } from '../js/capture.js';

test('google maps: the pin wins over the viewport', () => {
  const r = readShared({ url: 'https://www.google.com/maps/place/Septime/@48.8531,2.3789,17z/data=!4m5!3m4!1s0x0:0x0!8m2!3d48.8534!4d2.3792' });
  assert.equal(r.source, 'google maps');
  assert.equal(r.at.lat, 48.8534, 'the !3d pin, not the @ viewport');
  assert.equal(r.at.lng, 2.3792);
  assert.equal(r.name, 'Septime');
});

test('google maps: a bare query of coordinates', () => {
  const r = readShared({ url: 'https://maps.google.com/?q=46.5197,6.6323' });
  assert.deepEqual(r.at, { lat: 46.5197, lng: 6.6323 });
});

test('apple maps speaks its own dialect', () => {
  const r = readShared({ url: 'https://maps.apple.com/?ll=47.3769,8.5417&q=Kronenhalle&address=Ramistrasse%2C%20Zurich' });
  assert.equal(r.source, 'apple maps');
  assert.deepEqual(r.at, { lat: 47.3769, lng: 8.5417 });
  assert.equal(r.name, 'Kronenhalle');
  assert.ok(r.address.includes('Zurich'));
});

test('openstreetmap, by hash and by marker', () => {
  const a = readShared({ url: 'https://www.openstreetmap.org/#map=17/47.5596/7.5886' });
  assert.deepEqual(a.at, { lat: 47.5596, lng: 7.5886 });
  const b = readShared({ url: 'https://www.openstreetmap.org/?mlat=47.5596&mlon=7.5886' });
  assert.deepEqual(b.at, { lat: 47.5596, lng: 7.5886 });
});

test('a geo uri and a typed pair', () => {
  assert.deepEqual(coordsIn('geo:46.0,8.0'), { lat: 46, lng: 8 });
  assert.deepEqual(coordsIn('46.0, 8.0'), { lat: 46, lng: 8 });
  assert.equal(coordsIn('0,0'), null, 'the null island is nobody’s place');
  assert.equal(coordsIn('91,0'), null, 'off the globe');
  assert.equal(coordsIn('not coordinates'), null);
});

test('an ordinary website keeps its name and its link', () => {
  const r = readShared({ title: 'Bar Basso', url: 'https://barbasso.com/' });
  assert.equal(r.at, null, 'nothing is invented');
  assert.equal(r.name, 'Bar Basso');
  assert.equal(r.url, 'https://barbasso.com/');
});

test('a short link cannot be expanded here, and says so by having no point', () => {
  const r = readShared({ title: 'Noma', url: 'https://maps.app.goo.gl/abc123' });
  assert.equal(r.at, null);
  assert.equal(r.name, 'Noma', 'the name is still worth keeping');
});

test('plain text with nothing in it yields nothing', () => {
  assert.equal(readShared({ text: '   ' }), null);
  assert.equal(readShared({}), null);
});

test('a share that is only a name is still a place to propose', () => {
  const r = readShared({ title: 'Café Sabarsky' });
  assert.equal(r.at, null);
  assert.equal(r.name, 'Café Sabarsky');
});

test('a second copy of a place already held is recognised', () => {
  const places = [
    { id: 'p1', name: 'Septime', lat: 48.8534, lng: 2.3792 },
    { id: 'p2', name: 'Noma', lat: 55.6836, lng: 12.6103 },
  ];
  const near = alreadyHeld({ name: 'Septime', at: { lat: 48.8535, lng: 2.3793 } }, places);
  assert.equal(near?.id, 'p1', 'within 150 metres and the same name');
  const far = alreadyHeld({ name: 'Septime', at: { lat: 40, lng: 2 } }, places);
  assert.equal(far, null, 'the same name far away is another place');
  const other = alreadyHeld({ name: 'Le Chateaubriand', at: { lat: 48.8534, lng: 2.3792 } }, places);
  assert.equal(other, null, 'a different name at the same door is a different place');
  const byName = alreadyHeld({ name: 'noma', at: null }, places);
  assert.equal(byName?.id, 'p2', 'without coordinates, the name alone can answer');
});
