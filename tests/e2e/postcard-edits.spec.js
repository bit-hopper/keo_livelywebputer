// @ts-check
// The reader side of edited postcards (PostcardEdits.js) and the lists dialog
// (ListsDialog.js), driven in a blank world with the network stubbed. The server's
// stamping and notices are covered by tests/server/edit-tracking.test.js and
// inbox-edit-notices.test.js; the real encrypted-card flow needs a signed card and a
// passkey, so it is checked by hand.
const { test, expect } = require("@playwright/test");

async function boot(page) {
  await page.goto("/blank.html");
  await page.waitForFunction(
    () => window.$world && window.lively && lively.identity && lively.identity.did,
    null, { timeout: 90000 });
}

const doc = (paras) => ({ type: "doc", content: paras.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })) });

// Replaces fetch: edit-baseline answers `baseline`, /at/<cid> answers a public version.
async function stubVersions(page, baseline, versions) {
  await page.evaluate(({ baseline, versions }) => {
    const real = window.fetch;
    window.fetch = (url, opts) => {
      const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { "Content-Type": "application/json" } }));
      if (/edit-baseline$/.test(String(url))) return json(baseline);
      const m = /\/at\/(\w+)$/.exec(String(url));
      if (m) return versions[m[1]]
        ? json({ visibility: "public", record: { cid: m[1], payload: { format: "prosemirror-doc-v1", doc: versions[m[1]] } } })
        : json({ error: "Forbidden" }, 403);
      return real(url, opts);
    };
  }, { baseline, versions });
}

const hostText = (page) => page.evaluate(() => {
  const w = /** @type {any} */ (window);
  const scrim = w.$world.submorphs.find((m) => m.submorphs && m.submorphs[0] && m.submorphs[0].getExtent && m.submorphs[0].getExtent().x === 680);
  const host = scrim && scrim.submorphs[0].renderContext().shapeNode.querySelector(".selectable");
  return host ? host.textContent : null;
});

const open = (page, extra) => page.evaluate((extra) => new Promise((res) => lively.require("lively.identity.PostcardEdits").toRun(() => {
  const w = /** @type {any} */ (window);
  w.__noChange = 0;
  lively.identity.postcardEdits.openDialog(Object.assign({ handle: "me", objId: "o1", title: "T", editedAt: new Date().toISOString(), onNoChange: () => { w.__noChange++; } }, extra));
  res(null);
})), extra || {});

test("the diff dialog shows what changed between the baseline and the current version", async ({ page }) => {
  await boot(page);
  await stubVersions(page, { edited: true, baselineCid: "c1", currentCid: "c2", editedAt: new Date().toISOString() },
    { c1: doc(["Dinner is on Saturday.", "Bring a dish."]), c2: doc(["Dinner is on Sunday.", "Bring a dish.", "Parking is behind."]) });
  await open(page);
  await expect.poll(() => hostText(page)).toContain("Parking is behind.");
  const text = await hostText(page);
  expect(text).toContain("Saturday");
  expect(text).toContain("Sunday");
  expect(await page.evaluate(() => /** @type {any} */ (window).__noChange)).toBe(0);
});

test("an edit that was put back shows no net change and tells the caller", async ({ page }) => {
  await boot(page);
  await stubVersions(page, { edited: true, baselineCid: "c1", currentCid: "c2", editedAt: new Date().toISOString() },
    { c1: doc(["Same."]), c2: doc(["Same."]) });
  await open(page);
  await expect.poll(() => hostText(page)).toContain("No net change");
  expect(await page.evaluate(() => /** @type {any} */ (window).__noChange)).toBe(1);
});

test("a card that was not edited for this reader says so and does not fetch versions", async ({ page }) => {
  await boot(page);
  await stubVersions(page, { edited: false, baselineCid: null, currentCid: "c2", editedAt: null }, {});
  await open(page);
  await expect.poll(() => hostText(page)).toContain("has not changed");
});

test("a reader who lost access gets a clear message", async ({ page }) => {
  await boot(page);
  await stubVersions(page, { edited: true, baselineCid: "c1", currentCid: "c2", editedAt: new Date().toISOString() }, {});
  await open(page);
  await expect.poll(() => hostText(page)).toContain("no longer open earlier versions");
});

test("agoLabel is coarse and never negative", async ({ page }) => {
  await boot(page);
  const labels = await page.evaluate(() => new Promise((res) => lively.require("lively.identity.PostcardEdits").toRun(() => {
    const f = lively.identity.postcardEdits.agoLabel;
    const now = Date.parse("2026-10-17T12:00:00Z");
    res([f("2026-10-17T12:00:30Z", now), f("2026-10-17T11:59:30Z", now), f("2026-10-17T11:55:00Z", now),
      f("2026-10-17T09:00:00Z", now), f("2026-10-14T12:00:00Z", now), f("nonsense", now)]);
  })));
  expect(labels).toEqual(["just now", "just now", "5 minutes ago", "3 hours ago", "3 days ago", ""]);
});

test("the lists dialog creates, edits and deletes lists, saving each change", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => new Promise((res) => lively.require("lively.identity.ListsDialog").toRun(() => {
    const w = /** @type {any} */ (window);
    w.__saved = [];
    lively.identity.postcardAudience.saveLists = (lists, cb) => { w.__saved.push(JSON.parse(JSON.stringify(lists))); cb(null, { audienceLists: lists }); };
    w.__ctx = { ownerDid: "did:me", handle: "me", friendDids: ["did:a", "did:b"], orbitDids: [], handleByDid: { "did:a": "ana", "did:b": "bo" }, lists: [], cardAudiences: {} };
    lively.identity.ListsDialog.open({ ctx: w.__ctx });
    res(null);
  })));
  // Tags every clickable box so trusted clicks can find it.
  const tag = () => page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const scrim = w.$world.submorphs.find((m) => m.submorphs && m.submorphs[0] && m.submorphs[0].getExtent && m.submorphs[0].getExtent().x === 460);
    const panel = scrim.submorphs[0];
    const tagOne = (m, label) => { const n = m.renderContext().shapeNode; n.setAttribute("role", "button"); n.setAttribute("aria-label", "t:" + label); };
    panel.submorphs.forEach((m) => {
      const texts = (m.submorphs || []).map((s) => s.textString).filter(Boolean);
      if (texts.length) tagOne(m, texts.join(" "));
      if (m.getExtent().x === 412 && (m.submorphs || []).length) m.submorphs.forEach((r) => { const t = (r.submorphs || []).map((s) => s.textString).filter(Boolean)[0]; if (t) tagOne(r, "friend " + t); });
    });
  });
  const click = async (label) => { await tag(); await page.locator(`[aria-label="t:${label}"]`).click(); };

  await click("New list");
  await page.locator('input[aria-label="List name"]').fill("Book club");
  await click("friend @ana");
  expect(await page.locator('input[aria-label="List name"]').inputValue()).toBe("Book club");   // survives the redraw
  await click("Save");
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__saved.length)).toBe(1);
  let saved = await page.evaluate(() => /** @type {any} */ (window).__saved);
  expect(saved[0]).toHaveLength(1);
  expect(saved[0][0]).toMatchObject({ name: "Book club", memberDids: ["did:a"] });
  expect(saved[0][0].id).toMatch(/^[A-Za-z0-9]+$/);

  // A second list with the same name is refused, and nothing more is saved.
  await click("New list");
  await page.locator('input[aria-label="List name"]').fill("  book CLUB ");
  await click("Save");
  await expect.poll(() => page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const scrim = w.$world.submorphs.find((m) => m.submorphs && m.submorphs[0] && m.submorphs[0].getExtent && m.submorphs[0].getExtent().x === 460);
    const texts = []; (function walk(m) { if (m.textString) texts.push(m.textString); (m.submorphs || []).forEach(walk); })(scrim.submorphs[0]);
    return texts.join("|");
  })).toContain("already have a list");
  expect(await page.evaluate(() => /** @type {any} */ (window).__saved.length)).toBe(1);
  await click("Cancel");

  // Delete needs a second click.
  await click("label Book club 1 person chevron_right");
  await click("Delete list");
  expect(await page.evaluate(() => /** @type {any} */ (window).__saved.length)).toBe(1);
  await click("Really delete?");
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__saved.length)).toBe(2);
  saved = await page.evaluate(() => /** @type {any} */ (window).__saved);
  expect(saved[1]).toEqual([]);
});
