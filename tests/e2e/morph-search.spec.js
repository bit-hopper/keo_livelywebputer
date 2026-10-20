// @ts-check
const { test, expect } = require("@playwright/test");

// The menu bar's search > "Search morphs in this world"
// (lively.ide.morphSearch): matches live morphs by name or text, and the
// signed-in user's saved worlds by the morph names/text inside them.
// Sign-in needs a passkey, so the saved-world test fakes the signed-in state
// and answers the /@handle listing from a route mock -- it covers the scan and
// the list, not the real login.

async function openWorld(page) {
  await page.goto("/blank.html");
  await page.waitForFunction(
    () =>
      window.$world &&
      window.lively &&
      lively.ide &&
      lively.ide.commands &&
      lively.ide.commands.byName["lively.ide.morphSearch"] &&
      lively.ide.tools &&
      lively.ide.tools.SelectionNarrowing,
    { timeout: 30000 },
  );
}

function addText(page, name, text) {
  return page.evaluate(
    ({ name, text }) => {
      var t = new lively.morphic.Text(lively.rect(800, 450, 300, 40), text);
      if (name) t.name = name;
      $world.addMorph(t);
    },
    { name, text },
  );
}

async function openSearch(page) {
  await page.evaluate(() => lively.ide.commands.exec("lively.ide.morphSearch"));
  await page.waitForFunction(() => {
    var n = lively.ide.tools.SelectionNarrowing.cachedNarrowers["lively.ide.morphSearch"];
    return n && n.state && n.owner;
  });
}

// What the open list currently shows, as strings.
function shown(page) {
  return page.evaluate(() => {
    var n = lively.ide.tools.SelectionNarrowing.cachedNarrowers["lively.ide.morphSearch"];
    return n.state.filteredCandidates.map(function (c) {
      return typeof c === "string" ? c : c.string;
    });
  });
}

test("finds a morph by its name and opens its halo", async ({ page }) => {
  await openWorld(page);
  await addText(page, "Puter", "Puting together");
  await openSearch(page);

  await page.keyboard.type("Puter");
  await expect.poll(() => shown(page)).toEqual(['Puter  <Text>  "Puting together"']);

  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    var m = $world.submorphs.find(function (ea) { return ea.name === "Puter"; });
    return m && m.showsHalos && m.halos && m.halos.length > 0;
  });
});

test("finds an unnamed text morph by its text", async ({ page }) => {
  await openWorld(page);
  await addText(page, null, "grocery list: milk");
  await openSearch(page);

  await page.keyboard.type("milk");
  await expect.poll(() => shown(page)).toEqual(['(unnamed)  <Text>  "grocery list: milk"']);
});

test("finds morphs inside saved worlds and opens the world", async ({ page }) => {
  await page.route("**/@testuser", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        handle: "testuser",
        objects: [
          {
            type: "world",
            objId: "w0rldObjId01",
            visibility: "public",
            state: { name: "My Saved World" },
            record: {
              payload: {
                id: "0",
                registry: {
                  0: { __LivelyClassName__: "lively.morphic.World" },
                  1: { __LivelyClassName__: "lively.morphic.Box", name: "ZebraPanel" },
                  2: { __LivelyClassName__: "lively.morphic.Text", textString: "quokka notes" },
                  3: { __LivelyClassName__: "lively.morphic.Shapes.Rectangle", name: "ZebraShape" },
                },
              },
            },
          },
          // not a world, and an encrypted world: neither has a readable registry
          { type: "postcard", objId: "p1", record: { payload: { registry: { 1: { __LivelyClassName__: "lively.morphic.Box", name: "ZebraPostcard" } } } } },
          { type: "world", objId: "enc1", visibility: "private", state: { name: "Secret" }, record: { ciphertext: "x" } },
        ],
      }),
    }),
  );

  await openWorld(page);
  await page.evaluate(() => {
    lively.identity.did = { isLoggedIn: () => true, currentUser: () => ({ handle: "testuser" }) };
    window.__opened = [];
    window.open = function (u, t) { window.__opened.push([u, t]); };
  });
  await openSearch(page);

  // typed immediately, before the listing has necessarily returned
  await page.keyboard.type("Zebra");
  await expect
    .poll(() => shown(page))
    .toEqual(['ZebraPanel  <Box>  — in world "My Saved World"']);

  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.__opened))
    .toEqual([["/@testuser/w0rldObjId01", "_blank"]]);
});

test("a saved-world text match shows the text", async ({ page }) => {
  await page.route("**/@testuser", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        objects: [
          {
            type: "world",
            objId: "w1",
            state: { name: "Notes" },
            record: { payload: { registry: { 1: { __LivelyClassName__: "lively.morphic.Text", textString: "quokka notes" } } } },
          },
        ],
      }),
    }),
  );
  await openWorld(page);
  await page.evaluate(() => {
    lively.identity.did = { isLoggedIn: () => true, currentUser: () => ({ handle: "testuser" }) };
  });
  await openSearch(page);

  await page.keyboard.type("quokka");
  await expect
    .poll(() => shown(page))
    .toEqual(['(unnamed)  <Text>  "quokka notes"  — in world "Notes"']);
});

test("world items come back in the shared shape", async ({ page }) => {
  await openWorld(page);
  await addText(page, "Shaped", "some   spaced\ntext");
  const item = await page.evaluate(() =>
    new Promise((resolve) =>
      lively.require("lively.ide.tools.Search").toRun(function () {
        var it = lively.ide.tools.Search.worldItems().find(function (i) { return i.name === "Shaped"; });
        resolve({
          type: it.type, group: it.group, cls: it.cls, text: it.text, world: it.world,
          hasMorph: !!it.morph, hasRun: typeof it.run === "function",
          line: lively.ide.tools.Search.listString(it),
        });
      }),
    ),
  );
  expect(item).toEqual({
    type: "text", group: "world", cls: "Text", text: "some spaced text", world: null,
    hasMorph: true, hasRun: true, line: 'Shaped  <Text>  "some spaced text"',
  });
});
