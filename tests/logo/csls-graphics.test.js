// The csls graphics program `plot` (a Fourier series plotter, volume 2 chapter 13) run through the real turtle. The
// packaged reference cannot draw in its console build, so the expected picture is computed here in JS from the program's
// own definition (see the comments) and compared with the recorded draw operations. Needs the fetched corpus
// (node tests/logo/fetch-reference.js); skips without it. The program text is GPL and is never committed.
//
// (algs, which LOGO.md 13 lists as needing graphics, contains no turtle command at all: its Phase 1 run covers it.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newInterpreter } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLOT = path.join(here, 'reference', 'csls', 'plot.lg');
const have = fs.existsSync(PLOT);
const skip = have ? false : 'corpus not fetched (node tests/logo/fetch-reference.js)';

// The picture `plot` draws, from its definition: it goes (pen up) to [-xrange 0], then for x = deltax, 2 deltax, ...
// up to 2 xrange it moves to [xcor + deltax, yscale * series(x)], where series(x) is the sum of sin(xscale h x) / h over
// h = maxharm, maxharm - skip, ... while h >= 1, and xscale = cycles * 180 / xrange (degrees).
function expected({ maxharm = 5, deltax = 2, yscale = 75, cycles = 1, xrange = 230, skip = 2 } = {}) {
  const xscale = cycles * 180 / xrange;
  const series = (x) => { let s = 0; for (let h = maxharm; h >= 1; h -= skip) s += Math.sin(xscale * h * x * Math.PI / 180) / h; return s; };
  const pts = [[-xrange, 0]];
  for (let x = deltax; x <= 2 * xrange; x += deltax) pts.push([pts[pts.length - 1][0] + deltax, yscale * series(x)]);
  return pts;
}

function plotRun(call) {
  const it = newInterpreter();
  it.run(fs.readFileSync(PLOT, 'utf8'), { onError: 'continue' });
  const r = it.run(call, { onError: 'continue' });
  return { ...r, it };
}

function checkPicture(call, params) {
  const r = plotRun(call);
  assert.equal(r.text, '', `${call} printed: ${r.text}`);
  const pts = expected(params);
  const ls = r.draw.filter((o) => o.op === 'line');
  assert.equal(ls.length, pts.length - 1, `${call}: number of segments`);
  ls.forEach((l, i) => {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    assert.ok(Math.abs(l.x1 - x0) < 1e-6 && Math.abs(l.y1 - y0) < 1e-6 && Math.abs(l.x2 - x1) < 1e-6 && Math.abs(l.y2 - y1) < 1e-6,
      `${call}: segment ${i} is (${l.x1},${l.y1})-(${l.x2},${l.y2}), want (${x0},${y0})-(${x1},${y1})`);
  });
  return r;
}

test('csls plot draws the Fourier series with the default settings (plot needs an input list: an empty one fails inside the program itself)', { skip }, () => {
  const r = checkPicture('plot [maxharm 5]', {});
  assert.equal(r.draw[0].op, 'clear');           // CLEARSCREEN is the first thing it does
  assert.equal(r.turtle.shown, false);           // HIDETURTLE
  assert.equal(r.it.turtle.screenMode, 'splitscreen');
  assert.equal(r.draw.filter((o) => o.op === 'line').length, 230);
});

test('csls plot takes keyword settings', { skip }, () => {
  checkPicture('plot [cycles 2 yscale 50]', { cycles: 2, yscale: 50 });
  checkPicture('plot [maxharm 9 deltax 5 skip 1]', { maxharm: 9, deltax: 5, skip: 1 });
});

test('csls plot stays inside the window: nothing wraps', { skip }, () => {
  const r = plotRun('plot [maxharm 5]');
  for (const l of r.draw.filter((o) => o.op === 'line')) for (const v of [l.x1, l.x2]) assert.ok(Math.abs(v) <= 250);
});
