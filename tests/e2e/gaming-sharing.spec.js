// @ts-check
// Sharing a game entry with other people, against the real server and four real accounts:
// the owner, two friends (one is added to the audience later) and a stranger who is not a
// friend. Each is its own browser with its own virtual passkey, because opening an entry that
// was sealed to you needs YOUR account key, which only exists in that browser.
//
// Checks what is STORED (recipients, readable state, no title anywhere) and what each reader
// can OPEN, through the real data layer (GameLog) and the real audience sync, not stubs:
//   - sealing to named people, and to a tier (Friends)
//   - an ordinary edit of a shared game keeps its readers
//   - withdrawing a person (a new version under a new key)
//   - a list the game is shared with gaining and losing a member reaching an ALREADY shared
//     game through the audience sync, with no content change (record.cid stays the same)
//   - back to private and to public
//   - the stranger and an anonymous reader get nothing at every step
//
// All accounts are hometest_* and are removed through the deletion feature even when a check
// fails (see account-lifecycle.spec.js on pruning the reserved handles).
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers.js");

test.setTimeout(420 * 1000);

const TITLE = "Quux Sharing Title " + Math.random().toString(36).slice(2, 8);
const REVIEW = "a review nobody but the chosen may read";

const loadGameLog = (page) => page.evaluate(() => new Promise((r) => lively.require("lively.gaming.GameLog").toRun(r)));
// Calls a callback-style GameLog method in the page and resolves its (plain-data) result.
const call = (page, method, args) => page.evaluate(([m, a]) => new Promise((res, rej) => {
  const GL = lively.gaming.GameLog;
  GL[m].apply(GL, a.concat([(e, v) => (e ? rej(new Error(e.message)) : res(v))]));
}), [method, args]);
const fetchEnv = (page, handle, objId) => page.evaluate(async ([h, o]) => {
  const r = await fetch("/@" + h + "/" + o, { credentials: "include", headers: { Accept: "application/json" } });
  return { status: r.status, body: r.ok ? await r.json() : null };
}, [handle, objId]);
// What a reader can open of someone's library: the titles, and how many were returned but unreadable.
const titlesSeenBy = async (page, ownerHandle) => {
  const r = await call(page, "list", [ownerHandle, {}]);
  return { titles: r.entries.map((e) => e.payload.title), hidden: r.hidden };
};
// The settings state the audience sync reads (the recorded audience of each shared entry).
const recorded = (page, objId) => page.evaluate((o) => new Promise((res, rej) =>
  lively.identity.postcardAudience.readSettingsState((e, s) => (e ? rej(e) : res((s.cardAudiences || {})[o] || null)))), objId);
const sync = (page) => page.evaluate(() => new Promise((res, rej) =>
  lively.identity.postcardAudience.syncAudiences({}, (e, report) => (e ? rej(e) : res({ updated: report.updated.length, failed: report.failed })))));
const saveLists = (page, lists) => page.evaluate((l) => new Promise((res, rej) =>
  lively.identity.postcardAudience.saveLists(l, (e) => (e ? rej(e) : res(true)))), lists);

test("a shared game is sealed to exactly the chosen people and follows list changes", async ({ browser, baseURL }) => {
  const R = Math.random().toString(36).slice(2, 6);
  const owner = await newAccount(browser, "hometest_so" + R);
  /** @type {any[]} */
  const others = [];
  const anon = await browser.newContext({ baseURL });
  try {
    const f1 = await newAccount(browser, "hometest_sa" + R); others.push(f1);
    const f2 = await newAccount(browser, "hometest_sb" + R); others.push(f2);
    const stranger = await newAccount(browser, "hometest_sc" + R); others.push(stranger);
    const asPage = (acct) => (method, url, body) => acct.page.evaluate(([m, u, b]) => /** @type {any} */ (window).__req(m, u, b), [method, url, body]);

    // Two friends of the owner (a real request and approval each); the stranger never asks.
    for (const f of [f1, f2]) {
      expect((await asPage(f)("POST", "/@" + owner.handle + "/friend-requests")).status).toBe(200);
      expect((await asPage(owner)("PUT", "/@" + owner.handle + "/friend-requests/" + encodeURIComponent(f.did), { action: "approve" })).body.status).toBe("accepted");
    }
    for (const a of [owner, f1, f2, stranger]) await loadGameLog(a.page);
    const op = owner.page;

    // Who can open the owner's library right now.
    const seen = async (acct) => (await titlesSeenBy(acct.page, owner.handle)).titles;
    const anonSees = async () => {
      const r = await anon.request.get("/@" + owner.handle + "/games", { headers: { Accept: "application/json" } });
      expect(r.status()).toBe(200);
      return { n: (await r.json()).games.length, leaks: (await r.text()).includes(TITLE) };
    };

    // ── a private game: nobody else can open it
    let cur = await call(op, "create", [{ title: TITLE, status: "playing", rating: 3, review: REVIEW }, "private"]);
    expect(await seen(f1)).toEqual([]);

    // ── shared with ONE named friend: stored sealed to that person, readable only by them
    cur = await call(op, "save", [cur, { visibility: "shared", audience: { tiers: [], people: [f1.did] } }]);
    expect(cur.visibility).toBe("shared");
    let env = (await fetchEnv(op, owner.handle, cur.objId)).body;
    expect(env.visibility).toBe("shared");
    expect(env.record.recipients.map((r) => r.did)).toEqual([f1.did]);
    expect(env.record.recipients[0].sealedDek).toBeTruthy();
    expect(env.state.kind).toBe("gamelog");
    expect(env.state.audience).toEqual({ tiers: [], custom: true });            // coarse shape only, no person named
    for (const secret of [TITLE, REVIEW, f1.did]) expect(JSON.stringify(env.state)).not.toContain(secret);
    expect(JSON.stringify(env)).not.toContain(TITLE);                             // still ciphertext
    expect(await recorded(op, cur.objId)).toEqual({ tiers: [], people: [f1.did] });

    expect(await seen(f1)).toEqual([TITLE]);                                      // the friend opens it
    const opened = (await call(f1.page, "list", [owner.handle, {}])).entries[0];
    expect(opened.payload.review).toBe(REVIEW);
    expect(opened.did).toBe(owner.did);
    expect(await seen(f2)).toEqual([]);                                           // the other friend: nothing
    expect(await seen(stranger)).toEqual([]);
    expect(await anonSees()).toEqual({ n: 0, leaks: false });
    // the unreadable entry is not even listed to people who are not recipients
    expect((await titlesSeenBy(f2.page, owner.handle)).hidden).toBe(0);

    // ── an ordinary edit keeps the readers (no audience named: the recorded one is used)
    cur = await call(op, "save", [cur, { rating: 5 }]);
    env = (await fetchEnv(op, owner.handle, cur.objId)).body;
    expect(env.record.recipients.map((r) => r.did)).toEqual([f1.did]);
    expect((await call(f1.page, "list", [owner.handle, {}])).entries[0].payload.rating).toBe(5);
    expect(await seen(f2)).toEqual([]);

    // ── the Friends tier: both friends, still not the stranger
    cur = await call(op, "save", [cur, { visibility: "shared", audience: { tiers: ["friends"], people: [] } }]);
    env = (await fetchEnv(op, owner.handle, cur.objId)).body;
    expect(env.record.recipients.map((r) => r.did).sort()).toEqual([f1.did, f2.did].sort());
    expect(env.state.audience).toEqual({ tiers: ["friends"] });
    expect(await seen(f1)).toEqual([TITLE]);
    expect(await seen(f2)).toEqual([TITLE]);
    expect(await seen(stranger)).toEqual([]);

    // ── withdrawing a person: a new version under a new key, the old reader locked out
    const keyBefore = env.record.wrappedDek;
    cur = await call(op, "save", [cur, { visibility: "shared", audience: { tiers: [], people: [f2.did] } }]);
    env = (await fetchEnv(op, owner.handle, cur.objId)).body;
    expect(env.record.recipients.map((r) => r.did)).toEqual([f2.did]);
    expect(env.record.wrappedDek).not.toBe(keyBefore);
    expect(await seen(f1)).toEqual([]);
    expect(await seen(f2)).toEqual([TITLE]);

    // ── a LIST the game is shared with, then a member joins an already shared game
    const listId = "lst" + R;
    await saveLists(op, [{ id: listId, name: "Raid night", memberDids: [f1.did] }]);
    cur = await call(op, "save", [cur, { visibility: "shared", audience: { tiers: ["list:" + listId], people: [] } }]);
    env = (await fetchEnv(op, owner.handle, cur.objId)).body;
    expect(env.record.recipients.map((r) => r.did)).toEqual([f1.did]);
    expect(env.state.audience).toEqual({ tiers: [], custom: true });             // a list's name and members stay private
    expect(await seen(f1)).toEqual([TITLE]);
    expect(await seen(f2)).toEqual([]);

    await saveLists(op, [{ id: listId, name: "Raid night", memberDids: [f1.did, f2.did] }]);
    const cidBefore = env.record.cid;
    const s1 = await sync(op);
    expect(s1.failed).toEqual([]);
    expect(s1.updated).toBeGreaterThanOrEqual(1);
    env = (await fetchEnv(op, owner.handle, cur.objId)).body;
    expect(env.record.cid).toBe(cidBefore);                                       // metadata only: the content did not change
    expect(env.record.recipients.map((r) => r.did).sort()).toEqual([f1.did, f2.did].sort());
    expect(await seen(f2)).toEqual([TITLE]);                                      // the new member can open it

    await saveLists(op, [{ id: listId, name: "Raid night", memberDids: [f2.did] }]);
    await sync(op);
    expect(await seen(f1)).toEqual([]);                                           // removed from the list: withdrawn
    expect(await seen(f2)).toEqual([TITLE]);
    expect(await seen(stranger)).toEqual([]);

    // ── back to private: sealed to the owner alone, and the recorded audience is gone
    cur = await call(op, "save", [cur, { visibility: "private" }]);
    env = (await fetchEnv(op, owner.handle, cur.objId)).body;
    expect(env.visibility).toBe("private");
    expect(env.record.recipients).toEqual([]);
    expect(env.state.audience).toBeUndefined();
    expect(await recorded(op, cur.objId)).toBeNull();
    expect(await seen(f2)).toEqual([]);
    expect(await sync(op)).toMatchObject({ failed: [] });                         // the sync does not put anyone back
    expect((await fetchEnv(op, owner.handle, cur.objId)).body.record.recipients).toEqual([]);

    // ── public: anyone, including the stranger and an anonymous reader
    cur = await call(op, "save", [cur, { visibility: "public" }]);
    expect(await seen(stranger)).toEqual([TITLE]);
    expect((await anonSees()).n).toBe(1);

    // ── removing a shared game withdraws it from everyone
    cur = await call(op, "save", [cur, { visibility: "shared", audience: { tiers: ["friends"], people: [] } }]);
    expect(await seen(f1)).toEqual([TITLE]);
    await call(op, "remove", [cur]);
    expect(await seen(f1)).toEqual([]);
    expect(await seen(f2)).toEqual([]);
    expect(await recorded(op, cur.objId)).toBeNull();
  } finally {
    await anon.close().catch(() => {});
    for (const o of others) { await deleteAccount(o); await o.context.close().catch(() => {}); }
    await deleteAccount(owner);
    await owner.context.close().catch(() => {});
  }
});

// ── The Friends choice in the template itself, with real clicks: the detail dialog's pill opens
// the audience dialog, its Save seals the game to the chosen friend, and the dialogs stack sanely.
const openGaming = (page) => page.evaluate(async () => {
  await new Promise((r) => lively.require("lively.gaming.Gaming").toRun(r));
  const w = /** @type {any} */ (window);
  if (w.__g) w.__g.remove();
  w.__g = lively.gaming.Gaming.open();
  for (let i = 0; i < 100 && !w.__g.state.loaded; i++) await new Promise((r) => setTimeout(r, 100));
  return { loaded: w.__g.state.loaded, error: w.__g.state.error };
});

test("the Friends pill opens the audience dialog and Save shares the game with the chosen friend", async ({ browser }) => {
  const R = Math.random().toString(36).slice(2, 6);
  const owner = await newAccount(browser, "hometest_uo" + R);
  let friend = null;
  try {
    friend = await newAccount(browser, "hometest_uf" + R);
    expect((await friend.page.evaluate(([m, u]) => /** @type {any} */ (window).__req(m, u), ["POST", "/@" + owner.handle + "/friend-requests"])).status).toBe(200);
    expect((await owner.page.evaluate(([m, u, b]) => /** @type {any} */ (window).__req(m, u, b), ["PUT", "/@" + owner.handle + "/friend-requests/" + encodeURIComponent(friend.did), { action: "approve" }])).body.status).toBe("accepted");

    const page = owner.page;
    await loadGameLog(page);
    await loadGameLog(friend.page);
    await call(page, "create", [{ title: TITLE, status: "playing" }, "private"]);
    const state = await openGaming(page);
    test.skip(!!state.error, "the running server does not serve /@handle/games yet: restart it from WSL (" + state.error + ")");

    // ── detail dialog -> the Friends pill -> the audience dialog (no longer disabled)
    await page.getByRole("button", { name: new RegExp("^" + TITLE + ", ") }).click();
    await expect(page.getByRole("dialog", { name: "Game: " + TITLE })).toBeVisible();
    await page.getByRole("radio", { name: "Visibility: Friends" }).click();
    // The audience dialog is plain morphs with no roles: tag the nodes to click by their text, inside its own panel.
    const tag = (text, id) => page.evaluate(([t, i]) => {
      let panel = null;
      $world.withAllSubmorphsDo((m) => { if (!panel && typeof m.textString === "string" && m.textString === "Who can see this game" && m.owner && m.owner.owner && m.owner.owner.constructor.type === "lively.morphic.Box" && /** @type {any} */ (m.owner).getExtent().x === 460) panel = m.owner; });
      if (!panel) return false;
      let hit = null;
      panel.withAllSubmorphsDo((m) => { if (!hit && m.textString === t && m.owner && m.owner !== panel) hit = m; });
      if (!hit) return false;
      hit.owner.renderContext().shapeNode.setAttribute("data-pw", i);
      return true;
    }, [text, id]);
    await expect.poll(() => tag("Friends", "aud-friends")).toBe(true);
    // its wording is about a game, and Esc does not close the dialog underneath it
    expect(await page.evaluate(() => { let n = 0; $world.withAllSubmorphsDo((m) => { if (m.textString === "Only you can open this game.") n++; }); return n; })).toBe(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Game: " + TITLE })).toBeVisible();

    await page.locator('[data-pw="aud-friends"]').click();
    await expect.poll(() => page.evaluate(() => { let n = 0; $world.withAllSubmorphsDo((m) => { if (m.textString === "Sealed to 1 person. Only they can open it.") n++; }); return n; })).toBe(1);
    await expect.poll(() => tag("Save", "aud-save")).toBe(true);
    await page.locator('[data-pw="aud-save"]').click();

    // ── stored: sealed to the friend, and the tile says Shared
    await expect.poll(async () => {
      const r = await page.evaluate(async (h) => (await (await fetch("/@" + h + "/games", { credentials: "include", headers: { Accept: "application/json" } })).json()).games[0], owner.handle);
      return JSON.stringify({ v: r.visibility, to: r.record.recipients.map((x) => x.did) });
    }, { timeout: 20000 }).toBe(JSON.stringify({ v: "shared", to: [friend.did] }));
    const seen = await call(friend.page, "list", [owner.handle, {}]);
    expect(seen.entries.map((e) => e.payload.title)).toEqual([TITLE]);

    // ── the pill is selected and the dialog's explanation is about the audience
    await expect(page.getByRole("radio", { name: "Visibility: Friends" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: new RegExp("^" + TITLE + ", .*Shared") })).toBeVisible();
  } finally {
    if (friend) { await deleteAccount(friend); await friend.context.close().catch(() => {}); }
    await deleteAccount(owner);
    await owner.context.close().catch(() => {});
  }
});

// ── The postcard side: changing a game's status offers to share it, "Share as postcard" opens
// the real postcard editor prefilled (nothing is created until the author edits), and the card
// that results is sealed to the friend, carries the game block inside the ciphertext, and shows
// that block when the friend opens it.
const theEditor = () => { let ed = null; $world.withAllSubmorphsDo((m) => { if (m.constructor.type === "lively.identity.PostCardEditor") ed = m; }); return ed; };

test("a status change offers to share; the postcard is created on the first edit, sealed to Friends, with the game block", async ({ browser }) => {
  const R = Math.random().toString(36).slice(2, 6);
  const owner = await newAccount(browser, "hometest_po" + R);
  let friend = null;
  try {
    friend = await newAccount(browser, "hometest_pf" + R);
    expect((await friend.page.evaluate(([m, u]) => /** @type {any} */ (window).__req(m, u), ["POST", "/@" + owner.handle + "/friend-requests"])).status).toBe(200);
    expect((await owner.page.evaluate(([m, u, b]) => /** @type {any} */ (window).__req(m, u, b), ["PUT", "/@" + owner.handle + "/friend-requests/" + encodeURIComponent(friend.did), { action: "approve" }])).body.status).toBe("accepted");

    const page = owner.page;
    await loadGameLog(page);
    const entry = await call(page, "create", [{ title: TITLE, status: "backlog", rating: 4, review: REVIEW, manual_playtime_minutes: 150, cover_url: "https://example.invalid/cover.jpg" }, "private"]);
    const state = await openGaming(page);
    test.skip(!!state.error, "the running server does not serve /@handle/games yet: restart it from WSL (" + state.error + ")");

    // ── changing the status to Playing offers to share (a repeat of the same status does not)
    await page.getByRole("button", { name: new RegExp("^" + TITLE + ", ") }).click();
    await expect(page.getByRole("dialog", { name: "Game: " + TITLE })).toBeVisible();
    await page.getByRole("radio", { name: "Status: Playing" }).click();
    const prompt = page.getByRole("region", { name: /^You started / });
    await expect(prompt).toBeVisible();
    await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();
    await page.getByRole("button", { name: "Not now" }).click();
    await expect(prompt).toHaveCount(0);
    await page.getByRole("radio", { name: "Status: Playing" }).click();           // already playing: no new offer
    await page.waitForTimeout(400);
    await expect(prompt).toHaveCount(0);
    await page.getByRole("radio", { name: "Status: Backlog" }).click();           // backlog never offers
    await page.waitForTimeout(400);
    await expect(page.getByRole("region")).toHaveCount(0);
    await page.getByRole("radio", { name: "Status: Completed" }).click();
    await expect(page.getByRole("region", { name: /^You finished / })).toBeVisible();

    // ── Share as postcard -> the dialog; rating is on, playtime is off
    await page.getByRole("button", { name: "Share as postcard" }).first().click();
    await expect(page.getByRole("dialog", { name: "Share " + TITLE + " as a postcard" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Show my rating" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("checkbox", { name: "Show my playtime" })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("checkbox", { name: "Show my playtime" }).click();
    await expect(page.getByRole("checkbox", { name: "Show my playtime" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Open postcard" }).click();

    // ── the editor opens prefilled; nothing exists on the server yet
    await page.waitForFunction(`(${theEditor.toString()})() && (${theEditor.toString()})().editorView && !(${theEditor.toString()})()._pendingPrefill`, null, { timeout: 60000 });
    const pre = await page.evaluate((fn) => {
      const ed = eval("(" + fn + ")")();
      return { game: ed._game, audience: ed._audience, visibility: ed._visibility, objId: ed._objId, paras: ed.editorView.state.doc.content.content.map((n) => n.textContent) };
    }, theEditor.toString());
    expect(pre.game).toEqual({ title: TITLE, cover_url: "https://example.invalid/cover.jpg", igdb_id: null, status: "completed", rating: 4, playtime_minutes: 150, playtime_source: "manual" });
    expect(pre.audience).toEqual({ tiers: ["friends"], people: [] });
    expect(pre.visibility).toBe("private");
    expect(pre.paras).toEqual(["Finished " + TITLE, REVIEW]);
    await page.waitForTimeout(3500);                                             // longer than the autosave delay
    expect(await page.evaluate((fn) => eval("(" + fn + ")")()._objId, theEditor.toString())).toBeNull();
    const none = await page.evaluate(async (h) => (await (await fetch("/@" + h + "/postcards", { credentials: "include", headers: { Accept: "application/json" } })).json()), owner.handle);
    expect((none.postcards || []).length).toBe(0);

    // ── a real edit creates it
    await page.locator(".ProseMirror").first().click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" Great run!");
    const objId = await page.waitForFunction((fn) => { const ed = eval("(" + fn + ")")(); return ed && ed._objId && !ed._saveInFlight ? ed._objId : false; }, theEditor.toString(), { timeout: 60000 }).then((h) => h.jsonValue());

    const env = (await fetchEnv(page, owner.handle, objId)).body;
    expect(env.type).toBe("postcard");
    expect(env.visibility).toBe("shared");
    expect(env.record.recipients.map((r) => r.did)).toEqual([friend.did]);
    expect(env.state.hasGame).toBe(true);                                         // the marker says THAT, not which
    expect(env.state.audience).toEqual({ tiers: ["friends"] });
    expect(JSON.stringify(env)).not.toContain(TITLE);                              // the game is inside the ciphertext
    expect(typeof env.record.payload).toBe("string");

    // ── the friend opens it: the block is in the decrypted payload and drawn on the card
    const seen = await friend.page.evaluate(async ([h, o]) => {
      await new Promise((r) => lively.require("lively.identity.PostCardView").toRun(r));
      const env = await (await fetch("/@" + h + "/" + o, { credentials: "include", headers: { Accept: "application/json" } })).json();
      const payload = await new Promise((res, rej) => lively.identity.postCardSerializer.deserializeEncryptedAuto(env, (e, mode, doc, p) => (e ? rej(e) : res(p))));
      const holder = new lively.morphic.Box(lively.rect(20, 80, 420, 560));
      $world.addMorph(holder);
      lively.identity.PostCardView.open(h, o, { target: holder });
      return { game: payload.game, text: JSON.stringify(payload.doc) };
    }, [owner.handle, objId]);
    expect(seen.game.title).toBe(TITLE);
    expect(seen.game.rating).toBe(4);
    expect(seen.text).toContain("Great run!");
    await friend.page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "View content"), null, { timeout: 30000 });
    await friend.page.evaluate(() => { Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "View content").click(); });
    const block = friend.page.locator(".lively-postcard-game");
    await expect(block).toHaveCount(1, { timeout: 30000 });
    await expect(block).toContainText(TITLE);
    await expect(block).toContainText("Completed");
    await expect(block).toContainText("★★★★☆");
    await expect(block).toContainText("2.5 h · self-reported");
    expect(entry.objId).toBeTruthy();
  } finally {
    if (friend) { await deleteAccount(friend); await friend.context.close().catch(() => {}); }
    await deleteAccount(owner);
    await owner.context.close().catch(() => {});
  }
});
