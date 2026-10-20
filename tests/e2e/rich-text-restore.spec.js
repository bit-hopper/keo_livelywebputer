// @ts-check
const { test, expect } = require("@playwright/test");

// A rich text morph rendered from a saved world used to collapse to its
// border + padding (12px) and let the text hang out below it: the height
// correction in TextFormattingSupport's fit() ran while the node was not yet
// attached to the page, where offsetHeight reads 0. Building a morph in a
// live world does not take that path, so these serialize a world and serve it
// as the page's own embedded world, which loads the way a saved world does.

const WORLD_SCRIPT = /(<script type="text\/x-lively-world"[^>]*>)([\s\S]*?)(<\/script>)/;

async function openWorld(page) {
  await page.goto("/blank.html");
  await page.waitForFunction(
    () =>
      window.$world &&
      lively.morphic.Text.prototype._richTextOriginals &&
      lively.identity &&
      lively.identity.signedSerializer,
    { timeout: 30000 },
  );
}

// The page's html with a rich text morph (saved height `height`) in its world.
async function savedPageWith(page, request, text, height) {
  await openWorld(page);
  const worldJson = await page.evaluate(
    ({ text, height }) => {
      var t = new lively.morphic.Text(lively.rect(300, 300, 240, height), text);
      t.applyStyle({ fixedWidth: true, fixedHeight: false, borderWidth: 1, padding: lively.rect(5, 5, 0, 0) });
      t.richTextToolbarEnabled = true;
      $world.addMorph(t);
      return JSON.stringify(lively.identity.signedSerializer._innerSerializeToJso($world));
    },
    { text, height },
  );
  const html = await (await request.get("/blank.html")).text();
  expect(html).toMatch(WORLD_SCRIPT);
  return html.replace(WORLD_SCRIPT, (m, open, body, close) => open + worldJson + close);
}

async function loadSaved(page, html) {
  await page.route("**/blank.html", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("/blank.html");
  await page.waitForFunction(
    () => window.$world && $world.submorphs.some((m) => m.richTextToolbarEnabled),
    { timeout: 30000 },
  );
  await page.waitForTimeout(1500);
}

test("a rich text box keeps its saved height when a saved world loads", async ({ page, request }) => {
  const html = await savedPageWith(page, request, "The text label is off after a save", 31);
  await loadSaved(page, html);

  const result = await page.evaluate(() => {
    var t = $world.submorphs.find((m) => m.richTextToolbarEnabled),
      box = t.renderContext().shapeNode.getBoundingClientRect(),
      text = t.renderContext().textNode.getBoundingClientRect();
    return { height: t.getExtent().y, textBottom: text.bottom, boxBottom: box.bottom };
  });

  expect(result.height).toBeGreaterThan(12);
  expect(result.textBottom).toBeLessThanOrEqual(result.boxBottom + 1);
});

test("a restored rich text box still grows when its text wraps", async ({ page, request }) => {
  const html = await savedPageWith(page, request, "short", 31);
  await loadSaved(page, html);

  const result = await page.evaluate(async () => {
    var t = $world.submorphs.find((m) => m.richTextToolbarEnabled),
      before = t.getExtent().y;
    t.setTextString("a much longer sentence that has to wrap onto several lines inside a box that is only two hundred and forty pixels wide");
    t.fit();
    await new Promise((r) => setTimeout(r, 400));
    var box = t.renderContext().shapeNode.getBoundingClientRect(),
      text = t.renderContext().textNode.getBoundingClientRect();
    return { before: before, after: t.getExtent().y, textBottom: text.bottom, boxBottom: box.bottom };
  });

  expect(result.after).toBeGreaterThan(result.before);
  expect(result.textBottom).toBeLessThanOrEqual(result.boxBottom + 1);
});
