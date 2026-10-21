// @ts-check
// Linking a game-store account, as far as it can be driven without a real store account:
// the game-search proxy against the real service, the Settings > Connected tab as a
// signed-in user, what the start route redirects to, that a forged or foreign callback
// is turned away, and that a returning ?link_error= opens the tab with the outcome.
//
// The sign-in round trips themselves (each store's own sign-in and consent pages)
// need a real account and are checked by hand.
//
// Registers a throwaway hometest_* account through a CDP virtual passkey and removes it
// afterwards (see account-lifecycle.spec.js for the reserved-handle note). Needs the dev
// server restarted since GameLinkServer.js was added.
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { newAccount, deleteAccount } = require("./wikiHelpers.js");

test.setTimeout(180 * 1000);

// every Text/Button string currently visible inside the Settings window
const settingsTexts = (page) => page.evaluate(() => {
  const out = [];
  $world.withAllSubmorphsDo((m) => {
    if (m.name !== "settingsContent") return;
    m.withAllSubmorphsDo((s) => { if (s.textString) out.push(String(s.textString)); if (s.getLabel && s.label) out.push(String(s.getLabel())); });
  });
  return out;
});

const openSettings = (page, tab, notice) => page.evaluate(async ([t, n]) => {
  await new Promise((r) => lively.require("lively.identity.SettingsDialog").toRun(r));
  window.__settings = lively.identity.SettingsDialog.open(t, n || null);
}, [tab, notice || null]);

test("game search answers from the real service", async ({ browser }) => {
  const handle = "hometest_gs" + Math.random().toString(36).slice(2, 8);
  const acct = await newAccount(browser, handle);
  try {
    const r = await acct.page.evaluate(async () => {
      const status = await (await fetch("/nodejs/GameDbProxyServer/status", { credentials: "include" })).json();
      const res = await fetch("/nodejs/GameDbProxyServer/search?q=hades", { credentials: "include" });
      return { status, code: res.status, body: await res.json().catch(() => null) };
    });
    console.log("[game search] status:", JSON.stringify(r.status), "http", r.code, "first:", JSON.stringify(r.body && r.body.games && r.body.games[0]), "count:", r.body && r.body.games && r.body.games.length, "error:", r.body && r.body.error);
    test.skip(!r.status.configured, "no game-database credentials on this server");
    expect(r.code).toBe(200);
    expect(r.body.games.length).toBeGreaterThan(0);
    const g = r.body.games[0];
    expect(typeof g.igdb_id).toBe("number");
    expect(typeof g.title).toBe("string");
    const pop = await acct.page.evaluate(async () => (await (await fetch("/nodejs/GameDbProxyServer/popular", { credentials: "include" })).json()));
    console.log("[game search] popular count:", pop.games && pop.games.length, "error:", pop.error, "first:", JSON.stringify(pop.games && pop.games[0]));
  } finally { await deleteAccount(acct); await acct.context.close(); }
});

test("Settings > Connected: the cards, the start redirect, forged callbacks, and the return notice", async ({ browser }) => {
  const handle = "hometest_cn" + Math.random().toString(36).slice(2, 8);
  const acct = await newAccount(browser, handle);
  try {
    const page = acct.page;
    const shots = path.join(__dirname, "..", "..", "test-results");
    fs.mkdirSync(shots, { recursive: true });

    // ── the tab renders both stores from the server's status
    await openSettings(page, "connected");
    await expect.poll(async () => (await settingsTexts(page)).some((t) => /Connect Steam/.test(t)), { timeout: 15000 }).toBe(true);
    const texts = (await settingsTexts(page)).join("\n");
    expect(texts).toMatch(/Steam/);
    expect(texts).toMatch(/itch\.io/);
    expect(texts).toMatch(/Not affiliated with or endorsed by Valve or Steam/);
    expect(texts).toMatch(/Xbox/);
    expect(texts).toMatch(/PlayStation/);
    console.log("[connected tab]\n" + texts);
    const tabs = await page.evaluate(() => { const out = []; $world.withAllSubmorphsDo((m) => { if (m.name === "settingsContent") m.submorphs.forEach((s) => { if (s._targetTab) out.push([s._targetTab, Math.round(s.getPosition().x), Math.round(s.getExtent().x)]); }); }); return out; });
    console.log("[tabs]", JSON.stringify(tabs));
    expect(tabs.map((t) => t[0])).toEqual(["account", "privacy", "feeds", "security", "connected", "delete"]);
    await page.screenshot({ path: path.join(shots, "connected-tab.png") });

    // ── a real click on Connect asks first, and stays on the page when there is no go-ahead
    const rect = await page.evaluate(() => { let r = null; $world.withAllSubmorphsDo((m) => { if (m._arg === "steam" && m._action === "_connect") { const b = m.renderContext().shapeNode.getBoundingClientRect(); r = { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } }); return r; });
    expect(rect).not.toBeNull();
    await page.mouse.click(rect.x, rect.y);
    await expect.poll(() => page.evaluate(() => { let found = false; $world.withAllSubmorphsDo((m) => { if (m.textString && /Connecting leaves this page/.test(m.textString)) found = true; }); return found; }), { timeout: 10000 }).toBe(true);
    expect(new URL(page.url()).pathname).toBe("/blank.html");
    await page.screenshot({ path: path.join(shots, "connected-confirm.png") });

    // ── start: redirects to the provider with our callback and nothing in the URL we would regret
    const ctxReq = acct.context.request;
    const start = await ctxReq.get("/nodejs/GameLinkServer/start/steam?return=/blank.html", { maxRedirects: 0 });
    expect(start.status()).toBe(302);
    const loc = new URL(start.headers()["location"]);
    expect(loc.origin + loc.pathname).toBe("https://steamcommunity.com/openid/login");
    const returnTo = new URL(loc.searchParams.get("openid.return_to"));
    expect(returnTo.pathname).toBe("/nodejs/GameLinkServer/callback/steam");
    expect(returnTo.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    console.log("[start] return_to:", returnTo.href);

    // ── callbacks that do not belong to this session are refused and store nothing
    const bad = async (url) => (await ctxReq.get(url, { maxRedirects: 0 })).headers()["location"];
    expect(await bad("/nodejs/GameLinkServer/callback/steam?state=" + "x".repeat(43))).toBe("/blank.html?link_error=state_invalid");
    expect(await bad("/nodejs/GameLinkServer/callback/steam")).toBe("/blank.html?link_error=state_invalid");
    // a real state from the start above, but a bogus assertion: rejected by the local checks
    const forged = await bad(returnTo.pathname + returnTo.search + "&openid.mode=id_res&openid.claimed_id=https://steamcommunity.com/openid/id/76561198000000001");
    expect(forged).toBe("/blank.html?link_error=assertion_rejected");
    // and that state is now burned
    expect(await bad(returnTo.pathname + returnTo.search)).toBe("/blank.html?link_error=state_invalid");
    // a hostile return target is replaced
    const hostile = await ctxReq.get("/nodejs/GameLinkServer/start/steam?return=https://evil.example/x", { maxRedirects: 0 });
    const hl = new URL(hostile.headers()["location"]);
    expect(new URL(hl.searchParams.get("openid.return_to")).origin).toBe(new URL(page.url()).origin);

    // nothing was linked
    const status = await page.evaluate(async () => (await fetch("/nodejs/GameLinkServer/status", { credentials: "include" })).json());
    expect(status.accounts).toEqual([]);
    console.log("[providers]", JSON.stringify(status.providers));

    // ── returning from a failed attempt opens Settings on that tab with the outcome
    await page.goto("/blank.html?link_error=cancelled");
    await page.waitForFunction(() => window.$world && lively.identity && lively.identity.did && lively.identity.did.currentUser(), null, { timeout: 90000 });
    await expect.poll(async () => (await settingsTexts(page)).some((t) => /The connection was cancelled/.test(t)), { timeout: 30000 }).toBe(true);
    expect(page.url()).not.toMatch(/link_error/);
    await page.screenshot({ path: path.join(shots, "connected-return.png") });

    // ── disconnecting something that is not linked is a clean no-op, and cross-site callers are refused
    const del = await page.evaluate(async () => { const r = await fetch("/nodejs/GameLinkServer/steam", { method: "DELETE", credentials: "include" }); return { code: r.status, body: await r.json() }; });
    expect(del.code).toBe(200);
    expect(del.body.wasLinked).toBe(false);
    const cross = await ctxReq.delete("/nodejs/GameLinkServer/steam", { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(cross.status()).toBe(403);
  } finally { await deleteAccount(acct); await acct.context.close(); }
});
