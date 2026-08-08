// share.js — the whole map compressed into a URL hash; no backend

/* global LZString */

import { normPayload, SCHEMA_VERSION } from './schema.js?v=rf68';
import { encodePath, simplify } from './route.js?v=rf68';

function pack(payload) {
  return `${location.origin}${location.pathname}#m=${LZString.compressToEncodedURIComponent(JSON.stringify(payload))}`;
}

// a folio: a composed slice with a title and a dedication — the atomic recommendation
// a folio is the same disclosure under a title, so it goes through the same
// builder: a field that would leak from an atlas leaks from a folio too
export function makeFolioUrl({ title, dedication, author, tags, places, routes = [] }) {
  return pack({
    ...buildDisclosure({ places, routes, tags, author, forLink: true }),
    kind: 'folio',
    title: String(title || '').slice(0, 80),
    dedication: String(dedication || '').slice(0, 140),
    tags: tags.map(t => ({ id: t.id, name: t.name, hue: t.hue, color: t.color })),
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

// ---------- one disclosure ----------
//
// What the recipient gets must not depend on how it reached them.
//
// The link was an explicit field list. The file was a spread of whole records
// plus every tag in the atlas, and it sat under the same review panel and the
// same sentence. So "send it as a file" quietly added the creation and update
// dates of every place, the domains a person had never used or had used only
// on places that never leave, and any field a future release happened to add
// to a record. The preview described the link. The file was something else.
//
// buildDisclosure is now the only thing that decides what leaves. The link
// encodes it, the file writes it, and anything later (a code, a relay) encodes
// the same object. Transport may change the shape of the carrier. It may not
// change what the person on the other end receives.
//
// The one honest difference is geometry: a link has to fit in an address bar,
// so a way in a link is coarser. That difference is named on the surface
// rather than hidden, and `wayPoints` says which of the two this object is.
export function buildDisclosure({ places = [], routes = [], tags = [], author = '', forLink = false } = {}) {
  return {
    v: SCHEMA_VERSION,
    kind: 'atlas',
    author: String(author || '').slice(0, 60),
    // only the domains these records actually use: an unused domain, or one
    // used solely on a place that never leaves, has no business travelling
    tags: tags.map(t => ({ id: t.id, name: t.name, emoji: t.emoji, color: t.color })),
    // photographs stay on the device. they never travel, by link or by file.
    places: places.map(p => ({
      id: p.id, name: p.name, lat: p.lat, lng: p.lng,
      address: p.address, city: p.city, country: p.country, countryCode: p.countryCode,
      tags: p.tags, status: p.status, rating: p.rating, note: p.note, url: p.url,
      // where it has been: the names, oldest first, so a place keeps its road
      prov: p.provenance ? [...(p.provenance.chain || []), { name: p.provenance.name, at: p.provenance.adoptedAt }] : undefined,
    })),
    routes: routes.map(r => {
      const base = {
        id: r.id, name: r.name, city: r.city, country: r.country,
        tags: r.tags, status: r.status, rating: r.rating, note: r.note, url: r.url,
        km: r.km, ascent: r.ascent, descent: r.descent, high: r.high, low: r.low,
        hours: r.hours, loop: r.loop,
      };
      // a link has to fit in an address bar, so a way in a link is coarser.
      // a file has no such trouble and carries the shape plainly, which is
      // the same information in a form a person can read. the surface says
      // which is which rather than leaving the recipient to find out.
      return forLink
        ? { ...base, p: encodePath(simplify(r.path, 0.03).slice(0, 900)) }
        : { ...base, path: r.path };
    }),
  };
}

// what a person is about to hand over, counted, so the panel and the payload
// can never disagree: both read this, and it reads the disclosure
export function disclosureCounts(d) {
  const bylines = new Set([...d.places, ...d.routes]
    .flatMap(r => (r.prov || []).map(h => h.name)).filter(Boolean));
  return {
    places: d.places.length,
    routes: d.routes.length,
    tags: d.tags.length,
    notes: d.places.filter(p => p.note).length + d.routes.filter(r => r.note).length,
    links: d.places.filter(p => p.url).length + d.routes.filter(r => r.url).length,
    bylines: bylines.size,
    author: d.author,
  };
}

export function packDisclosure(d) {
  const packed = LZString.compressToEncodedURIComponent(JSON.stringify(d));
  return `${location.origin}${location.pathname}#m=${packed}`;
}

export function makeShareUrl(tags, places, author = '', routes = []) {
  return packDisclosure(buildDisclosure({ places, routes, tags, author, forLink: true }));
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
