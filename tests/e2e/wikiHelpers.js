// @ts-check
// Shared setup for the wiki history specs: a browser context with a CDP virtual passkey, an account
// registered through the real RegisterDialog ceremony (a bare /register call gives no soft signing
// key, so every page save would 403), and a few page-side helpers installed as init scripts.
const { expect } = require("@playwright/test");

const initScript = () => {
  const w = /** @type {any} */ (window);
  w.__assert = async (credentialId) => {
    const ch = await (await fetch("/nodejs/IdentityServer/challenge", { credentials: "include" })).json();
    return new Promise((res, rej) => lively.identity.webAuthn.authenticate({ challenge: lively.identity.crypto.base64urlDecode(ch.challenge),
      rpId: location.hostname, credentialIds: [credentialId] }, (e, v) => (e ? rej(e) : res(v))));
  };
  w.__req = async (method, url, body) => { const r = await fetch(url, { method, credentials: "include", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  w.__login = async (handle, credentialId) => w.__req("POST", "/nodejs/IdentityServer/authenticate", Object.assign({ handle }, await w.__assert(credentialId)));
  // replaces the editor's whole document with plain paragraphs, then saves (resolves when the PUT is done)
  w.__setDocAndSave = (paras, ed) => new Promise((res, rej) => {
    ed = ed || w.__ed;
    const PM = ed._ProseMirror(), v = ed.editorView;
    const doc = PM.model.Node.fromJSON(v.state.schema, { type: "doc", content: paras.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })) });
    v.dispatch(v.state.tr.replaceWith(0, v.state.doc.content.size, doc.content));
    ed._saveNow((e) => (e ? rej(e) : res(true)));
  });
  // text of the latest stored version, one entry per paragraph
  w.__latestParas = async (handle, objId) => {
    const env = await (await fetch("/@" + handle + "/" + objId, { headers: { Accept: "application/json" }, credentials: "include" })).json();
    return (env.record.payload.snapshot.content || []).map((b) => (b.content || []).map((c) => c.text || "").join(""));
  };
  w.__latestEnvelope = async (handle, objId) => (await fetch("/@" + handle + "/" + objId, { headers: { Accept: "application/json" }, credentials: "include" })).json();
  w.__versions = async (handle, objId) => (await (await fetch("/@" + handle + "/" + objId + "/versions", { headers: { Accept: "application/json" }, credentials: "include" })).json()).versions;
  w.__findAll = (type) => { const out = []; $world.withAllSubmorphsDo((m) => { if (m.constructor.type === type) out.push(m); }); return out; };
};

/**
 * @param {import('@playwright/test').Browser} browser
 * @param {string} handle  should start with hometest_ (see account-lifecycle.spec.js on pruning)
 */
async function newAccount(browser, handle) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await page.addInitScript(initScript);
  await page.goto("/blank.html");
  await page.waitForFunction(() => window.$world && window.lively && lively.identity && lively.identity.did, null, { timeout: 90000 });

  // the dialog ends by navigating to the new account's home world
  const nav = page.waitForURL(/welcome=/, { timeout: 90000 });
  await page.evaluate(async (h) => {
    await new Promise((r) => lively.require("lively.identity.RegisterDialog").toRun(r));
    const dlg = lively.BuildSpec("lively.identity.RegisterDialog").createMorph();
    dlg.openInWorldCenter();
    dlg._startRegisterCeremony(h, h, "Test");
  }, handle);
  await nav;
  await page.goto("/blank.html");
  await page.waitForFunction(() => window.$world && lively.identity && lively.identity.did && lively.identity.did.currentUser(), null, { timeout: 90000 });
  const who = await page.evaluate(() => { const u = lively.identity.did.currentUser(); return { handle: u.handle, did: u.did, credentialId: u.credentialId }; });
  expect(who.handle).toBe(handle);

  await page.evaluate(() => new Promise((r) => lively.require("lively.identity.WikiEditor").toRun(() =>
    lively.require("lively.identity.WikiView").toRun(() => lively.require("lively.identity.PasskeyPrimingDialog").toRun(r)))));
  await page.evaluate(() => lively.LocalStorage.set(lively.identity.PasskeyPrimingDialog.SKIP_FLAG_KEY, true));
  return { context, page, cdp, authenticatorId, ...who };
}

// Removes the account through the deletion feature itself (fails quietly: best effort in a finally block).
async function deleteAccount(acct) {
  try {
    await acct.page.evaluate(([h, c]) => /** @type {any} */ (window).__login(h, c), [acct.handle, acct.credentialId]);
    await acct.page.evaluate(async ([h, c]) => {
      const w = /** @type {any} */ (window);
      return w.__req("POST", "/@" + h + "/account/delete", { confirmHandle: h, assertion: await w.__assert(c) });
    }, [acct.handle, acct.credentialId]);
  } catch (e) { /* best effort */ }
}

// Opens a new wiki page in the page's editor (window.__ed) and saves each entry of `versions` (an
// array of paragraph arrays) in turn. Returns the objId.
async function makePage(page, handle, wikiName, versions, extra) {
  await page.evaluate(([h, n, x]) => { const w = /** @type {any} */ (window); w.__ed = lively.identity.WikiEditor.newCard(h, Object.assign({ wikiName: n }, x || {})); }, [handle, wikiName, extra || null]);
  await page.waitForFunction(() => /** @type {any} */ (window).__ed && /** @type {any} */ (window).__ed.editorView, null, { timeout: 30000 });
  for (const paras of versions) await page.evaluate((p) => /** @type {any} */ (window).__setDocAndSave(p), paras);
  return page.evaluate(() => /** @type {any} */ (window).__ed._objId);
}

module.exports = { newAccount, deleteAccount, makePage };
