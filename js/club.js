// club.js — the travellers club, from the member's side.
//
// The rule that makes the club worth joining: the envelope is sealed HERE,
// on this device, before it travels. The phrase never leaves. The club keeps
// bytes it cannot read, and if the phrase is lost, the envelope is lost with
// it. That sentence is the price of the privacy, and it is said out loud.
//
// Sealing: Argon2id at 64 MiB, three passes, one lane, into AES-GCM-256 with
// a 12-byte nonce, over a 16-byte salt. PBKDF2-SHA256 at 600000 iterations is
// the fallback where a device cannot run Argon2id. The envelope is
//   rsnt2 | kdfId | params | kid8 | salt | iv | ciphertext
// and the older rsnt1 | salt | iv | ciphertext is read forever, written never.
// The exact bytes are specified in club/SPEC.md, published at /SPEC.md.

// where the club stands. empty until the door is deployed; a value in
// settings (clubUrl) overrides, which is also how the mock is reached.
export const CLUB_URL = '';

// the stripe payment link that begins a membership. empty until it exists.
export const JOIN_URL = '';

const MAGIC1 = new TextEncoder().encode('rsnt1');
const MAGIC2 = new TextEncoder().encode('rsnt2');
const ROUNDS_V1 = 310_000;   // what rsnt1 envelopes were sealed with
const ROUNDS_WRITE = 600_000; // what a pbkdf2 fallback writes today

// argon2id, when the vendored library stands. the browser loads it as a
// script; node tests import it and set the global themselves.
const argon2 = () => globalThis.hashwasm?.argon2id ?? null;

// write-side kdf parameters. argon2id follows owasp's first recommendation:
// 64 MiB, three passes, one lane. the bounds in unseal are the read-side law.
const ARGON2_M = 65_536, ARGON2_T = 3, ARGON2_P = 1;

const te = new TextEncoder();

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function kid8Of(bind) {
  if (!bind) return new Uint8Array(8);
  return (await sha256(te.encode('tc:' + bind))).slice(0, 8);
}

async function pbkdf2Key(phrase, salt, iterations) {
  const raw = await crypto.subtle.importKey(
    'raw', te.encode(String(phrase).normalize('NFC')),
    'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function argon2Key(phrase, salt, m, t, pl) {
  const bits = await argon2()({
    password: String(phrase).normalize('NFC'), salt,
    memorySize: m, iterations: t, parallelism: pl,
    hashLength: 32, outputType: 'binary',
  });
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// the envelope, second form:
//   rsnt2 | kdfId u8 | p0 u32le | p1 u8 | p2 u8 | kid8 | salt16 | iv12 | ct
//   kdfId 1 = pbkdf2-sha256, p0 iterations
//   kdfId 2 = argon2id, p0 memory KiB, p1 passes, p2 lanes
// the first twenty bytes and the membership key are bound into the seal as
// aad, so neither the kdf parameters nor the owner can be quietly swapped.
// the first form, rsnt1 | salt16 | iv12 | ct, is read forever, written never.

function u32le(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }

export async function seal(text, phrase, { bind = '' } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // argon2id when the library stands AND the device can run it: a wasm that
  // parses but cannot compile (lockdown modes, old policies, low memory)
  // falls back to pbkdf2 rather than failing the seal
  let key = null;
  let useArgon = !!argon2();
  if (useArgon) {
    try { key = await argon2Key(phrase, salt, ARGON2_M, ARGON2_T, ARGON2_P); }
    catch { useArgon = false; }
  }
  if (!key) key = await pbkdf2Key(phrase, salt, ROUNDS_WRITE);

  const header = new Uint8Array(20);
  header.set(MAGIC2, 0);
  header[5] = useArgon ? 2 : 1;
  header.set(u32le(useArgon ? ARGON2_M : ROUNDS_WRITE), 6);
  header[10] = useArgon ? ARGON2_T : 0;
  header[11] = useArgon ? ARGON2_P : 0;
  header.set(await kid8Of(bind), 12);
  const aad = new Uint8Array([...header, ...te.encode(bind)]);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad }, key, te.encode(text)));

  const out = new Uint8Array(20 + 16 + 12 + ct.length);
  out.set(header, 0); out.set(salt, 20); out.set(iv, 36); out.set(ct, 48);
  return out;
}

// returns the text, or throws:
//   'not-an-envelope' | 'sealed-for-another-key' | 'wrong-phrase'
export async function unseal(bytes, phrase, { bind = '' } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  // the first form: pbkdf2 at its old count, nothing bound. 49 bytes is the
  // smallest honest rsnt1: magic, salt, iv, and one gcm tag over nothing.
  if (b.length >= 49 && MAGIC1.every((v, i) => b[i] === v)) {
    const salt = b.slice(5, 21), iv = b.slice(21, 33);
    const key = await pbkdf2Key(phrase, salt, ROUNDS_V1);
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b.slice(33));
      return new TextDecoder().decode(pt);
    } catch { throw new Error('wrong-phrase'); }
  }

  if (b.length < 49 || !MAGIC2.every((v, i) => b[i] === v)) throw new Error('not-an-envelope');
  const kdfId = b[5];
  const p0 = new DataView(b.buffer, b.byteOffset + 6, 4).getUint32(0, true);
  const p1 = b[10], p2 = b[11];
  // read-side bounds: a hostile header may not spend this device's memory
  if (kdfId === 1) {
    if (p0 < 100_000 || p0 > 5_000_000) throw new Error('not-an-envelope');
  } else if (kdfId === 2) {
    if (p0 < 8_192 || p0 > 262_144 || p1 < 1 || p1 > 10 || p2 < 1 || p2 > 4) throw new Error('not-an-envelope');
    // the envelope is fine; this device cannot derive its key
    if (!argon2()) throw new Error('this-device-cannot-open-it');
  } else {
    throw new Error('not-an-envelope');
  }

  const kid = b.slice(12, 20);
  if (bind) {
    const mine = await kid8Of(bind);
    const zero = kid.every(x => x === 0);
    if (!zero && !kid.every((x, i) => x === mine[i])) throw new Error('sealed-for-another-key');
  }

  const header = b.slice(0, 20), salt = b.slice(20, 36), iv = b.slice(36, 48);
  let key;
  if (kdfId === 2) {
    try { key = await argon2Key(phrase, salt, p0, p1, p2); }
    catch { throw new Error('this-device-cannot-open-it'); }
  } else {
    key = await pbkdf2Key(phrase, salt, p0);
  }
  const aad = new Uint8Array([...header, ...te.encode(bind)]);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, b.slice(48));
    return new TextDecoder().decode(pt);
  } catch { throw new Error('wrong-phrase'); }
}

// ---- the sync's pure law, testable without a browser ----

// after a burn, the count starts over: apply this to settings
export function burnPatch() { return { clubSeq: 0, clubSealedAt: '' }; }

// an empty vault over a history of sealing is refused; anything else proceeds
export function syncGuard(gotExists, lastSeq) {
  return !gotExists && lastSeq > 0 ? 'refuse-empty' : 'proceed';
}

// ---- speaking to the club ----

export function makeClient(base, keyGetter) {
  const call = async (path, opts = {}) => {
    const key = keyGetter();
    const headers = { ...(opts.headers || {}) };
    if (key) headers.authorization = `Bearer ${key}`;
    const r = await fetch(base.replace(/\/$/, '') + path, { ...opts, headers });
    return r;
  };
  return {
    // a checkout session becomes a key: the door speaks once
    async door(session) {
      const r = await call('/door', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || 'the door did not answer');
      return r.json();
    },
    async membership() {
      const r = await call('/membership');
      if (r.status === 401) return { standing: 'none' };
      if (!r.ok) throw new Error('the club did not answer');
      return r.json();
    },
    async putVault(bytes) {
      const r = await call('/vault', { method: 'PUT', body: bytes });
      if (r.status === 402) throw new Error('lapsed');
      if (r.status === 413) throw new Error('too-large');
      if (!r.ok) throw new Error('the vault did not answer');
      return r.json();
    },
    // returns { bytes, at } or null when the vault is empty
    async getVault(prev = false) {
      const r = await call(prev ? '/vault?prev=1' : '/vault');
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('the vault did not answer');
      return { bytes: new Uint8Array(await r.arrayBuffer()), at: r.headers.get('x-sealed-at') || '' };
    },
    async delVault() {
      const r = await call('/vault', { method: 'DELETE' });
      if (!r.ok) throw new Error('the vault did not answer');
      return r.json();
    },
  };
}
