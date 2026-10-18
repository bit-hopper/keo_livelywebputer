// @ts-check
// The location pill in the homestar's header (Homestar.js, locationPill) and the Location field in the
// profile card's edit tab (ProfileCard.js, locationPicker): typing offers cities from the birth-chart
// calculator's offline list, picking one fills the field, anything else typed is kept as-is, Save writes
// profile.location, and the home page then shows a pin pill beside the name.
//
// Registers one throwaway `hometest_*` account; see account-lifecycle.spec.js on pruning the reserved handles.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });
test.setTimeout(120 * 1000);

/** @type {any} */ let A = null;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(200 * 1000);
  A = await newAccount(browser, "hometest_loc" + Math.random().toString(36).slice(2, 6));
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (A) await A.context.close();
});

const worldText = () => A.page.evaluate(() => { const out = []; if (typeof $world === "undefined" || !$world) return out; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
const shows = (/** @type {string} */ s) => expect.poll(async () => (await worldText()).includes(s), { timeout: 30000 }).toBe(true);

// Lively reads a text morph on keyup and gets "" when keys arrive with no gap, so type at human speed.
// Screen centre of the morph (found by name, or by exact text) in the card window.
const nodeCenter = (/** @type {any} */ find) => A.page.evaluate((f) => {
  let hit = null;
  $world.withAllSubmorphsDo((m) => {
    if (f.name ? m.name === f.name : (m.textString === f.text && m.owner && m.owner.name !== "pcLocation")) hit = m;
  });
  if (!hit) return null;
  const r = hit.renderContext().shapeNode.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, find);

async function openEditTab() {
  await A.page.evaluate(async (h) => {
    await new Promise((r) => lively.require("lively.identity.ProfileCard").toRun(r));
    const win = lively.identity.ProfileCard.open(h);
    window.__pcWin = win;
    await new Promise((res, rej) => {
      let n = 0;
      const t = setInterval(() => {
        if (win._envelope) { clearInterval(t); res(null); }
        else if (++n > 200) { clearInterval(t); rej(new Error("profile never loaded")); }
      }, 100);
    });
    win._renderEdit(win._handle, (win._envelope.record && win._envelope.record.payload) || {}, win._currentDid);
  }, A.handle);
  await expect.poll(() => nodeCenter({ name: "pcLocation" }), { timeout: 20000 }).not.toBeNull();
}

test("typing a city offers matches, picking one fills the field", async () => {
  await A.page.goto("/@" + A.handle);
  await shows("Edit profile");
  await openEditTab();

  const c = await nodeCenter({ name: "pcLocation" });
  await A.page.mouse.click(c.x, c.y);
  await A.page.keyboard.type("oakla", { delay: 80 });
  await expect.poll(() => nodeCenter({ name: "pcLocationSuggest" }), { timeout: 30000 }).not.toBeNull();

  const rows = await A.page.evaluate(() => {
    const box = $world.withAllSubmorphsDo ? (() => { let b = null; $world.withAllSubmorphsDo((m) => { if (m.name === "pcLocationSuggest") b = m; }); return b; })() : null;
    return box.submorphs.map((m) => m.textString);
  });
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].toLowerCase()).toContain("oakland");

  const row = await A.page.evaluate(() => {
    let b = null; $world.withAllSubmorphsDo((m) => { if (m.name === "pcLocationSuggest") b = m; });
    const r = b.submorphs[0].renderContext().shapeNode.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await A.page.mouse.click(row.x, row.y);
  await expect.poll(() => A.page.evaluate(() => { let t = null; $world.withAllSubmorphsDo((m) => { if (m.name === "pcLocation") t = m.textString; }); return t; })).toBe("Oakland");
  expect(await nodeCenter({ name: "pcLocationSuggest" })).toBeNull();
});

test("a custom place is kept, saved, and shown as a pin pill beside the name", async () => {
  // replace the picked city with a made-up place
  const c = await nodeCenter({ name: "pcLocation" });
  await A.page.mouse.click(c.x, c.y);
  await A.page.keyboard.press("Control+A");
  await A.page.keyboard.type("THE A", { delay: 80 });
  await A.page.waitForTimeout(500);

  const save = await A.page.evaluate(() => {
    const btn = window.__pcWin.targetMorph.submorphs.filter((m) => m.label && m.label.textString === "Save")[0];
    const r = btn.renderContext().shapeNode.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await A.page.mouse.click(save.x, save.y);
  await expect.poll(() => A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/profile", { credentials: "include" })).json()).record.payload.location, A.handle),
    { timeout: 30000 }).toBe("THE A");

  await A.page.goto("/@" + A.handle);
  await shows("Edit profile");
  await shows("📍 THE A");

  // the pin pill sits on the name row, to the right of the name and clear of the Edit profile button
  const geo = await A.page.evaluate((h) => {
    let name = null, pill = null, edit = null;
    $world.withAllSubmorphsDo((m) => {
      if (m.textString === h) name = m;
      if (m.textString === "📍 THE A") pill = m.owner;
      if (m.textString === "Edit profile") edit = m.owner;
    });
    const r = (m) => m.renderContext().shapeNode.getBoundingClientRect();
    const hasPin = pill.submorphs.some((s) => s.textString === "📍 THE A") && /rgb\(18, 128, 70\)/.test(pill.renderContext().shapeNode.style.background || getComputedStyle(pill.renderContext().shapeNode).backgroundColor);
    return { name: name && r(name).toJSON(), pill: r(pill).toJSON(), edit: r(edit).toJSON(), hasPin };
  }, A.handle);
  expect(geo.hasPin).toBe(true);
  expect(geo.pill.left).toBeGreaterThan(geo.name.left);
  expect(geo.pill.right).toBeLessThan(geo.edit.left);
  expect(geo.pill.top).toBeGreaterThanOrEqual(geo.name.top - 1);
  expect(geo.pill.bottom).toBeLessThanOrEqual(geo.name.bottom + 1);
});

test("clearing the field removes the pill", async () => {
  await A.page.evaluate(async () => {
    await new Promise((r) => lively.require("lively.identity.UserSpace").toRun(r));
    await new Promise((res, rej) => lively.identity.userSpace.saveProfile({ location: "" }, (e) => e ? rej(e) : res(null)));
  });
  await A.page.goto("/@" + A.handle);
  await shows("Edit profile");
  expect((await worldText()).some((t) => t.includes("THE A"))).toBe(false);
});
