// @ts-check
// The badge row's interaction (HomestarBadges.js, Homestar.js; badges.md §3, §7.1, §8 phase 3) against the REAL
// server and a real signed-in owner: hover lift, the dark tooltip, the owner's outline and remove button, removal
// through the real settings route, the old profile location as a removable place, the "Add badge" pill, the
// "Manage badges" button, and the keyboard (Tab, Enter, Space, Delete). Everything is driven with real mouse and
// keyboard input (page.mouse / page.keyboard), and every claim is judged by its side effect (the stored
// state.badges, the stored profile, a counter bumped by the handler), not by where a click landed.
//
// The picker and the manage dialog do not exist yet (phases 4 and 5), so an init script stands in for them with
// two counters; the "Add badge" pill and "Manage badges" button only appear once such a module exists.
//
// Registers one throwaway `hometest_*` account (and one signed-out visitor context); see account-lifecycle.spec.js
// on pruning the reserved handles.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });
test.setTimeout(150 * 1000);

/** @type {any} */ let A = null;
/** @type {import('@playwright/test').Browser} */ let browserRef;

const place = { id: "plc001", kind: "place", visibility: "anyone", label: "Oakland, CA" };
const metroLine = { id: "trn001", kind: "transit", visibility: "anyone", agency: "Metro", label: "Orange Line", color: "#A85200", textColor: "#FFFFFF" };
const college = { id: "sch001", kind: "school", visibility: "anyone", label: "Hilltop College", color: "#1B2A4A", textColor: "#F4C542" };
const library = { id: "lib001", kind: "library", visibility: "anyone", label: "Oakland Public Library", abbr: "OPL" };

test.beforeAll(async ({ browser }) => {
  test.setTimeout(200 * 1000);
  browserRef = browser;
  A = await newAccount(browser, "hometest_bo" + Math.random().toString(36).slice(2, 6));
  // stand-ins for the picker and the manage dialog: count the calls
  await A.page.addInitScript(() => {
    const t = setInterval(() => {
      if (window.lively && lively.identity) {
        clearInterval(t);
        lively.identity.BadgePicker = { open: (o) => { window.__picker = (window.__picker || 0) + 1; window.__pickerBadges = (o.badges || []).length; } };
        lively.identity.BadgesDialog = { open: () => { window.__manage = (window.__manage || 0) + 1; } };
      }
    }, 2);
  });
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (A) await A.context.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Stores state.badges (and optionally profile.location) for the owner, through the real routes. */
const seed = async (/** @type {any[]} */ list, /** @type {string} */ location = "") => {
  await A.page.evaluate(async ([l, loc]) => {
    await new Promise((r) => lively.require("lively.identity.UserSpace", "lively.identity.PostcardAudience").toRun(r));
    await new Promise((res, rej) => lively.identity.postcardAudience.patchSettings((st) => { st.badges = l; }, (e) => (e ? rej(e) : res(null))));
    await new Promise((res, rej) => lively.identity.userSpace.saveProfile({ location: loc }, (e) => (e ? rej(e) : res(null))));
  }, [list, location]);
};
const storedBadges = () => A.page.evaluate(async (h) => ((await (await fetch("/@" + h + "/settings", { credentials: "include", headers: { Accept: "application/json" } })).json()).state || {}).badges || [], A.handle);
const storedLocation = () => A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/profile", { credentials: "include", headers: { Accept: "application/json" } })).json()).record.payload.location || "", A.handle);

/** Opens the owner's homestar and waits for `n` badge nodes (not counting the Add pill). */
const open = async (/** @type {any} */ page, /** @type {number} */ n) => {
  await page.goto("/@" + A.handle);
  await expect.poll(() => count(page), { timeout: 30000 }).toBe(n);
  await page.waitForTimeout(700);   // lets the page font finish and the row redraw
};
const count = (/** @type {any} */ page) => page.evaluate(() => {
  let n = 0;
  if (typeof $world === "undefined" || !$world) return -1;
  $world.withAllSubmorphsDo((m) => { const x = m.renderContext && m.renderContext().shapeNode; if (x && x.getAttribute && x.getAttribute("data-badge") && x.getAttribute("data-badge") !== "add") n++; });
  return n;
});

/** Viewport rect and live style of the node with this aria-label (or null). */
const probe = (/** @type {any} */ page, /** @type {string} */ aria) => page.evaluate((a) => {
  const nodes = document.querySelectorAll("[aria-label]");
  let n = null;
  for (const e of nodes) if (e.getAttribute("aria-label") === a) n = e;
  if (!n) return null;
  const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2,
    outline: cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor, outlineOffset: cs.outlineOffset, transform: cs.transform === "none" ? "matrix(1, 0, 0, 1, 0, 0)" : cs.transform, shadow: cs.boxShadow,
    tabindex: n.getAttribute("tabindex"), role: n.getAttribute("role"), focused: document.activeElement === n, bg: cs.backgroundColor, cursor: cs.cursor };
}, aria);

const tooltip = (/** @type {any} */ page) => page.evaluate(() => {
  const t = document.querySelector('[role="tooltip"]');
  if (!t) return null;
  const r = t.getBoundingClientRect(), cs = getComputedStyle(t);
  return { text: [...t.querySelectorAll("span")].map((s) => s.textContent), bg: cs.backgroundColor, color: getComputedStyle(t.querySelector("span")).color, l: r.left, t: r.top, r: r.right, b: r.bottom, pe: cs.pointerEvents };
});

const mouseTo = async (/** @type {any} */ page, /** @type {number} */ x, /** @type {number} */ y) => { await page.mouse.move(x, y, { steps: 6 }); };
const hover = async (/** @type {any} */ page, /** @type {string} */ aria) => { const p = await probe(page, aria); await mouseTo(page, p.cx, p.cy); return p; };
const away = (/** @type {any} */ page) => mouseTo(page, 700, 20);
const activeName = (/** @type {any} */ page) => page.evaluate(() => { const e = document.activeElement; return e && e.getAttribute ? (e.getAttribute("aria-label") || "(" + e.tagName + ")") : null; });

// ── tests ────────────────────────────────────────────────────────────────────

test("owner: hovering a badge lifts and outlines it, shows its name and a remove button; leaving clears all", async () => {
  await seed([place, metroLine, college]);
  await open(A.page, 3);
  const rest = await probe(A.page, "Metro Orange Line");
  expect(rest.outline).toMatch(/^none /);
  expect(rest.transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
  expect(await probe(A.page, "Remove Metro Orange Line")).toBeNull();
  expect(await tooltip(A.page)).toBeNull();

  await hover(A.page, "Metro Orange Line");
  await expect.poll(async () => (await probe(A.page, "Remove Metro Orange Line")) !== null, { timeout: 5000 }).toBe(true);
  const b = await probe(A.page, "Metro Orange Line");
  expect(b.outline).toBe("solid 2px rgb(194, 68, 127)");
  expect(b.outlineOffset).toBe("3px");
  await expect.poll(async () => (await probe(A.page, "Metro Orange Line")).transform, { timeout: 3000 }).toBe("matrix(1, 0, 0, 1, 0, -1)");
  await expect.poll(async () => (await probe(A.page, "Metro Orange Line")).shadow, { timeout: 3000 }).toContain("rgba(36, 31, 44, 0.25)");   // after its transition

  // the remove button: 24px, 10px above and 8px past the badge's top-right corner (the badge is lifted 1px)
  const x = await probe(A.page, "Remove Metro Orange Line");
  expect(Math.round(x.w)).toBe(24);
  expect(Math.round(x.h)).toBe(24);
  expect(Math.abs(x.r - (rest.r + 8))).toBeLessThanOrEqual(1.5);
  expect(Math.abs(x.t - (rest.t - 10))).toBeLessThanOrEqual(1.5);
  expect(x.bg).toBe("rgb(255, 255, 255)");
  expect(x.cursor).toBe("pointer");

  // the dark tooltip after its delay, above the badge, not in the way of the mouse
  await expect.poll(() => tooltip(A.page), { timeout: 5000 }).not.toBeNull();
  const tip = await tooltip(A.page);
  expect(tip.text).toEqual(["Metro Orange Line"]);
  expect(tip.bg).toBe("rgb(36, 31, 44)");
  expect(tip.color).toBe("rgb(255, 255, 255)");
  expect(tip.b).toBeLessThan(rest.t);
  expect(tip.pe).toBe("none");

  await away(A.page);
  await expect.poll(async () => ({ x: await probe(A.page, "Remove Metro Orange Line"), tip: await tooltip(A.page), b: (await probe(A.page, "Metro Orange Line")) }), { timeout: 5000 })
    .toMatchObject({ x: null, tip: null, b: { transform: "matrix(1, 0, 0, 1, 0, 0)" } });
  expect((await probe(A.page, "Metro Orange Line")).outline).toMatch(/^none /);
});

test("moving from a badge onto its remove button keeps both (the gap is bridged)", async () => {
  await hover(A.page, "Hilltop College");
  await expect.poll(async () => (await probe(A.page, "Remove Hilltop College")) !== null, { timeout: 5000 }).toBe(true);
  const x = await probe(A.page, "Remove Hilltop College");
  await mouseTo(A.page, x.cx, x.cy);
  await A.page.waitForTimeout(400);                   // well past the 120ms grace
  expect(await probe(A.page, "Remove Hilltop College")).not.toBeNull();
  expect((await probe(A.page, "Hilltop College")).outline).toBe("solid 2px rgb(194, 68, 127)");
  await away(A.page);
});

test("clicking the remove button stores the removal (real click, judged by the saved settings)", async () => {
  await hover(A.page, "Metro Orange Line");
  await expect.poll(async () => (await probe(A.page, "Remove Metro Orange Line")) !== null, { timeout: 5000 }).toBe(true);
  const x = await probe(A.page, "Remove Metro Orange Line");
  await mouseTo(A.page, x.cx, x.cy);
  await A.page.mouse.down();
  await A.page.mouse.up();
  await expect.poll(async () => (await storedBadges()).map((b) => b.id), { timeout: 30000 }).toEqual(["plc001", "sch001"]);
  await expect.poll(() => count(A.page), { timeout: 30000 }).toBe(2);
  expect(await probe(A.page, "Metro Orange Line")).toBeNull();
  expect(await probe(A.page, "Remove Metro Orange Line")).toBeNull();
  expect(await tooltip(A.page)).toBeNull();
});

test("the old public profile location is a place the owner can remove (clears profile.location)", async () => {
  await seed([metroLine], "Old Town");
  await open(A.page, 2);
  expect(await probe(A.page, "Old Town")).not.toBeNull();            // the synthetic place
  await hover(A.page, "Old Town");
  await expect.poll(async () => (await probe(A.page, "Remove Old Town")) !== null, { timeout: 5000 }).toBe(true);
  const x = await probe(A.page, "Remove Old Town");
  await mouseTo(A.page, x.cx, x.cy);
  await A.page.mouse.down();
  await A.page.mouse.up();
  await expect.poll(storedLocation, { timeout: 30000 }).toBe("");
  await expect.poll(() => count(A.page), { timeout: 30000 }).toBe(1);
  expect((await storedBadges()).map((b) => b.id)).toEqual(["trn001"]);   // the real badges were not touched
  // signed out, nothing resurrects it
  const anon = await A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/badges", { credentials: "omit", headers: { Accept: "application/json" } })).json()).badges.map((b) => b.id), A.handle);
  expect(anon).toEqual(["trn001"]);
});

test("removing a real place also clears a leftover profile.location, so the old value cannot come back", async () => {
  await seed([place, metroLine], "Old Town");
  await open(A.page, 2);                                              // the real place wins over the old value
  expect(await probe(A.page, "Old Town")).toBeNull();
  await hover(A.page, "Oakland, CA");
  await expect.poll(async () => (await probe(A.page, "Remove Oakland, CA")) !== null, { timeout: 5000 }).toBe(true);
  const x = await probe(A.page, "Remove Oakland, CA");
  await mouseTo(A.page, x.cx, x.cy);
  await A.page.mouse.down();
  await A.page.mouse.up();
  await expect.poll(async () => (await storedBadges()).map((b) => b.id), { timeout: 30000 }).toEqual(["trn001"]);
  await expect.poll(storedLocation, { timeout: 30000 }).toBe("");
  await expect.poll(() => count(A.page), { timeout: 30000 }).toBe(1);   // no "Old Town" place came back
  expect(await probe(A.page, "Old Town")).toBeNull();
});

test("a re-render while hovering strands nothing: one tooltip at most, and none once the pointer leaves", async () => {
  await seed([place, metroLine, college]);
  await open(A.page, 3);
  await hover(A.page, "Hilltop College");
  await expect.poll(() => tooltip(A.page), { timeout: 5000 }).not.toBeNull();
  // a window resize re-renders the page (debounced), rebuilding every morph under the resting pointer
  await A.page.setViewportSize({ width: 1499, height: 1000 });
  await A.page.waitForTimeout(900);
  const nodes = () => A.page.evaluate(() => ({ tips: document.querySelectorAll('[role="tooltip"]').length, xs: [...document.querySelectorAll("[aria-label]")].filter((e) => /^Remove /.test(e.getAttribute("aria-label"))).length }));
  const n = await nodes();
  expect(n.tips).toBeLessThanOrEqual(1);          // the pointer is still on the rebuilt badge, so a fresh one may show: never two
  expect(n.xs).toBeLessThanOrEqual(1);
  await away(A.page);
  await expect.poll(nodes, { timeout: 5000 }).toEqual({ tips: 0, xs: 0 });
  expect((await probe(A.page, "Hilltop College")).outline).toMatch(/^none /);
  await A.page.setViewportSize({ width: 1500, height: 1000 });
  await A.page.waitForTimeout(600);
});

test("the Add badge pill ends the row and opens the picker; Manage badges sits top-right and opens the dialog", async () => {
  await A.page.evaluate(() => { window.__picker = 0; window.__manage = 0; });
  const add = await probe(A.page, "Add badge");
  expect(add).not.toBeNull();
  expect(Math.round(add.h)).toBe(32);
  const last = await probe(A.page, "Hilltop College");
  expect(add.l).toBeGreaterThan(last.r);                              // after the last badge, on the same row
  expect(Math.abs(add.cy - last.cy)).toBeLessThanOrEqual(1);
  // dashed outline, pink on hover
  const border = () => A.page.evaluate(() => { const n = [...document.querySelectorAll("[aria-label]")].find((e) => e.getAttribute("aria-label") === "Add badge"); const cs = getComputedStyle(n); return { style: cs.borderTopStyle, color: cs.borderTopColor, ink: getComputedStyle(n.querySelector("span:last-of-type")).color, bg: cs.backgroundColor }; });
  expect(await border()).toMatchObject({ style: "dashed", color: "rgb(201, 191, 207)", ink: "rgb(114, 107, 122)", bg: "rgb(255, 255, 255)" });
  await mouseTo(A.page, add.cx, add.cy);
  await expect.poll(border, { timeout: 3000 }).toMatchObject({ color: "rgb(194, 68, 127)", ink: "rgb(194, 68, 127)" });
  await A.page.mouse.down(); await A.page.mouse.up();
  await expect.poll(() => A.page.evaluate(() => window.__picker), { timeout: 5000 }).toBe(1);
  expect(await A.page.evaluate(() => window.__pickerBadges)).toBe(3);   // the picker is handed the current badges
  await away(A.page);
  await expect.poll(border, { timeout: 3000 }).toMatchObject({ color: "rgb(201, 191, 207)", ink: "rgb(114, 107, 122)" });

  const mg = await probe(A.page, "Manage badges");
  expect(mg).not.toBeNull();
  expect(Math.round(mg.h)).toBe(44);
  const hero = await A.page.evaluate(() => { let r = null; $world.withAllSubmorphsDo((m) => { if (m.textString === "Edit profile") r = m.owner.owner.renderContext().shapeNode.getBoundingClientRect().toJSON(); }); return r; });
  expect(Math.abs(mg.r - (hero.right - 24))).toBeLessThanOrEqual(1.5);
  expect(Math.abs(mg.t - (hero.top + 20))).toBeLessThanOrEqual(1.5);
  await mouseTo(A.page, mg.cx, mg.cy);
  await A.page.mouse.down(); await A.page.mouse.up();
  await expect.poll(() => A.page.evaluate(() => window.__manage), { timeout: 5000 }).toBe(1);
  await away(A.page);
});

test("an owner with no badges still gets the Add badge pill", async () => {
  await seed([]);
  await A.page.goto("/@" + A.handle);
  await expect.poll(async () => (await probe(A.page, "Add badge")) !== null, { timeout: 30000 }).toBe(true);
  expect(await count(A.page)).toBe(0);
  await seed([place, metroLine, college]);
});

test("keyboard: Tab walks every badge, its remove button and Add badge; Enter, Space and Delete act", async () => {
  await open(A.page, 3);
  await A.page.evaluate(() => { window.__picker = 0; window.__manage = 0; const n = [...document.querySelectorAll("[aria-label]")].find((e) => e.getAttribute("aria-label") === "Manage badges"); n.focus(); });
  expect(await activeName(A.page)).toBe("Manage badges");
  expect((await probe(A.page, "Manage badges")).outline).toBe("solid 2px rgb(194, 68, 127)");

  // Enter on Manage badges
  await A.page.keyboard.press("Enter");
  await expect.poll(() => A.page.evaluate(() => window.__manage), { timeout: 5000 }).toBe(1);

  const seen = [];
  for (let i = 0; i < 7; i++) {
    await A.page.keyboard.press("Tab");
    await A.page.waitForTimeout(150);
    seen.push(await activeName(A.page));
  }
  expect(seen).toEqual(["Oakland, CA", "Remove Oakland, CA", "Metro Orange Line", "Remove Metro Orange Line", "Hilltop College", "Remove Hilltop College", "Add badge"]);
  // back from "Add badge" (focus is on it after the 7th Tab): each remove button is visited before its badge
  await A.page.keyboard.press("Shift+Tab");
  await A.page.waitForTimeout(150);
  expect(await activeName(A.page)).toBe("Remove Hilltop College");
  await A.page.keyboard.press("Shift+Tab");
  await A.page.waitForTimeout(200);
  expect(await activeName(A.page)).toBe("Hilltop College");
  // a focused badge is outlined and has its remove button (and a tooltip), like a hovered one
  expect((await probe(A.page, "Hilltop College")).outline).toBe("solid 2px rgb(194, 68, 127)");
  expect(await probe(A.page, "Remove Hilltop College")).not.toBeNull();
  await expect.poll(() => tooltip(A.page), { timeout: 3000 }).not.toBeNull();

  // Space on Add badge opens the picker
  await A.page.keyboard.press("Tab"); await A.page.keyboard.press("Tab");
  expect(await activeName(A.page)).toBe("Add badge");
  await A.page.keyboard.press(" ");
  await expect.poll(() => A.page.evaluate(() => window.__picker), { timeout: 5000 }).toBe(1);

  // Enter on a remove button removes that badge (judged by the saved settings)
  await A.page.keyboard.press("Shift+Tab");               // the remove button of Hilltop College
  expect(await activeName(A.page)).toBe("Remove Hilltop College");
  await A.page.keyboard.press("Enter");
  await expect.poll(async () => (await storedBadges()).map((b) => b.id), { timeout: 30000 }).toEqual(["plc001", "trn001"]);
  await expect.poll(() => count(A.page), { timeout: 30000 }).toBe(2);

  // Delete on a focused badge removes it too
  await A.page.evaluate(() => { const n = [...document.querySelectorAll("[aria-label]")].find((e) => e.getAttribute("aria-label") === "Metro Orange Line"); n.focus(); });
  expect(await activeName(A.page)).toBe("Metro Orange Line");
  await A.page.keyboard.press("Delete");
  await expect.poll(async () => (await storedBadges()).map((b) => b.id), { timeout: 30000 }).toEqual(["plc001"]);
});

test("a visitor: hover lifts the badge and shows its name, with no outline, remove button, focus, Add or Manage", async () => {
  await seed([place, metroLine, library, college]);
  const ctx = await browserRef.newContext({ viewport: { width: 1500, height: 1000 } });
  const v = await ctx.newPage();
  try {
    await v.goto("/@" + A.handle);
    await expect.poll(() => count(v), { timeout: 60000 }).toBe(4);
    await v.waitForTimeout(700);
    const rest = await probe(v, "Metro Orange Line");
    expect(rest.tabindex).toBeNull();                                  // not focusable: it is information, not a control
    expect(rest.role).toBe("img");
    expect(await probe(v, "Add badge")).toBeNull();
    expect(await probe(v, "Manage badges")).toBeNull();

    await hover(v, "Metro Orange Line");
    await expect.poll(async () => (await probe(v, "Metro Orange Line")).transform, { timeout: 3000 }).toBe("matrix(1, 0, 0, 1, 0, -1)");
    await expect.poll(() => tooltip(v), { timeout: 5000 }).not.toBeNull();
    expect((await tooltip(v)).text).toEqual(["Metro Orange Line"]);
    expect((await probe(v, "Metro Orange Line")).outline).toMatch(/^none /);
    expect(await probe(v, "Remove Metro Orange Line")).toBeNull();

    // the stamp spells out its full name only here
    await hover(v, "Oakland Public Library");
    await expect.poll(async () => (await tooltip(v) || { text: [] }).text, { timeout: 5000 }).toEqual(["Oakland Public Library"]);
    await mouseTo(v, 700, 20);
    await expect.poll(() => tooltip(v), { timeout: 5000 }).toBeNull();
  } finally {
    await ctx.close();
  }
});

test("a '+N more' chip's tooltip lists the folded names, one per line", async () => {
  const many = [place, metroLine, college, library];
  for (let i = 0; i < 5; i++) many.push({ ...college, id: "scx" + (100 + i), label: "School " + i });
  await seed(many);
  await open(A.page, 6);
  const chip = await probe(A.page, "School 1, School 2, School 3, School 4");
  expect(chip).not.toBeNull();
  await mouseTo(A.page, chip.cx, chip.cy);
  await expect.poll(() => tooltip(A.page), { timeout: 5000 }).not.toBeNull();
  expect((await tooltip(A.page)).text).toEqual(["School 1", "School 2", "School 3", "School 4"]);   // five are shown; these four are folded
  // the chip is not removable: no remove button
  expect(await probe(A.page, "Remove School 1, School 2, School 3, School 4")).toBeNull();
  await away(A.page);
  await seed([]);
});
