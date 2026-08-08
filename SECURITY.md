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
and a merge the device cannot write is rolled back whole. Since rf67
(2026-08-08) an import is read, decided, staged and only then committed: a
photograph is decoded and written to IndexedDB only for a record that will
actually be kept, and anything staged is removed again if the commit does not
happen. Before this, every photograph in a file was written before validation,
so a file that was then refused still spent the device's room, and importing
it again left duplicates behind with nothing pointing at them. Replacing an
atlas from a file is a single transaction with full rollback: if any part of
the write is refused, everything that was here is put back.

**An archive that came home short** (rf67, 2026-08-08). A person's own archive
has no length limits at all, and every bounded field passes a witness that
records what had to be cut. If a restore or a merge of your own archive would
lose anything, it is refused whole and the losses are named, rather than
brought in quietly shorter. Before this, an own archive was held to numbers
that were generous but finite, 200 photographs on a place and 200,000
characters in a note, while address, city and country were held to a
stranger's limits of 200, 120 and 120 characters. An archive past any of those
came home shorter than it left, and nothing said so.

**A share arriving from the phone** (rf67, 2026-08-08). The share target is a
POST intercepted by the service worker, so a shared place never travels as a
request the host could log. Each field is bounded on arrival: 2048 characters
for the link, 300 for the title, 2000 for the text, 4096 for the three
together, and a body over 1 MB is refused without being parsed at all. The
worker redirects back into the app with one digit and not a word of the place,
and that digit is the truth: `?shared=1` only when the write to the inbox
actually succeeded, `?shared=0` when it kept nothing. The inbox is a separate
IndexedDB database, `resonate-share`, which an erase now deletes; it was
surviving one.

**The commons.** A folio is published only when a maintainer applies the
`publish` label to its issue. Nothing runs on arrival. The workflow passes
arguments to git as an array, never through a shell.

**The club's envelope.** Sealed on the device before it travels: Argon2id, at
64 MiB and three passes, into AES-GCM under a phrase that never leaves.
PBKDF2-SHA256 at 600000 iterations is the fallback where a device cannot run
Argon2id, and opens every envelope sealed before this format. The header and
the membership key are bound into the seal, so neither the parameters nor the
owner can be quietly swapped. The envelope carries a monotonic count inside
the authenticated payload, so a stale or hollowed vault is refused rather than
sealed over, and a merge the device refuses aborts the push. The current envelope is the second
form, `rsnt2`, and the first is read forever and written never. The complete
format and its refusal rules are specified in club/SPEC.md, published at
/SPEC.md.

**Two devices sealing at once** (rf67, 2026-08-08). The vault is
compare-and-swap. A `PUT /vault` must say what it replaces: `If-Match` with the
revision this client last read, or `If-None-Match: *` to create where there is
nothing. Neither is 428. A revision that has moved on, or a vault that already
holds an envelope when the client believed it empty, is 412 with the current
revision on the `ETag`. `If-Match: *` is deliberately not honoured, because it
means "whatever is there", which is the one thing a client must not say about
another device's envelope. The revision and both preconditions are named in
the CORS headers, since a browser cannot read an `ETag` it was not shown, and a
vault whose revision is invisible can be written exactly once.

**A key lost between the payment and the door** (rf67, 2026-08-08). A checkout
session opens the door once. The device generates a 128 bit secret before it
asks, keeps it in `resonate.club.claim.v1`, and sends only its SHA-256 hash
under the label `tc-claim:`. For 24 hours the same device can present the same
secret and be given the same key again, which covers a flat battery, a closed
tab, or a reload at the wrong moment. Anyone else presenting that session gets
409: the door has been opened, and the key that was handed out is the way in. A
device whose storage refuses the write still opens the door and loses only the
second chance.

## Resolved

**A shared origin** (resolved 2026-08-06). The app formerly shared
`jonashertner.github.io` with the commons; `localStorage` is scoped per origin,
so any script on that host could in principle have read the atlas. The app now
lives on its own address, resonate.select, and the commons stays where it was.

## Known limits

**Structured records are still in `localStorage`.** Photographs moved to
IndexedDB, which is where the room is, but places, ways, folios, domains,
voices and settings have not. That is a real limit and rf67 did not lift it.
Each collection is one JSON string, so changing one place rewrites the whole
collection, and the cost of a write grows with the size of the atlas. The API
is synchronous, so a large write blocks the page while it happens. Two tabs of
the same atlas hold their own copies in memory and coordinate only after a
write has landed, so the last one to write wins and the other does not know
until it reloads. A refused write still rolls back whole and says so. A
browser may still evict storage it has not promised to keep, which is why the
app asks for that promise, says whether it was given, and keeps three local
snapshots of the records.

**A key that will not read is not a key that is empty** (rf67, 2026-08-08). If
one of those `localStorage` keys holds JSON that will not parse, the app used
to read it as an empty list, draw an empty atlas, and let the next keystroke
save that emptiness over the damaged bytes. Now the key is sealed: the bytes
stay, a copy is set aside as `<key>.unreadable`, every write to that key is
refused, and the app says so and offers to export what still reads. What this
does not do is repair anything. An atlas that will not parse is still an
atlas you cannot use until you decide to start that part fresh, and the set
aside copy is only as good as someone's willingness to read it by hand.

**The deploy is the trust root.** The page is static and hand-readable, with no
third-party script, but a compromised deployment could read anything, including
the club phrase as it is typed. Every release runs its tests in CI before the
site updates.

**The club is a backup, not synchronisation.** The envelope is an encrypted
backup and nothing more. It is add-only: what comes home is merged in, adding
only what this atlas lacks and changing nothing it already holds. It carries no
deletions, so a place removed on one device returns from an envelope sealed on
another. It keeps no two devices in step: there is no ordering of edits, no
resolution of a conflict between them, and no moment at which two devices are
known to agree. The compare-and-swap above stops one device overwriting
another's envelope; it does not make the two atlases the same. That is the
backup working, it is why the app says backup and not sync, and it is stated
where you press the button.

**No independent audit.** Nobody outside this project has reviewed this code
for security. The tests in CI, the published spec and the fact that the page
is hand-readable are not a substitute for that, and none of them has found
what an auditor is paid to look for. Treat every claim on this page as the
author's own, verifiable against the source, and unverified by anyone else.

## What leaves the device

Nothing, unless you send it. A share link carries what you enclosed at that
moment. An ask carries one question and a byline. Photos never travel in links.

Since rf67 (2026-08-08) the link, the file offered in place of a link, and the
count shown on the panel before you hand anything over are all built from one
object. Before this the file was assembled separately by spreading whole
records, so it disclosed fields the panel never mentioned, including when each
record was created and last changed, and every domain in the atlas rather than
only the domains those records use. A way whose ends you asked to be trimmed is
now trimmed by distance, a quarter kilometre from each end with an interpolated
endpoint, and the distance, ascent, descent and hours beside it are recomputed
from the trimmed shape. A way too short to lose both ends is refused rather
than handed over whole. Before this, a way of fewer than eight points was
handed over entire, which meant a two point straight line of any length left
with both its ends.

The page, its code and its typefaces come from the site's own host. Map tiles
and place searches go to CARTO and to OpenStreetMap's Nominatim, which see your
IP address and what you searched for, as any map would. The club, if joined,
receives a sealed envelope, keeps the one before it, and holds the minimum a
subscription needs: a key, a paid-until date, notice of cancellation, the
envelope's size and last-sealed time, and the Stripe subscription id.
