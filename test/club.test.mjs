// The envelope: sealed here, opened here, and never mistaken for anything else.
import test from 'node:test';
import assert from 'node:assert/strict';
// The page loads this library with a script tag, and the library hangs itself
// on the global. Node reads the same file as a module or as commonjs depending
// on what package.json says, so take whichever of the three actually answers.
// Guessing wrong is silent: every seal falls back to pbkdf2 and the argon2
// tests pass on the wrong dialect.
const hw = await import('../vendor/argon2/argon2.umd.min.js');
globalThis.hashwasm = [hw.default, hw, globalThis.hashwasm]
  .find(x => typeof x?.argon2id === 'function');
import { seal, unseal, burnPatch, syncGuard } from '../js/club.js';

test('the library under these tests is the argon2 the page gets', () => {
  assert.equal(typeof globalThis.hashwasm?.argon2id, 'function',
    'without it every assertion below quietly tests the fallback instead');
});

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


// ---- the second form of the envelope ----

test('an argon2id envelope round-trips, bound to its key', async () => {
  const bytes = await seal('the atlas', 'a long walk after rain', { bind: 'tc_k1' });
  assert.equal(bytes[5], 2, 'argon2id is the write default when the library stands');
  assert.equal(await unseal(bytes, 'a long walk after rain', { bind: 'tc_k1' }), 'the atlas');
});

test('an envelope sealed under another key says so by name', async () => {
  const bytes = await seal('the atlas', 'phrase123', { bind: 'tc_alpha' });
  await assert.rejects(() => unseal(bytes, 'phrase123', { bind: 'tc_beta' }), /sealed-for-another-key/);
});

test('a tampered header refuses, because the seal binds it', async () => {
  const bytes = await seal('the atlas', 'phrase123', { bind: 'tc_k1' });
  bytes[10] += 1; // one more pass than was sealed
  await assert.rejects(() => unseal(bytes, 'phrase123', { bind: 'tc_k1' }), /wrong-phrase|not-an-envelope/);
});

test('a hostile header may not spend this device', async () => {
  const bytes = await seal('the atlas', 'phrase123', { bind: 'tc_k1' });
  new DataView(bytes.buffer, 6, 4).setUint32(0, 4_000_000_000, true); // 4 TB of memory, politely declined
  await assert.rejects(() => unseal(bytes, 'phrase123', { bind: 'tc_k1' }), /not-an-envelope/);
});

test('the first form still opens, unbound', async () => {
  // an rsnt1 envelope, sealed the way rf45 sealed them
  const te = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const raw = await crypto.subtle.importKey('raw', te.encode('old phrase'), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' },
    raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode('the old atlas')));
  const legacy = new Uint8Array([...te.encode('rsnt1'), ...salt, ...iv, ...ct]);
  assert.equal(await unseal(legacy, 'old phrase', { bind: 'tc_whatever' }), 'the old atlas');
});

test('a device that cannot open an envelope says so, and does not accuse it', async (t) => {
  const bytes = await seal('the atlas', 'phrase123', { bind: 'tc_k1' });
  assert.equal(bytes[5], 2);
  const held = globalThis.hashwasm;
  globalThis.hashwasm = undefined;
  t.after(() => { globalThis.hashwasm = held; });
  await assert.rejects(() => unseal(bytes, 'phrase123', { bind: 'tc_k1' }), /this-device-cannot-open-it/);
});

test('an argon2 that throws at run time still seals, in the other dialect', async (t) => {
  const held = globalThis.hashwasm;
  globalThis.hashwasm = { argon2id: async () => { throw new Error('wasm refused'); } };
  t.after(() => { globalThis.hashwasm = held; });
  const bytes = await seal('the atlas', 'phrase123', { bind: 'tc_k1' });
  assert.equal(bytes[5], 1, 'it fell back rather than failing the seal');
  globalThis.hashwasm = held;
  assert.equal(await unseal(bytes, 'phrase123', { bind: 'tc_k1' }), 'the atlas');
});

test('an argon2 that throws while reading blames the device, not the envelope', async (t) => {
  const bytes = await seal('the atlas', 'phrase123', { bind: 'tc_k1' });
  const held = globalThis.hashwasm;
  globalThis.hashwasm = { argon2id: async () => { throw new Error('wasm refused'); } };
  t.after(() => { globalThis.hashwasm = held; });
  await assert.rejects(() => unseal(bytes, 'phrase123', { bind: 'tc_k1' }), /this-device-cannot-open-it/);
});

test('a truncated first-form envelope is not mistaken for a whole one', async () => {
  const te = new TextEncoder();
  const stub = new Uint8Array([...te.encode('rsnt1'), ...new Uint8Array(30)]);
  await assert.rejects(() => unseal(stub, 'phrase'), /not-an-envelope/);
});

test('the pbkdf2 fallback writes when argon2 is away', async (t) => {
  const held = globalThis.hashwasm;
  globalThis.hashwasm = undefined;
  t.after(() => { globalThis.hashwasm = held; });
  const bytes = await seal('the atlas', 'phrase123', { bind: 'tc_k1' });
  assert.equal(bytes[5], 1, 'pbkdf2 dialect');
  globalThis.hashwasm = held;
  assert.equal(await unseal(bytes, 'phrase123', { bind: 'tc_k1' }), 'the atlas', 'and either reader opens it');
});

test('after a burn, an empty vault is sealable again', () => {
  assert.equal(syncGuard(false, 4), 'refuse-empty', 'history refuses emptiness');
  const s2 = { clubSeq: 4, clubSealedAt: 'x', ...burnPatch() };
  assert.equal(syncGuard(false, s2.clubSeq), 'proceed', 'the burn starts the count over');
  assert.equal(s2.clubSealedAt, '');
});
