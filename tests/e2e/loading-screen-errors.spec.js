// @ts-check
const { test, expect } = require("@playwright/test");

// An error logged during startup, after the world's DOM has replaced the loading
// screen but before LoadingScreen.remove() runs, used to make the loading screen's
// console consumer throw (its container element no longer existed). The throw was
// logged as another error, which re-entered the consumer, so one real failure
// turned into a burst of "Cannot read properties of null (reading 'appendChild')"
// errors plus an uncaught page error that aborted startup and hid the cause.
//
// The failure is forced here by refusing the base stylesheet, which the boot
// loads synchronously inside that window and reports with console.error.
test("a failing startup request does not cascade into loading-screen errors", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.route("**/core/styles/base_theme.css*", (route) => route.abort());

  await page.goto("/blank.html");
  await page.waitForFunction(
    () => typeof window.$world !== "undefined" && window.$world !== null,
    { timeout: 20000 },
  );
  // let the rest of startup and any queued callbacks finish
  await page.waitForTimeout(3000);

  // the failure itself is still reported, so the test is really exercising that path
  expect(consoleErrors.some((t) => /base_theme\.css/.test(t))).toBe(true);
  // and nothing came out of the loading screen's own error handling
  expect(consoleErrors.filter((t) => /reading 'appendChild'/.test(t))).toEqual([]);
  expect(pageErrors.filter((t) => /appendChild/.test(t))).toEqual([]);
});
