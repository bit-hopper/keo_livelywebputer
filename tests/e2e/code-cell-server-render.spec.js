// @ts-check
// Server-side render of code cells on a real saved wiki page: a Python, a Scheme and an `cobol` cell
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
        { language: "cobol", source: "fun f x = <b>x</b>" },
      ];
      const doc = PM.model.Node.fromJSON(v.state.schema, { type: "doc", content: cells.map((attrs) => ({ type: "code_cell", attrs })) });
      v.dispatch(v.state.tr.replaceWith(0, v.state.doc.content.size, doc.content));
      ed._saveNow((e) => (e ? rej(e) : res(true)));
    }));

    // The saved envelope keeps the unknown language as written.
    const saved = await acct.page.evaluate(([h, o]) => /** @type {any} */ (window).__latestEnvelope(h, o), [handle, objId]);
    const attrs = saved.record.payload.snapshot.content.map((n) => n.attrs);
    expect(attrs.map((a) => a.language)).toEqual(["python", "scheme", "cobol"]);

    // A fresh context: no cookies, so this is the public static page.
    const anon = await request.newContext({ baseURL: baseURL || "http://localhost:9001" });
    const res = await anon.get("/@" + handle + "/" + objId, { headers: { Accept: "text/html" } });
    expect(res.status()).toBe(200);
    const html = await res.text();
    await anon.dispose();

    // Isolate the three rendered cells.
    const cells = html.split('<div class="lively-code-cell lively-code-cell-node"').slice(1);
    expect(cells).toHaveLength(3);
    const [py, sc, cobol] = cells;

    expect(py).toContain('data-language="python"');
    expect(py).toContain("🐍 Python");
    expect(py).toContain("lively-code-cell-run-btn");
    expect(py).not.toContain("lively-code-cell-reset-btn");

    expect(sc).toContain('data-language="scheme"');
    expect(sc).toContain("λ Scheme");
    expect(sc).toContain("lively-code-cell-reset-btn");

    expect(cobol).toContain('data-language="cobol"');
    expect(cobol).toContain('<span class="lively-code-cell-badge">cobol</span>');
    expect(cobol).toContain("fun f x = &lt;b&gt;x&lt;/b&gt;");
    expect(cobol).toContain("this build doesn't have");
    // Cut at this cell's own closing so a later cell's markup cannot satisfy these.
    const smlOnly = cobol.split("lively-code-cell-output")[0];
    expect(smlOnly).not.toMatch(/run-btn|stop-btn|reset-btn|lively-code-cell-status|hljs-/);
  } finally {
    await deleteAccount(acct);
    await acct.context.close();
  }
});
