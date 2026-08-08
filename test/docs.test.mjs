// docs.test.mjs — the code and the documents must say the same thing.
//
// A privacy product whose security page contradicts its source is not making a
// cosmetic mistake. These assertions failed once, quietly, for two releases:
// the page said PBKDF2 while the envelope had moved to Argon2id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const club = read('js/club.js');
const worker = read('club/src/worker.js');
const spec = read('club/SPEC.md');
const security = read('SECURITY.md');
const readme = read('README.md');
const app = read('js/app.js');
const store = read('js/store.js');
const schema = read('js/schema.js');
const sw = read('sw.js');

test('the envelope written by the code is the one the documents describe', () => {
  // what the code actually does
  assert.ok(/MAGIC2 = new TextEncoder\(\)\.encode\('rsnt2'\)/.test(club), 'rsnt2 is the written form');
  assert.ok(/ARGON2_M = 65_536/.test(club), 'argon2id at 64 MiB');
  assert.ok(/ROUNDS_WRITE = 600_000/.test(club), 'pbkdf2 fallback at 600000');

  for (const [name, doc] of [['SPEC', spec], ['SECURITY', security]]) {
    assert.ok(/[Aa]rgon2id/.test(doc), `${name} names argon2id`);
    assert.ok(/64 MiB|65536|65_536/.test(doc), `${name} names the memory cost`);
    assert.ok(/600000|600,000|600_000/.test(doc), `${name} names the pbkdf2 fallback count`);
    assert.ok(/rsnt2/.test(doc) || /second form/.test(doc), `${name} names the current envelope`);
  }
});

test('no document still calls pbkdf2 the current default', () => {
  for (const [name, doc] of [['SECURITY', security], ['SPEC', spec]]) {
    const sentences = doc.split(/(?<=\.)\s+/);
    const wrong = sentences.filter(x =>
      /PBKDF2/.test(x) && /(sealed on the device|is what seals|current default)/i.test(x)
      && !/fallback|older|before this|legacy/i.test(x));
    assert.deepEqual(wrong, [], `${name} still presents pbkdf2 as the default`);
  }
});

test('the door and the vault answer as the spec says they answer', () => {
  // the claim is hashed under one label and kept in one place, and the spec
  // is where a member's own client would be written from
  assert.ok(/tc-claim:/.test(club), 'the client hashes the claim under its label');
  assert.ok(/tc-claim:/.test(spec), 'and the spec names the same label');
  assert.ok(/resonate\.club\.claim\.v1/.test(club) && /resonate\.club\.claim\.v1/.test(spec),
    'the secret is kept where the spec says it is kept');
  assert.ok(/CLAIM_TTL_S = 24 \* 3600/.test(worker), 'the window is a day in the code');
  assert.ok(/24 hours/.test(spec), 'and a day in the spec');

  // every refusal the wire can answer is written down as a refusal
  for (const code of ['409', '412', '428']) {
    assert.ok(new RegExp(`\\b${code}\\b`).test(worker), `the worker answers ${code}`);
    assert.ok(new RegExp(`\\b${code}\\b`).test(spec), `and the spec names ${code}`);
  }
  assert.ok(/if-match/.test(worker) && /If-Match/.test(spec), 'the seal names what it replaces');
  assert.ok(/if-none-match/.test(worker) && /If-None-Match/.test(spec), 'and says when it replaces nothing');

  // this one is not documentation but survival: a browser sees neither the
  // etag nor the precondition unless the worker says so, and a vault whose
  // revision is invisible can be written exactly once
  assert.ok(/'access-control-expose-headers': 'x-sealed-at,etag'/.test(worker), 'the etag reaches the client');
  assert.ok(/'access-control-allow-headers': '[^']*if-match,if-none-match'/.test(worker), 'and the preconditions reach the club');
});

test('the readme does not promise a product the code no longer is', () => {
  assert.ok(!/five stars|five-star/i.test(readme), 'the rating is gone from the product');
  assert.ok(!/No account, no server, no build step/.test(readme),
    'the club is a server of ours, and the readme must qualify the claim');
  for (const format of ['GeoJSON', 'KML', 'CSV', 'Markdown', 'GPX']) {
    assert.ok(new RegExp(format, 'i').test(readme), `the readme names ${format}, which the app exports`);
  }
});

test('the shipped policy speaks only to addresses that exist', () => {
  const html = read('index.html');
  const csp = /content="([^"]*default-src[^"]*)"/.exec(html)?.[1] || '';
  assert.ok(csp, 'there is a policy at all');
  assert.ok(!/localhost/.test(csp), 'no development address ships to readers');
  assert.ok(/script-src 'self' 'wasm-unsafe-eval'/.test(csp), 'wasm is allowed for argon2id, and said so in THREATS');
  assert.ok(/font-src 'self'/.test(csp), 'the typefaces come from this site');
});

test('the share target keeps what is shared off the wire', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.share_target.method, 'POST',
    'a GET share target puts the shared place in a request the host can see');
  assert.ok(/share-target/.test(read('sw.js')), 'and the worker intercepts it');
});

// Every place this app writes to is a place a person may need to find, empty,
// or rescue by hand. A key the readme does not name is a key nobody knows to
// look for, which is the whole problem with a quarantine nobody was told about.
test('the readme names every place this app keeps something', () => {
  for (const name of ['places', 'routes', 'folios', 'tags', 'correspondents', 'settings']) {
    assert.ok(new RegExp(`'resonate\\.${name}\\.v1'`).test(store), `store.js keeps ${name}`);
    assert.ok(new RegExp(`\\.${name}\\.v1`).test(readme), `and the readme names the ${name} key`);
  }

  // the quarantine: damaged bytes are set aside under a name, and refused
  assert.ok(/`\$\{key\}\.unreadable`/.test(store), 'store.js sets the damaged bytes aside');
  assert.ok(/\.unreadable/.test(readme), 'and the readme names the quarantine key');
  assert.ok(/\.unreadable/.test(security), 'and security says what it is for');

  // the share inbox is a second database, and an erase has to reach it
  assert.ok(/INBOX_DB = 'resonate-share'/.test(sw), 'the worker writes the inbox');
  assert.ok(/SHARE_DB = 'resonate-share'/.test(app), 'and the app reads the same one');
  assert.ok(/deleteDatabase\(SHARE_DB\)/.test(app), 'and an erase deletes it');
  assert.ok(/resonate-share/.test(readme), 'and the readme names the inbox database');

  // the two remaining keys, which used to be nowhere in the documents
  assert.ok(/INBOX_KEY = 'resonate\.inbox\.v1'/.test(app) && /resonate\.inbox\.v1/.test(readme),
    'the readme names the share inbox key');
  assert.ok(/CLAIM_STORE = 'resonate\.club\.claim\.v1'/.test(club) && /resonate\.club\.claim\.v1/.test(readme),
    'the readme names where the club claim secret is kept');

  // and the photograph store, which is the one that holds the room
  assert.ok(/const DB = 'resonate'/.test(read('js/photos.js')), 'photographs live in `resonate`');
  assert.ok(/IndexedDB\s+`resonate`/.test(readme), 'and the readme says so');
});

// Import was one operation under a word that promised two. A document that
// still describes it as one is telling a person their backup can restore.
test('the readme describes both halves of import, not just the merge', () => {
  assert.ok(/bring\s+in\s+what\s+is\s+missing/i.test(app) && /make\s+this\s+atlas\s+the\s+file/i.test(app),
    'the app offers both words');
  assert.ok(/bring\s+in\s+what\s+is\s+missing/i.test(readme), 'and the readme names the merge');
  assert.ok(/make\s+this\s+atlas\s+the\s+file/i.test(readme), 'and the readme names the replace');
  assert.ok(/store\.restore\(/.test(app) && /restore\(raw\)/.test(store),
    'the replace is a restore, not a merge with extra steps');
  assert.ok(/snapshot/i.test(readme), 'and the readme says a snapshot is taken first');
});

// The club is add-only. Any document that lets a reader believe otherwise is
// promising that a deletion travels, and it does not.
test('no document sells the club as synchronisation', () => {
  // what the code does: an envelope comes home through the additive merge
  assert.ok(/bringHome\(atlas\)/.test(app), 'an envelope comes home through bringHome');
  assert.ok(/merge\(staged\.atlas, \{ own: true \}\)/.test(app),
    'and bringHome without replace is a merge, which only adds');

  for (const [name, doc] of [['README', readme], ['SECURITY', security]]) {
    const sentences = doc.split(/(?<=\.)\s+/);
    const wrong = sentences.filter(x =>
      /synchronis|synchroniz|\bsync\b|\bsyncs\b/i.test(x)
      && !/\bnot\b|\bno\b|\bnever\b|rather than|instead of/i.test(x));
    assert.deepEqual(wrong, [], `${name} lets a reader believe the club synchronises`);
    assert.ok(/add-only|add\s+only/i.test(doc), `${name} says the envelope is add-only`);
    assert.ok(/encrypted\s+backup/i.test(doc), `${name} says it is an encrypted backup`);
    assert.ok(/deletion/i.test(doc), `${name} says what happens to a deletion`);
  }
});

// The bounds in sw.js are the only thing between a share sheet and the store.
// A document naming different numbers is documenting a build that is not this
// one, which is how a reader ends up trusting a ceiling that was never there.
test('security names the ceilings the share target actually enforces', () => {
  const caps = /const CAP = \{ url: (\d+), title: (\d+), text: (\d+) \};/.exec(sw);
  assert.ok(caps, 'the worker bounds each field');
  const total = /const CAP_TOTAL = (\d+);/.exec(sw);
  assert.ok(total, 'and bounds the three together');
  for (const n of [caps[1], caps[2], caps[3], total[1]]) {
    assert.ok(new RegExp(`\\b${n}\\b`).test(security), `SECURITY names the ceiling ${n}`);
  }
  assert.ok(/const CAP_BODY = 1024 \* 1024;/.test(sw), 'a body past a megabyte is not parsed');
  assert.ok(/1\s+MB|1024\s*\*\s*1024|one\s+megabyte/i.test(security), 'and SECURITY names that too');

  // the digit in the address is the truth about whether anything was kept
  assert.ok(/kept \? '\?shared=1' : '\?shared=0'/.test(sw), 'the redirect honours the write');
  assert.ok(/shared=1/.test(security) && /shared=0/.test(security),
    'and SECURITY names both digits');
});

// Two devices, one vault. The preconditions are the whole defence.
test('security describes the vault the worker actually implements', () => {
  assert.ok(/if-match/.test(worker), 'the worker requires a precondition');
  assert.ok(/If-Match/.test(security), 'and SECURITY names it');
  assert.ok(/If-None-Match/.test(security), 'and names the create case');
  for (const code of ['412', '428']) {
    assert.ok(new RegExp(`\\b${code}\\b`).test(worker), `the worker answers ${code}`);
    assert.ok(new RegExp(`\\b${code}\\b`).test(security), `and SECURITY names ${code}`);
  }
  // the star form is refused on purpose, and that is a claim worth holding
  assert.ok(/star form of `?If-Match`?: \*` is deliberately not honoured|star form of if-match is deliberately not honoured/i.test(worker),
    'the worker refuses If-Match: *');
  assert.ok(/If-Match:\s*\*` is\s+(deliberately\s+)?not\s+honoured/.test(security),
    'and SECURITY says so');
});

// A claim that cannot be presented again is a key lost to a flat battery.
test('security describes the claim the door actually accepts', () => {
  assert.ok(/CLAIM_TTL_S = 24 \* 3600/.test(worker), 'the window is a day in the code');
  assert.ok(/24\s+hours/.test(security), 'and a day in SECURITY');
  assert.ok(/tc-claim:/.test(club) && /tc-claim:/.test(security), 'SECURITY names the label');
  assert.ok(/getRandomValues\(new Uint8Array\(16\)\)/.test(club), 'the secret is 128 bits');
  assert.ok(/128\s+bit/i.test(security), 'and SECURITY says how big it is');
  assert.ok(/\b409\b/.test(worker) && /\b409\b/.test(security),
    'SECURITY names what anyone else presenting that session gets');
});

// The witness exists so that nothing is ever cut in silence. If a bound creeps
// back into an own archive the witness fires, and the document has to be the
// place a person can read that promise before they trust a restore.
test('security states the promise the witness makes about an own archive', () => {
  assert.ok(/const ALL = Infinity;/.test(schema), 'own caps are unbounded');
  assert.ok(/export const OWN = \{[^}]*\}/s.test(schema), 'and they are named together');
  const own = /export const OWN = \{([^}]*)\}/s.exec(schema)[1];
  assert.ok(!/\d/.test(own), 'no number has crept back into an own archive');
  assert.ok(/refused\s+whole/i.test(security), 'SECURITY says a lossy archive is refused, not shortened');
  assert.ok(/witness/i.test(security), 'and names the thing that notices');
});

// The three limits this release did not fix. Saying so is the product.
test('security still states the limits rf67 did not lift', () => {
  // structured records really are still in localStorage, one string each
  assert.ok(/localStorage\.setItem\(key, JSON\.stringify\(value\)\)/.test(store),
    'a collection is written as one string');
  assert.ok(/localStorage/.test(security), 'SECURITY says where records live');
  assert.ok(/whole\s+collection/i.test(security),
    'and that a change rewrites the whole collection');
  assert.ok(/two\s+tabs/i.test(security), 'and that two tabs coordinate only after a write');

  assert.ok(/no\s+independent\s+audit|not\s+been\s+audited|nobody\s+outside/i.test(security),
    'SECURITY says there is no independent audit');
});
