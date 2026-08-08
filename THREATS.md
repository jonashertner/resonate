# The threat model

Sixteen questions a skeptical reader should ask about the travellers club, and
about the device it backs up, each answered against the code as it stands. The
wire format is in club/SPEC.md; the reporting channel is in SECURITY.md and
/.well-known/security.txt. Where a defence has a limit, the limit is stated
rather than rounded up.

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

## 13. Can two devices sealing at once erase one another?

A seal used to overwrite whatever was there, so two devices could read the
same envelope, merge it into their own atlas, and seal in turn: the second
erased the first, and the loser's records left no trace anywhere. The vault
now answers compare-and-swap. Every seal mints a revision of sixteen random
bytes, served as a strong ETag, and a PUT must say which envelope it believes
it is replacing: `If-Match: "<rev>"`, or `If-None-Match: *` for the first seal
into an empty vault. Sending neither header is 428, so a seal that says
nothing about what it replaces is refused rather than obeyed. A revision that
is no longer current is 412, carrying the current ETag; the client reads again, merges,
and seals over what the vault now holds. `If-Match: *` matches nothing on
purpose, because a star means "whatever is there", which is the licence the
guard exists to refuse. The revision is minted rather than derived from the
envelope, so the ETag answers nothing about the ciphertext to anyone who asks.

The limit, stated plainly: KV is eventually consistent, and reading the
revision and writing the envelope are two operations rather than one atomic
one. Two devices sealing in the same instant can both read the same revision,
both pass the check, and both write; the later write stands. In that case the
previous-envelope slot does not hold the loser either, because both writes
moved the same older envelope into it. What this closes is the
minutes-and-hours window, which is the one that happens: a device that read an
hour ago, or yesterday, and seals now is refused rather than obeyed. The
residue is bounded by the client rather than the server: the losing device
still holds its own records, the merge is additive (question 8), and they
return to the vault at its next seal.

## 14. What can a stranger holding a checkout session id do?

The door mints one key per subscription, once. Once meant once even when the
answer never arrived: a dropped connection on the way back from Stripe left a
paid membership with nobody holding its key, every retry answered 409, and
there was no way back. So the claim exists, and it belongs to the joining
device alone. Before the door is knocked on, the device mints a claim secret
of sixteen random bytes, keeps it in local storage, and never sends it. What
travels is `SHA-256("tc-claim:" + secret + ":" + session)`. The worker files
the minted key under that hash for 24 hours, enforced twice: the closing
moment sits inside the record, and the record is written with a 24 hour expiry
so the store forgets it as well. Presenting the same claim for the same
subscription inside the window returns the same key as often as it is asked.
Any other claim, or the right one after the window, is 409 and no key. The
three writes happen in one order, and the order is the recovery: the
membership, then the claim that can recover it, then the pointer marking the
subscription claimed. A worker that dies between any two of them leaves a door
that opens again.

So a stranger holding only the session id, after the paying device has
knocked, gets nothing: without the secret they compute no claim, the pointer
says the subscription is claimed, and the answer is 409. The limit is the
other side of that sentence, and it is real: before the paying device knocks,
a paid session id is the credential, and whoever presents it first with any
well-formed claim mints the key. That id lives in the return address the
paying browser is sent to, so the window is a race against the payer's own
browser on their own return, but it is a window. What it is not is a way into
an atlas: a key minted by a stranger opens a vault that is empty, and any
envelope sealed later is ciphertext under a phrase the stranger does not have.
The damage such a stranger can do is to take the membership, not to read it.

## 15. What can another app push into this one?

A place shared into the app from a phone's share sheet is the one thing that
must not go on the wire, so the POST share target is answered by the service
worker on the device. The title, the text and the address never leave, not
even as a request the host could log.

The worker bounds what it accepts. A body declaring more than 1 MB is refused
before it is parsed at all. Each field has its own ceiling, 2048 for the
address, 300 for the title, 2000 for the text, and the sum is bounded at 4096
as well, because the sum is what lands in the store. Fields are cut to their
own ceiling and then to whatever is left of the total, with the address served
first, since that is where the coordinates live. A record that had to be cut
carries a flag saying so, and the app says a share arrived in part rather than
pretending it arrived whole. Three blank fields are not a share and nothing is
written. A body that will not parse as a form writes nothing either.

The redirect honours what actually happened: `?shared=1` only when the write
succeeded and something is waiting, `?shared=0` when the worker kept nothing,
whether the body was oversize, unreadable, blank, or the store refused it. One
digit, and not a word of the place, in the address. The stated limit: the
megabyte ceiling is read off the declared content length, so a body that
arrives without one is parsed, and the field ceilings are what hold then.

## 16. What if this device's own store will not read?

A key whose JSON will not parse used to be caught and handed back as an empty
list. The app drew an empty atlas, and the very next edit wrote that emptiness
over the damaged bytes. One corrupt byte became a blank life, permanently, on
the next keystroke, and nobody was told.

Such a key is now quarantined. The damaged bytes are left exactly where they
are, a copy is set aside under a name that says what it is, and never over a
copy an earlier load already set aside; every write to that key is then
refused, through the same channel that reports a failed write, so the app
already knows how to say it out loud. It says it at first paint, before
anything else happens, and offers to export everything that still reads.

The consequence is deliberate and worth naming: a sealed key makes that part
of the app read-only until a person chooses. The rest of the atlas works. The
person can leave it, take the rescue export, or start that part fresh, and
starting fresh releases the seal without touching the copy set aside, because
moving on is not the same decision as destroying. The limits: the seal is held
for the session, so a reload reads the same damaged bytes and seals again,
which is the intent; setting the copy aside needs room, and a device with none
still leaves the original untouched; and a key that parses but holds wrong
values is not this case at all, which is the schema gate's work, not this one.
