// @ts-check
const { test, expect } = require("@playwright/test");

// The "Diary" world template stub: listed in the worlds browser's template
// picker, and opened into a fresh world by WorldTemplateLauncher via
// ?template=diary. Neither test creates or saves a world.

test("?template=diary opens the Diary card and strips the param", async ({ page }) => {
  await page.goto("/blank.html?template=diary");
  await page.waitForFunction(
    () => window.$world && $world.submorphs.some((m) => m.name === "Diary"),
    { timeout: 30000 },
  );

  const card = await page.evaluate(() => {
    var d = $world.submorphs.find((m) => m.name === "Diary");
    return d.submorphs.map((s) => s.textString);
  });
  expect(card[0]).toBe("Diary");
  expect(card.length).toBe(2);
  expect(page.url()).not.toContain("template=");
});

test("the template picker lists Diary and opens its create form", async ({ page }) => {
  await page.goto("/blank.html");
  await page.waitForFunction(() => window.$world && window.lively && lively.require, { timeout: 30000 });

  const texts = await page.evaluate(async () => {
    await new Promise((res) => lively.require("lively.identity.WorldsBrowser").toRun(res));
    var w = lively.BuildSpec("lively.identity.WorldsBrowser").createMorph();
    w.openInWorld(lively.pt(120, 120));
    await new Promise((r) => setTimeout(r, 800));
    w.showCreateTemplateList();
    await new Promise((r) => setTimeout(r, 400));

    var content = w.get("worldsBrowserContent"),
      row = null,
      listed = [];
    content.withAllSubmorphsDo(function (m) {
      if (m.textString) listed.push(m.textString);
      if (m.textString === "Diary" && !row) row = m.owner;
    });
    row.onMouseDown();
    await new Promise((r) => setTimeout(r, 400));
    var form = [];
    w.get("worldsBrowserContent").withAllSubmorphsDo(function (m) {
      if (m.textString) form.push(m.textString);
    });
    return { listed: listed, form: form };
  });

  expect(texts.listed).toContain("Diary");
  expect(texts.form).toContain("New Diary world");
});
