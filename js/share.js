// share.js — the whole map compressed into a URL hash; no backend

/* global LZString */

export function makeShareUrl(tags, places) {
  const payload = {
    v: 1,
    tags: tags.map(t => ({ id: t.id, name: t.name, emoji: t.emoji, color: t.color })),
    // photos stay private on the device — they never travel in the link
    places: places.map(p => ({
      id: p.id, name: p.name, lat: p.lat, lng: p.lng,
      address: p.address, city: p.city, country: p.country, countryCode: p.countryCode,
      tags: p.tags, status: p.status, rating: p.rating, note: p.note, url: p.url,
      createdAt: p.createdAt, updatedAt: p.updatedAt,
    })),
  };
  const packed = LZString.compressToEncodedURIComponent(JSON.stringify(payload));
  return `${location.origin}${location.pathname}#m=${packed}`;
}

export function parseShareHash() {
  const h = location.hash;
  if (!h.startsWith('#m=')) return null;
  try {
    const json = LZString.decompressFromEncodedURIComponent(h.slice(3));
    if (!json) return null;
    const payload = JSON.parse(json);
    if (!payload || !Array.isArray(payload.places)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function clearShareHash() {
  history.replaceState(null, '', location.pathname + location.search);
}
