// @ts-check
// The Gaming template's data layer (core/lively/gaming/GameLog.js) against the real
// server: what is stored for a private and a public entry, that a save which returns
// to an earlier value really persists, visibility changes, soft delete, and who can
// read what through GET /@handle/games.
//
// Registers throwaway hometest_* accounts through a CDP virtual passkey and removes
// them through the deletion feature even when a check fails (see account-lifecycle
// for the reserved-handle note). Needs the dev server running at baseURL.
//
// The /games listing is a server route: the listing tests are skipped, loudly, when
// the running server predates it (restart it from WSL to pick the route up).
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers.js");

test.setTimeout(180 * 1000);

const TITLE = "Zzyzx Unique Title " + Math.random().toString(36).slice(2, 8);

async function loadGameLog(page) {
  await page.evaluate(() => new Promise((r) => lively.require("lively.gaming.GameLog").toRun(r)));
}
// Calls a callback-style GameLog method in the page and resolves its result.
const call = (page, method, args) => page.evaluate(([m, a]) => new Promise((res, rej) => {
  const GL = lively.gaming.GameLog;
  GL[m].apply(GL, a.concat([(e, v) => (e ? rej(new Error(e.message)) : res(v))]));
}), [method, args]);
const fetchEnv = (page, handle, objId) => page.evaluate(async ([h, o]) => {
  const r = await fetch("/@" + h + "/" + o, { credentials: "include", headers: { Accept: "application/json" } });
  return { status: r.status, body: r.ok ? await r.json() : null };
}, [handle, objId]);

test("a game entry: sealed when private, plain when public, every save sticks, delete is soft", async ({ browser }) => {
  const handle = "hometest_g" + Math.random().toString(36).slice(2, 8);
  const acct = await newAccount(browser, handle);
  try {
    const page = acct.page;
    await loadGameLog(page);

    // ── private: the server holds ciphertext and learns nothing about the game
    const e1 = await call(page, "create", [{ title: TITLE, genre: "Roguelike", status: "playing", rating: 3, review: "secret review text" }, "private"]);
    expect(e1.visibility).toBe("private");
    const stored = await fetchEnv(page, handle, e1.objId);
    expect(stored.status).toBe(200);
    const env = stored.body;
    expect(env.type).toBe("gamelog");
    expect(env.visibility).toBe("private");
    expect(typeof env.record.payload).toBe("string");               // ciphertext, not an object
    expect(env.record.wrappedDek).toBeTruthy();
    expect(env.state).toEqual({ kind: "gamelog" });                 // no title, no details
    const raw = JSON.stringify(env);
    for (const secret of [TITLE, "Roguelike", "secret review text"]) expect(raw).not.toContain(secret);
    expect(env.sig).toBeTruthy();                                   // signed (the account has a delegation cert)

    // ── it opens again for the owner
    const opened = await call(page, "open", [env]);
    expect(opened.payload.title).toBe(TITLE);
    expect(opened.payload.rating).toBe(3);
    expect(opened.payload.manual_playtime_minutes).toBeNull();      // defaults() filled the rest in

    // ── a save that returns to an earlier value must persist (the cid-collision trap)
    let cur = e1;
    for (const rating of [4, 3, 5, 3]) {
      cur = await call(page, "save", [cur, { rating }]);
      const back = await call(page, "open", [(await fetchEnv(page, handle, cur.objId)).body]);
      expect(back.payload.rating, "rating " + rating + " stored").toBe(rating);
    }

    // ── private -> public: the payload becomes readable JSON, anyone can fetch it
    cur = await call(page, "save", [cur, { visibility: "public", status: "completed" }]);
    expect(cur.visibility).toBe("public");
    const pub = (await fetchEnv(page, handle, cur.objId)).body;
    expect(pub.visibility).toBe("public");
    expect(pub.record.payload.title).toBe(TITLE);
    expect(pub.record.wrappedDek).toBeNull();
    const anon = await page.context().browser().newContext({ baseURL: page.url().split("/@")[0] });
    try {
      const r = await anon.request.get("/@" + handle + "/" + cur.objId, { headers: { Accept: "application/json" } });
      expect(r.status()).toBe(200);
      expect((await r.json()).record.payload.title).toBe(TITLE);
    } finally { await anon.close(); }

    // ── public -> private again: sealed, and an anonymous reader is refused
    cur = await call(page, "save", [cur, { visibility: "private" }]);
    const sealedAgain = (await fetchEnv(page, handle, cur.objId)).body;
    expect(typeof sealedAgain.record.payload).toBe("string");
    expect(JSON.stringify(sealedAgain)).not.toContain(TITLE);
    const anon2 = await browser.newContext({ baseURL: page.url().split("/@")[0] });
    try {
      const r = await anon2.request.get("/@" + handle + "/" + cur.objId, { headers: { Accept: "application/json" } });
      expect([401, 403, 404]).toContain(r.status());
      expect(await r.text()).not.toContain(TITLE);
    } finally { await anon2.close(); }

    // ── manual playtime is shown with its source
    cur = await call(page, "save", [cur, { manual_playtime_minutes: 90 }]);
    expect(await page.evaluate((p) => lively.gaming.GameLog.playtimeOf(p), cur.payload)).toEqual({ minutes: 90, source: "manual" });

    // ── soft delete: a new version flagged deleted; the object is still stored
    const gone = await call(page, "remove", [cur]);
    expect(gone.envelope.state).toEqual({ kind: "gamelog", deleted: true });
    expect((await fetchEnv(page, handle, cur.objId)).body.state.deleted).toBe(true);

    // ── a creation with no title is refused before anything is sent
    await expect(call(page, "create", [{ title: "   " }, "private"])).rejects.toThrow(/title/);
  } finally {
    await deleteAccount(acct);
    await acct.context.close().catch(() => {});
  }
});

test("GET /@handle/games: the owner sees everything, others only public entries, deleted ones nobody", async ({ browser, baseURL }) => {
  const ha = "hometest_ga" + Math.random().toString(36).slice(2, 7);
  const hb = "hometest_gb" + Math.random().toString(36).slice(2, 7);
  const A = await newAccount(browser, ha);
  let B = null;
  try {
    const page = A.page;
    await loadGameLog(page);
    const probe = await page.evaluate(async (h) => {
      const r = await fetch("/@" + h + "/games", { credentials: "include", headers: { Accept: "application/json" } });
      return { status: r.status, type: r.headers.get("content-type") || "" };
    }, ha);
    test.skip(!(probe.status === 200 && probe.type.includes("json")), "the running server does not serve /@handle/games yet: restart it from WSL (got " + probe.status + " " + probe.type + ")");

    const priv = await call(page, "create", [{ title: "Private One" }, "private"]);
    await call(page, "create", [{ title: "Public One" }, "public"]);
    const dead = await call(page, "create", [{ title: "Dead One" }, "public"]);
    await call(page, "remove", [dead]);

    // owner: both live entries, decrypted, newest first, deleted one absent
    const mine = await call(page, "list", [ha, {}]);
    expect(mine.entries.map((e) => e.payload.title)).toEqual(["Public One", "Private One"]);
    expect(mine.hidden).toBe(0);

    // anonymous: the public one only (and it is plain JSON, no recipients leaked)
    const anon = await browser.newContext({ baseURL });
    try {
      const r = await anon.request.get("/@" + ha + "/games", { headers: { Accept: "application/json" } });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.games.map((g) => g.record.payload.title)).toEqual(["Public One"]);
      expect(await r.text()).not.toContain("Private One");
      expect(body.cursor).toBeNull();
    } finally { await anon.close(); }

    // another signed-in account sees the same: public only
    B = await newAccount(browser, hb);
    await loadGameLog(B.page);
    const theirs = await call(B.page, "list", [ha, {}]);
    expect(theirs.entries.map((e) => e.payload.title)).toEqual(["Public One"]);

    // paging: a page size of 1 walks the library with a cursor and loses nothing
    const walked = await page.evaluate(async (h) => {
      const titles = []; let cursor = null, pages = 0;
      do {
        const r = await fetch("/@" + h + "/games?limit=1" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), { credentials: "include", headers: { Accept: "application/json" } });
        const b = await r.json(); pages++;
        b.games.forEach((g) => titles.push(g.objId));
        cursor = b.cursor;
      } while (cursor && pages < 10);
      return { n: titles.length, unique: new Set(titles).size, pages };
    }, ha);
    expect(walked).toEqual({ n: 2, unique: 2, pages: 2 });
    expect(priv.objId).toBeTruthy();

    // a handle that does not exist is a 404, not an empty library
    const nobody = await page.evaluate(async () => (await fetch("/@hometest_nobody_zzz/games", { headers: { Accept: "application/json" } })).status);
    expect(nobody).toBe(404);
  } finally {
    if (B) { await deleteAccount(B); await B.context.close().catch(() => {}); }
    await deleteAccount(A);
    await A.context.close().catch(() => {});
  }
});
