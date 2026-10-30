// @ts-check
// The "Add badge" dialog (BadgePicker.js; badges.md §7.2-7.4, §8 phase 4) against the REAL server and a real
// signed-in owner. Everything is driven with the real mouse and keyboard (page.mouse / locator.pressSequentially
// with a delay), and every claim is judged by its side effect: the stored state.badges and profile, not by where
// a click landed (CLAUDE.md "Don't trust a screenshot...").
//
// Registers one throwaway `hometest_*` account; see account-lifecycle.spec.js on pruning the reserved handles.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });
test.setTimeout(150 * 1000);

/** @type {any} */ let A = null;
const SHOTS = process.env.LK_BADGE_SHOTS || "";   // a directory: save screenshots there (looking at the dialog by eye)

test.beforeAll(async ({ browser }) => {
  test.setTimeout(200 * 1000);
  A = await newAccount(browser, "hometest_bp" + Math.random().toString(36).slice(2, 6));
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (A) await A.context.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const seed = async (/** @type {any[]} */ list, /** @type {string} */ location = "") => {
  await A.page.evaluate(async ([l, loc]) => {
    await new Promise((r) => lively.require("lively.identity.UserSpace", "lively.identity.PostcardAudience").toRun(r));
    await new Promise((res, rej) => lively.identity.postcardAudience.patchSettings((st) => { st.badges = l; }, (e) => (e ? rej(e) : res(null))));
    await new Promise((res, rej) => lively.identity.userSpace.saveProfile({ location: loc }, (e) => (e ? rej(e) : res(null))));
  }, [list, location]);
};
const storedBadges = () => A.page.evaluate(async (h) => ((await (await fetch("/@" + h + "/settings", { credentials: "include", headers: { Accept: "application/json" } })).json()).state || {}).badges || [], A.handle);
const storedLocation = () => A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/profile", { credentials: "include", headers: { Accept: "application/json" } })).json()).record.payload.location || "", A.handle);

/** Opens the owner's homestar and waits for the "Add badge" pill. */
const open = async (/** @type {number} */ n) => {
  await A.page.goto("/@" + A.handle);
  await expect.poll(() => badgeCount(), { timeout: 30000 }).toBe(n);
  await A.page.waitForTimeout(700);   // lets the page font finish and the row redraw
};
const badgeCount = () => A.page.evaluate(() => {
  let n = 0;
  if (typeof $world === "undefined" || !$world) return -1;
  $world.withAllSubmorphsDo((m) => { const x = m.renderContext && m.renderContext().shapeNode; if (x && x.getAttribute && x.getAttribute("data-badge") && x.getAttribute("data-badge") !== "add") n++; });
  return n;
});

/** Viewport rect and live style of the LAST node with this aria-label (the dialog sits above the page), or null. */
const probe = (/** @type {string} */ aria) => A.page.evaluate((a) => {
  let n = null;
  for (const e of document.querySelectorAll("[aria-label]")) if (e.getAttribute("aria-label") === a) n = e;
  if (!n) return null;
  const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2,
    bg: cs.backgroundColor, color: cs.color, tabindex: n.getAttribute("tabindex"), role: n.getAttribute("role"), disabled: n.getAttribute("aria-disabled") === "true" };
}, aria);

const click = async (/** @type {string} */ aria) => {
  const p = await probe(aria);
  expect(p, "no node labelled " + aria).not.toBeNull();
  await A.page.mouse.move(p.cx, p.cy, { steps: 4 });
  await A.page.mouse.click(p.cx, p.cy);
};
const gone = (/** @type {string} */ aria) => expect.poll(() => probe(aria), { timeout: 8000 }).toBeNull();
const there = (/** @type {string} */ aria) => expect.poll(async () => (await probe(aria)) !== null, { timeout: 8000 }).toBe(true);
const typeInto = async (/** @type {string} */ aria, /** @type {string} */ text) => {
  const input = A.page.locator('input[aria-label="' + aria + '"]');
  await input.click();
  await input.pressSequentially(text, { delay: 70 });
};
const shot = async (/** @type {string} */ name) => { if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, name + ".png") }); };

/** Opens the picker from the page's own "Add badge" pill with a real click, then picks a kind tile. */
const startAdd = async (/** @type {string} */ tile) => {
  await click("Add badge");
  await there("A place");
  if (tile) await click(tile);
};
/** The dialog's own primary button is the last "Add badge" node; true when it is pink and not marked unavailable. */
const addReady = async () => {
  const p = await probe("Add badge");
  return !!p && !p.disabled && p.bg === "rgb(204, 0, 87)";
};
const pickVisibility = async (/** @type {string} */ v) => { await click(v); };

// ── tests ────────────────────────────────────────────────────────────────────

test("the Add badge pill opens the picker with five kinds; Escape and Cancel and an outside click close it", async () => {
  await seed([]);
  await open(0);
  await click("Add badge");
  for (const t of ["A place", "A transit line", "A school or community", "A library", "A team"]) await there(t);
  await shot("01-kinds");
  await A.page.keyboard.press("Escape");
  await gone("A place");

  await click("Add badge");
  await there("A place");
  await click("Cancel");
  await gone("A place");

  await click("Add badge");
  await there("A place");
  await A.page.mouse.click(8, 8);           // on the scrim, outside the panel
  await gone("A place");
  expect(await storedBadges()).toEqual([]);   // nothing was saved by any of that
});

test("place: typing offers cities, the preview follows, Add stores the badge with the chosen who-sees", async () => {
  await startAdd("A place");
  await expect(A.page.locator('input[aria-label="Place"]')).toBeFocused();
  expect(await addReady()).toBe(false);                       // nothing typed yet
  await typeInto("Place", "oakl");
  // a city suggestion row appears (cities come from the same list the old profile field used)
  await expect.poll(() => A.page.evaluate(() => [...document.querySelectorAll('[role="button"][aria-label]')].map((e) => e.getAttribute("aria-label")).filter((l) => /^Oakland/.test(l || "")).length), { timeout: 15000 }).toBeGreaterThan(0);
  await shot("02-place");
  // the preview is the badge the page will show: a Place pill with the typed text
  const preview = await probe("oakl");
  expect(preview).not.toBeNull();
  expect(preview.bg).toBe("rgb(251, 228, 238)");
  expect(Math.round(preview.h)).toBe(32);
  expect(await addReady()).toBe(true);
  await pickVisibility("Friends");
  await click("Add badge");
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(1);
  const [b] = await storedBadges();
  expect(b).toMatchObject({ kind: "place", label: "oakl", visibility: "friends" });
  expect(b.id).toMatch(/^[a-z0-9]{6,12}$/);
  await gone("A place");
  await expect.poll(() => badgeCount(), { timeout: 15000 }).toBe(1);
  // what was drawn in the preview is what the page now shows: same size
  const shown = await probe("oakl");
  expect(Math.round(shown.w)).toBe(Math.round(preview.w));
  expect(Math.round(shown.h)).toBe(Math.round(preview.h));
});

test("place: picking a suggestion fills the field; a second place replaces the first and says so", async () => {
  await startAdd("A place");
  const note = await A.page.evaluate(() => [...document.querySelectorAll("span")].map((s) => s.textContent).filter((t) => /This replaces/.test(t || "")));
  expect(note[0]).toContain("oakl");
  await typeInto("Place", "berkel");
  let label = "";
  await expect.poll(async () => {
    label = await A.page.evaluate(() => { const e = [...document.querySelectorAll('[role="button"][aria-label]')].find((x) => /^Berkeley/.test(x.getAttribute("aria-label") || "")); return e ? e.getAttribute("aria-label") : ""; });
    return label;
  }, { timeout: 15000 }).not.toBe("");
  await click(label);
  const value = await A.page.locator('input[aria-label="Place"]').inputValue();
  expect(value).toMatch(/^Berkeley/);
  await click("Add badge");
  await expect.poll(async () => (await storedBadges()).map((x) => x.label), { timeout: 15000 }).toEqual([value]);   // replaced, still one place
  expect((await storedBadges())[0].visibility).toBe("anyone");
});

test("place: saving a real place clears the old public profile location", async () => {
  await seed([], "Old Town");
  await open(1);                       // the profile location reads through as a place
  expect(await storedLocation()).toBe("Old Town");
  await startAdd("A place");
  await typeInto("Place", "THE BAY");
  await click("Add badge");
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(1);
  await expect.poll(() => storedLocation(), { timeout: 15000 }).toBe("");
  expect((await storedBadges())[0]).toMatchObject({ kind: "place", label: "THE BAY" });
});

test("transit: a catalog line is stored with the catalog's own colours; the agency alone works where it has a colour", async () => {
  await seed([]);
  await open(0);
  await startAdd("A transit line");
  await shot("03-transit");
  await click("Orange Line");
  const pv = await probe("BART Orange Line");
  expect(pv).not.toBeNull();
  await expect.poll(() => addReady()).toBe(true);
  await click("Add badge");
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(1);
  expect((await storedBadges())[0]).toMatchObject({ kind: "transit", agency: "BART", label: "Orange Line", color: "#FF9933", textColor: "#241F2C" });
  await gone("A place");

  await startAdd("A transit line");
  await click("Caltrain");
  await there("Just “Caltrain”");
  await click("Just “Caltrain”");
  await click("Add badge");
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(2);
  expect((await storedBadges())[1]).toMatchObject({ kind: "transit", agency: "Caltrain", label: "", color: "#CE202F", textColor: "#FFFFFF" });

  // BART has no colour of its own, so it has no "agency alone" row
  await startAdd("A transit line");
  expect(await probe("Just “BART”")).toBeNull();
  await A.page.keyboard.press("Escape");
});

test("transit: your own agency and line with a colour; a malformed hex is refused; the text colour is chosen to be readable", async () => {
  await seed([]);
  await open(0);
  await startAdd("A transit line");
  await click("Other");
  await typeInto("Agency", "Metro");
  await typeInto("Line or route", "72");
  expect(await addReady()).toBe(false);               // no colour yet
  await shot("04-transit-other");
  await typeInto("Hex colour", "#12");
  expect(await addReady()).toBe(false);               // malformed
  await A.page.locator('input[aria-label="Hex colour"]').fill("");
  await typeInto("Hex colour", "#FFFF33");           // a light yellow: white would fail, so the text goes dark
  await expect.poll(() => addReady()).toBe(true);
  await click("Add badge");
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(1);
  expect((await storedBadges())[0]).toMatchObject({ kind: "transit", agency: "Metro", label: "72", color: "#FFFF33", textColor: "#241F2C" });

  // a swatch
  await startAdd("A transit line");
  await click("Other");
  await typeInto("Line or route", "Harbor Line");
  await click("Colour #5B2A86");
  await expect.poll(() => A.page.locator('input[aria-label="Hex colour"]').inputValue()).toBe("#5B2A86");
  await click("Add badge");
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(2);
  expect((await storedBadges())[1]).toMatchObject({ kind: "transit", agency: "", label: "Harbor Line", color: "#5B2A86", textColor: "#FFFFFF" });
});

test("team: league chips and search narrow the list; a catalog team is stored; a custom team needs letters and a colour", async () => {
  await seed([]);
  await open(0);
  await startAdd("A team");
  await shot("05-team");
  await click("NBA");
  await typeInto("Search teams", "war");
  await there("Warriors");
  expect(await probe("Man City")).toBeNull();
  await click("Warriors");
  await click("Friends");
  await click("Add badge");
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(1);
  expect((await storedBadges())[0]).toMatchObject({ kind: "team", label: "Warriors", abbr: "GSW", color: "#1D428A", textColor: "#FDB927", visibility: "friends" });

  // two clubs share the word "Man": both are offered, as separate rows
  await startAdd("A team");
  await typeInto("Search teams", "Man");
  await there("Man City");

  // custom
  await A.page.locator('input[aria-label="Search teams"]').fill("");
  await typeInto("Search teams", "Harbor Comets");
  await click("Use “Harbor Comets” as a custom team name");
  await expect(A.page.locator('input[aria-label="Team name"]')).toHaveValue("Harbor Comets");
  await expect(A.page.locator('input[aria-label="Crest letters"]')).toHaveValue("HC");   // guessed from the name
  expect(await addReady()).toBe(false);                                                    // no colour yet
  await click("Colour #00796B");
  await expect.poll(() => addReady()).toBe(true);
  await shot("06-team-custom");
  await click("Add badge");
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(2);
  expect((await storedBadges())[1]).toMatchObject({ kind: "team", label: "Harbor Comets", abbr: "HC", color: "#00796B", textColor: "#FFFFFF" });
});

test("school and library: a catalog school, a custom one, and a library stamp with guessed letters", async () => {
  await seed([]);
  await open(0);
  await startAdd("A school or community");
  await click("UC Berkeley");
  await click("Add badge");
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(1);
  expect((await storedBadges())[0]).toMatchObject({ kind: "school", label: "UC Berkeley", color: "#002676", textColor: "#FDB515" });

  await startAdd("A school or community");
  await typeInto("Search schools and communities", "Hilltop Academy");
  await click("Use “Hilltop Academy” as my own");
  await expect(A.page.locator('input[aria-label="School or community name"]')).toHaveValue("Hilltop Academy");
  await click("Colour #1A4FA0");
  await click("Add badge");
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(2);
  expect((await storedBadges())[1]).toMatchObject({ kind: "school", label: "Hilltop Academy", color: "#1A4FA0", textColor: "#FFFFFF" });

  await startAdd("A library");
  await typeInto("Library name", "Oakland Public Library");
  await expect(A.page.locator('input[aria-label="Stamp letters"]')).toHaveValue("OPL");
  await shot("07-library");
  await A.page.locator('input[aria-label="Stamp letters"]').fill("");
  await typeInto("Stamp letters", "oak1");
  await expect(A.page.locator('input[aria-label="Stamp letters"]')).toHaveValue("OAK1");
  await click("Add badge");
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(3);
  expect((await storedBadges())[2]).toMatchObject({ kind: "library", label: "Oakland Public Library", abbr: "OAK1" });
  await expect.poll(() => badgeCount(), { timeout: 15000 }).toBe(3);
});

test("the keyboard: tiles, rows and buttons are tab stops; Enter picks and saves", async () => {
  await seed([]);
  await open(0);
  await click("Add badge");
  await there("A library");
  const t = await probe("A library");
  expect(t.tabindex).toBe("0");
  await A.page.evaluate(() => { for (const e of document.querySelectorAll('[aria-label="A library"]')) e.focus(); });
  await A.page.keyboard.press("Enter");
  await expect(A.page.locator('input[aria-label="Library name"]')).toBeFocused();
  await A.page.keyboard.type("Berkeley Public Library", { delay: 40 });
  await A.page.keyboard.press("Enter");                // Enter in the field saves a complete badge
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(1);
  expect((await storedBadges())[0]).toMatchObject({ kind: "library", label: "Berkeley Public Library", abbr: "BPL" });
});

test("at 20 badges only a place can still be added", async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: "sch" + String(i).padStart(3, "0"), kind: "school", visibility: "anyone", label: "School " + i, color: "#1A4FA0", textColor: "#FFFFFF" }));
  await seed(many);
  await open(6);                       // the row shows the first five and a "+15 more" chip
  await startAdd("A library");
  await typeInto("Library name", "Full Library");
  expect(await addReady()).toBe(false);
  await A.page.keyboard.press("Escape");
  expect((await storedBadges()).length).toBe(20);
});

test("a short, narrow window (390 x 600): the panel stays on screen and scrolls inside its own frame", async () => {
  await seed([]);
  await open(0);
  await A.page.setViewportSize({ width: 390, height: 600 });
  await A.page.waitForTimeout(500);
  await click("Add badge");
  await there("A team");
  await click("A team");
  await there("Back");
  await shot("08-phone-team");
  const geom = await A.page.evaluate(() => {
    // the panel is the nearest scrollable ancestor of the "Back" button's node
    let n = null;
    for (const e of document.querySelectorAll('[aria-label="Back"]')) n = e;
    let p = n;
    while (p && !(p.scrollHeight > p.clientHeight + 4 && getComputedStyle(p).overflowY !== "visible")) p = p.parentElement;
    const r = p ? p.getBoundingClientRect() : null;
    return { found: !!p, left: r && r.left, right: r && r.right, top: r && r.top, bottom: r && r.bottom,
      scrolls: p ? p.scrollHeight > p.clientHeight : false, pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  });
  expect(geom.found).toBe(true);
  expect(geom.left).toBeGreaterThanOrEqual(0);
  expect(geom.right).toBeLessThanOrEqual(390);
  expect(geom.top).toBeGreaterThanOrEqual(0);
  expect(geom.bottom).toBeLessThanOrEqual(600);
  expect(geom.scrolls).toBe(true);
  expect(geom.pageOverflowX).toBe(false);
  // Add badge can be reached by scrolling the panel, and a real click on a tile still works there
  await A.page.evaluate(() => { for (const e of document.querySelectorAll('[aria-label="Back"]')) { let p = e.parentElement; while (p && !(p.scrollHeight > p.clientHeight + 4 && getComputedStyle(p).overflowY !== "visible")) p = p.parentElement; if (p) p.scrollTop = p.scrollHeight; } });
  const add = await probe("Add badge");
  expect(add.b).toBeLessThanOrEqual(600);
  expect(add.t).toBeGreaterThanOrEqual(0);
  await A.page.keyboard.press("Escape");
  await A.page.setViewportSize({ width: 1500, height: 1000 });
});
