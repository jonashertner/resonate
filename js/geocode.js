// geocode.js — Nominatim (OpenStreetMap) search + reverse geocoding

const BASE = 'https://nominatim.openstreetmap.org';

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
  const url = `${BASE}/search?format=jsonv2&addressdetails=1&limit=${limit}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal, headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const rows = await res.json();
  return rows.map(toResult).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

export async function reverseGeo(lat, lng, { signal } = {}) {
  const url = `${BASE}/reverse?format=jsonv2&addressdetails=1&zoom=17&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, { signal, headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error(`Reverse geocoding failed (${res.status})`);
  const r = await res.json();
  if (r.error) return null;
  return toResult(r);
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
