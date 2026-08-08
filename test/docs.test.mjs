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
const spec = read('club/SPEC.md');
const security = read('SECURITY.md');
const readme = read('README.md');

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
