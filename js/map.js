// map.js — Leaflet, inked basemaps, benchmark markers, survey furniture

/* global L */

const TILE = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const ATTRIB = ''; // attribution is typeset into the plate band instead

const RM = matchMedia('(prefers-reduced-motion: reduce)');

let map;
let tileLayer;
let clusterGroup;
let addPopup;
let locateMarker;
const markersById = new Map();
const nameById = new Map();
let labelsOn = false;

export function initMap({ onMarkerClick, onAddHere, onPointerMove, onViewChange }) {
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
      const s = n < 10 ? 38 : n < 50 ? 44 : 50;
      return L.divIcon({
        html: `<div class="station">
          <svg width="${s}" height="${s}" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="17" class="st-disc"/>
            <circle cx="20" cy="20" r="13.5" class="st-ring"/>
            <path d="M20 1v4M20 35v4M1 20h4M35 20h4" class="st-tick"/>
          </svg>
          <span class="station-n">${n}</span>
        </div>`,
        className: 'station-icon',
        iconSize: [s, s],
      });
    },
  });
  map.addLayer(clusterGroup);

  // cluster click: zoom into the station's bounds, keeping clear of the index page
  clusterGroup.on('clusterclick', (e) => {
    map.flyToBounds(e.layer.getBounds(), { ...overlayPadding(), maxZoom: 16, duration: 0.5 });
  });

  map.on('click', (e) => {
    if (!onAddHere) return;
    openAddPopup(e.latlng, onAddHere);
  });

  map.on('mousemove', (e) => onPointerMove?.(e.latlng.lat, e.latlng.lng));
  map.on('moveend zoomend', () => {
    const c = map.getCenter();
    onViewChange?.({ lat: c.lat, lng: c.lng, zoom: map.getZoom() });
  });
  map.on('zoomend', () => refreshLabels());
  map.on('moveend', () => { if (labelsOn) refreshLabels(); });

  markersById._onMarkerClick = onMarkerClick;
  return map;
}

// ---------- basemap with day/night crossfade ----------

export function setBasemap(mode /* 'light' | 'dark' */) {
  // hard replace — the ink filter swaps with the theme in the same beat,
  // and animating Leaflet's own tile containers desyncs its transform state
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(TILE[mode] || TILE.light, {
    attribution: ATTRIB,
    subdomains: 'abcd',
    maxZoom: 20,
  });
  tileLayer.addTo(map);
}

// ---------- benchmark markers ----------

function benchHTML(color, wish, selected) {
  const ring = wish
    ? `<circle cx="13" cy="13" r="8" class="bm-ring wish" style="stroke:${color}"/>`
    : `<circle cx="13" cy="13" r="8" class="bm-ring" style="stroke:${color}"/>`;
  const dot = wish
    ? `<circle cx="13" cy="13" r="2.4" class="bm-dot wish" style="stroke:${color}"/>`
    : `<circle cx="13" cy="13" r="2.4" class="bm-dot"/>`;
  const ripples = selected
    ? `<span class="ripple" style="border-color:${color}"></span><span class="ripple d2" style="border-color:${color}"></span>`
    : '';
  return `<div class="bench${wish ? ' wish' : ''}${selected ? ' fixed' : ''}">
    ${ripples}
    <svg width="26" height="26" viewBox="0 0 26 26"><g class="bench-g">${ring}${dot}</g></svg>
  </div>`;
}

function makeIcon(place, tag, selected) {
  const color = tag?.color || '#5C6A77';
  return L.divIcon({
    className: 'bench-icon',
    html: benchHTML(color, place.status === 'wishlist', selected),
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

export function renderMarkers(places, tagById, selectedId) {
  clusterGroup.clearLayers();
  markersById.clear();
  nameById.clear();
  places.forEach(place => {
    const tag = tagById(place.tags[0]);
    const marker = L.marker([place.lat, place.lng], {
      icon: makeIcon(place, tag, place.id === selectedId),
      riseOnHover: true,
    });
    marker.on('click', () => markersById._onMarkerClick?.(place.id));
    markersById.set(place.id, marker);
    nameById.set(place.id, { name: place.name, wish: place.status === 'wishlist' });
    clusterGroup.addLayer(marker);
  });
  refreshLabels(true);
}

export function refreshMarkerIcon(place, tagById, selected) {
  const m = markersById.get(place.id);
  if (!m) return;
  m.setIcon(makeIcon(place, tagById(place.tags[0]), selected));
  nameById.set(place.id, { name: place.name, wish: place.status === 'wishlist' });
  bindLabel(place.id, m);
}

// typeset place-name labels, engraved-quad style, at close zoom
function labelDirection(m) {
  // flip to the left when the label would run off the neat line
  const pt = map.latLngToContainerPoint(m.getLatLng());
  const w = map.getSize().x;
  return pt.x > w - 190 ? 'left' : 'right';
}

function bindLabel(id, m) {
  const rec = nameById.get(id);
  if (!rec) return;
  const dir = labelDirection(m);
  if (m.getTooltip()) m.unbindTooltip();
  const node = document.createElement('span');
  node.textContent = rec.name; // textContent — names can arrive via share links
  m.bindTooltip(node, {
    permanent: labelsOn,
    direction: dir,
    offset: [dir === 'left' ? -13 : 13, 0],
    className: `map-label${rec.wish ? ' wish' : ''}`,
    opacity: 1,
  });
  m._labelDir = dir;
}

function refreshLabels(force = false) {
  if (!map) return;
  const show = map.getZoom() >= 12 && markersById.size <= 40;
  if (!force && show === labelsOn) {
    // state unchanged — only fix labels whose edge side flipped
    if (show) {
      markersById.forEach((m, id) => {
        if (m._labelDir !== labelDirection(m)) bindLabel(id, m);
      });
    }
    return;
  }
  labelsOn = show;
  markersById.forEach((m, id) => bindLabel(id, m));
}

// ---------- view control ----------

// keep fitted bounds clear of the index page (desktop) / bottom sheet (mobile)
function overlayPadding() {
  if (window.innerWidth <= 760) {
    return { paddingTopLeft: [36, 64], paddingBottomRight: [36, Math.round(window.innerHeight * 0.46) + 30] };
  }
  // the rail is opaque — fitted content must start right of it
  const railRight = document.getElementById('rail')?.getBoundingClientRect().right ?? 412;
  return { paddingTopLeft: [Math.round(railRight) + 24, 56], paddingBottomRight: [64, 84] };
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
  if (window.innerWidth > 760) pt.x -= 205;
  else pt.y += Math.round(window.innerHeight * 0.23);
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
    // var() is invalid in SVG presentation attributes — style via class instead
    locateMarker = L.circleMarker(e.latlng, {
      radius: 6, weight: 1.5, fillOpacity: 0, className: 'locate-dot',
    }).addTo(map);
    onDone?.(e.latlng);
  });
  map.once('locationerror', () => onError?.());
  map.locate({ setView: true, maxZoom: 14, enableHighAccuracy: false });
}

// ---------- the survey stamp: fired once when a place is added ----------

export function stampFix(lat, lng) {
  if (RM.matches) return;
  const container = map.getContainer();
  let layer = container.querySelector('.stamp-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'stamp-layer';
    container.appendChild(layer);
  }
  const pt = map.latLngToContainerPoint([lat, lng]);
  layer.innerHTML = `
    <div class="stamp-h" style="top:${pt.y}px"></div>
    <div class="stamp-v" style="left:${pt.x}px"></div>
    <div class="stamp-ring" style="left:${pt.x}px;top:${pt.y}px"></div>
    <div class="stamp-res" style="left:${pt.x}px;top:${pt.y}px"></div>`;
  setTimeout(() => { layer.innerHTML = ''; }, 900);
}

// ---------- add-here popup ----------

function openAddPopup(latlng, onAddHere) {
  closeAddPopup();
  const node = document.createElement('div');
  node.innerHTML = `
    <button class="add-here-btn"><svg><use href="#i-plus"/></svg>Add place here</button>
    <div class="add-here-sub mono">${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</div>`;
  node.querySelector('button').addEventListener('click', () => {
    closeAddPopup();
    onAddHere(latlng.lat, latlng.lng);
  });
  addPopup = L.popup({ className: 'add-popup', offset: [0, 2], autoPan: false, closeButton: false })
    .setLatLng(latlng)
    .setContent(node)
    .openOn(map);
}

export function closeAddPopup() {
  if (addPopup) { map.closePopup(addPopup); addPopup = null; }
}

export function invalidate() { map.invalidateSize(); }
export function getMap() { return map; }
