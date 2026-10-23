// The Worker entry point (core/lib/logo/logo-worker.js) driven in a bare vm context that stands in for a Worker's global
// scope: `importScripts` evaluates the committed bundle there, `postMessage` records what the worker says, and the test
// sends it messages by calling the `onmessage` it installs. This checks the protocol and the slicing (draw before text,
// interrupt between slices, reset, the turtle reported on every run); a real Worker in a real page is the e2e spec's job.
// `npm run test:logo` rebuilds the bundle first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

// A worker scope with a script loader, a message sink and the worker's own onmessage once the script has run.
function startWorker() {
  const sent = [];
  const ctx = vm.createContext({ MessageChannel, console });
  ctx.self = ctx;
  // A JSON round trip, like the structured clone a real postMessage makes (and it takes the objects out of the vm realm).
  ctx.postMessage = (m) => sent.push(JSON.parse(JSON.stringify(m)));
  ctx.importScripts = (url) => {
    const file = path.join(root, url);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'core', 'lib', 'logo', 'logo-worker.js'), 'utf8'), ctx, { filename: 'logo-worker.js' });
  const send = (msg) => ctx.onmessage({ data: msg });
  // Resolves with the messages for run `id` once its `done` arrives (or after `ms`, with whatever came).
  const until = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (pred()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timed out; got ' + JSON.stringify(sent).slice(0, 400)));
      setTimeout(poll, 5);
    })();
  });
  const close = () => { ctx.yieldChannel.port1.close(); ctx.yieldChannel.port2.close(); };
  return { ctx, sent, send, until, close };
}

const forRun = (sent, id) => sent.filter((m) => m.id === id);
const done = (sent, id) => sent.some((m) => m.id === id && m.op === 'done');

test('init loads the bundle and reports its build id', (t) => {
  const w = startWorker();
  t.after(w.close);
  w.send({ op: 'init' });
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].op, 'init');
  assert.equal(w.sent[0].ok, true);
  assert.match(w.sent[0].buildId, /^\d{4}-\d\d-\d\dT/);
});

test('a run posts its drawing first, then its text, then done', async (t) => {
  const w = startWorker();
  t.after(w.close);
  w.send({ op: 'init' });
  w.send({ id: 1, op: 'run', source: 'fd 10\nrt 90\nfd 5\nprint pos' });
  await w.until(() => done(w.sent, 1));
  const msgs = forRun(w.sent, 1);
  const kinds = msgs.map((m) => m.op);
  assert.deepEqual(kinds, ['draw', 'done']);
  assert.equal(msgs[0].ops.length, 2);
  assert.deepEqual(msgs[0].ops.map((o) => o.op), ['line', 'line']);
  assert.deepEqual([msgs[0].turtle.x, msgs[0].turtle.y, msgs[0].turtle.heading], [5, 10, 90]);
  assert.equal(msgs[1].state, 'done');
  assert.deepEqual(msgs[1].segments, [{ kind: 'stdout', text: '5 10\n' }]);
});

test('a run that draws nothing still reports the turtle once, and a later run sees the earlier cell\'s turtle', async (t) => {
  const w = startWorker();
  t.after(w.close);
  w.send({ op: 'init' });
  w.send({ id: 1, op: 'run', source: 'setxy 7 8 setheading 30' });
  await w.until(() => done(w.sent, 1));
  w.send({ id: 2, op: 'run', source: 'print 1' });
  await w.until(() => done(w.sent, 2));
  const draw2 = forRun(w.sent, 2).filter((m) => m.op === 'draw');
  assert.equal(draw2.length, 1);
  assert.deepEqual(draw2[0].ops, []);
  assert.deepEqual([draw2[0].turtle.x, draw2[0].turtle.y, draw2[0].turtle.heading], [7, 8, 30]);
});

test('an error ends the cell with an error segment, and the workspace stays usable', async (t) => {
  const w = startWorker();
  t.after(w.close);
  w.send({ op: 'init' });
  w.send({ id: 1, op: 'run', source: 'fd 10\nfoo\nfd 10' });
  await w.until(() => done(w.sent, 1));
  const d = forRun(w.sent, 1).find((m) => m.op === 'done');
  assert.equal(d.state, 'error');
  assert.ok(d.segments.some((s) => s.kind === 'error' && /I don't know how/.test(s.text)));
  w.send({ id: 2, op: 'run', source: 'print ycor' });
  await w.until(() => done(w.sent, 2));
  assert.deepEqual(forRun(w.sent, 2).find((m) => m.op === 'done').segments, [{ kind: 'stdout', text: '10\n' }]);
});

test('interrupt stops an endless drawing loop between slices, keeps what it drew, and the workspace survives', async (t) => {
  const w = startWorker();
  t.after(w.close);
  w.send({ op: 'init' });
  w.send({ id: 1, op: 'run', source: 'to spin\nforever [fd 1 rt 1]\nend\nspin' });
  await w.until(() => forRun(w.sent, 1).some((m) => m.op === 'draw' && m.ops.length > 0));
  w.send({ op: 'interrupt' });
  await w.until(() => done(w.sent, 1));
  assert.equal(forRun(w.sent, 1).find((m) => m.op === 'done').state, 'stopped');
  assert.ok(forRun(w.sent, 1).filter((m) => m.op === 'draw').reduce((n, m) => n + m.ops.length, 0) > 10);
  w.send({ id: 2, op: 'run', source: 'print 1 + 1' });
  await w.until(() => done(w.sent, 2));
  assert.equal(forRun(w.sent, 2).find((m) => m.op === 'done').state, 'done');
});

test('a second run while one is in flight is refused', async (t) => {
  const w = startWorker();
  t.after(w.close);
  w.send({ op: 'init' });
  w.send({ id: 1, op: 'run', source: 'forever [fd 1]' });
  w.send({ id: 2, op: 'run', source: 'print 1' });
  assert.equal(forRun(w.sent, 2)[0].state, 'error');
  assert.match(forRun(w.sent, 2)[0].segments[0].text, /still running/);
  w.send({ op: 'interrupt' });
  await w.until(() => done(w.sent, 1));
});

test('reset gives a fresh workspace: definitions and the turtle are gone', async (t) => {
  const w = startWorker();
  t.after(w.close);
  w.send({ op: 'init' });
  w.send({ id: 1, op: 'run', source: 'to sq\nrepeat 4 [fd 10 rt 90]\nend\nsetxy 3 4' });
  await w.until(() => done(w.sent, 1));
  w.send({ op: 'reset' });
  assert.deepEqual(w.sent[w.sent.length - 1], { op: 'reset', ok: true });
  w.send({ id: 2, op: 'run', source: 'print pos\nsq' });
  await w.until(() => done(w.sent, 2));
  const d = forRun(w.sent, 2).find((m) => m.op === 'done');
  assert.equal(d.state, 'error');
  assert.equal(d.segments[0].text, '0 0\n');
  assert.ok(d.segments.some((s) => s.kind === 'error' && /I don't know how/.test(s.text)));
});

test('BYE ends the cell with state exit', async (t) => {
  const w = startWorker();
  t.after(w.close);
  w.send({ op: 'init' });
  w.send({ id: 1, op: 'run', source: 'print 1\nbye\nprint 2' });
  await w.until(() => done(w.sent, 1));
  assert.equal(forRun(w.sent, 1).find((m) => m.op === 'done').state, 'exit');
});
