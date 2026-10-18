// @ts-check
// The owner's orbit manager on the homestar, against a LIVE server, with several real friends:
// the real Manage dialog driven by real clicks, what it stores, what each viewer then gets, the
// Escape key, and the rings on the page.
//
// Registers an owner and four friends through the real RegisterDialog ceremony, each in its own browser
// (all `hometest_*`; see account-lifecycle.spec.js on pruning the reserved
// handles), makes each friend a real friend of the owner through the friend-request routes, and
// removes every account through the deletion feature, even if a check fails.
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.setTimeout(300 * 1000);

test("manage a real orbit of four friends: pick, pin (three at most), unpin, who sees it, Escape, rings", async ({ browser }) => {
  const R = Math.random().toString(36).slice(2, 6);
  const owner = await newAccount(browser, "hometest_o" + R);
  const page = owner.page;
  /** @type {any[]} */
  const friends = [];

  try {
    // ── four friends, each in its own browser (one virtual passkey per account)
    for (const letter of ["a", "b", "c", "d"]) friends.push(await newAccount(browser, "hometest_" + letter + R));
    const asPage = (acct) => (method, url, body) => acct.page.evaluate(([m, u, b]) => /** @type {any} */ (window).__req(m, u, b), [method, url, body]);
    const req = asPage(owner);

    // ── each friend asks, the owner approves: four real friendships
    for (const f of friends) {
      expect((await asPage(f)("POST", "/@" + owner.handle + "/friend-requests")).status).toBe(200);
      expect((await req("PUT", "/@" + owner.handle + "/friend-requests/" + encodeURIComponent(f.did), { action: "approve" })).body.status).toBe("accepted");
    }

    // ── the owner's homestar, with an empty orbit
    await page.goto("/@" + owner.handle);
    await page.waitForFunction(() => /** @type {any} */ (window).lively && lively.identity && lively.identity.Homestar && window.$world, null, { timeout: 90000 });
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      // Give the morph that owns a piece of text a stable test id (the dialog redraws on every click,
      // so this is run again before each one). Returns how many morphs matched.
      w.__tagText = (text, nth, id) => {
        const hits = [];
        $world.withAllSubmorphsDo((m) => { if (m.textString === text && m.owner) hits.push(m); });
        const m = hits[nth || 0];
        if (!m) return 0;
        const target = id === "self" ? m : m.owner;
        target.renderContext().shapeNode.setAttribute("data-pw", text + ":" + (nth || 0) + (id === "self" ? ":self" : ""));
        return hits.length;
      };
      // The star of one friend's row (the picker lists friends in the server's order, not ours).
      w.__tagStar = (handle) => {
        let row = null;
        $world.withAllSubmorphsDo((m) => { if (m.textString === "@" + handle && m.owner) row = m.owner; });
        const star = row && row.submorphs.find((m) => m.textString === "star");
        if (!star) return 0;
        star.renderContext().shapeNode.setAttribute("data-pw", "star-of:" + handle);
        return 1;
      };
      w.__texts = () => { const out = []; $world.withAllSubmorphsDo((m) => { if (m.textString) out.push(m.textString); }); return out; };
    });
    const tagged = async (text, nth = 0, self = false) => {
      await expect.poll(() => page.evaluate(([t, n, s]) => /** @type {any} */ (window).__tagText(t, n, s ? "self" : ""), [text, nth, self]), { timeout: 30000 }).toBeGreaterThan(nth);
      return page.locator('[data-pw="' + text + ":" + nth + (self ? ":self" : "") + '"]');
    };
    const star = async (f) => {
      await expect.poll(() => page.evaluate((h) => /** @type {any} */ (window).__tagStar(h), f.handle), { timeout: 30000 }).toBe(1);
      return page.locator('[data-pw="star-of:' + f.handle + '"]');
    };
    const texts = () => page.evaluate(() => /** @type {any} */ (window).__texts());
    const orbitNow = async (as) => (await page.evaluate(async (h) => (await (await fetch("/@" + h + "/orbit", { credentials: "include", headers: { Accept: "application/json" } })).json()), as));
    const counter = async () => (await texts()).find((t) => /selected · \d+ pinned/.test(t));

    await (await tagged("Add close friends")).click();

    // ── all four friends are listed; tick them in order and pin three
    for (const f of friends) await (await tagged("@" + f.handle)).click();
    await expect.poll(counter).toBe("4 selected · 0 pinned");
    for (const f of friends.slice(0, 3)) await (await star(f)).click();
    await expect.poll(counter).toBe("4 selected · 3 pinned");

    // a fourth pin is refused, with the reason on screen, and nothing changes
    await (await star(friends[3])).click();
    await expect.poll(async () => (await texts()).includes("At most 3 can be pinned. Unpin someone first.")).toBe(true);
    expect(await counter()).toBe("4 selected · 3 pinned");
    await (await star(friends[0])).click();                          // unpin the first
    await expect.poll(counter).toBe("4 selected · 2 pinned");

    // ── Escape cancels and stores nothing
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await texts()).includes("Your orbit")).toBe(false);
    expect((await orbitNow(owner.handle)).members).toEqual([]);

    // ── do it again for real: tick the first three, pin the first two, Save
    await (await tagged("Add close friends")).click();
    for (const f of friends.slice(0, 3)) await (await tagged("@" + f.handle)).click();
    for (const f of friends.slice(0, 2)) await (await star(f)).click();
    await expect.poll(counter).toBe("3 selected · 2 pinned");
    await (await tagged("Save")).click();
    await expect.poll(async () => (await orbitNow(owner.handle)).members.length).toBe(3);
    let o = await orbitNow(owner.handle);
    expect(o.members.map((m) => m.handle)).toEqual(friends.slice(0, 3).map((f) => f.handle));
    expect(o.pinned).toEqual([friends[0].did, friends[1].did]);
    const stored = (await req("GET", "/@" + owner.handle + "/settings")).body;
    expect(stored.state.orbit).toEqual({ visibility: "friends", members: friends.slice(0, 3).map((f) => f.did), pinned: [friends[0].did, friends[1].did] });

    // ── the page draws it: two rings turning, three satellites (2 inner, 1 outer), nobody asked to Add friends
    await expect.poll(async () => (await texts()).some((t) => t.startsWith("@" + friends[0].handle + ", "))).toBe(true);
    expect(await page.evaluate(() => document.querySelectorAll(".homestar-orbit-spin").length)).toBe(2 + 3);
    const names = (await texts()).find((t) => t.startsWith("@" + friends[0].handle + ", "));
    expect(names).toBe(friends.slice(0, 3).map((f) => "@" + f.handle).join(", "));

    // ── unpin by unticking a pinned friend: the second is taken out of the orbit entirely
    await (await tagged("Manage")).click();
    await (await tagged("@" + friends[1].handle)).click();
    await expect.poll(counter).toBe("2 selected · 1 pinned");
    await (await tagged("Save")).click();
    await expect.poll(async () => (await orbitNow(owner.handle)).members.length).toBe(2);
    o = await orbitNow(owner.handle);
    expect(o.members.map((m) => m.did)).toEqual([friends[0].did, friends[2].did]);
    expect(o.pinned).toEqual([friends[0].did]);

    // ── who sees what: a member sees the orbit, the owner's Friends visibility is honoured
    o = await friends[2].page.evaluate(async (h) => (await (await fetch("/@" + h + "/orbit", { credentials: "include", headers: { Accept: "application/json" } })).json()), owner.handle);
    expect(o).toMatchObject({ locked: false, isOwner: false });
    expect(o.members.map((m) => m.handle)).toEqual([friends[0].handle, friends[2].handle]);
  } finally {
    for (const f of friends) { await deleteAccount(f); await f.context.close(); }
    await deleteAccount(owner);
    await owner.context.close();
  }
});
