// @ts-check
// Homestar server routes, end to end against the real dev server: the viewer-aware
// GET /@:handle/orbit, /worlds and /postcards, and the settings PUT that stores
// state.orbit.
//
// Registers three throwaway `hometest_*` accounts through a CDP virtual passkey
// (hasPrf): OWNER, FRIEND (becomes the owner's friend through the real
// friend-request routes) and STRANGER. It drives plain HTTP from a signed-in page
// and removes the accounts through the account-deletion route, even if a check
// fails. Needs the dev server running at baseURL (not started by Playwright).
//
// Each run leaves three RESERVED handles behind (a deleted handle stays reserved
// by design). Prune with: DELETE FROM reserved_handles WHERE handle LIKE 'hometest\_%';
//
// Not covered here: postcards visible only to a recipient. Creating a postcard
// needs a signed envelope, which needs a delegated device key that this
// registration does not set up; that behaviour is covered with seeded rows in
// tests/server/viewer-postcard-listing.test.js.
const { test, expect } = require("@playwright/test");

test.setTimeout(180 * 1000);

test("orbit, worlds and postcards routes by viewer", async ({ browser }) => {
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
      const r = await fetch(url, { method, credentials: anon ? "omit" : "include", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    w.__login = async (handle, credentialId) => w.__req("POST", "/nodejs/IdentityServer/authenticate", Object.assign({ handle }, await w.__assert(credentialId)));
  });

  await page.goto("/blank.html");
  await page.waitForFunction(() => window.$world && window.lively && lively.identity && lively.identity.did, null, { timeout: 90000 });
  await page.evaluate(() => new Promise((r) => lively.require("lively.identity.RegisterDialog").toRun(r)));

  const R = Math.random().toString(36).slice(2, 7);
  const accts = { owner: { handle: "hometest_o" + R }, friend: { handle: "hometest_f" + R }, stranger: { handle: "hometest_s" + R } };
  const O = accts.owner, F = accts.friend, S = accts.stranger;
  /** @type {(method: string, url: string, body?: any, anon?: boolean) => Promise<{status: number, body: any}>} */
  const req = (method, url, body, anon) => page.evaluate(([m, u, b, a]) => /** @type {any} */ (window).__req(m, u, b, a), [method, url, body, anon]);
  const loginAs = async (a) => expect((await page.evaluate(([h, c]) => /** @type {any} */ (window).__login(h, c), [a.handle, a.credentialId])).status).toBe(200);

  try {
    for (const a of [O, F, S]) {
      Object.assign(a, await page.evaluate((h) => /** @type {any} */ (window).__reg(h), a.handle));
      expect(a.status).toBe(200);
    }

    // ── friendship: FRIEND asks, OWNER approves
    await loginAs(F);
    expect((await req("POST", "/@" + O.handle + "/friend-requests")).status).toBe(200);
    await loginAs(O);
    expect((await req("PUT", "/@" + O.handle + "/friend-requests/" + encodeURIComponent(F.did), { action: "approve" })).body.status).toBe("accepted");

    // ── a fresh account's orbit is empty and Friends-only
    let o = await req("GET", "/@" + O.handle + "/orbit");
    expect(o.status).toBe(200);
    expect(o.body).toMatchObject({ visibility: "friends", locked: false, isOwner: true, members: [], pinned: [] });

    // ── store an orbit: a friend, a stranger (must be dropped), pins beyond the members
    const settings = (await req("GET", "/@" + O.handle + "/settings")).body;
    expect(settings.type).toBe("settings");
    const putOrbit = (orbit, env) => req("PUT", "/@" + O.handle + "/settings", Object.assign({}, env || settings, { state: Object.assign({}, (env || settings).state, { orbit }) }));
    expect((await putOrbit({ visibility: "friends", members: [F.did, S.did], pinned: [S.did, F.did] })).status).toBe(200);
    o = await req("GET", "/@" + O.handle + "/orbit");
    expect(o.body.members).toEqual([{ did: F.did, handle: F.handle }]);
    expect(o.body.pinned).toEqual([F.did]);
    // the stored copy is the cleaned one, not what the client sent
    const stored = (await req("GET", "/@" + O.handle + "/settings")).body;
    expect(stored.state.orbit).toEqual({ visibility: "friends", members: [F.did], pinned: [F.did] });
    expect(stored.state.blockedDids).toEqual([]);                                  // the rest of state survives

    // ── malformed orbits are refused and change nothing
    const bad = await putOrbit({ visibility: "everyone", members: [] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_ORBIT");
    expect((await putOrbit({ visibility: "friends", members: "x" })).status).toBe(400);
    expect((await req("GET", "/@" + O.handle + "/orbit")).body.members.length).toBe(1);

    // ── who sees a Friends-only orbit
    await loginAs(F);
    o = await req("GET", "/@" + O.handle + "/orbit");
    expect(o.body).toMatchObject({ locked: false, isOwner: false, visibility: "friends" });
    expect(o.body.members.map((m) => m.did)).toEqual([F.did]);
    await loginAs(S);
    o = await req("GET", "/@" + O.handle + "/orbit");
    expect(o.body).toEqual({ visibility: "friends", locked: true, isOwner: false, members: [], pinned: [] });
    o = await req("GET", "/@" + O.handle + "/orbit", undefined, true);               // signed out
    expect(o.body).toEqual({ visibility: "friends", locked: true, isOwner: false, members: [], pinned: [] });

    // ── Anyone / Only me
    await loginAs(O);
    expect((await putOrbit({ visibility: "anyone", members: [F.did], pinned: [] }, (await req("GET", "/@" + O.handle + "/settings")).body)).status).toBe(200);
    o = await req("GET", "/@" + O.handle + "/orbit", undefined, true);
    expect(o.body.locked).toBe(false);
    expect(o.body.members.map((m) => m.handle)).toEqual([F.handle]);
    expect((await putOrbit({ visibility: "private", members: [F.did], pinned: [] }, (await req("GET", "/@" + O.handle + "/settings")).body)).status).toBe(200);
    expect((await req("GET", "/@" + O.handle + "/orbit")).body.members.length).toBe(1);   // the owner still sees it
    await loginAs(F);
    expect((await req("GET", "/@" + O.handle + "/orbit")).body.locked).toBe(true);          // even a member does not

    // ── an ended friendship drops the member at once, without touching the stored orbit
    await loginAs(O);
    expect((await putOrbit({ visibility: "friends", members: [F.did], pinned: [F.did] }, (await req("GET", "/@" + O.handle + "/settings")).body)).status).toBe(200);
    expect((await req("DELETE", "/@" + O.handle + "/friends/" + encodeURIComponent(F.did))).status).toBe(200);
    o = await req("GET", "/@" + O.handle + "/orbit");
    expect(o.body.members).toEqual([]);
    expect(o.body.pinned).toEqual([]);

    // ── another account cannot overwrite the owner's settings by objId (same cid for everyone)
    const ownerSettings = (await req("GET", "/@" + O.handle + "/settings")).body;
    await loginAs(S);
    const mine = (await req("GET", "/@" + S.handle + "/settings")).body;
    const hijack = await req("PUT", "/@" + S.handle + "/settings", Object.assign({}, mine, { objId: ownerSettings.objId, state: Object.assign({}, mine.state, { blockedDids: ["did:evil"] }) }));
    expect(hijack.status).toBe(403);
    expect(hijack.body.code).toBe("NOT_OWNER");
    await loginAs(O);
    expect((await req("GET", "/@" + O.handle + "/settings")).body.state.blockedDids).toEqual([]);
    // ... and the caller's own settings still save
    await loginAs(S);
    expect((await req("PUT", "/@" + S.handle + "/settings", Object.assign({}, mine, { state: Object.assign({}, mine.state, { blockedDids: [] }) }))).status).toBe(200);

    // ── worlds: metadata only, filtered by who is asking
    const worlds = await req("GET", "/@" + O.handle + "/worlds", undefined, true);
    expect(worlds.status).toBe(200);
    const asOwner = (await (async () => { await loginAs(O); return req("GET", "/@" + O.handle + "/worlds"); })()).body.worlds;
    expect(asOwner.length).toBeGreaterThan(0);                                       // registration creates a home world
    for (const w of asOwner) expect(Object.keys(w).sort()).toEqual(["created", "name", "objId", "template", "visibility"]);
    const publicOnes = asOwner.filter((w) => w.visibility === "public").map((w) => w.objId);
    expect(worlds.body.worlds.map((w) => w.objId)).toEqual(publicOnes);              // signed out sees exactly the public ones
    expect((await req("GET", "/@nobody_" + R + "/worlds")).status).toBe(404);

    // ── postcards: the viewer path and the owner path both answer; unknown params are harmless
    for (const url of ["/postcards", "/postcards?sort=starred&limit=5", "/postcards?hasLocation=1", "/postcards?sort=bogus"]) {
      const r = await req("GET", "/@" + O.handle + url, undefined, true);
      expect(r.status, url).toBe(200);
      expect(Array.isArray(r.body.postcards), url).toBe(true);
    }
    expect((await req("GET", "/@" + O.handle + "/postcards")).status).toBe(200);     // owner's plain listing (mailbox path)
    // a real account with public cards, read signed out through the new path
    const real = await req("GET", "/@gameboy/postcards?limit=2", undefined, true);
    expect(real.status).toBe(200);
    if (real.body.cursor) {
      const next = await req("GET", "/@gameboy/postcards?limit=2&cursor=" + encodeURIComponent(real.body.cursor), undefined, true);
      const firstIds = real.body.postcards.map((c) => c.objId);
      expect(next.body.postcards.some((c) => firstIds.includes(c.objId))).toBe(false);
    }
  } finally {
    for (const a of [O, F, S]) {
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
