// @ts-check
// The homestar postcard reel (PostcardReel.js) against a LIVE server, with the feed and the card
// envelopes stubbed in the browser so the test does not depend on any account's real postcards
// (creating a signed card needs a delegated device key the test accounts lack).
//
// Registers one throwaway `hometest_*` account and opens its own homestar (so the owner view of the
// reel runs); see account-lifecycle.spec.js on pruning the reserved handles.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });

/** @type {any} */ let A = null;
/** @type {string[]} */ const feedRequests = [];

function envelope(did, objId, n) {
  return {
    did, objId, type: "postcard", visibility: "public", created: "2026-10-08T12:41:00.000Z",
    state: { title: "Reel card " + n },
    record: {
      cid: "cid" + n,
      payload: {
        format: "prosemirror-doc-v1",
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body of card " + n }] }] },
      },
    },
  };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(200 * 1000);
  A = await newAccount(browser, "hometest_rl" + Math.random().toString(36).slice(2, 6));
  const did = await A.page.evaluate(async (h) => (await (await fetch("/@" + h + "/profile", { credentials: "include" })).json()).did, A.handle);
  const rows = ["R1", "R2", "R3"].map((id, i) => ({ objId: id, did, state: { title: "Reel card " + (i + 1) } }));

  // The reel's own requests: the feed (any sort), then each card, its replies and its reactions.
  await A.page.route(new RegExp("/@" + A.handle + "/postcards"), (route) => {
    feedRequests.push(route.request().url());
    return route.fulfill({ json: { postcards: rows, cursor: null } });
  });
  await A.page.route(new RegExp("/@" + A.handle + "/R[123]/replies"), (route) => route.fulfill({ json: { postcards: [] } }));
  await A.page.route(new RegExp("/@" + A.handle + "/R[123]/thread"), (route) => {
    const n = Number(route.request().url().match(/R([123])\/thread/)[1]);
    return route.fulfill({ json: { root: envelope(did, "R" + n, n), replies: [], handles: {} } });
  });
  await A.page.route(new RegExp("/@" + A.handle + "/R[123]/reactions"), (route) => route.fulfill({ json: { reactions: {}, mine: [] } }));
  await A.page.route(new RegExp("/@" + A.handle + "/R[123]$"), (route) => {
    const n = Number(route.request().url().slice(-1));
    return route.fulfill({ json: envelope(did, "R" + n, n) });
  });
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (A) await A.context.close();
});

/** Text of every text morph in the world, so the assertions read what the page shows. */
const worldText = () => A.page.evaluate(() => { const out = []; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; });
const cardText = () => A.page.evaluate(() => { const n = document.querySelector(".homestar-reel-card"); return n ? n.innerText : ""; });
const navShows = (/** @type {string} */ s) => expect.poll(async () => (await worldText()).includes(s), { timeout: 15000 }).toBe(true);

test("the owner's reel loads the viewer-aware feed and shows the first card", async () => {
  await A.page.goto("/@" + A.handle);
  await A.page.waitForSelector(".homestar-reel-card .lively-postcard-view-content", { timeout: 90000 });
  await navShows("1 / 3");
  expect(await cardText()).toContain("Reel card 1");
  // The owner's plain listing is the mailbox's, so the reel always asks with a sort.
  expect(feedRequests.some((u) => /[?&]sort=new\b/.test(u))).toBe(true);
});

test("arrow keys turn the card and wrap past either end", async () => {
  await A.page.keyboard.press("ArrowRight");
  await navShows("2 / 3");
  await expect.poll(cardText).toContain("Reel card 2");
  await A.page.waitForTimeout(700);            // the turn animation ignores presses while it runs
  await A.page.keyboard.press("ArrowLeft");
  await navShows("1 / 3");
  await A.page.waitForTimeout(700);
  await A.page.keyboard.press("ArrowLeft");    // past the newest wraps to the last
  await navShows("3 / 3");
  await expect.poll(cardText).toContain("Reel card 3");
  await A.page.waitForTimeout(700);
  await A.page.keyboard.press("ArrowRight");   // and past the last wraps back
  await navShows("1 / 3");
});

test("a sideways drag on the card header turns it; a short one snaps back", async () => {
  await A.page.waitForTimeout(700);
  const box = await A.page.evaluate(() => { const r = document.querySelector(".homestar-reel-card").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; });
  const y = box.y + 18;                        // the header strip: a mouse drag in the content selects text
  await A.page.mouse.move(box.x + box.w - 120, y);
  await A.page.mouse.down();
  for (let i = 1; i <= 10; i++) await A.page.mouse.move(box.x + box.w - 120 - i * 20, y + 1);
  await A.page.mouse.up();
  await navShows("2 / 3");                     // dragging left shows the next card

  await A.page.waitForTimeout(900);
  await A.page.mouse.move(box.x + 300, y);
  await A.page.mouse.down();
  for (let i = 1; i <= 3; i++) await A.page.mouse.move(box.x + 300 + i * 10, y);
  await A.page.mouse.up();
  await A.page.waitForTimeout(500);
  expect(await worldText()).toContain("2 / 3");
});

test("picking a sort re-asks the feed with that sort", async () => {
  const before = feedRequests.length;
  const box = await A.page.evaluate(() => { const r = document.querySelector(".homestar-reel-card").getBoundingClientRect(); return { x: r.left, y: r.top }; });
  // The sort pills sit 40px above the card: New, then Stellar.
  await A.page.mouse.click(box.x + 101, box.y - 112 + 72 + 14);
  await expect.poll(() => feedRequests.slice(before).some((u) => /[?&]sort=starred\b/.test(u)), { timeout: 15000 }).toBe(true);
  await navShows("1 / 3");
});

test("the card flips to the homestar back face", async () => {
  await A.page.evaluate(() => { document.querySelector(".homestar-reel-card button[title*='Flip']").click(); });
  await expect(A.page.locator(".homestar-reel-card .lively-postcard-view-postmark")).toHaveCount(1);
  expect(await A.page.locator(".homestar-reel-card .lively-postcard-view-addr").innerText()).toContain("Everyone");
});

test("the comment chip opens the thread under the card", async () => {
  await A.page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll(".homestar-reel-card button")).find((b) => /mode_comment/.test(b.innerHTML));
    chip.click();
  });
  await expect(A.page.locator(".mbt-root")).toHaveCount(1);
  await expect(A.page.locator(".mbt-root .mbt-empty")).toContainText("No replies yet");
  // The owner can answer; the composer is there.
  await expect(A.page.locator(".mbt-composer textarea")).toBeVisible();
});
