// @ts-check
// The homestar's shelves row (HomestarShelves.js) against a LIVE server, with the wiki listing, the
// Books and Music worlds and their libraries stubbed in the browser: On the shelf (book spines, the
// record on the turntable, who may see it), Sky tonight (the real moon for today, and the moon picture's geometry
// checked by drawing it), the six newest wiki pages (order, ages, a click opening the page, and no
// card at all when there are none), and the grid (side by side when wide, stacked on a phone, always
// under the columns, never a horizontal scrollbar).
//
// Registers one throwaway `hometest_*` account and opens its own homestar; see
// account-lifecycle.spec.js on pruning the reserved handles.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });

/** @type {any} */ let A = null;
/** @type {any[]} */ let wikiPages = [];
const DAY = 86400000;

const page = (name, daysAgo) => ({
  objId: "W" + name, wikiName: name, category: null, tags: [],
  updatedAt: new Date(Date.now() - daysAgo * DAY).toISOString(), createdAt: "2026-01-01T00:00:00.000Z",
});

test.beforeAll(async ({ browser }) => {
  test.setTimeout(200 * 1000);
  A = await newAccount(browser, "hometest_sh" + Math.random().toString(36).slice(2, 6));
  // no Transit card: the owner would otherwise get its prompt, a fifth card that narrows the row
  await A.page.route(new RegExp("/@" + A.handle + "/transit$"), (route) => route.fulfill({ json: { station: null, isOwner: false, locked: true } }));
  await A.page.route(new RegExp("/@" + A.handle + "/wiki-card$"), (route) => route.fulfill({ json: { pages: wikiPages, isOwner: true, hiddenCount: 0 } }));
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (A) await A.context.close();
});

const worldText = () => A.page.evaluate(() => { const out = []; if (typeof $world === "undefined" || !$world) return out; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
const shows = (/** @type {string} */ s) => expect.poll(async () => (await worldText()).includes(s), { timeout: 30000 }).toBe(true);
/** The page rectangles of the named cards' panels (the Box that holds the header text). */
const panelRect = (/** @type {string} */ title) => A.page.evaluate((t) => {
  let hit = null;
  if (typeof $world === "undefined" || !$world) return null;
  $world.withAllSubmorphsDo((m) => { if (m.textString === t && m.owner && m.owner.owner === $world) hit = m.owner; });
  if (!hit) return null;
  const r = hit.renderContext().shapeNode.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, bottom: r.bottom };
}, title);

test("Sky tonight shows today's real moon and the profile's signs", async () => {
  wikiPages = [];
  await A.page.goto("/@" + A.handle);
  await shows("Sky tonight");
  const expected = await A.page.evaluate(() => {
    const mp = lively.identity.SkyWidget._astro.moonPhase(new Date());
    return { name: mp.name, lit: Math.round(mp.illumination * 100) + "% lit" };
  });
  const text = await worldText();
  expect(text).toContain(expected.name);
  expect(text).toContain(expected.lit);
  expect(text.some((t) => /^(Full|New) moon (today|in \d+ days?)$/.test(t))).toBe(true);
  // a fresh account has no signs; one with them gets a line of the three
  const signsLine = await A.page.evaluate(() => {
    const card = lively.identity.HomestarShelves.sky({ sunSign: "Leo", moonSign: "Pisces", risingSign: "Virgo" });
    const box = card.build(0, 0, 300, card.h);
    const out = [];
    box.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); });
    return out.find((s) => /Leo/.test(s));
  });
  expect(signsLine).toMatch(/Leo.*Pisces.*Virgo/);
});

test("the moon picture lights the right side when waxing, the left when waning", async () => {
  // Draw the real data URL and read pixels: lit pixels are light, the dark part is deep violet.
  const px = await A.page.evaluate(async () => {
    const S = 64;
    async function sample(f) {
      const img = new Image();
      img.src = lively.identity.HomestarShelves.moonSvg(f, S);
      await img.decode();
      const c = document.createElement("canvas"); c.width = c.height = S;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const lum = (x, y) => { const d = g.getImageData(x, y, 1, 1).data; return d[0] + d[1] + d[2]; };
      return { left: lum(S * 0.3, S / 2), right: lum(S * 0.7, S / 2), centre: lum(S / 2, S / 2) };
    }
    return { fq: await sample(0.25), lq: await sample(0.75), nm: await sample(0.001), fm: await sample(0.5), wxc: await sample(0.1), wxg: await sample(0.4) };
  });
  const LIT = 600;   // the lit colour sums to ~ 700; the dark disc to ~ 140
  expect(px.fq.right).toBeGreaterThan(LIT); expect(px.fq.left).toBeLessThan(LIT);
  expect(px.lq.left).toBeGreaterThan(LIT);  expect(px.lq.right).toBeLessThan(LIT);
  expect(px.nm.left).toBeLessThan(LIT);     expect(px.nm.right).toBeLessThan(LIT);
  expect(px.fm.left).toBeGreaterThan(LIT);  expect(px.fm.right).toBeGreaterThan(LIT);
  // a thin waxing crescent lights the right only near the rim; a waxing gibbous lights the centre
  expect(px.wxc.centre).toBeLessThan(LIT);
  expect(px.wxg.centre).toBeGreaterThan(LIT);
});

test("no wiki card without pages; with pages, the six newest in order with their ages", async () => {
  expect(await worldText()).not.toContain("Wiki pages");
  wikiPages = [page("Oldest", 400), page("Seventh", 90), page("Newest", 0), page("Third", 20), page("Second", 3), page("Fourth", 30), page("Fifth", 45), page("Sixth", 60)];
  await A.page.goto("/@" + A.handle);
  await shows("Wiki pages");
  const text = await worldText();
  const names = ["Newest", "Second", "Third", "Fourth", "Fifth", "Sixth"].map((n) => text.indexOf(n));
  expect(names.every((i) => i > 0)).toBe(true);
  expect(names.every((v, i) => i === 0 || names[i - 1] < v)).toBe(true);
  expect(text).not.toContain("Seventh");   // the seventh and the oldest are left off
  expect(text).not.toContain("Oldest");
  expect(text).toContain("just now");
  expect(text).toContain("3 days ago");
  expect(text).toContain("3 weeks ago");
});

test("a wiki row opens that page", async () => {
  const urls = [];
  await A.page.route(new RegExp("/@" + A.handle + "/wiki/Second$"), (route) => { urls.push(route.request().url()); return route.fulfill({ body: "<html>stub</html>", contentType: "text/html" }); });
  await A.page.waitForTimeout(1500);               // let the page's fetches land: each redraw rebuilds the rows
  const tagged = await A.page.evaluate(() => {
    let row = null;
    $world.withAllSubmorphsDo((m) => { if (m.textString === "Second") row = m.owner; });
    if (!row) return 0;
    row.renderContext().shapeNode.setAttribute("data-pw", "wiki-second");
    return 1;
  });
  expect(tagged).toBe(1);
  await Promise.all([A.page.waitForURL(/\/wiki\/Second$/), A.page.locator('[data-pw="wiki-second"]').click()]);
  expect(urls.length).toBe(1);
});

test("the cards sit side by side under the columns when wide, and stack on a phone, with no sideways scroll", async () => {
  await A.page.setViewportSize({ width: 1400, height: 900 });
  await A.page.goto("/@" + A.handle);
  await shows("Wiki pages");
  await expect.poll(() => panelRect("Sky tonight")).not.toBeNull();
  const sky = await panelRect("Sky tonight"), wiki = await panelRect("Wiki pages");
  expect(Math.abs(sky.y - wiki.y)).toBeLessThan(1);                    // one row
  expect(sky.x).toBeGreaterThan(wiki.x + wiki.w - 1);                  // side by side, the wiki first
  // under the tallest column: below the worlds panel and the orbit panel
  const above = await A.page.evaluate(() => {
    let b = 0;
    $world.withAllSubmorphsDo((m) => {
      if (["Orbit", "Worlds"].indexOf(m.textString) >= 0 && m.owner && m.owner.owner === $world) {
        b = Math.max(b, m.owner.renderContext().shapeNode.getBoundingClientRect().bottom);
      }
    });
    return b;
  });
  expect(sky.y).toBeGreaterThan(above);

  await A.page.setViewportSize({ width: 390, height: 800 });
  await A.page.goto("/@" + A.handle);
  await shows("Wiki pages");
  await expect.poll(async () => { const s = await panelRect("Sky tonight"), w = await panelRect("Wiki pages"); return s && w && s.y > w.bottom; }).toBe(true);
  const over = await A.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
});

// ─── On the shelf ───────────────────────────────────────────────────────────

/** The objects the stubbed Books / Music worlds and their libraries are made of, by object id. */
/** @type {{worlds: any[], objects: Record<string, any>} | null} */
let shelfStub = null;
let ownDid = "";

const env = (type, did, objId, payload, state) => ({
  objId, did, type, visibility: "public", state: state || {}, created: "2026-10-01T00:00:00.000Z",
  record: { cid: "c" + objId, payload },
});

/** The stubbed answers, on any page (the owner's or a signed-out visitor's). */
async function installShelfStubs(/** @type {any} */ page) {
  await page.route(new RegExp("/@" + A.handle + "/worlds$"), async (route) => {
    if (!shelfStub) return route.continue();
    const j = await (await route.fetch()).json();
    j.worlds = j.worlds.concat(shelfStub.worlds);
    return route.fulfill({ json: j });
  });
  await page.route(new RegExp("/@" + A.handle + "/(BWORLD1|MWORLD1|BLIB001|MLIB001|BOOK00\\d|ALBUM0\\d)$"), (route) => {
    const accept = route.request().headers()["accept"] || "";
    if (!/json/.test(accept)) return route.fulfill({ body: "<html>stub page</html>", contentType: "text/html" });
    const id = route.request().url().split("/").pop();
    const o = shelfStub && shelfStub.objects[/** @type {string} */ (id)];
    return o ? route.fulfill({ json: o }) : route.fulfill({ status: 404, json: { error: "nope" } });
  });
}

/** A library with these object ids, newest last, as the Books / Music templates save it. */
const folderOf = (id, refType, ids, did) => env("folder", did || ownDid, id, {
  name: "Library", albums: [],
  files: ids.map((r, i) => ({ id: "p" + i, type: "pointer", refType, refObjId: r })),
});

function booksStub(/** @type {any=} */ extra) {
  const objects = {
    BWORLD1: env("world", ownDid, "BWORLD1", { booksLibraryObjId: "BLIB001", booksLibraryHandle: A.handle }),
    BLIB001: folderOf("BLIB001", "book", ["BOOK001", "BOOK002", "BOOK003", "BOOK004", "BOOK005"]),
    BOOK001: env("book", ownDid, "BOOK001", { title: "Reading Now", author: "Author One", shelf: "reading" }),
    BOOK002: env("book", ownDid, "BOOK002", { title: "Finished One", author: "Author Two", shelf: "read" }),
    BOOK003: env("book", ownDid, "BOOK003", { title: "Wanted", author: "", shelf: "want" }),
    BOOK004: env("book", ownDid, "BOOK004", { title: "Ghost", shelf: "read" }, { deleted: true }),
    BOOK005: env("book", "did:key:someone-else", "BOOK005", { title: "Alien", shelf: "read" }),
  };
  return Object.assign(objects, extra || {});
}
function musicStub(/** @type {any[]} */ albums, /** @type {any=} */ morph) {
  /** @type {Record<string, any>} */
  const objects = {
    MWORLD1: env("world", ownDid, "MWORLD1", Object.assign({ musicLibraryObjId: "MLIB001", musicLibraryHandle: A.handle }, morph || {})),
    MLIB001: folderOf("MLIB001", "album", albums.map((_, i) => "ALBUM0" + (i + 1))),
  };
  albums.forEach((a, i) => { objects["ALBUM0" + (i + 1)] = env("album", ownDid, "ALBUM0" + (i + 1), a); });
  return objects;
}
const world = (id, name, template) => ({ objId: id, name, template, visibility: "public", created: "2026-10-02T00:00:00.000Z" });
const BW = world("BWORLD1", "My Books", "books"), MW = world("MWORLD1", "My Music", "music");

/** The book spines on the page (image morphs with a tooltip and a click handler), left to right. */
const spineTips = () => A.page.evaluate(() => {
  const out = [];
  if (typeof $world === "undefined" || !$world) return out;
  $world.withAllSubmorphsDo((m) => {
    if (m.toolTip && m.onMouseUp && m.getImageURL && /svg/.test(m.getImageURL() || "")) {
      const p = m.worldPoint(lively.pt(0, 0));
      out.push({ tip: m.toolTip, x: p.x, y: p.y });
    }
  });
  return out.sort((a, b) => a.x - b.x);
});
const vinylNode = () => A.page.evaluate(() => {
  let n = null;
  if (typeof $world === "undefined" || !$world) return null;
  $world.withAllSubmorphsDo((m) => {
    const node = m.renderContext && m.renderContext().shapeNode;
    if (node && node.classList && node.classList.contains("homestar-vinyl-spin")) n = node;
  });
  if (!n) return null;
  const cs = getComputedStyle(n);
  const r = n.getBoundingClientRect();
  return { animation: cs.animationName, transform: cs.transform, x: r.left, y: r.top };
});
/** Opens the owner's page with the given stubs. */
async function openWith(/** @type {any} */ stub, /** @type {number=} */ width) {
  shelfStub = stub;
  await A.page.setViewportSize({ width: width || 1400, height: 900 });
  await A.page.goto("/@" + A.handle);
}

test("On the shelf: spines (reading first, deleted and foreign books left out) and the record spinning", async () => {
  ownDid = await A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/profile", { credentials: "include" })).json()).did, A.handle);
  await installShelfStubs(A.page);
  wikiPages = [];
  await openWith({
    worlds: [BW, MW],
    objects: Object.assign(booksStub(), musicStub([
      { title: "Old Favourite", artist: "Someone", shelf: "listened" },
      { title: "Spin Me", artist: "The Discs", shelf: "listening", coverUrl: "/no-such-cover.png" },
    ])),
  });
  await shows("On the shelf");
  const text = await worldText();
  expect(text).toContain("Now spinning");
  expect(text).toContain("Spin Me");
  expect(text).toContain("The Discs");
  expect(text).not.toContain("Old Favourite");

  await expect.poll(async () => (await spineTips()).length).toBe(3);
  // reading first, then the rest newest first; the deleted and the foreign book are not there
  expect((await spineTips()).map((t) => t.tip)).toEqual(["Reading Now — Author One (reading now)", "Wanted", "Finished One — Author Two"]);

  // the record turns: the animation is on and the transform moves between two looks
  const v1 = await vinylNode();
  expect(v1 && v1.animation).toBe("homestar-vinyl-spin");
  await A.page.waitForTimeout(700);
  const v2 = await vinylNode();
  expect(v2 && v2.transform).not.toBe(v1 && v1.transform);
  // a wide card: the record is to the right of the spines
  const spines = await spineTips();
  expect(v1.x).toBeGreaterThan(spines[spines.length - 1].x + 10);
});

test("a spine opens the Books world", async () => {
  await openWith(shelfStub);
  await expect.poll(async () => (await spineTips()).length).toBe(3);
  await A.page.evaluate(() => {
    let m0 = null;
    $world.withAllSubmorphsDo((m) => { if (m.toolTip && /^Reading Now/.test(m.toolTip)) m0 = m; });
    m0.renderContext().shapeNode.setAttribute("data-pw", "spine");
  });
  await Promise.all([A.page.waitForURL(/\/BWORLD1$/), A.page.locator('[data-pw="spine"]').click()]);
});

test("the record opens the Music world", async () => {
  await openWith(shelfStub);
  await expect.poll(vinylNode).not.toBeNull();
  await A.page.evaluate(() => {
    $world.withAllSubmorphsDo((m) => {
      const node = m.renderContext && m.renderContext().shapeNode;
      if (node && node.classList && node.classList.contains("homestar-vinyl-spin")) node.setAttribute("data-pw", "vinyl");
    });
  });
  await Promise.all([A.page.waitForURL(/\/MWORLD1$/), A.page.locator('[data-pw="vinyl"]').click({ force: true })]);
});

test("with only listened albums the record reads Last spun; with only books there is no record", async () => {
  await openWith({ worlds: [MW], objects: musicStub([{ title: "Done With", artist: "Past", shelf: "listened" }]) });
  await shows("Last spun");
  expect(await worldText()).toContain("Done With");
  expect((await spineTips()).length).toBe(0);
  await openWith({ worlds: [BW], objects: booksStub() });
  await expect.poll(async () => (await spineTips()).length).toBe(3);
  const t = await worldText();
  expect(t).toContain("On the shelf");
  expect(t).not.toContain("Now spinning");
  expect(await vinylNode()).toBeNull();
});

test("no Books or Music world, or a library of another account: no card", async () => {
  await openWith({ worlds: [], objects: {} });
  await shows("Sky tonight");
  await A.page.waitForTimeout(1500);
  expect(await worldText()).not.toContain("On the shelf");
  // a library saved under someone else's account is not shown under this one
  await openWith({ worlds: [BW], objects: booksStub({ BLIB001: folderOf("BLIB001", "book", ["BOOK001"], "did:key:someone-else") }) });
  await shows("Sky tonight");
  await A.page.waitForTimeout(1500);
  expect(await worldText()).not.toContain("On the shelf");
});

test("a library its owner made private shows its record to the owner only", async ({ browser }) => {
  const stub = { worlds: [MW], objects: musicStub([{ title: "Hidden Gem", artist: "Quiet", shelf: "listening" }], { musicLibPublic: false }) };
  await openWith(stub);
  await shows("Hidden Gem");                       // the owner still sees it
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const v = await ctx.newPage();
  const vText = () => v.evaluate(() => { const out = []; if (typeof $world === "undefined" || !$world) return out; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
  try {
    await installShelfStubs(v);
    await v.goto("/@" + A.handle);
    await v.waitForFunction(() => window.lively && lively.identity && lively.identity.Homestar && window.$world, null, { timeout: 90000 });
    await expect.poll(async () => (await vText()).includes("Sky tonight"), { timeout: 30000 }).toBe(true);
    await v.waitForTimeout(1500);
    expect(await vText()).not.toContain("Hidden Gem");
    expect(await vText()).not.toContain("On the shelf");
    // made public, the visitor sees it too
    stub.objects.MWORLD1 = env("world", ownDid, "MWORLD1", { musicLibraryObjId: "MLIB001", musicLibraryHandle: A.handle });
    await v.goto("/@" + A.handle);
    await expect.poll(async () => (await vText()).includes("Hidden Gem"), { timeout: 30000 }).toBe(true);
  } finally { await ctx.close(); }
});

test("on a phone the spines and the record stack, and the page does not scroll sideways", async () => {
  await openWith({
    worlds: [BW, MW],
    objects: Object.assign(booksStub(), musicStub([{ title: "Spin Me", artist: "The Discs", shelf: "listening" }])),
  }, 390);
  await shows("Now spinning");
  await expect.poll(async () => (await spineTips()).length).toBeGreaterThan(0);
  const spines = await spineTips();
  const v = await vinylNode();
  expect(v.y).toBeGreaterThan(spines[0].y + 40);       // the record is under the plank, not beside the spines
  expect(await A.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  shelfStub = null;
});

test("every spine has a colour and is no taller than its shelf allows, whatever the title", async () => {
  await A.page.goto("/@" + A.handle);
  await A.page.waitForFunction(() => window.lively && lively.identity && lively.identity.HomestarShelves && lively.identity.HomestarShelves.shelf, null, { timeout: 90000 });
  const spines = await A.page.evaluate(() => {
    const titles = [];
    for (let i = 0; i < 60; i++) titles.push("Title number " + i * 7919 + " " + "abcdefghijklmnopqrstuvwxyz".slice(i % 26));
    titles.push("Gödel, Escher, Bach", "<&\">", "a");
    const card = lively.identity.HomestarShelves.shelf({ handle: "x", books: titles.map((t) => ({ title: t, shelf: "read" })) });
    const out = [];
    for (const [w, max] of [[1000, 84], [400, 84]]) {
      const box = card.build(0, 0, w, card.h(w));
      box.withAllSubmorphsDo((m) => {
        if (m.getImageURL && /svg/.test(m.getImageURL() || "")) {
          const svg = decodeURIComponent(m.getImageURL().replace(/^data:image\/svg\+xml;utf8,/, ""));
          out.push({ h: m.getExtent().y, max, fill: (svg.match(/<rect width="\d+" height="\d+" rx="2" fill="([^"]*)"/) || [])[1] });
        }
      });
    }
    return out;
  });
  expect(spines.length).toBeGreaterThan(30);
  for (const s of spines) {
    expect(s.fill).toMatch(/^#[0-9a-f]{6}$/i);
    expect(s.h).toBeGreaterThanOrEqual(84 - 6 - 21);
    expect(s.h).toBeLessThanOrEqual(84 - 6);
  }
});
