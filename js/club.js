// club.js — the travellers club, from the member's side.
//
// The rule that makes the club worth joining: the envelope is sealed HERE,
// on this device, before it travels. The phrase never leaves. The club keeps
// bytes it cannot read, and if the phrase is lost, the envelope is lost with
// it. That sentence is the price of the privacy, and it is said out loud.
//
// Sealing: PBKDF2-SHA256, 310000 rounds, over a 16-byte salt, into AES-GCM
// with a 12-byte nonce. The envelope is  rsnt1 | salt | iv | ciphertext.

const MAGIC = new TextEncoder().encode('rsnt1');
const ROUNDS = 310_000;

// where the club stands. empty until the door is deployed; a value in
// settings (clubUrl) overrides, which is also how the mock is reached.
export const CLUB_URL = '';

// the stripe payment link that begins a membership. empty until it exists.
export const JOIN_URL = '';

async function keyFrom(phrase, salt) {
  const raw = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(phrase).normalize('NFC')),
    'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ROUNDS, hash: 'SHA-256' },
    raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(text, phrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(phrase, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const out = new Uint8Array(MAGIC.length + 16 + 12 + ct.length);
  out.set(MAGIC, 0); out.set(salt, MAGIC.length); out.set(iv, MAGIC.length + 16);
  out.set(ct, MAGIC.length + 28);
  return out;
}

// returns the text, or throws: 'not-an-envelope' | 'wrong-phrase'
export async function unseal(bytes, phrase) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < MAGIC.length + 28 + 1 || !MAGIC.every((v, i) => b[i] === v)) {
    throw new Error('not-an-envelope');
  }
  const salt = b.slice(MAGIC.length, MAGIC.length + 16);
  const iv = b.slice(MAGIC.length + 16, MAGIC.length + 28);
  const key = await keyFrom(phrase, salt);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b.slice(MAGIC.length + 28));
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error('wrong-phrase');
  }
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
