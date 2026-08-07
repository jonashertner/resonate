// mock.mjs — the club, pretended, for local work.
//
// The same doors and the same answers as the worker, held in memory, with
// Stripe replaced by a handshake: any session id beginning cs_mock is paid.
// Run it, point settings.clubUrl at it, and the whole membership can be
// walked without an account anywhere.
//
//   node club/mock.mjs        (port 5179)

import http from 'node:http';
import { mintKey, isKey, standingOf, LIMITS, GRACE_S } from './src/validate.js';

const members = new Map(); // key -> { sub, until, standing }
const subs = new Map();    // subId -> key
const vaults = new Map();  // key -> { now: Buffer, prev: Buffer|null, at: string }

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-expose-headers': 'x-sealed-at',
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
    if (subs.has(session)) {
      const key = subs.get(session);
      return send(res, 200, { key, until: members.get(key).until, again: true });
    }
    const key = mintKey(crypto.getRandomValues(new Uint8Array(16)));
    const until = nowS + 30 * 24 * 3600;
    members.set(key, { sub: session, until, standing: 'good' });
    subs.set(session, key);
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
      const buf = await read(req);
      if (buf.length < 24) return send(res, 400, { error: 'not sealed' });
      if (buf.length > LIMITS.vaultBytes) return send(res, 413, { error: 'too large' });
      const v = vaults.get(key);
      vaults.set(key, { now: buf, prev: v?.now ?? null, at: new Date().toISOString() });
      return send(res, 200, { bytes: buf.length, at: vaults.get(key).at });
    }
    if (req.method === 'GET') {
      const v = vaults.get(key);
      const buf = url.searchParams.get('prev') ? v?.prev : v?.now;
      if (!buf) return send(res, 404, { error: 'empty' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-sealed-at': v.at, ...CORS });
      return res.end(buf);
    }
    if (req.method === 'DELETE') {
      vaults.delete(key);
      return send(res, 200, { gone: true });
    }
  }
  return send(res, 404, { error: 'nothing lives here' });
}).listen(5179, () => console.log('the pretended club stands at http://localhost:5179'));
