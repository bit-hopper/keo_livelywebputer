// The first five figures of the book's section 1.1 (LOGO.md 15.8, Phase 2 exit criterion): the procedures printed with them,
// run on our engine, must draw what the figures show. The procedure listings are short code transcribed from the page images
// (not the OCR text layer; "FORWARD loo" is FORWARD 100 there) and written as Logo, since TPN arrives in Phase 3; each
// expectation is worked out by hand from the figure and the text around it, in the comments, and asserted on the recorded
// draw operations to 1e-9, not on pixels. No book prose is reproduced.
//
// Every figure also has to FIT the default window (+-250): the draw operations are checked to stay inside it, which is the
// same as saying the picture is not cut by a wrap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newInterpreter } from './helpers.js';

function run(source, opts = {}) {
  const it = newInterpreter(opts);
  const r = it.run(source, { onError: 'continue' });
  return { ...r, text: r.text.replace(/\s+$/, ''), it };
}
const lines = (r) => r.draw.filter((o) => o.op === 'line');
const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''}: ${a} vs ${b}`);
const nearPt = (p, q, msg, eps = 1e-9) => { near(p[0], q[0], `${msg} x`, eps); near(p[1], q[1], `${msg} y`, eps); };
const dist = (l) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
// Every vertex a run drew (each line's end point, plus the first start).
function vertices(r) {
  const ls = lines(r);
  return ls.length ? [[ls[0].x1, ls[0].y1], ...ls.map((l) => [l.x2, l.y2])] : [];
}
function fits(r, half = 250) {
  for (const l of lines(r)) for (const v of [l.x1, l.y1, l.x2, l.y2]) assert.ok(Math.abs(v) <= half + 1e-9, `outside the window: ${v}`);
}

// ---- Figure 1.1: a sequence of turtle commands --------------------------------------------------------------------------
// Panels (a)-(f). The turtle starts facing up; RIGHT turns clockwise. Worked out: start (0,0) heading 0; (b) FORWARD 100 ->
// (0,100); (c) RIGHT 90 -> heading 90, same place; (d) FORWARD 150 -> (150,100), LEFT 45 -> heading 45; (e) BACK 100 along
// heading 45 -> (150 - 100 sin 45, 100 - 100 cos 45) = (79.289, 29.289); (f) LEFT 45 -> heading 0, PENUP, FORWARD 100 ->
// (79.289, 129.289) with no new line.

test('figure 1.1: after each panel the turtle is where the figure shows it', () => {
  const k = 100 / Math.SQRT2;
  const panels = [
    ['', [0, 0], 0, 0],                                                    // (a) the turtle starts
    ['forward 100', [0, 100], 0, 1],                                       // (b)
    ['forward 100 right 90', [0, 100], 90, 1],                             // (c)
    ['forward 100 right 90 forward 150 left 45', [150, 100], 45, 2],       // (d)
    ['forward 100 right 90 forward 150 left 45 back 100', [150 - k, 100 - k], 45, 3],   // (e)
    ['forward 100 right 90 forward 150 left 45 back 100 left 45 penup forward 100', [150 - k, 100 - k + 100], 0, 3],   // (f)
  ];
  for (const [src, pos, heading, nLines] of panels) {
    const r = run(src + '\nprint pos\nprint heading');
    const [x, y] = r.text.split('\n')[0].split(' ').map(Number);
    nearPt([x, y], pos, `"${src}" position`, 1e-9);
    near(Number(r.text.split('\n')[1]), heading, `"${src}" heading`);
    assert.equal(lines(r).length, nLines, `"${src}" lines drawn`);
  }
});

test('figure 1.1: the lines are the ones in the figure, with PENUP leaving no trace', () => {
  const r = run('forward 100 right 90 forward 150 left 45 back 100 left 45 penup forward 100');
  const k = 100 / Math.SQRT2;
  const ls = lines(r);
  assert.equal(ls.length, 3);
  nearPt([ls[0].x2, ls[0].y2], [0, 100], 'first line end');
  nearPt([ls[1].x1, ls[1].y1], [0, 100], 'second line start'); nearPt([ls[1].x2, ls[1].y2], [150, 100], 'second line end');
  nearPt([ls[2].x1, ls[2].y1], [150, 100], 'third line start'); nearPt([ls[2].x2, ls[2].y2], [150 - k, 100 - k], 'third line end');
  fits(r);
});

// ---- Figure 1.2: an attempt to draw a triangle --------------------------------------------------------------------------
// TRY.ANGLE turns 60 degrees, the interior angle of an equilateral triangle, where the turtle must turn the exterior angle
// (120). "Running this procedure draws half of a regular hexagon": three sides, headings 0, 60, 120, ending at heading 180.
// Worked out for side 100: (0,0) -> (0,100) -> (50 sqrt 3, 150) -> (100 sqrt 3, 100); the four points all lie on the circle of
// radius 100 about the hexagon's centre (50 sqrt 3, 50).

const TRY_ANGLE = 'to try.angle\n  repeat 3 [forward 100 right 60]\nend\nto try.angle.size :size\n  repeat 3 [forward :size right 60]\nend\nto triangle :size\n  repeat 3 [forward :size right 120]\nend\n';

test('figure 1.2: TRY.ANGLE draws half of a regular hexagon and does not close', () => {
  const r = run(TRY_ANGLE + 'try.angle\nprint pos\nprint heading');
  const ls = lines(r);
  assert.equal(ls.length, 3);
  ls.forEach((l) => near(dist(l), 100, 'side length'));
  const v = vertices(r);
  const c = [50 * Math.sqrt(3), 50];
  nearPt(v[0], [0, 0], 'v0'); nearPt(v[1], [0, 100], 'v1'); nearPt(v[2], [50 * Math.sqrt(3), 150], 'v2'); nearPt(v[3], [100 * Math.sqrt(3), 100], 'v3');
  v.forEach((p, i) => near(Math.hypot(p[0] - c[0], p[1] - c[1]), 100, `vertex ${i} on the hexagon's circle`));
  assert.equal(r.text.split('\n').pop(), '180');
  assert.ok(Math.hypot(v[3][0], v[3][1]) > 100, 'not back at the start');
  fits(r);
});

test('figure 1.2: the size version of TRY.ANGLE draws the same shape scaled', () => {
  const a = vertices(run(TRY_ANGLE + 'try.angle.size 40'));
  const b = vertices(run(TRY_ANGLE + 'try.angle'));
  a.forEach((p, i) => nearPt(p, [b[i][0] * 0.4, b[i][1] * 0.4], `vertex ${i}`, 1e-9));
});

test('figure 1.2: TRIANGLE (turning 120) closes, with three equal sides', () => {
  const r = run(TRY_ANGLE + 'triangle 100\nprint pos\nprint heading');
  const v = vertices(r);
  assert.equal(lines(r).length, 3);
  nearPt(v[1], [0, 100], 'v1'); nearPt(v[2], [50 * Math.sqrt(3), 50], 'v2'); nearPt(v[3], [0, 0], 'back at the start');
  lines(r).forEach((l) => near(dist(l), 100, 'side'));
  assert.equal(r.text.split('\n').pop(), '0');
});

// ---- Figure 1.3: HOUSE -------------------------------------------------------------------------------------------------
// SQUARE leaves the turtle where it started, facing as it started. (a) Running TRIANGLE straight after SQUARE draws the
// triangle INSIDE the square, pointing right: its vertices (0,0), (0,s), (s sqrt 3 / 2, s / 2) all within [0,s]^2. (b) With
// FORWARD SIDE and RIGHT 30 first, TRIANGLE starts at the square's top-left corner heading 30: apex (s/2, s + s sqrt 3 / 2),
// then back down to the top-right corner (s, s) and along the top edge to (0, s): a roof on the house, heading 30 at the end.

const HOUSE = 'to square :side\n  repeat 4 [forward :side right 90]\nend\nto triangle :side\n  repeat 3 [forward :side right 120]\nend\n' +
  'to house.a :side\n  square :side\n  triangle :side\nend\nto house.b :side\n  square :side\n  forward :side\n  right 30\n  triangle :side\nend\n';

test('figure 1.3(a): SQUARE then TRIANGLE draws the triangle inside the square', () => {
  const s = 100;
  const r = run(HOUSE + `house.a ${s}`);
  const ls = lines(r);
  assert.equal(ls.length, 7);
  const tri = vertices({ draw: ls.slice(4) });
  nearPt(tri[0], [0, 0], 'triangle starts at the corner');
  nearPt(tri[1], [0, s], 't1'); nearPt(tri[2], [s * Math.sqrt(3) / 2, s / 2], 't2'); nearPt(tri[3], [0, 0], 't3');
  for (const p of tri) assert.ok(p[0] >= -1e-9 && p[0] <= s + 1e-9 && p[1] >= -1e-9 && p[1] <= s + 1e-9, 'inside the square');
  fits(r);
});

test('figure 1.3(b): with the interface steps the triangle is a roof on the square', () => {
  const s = 100;
  const r = run(HOUSE + `house.b ${s}\nprint pos\nprint heading`);
  const ls = lines(r);
  // SQUARE (4 lines), the FORWARD SIDE interface step (1: it retraces the left wall), TRIANGLE (3).
  assert.equal(ls.length, 8);
  // The walls: a square from the origin, the turtle ending back at the origin.
  const walls = vertices({ draw: ls.slice(0, 4) });
  nearPt(walls[1], [0, s], 'wall 1'); nearPt(walls[2], [s, s], 'wall 2'); nearPt(walls[3], [s, 0], 'wall 3'); nearPt(walls[4], [0, 0], 'wall 4');
  // The roof: from the top-left corner up to the apex, down to the top-right corner, along the top edge.
  nearPt([ls[4].x1, ls[4].y1], [0, 0], 'the interface step starts at the corner');
  nearPt([ls[4].x2, ls[4].y2], [0, s], 'and goes up the left wall');
  const roof = vertices({ draw: ls.slice(5) });
  nearPt(roof[0], [0, s], 'roof starts on the top-left corner');
  nearPt(roof[1], [s / 2, s + s * Math.sqrt(3) / 2], 'apex');
  nearPt(roof[2], [s, s], 'top-right corner');
  nearPt(roof[3], [0, s], 'back along the top edge');
  roof.forEach((p) => assert.ok(p[1] >= s - 1e-9, 'nothing of the roof below the top edge'));
  near(Number(r.text.split('\n').pop()), 30, 'final heading');
  fits(r);
});

// ---- Figure 1.4: designs made by rotating a doodle ------------------------------------------------------------------------
// THING, from the page: FORWARD 100, RIGHT 90, FORWARD 100, RIGHT 90, FORWARD 50, RIGHT 90, FORWARD 50, RIGHT 90, FORWARD 100,
// RIGHT 90, FORWARD 25, RIGHT 90, FORWARD 25, RIGHT 90, FORWARD 50. Worked out: it ends at (25, 125) heading 270, i.e. it
// turns the turtle through 270 degrees (-90). So repeating it rotates the doodle by that much each time: THING1 (four times)
// closes. THING2 and THING3 repeat THING with an extra RIGHT 10 / LEFT 45 and a FORWARD: the heading changes by 280 and by 225
// degrees per round, and a path made by repeating one round closes when the total turning is a multiple of 360, after 9 and
// after 8 rounds (280 k and 225 k are first multiples of 360 at k = 9 and k = 8). The figure's rings have exactly that many
// copies. The book's version runs REPEAT FOREVER; a finite count shows the closed figure, and Stop shows the same pattern
// growing (checked below for CIRCLE).

// The book's procedure is called THING, which is also a Logo primitive (it outputs a variable's value, so `thing "x` is
// `:x`): defining it takes REDEFP, set at the head of the listing below, or the TO line is refused (checked in the next test).
const THING = 'make "redefp "true\nto thing\n  forward 100 right 90 forward 100 right 90 forward 50 right 90 forward 50 right 90\n  forward 100 right 90 forward 25 right 90 forward 25 right 90 forward 50\nend\n' +
  'to thing1\n  repeat 4 [thing]\nend\nto thing2 :n\n  repeat :n [thing right 10 forward 50]\nend\nto thing3 :n\n  repeat :n [thing left 45 forward 100]\nend\n';

test("figure 1.4: the book's name THING is a primitive here, and a program that wants it sets REDEFP first", () => {
  assert.match(run('to thing\nend').text, /thing is a primitive/);
  assert.match(run(THING).text, /thing defined/);
});

test('figure 1.4: THING ends at (25, 125) facing 270', () => {
  const r = run(THING + 'thing\nprint pos\nprint heading');
  assert.equal(r.text.split('\n').slice(-2).join(' | '), '25 125 | 270');
  assert.equal(lines(r).length, 8);
});

test('figure 1.4: THING1 (four THINGs) closes, with 32 sides', () => {
  const r = run(THING + 'thing1\nprint pos\nprint heading');
  assert.equal(r.text.split('\n').slice(-2).join(' | '), '0 0 | 0');
  assert.equal(lines(r).length, 32);
  fits(r);
});

test('figure 1.4: THING2 closes after 9 rounds and not before; THING3 after 8 and not before', () => {
  for (const [name, rounds] of [['thing2', 9], ['thing3', 8]]) {
    const closed = run(`${THING}${name} ${rounds}\nprint pos`);
    const [x, y] = closed.text.split('\n').pop().split(' ').map(Number);
    nearPt([x, y], [0, 0], `${name} after ${rounds} rounds`, 1e-6);
    for (let k = 1; k < rounds; k++) {
      const part = run(`${THING}${name} ${k}\nprint pos`).text.split('\n').pop().split(' ').map(Number);
      assert.ok(Math.hypot(part[0], part[1]) > 1e-3, `${name} is at the start after only ${k} of ${rounds} rounds`);
    }
  }
});

test('figure 1.4: THING2 and THING3 have 9 and 8 rounds of 9 sides', () => {
  // A round is THING's 8 sides plus the extra FORWARD: 9 sides. (Counted in WINDOW mode: a figure that wraps is cut into
  // more pieces, see the next test.)
  assert.equal(lines(run(`window\n${THING}thing2 9`)).length, 81);
  assert.equal(lines(run(`window\n${THING}thing3 8`)).length, 72);
});

// Measured, window mode: THING1 spans x -200..100, y -75..225; THING3 x -204.8..136.6, y -153..188.4; THING2 x -288.3..100,
// y -140.8..249.5. The default window is +-250 (LOGO.md decision 16), so THING2 reaches 38 units past its left edge and, run
// there in WRAP mode, is cut and continued on the right: a visibly different picture from the book's. (The decision's
// reasoning, "the book figures only need the central +-100", does not hold for this figure.) It fits a window of +-300.
test('figure 1.4: THING1 and THING3 fit the default window; THING2 needs a window of at least 289', () => {
  fits(run(`${THING}thing1`)); fits(run(`${THING}thing3 8`));
  const wrapped = run(`${THING}thing2 9`);
  assert.ok(lines(wrapped).length > 81, 'the default window cuts it');
  const wide = run(`${THING}thing2 9`, { half: 300 });
  assert.equal(lines(wide).length, 81);
  fits(wide, 300);
  const xs = lines(run(`window\n${THING}thing2 9`)).flatMap((l) => [l.x1, l.x2]);
  near(Math.min(...xs), -288.3, 'leftmost point', 0.05);
});

test('figure 1.4: THING3 has the eight-fold symmetry of the figure', () => {
  // Each round is the previous one turned clockwise by 225 degrees about a fixed centre, and 225 degrees generates the
  // rotations by multiples of 45: so the vertex set is unchanged by a 45 degree turn about its own centroid.
  // The ends of the 72 sides (the start point is the last of them, the figure being closed): the first point alone would
  // count (0,0) twice.
  const v = vertices(run(`${THING}thing3 8`)).slice(1);
  const c = [v.reduce((sum, p) => sum + p[0], 0) / v.length, v.reduce((sum, p) => sum + p[1], 0) / v.length];
  const th = 45 * RAD;
  const rotated = v.map((p) => {
    const dx = p[0] - c[0], dy = p[1] - c[1];
    return [c[0] + dx * Math.cos(th) + dy * Math.sin(th), c[1] - dx * Math.sin(th) + dy * Math.cos(th)];
  });
  for (const q of rotated) {
    assert.ok(v.some((p) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6), `the turned vertex (${q}) is not a vertex`);
  }
});

// ---- Figure 1.5: CIRCLE ---------------------------------------------------------------------------------------------------
// FORWARD 1, RIGHT 1 repeated is a regular polygon of side 1 and exterior angle 1 degree: a "circle" that closes after
// exactly 360 chunks (the text says so). Worked out: the circumradius is R = 1 / (2 sin 0.5 degrees) = 57.2965 and, the first
// side running straight up from the origin and the turtle turning right, the centre is at (apothem, 0.5) with
// apothem = 1 / (2 tan 0.5 degrees). 180 chunks give the semicircle (heading 180, at the antipode (2 apothem, 1)); 60 chunks
// give the 60 degree arc.

const CIRCLE = 'to circle\n  repeat 360 [forward 1 right 1]\nend\nto circle.forever\n  forever [forward 1 right 1]\nend\nto arcr :r :deg\n  repeat :deg [forward :r right 1]\nend\n';
const RAD = Math.PI / 180;
const APOTHEM = 1 / (2 * Math.tan(0.5 * RAD));
const CIRCUMRADIUS = 1 / (2 * Math.sin(0.5 * RAD));

test('figure 1.5: REPEAT 360 [FORWARD 1 RIGHT 1] closes precisely, on a circle of radius 57.2965', () => {
  const r = run(CIRCLE + 'circle\nprint pos\nprint heading');
  assert.equal(lines(r).length, 360);
  const [x, y] = r.text.split('\n').slice(-2)[0].split(' ').map(Number);
  nearPt([x, y], [0, 0], 'closed', 1e-9);
  near(Number(r.text.split('\n').pop()), 0, 'heading');
  const c = [APOTHEM, 0.5];
  vertices(r).forEach((p, i) => near(Math.hypot(p[0] - c[0], p[1] - c[1]), CIRCUMRADIUS, `vertex ${i} on the circle`, 1e-9));
  near(CIRCUMRADIUS, 57.2965, 'circumradius', 1e-4);
  fits(r);
});

test('figure 1.5: 180 chunks are a semicircle and 60 chunks a 60 degree arc', () => {
  const semi = run(CIRCLE + 'repeat 180 [forward 1 right 1]\nprint pos\nprint heading');
  const [x, y] = semi.text.split('\n').slice(-2)[0].split(' ').map(Number);
  nearPt([x, y], [2 * APOTHEM, 1], 'the far side of the circle', 1e-9);
  near(Number(semi.text.split('\n').pop()), 180, 'heading');
  const arc = run(CIRCLE + 'repeat 60 [forward 1 right 1]\nprint heading');
  near(Number(arc.text.split('\n').pop()), 60, 'arc heading');
});

test('figure 1.5: ARCR R DEG scales the arc: radius R times as big, same closing rule', () => {
  const big = run(CIRCLE + 'arcr 2 360\nprint pos\nprint heading');
  const [x, y] = big.text.split('\n').slice(-2)[0].split(' ').map(Number);
  nearPt([x, y], [0, 0], 'a full ARCR closes', 1e-9);
  const c = [2 * APOTHEM, 1];
  vertices(big).forEach((p, i) => near(Math.hypot(p[0] - c[0], p[1] - c[1]), 2 * CIRCUMRADIUS, `vertex ${i}`, 1e-8));
});

test('figure 1.5: the REPEAT FOREVER version draws the same arc until Stop', () => {
  const it = newInterpreter();
  const job = it.startRun(CIRCLE + 'circle.forever');
  const ops = [];
  let r = job.step(30);
  ops.push(...r.draw);
  assert.equal(r.state, 'running');
  job.interrupt();
  r = job.step(30);
  ops.push(...r.draw);
  assert.equal(r.state, 'stopped');
  const ls = ops.filter((o) => o.op === 'line');
  assert.ok(ls.length > 360, 'it kept drawing');   // it passes the full circle and retraces it (the figure is a circle, not a spiral)
  const c = [APOTHEM, 0.5];
  ls.forEach((l, i) => near(Math.hypot(l.x2 - c[0], l.y2 - c[1]), CIRCUMRADIUS, `side ${i} end on the circle`, 1e-6));
});
