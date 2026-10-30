// @ts-check
// Homestar badges, server side, end to end against the real dev server (badges.md §8 phase 1):
// the settings PUT that stores state.badges and the viewer-aware GET /@:handle/badges.
//
// Registers three throwaway `hometest_*` accounts through a CDP virtual passkey
// (hasPrf): OWNER, FRIEND (becomes the owner's friend through the real friend-request
// routes) and STRANGER. It drives plain HTTP from a signed-in page and removes the
// accounts through the account-deletion route, even if a check fails. Needs the dev
// server running at baseURL (not started by Playwright) and restarted since
// Badges.js / the route were added.
//
// Each run leaves three RESERVED handles behind (a deleted handle stays reserved
// by design). Prune with: DELETE FROM reserved_handles WHERE handle LIKE 'hometest\_%';
const { test, expect } = require("@playwright/test");

test.setTimeout(180 * 1000);

test("badges: validation, per-badge visibility, legacy place", async ({ browser }) => {
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
      return { status: resp.status, did: derivedDid, credentialId: r.credentialId, document };
    };
    w.__assert = async (credentialId) => {
      const ch = await (await fetch("/nodejs/IdentityServer/challenge", { credentials: "include" })).json();
      return new Promise((res, rej) => lively.identity.webAuthn.authenticate({ challenge: lively.identity.crypto.base64urlDecode(ch.challenge),
        rpId: location.hostname, credentialIds: [credentialId] }, (e, v) => (e ? rej(e) : res(v))));
    };
    // `anon` sends no cookie; every read asks for JSON (a bare */* can be answered with HTML).
    w.__req = async (method, url, body, anon) => {
      const r = await fetch(url, { method, credentials: anon ? "omit" : "include", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})), text: "" };
    };
    w.__login = async (handle, credentialId) => w.__req("POST", "/nodejs/IdentityServer/authenticate", Object.assign({ handle }, await w.__assert(credentialId)));
  });

  await page.goto("/blank.html");
  await page.waitForFunction(() => window.$world && window.lively && lively.identity && lively.identity.did, null, { timeout: 90000 });
  await page.evaluate(() => new Promise((r) => lively.require("lively.identity.RegisterDialog").toRun(r)));

  const R = Math.random().toString(36).slice(2, 7);
  const O = { handle: "hometest_o" + R }, F = { handle: "hometest_f" + R }, S = { handle: "hometest_s" + R };
  /** @type {(method: string, url: string, body?: any, anon?: boolean) => Promise<{status: number, body: any}>} */
  const req = (method, url, body, anon) => page.evaluate(([m, u, b, a]) => /** @type {any} */ (window).__req(m, u, b, a), [method, url, body, anon]);
  const loginAs = async (a) => expect((await page.evaluate(([h, c]) => /** @type {any} */ (window).__login(h, c), [a.handle, a.credentialId])).status).toBe(200);

  const badgesOf = (anon) => req("GET", "/@" + O.handle + "/badges", undefined, anon);
  const ids = (r) => r.body.badges.map((b) => b.id);
  const settingsNow = async () => (await req("GET", "/@" + O.handle + "/settings")).body;
  const putState = async (patch) => {
    const cur = await settingsNow();
    return req("PUT", "/@" + O.handle + "/settings", Object.assign({}, cur, { state: Object.assign({}, cur.state, patch) }));
  };
  const place = (o) => Object.assign({ id: "plc001", kind: "place", visibility: "friends", label: "Oakland, CA" }, o);
  const transit = (o) => Object.assign({ id: "trn001", kind: "transit", visibility: "anyone", agency: "Metro", label: "Orange Line", color: "#a85200", textColor: "#ffffff" }, o);
  const team = (o) => Object.assign({ id: "tem001", kind: "team", visibility: "orbit", label: "Comets", abbr: "CM", color: "#1B2A4A", textColor: "#F4C542" }, o);
  const school = (o) => Object.assign({ id: "sch001", kind: "school", visibility: "private", label: "Hilltop College", color: "#1B2A4A", textColor: "#F4C542" }, o);
  const library = (o) => Object.assign({ id: "lib001", kind: "library", visibility: "friends", label: "Oakland Public Library", abbr: "OPL" }, o);

  try {
    for (const a of [O, F, S]) {
      Object.assign(a, await page.evaluate((h) => /** @type {any} */ (window).__reg(h), a.handle));
      expect(a.status).toBe(200);
    }

    // ── friendship: FRIEND asks, OWNER approves (STRANGER stays a stranger)
    await loginAs(F);
    expect((await req("POST", "/@" + O.handle + "/friend-requests")).status).toBe(200);
    await loginAs(O);
    expect((await req("PUT", "/@" + O.handle + "/friend-requests/" + encodeURIComponent(F.did), { action: "approve" })).body.status).toBe("accepted");

    // ── a fresh account has no badges, for everyone, and the unknown-handle case is a 404
    let r = await badgesOf(false);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ badges: [], isOwner: true });
    expect((await badgesOf(true)).body).toEqual({ badges: [], isOwner: false });
    expect((await req("GET", "/@nosuchhandle" + R + "/badges", undefined, true)).status).toBe(404);

    // ── invalid lists are refused with INVALID_BADGES and store nothing
    const many = Array.from({ length: 21 }, (_, i) => school({ id: "many" + String(100 + i) }));
    const refused = [
      ["21 badges", many],
      ["not an array", "x"],
      ["bad colour", [transit({ color: "orange" })]],
      ["failing contrast pair", [transit({ color: "#FF9933", textColor: "#FFFFFF" })]],
      ["duplicate id", [school(), school({ label: "Ridge College" })]],
      ["two places", [place(), place({ id: "plc002" })]],
      ["the synthetic legacy id", [place({ id: "_legacy" })]],
      ["unknown visibility", [place({ visibility: "everyone" })]],
      ["unknown kind", [place({ kind: "pet" })]],
      ["team without abbr", [team({ abbr: "" })]]
    ];
    for (const [what, list] of refused) {
      const res = await putState({ badges: list });
      expect(res.status, what).toBe(400);
      expect(res.body.code, what).toBe("INVALID_BADGES");
    }
    expect((await settingsNow()).state.badges).toBeUndefined();

    // ── a valid mix; the place arrives last but is stored first, colours are upper-cased
    expect((await putState({ badges: [transit(), team(), school(), library(), place()] })).status).toBe(200);
    const stored = (await settingsNow()).state.badges;
    expect(stored.map((b) => b.id)).toEqual(["plc001", "trn001", "tem001", "sch001", "lib001"]);
    expect(stored[1].color).toBe("#A85200");
    expect(stored[1].textColor).toBe("#FFFFFF");

    // ── owner: everything, with visibility
    r = await badgesOf(false);
    expect(r.body.isOwner).toBe(true);
    expect(ids(r)).toEqual(["plc001", "trn001", "tem001", "sch001", "lib001"]);
    expect(r.body.badges.map((b) => b.visibility)).toEqual(["friends", "anyone", "orbit", "private", "friends"]);

    // ── friend (not in the orbit): anyone + friends; no visibility field anywhere
    await loginAs(F);
    r = await badgesOf(false);
    expect(r.body.isOwner).toBe(false);
    expect(ids(r)).toEqual(["plc001", "trn001", "lib001"]);
    expect(JSON.stringify(r.body)).not.toContain("visibility");
    expect(Object.keys(r.body).sort()).toEqual(["badges", "isOwner"]);

    // ── stranger and signed out: only the anyone badge; nothing hints at the others
    await loginAs(S);
    for (const anon of [false, true]) {
      r = await badgesOf(anon);
      expect(ids(r)).toEqual(["trn001"]);
      const json = JSON.stringify(r.body);
      for (const secret of ["Oakland", "Comets", "Hilltop", "visibility", "private", "locked"]) expect(json, secret).not.toContain(secret);
      expect(Object.keys(r.body).sort()).toEqual(["badges", "isOwner"]);
    }

    // ── orbit: a friend in the orbit also sees the orbit badge
    await loginAs(O);
    expect((await putState({ orbit: { visibility: "friends", members: [F.did], pinned: [] } })).status).toBe(200);
    expect((await settingsNow()).state.badges.length).toBe(5);                    // the orbit save kept the badges
    await loginAs(F);
    expect(ids(await badgesOf(false))).toEqual(["plc001", "trn001", "tem001", "lib001"]);
    await loginAs(S);
    expect(ids(await badgesOf(false))).toEqual(["trn001"]);                        // a stranger is still a stranger

    // ── legacy place: the old public profile.location stands in only while there is no place badge
    await loginAs(O);
    await page.evaluate((a) => new Promise((res) => lively.identity.did.establishSession({ did: a.did, handle: a.handle, displayName: a.handle,
      credentialId: a.credentialId, rpId: location.hostname, document: a.document }, res)), O);
    const saved = await page.evaluate(() => new Promise((res) => lively.identity.userSpace.saveProfile({ location: "Old Town" }, (e) => res(e ? String(e) : "ok"))));
    expect(saved).toBe("ok");
    expect((await req("GET", "/@" + O.handle + "/profile", undefined, true)).body.record.payload.location).toBe("Old Town");
    // a real (Friends-only) place badge exists: the stranger must NOT get "Old Town" instead
    r = await badgesOf(true);
    expect(ids(r)).toEqual(["trn001"]);
    expect(JSON.stringify(r.body)).not.toContain("Old Town");
    // drop the real place: the fallback appears for everyone, public, with the synthetic id
    const without = (await settingsNow()).state.badges.filter((b) => b.kind !== "place");
    expect((await putState({ badges: without })).status).toBe(200);
    r = await badgesOf(true);
    expect(r.body.badges[0]).toEqual({ id: "_legacy", kind: "place", label: "Old Town" });
    expect(ids(r)).toEqual(["_legacy", "trn001"]);
    r = await badgesOf(false);                                                     // the owner sees it as an ordinary public place
    expect(r.body.badges[0]).toEqual({ id: "_legacy", kind: "place", visibility: "anyone", label: "Old Town" });
    // the synthetic badge cannot be saved back as it is
    expect((await putState({ badges: r.body.badges })).body.code).toBe("INVALID_BADGES");
    // saving it with a real id makes it a real badge, and the profile value is ignored from then on
    expect((await putState({ badges: [place({ id: "plc009", visibility: "private", label: "Old Town" }), ...without] })).status).toBe(200);
    expect(ids(await badgesOf(true))).toEqual(["trn001"]);
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
