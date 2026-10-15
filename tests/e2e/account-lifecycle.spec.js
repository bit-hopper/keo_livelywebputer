// @ts-check
// Account export, verify and self-service deletion, end to end (settings.md §5, §5a, §8).
//
// Registers throwaway `hometest_*` accounts through a CDP virtual passkey
// (hasPrf), then drives the real HTTP routes and the real Settings dialog:
// real mouse clicks, a real browser download, the real file chooser. It
// removes what it creates THROUGH the deletion feature, even when a check
// fails. Needs the dev server running at baseURL (not started by Playwright).
//
// Each run leaves two RESERVED handles behind (hometest_a*/hometest_b*): a deleted
// handle stays reserved forever by design, so the test can't free them. Prune
// with: DELETE FROM reserved_handles WHERE handle LIKE 'hometest\_%';
//
// Not covered here, and why: a constellation creator being refused (409
// BLOCKED) needs a creationSig from a delegated device key that this test's
// registration doesn't set up; that path is covered, with seeded rows, in
// tests/server/account-lifecycle.test.js.
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

test.setTimeout(180 * 1000);

test("export, verify and delete an account", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keo-e2e-"));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

  // Installed as an init script so the helpers survive the page navigations (the
  // sign-out redirect, and the cleanup that runs after it).
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
      return { status: resp.status, body: await resp.json().catch(() => ({})), did: derivedDid, credentialId: r.credentialId, document };
    };
    // a fresh assertion over a fresh server challenge for `credentialId`
    w.__assert = async (credentialId) => {
      const ch = await (await fetch("/nodejs/IdentityServer/challenge", { credentials: "include" })).json();
      return new Promise((res, rej) => lively.identity.webAuthn.authenticate({ challenge: lively.identity.crypto.base64urlDecode(ch.challenge),
        rpId: location.hostname, credentialIds: [credentialId] }, (e, v) => (e ? rej(e) : res(v))));
    };
    w.__req = async (method, url, body) => { const r = await fetch(url, { method, credentials: "include", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    w.__login = async (handle, credentialId) => w.__req("POST", "/nodejs/IdentityServer/authenticate", Object.assign({ handle }, await w.__assert(credentialId)));
  });


  await page.goto("/blank.html");
  await page.waitForFunction(() => window.$world && window.lively && lively.identity && lively.identity.did, null, { timeout: 90000 });
  await page.evaluate(() => new Promise((r) => lively.require("lively.identity.RegisterDialog").toRun(r)));
  const R = Math.random().toString(36).slice(2, 7);
  const ha = "hometest_a" + R, hb = "hometest_b" + R;
  /** @type {any} */ let A = null, B = null;
  const post = (url, body) => page.evaluate(([u, b]) => /** @type {any} */ (window).__req("POST", u, b), [url, body]);
  const get = (url) => page.evaluate((u) => /** @type {any} */ (window).__req("GET", u), url);
  const assertFor = (cred) => page.evaluate((c) => /** @type {any} */ (window).__assert(c), cred);

  try {
    A = await page.evaluate((h) => /** @type {any} */ (window).__reg(h), ha);
    B = await page.evaluate((h) => /** @type {any} */ (window).__reg(h), hb);
    expect([A.status, B.status]).toEqual([200, 200]);
    const login = await page.evaluate(([h, c]) => /** @type {any} */ (window).__login(h, c), [ha, A.credentialId]);
    expect(login.status).toBe(200);
    // the dialog reads the signed-in account from the client state
    await page.evaluate(([a]) => new Promise((res) => lively.identity.did.establishSession({ did: a.did, handle: a.handle, displayName: a.handle,
      credentialId: a.credentialId, rpId: location.hostname, document: a.document }, res)), [{ ...A, handle: ha }]);
    await page.evaluate((h) => fetch("/@" + h + "/uploads/notes/hello.txt", { method: "PUT", credentials: "include", body: "hello keo" }), ha);

    // ── summary
    const sum = await get("/@" + ha + "/account/summary");
    expect(sum.status).toBe(200);
    expect(sum.body.handle).toBe(ha);
    expect(Array.isArray(sum.body.blockedBy)).toBe(true);
    expect((await get("/@" + hb + "/account/summary")).status).toBe(403);

    // ── nothing below may delete anything
    const del = (body) => post("/@" + ha + "/account/delete", body);
    expect((await del({ confirmHandle: ha })).body.code).toBe("ASSERTION_REQUIRED");
    expect((await del({ confirmHandle: "someoneelse", assertion: await assertFor(A.credentialId) })).body.code).toBe("CONFIRM_MISMATCH");
    expect((await del({ confirmHandle: ha, assertion: await assertFor(B.credentialId) })).status).toBe(401);       // another account's passkey
    const stale = await assertFor(A.credentialId);
    await page.evaluate(() => fetch("/nodejs/IdentityServer/challenge", { credentials: "include" }));              // newer challenge replaces it
    expect((await del({ confirmHandle: ha, assertion: stale })).status).toBe(401);
    const good = await assertFor(A.credentialId);
    expect((await del({ confirmHandle: ha, assertion: { ...good, signature: good.signature.slice(0, -4) + "AAAA" } })).status).toBe(401);
    expect((await del({ confirmHandle: ha, assertion: good })).status).toBe(401);                                  // the challenge was consumed
    expect((await post("/@" + hb + "/account/delete", { confirmHandle: hb, assertion: good })).status).toBe(403); // someone else's URL
    expect((await get("/@" + ha + "/account/summary")).status).toBe(200);                                          // still here, still signed in

    // ── export token: needs an assertion, works exactly once
    expect((await post("/@" + ha + "/account/export-token", {})).status).toBe(400);
    const tokenResp = await post("/@" + ha + "/account/export-token", { assertion: await assertFor(A.credentialId) });
    expect(tokenResp.status).toBe(200);
    const dl = await page.evaluate(async ([h, t]) => {
      const first = await fetch("/@" + h + "/account/export?token=" + encodeURIComponent(t), { credentials: "include" });
      const bytes = new Uint8Array(await first.arrayBuffer());
      const second = await fetch("/@" + h + "/account/export?token=" + encodeURIComponent(t), { credentials: "include" });
      let b64 = ""; for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
      return { status: first.status, type: first.headers.get("content-type"), disp: first.headers.get("content-disposition"), second: second.status, b64: btoa(b64) };
    }, [ha, tokenResp.body.token]);
    expect(dl.status).toBe(200);
    expect(dl.type).toBe("application/x-keo");
    expect(dl.disp).toContain("attachment");
    expect(dl.second).toBe(403);
    expect((await get("/@" + ha + "/account/export")).status).toBe(403);

    // ── browser-side verification: the genuine file passes, damaged ones don't
    await page.evaluate(() => new Promise((r) => lively.require("lively.identity.KeoReader").toRun(r)));
    const verify = (mutate) => page.evaluate(async ([b64, m]) => {
      let arr = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const KR = lively.identity.KeoReader;
      if (m === "flip") { const sc = await KR.scan(new Blob([arr])); const e = sc.entries.find((x) => x.path === "did-document.json"); arr[e.offset + 20] ^= 0xff; }
      if (m === "truncate") arr = arr.slice(0, arr.length - 2500);
      if (m === "garbage") arr = new Uint8Array(3000).fill(7);
      const r = await KR.verify(new Blob([arr]));
      return { ok: r.ok, problems: r.problems };
    }, [dl.b64, mutate]);
    expect((await verify(null)).ok).toBe(true);
    const flipped = await verify("flip");
    expect(flipped.ok).toBe(false);
    expect(flipped.problems.join(" ")).toMatch(/did-document\.json is corrupted/);
    expect((await verify("truncate")).ok).toBe(false);
    expect((await verify("garbage")).ok).toBe(false);

    // ── the real dialog, real clicks
    await page.evaluate(() => new Promise((r) => lively.require("lively.identity.SettingsDialog").toRun(r)));
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__dlg = lively.identity.SettingsDialog.open("delete");
      w.__morphs = () => w.__dlg.get("settingsContent").submorphs;
      w.__rect = (action) => { const b = w.__morphs().find((m) => m._action === action); if (!b) return null; const r = b.renderContext().shapeNode.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
      w.__texts = () => w.__morphs().map((m) => m.textString || (m.label && m.label.textString) || "").filter(Boolean);
    });
    // Move to the button, pause, then press, like a user (not verified to be required)
    const clickAction = async (action) => {
      const r = await page.evaluate((a) => /** @type {any} */ (window).__rect(a), action);
      if (!r) throw new Error("no button " + action);
      await page.mouse.move(r.x - 30, r.y - 5); await page.mouse.move(r.x, r.y, { steps: 4 });
      await page.waitForTimeout(150); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
    };
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__texts().some((t) => /permanently deletes @/.test(t))), { timeout: 20000 }).toBe(true);
    const review = await page.evaluate(() => /** @type {any} */ (window).__texts());
    expect(review.some((t) => /Wallet:/.test(t)) && review.some((t) => /Passkey:/.test(t)) && review.includes("Continue")).toBe(true);

    await clickAction("_deleteStep");                                   // review -> export step
    const download = page.waitForEvent("download", { timeout: 30000 });
    await clickAction("_downloadExport");                               // passkey prompt, token, browser download
    const dlFile = await download;
    expect(dlFile.suggestedFilename()).toBe(ha + "-" + new Date().toISOString().slice(0, 10) + ".keo");
    const keo = path.join(tmp, "export.keo");
    await dlFile.saveAs(keo);
    const listing = spawnSync("tar", ["-tf", "export.keo"], { cwd: tmp }).stdout.toString().split(/\r?\n/).filter(Boolean);
    expect(listing[0]).toBe("format.json");
    expect(listing[listing.length - 1]).toBe("manifest.json");

    const chooser = page.waitForEvent("filechooser");
    await clickAction("_pickAndVerify");
    await (await chooser).setFiles(keo);
    await page.waitForFunction(() => /** @type {any} */ (window).__dlg._verifyResult, null, { timeout: 30000 });
    expect(await page.evaluate(() => /** @type {any} */ (window).__dlg._verifyResult.ok)).toBe(true);

    // the account changed since that export, so the old file must be flagged
    await page.evaluate((h) => fetch("/@" + h + "/uploads/notes/second.txt", { method: "PUT", credentials: "include", body: "more" }), ha);
    const chooser2 = page.waitForEvent("filechooser");
    await clickAction("_pickAndVerify");
    await (await chooser2).setFiles(keo);
    await page.waitForFunction(() => { const d = /** @type {any} */ (window).__dlg; return d._verifyResult && !d._verifying && !d._verifyResult.ok; }, null, { timeout: 30000 });
    expect(await page.evaluate(() => /** @type {any} */ (window).__dlg._verifyResult.problems.join(" "))).toMatch(/Download a fresh copy/);

    const download2 = page.waitForEvent("download", { timeout: 30000 });
    await clickAction("_downloadExport");
    const keo2 = path.join(tmp, "export2.keo");
    await (await download2).saveAs(keo2);
    const chooser3 = page.waitForEvent("filechooser");
    await clickAction("_pickAndVerify");
    await (await chooser3).setFiles(keo2);
    await page.waitForFunction(() => { const d = /** @type {any} */ (window).__dlg; return d._verifyResult && !d._verifying && d._verifyResult.ok; }, null, { timeout: 30000 });

    await clickAction("_deleteStep");                                   // Continue -> confirm step
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__texts().includes("Delete forever"))).toBe(true);
    await page.evaluate(() => { /** @type {any} */ (window).__dlg.get("settingsContent").get("sdConfirmHandle").textString = "wrong_handle"; });
    await clickAction("_deleteNow");
    await page.waitForTimeout(800);
    expect((await get("/@" + ha + "/account/summary")).status).toBe(200);   // a wrong typed handle deletes nothing
    await page.evaluate((h) => { /** @type {any} */ (window).__dlg.get("settingsContent").get("sdConfirmHandle").textString = h; }, ha);
    const nav = page.waitForURL(/welcome\.html/, { timeout: 30000 });
    await clickAction("_deleteNow");
    await nav;                                                          // signed out and sent to the welcome page

    // ── afterwards: signed out, gone, and the handle can't be taken
    expect((await page.evaluate(() => fetch("/nodejs/IdentityServer/session", { credentials: "include" }).then((r) => r.json()))).identity).toBeFalsy();
    await page.goto("/blank.html");
    await page.waitForFunction(() => window.$world && lively.identity && lively.identity.did, null, { timeout: 90000 });
    await page.evaluate(() => new Promise((r) => lively.require("lively.identity.RegisterDialog").toRun(r)));
    const again = await page.evaluate(async (h) => {
      const crypto = lively.identity.crypto, did = lively.identity.did, webAuthn = lively.identity.webAuthn;
      const ch = await (await fetch("/nodejs/IdentityServer/challenge", { credentials: "include" })).json();
      const r = await new Promise((res, rej) => webAuthn.register({ handle: h, displayName: h, rpId: location.hostname, rpName: "Lively",
        challenge: crypto.base64urlDecode(ch.challenge), requestPrf: true }, (e, v) => (e ? rej(e) : res(v))));
      const derivedDid = did.didFromJwk(r.publicKeyJwk);
      const resp = await fetch("/nodejs/IdentityServer/register", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: h, did: derivedDid, credentialId: r.credentialId, attestationObject: r.attestationObject, clientDataJSON: r.clientDataJSON,
          publicKeyJwk: r.publicKeyJwk, credentialPublicKeyBytes: r.credentialPublicKeyBytes, didDocument: did.buildDocument({ did: derivedDid, publicKeyJwk: r.publicKeyJwk, credentialId: r.credentialId, deviceLabel: "x", handle: h }) }) });
      return resp.status;
    }, ha);
    expect(again).toBe(409);                                            // a deleted handle stays reserved
    A = null;
  } finally {
    // remove whatever is left through the feature itself
    for (const [h, acct] of [[ha, A], [hb, B]]) {
      if (!acct) continue;
      try {
        await page.evaluate(([handle, cred]) => /** @type {any} */ (window).__login(handle, cred), [h, acct.credentialId]);
        await page.evaluate(async ([handle, cred]) => {
          const w = /** @type {any} */ (window);
          return w.__req("POST", "/@" + handle + "/account/delete", { confirmHandle: handle, assertion: await w.__assert(cred) });
        }, [h, acct.credentialId]);
      } catch (e) { /* best effort */ }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    await context.close();
  }
});
