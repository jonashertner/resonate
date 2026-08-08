// mock.mjs — the club, pretended, for local work.
//
// The same doors and the same answers as the worker, held in memory, with
// Stripe replaced by a handshake: any session id beginning cs_mock is paid.
// Run it, point settings.clubUrl at it, and the whole membership can be
// walked without an account anywhere.
//
//   node club/mock.mjs        (port 5179)

import http from 'node:http';
import { mintKey, isKey, isClaimHash, standingOf, LIMITS, GRACE_S } from './src/validate.js';

const members = new Map(); // key -> { sub, until, standing }
const subs = new Map();    // subId -> key
const claims = new Map();  // claim hash -> { key, sub, until, exp }
const vaults = new Map();  // key -> { now: Buffer, prev: Buffer|null, at: string, rev: string }

const CLAIM_TTL_S = 24 * 3600;

const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const newRev = () => hex(crypto.getRandomValues(new Uint8Array(16)));

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,if-match,if-none-match',
  'access-control-expose-headers': 'x-sealed-at,etag',
};

const send = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS, ...headers });
  res.end(JSON.stringify(obj));
};

const read = req => new Promise(resolve => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const nowS = Math.floor(Date.now() / 1000);

  if (url.pathname === '/door' && req.method === 'POST') {
    let body; try { body = JSON.parse((await read(req)).toString()); } catch { return send(res, 400, { error: 'json' }); }
    const session = String(body?.session || '');
    if (!session.startsWith('cs_mock')) return send(res, 403, { error: 'the mock door opens on cs_mock… only' });
    const claim = String(body?.claim || '');
    if (!isClaimHash(claim)) return send(res, 400, { error: 'that is not a claim' });
    // the mock has no Stripe, so a session stands for its own subscription
    const sub = `sub_${session}`;
    // the same secret gets the same key back; the session id alone gets 409
    const held = claims.get(claim);
    if (held && held.sub === sub && nowS <= held.exp) {
      return send(res, 200, { key: held.key, until: held.until, again: true });
    }
    if (subs.has(sub)) {
      return send(res, 409, { error: 'this door has already been opened. the key you were given is the way in' });
    }
    const key = mintKey(crypto.getRandomValues(new Uint8Array(16)));
    const until = nowS + 30 * 24 * 3600;
    members.set(key, { sub, until, standing: 'good' });
    claims.set(claim, { key, sub, until, exp: nowS + CLAIM_TTL_S });
    subs.set(sub, key);
    return send(res, 200, { key, until });
  }

  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!isKey(key) || !members.has(key)) return send(res, 401, { error: 'no key' });
  const member = members.get(key);
  const standing = standingOf(member, nowS);

  if (url.pathname === '/membership' && req.method === 'GET') {
    return send(res, 200, { standing, until: member.until, leaving: false });
  }
  if (url.pathname === '/lapse' && req.method === 'POST') {
    // a lever the real club does not have: for trying the lapsed state
    member.until = nowS - GRACE_S - 10;
    return send(res, 200, { lapsed: true });
  }
  if (url.pathname === '/vault') {
    if (req.method === 'PUT') {
      if (standing !== 'good') return send(res, 402, { error: 'the membership has lapsed' });
      // the body is drained first so keep-alive stays honest, then the
      // preconditions decide, in the same order the worker decides them
      const buf = await read(req);
      const v = vaults.get(key);
      const rev = v?.rev || '';
      const tag = rev ? { etag: `"${rev}"` } : {};
      const ifMatch = req.headers['if-match'];
      const ifNone = req.headers['if-none-match'];
      if (ifMatch !== undefined) {
        if (!rev || ifMatch.trim() !== `"${rev}"`) {
          return send(res, 412, { error: 'the vault has moved on. read it again and seal over what it now holds' }, tag);
        }
      } else if (ifNone !== undefined) {
        if (ifNone.trim() !== '*') return send(res, 400, { error: 'if-none-match takes a star and nothing else' });
        if (rev) return send(res, 412, { error: 'the vault already holds an envelope' }, tag);
      } else {
        return send(res, 428, { error: 'a seal must say what it replaces: if-match, or if-none-match: *' }, tag);
      }
      if (buf.length < 24) return send(res, 400, { error: 'not sealed' });
      if (buf.length > LIMITS.vaultBytes) return send(res, 413, { error: 'too large' });
      const meta = { bytes: buf.length, at: new Date().toISOString(), rev: newRev() };
      vaults.set(key, { now: buf, prev: v?.now ?? null, at: meta.at, rev: meta.rev });
      return send(res, 200, meta, { etag: `"${meta.rev}"` });
    }
    if (req.method === 'GET') {
      const v = vaults.get(key);
      const wantPrev = !!url.searchParams.get('prev');
      const buf = wantPrev ? v?.prev : v?.now;
      if (!buf) return send(res, 404, { error: 'empty' });
      const headers = {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'x-sealed-at': v.at,
        ...CORS,
      };
      if (!wantPrev) headers.etag = `"${v.rev}"`;
      res.writeHead(200, headers);
      return res.end(buf);
    }
    if (req.method === 'DELETE') {
      vaults.delete(key);
      return send(res, 200, { gone: true });
    }
  }
  return send(res, 404, { error: 'nothing lives here' });
}).listen(5179, () => console.log('the pretended club stands at http://localhost:5179'));
