# Resonate

A personal atlas of the places that matter to you, and a quiet trust network
around them. It lives in your browser. No account, no server, no build step.

Live at [jonashertner.github.io/resonate](https://jonashertner.github.io/resonate/).

## The idea

Keeping places is easy. Knowing whose recommendations to trust is not.

Resonate holds your places, and lets you hand a set of them to one person as a
link. When someone hands you theirs, your device compares the two atlases: what
you both hold, what you both love, and where they know ground you do not. The
answer is a word, never a score. Keep a person as a voice and their marks stay
on your field, open rings you may adopt. An adopted place says after their name,
for good.

## Run it

```bash
python3 -m http.server 5178
```

Then open http://localhost:5178. Any static file server works. Note that
python's server does not answer range requests, so the intro film cannot seek;
it starts from the first frame locally and from the right frame in production.

## Tests

```bash
node --test test/*.test.mjs
```

They hold the lines a hostile share link must not cross: a rating that cannot
exceed five stars, tags that are always an array, provenance rebuilt as a
number, ask and folio links that round-trip, and evidence that escapes what it
is given. They run on every push, alongside a parse check and a house-style
check.

## What it does

**Keep.** Type a place into the command line, drop a photo with a GPS fix on the
map, shoot one on a phone, or press long on the field. Anything you open is
proposed first: you decide whether to keep it. Tags carry hues the whole world
wears. Notes can be dictated.

**Find.** One command line answers with your own places, your voices, the
newsstand, and, when you ask it to, the world. Prefixes: `#tag`, `>verb`,
`@voice`, or a bare `lat,lng`.

**Hand over.** A folio is a titled, signed set of places for one person. An ask
is a question that arrives with the reply already drafted from the recipient's
own atlas. Both travel as a link and nothing else.

**The newsstand.** Anyone may publish a folio to a commons. Your device fetches
the list and ranks it against your own atlas, on your device. The newsstand
never learns what you like or who you are.

**Take it away.** Export the whole atlas as JSON or GeoJSON, print it or save it
as a PDF, typeset by city. Erase everything, whenever.

## How it is built

Hand-written ES modules. No framework, no bundler.

| Piece | Choice |
| --- | --- |
| Map | Leaflet 1.9.4 + leaflet.markercluster, vendored |
| Tiles | CARTO light and dark raster, filtered to the field's hue |
| Geocoding | Nominatim, on an explicit press only, never as you type |
| Links | lz-string into the URL hash |
| Storage | localStorage: `resonate.places.v1`, `.tags.v1`, `.correspondents.v1`, `.settings.v1` |
| Type | Bricolage Grotesque variable, Fragment Mono |

```
index.html      the shell: corner marks, the index, posters, the command line
css/style.css   the whole system: one field, one ink, one counter-ink
js/app.js       state, surfaces, the command line, reports, the printed sheet
js/store.js     persistence, models, the shape a stranger is given
js/map.js       leaflet, resonance marks, station clusters, inked tiles
js/kinship.js   what two atlases have to say to each other
js/geocode.js   nominatim search and reverse, coordinate formatting
js/share.js     atlas, folio and ask links
js/exif.js      the GPS fix a camera wrote into a photo
sw.js           the shell, network first, so it opens without a network
test/           the invariants a hostile link must not break
```

The commons lives in its own repository,
[resonate-commons](https://github.com/jonashertner/resonate-commons). A folio is
published only when a maintainer applies a label to its issue.

## Known limits

The app and the commons share one github.io origin, and localStorage is scoped
to an origin rather than a path. The commons serves no page that could run
script, but a dedicated hostname is the real fix. Photos live in localStorage
and a large atlas can exhaust the quota; a refused write says so, and IndexedDB
is the next move. See [SECURITY.md](SECURITY.md).

## Attribution

Map data © OpenStreetMap contributors. Tiles by CARTO. Geocoding by Nominatim,
whose usage policy this app follows: the world is asked once per press, never
while you type.
