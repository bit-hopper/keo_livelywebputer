// @ts-check
// Block-level atoms (display math, video, audio, embedded part) inserted into the wiki editor and the
// postcard editor. Both share the same insert helper (_insertBlockAtom): an atom must never replace the
// previous atom, and an atom that ends the document is followed by exactly one empty paragraph.
// newCard works without a login; autosave/sync requests just fail in the background.
const { test, expect } = require("@playwright/test");

// mathButton: how each toolbar offers display math (the wiki editor has a Template menu, the postcard editor an icon).
const EDITORS = [
  { name: "wiki editor", cls: "lively.identity.WikiEditor", open: (C) => C.newCard("tester", { wikiName: "atoms" }),
    clickMath: async (page) => { await page.locator('button[title="Template"]').click(); await page.getByText("Math (display)", { exact: true }).click(); } },
  { name: "postcard editor", cls: "lively.identity.PostCardEditor", open: (C) => C.newCard("tester", {}),
    clickMath: async (page) => { await page.locator('button[title="Math display"]').click(); } },
];

async function openEditor(page, ed) {
  await page.goto("/blank.html");
  await page.waitForFunction(() => typeof window.$world !== "undefined" && window.$world !== null, { timeout: 20000 });
  await page.addScriptTag({ url: "/core/lib/postcard/postcard-runtime.js" });
  await page.evaluate((cls) => new Promise((r) => lively.require(cls).toRun(r)), ed.cls);
  await page.evaluate(async ({ cls, open }) => {
    const C = cls.split(".").reduce((o, k) => o[k], window);
    const e = (new Function("C", "return (" + open + ")(C)"))(C);
    window.__ed = e;
    for (let i = 0; i < 100 && !e.editorView; i++) await new Promise((r) => setTimeout(r, 100));
    if (!e.editorView) throw new Error("editor did not mount");
    e.setPosition(lively.pt(30, 70));   // keep the toolbar clear of the world's menu bar
  }, { cls: ed.cls, open: ed.open.toString() });
}

// Node type names of the document's top-level children, in order.
const shape = (page) => page.evaluate(() => { const k = []; window.__ed.editorView.state.doc.forEach((n) => k.push(n.type.name)); return k; });

// The same code paths the attachment dialog and the part picker call.
const insert = {
  video: (page) => page.evaluate(() => window.__ed._insertAttachmentVideo({ name: "clip.mp4", blobCid: "bafyvideo", objId: "obj-video" })),
  audio: (page) => page.evaluate(() => window.__ed._insertAttachmentAudio({ name: "tune.mp3", blobCid: "bafyaudio", objId: "obj-audio" })),
  part: (page) => page.evaluate(() => window.__ed._insertPartEmbed({ envelope: { objId: "obj-part", record: { cid: "bafypart" } } })),
};

for (const ed of EDITORS) {
  test.describe(ed.name + ": block atoms", () => {
    test("four different atoms in a row all stay, followed by one empty paragraph", async ({ page }) => {
      await openEditor(page, ed);
      await insert.video(page);
      await insert.audio(page);
      await insert.part(page);
      await ed.clickMath(page);
      expect(await shape(page)).toEqual(["video", "audio", "embeddedPart", "math_display", "paragraph"]);
    });

    test("an atom inserted in the middle of a paragraph splits it and adds no extra paragraph", async ({ page }) => {
      await openEditor(page, ed);
      await page.locator(".ProseMirror").click();
      await page.keyboard.type("ab");
      await page.keyboard.press("ArrowLeft");
      // ProseMirror picks the caret move up from the DOM asynchronously; wait until it has.
      await page.waitForFunction(() => window.__ed.editorView.state.selection.$from.parentOffset === 1);
      await insert.video(page);
      expect(await shape(page)).toEqual(["paragraph", "video", "paragraph"]);
      // The caret is in the second half, so the next atom goes in front of it, still between the two halves.
      await insert.audio(page);
      expect(await shape(page)).toEqual(["paragraph", "video", "audio", "paragraph"]);
      const texts = await page.evaluate(() => { const t = []; window.__ed.editorView.state.doc.forEach((n) => { if (n.type.name === "paragraph") t.push(n.textContent); }); return t; });
      expect(texts).toEqual(["a", "b"]);
    });

    test("with an atom selected, the next atom goes after it instead of replacing it", async ({ page }) => {
      await openEditor(page, ed);
      await insert.video(page);
      await insert.audio(page);
      // Select the video itself (the state the old code left the editor in after every insert).
      await page.evaluate(() => {
        const e = window.__ed, v = e.editorView, PM = e._ProseMirror().state;
        let pos = null;
        v.state.doc.descendants((n, p) => { if (pos === null && n.type.name === "video") pos = p; });
        v.dispatch(v.state.tr.setSelection(PM.NodeSelection.create(v.state.doc, pos)));
      });
      expect(await page.evaluate(() => !!window.__ed.editorView.state.selection.node)).toBe(true);
      await insert.part(page);
      // The part goes right after the video. The audio that follows is another atom, so there is no text
      // position for the caret between them: an empty paragraph is added there to hold it.
      expect(await shape(page)).toEqual(["video", "embeddedPart", "paragraph", "audio", "paragraph"]);
    });

    test("typing after an inserted atom lands in the paragraph after it, not on the atom", async ({ page }) => {
      await openEditor(page, ed);
      await insert.video(page);
      await page.keyboard.type("after");
      expect(await shape(page)).toEqual(["video", "paragraph"]);
      expect(await page.evaluate(() => window.__ed.editorView.state.doc.lastChild.textContent)).toBe("after");
    });
  });
}
