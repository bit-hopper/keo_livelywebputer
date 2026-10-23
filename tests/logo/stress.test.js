// Stress and stop: constant-space tail calls, deep non-tail recursion, runaway recursion, the output cap, and
// Job.interrupt() in the middle of a long run (LOGO.md 9.2 and 9.7). These assert on behaviour, not speed; the timings are
// in LOGO.md 15.2. Every run here finishes in well under a second on the development machine, and the generous timeouts
// are only a guard against a hang.
import test from 'node:test';
import assert from 'node:assert/strict';
import { logo, out, newInterpreter } from './helpers.js';

test('a 1M-iteration tail-recursive loop runs in constant space', { timeout: 20000 }, () => {
  const r = logo('to count.up :n :limit\nif :n = :limit [output :n]\noutput count.up :n + 1 :limit\nend\nprint count.up 0 1000000');
  assert.equal(r.text.trim(), 'count.up defined\n1000000');
});

test('a 1M-iteration tail-recursive command loop (no output) runs in constant space', { timeout: 20000 }, () => {
  const r = logo('make "total 0\nto spin :n\nif :n = 0 [stop]\nmake "total :total + 1\nspin :n - 1\nend\nspin 1000000\nprint :total');
  assert.equal(r.text.trim(), 'spin defined\n1000000');
});

test('a tail call keeps the caller\'s variables the callee does not shadow', () => {
  assert.equal(out('to f2\nprint :x\nend\nto f1\nlocal "x\nmake "x 5\nf2\nend\nf1'), 'f2 defined\nf1 defined\n5');
});

test('100k-deep non-tail recursion finishes', { timeout: 20000 }, () => {
  const r = logo('to depth :n\nif :n = 0 [output 0]\noutput 1 + depth :n - 1\nend\nprint depth 100000');
  assert.equal(r.text.trim(), 'depth defined\n100000');
});

test('runaway recursion reports a stack overflow, and the next cell on the same workspace runs', { timeout: 60000 }, () => {
  const it = newInterpreter();
  const r1 = logo('to forever.down :n\noutput 1 + forever.down :n + 1\nend\nprint forever.down 0', { interp: it });
  assert.match(r1.text, /stack overflow/i);
  const r2 = logo('print 2 + 3', { interp: it });
  assert.equal(r2.text.trim(), '5');
});

test('output past the cap is cut off and says so', { timeout: 20000 }, () => {
  const r = logo('repeat 2000000 [print "aaaaaaaaaaaaaaaa]');
  const last = r.segments[r.segments.length - 1];
  assert.equal(last.text, '(output truncated)');
});

// Stop. The job runs in short slices (the worker does this so that Stop can be seen between slices); interrupt() between
// slices ends the run as 'stopped', abandons the half-run line, and leaves the workspace -- globals, procedures -- alone.
test('interrupting FOREVER stops it and leaves the workspace intact', { timeout: 20000 }, () => {
  const it = newInterpreter();
  const first = it.startRun('make "kept 42\nto hello\nprint "hi\nend\nforever [make "n 1]');
  let r = first.step(10);
  assert.equal(r.state, 'running', 'FOREVER is still going after a slice');
  first.interrupt();
  r = first.step(10);
  assert.equal(r.state, 'stopped');

  const next = logo('print :kept\nhello\nprint :n', { interp: it });
  assert.equal(next.text.trim(), '42\nhi\n1');
});

test('interrupt during a long tail-recursive loop, then the next run starts clean', { timeout: 20000 }, () => {
  const it = newInterpreter();
  const job = it.startRun('to spin :n\nspin :n + 1\nend\nspin 0');
  assert.equal(job.step(10).state, 'running');
  job.interrupt();
  assert.equal(job.step(10).state, 'stopped');
  // The machine was abandoned mid-call: no frames or request registers may leak into the next run.
  assert.equal(logo('print "ok', { interp: it }).text.trim(), 'ok');
  assert.equal(logo('print count [a b c]', { interp: it }).text.trim(), '3');
});

test('interrupting before the first slice stops without running anything', () => {
  const it = newInterpreter();
  const job = it.startRun('print "never');
  job.interrupt();
  const r = job.step(10);
  assert.equal(r.state, 'stopped');
  assert.equal(r.segments.length, 0);
});

test('interrupt inside a deep non-tail recursion leaves the next run usable', { timeout: 20000 }, () => {
  const it = newInterpreter();
  const job = it.startRun('to deep :n\noutput 1 + deep :n + 1\nend\nprint deep 0');
  job.step(5);
  job.interrupt();
  const r = job.step(10);
  assert.ok(r.state === 'stopped' || r.state === 'error', 'got ' + r.state);   // it may overflow before the interrupt lands
  assert.equal(logo('print 6 * 7', { interp: it }).text.trim(), '42');
});
