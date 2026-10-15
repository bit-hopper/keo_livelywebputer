// @ts-check
// Wiki history panel: the paths wiki-history.spec.js leaves out, on ONE throwaway account (a
// personal wiki, no constellation): who saved each version, the grouping rule, the index route
// (/@handle/wiki, where WikiIndex owns the Edit/Restore swap), a content version the editor's
// schema rejects, attachments carried into a restore, and a restore whose save fails (passkey
// prompt not satisfied) followed by a successful retry.
// The two-account cases (another author, plain member, controllers-only page, a peer in the sync
// room) are in wiki-history-constellation.spec.js.
// Removes its account through the deletion feature; leaves one reserved `hometest_*` handle behind.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount, makePage } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });
test.setTimeout(180 * 1000);

/** @type {any} */ let A;
const R = Math.random().toString(36).slice(2, 7);

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180 * 1000);
  A = await newAccount(browser, "hometest_e" + R);
});
test.afterAll(async () => {
  if (A) { await deleteAccount(A); await A.context.close(); }
});

const versions = (page, h, o) => page.evaluate(([a, b]) => /** @type {any} */ (window).__versions(a, b), [h, o]);
const paras = (page, h, o) => page.evaluate(([a, b]) => /** @type {any} */ (window).__latestParas(a, b), [h, o]);
const count = (page, type) => page.evaluate((t) => /** @type {any} */ (window).__findAll(t).length, type);

async function openHistoryFromMenu(page) {
  await page.locator("button[title=More]").click();
  await page.locator("text=History").first().click();
  await expect(page.locator(".wh-root")).toBeVisible();
  await page.waitForFunction(() => document.querySelectorAll(".wh-grp").length > 0, null, { timeout: 20000 });
}

test("every version carries who saved it, and the list shows them", async () => {
  const { page, handle, did } = A;
  const objId = await makePage(page, handle, "edge-authors", [["one"], ["one", "two"], ["one", "two", "three"]]);
  const vs = await versions(page, handle, objId);
  expect(vs.length).toBe(3);
  // needs the restarted server (listVersions returns it). The genesis version never has one (nothing existed to
  // track against) and the panel falls back to the page's author for it, which is right.
  expect(vs[0].lastEditedBy).toBeNull();
  expect(vs.slice(1).map((v) => v.lastEditedBy)).toEqual([did, did]);
  expect(vs.every((v) => v.title)).toBe(true);
  await page.evaluate(([h, o]) => { /** @type {any} */ (window).__ed.remove(); lively.identity.WikiView.open(h, o, {}); }, [handle, objId]);
  await page.waitForFunction(() => { const v = /** @type {any} */ (lively.identity.WikiView)._currentWorldView; return v && v._envelope; }, null, { timeout: 30000 });
  await openHistoryFromMenu(page);
  // v2, v3 attributed from the server's data; v1 falls back to the page's author
  expect(await page.evaluate(() => /** @type {any} */ (window).__findAll("lively.identity.WikiView")[0]._history.versions.map((v) => v.attributed))).toEqual([false, true, true]);
  await expect(page.locator(".wh-grp .wh-who")).toHaveText("@" + handle);
});

test("grouping: a new group on another author or a gap over 30 minutes, not at exactly 30", async () => {
  const groups = await A.page.evaluate(() => {
    const H = new lively.identity.WikiHistory({});
    const t = (min) => new Date(Date.UTC(2026, 0, 1, 12, min));
    const v = (cid, did, min) => ({ cid, did, at: t(min) });
    H.versions = [v("a", "x", 0), v("b", "x", 10), v("c", "x", 40) /* exactly 30 after b */, v("d", "x", 71) /* 31 after c */,
      v("e", "y", 72) /* other author */, v("f", "x", 73) /* back to the first */];
    H._group();
    return H.groups.map((g) => g.versions.map((x) => x.cid).join(""));
  });
  expect(groups).toEqual(["f", "e", "d", "abc"]);          // newest group first
});

test("index route: History and Restore through WikiIndex's own edit swap", async () => {
  const { page, handle } = A;
  const objId = await makePage(page, handle, "edge-index", [["one"], ["one", "two"], ["one", "two", "three"]]);
  await page.goto("/@" + handle + "/wiki");
  await page.waitForFunction(() => window.$world && lively.identity && lively.identity.did && lively.identity.did.currentUser(), null, { timeout: 90000 });
  // the page's card in the grid: click its name label for real
  const label = await page.waitForFunction(() => {
    let r = null;
    $world.withAllSubmorphsDo((m) => { if (!r && m.textString === "edge-index" && m.renderContext().shapeNode) { const b = m.renderContext().shapeNode.getBoundingClientRect(); if (b.width) r = { x: b.x + 20, y: b.y + b.height / 2 }; } });
    return r;
  }, null, { timeout: 60000 }).then((h) => h.jsonValue());
  await page.mouse.move(label.x, label.y);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForFunction(() => /** @type {any} */ (window).__findAll("lively.identity.WikiView").some((v) => v._envelope && v._canEdit), null, { timeout: 60000 });
  await openHistoryFromMenu(page);
  await page.locator(".wh-grp").first().click();
  await page.locator(".wh-ver", { hasText: "v1" }).click();
  await page.locator(".wh-restore").click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect.poll(async () => (await versions(page, handle, objId)).length, { timeout: 60000 }).toBe(4);
  expect(await paras(page, handle, objId)).toEqual(["one"]);
  // the slot ends on a read-only view of the restored text, with no editor left in the world
  await page.waitForFunction(() => /** @type {any} */ (window).__findAll("lively.identity.WikiView").some((v) => v._contentEl && /one/.test(v._contentEl.textContent) && !/two/.test(v._contentEl.textContent)), null, { timeout: 60000 });
  expect(await count(page, "lively.identity.WikiEditor")).toBe(0);
  // and its History button (a view the index created after the swap) still works
  await openHistoryFromMenu(page);
  await page.locator(".wh-grp").first().click();
  await expect(page.locator(".wh-ver")).toHaveCount(4);
});

test("a version the editor schema rejects is refused with a message and saves nothing", async () => {
  const { page, handle } = A;
  const objId = await makePage(page, handle, "edge-schema", [["one"], ["one", "two"]]);
  await page.evaluate(([h, o]) => { /** @type {any} */ (window).__ed.remove();
    lively.identity.WikiEditor.openCard(h, o, { restore: { snapshot: { type: "doc", content: [{ type: "no_such_node" }] }, attachments: [] } }); }, [handle, objId]);
  await page.waitForFunction(() => $world.submorphs.some((m) => m.name === "messageMorph"), null, { timeout: 30000 });
  const msg = await page.evaluate(() => { const m = $world.submorphs.filter((x) => x.name === "messageMorph").pop(); return m.renderContext().shapeNode.textContent; });
  expect(msg).toMatch(/cannot be restored/);
  await page.waitForTimeout(3000);                                   // longer than the autosave debounce
  expect((await versions(page, handle, objId)).length).toBe(2);
  expect(await paras(page, handle, objId)).toEqual(["one", "two"]);
});

test("a restore carries the old version's attachments into the new one", async () => {
  const { page, handle } = A;
  const fake = { objId: "att-test-1", dek: "ZGVr", blobCid: "bafyfake", blobNonce: "bm9uY2U", name: "a.png", mime: "image/png" };
  // version 1 lists an attachment; version 2 does not
  await page.evaluate(([h, f]) => { const w = /** @type {any} */ (window); w.__ed = lively.identity.WikiEditor.newCard(h, { wikiName: "edge-attach" }); w.__fake = f; }, [handle, fake]);
  await page.waitForFunction(() => /** @type {any} */ (window).__ed.editorView, null, { timeout: 30000 });
  await page.evaluate(() => { const w = /** @type {any} */ (window); w.__ed._attachments = [w.__fake]; return w.__setDocAndSave(["one"]); });
  await page.evaluate(() => { const w = /** @type {any} */ (window); w.__ed._attachments = []; return w.__setDocAndSave(["one", "two"]); });
  const objId = await page.evaluate(() => /** @type {any} */ (window).__ed._objId);
  const vs = await versions(page, handle, objId);
  expect(vs.length).toBe(2);
  const v1 = await page.evaluate(async ([h, o, c]) => (await (await fetch("/@" + h + "/" + o + "/at/" + c, { headers: { Accept: "application/json" }, credentials: "include" })).json()), [handle, objId, vs[0].cid]);
  const env1 = v1.envelope || v1;
  expect(env1.record.payload.attachments.map((a) => a.objId)).toEqual(["att-test-1"]);
  expect((await page.evaluate(([h, o]) => /** @type {any} */ (window).__latestEnvelope(h, o), [handle, objId])).record.payload.attachments).toEqual([]);

  await page.evaluate(([h, o, r]) => { /** @type {any} */ (window).__ed.remove();
    lively.identity.WikiEditor.openCard(h, o, { restore: r, onSaved: function () {} }); },
    [handle, objId, { snapshot: env1.record.payload.snapshot, attachments: env1.record.payload.attachments }]);
  await expect.poll(async () => (await versions(page, handle, objId)).length, { timeout: 60000 }).toBe(3);
  const latest = await page.evaluate(([h, o]) => /** @type {any} */ (window).__latestEnvelope(h, o), [handle, objId]);
  expect(latest.record.payload.attachments.map((a) => a.objId)).toEqual(["att-test-1"]);
  expect(await paras(page, handle, objId)).toEqual(["one"]);
});

test("a restore whose save fails keeps the editor open on the restored text, and a retry saves it", async () => {
  const { page, handle } = A;
  // a fresh world: the earlier tests left the wiki index route (and its open page view) on this page
  await page.goto("/blank.html");
  await page.waitForFunction(() => window.$world && lively.identity && lively.identity.did && lively.identity.did.currentUser(), null, { timeout: 90000 });
  await page.evaluate(() => new Promise((r) => lively.require("lively.identity.WikiEditor").toRun(() =>
    lively.require("lively.identity.WikiView").toRun(() => lively.require("lively.identity.PasskeyPrimingDialog").toRun(r)))));
  const objId = await makePage(page, handle, "edge-passkey", [["one"], ["one", "two"], ["one", "two", "three"]]);
  await page.evaluate(([h, o]) => { /** @type {any} */ (window).__ed.remove(); lively.identity.WikiView.open(h, o, {}); }, [handle, objId]);
  await page.waitForFunction(() => { const v = /** @type {any} */ (lively.identity.WikiView)._currentWorldView; return v && v._envelope && v._canEdit; }, null, { timeout: 30000 });
  await openHistoryFromMenu(page);
  await page.locator(".wh-grp").first().click();
  await page.locator(".wh-ver", { hasText: "v1" }).click();
  await page.locator(".wh-restore").click();

  // the passkey prompt is cancelled: no warm key, and the ceremony rejects the way a dismissed prompt does.
  // (Not done by flipping the virtual authenticator's user verification off and on: Chrome's virtual
  // authenticator does not recover from that, even for a direct navigator.credentials.get.)
  await page.evaluate(() => {
    const wa = lively.identity.webAuthn;
    wa._kekCache = {};
    wa.deriveKek = (o, cb) => cb(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
  });
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.waitForFunction(() => { const e = /** @type {any} */ (window).__findAll("lively.identity.WikiEditor")[0]; return e && e.editorView && e._statusEl && /Error/.test(e._statusEl.textContent); }, null, { timeout: 60000 });
  // nothing was saved, the editor shows the restored text, and it is still the one editor in the world
  expect((await versions(page, handle, objId)).length).toBe(3);
  expect(await page.evaluate(() => /** @type {any} */ (window).__findAll("lively.identity.WikiEditor")[0].editorView.state.doc.textContent)).toBe("one");
  expect(await count(page, "lively.identity.WikiEditor")).toBe(1);

  // satisfy the prompt and press Save: the restore lands as version 4
  await page.evaluate(() => { delete lively.identity.webAuthn.deriveKek; });   // back to the real ceremony
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await versions(page, handle, objId)).length, { timeout: 60000 }).toBe(4);
  expect(await paras(page, handle, objId)).toEqual(["one"]);
});
