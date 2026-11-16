// @ts-check
const { test, expect } = require("@playwright/test");

// The code cell is a TEXT BLOCK of the wiki editor: its code is the node's own content, edited like any other text, so what two
// people type into one cell merges character by character, a key press is in the document at once (no commit step), and the
// cell follows the editor's own rules for text blocks (Enter, Backspace, select-all, paste). It was an atom with a `source`
// attribute edited in a <textarea> outside the editor: last writer won (one of two concurrent edits was lost), and a
// collaborator saw typing only after a 600 ms debounce. These tests drive the real editor in blank.html (newCard needs no
// login; autosave and sync requests just 401 in the background). Scheme-specific editing is in scheme-cell.spec.js.

async function boot(page) {
  await page.goto("/blank.html");
  await page.waitForFunction(() => typeof window.$world !== "undefined" && window.$world !== null, { timeout: 20000 });
  // The wiki pages load this bundle (window.hljs, KaTeX, ProseMirror, Yjs); blank.html doesn't.
  await page.addScriptTag({ url: "/core/lib/postcard/postcard-runtime.js" });
  await page.evaluate(() => new Promise((resolve) => {
    lively.require("lively.identity.WikiEditor", "lively.identity.WikiSerializer", "lively.identity.PostCardUtils").toRun(resolve);
  }));
}

// One editor card, kept as window[key].
async function openEditor(page, key = "__ed", at = 70) {
  await page.evaluate(async ([k, y]) => {
    const ed = lively.identity.WikiEditor.newCard("tester", { wikiName: "cell-text-" + k });
    window[k] = ed;
    for (let i = 0; i < 100 && !ed.editorView; i++) await new Promise((r) => setTimeout(r, 100));
    if (!ed.editorView) throw new Error("editor did not mount");
    ed.setPosition(lively.pt(30, y));
  }, [key, at]);
}

// Replaces the editor's whole document by `blocks`: [{ cell: [language, code] } | { p: text } | custom], then returns.
// A block is built through the editor's own schema.
function setDoc(page, blocks, key = "__ed") {
  return page.evaluate(([bs, k]) => {
    const v = window[k].editorView, s = v.state.schema;
    const nodes = bs.map((b) => b.cell ? s.nodes.code_cell.create({ language: b.cell[0] }, b.cell[1] ? s.text(b.cell[1]) : null)
      : b.list ? s.nodes.bullet_list.create(null, s.nodes.list_item.create(null, [s.nodes.paragraph.create(null, s.text(b.list)), s.nodes.code_cell.create({ language: b.cell2[0] })]))
      : s.nodes.paragraph.create(null, b.p ? s.text(b.p) : null));
    v.dispatch(v.state.tr.replaceWith(0, v.state.doc.content.size, nodes));
  }, [blocks, key]);
}

// Puts the caret inside the first cell, at `where` ("start" | "end" | a number of characters in), and focuses the editor.
function caretInCell(page, where = "end", key = "__ed") {
  return page.evaluate(([w, k]) => {
    const ed = window[k], v = ed.editorView, PM = ed._ProseMirror().state;
    let pos = null, node = null;
    v.state.doc.descendants((n, p) => { if (pos === null && n.type.name === "code_cell") { pos = p; node = n; } });
    const off = w === "start" ? 0 : w === "end" ? node.content.size : w;
    v.dispatch(v.state.tr.setSelection(PM.TextSelection.create(v.state.doc, pos + 1 + off)));
    v.focus();
  }, [where, key]);
}

// What the editor holds: the top-level block names, the text of every cell, and where the caret is.
const snap = (page, key = "__ed") => page.evaluate((k) => {
  const v = window[k].editorView, blocks = [], cells = [];
  v.state.doc.forEach((n) => blocks.push(n.type.name));
  v.state.doc.descendants((n) => { if (n.type.name === "code_cell") cells.push(n.textContent); });
  const $f = v.state.selection.$from;
  return { blocks, cells, caretIn: $f.parent.type.name, caretOffset: $f.parentOffset, empty: v.state.selection.empty };
}, key);

// The text each cell SHOWS (the code pane's own text), in order, for one editor.
const shown = (page, key = "__ed") => page.evaluate((k) => {
  const root = window[k].editorView.dom;
  return [...root.querySelectorAll(".lively-code-cell-node pre.lively-code-cell-source")].map((p) => p.textContent);
}, key);

test.describe("typing in a cell", () => {
  test("every key is in the document at once: no commit step, no debounce", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    await setDoc(page, [{ cell: ["python", ""] }, { p: "" }]);
    await caretInCell(page);
    let typed = "";
    for (const ch of "print(1)") {
      await page.keyboard.type(ch);
      typed += ch;
      // read right after the key, with no waiting: the old cell held the typing in its textarea for 600 ms
      expect((await snap(page)).cells).toEqual([typed]);
    }
    expect(await shown(page)).toEqual(["print(1)"]);
  });

  test("what one editor types shows in another at once", async ({ page }) => {
    await boot(page);
    // two editor cards in one world: only the NEWEST takes the keyboard, so the typist is opened last
    await openEditor(page, "__ed2", 120);
    await openEditor(page, "__ed", 70);
    await page.evaluate(() => {
      const Y = window.Y;
      // a live link between the two documents, both ways, the way a sync room carries updates
      const link = (a, b) => a.yDoc.on("update", (u, origin) => { if (origin !== "relay") Y.applyUpdate(b.yDoc, u, "relay"); });
      link(window.__ed, window.__ed2); link(window.__ed2, window.__ed);
    });
    await setDoc(page, [{ cell: ["python", ""] }, { p: "" }]);
    expect((await snap(page, "__ed2")).blocks).toEqual(["code_cell", "paragraph"]);
    await caretInCell(page);
    await page.keyboard.type("x = 1");
    // no polling: the other editor already holds it
    expect((await snap(page, "__ed2")).cells).toEqual(["x = 1"]);
    expect(await shown(page, "__ed2")).toEqual(["x = 1"]);
  });
});

test.describe("two people in one cell", () => {
  // Two editors, each with its own document, joined by updates carried by hand: edits made on each side while they are apart are
  // handed over afterwards, as happens when two people type before either's change arrives.
  async function apart(page, code) {
    await boot(page);
    await openEditor(page, "__ed", 70);
    await openEditor(page, "__ed2", 120);
    await setDoc(page, [{ cell: ["python", code] }, { p: "" }]);
    await page.evaluate(() => {
      const Y = window.Y;
      Y.applyUpdate(window.__ed2.yDoc, Y.encodeStateAsUpdate(window.__ed.yDoc), "relay");      // the second joins with the page as it is
      window.__q1 = []; window.__q2 = [];                                                     // from here, nothing is carried until we say
      window.__ed.yDoc.on("update", (u, o) => { if (o !== "relay") window.__q1.push(u); });
      window.__ed2.yDoc.on("update", (u, o) => { if (o !== "relay") window.__q2.push(u); });
    });
    expect((await snap(page, "__ed2")).cells).toEqual([code]);
  }
  const insertInCell = (page, key, offset, text) => page.evaluate(([k, off, t]) => {
    const v = window[k].editorView;
    let pos = null;
    v.state.doc.descendants((n, p) => { if (pos === null && n.type.name === "code_cell") pos = p; });
    v.dispatch(v.state.tr.insertText(t, pos + 1 + off));
  }, [key, offset, text]);
  const deliver = (page) => page.evaluate(() => {
    const Y = window.Y;
    window.__q1.forEach((u) => Y.applyUpdate(window.__ed2.yDoc, u, "relay"));
    window.__q2.forEach((u) => Y.applyUpdate(window.__ed.yDoc, u, "relay"));
  });

  test("edits to different lines of one cell are both kept, and both pages end up the same", async ({ page }) => {
    await apart(page, "line1\nline2\nline3");
    await insertInCell(page, "__ed", 0, "A: ");                 // the first person, at the top of the cell
    await insertInCell(page, "__ed2", "line1\nline2\nline3".length, " <B>");   // the second, at the end, before seeing the first
    await deliver(page);
    const want = "A: line1\nline2\nline3 <B>";
    expect((await snap(page, "__ed")).cells).toEqual([want]);
    expect((await snap(page, "__ed2")).cells).toEqual([want]);
    // and the screen shows it on both sides (the cell was last-writer-wins before: one of the two was lost)
    expect(await shown(page, "__ed")).toEqual([want]);
    expect(await shown(page, "__ed2")).toEqual([want]);
  });

  test("edits at the very same place are both kept and the pages agree", async ({ page }) => {
    await apart(page, "x = 1");
    await insertInCell(page, "__ed", 5, " # one");
    await insertInCell(page, "__ed2", 5, " # two");
    await deliver(page);
    const a = (await snap(page, "__ed")).cells[0], b = (await snap(page, "__ed2")).cells[0];
    expect(a).toBe(b);
    expect(a.startsWith("x = 1")).toBe(true);
    expect(a).toContain("# one");
    expect(a).toContain("# two");
    expect(a.length).toBe("x = 1 # one # two".length);
  });

  test("one person deleting a line while another types on another line: both happen", async ({ page }) => {
    await apart(page, "keep1\ndrop\nkeep2");
    await page.evaluate(() => {
      const v = window.__ed.editorView;
      let pos = null;
      v.state.doc.descendants((n, p) => { if (pos === null && n.type.name === "code_cell") pos = p; });
      v.dispatch(v.state.tr.delete(pos + 1 + "keep1\n".length, pos + 1 + "keep1\ndrop\n".length));     // removes "drop\n"
    });
    await insertInCell(page, "__ed2", "keep1\ndrop\nkeep2".length, "!");
    await deliver(page);
    expect((await snap(page, "__ed")).cells).toEqual(["keep1\nkeep2!"]);
    expect((await snap(page, "__ed2")).cells).toEqual(["keep1\nkeep2!"]);
  });
});

test.describe("keys in a cell", () => {
  async function inCell(page, language, code) {
    await boot(page);
    await openEditor(page);
    await setDoc(page, [{ p: "before" }, { cell: [language, code] }, { p: "after" }]);
    await caretInCell(page);
  }

  test("Enter is a newline in every language, Shift+Enter too, and the caret stays in the cell", async ({ page }) => {
    await inCell(page, "python", "");
    await page.keyboard.type("a");
    await page.keyboard.press("Enter");
    await page.keyboard.type("b");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("c");
    const s = await snap(page);
    expect(s.cells).toEqual(["a\nb\nc"]);
    expect(s.blocks).toEqual(["paragraph", "code_cell", "paragraph"]);   // no break node, no split cell
    expect(s.caretIn).toBe("code_cell");
  });

  test("Enter in a cell inside a list item stays in the cell and does not split the item", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    await setDoc(page, [{ list: "item", cell2: ["python", ""] }, { p: "" }]);
    await caretInCell(page);
    await page.keyboard.type("x");
    await page.keyboard.press("Enter");
    await page.keyboard.type("y");
    const s = await snap(page);
    expect(s.cells).toEqual(["x\ny"]);
    expect(s.caretIn).toBe("code_cell");
    expect(await page.evaluate(() => { let n = 0; window.__ed.editorView.state.doc.descendants((x) => { if (x.type.name === "list_item") n++; }); return n; })).toBe(1);
  });

  test("Backspace in an empty cell removes the cell and puts the caret at the end of the block before", async ({ page }) => {
    await inCell(page, "python", "");
    await page.keyboard.press("Backspace");
    const s = await snap(page);
    expect(s.blocks).toEqual(["paragraph", "paragraph"]);
    expect(s.caretIn).toBe("paragraph");
    expect(s.caretOffset).toBe("before".length);
  });

  test("Backspace in a cell with code deletes a character, not the cell", async ({ page }) => {
    await inCell(page, "python", "ab");
    await page.keyboard.press("Backspace");
    const s = await snap(page);
    expect(s.cells).toEqual(["a"]);
    expect(s.blocks).toEqual(["paragraph", "code_cell", "paragraph"]);
  });

  test("Backspace at the start of a cell with code does not merge it into the paragraph before", async ({ page }) => {
    await inCell(page, "python", "ab");
    await caretInCell(page, "start");
    await page.keyboard.press("Backspace");
    const s = await snap(page);
    expect(s.cells).toEqual(["ab"]);
    expect(s.blocks).toEqual(["paragraph", "code_cell", "paragraph"]);
  });

  test("an empty cell that is the only block leaves an empty paragraph behind", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    await setDoc(page, [{ cell: ["python", ""] }]);
    await caretInCell(page);
    await page.keyboard.press("Backspace");
    const s = await snap(page);
    expect(s.blocks).toEqual(["paragraph"]);
  });

  test("select-all inside a cell selects its code; pressed again it selects the page", async ({ page }) => {
    await inCell(page, "python", "abc");
    await caretInCell(page, 1);
    await page.keyboard.press("Control+a");
    let sel = await page.evaluate(() => { const v = window.__ed.editorView; return { text: v.state.doc.textBetween(v.state.selection.from, v.state.selection.to), all: v.state.selection.from === 0 && v.state.selection.to === v.state.doc.content.size }; });
    expect(sel).toEqual({ text: "abc", all: false });
    await page.keyboard.press("Control+a");
    sel = await page.evaluate(() => { const v = window.__ed.editorView; return { all: v.state.selection.from === 0 && v.state.selection.to === v.state.doc.content.size }; });
    expect(sel.all).toBe(true);
  });

  test("Ctrl+Enter leaves the cell: a paragraph is made after it and takes the caret", async ({ page }) => {
    await inCell(page, "python", "abc");
    await page.keyboard.press("Control+Enter");
    const s = await snap(page);
    expect(s.caretIn).toBe("paragraph");
    expect(s.cells).toEqual(["abc"]);
    expect(s.blocks.filter((b) => b === "paragraph").length).toBe(3);
  });

  test("a cell is not a place for formatting: bold has no effect and leaves the code as it was", async ({ page }) => {
    await inCell(page, "python", "abc");
    await page.keyboard.press("Control+a");        // the code
    await page.keyboard.press("Control+b");
    const marks = await page.evaluate(() => { let m = 0; window.__ed.editorView.state.doc.descendants((n) => { if (n.type.name === "code_cell") n.forEach((c) => { m += c.marks.length; }); }); return m; });
    expect(marks).toBe(0);
    expect((await snap(page)).cells).toEqual(["abc"]);
  });
});

test.describe("Ctrl+Home and Ctrl+End with a cell at the edge of the page", () => {
  // The browser's own move goes to the start or end of the editor, which with a cell at the edge is the cell's header or output,
  // where no caret can be: it did nothing. The editor takes the key then. The editor is focused by a real click, as a person does.
  const at = (page) => page.evaluate(() => { const s = window.__ed.editorView.state.selection; return { from: s.from, to: s.to, inBlock: s.$from.parent.type.name, offset: s.$from.parentOffset }; });
  const clickParagraph = (page) => page.locator(".ProseMirror > p").first().click({ position: { x: 20, y: 8 } });
  // The editor hears of a native key (or a click) from a selectionchange event a moment later: read until it has, never at once
  // (an immediate read was stale in 24 of 30 tries, no key was lost; see expectCaretOffset in scheme-cell.spec.js).
  const expectAt = (page, match) => expect.poll(() => at(page)).toMatchObject(match);

  test("a cell first: Ctrl+Home goes to the start of its code, from a paragraph below and from inside the cell", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    await setDoc(page, [{ cell: ["scheme", "(a (b) c)"] }, { p: "after" }]);
    await clickParagraph(page);
    await expectAt(page, { inBlock: "paragraph" });
    await page.keyboard.press("Control+Home");
    await expectAt(page, { inBlock: "code_cell", offset: 0 });
    await page.keyboard.press("End");
    await expectAt(page, { inBlock: "code_cell", offset: "(a (b) c)".length });
    await page.keyboard.press("Control+Home");
    await expectAt(page, { inBlock: "code_cell", offset: 0 });
  });

  test("a cell last: Ctrl+End goes to the end of its code, from a paragraph above and from inside the cell", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    await setDoc(page, [{ p: "before" }, { cell: ["scheme", "(a (b) c)"] }]);
    await clickParagraph(page);
    await expectAt(page, { inBlock: "paragraph" });
    await page.keyboard.press("Control+End");
    await expectAt(page, { inBlock: "code_cell", offset: "(a (b) c)".length });
    await page.keyboard.press("Home");
    await expectAt(page, { inBlock: "code_cell", offset: 0 });
    await page.keyboard.press("Control+End");
    await expectAt(page, { inBlock: "code_cell", offset: "(a (b) c)".length });
  });

  test("with Shift the selection grows from where it started", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    await setDoc(page, [{ cell: ["scheme", "(a (b) c)"] }, { p: "after" }]);
    await clickParagraph(page);
    await expectAt(page, { inBlock: "paragraph" });
    const start = await at(page);
    await page.keyboard.press("Control+Shift+Home");
    // the selection runs from the first place in the cell's code to where the click had put the caret: the anchor stayed
    await expectAt(page, { from: 1, to: start.from });
  });

  test("a paragraph at the edge: the key is left to the browser and still goes to the start of the page", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    await setDoc(page, [{ p: "before" }, { cell: ["scheme", "(a (b) c)"] }, { p: "after" }]);
    await page.locator(".ProseMirror > p").last().click({ position: { x: 20, y: 8 } });
    await expectAt(page, { inBlock: "paragraph" });
    await page.keyboard.press("Control+Home");
    await expectAt(page, { from: 1, inBlock: "paragraph", offset: 0 });
  });
});

test.describe("inserting a cell", () => {
  async function insert(page, kind) {
    await page.locator('button[title="Template"]').click();
    await page.getByText(kind + " code cell", { exact: true }).click();
  }

  test("in an empty page: the cell takes the empty paragraph's place, a paragraph follows, the caret is in the cell", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    await insert(page, "Python");
    const s = await snap(page);
    expect(s.blocks).toEqual(["code_cell", "paragraph"]);
    expect(s.caretIn).toBe("code_cell");
    expect(s.caretOffset).toBe(0);
    await page.keyboard.type("x");                // typing goes straight into the new cell
    expect((await snap(page)).cells).toEqual(["x"]);
  });

  test("in the middle of a paragraph: the paragraph is split around the cell", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    await setDoc(page, [{ p: "hello world" }]);
    await page.evaluate(() => {
      const v = window.__ed.editorView, PM = window.__ed._ProseMirror().state;
      v.dispatch(v.state.tr.setSelection(PM.TextSelection.create(v.state.doc, 1 + "hello ".length)));
      v.focus();
    });
    await insert(page, "Scheme");
    const s = await snap(page);
    expect(s.blocks).toEqual(["paragraph", "code_cell", "paragraph"]);
    expect(await page.evaluate(() => { const t = []; window.__ed.editorView.state.doc.forEach((n) => t.push(n.textContent)); return t; })).toEqual(["hello ", "", "world"]);
    expect(s.caretIn).toBe("code_cell");
  });
});

test.describe("copy and paste", () => {
  test("a cell copied from the editor pastes back as a cell with its language and code", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    await setDoc(page, [{ cell: ["scheme", "(+ 1 2)\n(* 3 4)"] }, { p: "" }]);
    const html = await page.evaluate(() => {
      const PM = window.__ed._ProseMirror(), v = window.__ed.editorView;
      let node = null;
      v.state.doc.descendants((n) => { if (!node && n.type.name === "code_cell") node = n; });
      const wrap = document.createElement("div");
      wrap.appendChild(PM.model.DOMSerializer.fromSchema(v.state.schema).serializeNode(node));
      return wrap.innerHTML;
    });
    expect(html).toContain('class="lively-code-cell"');
    await setDoc(page, [{ p: "" }]);
    await page.evaluate((h) => { window.__ed.editorView.focus(); window.__ed.editorView.pasteHTML(h); }, html);
    const s = await page.evaluate(() => { const out = []; window.__ed.editorView.state.doc.descendants((n) => { if (n.type.name === "code_cell") out.push([n.attrs.language, n.textContent]); }); return out; });
    expect(s).toEqual([["scheme", "(+ 1 2)\n(* 3 4)"]]);
  });

  test("the read-only rendering of a cell (highlighted markup) pastes as a cell with its plain code", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    const html = await page.evaluate(() => lively.identity.postCardUtils.snapshotToHtml({ type: "doc", content: [
      { type: "code_cell", attrs: { language: "scheme" }, content: [{ type: "text", text: "(define x 1)" }] }] }));
    expect(html).toContain("hljs-");          // the markup that pasting must reduce to plain text
    await page.evaluate((h) => { window.__ed.editorView.focus(); window.__ed.editorView.pasteHTML(h); }, html);
    const s = await page.evaluate(() => { const out = []; window.__ed.editorView.state.doc.descendants((n) => { if (n.type.name === "code_cell") out.push([n.attrs.language, n.textContent, n.childCount]); }); return out; });
    expect(s).toEqual([["scheme", "(define x 1)", 1]]);
  });
});

test.describe("highlighting", () => {
  test("a cell is highlighted as its own language, as the code is typed", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    await setDoc(page, [{ cell: ["scheme", ""] }, { p: "" }]);
    await caretInCell(page);
    await page.keyboard.type("(define x 12)");
    await expect(page.locator(".lively-code-cell-editing pre.lively-code-cell-source .hljs-number")).toHaveCount(1);
    await expect(page.locator(".lively-code-cell-editing pre.lively-code-cell-source .hljs-keyword, .lively-code-cell-editing pre.lively-code-cell-source .hljs-name")).not.toHaveCount(0);
    expect(await shown(page)).toEqual(["(define x 12)"]);      // the spans are around the text, not in it
  });

  test("typing in one cell re-highlights that cell only", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    await setDoc(page, [{ cell: ["scheme", "(+ 1 2)"] }, { cell: ["python", "print(1)"] }, { cell: ["sml", "val a = 1;"] }, { p: "" }]);
    await caretInCell(page);
    await page.evaluate(() => {
      window.__hl = 0;
      const h = window.hljs, orig = h.highlight.bind(h), origAuto = h.highlightAuto.bind(h);
      h.highlight = (...a) => { window.__hl++; return orig(...a); };
      h.highlightAuto = (...a) => { window.__hl++; return origAuto(...a); };
    });
    await page.keyboard.type("3");
    expect(await page.evaluate(() => window.__hl)).toBe(1);     // the edited cell, not all three
    expect((await snap(page)).cells).toEqual(["(+ 1 2)3", "print(1)", "val a = 1;"]);      // the caret was at the end of the first cell
  });
});

test.describe("a page saved before the cell was a text block", () => {
  // The code of such a page is in a `source` attribute of a cell with no children. It is converted when the page is loaded.
  const legacyEnvelope = (page) => page.evaluate(() => {
    const Y = window.Y, d = new Y.Doc({ gc: false }), f = d.getXmlFragment("prosemirror");
    const old = (parent, language, source) => { const c = new Y.XmlElement("code_cell"); parent.push([c]); c.setAttribute("language", language); c.setAttribute("source", source); };
    d.transact(() => {
      const p = new Y.XmlElement("paragraph"); f.push([p]); const t = new Y.XmlText(); p.push([t]); t.insert(0, "intro");
      old(f, "scheme", "(define a 1)\n(+ a 2)");
      old(f, "python", "print('hi')");
    });
    const update = Y.encodeStateAsUpdate(d);
    return { record: { cid: "x", payload: { format: "yjs-update-v1", update: lively.identity.crypto.base64urlEncode(update), attachments: [] } } };
  });
  const load = (page, envelope, key) => page.evaluate(([env, k]) => new Promise((resolve, reject) => {
    lively.identity.wikiSerializer.deserializeFromEnvelope(env, (err, doc, payload, info) => {
      if (err) return reject(new Error(err.message));
      const ed = window[k];
      ed.editorView.destroy();
      ed.editorView = null;          // the editor's dispatchTransaction would otherwise read the destroyed view
      ed.yDoc = doc;
      ed._attachEditor();
      resolve({ upgraded: info && info.upgradedCodeCells });
    });
  }), [envelope, key]);

  test("opens with each cell's code in the cell, and typing into it keeps the code", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    const env = await legacyEnvelope(page);
    const info = await load(page, env, "__ed");
    expect(info.upgraded).toBe(2);
    expect((await snap(page)).cells).toEqual(["(define a 1)\n(+ a 2)", "print('hi')"]);
    expect(await shown(page)).toEqual(["(define a 1)\n(+ a 2)", "print('hi')"]);
    // the stored attribute is gone from the live document, and typing does not lose the code (it used to delete the attribute)
    expect(await page.evaluate(() => { let n = 0; window.__ed.yDoc.getXmlFragment("prosemirror").toArray().forEach((e) => { if (e.nodeName === "code_cell" && e.getAttribute("source") !== undefined) n++; }); return n; })).toBe(0);
    await caretInCell(page, "end");
    await page.keyboard.type("!");
    expect((await snap(page)).cells).toEqual(["(define a 1)\n(+ a 2)!", "print('hi')"]);
  });

  test("two editors that both load the stored page, then meet, hold each cell's code once", async ({ page }) => {
    await boot(page);
    await openEditor(page, "__ed", 70);
    await openEditor(page, "__ed2", 120);
    const env = await legacyEnvelope(page);
    await load(page, env, "__ed");
    await load(page, env, "__ed2");
    await page.evaluate(() => {
      const Y = window.Y;
      Y.applyUpdate(window.__ed2.yDoc, Y.encodeStateAsUpdate(window.__ed.yDoc), "relay");
      Y.applyUpdate(window.__ed.yDoc, Y.encodeStateAsUpdate(window.__ed2.yDoc), "relay");
    });
    expect((await snap(page, "__ed")).cells).toEqual(["(define a 1)\n(+ a 2)", "print('hi')"]);
    expect((await snap(page, "__ed2")).cells).toEqual(["(define a 1)\n(+ a 2)", "print('hi')"]);
  });

  test("restoring an old version brings back each cell's code", async ({ page }) => {
    await boot(page);
    await openEditor(page);
    await page.evaluate(() => {
      const ed = window.__ed;
      ed._canEdit = true; ed._forceReadOnly = false;
      ed._saveNow = (cb) => { if (cb) cb(null); };          // no server here
      ed._restore = { attachments: [], snapshot: { type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: "old" }] },
        { type: "code_cell", attrs: { language: "scheme", source: "(+ 20 22)" } }] } };
      ed._applyRestore();
    });
    const s = await snap(page);
    expect(s.cells).toEqual(["(+ 20 22)"]);
    expect(await shown(page)).toEqual(["(+ 20 22)"]);
  });
});
