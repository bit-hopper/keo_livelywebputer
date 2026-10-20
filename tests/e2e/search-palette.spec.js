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
