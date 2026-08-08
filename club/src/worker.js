// worker.js — the travellers club.
//
// The club keeps two things and knows almost nothing:
//
//   a membership: a key, and "paid until when"
//   a vault: one sealed envelope per member, and the one before it
//
// The envelope is sealed on the member's device before it ever travels.
// The club cannot open it. All it holds about a member: the key, the
// subscription id, a paid-until date, and when the envelope was last
// sealed. No names, no addresses, no request logs. If this worker
// disappears, every atlas keeps living in its browser; only the backup
// goes quiet.
//
//   POST /door         a Stripe checkout session id becomes a key. shown once.
//   POST /stripe       Stripe's webhook: renewals arrive, lapses arrive.
//   GET  /membership   the key's standing: good | lapsed, and until when.
//   PUT  /vault        the sealed envelope. the previous one is kept.
//   GET  /vault        the envelope back. ?prev=1 for the one before.
//   DELETE /vault      both envelopes gone, now.
//
// KV: member:<key>, sub:<subscriptionId>, vault:<key>, vault:<key>:prev,
//     vaultmeta:<key>. Secrets: STRIPE_SECRET, STRIPE_WEBHOOK_SECRET.

import { LIMITS, mintKey, isKey, isSessionId, standingOf } from './validate.js';
import { fetchSession, verifyWebhook } from './stripe.js';

const ORIGINS = new Set([
  'https://resonate.select',
  'http://localhost:5178',
]);

function cors(req) {
  const o = req.headers.get('origin') || '';
  const h = {
    'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-expose-headers': 'x-sealed-at',
    'access-control-max-age': '86400',
  };
  if (ORIGINS.has(o)) h['access-control-allow-origin'] = o;
  return h;
}

const json = (obj, status, extra) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', ...extra },
});

async function memberOf(req, env) {
  const auth = req.headers.get('authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!isKey(key)) return { key: null, member: null };
  const member = await env.BOX.get(`member:${key}`, 'json');
  return { key, member };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const h = cors(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const nowS = Math.floor(Date.now() / 1000);

    // ---- the door: a paid checkout session becomes a key, exactly once ----
    if (url.pathname === '/door' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'a session id, as json' }, 400, h); }
      if (!isSessionId(body?.session)) return json({ error: 'that is not a checkout session' }, 400, h);

      const s = await fetchSession(body.session, env.STRIPE_SECRET);
      if (!s || s.payment_status !== 'paid' || s.mode !== 'subscription') {
        return json({ error: 'the door only opens on a paid subscription' }, 403, h);
      }
      const sub = typeof s.subscription === 'string' ? { id: s.subscription } : s.subscription;
      if (!sub?.id) return json({ error: 'no subscription on that session' }, 403, h);
      const periodEnd = Number(sub.current_period_end)
        || (sub.items?.data ?? []).map(i => Number(i.current_period_end) || 0).reduce((a, b) => Math.max(a, b), 0);

      // A checkout session is a one-time claim, not a spare key. Handing the
      // membership back to whoever replays the session would make the Stripe
      // receipt a second credential for the vault, forever. The member holds
      // the key; that is the only way back in.
      const claimed = await env.BOX.get(`sub:${sub.id}`);
      if (claimed) {
        return json({ error: 'this door has already been opened. the key you were given is the way in' }, 409, h);
      }

      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const key = mintKey(bytes);
      const until = periodEnd
        || nowS + 32 * 24 * 3600; // a month and a breath, until the webhook speaks
      await env.BOX.put(`member:${key}`, JSON.stringify({ sub: sub.id, until, standing: 'good' }));
      await env.BOX.put(`sub:${sub.id}`, key);
      return json({ key, until }, 200, h);
    }

    // ---- stripe speaks: renewals and lapses ----
    if (url.pathname === '/stripe' && req.method === 'POST') {
      const raw = await req.text();
      const ok = await verifyWebhook(raw, req.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET, nowS);
      if (!ok) return json({ error: 'not stripe' }, 400, h);
      let ev;
      try { ev = JSON.parse(raw); } catch { return json({ error: 'unreadable' }, 400, h); }

      const touch = async (subId, patch) => {
        if (!subId) return;
        const key = await env.BOX.get(`sub:${subId}`);
        if (!key) return; // a subscription the door never opened for
        const m = await env.BOX.get(`member:${key}`, 'json');
        if (!m) return;
        await env.BOX.put(`member:${key}`, JSON.stringify({ ...m, ...patch }));
      };

      const obj = ev.data?.object ?? {};
      if (ev.type === 'invoice.paid') {
        // the subscription moved house in 2025-03-31.basil; both addresses answer
        const subId = obj.parent?.subscription_details?.subscription
          ?? (typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id);
        const until = obj.lines?.data?.map(l => Number(l.period?.end) || 0).reduce((a, b) => Math.max(a, b), 0);
        await touch(subId, until ? { until, standing: 'good' } : { standing: 'good' });
      } else if (ev.type === 'customer.subscription.updated') {
        // current_period_end moved onto the items in basil; read both
        const end = Number(obj.current_period_end)
          || (obj.items?.data ?? []).map(i => Number(i.current_period_end) || 0).reduce((a, b) => Math.max(a, b), 0);
        const patch = {};
        if (end) patch.until = end;
        if (obj.status === 'canceled' || obj.cancel_at_period_end === true) patch.leaving = true;
        await touch(obj.id, patch);
      } else if (ev.type === 'customer.subscription.deleted') {
        await touch(obj.id, { standing: 'left' });
      }
      return json({ received: true }, 200, h);
    }

    // ---- everything below is a member speaking ----
    const { key, member } = await memberOf(req, env);
    if (!key) return json({ error: 'no key' }, 401, h);
    const standing = standingOf(member, nowS);
    if (standing === 'none') return json({ error: 'unknown key' }, 401, h);

    if (url.pathname === '/membership' && req.method === 'GET') {
      return json({ standing, until: member.until ?? null, leaving: member.leaving === true }, 200, h);
    }

    // a lapsed member may still read and delete: the envelope is theirs.
    // only writing new ones asks for good standing.
    if (url.pathname === '/vault') {
      if (req.method === 'PUT') {
        if (standing !== 'good') return json({ error: 'the membership has lapsed' }, 402, h);
        const buf = await req.arrayBuffer();
        if (buf.byteLength < 24) return json({ error: 'that is not a sealed envelope' }, 400, h);
        if (buf.byteLength > LIMITS.vaultBytes) {
          return json({ error: `the vault holds ${LIMITS.vaultBytes} bytes at most` }, 413, h);
        }
        const prev = await env.BOX.get(`vault:${key}`, 'arrayBuffer');
        if (prev) await env.BOX.put(`vault:${key}:prev`, prev);
        await env.BOX.put(`vault:${key}`, buf);
        const meta = { bytes: buf.byteLength, at: new Date().toISOString() };
        await env.BOX.put(`vaultmeta:${key}`, JSON.stringify(meta));
        return json(meta, 200, h);
      }
      if (req.method === 'GET') {
        const which = url.searchParams.get('prev') ? `vault:${key}:prev` : `vault:${key}`;
        const buf = await env.BOX.get(which, 'arrayBuffer');
        if (!buf) return json({ error: 'the vault is empty' }, 404, h);
        const meta = await env.BOX.get(`vaultmeta:${key}`, 'json');
        return new Response(buf, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream', 'x-sealed-at': meta?.at ?? '', ...h },
        });
      }
      if (req.method === 'DELETE') {
        await env.BOX.delete(`vault:${key}`);
        await env.BOX.delete(`vault:${key}:prev`);
        await env.BOX.delete(`vaultmeta:${key}`);
        return json({ gone: true }, 200, h);
      }
    }

    return json({ error: 'nothing lives here' }, 404, h);
  },
};
