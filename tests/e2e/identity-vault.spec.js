// @ts-check
// Identity vault (Encryption.md §19.5): the cross-origin iframe that holds the
// passkey-derived KEK / X25519 key. App at http://dev.localhost:9001, vault at
// http://vault.dev.localhost:9001 (a subdomain of the RP ID host, which the
// browser requires for the ceremony to run inside the frame). Chromium only: it
// needs a CDP virtual authenticator, which is NOT a real authenticator.
//
// Needs the dev server up, with the /identity-vault route in IdentityServer.js
// loaded (a server restart after that edit). Without the restart run with
// VAULT_MOCK=1: the vault page request is answered by the test using the same
// HTML and headers the route sends (the scripts still load from the real server).
// Chromium resolves *.localhost itself; no hosts-file entry is needed.
const { test, expect } = require("@playwright/test");

const APP = "http://dev.localhost:9001";
const VAULT = "http://vault.dev.localhost:9001";
const MOCK = !!process.env.VAULT_MOCK;
const MOCK_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="vault-app-origins" content="' + APP + '">' +
  '<title>Lively Identity Vault</title></head><body><button id="unlock" type="button">Unlock with passkey</button>' +
  '<script src="/core/lib/libsodium/sodium.js"></script><script src="/core/lively/identity/IdentityVaultFrame.js"></script></body></html>';
const MOCK_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; frame-ancestors " + APP;

test.describe("identity vault", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "needs a CDP virtual authenticator");

  let n = 0;

  async function setup(page, context) {
    if (MOCK) {
      await context.route(VAULT + "/identity-vault", (r) =>
        r.fulfill({ status: 200, contentType: "text/html", headers: { "Content-Security-Policy": MOCK_CSP, "Cache-Control": "no-store" }, body: MOCK_HTML }));
    }
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    return { cdp, authenticatorId };
  }

  // Number of passkey assertions the authenticator has answered so far.
  async function signCount({ cdp, authenticatorId }) {
    const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    return credentials.reduce((sum, c) => sum + (c.signCount || 0), 0);
  }

  async function boot(page, opts) {
    opts = opts || {};
    await page.goto(APP + "/blank.html");
    await page.waitForFunction(() => window.$world && window.lively && lively.require, null, { timeout: 90000 });
    await page.evaluate(() => new Promise((r) =>
      lively.require("lively.identity.WebAuthn", "lively.identity.DID", "lively.identity.IdentityVaultBridge").toRun(r)));
    await page.waitForFunction(() => !lively.identity.webAuthn._vaultPending);
    await page.evaluate(([vault, gesture]) => {
      lively.Config.set("identityVaultOrigin", vault);
      lively.Config.set("identityVaultGesture", !!gesture);
      // promisified Crypto helpers for the tests
      window.__p = (obj, fn) => (...args) => new Promise((res, rej) => obj[fn](...args, (e, r) => (e ? rej(e) : res(r))));
    }, [VAULT, opts.gesture]);
  }

  const register = (page) => page.evaluate((h) => new Promise((res, rej) => lively.identity.webAuthn.register({
    handle: h, displayName: h, rpId: location.hostname, rpName: "Lively",
    challenge: crypto.getRandomValues(new Uint8Array(32)), requestPrf: true }, (e, r) => (e ? rej(e) : res(r.credentialId)))), "ivtest" + (++n) + Date.now());

  const derive = (page, cred) => page.evaluate((id) => new Promise((res) => {
    const wa = lively.identity.webAuthn, ch = crypto.getRandomValues(new Uint8Array(32));
    wa.deriveKek({ credentialId: id, challenge: ch, rpId: location.hostname }, (e1, kek) =>
      wa.deriveX25519KeyPair({ credentialId: id, challenge: ch, rpId: location.hostname }, (e2, pair) =>
        res({ err: (e1 && e1.message) || (e2 && e2.message) || null,
          kekIsHandle: !!(kek && kek.__identityVault), privIsHandle: !!(pair && pair.privateKey && pair.privateKey.__identityVault),
          kekBytes: kek instanceof Uint8Array, privBytes: !!(pair && pair.privateKey instanceof Uint8Array),
          pub: pair && Array.from(pair.publicKey) })));
  }), cred);

  // The OLD path, run in the page realm: the keys the vault must agree with.
  const reference = (page, cred) => page.evaluate(async (id) => {
    const c = lively.identity.crypto, enc = (s) => new TextEncoder().encode(s);
    const a = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: c.base64urlDecode(id) }], userVerification: "required",
      extensions: { prf: { eval: { first: enc("lively-kek-v1"), second: enc("lively-x25519:" + id) } } } } });
    const r = a.getClientExtensionResults().prf.results;
    const sodium = await new Promise((res) => c.withSodium((e, s) => res(s)));
    const priv = new Uint8Array(r.second); priv[0] &= 248; priv[31] &= 127; priv[31] |= 64;
    return { kek: Array.from(new Uint8Array(r.first)), priv: Array.from(priv), pub: Array.from(sodium.crypto_scalarmult_base(priv)) };
  }, cred);

  test("one ceremony in the frame fills both caches with handles, never bytes", async ({ page, context }) => {
    const auth = await setup(page, context);
    await boot(page);
    const cred = await register(page);
    const before = await signCount(auth);
    const r = await derive(page, cred);
    expect(r.err).toBeNull();
    expect(r.kekIsHandle).toBe(true);
    expect(r.privIsHandle).toBe(true);
    expect(r.kekBytes).toBe(false);
    expect(r.privBytes).toBe(false);
    expect(await signCount(auth)).toBe(before + 1);        // KEK and X25519 from ONE prompt
    // the handle carries no key material
    const keys = await page.evaluate((id) => Object.keys(lively.identity.webAuthn._kekCache[id]).sort(), cred);
    expect(keys).toEqual(["__identityVault", "credentialId", "kind", "toJSON"]);
    // and a second derive is served from the vault without a prompt
    await derive(page, cred);
    expect(await signCount(auth)).toBe(before + 1);
  });

  test("the vault is byte-compatible with the page-realm path (no migration needed)", async ({ page, context }) => {
    await setup(page, context);
    await boot(page);
    const cred = await register(page);
    const ref = await reference(page, cred);
    const d = await derive(page, cred);
    expect(d.pub).toEqual(ref.pub);                        // same X25519 public key

    const out = await page.evaluate(async ([id, ref]) => {
      const c = lively.identity.crypto, wa = lively.identity.webAuthn, P = window.__p;
      const kekH = wa._kekCache[id], pairH = wa._x25519Cache[id];
      const rawKek = new Uint8Array(ref.kek), rawPriv = new Uint8Array(ref.priv), rawPub = new Uint8Array(ref.pub);
      const res = {};
      // wrapDek via the vault -> unwrap with the raw KEK, and the reverse
      const w1 = await P(c, "wrapDek")(kekH);
      res.vaultWrapRawUnwrap = Array.from(await P(c, "unwrapDek")(w1.wrappedDek, rawKek)).join() === Array.from(w1.dek).join();
      const w2 = await P(c, "wrapDek")(rawKek);
      res.rawWrapVaultUnwrap = Array.from(await P(c, "unwrapDek")(w2.wrappedDek, kekH)).join() === Array.from(w2.dek).join();
      // payload encryption (the soft signing key uses this)
      const e1 = await P(c, "encryptPayload")({ a: 1, s: "x" }, kekH);
      res.payloadVaultToRaw = JSON.stringify(await P(c, "decryptPayload")(e1.ciphertext, e1.nonce, rawKek)) === '{"a":1,"s":"x"}';
      const e2 = await P(c, "encryptPayload")({ b: 2 }, rawKek);
      res.payloadRawToVault = JSON.stringify(await P(c, "decryptPayload")(e2.ciphertext, e2.nonce, kekH)) === '{"b":2}';
      // sealed boxes produced for the (unchanged) public key open through the handle
      const dek = crypto.getRandomValues(new Uint8Array(32));
      const sealed = await P(c, "sealForRecipient")(dek, pairH.publicKey);
      res.sealedOpenVault = Array.from(await P(c, "openSealedBox")(sealed, pairH.publicKey, pairH.privateKey)).join() === Array.from(dek).join();
      res.sealedOpenRaw = Array.from(await P(c, "openSealedBox")(sealed, rawPub, rawPriv)).join() === Array.from(dek).join();
      // a wrong KEK must fail
      try { await P(c, "unwrapDek")(w1.wrappedDek, crypto.getRandomValues(new Uint8Array(32))); res.wrongKekRejected = false; } catch (e) { res.wrongKekRejected = true; }
      return res;
    }, [cred, ref]);
    expect(out).toEqual({ vaultWrapRawUnwrap: true, rawWrapVaultUnwrap: true, payloadVaultToRaw: true, payloadRawToVault: true,
      sealedOpenVault: true, sealedOpenRaw: true, wrongKekRejected: true });
  });

  test("a real consumer works through the vault: EnvelopeSigning decrypts the soft key by handle and signs", async ({ page, context }) => {
    await setup(page, context);
    await boot(page);
    await page.evaluate(() => new Promise((r) => lively.require("lively.identity.EnvelopeSigning").toRun(r)));
    const cred = await register(page);
    await derive(page, cred);
    const out = await page.evaluate(async (id) => {
      const c = lively.identity.crypto, wa = lively.identity.webAuthn, did = lively.identity.did, P = window.__p;
      // what registration stores: the soft signing key's private JWK encrypted under the KEK
      const kp = await P(c, "generateSigningKeyPair")();
      const privJwk = await P(c, "exportPrivateKeyJwk")(kp.privateKey);
      const pubJwk = await P(c, "exportPublicKeyJwk")(kp.publicKey);
      const enc = await P(c, "encryptPayload")(privJwk, wa._kekCache[id]);          // KEK is a handle here
      const orig = did.findMethodByCredentialId;
      did.findMethodByCredentialId = () => ({ lively: { softSigningKeyWrapped: JSON.stringify(enc), delegationCert: {} } });
      try {
        const env = { objId: "abc", did: "did:jwk:x", record: { cid: "c", payload: "p" } };
        const signed = await new Promise((res, rej) => lively.identity.envelopeSigning.signEnvelopeIfPossible(
          env, { credentialId: id, rpId: location.hostname, document: {} }, c, (e, r) => (e ? rej(e) : res(r))));
        const valid = await P(c, "verifyJws")(signed.sig, pubJwk);
        // flip a character in the MIDDLE of the signature: the last base64url char of a 64-byte
        // signature carries padding bits, so changing it can leave the decoded bytes identical
        const parts = signed.sig.split("."), sg = parts[2], i = 40;
        parts[2] = sg.slice(0, i) + (sg[i] === "A" ? "B" : "A") + sg.slice(i + 1);
        const tampered = await P(c, "verifyJws")(parts.join("."), pubJwk).catch(() => false);
        return { signed: typeof signed.sig === "string", valid: valid, tamperedRejected: !tampered };
      } finally { did.findMethodByCredentialId = orig; }
    }, cred);
    expect(out).toEqual({ signed: true, valid: true, tamperedRejected: true });
  });

  test("Stay unlocked ON: keys survive a reload with zero ceremonies; OFF: they do not", async ({ page, context }) => {
    const auth = await setup(page, context);
    await boot(page);
    const cred = await register(page);
    await page.evaluate(() => lively.identity.keyVault.setEnabled(true));
    await derive(page, cred);
    const afterFirst = await signCount(auth);

    await page.reload();
    await boot(page);
    await page.evaluate(() => lively.identity.keyVault.isEnabled() && lively.identity.webAuthn.restoreCachesFromVault());
    await page.waitForFunction(() => !lively.identity.webAuthn._vaultPending);
    // the cache was refilled with handles before anyone asked
    expect(await page.evaluate((id) => !!(lively.identity.webAuthn._kekCache && lively.identity.webAuthn._kekCache[id] &&
      lively.identity.webAuthn._kekCache[id].__identityVault), cred)).toBe(true);
    const r = await derive(page, cred);
    expect(r.err).toBeNull();
    expect(r.kekIsHandle).toBe(true);
    expect(await signCount(auth)).toBe(afterFirst);          // no new prompt
    // and the restored handle really works
    const ok = await page.evaluate((id) => new Promise((res) => {
      const c = lively.identity.crypto, h = lively.identity.webAuthn._kekCache[id];
      c.wrapDek(h, (e, w) => c.unwrapDek(w.wrappedDek, h, (e2, dek) => res(!e && !e2 && dek.length === 32)));
    }), cred);
    expect(ok).toBe(true);

    // control: setting off wipes the vault's copy, so the next load prompts again
    await page.evaluate(() => lively.identity.keyVault.setEnabled(false));
    await page.reload();
    await boot(page);
    await page.evaluate(() => lively.identity.webAuthn.restoreCachesFromVault());
    const before = await signCount(auth);
    const r2 = await derive(page, cred);
    expect(r2.err).toBeNull();
    expect(await signCount(auth)).toBe(before + 1);
  });

  test("Stay unlocked OFF (default): a reload costs a ceremony again", async ({ page, context }) => {
    const auth = await setup(page, context);
    await boot(page);
    const cred = await register(page);
    await derive(page, cred);
    await page.reload();
    await boot(page);
    const before = await signCount(auth);
    await derive(page, cred);
    expect(await signCount(auth)).toBe(before + 1);
  });

  test("sign-out (keyVault.destroy) wipes the vault's persisted keys", async ({ page, context }) => {
    const auth = await setup(page, context);
    await boot(page);
    const cred = await register(page);
    await page.evaluate(() => lively.identity.keyVault.setEnabled(true));
    await derive(page, cred);
    await page.evaluate(() => lively.identity.keyVault.destroy());
    await page.waitForTimeout(500);
    expect(await page.evaluate((id) => !(lively.identity.webAuthn._kekCache && lively.identity.webAuthn._kekCache[id]), cred)).toBe(true);
    await page.evaluate(() => lively.identity.keyVault.setEnabled(true));
    await page.reload();
    await boot(page);
    await page.evaluate(() => lively.identity.webAuthn.restoreCachesFromVault());
    await page.waitForFunction(() => !lively.identity.webAuthn._vaultPending);
    const before = await signCount(auth);
    await derive(page, cred);
    expect(await signCount(auth)).toBe(before + 1);          // had to ask the passkey again
    await page.evaluate(() => lively.identity.keyVault.setEnabled(false));
  });

  test("a stale handle (vault wiped elsewhere) fails as Locked and is dropped from the cache", async ({ page, context }) => {
    await setup(page, context);
    await boot(page);
    const cred = await register(page);
    await derive(page, cred);
    await page.evaluate(() => new Promise((res) => lively.identity.identityVault.call("destroy", {}, () => res())));
    const out = await page.evaluate((id) => new Promise((res) => {
      const c = lively.identity.crypto, wa = lively.identity.webAuthn;
      c.wrapDek(wa._kekCache[id], (e) => res({ name: e && e.name, stillCached: !!wa._kekCache[id] }));
    }), cred);
    expect(out).toEqual({ name: "Locked", stillCached: false });
  });

  test("bytes from a page-realm ceremony (registration) are adopted: the cache keeps only a handle", async ({ page, context }) => {
    await setup(page, context);
    await boot(page);
    const cred = await register(page);
    const out = await page.evaluate(async (id) => {
      const c = lively.identity.crypto, wa = lively.identity.webAuthn, P = window.__p;
      const raw = crypto.getRandomValues(new Uint8Array(32));
      wa.cacheKek(id, raw);
      const h = wa._kekCache[id];
      const w = await P(c, "wrapDek")(h);                      // queued behind the import
      const dek = await P(c, "unwrapDek")(w.wrappedDek, raw);
      return { isHandle: !!h.__identityVault, roundTrip: Array.from(dek).join() === Array.from(w.dek).join() };
    }, cred);
    expect(out).toEqual({ isHandle: true, roundTrip: true });
  });

  test("a page on another origin that frames the vault gets no reply", async ({ page, context }) => {
    await setup(page, context);
    await boot(page);
    await context.route("http://127.0.0.1:9001/evil.html", (r) => r.fulfill({ status: 200, contentType: "text/html", body:
      '<!doctype html><body><script>window.got=[];addEventListener("message",e=>got.push([e.origin,e.data]));' +
      'const f=document.createElement("iframe");f.src="' + VAULT + '/identity-vault";document.body.appendChild(f);' +
      'f.onload=()=>f.contentWindow.postMessage({id:1,op:"hello",args:{}},"*");</script>' }));
    const evil = await context.newPage();
    await evil.goto("http://127.0.0.1:9001/evil.html");
    await evil.waitForTimeout(2500);
    expect(await evil.evaluate(() => window.got.length)).toBe(0);
  });

  test("gesture fallback: ceremony from a click inside the frame, then the frame hides again", async ({ page, context }) => {
    const auth = await setup(page, context);
    await boot(page, { gesture: true });
    const cred = await register(page);
    const before = await signCount(auth);
    const pending = page.evaluate((id) => new Promise((res) => {
      lively.identity.webAuthn.deriveKek({ credentialId: id, challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname },
        (e, kek) => res({ err: e && e.message, isHandle: !!(kek && kek.__identityVault) }));
    }), cred);
    const frame = page.frameLocator('iframe[title="Identity vault"]');
    await frame.locator("#unlock").click({ timeout: 15000 });
    const r = await pending;
    expect(r).toEqual({ err: null, isHandle: true });
    expect(await signCount(auth)).toBe(before + 1);
    const w = await page.evaluate(() => document.querySelector('iframe[title="Identity vault"]').style.width);
    expect(w).toBe("1px");
  });
});
