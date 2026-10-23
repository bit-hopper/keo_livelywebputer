// @ts-check
const { test, expect } = require("@playwright/test");
const hljs = require("highlight.js/lib/core");
hljs.registerLanguage("python", require("highlight.js/lib/languages/python"));
hljs.registerLanguage("scheme", require("highlight.js/lib/languages/scheme"));
hljs.registerLanguage("sml", require("highlight.js/lib/languages/sml"));
hljs.registerLanguage("logo", require("../../core/lib/logo/hljs-logo"));
hljs.registerLanguage("tpn", require("../../core/lib/logo/hljs-tpn"));
const { CODE_CELL_LANGUAGES, createCodeCellRenderer } = require("../../core/servers/identity/CodeCellRender");

// The code-cell language registry (PostCardUtils.js) and the places that read
// it: a language this build has no row for is shown as plain text with no Run
// button, never as Python; the server's copy of the table matches the client's.
// Boots blank.html (general-purpose world) and drives the same objects the wiki
// editor and viewer use.

async function boot(page) {
  await page.goto("/blank.html");
  await page.waitForFunction(() => typeof window.$world !== "undefined" && window.$world !== null, { timeout: 20000 });
  // The wiki pages load this bundle (window.hljs, KaTeX, ProseMirror); blank.html doesn't.
  await page.addScriptTag({ url: "/core/lib/postcard/postcard-runtime.js" });
  await page.evaluate(() => new Promise((resolve) => {
    lively.require("lively.identity.PostCardUtils").toRun(resolve);
  }));
}

// Puts a read-only rendering of one code_cell into the page and hydrates it.
async function renderCell(page, attrs) {
  await page.evaluate((a) => {
    const U = lively.identity.postCardUtils;
    const host = document.createElement("div");
    host.id = "cell-host";
    host.style.cssText = "position:fixed;left:0;top:60px;width:600px;background:#fff;z-index:99999";
    host.innerHTML = U.snapshotToHtml({ type: "doc", content: [{ type: "code_cell", attrs: a }] });
    document.body.appendChild(host);
    U.hydrateCodeCells(host);
  }, attrs);
}

test.describe("code-cell language registry (client)", () => {
  test("rows for the known languages; anything else is a stand-in, not Python", async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const U = lively.identity.postCardUtils;
      const pick = (d) => ({ id: d.id, known: d.known, label: d.label, output: d.output, hasReset: d.hasReset });
      return {
        list: U.codeCellLanguageList().map((d) => d.id),
        // The schema default: a missing or empty language is python.
        dflt: [undefined, null, ""].map((v) => U.codeCellLanguage(v).id),
        python: pick(U.codeCellLanguage("python")),
        scheme: pick(U.codeCellLanguage("scheme")),
        sml: pick(U.codeCellLanguage("sml")),
        logo: Object.assign(pick(U.codeCellLanguage("logo")), { graphics: U.codeCellLanguage("logo").graphics, controller: U.codeCellLanguage("logo").controller }),
        tpn: Object.assign(pick(U.codeCellLanguage("tpn")), { graphics: U.codeCellLanguage("tpn").graphics, controller: U.codeCellLanguage("tpn").controller }),
        noGraphics: ["python", "scheme", "sml"].map((id) => !!U.codeCellLanguage(id).graphics),
        cobol: pick(U.codeCellLanguage("cobol")),
        // Names that exist on every object must not resolve to a registry row.
        proto: ["constructor", "__proto__", "toString", "hasOwnProperty"].map((v) => U.codeCellLanguage(v).known),
        long: U.codeCellLanguage("x".repeat(100)).label.length,
      };
    });
    expect(r.list).toEqual(["python", "scheme", "sml", "logo", "tpn"]);
    expect(r.dflt).toEqual(["python", "python", "python"]);
    expect(r.python).toEqual({ id: "python", known: true, label: "🐍 Python", output: "python", hasReset: false });
    expect(r.scheme).toEqual({ id: "scheme", known: true, label: "λ Scheme", output: "transcript", hasReset: true });
    expect(r.sml).toEqual({ id: "sml", known: true, label: "🐪 ML", output: "transcript", hasReset: true });
    // Two rows, one controller (one interpreter per page serves both); only they carry a turtle canvas.
    const logoCtl = "lively.identity.LogoWorker";
    expect(r.logo).toEqual({ id: "logo", known: true, label: "🐢 Logo", output: "transcript", hasReset: true, graphics: true, controller: logoCtl });
    expect(r.tpn).toEqual({ id: "tpn", known: true, label: "🐢 TPN", output: "transcript", hasReset: true, graphics: true, controller: logoCtl });
    expect(r.noGraphics).toEqual([false, false, false]);
    expect(r.cobol).toEqual({ id: "cobol", known: false, label: "cobol", output: "none", hasReset: false });
    expect(r.proto).toEqual([false, false, false, false]);
    expect(r.long).toBe(41);
  });

  test("the badge tints come from the registry", async ({ page }) => {
    await boot(page);
    const css = await page.evaluate(() => document.getElementById("lively-postcard-media-style").textContent);
    expect(css).toContain('.lively-code-cell-node[data-language="python"] .lively-code-cell-badge{background:#fff4cc;color:#7a5600;border-color:#f3dc8a;}');
    expect(css).toContain('.lively-code-cell-node[data-language="scheme"] .lively-code-cell-badge{background:#ede7ff;color:#5233b5;border-color:#d6c9fb;}');
    expect(css).toContain('.lively-code-cell-node[data-language="sml"] .lively-code-cell-badge{background:#fff0e0;color:#8a4b00;border-color:#f5d3a8;}');
    expect(css).toContain('.lively-code-cell-node[data-language="logo"] .lively-code-cell-badge{background:#e3f6e8;color:#1d6b36;border-color:#b9e4c5;}');
    expect(css).toContain('.lively-code-cell-node[data-language="tpn"] .lively-code-cell-badge{background:#e0f4f6;color:#0e6573;border-color:#b3dfe5;}');
  });

  test("an unknown language never runs: no confirm dialog, no worker, Stop/Reset do nothing", async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => new Promise((resolve) => {
      const U = lively.identity.postCardUtils;
      const out = {};
      out.stop = U.stopCodeCell("cobol");
      U.resetCodeCell("cobol", (err) => { out.resetErr = err; });
      U.provideCodeCellInput("x", "cobol");
      U.runCodeCell("fun f x = x", { onDone: (err, res) => {
        out.runErr = err && err.message;
        out.runRes = res;
        let dialogs = 0;
        $world.withAllSubmorphsDo((m) => { if (m.label && m.label.textString === "Run") dialogs++; });
        out.dialogs = dialogs;
        out.pyodide = !!(lively.identity.PyodideWorker && lively.identity.PyodideWorker.isRunning && lively.identity.PyodideWorker.isRunning());
        resolve(out);
      } }, "cobol");
    }));
    expect(r.runErr).toMatch(/no runtime/);
    expect(r.runRes).toBeUndefined();
    expect(r.dialogs).toBe(0);
    expect(r.stop).toBe(false);
    expect(r.resetErr).toBeNull();
    expect(r.pyodide).toBe(false);
  });
});

test.describe("unknown language, read-only render", () => {
  test("plain source, the language as the badge, a note, and no Run button", async ({ page }) => {
    await boot(page);
    await renderCell(page, { language: "cobol", source: 'fun f x = x\n(* <b>not markup</b> *)' });
    const cell = page.locator("#cell-host .lively-code-cell");
    await expect(cell).toHaveAttribute("data-language", "cobol");
    await expect(cell.locator(".lively-code-cell-badge")).toHaveText("cobol");
    await expect(cell.locator(".lively-code-cell-run-btn, .lively-code-cell-stop-btn, .lively-code-cell-reset-btn, .lively-code-cell-status")).toHaveCount(0);
    await expect(cell.locator(".lively-code-cell-output")).toContainText("this build doesn't have");
    // The source is text, not highlighted markup and not parsed as HTML.
    await expect(cell.locator("pre.lively-code-cell-source")).toHaveText('fun f x = x\n(* <b>not markup</b> *)');
    await expect(cell.locator("pre.lively-code-cell-source b, pre.lively-code-cell-source [class^='hljs-']")).toHaveCount(0);
  });

  test("the language id is escaped", async ({ page }) => {
    await boot(page);
    const evil = '"><img src=x onerror="window.__pwned=1">';
    await renderCell(page, { language: evil, source: "1" });
    await expect(page.locator("#cell-host img")).toHaveCount(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    await expect(page.locator("#cell-host .lively-code-cell")).toHaveAttribute("data-language", evil);
  });

  test("known languages still render with their controls", async ({ page }) => {
    await boot(page);
    await renderCell(page, { language: "scheme", source: "(+ 1 2)" });
    const cell = page.locator("#cell-host .lively-code-cell");
    await expect(cell.locator(".lively-code-cell-badge")).toHaveText("λ Scheme");
    await expect(cell.locator(".lively-code-cell-reset-btn")).toHaveCount(1);
    await expect(cell.locator("pre.lively-code-cell-source .hljs-number")).toHaveCount(2);
  });

  test("a cell with no language attr is python", async ({ page }) => {
    await boot(page);
    await renderCell(page, { source: "print(1)" });
    const cell = page.locator("#cell-host .lively-code-cell");
    await expect(cell).toHaveAttribute("data-language", "python");
    await expect(cell.locator(".lively-code-cell-reset-btn")).toHaveCount(0);
    await expect(cell.locator(".lively-code-cell-run-btn")).toHaveCount(1);
  });
});

async function openEditor(page) {
  await boot(page);
  await page.evaluate(() => new Promise((r) => lively.require("lively.identity.WikiEditor").toRun(r)));
  await page.evaluate(async () => {
    const ed = lively.identity.WikiEditor.newCard("tester", { wikiName: "registry-e2e" });
    window.__wikiEd = ed;
    for (let i = 0; i < 100 && !ed.editorView; i++) await new Promise((r) => setTimeout(r, 100));
    if (!ed.editorView) throw new Error("editor did not mount");
    ed.setPosition(lively.pt(30, 70));   // keep the toolbar clear of the world's menu bar
  });
}

const setCell = (page, attrs) => page.evaluate((a) => {
  const v = window.__wikiEd.editorView;
  let pos = null, size = 0;
  v.state.doc.descendants((n, p) => { if (pos === null && n.type.name === "code_cell") { pos = p; size = n.nodeSize; } });
  const node = v.state.schema.nodes.code_cell.create(a);
  if (pos === null) v.dispatch(v.state.tr.insert(v.state.doc.content.size, node));
  else v.dispatch(v.state.tr.replaceWith(pos, pos + size, node));
}, attrs);

const cellState = (page) => page.evaluate(() => {
  const doc = [];
  window.__wikiEd.editorView.state.doc.descendants((n) => { if (n.type.name === "code_cell") doc.push({ lang: n.attrs.language, src: n.attrs.source }); });
  const view = [...document.querySelectorAll(".lively-code-cell-node")].map((c) => ({
    lang: c.getAttribute("data-language"),
    badge: c.querySelector(".lively-code-cell-badge").innerText,
    run: !!c.querySelector(".lively-code-cell-run-btn"),
    stop: !!c.querySelector(".lively-code-cell-stop-btn"),
    reset: !!c.querySelector(".lively-code-cell-reset-btn"),
    status: !!c.querySelector(".lively-code-cell-status"),
    src: c.querySelector("textarea").value,
    out: c.querySelector(".lively-code-cell-output").innerText,
  }));
  return { doc, view };
});

test.describe("unknown language in the wiki editor", () => {
  test("keeps its id and its editable source, with no way to run it", async ({ page }) => {
    await openEditor(page);
    await setCell(page, { language: "cobol", source: "val x = 1" });
    await expect(page.locator(".lively-code-cell-node")).toHaveCount(1);
    const s = await cellState(page);
    expect(s.doc).toEqual([{ lang: "cobol", src: "val x = 1" }]);
    expect(s.view).toHaveLength(1);
    expect(s.view[0]).toMatchObject({ lang: "cobol", badge: "cobol", run: false, stop: false, reset: false, status: false, src: "val x = 1" });
    expect(s.view[0].out).toContain("this build doesn't have");

    // The source stays editable and the edit reaches the document with the language intact.
    const ta = page.locator(".lively-code-cell-source");
    await ta.fill("val x = 2");
    await ta.blur();
    const after = await cellState(page);
    expect(after.doc).toEqual([{ lang: "cobol", src: "val x = 2" }]);
  });

  test("a cell that becomes a known language (or back) gets a fresh view", async ({ page }) => {
    await openEditor(page);
    await setCell(page, { language: "cobol", source: "x" });
    await setCell(page, { language: "scheme", source: "(+ 1 2)" });
    let s = await cellState(page);
    expect(s.view).toHaveLength(1);
    expect(s.view[0]).toMatchObject({ lang: "scheme", run: true, stop: true, reset: true, status: true });
    await setCell(page, { language: "cobol", source: "x" });
    s = await cellState(page);
    expect(s.view[0]).toMatchObject({ lang: "cobol", run: false, reset: false, status: false });
  });

  test("the Template menu lists one row per registry language", async ({ page }) => {
    await openEditor(page);
    await page.locator('button[title="Template"]').click();
    await expect(page.getByText("Python code cell", { exact: true })).toBeVisible();
    await expect(page.getByText("Scheme code cell", { exact: true })).toBeVisible();
    await expect(page.getByText("ML code cell", { exact: true })).toBeVisible();
    await expect(page.getByText("Logo code cell", { exact: true })).toBeVisible();
    await expect(page.getByText("Turtle Procedure Notation cell", { exact: true })).toBeVisible();
    await page.getByText("Scheme code cell", { exact: true }).click();
    const s = await cellState(page);
    expect(s.doc).toEqual([{ lang: "scheme", src: "" }]);
    expect(s.view[0]).toMatchObject({ badge: "λ Scheme", reset: true });
  });
});

test.describe("server-side render", () => {
  const render = createCodeCellRenderer({
    hljs,
    escapeHtml: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  });

  test("the server's table matches the client registry", async ({ page }) => {
    await boot(page);
    const client = await page.evaluate(() => lively.identity.postCardUtils.codeCellLanguageList()
      .map((d) => ({ id: d.id, label: d.label, hljsId: d.hljsId, hasReset: d.hasReset, help: d.help })));
    const server = Object.keys(CODE_CELL_LANGUAGES).map((id) => CODE_CELL_LANGUAGES[id]);
    expect(server).toEqual(client);
  });

  test("known languages render as before", () => {
    const py = render({ attrs: { language: "python", source: "print(1)" } });
    expect(py).toContain('data-language="python"');
    expect(py).toContain("🐍 Python");
    expect(py).toContain("lively-code-cell-run-btn");
    expect(py).not.toContain("lively-code-cell-reset-btn");
    const sc = render({ attrs: { language: "scheme", source: "(+ 1 2)" } });
    expect(sc).toContain("λ Scheme");
    expect(sc).toContain("lively-code-cell-reset-btn");
    expect(sc).toContain("hljs-number");
    const ml = render({ attrs: { language: "sml", source: "fun f x = x + 1" } });
    expect(ml).toContain('data-language="sml"');
    expect(ml).toContain("🐪 ML");
    expect(ml).toContain("lively-code-cell-reset-btn");
    expect(ml).toContain("hljs-keyword");
    expect(ml).toContain('<div class="lively-code-cell-help">');
    expect(ml).toContain("(*# style: book|sml *)");
    expect(ml).toContain("-&gt; =&gt; :&gt;");
    const lg = render({ attrs: { language: "logo", source: "to sq :n\n  repeat 4 [fd :n rt 90]\nend ; done" } });
    expect(lg).toContain('data-language="logo"');
    expect(lg).toContain("🐢 Logo");
    expect(lg).toContain("lively-code-cell-reset-btn");
    expect(lg).toContain("hljs-keyword");
    expect(lg).toContain("hljs-variable");
    expect(lg).toContain("hljs-comment");
    expect(lg).toContain('<div class="lively-code-cell-help">');
    const tp = render({ attrs: { language: "tpn", source: "TO POLY SIDE\n  X <- 2 ^ 3" } });
    expect(tp).toContain('data-language="tpn"');
    expect(tp).toContain("🐢 TPN");
    expect(tp).toContain("hljs-keyword");
    expect(tp).toContain("&lt;-");
    expect(sc).not.toContain("lively-code-cell-help");
    expect(py).not.toContain("lively-code-cell-help");
    // No language attr: the schema default.
    expect(render({ attrs: { source: "x" } })).toContain('data-language="python"');
    expect(render({})).toContain('data-language="python"');
  });

  test("an unknown language is plain text with a note and no controls", () => {
    const html = render({ attrs: { language: "cobol", source: "fun f x = <b>x</b>" } });
    expect(html).toContain('data-language="cobol"');
    expect(html).toContain('<span class="lively-code-cell-badge">cobol</span>');
    expect(html).toContain("fun f x = &lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("this build doesn't have");
    expect(html).not.toMatch(/run-btn|stop-btn|reset-btn|lively-code-cell-status/);
    expect(html).not.toContain("hljs-");
  });

  test("an unknown language id is escaped, and names on Object.prototype are not rows", () => {
    const evil = render({ attrs: { language: '"><img src=x>', source: "1" } });
    expect(evil).not.toContain("<img");
    expect(evil).toContain("&quot;&gt;&lt;img src=x&gt;");
    for (const name of ["constructor", "__proto__", "toString"]) {
      const html = render({ attrs: { language: name, source: "1" } });
      expect(html).toContain("this build doesn't have");
      expect(html).not.toContain("run-btn");
    }
  });
});
