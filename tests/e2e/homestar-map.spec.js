// @ts-check
// The homestar map (HomestarMap.js) against a LIVE server, with the two postcard listings and the
// card envelopes stubbed in the browser (creating a signed card needs a delegated device key the
// test accounts lack): what it asks the server for, the pins and their halos, the caption, the
// violet pin following the reel, a pin click paging the reel to a card that is not loaded yet, the
// owner's Manage dialog (which cards show, saved into the real profile without disturbing its other
// homestar settings), that only the owner's map ever pins a non-public card, and that a page with
// nothing to show draws no map at all.
//
// Registers one throwaway `hometest_*` account and opens its own homestar; see
// account-lifecycle.spec.js on pruning the reserved handles.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });

/** @type {any} */ let A = null;
/** @type {string[]} */ const mapRequests = [];
let withLocations = true;
/** @type {any[]} */ let located = [];

// Floored Plus Codes (6 significant digits): two in one cell, one far away.
const CELL_A = "849VQJ00+", CELL_B = "8FVC9G00+";

function envelope(did, objId, n) {
  return {
    did, objId, type: "postcard", visibility: "public", created: "2026-10-08T12:41:00.000Z",
    state: { title: "Map card " + n },
    record: {
      cid: "cid" + n,
      payload: {
        format: "prosemirror-doc-v1",
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body of map card " + n }] }] },
      },
    },
  };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(200 * 1000);
  A = await newAccount(browser, "hometest_mp" + Math.random().toString(36).slice(2, 6));
  const did = await A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/profile", { credentials: "include" })).json()).did, A.handle);
  const row = (id, n, loc, visibility) => ({
    objId: id, did, visibility: visibility || "public", created: "2026-10-0" + n + "T12:00:00.000Z",
    state: loc ? { title: "Map card " + n, location: loc } : { title: "Map card " + n },
  });
  // The reel pages: M1, M2 first (cursor M2), then M3, the card that is only on the map's list yet.
  // M4 is private: the owner's map pins it, nobody else's does (their listing would not even carry it,
  // but a recipient's would, which is what the visitor test below feeds the page).
  located = [row("M4", 4, CELL_A, "private"), row("M3", 3, CELL_B), row("M2", 2, CELL_A), row("M1", 1, CELL_A)];

  await A.page.route(new RegExp("/@" + A.handle + "/postcards"), (route) => {
    const url = route.request().url();
    if (/[?&]hasLocation=1\b/.test(url)) {
      mapRequests.push(url);
      return route.fulfill({ json: { postcards: withLocations ? located : [], cursor: null } });
    }
    if (/[?&]cursor=M2\b/.test(url)) return route.fulfill({ json: { postcards: [row("M3", 3, CELL_B)], cursor: null } });
    return route.fulfill({ json: { postcards: [row("M1", 1, CELL_A), row("M2", 2, CELL_A)], cursor: "M2" } });
  });
  await A.page.route(new RegExp("/@" + A.handle + "/M[123]/replies"), (route) => route.fulfill({ json: { postcards: [] } }));
  await A.page.route(new RegExp("/@" + A.handle + "/M[123]/thread"), (route) => {
    const n = Number(route.request().url().match(/M([123])\/thread/)[1]);
    return route.fulfill({ json: { root: envelope(did, "M" + n, n), replies: [], handles: {} } });
  });
  await A.page.route(new RegExp("/@" + A.handle + "/M[123]/reactions"), (route) => route.fulfill({ json: { reactions: {}, mine: [] } }));
  await A.page.route(new RegExp("/@" + A.handle + "/M[123]$"), (route) => {
    const n = Number(route.request().url().slice(-1));
    return route.fulfill({ json: envelope(did, "M" + n, n) });
  });
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (A) await A.context.close();
});

const worldText = () => A.page.evaluate(() => { const out = []; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
const cardText = () => A.page.evaluate(() => { const n = document.querySelector(".homestar-reel-card"); return n ? n.innerText : ""; });
const navShows = (/** @type {string} */ s) => expect.poll(async () => (await worldText()).includes(s), { timeout: 15000 }).toBe(true);
/** Every pin on the map, with whether it is the violet one (overlapping pins at a wide zoom stay separate). */
const pins = () => A.page.evaluate(() => Array.from(document.querySelectorAll(".lively-homestarmap-marker")).map((el) => {
  const d = /** @type {HTMLElement} */ (el).firstElementChild;
  return { violet: /rgb\(124, 77, 255\)/.test(getComputedStyle(d).borderColor) };
}));

test("the owner's map asks for located cards, pins them with halos and says how coarse they are", async () => {
  await A.page.goto("/@" + A.handle);
  await A.page.waitForSelector(".homestar-reel-card .lively-postcard-view-content", { timeout: 90000 });
  // the owner's map carries the private card too: four pins
  await expect.poll(() => A.page.evaluate(() => document.querySelectorAll(".lively-homestarmap-marker").length), { timeout: 30000 }).toBe(4);
  expect(mapRequests.some((u) => /sort=new\b/.test(u))).toBe(true);
  // the four cards sit in two cells: two halos, and the caption counts places, not cards
  expect(await A.page.evaluate(() => document.querySelectorAll("path.leaflet-interactive, .leaflet-overlay-pane path").length)).toBe(2);
  const text = await worldText();
  expect(text).toContain("Where I have been");
  expect(text).toContain("2 places on your map. Shown to anyone. Pins are rounded to about 5 km.");
});

test("the pin of the card on show is violet, and follows the reel", async () => {
  await navShows("1 / 2+");
  await expect.poll(async () => (await pins()).filter((p) => p.violet).length).toBe(1);
  await A.page.keyboard.press("ArrowRight");
  await navShows("2 / 2+");
  await expect.poll(cardText).toContain("Map card 2");
  await expect.poll(async () => (await pins()).filter((p) => p.violet).length).toBe(1);
});

test("a pin for a card the reel has not paged in yet pages it, shows it and turns violet", async () => {
  // M3 is on the second reel page; click its pin (the lone one in the far cell)
  const target = await A.page.evaluate(() => {
    const els = Array.from(document.querySelectorAll(".lively-homestarmap-marker"));
    // the far cell's pin is the one farthest from the other two
    const pts = els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const far = pts.map((p) => pts.reduce((s, q) => s + dist(p, q), 0));
    const i = far.indexOf(Math.max(...far));
    return pts[i];
  });
  await A.page.mouse.click(target.x, target.y);
  await expect.poll(cardText, { timeout: 20000 }).toContain("Map card 3");
  await navShows("3 / 3");
  await expect.poll(async () => (await pins()).filter((p) => p.violet).length).toBe(1);
});

/** Tags the box that owns a piece of text (a pill or a row) so a real click can reach it. */
const tag = async (/** @type {string} */ text, /** @type {string} */ id) => {
  await expect.poll(() => A.page.evaluate(([t, i]) => {
    // the rightmost match: the orbit panel has a "Manage" pill too, on the left of the page
    let hit = null, hitX = -1;
    $world.withAllSubmorphsDo((m) => {
      if (m.textString !== t || !m.owner) return;
      const x = m.worldPoint(lively.pt(0, 0)).x;
      if (x > hitX) { hit = m; hitX = x; }
    });
    if (!hit) return 0;
    hit.owner.renderContext().shapeNode.setAttribute("data-pw", i);
    return 1;
  }, [text, id]), { timeout: 30000 }).toBe(1);
  return A.page.locator('[data-pw="' + id + '"]');
};
const profileHomestar = () => A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/profile", { credentials: "include" })).json()).record.payload.homestar, A.handle);
const settingsVisibility = () => A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/settings", { credentials: "include" })).json()).state.mapVisibility, A.handle);
const pinCount = (/** @type {any} */ page) => page.evaluate(() => document.querySelectorAll(".lively-homestarmap-marker").length);

/** A signed-out visitor's page, fed the listing a RECIPIENT would get (private card included). */
async function visitor(/** @type {any} */ browser, /** @type {boolean=} */ locked) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await ctx.newPage();
  await page.route(new RegExp("/@" + A.handle + "/postcards"), (route) => {
    const hasLoc = /[?&]hasLocation=1\b/.test(route.request().url());
    // a viewer the owner does not show the map to gets what the server sends them: no cards and locked
    if (hasLoc && locked) return route.fulfill({ json: { postcards: [], cursor: null, locked: true } });
    return route.fulfill({ json: { postcards: hasLoc ? located : [], cursor: null } });
  });
  await page.goto("/@" + A.handle);
  await page.waitForFunction(() => /** @type {any} */ (window).lively && lively.identity && lively.identity.Homestar && window.$world, null, { timeout: 90000 });
  return { ctx, page };
}

test("the owner chooses which cards the map shows; visitors only ever see public ones that are ticked", async ({ browser }) => {
  // another homestar setting must survive the save
  await A.page.evaluate(async () => {
    await new Promise((r) => lively.require("lively.identity.UserSpace").toRun(r));
    const cur = (await new Promise((res) => lively.identity.userSpace.getProfile((e, v) => res(v)))).record.payload.homestar || {};
    await new Promise((res, rej) => lively.identity.userSpace.saveProfile({ homestar: Object.assign({}, cur, { layout: { left: ["orbit"] } }) }, (e) => (e ? rej(e) : res(true))));
  });
  await A.page.goto("/@" + A.handle);
  await expect.poll(() => pinCount(A.page), { timeout: 30000 }).toBe(4);

  // a visitor whose listing carries the private card still sees no pin for it: M1, M2, M3 are public
  let v = await visitor(browser);
  try {
    await expect.poll(() => pinCount(v.page), { timeout: 30000 }).toBe(3);
    const vtext = await v.page.evaluate(() => { const out = []; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
    expect(vtext).not.toContain("Manage");
    expect(vtext).toContain("Where @" + A.handle + " has been");
  } finally { await v.ctx.close(); }

  // the owner unticks M2 in the real dialog
  await (await tag("Manage", "map-manage")).click();
  await expect.poll(async () => (await worldText()).includes("4 of 4 shown")).toBe(true);
  await (await tag("Map card 2", "row-M2")).click();
  await expect.poll(async () => (await worldText()).includes("3 of 4 shown")).toBe(true);
  // who sees the map: Friends (stored in the private settings, not the public profile)
  await (await tag("Friends", "vis-friends")).click();
  await expect.poll(async () => (await worldText()).includes("Only your friends can see your map.")).toBe(true);
  await (await tag("Save", "map-save")).click();
  await expect.poll(async () => (await profileHomestar()).mapHidden, { timeout: 20000 }).toEqual(["M2"]);
  expect(await settingsVisibility()).toBe("friends");
  expect(JSON.stringify(await profileHomestar())).not.toContain("friends");        // not in the public profile
  await expect.poll(async () => (await worldText()).includes("2 places on your map. Shown to friends. Pins are rounded to about 5 km.")).toBe(true);
  expect((await profileHomestar()).layout).toEqual({ left: ["orbit"] });          // the rest of homestar survived
  await expect.poll(() => pinCount(A.page), { timeout: 20000 }).toBe(3);          // owner: M1, M3, M4

  // a visitor now sees M1 and M3 only (M2 hidden, M4 private)
  v = await visitor(browser);
  try {
    await expect.poll(() => pinCount(v.page), { timeout: 30000 }).toBe(2);
  } finally { await v.ctx.close(); }

  // Hide all: the owner keeps the panel and the way back; a visitor gets none
  await (await tag("Manage", "map-manage")).click();
  await expect.poll(async () => (await worldText()).includes("3 of 4 shown")).toBe(true);
  await (await tag("Hide all", "map-none")).click();
  await expect.poll(async () => (await worldText()).includes("0 of 4 shown")).toBe(true);
  await (await tag("Save", "map-save")).click();
  await expect.poll(async () => (await profileHomestar()).mapHidden.length, { timeout: 20000 }).toBe(4);
  await expect.poll(() => pinCount(A.page), { timeout: 20000 }).toBe(0);
  await expect.poll(async () => (await worldText()).includes("Nothing is on your map. Use Manage to choose cards.")).toBe(true);
  expect(await worldText()).toContain("Manage");
  v = await visitor(browser);
  try {
    await v.page.waitForTimeout(2000);
    expect(await pinCount(v.page)).toBe(0);
    const vtext = await v.page.evaluate(() => { const out = []; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
    expect(vtext.some((t) => /^Where @/.test(t))).toBe(false);
  } finally { await v.ctx.close(); }
});

test("a viewer the owner does not show the map to gets no panel", async ({ browser }) => {
  const v = await visitor(browser, true);
  try {
    await v.page.waitForSelector(".homestar-reel-card, .lively-postcard-view-content", { timeout: 5000 }).catch(() => {});
    await v.page.waitForTimeout(2000);
    expect(await pinCount(v.page)).toBe(0);
    const vtext = await v.page.evaluate(() => { const out = []; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
    expect(vtext.some((t) => /^Where @/.test(t))).toBe(false);
  } finally { await v.ctx.close(); }
});

test("with no located cards there is no map panel", async () => {
  withLocations = false;
  await A.page.goto("/@" + A.handle);
  await A.page.waitForSelector(".homestar-reel-card .lively-postcard-view-content", { timeout: 90000 });
  await A.page.waitForTimeout(1500);
  expect(await A.page.evaluate(() => document.querySelectorAll(".lively-homestarmap-marker").length)).toBe(0);
  expect(await worldText()).not.toContain("Where I have been");
  withLocations = true;
});
