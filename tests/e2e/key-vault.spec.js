// @ts-check
// KeyVault: the opt-in "Stay unlocked" persistence of the passkey-derived keys
// across page loads (Encryption.md §19). Runs in Chromium, Firefox and WebKit
// (the playwright config scopes the last two to this file) so Safari-engine
// behaviour is covered. The one test that needs a CDP virtual authenticator
// (a real PRF ceremony) is Chromium-only.
//
// No server-side state is touched: nothing is registered and no account exists.
// Needs the dev server up at baseURL.
const { test, expect } = require("@playwright/test");

const KEK = Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 255);
const PUB = Array.from({ length: 32 }, (_, i) => (i * 3 + 7) & 255);
const PRIV = Array.from({ length: 32 }, (_, i) => (i * 11 + 2) & 255);

async function boot(page, query) {
  await page.goto("/blank.html" + (query || ""));
  await page.waitForFunction(() => window.$world && window.lively && lively.require, null, { timeout: 90000 });
  await page.evaluate(() => new Promise((r) => lively.require("lively.identity.WebAuthn", "lively.identity.DID").toRun(r)));
  // restoreCachesFromVault() ran at module load; wait for it to settle
  await page.waitForFunction(() => !lively.identity.webAuthn._vaultPending);
}

const state = (page, cred) => page.evaluate((c) => {
  const wa = lively.identity.webAuthn;
  const kek = wa._kekCache && wa._kekCache[c], x = wa._x25519Cache && wa._x25519Cache[c];
  return {
    kek: kek ? Array.from(kek) : null,
    pub: x ? Array.from(x.publicKey) : null,
    priv: x ? Array.from(x.privateKey) : null,
    blobs: Object.keys(sessionStorage).filter((k) => k.indexOf("lively.kv1:") === 0).length,
  };
}, cred);

// remember() is fire-and-forget, so wait for the blobs to actually land (a fixed
// sleep loses to a loaded machine). `expectBlobs` is 0 when the setting is off.
const fill = async (page, cred, expectBlobs = 2) => {
  await page.evaluate(([c, kek, pub, priv]) => {
    const wa = lively.identity.webAuthn;
    wa.cacheKek(c, new Uint8Array(kek));
    wa.cacheX25519(c, { publicKey: new Uint8Array(pub), privateKey: new Uint8Array(priv) });
  }, [cred, KEK, PUB, PRIV]);
  if (expectBlobs) {
    await page.waitForFunction((n) => Object.keys(sessionStorage).filter((k) => k.indexOf("lively.kv1:") === 0).length >= n, expectBlobs);
  } else {
    await page.waitForTimeout(500);
  }
};

// Count real WebAuthn ceremonies from here on (re-installed after every load).
const countCeremonies = (page) => page.evaluate(() => {
  const w = /** @type {any} */ (window);
  w.__gets = 0;
  if (!navigator.credentials) {   // e.g. Playwright's WebKit build: nothing to wrap, so count attempts
    Object.defineProperty(navigator, "credentials", { configurable: true, value: {
      get() { w.__gets++; return Promise.reject(new DOMException("no authenticator", "NotAllowedError")); } } });
    return;
  }
  const orig = navigator.credentials.get.bind(navigator.credentials);
  navigator.credentials.get = function (o) { w.__gets++; return orig(o); };
});
const gets = (page) => page.evaluate(() => /** @type {any} */ (window).__gets);

test.describe("KeyVault", () => {
  test.setTimeout(120 * 1000);

  test("off by default: nothing is stored and nothing survives a reload", async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(() => lively.identity.keyVault.isEnabled())).toBe(false);
    await fill(page, "credOff", 0);
    expect((await state(page, "credOff")).blobs).toBe(0);
    await page.reload();
    await boot(page);
    const s = await state(page, "credOff");
    expect(s.kek).toBeNull();
    expect(s.pub).toBeNull();
  });

  test("on: KEK and X25519 pair survive reload and location.href, with no ceremony", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => lively.identity.keyVault.setEnabled(true));
    await fill(page, "credOn");
    const before = await state(page, "credOn");
    expect(before.blobs).toBe(2);

    await page.reload();
    await boot(page);
    await countCeremonies(page);
    const afterReload = await state(page, "credOn");
    expect(afterReload.kek).toEqual(KEK);
    expect(afterReload.pub).toEqual(PUB);
    expect(afterReload.priv).toEqual(PRIV);

    // the public API returns the restored keys without starting a passkey prompt
    const viaApi = await page.evaluate(() => new Promise((res) => {
      const wa = lively.identity.webAuthn, ch = new Uint8Array(32);
      wa.deriveKek({ credentialId: "credOn", challenge: ch }, (e1, kek) =>
        wa.deriveX25519KeyPair({ credentialId: "credOn", challenge: ch }, (e2, pair) =>
          res({ e1: e1 && e1.message, e2: e2 && e2.message, kek: kek && Array.from(kek), priv: pair && Array.from(pair.privateKey) })));
    }));
    expect(viaApi).toEqual({ e1: null, e2: null, kek: KEK, priv: PRIV });
    expect(await gets(page)).toBe(0);

    // a real navigation, not just a reload
    await Promise.all([page.waitForNavigation(), page.evaluate(() => { location.href = "/blank.html?nav=1"; })]);
    await boot(page);
    expect((await state(page, "credOn")).kek).toEqual(KEK);
  });

  test("a new tab does not get the keys", async ({ page, context }) => {
    await boot(page);
    await page.evaluate(() => lively.identity.keyVault.setEnabled(true));
    await fill(page, "credTab");
    const tab2 = await context.newPage();
    await boot(tab2);
    const s = await state(tab2, "credTab");
    expect(s.kek).toBeNull();
    expect(s.blobs).toBe(0);
  });

  test("sign-out (clearSession) wipes the keys in every tab, not just the current one", async ({ page, context }) => {
    await boot(page);
    await page.evaluate(() => lively.identity.keyVault.setEnabled(true));
    await fill(page, "credOut");
    // copy this tab's blobs into a second tab of the same profile
    const blobs = await page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage)
      .filter((k) => k.indexOf("lively.kv1:") === 0).map((k) => [k, sessionStorage.getItem(k)])));
    const tab2 = await context.newPage();
    await tab2.goto("/blank.html?second=1");
    await tab2.evaluate((b) => { for (const k in b) sessionStorage.setItem(k, b[k]); }, blobs);
    await boot(tab2);
    expect((await state(tab2, "credOut")).kek).toEqual(KEK);   // control: it does decrypt there

    await page.evaluate(() => new Promise((r) => lively.identity.did.clearSession(r)));
    expect((await state(page, "credOut")).blobs).toBe(0);

    await tab2.evaluate((b) => { for (const k in b) sessionStorage.setItem(k, b[k]); }, blobs);
    await tab2.reload();
    await boot(tab2);
    expect((await state(tab2, "credOut")).kek).toBeNull();      // device key is gone
    // the preference itself is left alone: only the key material is wiped
    expect(await page.evaluate(() => lively.identity.keyVault.isEnabled())).toBe(true);
  });

  test("turning it off deletes stored copies", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => lively.identity.keyVault.setEnabled(true));
    await fill(page, "credDis");
    await page.evaluate(() => lively.identity.keyVault.setEnabled(false));
    expect((await state(page, "credDis")).blobs).toBe(0);
    await page.reload();
    await boot(page);
    expect((await state(page, "credDis")).kek).toBeNull();
  });

  test("an expired blob is dropped, not restored", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => lively.identity.keyVault.setEnabled(true));
    await fill(page, "credTtl");
    await page.evaluate(() => {
      for (const k of Object.keys(sessionStorage).filter((k) => k.indexOf("lively.kv1:") === 0)) {
        const b = JSON.parse(sessionStorage.getItem(k)); b.exp = Date.now() - 1000; sessionStorage.setItem(k, JSON.stringify(b));
      }
    });
    await page.reload();
    await boot(page);
    const s = await state(page, "credTtl");
    expect(s.kek).toBeNull();
    expect(s.blobs).toBe(0);
  });

  test("Settings > Security has a working Stay unlocked toggle", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => new Promise((r) => lively.require("lively.identity.SettingsDialog").toRun(r)));
    const labels = () => page.evaluate(() => {
      const win = $world.submorphs.find((m) => m.name === "SettingsDialog");
      const c = win.get("settingsContent");
      return c.submorphs.filter((m) => m.label && /^Turn (on|off)$/.test(m.getLabel && m.getLabel())).map((m) => m.getLabel());
    });
    await page.evaluate(() => {
      // a signed-in view without touching the server
      lively.identity.did._currentUser = { handle: "kvtest", did: "did:jwk:test", credentialId: "credUi" };
      lively.identity.SettingsDialog.open("security");
    });
    await expect.poll(labels).toEqual(["Turn on"]);
    await page.evaluate(() => {
      const c = $world.submorphs.find((m) => m.name === "SettingsDialog").get("settingsContent");
      c.submorphs.find((m) => m.getLabel && m.getLabel() === "Turn on").setValue(false); // a Button fires on release
    });
    await expect.poll(() => page.evaluate(() => lively.identity.keyVault.isEnabled())).toBe(true);
    await expect.poll(labels).toEqual(["Turn off"]);
    await page.evaluate(() => {
      const c = $world.submorphs.find((m) => m.name === "SettingsDialog").get("settingsContent");
      c.submorphs.find((m) => m.getLabel && m.getLabel() === "Turn off").setValue(false);
    });
    await expect.poll(() => page.evaluate(() => lively.identity.keyVault.isEnabled())).toBe(false);
    await page.evaluate(() => { lively.identity.did._currentUser = null; });
  });

  test("real PRF ceremony: one prompt, then none after a reload (Chromium virtual authenticator)", async ({ page, context, browserName }) => {
    test.skip(browserName !== "chromium", "needs a CDP virtual authenticator");
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await boot(page);
    await page.evaluate(() => lively.identity.keyVault.setEnabled(true));

    const credentialId = await page.evaluate(() => new Promise((res, rej) => lively.identity.webAuthn.register({
      handle: "kvtest", displayName: "kvtest", rpId: location.hostname, rpName: "Lively",
      challenge: crypto.getRandomValues(new Uint8Array(32)), requestPrf: true }, (e, r) => (e ? rej(e) : res(r.credentialId)))));

    const derive = (p) => p.evaluate((id) => new Promise((res) => {
      const wa = lively.identity.webAuthn, ch = crypto.getRandomValues(new Uint8Array(32));
      wa.deriveKek({ credentialId: id, challenge: ch, rpId: location.hostname }, (e1, kek) =>
        wa.deriveX25519KeyPair({ credentialId: id, challenge: ch, rpId: location.hostname }, (e2, pair) =>
          res({ err: (e1 && e1.message) || (e2 && e2.message) || null, kek: kek && Array.from(kek), priv: pair && Array.from(pair.privateKey) })));
    }), credentialId);

    await countCeremonies(page);
    const first = await derive(page);
    expect(first.err).toBeNull();
    expect(first.kek).toHaveLength(32);
    expect(await gets(page)).toBe(2);                 // KEK + X25519: one prompt each
    await page.waitForTimeout(300);

    await page.reload();
    await boot(page);
    await countCeremonies(page);
    const second = await derive(page);
    expect(second).toEqual(first);                    // same keys…
    expect(await gets(page)).toBe(0);                 // …and no prompt

    // control: with the setting off the same reload costs two prompts again
    await page.evaluate(() => lively.identity.keyVault.setEnabled(false));
    await page.reload();
    await boot(page);
    await countCeremonies(page);
    const third = await derive(page);
    expect(third.kek).toEqual(first.kek);             // PRF is deterministic
    expect(await gets(page)).toBe(2);
  });
});
