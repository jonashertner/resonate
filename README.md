# Resonate — a personal atlas

Save the places that resonate with you. A local-first, single-page web app in the spirit of
Mapstr — but faster to capture, more powerful to organize, and designed as **a living chart
sheet**: the whole viewport is one printed survey document. A neat-line frame with a live
graticule (degree ticks that glide as you pan), a basemap duotone-inked into the app's own
paper and ink, survey-benchmark ring markers with typeset serif labels, an index page with
dotted leaders instead of cards, and plate-style detail pages numbered like an atlas.

**No account. No cloud. No build step.** Your atlas lives in your browser; export it or share
it as a link whenever you like.

## Run it

```bash
python3 -m http.server 5178
```

Then open <http://localhost:5178>. Any static file server works — there is no build step and
no server-side code.

## What it does

- **Capture in seconds** — press `⌘K` (or `/`), type any place on Earth (OpenStreetMap
  search), hit enter. Or click anywhere on the map → "Add place here" (reverse-geocoded).
- **Organize** — colored + emoji tags, been / want-to-go status, star ratings, serif notes,
  photos (auto-thumbnailed into local storage), links.
- **Find again** — full-text search over your places, tag chips with counts, status filter,
  sort by newest / A–Z / nearest / top rated. Map and list stay in sync; wishlist places
  draw as dashed hollow pins, visited as solid ones.
- **The story so far** — a stats view: places, countries, cities, per-tag breakdown.
- **Share without a backend** — the whole map compresses (lz-string) into the URL hash.
  Anyone who opens the link gets a read-only view and can fork it with "Save a copy".
  Photos never travel in the link.
- **Own your data** — export/import JSON, export GeoJSON, erase everything. localStorage only.
- **Light & dark** — chrome and basemap swap together (CARTO Positron ↔ Dark Matter).
- **Offline-ready** — a service worker caches the app shell (PWA, installable).

## Stack

Hand-written ES modules, no framework, no bundler.

| Piece | Choice |
| --- | --- |
| Map | Leaflet 1.9.4 + leaflet.markercluster (vendored) |
| Basemaps | CARTO Positron / Dark Matter raster tiles (free, no key) |
| Geocoding | Nominatim (OpenStreetMap) public API |
| Share links | lz-string compression → URL hash |
| Storage | localStorage (`resonate.places.v1`, `resonate.tags.v1`, `resonate.settings.v1`) |
| Type | Newsreader (display), Archivo (UI), Spline Sans Mono (coordinates) |

## Files

```
index.html          app shell + SVG icon sprite + chart frame/band markup
css/style.css       the whole design system (light "engraved sheet" / dark "night chart")
js/app.js           state, rendering, events — index/plate/census/colophon templates
js/store.js         persistence, models, demo dataset
js/map.js           Leaflet, benchmark ring markers, station clusters, inked tiles
js/frame.js         the neat-line frame: live graticule tick pools, scale bar, coords band
js/geocode.js       Nominatim search/reverse + degree-minute formatting
js/share.js         map ⇄ URL-hash encoding
vendor/             leaflet, markercluster, lz-string (pinned copies)
sw.js               offline shell cache (network-first for same-origin)
```

Attribution: map data © OpenStreetMap contributors, tiles by CARTO. Geocoding by Nominatim —
be gentle with the public API (the app debounces and caps result counts).
