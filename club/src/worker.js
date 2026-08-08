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
//   POST /door         a Stripe checkout session id becomes a key. once, and
//                      recoverable by the claim that opened it.
//   POST /stripe       Stripe's webhook: renewals arrive, lapses arrive.
//   GET  /membership   the key's standing: good | lapsed, and until when.
//   PUT  /vault        the sealed envelope, if-match the revision held.
//   GET  /vault        the envelope back, with its revision as an etag.
//                      ?prev=1 for the one before.
//   DELETE /vault      both envelopes gone, now.
//
// KV: member:<key>, sub:<subscriptionId>, claim:<hash>, vault:<key>,
//     vault:<key>:prev, vaultmeta:<key>.
// Secrets: STRIPE_SECRET, STRIPE_WEBHOOK_SECRET.

import { LIMITS, mintKey, isKey, isSessionId, isClaimHash, standingOf } from './validate.js';
import { fetchSession, verifyWebhook } from './stripe.js';

// how long a claim can be presented again. long enough for a flat battery, a
// tunnel, and a night's sleep; short enough that the record is not a second
// credential lying about.
const CLAIM_TTL_S = 24 * 3600;

const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

// the vault's revision: sixteen fresh random bytes at every seal, derived
// from nothing. an etag that were a digest of the envelope would answer the
// question "is this still the envelope I hold a copy of" to anyone who asks;
// randomness answers nothing at all.
function newRev() {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}
const etagOf = rev => `"${rev}"`;

const ORIGINS = new Set([
  'https://resonate.select',
  'http://localhost:5178',
]);

function cors(req) {
  const o = req.headers.get('origin') || '';
  const h = {
    'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS',
    // the preconditions travel on if-match and if-none-match, and the
    // revision comes back on the etag: a browser sees neither unless it is
    // named here, and a vault whose etag is invisible cannot be written to
    'access-control-allow-headers': 'authorization,content-type,if-match,if-none-match',
    'access-control-expose-headers': 'x-sealed-at,etag',
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
      // the claim, before Stripe is troubled: a malformed one costs an api call
      if (!isClaimHash(body?.claim)) return json({ error: 'that is not a claim' }, 400, h);

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
      //
      // But the client that paid must be able to ask twice. The answer to the
      // first ask travels over a mobile network and sometimes does not arrive,
      // and marking the subscription claimed with nobody holding the key was a
      // paid membership lost for good. So the minted key is also filed under
      // the claim, which is the hash of a secret only that client holds, and
      // presenting the secret again gets the same key as often as it is asked
      // until the window closes. A stranger with the session id has no secret,
      // computes no claim, and still meets 409.
      const held = await env.BOX.get(`claim:${body.claim}`, 'json');
      if (held && held.sub === sub.id && nowS <= (Number(held.exp) || 0)) {
        return json({ key: held.key, until: held.until, again: true }, 200, h);
      }
      const claimed = await env.BOX.get(`sub:${sub.id}`);
      if (claimed) {
        return json({ error: 'this door has already been opened. the key you were given is the way in' }, 409, h);
      }

      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const key = mintKey(bytes);
      const until = periodEnd
        || nowS + 32 * 24 * 3600; // a month and a breath, until the webhook speaks
      // the order of these three writes is the whole recovery. the membership
      // exists before anything points at it; the claim that can recover it is
      // filed before the subscription is marked claimed. a worker that dies
      // between any two of them leaves a door that opens again.
      await env.BOX.put(`member:${key}`, JSON.stringify({ sub: sub.id, until, standing: 'good' }));
      await env.BOX.put(
        `claim:${body.claim}`,
        JSON.stringify({ key, sub: sub.id, until, exp: nowS + CLAIM_TTL_S }),
        { expirationTtl: CLAIM_TTL_S },
      );
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

        // Compare and swap, before the body is even read. Two devices used to
        // be able to read the same envelope and then write over one another,
        // and the loser's records left no trace anywhere. A seal now says
        // which envelope it believes it is replacing, and a seal that believes
        // wrong is refused rather than obeyed.
        //
        // The star form of if-match is deliberately not honoured: `If-Match: *`
        // means "whatever is there", which is a licence to clobber, which is
        // the thing this guard exists to refuse. Only a revision matches.
        const meta0 = await env.BOX.get(`vaultmeta:${key}`, 'json');
        const rev = meta0?.rev || '';
        const tag = rev ? { etag: etagOf(rev) } : {};
        const ifMatch = req.headers.get('if-match');
        const ifNone = req.headers.get('if-none-match');
        if (ifMatch !== null) {
          if (!rev || ifMatch.trim() !== etagOf(rev)) {
            return json({ error: 'the vault has moved on. read it again and seal over what it now holds' }, 412, { ...h, ...tag });
          }
        } else if (ifNone !== null) {
          if (ifNone.trim() !== '*') return json({ error: 'if-none-match takes a star and nothing else' }, 400, h);
          if (rev) return json({ error: 'the vault already holds an envelope' }, 412, { ...h, ...tag });
        } else {
          return json({ error: 'a seal must say what it replaces: if-match, or if-none-match: *' }, 428, { ...h, ...tag });
        }

        const buf = await req.arrayBuffer();
        if (buf.byteLength < 24) return json({ error: 'that is not a sealed envelope' }, 400, h);
        if (buf.byteLength > LIMITS.vaultBytes) {
          return json({ error: `the vault holds ${LIMITS.vaultBytes} bytes at most` }, 413, h);
        }
        const prev = await env.BOX.get(`vault:${key}`, 'arrayBuffer');
        if (prev) await env.BOX.put(`vault:${key}:prev`, prev);
        await env.BOX.put(`vault:${key}`, buf);
        const meta = { bytes: buf.byteLength, at: new Date().toISOString(), rev: newRev() };
        await env.BOX.put(`vaultmeta:${key}`, JSON.stringify(meta));
        return json(meta, 200, { ...h, etag: etagOf(meta.rev) });
      }
      if (req.method === 'GET') {
        const wantPrev = !!url.searchParams.get('prev');
        const buf = await env.BOX.get(wantPrev ? `vault:${key}:prev` : `vault:${key}`, 'arrayBuffer');
        if (!buf) return json({ error: 'the vault is empty' }, 404, h);
        const meta = await env.BOX.get(`vaultmeta:${key}`, 'json');
        // an etag invites a cache to hold the answer, and an envelope read
        // from a cache is an envelope the writer would then seal over with a
        // revision that has moved. this response is for one reader, once.
        const headers = {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
          'x-sealed-at': meta?.at ?? '',
          ...h,
        };
        // the revision names the current envelope alone. the slot before is
        // not writable, and an etag there would name a thing no put accepts.
        if (!wantPrev && meta?.rev) headers.etag = etagOf(meta.rev);
        return new Response(buf, { status: 200, headers });
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
