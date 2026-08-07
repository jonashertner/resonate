// The envelope: sealed here, opened here, and never mistaken for anything else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal } from '../js/club.js';

test('an envelope round-trips through its phrase', async () => {
  const text = JSON.stringify({ places: [{ name: 'Café Sabarsky', lat: 40.78, lng: -73.96 }] });
  const bytes = await seal(text, 'a long walk after rain');
  assert.equal(await unseal(bytes, 'a long walk after rain'), text);
});

test('the wrong phrase opens nothing', async () => {
  const bytes = await seal('the atlas', 'right phrase');
  await assert.rejects(() => unseal(bytes, 'wrong phrase'), /wrong-phrase/);
});

test('a tampered envelope refuses', async () => {
  const bytes = await seal('the atlas', 'phrase');
  bytes[bytes.length - 3] ^= 0xff;
  await assert.rejects(() => unseal(bytes, 'phrase'), /wrong-phrase/);
});

test('bytes that are not an envelope say so', async () => {
  await assert.rejects(() => unseal(new TextEncoder().encode('{"places":[]}'), 'phrase'), /not-an-envelope/);
  await assert.rejects(() => unseal(new Uint8Array(4), 'phrase'), /not-an-envelope/);
});

test('the phrase is normalised, so a composed accent equals its parts', async () => {
  const bytes = await seal('the atlas', 'café'); // é composed
  assert.equal(await unseal(bytes, 'café'), 'the atlas'); // e + combining acute
});

test('two sealings of the same text never repeat themselves', async () => {
  const a = await seal('the atlas', 'phrase');
  const b = await seal('the atlas', 'phrase');
  assert.notDeepEqual([...a], [...b], 'fresh salt and nonce every time');
});
