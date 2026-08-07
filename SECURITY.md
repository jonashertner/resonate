# Security

Resonate keeps an atlas in one browser. The free atlas speaks to no server of
ours; the optional travellers club adds one Cloudflare worker that stores a
sealed envelope it cannot read. The attack surface is therefore small and
specific: what arrives in a link, what arrives in an imported file, what
arrives from the commons, and what the club holds.

## Reporting

Open an advisory at https://github.com/jonashertner/resonate/security/advisories/new
or write to jonashertner@protonmail.ch. If the finding would harm people before
it is fixed, use the address, and give us a week before publishing. There is a
machine-readable copy of this at /.well-known/security.txt on the live site.

## What we defend against

**Hostile share links.** A `#m=` payload is attacker-controlled in full. Every
value it carries reaches the page escaped, including names, notes, tags, and the
evidence lines the kinship engine composes. Every inbound payload passes one
schema gate that bounds and types every field. Colors are matched against a
pattern, photo sources must be `data:image/`, and link targets must be `http`
or `https`. A Content-Security-Policy stands behind all of it: no inline
scripts, no external script hosts, no object or form targets, and, since the
typefaces moved into the site itself, no font or style host either.

**Hostile imports.** An imported JSON file is validated on merge, not trusted,
and a merge the device cannot write is rolled back whole.

**The commons.** A folio is published only when a maintainer applies the
`publish` label to its issue. Nothing runs on arrival. The workflow passes
arguments to git as an array, never through a shell.

**The club's envelope.** Sealed on the device before it travels: PBKDF2-SHA256
into AES-GCM under a phrase that never leaves. The envelope carries a monotonic
count inside the authenticated payload, so a stale or hollowed vault is refused
rather than sealed over. A merge the device refuses aborts the push. The full
format and its refusal rules are being written into club/SPEC.md.

## Resolved

**A shared origin** (resolved 2026-08-06). The app formerly shared
`jonashertner.github.io` with the commons; `localStorage` is scoped per origin,
so any script on that host could in principle have read the atlas. The app now
lives on its own address, resonate.select, and the commons stays where it was.

## Known limits

**Photos and quota.** Photos live in `localStorage` as data URLs. A large atlas
can exhaust the quota; a refused write says so and rolls back. Moving photos to
IndexedDB is the next durability change.

**The deploy is the trust root.** The page is static and hand-readable, with no
third-party script, but a compromised deployment could read anything, including
the club phrase as it is typed. Every release runs its tests in CI before the
site updates.

**Deletions do not synchronise.** The club's envelope is a backup, not a ledger:
a place removed on one device returns from an envelope sealed on another. That
is the backup working, and it is stated in the app.

## What leaves the device

Nothing, unless you send it. A share link carries what you enclosed at that
moment. An ask carries one question and a byline. Photos never travel in links.
The page, its code and its typefaces come from the site's own host. Map tiles
and place searches go to CARTO and to OpenStreetMap's Nominatim, which see your
IP address and what you searched for, as any map would. The club, if joined,
receives a sealed envelope, keeps the one before it, and holds the minimum a
subscription needs: a key, a paid-until date, notice of cancellation, the
envelope's size and last-sealed time, and the Stripe subscription id.
