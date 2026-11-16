// A wiki page saved before the code cell became a text block holds its code in a `source` attribute on a cell with no children. When
// such a page is loaded it is converted (PostCardUtils.upgradeLegacyCodeCells): the code becomes the cell's text, the attribute goes.
// Every collaborator loads the same stored state and converts it, so the conversion has to come out IDENTICAL on every peer, or
// the merged cell would hold the code once per peer. Real Yjs and y-prosemirror, no browser.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '../../core/lively/identity/PostCardUtils.js');

function loadClient(source) {
  const lively = { identity: {} };
  const chain = { requires: () => chain, toRun: (fn) => fn() };
  const document = { getElementById() { return null; }, createElement() { return { style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} }; },
    head: { appendChild() {} }, body: { appendChild() {} }, addEventListener() {}, querySelector() { return null; } };
  vm.runInNewContext(source, { lively, module: () => chain, document, window: undefined }, { filename: file });
  return lively.identity.postCardUtils;
}
const U = loadClient(fs.readFileSync(file, 'utf8'));

const plain = (v) => JSON.parse(JSON.stringify(v));
const para = (frag, text) => { const p = new Y.XmlElement('paragraph'); frag.push([p]); const t = new Y.XmlText(); p.push([t]); t.insert(0, text); return p; };
const oldCell = (parent, language, source) => { const c = new Y.XmlElement('code_cell'); parent.push([c]); c.setAttribute('language', language); c.setAttribute('source', source); return c; };

// the stored page: what the server keeps and every peer loads (gc off, as the wiki's documents are)
function storedPage() {
  const d = new Y.Doc({ gc: false });
  const frag = d.getXmlFragment('prosemirror');
  d.transact(() => {
    para(frag, 'before');
    oldCell(frag, 'python', 'print(1)\nprint(2)');
    const q = new Y.XmlElement('blockquote'); frag.push([q]);
    oldCell(q, 'scheme', '(+ 1 2)');
    oldCell(frag, 'sml', '');                                   // an empty old cell
    const fresh = new Y.XmlElement('code_cell'); frag.push([fresh]); fresh.setAttribute('language', 'logo');
    const ft = new Y.XmlText(); fresh.push([ft]); ft.insert(0, 'fd 10');   // a cell already in the new shape
    para(frag, 'after');
  });
  return Y.encodeStateAsUpdate(d);
}
const load = (bytes) => { const d = new Y.Doc({ gc: false }); Y.applyUpdate(d, bytes); return d; };
const json = (d) => plain(yDocToProsemirrorJSON(d, 'prosemirror'));
const cellsOf = (j) => { const out = []; (function walk(n) { if (n.type === 'code_cell') out.push(n); (n.content || []).forEach(walk); })(j); return out; };
const sync = (a, b) => { Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))); Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))); };

test('converting a stored page: old cells get their source as text and lose the attribute, the rest is untouched', () => {
  const doc = load(storedPage());
  const before = json(doc);
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, doc), 3, 'three old cells: python, the one in the quote, the empty one');
  const after = json(doc);
  const cells = cellsOf(after);
  assert.deepStrictEqual(cells.map((c) => [c.attrs.language, (c.content || []).map((t) => t.text).join('')]),
    [['python', 'print(1)\nprint(2)'], ['scheme', '(+ 1 2)'], ['sml', ''], ['logo', 'fd 10']]);
  assert.ok(cells.every((c) => !('source' in c.attrs)), 'no cell keeps the attribute');
  assert.strictEqual(cells[2].content, undefined, 'an empty old cell gets no text node');
  assert.strictEqual(doc.gc, false, 'history is kept');
  // the same result as upgrading the snapshot of the unconverted page
  assert.deepStrictEqual(after, plain(U.upgradeCodeCellSnapshot(before)), 'live conversion and snapshot conversion agree');
});

test('converting is done once: a second call, and a page with no old cell, change nothing', () => {
  const doc = load(storedPage());
  U.upgradeLegacyCodeCells(Y, doc);
  const sv = Y.encodeStateVector(doc);
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, doc), 0);
  assert.deepStrictEqual(Array.from(Y.encodeStateVector(doc)), Array.from(sv), 'nothing was written');
  const fresh = new Y.Doc({ gc: false });
  para(fresh.getXmlFragment('prosemirror'), 'just text');
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, fresh), 0);
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, null), 0);
  assert.strictEqual(U.upgradeLegacyCodeCells(null, fresh), 0);
});

test('every peer converts the same stored page on its own, and what they then exchange holds each cell\'s code exactly once', () => {
  const bytes = storedPage();
  const peers = [load(bytes), load(bytes), load(bytes)];
  peers.forEach((p) => assert.strictEqual(U.upgradeLegacyCodeCells(Y, p), 3));
  // the three conversions are the same update, byte for byte
  const states = peers.map((p) => Buffer.from(Y.encodeStateAsUpdate(p, Y.encodeStateVector(load(bytes)))).toString('base64'));
  assert.strictEqual(new Set(states).size, 1, 'one and the same update on every peer');
  sync(peers[0], peers[1]); sync(peers[1], peers[2]); sync(peers[0], peers[2]);
  const want = json(peers[0]);
  peers.forEach((p) => assert.deepStrictEqual(json(p), want));
  assert.deepStrictEqual(cellsOf(want).map((c) => (c.content || []).map((t) => t.text).join('')), ['print(1)\nprint(2)', '(+ 1 2)', '', 'fd 10']);
});

test('peers that converted, then each typed into the same cell, keep both edits and the code once', () => {
  const bytes = storedPage();
  const a = load(bytes), b = load(bytes);
  U.upgradeLegacyCodeCells(Y, a); U.upgradeLegacyCodeCells(Y, b);
  const cellText = (d) => d.getXmlFragment('prosemirror').toArray().filter((e) => e.nodeName === 'code_cell')[0].toArray()[0];
  cellText(a).insert(0, '# by A\n');                              // the top of the cell
  const tb = cellText(b); tb.insert(tb.length, '\nprint(3)');      // the end of the cell
  sync(a, b);
  const t = (d) => (cellsOf(json(d))[0].content || []).map((x) => x.text).join('');
  assert.strictEqual(t(a), t(b));
  assert.strictEqual(t(a), '# by A\nprint(1)\nprint(2)\nprint(3)');
});

test('a peer that is given the converted state first, or converts first, ends up the same', () => {
  const bytes = storedPage();
  const a = load(bytes), early = load(bytes), late = load(bytes);
  U.upgradeLegacyCodeCells(Y, a);
  Y.applyUpdate(early, Y.encodeStateAsUpdate(a));                  // gets A's converted page and has nothing left to convert
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, early), 0);
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, late), 3);        // converts on its own, THEN meets A's state
  sync(a, late);
  assert.deepStrictEqual(json(early), json(a));
  assert.deepStrictEqual(json(late), json(a));
});

test('peers that loaded DIFFERENT stored versions, holding different sets of old cells, still merge to each cell\'s code once', () => {
  const v1 = storedPage();
  // a later stored version: the same page plus one more old cell, in front of the others (so the cells come in another order)
  const later = load(v1);
  later.transact(() => {
    const c = new Y.XmlElement('code_cell'); later.getXmlFragment('prosemirror').insert(1, [c]);
    c.setAttribute('language', 'python'); c.setAttribute('source', 'NEW = 0');
  });
  const v2 = Y.encodeStateAsUpdate(later);
  const a = load(v1), b = load(v2);
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, a), 3);
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, b), 4);
  sync(a, b);
  assert.deepStrictEqual(json(a), json(b));
  assert.deepStrictEqual(cellsOf(json(a)).map((c) => (c.content || []).map((t) => t.text).join('')),
    ['NEW = 0', 'print(1)\nprint(2)', '(+ 1 2)', '', 'fd 10']);
});

test('different old cells with the SAME source, in peers holding different sets of them, each keep their own code once', () => {
  const base = new Y.Doc({ gc: false });
  const f = base.getXmlFragment('prosemirror');
  base.transact(() => { oldCell(f, 'python', 'dup()'); para(f, 'between'); oldCell(f, 'python', 'dup()'); });
  const v1 = Y.encodeStateAsUpdate(base);
  const later = load(v1);
  later.transact(() => {
    const c = new Y.XmlElement('code_cell'); later.getXmlFragment('prosemirror').insert(0, [c]);
    c.setAttribute('language', 'python'); c.setAttribute('source', 'dup()');
  });
  const a = load(v1), b = load(Y.encodeStateAsUpdate(later));
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, a), 2);
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, b), 3);
  sync(a, b);
  assert.deepStrictEqual(json(a), json(b));
  assert.deepStrictEqual(cellsOf(json(a)).map((c) => (c.content || []).map((t) => t.text).join('')), ['dup()', 'dup()', 'dup()']);
});

test('the SAME old cell holding different sources on two peers (an old client edited it in between): the peers still end up equal', () => {
  // The one case that cannot be made exact: each peer converts the source it holds, so the cell ends up with both. What matters
  // is that the peers AGREE. (With one client id for the cell whatever its source, each peer would keep its own text and
  // never take the other's, as both write the same (client, clock): they would differ for good.)
  const base = new Y.Doc({ gc: false });
  const f = base.getXmlFragment('prosemirror');
  base.transact(() => { para(f, 'x'); oldCell(f, 'python', 'v1'); });
  const bytes = Y.encodeStateAsUpdate(base);
  const a = load(bytes), b = load(bytes);
  b.getXmlFragment('prosemirror').toArray().filter((e) => e.nodeName === 'code_cell')[0].setAttribute('source', 'v2');
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, a), 1);
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, b), 1);
  sync(a, b);
  assert.deepStrictEqual(json(a), json(b), 'the peers agree');
  const text = (cellsOf(json(a))[0].content || []).map((t) => t.text).join('');
  assert.ok(text.includes('v1') && text.includes('v2'), 'both sources are kept: ' + JSON.stringify(text));
});

test('a cell that has text AND a leftover source attribute is not converted again (its text is the code, once)', () => {
  const d = new Y.Doc({ gc: false });
  const f = d.getXmlFragment('prosemirror');
  d.transact(() => {
    const c = new Y.XmlElement('code_cell'); f.push([c]);
    c.setAttribute('language', 'python'); c.setAttribute('source', 'STALE');
    const t = new Y.XmlText(); c.push([t]); t.insert(0, 'fresh');
  });
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, d), 0);
  const cell = cellsOf(json(d))[0];
  assert.strictEqual((cell.content || []).map((t) => t.text).join(''), 'fresh', 'the text is not doubled');
});

test('a cell added in the old shape after the page was converted is converted too, the same on every peer', () => {
  const bytes = storedPage();            // ONE stored page: two storedPage() calls are two different documents (random client ids)
  const a = load(bytes), b = load(bytes);
  U.upgradeLegacyCodeCells(Y, a); U.upgradeLegacyCodeCells(Y, b); sync(a, b);
  // a stale client of some peer adds one more old-shape cell and it reaches both
  oldCell(a.getXmlFragment('prosemirror'), 'python', 'x = 1');
  sync(a, b);
  const a2 = load(Y.encodeStateAsUpdate(a)), b2 = load(Y.encodeStateAsUpdate(b));
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, a2), 1);
  assert.strictEqual(U.upgradeLegacyCodeCells(Y, b2), 1);
  sync(a2, b2);
  assert.deepStrictEqual(json(a2), json(b2));
  const last = cellsOf(json(a2)).pop();
  assert.strictEqual((last.content || []).map((x) => x.text).join(''), 'x = 1', 'once, not twice');
});
