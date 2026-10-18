// @ts-check
// The guestbook's server rules, end to end against the real dev server (which must have been restarted
// after the comments routes changed): comments on a profile object accept only a signed-in author, are
// kept to 500 characters, refuse an author the owner has blocked or who has blocked the owner (a block
// works both ways), and can be removed by their author or by the profile's owner, nobody else.
//
// Registers three throwaway `hometest_*` accounts through a CDP virtual passkey: OWNER, SIGNER (an
// ordinary visitor, who later blocks the owner) and BLOCKED (blocked by the owner). (A fourth
// registration in one virtual authenticator fails.) It drives plain
// HTTP from a signed-in page and removes the accounts afterwards, even if a check fails. The UI side is
// in homestar-guestbook.spec.js.
//
// Each run leaves three RESERVED handles behind (a deleted handle stays reserved by design). Prune with:
// DELETE FROM reserved_handles WHERE handle LIKE 'hometest\_%';
const { test, expect } = require("@playwright/test");

test.setTimeout(240 * 1000);

test("who may sign a guestbook and who may remove an entry", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    w.__reg = async (handle) => {
      const crypto = lively.identity.crypto, did = lively.identity.did, webAuthn = lively.identity.webAuthn;
      const ch = await (await fetch("/nodejs/IdentityServer/challenge", { credentials: "include" })).json();
      const r = await new Promise((res, rej) => webAuthn.register({ handle, displayName: handle, rpId: location.hostname, rpName: "Lively",
        challenge: crypto.base64urlDecode(ch.challenge), requestPrf: true }, (e, v) => (e ? rej(e) : res(v))));
      const derivedDid = did.didFromJwk(r.publicKeyJwk);
      const document = did.buildDocument({ did: derivedDid, publicKeyJwk: r.publicKeyJwk, credentialId: r.credentialId, deviceLabel: "Test", handle });
      const resp = await fetch("/nodejs/IdentityServer/register", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, did: derivedDid, credentialId: r.credentialId, attestationObject: r.attestationObject, clientDataJSON: r.clientDataJSON,
          publicKeyJwk: r.publicKeyJwk, credentialPublicKeyBytes: r.credentialPublicKeyBytes, didDocument: document }) });
      return { status: resp.status, did: derivedDid, credentialId: r.credentialId };
    };
    w.__assert = async (credentialId) => {
      const ch = await (await fetch("/nodejs/IdentityServer/challenge", { credentials: "include" })).json();
      return new Promise((res, rej) => lively.identity.webAuthn.authenticate({ challenge: lively.identity.crypto.base64urlDecode(ch.challenge),
        rpId: location.hostname, credentialIds: [credentialId] }, (e, v) => (e ? rej(e) : res(v))));
    };
    w.__req = async (method, url, body, anon) => {
      const r = await fetch(url, { method, credentials: anon ? "omit" : "include", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    w.__login = async (handle, credentialId) => w.__req("POST", "/nodejs/IdentityServer/authenticate", Object.assign({ handle }, await w.__assert(credentialId)));
  });

  await page.goto("/blank.html");
  await page.waitForFunction(() => window.$world && window.lively && lively.identity && lively.identity.did, null, { timeout: 90000 });
  await page.evaluate(() => new Promise((r) => lively.require("lively.identity.RegisterDialog").toRun(r)));

  const R = Math.random().toString(36).slice(2, 7);
  /** @type {any} */ const O = { handle: "hometest_o" + R }, S = { handle: "hometest_s" + R }, K = { handle: "hometest_k" + R };
  /** @type {(method: string, url: string, body?: any, anon?: boolean) => Promise<{status: number, body: any}>} */
  const req = (method, url, body, anon) => page.evaluate(([m, u, b, a]) => /** @type {any} */ (window).__req(m, u, b, a), [method, url, body, anon]);
  const loginAs = async (a) => expect((await page.evaluate(([h, c]) => /** @type {any} */ (window).__login(h, c), [a.handle, a.credentialId])).status).toBe(200);

  try {
    for (const a of [O, S, K]) {
      Object.assign(a, await page.evaluate((h) => /** @type {any} */ (window).__reg(h), a.handle));
      expect(a.status).toBe(200);
    }
    const profileOf = async (a) => (await req("GET", "/@" + a.handle + "/profile")).body;
    const gb = (await profileOf(O)).objId;
    const base = "/@" + O.handle + "/" + gb + "/comments";
    const post = (text) => req("POST", base, { body: text });
    const list = async (anon) => (await req("GET", base, undefined, anon)).body.comments || [];
    const putBlocked = async (a, dids) => {
      await loginAs(a);
      const cur = (await req("GET", "/@" + a.handle + "/settings")).body;
      return req("PUT", "/@" + a.handle + "/settings", Object.assign({}, cur, { state: Object.assign({}, cur.state, { blockedDids: dids }) }));
    };

    // ── signed out: anyone may read, nobody may sign
    expect((await req("POST", base, { body: "anonymous" }, true)).status).toBe(401);
    let r = await req("GET", base, undefined, true);
    expect(r.status).toBe(200);
    expect(r.body.comments).toEqual([]);

    // ── signed in: an entry is stored, with the author's handle, and anyone can read it
    await loginAs(S);
    r = await post("Hello from SIGNER");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ did: S.did, handle: S.handle, body: "Hello from SIGNER" });
    const signerEntry = r.body.id;
    expect((await list(true)).map((c) => [c.handle, c.body])).toEqual([[S.handle, "Hello from SIGNER"]]);

    // ── limits: empty and over 500 characters are refused, 500 is fine
    expect((await post("   ")).status).toBe(400);
    expect((await post("x".repeat(501))).status).toBe(400);
    const longEntry = await post("y".repeat(500));
    expect(longEntry.status).toBe(200);

    // ── a block works both ways: the owner blocks K, and S blocks the owner
    await loginAs(K);
    expect((await post("BLOCKED signs before being blocked")).status).toBe(200);
    const blockedEntry = (await list(true)).find((c) => c.did === K.did).id;
    expect((await putBlocked(O, [K.did])).status).toBe(200);
    await loginAs(K);
    expect((await post("again")).status).toBe(403);
    await loginAs(S);
    expect((await post("still fine")).status).toBe(200);                // others are unaffected
    expect((await putBlocked(S, [O.did])).status).toBe(200);
    await loginAs(S);
    expect((await post("again")).status).toBe(403);
    await loginAs(O);
    expect((await post("A note from the owner")).status).toBe(200);     // the owner signing their own is not a block case

    // ── removing: the author, or the profile's owner, nobody else
    expect((await req("DELETE", base + "/" + signerEntry, undefined, true)).status).toBe(401);
    await loginAs(K);
    expect((await req("DELETE", base + "/" + signerEntry)).status).toBe(403);       // not theirs, not their profile
    expect((await req("DELETE", base + "/" + blockedEntry)).status).toBe(200);      // a blocked author can still take their own back
    await loginAs(S);
    expect((await req("DELETE", base + "/" + signerEntry)).status).toBe(200);       // their own, blocker or not
    await loginAs(O);
    expect((await req("DELETE", base + "/" + longEntry.body.id)).status).toBe(200); // the owner removes anyone's, a blocker's included
    expect((await req("DELETE", base + "/999999999")).status).toBe(404);
    const left = (await list(true)).map((c) => c.body);
    expect(left).not.toContain("Hello from SIGNER");
    expect(left).not.toContain("BLOCKED signs before being blocked");
    expect(left).not.toContain("y".repeat(500));
    expect(left).toContain("still fine");
    expect(left).toContain("A note from the owner");

    // ── owning one profile gives no say over another's guestbook
    await loginAs(K);
    const kBook = "/@" + K.handle + "/" + (await profileOf(K)).objId + "/comments";
    await loginAs(S);
    const onK = await req("POST", kBook, { body: "S on K's book" });
    expect(onK.status).toBe(200);
    await loginAs(O);
    expect((await req("DELETE", kBook + "/" + onK.body.id)).status).toBe(403);
    await loginAs(K);
    expect((await req("DELETE", kBook + "/" + onK.body.id)).status).toBe(200);       // K owns that profile
  } finally {
    for (const a of [O, S, K]) {
      if (!a.credentialId) continue;
      try {
        await page.evaluate(([handle, cred]) => /** @type {any} */ (window).__login(handle, cred), [a.handle, a.credentialId]);
        await page.evaluate(async ([handle, cred]) => {
          const w = /** @type {any} */ (window);
          return w.__req("POST", "/@" + handle + "/account/delete", { confirmHandle: handle, assertion: await w.__assert(cred) });
        }, [a.handle, a.credentialId]);
      } catch (e) { /* best effort */ }
    }
    await context.close();
  }
});
