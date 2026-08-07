// The invariants the club must hold: keys are honest, standing is bounded,
// the webhook only listens to Stripe, the door opens once per subscription,
// and the vault keeps exactly what it was given.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mintKey, isKey, standingOf, sameString, GRACE_S, LIMITS } from '../src/validate.js';
import { verifyWebhook } from '../src/stripe.js';
import worker from '../src/worker.js';

// ---- a KV that lives for one test ----
function kv() {
  const m = new Map();
  return {
    async get(k, type) {
      const v = m.get(k);
      if (v === undefined) return null;
      if (type === 'json') return JSON.parse(typeof v === 'string' ? v : new TextDecoder().decode(v));
      if (type === 'arrayBuffer') return typeof v === 'string' ? new TextEncoder().encode(v).buffer : v;
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    },
    async put(k, v) { m.set(k, v instanceof ArrayBuffer ? v : String(v)); },
    async delete(k) { m.delete(k); },
    _m: m,
  };
}

const req = (path, { method = 'GET', body, headers = {} } = {}) =>
  new Request(`https://club.example${path}`, { method, body, headers });

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

  const r1 = await worker.fetch(req('/door', { method: 'POST', body: JSON.stringify({ session: 'cs_test_abc' }) }), env);
  const j1 = await r1.json();
  assert.equal(r1.status, 200);
  assert.ok(isKey(j1.key));
  assert.equal(j1.until, 2_000_000_000);

  const r2 = await worker.fetch(req('/door', { method: 'POST', body: JSON.stringify({ session: 'cs_test_abc' }) }), env);
  const j2 = await r2.json();
  assert.equal(j2.key, j1.key, 'the same subscription gets the same key');
  assert.equal(j2.again, true);

  globalThis.fetch = async () => new Response(JSON.stringify({ payment_status: 'unpaid', mode: 'subscription' }), { status: 200 });
  const r3 = await worker.fetch(req('/door', { method: 'POST', body: JSON.stringify({ session: 'cs_test_xyz' }) }), env);
  assert.equal(r3.status, 403, 'unpaid stays outside');
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
  const r = await worker.fetch(req('/door', { method: 'POST', body: JSON.stringify({ session: 'cs_test_items' }) }), env);
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
  const r1 = await worker.fetch(req('/vault', { method: 'PUT', body: first, headers: auth }), env);
  assert.equal(r1.status, 200);

  const second = new Uint8Array(64).fill(2);
  await worker.fetch(req('/vault', { method: 'PUT', body: second, headers: auth }), env);

  const back = new Uint8Array(await (await worker.fetch(req('/vault', { headers: auth }), env)).arrayBuffer());
  assert.deepEqual(back, second);
  const prev = new Uint8Array(await (await worker.fetch(req('/vault?prev=1', { headers: auth }), env)).arrayBuffer());
  assert.deepEqual(prev, first, 'the envelope before is kept');

  const gone = await worker.fetch(req('/vault', { method: 'DELETE', headers: auth }), env);
  assert.equal((await gone.json()).gone, true);
  assert.equal((await worker.fetch(req('/vault', { headers: auth }), env)).status, 404);
});

test('a lapsed member reads and deletes, but does not write', async () => {
  const now = Math.floor(Date.now() / 1000);
  const { env, key, auth } = await memberEnv(now + 3600);
  await worker.fetch(req('/vault', { method: 'PUT', body: new Uint8Array(64), headers: auth }), env);

  await env.BOX.put(`member:${key}`, JSON.stringify({ sub: 'sub_9', until: now - GRACE_S - 10, standing: 'good' }));
  const w = await worker.fetch(req('/vault', { method: 'PUT', body: new Uint8Array(64), headers: auth }), env);
  assert.equal(w.status, 402, 'no new envelopes');
  const r = await worker.fetch(req('/vault', { headers: auth }), env);
  assert.equal(r.status, 200, 'but the envelope is still theirs');
  const m = await (await worker.fetch(req('/membership', { headers: auth }), env)).json();
  assert.equal(m.standing, 'lapsed');
});

test('the vault is bounded and strangers stay outside', async () => {
  const now = Math.floor(Date.now() / 1000);
  const { env, auth } = await memberEnv(now + 3600);

  const tiny = await worker.fetch(req('/vault', { method: 'PUT', body: new Uint8Array(4), headers: auth }), env);
  assert.equal(tiny.status, 400, 'too small to be sealed');
  assert.ok(LIMITS.vaultBytes <= 20_000_000, 'stays under the KV ceiling');

  const anon = await worker.fetch(req('/vault'), env);
  assert.equal(anon.status, 401);
  const wrong = await worker.fetch(req('/vault', { headers: { authorization: 'Bearer tc_00000000000000000000' } }), env);
  assert.equal(wrong.status, 401);
});
