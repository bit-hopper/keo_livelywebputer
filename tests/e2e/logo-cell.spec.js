// @ts-check
const { test, expect } = require("@playwright/test");

// Logo and TPN code cells (LOGO.md sections 7 and 10): the registry rows, the shared controller, and the real worker (the
// engine bundle, time-sliced, posting segments and the turtle's draw operations). Phase 2 so far: the worker runs Logo;
// the cell pane does not draw the turtle yet, so the drawing is asserted on what the controller delivers (onDraw), not on
// pixels. A tpn cell goes through the same worker but TPN syntax itself arrives in Phase 3.
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

// Runs one cell through the controller; resolves {segments, draw, turtle, state, err}.
function runCell(page, source) {
  return page.evaluate((src) => new Promise((resolve) => {
    const W = lively.identity.LogoWorker;
    const segments = [], draw = [];
    let turtle = null;
    W.ensureReady((err) => {
      if (err) return resolve({ err: err.message });
      W.run(src, {
        onSegments: (s) => segments.push(...s),
        onDraw: (ops, t) => { draw.push(...ops); if (t) turtle = t; },
        onDone: (err, res) => resolve({ err: err && err.message, state: res && res.state, segments, draw, turtle }),
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

test.describe("LogoWorker controller (real worker)", () => {
  test("runs Logo: text comes back as segments and the turtle's drawing as draw operations", async ({ page }) => {
    await boot(page);
    const r = await runCell(page, "fd 100\nrt 90\nfd 50\nprint pos");
    expect(r.err).toBeFalsy();
    expect(r.state).toBe("done");
    expect(r.segments).toEqual([{ kind: "stdout", text: "50 100\n" }]);
    expect(r.draw.map((o) => o.op)).toEqual(["line", "line"]);
    expect(r.draw[0]).toMatchObject({ x1: 0, y1: 0, x2: 0, y2: 100, c: [255, 255, 255] });
    expect(r.turtle).toMatchObject({ x: 50, y: 100, heading: 90, shown: true });
    expect(await page.evaluate(() => lively.identity.LogoWorker.buildId)).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await page.evaluate(() => lively.identity.LogoWorker.isRunning())).toBe(false);
  });

  test("an error ends the cell, the workspace and the turtle survive it, and the next cell sees them", async ({ page }) => {
    await boot(page);
    const bad = await runCell(page, "setxy 3 4\nfoo\nfd 10");
    expect(bad.state).toBe("error");
    expect(bad.segments.some((s) => s.kind === "error" && s.text.includes("I don't know how"))).toBe(true);
    const next = await runCell(page, "print pos");
    expect(next.state).toBe("done");
    expect(next.segments).toEqual([{ kind: "stdout", text: "3 4\n" }]);
    // Every run reports the turtle, even one that draws nothing: the new cell pane needs to know where it is.
    expect(next.draw).toEqual([]);
    expect(next.turtle).toMatchObject({ x: 3, y: 4 });
  });

  test("Stop interrupts an endless drawing loop cooperatively and the workspace survives", async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => new Promise((resolve) => {
      const W = lively.identity.LogoWorker;
      let ops = 0, stopped = false;
      W.ensureReady(() => {
        W.run("to spin\nforever [fd 1 rt 1]\nend\nspin", {
          onDraw: (o) => { ops += o.length; if (ops > 50 && !stopped) { stopped = true; lively.identity.postCardUtils.stopCodeCell("logo"); } },
          onDone: (err, res) => resolve({ err: err && err.message, state: res && res.state, ops }),
        });
      });
    }));
    expect(r.err).toBeFalsy();
    expect(r.state).toBe("stopped");
    expect(r.ops).toBeGreaterThan(50);
    // Tier 1 only: the worker answered, so it was not terminated and the interpreter is still there.
    const after = await runCell(page, "print 2 + 2");
    expect(after.segments).toEqual([{ kind: "stdout", text: "4\n" }]);
  });

  test("reset answers with a fresh workspace, and Stop with nothing running does nothing", async ({ page }) => {
    await boot(page);
    await runCell(page, "to sq\nrepeat 4 [fd 10 rt 90]\nend\nsetxy 5 5");
    const err = await page.evaluate(() => new Promise((r) => lively.identity.LogoWorker.reset(r)));
    expect(err).toBeNull();
    expect(await page.evaluate(() => lively.identity.postCardUtils.stopCodeCell("logo"))).toBe(false);
    const r = await runCell(page, "print pos\nsq");
    expect(r.segments[0]).toEqual({ kind: "stdout", text: "0 0\n" });
    expect(r.state).toBe("error");
  });

  test("logo and tpn rows share the one controller and so the one workspace", async ({ page }) => {
    await boot(page);
    const same = await page.evaluate(() => {
      const U = lively.identity.postCardUtils;
      return U.codeCellLanguage("logo").controller === U.codeCellLanguage("tpn").controller;
    });
    expect(same).toBe(true);
    // A procedure defined by a run started as a tpn cell is callable from a logo cell. (TPN's own syntax is Phase 3: until
    // then the text is read as Logo.)
    const state = await page.evaluate(() => new Promise((resolve) => {
      lively.identity.postCardUtils.runCodeCell("to hello\nprint 42\nend", { onDone: (err, res) => resolve(err ? "err" : res.state) }, "tpn");
    }));
    expect(state).toBe("done");
    expect((await runCell(page, "hello")).segments).toEqual([{ kind: "stdout", text: "42\n" }]);
  });
});

test.describe("logo and tpn cells, read-only render", () => {
  for (const [language, badge, source, defined] of [
    ["logo", "🐢 Logo", "to sq :n\n  repeat 4 [fd :n rt 90]\nend", "sq defined"],
    // (TPN's own syntax is Phase 3; this text is also valid Logo, which is how the worker reads it for now.)
    ["tpn", "🐢 TPN", "TO HELLO\n  PRINT 3\nEND", "HELLO defined"],
  ]) {
    test(`${language}: badge, highlighted source, controls, and Run defines the procedure`, async ({ page }) => {
      await boot(page);
      await renderCell(page, { language, source });
      const cell = page.locator("#logo-host .lively-code-cell");
      await expect(cell).toHaveAttribute("data-language", language);
      await expect(cell.locator(".lively-code-cell-badge")).toHaveText(badge);
      await expect(cell.locator("pre.lively-code-cell-source .hljs-keyword").first()).toBeVisible();
      await expect(cell.locator(".lively-code-cell-reset-btn")).toHaveCount(1);
      await expect(cell.locator(".lively-code-cell-help")).toHaveCount(1);
      await cell.locator(".lively-code-cell-run-btn").click();
      await expect(cell.locator(".lively-code-cell-output")).toContainText(defined);
      await expect(cell.locator(".lively-code-cell-output pre.lively-code-cell-stderr")).toHaveCount(0);
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
