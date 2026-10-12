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

  test("#lang tls fetches the library, which later cells keep and Reset drops", async ({ page }) => {
    await boot(page);
    const first = await runCell(page, "#lang tls\n(list (atom? 'a) (atom? '(a)) (add1 4))");
    expect(first.err).toBeFalsy();
    expect(first.state).toBe("done");
    expect(first.segments).toEqual([{ kind: "value", text: "(#t #f 5)" }]);

    // The library stays in the page's shared environment for later cells (no #lang line needed),
    // including its macros, and case/=> works.
    const second = await runCell(page, "(define (f l) (try out (if (null? l) (out 'none) (car l)) 'fallback))\n(list (f '(1 2)) (f '()) (case 3 ((3) => add1) (else 0)))");
    expect(second.state).toBe("done");
    expect(second.segments[second.segments.length - 1]).toEqual({ kind: "value", text: "(1 fallback 4)" });

    // A cell can redefine atom? without disturbing the rest.
    const third = await runCell(page, "(define (atom? x) 'mine) (atom? 1)");
    expect(third.segments[third.segments.length - 1]).toEqual({ kind: "value", text: "mine" });

    // Reset drops it; the next #lang tls cell loads it again.
    await page.evaluate(() => new Promise((r) => lively.identity.SchemeWorker.reset(r)));
    expect((await runCell(page, "(atom? 'a)")).state).toBe("error");
    const again = await runCell(page, "#lang tls\n(atom? 'a)");
    expect(again.segments).toEqual([{ kind: "value", text: "#t" }]);
  });

  test("a book-style program runs end to end in a cell", async ({ page }) => {
    await boot(page);
    const src = [
      "#lang tls",
      "(define Y (lambda (le) ((lambda (f) (f f)) (lambda (f) (le (lambda (x) ((f f) x)))))))",
      "(define len (Y (lambda (length) (lambda (l) (cond ((null? l) 0) (else (add1 (length (cdr l)))))))))",
      "(define rember-upto-last (lambda (a lat) (letcc skip (letrec ((R (lambda (lat) (cond ((null? lat) '()) ((eq? (car lat) a) (skip (R (cdr lat)))) (else (cons (car lat) (R (cdr lat)))))))) (R lat)))))",
      "(list (len '(a b c d)) (rember-upto-last 'r '(a r b r c d)))",
    ].join("\n");
    const r = await runCell(page, src);
    expect(r.state).toBe("done");
    expect(r.segments[r.segments.length - 1]).toEqual({ kind: "value", text: "(4 (c d))" });
  });

  test("#lang sicp fetches the library; nil and put/get persist across cells and Reset drops them", async ({ page }) => {
    await boot(page);
    const first = await runCell(page, "#lang sicp\n(list nil (null? nil) (get 'op '(a b)))");
    expect(first.err).toBeFalsy();
    expect(first.state).toBe("done");
    expect(first.segments).toEqual([{ kind: "value", text: "(() #t #f)" }]);

    // The table lives behind the library's procedures, so it is shared by every later cell.
    const second = await runCell(page, "(put 'op '(a b) 42)");
    expect(second.state).toBe("done");
    expect(second.segments).toEqual([]);
    const third = await runCell(page, "(list (get 'op '(a b)) (get 'op '(a c)))");
    expect(third.segments).toEqual([{ kind: "value", text: "(42 #f)" }]);

    // Reset drops the library; the next #lang sicp cell loads it again with an empty table.
    await page.evaluate(() => new Promise((r) => lively.identity.SchemeWorker.reset(r)));
    expect((await runCell(page, "nil")).state).toBe("error");
    const again = await runCell(page, "#lang sicp\n(list nil (get 'op '(a b)))");
    expect(again.segments).toEqual([{ kind: "value", text: "(() #f)" }]);
  });

  test("a register-machine simulator written in Scheme runs end to end in cells", async ({ page }) => {
    await boot(page);
    // The corpus file is served from the repo like any other static file.
    const corpus = await page.evaluate(async () => (await fetch("/tests/scheme/corpora/sicp-5-regs.scm")).text());
    expect(corpus).toContain("make-new-machine");
    const loadedCorpus = await runCell(page, corpus);
    expect(loadedCorpus.err).toBeFalsy();
    expect(loadedCorpus.state).toBe("done");
    expect(loadedCorpus.segments).toEqual([]);

    const r = await runCell(page, [
      "(list (run-machine gcd-machine '((a 206) (b 40)) 'a)",
      "      (run-machine fact-machine '((n 5)) 'val)",
      "      ((fact-machine 'stack) 'statistics)",
      "      (run-machine fib-machine '((n 15)) 'val))",
    ].join("\n"));
    expect(r.state).toBe("done");
    expect(r.segments).toEqual([{ kind: "value", text: "(2 120 (8 8) 610)" }]);

    // A loop longer than the recursion limit completes only with proper tail calls.
    const loop = await runCell(page, "(run-machine sum-machine '((n 100000)) 'total)");
    expect(loop.segments).toEqual([{ kind: "value", text: "5000050000" }]);

    const bad = await runCell(page, "(get-register-contents gcd-machine 'zzz)");
    expect(bad.state).toBe("error");
    expect(bad.segments.some((s) => s.kind === "error" && /Unknown register: zzz/.test(s.text))).toBe(true);
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
    expect(info.badge).toBe("λ Scheme");
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

// Live wiki editor helpers (ProseMirror NodeView). newCard works without a
// login; autosave/sync requests just 401 in the background.
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

// Real toolbar clicks: Template dropdown -> "<kind> code cell".
async function insertCodeCell(page, kind) {
  await page.locator('button[title="Template"]').click();
  await page.getByText(kind + " code cell", { exact: true }).click();
  await expect(page.locator(".lively-code-cell-node")).toHaveCount(1);
}
const insertSchemeCell = (page) => insertCodeCell(page, "Scheme");

async function setSource(page, text) {
  const ta = page.locator(".lively-code-cell-source");
  await ta.fill(text);
  await ta.blur();
}

// Clicks the Python confirm dialog's "Run" button (a morphic Button) with a real mouse click.
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

test.describe("Scheme cell in the wiki editor", () => {
  test("insert via the Template menu, run, shared state, Reset", async ({ page }) => {
    await openEditor(page);
    await insertSchemeCell(page);

    await expect(page.locator(".lively-code-cell-badge")).toContainText("Scheme");
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

  test("asks for confirmation, runs, shows output; Stop is visible while running", async ({ page }) => {
    test.setTimeout(150000);
    // The sleep keeps the run going long enough to see the Stop button.
    await hydratePython(page, "import time\ntime.sleep(3)\nprint('answer')\n6 * 7");
    await expect(page.locator("#py-host .lively-code-cell-badge")).toContainText("Python");
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

// ---- Paths that were previously unverified ----

test.describe("Previously unverified paths", () => {
  test("Python cell works through the live editor NodeView", async ({ page }) => {
    test.setTimeout(150000);
    await openEditor(page);
    await insertCodeCell(page, "Python");
    await expect(page.locator(".lively-code-cell-badge")).toContainText("Python");
    await expect(page.locator(".lively-code-cell-reset-btn")).toHaveCount(0);
    await setSource(page, "import time\ntime.sleep(3)\nprint('from editor')\n3 * 14");
    const lang = await page.evaluate(() => {
      let l = null;
      window.__wikiEd.editorView.state.doc.descendants((n) => { if (n.type.name === "code_cell") l = n.attrs.language; });
      return l;
    });
    expect(lang).toBe("python");
    await page.locator(".lively-code-cell-run-btn").click();
    await confirmRun(page);
    await expect(page.locator(".lively-code-cell-stop-btn")).toBeVisible();
    await expect(page.locator(".lively-code-cell-output")).toContainText("from editor", { timeout: 120000 });
    await expect(page.locator(".lively-code-cell-output")).toContainText("42");
    await expect(page.locator(".lively-code-cell-status")).toHaveText("Ran just now");
    await expect(page.locator(".lively-code-cell-stop-btn")).toBeHidden();
  });

  test("Preview mode renders and runs the Scheme cell, and returns to editing", async ({ page }) => {
    await openEditor(page);
    await insertSchemeCell(page);
    await setSource(page, "(define pv 6)\n(* pv 7)");
    // The placeholder before any run.
    await expect(page.locator(".lively-code-cell-output")).toHaveText("Run to see output.");

    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const preview = page.locator(".lively-code-cell").last();
    await expect(preview.locator(".lively-code-cell-badge")).toContainText("Scheme");
    await expect(preview.locator(".lively-code-cell-reset-btn")).toBeVisible();
    await preview.locator(".lively-code-cell-run-btn").click();
    await expect(preview.locator("pre.lively-code-cell-value")).toHaveText("42");
    await expect(preview.locator(".lively-code-cell-status")).toHaveText("Ran just now");

    await page.getByRole("button", { name: "Continue Editing", exact: true }).click();
    await expect(page.locator(".lively-code-cell-node textarea.lively-code-cell-source")).toBeVisible();
    // Back in the editor the same shared environment is live.
    expect((await runCell(page, "pv")).segments[0].text).toBe("6");
  });

  test("a run with no output says so", async ({ page }) => {
    await openEditor(page);
    await insertSchemeCell(page);
    await setSource(page, "(define quiet 1)");
    await page.locator(".lively-code-cell-run-btn").click();
    await expect(page.locator(".lively-code-cell-output")).toHaveText("Ran with no output.");
  });

  test("Reset while a cell is running drops the run and gives a fresh environment", async ({ page }) => {
    await boot(page);
    await runCell(page, "(define old 1)");
    const r = await page.evaluate(() => new Promise((resolve) => {
      const W = lively.identity.SchemeWorker;
      W.run("(let loop () (loop))", {
        onDone: (err, res) => resolve({ err: err && err.message, state: res && res.state }),
      });
      setTimeout(() => W.reset(() => {}), 300);
    }));
    expect(r.state).toBe("stopped");
    expect((await runCell(page, "old")).state).toBe("error");
    // The worker is alive and usable after the reset.
    expect((await runCell(page, "(+ 1 2)")).segments[0].text).toBe("3");
  });

  test("output over the cap is truncated and the page stays usable", async ({ page }) => {
    await boot(page);
    const r = await runCell(page, '(let loop ((i 0)) (if (< i 200000) (begin (display "0123456789") (loop (+ i 1)))))');
    expect(r.state).toBe("done");
    const total = r.segments.filter((s) => s.kind === "stdout").reduce((n, s) => n + s.text.length, 0);
    expect(total).toBeLessThanOrEqual(1000000);
    expect(total).toBeGreaterThan(900000);
    expect(r.segments.some((s) => s.kind === "status" && /truncated/.test(s.text))).toBe(true);
    expect((await runCell(page, "(+ 1 1)")).segments[0].text).toBe("2");
  });

  test("Stop falls back to killing the worker when a native call never yields", async ({ page }) => {
    await boot(page);
    await runCell(page, "(define lost 1)");
    const r = await page.evaluate(() => new Promise((resolve) => {
      const W = lively.identity.SchemeWorker;
      W.STOP_GRACE_MS = 300;
      // One long native call (big-number printing) blocks the worker for over a second per iteration.
      W.run("(let loop ((i 0)) (if (< i 30) (begin (number->string (expt 7 1000000)) (loop (+ i 1)))))", {
        onDone: (err, res) => resolve({ err: err && err.message, state: res && res.state }),
      });
      setTimeout(() => W.interrupt(), 100);
    }));
    expect(r.err).toMatch(/did not respond to Stop/);
    // A fresh runtime comes up on the next run; the old environment is gone.
    expect((await runCell(page, "lost")).state).toBe("error");
    expect((await runCell(page, "(+ 20 42)")).segments[0].text).toBe("62");
  });
});

// Paren-aware source editing (SchemeEditing): driven with real key events,
// never `.value =`, so the keydown handlers and the browser's own edit path
// are what's under test.
test.describe("Scheme source editing", () => {
  async function focusedCell(page) {
    await openEditor(page);
    await insertSchemeCell(page);
    const ta = page.locator("textarea.lively-code-cell-source");
    await ta.click();
    return ta;
  }

  test("auto-closes brackets, overtypes closers, and Enter indents", async ({ page }) => {
    const ta = await focusedCell(page);
    await page.keyboard.type("(define (f x");
    await expect(ta).toHaveValue("(define (f x))");
    await page.keyboard.type(")");               // overtypes the auto-inserted closer
    await expect(ta).toHaveValue("(define (f x))");
    await page.keyboard.press("Enter");
    await expect(ta).toHaveValue("(define (f x)\n  )");
    await page.keyboard.type("(* x x");
    await page.keyboard.type(")");
    await expect(ta).toHaveValue("(define (f x)\n  (* x x))");
    // The edit reaches the document node through the normal debounced commit.
    await ta.blur();
    const src = await page.evaluate(() => {
      let s = null;
      window.__wikiEd.editorView.state.doc.descendants((n) => { if (n.type.name === "code_cell") s = n.attrs.source; });
      return s;
    });
    expect(src).toBe("(define (f x)\n  (* x x))");
    // and it runs
    await page.locator(".lively-code-cell-run-btn").click();
    await page.locator("textarea.lively-code-cell-source").click();
    await expect(page.locator(".lively-code-cell-status")).toHaveText("Ran just now");
    expect((await runCell(page, "(f 7)")).segments[0].text).toBe("49");
  });

  test("quotes pair, Backspace removes an empty pair, character literals are left alone", async ({ page }) => {
    const ta = await focusedCell(page);
    await page.keyboard.type('(display "hi');
    await expect(ta).toHaveValue('(display "hi")');   // only the "(" is auto-closed; the quote paired inside it
    await page.keyboard.type('"');                    // overtypes the closing quote
    await page.keyboard.press("Backspace");           // removes the quote just typed (not a pair)
    await ta.fill("");
    await page.keyboard.type("()");
    await expect(ta).toHaveValue("()");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Backspace");           // empty pair -> both go
    await expect(ta).toHaveValue("");
    const charLit = "#" + String.fromCharCode(92) + "(";   // the character literal #\(
    await page.keyboard.type(charLit);                // no auto-close after #\
    await expect(ta).toHaveValue(charLit);
    await page.keyboard.type(" ; (");                 // inside a comment: no auto-close
    await expect(ta).toHaveValue(charLit + " ; (");
  });

  test("Tab re-indents the selected lines; Ctrl+Z undoes it as one step", async ({ page }) => {
    const ta = await focusedCell(page);
    const messy = "(define (fact n)\n(if (= n 0)\n1\n(* n\n(fact (- n 1)))))";
    await ta.fill(messy);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Tab");
    await expect(ta).toHaveValue("(define (fact n)\n  (if (= n 0)\n      1\n      (* n\n         (fact (- n 1)))))");
    await page.keyboard.press("Control+z");
    await expect(ta).toHaveValue(messy);
  });

  test("Tab on a single line indents just that line and keeps the caret in place", async ({ page }) => {
    const ta = await focusedCell(page);
    await ta.fill("(foo a\nb)");
    await page.keyboard.press("Control+End");
    await page.keyboard.press("ArrowLeft");          // between b and )
    await page.keyboard.press("Tab");
    await expect(ta).toHaveValue("(foo a\n     b)");
    await page.keyboard.type("X");
    await expect(ta).toHaveValue("(foo a\n     bX)");
  });

  test("the bracket next to the caret and its partner are highlighted", async ({ page }) => {
    const ta = await focusedCell(page);
    await ta.fill("(a (b) c)");
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowRight");         // just after the first "("
    const marks = page.locator(".lively-code-cell-backdrop-inner mark");
    await expect(marks).toHaveCount(2);
    await expect(marks.nth(0)).toHaveText("(");
    await expect(marks.nth(1)).toHaveText(")");
    // The marks sit exactly over the characters they highlight: same left offset
    // as the textarea's text, one cell per column.
    const geo = await page.evaluate(() => {
      const t = document.querySelector("textarea.lively-code-cell-source").getBoundingClientRect();
      const ms = [...document.querySelectorAll(".lively-code-cell-backdrop-inner mark")].map((m) => m.getBoundingClientRect());
      return { taLeft: t.left, taTop: t.top, m0: ms[0].left, m1: ms[1].left, w: ms[0].width, mTop: ms[0].top, mH: ms[0].height };
    });
    expect(Math.abs(geo.m0 - (geo.taLeft + 16))).toBeLessThan(1.5);          // padding-left
    expect(Math.abs((geo.m1 - geo.m0) - 8 * geo.w)).toBeLessThan(1.5);       // ")" is at column 8
    // vertically the mark is centred on the first text line (14px padding, 1.55 * 13px line box)
    expect(Math.abs((geo.mTop + geo.mH / 2) - (geo.taTop + 14 + (1.55 * 13) / 2))).toBeLessThan(2);
    if (process.env.SCHEME_SHOT) await page.locator(".lively-code-cell-node").screenshot({ path: process.env.SCHEME_SHOT });
    // moving away clears them; an unmatched bracket is flagged
    await page.keyboard.press("ArrowRight");
    await expect(marks).toHaveCount(0);
    await ta.fill("(a b");
    await page.keyboard.press("Control+Home");
    await expect(page.locator(".lively-code-cell-backdrop-inner mark.bad")).toHaveCount(1);
  });

  test("Escape and Shift+Tab are not trapped", async ({ page }) => {
    const ta = await focusedCell(page);
    await page.keyboard.type("(a");
    await page.keyboard.press("Shift+Tab");
    await expect(ta).not.toBeFocused();
    await ta.click();
    await page.keyboard.press("Escape");
    await expect(ta).not.toBeFocused();
  });

  test("a Python cell keeps its plain textarea (no brackets paired, Tab not trapped)", async ({ page }) => {
    await openEditor(page);
    await insertCodeCell(page, "Python");
    await expect(page.locator(".lively-code-cell-editwrap")).toHaveCount(0);
    const ta = page.locator("textarea.lively-code-cell-source");
    await ta.click();
    await page.keyboard.type("print(");
    await expect(ta).toHaveValue("print(");
  });
});
