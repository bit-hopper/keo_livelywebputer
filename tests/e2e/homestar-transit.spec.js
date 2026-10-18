// @ts-check
// The homestar's Transit card (Homestar.js, HomestarShelves.js transit, TransitDialog.js) against a LIVE
// server, with GET /@handle/transit and the transit proxy's stop-monitoring stubbed in the browser: the
// owner's prompt when no station is chosen, the next trains for a station (nearest first, at most three,
// "now" for 0 minutes), the honest message when live times are unavailable (no made-up numbers on a public
// page), a visitor locked out or let in, and the Manage dialog storing the station and who sees it.
//
// What the real route does (the gate per viewer, bad shapes refused) is checked by the last test, which
// needs the server restarted after the route was added.
//
// Registers one throwaway `hometest_*` account; see account-lifecycle.spec.js on pruning the reserved handles.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });

/** @type {any} */ let A = null;
/** @type {any} */ let transit = { station: null, isOwner: true };
/** @type {{status:number, json:any}} */ let stops = { status: 200, json: { predictions: [] } };

const soon = (/** @type {number} */ minutes) => new Date(Date.now() + minutes * 60000 + 15000).toISOString();
const pred = (/** @type {string} */ lineKey, /** @type {string} */ destination, /** @type {number} */ minutes) =>
  ({ line: lineKey, lineKey, destination, stopName: "Embarcadero", expectedArrival: soon(minutes), minutesAway: minutes });

/** @param {any} page */
async function stub(page) {
  await page.route(new RegExp("/@" + A.handle + "/transit$"), (route) => route.fulfill({ json: transit }));
  await page.route(/\/nodejs\/TransitProxyServer\/stop-monitoring/, (route) =>
    route.fulfill({ status: stops.status, json: stops.json }));
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(200 * 1000);
  A = await newAccount(browser, "hometest_tr" + Math.random().toString(36).slice(2, 6));
  await stub(A.page);
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (A) await A.context.close();
});

/** @param {any} page */
const textsOf = (page) => page.evaluate(() => { const out = []; if (typeof $world === "undefined" || !$world) return out; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
const worldText = () => textsOf(A.page);
const shows = (/** @type {string} */ s) => expect.poll(async () => (await worldText()).includes(s), { timeout: 30000 }).toBe(true);

test("the owner with no station is asked to pick one", async () => {
  transit = { station: null, isOwner: true, visibility: "anyone" };
  await A.page.goto("/@" + A.handle);
  await shows("Transit");
  expect(await worldText()).toContain("Show the trains at your BART station. Use Manage to pick one.");
  expect(await worldText()).not.toContain("Live from 511.org");
});

test("a station shows its name and the next three trains, soonest first, 'now' for zero", async () => {
  transit = { station: "EMBR", isOwner: true, visibility: "anyone" };
  stops = { status: 200, json: { predictions: [
    pred("YELLOW", "Antioch", 9), pred("RED", "Richmond", 0), pred("BLUE", "Dublin/Pleasanton", 4), pred("GREEN", "Berryessa/North San Jose", 12),
  ] } };
  await A.page.goto("/@" + A.handle);
  await shows("Embarcadero");
  await shows("Richmond");
  const t = await worldText();
  expect(t).toContain("Live from 511.org");
  expect(t).toContain("now");
  expect(t).toContain("4 min");
  expect(t).toContain("9 min");
  expect(t).toContain("Dublin/Pleasanton");
  expect(t).toContain("Antioch");
  expect(t).not.toContain("Berryessa/North San Jose");   // the fourth
  expect(t).not.toContain("12 min");
  // nearest first: Richmond (0), Dublin (4), Antioch (9), top to bottom
  const ys = await A.page.evaluate(() => {
    const y = {};
    $world.withAllSubmorphsDo((m) => { if (["Richmond", "Dublin/Pleasanton", "Antioch"].includes(m.textString)) y[m.textString] = m.renderContext().shapeNode.getBoundingClientRect().top; });
    return y;
  });
  expect(ys["Richmond"]).toBeLessThan(ys["Dublin/Pleasanton"]);
  expect(ys["Dublin/Pleasanton"]).toBeLessThan(ys["Antioch"]);
});

test("when live times are unavailable it says so and shows no numbers", async () => {
  transit = { station: "EMBR", isOwner: true, visibility: "anyone" };
  stops = { status: 503, json: { error: "not configured" } };
  await A.page.goto("/@" + A.handle);
  await shows("Unavailable right now");
  const t = await worldText();
  expect(t.some((s) => /^\d+ min$/.test(s))).toBe(false);   // the proxy's 503 makes TransitClient fall back to made-up times; the page must not show them
  expect(t).not.toContain("Live from 511.org");
});

test("a station with no trains listed says so", async () => {
  transit = { station: "EMBR", isOwner: true, visibility: "anyone" };
  stops = { status: 200, json: { predictions: [] } };
  await A.page.goto("/@" + A.handle);
  await shows("No trains listed right now.");
});

test("a code the page does not know shows a visitor nothing, and the owner the prompt", async ({ browser }) => {
  transit = { station: "ZZZZ", isOwner: false };
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  try {
    await stub(v);
    await v.goto("/@" + A.handle);
    await v.waitForFunction(() => /** @type {any} */ (window).lively && lively.identity && lively.identity.Homestar && window.$world && $world.submorphs.length > 5, null, { timeout: 90000 });
    await v.waitForTimeout(1500);
    expect(await textsOf(v)).not.toContain("Transit");
  } finally {
    await ctx.close();
  }
  transit = { station: "ZZZZ", isOwner: true, visibility: "anyone" };
  await A.page.goto("/@" + A.handle);
  await shows("Show the trains at your BART station. Use Manage to pick one.");
});

test("a visitor locked out gets no card; one let in gets the card without Manage", async ({ browser }) => {
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  try {
    await stub(v);
    transit = { station: null, isOwner: false, locked: true };
    await v.goto("/@" + A.handle);
    await v.waitForFunction(() => /** @type {any} */ (window).lively && lively.identity && lively.identity.Homestar && window.$world && $world.submorphs.length > 5, null, { timeout: 90000 });
    await v.waitForTimeout(1500);
    expect(await textsOf(v)).not.toContain("Transit");

    transit = { station: "EMBR", isOwner: false };
    stops = { status: 200, json: { predictions: [pred("RED", "Richmond", 3)] } };
    await v.goto("/@" + A.handle);
    await expect.poll(async () => (await textsOf(v)).includes("Richmond"), { timeout: 30000 }).toBe(true);
    const t = await textsOf(v);
    expect(t).toContain("Transit");
    expect(t).toContain("Embarcadero");
    expect(t).toContain("3 min");
    const manage = await v.evaluate(() => {
      let found = false;
      $world.withAllSubmorphsDo((m) => {
        if (m.textString === "Transit" && m.owner && m.owner.owner === $world) m.owner.withAllSubmorphsDo((s) => { if (s.textString === "Manage") found = true; });
      });
      return found;
    });
    expect(manage).toBe(false);
  } finally {
    await ctx.close();
  }
});

// ── Manage ──────────────────────────────────────────────────────────────────────────────────────
const settingsState = async () => (await (await A.context.request.get("/@" + A.handle + "/settings", { headers: { Accept: "application/json" } })).json()).state || {};
const slug = (/** @type {string} */ t) => "tr-" + t.replace(/\W+/g, "-");
/** Tags the node of the box that owns the click around the text `text`, inside the Transit panel or the dialog's scrim. */
const tag = (/** @type {string} */ text, /** @type {"panel"|"dialog"} */ where) => A.page.evaluate(([t, w, tagName]) => {
  let root = null;
  if (w === "panel") $world.withAllSubmorphsDo((m) => { if (m.textString === "Transit" && m.owner && m.owner.owner === $world) root = m.owner; });
  else {
    let title = null;
    $world.withAllSubmorphsDo((m) => { if (m.textString === "Your transit card") title = m; });
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
  // a row inside the dialog's scrolling list may be below the fold
  await A.page.locator("[data-pw=" + slug(text) + "]").scrollIntoViewIfNeeded();
  await A.page.locator("[data-pw=" + slug(text) + "]").click();
};

test("Manage: Escape stores nothing; a station and who sees it are stored, and shown when reopened", async () => {
  test.setTimeout(120 * 1000);
  // a station is set so the card first draws "Loading…" and redraws when the times land; wait for that
  // redraw, or it rebuilds the node a click was just aimed at
  transit = { station: "EMBR", isOwner: true, visibility: "anyone" };
  stops = { status: 200, json: { predictions: [pred("RED", "Richmond", 3)] } };
  await A.page.goto("/@" + A.handle);
  await shows("Richmond");
  expect((await settingsState()).transitStation).toBeUndefined();

  // open: the four choices, "No Transit card" and the stations, and Escape after a change stores nothing
  await click("Manage", "panel");
  await expect.poll(() => worldText().then((t) => t.includes("Your transit card") && t.includes("No Transit card")), { timeout: 30000 }).toBe(true);
  const t0 = await worldText();
  expect(t0).toContain("Embarcadero");
  expect(t0).toContain("Montgomery St.");
  await click("Embarcadero", "dialog");
  await A.page.keyboard.press("Escape");
  await expect.poll(() => worldText().then((t) => !t.includes("Your transit card")), { timeout: 10000 }).toBe(true);
  expect((await settingsState()).transitStation).toBeUndefined();
  expect((await settingsState()).transitVisibility).toBeUndefined();

  // reopen, choose a station and Friends, save
  await click("Manage", "panel");
  await expect.poll(() => worldText().then((t) => t.includes("No Transit card")), { timeout: 30000 }).toBe(true);
  await click("Montgomery St.", "dialog");
  await click("Friends", "dialog");
  await expect.poll(() => worldText().then((t) => t.includes("Only your friends can see this card.")), { timeout: 10000 }).toBe(true);
  await click("Save", "dialog");
  await expect.poll(() => worldText().then((t) => !t.includes("Your transit card")), { timeout: 30000 }).toBe(true);
  const st = await settingsState();
  expect(st.transitStation).toBe("MONT");
  expect(st.transitVisibility).toBe("friends");

  // reopening shows the saved choices; the station list scrolled to the chosen one, so it is on screen
  await click("Manage", "panel");
  await expect.poll(() => worldText().then((t) => t.includes("Only your friends can see this card.")), { timeout: 30000 }).toBe(true);
  const inView = await A.page.evaluate(() => {
    let box = null, row = null;
    $world.withAllSubmorphsDo((m) => { if (m.textString === "Montgomery St.") row = m; });
    for (let m = row; m && !box; m = m.owner) if (m.getClipMode && m.getClipMode() === "auto") box = m;
    if (!row || !box) return null;
    const r = row.renderContext().shapeNode.getBoundingClientRect(), b = box.renderContext().shapeNode.getBoundingClientRect();
    return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
  });
  expect(inView).toBe(true);

  // "No Transit card" clears the station
  await click("No Transit card", "dialog");
  await click("Save", "dialog");
  await expect.poll(() => worldText().then((t) => !t.includes("Your transit card")), { timeout: 30000 }).toBe(true);
  expect((await settingsState()).transitStation).toBeNull();
});

test("the real route and settings: bad shapes are refused; Friends, Orbit and Only me lock a stranger out", async ({ browser }) => {
  const url = "/@" + A.handle + "/settings";
  const put = (patch) => A.page.evaluate(async ([u, p]) => {
    const env = await (await fetch(u, { credentials: "include", headers: { Accept: "application/json" } })).json();
    env.state = Object.assign(env.state || {}, p);
    await new Promise((res, rej) => lively.identity.crypto.computeCid((env.record && env.record.payload) || {}, (e, c) => (e ? rej(e) : (env.record.cid = c, res()))));
    const w = await fetch(u, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(env) });
    return { status: w.status, body: await w.json().catch(() => null) };
  }, [url, patch]);

  for (const bad of [{ transitVisibility: "public" }, { transitStation: "embr" }, { transitStation: 7 }, { transitStation: ["EMBR"] }, { transitStation: "../x" }]) {
    const r = await put(bad);
    expect(r.status, JSON.stringify(bad)).toBe(400);
    expect(r.body.code).toBe("INVALID_TRANSIT");
  }

  const anonCtx = await browser.newContext();
  // the context's request object skips the page.route stubs and carries the owner's cookie
  const get = async (ctx, h = A.handle) => ctx.get("/@" + h + "/transit", { headers: { Accept: "application/json" } });
  try {
    expect((await put({ transitStation: "EMBR", transitVisibility: "anyone" })).status).toBe(200);
    const open = await (await get(anonCtx.request)).json();
    expect(open.station).toBe("EMBR");
    expect(open.isOwner).toBe(false);
    expect(open.visibility).toBeUndefined();      // only the owner is told what they chose

    for (const vis of ["friends", "private", "orbit"]) {
      expect((await put({ transitVisibility: vis })).status, vis).toBe(200);
      const anon = await (await get(anonCtx.request)).json();
      expect(anon.locked, vis).toBe(true);
      expect(anon.station, vis).toBeNull();          // the station is never sent to someone locked out
      const own = await (await get(A.context.request)).json();
      expect(own.locked).toBeUndefined();
      expect(own.station).toBe("EMBR");
      expect(own.isOwner).toBe(true);
      expect(own.visibility).toBe(vis);
    }
    expect((await get(anonCtx.request, "nosuchhandle" + Date.now())).status()).toBe(404);
  } finally {
    await anonCtx.close();
  }
});
