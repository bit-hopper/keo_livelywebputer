// Pure diff behind the wiki history panel. WikiDiff.js is a Lively module(...).requires().toRun(...)
// file, so load it into a sandbox with just enough of those globals stubbed.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '../../core/lively/identity/WikiDiff.js');

function load() {
  const lively = { identity: {} };
  const ctx = { lively, module: () => ({ requires: () => ({ toRun: (fn) => fn() }) }) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  return lively.identity.wikiDiff;
}
const D = load();

const text = (s, marks) => ({ type: 'text', text: s, ...(marks ? { marks } : {}) });
const p = (s, marks) => ({ type: 'paragraph', content: s === '' ? [] : [text(s, marks)] });
const h = (level, s) => ({ type: 'heading', attrs: { level }, content: [text(s)] });
const doc = (...content) => ({ type: 'doc', content });
// results come from another vm realm: copy into this realm before deepStrictEqual
const plain = (v) => JSON.parse(JSON.stringify(v));
const ops = (a, b) => plain(D.diffSnapshots(a, b).ops.map((o) => o.op));

test('identical documents have no changes', () => {
  const d = doc(h(1, 'Title'), p('one'), p('two'));
  const r = D.diffSnapshots(d, JSON.parse(JSON.stringify(d)));
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(ops(d, d), ['eq', 'eq', 'eq']);
});

test('key order inside nodes does not matter (jsonb round trip)', () => {
  const a = doc({ type: 'heading', attrs: { level: 2 }, content: [text('x')] });
  const b = doc({ content: [text('x')], attrs: { level: 2 }, type: 'heading' });
  assert.strictEqual(D.diffSnapshots(a, b).changed, false);
});

test('a null old version makes every block an insertion', () => {
  const r = D.diffSnapshots(null, doc(p('a'), p('b')));
  assert.deepStrictEqual(plain(r.ops.map((o) => o.op)), ['ins', 'ins']);
  assert.strictEqual(r.stats.added, 2);
});

test('an added block and a removed block', () => {
  assert.deepStrictEqual(ops(doc(p('a'), p('c')), doc(p('a'), p('b'), p('c'))), ['eq', 'ins', 'eq']);
  assert.deepStrictEqual(ops(doc(p('a'), p('b'), p('c')), doc(p('a'), p('c'))), ['eq', 'del', 'eq']);
});

test('an edited paragraph becomes one modified line with a word diff', () => {
  const r = D.diffSnapshots(doc(p('the quick brown fox jumps')), doc(p('the quick red fox jumps')));
  assert.deepStrictEqual(plain(r.ops.map((o) => o.op)), ['mod']);
  const w = r.ops[0].words;
  assert.deepStrictEqual(plain(w.filter((x) => x.t === 'del').map((x) => x.s)), ['brown']);
  assert.deepStrictEqual(plain(w.filter((x) => x.t === 'ins').map((x) => x.s)), ['red']);
  assert.strictEqual(r.ops[0].fmtOnly, false);
});

test('a completely rewritten paragraph is a removal plus an insertion, not a modification', () => {
  assert.deepStrictEqual(ops(doc(p('alpha beta gamma')), doc(p('one two three'))), ['del', 'ins']);
});

test('a formatting-only change is flagged', () => {
  const r = D.diffSnapshots(doc(p('same words')), doc(p('same words', [{ type: 'strong' }])));
  assert.deepStrictEqual(plain(r.ops.map((o) => o.op)), ['mod']);
  assert.strictEqual(r.ops[0].fmtOnly, true);
});

test('changing a heading level is not paired with a paragraph of the same text', () => {
  assert.deepStrictEqual(ops(doc(h(1, 'Intro')), doc(h(2, 'Intro'))), ['del', 'ins']);
});

test('list items are diffed individually', () => {
  const list = (...items) => ({
    type: 'bullet_list',
    content: items.map((s) => ({ type: 'list_item', content: [p(s)] })),
  });
  const r = D.diffSnapshots(doc(list('a', 'b', 'c')), doc(list('a', 'c', 'd')));
  assert.deepStrictEqual(plain(r.ops.map((o) => o.op)), ['eq', 'del', 'eq', 'ins']);
});

test('non-text blocks are matched whole', () => {
  const img = (src) => ({ type: 'image', attrs: { src } });
  assert.deepStrictEqual(ops(doc(img('a.png'), p('x')), doc(img('b.png'), p('x'))), ['del', 'ins', 'eq']);
});

test('wordDiff keeps spacing changes visible', () => {
  const w = D.wordDiff('a b', 'a  b');
  assert.ok(w.some((x) => x.t !== 'eq'));
});

test('renderHtml escapes text and collapses long unchanged runs', () => {
  const same = Array.from({ length: 8 }, (_, i) => p('para ' + i));
  const a = doc(p('top <b>'), ...same, p('end'));
  const b = doc(p('top <b> now'), ...same, p('end'));
  const html = D.renderHtml(D.diffSnapshots(a, b));
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(!html.includes('<b>'));
  assert.ok(/data-wh-toggle/.test(html));
  assert.ok(/\d+ unchanged blocks?/.test(html));
});

test('renderHtml on an unchanged document shows nothing collapsed away from view', () => {
  const d = doc(p('a'), p('b'));
  const html = D.renderHtml(D.diffSnapshots(d, d));
  assert.ok(html.includes('a') && html.includes('b'));
});

test('large documents diff in reasonable time', () => {
  const big = (n, tweak) => doc(...Array.from({ length: n }, (_, i) => p('line ' + i + (tweak && i % 50 === 0 ? ' edited' : ''))));
  const t0 = Date.now();
  const r = D.diffSnapshots(big(1500), big(1500, true));
  assert.strictEqual(r.stats.modified, 30);
  assert.ok(Date.now() - t0 < 3000);
});
