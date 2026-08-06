# Security

Resonate keeps an atlas in one browser. There is no account and no server, so
the attack surface is small and specific: what arrives in a link, what arrives
in an imported file, and what arrives from the commons.

## Reporting

Open an issue at https://github.com/jonashertner/resonate/issues. If the finding
would harm people before it is fixed, write to the address on the maintainer's
GitHub profile instead, and give us a week before publishing.

## What we defend against

**Hostile share links.** A `#m=` payload is attacker-controlled in full. Every
value it carries reaches the page escaped, including names, notes, tags, and the
evidence lines the kinship engine composes. Colors are matched against a
pattern, photo sources must be `data:image/`, and link targets must be `http`
or `https`. A Content-Security-Policy stands behind all of it: no inline
scripts, no external script hosts, no object or form targets.

**Hostile imports.** An imported JSON file is validated on merge, not trusted.

**The commons.** A folio is published only when a maintainer applies the
`publish` label to its issue. Nothing runs on arrival. The workflow passes
arguments to git as an array, never through a shell.

## What we do not yet defend against

**A shared origin.** The app and the commons are both served from
`jonashertner.github.io`. `localStorage` is scoped to an origin, not a path, so
any script served from that host could read the atlas. The commons serves only
JSON and Markdown, with `.nojekyll`, so no page there executes script today.
The real fix is a dedicated hostname for the app, and it is the next
infrastructure change.

**Photos and quota.** Photos live in `localStorage` as data URLs. A large atlas
can exhaust the quota. Moving records to IndexedDB, with a visible failure when
a write is refused, is planned.

## What leaves the device

Nothing, unless you send it. A share link carries what you put in it. An ask
carries one question and a name. Photos never travel. Map tiles and place
searches go to CARTO and to OpenStreetMap's Nominatim, which see your IP address
and what you searched for, as any map would.
