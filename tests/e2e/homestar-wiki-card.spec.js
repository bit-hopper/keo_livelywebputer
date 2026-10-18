// @ts-check
// The homestar's Wiki pages card Manage (Homestar.js, HomestarShelves.js wiki, WikiCardDialog.js) against a LIVE
// server, with GET /@handle/wiki-card (the card's pages) and /@handle/wiki (the full list the dialog reads)
// stubbed in the browser: the owner's Manage pill and a visitor without it, the owner's line when every page is
// hidden, a locked visitor getting no card, and the real dialog by real clicks (Escape stores nothing; unticking
// pages plus Friends stores their ids and the choice; reopening shows them; the tick is centred in its box).
//
// The last test calls the REAL route and settings, so it needs the server restarted after the route was added.
//
// Registers one throwaway `hometest_*` account; see account-lifecycle.spec.js on pruning the reserved handles.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });

/** @type {any} */ let A = null;
const DAY = 86400000;
const page = (/** @type {string} */ name, /** @type {number} */ daysAgo) => ({
  objId: "W" + name.replace(/\W/g, ""), wikiName: name, category: null, tags: [],
  updatedAt: new Date(Date.now() - daysAgo * DAY).toISOString(), createdAt: "2026-01-01T00:00:00.000Z",
});
const ALL = [page("Alpha", 1), page("Bravo", 2), page("Charlie", 3), page("Delta", 4)];
/** @type {any} */ let card = { pages: ALL, isOwner: true, visibility: "anyone", hiddenCount: 0 };

/** @param {any} p */
async function stub(p) {
  await p.route(new RegExp("/@" + A.handle + "/wiki-card$"), (route) => route.fulfill({ json: card }));
  await p.route(new RegExp("/@" + A.handle + "/wiki$"), (route) => route.fulfill({ json: { pages: ALL } }));
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(200 * 1000);
  A = await newAccount(browser, "hometest_wc" + Math.random().toString(36).slice(2, 6));
  await stub(A.page);
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (A) await A.context.close();
});

/** @param {any} p */
const textsOf = (p) => p.evaluate(() => { const out = []; if (typeof $world === "undefined" || !$world) return out; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
const worldText = () => textsOf(A.page);
const shows = (/** @type {string} */ s) => expect.poll(async () => (await worldText()).includes(s), { timeout: 30000 }).toBe(true);
/** @param {any} p */
const manageIn = (p) => p.evaluate(() => {
  let found = null;
  $world.withAllSubmorphsDo((m) => {
    if (m.textString === "Wiki pages" && m.owner && m.owner.owner === $world) { found = false; m.owner.withAllSubmorphsDo((s) => { if (s.textString === "Manage") found = true; }); }
  });
  return found;
});

test("the owner has Manage; a visitor sees the card without it", async ({ browser }) => {
  card = { pages: ALL, isOwner: true, visibility: "anyone", hiddenCount: 0 };
  await A.page.goto("/@" + A.handle);
  await shows("Charlie");
  expect(await manageIn(A.page)).toBe(true);

  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  try {
    card = { pages: ALL, isOwner: false };
    await stub(v);
    await v.goto("/@" + A.handle);
    await expect.poll(async () => (await textsOf(v)).includes("Charlie"), { timeout: 60000 }).toBe(true);
    expect(await manageIn(v)).toBe(false);
  } finally {
    await ctx.close();
  }
});

test("an owner who hid every page still gets the card, with a line pointing at Manage", async () => {
  card = { pages: [], isOwner: true, visibility: "anyone", hiddenCount: 4 };
  await A.page.goto("/@" + A.handle);
  await shows("Nothing is shown. Use Manage to choose pages.");
  expect(await manageIn(A.page)).toBe(true);
});

test("a visitor locked out, or with nothing to show, gets no card", async ({ browser }) => {
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  try {
    await stub(v);
    for (const body of [{ pages: [], isOwner: false, locked: true }, { pages: [], isOwner: false }]) {
      card = body;
      await v.goto("/@" + A.handle);
      await v.waitForFunction(() => /** @type {any} */ (window).lively && lively.identity && lively.identity.Homestar && window.$world && $world.submorphs.length > 5, null, { timeout: 90000 });
      await v.waitForTimeout(1500);
      expect(await textsOf(v)).not.toContain("Wiki pages");
    }
  } finally {
    await ctx.close();
  }
});

// ── Manage ──────────────────────────────────────────────────────────────────────────────────────
const settingsState = async () => (await (await A.context.request.get("/@" + A.handle + "/settings", { headers: { Accept: "application/json" } })).json()).state || {};
const slug = (/** @type {string} */ t) => "wc-" + t.replace(/\W+/g, "-");
const tag = (/** @type {string} */ text, /** @type {"panel"|"dialog"} */ where) => A.page.evaluate(([t, w, tagName]) => {
  let root = null;
  if (w === "panel") $world.withAllSubmorphsDo((m) => { if (m.textString === "Wiki pages" && m.owner && m.owner.owner === $world) root = m.owner; });
  else {
    let title = null;
    $world.withAllSubmorphsDo((m) => { if (m.textString === "Your wiki pages card") title = m; });
    for (let m = title; m && m.owner; m = m.owner) if (m.owner === $world) root = m;
  }
  if (!root) return false;
  let hit = null;
  root.withAllSubmorphsDo((m) => { if (!hit && m.textString === t) hit = m; });
  if (!hit) return false;
  hit.owner.renderContext().shapeNode.setAttribute("data-pw", tagName);
  return true;
}, [text, where, slug(text)]);
const click = async (/** @type {string} */ text, /** @type {"panel"|"dialog"} */ where) => {
  expect(await tag(text, where), text).toBe(true);
  await A.page.locator("[data-pw=" + slug(text) + "]").scrollIntoViewIfNeeded();
  await A.page.locator("[data-pw=" + slug(text) + "]").click();
};

test("Manage: Escape stores nothing; unticking pages and choosing Friends stores both, and reopening shows them", async () => {
  test.setTimeout(120 * 1000);
  card = { pages: ALL, isOwner: true, visibility: "anyone", hiddenCount: 0 };
  await A.page.goto("/@" + A.handle);
  await shows("Charlie");
  expect((await settingsState()).wikiCardHidden).toBeUndefined();

  await click("Manage", "panel");
  await expect.poll(() => worldText().then((t) => t.includes("Your wiki pages card") && t.includes("4 of 4 shown")), { timeout: 30000 }).toBe(true);
  expect(await worldText()).toContain("Updated 1 day ago");

  // Escape after changing something stores nothing
  await click("Bravo", "dialog");
  await expect.poll(() => worldText().then((t) => t.includes("3 of 4 shown")), { timeout: 10000 }).toBe(true);
  await A.page.keyboard.press("Escape");
  await expect.poll(() => worldText().then((t) => !t.includes("Your wiki pages card")), { timeout: 10000 }).toBe(true);
  expect((await settingsState()).wikiCardHidden).toBeUndefined();
  expect((await settingsState()).wikiCardVisibility).toBeUndefined();

  // reopen, hide two, choose Friends, save
  await click("Manage", "panel");
  await expect.poll(() => worldText().then((t) => t.includes("4 of 4 shown")), { timeout: 30000 }).toBe(true);
  await click("Bravo", "dialog");
  await click("Delta", "dialog");
  await click("Friends", "dialog");
  await expect.poll(() => worldText().then((t) => t.includes("Only your friends can see this card.") && t.includes("2 of 4 shown")), { timeout: 10000 }).toBe(true);
  await click("Save", "dialog");
  await expect.poll(() => worldText().then((t) => !t.includes("Your wiki pages card")), { timeout: 30000 }).toBe(true);
  const st = await settingsState();
  expect(st.wikiCardHidden).toEqual(["WBravo", "WDelta"]);   // newest first: Bravo before Delta
  expect(st.wikiCardVisibility).toBe("friends");

  // reopening shows the saved choices; and a ticked box's tick is centred in it
  await click("Manage", "panel");
  await expect.poll(() => worldText().then((t) => t.includes("2 of 4 shown") && t.includes("Only your friends can see this card.")), { timeout: 30000 }).toBe(true);
  const tick = await A.page.evaluate(() => {
    let out = null;
    $world.withAllSubmorphsDo((m) => {
      // the dialog's row, whose first child is the checkbox with a tick in it (the card's own row has no such child)
      if (m.textString === "Alpha" && m.owner && !out && m.owner.submorphs[0] && m.owner.submorphs[0].submorphs.length) {
        const box = m.owner.submorphs[0], b = box.renderContext().shapeNode.getBoundingClientRect(), t = box.submorphs[0].renderContext().shapeNode;
        const g = (t.querySelector("span") || t).getBoundingClientRect();
        out = { dx: g.left + g.width / 2 - (b.left + b.width / 2), dy: g.top + g.height / 2 - (b.top + b.height / 2), w: b.width };
      }
    });
    return out;
  });
  console.log("tick offset from box centre:", JSON.stringify(tick));
  expect(Math.abs(tick.dx)).toBeLessThan(1.5);
  expect(Math.abs(tick.dy)).toBeLessThan(1.5);
  await A.page.keyboard.press("Escape");
});

test("the real route and settings: bad shapes are refused; Friends, Orbit and Only me lock a stranger out", async ({ browser }) => {
  const url = "/@" + A.handle + "/settings";
  const put = (/** @type {any} */ patch) => A.page.evaluate(async ([u, p]) => {
    const env = await (await fetch(u, { credentials: "include", headers: { Accept: "application/json" } })).json();
    env.state = Object.assign(env.state || {}, p);
    await new Promise((res, rej) => lively.identity.crypto.computeCid((env.record && env.record.payload) || {}, (e, c) => (e ? rej(e) : (env.record.cid = c, res()))));
    const w = await fetch(u, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(env) });
    return { status: w.status, body: await w.json().catch(() => null) };
  }, [url, patch]);

  for (const bad of [{ wikiCardVisibility: "public" }, { wikiCardHidden: "WAlpha1" }, { wikiCardHidden: ["x"] }, { wikiCardHidden: [5] }, { wikiCardHidden: ["../etc/passwd"] }]) {
    const r = await put(bad);
    expect(r.status, JSON.stringify(bad)).toBe(400);
    expect(r.body.code).toBe("INVALID_WIKI_CARD");
  }

  const anonCtx = await browser.newContext();
  const get = (/** @type {any} */ ctx, h = A.handle) => ctx.get("/@" + h + "/wiki-card", { headers: { Accept: "application/json" } });
  try {
    expect((await put({ wikiCardVisibility: "anyone", wikiCardHidden: [] })).status).toBe(200);
    const open = await (await get(anonCtx.request)).json();
    expect(open.locked).toBeUndefined();
    expect(open.isOwner).toBe(false);
    expect(Array.isArray(open.pages)).toBe(true);
    expect(open.visibility).toBeUndefined();       // only the owner is told what they chose
    expect(open.hiddenCount).toBeUndefined();

    for (const vis of ["friends", "private", "orbit"]) {
      expect((await put({ wikiCardVisibility: vis })).status, vis).toBe(200);
      const anon = await (await get(anonCtx.request)).json();
      expect(anon.locked, vis).toBe(true);
      expect(anon.pages, vis).toEqual([]);
      const own = await (await get(A.context.request)).json();
      expect(own.locked).toBeUndefined();
      expect(own.isOwner).toBe(true);
      expect(own.visibility).toBe(vis);
    }
    expect((await get(anonCtx.request, "nosuchhandle" + Date.now())).status()).toBe(404);
  } finally {
    await anonCtx.close();
  }
});
