# The envelope, specified

This is the complete wire format and protocol of the travellers club, written
so that a skeptical reader can verify every claim against the code and the
bytes. The implementation is js/club.js on the client and club/src/worker.js
on the server. Nothing here is custom cryptography: key derivation and
authenticated encryption use WebCrypto and, for Argon2id, the vendored
hash-wasm library. Its digest is committed at vendor/argon2/SHA256SUMS, the
page loads it under a subresource integrity hash, and every push re-checks
the digest before the site can deploy.

## 1. Vocabulary

A **member** holds a **key** (`tc_` and twenty-some crockford characters),
minted by the door from a paid Stripe checkout session, exactly once per
subscription. A **claim** is the hash of a secret the joining device keeps, and
is what lets that device, and only that device, be told its key a second time.
A **phrase** is the member's sealing passphrase; it never leaves a device. An
**envelope** is the sealed atlas. The **vault** is the club's storage for one
member: the current envelope and the **one before** it. **seq** is a monotonic
count inside the envelope. A **revision** is the club's opaque name for the
envelope it currently holds, and is what a seal must name to replace it.

## 2. Envelope byte layout

Second form, written today:

```
offset  size  field
0       5     magic "rsnt2"
5       1     kdfId       1 = PBKDF2-SHA256, 2 = Argon2id
6       4     p0 u32le    kdfId 1: iterations · kdfId 2: memory KiB
10      1     p1          kdfId 2: passes (t), else 0
11      1     p2          kdfId 2: lanes (p), else 0
12      8     kid8        first 8 bytes of SHA-256("tc:" + key), zeros if unbound
20      16    salt        random per seal
36      12    iv          random per seal
48      ...   ciphertext  AES-GCM-256, 16-byte tag included
```

First form, read forever, written never (sealed before 2026-08-08):

```
"rsnt1" | salt16 | iv12 | ciphertext     PBKDF2-SHA256, 310000 iterations
```

## 3. Key derivation

The phrase is NFC-normalized, then:

- **kdfId 2, Argon2id** (write default when the vendored library is present
  and this device can run it): memory p0 KiB, passes p1, lanes p2, output 32
  bytes. Written today with m = 65536 KiB, t = 3, p = 1, per OWASP's first
  recommendation.
- **kdfId 1, PBKDF2-SHA256** (write fallback, and all rsnt1 envelopes):
  p0 iterations. Written today with 600000; rsnt1 envelopes carry 310000.
  A device whose WebAssembly will not run Argon2id seals in this dialect
  rather than failing, and the club room names the dialect each seal used.

Read-side bounds, refused as `not-an-envelope` outside them, so a hostile
header cannot spend the reader's memory or time: kdfId 1 iterations in
[100000, 5000000]; kdfId 2 memory in [8192, 262144] KiB, passes in [1, 10],
lanes in [1, 4].

Raising the write parameters is a one-line change; old envelopes keep opening
because the header, not the code, says how they were sealed.

## 4. Authenticated encryption

AES-GCM with a 256-bit key, 12-byte iv, 16-byte tag. For rsnt2, the
additional authenticated data (AAD) is the first 20 header bytes followed by
the UTF-8 bytes of the membership key the envelope is bound to (empty when
unbound). Consequences:

- KDF parameters cannot be quietly downgraded: a modified header fails the tag.
- An envelope bound to one membership cannot be replayed into another: the
  binding fails before decryption with `sealed-for-another-key` (via kid8),
  and would fail the tag even if kid8 were forged.

What the AAD deliberately does not bind: which vault slot the envelope sits in
(current or previous), the server's stored metadata (size, sealed-at), and
membership standing. rsnt1 envelopes carry no AAD.

## 5. Error taxonomy

`not-an-envelope` (wrong magic, an rsnt2 buffer under 49 bytes, an rsnt1
buffer under 49 bytes, or an out-of-bounds header) ·
`this-device-cannot-open-it` (an Argon2id envelope on a device without the
library, or one whose WebAssembly refuses to run: the envelope is intact and
another device opens it) ·
`sealed-for-another-key` (kid8 mismatch under a bound read) ·
`wrong-phrase` (authentication failure; also any tampering of salt, iv,
ciphertext, or header, and any rsnt1 buffer of 49 bytes or more that is
nonetheless truncated).

Those four are the reader's. The wire has its own, and every one of them is a
status code with a sentence beside it:

```
400  unreadable json; a session id that is not one; a claim that is not
     sixty-four lowercase hex characters; if-none-match with anything but a
     bare star; an envelope under 24 bytes
401  no key, or a key the club does not know
402  a lapsed membership sealing a new envelope
403  a checkout session that is unpaid, or is not a subscription
404  an empty vault, either slot; any other path
409  a subscription already claimed, presented without the claim that
     claimed it, or with it after its window has closed (section 9)
412  a seal naming a revision the vault no longer holds, or a creating seal
     into a vault that is not empty (section 10)
413  an envelope over 16000000 bytes
428  a seal naming no revision at all
```

## 6. The wrapper and seq

The plaintext is JSON: `{ v: 2, seq, sealedAt, atlas }`. Readers tolerate a
missing `v` (older wrappers) and a bare atlas (the oldest). `seq` sits inside
the authenticated ciphertext, so the server cannot alter it.

The sync refuses to write in exactly three cases, verbatim from the client:

1. The vault answers empty but this device has sealed before
   (`syncGuard(false, lastSeq > 0)`): a stale edge or a hollowed vault is
   never sealed over.
2. The vault returns an envelope with `seq` lower than this device has seen:
   an older envelope is never sealed over.
3. The device refuses the merge (storage rollback): the poorer atlas is never
   sealed over the richer envelope.

Otherwise the client merges additively, seals `max(remoteSeq, lastSeq) + 1`,
and records the new seq only after the server acknowledges the write.

Those three are the client's own, decided before anything is sent. A fourth is
the club's, decided at the moment of writing: a seal that names an envelope the
vault no longer holds is refused with 412, and the client reads again, merges
again, and seals over what it has now seen (section 10).

## 7. Burn

`DELETE /vault` removes the current envelope, the one before, and the
metadata. The client then applies `burnPatch()`: seq returns to 0 and the
last-sealed time clears, so an empty vault is sealable again. The membership
key survives a burn; only "forget the key on this device" removes it locally.

## 8. The envelope before

Every successful seal demotes the previous current envelope to the `prev`
slot; the slot holds exactly one. `GET /vault?prev=1` returns it, and carries
no ETag: the slot before is read and never written, so a revision naming it
would name a thing no PUT accepts. Restoring from it merges additively into
the device and never deletes; nothing is sealed until the member syncs again.
This is the deliberate, member-initiated form of rollback; the seq guard exists
to refuse the involuntary form.

## 9. The claim, and the answer that got lost

The door mints a key once per subscription. Once used to mean once even when
the answer never arrived: a dropped connection on the way back from Stripe left
a paid membership with nobody holding its key, every retry answered 409, and
there was no way back. The claim is the way back, and it is the joining
device's alone.

Before the door is knocked on, the device mints a **claim secret**: sixteen
random bytes in lowercase hex, kept in local storage under
`resonate.club.claim.v1` and never sent anywhere. What travels is

```
claim = lowercase hex of SHA-256( UTF-8( "tc-claim:" + secret + ":" + session ) )
```

sixty-four characters. The session is inside the hash, so one device joining
twice files two claims rather than writing over its own, and a stranger holding
the checkout session id computes nothing without the secret.

```
POST /door   { "session": "cs_…", "claim": "<64 hex>" }
     200     { "key": "tc_…", "until": <unix seconds> }
     200     { "key": "tc_…", "until": …, "again": true }   a second telling
```

The worker keeps `claim:<hash>` holding the minted key, the subscription id,
the paid-until, and the moment the window closes. The window is 24 hours,
enforced twice: the moment sits inside the record, and the record is written
with a 24 hour expiry so the store forgets it as well. Presenting the same
claim for the same subscription inside the window returns the same key as often
as it is asked. Presenting any other claim, or the right one after the window,
returns 409 and no key: from there the key itself is the only way in.

The three writes happen in one order, and the order is the whole recovery: the
membership first, then the claim that can recover it, then the `sub:` pointer
that marks the subscription claimed. A worker that dies between any two of them
leaves a door that opens again.

## 10. The revision, and two devices

`PUT /vault` used to overwrite whatever was there. Two devices could read the
same envelope, merge into their own atlas, and seal in turn; the second seal
erased the first, and the loser's records left no trace anywhere. The vault now
answers compare-and-swap.

Every seal mints a **revision**: sixteen random bytes in lowercase hex, stored
in `vaultmeta:<key>` and served as a strong ETag.

```
GET /vault        200, ETag: "<32 hex>", Cache-Control: no-store
PUT /vault        If-None-Match: *      the vault must be empty (the first seal)
                  If-Match: "<32 hex>"  the revision must be the current one
```

The envelope is served `no-store`, because an envelope read from a cache is an
envelope a device would then seal over with a revision that has already moved.
Exactly one of the two headers is required; If-Match is read first when both
are present. Neither present is 428. The condition failing is 412, and the
answer carries the current ETag when there is one, so the client knows there is
something to read. A successful PUT answers `{ bytes, at, rev }` and the new
ETag.

If-Match is compared as an exact string against `"<rev>"`. Two forms therefore
match nothing, on purpose: `W/"<rev>"`, because a weak comparison is no
comparison, and `If-Match: *`, because a star means "whatever is there", which
is a licence to overwrite, which is the thing the guard exists to refuse.

The revision is minted, not derived. An ETag computed from the envelope would
answer "is this still the envelope I hold a copy of" to anyone who asked;
random bytes answer nothing at all, and the club still never reads inside the
ciphertext to produce one. `DELETE /vault` takes the metadata with the
envelopes, so a burned vault has no revision and the next seal creates.

## 11. Limits and standing

The vault accepts envelopes up to 16000000 bytes and refuses smaller than 24.
Membership standing is `good` until the paid-until date plus three days of
grace, then `lapsed`: a lapsed member still reads and deletes, but does not
seal. `left` follows a completed cancellation. Keys are minted from 16 random
bytes into crockford base32 and never re-minted for the same subscription.

## 12. What the server stores

Six KV shapes, nothing else: `member:<key>` (subscription id, paid-until,
standing, notice-of-cancellation flag), `sub:<subscriptionId>` (the reverse
pointer), `claim:<hash>` (the minted key, the subscription id, the paid-until,
and when the window closes; gone after 24 hours), `vault:<key>`,
`vault:<key>:prev`, `vaultmeta:<key>` (byte size, sealed-at time, the
revision). The worker keeps no request logs; Cloudflare's edge sees
requests as any host does. The full adversarial accounting lives in
THREATS.md at the repository root, published on the site.
