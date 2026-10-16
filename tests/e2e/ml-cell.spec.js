// @ts-check
const { test, expect } = require("@playwright/test");

// ML (Standard ML) code cells: the worker/controller layer, the read-only (hydrated) cell UI and the cell inside the wiki
// editor. Boots blank.html (general-purpose world) and drives lively.identity.MLWorker / postCardUtils directly -- the same
// objects the wiki editor and viewer use.

async function boot(page) {
  await page.goto("/blank.html");
  await page.waitForFunction(() => typeof window.$world !== "undefined" && window.$world !== null, { timeout: 20000 });
  // The wiki pages load this bundle (window.hljs, KaTeX, ProseMirror); blank.html doesn't.
  await page.addScriptTag({ url: "/core/lib/postcard/postcard-runtime.js" });
  await page.evaluate(() => new Promise((resolve) => {
    lively.require("lively.identity.MLWorker", "lively.identity.PostCardUtils").toRun(resolve);
  }));
}

// Runs one cell through the controller; resolves {segments, state, err}.
function runCell(page, source) {
  return page.evaluate((src) => new Promise((resolve) => {
    const W = lively.identity.MLWorker;
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

const texts = (r) => r.segments.map((s) => s.kind + ":" + s.text);

// Puts a read-only rendering of one code_cell into the page and hydrates it.
async function renderCell(page, attrs) {
  await page.evaluate((a) => {
    const U = lively.identity.postCardUtils;
    const host = document.createElement("div");
    host.id = "ml-host";
    host.style.cssText = "position:fixed;left:0;top:60px;width:700px;background:#fff;z-index:99999";
    host.innerHTML = U.snapshotToHtml({ type: "doc", content: [{ type: "code_cell", attrs: a }] });
    document.body.appendChild(host);
    U.hydrateCodeCells(host);
  }, attrs);
}

test.describe("MLWorker controller", () => {
  test("runs cells, shares one environment, resets", async ({ page }) => {
    await boot(page);
    const first = await runCell(page, "datatype t = A | B of int;\nfun f(A) = 0 | f(B n) = n + 1;\nf(B 4);");
    expect(first.err).toBeFalsy();
    expect(first.state).toBe("done");
    expect(texts(first)).toEqual([
      "value:datatype t = A | B of int",
      "value:val f = fn : t -> int",
      "value:val it = 5 : int",
    ]);

    // A second cell sees the first cell's definitions.
    expect(texts(await runCell(page, "f(A);"))).toEqual(["value:val it = 0 : int"]);

    // Errors are reported with their class, and the environment survives them.
    const bad = await runCell(page, "f(true);");
    expect(bad.state).toBe("error");
    expect(bad.segments[0]).toMatchObject({ kind: "error", errorClass: "nonsense" });
    expect(texts(await runCell(page, "f(B 9);"))).toEqual(["value:val it = 10 : int"]);

    // An uncaught exception is meaningless and keeps what came before it.
    const exn = await runCell(page, "val ok = 1;\nval z = 1 div 0;");
    expect(exn.state).toBe("error");
    expect(exn.segments[exn.segments.length - 1]).toMatchObject({ kind: "error", errorClass: "exception", text: "uncaught exception Div" });
    expect(texts(await runCell(page, "ok;"))).toEqual(["value:val it = 1 : int"]);

    // Reset gives a fresh environment.
    await page.evaluate(() => new Promise((r) => lively.identity.MLWorker.reset(r)));
    expect((await runCell(page, "f(A);")).state).toBe("error");
  });

  test("Stop interrupts an endless loop and keeps the environment", async ({ page }) => {
    await boot(page);
    await runCell(page, "val keep = 42;\nfun loop(n) = loop(n + 1);");
    const stopped = await page.evaluate(() => new Promise((resolve) => {
      const W = lively.identity.MLWorker;
      const segments = [];
      W.run("val y = loop(0);", {
        onSegments: (s) => segments.push(...s),
        onDone: (err, res) => resolve({ err: err && err.message, state: res && res.state, segments }),
      });
      setTimeout(() => W.interrupt(), 300);
    }));
    expect(stopped.err).toBeFalsy();
    expect(stopped.state).toBe("stopped");
    expect(texts(await runCell(page, "keep;"))).toEqual(["value:val it = 42 : int"]);
  });

  test("a second run while one is active is refused", async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(() => new Promise((resolve) => {
      const W = lively.identity.MLWorker;
      W.ensureReady(() => {
        W.run("fun loop(n) = loop(n + 1); loop(0);", { onDone: () => {} });
        W.run("1;", { onDone: (err) => { W.interrupt(); resolve(err && err.message); } });
      });
    }));
    expect(result).toMatch(/still running/);
  });

  test("runaway recursion is reported and the next cell works", async ({ page }) => {
    await boot(page);
    await runCell(page, "fun run(n) = 1 + run(n + 1);");
    const r = await runCell(page, "run(0);");
    expect(r.state).toBe("error");
    expect(r.segments[0]).toMatchObject({ kind: "error", errorClass: "limit" });
    expect(texts(await runCell(page, "1 + 1;"))).toEqual(["value:val it = 2 : int"]);
  });

  test("signatures, structures and functors run in a cell, with signature nonsense reported", async ({ page }) => {
    await boot(page);
    const r = await runCell(page, [
      "signature N = sig type number val succ : number -> number val reveal : number -> int val zero : number end;",
      "functor Mk() :> N = struct type number = int fun succ(n) = n + 1 fun reveal(n) = n val zero = 0 end;",
      "structure A = Mk();",
      "A.reveal(A.succ(A.succ(A.zero)));",
    ].join("\n"));
    expect(r.state).toBe("done");
    expect(texts(r).slice(-2)).toEqual(["value:structure A : N", "value:val it = 2 : int"]);
    const bad = await runCell(page, "A.succ(1);");
    expect(bad.state).toBe("error");
    expect(bad.segments[0]).toMatchObject({ kind: "error", errorClass: "signature" });
    expect(bad.segments[0].text).toContain("A.number is an abstract type");
  });

  test("lists, strings and print: stdout is its own segment, in order, before the echo", async ({ page }) => {
    await boot(page);
    const r = await runCell(page, [
      "val l = [3, 1, 2];",
      "print (\"n = \" ^ Int.toString (length l) ^ \"\\n\");",
      "map (fn x => x * 2) l;",
      "\"apple\" < \"banana\";",
      "fun first (x :: _) = x;",
      "hd [] ;",
    ].join("\n"));
    expect(r.state).toBe("error");
    expect(r.segments.map((s) => s.kind)).toEqual(["value", "stdout", "value", "value", "value", "warning", "value", "error"]);
    expect(r.segments[1].text).toBe("n = 3\n");
    expect(texts(r)[3]).toBe("value:val it = [6,2,4] : int list");
    expect(r.segments[5].text).toContain("first has no clause for []");
    expect(r.segments[7]).toMatchObject({ errorClass: "exception", text: "uncaught exception Empty" });
    // the basis is shared state: what a list cell defined is there for the next one
    expect(texts(await runCell(page, "first l;"))).toEqual(["value:val it = 3 : int"]);
  });

  test("a print loop is stopped with output flowing, and the page keeps working", async ({ page }) => {
    await boot(page);
    const stopped = await page.evaluate(() => new Promise((resolve) => {
      const W = lively.identity.MLWorker;
      let chars = 0;
      W.ensureReady(() => {
        W.run("fun loop n = (print \"xxxxxxxxxx\"; loop (n + 1)); loop 0;", {
          onSegments: (s) => s.forEach((x) => { if (x.kind === "stdout") chars += x.text.length; }),
          onDone: (err, res) => resolve({ err: err && err.message, state: res && res.state, chars, last: res && res.segments && res.segments.map((x) => x.kind + ":" + x.text) }),
        });
        setTimeout(() => W.interrupt(), 400);
      });
    }));
    expect(stopped.err).toBeFalsy();
    expect(stopped.state).toBe("stopped");
    expect(stopped.chars).toBeGreaterThan(0);
    expect(texts(await runCell(page, "1 + 1;"))).toEqual(["value:val it = 2 : int"]);
  });

  test("the bundle reports a build id", async ({ page }) => {
    await boot(page);
    await runCell(page, "1;");
    expect(await page.evaluate(() => lively.identity.MLWorker.buildId)).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

test.describe("read-only ML cell", () => {
  test("highlights, runs with no confirm, shows book-style output, supports Reset", async ({ page }) => {
    await boot(page);
    await renderCell(page, { language: "sml", source: "datatype 'a pizza = Bottom | Topping of ('a * ('a pizza));\nTopping(1, Bottom);\n(* a comment *)" });
    const cell = page.locator("#ml-host .lively-code-cell");
    await expect(cell).toHaveAttribute("data-language", "sml");
    await expect(cell.locator(".lively-code-cell-badge")).toHaveText("🐪 ML");
    await expect(cell.locator(".lively-code-cell-reset-btn")).toHaveCount(1);
    await expect(cell.locator("pre.lively-code-cell-source .hljs-keyword").first()).toBeVisible();

    await page.click("#ml-host .lively-code-cell-run-btn");
    const out = page.locator("#ml-host .lively-code-cell-output");
    await expect(out.locator("pre.lively-code-cell-value")).toHaveText([
      "datatype α pizza = Bottom | Topping of (α * (α pizza))",
      "val it = Topping(1,Bottom) : int pizza",
    ]);
    await expect(page.locator("#ml-host .lively-code-cell-status")).toHaveText("Ran just now");

    // The datatype lives on in the shared environment; Reset drops it.
    expect(texts(await runCell(page, "Bottom;"))).toEqual(["value:val it = Bottom : α pizza"]);
    await page.click("#ml-host .lively-code-cell-reset-btn");
    await expect(page.locator("#ml-host .lively-code-cell-status")).toHaveText("Environment reset");
    expect((await runCell(page, "Bottom;")).state).toBe("error");
  });

  test("print output shows as plain text above the echo, and strings are highlighted", async ({ page }) => {
    await boot(page);
    await renderCell(page, { language: "sml", source: "print \"hello\\n\";\n[1, 2, 3] @ [4];\n\"abc\" ^ \"def\";" });
    const src = page.locator("#ml-host pre.lively-code-cell-source");
    await expect(src.locator(".hljs-string")).toHaveCount(3);
    await page.click("#ml-host .lively-code-cell-run-btn");
    const out = page.locator("#ml-host .lively-code-cell-output");
    await expect(out.locator("pre.lively-code-cell-stdout")).toHaveText("hello");
    await expect(out.locator("pre.lively-code-cell-value")).toHaveText([
      "val it = () : unit",
      "val it = [1,2,3,4] : int list",
      "val it = \"abcdef\" : string",
    ]);
    // the order on the page is the order of the program: the print comes before the first echo
    expect(await out.locator("pre").evaluateAll((els) => els.map((e) => e.className.replace("lively-code-cell-", "")))).toEqual(["stdout", "value", "value", "value"]);
  });

  test("pragma lines and the book's glyphs are coloured, and a help line sits under the cell", async ({ page }) => {
    await boot(page);
    await renderCell(page, { language: "sml", source: "(*# style: sml *)\n(* plain comment *)\n• f : α → α\n⊗ val x = … ;" });
    const src = page.locator("#ml-host pre.lively-code-cell-source");
    await expect(src.locator(".hljs-meta").filter({ hasText: "(*# style: sml *)" })).toHaveCount(1);
    await expect(src.locator(".hljs-comment")).toHaveText(["(* plain comment *)"]);
    await expect(src.locator(".hljs-meta").filter({ hasText: /^[•⊗]$/ })).toHaveCount(2);
    await expect(src.locator(".hljs-keyword", { hasText: "→" })).toHaveCount(1);
    await expect(src.locator(".hljs-symbol", { hasText: "α" })).toHaveCount(2);
    await expect(src.locator(".hljs-literal", { hasText: "…" })).toHaveCount(1);
    const help = page.locator("#ml-host .lively-code-cell-help");
    await expect(help).toHaveCount(1);
    await expect(help).toContainText("→ ⇒ ▷ for -> => :>");
    await expect(help).toContainText("(*# verdicts: on|off *)");
    // below the output pane, and still there after a run
    expect(await page.evaluate(() => document.querySelector("#ml-host .lively-code-cell-output").nextElementSibling.className)).toBe("lively-code-cell-help");
    await page.click("#ml-host .lively-code-cell-run-btn");
    await expect(page.locator("#ml-host .lively-code-cell-status")).not.toHaveText("Running…");
    await expect(help).toHaveCount(1);
  });

  test("errors carry their class label, warnings and verdicts their own style", async ({ page }) => {
    await boot(page);
    await renderCell(page, {
      language: "sml",
      source: "datatype t = A | B;\nfun f(A) = 1;\n(f : t -> int);\n(f : t -> bool);\n⊗ val fine = 1;\nf(5);",
    });
    await page.click("#ml-host .lively-code-cell-run-btn");
    const out = page.locator("#ml-host .lively-code-cell-output");
    await expect(out.locator("pre.lively-code-cell-warn")).toContainText("f has no clause for B");
    await expect(out.locator("pre.lively-code-cell-tone-ok")).toContainText("✓ exactly: f : t -> int");
    await expect(out.locator("pre.lively-code-cell-tone-bad").first()).toContainText("✗ nonsense");
    await expect(out.locator("pre.lively-code-cell-tone-bad").nth(1)).toContainText("✗ accepted");
    const err = out.locator("pre.lively-code-cell-stderr");
    await expect(err.locator(".lively-code-cell-errclass")).toHaveText("nonsense:");
    await expect(err).toContainText("f consumes t, but was given int");
    await expect(page.locator("#ml-host .lively-code-cell-status")).toHaveText("Error");
  });

  test("Stop on an endless loop, then the page keeps working", async ({ page }) => {
    await boot(page);
    await renderCell(page, { language: "sml", source: "val seen = 1;\nfun loop(n) = loop(n + 1);\nval y = loop(0);" });
    await page.click("#ml-host .lively-code-cell-run-btn");
    const stop = page.locator("#ml-host .lively-code-cell-stop-btn");
    await expect(page.locator("#ml-host .lively-code-cell-status")).toHaveText("Running…");
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(page.locator("#ml-host .lively-code-cell-status")).toHaveText("Stopped");
    await expect(page.locator("#ml-host .lively-code-cell-run-btn")).toBeVisible();
    expect(texts(await runCell(page, "seen;"))).toEqual(["value:val it = 1 : int"]);
  });
});

// ---- inside the wiki editor ----------------------------------------------------------------------------------------

async function openEditor(page) {
  await boot(page);
  await page.evaluate(() => new Promise((r) => lively.require("lively.identity.WikiEditor").toRun(r)));
  await page.evaluate(async () => {
    const ed = lively.identity.WikiEditor.newCard("tester", { wikiName: "ml-e2e" });
    window.__wikiEd = ed;
    for (let i = 0; i < 100 && !ed.editorView; i++) await new Promise((r) => setTimeout(r, 100));
    if (!ed.editorView) throw new Error("editor did not mount");
    ed.setPosition(lively.pt(30, 70));
  });
}

test.describe("ML cell in the wiki editor", () => {
  test("the Template menu inserts one; it runs and its source edit reaches the document", async ({ page }) => {
    await openEditor(page);
    await page.locator('button[title="Template"]').click();
    await page.getByText("ML code cell", { exact: true }).click();
    const cell = page.locator(".lively-code-cell-node");
    await expect(cell).toHaveCount(1);
    await expect(cell).toHaveAttribute("data-language", "sml");
    await expect(cell.locator(".lively-code-cell-badge")).toHaveText("🐪 ML");
    await expect(cell.locator(".lively-code-cell-help")).toContainText("Pragmas: (*# style: book|sml *)");

    const ta = cell.locator("textarea");
    await ta.fill("fun sq(x) = x * x;\nsq(12);");
    await ta.blur();
    const doc = await page.evaluate(() => {
      const out = [];
      window.__wikiEd.editorView.state.doc.descendants((n) => { if (n.type.name === "code_cell") out.push({ lang: n.attrs.language, src: n.attrs.source }); });
      return out;
    });
    expect(doc).toEqual([{ lang: "sml", src: "fun sq(x) = x * x;\nsq(12);" }]);

    await cell.locator(".lively-code-cell-run-btn").click();
    await expect(cell.locator(".lively-code-cell-output pre.lively-code-cell-value")).toHaveText([
      "val sq = fn : int -> int",
      "val it = 144 : int",
    ]);
  });
});
