// atlas.spec.mjs — the app, driven in a real browser.
//
// Every test here exists because something got through the node tests. A
// control a keyboard could not reach shipped. A word pushed off a narrow
// screen shipped. A shared place travelled to the host. None of those are
// visible to a parser.

import { test, expect } from '@playwright/test';

// no test here may depend on a stranger's server being up, or on how fast it
// answers. tiles and the geocoder are cut, which is also the state a person on
// a train is in
const OFF = ['**://*.cartocdn.com/**', '**://*.openstreetmap.org/**', '**://tile.**'];

// arrive with an atlas already standing, past the film and the first-run door
async function open(page, { places = 3 } = {}) {
  for (const pattern of OFF) await page.route(pattern, r => r.abort());
  await page.addInitScript((n) => {
    const now = new Date().toISOString();
    const tags = [{ id: 't1', name: 'Nature', hue: 155, color: '#4a7' }];
    const places = Array.from({ length: n }, (_, i) => ({
      id: 'p' + i, name: 'Place ' + i, lat: 46 + i * 0.01, lng: 8 + i * 0.01,
      city: 'Basel', country: 'Switzerland', tags: ['t1'], status: 'visited',
      note: '', photos: [], createdAt: now, updatedAt: now,
    }));
    localStorage.setItem('resonate.places.v1', JSON.stringify(places));
    localStorage.setItem('resonate.tags.v1', JSON.stringify(tags));
    localStorage.setItem('resonate.settings.v1', JSON.stringify({
      theme: 'auto', chosen: true, seeded: true, introSeen: true,
      authorName: 'ada', hue: 300,
    }));
  }, places);
  await page.goto('/');
  await expect(page.locator('#threshold')).toBeHidden();
  // the film keeps enter, escape and space while it runs, as it should. a
  // person waits for it; so does this
  await expect(page.locator('#intro')).toBeHidden({ timeout: 15000 });
}

// is a worker active and holding this page? a share target that the worker
// does not control is served by the host instead, which is the whole failure.
// the first load can finish before the worker claims it, so the page is loaded
// again once and asked a second time. nothing here waits forever: a missing
// worker answers false rather than hanging the run out to its timeout
async function claimed(page) {
  const ask = () => page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise(r => setTimeout(() => r(null), 10000)),
    ]);
    return !!(reg && reg.active && navigator.serviceWorker.controller);
  });
  if (await ask()) return true;
  await page.reload();
  await expect(page.locator('#intro')).toBeHidden({ timeout: 15000 });
  return ask();
}

test('a place can be marked and kept with a keyboard alone', async ({ page }) => {
  await open(page);
  // no pointer is used past this line
  await page.keyboard.press('/');
  await page.locator('#paletteInput').fill('>mark');
  await expect(page.locator('.cmd-row').first()).toBeVisible();
  await page.keyboard.press('Enter');

  const form = page.locator('#addConfirm');
  await expect(form).toBeVisible();
  await expect(page.locator('#addConfirmInput')).toBeFocused();

  await page.keyboard.type('a bench with a view');
  await page.keyboard.press('Enter');

  await expect(form).toBeHidden();
  const kept = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('resonate.places.v1')).some(p => p.name === 'a bench with a view'));
  expect(kept).toBe(true);
});

test('the mark can be abandoned, and keeps nothing', async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('resonate.places.v1')).length);

  await page.keyboard.press('/');
  await page.locator('#paletteInput').fill('>mark');
  await expect(page.locator('.cmd-row').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#addConfirm')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#addConfirm')).toBeHidden();

  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('resonate.places.v1')).length);
  expect(after).toBe(before);
});

test('a nameless mark is never kept under a name nobody chose', async ({ page }) => {
  await open(page);
  await page.keyboard.press('/');
  await page.locator('#paletteInput').fill('>mark');
  await expect(page.locator('.cmd-row').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#addConfirmInput')).toBeFocused();

  // a name written and then taken back is still no name
  await page.locator('#addConfirmInput').fill('a thought');
  await page.locator('#addConfirmInput').fill('');
  await page.locator('#addConfirmGo').click();
  await expect(page.locator('#addConfirm')).toBeVisible();
  await expect(page.locator('#addConfirmStatus')).toContainText('give it a name');
});

// a test stood here that wrote a share straight into the inbox and then
// reloaded. it proved that a secret already on the device stays there, which
// was never the doubt. it could not have caught a worker that let the post
// through to the host, nor one that answered and then dropped the item on the
// floor. so the form a phone posts is posted here, by the browser, to the
// worker, and every claim below is about that one post.
//
// the app forbids form-action, and rightly: nothing in the app submits a form.
// a share sheet's post is not the app's form though. it is the browser's, made
// before any page of ours exists, and no page policy has a say in it. this one
// test stands where the share sheet stands, outside that rule.
test.describe('a place shared in from the phone', () => {
  test.use({ bypassCSP: true });

  test('is answered by the worker, kept on the device, and never put on the wire', async ({ page, request }) => {
    const secret = 'Kronenhalle-Ramistrasse-Zurich';
    const share = {
      title: secret,
      text: `a table by the window at ${secret}`,
      url: `https://www.google.com/maps/place/${secret}/@47.3686,8.5451,17z/data=!3d47.3686!4d8.5451`,
    };
    const outbound = [];
    // every attempt is recorded, including the ones the route table then cuts:
    // an address that was built is already a leak, whether or not it connected
    page.on('request', r => outbound.push(r.url()));

    // the host has no such door: asked directly, it says so. whatever answers
    // the post below is therefore not the host, and the app the browser lands
    // on is not what the host would have given back
    const knock = await request.post('/share-target', { multipart: { title: 'knock' } });
    expect(knock.status(), 'the host answered at the share target').toBe(404);

    await open(page);
    expect(await claimed(page), 'no service worker took control of the page').toBe(true);

    // the app lifts the share out of the inbox about a second after it opens,
    // so both the inbox and the address the browser landed on are read at
    // document start, before the app has had the chance to touch either
    await page.addInitScript(() => {
      window.__landed = location.href;
      window.__inbox = new Promise((resolve) => {
        let req;
        try { req = indexedDB.open('resonate-share', 1); } catch { return resolve([]); }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('shared')) db.createObjectStore('shared', { autoIncrement: true });
        };
        req.onsuccess = () => {
          try {
            const tx = req.result.transaction('shared', 'readonly');
            const all = tx.objectStore('shared').getAll();
            tx.oncomplete = () => resolve(all.result || []);
            tx.onabort = tx.onerror = () => resolve([]);
          } catch { resolve([]); }
        };
        req.onerror = () => resolve([]);
      });
    });

    // the share sheet's own request: a multipart post at the address the
    // manifest names, carrying the three fields it names
    await page.evaluate((fields) => {
      const f = document.createElement('form');
      f.method = 'POST';
      f.action = 'share-target';
      f.enctype = 'multipart/form-data';
      for (const [name, value] of Object.entries(fields)) {
        const i = document.createElement('input');
        i.type = 'hidden'; i.name = name; i.value = value;
        f.appendChild(i);
      }
      document.body.appendChild(f);
      // submitted on the next turn, so this call returns before the page goes
      setTimeout(() => f.submit(), 0);
    }, share);

    // the place is offered, by name. the address it opened with carried
    // nothing to build this from, so it came off this device or not at all
    await expect(page.locator('#plate .plate-name')).toHaveText(secret);

    const landed = await page.evaluate(() => window.__landed);
    // one digit for whether anything is waiting, and not a word of the place
    expect(landed, 'the redirect carried something of the share').toBe(`${new URL(landed).origin}/?shared=1`);

    // and the item is really there, whole, not merely acknowledged
    const inbox = await page.evaluate(() => window.__inbox);
    expect(inbox, 'the worker answered but kept nothing').toHaveLength(1);
    expect(inbox[0]).toMatchObject({ ...share, shortened: false });

    // a fetch the worker makes on its own behalf is the one shape the browser
    // will not report to a test. the two claims above stand in for it: the
    // answer was the worker's, and the place is here rather than anywhere else
    const leaked = outbound.filter(u => u.includes('Kronenhalle'));
    expect(leaked, `the shared place appeared in: ${leaked.join(', ')}`).toHaveLength(0);
  });
});

test('a poster keeps its close word on the narrowest screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await open(page);
  await page.locator('#fmIndex').click();
  await page.locator('[data-go="newsstand"]').click();
  const word = page.locator('#newsOverlay .poster-word');
  const close = page.locator('#newsOverlay .poster-x');
  await expect(word).toBeVisible();
  const [w, c, vw] = await Promise.all([
    word.boundingBox(), close.boundingBox(), page.evaluate(() => innerWidth),
  ]);
  expect(c.x + c.width).toBeLessThanOrEqual(vw);
  expect(w.x + w.width).toBeLessThanOrEqual(c.x);
});

test('a private archive comes home whole', async ({ page }) => {
  await open(page, { places: 1 });
  const restored = await page.evaluate(async () => {
    const { store } = await import('/js/store.js');
    store.load();
    const many = Array.from({ length: 501 }, (_, i) => ({
      id: 'big' + i, name: 'Big ' + i, lat: 46, lng: 8, tags: [], photos: [],
    }));
    store.merge({ version: 4, places: many, tags: [] }, { own: true });
    return store.places.length;
  });
  expect(restored).toBeGreaterThanOrEqual(502);
});

test('a place marked as never leaving is in no file a stranger is given', async ({ page }) => {
  await open(page);
  const leaked = await page.evaluate(async () => {
    const { store } = await import('/js/store.js');
    store.load();
    const secret = store.addPlace({ ...store.places[0], id: 'secret', name: 'My Own Door' });
    store.updatePlace('secret', { private: true });
    const out = [store.exportShareJSON(), store.exportGeoJSON(), store.exportKML(),
      store.exportCSV(), store.exportMarkdown()];
    return out.filter(t => t.includes('My Own Door')).length;
  });
  expect(leaked).toBe(0);
});

// the same word, on the other kind of record. it shipped honoured on places
// and ignored on ways in two of the five formats, which is the worst version
// of a promise: kept where it is looked for and broken where it is not
test('a way marked as never leaving is in no file a stranger is given', async ({ page }) => {
  await open(page);
  const found = await page.evaluate(async () => {
    const { store, newRoute } = await import('/js/store.js');
    store.load();
    const path = Array.from({ length: 12 }, (_, i) => ({ lat: 46 + i * 0.002, lng: 8 + i * 0.002 }));
    store.addRoute(newRoute({ id: 'w1', name: 'The Way Home', path, private: true }));
    store.addRoute(newRoute({ id: 'w2', name: 'A Way To Offer', path }));
    const out = {
      share: store.exportShareJSON(), kml: store.exportKML(),
      md: store.exportMarkdown(), geo: store.exportGeoJSON(), csv: store.exportCSV(),
    };
    return Object.fromEntries(Object.entries(out).map(([k, t]) =>
      [k, { secret: t.includes('The Way Home'), offered: t.includes('A Way To Offer') }]));
  });
  for (const [format, saw] of Object.entries(found)) {
    expect(saw.secret, `${format} carried the private way`).toBe(false);
  }
  // and the ones that carry ways at all still carry the offered one, or the
  // test would pass by exporting nothing
  expect(found.share.offered).toBe(true);
  expect(found.kml.offered).toBe(true);
  expect(found.md.offered).toBe(true);
});

test('every surface can be left by keyboard', async ({ page }) => {
  await open(page);
  for (const go of ['folio', 'census', 'yours', 'how']) {
    if (await page.locator('#indexOverlay').isHidden()) await page.locator('#fmIndex').click();
    await expect(page.locator('#indexOverlay')).toBeVisible();
    await page.locator(`[data-go="${go}"]`).click();
    const poster = page.locator('.poster:not([hidden])');
    await expect(poster).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(poster).toBeHidden();
    // the index stands beneath, which is the point: reading one thing does
    // not cost you the others
    await expect(page.locator('#indexOverlay')).toBeVisible();
  }
});
