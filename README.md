# Resonate

A personal atlas of the places that matter to you, and a quiet trust network
around them. It lives in your browser. No account, no build step, and no
server of ours behind the free atlas; the optional travellers club adds one
that holds a sealed envelope it cannot read.

Live at [resonate.select](https://resonate.select/).

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
node tools/dev.mjs
```

Any static file server works too (`python3 -m http.server 5178`); the dev
server additionally lets the intro film seek and admits the local club mock
into the page's security policy.

Then open http://localhost:5178.

## Tests

```bash
node --test test/*.test.mjs
```

They hold the lines that matter: a hostile share link is capped hard while a
private archive comes home whole or not at all, a place marked as never
leaving is in no file a stranger is given, a photo id survives a reload, the
envelope opens in every dialect it has ever been sealed in, and evidence
escapes what it is given. They run on every push, alongside a parse check, a
digest check on the vendored Argon2id, and a house-style check.

## What it does

**Keep.** Type a place into the command line, paste a link from google, apple
or openstreetmap and the point is read out of it, share one straight in from
the phone's own share sheet, mark the middle of the field with `>mark` and name
it yourself, drop a photo with a GPS fix on the map, or press long on the
field. Anything you open is
proposed first: you decide whether to keep it. The map is paper and stays grey;
colour on it means a mark and the domain it belongs to. Notes can be dictated.

**Find.** One command line answers with your own places, your voices, the
newsstand, and, when you ask it to, the world. Prefixes: `#tag`, `>verb`,
`@voice`, or a bare `lat,lng`.

**Hand over.** A folio is a titled set of places under your byline, for one person. An ask
is a question that arrives with the reply already drafted from the recipient's
own atlas. Both travel as a link and nothing else.

**The newsstand.** A shelf, not a feed. Published folios sit on a separate
address as a plain list; your device fetches it and ranks it against your own
atlas here. Nothing about what you hold or open goes back. Offering a folio
runs the other way and is read by a person first, today through GitHub.

**Take it away.** Export the whole atlas as a JSON archive carrying its
photographs, or as GeoJSON, KML, CSV or Markdown typeset by city, or a way as
GPX. Print it or save it as a PDF. Erase everything, whenever.

## How it is built

Hand-written ES modules. No framework, no bundler.

| Piece | Choice |
| --- | --- |
| Map | Leaflet 1.9.4 + leaflet.markercluster, vendored |
| Tiles | CARTO light and dark raster, stripped to grey |
| Geocoding | Nominatim, on an explicit press only, never as you type |
| Links | lz-string into the URL hash |
| Storage | localStorage for records: `resonate.places.v1`, `.routes.v1`, `.folios.v1`, `.tags.v1`, `.correspondents.v1`, `.settings.v1`. IndexedDB `resonate` for photographs and snapshots |
| Type | Bricolage Grotesque variable, Fragment Mono, vendored under `fonts/` (OFL) |

```
index.html      the shell: corner marks, the index, posters, the command line
css/style.css   the whole system: one field, one ink, one counter-ink
js/app.js       state, surfaces, the command line, reports, the printed sheet
js/store.js     persistence, models, the shape a stranger is given
js/map.js       leaflet, resonance marks, station clusters, grey tiles
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

Records live in localStorage; photographs live in IndexedDB, where the room
is. A refused write rolls back whole and says so. Deletions do not travel
through the club's envelope: it is a backup, not a ledger. See
[SECURITY.md](SECURITY.md) and [THREATS.md](THREATS.md).

## Attribution

Map data © OpenStreetMap contributors. Tiles by CARTO. Geocoding by Nominatim,
whose usage policy this app follows: the world is asked once per press, never
while you type.
