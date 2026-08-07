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
subscription. A **phrase** is the member's sealing passphrase; it never leaves
a device. An **envelope** is the sealed atlas. The **vault** is the club's
storage for one member: the current envelope and the **one before** it.
**seq** is a monotonic count inside the envelope.

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

## 7. Burn

`DELETE /vault` removes the current envelope, the one before, and the
metadata. The client then applies `burnPatch()`: seq returns to 0 and the
last-sealed time clears, so an empty vault is sealable again. The membership
key survives a burn; only "forget the key on this device" removes it locally.

## 8. The envelope before

Every successful seal demotes the previous current envelope to the `prev`
slot; the slot holds exactly one. `GET /vault?prev=1` returns it. Restoring
from it merges additively into the device and never deletes; nothing is sealed
until the member syncs again. This is the deliberate, member-initiated form of
rollback; the seq guard exists to refuse the involuntary form.

## 9. Limits and standing

The vault accepts envelopes up to 16000000 bytes and refuses smaller than 24.
Membership standing is `good` until the paid-until date plus three days of
grace, then `lapsed`: a lapsed member still reads and deletes, but does not
seal. `left` follows a completed cancellation. Keys are minted from 16 random
bytes into crockford base32 and never re-minted for the same subscription.

## 10. What the server stores

Five KV shapes, nothing else: `member:<key>` (subscription id, paid-until,
standing, notice-of-cancellation flag), `sub:<subscriptionId>` (the reverse
pointer), `vault:<key>`, `vault:<key>:prev`, `vaultmeta:<key>` (byte size,
sealed-at time). The worker keeps no request logs; Cloudflare's edge sees
requests as any host does. The full adversarial accounting lives in
THREATS.md at the repository root, published on the site.
