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

test("Worlds scope lists saved worlds by name, private ones too, with morph counts", async ({ page }) => {
  const day = 86400000;
  await page.route("**/@testuser", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        objects: [{
          type: "world", objId: "w1", state: { name: "Neon Garden" },
          record: { payload: { registry: {
            0: { __LivelyClassName__: "lively.morphic.World" },
            1: { __LivelyClassName__: "lively.morphic.Box", name: "Gate" },
            2: { __LivelyClassName__: "lively.morphic.Box" },
            3: { __LivelyClassName__: "lively.morphic.Shapes.Rectangle" },
          } } },
        }],
      }),
    }),
  );
  await page.route("**/@testuser/worlds", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        worlds: [
          { objId: "w1", name: "Neon Garden", template: null, visibility: "public", created: new Date(Date.now() - 2 * day).toISOString() },
          { objId: "w2", name: "Neon Diary", template: null, visibility: "private", created: new Date(Date.now() - 40 * day).toISOString() },
        ],
      }),
    }),
  );
  await openWithMorphs(page, 0);
  await page.evaluate(() => {
    window.__opened = [];
    window.open = (u, t) => window.__opened.push([u, t]);
    lively.identity.did = { isLoggedIn: () => true, currentUser: () => ({ handle: "testuser" }) };
    lively.ide.tools.SearchPalette.close();
    lively.ide.tools.SearchPalette.open();
  });
  await page.waitForFunction(() => lively.ide.tools.SearchPalette.current.input.renderContext().shapeNode.contains(document.activeElement));
  await page.keyboard.type("neon");

  // counts on the pills: the two worlds, plus the morph Gate (it matches through its world's name)
  await expect.poll(() => state(page)).toMatchObject({ pills: ["All  3", "Morphs  1", "Worlds  2", "Code  0", "Files  0"] });

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const metas = () =>
    page.evaluate(() => lively.ide.tools.SearchPalette.current.rows.map((r) => r.item.name + " | " + r.item.meta));
  await expect.poll(metas).toEqual([
    "Neon Garden | 2 morphs  \u00b7  created 2 days ago",   // Gate + the unnamed Box; the World and the Shape do not count
    "Neon Diary | private  \u00b7  created 1 month ago",
  ]);

  await page.getByRole("button", { name: "Result: Neon Diary" }).click();
  await expect.poll(() => page.evaluate(() => window.__opened)).toEqual([["/@testuser/w2", "_blank"]]);
});

// ---- preview pane

const previewTexts = (page) =>
  page.evaluate(() => {
    var s = lively.ide.tools.SearchPalette.current;
    return { visible: s.preview.isVisible ? s.preview.isVisible() : true, wide: s.wide,
      texts: s.preview.withAllSubmorphsSelect((m) => !!m.textString).map((m) => m.textString) };
  });

test("preview follows the highlighted row and its buttons work", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openWithMorphs(page, 3);
  await page.keyboard.type("rowtest");
  await expect.poll(() => previewTexts(page)).toMatchObject({ wide: true });
  let p = await previewTexts(page);
  expect(p.texts).toEqual(expect.arrayContaining(["rowtest0", "Text", "Class", "Where", "This world", "Size", "300 \u00d7 30", "Show halo  \u21b5", "Copy name"]));

  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await previewTexts(page)).texts).toContain("rowtest1");

  // Copy name: a real click; the clipboard gets the name
  await page.getByRole("button", { name: "Copy name" }).click();
  await expect.poll(async () => (await previewTexts(page)).texts).toContain("Copied");   // shown for 1.2 s only: check it first
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("rowtest1");

  // the primary button runs the row's action and closes
  await page.getByRole("button", { name: "Preview action" }).click();
  await page.waitForFunction(() => {
    var m = $world.submorphs.find((ea) => ea.name === "rowtest1");
    return !lively.ide.tools.SearchPalette.isOpen() && m && m.showsHalos && m.halos && m.halos.length > 0;
  });
});

test("the preview pane is hidden when the panel is narrower than 760px", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await openWithMorphs(page, 2);
  await page.keyboard.type("rowtest");
  await expect.poll(() => rows(page)).toMatchObject({ sel: 0 });
  const r = await page.evaluate(() => {
    var s = lively.ide.tools.SearchPalette.current;
    return { wide: s.wide, previewVisible: s.preview.renderContext().shapeNode.style.display !== "none" && s.preview.submorphs.length > 0,
      listW: s.list.getExtent().x, panelW: s.panel.getExtent().x };
  });
  expect(r.wide).toBe(false);
  expect(r.previewVisible).toBe(false);
  expect(r.listW).toBe(r.panelW);
});

test("a world's preview lists its morph count, visibility and creation date", async ({ page }) => {
  await page.route("**/@testuser", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ objects: [] }) }));
  await page.route("**/@testuser/worlds", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ worlds: [{ objId: "w2", name: "Neon Diary", template: null, visibility: "private", created: "2026-03-04T12:00:00.000Z" }] }),
    }),
  );
  await openWithMorphs(page, 0);
  await page.evaluate(() => {
    lively.identity.did = { isLoggedIn: () => true, currentUser: () => ({ handle: "testuser" }) };
    lively.ide.tools.SearchPalette.close();
    lively.ide.tools.SearchPalette.open();
  });
  await page.waitForFunction(() => lively.ide.tools.SearchPalette.current.input.renderContext().shapeNode.contains(document.activeElement));
  await page.keyboard.type("neon diary");
  await expect.poll(() => rows(page)).toMatchObject({ names: ["Neon Diary"] });
  const p = await previewTexts(page);
  expect(p.texts).toEqual(expect.arrayContaining(["Neon Diary", "World", "Visibility", "Private", "Created", "Opens", "In a new tab", "Open world  \u21b5"]));
  expect(p.texts.some((t) => /2026/.test(t))).toBe(true);
});

// ---- code scope (runtime code search; nothing goes to the server)

test("Code scope finds runtime code, needs two characters, and Enter opens the code browser", async ({ page }) => {
  const requests = [];
  // The page itself GETs CommandLineServer at boot; what must never happen is a command run (POST) or an eval.
  page.on("request", (r) => { if (r.method() !== "GET" && /nodejs\/(CommandLineServer|NodeJSEvalServer|PtyServer)/.test(r.url())) requests.push(r.method() + " " + r.url()); });
  await openWithMorphs(page, 0);
  await page.evaluate(() => {
    window.__browsed = [];
    lively.ide.browse = function () { window.__browsed.push(Array.prototype.slice.call(arguments)); };
  });

  // one character: no code search at all
  await page.keyboard.type("w");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => lively.ide.tools.SearchPalette.current.codeItems.length)).toBe(0);

  await page.keyboard.type("orldItems");
  await expect
    .poll(() => page.evaluate(() => lively.ide.tools.SearchPalette.current.codeItems.map((i) => i.name)))
    .toContain("lively.ide.tools.Search>>worldItems");
  await expect.poll(() => state(page)).toMatchObject({ pills: expect.arrayContaining([expect.stringMatching(/^Code  [1-9]/)]) });

  // the preview describes it
  const texts = (await previewTexts(page)).texts;
  expect(texts).toEqual(expect.arrayContaining(["Kind", "Object", "Member", "Opens", "In the code browser", "Open in browser  \u21b5"]));

  // Enter opens the code browser on that method (stubbed here: it opens a whole window)
  await page.getByRole("button", { name: /^Result: lively\.ide\.tools\.Search>>worldItems$/ }).click();
  await expect.poll(() => page.evaluate(() => window.__browsed)).toContainEqual(["lively.ide.tools.Search", "worldItems", "Global.lively.ide.tools.Search"]);
  expect(requests).toEqual([]);   // no shell command / eval was sent
});

test("a late code answer for an older query is dropped, and the palette's own morphs are not hits", async ({ page }) => {
  await openWithMorphs(page, 0);
  await page.keyboard.type("worldIt");
  await page.keyboard.type("ems");
  await expect
    .poll(() => page.evaluate(() => lively.ide.tools.SearchPalette.current.codeItems.every((i) => /worlditems/i.test(i.name + (i.text || "")))))
    .toBe(true);
  const own = await page.evaluate(() => {
    var s = lively.ide.tools.SearchPalette.current;
    return s.codeItems.filter((i) => i.cls === "script").length;
  });
  expect(own).toBe(0);
});
