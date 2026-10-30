// @ts-check
// The old public profile.location, now that the place lives in the badge row (badges.md D1, §8 phases 2 and 6):
//  - the profile card's edit tab no longer has a Location field, and saving the card leaves a stored location alone
//    (so it cannot write a stale value back over what the badge flow cleared);
//  - a location that is still stored is read through as the Place badge on the home page (until the owner has a real one);
//  - clearing it removes the badge;
//  - the leak check: after the owner saves that place as a Friends-only badge, what ANYONE can fetch (the public profile
//    JSON and GET /@handle/badges, signed out) shows no place at all.
// City suggestions now belong to the badge picker and are tested in homestar-badge-picker.spec.js.
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
const storedLocation = () => A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/profile", { credentials: "include", headers: { Accept: "application/json" } })).json()).record.payload.location || "", A.handle);
const setLocation = (/** @type {string} */ loc) => A.page.evaluate(async (l) => {
  await new Promise((r) => lively.require("lively.identity.UserSpace").toRun(r));
  await new Promise((res, rej) => lively.identity.userSpace.saveProfile({ location: l }, (e) => (e ? rej(e) : res(null))));
}, loc);

// Screen centre of the morph (found by name) in the card window.
const nodeCenter = (/** @type {string} */ name) => A.page.evaluate((n) => {
  let hit = null;
  $world.withAllSubmorphsDo((m) => { if (m.name === n) hit = m; });
  if (!hit) return null;
  const r = hit.renderContext().shapeNode.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, name);

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
  await expect.poll(() => nodeCenter("pcPronouns"), { timeout: 20000 }).not.toBeNull();
}

/** Viewport centre of the node with this aria-label (the LAST one: a dialog sits above the page), or null. */
const probe = (/** @type {string} */ aria) => A.page.evaluate((a) => {
  let n = null;
  for (const e of document.querySelectorAll("[aria-label]")) if (e.getAttribute("aria-label") === a) n = e;
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
}, aria);
const click = async (/** @type {string} */ aria) => {
  const p = await probe(aria);
  expect(p, "no node labelled " + aria).not.toBeNull();
  await A.page.mouse.move(p.cx, p.cy, { steps: 4 });
  await A.page.mouse.click(p.cx, p.cy);
};

test("the profile card's edit tab has no Location field, and saving it keeps a stored location", async () => {
  await setLocation("THE A");
  await A.page.goto("/@" + A.handle);
  await shows("Edit profile");
  await openEditTab();
  // the field and its suggestion list are gone; a sibling field is still there
  expect(await nodeCenter("pcLocation")).toBeNull();
  expect(await A.page.evaluate(() => (window.__pcWin.targetMorph.submorphs || []).some((m) => m.textString && /^Location/.test(m.textString)))).toBe(false);
  const c = await nodeCenter("pcPronouns");
  await A.page.mouse.click(c.x, c.y);
  await A.page.keyboard.type("they/them", { delay: 80 });
  await A.page.waitForTimeout(500);
  const save = await A.page.evaluate(() => {
    const btn = window.__pcWin.targetMorph.submorphs.filter((m) => m.label && m.label.textString === "Save")[0];
    const r = btn.renderContext().shapeNode.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await A.page.mouse.click(save.x, save.y);
  await expect.poll(() => A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/profile", { credentials: "include", headers: { Accept: "application/json" } })).json()).record.payload.pronouns, A.handle),
    { timeout: 30000 }).toBe("they/them");
  expect(await storedLocation()).toBe("THE A");           // untouched by the card's Save
});

test("a stored location shows as the Place badge on the home page", async () => {
  await A.page.goto("/@" + A.handle);
  await shows("Edit profile");
  await shows("THE A");

  // the badge is a pink pill (the Place badge) below the name, clear of the Edit profile button
  const geo = await A.page.evaluate((h) => {
    let name = null, badge = null, edit = null;
    $world.withAllSubmorphsDo((m) => {
      if (m.textString === h) name = m;
      const n = m.renderContext && m.renderContext().shapeNode;
      if (n && n.getAttribute && n.getAttribute("data-badge") && n.getAttribute("aria-label") === "THE A") badge = m;
      if (m.textString === "Edit profile") edit = m.owner;
    });
    const r = (m) => m.renderContext().shapeNode.getBoundingClientRect();
    return { name: name && r(name).toJSON(), badge: badge && r(badge).toJSON(), edit: r(edit).toJSON(),
      fill: badge && getComputedStyle(badge.renderContext().shapeNode).backgroundColor };
  }, A.handle);
  expect(geo.badge).not.toBeNull();
  expect(geo.fill).toBe("rgb(251, 228, 238)");
  expect(geo.badge.top).toBeGreaterThan(geo.name.bottom);
  expect(geo.badge.left).toBeLessThanOrEqual(geo.name.left + 1);   // the text column, same left edge as the name
  expect(geo.badge.height).toBeCloseTo(32, 0);
  // the old green pill is gone
  expect((await worldText()).some((t) => t.includes("📍"))).toBe(false);
});

test("clearing the location removes the badge", async () => {
  await setLocation("");
  await A.page.goto("/@" + A.handle);
  await shows("Edit profile");
  expect((await worldText()).some((t) => t.includes("THE A"))).toBe(false);
});

test("saving the old location as a Friends-only place leaves nothing public: the profile JSON and the badge list, signed out", async ({ playwright, baseURL }) => {
  await setLocation("Old Town");
  await A.page.goto("/@" + A.handle);
  await shows("Edit profile");
  await expect.poll(async () => probe("Manage badges"), { timeout: 30000 }).not.toBeNull();
  await A.page.waitForTimeout(700);

  // before: anyone can read the location, both in the profile and as the read-through place badge
  const anon = await playwright.request.newContext({ baseURL: baseURL || undefined, extraHTTPHeaders: { Accept: "application/json" } });
  try {
    const before = await (await anon.get("/@" + A.handle + "/profile")).json();
    expect(before.record.payload.location).toBe("Old Town");
    const beforeBadges = await (await anon.get("/@" + A.handle + "/badges")).json();
    expect(beforeBadges.badges.map((/** @type {any} */ b) => b.label)).toEqual(["Old Town"]);

    // the owner makes it Friends-only in the manage dialog (real clicks), and saves
    await click("Manage badges");
    await expect.poll(() => probe("Cancel"), { timeout: 10000 }).not.toBeNull();
    await A.page.locator('select[data-badge-visibility="_legacy"]').selectOption("friends");
    await click("Save");
    await expect.poll(() => probe("Cancel"), { timeout: 10000 }).toBeNull();
    await expect.poll(() => storedLocation(), { timeout: 30000 }).toBe("");

    // after: signed out, nothing is readable
    const after = await (await anon.get("/@" + A.handle + "/profile")).json();
    expect(after.record.payload.location || "").toBe("");
    expect(JSON.stringify(after)).not.toContain("Old Town");
    const afterBadges = await (await anon.get("/@" + A.handle + "/badges")).json();
    expect(afterBadges.badges).toEqual([]);
    expect(JSON.stringify(afterBadges)).not.toContain("Old Town");
  } finally {
    await anon.dispose();
  }
  // and the owner still has it, as a real badge with its own who-sees choice
  const mine = await A.page.evaluate(async (h) => ((await (await fetch("/@" + h + "/settings", { credentials: "include", headers: { Accept: "application/json" } })).json()).state || {}).badges || [], A.handle);
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ kind: "place", label: "Old Town", visibility: "friends" });
});
