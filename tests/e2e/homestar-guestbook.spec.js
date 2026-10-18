// @ts-check
// The homestar guestbook (the Guestbook card in HomestarShelves.js, GuestbookDialog.js) with the comments
// routes stubbed in the browser: what the card lists (the newest three, who may remove an entry, who may
// sign), the signing dialog driven with real keystrokes (typing, the counter, Escape, an empty entry,
// the server's refusals, a successful post), and removing an entry. What the SERVER refuses (anonymous
// posts, blocked authors, who may delete) is in homestar-guestbook-server.spec.js.
//
// Registers two throwaway `hometest_*` accounts (OWNER and VISITOR); see account-lifecycle.spec.js on
// pruning the reserved handles.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });

/** @type {any} */ let O = null;
/** @type {any} */ let V = null;
let profileObjId = "";
let ownerDid = "";

/** What the stubbed comments route holds and was sent. */
const gb = {
  /** @type {any[]} */ entries: [],
  /** @type {string[]} */ posts: [],
  /** @type {string[]} */ deletes: [],
  postStatus: 200,
  nextId: 100,
};
const ago = (/** @type {number} */ days) => new Date(Date.now() - days * 86400000).toISOString();
const entry = (/** @type {number} */ id, /** @type {string} */ handle, /** @type {string} */ did, /** @type {string} */ body, /** @type {number} */ days) =>
  ({ id, objId: profileObjId, did, handle, body, createdAt: ago(days) });

async function installStubs(/** @type {any} */ page, /** @type {() => string} */ viewerHandle, /** @type {() => string} */ viewerDid) {
  await page.route(new RegExp("/@" + O.handle + "/" + "[^/]+/comments(\\?.*)?$"), async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}").body;
      gb.posts.push(body);
      if (gb.postStatus !== 200) return route.fulfill({ status: gb.postStatus, json: { error: "stub refusal" } });
      const e = entry(gb.nextId++, viewerHandle(), viewerDid(), body, 0);
      gb.entries.unshift(e);
      return route.fulfill({ json: e });
    }
    return route.fulfill({ json: { comments: gb.entries, cursor: null } });
  });
  await page.route(new RegExp("/@" + O.handle + "/[^/]+/comments/\\d+$"), (route) => {
    const id = Number(route.request().url().split("/").pop());
    gb.deletes.push(String(id));
    gb.entries = gb.entries.filter((e) => e.id !== id);
    return route.fulfill({ json: { ok: true } });
  });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240 * 1000);
  const r = Math.random().toString(36).slice(2, 6);
  O = await newAccount(browser, "hometest_go" + r);
  V = await newAccount(browser, "hometest_gv" + r);
  const prof = await O.page.evaluate(async (h) => await (await fetch("/@" + h + "/profile", { credentials: "include", headers: { Accept: "application/json" } })).json(), O.handle);
  profileObjId = prof.objId;
  ownerDid = prof.did;
  V.did = await V.page.evaluate(async (h) => (await (await fetch("/@" + h + "/profile", { credentials: "include" })).json()).did, V.handle);
  await installStubs(O.page, () => O.handle, () => ownerDid);
  await installStubs(V.page, () => V.handle, () => V.did);
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  for (const a of [O, V]) { if (a) { await deleteAccount(a); await a.context.close(); } }
});

const texts = (/** @type {any} */ page) => page.evaluate(() => {
  const out = [];
  if (typeof $world === "undefined" || !$world) return out;
  $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); });
  return out;
});
const shows = (/** @type {any} */ page, /** @type {string} */ s) => expect.poll(async () => (await texts(page)).includes(s), { timeout: 30000 }).toBe(true);
const gone = async (/** @type {any} */ page, /** @type {string} */ s) => expect.poll(async () => (await texts(page)).includes(s), { timeout: 15000 }).toBe(false);
/** Tags the box that owns a piece of text, or the morph with this tooltip, so a real click can reach it. */
const tag = async (/** @type {any} */ page, /** @type {string} */ what, /** @type {string} */ id, /** @type {"text"|"tip"} */ by) => {
  await expect.poll(() => page.evaluate(([w, i, b]) => {
    let hit = null;
    $world.withAllSubmorphsDo((m) => {
      if (b === "text" ? (m.textString === w && m.owner) : (m.toolTip === w)) hit = b === "text" ? m.owner : m;
    });
    if (!hit) return 0;
    hit.renderContext().shapeNode.setAttribute("data-pw", i);
    return 1;
  }, [what, id, by || "text"]), { timeout: 30000 }).toBe(1);
  return page.locator('[data-pw="' + id + '"]');
};
const area = (/** @type {any} */ page) => page.locator('textarea[aria-label="Guestbook entry"]');
const open = async (/** @type {any} */ page, /** @type {string} */ wait) => {
  await page.goto("/@" + O.handle);
  await shows(page, wait);
};

test("the owner sees the newest three entries, can remove any, and has no way to sign", async () => {
  gb.entries = [];
  await open(O.page, "Guestbook");
  await shows(O.page, "Nobody has signed your guestbook yet.");
  expect(await texts(O.page)).not.toContain("Sign the guestbook");

  gb.entries = [
    entry(1, "alice", "did:key:alice", "Lovely homestar, the moon card made my day", 0.1),
    entry(2, "bob", "did:key:bob", "Second entry", 2),
    entry(3, "carol", "did:key:carol", "Third entry", 9),
    entry(4, "dave", "did:key:dave", "The fourth is not shown", 30),
  ];
  await open(O.page, "Lovely homestar, the moon card made my day");
  const t = await texts(O.page);
  expect(t).toContain("@alice"); expect(t).toContain("@bob"); expect(t).toContain("@carol");
  expect(t).not.toContain("The fourth is not shown");
  expect(t).toContain("Showing the newest 3.");
  expect(t).toContain("2 days ago");
  expect(t).not.toContain("Sign the guestbook");

  // remove carol's entry (the last x on the card): a real click on its x, then Ok in the confirm
  await (await tag(O.page, "Remove this entry", "gb-del", "tip")).first().click();
  await expect.poll(() => O.page.evaluate(() => { let ok = 0; $world.withAllSubmorphsDo((m) => { if (m.textString === "Ok" && m.owner) { m.owner.renderContext().shapeNode.setAttribute("data-pw", "gb-ok"); ok = 1; } }); return ok; })).toBe(1);
  await O.page.locator('[data-pw="gb-ok"]').click();
  await expect.poll(() => gb.deletes.length).toBe(1);
  expect(gb.deletes[0]).toBe("3");
  await shows(O.page, "The fourth is not shown");   // the list moved up
});

test("a signed-out visitor reads the entries and is asked to sign in; nothing can be removed", async ({ browser }) => {
  gb.entries = [entry(1, "alice", "did:key:alice", "Hello from alice", 1)];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  try {
    await installStubs(page, () => "nobody", () => "did:key:nobody");
    await page.goto("/@" + O.handle);
    await page.waitForFunction(() => window.lively && lively.identity && lively.identity.Homestar && window.$world, null, { timeout: 90000 });
    await shows(page, "Hello from alice");
    const t = await texts(page);
    expect(t).toContain("Sign in to sign the guestbook");
    expect(t).not.toContain("Sign the guestbook");
    expect(await page.evaluate(() => { let n = 0; $world.withAllSubmorphsDo((m) => { if (/^(Remove this entry|Delete your entry)$/.test(m.toolTip || "")) n++; }); return n; })).toBe(0);
    await (await tag(page, "Sign in to sign the guestbook", "gb-signin")).click();
    await expect.poll(() => page.evaluate(() => { let n = 0; $world.withAllSubmorphsDo((m) => { if (m.constructor && /LoginDialog/.test(m.constructor.type || m.name || "")) n++; if (m.textString === "Sign in") n++; }); return n; }), { timeout: 20000 }).toBeGreaterThan(0);
    expect(gb.posts.length).toBe(0);
  } finally { await ctx.close(); }
});

test("a signed-in visitor signs it: the dialog takes real typing, Escape cancels, an empty entry is refused", async () => {
  gb.entries = [entry(1, "alice", "did:key:alice", "Hello from alice", 1)];
  gb.posts = [];
  await open(V.page, "Hello from alice");
  await shows(V.page, "Sign the guestbook");
  await (await tag(V.page, "Sign the guestbook", "gb-sign")).click();
  await expect(area(V.page)).toBeVisible();
  await expect(area(V.page)).toBeFocused();

  // real keystrokes, Backspace included, and the counter follows
  await V.page.keyboard.type("Hello there!");
  await expect(area(V.page)).toHaveValue("Hello there!");
  await V.page.keyboard.press("Backspace");
  await expect(area(V.page)).toHaveValue("Hello there");
  await shows(V.page, "11 / 500");

  // Escape cancels and posts nothing
  await V.page.keyboard.press("Escape");
  await expect(area(V.page)).toHaveCount(0);
  expect(gb.posts.length).toBe(0);

  // an empty entry is refused in the dialog, before any request
  await (await tag(V.page, "Sign the guestbook", "gb-sign2")).click();
  await expect(area(V.page)).toBeVisible();
  await (await tag(V.page, "Post", "gb-post")).click();
  await shows(V.page, "Write something first.");
  expect(gb.posts.length).toBe(0);

  // the server's refusal is shown and the dialog stays, with the text kept
  gb.postStatus = 403;
  await area(V.page).click();
  await V.page.keyboard.type("A note that will be refused");
  await (await tag(V.page, "Post", "gb-post2")).click();
  await shows(V.page, "You can't sign this guestbook.");
  await expect(area(V.page)).toHaveValue("A note that will be refused");
  expect(gb.posts).toEqual(["A note that will be refused"]);

  // and then it goes through: the dialog closes and the entry is listed, as the visitor's
  gb.postStatus = 200;
  await (await tag(V.page, "Post", "gb-post3")).click();
  await expect(area(V.page)).toHaveCount(0);
  await shows(V.page, "A note that will be refused");
  expect(gb.posts.length).toBe(2);
  expect(await texts(V.page)).toContain("@" + V.handle);
});

test("a visitor can take back their own entry but not someone else's", async () => {
  await open(V.page, "A note that will be refused");
  const tips = await V.page.evaluate(() => { const out = []; $world.withAllSubmorphsDo((m) => { if (/^(Remove this entry|Delete your entry)$/.test(m.toolTip || "")) out.push(m.toolTip); }); return out; });
  expect(tips).toEqual(["Delete your entry"]);     // only on the visitor's own entry (alice's has none)
  gb.deletes = [];
  await (await tag(V.page, "Delete your entry", "gb-mine", "tip")).click();
  await expect.poll(() => V.page.evaluate(() => { let ok = 0; $world.withAllSubmorphsDo((m) => { if (m.textString === "Ok" && m.owner) { m.owner.renderContext().shapeNode.setAttribute("data-pw", "gb-ok2"); ok = 1; } }); return ok; })).toBe(1);
  await V.page.locator('[data-pw="gb-ok2"]').click();
  await expect.poll(() => gb.deletes.length).toBe(1);
  await gone(V.page, "A note that will be refused");
});

test("at 390 px the card fits and the page does not scroll sideways", async () => {
  gb.entries = [entry(1, "alice", "did:key:alice", "A fairly long entry that has to wrap onto a second line inside the narrow card on a phone", 1)];
  await V.page.setViewportSize({ width: 390, height: 800 });
  await open(V.page, "Sign the guestbook");
  expect(await V.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("a guest who has used their five entries in 36 hours is told so instead of offered the button", async () => {
  const mine = (/** @type {number} */ id, /** @type {number} */ days) => entry(id, V.handle, V.did, "Entry " + id, days);
  // five within the window (35 hours is inside, 37 is outside)
  gb.entries = [mine(1, 0.1), mine(2, 0.5), mine(3, 1), mine(4, 1.2), mine(5, 35 / 24)];
  await V.page.setViewportSize({ width: 1400, height: 900 });
  await open(V.page, "Entry 1");
  await shows(V.page, "You have left 5 entries recently. Come back later.");
  expect(await texts(V.page)).not.toContain("Sign the guestbook");

  // the oldest of them falls outside the window: there is room again
  gb.entries = [mine(1, 0.1), mine(2, 0.5), mine(3, 1), mine(4, 1.2), mine(5, 37 / 24)];
  await open(V.page, "Entry 1");
  await shows(V.page, "Sign the guestbook");
  expect(await texts(V.page)).not.toContain("You have left 5 entries recently. Come back later.");
});

test("the server's refusal of a sixth entry is shown in the dialog", async () => {
  gb.entries = [entry(1, "alice", "did:key:alice", "Hello from alice", 1)];
  await open(V.page, "Sign the guestbook");
  await (await tag(V.page, "Sign the guestbook", "gb-sign-limit")).click();
  await expect(area(V.page)).toBeVisible();
  gb.postStatus = 429;
  await V.page.keyboard.type("one too many");
  await (await tag(V.page, "Post", "gb-post-limit")).click();
  // the stub's refusal text is the one the server sends for any status other than 401 and 403
  await shows(V.page, "stub refusal");
  await expect(area(V.page)).toHaveValue("one too many");
  gb.postStatus = 200;
  await V.page.keyboard.press("Escape");
});
