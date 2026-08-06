# Resonate — a personal atlas

**The Resonant Field.** The map is the entire interface: four typographic corner marks,
one command line, and summoned typographic posters — no panels, no buttons, no boxes.
The whole viewport lives in exactly two colors at any moment, derived from three custom
properties: filter by a tag and the entire world — tiles included — re-inks itself in that
tag's hue. Places are breathing resonance marks; selecting one sends a single ripple across
the field. Type: Bricolage Grotesque (variable) + Fragment Mono.

**And a quiet trust network.** Resonance is exchanged, not followed: hand someone your atlas
as a link; when theirs comes back, the app reads it like a discerning friend — common ground
(places you both hold and both love), domain fluency, and the divergence that expands you —
and renders a verdict word, never a score. Keep them as a *correspondent*: their places live
on your field as open aperture marks in the counter-ink, adoptable with permanent provenance
("after Anna"). Photos that carry a GPS fix become places by themselves (shoot or drop one on
the field); notes can be dictated.

**No account. No cloud. No build step.** Everything lives in your browser.

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
