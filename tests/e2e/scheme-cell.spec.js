// @ts-check
const { test, expect } = require("@playwright/test");

// Scheme code cells: the worker/controller layer and the read-only
// (hydrated) cell UI. Boots blank.html (general-purpose world; welcome.html is
// only for login flows) and drives lively.identity.SchemeWorker /
// postCardUtils directly -- the same objects the wiki editor and viewer use.

async function boot(page) {
  await page.goto("/blank.html");
  await page.waitForFunction(() => typeof window.$world !== "undefined" && window.$world !== null, { timeout: 20000 });
  // The wiki pages load this bundle (window.hljs, KaTeX, ProseMirror); blank.html doesn't.
  await page.addScriptTag({ url: "/core/lib/postcard/postcard-runtime.js" });
  await page.evaluate(() => new Promise((resolve) => {
    lively.require("lively.identity.SchemeWorker", "lively.identity.PostCardUtils").toRun(resolve);
  }));
}

// Runs one cell through the controller; resolves {segments, state, err, inputs}.
// opts.onInput(provide) is called when the cell asks for a line.
function runCell(page, source) {
  return page.evaluate((src) => new Promise((resolve) => {
    const W = lively.identity.SchemeWorker;
    const segments = [];
    W.ensureReady((err) => {
      if (err) return resolve({ err: err.message });
      W.run(src, {
        onSegments: (s) => segments.push(...s),
        onNeedInput: () => { segments.push({ kind: "needInput" }); W.provideInput("typed line"); },
        onDone: (err, res) => resolve({ err: err && err.message, state: res && res.state, segments }),
      });
    });
  }), source);
}

test.describe("SchemeWorker controller", () => {
  test("runs cells, shares one environment, resets", async ({ page }) => {
    await boot(page);

    const first = await runCell(page, '(define x 5) (display "hi") (newline) (* x 2)');
    expect(first.err).toBeFalsy();
    expect(first.state).toBe("done");
    const text = first.segments.map((s) => s.kind + ":" + s.text);
    expect(text).toEqual(["stdout:hi\n", "value:10"]);

    // A second cell sees the first cell's definition.
    const second = await runCell(page, "(+ x 1)");
    expect(second.segments).toEqual([{ kind: "value", text: "6" }]);

    // Errors are reported, the environment survives them.
    const bad = await runCell(page, "(car 5)");
    expect(bad.state).toBe("error");
    expect(bad.segments.some((s) => s.kind === "error")).toBe(true);
    expect((await runCell(page, "x")).segments[0].text).toBe("5");

    // Reset gives a fresh environment.
    await page.evaluate(() => new Promise((r) => lively.identity.SchemeWorker.reset(r)));
    const afterReset = await runCell(page, "x");
    expect(afterReset.state).toBe("error");
  });

  test("Stop interrupts an endless loop and keeps the environment", async ({ page }) => {
    await boot(page);
    await runCell(page, "(define keep 42)");

    const stopped = await page.evaluate(() => new Promise((resolve) => {
      const W = lively.identity.SchemeWorker;
      const segments = [];
      W.run("(let loop () (loop))", {
        onSegments: (s) => segments.push(...s),
        onDone: (err, res) => resolve({ err: err && err.message, state: res && res.state, segments }),
      });
      setTimeout(() => W.interrupt(), 300);
    }));
    expect(stopped.err).toBeFalsy();
    expect(stopped.state).toBe("stopped");

    const after = await runCell(page, "keep");
    expect(after.segments).toEqual([{ kind: "value", text: "42" }]);
  });

  test("read-line pauses for input and resumes", async ({ page }) => {
    await boot(page);
    const r = await runCell(page, '(define s (read-line)) (string-append "got: " s)');
    expect(r.state).toBe("done");
    expect(r.segments.map((s) => s.kind)).toContain("needInput");
    expect(r.segments[r.segments.length - 1]).toEqual({ kind: "value", text: '"got: typed line"' });
  });

  test("a second run while one is active is refused", async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(() => new Promise((resolve) => {
      const W = lively.identity.SchemeWorker;
      W.ensureReady(() => {
        W.run("(let loop () (loop))", { onDone: () => {} });
        W.run("1", { onDone: (err) => { W.interrupt(); resolve(err && err.message); } });
      });
    }));
    expect(result).toMatch(/still running/);
  });

  test("unknown #lang is reported", async ({ page }) => {
    await boot(page);
    const r = await runCell(page, "#lang nosuchbook\n1");
    expect(r.state).toBe("error");
    expect(r.segments[0].text).toMatch(/Unknown #lang/);
  });
});

test.describe("read-only Scheme cell", () => {
  test("highlights, runs, streams output and supports Reset", async ({ page }) => {
    await boot(page);

    const info = await page.evaluate(() => {
      const U = lively.identity.postCardUtils;
      const host = document.createElement("div");
      host.id = "scheme-host";
      host.style.cssText = "position:fixed;left:0;top:0;width:600px;background:#fff;z-index:99999";
      host.innerHTML = U.snapshotToHtml({
        type: "doc",
        content: [{ type: "code_cell", attrs: { language: "scheme", source: "(define (sq x) (* x x))\n(display \"sq: \")\n(sq 7)" } }],
      });
      document.body.appendChild(host);
      U.hydrateCodeCells(host);
      return {
        badge: host.querySelector(".lively-code-cell-badge").textContent,
        lang: host.querySelector(".lively-code-cell").getAttribute("data-language"),
        hasReset: !!host.querySelector(".lively-code-cell-reset-btn"),
        highlighted: !!host.querySelector(".lively-code-cell-source .hljs-keyword, .lively-code-cell-source .hljs-name, .lively-code-cell-source .hljs-built_in"),
        hasSchemeGrammar: !!(window.hljs && window.hljs.getLanguage("scheme")),
      };
    });
    expect(info.badge).toBe("Scheme");
    expect(info.lang).toBe("scheme");
    expect(info.hasReset).toBe(true);
    expect(info.hasSchemeGrammar).toBe(true);
    expect(info.highlighted).toBe(true);

    // No confirm dialog: a plain click runs it.
    await page.click("#scheme-host .lively-code-cell-run-btn");
    const out = page.locator("#scheme-host .lively-code-cell-output");
    await expect(out).toContainText("sq: ");
    await expect(out.locator("pre.lively-code-cell-value")).toHaveText("49");
    await expect(page.locator("#scheme-host .lively-code-cell-status")).toHaveText("Ran just now");

    // The definition lives on in the shared environment; Reset drops it.
    expect(await runCell(page, "(sq 3)").then((r) => r.segments[0].text)).toBe("9");
    await page.click("#scheme-host .lively-code-cell-reset-btn");
    await expect(page.locator("#scheme-host .lively-code-cell-status")).toHaveText("Environment reset");
    expect((await runCell(page, "(sq 3)")).state).toBe("error");
  });

  test("Stop on an endless loop, then the page keeps working", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const U = lively.identity.postCardUtils;
      const host = document.createElement("div");
      host.id = "scheme-host";
      host.style.cssText = "position:fixed;left:0;top:0;width:600px;background:#fff;z-index:99999";
      host.innerHTML = U.snapshotToHtml({
        type: "doc",
        content: [{ type: "code_cell", attrs: { language: "scheme", source: "(define seen 1)\n(let loop () (loop))" } }],
      });
      document.body.appendChild(host);
      U.hydrateCodeCells(host);
    });
    await page.click("#scheme-host .lively-code-cell-run-btn");
    const stop = page.locator("#scheme-host .lively-code-cell-stop-btn");
    await expect(page.locator("#scheme-host .lively-code-cell-status")).toHaveText("Running…");
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(page.locator("#scheme-host .lively-code-cell-status")).toHaveText("Stopped");
    await expect(page.locator("#scheme-host .lively-code-cell-run-btn")).toBeVisible();
    const after = await runCell(page, "seen");
    expect(JSON.stringify(after)).toContain("\"text\":\"1\"");
  });

  test("inline input box answers a read-line", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const U = lively.identity.postCardUtils;
      const host = document.createElement("div");
      host.id = "scheme-host";
      host.style.cssText = "position:fixed;left:0;top:0;width:600px;background:#fff;z-index:99999";
      host.innerHTML = U.snapshotToHtml({
        type: "doc",
        content: [{ type: "code_cell", attrs: { language: "scheme", source: "(string-append \"hello \" (read-line))" } }],
      });
      document.body.appendChild(host);
      U.hydrateCodeCells(host);
    });
    await page.click("#scheme-host .lively-code-cell-run-btn");
    const input = page.locator("#scheme-host .lively-code-cell-input-row input");
    await expect(input).toBeVisible();
    await input.fill("world");
    await input.press("Enter");
    await expect(page.locator("#scheme-host .lively-code-cell-output pre.lively-code-cell-value")).toHaveText('"hello world"');
  });

  test("Stop clicked while the engine is still loading cancels the run", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const U = lively.identity.postCardUtils;
      const host = document.createElement("div");
      host.id = "scheme-host";
      host.style.cssText = "position:fixed;left:0;top:0;width:600px;background:#fff;z-index:99999";
      host.innerHTML = U.snapshotToHtml({
        type: "doc",
        content: [{ type: "code_cell", attrs: { language: "scheme", source: "(define late 1)" } }],
      });
      document.body.appendChild(host);
      U.hydrateCodeCells(host);
    });
    // Same tick: Run, then Stop while the worker is still starting up.
    await page.evaluate(() => {
      const host = document.getElementById("scheme-host");
      host.querySelector(".lively-code-cell-run-btn").click();
      host.querySelector(".lively-code-cell-stop-btn").click();
    });
    await expect(page.locator("#scheme-host .lively-code-cell-status")).toHaveText("Stopped");
    await expect(page.locator("#scheme-host .lively-code-cell-run-btn")).toBeVisible();
    // Nothing ran, and the page is not stuck "running".
    expect((await runCell(page, "late")).state).toBe("error");
  });
});

// The live wiki editor (ProseMirror NodeView). newCard works without a login;
// autosave/sync requests just 401 in the background.
test.describe("Scheme cell in the wiki editor", () => {
  async function openEditor(page) {
    await boot(page);
    await page.evaluate(() => new Promise((r) => lively.require("lively.identity.WikiEditor").toRun(r)));
    await page.evaluate(async () => {
      const ed = lively.identity.WikiEditor.newCard("tester", { wikiName: "scheme-e2e" });
      window.__wikiEd = ed;
      for (let i = 0; i < 100 && !ed.editorView; i++) await new Promise((r) => setTimeout(r, 100));
      if (!ed.editorView) throw new Error("editor did not mount");
      ed.setPosition(lively.pt(30, 70));   // keep the toolbar clear of the world's menu bar
    });
  }

  async function insertSchemeCell(page) {
    // Real toolbar clicks: Template dropdown -> "Scheme code cell".
    await page.locator('button[title="Template"]').click();
    await page.getByText("Scheme code cell", { exact: true }).click();
    await expect(page.locator(".lively-code-cell-node")).toHaveCount(1);
  }

  async function setSource(page, text) {
    const ta = page.locator(".lively-code-cell-source");
    await ta.fill(text);
    await ta.blur();
  }

  test("insert via the Template menu, run, shared state, Reset", async ({ page }) => {
    await openEditor(page);
    await insertSchemeCell(page);

    await expect(page.locator(".lively-code-cell-badge")).toHaveText("Scheme");
    await expect(page.locator(".lively-code-cell-reset-btn")).toBeVisible();

    await setSource(page, "(define (fact n) (if (= n 0) 1 (* n (fact (- n 1)))))\n(display \"fact 20 = \")\n(fact 20)");
    // The edit is committed to the document node, not just the textarea.
    const saved = await page.evaluate(() => {
      let src = null, lang = null;
      window.__wikiEd.editorView.state.doc.descendants((n) => { if (n.type.name === "code_cell") { src = n.attrs.source; lang = n.attrs.language; } });
      return { src, lang };
    });
    expect(saved.lang).toBe("scheme");
    expect(saved.src).toContain("(define (fact n)");

    // No confirm dialog; a plain click on Run executes.
    await page.locator(".lively-code-cell-run-btn").click();
    const out = page.locator(".lively-code-cell-output");
    await expect(out).toContainText("fact 20 = ");
    await expect(out.locator("pre.lively-code-cell-value")).toHaveText("2432902008176640000");
    await expect(page.locator(".lively-code-cell-status")).toHaveText("Ran just now");

    // Definitions persist for the page...
    expect((await runCell(page, "(fact 5)")).segments[0].text).toBe("120");
    // ...until Reset.
    await page.locator(".lively-code-cell-reset-btn").click();
    await expect(page.locator(".lively-code-cell-status")).toHaveText("Environment reset");
    expect((await runCell(page, "(fact 5)")).state).toBe("error");
  });

  test("Stop an endless loop, then run again", async ({ page }) => {
    await openEditor(page);
    await insertSchemeCell(page);
    await setSource(page, "(define marker 7)\n(let loop () (loop))");
    await page.locator(".lively-code-cell-run-btn").click();
    await expect(page.locator(".lively-code-cell-status")).toHaveText("Running…");
    await page.locator(".lively-code-cell-stop-btn").click();
    await expect(page.locator(".lively-code-cell-status")).toHaveText("Stopped");
    await expect(page.locator(".lively-code-cell-run-btn")).toBeVisible();
    expect(JSON.stringify(await runCell(page, "marker"))).toContain('"text":"7"');
  });

  test("typing into the inline input box reaches the cell", async ({ page }) => {
    await openEditor(page);
    await insertSchemeCell(page);
    await setSource(page, '(string-append "hi, " (read-line))');
    await page.locator(".lively-code-cell-run-btn").click();
    const input = page.locator(".lively-code-cell-input-row input");
    await expect(input).toBeVisible();
    // Real key events, not .value= (see CLAUDE.md on native inputs in a morph).
    await input.click();
    await page.keyboard.type("Ada Lovelace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await expect(page.locator(".lively-code-cell-output pre.lively-code-cell-value")).toHaveText('"hi, Ada Lovelac"');
  });
});

// Python cells share code paths with the Scheme ones (run/stop dispatch,
// hydration, the Stop button's visibility), so they get a regression check too.
test.describe("Python cell is unchanged", () => {
  async function hydratePython(page, source) {
    await boot(page);
    await page.evaluate((src) => {
      const U = lively.identity.postCardUtils;
      const host = document.createElement("div");
      host.id = "py-host";
      host.style.cssText = "position:fixed;left:0;top:60px;width:600px;background:#fff;z-index:99999";
      host.innerHTML = U.snapshotToHtml({ type: "doc", content: [{ type: "code_cell", attrs: { language: "python", source: src } }] });
      document.body.appendChild(host);
      U.hydrateCodeCells(host);
    }, source);
  }

  // Clicks the confirm dialog's "Run" button (a morphic Button) with a real mouse click.
  async function confirmRun(page) {
    await page.waitForFunction(() => {
      let found = false;
      $world.withAllSubmorphsDo((m) => { if (m.label && m.label.textString === "Run") found = true; });
      return found;
    });
    const box = await page.evaluate(() => {
      let r = null;
      $world.withAllSubmorphsDo((m) => { if (m.label && m.label.textString === "Run") { const b = m.renderContext().shapeNode.getBoundingClientRect(); r = { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } });
      return r;
    });
    await page.mouse.click(box.x, box.y);
  }

  test("asks for confirmation, runs, shows output; Stop is visible while running", async ({ page }) => {
    test.setTimeout(150000);
    await hydratePython(page, "print('answer')\n6 * 7");
    await expect(page.locator("#py-host .lively-code-cell-badge")).toHaveText("Python");
    await expect(page.locator("#py-host .lively-code-cell-reset-btn")).toHaveCount(0);

    await page.locator("#py-host .lively-code-cell-run-btn").click();
    await confirmRun(page);
    // Stop is shown while the (slow, first-time) runtime loads and runs.
    await expect(page.locator("#py-host .lively-code-cell-stop-btn")).toBeVisible();
    await expect(page.locator("#py-host .lively-code-cell-output")).toContainText("answer", { timeout: 120000 });
    await expect(page.locator("#py-host .lively-code-cell-output")).toContainText("42");
    await expect(page.locator("#py-host .lively-code-cell-status")).toHaveText("Ran just now");
    await expect(page.locator("#py-host .lively-code-cell-stop-btn")).toBeHidden();
  });
});

