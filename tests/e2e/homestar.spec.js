// @ts-check
// The homestar shell against a LIVE server (see homestar.md): what a new account lands on, what
// /@handle serves to a browser vs. an API client, and that sign-in goes to the homestar.
//
// Registers one throwaway `hometest_*` account through the real RegisterDialog ceremony (see
// account-lifecycle.spec.js on pruning the reserved handles) and removes it through the deletion feature.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });

/** @type {any} */ let A = null;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(200 * 1000);
  A = await newAccount(browser, "hometest_hs" + Math.random().toString(36).slice(2, 6));
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (A) await A.context.close();
});

test("a new account's profile feeds the homestar: its home world is featured", async () => {
  const profile = await A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/profile", { credentials: "include" })).json()).record.payload, A.handle);
  const worlds = await A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/worlds", { credentials: "include" })).json()).worlds, A.handle);
  expect(worlds.length).toBe(1);
  expect(worlds[0].name).toBe("Workshop");
  expect(profile.homestar.featuredWorlds).toEqual([worlds[0].objId]);
});

test("/@handle serves the homestar to a browser and the manifest to an API client", async ({ request }) => {
  const html = await request.get("/@" + A.handle, { headers: { Accept: "text/html" } });
  expect(html.status()).toBe(200);
  const body = await html.text();
  expect(body).toContain("window.__homestarData=");
  expect(body).toContain("Homestar.open");

  const json = await request.get("/@" + A.handle, { headers: { Accept: "application/json" } });
  expect(json.status()).toBe(200);
  const manifest = await json.json();
  expect(manifest.registeredHandle).toBe(A.handle);
  expect(Array.isArray(manifest.objects)).toBe(true);
});

test("the owner's homestar shows the new-user empty state", async () => {
  await A.page.goto("/@" + A.handle);
  await A.page.waitForFunction(() => /** @type {any} */ (window).lively && lively.identity && lively.identity.Homestar, null, { timeout: 90000 });
  const text = () => A.page.evaluate(() => { const out = []; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
  // The panels load from separate fetches (worlds, orbit, postcards), so wait for each
  // string rather than reading them all once after the first has appeared.
  const expected = ["Write your first postcard", "Edit profile", "Workshop",
    "Your orbit is empty. Add the friends you are closest to."];
  await expect.poll(async () => { const t = await text(); return expected.filter((s) => !t.includes(s)); },
    { timeout: 30000 }).toEqual([]);
});

test("signed-in /welcome.html redirects to the homestar", async () => {
  const r = await A.context.request.get("/welcome.html", { maxRedirects: 0 });
  expect(r.status()).toBe(302);
  expect(r.headers()["location"]).toBe("/@" + A.handle);
});
