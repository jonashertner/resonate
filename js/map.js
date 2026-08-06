// map.js — the field: inked tiles, resonance marks, the ripple, correspondents

/* global L */

const TILE = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};

const RM = matchMedia('(prefers-reduced-motion: reduce)');

let map;
let tileLayer;
let clusterGroup;
let corrLayer;
let locateMarker;
const markersById = new Map();
const nameById = new Map();
let labelsOn = false;
let selectedIdRef = null;

export function initMap({ onMarkerClick, onCorrClick, onLongPress, onPointerMove, onViewChange }) {
  map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    worldCopyJump: true,
    zoomSnap: 0.5,
    minZoom: 2,
    maxZoom: 20,
    maxBounds: [[-85, -540], [85, 540]],
    maxBoundsViscosity: 0.8,
    fadeAnimation: false,
  });
  map.setView([32, 8], 2.5);

  clusterGroup = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 44,
    spiderfyOnMaxZoom: true,
    zoomToBoundsOnClick: false,
    iconCreateFunction(cluster) {
      const n = cluster.getChildCount();
      const s = n < 10 ? 36 : n < 50 ? 42 : 48;
      return L.divIcon({
        html: `<div class="station"><svg width="${s}" height="${s}" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="17.5" class="st-ring"/>
          </svg><span class="station-n">${n}</span></div>`,
        className: 'station-icon',
        iconSize: [s, s],
      });
    },
  });
  map.addLayer(clusterGroup);

  clusterGroup.on('clusterclick', (e) => {
    map.flyToBounds(e.layer.getBounds(), { ...overlayPadding(), maxZoom: 16, duration: 0.5 });
  });

  corrLayer = L.layerGroup();
  map.addLayer(corrLayer);
  markersById._onCorrClick = onCorrClick;

  // right-click / long-press proposes a fix; plain taps only pan and select
  map.on('contextmenu', (e) => onLongPress?.(e.latlng.lat, e.latlng.lng));

  map.on('mousemove', (e) => onPointerMove?.(e.latlng.lat, e.latlng.lng));
  map.on('moveend zoomend', () => {
    const c = map.getCenter();
    onViewChange?.({ lat: c.lat, lng: c.lng, zoom: map.getZoom() });
  });
  map.on('zoomend', () => { refreshLabels(); refreshCorrVisibility(); });
  map.on('moveend', () => { if (labelsOn) refreshLabels(); });

  markersById._onMarkerClick = onMarkerClick;
  return map;
}

// the first time a hand touches the field, whoever is waiting is told
export function onFirstUse(fn) {
  // only a hand counts: zoomstart also fires for the app's own framing
  const once = () => {
    fn();
    map.off('dragstart', once);
    map.off('click', once);
  };
  map.on('dragstart', once);
  map.on('click', once);
}

export function setBasemap(mode /* 'light' | 'dark' */) {
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(TILE[mode] || TILE.light, {
    attribution: '',
    subdomains: 'abcd',
    maxZoom: 20,
  });
  tileLayer.addTo(map);
}

// ---------- resonance marks (yours) ----------

function seedFor(id) {
  return -(Math.abs([...String(id)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 5200);
}

export function sigAngle(id) {
  return (Math.abs([...String(id)].reduce((a, c) => a * 33 + c.charCodeAt(0), 5)) % 12) * 30;
}

function markHTML(place, selected) {
  const wish = place.status === 'wishlist';
  // sig lands inside an attribute: it is a number or it is nothing
  const graft = place.provenance
    ? `<circle class="graft" cx="15" cy="15" r="11.5" pathLength="360" style="--sig:${Number(place.provenance.sig) || 0}deg"/>`
    : '';
  return `<div class="mark${wish ? ' wish' : ''}${selected ? ' sel' : ''}" style="--seed:${seedFor(place.id)}ms">
    <svg width="30" height="30" viewBox="0 0 30 30">
      ${graft}
      <circle cx="15" cy="15" r="8" class="mk-ring"/>
      <circle cx="15" cy="15" r="2.4" class="mk-dot"/>
    </svg></div>`;
}

function makeIcon(place, selected) {
  return L.divIcon({
    className: 'mark-icon',
    html: markHTML(place, selected),
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

export function renderMarkers(places, _tagById, selectedId) {
  selectedIdRef = selectedId;
  clusterGroup.clearLayers();
  markersById.clear();
  nameById.clear();
  places.forEach(place => {
    const marker = L.marker([place.lat, place.lng], {
      icon: makeIcon(place, place.id === selectedId),
      riseOnHover: true,
    });
    marker.on('click', () => markersById._onMarkerClick?.(place.id));
    markersById.set(place.id, marker);
    nameById.set(place.id, { name: place.name, wish: place.status === 'wishlist' });
    clusterGroup.addLayer(marker);
  });
  refreshLabels(true);
}

export function refreshMarkerIcon(place, _tagById, selected) {
  const m = markersById.get(place.id);
  if (!m) return;
  if (selected) selectedIdRef = place.id;
  m.setIcon(makeIcon(place, selected));
  nameById.set(place.id, { name: place.name, wish: place.status === 'wishlist' });
  bindLabel(place.id, m);
}

// ---------- the ripple: the field acknowledges a fix ----------

export function ripple(lat, lng) {
  if (RM.matches) return;
  const container = map.getContainer();
  container.querySelector('.field-ripple')?.remove();
  const pt = map.latLngToContainerPoint([lat, lng]);
  const el = document.createElement('div');
  el.className = 'field-ripple';
  el.style.cssText = `left:${pt.x}px;top:${pt.y}px`;
  container.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// ---------- typeset labels, staged by zoom ----------

function labelDirection(m) {
  const pt = map.latLngToContainerPoint(m.getLatLng());
  return pt.x > map.getSize().x - 200 ? 'left' : 'right';
}

function bindLabel(id, m) {
  const rec = nameById.get(id);
  if (!rec) return;
  const z = map.getZoom();
  const shouldShow = labelsOn || (z >= 7 && id === selectedIdRef);
  const dir = labelDirection(m);
  if (m.getTooltip()) m.unbindTooltip();
  const node = document.createElement('span');
  node.textContent = rec.name;
  m.bindTooltip(node, {
    permanent: shouldShow,
    direction: dir,
    offset: [dir === 'left' ? -14 : 14, 0],
    className: `map-label${rec.wish ? ' wish' : ''}`,
    opacity: 1,
  });
  m._labelDir = dir;
}

function refreshLabels(force = false) {
  if (!map) return;
  const show = map.getZoom() >= 12 && markersById.size <= 40;
  if (!force && show === labelsOn) {
    if (show) {
      markersById.forEach((m, id) => {
        if (m._labelDir !== labelDirection(m)) bindLabel(id, m);
      });
    } else if (selectedIdRef && markersById.has(selectedIdRef)) {
      bindLabel(selectedIdRef, markersById.get(selectedIdRef));
    }
    return;
  }
  labelsOn = show;
  markersById.forEach((m, id) => bindLabel(id, m));
}

// ---------- correspondents: aperture marks in counter-ink ----------

let corrData = [];

function apertureHTML(sig) {
  return `<div class="mark corr" style="--sig:${sig}deg">
    <svg width="30" height="30" viewBox="0 0 30 30">
      <circle class="corr-arcs" cx="15" cy="15" r="8.4" pathLength="360"/>
      <circle class="corr-pole" cx="15" cy="15" r="1.7"/>
    </svg></div>`;
}

export function setCorrespondents(corrs) {
  corrData = corrs;
  refreshCorrVisibility();
}

function refreshCorrVisibility() {
  if (!corrLayer) return;
  corrLayer.clearLayers();
  if (map.getZoom() < 5) return;
  corrData.filter(c => c.visible !== false).forEach(c => {
    const sig = sigAngle(c.id);
    c.places.forEach(p => {
      const mk = L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: 'mark-icon',
          html: apertureHTML(sig),
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
      });
      const node = document.createElement('span');
      node.textContent = p.name;
      mk.bindTooltip(node, { direction: 'right', offset: [14, 0], className: 'map-label corr-label' });
      mk.on('click', () => markersById._onCorrClick?.(c.id, p.id));
      corrLayer.addLayer(mk);
    });
  });
}

// ---------- view control ----------

function plateOpen() {
  const el = document.getElementById('plate');
  return el && !el.hidden;
}

function overlayPadding() {
  if (window.innerWidth <= 760) {
    return {
      paddingTopLeft: [36, 72],
      paddingBottomRight: [36, plateOpen() ? Math.round(window.innerHeight * 0.64) + 24 : 84],
    };
  }
  return {
    paddingTopLeft: [64, 80],
    paddingBottomRight: [plateOpen() ? Math.min(480, Math.round(window.innerWidth * 0.36)) : 64, 90],
  };
}

export function fitAll(places) {
  if (!places.length) return;
  if (places.length === 1) { map.setView([places[0].lat, places[0].lng], 13); return; }
  const bounds = L.latLngBounds(places.map(p => [p.lat, p.lng]));
  map.fitBounds(bounds, { ...overlayPadding(), maxZoom: 14 });
}

export function flyToPlace(place, zoom) {
  const targetZoom = Math.max(map.getZoom(), zoom ?? 14);
  const pt = map.project(L.latLng(place.lat, place.lng), targetZoom);
  if (window.innerWidth > 760) pt.x += Math.min(220, window.innerWidth * 0.15);
  else pt.y += Math.round(window.innerHeight * 0.26);
  if (RM.matches) map.setView(map.unproject(pt, targetZoom), targetZoom);
  else map.flyTo(map.unproject(pt, targetZoom), targetZoom, { duration: 0.65, easeLinearity: 0.25 });
}

export function setView(view) {
  if (view && Number.isFinite(view.lat)) map.setView([view.lat, view.lng], view.zoom ?? 4);
}

export function getCenter() {
  const c = map.getCenter();
  return { lat: c.lat, lng: c.lng };
}

export function getZoom() { return map.getZoom(); }
export function zoomIn() { map.zoomIn(); }
export function zoomOut() { map.zoomOut(); }

export function locate(onDone, onError) {
  map.once('locationfound', (e) => {
    if (locateMarker) map.removeLayer(locateMarker);
    locateMarker = L.circleMarker(e.latlng, {
      radius: 6, weight: 1.5, fillOpacity: 0, className: 'locate-dot',
    }).addTo(map);
    onDone?.(e.latlng);
  });
  map.once('locationerror', () => onError?.());
  map.locate({ setView: true, maxZoom: 14, enableHighAccuracy: false });
}

let previewMarker = null;
export function previewPin(lat, lng) {
  clearPreview();
  previewMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: 'mark-icon',
      html: `<div class="mark wish proposed"><svg width="30" height="30" viewBox="0 0 30 30">
        <circle cx="15" cy="15" r="8" class="mk-ring"/>
        <circle cx="15" cy="15" r="2.4" class="mk-dot"/>
      </svg></div>`,
      iconSize: [30, 30], iconAnchor: [15, 15],
    }),
    interactive: false,
  }).addTo(map);
}
export function clearPreview() {
  if (previewMarker) { map.removeLayer(previewMarker); previewMarker = null; }
}

export function invalidate() { map.invalidateSize(); }
export function getMap() { return map; }
export function closeAddPopup() { /* superseded by the add-confirm line; kept for callers */ }
