// @ts-check
const { test, expect } = require("@playwright/test");

// The search palette shell: opens from the command, takes real typing, shows
// per-scope counts, cycles scopes with Tab / a pill click, closes on Esc.

async function openPalette(page) {
  await page.goto("/blank.html");
  await page.waitForFunction(
    () =>
      window.$world && window.lively && lively.ide && lively.ide.commands &&
      lively.ide.commands.byName["lively.ide.searchPalette"],
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    var t = new lively.morphic.Text(lively.rect(800, 450, 300, 40), "Puting together");
    t.name = "Puter";
    $world.addMorph(t);
    lively.ide.commands.exec("lively.ide.searchPalette");
  });
  await page.waitForFunction(() => {
    var P = lively.ide.tools && lively.ide.tools.SearchPalette;
    return P && P.current && P.current.input.renderContext().shapeNode.contains(document.activeElement);
  });
}

const state = (page) =>
  page.evaluate(() => {
    var s = lively.ide.tools.SearchPalette.current;
    return s && { scope: s.scopeIndex, query: s.query, pills: s.pills.map((p) => p._label.textString) };
  });

test("takes typing, shows counts, tab and pill click change scope, esc closes", async ({ page }) => {
  await openPalette(page);

  await page.keyboard.type("puter");
  await expect.poll(() => state(page)).toMatchObject({ query: "puter", pills: ["All  1", "Morphs  1", "Worlds  0", "Code  0", "Files  0"] });

  await page.keyboard.press("Backspace");
  await expect.poll(() => state(page)).toMatchObject({ query: "pute" });

  await page.keyboard.press("Tab");
  await expect.poll(() => state(page)).toMatchObject({ scope: 1 });
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => state(page)).toMatchObject({ scope: 0 });

  // a real click on a pill changes scope, leaves the palette open, keeps focus in the field
  await page.getByRole("button", { name: "Search scope: Worlds" }).click();
  await expect.poll(() => state(page)).toMatchObject({ scope: 2 });
  expect(
    await page.evaluate(() => {
      var s = lively.ide.tools.SearchPalette.current;
      return s.input.renderContext().shapeNode.contains(document.activeElement);
    }),
  ).toBe(true);

  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => lively.ide.tools.SearchPalette.isOpen())).toBe(false);
});

test("a click outside the panel closes it, a click inside does not", async ({ page }) => {
  await openPalette(page);
  const r = await page.evaluate(() => {
    var P = lively.ide.tools.SearchPalette, s = P.current;
    var ev = (x, y) => ({ getPosition: () => lively.pt(x, y), stop: () => {} });
    var b = s.panel.renderContext().shapeNode.getBoundingClientRect();
    s.scrim.onMouseUp(ev(b.left + 50, b.top + 50));
    var afterInside = P.isOpen();
    s.scrim.onMouseUp(ev(b.left - 10, b.top + 50));
    return { afterInside, afterOutside: P.isOpen() };
  });
  expect(r).toEqual({ afterInside: true, afterOutside: false });
});

// ---- results list

const rows = (page) =>
  page.evaluate(() => {
    var s = lively.ide.tools.SearchPalette.current;
    return s && { names: s.rows.map((r) => r.item.name || "(unnamed)"), sel: s.selIndex };
  });

async function openWithMorphs(page, n) {
  await page.goto("/blank.html");
  await page.waitForFunction(
    () => window.$world && window.lively && lively.ide && lively.ide.commands && lively.ide.commands.byName["lively.ide.searchPalette"],
    { timeout: 30000 },
  );
  await page.evaluate((n) => {
    for (var k = 0; k < n; k++) {
      var t = new lively.morphic.Text(lively.rect(700, 300 + k * 5, 300, 30), "text " + k);
      t.name = "rowtest" + k;
      $world.addMorph(t);
    }
    lively.ide.commands.exec("lively.ide.searchPalette");
  }, n);
  await page.waitForFunction(() => {
    var P = lively.ide.tools && lively.ide.tools.SearchPalette;
    return P && P.current && P.current.input.renderContext().shapeNode.contains(document.activeElement);
  });
}

test("rows: capped to 4 under All with a Show more link, uncapped under Morphs, arrows wrap, Enter shows the halo", async ({ page }) => {
  await openWithMorphs(page, 6);
  await page.keyboard.type("rowtest");
  await expect.poll(() => rows(page)).toMatchObject({ names: ["rowtest0", "rowtest1", "rowtest2", "rowtest3"], sel: 0 });

  await page.getByText("Show 2 more").click();   // real click; goes to the Morphs scope
  await expect.poll(() => rows(page)).toMatchObject({ names: ["rowtest0", "rowtest1", "rowtest2", "rowtest3", "rowtest4", "rowtest5"] });

  await page.keyboard.press("ArrowUp");           // wraps from the first row to the last
  await expect.poll(() => rows(page)).toMatchObject({ sel: 5 });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => rows(page)).toMatchObject({ sel: 1 });

  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    var m = $world.submorphs.find((ea) => ea.name === "rowtest1");
    return !lively.ide.tools.SearchPalette.isOpen() && m && m.showsHalos && m.halos && m.halos.length > 0;
  });
});

test("a real click on a row runs it and closes the palette", async ({ page }) => {
  await openWithMorphs(page, 3);
  await page.keyboard.type("rowtest2");
  await page.getByRole("button", { name: "Result: rowtest2" }).click();
  await page.waitForFunction(() => {
    var m = $world.submorphs.find((ea) => ea.name === "rowtest2");
    return !lively.ide.tools.SearchPalette.isOpen() && m && m.showsHalos && m.halos && m.halos.length > 0;
  });
});

test("no match shows the empty state; saved-world rows open the world", async ({ page }) => {
  await page.route("**/@testuser", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        objects: [{
          type: "world", objId: "w1", state: { name: "Neon Garden" },
          record: { payload: { registry: { 1: { __LivelyClassName__: "lively.morphic.Box", name: "ZebraFlower" } } } },
        }],
      }),
    }),
  );
  await openWithMorphs(page, 0);
  await page.evaluate(() => {
    window.__opened = [];
    window.open = (u, t) => window.__opened.push([u, t]);
  });
  await page.keyboard.type("qqqqq");
  await expect.poll(() => page.evaluate(() => lively.ide.tools.SearchPalette.current.bodyTitle.textString)).toBe("No matches for \u201cqqqqq\u201d");

  // the listing is read when the palette opens, so fake the signed-in state and reopen
  await page.evaluate(() => {
    lively.identity.did = { isLoggedIn: () => true, currentUser: () => ({ handle: "testuser" }) };
    lively.ide.tools.SearchPalette.close();
    lively.ide.tools.SearchPalette.open();
  });
  await page.waitForFunction(() => lively.ide.tools.SearchPalette.current.input.renderContext().shapeNode.contains(document.activeElement));
  await page.keyboard.type("zebra");
  await page.getByRole("button", { name: "Result: ZebraFlower" }).click();
  await expect.poll(() => page.evaluate(() => window.__opened)).toEqual([["/@testuser/w1", "_blank"]]);
});

test("no palette morph can be dragged or grabbed", async ({ page }) => {
  await openWithMorphs(page, 3);
  await page.keyboard.type("rowtest");
  await expect.poll(() => rows(page)).toMatchObject({ sel: 0 });
  const bad = await page.evaluate(() => {
    var s = lively.ide.tools.SearchPalette.current;
    return s.scrim
      .withAllSubmorphsSelect(function () { return true; })
      .filter((m) => !!(m.draggingEnabled || m.isGrabbable()))
      .map((m) => m.constructor.type + ":" + (m.textString || m.name || ""));
  });
  expect(bad).toEqual([]);
});
