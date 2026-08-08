// route.js — a way through the field.
//
// A mark is a place. A route is the line between places: it has length, climb,
// a shape you can read, and an hour it asks of you. Everything here is
// geometry and measure. Nothing here touches the page.

import { haversineKm } from './geocode.js?v=rf80';

// ---------- reading what a walking app exports ----------

// GPX is what every hiking app hands you: komoot, gaia, strava, garmin, an
// alltrails download. A track is the line actually walked, a route is the
// line planned; we take whichever is there.
export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(String(text || ''), 'application/xml');
  if (doc.querySelector('parsererror')) return null;

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const readPt = (el) => {
    const lat = num(el.getAttribute('lat'));
    const lng = num(el.getAttribute('lon'));
    if (lat === null || lng === null) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    const eleEl = el.getElementsByTagName('ele')[0];
    const ele = eleEl ? num(eleEl.textContent) : null;
    return { lat, lng, ele: ele === null || Math.abs(ele) > 9000 ? null : ele };
  };

  let nodes = [...doc.getElementsByTagName('trkpt')];
  if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')];
  if (!nodes.length) nodes = [...doc.getElementsByTagName('wpt')];
  const points = nodes.map(readPt).filter(Boolean);
  if (points.length < 2) return null;

  // the name a walking app wrote, in the order it tends to put it
  const nameOf = (tag) => {
    const parent = doc.getElementsByTagName(tag)[0];
    const el = parent && parent.getElementsByTagName('name')[0];
    return el ? el.textContent.trim() : '';
  };
  const name = nameOf('trk') || nameOf('rte') || nameOf('metadata') || '';

  const timeEl = doc.getElementsByTagName('time')[0];
  const walkedAt = timeEl ? timeEl.textContent.trim() : '';

  return { name, points, walkedAt };
}

// ---------- shaping: a line you can carry ----------

// A recorded track is thousands of points, most of them saying nothing. This
// keeps the ones that carry the shape (Ramer, Douglas and Peucker), measuring
// in kilometres so the tolerance means something on the ground.
// Horizontal simplification is blind to height: run it alone and a col can
// vanish between two points that look collinear from above. So the points
// that carry the climb are kept as well as the points that carry the shape.
export function simplify(points, tolKm = 0.012, eleTolM = 12) {
  if (!Array.isArray(points) || points.length < 3) return points || [];
  const lat0 = points[0].lat;
  const kx = 111.32 * Math.cos(lat0 * Math.PI / 180);
  const ky = 110.57;
  const X = points.map(p => p.lng * kx);
  const Y = points.map(p => p.lat * ky);

  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = X[a], ay = Y[a], bx = X[b], by = Y[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1, farD = -1;
    for (let i = a + 1; i < b; i++) {
      const px = X[i] - ax, py = Y[i] - ay;
      let d;
      if (len2 === 0) {
        d = Math.hypot(px, py);
      } else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        d = Math.hypot(px - t * dx, py - t * dy);
      }
      if (d > farD) { farD = d; far = i; }
    }
    if (farD > tolKm && far > 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }

  // keep every point where the ground has risen or fallen enough to matter
  // since the last one we kept, so summits and cols survive the thinning
  const ele = elevations(points);
  if (ele) {
    let anchor = ele.raw[0];
    let lastTurn = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const h = ele.raw[i];
      if (Math.abs(h - anchor) >= eleTolM) { keep[i] = 1; anchor = h; }
      // and every local summit or hollow, whatever its size
      const prev = ele.smooth[i - 1], here = ele.smooth[i], next = ele.smooth[i + 1];
      if ((here > prev && here >= next) || (here < prev && here <= next)) {
        if (i - lastTurn > 2) { keep[i] = 1; lastTurn = i; }
      }
    }
  }
  return points.filter((_, i) => keep[i]);
}

// A barometer wanders. Without smoothing, standing still on a summit "climbs"
// forty metres. A short running mean, then a dead band, gives an honest figure.
function elevations(points) {
  const has = points.some(p => Number.isFinite(p.ele));
  if (!has) return null;
  const raw = points.map(p => (Number.isFinite(p.ele) ? p.ele : null));
  // carry the last known reading across gaps
  let last = raw.find(v => v !== null) ?? 0;
  const filled = raw.map(v => (v === null ? last : (last = v)));
  const W = 2;
  const smooth = filled.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = i - W; k <= i + W; k++) {
      if (k < 0 || k >= filled.length) continue;
      sum += filled[k]; n++;
    }
    return sum / n;
  });
  // climb is summed from the smoothed series; the summit is what the
  // instrument actually read, which is the altitude a walker will quote
  return { smooth, raw: filled };
}

function smoothed(points) {
  const e = elevations(points);
  return e ? e.smooth : null;
}

// Tobler's hiking function: how fast a body actually walks a given slope,
// downhill included. Gentler than flat-distance arithmetic, and it knows that
// a steep descent is not free.
function toblerKmh(grade) {
  return 6 * Math.exp(-3.5 * Math.abs(grade + 0.05));
}

export function measure(points) {
  const out = {
    km: 0, ascent: null, descent: null, high: null, low: null,
    hours: null, loop: false, n: Array.isArray(points) ? points.length : 0,
  };
  if (!Array.isArray(points) || points.length < 2) return out;

  const series = elevations(points);
  const ele = series ? series.smooth : null;
  let km = 0, up = 0, down = 0, hours = 0;
  let pending = 0; // the dead band: a rise only counts once it commits

  for (let i = 1; i < points.length; i++) {
    const seg = haversineKm(points[i - 1], points[i]);
    if (!Number.isFinite(seg)) continue;
    km += seg;

    if (ele) {
      const d = ele[i] - ele[i - 1];
      pending += d;
      if (pending > 3) { up += pending; pending = 0; }
      else if (pending < -3) { down += -pending; pending = 0; }
      const grade = seg > 0 ? (d / 1000) / seg : 0;
      hours += seg / Math.max(0.3, toblerKmh(grade));
    } else {
      hours += seg / 4.5;
    }
  }

  out.km = km;
  out.hours = hours;
  if (series) {
    out.ascent = Math.round(up);
    out.descent = Math.round(down);
    out.high = Math.round(Math.max(...series.raw));
    out.low = Math.round(Math.min(...series.raw));
  }
  // a loop returns to where it began, within a few hundred paces
  out.loop = km > 0.6 && haversineKm(points[0], points[points.length - 1]) < 0.25;
  return out;
}

// ---------- carrying a line in a link ----------
//
// A route in a share link cannot be a list of objects: a thousand points would
// be a hundred kilobytes of json. This is the polyline encoding: five decimal
// places, each point stated as its difference from the last, in ascii.

function encVarint(v) {
  let n = v < 0 ? ~(v << 1) : (v << 1);
  let s = '';
  while (n >= 0x20) {
    s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
    n >>= 5;
  }
  return s + String.fromCharCode(n + 63);
}

export function encodePath(points) {
  let lat = 0, lng = 0, ele = 0;
  let s = '';
  for (const p of points) {
    const la = Math.round(p.lat * 1e5);
    const ln = Math.round(p.lng * 1e5);
    const el = Number.isFinite(p.ele) ? Math.round(p.ele) : 0;
    s += encVarint(la - lat) + encVarint(ln - lng) + encVarint(el - ele);
    lat = la; lng = ln; ele = el;
  }
  return s;
}

export function decodePath(str, { withEle = true } = {}) {
  const s = String(str || '');
  const out = [];
  let i = 0, lat = 0, lng = 0, ele = 0;
  const read = () => {
    let result = 0, shift = 0, b;
    do {
      if (i >= s.length) return null;
      b = s.charCodeAt(i++) - 63;
      if (b < 0) return null;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && shift < 32);
    return (result & 1) ? ~(result >> 1) : (result >> 1);
  };
  while (i < s.length) {
    const dLat = read(); if (dLat === null) break;
    const dLng = read(); if (dLng === null) break;
    const dEle = withEle ? read() : 0;
    if (dEle === null) break;
    lat += dLat; lng += dLng; ele += dEle;
    const p = { lat: lat / 1e5, lng: lng / 1e5 };
    if (withEle) p.ele = ele;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return out;
    out.push(p);
    if (out.length > 4000) break;
  }
  return out;
}

// ---------- the profile: the walk, drawn as ground ----------
//
// Not a chart. A section through the hill: a ridge line over close hatching
// whose weight follows the steepness, so a wall reads as a wall.

export function profile(points, { width = 1000, height = 220, columns = 132 } = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const ele = smoothed(points);
  if (!ele) return null;

  // cumulative distance, so the drawing is by ground covered, not by point
  const dist = [0];
  for (let i = 1; i < points.length; i++) {
    dist.push(dist[i - 1] + (haversineKm(points[i - 1], points[i]) || 0));
  }
  const total = dist[dist.length - 1];
  if (!(total > 0)) return null;

  const lo = Math.min(...ele);
  const hi = Math.max(...ele);
  const span = Math.max(30, hi - lo);
  // the ground never quite touches the frame
  const pad = span * 0.16;
  const yOf = (m) => height - ((m - lo + pad * 0.35) / (span + pad)) * height;

  // read the elevation at any distance along the walk
  let cursor = 1;
  const at = (kmAlong) => {
    while (cursor < dist.length - 1 && dist[cursor] < kmAlong) cursor++;
    while (cursor > 1 && dist[cursor - 1] > kmAlong) cursor--;
    const a = cursor - 1, b = cursor;
    const run = dist[b] - dist[a];
    const t = run > 0 ? (kmAlong - dist[a]) / run : 0;
    return {
      ele: ele[a] + (ele[b] - ele[a]) * t,
      lat: points[a].lat + (points[b].lat - points[a].lat) * t,
      lng: points[a].lng + (points[b].lng - points[a].lng) * t,
    };
  };

  const cols = [];
  for (let c = 0; c <= columns; c++) {
    const kmAlong = (c / columns) * total;
    const s = at(kmAlong);
    cols.push({ x: (c / columns) * width, y: yOf(s.ele), ele: s.ele, km: kmAlong, lat: s.lat, lng: s.lng });
  }

  // the hatch under the ridge: denser and darker where the ground is steep
  const hatch = cols.map((c, i) => {
    const prev = cols[Math.max(0, i - 1)];
    const next = cols[Math.min(cols.length - 1, i + 1)];
    const run = (next.km - prev.km) * 1000;
    const rise = next.ele - prev.ele;
    const grade = run > 0 ? Math.abs(rise / run) : 0;
    return { x: c.x, y: c.y, w: Math.min(1, grade / 0.28) };
  });

  const ridge = cols.map((c, i) => `${i ? 'L' : 'M'}${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join('');
  const ground = `${ridge}L${width} ${height}L0 ${height}Z`;

  const hiIdx = ele.indexOf(hi);
  const hiKm = dist[hiIdx] || 0;

  return {
    width, height, total, ridge, ground, hatch, cols,
    high: { m: Math.round(hi), x: (hiKm / total) * width, y: yOf(hi) },
    low: { m: Math.round(lo) },
    at,
  };
}

// ---------- saying it in words ----------

export function fmtKm(km) {
  if (!Number.isFinite(km)) return '';
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export function fmtHours(h) {
  if (!Number.isFinite(h) || h <= 0) return '';
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  if (!hh) return `${mm} min`;
  return mm ? `${hh} h ${String(mm).padStart(2, '0')}` : `${hh} h`;
}

// how hard the ground is, in words rather than a number
export function effort({ km, ascent, hours }) {
  const a = Number.isFinite(ascent) ? ascent : 0;
  const score = (Number.isFinite(km) ? km : 0) / 4 + a / 250;
  if (score < 1.2) return 'a stroll';
  if (score < 2.6) return 'an easy walk';
  if (score < 4.5) return 'a good walk';
  if (score < 7) return 'a long day';
  return 'a serious day';
}
