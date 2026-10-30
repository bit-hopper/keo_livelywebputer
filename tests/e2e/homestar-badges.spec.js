// @ts-check
// The badge row on the homestar hero (Homestar.js, HomestarBadges.js; badges.md §3, §8 phase 2), against a
// LIVE server with GET /@handle/badges stubbed in the browser, so every kind and every edge case can be drawn.
// What the real route does (who sees which badge) is checked by homestar-badges-server.spec.js.
//
// Everything is read off the live DOM (computed styles, bounding rects), not from a screenshot or the morph
// model: badge heights, fills, the transit agency overlay, the stamp's dashed ring and tilt, a Text's border,
// the row sitting between the bio and the chips, the "+N more" fold, a narrow column, and a failed read.
//
// Registers one throwaway `hometest_*` account; see account-lifecycle.spec.js on pruning the reserved handles.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });
test.setTimeout(120 * 1000);

/** @type {any} */ let A = null;
/** @type {{status: number, json: any}} */
let badges = { status: 200, json: { badges: [], isOwner: true } };

const place = { id: "plc001", kind: "place", visibility: "anyone", label: "Oakland, CA" };
const metroLine = { id: "trn001", kind: "transit", visibility: "anyone", agency: "Metro", label: "Orange Line", color: "#A85200", textColor: "#FFFFFF" };
const busRoute = { id: "trn002", kind: "transit", visibility: "anyone", agency: "Bay Bus", label: "72", color: "#0B6E99", textColor: "#FFFFFF" };
const railOnly = { id: "trn003", kind: "transit", visibility: "anyone", agency: "Valley Rail", label: "", color: "#8C0E34", textColor: "#FFFFFF" };
const teamA = { id: "tem001", kind: "team", visibility: "anyone", label: "Comets", abbr: "CM", color: "#1B2A4A", textColor: "#F4C542" };
const college = { id: "sch001", kind: "school", visibility: "anyone", label: "Hilltop College", color: "#1B2A4A", textColor: "#F4C542" };
const library = { id: "lib001", kind: "library", visibility: "anyone", label: "Oakland Public Library", abbr: "OPL" };

test.beforeAll(async ({ browser }) => {
  test.setTimeout(200 * 1000);
  A = await newAccount(browser, "hometest_bdg" + Math.random().toString(36).slice(2, 6));
  await A.page.route(new RegExp("/@" + A.handle + "/badges$"), (route) => route.fulfill({ status: badges.status, json: badges.json }));
  // a bio and a link, so the row has something above and below it
  await A.page.evaluate(async () => {
    await new Promise((r) => lively.require("lively.identity.UserSpace").toRun(r));
    await new Promise((res, rej) => lively.identity.userSpace.saveProfile({ bio: "Hello from the bay", links: [{ label: "my site", url: "https://example.com" }] }, (e) => (e ? rej(e) : res(null))));
  });
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (A) await A.context.close();
});

/** Every badge node on the page, top row first and left to right within a row, with what the checks need. */
const readBadges = () => A.page.evaluate(() => {
  const out = [];
  if (typeof $world === "undefined" || !$world) return out;
  $world.withAllSubmorphsDo((m) => {
    const n = m.renderContext && m.renderContext().shapeNode;
    if (!n || !n.getAttribute || !n.getAttribute("data-badge")) return;
    const cs = getComputedStyle(n), r = n.getBoundingClientRect();
    const texts = [];
    m.withAllSubmorphsDo((k) => {
      if (k === m || !k.textString) return;
      const kn = k.renderContext().shapeNode, sp = kn.querySelector("span"), kcs = getComputedStyle(kn);
      if (!sp) return;
      const sr = sp.getBoundingClientRect(), nr = kn.getBoundingClientRect();
      texts.push({ text: k.textString, color: getComputedStyle(sp).color, family: getComputedStyle(sp).fontFamily, size: getComputedStyle(sp).fontSize,
        border: kcs.borderTopWidth, midOffset: +((sr.top + sr.height / 2) - (r.top + r.height / 2)).toFixed(2),
        roomBelow: +(nr.bottom - sr.bottom).toFixed(2), roomRight: +(nr.right - sr.right).toFixed(2) });
    });
    const shades = [];
    (m.submorphs || []).forEach((k) => { if (!k.textString) shades.push(getComputedStyle(k.renderContext().shapeNode).backgroundColor); });
    out.push({ title: n.getAttribute("aria-label"), label: n.getAttribute("aria-label"), h: n.offsetHeight, w: n.offsetWidth, bg: cs.backgroundColor, radius: cs.borderTopLeftRadius,
      borderStyle: cs.borderTopStyle, borderColor: cs.borderTopColor, boxSizing: cs.boxSizing, transform: getComputedStyle(n.parentNode).transform,
      left: r.left, right: r.right, top: r.top, bottom: r.bottom, texts, shades });
  });
  // by row (the tilted stamp's box starts a few px higher than the flat ones, so sort on the centre), then left to right
  const row = (x) => Math.round((x.top + x.bottom) / 2 / 10);
  return out.sort((a, b) => row(a) - row(b) || a.left - b.left);
});

const worldText = () => A.page.evaluate(() => { const out = []; if (typeof $world === "undefined" || !$world) return out; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
const shows = (/** @type {string} */ s) => expect.poll(async () => (await worldText()).includes(s), { timeout: 30000 }).toBe(true);
const load = async (/** @type {any} */ list, /** @type {number} */ expected) => {
  badges = { status: 200, json: { badges: list, isOwner: true } };
  await A.page.goto("/@" + A.handle);
  await shows("Edit profile");
  await expect.poll(async () => (await readBadges()).length, { timeout: 30000 }).toBe(expected);
  await A.page.waitForTimeout(600);   // lets the page font finish loading and the row redraw with true widths
};

test("each kind is drawn to the design: size, fill, text colour, no stray border", async () => {
  await load([place, metroLine, busRoute, teamA, library], 5);
  const b = await readBadges();
  expect(b.map((x) => x.title)).toEqual(["Oakland, CA", "Metro Orange Line", "Bay Bus 72", "Comets", "Oakland Public Library"]);

  // every badge is 32 high, the stamp 36
  expect(b.filter((x) => x.title !== library.label).map((x) => x.h)).toEqual([32, 32, 32, 32]);
  expect(b[4].h).toBe(36);
  expect(b[4].w).toBe(36);

  // place: pink pill, dark text
  expect(b[0].bg).toBe("rgb(251, 228, 238)");
  expect(b[0].radius).toBe("16px");
  expect(b[0].texts.find((t) => t.text === "Oakland, CA").color).toBe("rgb(36, 31, 44)");

  // transit: the badge's own colours, an agency segment with a dark layer over the same fill
  expect(b[1].bg).toBe("rgb(168, 82, 0)");
  expect(b[1].radius).toBe("8px");
  expect(b[1].shades).toEqual(["rgba(0, 0, 0, 0.24)"]);
  expect(b[1].texts.map((t) => t.color)).toEqual(["rgb(255, 255, 255)", "rgb(255, 255, 255)"]);
  expect(b[1].texts[0].size).toBe("11px");
  expect(b[1].texts[1].size).toBe("12.5px");
  expect(b[2].bg).toBe("rgb(11, 110, 153)");

  // team: pill in the team colour, a crest with the colours swapped
  expect(b[3].bg).toBe("rgb(27, 42, 74)");
  expect(b[3].radius).toBe("16px");
  expect(b[3].shades).toEqual(["rgb(244, 197, 66)"]);                       // the crest disc
  expect(b[3].texts.find((t) => t.text === "CM").color).toBe("rgb(27, 42, 74)");
  expect(b[3].texts.find((t) => t.text === "Comets").color).toBe("rgb(244, 197, 66)");

  // library: parchment stamp, dashed brown ring, tilted, border-box so it is exactly 36
  expect(b[4].bg).toBe("rgb(251, 244, 230)");
  expect(b[4].borderStyle).toBe("dashed");
  expect(b[4].borderColor).toBe("rgb(125, 92, 51)");
  expect(b[4].boxSizing).toBe("border-box");
  expect(b[4].transform).not.toBe("none");
  const m = b[4].transform.slice(7, -1).split(", ").map(Number);        // matrix(a, b, c, d, e, f): the angle is atan2(b, a)
  const angle = Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI);
  expect([-6, 5]).toContain(angle);

  // no Text carries a border (a Text morph defaults to a 1px black one), all in the page font
  for (const badge of b) for (const t of badge.texts) {
    if (t.text !== "location_on" && t.text !== "menu_book") {
      expect(t.border, badge.title + " / " + t.text).toBe("0px");
      expect(t.family).toMatch(/Atkinson Hyperlegible|Georgia/);
    }
    // room for the descender under every line, and none of it spilling past the box on the right
    expect(t.roomBelow, badge.title + " / " + t.text).toBeGreaterThanOrEqual(1.5);
    expect(t.roomRight, badge.title + " / " + t.text).toBeGreaterThanOrEqual(0);
  }

  // text is vertically centred on its badge (the stamp's inner lines are not, by design)
  for (const badge of b.slice(0, 4)) for (const t of badge.texts) {
    if (t.text !== "CM") expect(Math.abs(t.midOffset), badge.title + " / " + t.text).toBeLessThanOrEqual(1);
  }

  // the badges sit on one row, 8px apart
  for (let i = 1; i < 4; i++) expect(b[i].left - b[i - 1].right).toBeCloseTo(8, 0);
});

test("the place badge keeps its width: padded 10 left, 13 right of the text", async () => {
  const b = (await readBadges())[0];
  const t = b.texts.find((x) => x.text === "Oakland, CA");
  expect(b.right - b.left).toBe(b.w);
  expect(t).toBeTruthy();
});

test("an agency alone is one segment; a numbered route is drawn", async () => {
  await load([railOnly, busRoute], 2);
  const b = await readBadges();
  expect(b[0].title).toBe("Valley Rail");
  expect(b[0].shades).toEqual([]);                    // no darker agency layer: there is no line next to it
  expect(b[0].texts.length).toBe(1);
  expect(b[0].bg).toBe("rgb(140, 14, 52)");
  expect(b[1].texts.map((t) => t.text)).toEqual(["Bay Bus", "72"]);
});

test("the row sits between the bio and the chips, in the text column", async () => {
  await load([place, metroLine], 2);
  const geo = await A.page.evaluate(() => {
    const r = (m) => m.renderContext().shapeNode.getBoundingClientRect();
    let bio = null, chip = null, name = null, badge = null;
    $world.withAllSubmorphsDo((m) => {
      if (m.textString === "Hello from the bay") bio = m;
      if (m.textString && m.textString.indexOf("my site") !== -1) chip = m.owner;
      if (m.textString === "Edit profile") name = m;
      const n = m.renderContext && m.renderContext().shapeNode;
      if (n && n.getAttribute && n.getAttribute("data-badge") && !badge) badge = m;
    });
    return { bio: bio && r(bio).toJSON(), chip: chip && r(chip).toJSON(), badge: r(badge).toJSON() };
  });
  expect(geo.bio).not.toBeNull();
  expect(geo.chip).not.toBeNull();
  expect(geo.badge.top).toBeGreaterThanOrEqual(geo.bio.top + 10);   // below the bio's first line
  expect(geo.badge.bottom).toBeLessThanOrEqual(geo.chip.top);       // the chips are below the badges, not overlapped
  expect(Math.abs(geo.badge.left - geo.bio.left)).toBeLessThanOrEqual(1);
});

test("more than five fold into an outlined '+N more' chip that names them", async () => {
  await load([place, metroLine, busRoute, teamA, library, college, railOnly], 6);
  const b = await readBadges();
  const more = b.find((x) => /^Hilltop College/.test(x.title));
  expect(more).toBeTruthy();
  expect(more.texts.map((t) => t.text)).toEqual(["+2 more"]);
  expect(more.title).toBe("Hilltop College, Valley Rail");
  expect(more.bg).toBe("rgb(255, 255, 255)");
  expect(more.borderStyle).toBe("solid");
  expect(more.borderColor).toBe("rgb(217, 206, 220)");
  expect(more.h).toBe(32);
  expect(more.boxSizing).toBe("border-box");
  expect((await readBadges()).filter((x) => x.title === "Hilltop College").length).toBe(0);   // the sixth is not drawn on its own
});

test("a name too long for the column is cut with an ellipsis and keeps its full name in the title", async () => {
  const long = "Gypsy Jumpy Quickly Wavy Pygmy Zebras Yo";
  await A.page.setViewportSize({ width: 390, height: 900 });
  await load([{ ...place, label: long }, { ...metroLine, agency: "Metropolitan Transport", label: "Very Long Line Name Here" }, { ...college, label: long }], 3);
  const b = await readBadges();
  const hero = await A.page.evaluate(() => { let w = 0; $world.withAllSubmorphsDo((m) => { if (m.textString === "Edit profile") w = m.owner.owner.renderContext().shapeNode.getBoundingClientRect().right; }); return w; });
  for (const badge of b) {
    expect(badge.right, badge.title).toBeLessThanOrEqual(hero - 24 + 1);             // inside the hero's right padding
    expect(badge.h).toBe(32);
  }
  expect(b[0].title).toBe(long);
  expect(b[0].texts.find((t) => t.text.endsWith("…"))).toBeTruthy();
  expect(b[1].title).toBe("Metropolitan Transport Very Long Line Name Here");
  expect(b[1].texts.every((t) => t.text.endsWith("…"))).toBe(true);
  // one badge per row at this width, 10px between rows, none overlapping
  for (let i = 1; i < b.length; i++) expect(b[i].top - b[i - 1].bottom).toBeCloseTo(10, 0);
  await A.page.setViewportSize({ width: 1500, height: 1000 });
});

test("20 badges: five and a '+15 more' chip", async () => {
  const many = [place];
  for (let i = 0; i < 19; i++) many.push({ ...college, id: "sc" + (1000 + i), label: "School " + i });
  await load(many, 6);
  const b = await readBadges();
  expect(b[5].texts.map((t) => t.text)).toEqual(["+15 more"]);
});

test("no badges: no row and nothing else disturbed; a failed read does the same", async () => {
  await load([], 0);
  expect(await worldText()).toContain("Hello from the bay");
  badges = { status: 500, json: { error: "boom" } };
  await A.page.goto("/@" + A.handle);
  await shows("Edit profile");
  await A.page.waitForTimeout(800);
  expect((await readBadges()).length).toBe(0);
  expect(await worldText()).toContain("Hello from the bay");
});
