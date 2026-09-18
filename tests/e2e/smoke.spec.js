// @ts-check
const { test, expect } = require("@playwright/test");

// blank.html is the general-purpose empty Lively world used for morph/world
// testing (welcome.html is reserved for login/identity flows -- see
// CLAUDE.md/memory). This just confirms the dev server is reachable and a
// real Lively world actually boots ($world exists), as a baseline sanity
// check before writing feature-specific tests against it.
test("blank.html boots a Lively world", async ({ page }) => {
  await page.goto("/blank.html");

  await page.waitForFunction(
    () => typeof window.$world !== "undefined" && window.$world !== null,
    { timeout: 20000 },
  );

  const worldClassName = await page.evaluate(
    () => window.$world.constructor.type || window.$world.constructor.name,
  );
  expect(worldClassName).toBeTruthy();
});
