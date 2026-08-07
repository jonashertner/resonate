// stripe.js — the smallest possible acquaintance with Stripe.
//
// No SDK. Two things only: ask about a checkout session, and verify that a
// webhook truly came from Stripe. Money is Stripe's business; the club only
// ever learns "paid until when".

import { sameString } from './validate.js';

const API = 'https://api.stripe.com/v1';

export async function fetchSession(id, secret, fetcher = fetch) {
  const r = await fetcher(`${API}/checkout/sessions/${encodeURIComponent(id)}?expand[]=subscription`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!r.ok) return null;
  return r.json();
}

// stripe signs: HMAC-SHA256(`${t}.${body}`) with the webhook secret,
// delivered as "t=...,v1=...". five minutes of tolerance.
export async function verifyWebhook(body, sigHeader, secret, nowS = Math.floor(Date.now() / 1000)) {
  const parts = Object.create(null);
  for (const kv of String(sigHeader || '').split(',')) {
    const [k, v] = kv.split('=');
    if (k === 't') parts.t = v;
    if (k === 'v1') (parts.v1 ??= []).push(v);
  }
  const t = parseInt(parts.t, 10);
  if (!Number.isFinite(t) || Math.abs(nowS - t) > 300 || !parts.v1?.length) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${body}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return parts.v1.some(v => sameString(v, hex));
}
