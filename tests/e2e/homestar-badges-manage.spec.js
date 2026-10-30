// @ts-check
// The "Manage badges" dialog (BadgesDialog.js; badges.md §7.5, §8 phase 5) against the REAL server and a real
// signed-in owner. The buttons, the Tab key and the page are driven with the real mouse and keyboard
// (page.mouse / page.keyboard); the one exception is a <select>'s value, set with selectOption because a native
// dropdown popup is not part of the page. Every claim is judged by its side effect: the stored state.badges and
// profile, not by where a click landed (CLAUDE.md "Don't trust a screenshot...").
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
  A = await newAccount(browser, "hometest_bm" + Math.random().toString(36).slice(2, 6));
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (A) await A.context.close();
});

// Invented names (the trademark-neutral rule), one of each kind.
const place = { id: "plc001", kind: "place", visibility: "anyone", label: "Oakland, CA" };
const metro = { id: "trn001", kind: "transit", visibility: "anyone", agency: "Metro", label: "Orange Line", color: "#A85200", textColor: "#FFFFFF" };
const college = { id: "sch001", kind: "school", visibility: "anyone", label: "Hilltop College", color: "#1B2A4A", textColor: "#F4C542" };
const library = { id: "lib001", kind: "library", visibility: "anyone", label: "Oakland Public Library", abbr: "OPL" };
const comets = { id: "tem001", kind: "team", visibility: "anyone", label: "Comets", abbr: "CMT", color: "#0A2032", textColor: "#FFFFFF" };
const club = { id: "sch002", kind: "school", visibility: "anyone", label: "Chess Club", color: "#046A38", textColor: "#FFFFFF" };
const harbor = { id: "trn002", kind: "transit", visibility: "anyone", agency: "Harbor", label: "Ferry", color: "#0277BD", textColor: "#FFFFFF" };
const SEVEN = [place, metro, college, library, comets, club, harbor];

// ── helpers ──────────────────────────────────────────────────────────────────

const seed = async (/** @type {any[]} */ list, /** @type {string} */ location = "") => {
  await A.page.evaluate(async ([l, loc]) => {
    await new Promise((r) => lively.require("lively.identity.UserSpace", "lively.identity.PostcardAudience").toRun(r));
    await new Promise((res, rej) => lively.identity.postcardAudience.patchSettings((st) => { st.badges = l; }, (e) => (e ? rej(e) : res(null))));
    await new Promise((res, rej) => lively.identity.userSpace.saveProfile({ location: loc }, (e) => (e ? rej(e) : res(null))));
  }, [list, location]);
};
const storedBadges = (page = A.page) => page.evaluate(async (h) => ((await (await fetch("/@" + h + "/settings", { credentials: "include", headers: { Accept: "application/json" } })).json()).state || {}).badges || [], A.handle);
const storedLocation = () => A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/profile", { credentials: "include", headers: { Accept: "application/json" } })).json()).record.payload.location || "", A.handle);
const ids = (/** @type {any[]} */ l) => l.map((b) => b.id);

const badgeCount = (page = A.page) => page.evaluate(() => {
  let n = 0;
  if (typeof $world === "undefined" || !$world) return -1;
  $world.withAllSubmorphsDo((m) => { const x = m.renderContext && m.renderContext().shapeNode; if (x && x.getAttribute && x.getAttribute("data-badge") && x.getAttribute("data-badge") !== "add") n++; });
  return n;
});
/** Opens the owner's homestar and waits for `n` badge nodes. */
const open = async (/** @type {number} */ n) => {
  await A.page.goto("/@" + A.handle);
  await expect.poll(() => badgeCount(), { timeout: 30000 }).toBe(n);
  await A.page.waitForTimeout(700);   // lets the page font finish and the row redraw
};

/** Viewport rect and live style of the LAST node with this aria-label (a dialog sits above the page), or null. */
const probe = (/** @type {string} */ aria) => A.page.evaluate((a) => {
  let n = null;
  for (const e of document.querySelectorAll("[aria-label]")) if (e.getAttribute("aria-label") === a) n = e;
  if (!n) return null;
  const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2,
    bg: cs.backgroundColor, tabindex: n.getAttribute("tabindex"), disabled: n.getAttribute("aria-disabled") === "true" };
}, aria);
const click = async (/** @type {string} */ aria) => {
  const p = await probe(aria);
  expect(p, "no node labelled " + aria).not.toBeNull();
  await A.page.mouse.move(p.cx, p.cy, { steps: 4 });
  await A.page.mouse.click(p.cx, p.cy);
};
const gone = (/** @type {string} */ aria) => expect.poll(() => probe(aria), { timeout: 8000 }).toBeNull();
const there = (/** @type {string} */ aria) => expect.poll(async () => (await probe(aria)) !== null, { timeout: 8000 }).toBe(true);
const shot = async (/** @type {string} */ name) => { if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, name + ".png") }); };

/** Opens the dialog from the page's own "Manage badges" button with a real click. */
const openManage = async () => {
  await click("Manage badges");
  await there("Cancel");
  await there("Move Metro Orange Line up").catch(() => {});
};
/** The aria-labels of the dialog's per-row "Move <name> up" buttons, in the order they are on screen (top to bottom). */
const rowOrder = () => A.page.evaluate(() => [...document.querySelectorAll('[aria-label^="Move "][aria-label$=" up"]')]
  .map((e) => ({ n: e.getAttribute("aria-label").replace(/^Move | up$/g, ""), t: e.getBoundingClientRect().top }))
  .sort((a, b) => a.t - b.t).map((x) => x.n));
const selectOf = (/** @type {string} */ id) => A.page.locator('select[data-badge-visibility="' + id + '"]');

// ── tests ────────────────────────────────────────────────────────────────────

test("the Manage badges button opens the list: every badge in order, the place pinned, a fold line after five", async () => {
  await seed(SEVEN);
  await open(6);
  await openManage();
  await shot("m01-list");
  expect(await rowOrder()).toEqual(["Oakland, CA", "Metro Orange Line", "Hilltop College", "Oakland Public Library", "Comets", "Chess Club", "Harbor Ferry"]);
  // the place cannot move; the first other badge cannot go above it; the last cannot go down
  expect((await probe("Move Oakland, CA up")).disabled).toBe(true);
  expect((await probe("Move Oakland, CA down")).disabled).toBe(true);
  expect((await probe("Move Metro Orange Line up")).disabled).toBe(true);
  expect((await probe("Move Metro Orange Line down")).disabled).toBe(false);
  expect((await probe("Move Harbor Ferry down")).disabled).toBe(true);
  expect((await probe("Remove Oakland, CA")).disabled).toBe(false);          // the place can still be removed
  // each row has a who-sees select showing the stored choice, laid out in its own row
  for (const b of SEVEN) await expect(selectOf(b.id)).toHaveValue("anyone");
  const fold = await A.page.evaluate(() => document.body.innerText.includes("Folded into") || [...document.querySelectorAll("*")].some((e) => /Folded into/.test(e.textContent || "") && e.children.length === 0));
  expect(fold).toBe(true);
  // a select sits on the same line as its row's buttons, to the left of them
  const sel = await selectOf("trn001").boundingBox();
  const up = await probe("Move Metro Orange Line down");
  expect(Math.abs(sel.y + sel.height / 2 - up.cy)).toBeLessThan(3);
  expect(sel.x + sel.width).toBeLessThan(up.l);
  // nothing was stored by opening it
  expect(ids(await storedBadges())).toEqual(ids(SEVEN));
});

test("move up and down are local until Save; Save stores the order; Cancel throws it away", async () => {
  await click("Move Hilltop College up");
  expect((await rowOrder()).slice(0, 3)).toEqual(["Oakland, CA", "Hilltop College", "Metro Orange Line"]);
  await click("Move Comets down");
  expect(await rowOrder()).toEqual(["Oakland, CA", "Hilltop College", "Metro Orange Line", "Oakland Public Library", "Chess Club", "Comets", "Harbor Ferry"]);
  expect(ids(await storedBadges())).toEqual(ids(SEVEN));                 // still nothing stored
  // Cancel discards
  await click("Cancel");
  await gone("Cancel");
  expect(ids(await storedBadges())).toEqual(ids(SEVEN));
  await openManage();
  expect((await rowOrder()).slice(0, 3)).toEqual(["Oakland, CA", "Metro Orange Line", "Hilltop College"]);   // reopened from the stored order
  // do it again and Save
  await click("Move Hilltop College up");
  await click("Move Comets down");
  await click("Save");
  await gone("Cancel");
  await expect.poll(async () => ids(await storedBadges()).join(), { timeout: 15000 }).toBe(["plc001", "sch001", "trn001", "lib001", "sch002", "tem001", "trn002"].join());
  // the homestar row now shows the new first five, in order, and it survives a reload
  await A.page.reload();
  await expect.poll(() => badgeCount(), { timeout: 30000 }).toBe(6);
  expect(ids(await storedBadges()).slice(0, 3)).toEqual(["plc001", "sch001", "trn001"]);
});

test("a who-sees choice is stored on Save and not before; the place keeps its own", async () => {
  await A.page.waitForTimeout(700);
  await openManage();
  await selectOf("lib001").selectOption("friends");
  await selectOf("plc001").selectOption("private");
  expect((await storedBadges()).find((b) => b.id === "lib001").visibility).toBe("anyone");
  await shot("m02-dirty");
  await click("Save");
  await gone("Cancel");
  await expect.poll(async () => (await storedBadges()).map((b) => b.id + ":" + b.visibility).join(), { timeout: 15000 })
    .toBe("plc001:private,sch001:anyone,trn001:anyone,lib001:friends,sch002:anyone,tem001:anyone,trn002:anyone");
});

test("remove deletes a row locally; Save stores it; removing the place keeps the others", async () => {
  await A.page.reload();
  await expect.poll(() => badgeCount(), { timeout: 30000 }).toBe(6);
  await A.page.waitForTimeout(700);
  await openManage();
  await click("Remove Comets");
  await gone("Move Comets up");
  expect((await storedBadges()).length).toBe(7);
  await click("Remove Oakland, CA");
  expect(await rowOrder()).toEqual(["Hilltop College", "Metro Orange Line", "Oakland Public Library", "Chess Club", "Harbor Ferry"]);
  await click("Save");
  await gone("Cancel");
  await expect.poll(async () => ids(await storedBadges()).join(), { timeout: 15000 }).toBe(["sch001", "trn001", "lib001", "sch002", "trn002"].join());
});

test("the keyboard: Tab reaches the buttons, Enter moves a badge and focus stays on that badge's button; Escape cancels", async () => {
  await seed(SEVEN);
  await open(6);
  await openManage();
  // focus the first row's remove button path: put focus on the sixth badge's "up" and press Enter with the real key
  await A.page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('[aria-label="Move Chess Club up"]')).focus());
  await A.page.keyboard.press("Enter");
  expect((await rowOrder()).slice(4, 6)).toEqual(["Chess Club", "Comets"]);
  const focused = () => A.page.evaluate(() => document.activeElement && document.activeElement.getAttribute("aria-label"));
  expect(await focused()).toBe("Move Chess Club up");               // focus followed the badge to its new row
  await A.page.keyboard.press("Enter");
  await A.page.keyboard.press("Enter");
  expect((await rowOrder()).slice(1, 4)).toEqual(["Metro Orange Line", "Chess Club", "Hilltop College"]);
  // it is at index 2 now; one more press takes it to the top (just below the place); then up is unavailable and focus moves on
  await A.page.keyboard.press("Enter");
  expect((await rowOrder()).slice(0, 3)).toEqual(["Oakland, CA", "Chess Club", "Metro Orange Line"]);
  expect(await focused()).toBe("Move Chess Club down");            // "up" became unavailable, so focus went to "down"
  // Tab from there reaches that row's remove button
  await A.page.keyboard.press("Tab");
  expect(await focused()).toBe("Remove Chess Club");
  // the who-sees select comes first in a row's tab order: select, up, down, remove. This row's "up" is unavailable
  // (it is just below the place), and an unavailable button is not a tab stop, so Tab goes straight to "down".
  await A.page.locator('select[data-badge-visibility="sch002"]').focus();
  await A.page.keyboard.press("Tab");
  expect(await focused()).toBe("Move Chess Club down");
  await A.page.keyboard.press("Tab");
  expect(await focused()).toBe("Remove Chess Club");
  await A.page.keyboard.press("Shift+Tab");
  await A.page.keyboard.press("Shift+Tab");
  await A.page.keyboard.press("Shift+Tab");
  expect(await focused()).toBe("Remove Oakland, CA");              // back past the select, onto the place's last stop
  // Escape cancels with nothing stored
  await A.page.keyboard.press("Escape");
  await gone("Cancel");
  expect(ids(await storedBadges())).toEqual(ids(SEVEN));
});

test("an outside click cancels; Save stays off until something changed", async () => {
  await openManage();
  const save = await probe("Save");
  expect(save.disabled).toBe(true);
  await click("Move Hilltop College up");
  expect((await probe("Save")).disabled).toBe(false);
  await click("Move Hilltop College down");                           // back to the stored order
  expect((await probe("Save")).disabled).toBe(true);
  await A.page.mouse.click(8, 8);
  await gone("Cancel");
  expect(ids(await storedBadges())).toEqual(ids(SEVEN));
});

test("the old public profile location shows as a place: saving it keeps it as a real badge and clears the profile", async () => {
  await seed([metro, college], "Oakland, CA");
  await open(3);
  await openManage();
  expect(await rowOrder()).toEqual(["Oakland, CA", "Metro Orange Line", "Hilltop College"]);
  await selectOf("_legacy").selectOption("friends");
  await click("Save");
  await gone("Cancel");
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(3);
  const b = await storedBadges();
  expect(b[0]).toMatchObject({ kind: "place", label: "Oakland, CA", visibility: "friends" });
  expect(b[0].id).toMatch(/^[a-z0-9]{6,12}$/);
  expect(b[0].id).not.toBe("_legacy");
  await expect.poll(() => storedLocation(), { timeout: 15000 }).toBe("");
});

test("removing the old public location place clears the profile so it does not come back", async () => {
  await seed([metro], "Oakland, CA");
  await open(2);
  await openManage();
  await click("Remove Oakland, CA");
  await click("Save");
  await gone("Cancel");
  await expect.poll(() => storedLocation(), { timeout: 15000 }).toBe("");
  await expect.poll(() => badgeCount(), { timeout: 15000 }).toBe(1);
  expect(ids(await storedBadges())).toEqual(["trn001"]);
});

test("a second tab: a badge added there is kept, one removed there stays removed, and our order and choices are saved", async () => {
  await seed([place, metro, college, library]);
  await open(4);
  await openManage();
  await click("Move Oakland Public Library up");                       // ours: library above college
  await selectOf("trn001").selectOption("orbit");                      // ours: a who-sees change
  // the other tab: remove the college, add a team
  const other = await A.context.newPage();
  await other.goto("/@" + A.handle);
  await other.waitForFunction(() => typeof $world !== "undefined" && $world && lively.identity && lively.identity.postcardAudience);
  await other.evaluate(async (t) => {
    await new Promise((r) => lively.require("lively.identity.PostcardAudience").toRun(r));
    await new Promise((res, rej) => lively.identity.postcardAudience.patchSettings((st) => { st.badges = st.badges.filter((b) => b.id !== "sch001").concat([t]); }, (e) => (e ? rej(e) : res(null))));
  }, comets);
  await other.close();
  await click("Save");
  await gone("Cancel");
  await expect.poll(async () => (await storedBadges()).map((b) => b.id).join(), { timeout: 15000 }).toBe("plc001,trn001,lib001,tem001");
  const b = await storedBadges();
  expect(b.find((x) => x.id === "trn001").visibility).toBe("orbit");
});

test("Add badge opens the real picker on top; what it stores is merged without losing the order made so far", async () => {
  await seed([place, metro, college]);
  await open(3);
  await openManage();
  await click("Move Hilltop College up");                              // ours, not saved
  // the dialog's own "Add badge" is the last node with that name while the picker is closed
  await click("Add badge");
  await there("A library");
  await click("A library");
  const name = A.page.locator('input[aria-label="Library name"]');
  await name.click();
  await name.pressSequentially("Branch Library", { delay: 70 });
  // Escape inside the picker closes ONLY the picker; the manage dialog stays
  await A.page.keyboard.press("Escape");
  await gone("A library");
  await there("Cancel");
  expect(ids(await storedBadges())).toEqual(["plc001", "trn001", "sch001"]);   // the picker was cancelled: nothing stored
  await click("Add badge");
  await click("A library");
  await name.click();
  await name.pressSequentially("Branch Library", { delay: 70 });
  await A.page.locator('[role="button"][aria-label="Add badge"]').last().click();
  await expect.poll(async () => (await storedBadges()).length, { timeout: 15000 }).toBe(4);   // the picker stored it at once
  await gone("A library");
  // the list shows it, last, and the unsaved move is still there
  await there("Move Branch Library up");
  expect(await rowOrder()).toEqual(["Oakland, CA", "Hilltop College", "Metro Orange Line", "Branch Library"]);
  await shot("m03-after-add");
  await click("Save");
  await gone("Cancel");
  await expect.poll(async () => ids(await storedBadges()).slice(0, 3).join(), { timeout: 15000 }).toBe("plc001,sch001,trn001");
  expect((await storedBadges())[3]).toMatchObject({ kind: "library", label: "Branch Library" });
});

test("a failed save leaves the dialog open with the error and the changes; a later Save works", async () => {
  await seed([place, metro, college]);
  await open(3);
  await openManage();
  await click("Move Hilltop College up");
  await A.page.route("**/@" + A.handle + "/settings", (route) => route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : route.continue());
  await click("Save");
  await expect.poll(() => A.page.evaluate(() => document.body.innerText + [...document.querySelectorAll("*")].map((e) => (e.children.length ? "" : e.textContent)).join(" ")), { timeout: 15000 }).toContain("Could not save");
  await there("Cancel");
  expect((await rowOrder()).slice(0, 3)).toEqual(["Oakland, CA", "Hilltop College", "Metro Orange Line"]);   // the change is still there
  expect(ids(await storedBadges())).toEqual(["plc001", "trn001", "sch001"]);
  await A.page.unroute("**/@" + A.handle + "/settings");
  await click("Save");
  await gone("Cancel");
  await expect.poll(async () => ids(await storedBadges()).join(), { timeout: 15000 }).toBe("plc001,sch001,trn001");
});

test("twenty badges scroll inside the list; Save stays reachable; a 390x600 phone keeps everything on screen", async () => {
  const many = [place];
  for (let i = 0; i < 19; i++) many.push({ id: "bdg" + String(100 + i), kind: "school", visibility: "anyone", label: "School " + (i + 1), color: "#1B2A4A", textColor: "#FFFFFF" });
  await seed(many);
  await A.page.setViewportSize({ width: 390, height: 600 });
  await open(6);
  await openManage();
  await shot("m04-phone");
  const save = await probe("Save");
  expect(save.b).toBeLessThanOrEqual(600);
  expect(save.l).toBeGreaterThanOrEqual(0);
  expect(save.r).toBeLessThanOrEqual(390);
  const overflow = await A.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  // the last row is reachable by scrolling the list, and still works there
  await A.page.evaluate(() => { const b = document.querySelector('[aria-label="Move School 19 up"]'); b.scrollIntoView({ block: "center" }); });
  await there("Move School 19 up");
  await A.page.waitForTimeout(200);
  await click("Move School 19 up");
  await expect.poll(async () => (await rowOrder()).indexOf("School 19"), { timeout: 8000 }).toBe(18);
  await click("Cancel");
  await A.page.setViewportSize({ width: 1280, height: 800 });
});
