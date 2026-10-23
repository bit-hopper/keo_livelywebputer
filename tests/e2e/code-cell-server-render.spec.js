// @ts-check
// Server-side render of code cells on a real saved wiki page: a Python, a Scheme, an ML, a Logo, a TPN and a `cobol` cell
// (a language the build has no runtime for) are saved through the real editor, then the page is
// fetched with no cookies and no JavaScript, the way a crawler or a link preview sees it. The
// unknown language must come back as plain text with no Run button, never as Python.
//
// Registers one throwaway `hometest_*` account through a CDP virtual passkey and removes it through
// the account-deletion feature (helpers in wikiHelpers.js). A run leaves one RESERVED handle behind:
// prune with  DELETE FROM reserved_handles WHERE handle LIKE 'hometest\_%';
// Needs the dev server running at baseURL (not started by Playwright), restarted since the last edit
// to core/servers/*.js.
const { test, expect, request } = require("@playwright/test");
const { newAccount, deleteAccount, makePage } = require("./wikiHelpers");

test.setTimeout(180 * 1000);

test("saved page: known cells render with controls, an unknown language as plain text", async ({ browser, baseURL }) => {
  const handle = "hometest_c" + Math.random().toString(36).slice(2, 7);
  const acct = await newAccount(browser, handle);
  try {
    const objId = await makePage(acct.page, handle, "cell-render-e2e", [["placeholder"]]);
    await acct.page.evaluate(() => new Promise((res, rej) => {
      const w = /** @type {any} */ (window);
      const ed = w.__ed, PM = ed._ProseMirror(), v = ed.editorView;
      const cells = [
        { language: "python", source: "print(1)" },
        { language: "scheme", source: "(+ 1 2)" },
        { language: "sml", source: "(*# style: book *)\nfun f x = x + 1" },
        { language: "logo", source: "to sq :n\nrepeat 4 [fd :n rt 90]\nend" },
        { language: "tpn", source: "TO sq n\n  x <- 3\n  REPEAT 4" },
        { language: "cobol", source: "fun f x = <b>x</b>" },
      ];
      const doc = PM.model.Node.fromJSON(v.state.schema, { type: "doc", content: cells.map((attrs) => ({ type: "code_cell", attrs })) });
      v.dispatch(v.state.tr.replaceWith(0, v.state.doc.content.size, doc.content));
      ed._saveNow((e) => (e ? rej(e) : res(true)));
    }));

    // The saved envelope keeps the unknown language as written.
    const saved = await acct.page.evaluate(([h, o]) => /** @type {any} */ (window).__latestEnvelope(h, o), [handle, objId]);
    const attrs = saved.record.payload.snapshot.content.map((n) => n.attrs);
    expect(attrs.map((a) => a.language)).toEqual(["python", "scheme", "sml", "logo", "tpn", "cobol"]);

    // A fresh context: no cookies, so this is the public static page.
    const anon = await request.newContext({ baseURL: baseURL || "http://localhost:9001" });
    const res = await anon.get("/@" + handle + "/" + objId, { headers: { Accept: "text/html" } });
    expect(res.status()).toBe(200);
    const html = await res.text();
    await anon.dispose();

    // Isolate the four rendered cells.
    const cells = html.split('<div class="lively-code-cell lively-code-cell-node"').slice(1);
    expect(cells).toHaveLength(6);
    const [py, sc, ml, logo, tpn, cobol] = cells;

    expect(py).toContain('data-language="python"');
    expect(py).toContain("🐍 Python");
    expect(py).toContain("lively-code-cell-run-btn");
    expect(py).not.toContain("lively-code-cell-reset-btn");

    expect(sc).toContain('data-language="scheme"');
    expect(sc).toContain("λ Scheme");
    expect(sc).toContain("lively-code-cell-reset-btn");

    expect(ml).toContain('data-language="sml"');
    expect(ml).toContain("🐪 ML");
    expect(ml).toContain("lively-code-cell-run-btn");
    expect(ml).toContain("lively-code-cell-reset-btn");
    expect(ml).toContain("hljs-keyword");
    expect(ml).toContain('<span class="hljs-meta">(*# style: book *)</span>'); // a pragma, not a comment
    expect(ml).toContain('<div class="lively-code-cell-help">');
    expect(ml).toContain("(*# redundant: error|warning *)");
    expect(ml).not.toContain("this build doesn't have");

    // Logo and TPN have their own highlighting grammars, registered by IdentityServer.js at startup. A server that has not
    // been restarted since they were added renders both as plain text (no hljs- spans at all).
    expect(logo).toContain('data-language="logo"');
    expect(logo).toContain("🐢 Logo");
    expect(logo).toContain("hljs-keyword");
    expect(logo).toContain("hljs-variable"); // :n, which only the Logo grammar colours
    expect(logo).toContain("lively-code-cell-run-btn");
    expect(tpn).toContain('data-language="tpn"');
    expect(tpn).toContain("🐢 TPN");
    expect(tpn).toContain("hljs-keyword");
    expect(tpn).toContain("hljs-number");
    expect(tpn.split("lively-code-cell-output")[0]).not.toContain("hljs-variable"); // bare names are not variables to a highlighter

    expect(cobol).toContain('data-language="cobol"');
    expect(cobol).toContain('<span class="lively-code-cell-badge">cobol</span>');
    expect(cobol).toContain("fun f x = &lt;b&gt;x&lt;/b&gt;");
    expect(cobol).toContain("this build doesn't have");
    // Cut at this cell's own closing so a later cell's markup cannot satisfy these.
    const cobolOnly = cobol.split("lively-code-cell-output")[0];
    expect(cobolOnly).not.toMatch(/run-btn|stop-btn|reset-btn|lively-code-cell-status|hljs-/);

    // The saved page, opened in a browser, hydrates the ML cell and runs it.
    await acct.page.goto("/@" + handle + "/" + objId);
    const mlCell = acct.page.locator('.lively-code-cell[data-language="sml"]');
    await expect(mlCell.locator(".lively-code-cell-run-btn")).toBeVisible({ timeout: 30000 });
    await mlCell.locator(".lively-code-cell-run-btn").click();
    await expect(mlCell.locator(".lively-code-cell-output pre.lively-code-cell-value")).toHaveText("val f = fn : int -> int", { timeout: 30000 });
    await expect(mlCell.locator(".lively-code-cell-status")).toHaveText("Ran just now");
  } finally {
    await deleteAccount(acct);
    await acct.context.close();
  }
});
