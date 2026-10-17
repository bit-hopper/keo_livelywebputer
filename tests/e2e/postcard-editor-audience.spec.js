// @ts-check
// PostCardEditor audience handling, driven on the real editor class in a blank world
// with the network, signing and key lookups stubbed. It checks WHO a save is sealed
// to and what is recorded, not the cryptography itself (a test account cannot make a
// signed card, so the sealing and the passkey prompt are checked by hand).
const { test, expect } = require("@playwright/test");

async function boot(page) {
  await page.goto("/blank.html");
  await page.waitForFunction(
    () => window.$world && window.lively && lively.identity && lively.identity.did,
    null, { timeout: 90000 });
  await page.evaluate(() => new Promise((r) => lively.require("lively.identity.PostCardEditor").toRun(r)));
  // One editor per test, with every outside dependency replaced by a recorder.
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const calls = w.__calls = { sealedTo: [], params: [], recorded: [], puts: [], alerts: [] };
    const id = lively.identity;
    id.did.currentUser = () => ({ did: "did:me", handle: "me", credentialId: "cred", rpId: "localhost" });
    id.webAuthn._kekCache = { cred: "KEK" };
    w.__ctx = {
      ownerDid: "did:me", handle: "me",
      friendDids: ["did:a", "did:b", "did:c"], orbitDids: ["did:a"],
      handleByDid: { "did:a": "ann", "did:b": "bo", "did:c": "cy" },
      lists: [], cardAudiences: {}
    };
    w.__ctxFails = false;
    id.postcardAudience.loadContext = (cb) => (w.__ctxFails ? cb(new Error("offline")) : cb(null, JSON.parse(JSON.stringify(w.__ctx))));
    id.postcardAudience.setCardAudience = (objId, audience, cb) => { calls.recorded.push({ objId, audience }); cb(null); };
    id.postCardSerializer.serializePlainEncrypted = (params, cb) => {
      calls.params.push({ kind: "encrypted", recipients: params.recipients.map((r) => r.did), stateMeta: params.stateMeta });
      cb(null, { objId: "card1", visibility: "shared", state: params.stateMeta, record: {} });
    };
    id.postCardSerializer.serializePlainToEnvelope = (params, cb) => {
      calls.params.push({ kind: "public" });
      cb(null, { objId: "card1", visibility: "public", state: params.stateMeta, record: {} });
    };
    w.$world.alert = (m) => calls.alerts.push(String(m));

    const e = w.__editor = new id.PostCardEditor(lively.rect(0, 0, 785, 520));
    e._handle = "me";
    e._canEdit = true;
    e._isOwner = true;
    e.editorView = { state: { doc: { toJSON: () => ({ type: "doc", content: [] }) } } };
    e._setStatus = () => {};
    e._putEnvelope = (env, cb) => { calls.puts.push(env); cb(null); };
    e._resolveRecipientPubKeys = (handles, cb) => {
      calls.sealedTo.push(handles.slice());
      cb(null, { resolved: handles.map((h) => ({ did: "did:" + h, handle: h, x25519PublicKey: "pub-" + h })), failed: [] });
    };
  });
}

const save = (page) => page.evaluate(() => new Promise((res) => /** @type {any} */ (window).__editor._saveNow((err) => res(err ? String(err.message) : null))));
const calls = (page) => page.evaluate(() => /** @type {any} */ (window).__calls);

test("a card with a recorded audience is sealed to it, not to a handle list", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__ctx.cardAudiences = { card1: { tiers: ["friends"], people: [] } };
    Object.assign(w.__editor, { _objId: "card1", _visibility: "private", _recipientHandles: [] });
  });
  expect(await save(page)).toBeNull();
  const c = await calls(page);
  expect(c.sealedTo[0].sort()).toEqual(["ann", "bo", "cy"]);
  expect(c.params[0].recipients.sort()).toEqual(["did:ann", "did:bo", "did:cy"]);
  expect(c.params[0].stateMeta.audience).toEqual({ tiers: ["friends"] });
  expect(c.params[0].stateMeta.recipientHandles).toBeUndefined();
  // What the save names must not become a sticky handle list.
  expect(await page.evaluate(() => /** @type {any} */ (window).__editor._recipientHandles)).toEqual([]);
});

test("a person withdrawn from the audience is not sealed to on the next save", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__ctx.cardAudiences = { card1: { tiers: ["orbit"], people: [] } };
    Object.assign(w.__editor, { _objId: "card1", _visibility: "private" });
  });
  expect(await save(page)).toBeNull();
  expect((await calls(page)).sealedTo[0]).toEqual(["ann"]);
});

test("a private save of an existing card waits for the recorded audience and fails rather than guess", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__ctxFails = true;
    Object.assign(w.__editor, { _objId: "card1", _visibility: "private" });
  });
  expect(await save(page)).toBe("offline");
  const c = await calls(page);
  expect(c.params).toEqual([]);
  expect(c.puts).toEqual([]);
});

test("a card shared by handle before audiences existed keeps sealing to that list", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    Object.assign(/** @type {any} */ (window).__editor, { _objId: "card1", _visibility: "private", _recipientHandles: ["ann"] });
  });
  expect(await save(page)).toBeNull();
  const c = await calls(page);
  expect(c.sealedTo[0]).toEqual(["ann"]);
  expect(c.params[0].stateMeta.recipientHandles).toEqual(["ann"]);
  expect(c.params[0].stateMeta.audience).toBeUndefined();
});

test("a Send seals to the recipient as well and reports who was sealed", async ({ page }) => {
  await boot(page);
  const sealed = await page.evaluate(() => new Promise((res) => {
    const w = /** @type {any} */ (window);
    w.__ctx.cardAudiences = { card1: { tiers: ["orbit"], people: [] } };
    const e = w.__editor;
    Object.assign(e, { _objId: "card1", _visibility: "private" });
    e._grantAttachmentsAccess = (h, cb) => cb();
    e._postInbox = (h, cb) => cb(null, { ok: true });
    lively.identity.webKey.resolveHandle = (h, cb) => cb(null, { did: "did:" + h });
    e._doSend("zed", (err) => res({ err: err && err.message, sealedTo: w.__calls.sealedTo, extra: e._extraRecipientHandles }));
  }));
  expect(sealed.err).toBeFalsy();
  expect(sealed.sealedTo.pop().sort()).toEqual(["ann", "zed"]);
  expect(sealed.extra).toEqual([]);
});

test("choosing an audience on an existing card records it, then saves a version sealed to it", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    Object.assign(/** @type {any} */ (window).__editor, { _objId: "card1", _visibility: "public", _audienceLoaded: true });
  });
  await page.evaluate(() => /** @type {any} */ (window).__editor._applyAudienceResult({ pub: false, audience: { tiers: ["orbit"], people: ["did:c"] } }));
  await page.waitForFunction(() => /** @type {any} */ (window).__calls.puts.length === 1);
  const c = await calls(page);
  expect(c.recorded).toEqual([{ objId: "card1", audience: { tiers: ["orbit"], people: ["did:c"] } }]);
  expect(c.sealedTo[0].sort()).toEqual(["ann", "cy"]);
  expect(await page.evaluate(() => /** @type {any} */ (window).__editor._visibility)).toBe("private");
});

test("choosing Public clears the recorded audience and saves a plaintext version", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    Object.assign(/** @type {any} */ (window).__editor, {
      _objId: "card1", _visibility: "private", _audienceLoaded: true, _audience: { tiers: ["friends"], people: [] } });
  });
  await page.evaluate(() => /** @type {any} */ (window).__editor._applyAudienceResult({ pub: true, audience: { tiers: [], people: [] } }));
  await page.waitForFunction(() => /** @type {any} */ (window).__calls.puts.length === 1);
  const c = await calls(page);
  expect(c.recorded).toEqual([{ objId: "card1", audience: null }]);
  expect(c.params.map((p) => p.kind)).toEqual(["public"]);
});

test("an audience chosen on a new card is recorded after its first save", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const e = /** @type {any} */ (window).__editor;
    Object.assign(e, { _objId: null, _isNew: true, _visibility: "public", _audienceLoaded: true });
    e._connectSync = () => {};
  });
  await page.evaluate(() => /** @type {any} */ (window).__editor._applyAudienceResult({ pub: false, audience: { tiers: ["friends"], people: [] } }));
  expect((await calls(page)).recorded).toEqual([]);          // nothing to record against yet
  expect(await save(page)).toBeNull();
  await page.waitForFunction(() => /** @type {any} */ (window).__calls.recorded.length === 1);
  expect((await calls(page)).recorded).toEqual([{ objId: "card1", audience: { tiers: ["friends"], people: [] } }]);
  expect(await page.evaluate(() => /** @type {any} */ (window).__editor._audienceDirty)).toBe(false);
});

test("the send panel has no visibility step and says Send locks the card", async ({ page }) => {
  await boot(page);
  const text = await page.evaluate(() => {
    const e = /** @type {any} */ (window).__editor;
    e._visibility = "private";
    e._populateKnownConstellations = () => {};
    e._promptAndSend();
    const t = e._sendPanel.textContent;
    e._closeSendPanel();
    return t;
  });
  expect(text).toContain("locks it");
  expect(text).toContain("Send & lock");
  expect(text).not.toContain("Choose who can read this card");
});

test("a card delivered to an inbox opens read-only with the reason", async ({ page }) => {
  await boot(page);
  const label = await page.evaluate(() => {
    const e = /** @type {any} */ (window).__editor;
    const tb = document.createElement("div");
    e.editorView.setProps = () => {};
    Object.assign(e, { _sentLocked: true, _canEdit: false, _toolbarDiv: tb });
    e._applyReadOnlyMode();
    return tb.textContent;
  });
  expect(label).toContain("permanent");
});

test("the audience pill shows in a real editor and opens the dialog", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__ctx.friendDids = ["did:a"];
    w.__ctx.handleByDid = { "did:a": "ann" };
    w.__real = lively.identity.PostCardEditor.newCard("me");
  });
  await page.waitForFunction(() => /** @type {any} */ (window).__real._visibilityBtn && /** @type {any} */ (window).__real.editorView, null, { timeout: 30000 });
  expect(await page.evaluate(() => /** @type {any} */ (window).__real._visibilityBtn.textContent)).toContain("Public");

  const before = await page.evaluate(() => $world.submorphs.length);
  await page.evaluate(() => /** @type {any} */ (window).__real._visibilityBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
  await page.waitForFunction((n) => $world.submorphs.length > n, before, { timeout: 15000 });
  // The dialog is a morph; read what it actually rendered.
  const shown = await page.evaluate(() => $world.submorphs.filter((m) => m.isBox || m.constructor.type === 'lively.morphic.Box').pop().renderContext().shapeNode.textContent);
  const hasFriends = /Who can see this postcard/.test(shown) && /Friends/.test(shown) && /Orbit/.test(shown);
  expect(hasFriends).toBe(true);
});

test("a card shared before audiences existed is labelled by who it is sealed to", async ({ page }) => {
  await boot(page);
  const label = await page.evaluate(() => {
    const e = /** @type {any} */ (window).__editor;
    Object.assign(e, { _visibility: "private", _audience: null, _recipientHandles: [],
      _envelope: { record: { recipients: [{ did: "did:a", sealedDek: "s" }, { did: "did:b", sealedDek: "s" }] } } });
    return e._audienceLabel();
  });
  expect(label).toBe("2 people");
});
