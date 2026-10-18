// @ts-check
// The owner's featured-worlds chooser on the homestar, against a LIVE server: the real dialog driven
// by real clicks, what it stores in the profile (and what it must leave alone), the order the page
// then shows, Escape, and what a signed-out visitor is shown.
//
// Registers one throwaway `hometest_*` account through the real RegisterDialog ceremony (see
// account-lifecycle.spec.js on pruning the reserved handles) and removes it through the deletion
// feature, even if a check fails.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.setTimeout(240 * 1000);

// Creates a world the way WorldsBrowser does (blank.html's world, signed), without opening it.
const makeWorld = (page, name) => page.evaluate(async (n) => {
  await new Promise((r) => lively.require("lively.identity.WorldsBrowser").toRun(r));
  const did = lively.identity.did, user = did.currentUser();
  const html = await (await fetch("/blank.html")).text();
  const jso = JSON.parse(html.match(/<script[^>]*type="text\/x-lively-world"[^>]*>([\s\S]*?)<\/script>/)[1]);
  const rootObj = jso.registry && jso.registry[jso.id];
  if (rootObj) { delete rootObj.currentUser; delete rootObj.knownWorkingDirectories; }
  const gen = await new Promise((res, rej) => lively.identity.webKey.generateGenesisObjId(user.did, (e, g) => (e ? rej(e) : res(g))));
  const method = did.findMethodByCredentialId(user.document, user.credentialId);
  const env = await new Promise((res, rej) => lively.identity.signedSerializer.serializeToEnvelope({
    jso, type: "world", objId: gen.objId, genesisNonce: gen.genesisNonce,
    publicKeyJwk: method ? method.publicKeyJwk : null, stateMeta: { name: n } }, (e, v) => (e ? rej(e) : res(v))));
  const r = await (await fetch("/@" + user.handle + "/" + gen.objId, { method: "PUT", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(env) })).json();
  return { ok: r.ok, objId: gen.objId, error: r.error };
}, name);

test("choose, order and save the featured worlds", async ({ browser }) => {
  const owner = await newAccount(browser, "hometest_w" + Math.random().toString(36).slice(2, 6));
  const page = owner.page;
  /** @type {import('@playwright/test').BrowserContext | null} */
  let visitorCtx = null;

  try {
    const games = await makeWorld(page, "Games");
    const notes = await makeWorld(page, "Notes");
    expect(games.ok, games.error).toBe(true);
    expect(notes.ok, notes.error).toBe(true);
    const profile = () => page.evaluate(async (h) => (await (await fetch("/@" + h + "/profile", { credentials: "include" })).json()).record.payload, owner.handle);
    const all = (await page.evaluate(async (h) => (await (await fetch("/@" + h + "/worlds", { credentials: "include" })).json()).worlds, owner.handle));
    const workshop = all.find((w) => w.name === "Workshop");
    expect(all.length).toBe(3);

    // another homestar setting must survive the save: seed one through the same path the profile card uses
    await page.evaluate(async (ws) => {
      await new Promise((r) => lively.require("lively.identity.UserSpace").toRun(r));
      const cur = (await new Promise((res) => lively.identity.userSpace.getProfile((e, v) => res(v)))).record.payload.homestar || {};
      await new Promise((res, rej) => lively.identity.userSpace.saveProfile({ homestar: Object.assign({}, cur, { layout: { left: ["orbit"] }, featuredWorlds: [ws] }) }, (e) => (e ? rej(e) : res(true))));
    }, workshop.objId);
    expect((await profile()).homestar).toEqual({ layout: { left: ["orbit"] }, featuredWorlds: [workshop.objId] });

    await page.goto("/@" + owner.handle);
    await page.waitForFunction(() => /** @type {any} */ (window).lively && lively.identity && lively.identity.Homestar && window.$world, null, { timeout: 90000 });
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__texts = () => { const out = []; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; };
      // test ids: the morph that owns a piece of text (a button or row), or a child of the row of the named world
      w.__tagText = (text, id) => {
        let hit = null;
        $world.withAllSubmorphsDo((m) => { if (m.textString === text && m.owner) hit = m; });
        if (!hit) return 0;
        hit.owner.renderContext().shapeNode.setAttribute("data-pw", id || text);
        return 1;
      };
      // the arrow glyph in the DIALOG's row for one world (the page's rows have none)
      w.__tagIn = (worldName, glyph) => {
        let target = null;
        $world.withAllSubmorphsDo((m) => { if (m.textString === worldName && m.owner && m.owner.submorphs.some((s) => s.textString === glyph)) target = m.owner.submorphs.find((s) => s.textString === glyph); });
        if (!target) return 0;
        target.renderContext().shapeNode.setAttribute("data-pw", glyph + ":" + worldName);
        return 1;
      };
      // names of the world rows on the PAGE (not the dialog), top to bottom
      w.__pageWorldNames = () => {
        const rows = [];
        // a page row is a box holding a tile box that holds the "language" glyph
        $world.withAllSubmorphsDo((m) => { if (m.submorphs && m.submorphs.some((s) => s.submorphs && s.submorphs.some((t) => t.textString === "language"))) rows.push(m); });
        return rows.map((r) => ({ y: r.worldPoint(lively.pt(0, 0)).y, name: (r.submorphs.find((s) => s.textString) || {}).textString }))
          .sort((a, b) => a.y - b.y).map((r) => r.name);
      };
    });
    const tag = async (text, id) => {
      await expect.poll(() => page.evaluate(([t, i]) => /** @type {any} */ (window).__tagText(t, i), [text, id]), { timeout: 30000 }).toBe(1);
      return page.locator('[data-pw="' + (id || text) + '"]');
    };
    const arrow = async (worldName, glyph) => {
      await expect.poll(() => page.evaluate(([n, g]) => /** @type {any} */ (window).__tagIn(n, g), [worldName, glyph]), { timeout: 30000 }).toBe(1);
      return page.locator('[data-pw="' + glyph + ":" + worldName + '"]');
    };
    const texts = () => page.evaluate(() => /** @type {any} */ (window).__texts());
    const counter = async () => (await texts()).find((t) => /^\d+ featured$/.test(t));

    // ── the page lists the one featured world, and the owner has a Choose button
    await expect.poll(async () => (await texts()).includes("Workshop")).toBe(true);
    expect(await texts()).not.toContain("Games");
    await (await tag("Choose")).click();

    // ── the dialog lists all three, the featured one first and ticked
    await expect.poll(counter).toBe("1 featured");
    const dialogTexts = await texts();
    for (const n of ["Workshop", "Games", "Notes"]) expect(dialogTexts).toContain(n);

    // ── Escape stores nothing
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await texts()).includes("Featured worlds")).toBe(false);
    expect((await profile()).homestar.featuredWorlds).toEqual([workshop.objId]);

    // ── tick Games then Notes, then reorder to Notes, Games, Workshop
    await (await tag("Choose")).click();
    await expect.poll(counter).toBe("1 featured");
    await (await tag("Games", "row-Games")).click();
    await expect.poll(counter).toBe("2 featured");
    await (await tag("Notes", "row-Notes")).click();
    await expect.poll(counter).toBe("3 featured");                       // featured order: Workshop, Games, Notes
    await (await arrow("Notes", "arrow_upward")).click();                // Workshop, Notes, Games
    await (await arrow("Workshop", "arrow_downward")).click();           // Notes, Workshop, Games
    await (await arrow("Games", "arrow_upward")).click();                // Notes, Games, Workshop
    await (await tag("Save")).click();

    await expect.poll(async () => (await profile()).homestar.featuredWorlds.length).toBe(3);
    const saved = await profile();
    expect(saved.homestar.featuredWorlds).toEqual([notes.objId, games.objId, workshop.objId]);
    expect(saved.homestar.layout).toEqual({ left: ["orbit"] });          // the rest of homestar survived
    expect(saved.displayName).toBeTruthy();                              // and the rest of the profile

    // ── the page now shows them in that order
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__pageWorldNames())).toEqual(["Notes", "Games", "Workshop"]);

    // ── a signed-out visitor sees only the worlds they may open
    visitorCtx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const vpage = await visitorCtx.newPage();
    await vpage.goto("/@" + owner.handle);
    await vpage.waitForFunction(() => /** @type {any} */ (window).lively && lively.identity && lively.identity.Homestar && window.$world, null, { timeout: 90000 });
    const anonWorlds = await vpage.evaluate(async (h) => (await (await fetch("/@" + h + "/worlds", { credentials: "omit" })).json()).worlds.map((w) => w.name), owner.handle);
    await vpage.waitForTimeout(3000);
    const vtexts = await vpage.evaluate(() => { const out = []; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
    for (const n of ["Notes", "Games", "Workshop"]) expect(vtexts.includes(n)).toBe(anonWorlds.includes(n));   // exactly what the server lets them see
    expect(vtexts).not.toContain("Choose");                                                                    // and no owner controls
  } finally {
    if (visitorCtx) await visitorCtx.close();
    await deleteAccount(owner);
    await owner.context.close();
  }
});
