// capture.js — a place arrives from somewhere else.
//
// Someone sends you a map link, or you share one into the app from a phone.
// These are pure parsers: they read what the text already contains and never
// ask the network. What they cannot find, they leave for the app to ask about
// or for a person to type. Nothing here throws.

const NUM = '-?\\d{1,3}(?:\\.\\d+)?';

function pair(lat, lng) {
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  if (a === 0 && b === 0) return null; // the null island is nobody's place
  return { lat: a, lng: b };
}

const clean = s => String(s || '').replace(/\+/g, ' ').trim().slice(0, 140);

// google: /@lat,lng,17z · ?q=lat,lng · !3dLAT!4dLNG (the pin, not the viewport)
function google(u) {
  const href = u.href;
  const bang = href.match(new RegExp(`!3d(${NUM})!4d(${NUM})`));
  if (bang) return { at: pair(bang[1], bang[2]), name: nameFromGooglePath(u) };
  const q = u.searchParams.get('q') || u.searchParams.get('query') || '';
  const qc = q.match(new RegExp(`^(${NUM})[,\\s]+(${NUM})$`));
  if (qc) return { at: pair(qc[1], qc[2]), name: '' };
  const at = href.match(new RegExp(`@(${NUM}),(${NUM})`));
  if (at) return { at: pair(at[1], at[2]), name: nameFromGooglePath(u) };
  return { at: null, name: clean(q) || nameFromGooglePath(u) };
}

function nameFromGooglePath(u) {
  const m = u.pathname.match(/\/place\/([^/@]+)/);
  return m ? clean(decodeURIComponent(m[1]).replace(/\+/g, ' ')) : '';
}

// apple: ?ll=lat,lng · ?sll= · ?q=name · ?address=
function apple(u) {
  const ll = u.searchParams.get('ll') || u.searchParams.get('sll') || '';
  const m = ll.match(new RegExp(`^(${NUM}),(${NUM})$`));
  const q = u.searchParams.get('q') || u.searchParams.get('name') || '';
  const addr = u.searchParams.get('address') || '';
  return {
    at: m ? pair(m[1], m[2]) : null,
    name: clean(q),
    address: clean(addr),
  };
}

// openstreetmap: #map=z/lat/lng · ?mlat=&mlon= · /node/123
function osm(u) {
  const mlat = u.searchParams.get('mlat'), mlon = u.searchParams.get('mlon');
  if (mlat && mlon) return { at: pair(mlat, mlon), name: '' };
  const h = u.hash.match(new RegExp(`map=\\d+(?:\\.\\d+)?/(${NUM})/(${NUM})`));
  if (h) return { at: pair(h[1], h[2]), name: '' };
  return { at: null, name: '' };
}

// geo:lat,lng and the bare pair a person types
export function coordsIn(text) {
  const t = String(text || '').trim();
  const geo = t.match(new RegExp(`^geo:(${NUM}),(${NUM})`, 'i'));
  if (geo) return pair(geo[1], geo[2]);
  const bare = t.match(new RegExp(`^(${NUM})[,\\s]+(${NUM})$`));
  if (bare) return pair(bare[1], bare[2]);
  return null;
}

// { at, name, address, source } or null when nothing is legible.
// `at` may be null while `name` stands: the app then asks the world once.
export function readShared({ title = '', text = '', url = '' } = {}) {
  const blob = [url, text, title].filter(Boolean).join(' ');
  const found = blob.match(/https?:\/\/[^\s]+/);
  const link = found ? found[0] : '';

  const bare = coordsIn(text) || coordsIn(title) || coordsIn(url);
  if (bare) return { at: bare, name: clean(title), address: '', source: 'coordinates' };

  if (link) {
    let u;
    try { u = new URL(link); } catch { u = null; }
    if (u) {
      const host = u.hostname.replace(/^www\./, '');
      let r = null, source = 'a link';
      if (/(^|\.)google\./.test(host) || host === 'goo.gl' || host === 'maps.app.goo.gl') { r = google(u); source = 'google maps'; }
      else if (/(^|\.)apple\.com$/.test(host) || host === 'maps.apple.com') { r = apple(u); source = 'apple maps'; }
      else if (/(^|\.)openstreetmap\.org$/.test(host)) { r = osm(u); source = 'openstreetmap'; }
      if (r) {
        const name = r.name || clean(title);
        if (r.at || name) return { at: r.at, name, address: r.address || '', source, url: link };
      }
      // any other site: its name is the best thing about it
      const name = clean(title) || clean(text) || host;
      return { at: null, name, address: '', source: host, url: link };
    }
  }

  const name = clean(title) || clean(text);
  return name ? { at: null, name, address: '', source: 'a note', url: '' } : null;
}

// Would this be a second copy of something already held? The same rule the
// resonance engine uses for two atlases, applied to one.
const KM = 0.15;
function haversine(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const family = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function alreadyHeld(candidate, places) {
  if (!candidate) return null;
  const name = family(candidate.name);
  return places.find(p => {
    if (candidate.at && haversine(p, candidate.at) <= KM) {
      return !name || !family(p.name) || family(p.name) === name
        || family(p.name).includes(name) || name.includes(family(p.name));
    }
    return !candidate.at && name && family(p.name) === name;
  }) || null;
}
