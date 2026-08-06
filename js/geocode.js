// geocode.js — Nominatim (OpenStreetMap) search + reverse geocoding

const BASE = 'https://nominatim.openstreetmap.org';

// The Nominatim usage policy asks for at most one request a second, and for
// results to be cached rather than asked for twice. Both are kept here, so no
// caller can breach the policy by accident.
const MIN_GAP_MS = 1100;
const CACHE_MAX = 200;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const memo = new Map();
let lastCall = 0;
let queue = Promise.resolve();

function cached(key) {
  const hit = memo.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { memo.delete(key); return null; }
  // keep it warm: most recently used last
  memo.delete(key); memo.set(key, hit);
  return hit.value;
}

function remember(key, value) {
  memo.set(key, { at: Date.now(), value });
  while (memo.size > CACHE_MAX) memo.delete(memo.keys().next().value);
}

// one request at a time, never closer together than the policy allows
function paced(fn) {
  const run = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

function pickCity(addr = {}) {
  return addr.city || addr.town || addr.village || addr.municipality || addr.hamlet || addr.suburb || '';
}

function shortName(r) {
  if (r.name) return r.name;
  return (r.display_name || '').split(',')[0].trim();
}

function subLine(r) {
  const name = shortName(r);
  const parts = (r.display_name || '').split(',').map(s => s.trim()).filter(s => s && s !== name);
  const head = parts.slice(0, 2);
  // always end with the country so same-named places are tellable apart
  const country = (r.address && r.address.country) || parts[parts.length - 1];
  if (country && !head.includes(country)) head.push(country);
  return head.join(', ');
}

function toResult(r) {
  const addr = r.address || {};
  return {
    name: shortName(r),
    sub: subLine(r),
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    address: subLine(r),
    city: pickCity(addr),
    country: addr.country || '',
    countryCode: (addr.country_code || '').toLowerCase(),
    kind: r.type || '',
  };
}

export async function searchGeo(query, { signal, limit = 6 } = {}) {
  const q = String(query || '').trim();
  const key = `s:${limit}:${q.toLowerCase()}`;
  const hit = cached(key);
  if (hit) return hit;
  const url = `${BASE}/search?format=jsonv2&addressdetails=1&limit=${limit}&q=${encodeURIComponent(q)}`;
  const rows = await paced(async () => {
    const res = await fetch(url, { signal, headers: { 'Accept-Language': navigator.language || 'en' } });
    if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
    return res.json();
  });
  const out = rows.map(toResult).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  remember(key, out);
  return out;
}

export async function reverseGeo(lat, lng, { signal } = {}) {
  // a fix is only worth asking about to about a metre
  const key = `r:${(+lat).toFixed(5)},${(+lng).toFixed(5)}`;
  const hit = cached(key);
  if (hit !== null && hit !== undefined) return hit;
  const url = `${BASE}/reverse?format=jsonv2&addressdetails=1&zoom=17&lat=${lat}&lon=${lng}`;
  const r = await paced(async () => {
    const res = await fetch(url, { signal, headers: { 'Accept-Language': navigator.language || 'en' } });
    if (!res.ok) throw new Error(`Reverse geocoding failed (${res.status})`);
    return res.json();
  });
  const out = r.error ? null : toResult(r);
  remember(key, out);
  return out;
}

export function fmtCoord(lat, lng) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns} · ${Math.abs(lng).toFixed(4)}° ${ew}`;
}

// degrees-and-minutes, the way charts label a graticule (never GPS decimals)
export function fmtDM(value, isLat) {
  const hemi = isLat ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
  let v = Math.abs(value);
  let d = Math.floor(v);
  let m = Math.round((v - d) * 60);
  if (m === 60) { d += 1; m = 0; }
  return m ? `${d}°${String(m).padStart(2, '0')}′${hemi}` : `${d}°${hemi}`;
}

export function fmtDMS(lat, lng) {
  return `${fmtDM(lat, true)} · ${fmtDM(lng, false)}`;
}

export function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function fmtDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}
