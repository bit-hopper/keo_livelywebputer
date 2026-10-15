// @ts-check
// Wiki history panel with TWO accounts in one constellation: A creates it, B is a plain member (made
// a controller and demoted again: that is the one way to add a member without the join-request
// postcard flow). Covers another author in the list (attribution + the author-change group split),
// a plain member restoring, a restore reaching a peer who has the page open in the sync room, and a
// controllers-only page where a plain member gets no Restore button and a forced restore is refused.
//
// LEAVES DEBRIS: a constellation creator's account cannot be deleted through the app (409 BLOCKED, and
// there is no delete-constellation route), so every run leaves one constellation `hometest-c*` and its
// creator `hometest_ca*`, plus B's reserved handle. Prune with SQL, e.g. (check the names first):
//   DELETE FROM constellations WHERE name LIKE 'hometest-c%';
//   DELETE FROM reserved_handles WHERE handle LIKE 'hometest\_%';
// plus the creator's own rows. B is removed through the deletion feature.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount, makePage } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });
test.setTimeout(240 * 1000);

/** @type {any} */ let A, B;
const R = Math.random().toString(36).slice(2, 7);
const CNAME = "hometest-c" + R;
let pageId = "", ctrlPageId = "";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240 * 1000);
  A = await newAccount(browser, "hometest_ca" + R);
  B = await newAccount(browser, "hometest_cb" + R);

  // A creates the constellation (public), signing the creation payload the way ConstellationsBrowser does
  const created = await A.page.evaluate(async (name) => {
    await new Promise((r) => lively.require("lively.identity.ConstellationsBrowser").toRun(r));
    const CB = lively.identity.ConstellationsBrowser.prototype;
    const user = lively.identity.did.currentUser();
    const gen = await new Promise((res, rej) => lively.identity.webKey.generateGenesisObjId(user.did, (e, v) => (e ? rej(e) : res(v))));
    const did = CB._didWebForConstellation.call({}, name);
    const createdAt = new Date().toISOString();
    const payload = { name, did, controller: [user.did], threshold: 1, createdBy: user.did, createdAt };
    const creationSig = await new Promise((res, rej) => CB._signConstellationCreation.call({}, payload, (e, v) => (e ? rej(e) : res(v))));
    return /** @type {any} */ (window).__req("POST", "/c/" + encodeURIComponent(name), { did, genesisObjId: gen.objId, genesisNonce: gen.genesisNonce, createdAt, creationSig, visibility: "public" });
  }, CNAME);
  expect(created.status).toBe(201);

  // B becomes a controller, then is demoted: still a member, no longer a controller
  expect((await A.page.evaluate(([n, h]) => /** @type {any} */ (window).__req("POST", "/c/" + n + "/controllers", { handle: h }), [CNAME, B.handle])).status).toBe(200);
  expect((await A.page.evaluate(([n, d]) => /** @type {any} */ (window).__req("DELETE", "/c/" + n + "/controllers/" + encodeURIComponent(d)), [CNAME, B.did])).status).toBe(200);
  const st = await B.page.evaluate((n) => /** @type {any} */ (window).__req("GET", "/c/" + n + "/space-token"), CNAME);
  expect(st.status).toBe(200);
  expect(st.body.canWrite).toBe(true);          // a member
  expect(st.body.isController).toBe(false);     // not a controller
});

test.afterAll(async () => {
  if (B) { await deleteAccount(B); await B.context.close(); }
  if (A) await A.context.close();       // not deleted: the creator of a constellation cannot be (see the header)
});

const versions = (page, h, o) => page.evaluate(([a, b]) => /** @type {any} */ (window).__versions(a, b), [h, o]);
const paras = (page, h, o) => page.evaluate(([a, b]) => /** @type {any} */ (window).__latestParas(a, b), [h, o]);

async function openView(acct, objId) {
  const { page } = acct;
  await page.goto("/blank.html");
  await page.waitForFunction(() => window.$world && lively.identity && lively.identity.did && lively.identity.did.currentUser(), null, { timeout: 90000 });
  await page.evaluate(() => new Promise((r) => lively.require("lively.identity.WikiEditor").toRun(() =>
    lively.require("lively.identity.WikiView").toRun(() => lively.require("lively.identity.PasskeyPrimingDialog").toRun(r)))));
  await page.evaluate(([h, o]) => lively.identity.WikiView.open(h, o, {}), [A.handle, objId]);
  await page.waitForFunction(() => { const v = /** @type {any} */ (lively.identity.WikiView)._currentWorldView; return v && v._envelope; }, null, { timeout: 30000 });
}
async function openHistory(page) {
  await page.locator("button[title=More]").click();
  await page.locator("text=History").first().click();
  await expect(page.locator(".wh-root")).toBeVisible();
  await page.waitForFunction(() => document.querySelectorAll(".wh-grp").length > 0, null, { timeout: 20000 });
}

test("a second author shows up: attribution and the author-change group split", async () => {
  // A saves v1, v2; B (member) saves v3 on top, through B's own editor
  pageId = await makePage(A.page, A.handle, "c-hist", [["one"], ["one", "two"]], { constellation: CNAME });
  await B.page.evaluate(([h, o]) => { /** @type {any} */ (window).__ed = lively.identity.WikiEditor.openCard(h, o, {}); }, [A.handle, pageId]);
  await B.page.waitForFunction(() => { const e = /** @type {any} */ (window).__ed; return e && e.editorView && e._canEdit; }, null, { timeout: 60000 });
  await B.page.evaluate(() => /** @type {any} */ (window).__setDocAndSave(["one", "two", "by B"]));

  const vs = await versions(A.page, A.handle, pageId);
  expect(vs.length).toBe(3);
  expect(vs.map((v) => v.lastEditedBy)).toEqual([null, A.did, B.did]);

  await openView(A, pageId);
  await openHistory(A.page);
  // newest group first: B's single save, then A's two
  await expect(A.page.locator(".wh-grp .wh-who")).toHaveText(["@" + B.handle, "@" + A.handle]);
  await expect(A.page.locator(".wh-grp").nth(1)).toContainText("2 edits");
  // B's group is what changed on top of A's: one added block, nothing else
  await expect(A.page.locator(".wh-panehead")).toContainText("@" + B.handle);
  await expect(A.page.locator(".wh-panehead .wh-stat")).toContainText("+1 added");
  await expect(A.page.locator(".wh-ins")).toHaveText("by B");
});

test("a plain member can restore; the new version is theirs and chains on the head", async () => {
  await openView(B, pageId);
  await openHistory(B.page);
  await B.page.locator(".wh-grp").nth(1).click();                       // A's group, expand
  await B.page.locator(".wh-ver", { hasText: "v1" }).click();
  await expect(B.page.locator(".wh-restore")).toBeVisible();            // canEdit came from the edit-token route (member, policy: all)
  await B.page.locator(".wh-restore").click();
  await B.page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect.poll(async () => (await versions(B.page, A.handle, pageId)).length, { timeout: 60000 }).toBe(4);
  expect(await paras(B.page, A.handle, pageId)).toEqual(["one"]);
  const vs = await versions(B.page, A.handle, pageId);
  expect(vs[3].lastEditedBy).toBe(B.did);
  expect(vs[3].prevCid).toBe(vs[2].cid);
});

test("a restore reaches a peer who has the page open in the sync room", async () => {
  // A opens the page in the editor and waits until the room has handed over its state
  await A.page.goto("/blank.html");
  await A.page.waitForFunction(() => window.$world && lively.identity && lively.identity.did && lively.identity.did.currentUser(), null, { timeout: 90000 });
  await A.page.evaluate(() => new Promise((r) => lively.require("lively.identity.WikiEditor").toRun(r)));
  await A.page.evaluate(([h, o]) => { /** @type {any} */ (window).__ed = lively.identity.WikiEditor.openCard(h, o, {}); }, [A.handle, pageId]);
  await A.page.waitForFunction(() => { const e = /** @type {any} */ (window).__ed; return e && e.editorView && e.wsProvider && e.wsProvider.synced; }, null, { timeout: 60000 });
  expect(await A.page.evaluate(() => /** @type {any} */ (window).__ed.editorView.state.doc.textContent)).toBe("one");

  // B restores v2 ("one", "two") from the history panel
  await openView(B, pageId);
  await openHistory(B.page);
  // A's editor opening may add a version of its own (see the last test), so don't depend on which group holds v2
  for (let i = 0; i < await B.page.locator(".wh-grp").count(); i++) {
    const g = B.page.locator(".wh-grp").nth(i);
    if (await g.locator(".wh-chev").count()) await g.click();
  }
  await B.page.locator(".wh-ver", { hasText: "v2" }).click();
  await B.page.locator(".wh-restore").click();
  await B.page.getByRole("button", { name: "Restore", exact: true }).click();

  // A's open editor now shows it without reloading
  await A.page.waitForFunction(() => /** @type {any} */ (window).__ed.editorView.state.doc.textContent === "onetwo", null, { timeout: 60000 });
  await expect.poll(async () => (await paras(B.page, A.handle, pageId)).join("|"), { timeout: 60000 }).toBe("one|two");
});

test("controllers-only page: a plain member gets no Restore button and a forced restore is refused", async () => {
  ctrlPageId = await makePage(A.page, A.handle, "c-ctrl", [["one"], ["one", "two"]],
    { constellation: CNAME, editPolicy: { mode: "controllers" } });
  const before = (await versions(A.page, A.handle, ctrlPageId)).length;
  expect(before).toBe(2);

  // the creator is a controller: the button is there
  await openView(A, ctrlPageId);
  await openHistory(A.page);
  await A.page.locator(".wh-grp").first().click();
  await A.page.locator(".wh-ver", { hasText: "v1" }).click();
  await expect(A.page.locator(".wh-restore")).toBeVisible();

  // B can read the history but not restore
  await openView(B, ctrlPageId);
  await expect.poll(() => B.page.evaluate(() => /** @type {any} */ (lively.identity.WikiView)._currentWorldView._canEdit === false)).toBe(true);
  await openHistory(B.page);
  await B.page.locator(".wh-grp").first().click();
  await B.page.locator(".wh-ver", { hasText: "v1" }).click();
  await expect(B.page.locator(".wh-panehead")).toContainText("@" + A.handle);
  await expect(B.page.locator(".wh-restore")).toHaveCount(0);

  // forcing it anyway (what a stale _canEdit or a crafted call would do): the editor refuses, nothing is saved
  const snap = await B.page.evaluate(async ([h, o]) => {
    const vs = await /** @type {any} */ (window).__versions(h, o);
    const env = await (await fetch("/@" + h + "/" + o + "/at/" + vs[0].cid, { headers: { Accept: "application/json" }, credentials: "include" })).json();
    return (env.envelope || env).record.payload;
  }, [A.handle, ctrlPageId]);
  await B.page.evaluate(([h, o, p]) => { lively.identity.WikiEditor.openCard(h, o, { restore: { snapshot: p.snapshot, attachments: p.attachments || [] } }); }, [A.handle, ctrlPageId, snap]);
  await B.page.waitForFunction(() => $world.submorphs.some((m) => m.name === "messageMorph" && /permission/.test(m.renderContext().shapeNode.textContent)), null, { timeout: 60000 });
  await B.page.waitForTimeout(3000);
  expect((await versions(A.page, A.handle, ctrlPageId)).length).toBe(2);
  expect(await paras(A.page, A.handle, ctrlPageId)).toEqual(["one", "two"]);
});

test("opening the editor on a page does not take over the head version's attribution", async () => {
  // Needs the server with the unchanged-content rule in _applyWikiContributorTracking (restart after editing it).
  // B saves new content; A then opens the page in the editor, whose autosave re-saves identical content.
  const objId = await makePage(A.page, A.handle, "c-attr", [["one"], ["one", "two"]], { constellation: CNAME });
  await B.page.evaluate(([h, o]) => { /** @type {any} */ (window).__ed = lively.identity.WikiEditor.openCard(h, o, {}); }, [A.handle, objId]);
  await B.page.waitForFunction(() => { const e = /** @type {any} */ (window).__ed; return e && e.editorView && e._canEdit; }, null, { timeout: 60000 });
  await B.page.evaluate(() => /** @type {any} */ (window).__setDocAndSave(["one", "two", "by B"]));
  const head = (await versions(A.page, A.handle, objId)).pop();
  expect(head.lastEditedBy).toBe(B.did);

  await A.page.evaluate(([h, o]) => { /** @type {any} */ (window).__ed.remove(); /** @type {any} */ (window).__ed = lively.identity.WikiEditor.openCard(h, o, {}); }, [A.handle, objId]);
  await A.page.waitForFunction(() => { const e = /** @type {any} */ (window).__ed; return e && e.editorView && e.wsProvider && e.wsProvider.synced; }, null, { timeout: 60000 });
  await A.page.waitForTimeout(5000);                                    // longer than the autosave debounce
  const after = await versions(A.page, A.handle, objId);
  expect(after.length).toBe(3);                                         // no new version either
  expect(after[2].cid).toBe(head.cid);
  expect(after[2].lastEditedBy).toBe(B.did);
});
