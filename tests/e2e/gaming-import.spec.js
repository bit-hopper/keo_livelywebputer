// @ts-check
// Importing a linked account's library into the Gaming template, driven with real mouse
// input against the real server, a real throwaway account and real (encrypted, signed)
// writes. Only the two link-server answers are faked, at the network level (page.route),
// because the sync route needs a store key that is not part of this test: the real client
// code (GameLinks, the dialog, GamingImport, Gaming.importGames, GameLog) all runs.
//
// What it proves:
//   - the preview counts new / already-in-library / unreadable correctly, de-duplicates by the
//     store's id (not the title), and pages its rows
//   - unticking a row changes what is imported; nothing is written before "Import"
//   - imported games land PRIVATE, sealed (the stored envelope holds no title), with the
//     store as the playtime's source and a sensible starting shelf
//   - a refresh touches only the store's facts: status, rating, review and typed playtime stay
//   - running it again does not add anything twice, and a second concurrent run is refused
//   - the failure messages and the "no account linked" state
//
// Registers a hometest_* account through a CDP virtual passkey and removes it afterwards
// (see account-lifecycle.spec.js for the reserved-handle note). Needs the dev server running.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers.js");

test.setTimeout(240 * 1000);

const NEW_COUNT = 45;                       // ids 1001..1045, plus 1000 which is already in the library
// Fixed once: a store reports the same last-played time on every read, so a second read of an
// unchanged library must not look like a change.
const PLAYED_TWO_DAYS_AGO = new Date(Date.now() - 2 * 86400000).toISOString();

function candidate(id, extra) {
  return Object.assign({ platform: "steam", external_id: String(id), name: "Game " + id, cover_url: null, playtime_minutes: id % 7 === 0 ? 0 : id, last_played_at: null, url: null }, extra);
}

function syncBody() {
  const list = [candidate(1000, { playtime_minutes: 120 })];                   // already in the library, 60 -> 120
  for (let i = 1001; i <= 1000 + NEW_COUNT; i++) list.push(candidate(i));
  list[1] = candidate(1001, { last_played_at: PLAYED_TWO_DAYS_AGO });   // played two days ago
  list.push(candidate(1001, { name: "Game 1001" }));                            // the same game listed twice
  list.push(candidate("", { name: "Unreadable" }));                             // no id: cannot be an entry
  return { platform: "steam", fetched_at: new Date().toISOString(), total: list.length, partial: false, warnings: [], candidates: list };
}

const status = (accounts) => ({ providers: { steam: { available: true, reason: null }, itch: { available: false, reason: "not set up" } }, accounts });
const ACCOUNT = { platform: "steam", display_name: "Steam ID 76561190000000001", status: "active", linked_at: "2026-10-21T00:00:00.000Z", last_synced_at: null, last_error: null };

const openGaming = (page) => page.evaluate(async () => {
  await new Promise((r) => lively.require("lively.gaming.Gaming").toRun(r));
  const w = /** @type {any} */ (window);
  if (w.__g) w.__g.remove();
  w.__g = lively.gaming.Gaming.open();
  for (let i = 0; i < 100 && !w.__g.state.loaded; i++) await new Promise((r) => setTimeout(r, 100));
  return { loaded: w.__g.state.loaded, error: w.__g.state.error };
});

const stored = (page) => page.evaluate(() => new Promise((res, rej) => {
  lively.gaming.GameLog.list(lively.identity.did.currentUser().handle, {}, (e, v) => (e ? rej(new Error(e.message)) : res(v.entries.map((x) => ({
    title: x.payload.title, vis: x.visibility, status: x.payload.status, rating: x.payload.rating, review: x.payload.review,
    ids: x.payload.external_ids, mins: x.payload.playtime_minutes, source: x.payload.playtime_source, manual: x.payload.manual_playtime_minutes,
    synced: x.payload.last_synced_at, platforms: x.payload.platforms,
  })))));
}));

async function storedWhere(page, ok, what) {
  let last = null;
  await expect.poll(async () => { last = await stored(page); return ok(last); }, { timeout: 30000, message: what }).toBe(true);
  return last;
}

// Mocks the two link-server routes. `sync` is a function returning { status, json }.
async function mockLinks(page, accounts, sync) {
  await page.route("**/nodejs/GameLinkServer/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status(accounts)) }));
  await page.route("**/nodejs/GameLinkServer/steam/sync", (r) => { const s = sync(); return r.fulfill({ status: s.status, contentType: "application/json", body: JSON.stringify(s.json) }); });
}

// Set LK_SHOTS=<existing directory> to save a screenshot at each stage; otherwise a no-op.
const shot = (page, name) => (process.env.LK_SHOTS ? page.screenshot({ path: require("path").join(process.env.LK_SHOTS, name + ".png") }) : Promise.resolve());

// every visible string in the open modal, for wording checks
const dialogText = (page) => page.evaluate(() => {
  const out = [];
  const m = /** @type {any} */ (lively.gaming.GamingUI)._modal;
  if (m) m.panel.withAllSubmorphsDo((s) => { if (s.textString) out.push(String(s.textString)); });
  return out.join(" | ");
});

test("importing a library: preview, paging, private + sealed, refresh keeps personal fields, idempotent", async ({ browser }) => {
  const handle = "hometest_im" + Math.random().toString(36).slice(2, 8);
  const acct = await newAccount(browser, handle);
  try {
    const page = acct.page;
    const state = await openGaming(page);
    test.skip(!!state.error, "the running server does not serve /@handle/games yet: restart it from WSL (" + state.error + ")");

    // ── a library that already holds one imported game (with personal fields set) and a hand-added lookalike
    await page.evaluate(() => new Promise((res) => {
      const g = /** @type {any} */ (window).__g;
      g.addGame({ title: "Game 1000", external_ids: { steam: "1000" }, platforms: ["Steam"], status: "completed", rating: 4, review: "loved it", playtime_minutes: 60, playtime_source: "steam", manual_playtime_minutes: 999 }, "private", () => {
        g.addGame({ title: "Game 1001" }, "private", () => res(null));        // same TITLE, no store id: must not be merged
      });
    }));
    await storedWhere(page, (l) => l.length === 2, "the two starting entries are stored");

    let syncs = 0;
    await mockLinks(page, [ACCOUNT], () => { syncs++; return { status: 200, json: syncBody() }; });

    // ── the Import button opens the dialog; nothing is read until "Read library" is pressed
    await page.getByRole("button", { name: "Import games from a linked account" }).click();
    await expect(page.getByRole("dialog", { name: "Import games" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Read library" })).toBeVisible();
    expect(syncs).toBe(0);
    expect(await dialogText(page)).toContain("Not affiliated with or endorsed by");
    await shot(page, "1-ready");

    // ── read: 48 raw candidates (one listed twice, one with no id) make 46 distinct, usable games
    await page.getByRole("button", { name: "Read library" }).click();
    await expect(page.getByText(/Found 46 games/)).toBeVisible();
    expect(syncs).toBe(1);
    const t = await dialogText(page);
    expect(t).toContain("Found 46 games · 45 new · 1 already in your library");     // the hand-added "Game 1001" does NOT count as present
    expect(t).toContain("1 entry could not be read and was left out");
    expect(t).toContain("Also refreshes the playtime of 1 game already in your library");

    await shot(page, "2-preview");
    // ── nothing has been written yet
    expect((await stored(page)).length).toBe(2);

    // ── paging: 40 rows, then the rest
    await expect(page.getByRole("button", { name: /^Will import: Game 1040$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Will import: Game 1041$/ })).toHaveCount(0);
    await page.getByRole("button", { name: /^Show 5 more/ }).click();
    await expect(page.getByRole("button", { name: /^Will import: Game 1045$/ })).toHaveCount(1);

    // ── untick one (a real click on its row); the count and the button follow
    await expect(page.getByRole("button", { name: "Import 45 games" })).toBeVisible();
    await page.getByRole("button", { name: "Will import: Game 1003", exact: true }).click();
    await expect(page.getByRole("button", { name: "Will not import: Game 1003", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import 44 games" })).toBeVisible();

    // ── private by default, and said so
    await expect(page.getByRole("radio", { name: "Visibility: Private" })).toHaveAttribute("aria-pressed", "true");
    expect(await dialogText(page)).toContain("Encrypted");

    // ── import
    await shot(page, "3-preview-unticked");
    await page.getByRole("button", { name: "Import 44 games" }).click();
    await expect(page.getByRole("button", { name: "Done" })).toBeVisible({ timeout: 60000 });
    expect(await dialogText(page)).toContain("Imported 44 games, refreshed 1");
    await shot(page, "4-done");

    const lib = await storedWhere(page, (l) => l.length === 46, "44 new entries stored next to the 2 existing");
    // the new ones: private, tagged with the store, playtime sourced, no personal data
    const byId = (id) => lib.filter((e) => e.ids && e.ids.steam === String(id))[0];
    for (let i = 1001; i <= 1045; i++) {
      if (i === 1003) { expect(byId(i)).toBeUndefined(); continue; }
      const e = byId(i);
      expect(e, "entry " + i).toBeTruthy();
      expect(e.vis).toBe("private");
      expect(e.source).toBe("steam");
      expect(e.platforms).toEqual(["Steam"]);
      expect(e.rating).toBe(0);
      expect(e.review).toBe("");
      expect(e.manual).toBeNull();
      expect(e.synced).toBeTruthy();
    }
    expect(byId(1001).status).toBe("playing");           // played two days ago
    expect(byId(1002).status).toBe("backlog");
    expect(byId(1008).mins).toBe(0);                     // zero is a real value from the store
    // the refreshed one: only the store's facts changed
    const old = byId(1000);
    expect(old.mins).toBe(120);
    expect([old.status, old.rating, old.review, old.manual, old.vis]).toEqual(["completed", 4, "loved it", 999, "private"]);
    // the hand-added lookalike was left alone
    const hand = lib.filter((e) => e.title === "Game 1001" && !(e.ids && e.ids.steam));
    expect(hand).toHaveLength(1);

    // ── the server holds ciphertext: no imported title appears anywhere in what it stores
    const raw = await page.evaluate(async (h) => JSON.stringify(await (await fetch("/@" + h + "/games?limit=200", { credentials: "include", headers: { Accept: "application/json" } })).json()), handle);
    expect(raw).not.toContain("Game 1010");
    expect(raw).not.toContain("loved it");

    // ── the library on screen caught up
    expect(await page.evaluate(() => /** @type {any} */ (window).__g.state.entries.length)).toBe(46);

    // ── run it again: only the unticked game is new, and nothing is refreshed or added twice
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Import games from a linked account" }).click();
    await page.getByRole("button", { name: "Read library" }).click();
    await expect(page.getByText(/Found 46 games/)).toBeVisible();
    const t2 = await dialogText(page);
    expect(t2).toContain("Found 46 games · 1 new · 45 already in your library");
    expect(t2).not.toContain("Also refreshes");
    await page.keyboard.press("Escape");

    // ── a second import started while one is running is refused, and a repeat adds nothing
    const dup = await page.evaluate(() => new Promise((res) => {
      const g = /** @type {any} */ (window).__g, GI = lively.gaming.GamingImport;
      const plan = GI.plan([{ platform: "steam", external_id: "2001", name: "Race Game" }], g.state.entries, {});
      const opts = { selected: plan.fresh, visibility: "private", syncedAt: new Date().toISOString() };
      let first = null, second = null, n = 0;
      const fin = () => { if (++n === 2) res({ first, second }); };
      g.importGames("steam", plan, opts, (e, s) => { first = e ? e.message : s; fin(); });
      g.importGames("steam", plan, opts, (e, s) => { second = e ? e.message : s; fin(); });
    }));
    expect(dup.second).toBe("An import is already running");
    expect(dup.first.created).toBe(1);
    await storedWhere(page, (l) => l.length === 47, "exactly one more entry");
  } finally {
    await deleteAccount(acct);
  }
});

test("import failures and the unlinked state use plain words and a way forward", async ({ browser }) => {
  const handle = "hometest_ie" + Math.random().toString(36).slice(2, 8);
  const acct = await newAccount(browser, handle);
  try {
    const page = acct.page;
    const state = await openGaming(page);
    test.skip(!!state.error, "the running server does not serve /@handle/games yet: restart it from WSL (" + state.error + ")");

    // ── no account linked: says so, offers to connect, and Settings opens on the Connected tab
    await page.route("**/nodejs/GameLinkServer/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status([])) }));
    await page.getByRole("button", { name: "Import games from a linked account" }).click();
    await expect(page.getByText("No account is linked yet.")).toBeVisible();
    await page.getByRole("button", { name: "Connect an account" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.waitForFunction(() => { let found = false; $world.withAllSubmorphsDo((m) => { if (m.name === "settingsContent") found = true; }); return found; });
    await page.evaluate(() => { $world.submorphs.filter((m) => /Settings/.test(m.getName && m.getName() || "") || (m.titleBar && /Settings/.test(String(m.titleBar.getTitle ? m.titleBar.getTitle() : "")))).forEach((w) => w.remove()); });

    // ── each failure reads as a sentence, never a raw code
    const cases = [
      [429, { retry_after: 45 }, "Too soon", /about 45 seconds/],
      [503, {}, "Not set up here", /isn't set up to read Steam libraries/],
      [404, { error: "not linked" }, "Steam isn't linked", /Link it again in Settings/],
      [409, { code: "needs_reconnect" }, "Link Steam again", /no longer accepts the saved link/],
      [502, {}, "Steam didn't answer", /Try again in a minute/],
    ];
    for (const [code, json, title, text] of cases) {
      await page.unroute("**/nodejs/GameLinkServer/status");
      await page.unroute("**/nodejs/GameLinkServer/steam/sync");
      await mockLinks(page, [ACCOUNT], () => ({ status: code, json }));
      await page.getByRole("button", { name: "Import games from a linked account" }).click();
      await page.getByRole("button", { name: "Read library" }).click();
      await expect(page.getByText(title, { exact: true })).toBeVisible();
      expect(await dialogText(page)).toMatch(text);
      await shot(page, "err-" + code);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }

    // ── an account the store no longer accepts offers "Link again", not a read
    await page.unroute("**/nodejs/GameLinkServer/status");
    await page.route("**/nodejs/GameLinkServer/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status([Object.assign({}, ACCOUNT, { status: "needs_reconnect" })])) }));
    await page.getByRole("button", { name: "Import games from a linked account" }).click();
    await expect(page.getByRole("button", { name: "Link again" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Read library" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // ── a library with nothing in it (the privacy case): the hint says how to fix it
    await page.unroute("**/nodejs/GameLinkServer/status");
    await mockLinks(page, [ACCOUNT], () => ({ status: 200, json: { platform: "steam", fetched_at: new Date().toISOString(), total: 0, partial: true, warnings: ["Steam returned no games."], candidates: [] } }));
    await page.getByRole("button", { name: "Import games from a linked account" }).click();
    await page.getByRole("button", { name: "Read library" }).click();
    await expect(page.getByText("No games found on Steam")).toBeVisible();
    const t = await dialogText(page);
    expect(t).toContain("Steam returned no games.");
    expect(t).toContain("Game details");
  } finally {
    await deleteAccount(acct);
  }
});
