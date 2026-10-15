// @ts-check
// Wiki version history panel (WikiHistory.js), end to end: three saved versions made through the
// real editor, then the panel driven with real mouse clicks -- grouping, per-version word diff,
// compare-with-current, page view, Restore (which goes through the editor and saves a NEW version
// on top of the chain) and Back.
//
// Registers one throwaway `hometest_*` account through a CDP virtual passkey and removes it through
// the account-deletion feature, even when a check fails (see account-lifecycle.spec.js, which this
// borrows its helpers from). A run leaves one RESERVED handle behind: prune with
//   DELETE FROM reserved_handles WHERE handle LIKE 'hometest\_%';
// Needs the dev server running at baseURL (not started by Playwright).
//
// Not covered: attribution to a second author (needs a second account in a constellation), and the
// grouping split on a >30 minute gap or an author change -- both are in WikiHistory._group and would
// need seeded versions with other timestamps.
const { test, expect } = require("@playwright/test");

test.setTimeout(180 * 1000);

test("history panel: groups, diffs, compare, restore, back", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    w.__assert = async (credentialId) => {
      const ch = await (await fetch("/nodejs/IdentityServer/challenge", { credentials: "include" })).json();
      return new Promise((res, rej) => lively.identity.webAuthn.authenticate({ challenge: lively.identity.crypto.base64urlDecode(ch.challenge),
        rpId: location.hostname, credentialIds: [credentialId] }, (e, v) => (e ? rej(e) : res(v))));
    };
    w.__req = async (method, url, body) => { const r = await fetch(url, { method, credentials: "include", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    w.__login = async (handle, credentialId) => w.__req("POST", "/nodejs/IdentityServer/authenticate", Object.assign({ handle }, await w.__assert(credentialId)));

    // replaces the editor's whole document with plain paragraphs, then saves (resolves when the PUT is done)
    w.__setDocAndSave = (paras) => new Promise((res, rej) => {
      const ed = w.__ed, PM = ed._ProseMirror(), v = ed.editorView;
      const doc = PM.model.Node.fromJSON(v.state.schema, { type: "doc", content: paras.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })) });
      v.dispatch(v.state.tr.replaceWith(0, v.state.doc.content.size, doc.content));
      ed._saveNow((e) => (e ? rej(e) : res(true)));
    });
    // text of the latest stored version, one entry per paragraph
    w.__latestParas = async (handle, objId) => {
      const env = await (await fetch("/@" + handle + "/" + objId, { headers: { Accept: "application/json" }, credentials: "include" })).json();
      return (env.record.payload.snapshot.content || []).map((b) => (b.content || []).map((c) => c.text || "").join(""));
    };
    w.__versions = async (handle, objId) => (await (await fetch("/@" + handle + "/" + objId + "/versions", { headers: { Accept: "application/json" }, credentials: "include" })).json()).versions;
  });

  await page.goto("/blank.html");
  await page.waitForFunction(() => window.$world && window.lively && lively.identity && lively.identity.did, null, { timeout: 90000 });
  const ha = "hometest_h" + Math.random().toString(36).slice(2, 7);
  /** @type {any} */ let A = null;

  try {
    // Register through the real dialog's ceremony (not a bare /register call): saving a page needs the
    // soft signing key + delegation cert it sets up. It ends by navigating to the new account's home world.
    const nav = page.waitForURL(/welcome=/, { timeout: 90000 });
    await page.evaluate(async (h) => {
      await new Promise((r) => lively.require("lively.identity.RegisterDialog").toRun(r));
      const dlg = lively.BuildSpec("lively.identity.RegisterDialog").createMorph();
      dlg.openInWorldCenter();
      dlg._startRegisterCeremony(h, h, "Test");
    }, ha);
    await nav;
    await page.goto("/blank.html");
    await page.waitForFunction(() => window.$world && lively.identity && lively.identity.did && lively.identity.did.currentUser(), null, { timeout: 90000 });
    A = { credentialId: await page.evaluate(() => lively.identity.did.currentUser().credentialId) };
    expect(await page.evaluate(() => lively.identity.did.currentUser().handle)).toBe(ha);

    // modules + no passkey priming dialog in the way of Edit/Restore
    await page.evaluate(() => new Promise((r) => lively.require("lively.identity.WikiEditor").toRun(() =>
      lively.require("lively.identity.WikiView").toRun(() => lively.require("lively.identity.PasskeyPrimingDialog").toRun(r)))));
    await page.evaluate(() => lively.LocalStorage.set(lively.identity.PasskeyPrimingDialog.SKIP_FLAG_KEY, true));

    // ── three versions through the real editor
    await page.evaluate((h) => { const w = /** @type {any} */ (window); w.__ed = lively.identity.WikiEditor.newCard(h, { wikiName: "history-test" }); }, ha);
    await page.waitForFunction(() => /** @type {any} */ (window).__ed && /** @type {any} */ (window).__ed.editorView, null, { timeout: 30000 });
    await page.evaluate(() => /** @type {any} */ (window).__setDocAndSave(["alpha beta gamma"]));
    await page.evaluate(() => /** @type {any} */ (window).__setDocAndSave(["alpha BETA gamma", "second"]));
    await page.evaluate(() => /** @type {any} */ (window).__setDocAndSave(["alpha BETA gamma", "second", "third"]));
    const objId = await page.evaluate(() => /** @type {any} */ (window).__ed._objId);
    expect(objId).toBeTruthy();
    expect((await page.evaluate(([h, o]) => /** @type {any} */ (window).__versions(h, o), [ha, objId])).length).toBe(3);

    // ── the read-only view, then History from its three-dot menu
    await page.evaluate(([h, o]) => { /** @type {any} */ (window).__ed.remove(); lively.identity.WikiView.open(h, o, {}); }, [ha, objId]);
    await page.waitForFunction(() => { const v = /** @type {any} */ (lively.identity.WikiView)._currentWorldView; return v && v._envelope && v._canEdit; }, null, { timeout: 30000 });
    await page.locator("button[title=More]").click();
    await page.locator("text=History").first().click();
    await expect(page.locator(".wh-root")).toBeVisible();
    await page.waitForFunction(() => document.querySelectorAll(".wh-grp").length > 0, null, { timeout: 20000 });

    // one group of 3 edits (same author, minutes apart); the group is selected and compared with nothing before it
    expect(await page.locator(".wh-grp").count()).toBe(1);
    await expect(page.locator(".wh-grp")).toContainText("3 edits");
    await expect(page.locator(".wh-grp .wh-badge")).toHaveText("Current");
    await expect(page.locator(".wh-panecontent")).toContainText("Created the page");
    await expect(page.locator(".wh-restore")).toHaveCount(0);                    // the current version can't be restored

    // expand the group: v3 v2 v1, newest first
    await page.locator(".wh-grp").first().click();
    await expect(page.locator(".wh-ver")).toHaveCount(3);

    // v2 against v1: "beta" -> "BETA" as a word-level edit, plus the new paragraph
    await page.locator(".wh-ver", { hasText: "v2" }).click();
    await expect(page.locator(".wh-mod")).toHaveCount(1);
    await expect(page.locator(".wh-mod del")).toHaveText("beta");
    await expect(page.locator(".wh-mod ins")).toHaveText("BETA");
    await expect(page.locator(".wh-ins")).toHaveCount(1);
    await expect(page.locator(".wh-panehead .wh-stat")).toContainText("+1 added");
    await expect(page.locator(".wh-panehead .wh-stat")).toContainText("~1 edited");

    // v3 against v1 via "compare with current" from v1's side: everything that changed since v1
    await page.locator(".wh-ver", { hasText: "v1" }).click();
    await page.locator(".wh-select").selectOption("current");
    await expect(page.locator(".wh-panecontent")).toContainText("Changes since this version");
    await expect(page.locator(".wh-mod")).toHaveCount(1);
    await expect(page.locator(".wh-ins")).toHaveCount(2);                        // "second", "third"

    // Page view of v1
    await page.locator(".wh-seg button", { hasText: "Page" }).click();
    await expect(page.locator(".wh-panecontent")).toContainText("alpha beta gamma");
    await expect(page.locator(".wh-panecontent")).not.toContainText("second");

    // ── Restore v1: confirm dialog, editor applies it and saves a NEW version, back on the read-only view
    await page.locator(".wh-restore").click();
    await expect(page.locator("text=Restore this version?")).toBeVisible();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(([h, o]) => /** @type {any} */ (window).__versions(h, o), [ha, objId])).length, { timeout: 60000 }).toBe(4);
    expect(await page.evaluate(([h, o]) => /** @type {any} */ (window).__latestParas(h, o), [ha, objId])).toEqual(["alpha beta gamma"]);
    const vs = await page.evaluate(([h, o]) => /** @type {any} */ (window).__versions(h, o), [ha, objId]);
    expect(vs[3].prevCid).toBe(vs[2].cid);                                       // chained on top, nothing rewritten

    // the editor hands back to a fresh read-only view showing the restored content
    await page.waitForFunction(() => {
      let v = null;
      $world.withAllSubmorphsDo((m) => { if (m.constructor.type === "lively.identity.WikiView") v = m; });
      return v && v._contentEl && /alpha beta gamma/.test(v._contentEl.textContent) && !/second/.test(v._contentEl.textContent);
    }, null, { timeout: 60000 });

    // the editor was swapped out, not left behind under the view
    expect(await page.evaluate(() => { let n = 0; $world.withAllSubmorphsDo((m) => { if (m.constructor.type === "lively.identity.WikiEditor") n++; }); return n; })).toBe(0);
    // ── history again: 4 versions, then Back returns to the page body
    await page.locator("button[title=More]").click();
    await page.locator("text=History").first().click();
    await page.waitForFunction(() => document.querySelectorAll(".wh-grp").length > 0, null, { timeout: 20000 });
    await page.locator(".wh-grp").first().click();
    await expect(page.locator(".wh-ver")).toHaveCount(4);
    await page.locator(".wh-ver", { hasText: "v4" }).click();                    // the restore itself: removes "second" and "third", reverts BETA
    await expect(page.locator(".wh-del")).toHaveCount(2);
    await page.locator(".wh-back").click();
    await expect(page.locator(".wh-root")).toHaveCount(0);
    await expect(page.locator(".lively-wiki-view-content")).toBeVisible();

    // ── the editor's own History button: saves, swaps back to the view and opens the panel on it
    await page.locator("button[title=More]").click();
    await page.locator("text=Edit").first().click();
    await page.waitForFunction(() => { let e = null; $world.withAllSubmorphsDo((m) => { if (m.constructor.type === "lively.identity.WikiEditor") e = m; }); return e && e.editorView; }, null, { timeout: 30000 });
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.locator(".wh-root")).toBeVisible({ timeout: 30000 });
    expect(await page.evaluate(() => { let n = 0; $world.withAllSubmorphsDo((m) => { if (m.constructor.type === "lively.identity.WikiEditor") n++; }); return n; })).toBe(0);
    await page.waitForFunction(() => document.querySelectorAll(".wh-grp").length > 0, null, { timeout: 20000 });
  } finally {
    if (A) {
      try {
        await page.evaluate(([handle, cred]) => /** @type {any} */ (window).__login(handle, cred), [ha, A.credentialId]);
        await page.evaluate(async ([handle, cred]) => {
          const w = /** @type {any} */ (window);
          return w.__req("POST", "/@" + handle + "/account/delete", { confirmHandle: handle, assertion: await w.__assert(cred) });
        }, [ha, A.credentialId]);
      } catch (e) { /* best effort */ }
    }
    await context.close();
  }
});
