// @ts-check
const { test, expect } = require("@playwright/test");

// Logo and TPN code cells, PHASE 0 (LOGO.md section 10): the registry rows, the shared controller and the worker stub that
// answers "Logo isn't built yet". There is no interpreter yet, so nothing here asserts a Logo result; when Phase 1 lands,
// the stub assertions below are replaced by real ones and the structure (one controller, two languages) stays.
// Boots blank.html and drives lively.identity.LogoWorker / postCardUtils directly -- the same objects the wiki editor and
// viewer use.

async function boot(page) {
  await page.goto("/blank.html");
  await page.waitForFunction(() => typeof window.$world !== "undefined" && window.$world !== null, { timeout: 20000 });
  // The wiki pages load this bundle (window.hljs, KaTeX, ProseMirror); blank.html doesn't.
  await page.addScriptTag({ url: "/core/lib/postcard/postcard-runtime.js" });
  await page.evaluate(() => new Promise((resolve) => {
    lively.require("lively.identity.LogoWorker", "lively.identity.PostCardUtils").toRun(resolve);
  }));
}

// Runs one cell through the controller; resolves {segments, state, err}.
function runCell(page, source) {
  return page.evaluate((src) => new Promise((resolve) => {
    const W = lively.identity.LogoWorker;
    const segments = [];
    W.ensureReady((err) => {
      if (err) return resolve({ err: err.message });
      W.run(src, {
        onSegments: (s) => segments.push(...s),
        onDone: (err, res) => resolve({ err: err && err.message, state: res && res.state, segments }),
      });
    });
  }), source);
}

// Puts a read-only rendering of one code_cell into the page and hydrates it.
async function renderCell(page, attrs, hostId = "logo-host") {
  await page.evaluate(([a, id]) => {
    const U = lively.identity.postCardUtils;
    const host = document.createElement("div");
    host.id = id;
    host.style.cssText = "position:fixed;left:0;top:60px;width:700px;background:#fff;z-index:99999";
    host.innerHTML = U.snapshotToHtml({ type: "doc", content: [{ type: "code_cell", attrs: a }] });
    document.body.appendChild(host);
    U.hydrateCodeCells(host);
  }, [attrs, hostId]);
}

test.describe("LogoWorker controller (Phase 0 stub)", () => {
  test("answers init and run; a run is a not-built error and the worker survives it", async ({ page }) => {
    await boot(page);
    const r = await runCell(page, "fd 100");
    expect(r.err).toBeFalsy();
    expect(r.state).toBe("error");
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ kind: "error", errorClass: "not built" });
    expect(r.segments[0].text).toContain("Logo isn't built yet");
    expect(await page.evaluate(() => lively.identity.LogoWorker.buildId)).toBe("phase0-stub");
    // The controller is free again for the next run.
    expect((await runCell(page, "rt 90")).state).toBe("error");
    expect(await page.evaluate(() => lively.identity.LogoWorker.isRunning())).toBe(false);
  });

  test("reset answers, and Stop with nothing running does nothing", async ({ page }) => {
    await boot(page);
    await runCell(page, "fd 1");
    const err = await page.evaluate(() => new Promise((r) => lively.identity.LogoWorker.reset(r)));
    expect(err).toBeNull();
    expect(await page.evaluate(() => lively.identity.postCardUtils.stopCodeCell("logo"))).toBe(false);
  });

  test("logo and tpn rows share the one controller", async ({ page }) => {
    await boot(page);
    const same = await page.evaluate(() => {
      const U = lively.identity.postCardUtils;
      return U.codeCellLanguage("logo").controller === U.codeCellLanguage("tpn").controller;
    });
    expect(same).toBe(true);
    // A run started from a tpn cell goes through the same worker (and gets the same stub answer).
    const state = await page.evaluate(() => new Promise((resolve) => {
      lively.identity.postCardUtils.runCodeCell("TO POLY SIDE", { onDone: (err, res) => resolve(err ? "err" : res.state) }, "tpn");
    }));
    expect(state).toBe("error");
  });
});

test.describe("logo and tpn cells, read-only render", () => {
  for (const [language, badge, source] of [
    ["logo", "🐢 Logo", "to sq :n\n  repeat 4 [fd :n rt 90]\nend"],
    ["tpn", "🐢 TPN", "TO POLY SIDE\n  FORWARD SIDE"],
  ]) {
    test(`${language}: badge, highlighted source, controls, and Run shows the stub's error`, async ({ page }) => {
      await boot(page);
      await renderCell(page, { language, source });
      const cell = page.locator("#logo-host .lively-code-cell");
      await expect(cell).toHaveAttribute("data-language", language);
      await expect(cell.locator(".lively-code-cell-badge")).toHaveText(badge);
      await expect(cell.locator("pre.lively-code-cell-source .hljs-keyword").first()).toBeVisible();
      await expect(cell.locator(".lively-code-cell-reset-btn")).toHaveCount(1);
      await expect(cell.locator(".lively-code-cell-help")).toHaveCount(1);
      await cell.locator(".lively-code-cell-run-btn").click();
      const err = cell.locator(".lively-code-cell-output pre.lively-code-cell-stderr");
      await expect(err).toContainText("Logo isn't built yet");
      await expect(err.locator(".lively-code-cell-errclass")).toHaveText("not built:");
      await expect(cell.locator(".lively-code-cell-status")).toHaveText("Error");
    });
  }
});

test.describe("output pane graphics scaffolding", () => {
  test("graphicsHost makes one canvas above the transcript and survives finish()", async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const U = lively.identity.postCardUtils;
      const el = document.createElement("div");
      el.className = "lively-code-cell-output";
      document.body.appendChild(el);
      const out = U.createTranscriptOutput(el);
      out.start();
      out.append([{ kind: "stdout", text: "hello\n" }]);
      const host1 = out.graphicsHost();
      const host2 = out.graphicsHost();
      out.finish("done", null);
      return {
        same: host1 === host2,
        firstChildIsGraphics: el.firstChild === host1,
        canvases: el.querySelectorAll("canvas").length,
        pres: el.querySelectorAll("pre").length,
        emptyNote: el.textContent.indexOf("Ran with no output") !== -1,
      };
    });
    expect(r).toEqual({ same: true, firstChildIsGraphics: true, canvases: 1, pres: 1, emptyNote: false });
  });

  test("a graphics-only run is not 'no output', and start() clears the canvas", async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const U = lively.identity.postCardUtils;
      const el = document.createElement("div");
      el.className = "lively-code-cell-output";
      document.body.appendChild(el);
      const out = U.createTranscriptOutput(el);
      out.start();
      out.graphicsHost();
      out.finish("done", null);
      const kept = el.querySelectorAll("canvas").length;
      out.start();
      return { kept, afterStart: el.querySelectorAll("canvas").length, emptyNote: el.textContent.indexOf("Ran with no output") !== -1 };
    });
    expect(r).toEqual({ kept: 1, afterStart: 0, emptyNote: false });
  });

  test("a pane that never asks for graphics renders exactly as before (scheme and ml)", async ({ page }) => {
    await boot(page);
    const html = await page.evaluate(() => {
      const U = lively.identity.postCardUtils;
      const el = document.createElement("div");
      el.className = "lively-code-cell-output";
      document.body.appendChild(el);
      const out = U.createTranscriptOutput(el);
      out.start();
      out.append([{ kind: "value", text: "3" }, { kind: "stdout", text: "x\n" }, { kind: "error", errorClass: "e", text: "boom" }]);
      out.finish("error", null);
      return el.innerHTML;
    });
    expect(html).toBe(
      '<pre class="lively-code-cell-value">3</pre>' +
      '<pre class="lively-code-cell-stdout">x\n</pre>' +
      '<pre class="lively-code-cell-stderr"><span class="lively-code-cell-errclass">e:</span>boom</pre>'
    );
  });
});
