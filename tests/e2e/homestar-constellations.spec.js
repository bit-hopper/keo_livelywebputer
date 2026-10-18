// @ts-check
// The homestar's Constellations card (Homestar.js, _buildConstellations) against a LIVE server, with the
// /constellations/public listing stubbed in the browser: the rows (name, member and cluster counts with
// their singular forms, the lock on a private one), "and N more" past six, a click opening the
// constellation, no card for a visitor with nothing to show, the owner's empty message, and the layout
// (under the Orbit in the left rail when wide, after it on a phone, no sideways scroll).
//
// What the real route returns (public only for a viewer, private too for the owner) is covered by
// constellation-membership.test.js against the database and by the last test here, which calls the real
// route and so needs the server restarted after the route was added.
//
// Registers one throwaway `hometest_*` account; see account-lifecycle.spec.js on pruning the reserved handles.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });

/** @type {any} */ let A = null;
/** @type {any[]} */ let rows = [];

const row = (name, memberCount, roomCount, visibility = "public") => ({ name, memberCount, roomCount, visibility, avatarUrl: null });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(200 * 1000);
  A = await newAccount(browser, "hometest_co" + Math.random().toString(36).slice(2, 6));
  await A.page.route(new RegExp("/@" + A.handle + "/constellations/public$"), (route) =>
    route.fulfill({ json: { constellations: rows, isOwner: true } }));
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (A) await A.context.close();
});

const worldText = () => A.page.evaluate(() => { const out = []; if (typeof $world === "undefined" || !$world) return out; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
const shows = (/** @type {string} */ s) => expect.poll(async () => (await worldText()).includes(s), { timeout: 30000 }).toBe(true);
const panelRect = (/** @type {string} */ title) => A.page.evaluate((t) => {
  let hit = null;
  if (typeof $world === "undefined" || !$world) return null;
  $world.withAllSubmorphsDo((m) => { if (m.textString === t && m.owner && m.owner.owner === $world) hit = m.owner; });
  if (!hit) return null;
  const r = hit.renderContext().shapeNode.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, bottom: r.bottom };
}, title);

test("the owner with none joined is told so", async () => {
  rows = [];
  await A.page.goto("/@" + A.handle);
  await shows("Constellations");
  expect(await worldText()).toContain("You haven't joined any constellations yet.");
});

test("rows show counts in the right form, a lock on a private one, and 'and N more' past six", async () => {
  rows = [row("alpha", 12, 3), row("solo", 1, 1), row("quiet", 2, 0), row("hidden", 4, 2, "private"),
          row("e", 3, 1), row("f", 3, 1), row("g", 3, 1), row("h", 3, 1)];
  await A.page.goto("/@" + A.handle);
  await shows("c/alpha");
  const text = await worldText();
  expect(text).toContain("12 members · 3 clusters");
  expect(text).toContain("1 member · 1 cluster");
  expect(text).toContain("2 members · 0 clusters");
  expect(text).toContain("c/hidden");
  expect(text).toContain("and 2 more");
  expect(text).not.toContain("c/g");
  // the lock is the private row's, and only that row's
  const locks = await A.page.evaluate(() => {
    const out = [];
    $world.withAllSubmorphsDo((m) => {
      if (m.textString === "lock" && m.owner) {
        const names = [];
        m.owner.withAllSubmorphsDo((s) => { if (s.textString && /^c\//.test(s.textString)) names.push(s.textString); });
        out.push(names[0]);
      }
    });
    return out;
  });
  expect(locks).toEqual(["c/hidden"]);
});

test("a row opens its constellation", async () => {
  rows = [row("alpha", 12, 3)];
  await A.page.goto("/@" + A.handle);
  await shows("c/alpha");
  await A.page.evaluate(() => {
    $world.withAllSubmorphsDo((m) => {
      if (m.textString === "c/alpha") m.owner.renderContext().shapeNode.setAttribute("data-pw", "constellation-row");
    });
  });
  await Promise.all([
    A.page.waitForURL(/\/c\/alpha$/, { timeout: 30000 }),
    A.page.locator("[data-pw=constellation-row]").click(),
  ]);
});

test("a visitor with nothing to show gets no card; with rows, the card", async ({ browser }) => {
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  try {
    await v.route(new RegExp("/@" + A.handle + "/constellations/public$"), (route) =>
      route.fulfill({ json: { constellations: [], isOwner: false } }));
    await v.goto("/@" + A.handle);
    await v.waitForFunction(() => /** @type {any} */ (window).lively && lively.identity && lively.identity.Homestar && window.$world && $world.submorphs.length > 5, null, { timeout: 90000 });
    await v.waitForTimeout(1500);
    const texts = () => v.evaluate(() => { const out = []; if (typeof $world === "undefined" || !$world) return out; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
    expect(await texts()).not.toContain("Constellations");
    expect(await texts()).not.toContain("You haven't joined any constellations yet.");

    await v.unroute(new RegExp("/@" + A.handle + "/constellations/public$"));
    await v.route(new RegExp("/@" + A.handle + "/constellations/public$"), (route) =>
      route.fulfill({ json: { constellations: [row("alpha", 2, 1)], isOwner: false } }));
    await v.goto("/@" + A.handle);
    await expect.poll(async () => (await texts()).includes("c/alpha"), { timeout: 30000 }).toBe(true);
    expect(await texts()).toContain("Constellations");
  } finally {
    await ctx.close();
  }
});

test("under the Orbit in the left rail when wide, after it on a phone, never a sideways scroll", async () => {
  rows = [row("alpha", 12, 3), row("beta", 5, 0)];
  await A.page.setViewportSize({ width: 1400, height: 900 });
  await A.page.goto("/@" + A.handle);
  await shows("c/alpha");
  const orbit = await panelRect("Orbit");
  const cons = await panelRect("Constellations");
  const worlds = await panelRect("Worlds");
  expect(orbit && cons && worlds).toBeTruthy();
  expect(Math.abs(cons.x - orbit.x)).toBeLessThan(2);
  expect(cons.w).toBeCloseTo(orbit.w, 0);
  expect(cons.y).toBeGreaterThan(orbit.bottom);
  expect(cons.y - orbit.bottom).toBeLessThan(30);
  expect(worlds.x).toBeGreaterThan(cons.x + cons.w);   // the right rail is still on the right

  await A.page.setViewportSize({ width: 390, height: 800 });
  await A.page.goto("/@" + A.handle);
  await shows("c/alpha");
  const o2 = await panelRect("Orbit");
  const c2 = await panelRect("Constellations");
  expect(c2.y).toBeGreaterThan(o2.bottom);
  const overflow = await A.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await A.page.setViewportSize({ width: 1280, height: 720 });
});

test("the real route: listed to the owner, public only to a stranger, 404 for an unknown handle", async ({ browser }) => {
  // the context's request object skips the page.route stub above and carries the owner's cookie
  const get = (h, ctx) => ctx.get("/@" + h + "/constellations/public", { headers: { Accept: "application/json" } });
  const own = await get(A.handle, A.context.request);
  expect(own.status()).toBe(200);
  const ownBody = await own.json();
  expect(ownBody.isOwner).toBe(true);
  expect(Array.isArray(ownBody.constellations)).toBe(true);

  const anonCtx = await browser.newContext();
  try {
    const anon = await get(A.handle, anonCtx.request);
    expect(anon.status()).toBe(200);
    const anonBody = await anon.json();
    expect(anonBody.isOwner).toBe(false);
    expect(anonBody.constellations.every((c) => c.visibility === "public")).toBe(true);
    expect((await get("nosuchhandle" + Date.now(), anonCtx.request)).status()).toBe(404);
  } finally {
    await anonCtx.close();
  }
});
