// The code cell's source as page JSON carries it. A cell is a text block: its code is its text. A page saved before that held the
// code in a `source` attribute on a cell with no children. This covers the three places that read it from JSON (the client render
// and snapshot upgrade in PostCardUtils.js, and the server's static render in CodeCellRender.js) and that they agree.
// Both load without a browser: PostCardUtils.js in a sandbox with a stub document, CodeCellRender.js as the module it is.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '../..');
const require = createRequire(import.meta.url);

function loadClient() {
  const file = path.join(root, 'core/lively/identity/PostCardUtils.js');
  const lively = { identity: {} };
  const chain = { requires: () => chain, toRun: (fn) => fn() };
  const document = { getElementById() { return null; }, createElement() { return { style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} }; },
    head: { appendChild() {} }, body: { appendChild() {} }, addEventListener() {}, querySelector() { return null; } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { lively, module: () => chain, document, window: undefined }, { filename: file });
  return lively.identity.postCardUtils;
}
const U = loadClient();

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// no highlighter: the server then shows the escaped text, as the client does when none is loaded
const { createCodeCellRenderer } = require(path.join(root, 'core/servers/identity/CodeCellRender.js'));
const serverRender = createCodeCellRenderer({ hljs: { highlight: (t) => ({ value: escapeHtml(t) }) }, escapeHtml });

const text = (s) => ({ type: 'text', text: s });
const cell = (language, ...parts) => ({ type: 'code_cell', attrs: { language }, content: parts.map(text) });
const oldCell = (language, source) => ({ type: 'code_cell', attrs: { language, source } });
const plain = (v) => JSON.parse(JSON.stringify(v));       // results of the sandbox are in another realm
const sourceOf = (html) => /<pre class="lively-code-cell-source"><code class="hljs">([\s\S]*?)<\/code><\/pre>/.exec(html)[1];

test('the source of a cell is its text; a cell of the old shape has it in the attribute', () => {
  assert.strictEqual(U.codeCellSource(cell('python', 'print(1)\nprint(2)')), 'print(1)\nprint(2)');
  assert.strictEqual(U.codeCellSource(oldCell('python', 'print(1)')), 'print(1)');
  assert.strictEqual(U.codeCellSource(cell('python')), '', 'no text and no attribute is empty');
  assert.strictEqual(U.codeCellSource({ type: 'code_cell' }), '', 'no attrs at all');
  assert.strictEqual(U.codeCellSource(cell('python', 'ab', 'cd')), 'abcd', 'several text children read as one text');
});

test('a cell with text never reads the old attribute, even when one is left on it', () => {
  const n = { type: 'code_cell', attrs: { language: 'python', source: 'STALE' }, content: [text('fresh')] };
  assert.strictEqual(U.codeCellSource(n), 'fresh');
});

test('upgrading a snapshot moves the source of an old cell into its text, and nothing else', () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [text('before')] },
    oldCell('scheme', '(+ 1 2)'),
    { type: 'blockquote', content: [oldCell('python', 'x = 1'), { type: 'paragraph', content: [text('quoted')] }] },
    { type: 'bullet_list', content: [{ type: 'list_item', content: [oldCell('logo', 'fd 10')] }] },
    cell('sml', 'val a = 1'),
    oldCell('python', ''),
  ] };
  const before = JSON.stringify(doc);
  const up = plain(U.upgradeCodeCellSnapshot(doc));
  assert.strictEqual(JSON.stringify(doc), before, 'the argument is left alone');
  assert.deepStrictEqual(up.content[0], doc.content[0]);
  assert.deepStrictEqual(up.content[1], cell('scheme', '(+ 1 2)'));
  assert.deepStrictEqual(up.content[2].content[0], cell('python', 'x = 1'), 'a cell inside a quote');
  assert.deepStrictEqual(up.content[2].content[1], doc.content[2].content[1]);
  assert.deepStrictEqual(up.content[3].content[0].content[0], cell('logo', 'fd 10'), 'a cell inside a list item');
  assert.deepStrictEqual(up.content[4], doc.content[4], 'a cell already in the new shape is untouched');
  assert.deepStrictEqual(up.content[5], { type: 'code_cell', attrs: { language: 'python' } }, 'an empty old cell gets no text node');
});

test('upgrading is idempotent, keeps a cell\'s other attributes and drops a stale source next to real text', () => {
  const stale = { type: 'code_cell', attrs: { language: 'python', source: 'STALE', future: 7 }, content: [text('fresh')] };
  const once = plain(U.upgradeCodeCellSnapshot({ type: 'doc', content: [stale, oldCell('scheme', '(a)')] }));
  assert.deepStrictEqual(once.content[0], { type: 'code_cell', attrs: { language: 'python', future: 7 }, content: [text('fresh')] });
  assert.deepStrictEqual(plain(U.upgradeCodeCellSnapshot(once)), once);
});

test('upgrading leaves marks and other text alone, and takes null and strings as they are', () => {
  const para = { type: 'paragraph', content: [{ type: 'text', text: 'b', marks: [{ type: 'strong' }] }] };
  assert.deepStrictEqual(plain(U.upgradeCodeCellSnapshot({ type: 'doc', content: [para] })).content[0], para);
  assert.strictEqual(U.upgradeCodeCellSnapshot(null), null);
  assert.strictEqual(U.upgradeCodeCellSnapshot('x'), 'x');
});

test('the client render of a cell is the same for both shapes, and escapes the source', () => {
  for (const [language, src] of [['python', 'print(1)'], ['scheme', '(+ 1 2)'], ['sml', 'fun f x = <b>x</b> & y']]) {
    assert.strictEqual(U.pmNodeToHtml(cell(language, src)), U.pmNodeToHtml(oldCell(language, src)), language);
  }
  const html = U.pmNodeToHtml(cell('python', 'a <b>bold</b> "q"'));
  assert.strictEqual(sourceOf(html), 'a &lt;b&gt;bold&lt;/b&gt; &quot;q&quot;');
  assert.ok(!html.includes('<b>bold</b>'));
});

test('a language this build has no row for shows the source as plain text and no Run button, in both shapes', () => {
  for (const n of [cell('cobol', 'MOVE <1> TO X'), oldCell('cobol', 'MOVE <1> TO X')]) {
    const html = U.pmNodeToHtml(n);
    assert.strictEqual(sourceOf(html), 'MOVE &lt;1&gt; TO X');
    assert.ok(!html.includes('lively-code-cell-run-btn'));
    assert.ok(html.includes('data-language="cobol"'));
  }
});

test('the server render reads the cell\'s text, or the old attribute, and agrees with the client render of the same node', () => {
  for (const n of [cell('python', 'print(1)'), oldCell('python', 'print(1)'), cell('scheme', '(+ 1 2)\n(* 3 4)'), oldCell('scheme', '(+ 1 2)\n(* 3 4)'),
                   cell('cobol', 'MOVE <1> TO X'), oldCell('cobol', 'MOVE <1> TO X'), cell('python'), oldCell('python', '')]) {
    assert.strictEqual(serverRender(n), U.pmNodeToHtml(n), JSON.stringify(n));
  }
  assert.strictEqual(sourceOf(serverRender(cell('python', 'a<b'))), 'a&lt;b');
  assert.strictEqual(sourceOf(serverRender({ type: 'code_cell', attrs: { language: 'python', source: 'STALE' }, content: [text('fresh')] })), 'fresh');
});
