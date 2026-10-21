// @ts-check
// The Gaming world template end to end, with real mouse and keyboard input against the
// real server: an empty library, adding a game, editing it in the detail dialog, who can
// see it, the theme switch, what a visitor sees, and saving then reloading the world.
//
// Registers a throwaway hometest_* account through a CDP virtual passkey and removes it
// through the deletion feature even when a check fails (see account-lifecycle.spec.js for
// the reserved-handle note). Needs the dev server running at baseURL, restarted since
// the /@handle/games route and the game-search proxy were added: the test skips itself,
// loudly, when /games is not served yet.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers.js");

test.setTimeout(240 * 1000);

const GAME = "Zzyzx Quest " + Math.random().toString(36).slice(2, 6);

const openGaming = (page) => page.evaluate(async () => {
  await new Promise((r) => lively.require("lively.gaming.Gaming").toRun(r));
  const w = /** @type {any} */ (window);
  if (w.__g) w.__g.remove();
  w.__g = lively.gaming.Gaming.open();
  for (let i = 0; i < 100 && !w.__g.state.loaded; i++) await new Promise((r) => setTimeout(r, 100));
  return { loaded: w.__g.state.loaded, error: w.__g.state.error };
});
const g = (page, fn, arg) => page.evaluate(fn, arg);
const stored = (page) => page.evaluate(() => new Promise((res, rej) => {
  lively.gaming.GameLog.list(lively.identity.did.currentUser().handle, {}, (e, v) => (e ? rej(new Error(e.message)) : res(v.entries.map((x) => ({ title: x.payload.title, status: x.payload.status, rating: x.payload.rating, review: x.payload.review, vis: x.visibility, hours: x.payload.manual_playtime_minutes })))));
}));
// poll until the stored library satisfies `ok` (saves are asynchronous and queued)
async function storedWhere(page, ok, what) {
  let last = null;
  await expect.poll(async () => { last = await stored(page); if (!ok(last)) console.log("[waiting for: " + what + "] stored now: " + JSON.stringify(last)); return ok(last); }, { timeout: 20000, message: what }).toBe(true);
  return last;
}

test("the library: empty state, add, edit, share, theme, visitor, save and reload", async ({ browser, baseURL }) => {
  const handle = "hometest_gm" + Math.random().toString(36).slice(2, 8);
  const acct = await newAccount(browser, handle);
  try {
    const page = acct.page;
    const state = await openGaming(page);
    test.skip(!!state.error, "the running server does not serve /@handle/games yet: restart it from WSL (" + state.error + ")");

    // ── empty library: says so, and offers the way forward (owner)
    expect(await g(page, () => /** @type {any} */ (window).__g.isOwner())).toBe(true);
    await expect(page.getByRole("button", { name: "Add a game" })).toBeVisible();
    expect(await g(page, () => !!/** @type {any} */ (window).__g._view.msgBox)).toBe(true);

    // ── add by title (the search proxy may be unconfigured here: the title route always works)
    await page.getByRole("button", { name: "Add game", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Add a game" })).toBeVisible();
    // scoped to the dialog: the library's own search box is behind it and also a .gaming-input
    const fields = page.getByRole("dialog").locator(".gaming-input");
    await fields.nth(1).click();                      // the second field in the dialog is "add it by its title"
    await page.keyboard.type(GAME);
    await page.keyboard.press("Enter");
    await storedWhere(page, (l) => l.length === 1 && l[0].title === GAME, "the game is stored");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // ── it is private and sealed: nothing about it is readable in the stored envelope
    const env = await page.evaluate(async (h) => { const r = await fetch("/@" + h + "/games", { credentials: "include", headers: { Accept: "application/json" } }); return r.json(); }, handle);
    expect(env.games).toHaveLength(1);
    expect(env.games[0].visibility).toBe("private");
    expect(JSON.stringify(env.games[0])).not.toContain(GAME);

    // ── the tile shows it; the owner's controls are there
    await expect(page.getByRole("button", { name: new RegExp("^" + GAME + ", Backlog") })).toBeVisible();     // a new game starts on the backlog
    const tile = page.getByRole("button", { name: new RegExp("^" + GAME + ", ") });                          // ...and its name follows its status
    expect(await g(page, () => /** @type {any} */ (window).__g._view.items.length)).toBe(1);

    // a decorative child must not make the tile draggable (all three flags, on the tile and every child)
    const draggable = await g(page, () => {
      const v = /** @type {any} */ (window).__g._view; const bad = [];
      v.pool.forEach((t) => [t].concat(Object.values(t.__c)).forEach((m) => { if (m.draggingEnabled || m.isGrabbable()) bad.push(m.constructor.type); }));
      return bad;
    });
    expect(draggable).toEqual([]);

    // ── keyboard: the tile is a Tab stop, Enter opens the detail
    await page.evaluate((name) => { const n = Array.from(document.querySelectorAll('[role="button"]')).find((e) => (e.getAttribute("aria-label") || "").startsWith(name)); /** @type {any} */ (n).parentElement.focus(); }, GAME);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Game: " + GAME })).toBeVisible();

    // ── edit: status, rating (and clearing it), review, own playtime, visibility
    await page.getByRole("radio", { name: "Status: Completed" }).click();
    await page.getByRole("radio", { name: "4 stars" }).click();
    await storedWhere(page, (l) => l[0].status === "completed" && l[0].rating === 4, "status and rating saved");
    await page.getByRole("radio", { name: /^4 stars. Click again to clear/ }).click();      // clicking the current rating clears it
    await storedWhere(page, (l) => l[0].rating === 0, "rating cleared");
    await page.getByRole("radio", { name: "5 stars" }).click();
    await page.getByRole("dialog").locator(".gaming-input").nth(0).click();               // "your own playtime (hours)"
    await page.keyboard.type("12.5");
    await page.keyboard.press("Enter");
    await storedWhere(page, (l) => l[0].hours === 750, "own playtime saved (12.5 h = 750 min)");
    await page.getByRole("dialog").locator(".gaming-input").nth(1).click();               // the review box
    await page.keyboard.type("First line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second line");
    await storedWhere(page, (l) => l[0].review === "First line\nSecond line", "review autosaved after typing stops");
    await page.getByRole("radio", { name: "Visibility: Public" }).click();
    await storedWhere(page, (l) => l[0].vis === "public", "made public");
    await expect(page.getByRole("radio", { name: /Visibility: Friends/ })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // the public entry is now plain JSON for anyone, with the review in it
    const anon = await browser.newContext({ baseURL });
    try {
      const r = await anon.request.get("/@" + handle + "/games", { headers: { Accept: "application/json" } });
      const body = await r.json();
      expect(body.games).toHaveLength(1);
      expect(body.games[0].record.payload.title).toBe(GAME);
      expect(body.games[0].record.payload.review).toBe("First line\nSecond line");
    } finally { await anon.close(); }

    // ── the visibility badge on the tile opens the visibility dialog (a click on the badge, not the tile)
    const badge = await page.evaluate(() => { const v = /** @type {any} */ (window).__g._view; const t = v.pool.find((p) => p.__idx === 0); const r = t.__c.vis.renderContext().shapeNode.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.click(badge.x, badge.y);
    await expect(page.getByRole("dialog", { name: "Who can see " + GAME })).toBeVisible();
    await page.getByRole("radio", { name: /^Private/ }).click();
    await storedWhere(page, (l) => l[0].vis === "private", "made private again from the badge");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // ── the library's own search box takes real keystrokes and filters the grid (no dialog is open here)
    await page.locator(".gaming-input").first().click();
    await page.keyboard.type("zzyzx");
    await expect.poll(() => g(page, () => /** @type {any} */ (window).__g._view.items.length)).toBe(1);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("no such game");
    await expect.poll(() => g(page, () => /** @type {any} */ (window).__g._view.items.length)).toBe(0);
    await expect(page.getByText("No games match")).toBeVisible();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await expect.poll(() => g(page, () => /** @type {any} */ (window).__g._view.items.length)).toBe(1);

    // ── theme: Light really repaints the page, a tile and a dialog panel (read from the DOM, not a screenshot)
    await page.getByRole("radio", { name: "Theme: Light" }).click();
    await expect.poll(() => g(page, () => getComputedStyle(/** @type {any} */ (window).__g.renderContext().shapeNode).backgroundColor)).toBe("rgb(253, 240, 245)");
    const tileBg = await g(page, () => { const t = /** @type {any} */ (window).__g._view.pool.find((p) => p.__idx === 0); return getComputedStyle(t.renderContext().shapeNode).backgroundColor; });
    expect(tileBg).toBe("rgb(255, 255, 255)");
    await tile.click();
    const panelBg = await g(page, () => getComputedStyle(lively.gaming.GamingUI._modal.panel.renderContext().shapeNode).backgroundColor);
    expect(panelBg).toBe("rgb(255, 255, 255)");
    await page.keyboard.press("Escape");
    await page.getByRole("radio", { name: "Theme: Dark" }).click();
    await expect.poll(() => g(page, () => getComputedStyle(/** @type {any} */ (window).__g.renderContext().shapeNode).backgroundColor)).toBe("rgb(0, 0, 0)");
    await page.getByRole("radio", { name: "Theme: Auto" }).click();

    // ── remove: asks first, then the tile is gone and the stored entry is deleted
    await tile.click();
    await page.getByRole("button", { name: "Remove from library" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();                            // changed my mind
    await expect(page.getByRole("dialog", { name: "Game: " + GAME })).toBeVisible();
    await page.getByRole("button", { name: "Remove from library" }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await storedWhere(page, (l) => l.length === 0, "removed");
    await expect(page.getByRole("button", { name: "Add a game" })).toBeVisible();          // the empty state is back

    // ── a visitor: no edit controls, only public games
    await g(page, () => new Promise((res, rej) => lively.gaming.GameLog.create({ title: "Hidden One" }, "private", (e, v) => (e ? rej(e) : res(v)))));
    await g(page, () => new Promise((res, rej) => lively.gaming.GameLog.create({ title: "Shown One", status: "playing" }, "public", (e, v) => (e ? rej(e) : res(v)))));
    const v = await browser.newContext({ baseURL, viewport: { width: 1400, height: 900 } });
    try {
      const vp = await v.newPage();
      await vp.goto("/blank.html");
      await vp.waitForFunction(() => /** @type {any} */ (window).$world && window.lively && lively.require, null, { timeout: 60000 });
      const seen = await vp.evaluate(async (h) => {
        await new Promise((r) => lively.require("lively.gaming.Gaming").toRun(r));
        const G = lively.gaming.Gaming;
        G.prototype.ownerHandle = function () { return h; };          // a visitor arrives through the owner's world URL; stand in for it
        const m = G.open();
        for (let i = 0; i < 100 && !m.state.loaded; i++) await new Promise((r) => setTimeout(r, 100));
        return { owner: m.isOwner(), titles: m.state.entries.map((e) => e.payload.title), addBtn: !!document.querySelector('[aria-label="Add game"]'), err: m.state.error };
      }, handle);
      expect(seen).toEqual({ owner: false, titles: ["Shown One"], addBtn: false, err: null });
    } finally { await v.close(); }

    // ── saving and reloading the world: the saved root is small, holds no screen, and comes back exactly once
    await page.goto(acct.homeUrl);
    await page.waitForFunction(() => /** @type {any} */ (window).$world && lively.identity && lively.identity.did && lively.identity.did.currentUser(), null, { timeout: 90000 });
    await openGaming(page);
    await page.evaluate(() => new Promise((r) => lively.require("lively.identity.WorldTemplateLauncher").toRun(r)));
    const size = await page.evaluate(() => JSON.stringify(lively.identity.signedSerializer._innerSerializeToJso($world)).length);
    expect(size, "the saved world must not contain the library screen").toBeLessThan(60000);
    await page.evaluate(() => lively.identity.WorldTemplateLauncher._saveCurrentWorld());
    await page.waitForTimeout(2500);
    await page.reload();
    await page.waitForFunction(() => /** @type {any} */ (window).$world && $world.submorphs.some((m) => m.constructor.type === "lively.gaming.Gaming"), null, { timeout: 90000 });
    const after = await page.evaluate(async () => {
      const roots = $world.submorphs.filter((m) => m.constructor.type === "lively.gaming.Gaming");
      const m = /** @type {any} */ (roots[0]);
      for (let i = 0; i < 100 && !(m.state && m.state.loaded); i++) await new Promise((r) => setTimeout(r, 100));
      return { roots: roots.length, loaded: m.state && m.state.loaded, titles: m.state ? m.state.entries.map((e) => e.payload.title).sort() : null, tiles: m._view ? m._view.pool.length : 0, hasToolbar: !!document.querySelector('[aria-label="Grid view"]') };
    });
    expect(after.roots).toBe(1);
    expect(after.titles).toEqual(["Hidden One", "Shown One"]);
    expect(after.hasToolbar).toBe(true);
  } finally {
    await deleteAccount(acct);
    await acct.context.close().catch(() => {});
  }
});

test("a Game world: ?template=game opens the template, saves it, and a plain reload brings it back once", async ({ browser }) => {
  const handle = "hometest_gl" + Math.random().toString(36).slice(2, 8);
  const acct = await newAccount(browser, handle);
  try {
    const page = acct.page;
    // what WorldsBrowser's create flow navigates to for the Game template
    await page.goto(acct.homeUrl + "?template=game");
    await page.waitForFunction(() => /** @type {any} */ (window).$world && $world.submorphs.some((m) => m.constructor.type === "lively.gaming.Gaming"), null, { timeout: 90000 });
    expect(new URL(page.url()).searchParams.has("template"), "the one-shot param is stripped").toBe(false);
    await page.waitForTimeout(3000);                                   // the launcher saves the world right after opening it
    await page.goto(acct.homeUrl);                                      // a plain load of the saved world
    await page.waitForFunction(() => /** @type {any} */ (window).$world && $world.submorphs.some((m) => m.constructor.type === "lively.gaming.Gaming"), null, { timeout: 90000 });
    const roots = await page.evaluate(() => $world.submorphs.filter((m) => m.constructor.type === "lively.gaming.Gaming").length);
    expect(roots).toBe(1);
    await expect(page.getByRole("radio", { name: "Grid view" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add a game" })).toBeVisible();   // owner, empty library
  } finally {
    await deleteAccount(acct);
    await acct.context.close().catch(() => {});
  }
});
