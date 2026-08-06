// share.js — the whole map compressed into a URL hash; no backend

/* global LZString */

import { normPayload, SCHEMA_VERSION } from './schema.js?v=rf22';

function pack(payload) {
  return `${location.origin}${location.pathname}#m=${LZString.compressToEncodedURIComponent(JSON.stringify(payload))}`;
}

// a folio: a composed slice with a title and a dedication — the atomic recommendation
export function makeFolioUrl({ title, dedication, author, tags, places }) {
  return pack({
    v: SCHEMA_VERSION,
    kind: 'folio',
    title: String(title || '').slice(0, 80),
    dedication: String(dedication || '').slice(0, 140),
    author: String(author || '').slice(0, 60),
    tags: tags.map(t => ({ id: t.id, name: t.name, hue: t.hue, color: t.color })),
    places: places.map(p => ({
      id: p.id, name: p.name, lat: p.lat, lng: p.lng,
      address: p.address, city: p.city, country: p.country, countryCode: p.countryCode,
      tags: p.tags, status: p.status, rating: p.rating, note: p.note, url: p.url,
    })),
  });
}

// an ask: a request-letter — the recipient's atlas pre-composes the reply
export function makeAskUrl({ from, q }) {
  return pack({
    v: SCHEMA_VERSION,
    kind: 'ask',
    from: String(from || '').slice(0, 60),
    q: String(q || '').slice(0, 80),
  });
}

export function makeShareUrl(tags, places, author = '') {
  const payload = {
    v: SCHEMA_VERSION,
    kind: 'atlas',
    author: String(author || '').slice(0, 60),
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
    // one gate: a payload is normalized and bounded, or it is not a payload
    return normPayload(JSON.parse(json));
  } catch {
    return null;
  }
}

export function clearShareHash() {
  history.replaceState(null, '', location.pathname + location.search);
}
