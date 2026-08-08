// The invariants the club must hold: keys are honest, standing is bounded,
// the webhook only listens to Stripe, the door opens once per subscription
// and answers the claim that opened it for a day, and the vault keeps exactly
// what it was given, replacing only the envelope the writer had read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mintKey, isKey, isClaimHash, standingOf, sameString, GRACE_S, LIMITS } from '../src/validate.js';
import { verifyWebhook } from '../src/stripe.js';
import worker from '../src/worker.js';
import { claimHash, makeClient } from '../../js/club.js';

// ---- a KV that lives for one test ----
function kv() {
  const m = new Map();
  const until = new Map(); // key -> ms, for the records that are given a ttl
  const live = (k) => {
    const t = until.get(k);
    // cloudflare forgets an expired record; so does this, so that the tests
    // of the claim window are testing the mechanism and not a promise
    if (t !== undefined && Date.now() > t) { m.delete(k); until.delete(k); }
    return m.get(k);
  };
  return {
    async get(k, type) {
      const v = live(k);
      if (v === undefined) return null;
      if (type === 'json') return JSON.parse(typeof v === 'string' ? v : new TextDecoder().decode(v));
      if (type === 'arrayBuffer') return typeof v === 'string' ? new TextEncoder().encode(v).buffer : v;
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    },
    async put(k, v, opts) {
      m.set(k, v instanceof ArrayBuffer ? v : String(v));
      if (opts?.expirationTtl) until.set(k, Date.now() + opts.expirationTtl * 1000);
      else until.delete(k);
    },
    async delete(k) { m.delete(k); until.delete(k); },
    _m: m,
  };
}

const req = (path, { method = 'GET', body, headers = {} } = {}) =>
  new Request(`https://club.example${path}`, { method, body, headers });

// a claim is 64 lowercase hex characters and nothing else; these are two
// honest ones, standing for two devices that never shared a secret
const MINE = 'a3'.repeat(32);
const THEIRS = 'b7'.repeat(32);
const door = (session, claim) => req('/door', { method: 'POST', body: JSON.stringify({ session, claim }) });
const seal = (body, headers) => req('/vault', { method: 'PUT', body, headers });

test('keys mint into their own alphabet and nothing else passes', () => {
  const k = mintKey(new Uint8Array(16).fill(7));
  assert.ok(isKey(k), k);
  assert.ok(k.startsWith('tc_'));
  assert.ok(!isKey('tc_UPPER'), 'no capitals');
  assert.ok(!isKey('tc_'), 'no empty');
  assert.ok(!isKey('sk_live_abcdefghij1234567890'), 'not a stripe secret');
});

test('standing honours the period, the grace, and the leaving', () => {
  const now = 1_000_000;
  assert.equal(standingOf(null, now), 'none');
  assert.equal(standingOf({ until: now + 10 }, now), 'good');
  assert.equal(standingOf({ until: now - 10 }, now), 'good', 'grace holds');
  assert.equal(standingOf({ until: now - GRACE_S - 1 }, now), 'lapsed');
  assert.equal(standingOf({ until: now + 10, standing: 'left' }, now), 'left');
});

test('the webhook only listens to stripe', async () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ type: 'invoice.paid' });
  const t = 1_700_000_000;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');

  assert.equal(await verifyWebhook(body, `t=${t},v1=${hex}`, secret, t + 60), true);
  assert.equal(await verifyWebhook(body, `t=${t},v1=${hex}`, 'whsec_other', t + 60), false, 'wrong secret');
  assert.equal(await verifyWebhook(body, `t=${t},v1=${hex}`, secret, t + 3600), false, 'stale');
  assert.equal(await verifyWebhook(body + ' ', `t=${t},v1=${hex}`, secret, t + 60), false, 'tampered');
  assert.equal(sameString(hex, hex), true);
});

test('the door opens on a paid session, once', async (t) => {
  const env = { BOX: kv(), STRIPE_SECRET: 'sk_test' };
  const paid = { payment_status: 'paid', mode: 'subscription', subscription: { id: 'sub_1', current_period_end: 2_000_000_000 } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(paid), { status: 200 });
  t.after(() => { globalThis.fetch = realFetch; });

  const r1 = await worker.fetch(door('cs_test_abc', MINE), env);
  const j1 = await r1.json();
  assert.equal(r1.status, 200);
  assert.ok(isKey(j1.key));
  assert.equal(j1.until, 2_000_000_000);

  const r2 = await worker.fetch(door('cs_test_abc', THEIRS), env);
  assert.equal(r2.status, 409, 'a session opens the door once, and is not a spare key afterwards');
  const j2 = await r2.json();
  assert.ok(!j2.key, 'and it never hands the membership back');

  const r4 = await worker.fetch(req('/door', { method: 'POST', body: JSON.stringify({ session: 'cs_test_abc' }) }), env);
  assert.equal(r4.status, 400, 'a session without a claim is not a request the door reads');

  globalThis.fetch = async () => new Response(JSON.stringify({ payment_status: 'unpaid', mode: 'subscription' }), { status: 200 });
  const r3 = await worker.fetch(door('cs_test_xyz', MINE), env);
  assert.equal(r3.status, 403, 'unpaid stays outside');
});

// the door, held open by a network that drops answers
function paidDoor(t, subId) {
  const env = { BOX: kv(), STRIPE_SECRET: 'sk_test' };
  const paid = { payment_status: 'paid', mode: 'subscription', subscription: { id: subId, current_period_end: 2_000_000_000 } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(paid), { status: 200 });
  t.after(() => { globalThis.fetch = realFetch; });
  return env;
}

test('the answer the network ate can be asked for again, by the one who paid', async (t) => {
  const env = paidDoor(t, 'sub_lost');

  // the first answer: minted, and imagine it never arrives
  const first = await worker.fetch(door('cs_test_lost', MINE), env);
  assert.equal(first.status, 200);
  const key = (await first.json()).key;
  assert.ok(isKey(key));

  // the same client asks again, and again, and is handed the same key
  for (const nth of [1, 2, 3]) {
    const again = await worker.fetch(door('cs_test_lost', MINE), env);
    assert.equal(again.status, 200, `ask ${nth}`);
    const j = await again.json();
    assert.equal(j.key, key, 'the same key, not a second one');
    assert.equal(j.again, true, 'and it says it is a second telling');
  }

  // a stranger holding the session id, and nothing else, is turned away
  const stranger = await worker.fetch(door('cs_test_lost', THEIRS), env);
  assert.equal(stranger.status, 409, 'the session id is not a credential');
  assert.ok(!(await stranger.json()).key);

  // exactly one membership was ever minted
  const minted = [...env.BOX._m.keys()].filter(k => k.startsWith('member:'));
  assert.deepEqual(minted, [`member:${key}`]);
});

test('the claim window closes, and the door stays shut after it', async (t) => {
  const env = paidDoor(t, 'sub_window');
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });

  const key = (await (await worker.fetch(door('cs_test_window', MINE), env)).json()).key;
  assert.ok(isKey(key));

  // an hour later, still the same key
  Date.now = () => realNow() + 3600 * 1000;
  const soon = await worker.fetch(door('cs_test_window', MINE), env);
  assert.equal(soon.status, 200);
  assert.equal((await soon.json()).key, key);

  // a day and an hour later, nothing. the key is the way in from here on
  Date.now = () => realNow() + 25 * 3600 * 1000;
  const late = await worker.fetch(door('cs_test_window', MINE), env);
  assert.equal(late.status, 409, 'the window is a day, not forever');
  assert.ok(!(await late.json()).key);
});

test('the claim the client sends is the shape the door accepts', async () => {
  const secret = '0123456789abcdef0123456789abcdef';
  const h = await claimHash(secret, 'cs_test_abc');
  assert.ok(isClaimHash(h), h);
  assert.notEqual(h, await claimHash(secret, 'cs_test_xyz'), 'a second checkout files a second claim');
  assert.notEqual(h, await claimHash('f'.repeat(32), 'cs_test_abc'), 'and another secret, another claim');
});

// build a signed stripe webhook request for the worker
async function stripeEvent(env, ev) {
  const body = JSON.stringify(ev);
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return req('/stripe', { method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=${hex}` } });
}

test('renewals arrive in both stripe dialects', async () => {
  const env = { BOX: kv(), STRIPE_WEBHOOK_SECRET: 'whsec_test' };
  const key = mintKey(crypto.getRandomValues(new Uint8Array(16)));
  await env.BOX.put(`member:${key}`, JSON.stringify({ sub: 'sub_d', until: 1000, standing: 'good' }));
  await env.BOX.put('sub:sub_d', key);

  // the old dialect: invoice.subscription at the top
  await worker.fetch(await stripeEvent(env, { type: 'invoice.paid', data: { object: {
    subscription: 'sub_d', lines: { data: [{ period: { end: 2_000_000_000 } }] } } } }), env);
  let m = await env.BOX.get(`member:${key}`, 'json');
  assert.equal(m.until, 2_000_000_000, 'legacy shape renews');

  // the basil dialect: the subscription moved under parent
  await worker.fetch(await stripeEvent(env, { type: 'invoice.paid', data: { object: {
    parent: { subscription_details: { subscription: 'sub_d' } },
    lines: { data: [{ period: { end: 2_100_000_000 } }] } } } }), env);
  m = await env.BOX.get(`member:${key}`, 'json');
  assert.equal(m.until, 2_100_000_000, 'basil shape renews');

  // subscription.updated with period end on the items, basil style
  await worker.fetch(await stripeEvent(env, { type: 'customer.subscription.updated', data: { object: {
    id: 'sub_d', status: 'active', items: { data: [{ current_period_end: 2_200_000_000 }] } } } }), env);
  m = await env.BOX.get(`member:${key}`, 'json');
  assert.equal(m.until, 2_200_000_000, 'item-level period end lands');

  // deletion ends the standing
  await worker.fetch(await stripeEvent(env, { type: 'customer.subscription.deleted', data: { object: { id: 'sub_d' } } }), env);
  m = await env.BOX.get(`member:${key}`, 'json');
  assert.equal(m.standing, 'left');
});

test('the door reads a period end that lives on the items', async (t) => {
  const env = { BOX: kv(), STRIPE_SECRET: 'sk_test' };
  const paid = { payment_status: 'paid', mode: 'subscription',
    subscription: { id: 'sub_b', items: { data: [{ current_period_end: 2_345_678_901 }] } } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(paid), { status: 200 });
  t.after(() => { globalThis.fetch = realFetch; });
  const r = await worker.fetch(door('cs_test_items', MINE), env);
  assert.equal((await r.json()).until, 2_345_678_901);
});

async function memberEnv(until) {
  const env = { BOX: kv() };
  const key = mintKey(crypto.getRandomValues(new Uint8Array(16)));
  await env.BOX.put(`member:${key}`, JSON.stringify({ sub: 'sub_9', until, standing: 'good' }));
  return { env, key, auth: { authorization: `Bearer ${key}` } };
}

test('the vault keeps the envelope, and the one before it', async () => {
  const now = Math.floor(Date.now() / 1000);
  const { env, auth } = await memberEnv(now + 3600);

  const first = new Uint8Array(64).fill(1);
  const r1 = await worker.fetch(seal(first, { ...auth, 'if-none-match': '*' }), env);
  assert.equal(r1.status, 200);

  const second = new Uint8Array(64).fill(2);
  await worker.fetch(seal(second, { ...auth, 'if-match': r1.headers.get('etag') }), env);

  const now1 = await worker.fetch(req('/vault', { headers: auth }), env);
  assert.deepEqual(new Uint8Array(await now1.arrayBuffer()), second);
  const before = await worker.fetch(req('/vault?prev=1', { headers: auth }), env);
  assert.deepEqual(new Uint8Array(await before.arrayBuffer()), first, 'the envelope before is kept');
  assert.equal(before.headers.get('etag'), null, 'the slot before is read, never written, and carries no revision');

  const gone = await worker.fetch(req('/vault', { method: 'DELETE', headers: auth }), env);
  assert.equal((await gone.json()).gone, true);
  assert.equal((await worker.fetch(req('/vault', { headers: auth }), env)).status, 404);
});

test('a lapsed member reads and deletes, but does not write', async () => {
  const now = Math.floor(Date.now() / 1000);
  const { env, key, auth } = await memberEnv(now + 3600);
  const kept = await worker.fetch(seal(new Uint8Array(64), { ...auth, 'if-none-match': '*' }), env);
  assert.equal(kept.status, 200);

  await env.BOX.put(`member:${key}`, JSON.stringify({ sub: 'sub_9', until: now - GRACE_S - 10, standing: 'good' }));
  const w = await worker.fetch(seal(new Uint8Array(64), { ...auth, 'if-match': kept.headers.get('etag') }), env);
  assert.equal(w.status, 402, 'no new envelopes');
  const r = await worker.fetch(req('/vault', { headers: auth }), env);
  assert.equal(r.status, 200, 'but the envelope is still theirs');
  const m = await (await worker.fetch(req('/membership', { headers: auth }), env)).json();
  assert.equal(m.standing, 'lapsed');
});

test('the vault is bounded and strangers stay outside', async () => {
  const now = Math.floor(Date.now() / 1000);
  const { env, auth } = await memberEnv(now + 3600);

  const tiny = await worker.fetch(seal(new Uint8Array(4), { ...auth, 'if-none-match': '*' }), env);
  assert.equal(tiny.status, 400, 'too small to be sealed');
  assert.ok(LIMITS.vaultBytes <= 20_000_000, 'stays under the KV ceiling');

  const anon = await worker.fetch(req('/vault'), env);
  assert.equal(anon.status, 401);
  const wrong = await worker.fetch(req('/vault', { headers: { authorization: 'Bearer tc_00000000000000000000' } }), env);
  assert.equal(wrong.status, 401);
});

test('two devices cannot write over one another', async () => {
  const now = Math.floor(Date.now() / 1000);
  const { env, auth } = await memberEnv(now + 3600);

  // nothing sealed yet, and the first seal is the one that says so
  const created = await worker.fetch(seal(new Uint8Array(64).fill(1), { ...auth, 'if-none-match': '*' }), env);
  assert.equal(created.status, 200);
  const revA = created.headers.get('etag');
  assert.match(revA, /^"[0-9a-f]{32}"$/, 'an opaque revision, and nothing of the envelope in it');

  const twice = await worker.fetch(seal(new Uint8Array(64).fill(9), { ...auth, 'if-none-match': '*' }), env);
  assert.equal(twice.status, 412, 'the vault is no longer empty, and the creating seal is refused');

  // two devices read the same envelope and hold the same revision
  const read = await worker.fetch(req('/vault', { headers: auth }), env);
  assert.equal(read.headers.get('etag'), revA);

  // one of them seals
  const won = await worker.fetch(seal(new Uint8Array(64).fill(2), { ...auth, 'if-match': revA }), env);
  assert.equal(won.status, 200);
  const revB = won.headers.get('etag');
  assert.notEqual(revB, revA, 'every seal moves the revision');

  // the other, still holding the old revision, is refused rather than obeyed
  const lost = await worker.fetch(seal(new Uint8Array(64).fill(3), { ...auth, 'if-match': revA }), env);
  assert.equal(lost.status, 412);
  assert.equal(lost.headers.get('etag'), revB, 'and is told which envelope to read');

  const held = new Uint8Array(await (await worker.fetch(req('/vault', { headers: auth }), env)).arrayBuffer());
  assert.deepEqual(held, new Uint8Array(64).fill(2), 'the winner is still there');

  // having read again, it may seal
  const retried = await worker.fetch(seal(new Uint8Array(64).fill(3), { ...auth, 'if-match': revB }), env);
  assert.equal(retried.status, 200);
});

test('a seal that names no envelope, or names them all, is refused', async () => {
  const now = Math.floor(Date.now() / 1000);
  const { env, auth } = await memberEnv(now + 3600);
  const created = await worker.fetch(seal(new Uint8Array(64).fill(1), { ...auth, 'if-none-match': '*' }), env);
  const rev = created.headers.get('etag');

  const silent = await worker.fetch(seal(new Uint8Array(64).fill(2), auth), env);
  assert.equal(silent.status, 428, 'the old unconditional write is now a refusal, not a clobber');

  const star = await worker.fetch(seal(new Uint8Array(64).fill(2), { ...auth, 'if-match': '*' }), env);
  assert.equal(star.status, 412, 'a star is a licence to overwrite, which is the thing being refused');

  const weak = await worker.fetch(seal(new Uint8Array(64).fill(2), { ...auth, 'if-match': `W/${rev}` }), env);
  assert.equal(weak.status, 412, 'and a weak comparison is no comparison');

  const held = new Uint8Array(await (await worker.fetch(req('/vault', { headers: auth }), env)).arrayBuffer());
  assert.deepEqual(held, new Uint8Array(64).fill(1), 'none of them touched the envelope');
});

test('the client seals over what it read, and refuses to clobber what it did not', async (t) => {
  const now = Math.floor(Date.now() / 1000);
  const { env, key, auth } = await memberEnv(now + 3600);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, init) => worker.fetch(new Request(u, init), env);
  t.after(() => { globalThis.fetch = realFetch; });

  const c = makeClient('https://club.example', () => key);
  assert.equal(await c.getVault(), null, 'an empty vault, and the client knows it');
  const first = await c.putVault(new Uint8Array(64).fill(1));
  assert.match(first.rev, /^"[0-9a-f]{32}"$/);

  // another device seals in between
  await worker.fetch(seal(new Uint8Array(64).fill(2), { ...auth, 'if-match': first.rev }), env);

  await assert.rejects(() => c.putVault(new Uint8Array(64).fill(3)), /stale/,
    'the client does not write over an envelope it has not read');

  const got = await c.getVault();
  assert.deepEqual(got.bytes, new Uint8Array(64).fill(2), 'so it reads again');
  const after = await c.putVault(new Uint8Array(64).fill(3));
  assert.notEqual(after.rev, got.rev, 'and then it may seal');

  await c.delVault();
  const fresh = await c.putVault(new Uint8Array(64).fill(4));
  assert.ok(fresh.rev, 'a burned vault is created into, not replaced');
});
