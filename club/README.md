# The travellers club

The club keeps two things and knows almost nothing: a membership, which is a
key and "paid until when", and a vault, which is one sealed envelope per
member and the one before it.

The envelope is sealed on the member's device before it travels. The phrase
never leaves that device. The club cannot open what it keeps. What it holds
about a member, in full: the key, the Stripe subscription id, a paid-until
date, notice of cancellation, the envelope's size and the time it was last
sealed, and the envelope before it. No names, no addresses, no request logs. If the worker disappears, every atlas keeps living in its
browser; only the backup goes quiet.

## What it serves

```
POST /door         a paid Stripe checkout session becomes a key, exactly once
POST /stripe       Stripe's webhook: renewals arrive, lapses arrive
GET  /membership   good | lapsed | left, and until when
PUT  /vault        the sealed envelope, if-match the revision held
GET  /vault        the envelope back, and its revision. ?prev=1 for the one before
DELETE /vault      both envelopes, gone
```

A lapsed member still reads and deletes; only sealing anew asks for good
standing. Three days of grace follow every period, so a stumbling card does
not eat a backup.

The door takes a claim beside the session: the hash of a secret the joining
device keeps. An answer lost on a mobile network can be asked for again for a
day, and is answered with the same key; a stranger holding only the session id
still meets 409. The vault answers compare-and-swap: it names the envelope it
holds with an ETag, and a seal must say which envelope it is replacing, or it
is refused rather than obeyed. Both are specified byte for byte in SPEC.md.

## Opening the club (owner's steps, in order)

1. **Stripe.** Create a product "travellers club" with a recurring price.
   Create a Payment Link for it. Set its confirmation to redirect to
   `https://resonate.select/?club={CHECKOUT_SESSION_ID}`.
   Create a webhook endpoint pointed at `https://<worker-url>/stripe`
   subscribed to `invoice.paid`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Keep its signing secret.
   Make a restricted API key that can read Checkout Sessions and nothing else.

2. **Cloudflare.**
   ```bash
   cd club
   wrangler kv namespace create BOX     # put the id into wrangler.toml
   wrangler secret put STRIPE_SECRET
   wrangler secret put STRIPE_WEBHOOK_SECRET
   wrangler deploy
   ```

3. **The app.** Put the worker's url into `CLUB_URL` and the payment link
   into `JOIN_URL`, both in `js/club.js`. Bump the version, push.

## Trying it without any of that

```bash
node club/mock.mjs        # the pretended club, port 5179
```

In the app, set `settings.clubUrl` to `http://localhost:5179`, then paste
`cs_mock1` into the key field on the club page: the mock door opens for any
session that begins `cs_mock`. It speaks the same protocol as the worker,
claim and revision included, so a client that works against it works against
the club. The mock also answers `POST /lapse` with a member key, a lever the
real club does not have, for trying the lapsed state.

## Tests

```bash
node --test club/test/*.test.mjs
```

They hold the lines: keys mint into their own alphabet, standing honours the
period and the grace, the webhook only listens to Stripe and reads both the
old field shapes and the basil ones, the door opens once per subscription and
tells the same key again only to the claim that opened it, the window closes
after a day, the vault keeps exactly what it was given and refuses what is
unsealed, too small, too large, or sealed over an envelope the writer never
read.

## The specification

The envelope's exact bytes, the KDF parameters and their bounds, the AAD
binding, the seq refusal rules, and the burn state transition live in
SPEC.md beside this file, published on the site as /SPEC.md. The adversarial
accounting is THREATS.md at the repository root, published as /THREATS.md.

## The honest sentence

Lose the phrase and the envelope is lost with it. Nobody can open it for a
member, and that is the point.
