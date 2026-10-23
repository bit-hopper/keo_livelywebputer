// The dialect a procedure was defined in (LOGO.md 4.4): the cell's language reaches the Job as `opts.dialect` and the Proc
// records it. Only the recording is checked here; what a dialect changes (the TPN reader, the heading primitives) has its
// own tests as it is built.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { newInterpreter } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

const DEF = 'to sq\nrepeat 4 [fd 10 rt 90]\nend';

test('a procedure records the dialect of the run that defined it', () => {
  const it = newInterpreter();
  it.run(DEF, { dialect: 'logo' });
  assert.equal(it.procs.get('sq').dialect, 'logo');
  it.run(DEF.replace('sq', 'sq2'), { dialect: 'tpn' });
  assert.equal(it.procs.get('sq2').dialect, 'tpn');
});

test('no dialect, or an unknown one, is Logo', () => {
  const it = newInterpreter();
  it.run(DEF);
  assert.equal(it.procs.get('sq').dialect, 'logo');
  it.run(DEF.replace('sq', 'sq2'), { dialect: 'basic' });
  assert.equal(it.procs.get('sq2').dialect, 'logo');
});

test('redefining a procedure from the other dialect replaces the recorded dialect', () => {
  const it = newInterpreter();
  it.run(DEF, { dialect: 'tpn' });
  it.run(DEF, { dialect: 'logo' });
  assert.equal(it.procs.get('sq').dialect, 'logo');
});

test('procedures the prelude defines are Logo', () => {
  const it = newInterpreter();
  for (const rec of it.procs.values()) if (rec.lines) assert.equal(rec.dialect, 'logo');
});

// The worker maps the run message's `language` onto the dialect; a message without one is Logo.
test('the worker passes the run message\'s language on as the dialect', async (t) => {
  const sent = [];
  const ctx = vm.createContext({ MessageChannel, console });
  ctx.self = ctx;
  ctx.postMessage = (m) => sent.push(JSON.parse(JSON.stringify(m)));
  ctx.importScripts = (url) => {
    const file = path.join(root, url);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'core', 'lib', 'logo', 'logo-worker.js'), 'utf8'), ctx, { filename: 'logo-worker.js' });
  t.after(() => { ctx.yieldChannel.port1.close(); ctx.yieldChannel.port2.close(); });
  const finished = (id) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (sent.some((m) => m.id === id && m.op === 'done')) return resolve();
      if (Date.now() - t0 > 5000) return reject(new Error('timed out'));
      setTimeout(poll, 5);
    })();
  });
  ctx.onmessage({ data: { op: 'init' } });
  const run = async (id, name, language) => {
    const msg = { id, op: 'run', source: 'to ' + name + '\nprint 1\nend' };
    if (language !== undefined) msg.language = language;
    ctx.onmessage({ data: msg });
    await finished(id);
  };
  await run(1, 'a', 'tpn');
  await run(2, 'b', 'logo');
  await run(3, 'c');
  await run(4, 'd', 'scheme');   // not a language of this worker: Logo
  const dialect = (name) => vm.runInContext('interp.procs.get("' + name + '").dialect', ctx);
  assert.deepEqual(['a', 'b', 'c', 'd'].map(dialect), ['tpn', 'logo', 'logo', 'logo']);
});
