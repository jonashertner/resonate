# The threat model

Twelve questions a skeptical reader should ask about the travellers club, each
answered against the code as it stands. The wire format is in club/SPEC.md;
the reporting channel is in SECURITY.md and /.well-known/security.txt. Where a
defence has a limit, the limit is stated rather than rounded up.

## 1. What does the club's server see?

Per member: the membership key, the Stripe subscription id, a paid-until date,
a notice-of-cancellation flag, the sealed envelope and the one before it, each
envelope's byte size, and the time of the last seal. Per request: whatever an
HTTP request carries, for the duration of the request; the worker stores none
of it. It never sees a place, a note, a photograph, a phrase, or a name.

## 2. What does the hosting provider see?

Two providers. GitHub Pages serves the static app: it sees the IP, user agent,
and which files it hands over, as any host does; the atlas never reaches it.
Cloudflare runs the club worker: its edge sees each request's metadata and
could log it under Cloudflare's own policies, outside our control. The
envelope passing through is ciphertext either way.

## 3. What does the payment processor see?

Stripe holds the member's name, card and email; that is Stripe's business. The
club holds only the subscription id. The linkage is real: if Stripe were made
to answer for a subscription id, the id in the club's records could connect a
vault to a person. Stated on the how page in the same words.

## 4. What if the club's database is stolen?

The thief holds ciphertext and the metadata of question 1. Opening an envelope
means guessing its phrase offline against Argon2id at 64 MiB and three passes,
or against PBKDF2 at 600000 iterations where a device could not run Argon2id
and at 310000 for envelopes sealed before this format. The club room names
which dialect sealed the envelope it holds. A strong phrase makes
this impractical; a weak one does not, and no server-side control can help,
because the server never sees the phrase. The floor is eight characters; the
guidance says longer, in words.

## 5. What if the application's JavaScript is compromised?

This is the trust root, and no cryptography beneath it survives it. A hostile
deploy could read the atlas and the phrase as it is typed. The mitigations
that exist: no third-party script and no analytics; every dependency vendored
into the repository and served from the site's own origin, the Argon2id
library additionally pinned by committed digest, re-checked in CI, and loaded
under a subresource integrity hash; a strict content security policy; tests
and a parse gate in CI before any deploy; a no-build codebase a reader can
inspect as served. One deliberate widening: the policy permits WebAssembly
compilation, which Argon2id needs. It permits no external script, so only
code already served from this origin can use it. The residual risk is the operator's
deploy pipeline, and honesty requires saying that plainly.

## 6. What about a weak recovery phrase?

The envelope is only as strong as its phrase (question 4). The club cannot
check phrase strength because it never sees the phrase. The client enforces
only a floor and asks for words rather than characters.

## 7. Can the club roll a member back to an older envelope?

Not silently, for a device that has sealed before: the count inside the sealed
wrapper is monotonic, and the client refuses an envelope older than it has
seen, refuses an empty vault over a history of sealing, and refuses to seal
over anything it could not merge. The stated limit: a brand-new device has no
history and would accept whatever the vault serves. The member-initiated form
of rollback exists on purpose: the envelope before, in the club room.

## 8. Can one device corrupt another's atlas?

The merge is additive by identifier and rolls back whole when the device
refuses a write, so a sync cannot delete places and a failed sync cannot leave
a half-written atlas. A hostile envelope body passes the same schema gate as
any share link.

## 9. How do deletions synchronise?

They do not, and this is stated in the app rather than hidden: the envelope is
a backup, not a ledger. A place removed on one device returns from an envelope
sealed on another; erase-then-sync restores the atlas, which is the backup
working as promised. The only true deletions are burning the envelopes and
erasing each device.

## 10. What remains after a subscription lapses?

Sealing stops after the paid-until date plus three days of grace. Reading and
deleting continue: the envelope stays the member's whatever the standing. The
envelopes persist until the member burns them.

## 11. What about the server's own backups?

KV deletion takes effect at the API; replicas converge on it. Cloudflare's
infrastructure may retain bytes briefly beyond that, under its own policies.
Those bytes are ciphertext, and question 4 applies to them.

## 12. Can support identify a member?

There are no accounts and no names on our side, but the chain exists and
honesty requires naming it: the club operates the Stripe account, Stripe's
dashboard maps a name or email to a subscription id, and the club's own
storage maps that subscription id to a key, and the key to a vault. Support
can therefore find which vault belongs to a paying person, using its own
credentials, without compulsion. What support can never do is open an
envelope or reset a phrase; those keys exist only on members' devices.
