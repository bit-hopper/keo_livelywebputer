// @ts-check
// Host-based realms against a LIVE server (core/servers/support/content-realm-gate.js).
//
// The gate is off unless the server was started with LK_APP_HOSTS, so this spec skips itself unless the
// server answers as if it were on. To run it, start the server (from WSL, as usual) with:
//
//   LK_APP_HOSTS=localhost:9001 LK_WORLDS_ORIGIN=http://worlds.localhost:9001 npm start
//
// "localhost:9001" is then the app realm, "vault.localhost:9001" the vault realm, and every other Host
// (worlds.localhost:9001, evil.example.com, ...) the content realm. Chromium resolves *.localhost to
// loopback by itself; the raw HTTP checks below reach the same server by IP with an explicit Host header.
//
// Registers two throwaway `hometest_*` accounts (see account-lifecycle.spec.js on pruning the reserved
// handles) and removes them through the deletion feature.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

const IP = "http://127.0.0.1:9001";
const APP = "localhost:9001";
const WORLDS = "worlds.localhost:9001";
const WORLDS_ORIGIN = "http://" + WORLDS;

test.describe.configure({ mode: "serial" });

/** @type {any} */ let A = null;
/** @type {any} */ let B = null;
let enabled = false;
let homePath = ""; // /@handleA/<objId>

const get = (request, host, path, extra) => request.get(IP + path, Object.assign({ headers: { Host: host }, maxRedirects: 0 }, extra || {}));
const post = (request, host, path) => request.post(IP + path, { headers: { Host: host }, data: {}, maxRedirects: 0 });

test.beforeAll(async ({ browser, playwright }) => {
  test.setTimeout(300 * 1000);
  const probe = await playwright.request.newContext();
  const r = await probe.post(IP + "/nodejs/IdentityServer/authenticate", { headers: { Host: WORLDS }, data: {}, maxRedirects: 0 });
  enabled = r.status() === 405;
  await probe.dispose();
  if (!enabled) return;
  const R = Math.random().toString(36).slice(2, 6);
  A = await newAccount(browser, "hometest_ca" + R);
  B = await newAccount(browser, "hometest_cb" + R);
  homePath = new URL(A.homeUrl).pathname;
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (B) await deleteAccount(B);
  if (A) await A.context.close();
  if (B) await B.context.close();
});

test.beforeEach(() => { test.skip(!enabled, "server was not started with LK_APP_HOSTS (see the header of this file)"); });

test("the content realm is read-only, closed to the login surface and to the subservers", async ({ request }) => {
  expect((await post(request, WORLDS, "/nodejs/IdentityServer/authenticate")).status()).toBe(405);
  expect((await post(request, WORLDS, "/nodejs/IdentityServer/register")).status()).toBe(405);
  expect((await request.put(IP + "/welcome.html", { headers: { Host: WORLDS }, data: "x" })).status()).toBe(405);
  expect((await get(request, WORLDS, "/nodejs/CommandLineServer/")).status()).toBe(404);
  expect((await get(request, WORLDS, "/identity-vault")).status()).toBe(404);
  expect((await get(request, WORLDS, "/wallet-vault")).status()).toBe(404);
  // the anonymous session probe stays available and says nobody is signed in
  const s = await get(request, WORLDS, "/nodejs/IdentityServer/session");
  expect(s.status()).toBe(200);
  expect((await s.json()).identity).toBeNull();
  // and it still serves the app's static files, which a world needs to boot
  expect((await get(request, WORLDS, "/core/lively/bootstrap.js")).status()).toBe(200);
});

test("an unlisted host is treated as the content realm", async ({ request }) => {
  expect((await post(request, "evil.example.com", "/nodejs/IdentityServer/authenticate")).status()).toBe(405);
  expect((await get(request, "evil.example.com", "/nodejs/CommandLineServer/")).status()).toBe(404);
  expect((await post(request, "", "/nodejs/IdentityServer/authenticate")).status()).toBe(405); // no usable Host
});

test("the app realm and the vault realm are unchanged", async ({ request }) => {
  // the auth handler itself answers (400: no handle), not the gate
  expect((await post(request, APP, "/nodejs/IdentityServer/authenticate")).status()).toBe(400);
  expect((await get(request, APP, "/nodejs/IdentityServer/session")).status()).toBe(200);
  const v = await get(request, "vault." + APP, "/identity-vault");
  expect(v.status()).toBe(200);
  expect(v.headers()["content-security-policy"]).toContain("frame-ancestors http://" + APP);
});

test("a foreign public world is redirected to the content hostname, the owner's is not", async ({ request }) => {
  const html = { Accept: "text/html" };
  // anonymous visitor on the app realm
  const anon = await get(request, APP, homePath, { headers: Object.assign({ Host: APP }, html) });
  expect(anon.status()).toBe(302);
  expect(anon.headers()["location"]).toBe(WORLDS_ORIGIN + homePath);
  // a signed-in visitor (B) on the app realm
  const visitor = await B.context.request.get(IP.replace("127.0.0.1", "localhost") + homePath, { headers: html, maxRedirects: 0 });
  expect(visitor.status()).toBe(302);
  expect(visitor.headers()["location"]).toBe(WORLDS_ORIGIN + homePath);
  // the owner (A) keeps today's behaviour
  const owner = await A.context.request.get("http://localhost:9001" + homePath, { headers: html, maxRedirects: 0 });
  expect(owner.status()).toBe(200);
  expect(await owner.text()).toContain("text/x-lively-world");
  // JSON requests are not redirected (programmatic access)
  const json = await get(request, APP, homePath, { headers: { Host: APP, Accept: "application/json" } });
  expect(json.status()).toBe(200);
  // on the content realm itself there is no redirect, so no loop
  const onWorlds = await get(request, WORLDS, homePath, { headers: Object.assign({ Host: WORLDS }, html) });
  expect(onWorlds.status()).toBe(200);
});

test("a signed-in visitor lands on the content hostname anonymous, and the world still boots", async () => {
  const page = B.page;
  // B is signed in on the app host
  await page.goto("http://localhost:9001/blank.html");
  await page.waitForFunction(() => window.$world && lively.identity && lively.identity.did && lively.identity.did.currentUser(), null, { timeout: 90000 });
  const bOnApp = await page.evaluate(() => lively.identity.did.currentUser().handle);
  expect(bOnApp).toBe(B.handle);

  // B opens A's public world on the app host and is sent to the content host
  await page.goto("http://localhost:9001" + homePath);
  await page.waitForURL(new RegExp("^" + WORLDS_ORIGIN.replace(/[.]/g, "\\.") + "/"), { timeout: 60000 });
  await page.waitForFunction(() => window.$world && window.lively && lively.identity && lively.identity.did, null, { timeout: 90000 });

  const seen = await page.evaluate(async () => {
    const authenticate = await fetch("/nodejs/IdentityServer/authenticate", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const session = await (await fetch("/nodejs/IdentityServer/session", { credentials: "include" })).json();
    return { origin: location.origin, currentUser: lively.identity.did.currentUser(), cookie: document.cookie, authenticateStatus: authenticate.status, sessionIdentity: session.identity };
  });
  expect(seen.origin).toBe(WORLDS_ORIGIN);
  expect(seen.currentUser).toBeNull();      // signed in on the app host, anonymous here
  expect(seen.cookie).toBe("");
  expect(seen.sessionIdentity).toBeNull();
  expect(seen.authenticateStatus).toBe(405);

  // and the visitor's session is untouched back on the app host
  await page.goto("http://localhost:9001/blank.html");
  await page.waitForFunction(() => window.$world && lively.identity && lively.identity.did && lively.identity.did.currentUser(), null, { timeout: 90000 });
  expect(await page.evaluate(() => lively.identity.did.currentUser().handle)).toBe(B.handle);
});
