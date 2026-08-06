// frame.js — the neat-line frame: live graticule ticks, scale bar, coords band
// A fixed pool of DOM nodes glides with the map during pan (rAF-throttled,
// transform-only writes); during zoom the graticule fades and re-indexes.

import { fmtDM, fmtDMS } from './geocode.js';

const STEPS = [30, 15, 10, 5, 2, 1, 0.5, 0.25, 1 / 6, 1 / 12, 1 / 30, 1 / 60];
const POOL = 22; // ticks per edge, created once
const EDGE_GUARD = 46; // px — suppress labels near corners

let map;
let frameEl;
let raf = 0;
let size = { w: 0, h: 0 };
const pools = { top: [], bottom: [], right: [], left: [] };
let scaleBarEl, scaleLabelEl, coordsEl;

function pickStep(span) {
  return STEPS.find(s => span / s >= 3) ?? STEPS[STEPS.length - 1];
}

function makeTick(edge) {
  const el = document.createElement('div');
  el.className = `gtick gtick-${edge}`;
  const label = document.createElement('span');
  label.className = 'gtick-label mono';
  el.appendChild(label);
  return el;
}

export function initFrame(leafletMap) {
  map = leafletMap;
  frameEl = document.getElementById('sheetFrame');
  scaleBarEl = document.getElementById('scaleBar');
  scaleLabelEl = document.getElementById('scaleLabel');
  coordsEl = document.getElementById('coordsReadout');

  for (const edge of ['top', 'bottom', 'right', 'left']) {
    const host = frameEl.querySelector(`.gticks-${edge}`);
    for (let i = 0; i < POOL; i++) {
      const t = makeTick(edge);
      pools[edge].push(t);
      host.appendChild(t);
    }
  }

  const measure = () => {
    const r = frameEl.getBoundingClientRect();
    size = { w: r.width, h: r.height };
  };
  measure();
  window.addEventListener('resize', () => { measure(); schedule(); });

  // when the pointer leaves the chart, the readout returns to tracking the centre
  map.getContainer().addEventListener('mouseleave', () => {
    if (coordsEl) delete coordsEl.dataset.live;
    const c = map.getCenter();
    setCoords(c.lat, c.lng);
  });

  map.on('move', schedule);
  map.on('zoomstart', () => frameEl.classList.add('is-zooming'));
  map.on('zoomend', () => { frameEl.classList.remove('is-zooming'); schedule(); updateScaleBar(); });
  map.on('moveend', updateScaleBar);

  schedule();
  updateScaleBar();
}

function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; layout(); });
}

function layout() {
  if (!map) return;
  const b = map.getBounds();
  const west = b.getWest(), east = b.getEast(), south = b.getSouth(), north = b.getNorth();
  const lngStep = pickStep(Math.abs(east - west));
  const latStep = pickStep(Math.abs(north - south));

  layoutEdge('top', west, east, lngStep, false);
  layoutEdge('bottom', west, east, lngStep, false);
  layoutEdge('right', south, north, latStep, true);
  layoutEdge('left', south, north, latStep, true);

  if (coordsEl && coordsEl.dataset.live !== 'pointer') {
    const c = map.getCenter();
    setCoords(c.lat, c.lng);
  }
}

function layoutEdge(edge, min, max, step, isLat) {
  const pool = pools[edge];
  const first = Math.ceil(min / step) * step;
  let i = 0;
  for (let v = first; v <= max + 1e-9 && i < POOL; v += step) {
    const value = Math.abs(v) < 1e-9 ? 0 : v;
    const pt = isLat
      ? map.latLngToContainerPoint([value, map.getCenter().lng])
      : map.latLngToContainerPoint([map.getCenter().lat, value]);
    const px = isLat ? pt.y : pt.x;
    const el = pool[i];
    const limit = isLat ? size.h : size.w;
    if (px < 4 || px > limit - 4) continue;
    el.style.transform = isLat
      ? `translate3d(0, ${px}px, 0)`
      : `translate3d(${px}px, 0, 0)`;
    let hideLabel = px < EDGE_GUARD || px > limit - EDGE_GUARD;
    // the right edge carries the instrument buttons — keep labels out of their lanes
    if (edge === 'right' && ((px > 12 && px < 250) || px > limit - 250)) hideLabel = true;
    // wrap unwrapped longitudes across the antimeridian (worldCopyJump bounds)
    const shown = isLat ? value : ((value + 180) % 360 + 360) % 360 - 180;
    const text = hideLabel ? '' : fmtDM(shown, isLat);
    if (el._txt !== text) {
      el._txt = text;
      el.lastElementChild.textContent = text;
    }
    i++;
  }
  for (; i < POOL; i++) {
    pool[i].style.transform = 'translate3d(-500px, -500px, 0)';
  }
}

export function setCoords(lat, lng, fromPointer = false) {
  if (!coordsEl) return;
  if (fromPointer) coordsEl.dataset.live = 'pointer';
  coordsEl.textContent = fmtDMS(lat, lng);
}

// checked scale bar: alternating ink/paper segments, snapped to a nice length
function updateScaleBar() {
  if (!scaleBarEl || !map) return;
  const c = map.getCenter();
  const mpp = 156543.03392 * Math.cos(c.lat * Math.PI / 180) / 2 ** map.getZoom();
  const target = mpp * 88; // aim for ~88px
  const pow = 10 ** Math.floor(Math.log10(target));
  const n = target / pow;
  const nice = (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow;
  const px = nice / mpp;
  scaleBarEl.style.width = `${Math.round(px)}px`;
  scaleLabelEl.textContent = nice >= 1000 ? `${nice / 1000} km` : `${Math.round(nice)} m`;
}
