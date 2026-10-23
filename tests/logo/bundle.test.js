// The committed browser bundle (core/lib/logo/logo-engine.js, built by scripts/build-logo-lib.js): loaded the way a Worker
// loads it -- as a plain script in a context with no module system -- and checked against the source engine, so a stale or
// broken bundle fails here. `npm run test:logo` rebuilds first; run by itself this tests whatever is committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { out, SEED_DIR } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', '..', 'core', 'lib', 'logo', 'logo-engine.js');

// A bare context, like a Worker's global: `self` is the global object, no require/module/process.
function loadBundle() {
  const ctx = vm.createContext({});
  ctx.self = ctx;
  vm.runInContext(fs.readFileSync(bundlePath, 'utf8'), ctx, { filename: 'logo-engine.js' });
  return ctx.LogoEngine;
}

function bundleOut(E, source) {
  const it = E.createInterpreter();
  return it.run(source, { onError: 'continue' }).text.replace(/\s+$/, '');
}

test('the bundle defines LogoEngine with a build id and the engine classes', () => {
  const E = loadBundle();
  assert.ok(E, 'LogoEngine is defined');
  assert.match(E.buildId, /^\d{4}-\d\d-\d\dT/);
  for (const name of ['Interpreter', 'Job', 'LogoError', 'createInterpreter', 'renderSegments']) assert.equal(typeof E[name], 'function', name);
  assert.equal(typeof E.corePrelude, 'string');
  assert.ok(E.corePrelude.includes('to mdarray'), 'the prelude is inlined');
});

test('the bundle runs programs, including a prelude procedure', () => {
  const E = loadBundle();
  assert.equal(bundleOut(E, 'print 1/3\nshow map [? * ?] [1 2 3]'), '0.333333333333333\n[1 4 9]');
  assert.equal(bundleOut(E, 'make "a mdarray [2 2]\nmdsetitem [1 2] :a 7\nprint mditem [1 2] :a'), '7');
});

test('the bundle matches the source engine on every recorded probe', () => {
  const E = loadBundle();
  for (const f of fs.readdirSync(SEED_DIR).filter((n) => n.endsWith('.lg') && !/gui/.test(n))) {
    const src = fs.readFileSync(path.join(SEED_DIR, f), 'utf8');
    // The probes call fd with its real arity; the turtle arrives in Phase 2, so both sides get the same stub.
    const stub = (it) => { for (const n of ['fd', 'forward']) it.procs.set(n, { name: n, key: n, min: 1, def: 1, max: 1, fn: () => {} }); return it; };
    const mine = stub(E.createInterpreter()).run(src, { onError: 'continue' }).text;
    const want = out(src, { turtleStub: true });
    assert.equal(mine.replace(/\s+$/, ''), want, f);
  }
});

test('the bundle can be interrupted', () => {
  const E = loadBundle();
  const it = E.createInterpreter();
  const job = it.startRun('forever [make "n 1]');
  assert.equal(job.step(10).state, 'running');
  job.interrupt();
  assert.equal(job.step(10).state, 'stopped');
});
