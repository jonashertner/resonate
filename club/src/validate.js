// validate.js — what the club will accept, and nothing else.
//
// The same discipline as the letterbox: a request is bounded and typed here,
// or it does not exist. Standalone, so the worker carries no dependency and
// the rules can be tested with plain node.

export const LIMITS = {
  // a sealed atlas with photographs is megabytes, not tens of them.
  // KV holds 25MB; we stop well before, and say so plainly.
  vaultBytes: 16_000_000,
  keyLength: 30, // tc_ + 26 crockford chars
  sessionId: 200,
};

// membership keys are minted here and only here: tc_ then crockford base32,
// no vowels that spell things, no characters that read two ways
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function mintKey(bytes) {
  // bytes: Uint8Array(16) of honest randomness, supplied by the caller
  let out = 'tc_';
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += ALPHABET[(acc >> bits) & 31]; }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

export function isKey(v) {
  return typeof v === 'string'
    && v.length <= LIMITS.keyLength
    && /^tc_[0-9abcdefghjkmnpqrstvwxyz]{20,27}$/.test(v);
}

export function isSessionId(v) {
  return typeof v === 'string'
    && v.length <= LIMITS.sessionId
    && /^cs_[A-Za-z0-9_]+$/.test(v);
}

// standing: a membership answers for its paid period plus three days of
// grace, so a card that stumbles does not eat a backup
export const GRACE_S = 3 * 24 * 3600;

export function standingOf(member, nowS) {
  if (!member) return 'none';
  if (member.standing === 'left') return 'left';
  const until = Number(member.until) || 0;
  return nowS <= until + GRACE_S ? 'good' : 'lapsed';
}

// constant-time equality, the same everywhere node and workers run
export function sameString(a, b) {
  const ab = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
