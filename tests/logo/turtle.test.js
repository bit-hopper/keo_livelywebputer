// The turtle: its queries and errors against the recorded reference runs, and its draw operations (LOGO.md 6, Phase 2).
//
// Two kinds of test. The probes recorded from the reference's GUI build (tests/logo/seed/turtle-*-gui) are compared line
// by line, numbers within a relative 1e-5 (the reference stores turtle coordinates as single-precision floats and prints
// them to about 8 digits), with an explicit list of the lines that differ on purpose. Everything the reference cannot
// show us (the draw operations, wrap and fence on OUR window, FILLED's polygon) is tested against values worked out by
// hand in the comments.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newInterpreter, SEED_DIR } from './helpers.js';
import { MAX_OPS } from '../../core/lib/logo/src/turtle.js';

// ---- helpers --------------------------------------------------------------------------------------------------------

function run(source, opts = {}) {
  const it = newInterpreter(opts);
  const r = it.run(source, { onError: 'continue' });
  return { ...r, it, text: r.text.replace(/\s+$/, '') };
}
const lines = (r) => r.draw.filter((o) => o.op === 'line');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} vs ${b}`);

// The probe with its file plumbing removed (the engine has no files yet, and the GUI run wrote to one).
function probeSource(name) {
  return fs.readFileSync(`${SEED_DIR}/${name}.lg`, 'utf8').replace(/\r/g, '')
    .split('\n').filter((l) => !/^(openwrite|setwrite|close|bye)\b/.test(l)).join('\n');
}
const recorded = (name) => fs.readFileSync(`${SEED_DIR}/${name}.ucblogo-output.txt`, 'utf8').replace(/\r/g, '').replace(/\n$/, '').split('\n');

// Two output lines are the same when every whitespace-separated token is equal, or both are numbers within 1e-5 relative.
function sameLine(want, got) {
  const a = want.split(' '), b = got.split(' ');
  if (a.length !== b.length) return false;
  return a.every((tok, i) => {
    if (tok === b[i]) return true;
    const x = Number(tok), y = Number(b[i]);
    return tok !== '' && b[i] !== '' && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1e-5 * Math.max(1, Math.abs(x));
  });
}

// Compares ours to the recording. `differs` maps a 1-based line number to why it differs on purpose; a line listed there
// must really differ (so a stale entry fails) and every other line must match.
function checkProbe(name, differs = {}) {
  const want = recorded(name);
  const got = run(probeSource(name)).text.split('\n');
  assert.equal(got.length, want.length, `${name}: line count`);
  for (let i = 0; i < want.length; i++) {
    const same = sameLine(want[i], got[i]);
    if (differs[i + 1] !== undefined) assert.ok(!same, `${name} line ${i + 1} is listed as different (${differs[i + 1]}) but matches`);
    else assert.ok(same, `${name} line ${i + 1}: reference "${want[i]}", ours "${got[i]}"`);
  }
}

// ---- against the reference ------------------------------------------------------------------------------------------

test('turtle state, queries and heading arithmetic match the reference (state probe)', () => {
  checkProbe('turtle-state-gui');
});

test('pen, colour, palette, error text and queries match the reference (pen probe)', () => {
  checkProbe('turtle-pen-gui', {
    // The reference's label font changes when SETSCRUNCH is used, ours is fixed (default 10 17 here, 8 15 there).
    90: 'labelsize after a scrunch round trip',
    // (Line 98, TOWARDS of a point straight up, prints -0 in the reference, an atan2 sign quirk, and 0 here; the numeric
    // comparison treats them as equal, so it is not listed.)
    // The reference calls FILLED inside FILLED "couldn't initialize graphics"; ours says what is wrong.
    111: 'nested FILLED message',
    // The wrap/setpos block: the reference's window is 872 wide by 520 high with pixel rounding (1 off, 259/-260), ours
    // is the square +-250. The rule is tested on our window below.
    116: 'window size', 117: 'window size', 118: 'window size', 119: 'window size', 120: 'window size', 121: 'window size',
    122: 'window size', 123: 'window size', 124: 'window size', 132: 'window size',
  });
});

// ---- motion and the draw operations ---------------------------------------------------------------------------------

test('FD draws one line in the pen colour, in screen space, and the turtle moves', () => {
  const r = run('fd 100\nprint pos');
  assert.equal(r.text, '0 100');
  assert.deepEqual(r.draw, [{ op: 'line', x1: 0, y1: 0, x2: 0, y2: 100, c: [255, 255, 255], w: 1, m: 'paint' }]);
});

test('with the pen up nothing is drawn but the turtle still moves', () => {
  const r = run('pu fd 100 rt 90 fd 5\nprint pos');
  assert.equal(r.text, '5 100');
  assert.deepEqual(r.draw, []);
});

test('right angles are exact: a square returns to 0 0 and RT 90 FD 100 ends at 100 0', () => {
  assert.equal(run('repeat 4 [fd 100 rt 90]\nprint pos\nprint heading').text, '0 0\n0');
  assert.equal(run('rt 90 fd 100\nprint pos').text, '100 0');
  assert.equal(run('lt 90 fd 100\nprint pos').text, '-100 0');
  assert.equal(run('rt 180 fd 100\nprint pos').text, '0 -100');
});

test('headings fold into [0, 360)', () => {
  assert.equal(run('rt 370 print heading lt 400 print heading setheading -0.5 print heading setheading 360 print heading').text, '10\n330\n359.5\n0');
});

test('HOME draws the way back when the pen is down; CLEARSCREEN does not draw', () => {
  const home = run('fd 10 rt 90 fd 10 home');
  assert.equal(lines(home).length, 3);
  assert.deepEqual(lines(home)[2], { op: 'line', x1: 10, y1: 10, x2: 0, y2: 0, c: [255, 255, 255], w: 1, m: 'paint' });
  const cs = run('fd 10 rt 90 fd 10 cs\nprint pos\nprint heading');
  assert.equal(cs.text, '0 0\n0');
  assert.deepEqual(cs.draw.map((o) => o.op), ['line', 'line', 'clear']);
});

test('CLEAN erases the picture and leaves the turtle where it was', () => {
  const r = run('fd 10 clean\nprint pos');
  assert.equal(r.text, '0 10');
  assert.deepEqual(r.draw.map((o) => o.op), ['line', 'clear']);
});

test('TOWARDS answers degrees clockwise from up', () => {
  assert.equal(run('print towards [1 1]\nprint towards [0 -5]\nprint towards [-3 0]').text.split('\n').map(Number).join(' '), '45 180 270');
  assert.equal(run('setxy 5 5\nprint towards [5 5]').text, '0');
});

test('the pen modes reach the draw operations', () => {
  const r = run('pe fd 1 px fd 1 ppt fd 1 pu pd fd 1');
  assert.deepEqual(lines(r).map((l) => l.m), ['erase', 'reverse', 'paint', 'paint']);
});

test('pen size and colour are recorded on each line', () => {
  const r = run('setpensize 3 setpc [100 0 0] fd 5 setpc 2 fd 5');
  assert.deepEqual(lines(r).map((l) => [l.w, l.c]), [[3, [255, 0, 0]], [3, [0, 255, 0]]]);
});

// ---- the window -----------------------------------------------------------------------------------------------------

test('WRAP: a move past the edge is split there and continues from the opposite edge', () => {
  const r = run('fd 300\nprint pos');
  assert.equal(r.text, '0 -200');
  assert.deepEqual(lines(r).map((l) => [l.x1, l.y1, l.x2, l.y2]), [[0, 0, 0, 250], [0, -250, 0, -200]]);
});

test('WRAP: landing exactly on the edge stays there; one step more wraps', () => {
  assert.equal(run('setxy 250 0\nprint pos').text, '250 0');
  assert.equal(run('setxy 250 0 setxy 251 0\nprint pos').text, '-249 0');
  assert.equal(run('setxy 0 -250 setxy 0 -251\nprint pos').text, '0 249');
});

test('WRAP: leaving through a corner wraps both axes', () => {
  const r = run('setheading 45 fd 400\nprint pos');
  const [x, y] = r.text.split(' ').map(Number);
  const d = 400 / Math.SQRT2 - 500;         // 282.84 - 500
  near(x, d); near(y, d);
  // Piece by piece (a corner may be passed in one jump or in two, depending on the last bit of sin 45 against cos 45):
  // every piece lies inside the window and the pieces add up to the whole 400.
  let total = 0;
  for (const l of lines(r)) {
    for (const v of [l.x1, l.y1, l.x2, l.y2]) assert.ok(Math.abs(v) <= 250 + 1e-9, `piece outside the window: ${v}`);
    total += Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
  }
  near(total, 400, 'total length');
  assert.ok(lines(r).length >= 2);
});

test('WRAP with the pen up draws nothing and still wraps', () => {
  const r = run('pu fd 300\nprint pos');
  assert.equal(r.text, '0 -200');
  assert.deepEqual(r.draw, []);
});

test('WRAP: a move of many windows ends at the right place', () => {
  assert.equal(run('fd 1000\nprint pos').text, '0 0');
  // 1250.5 up from the origin: 250 to the edge, two full windows of 500, then 0.5 past the edge.
  const r = run('fd 1250.5\nprint pos');
  near(Number(r.text.split(' ')[1]), -249.5, 'ycor');
  assert.equal(lines(r).length, 4);
  // A move too long to draw piece by piece still ends at the right place (the drawing is cut off, the position is exact).
  assert.equal(run('fd 1.0e9 + 250\nprint pos').text, '0 250');
});

test('FENCE: FD goes as far as the edge, then errors', () => {
  const r = run('fence\ncatch "error [fd 300]\nshow error\nprint pos');
  assert.equal(r.text, '[3 turtle out of bounds [] []]\n0 250');
  assert.deepEqual(lines(r).map((l) => [l.x1, l.y1, l.x2, l.y2]), [[0, 0, 0, 250]]);
});

test('FENCE: an absolute move outside raises the error and does not move', () => {
  const r = run('fence\ncatch "error [setxy 300 0]\nshow error\ncatch "error [setx 1000]\nshow error\ncatch "error [setpos [0 400]]\nprint pos');
  assert.equal(r.text, '[3 turtle out of bounds [] []]\n[3 turtle out of bounds [] []]\n0 0');
  assert.deepEqual(r.draw, []);
});

test('FENCE: inside moves are ordinary, the edge itself is inside, and the error ends the line', () => {
  assert.equal(run('fence setxy 250 -250\nprint pos').text, '250 -250');
  const r = run('fence\nfd 300 print "never\nprint "after');
  assert.equal(r.text, 'turtle out of bounds\nafter');
});

test('FENCE then BK, RT FD and LT FD each stop at their own edge', () => {
  assert.equal(run('fence catch "error [bk 2000]\nprint pos').text, '0 -250');
  assert.equal(run('fence rt 90 catch "error [fd 2000]\nprint pos').text, '250 0');
  assert.equal(run('fence lt 90 catch "error [fd 2000]\nprint pos').text, '-250 0');
});

test('WINDOW: no limit', () => {
  const r = run('window fd 1000\nprint pos');
  assert.equal(r.text, '0 1000');
  assert.equal(lines(r).length, 1);
});

test('TURTLEMODE names the mode; WRAP is the initial one', () => {
  assert.equal(run('print turtlemode window print turtlemode fence print turtlemode wrap print turtlemode').text, 'wrap\nwindow\nfence\nwrap');
});

test('a fenced turtle that is off the window can still go HOME', () => {
  assert.equal(run('window fd 1000 fence home\nprint pos').text, '0 0');
});

test('the window size is an engine option', () => {
  assert.equal(run('fence catch "error [fd 500]\nprint pos', { half: 100 }).text, '0 100');
});

// ---- scrunch --------------------------------------------------------------------------------------------------------

test('SETSCRUNCH stretches the picture but not the turtle coordinates', () => {
  const r = run('setscrunch 2 1 rt 90 fd 10\nprint pos\nprint scrunch');
  assert.equal(r.text, '10 0\n2 1');
  assert.deepEqual(lines(r).map((l) => [l.x1, l.y1, l.x2, l.y2]), [[0, 0, 20, 0]]);
  assert.deepEqual(r.turtle.x, 20);
});

test('a line drawn before SETSCRUNCH keeps its shape', () => {
  const r = run('fd 10 setscrunch 3 3 fd 10');
  assert.deepEqual(lines(r).map((l) => [l.y1, l.y2]), [[0, 10], [30, 60]]);
});

test('SETSCRUNCH narrows the window in turtle coordinates', () => {
  assert.equal(run('fence setscrunch 2 1 rt 90 catch "error [fd 1000]\nprint pos').text, '125 0');
});

// ---- colours --------------------------------------------------------------------------------------------------------

test('a colour set by percentages reads back quantised to 8 bits, as the reference does', () => {
  const r = run('setpc [10 20 30]\nprint pencolor\nfd 1');
  assert.equal(r.text, '9.76577401388571 19.9221789883268 29.6879530022126');
  assert.deepEqual(lines(r)[0].c, [25, 51, 76]);
});

test('PALETTE: the 16 initial colours, the wrap-around beyond them, SETPALETTE from slot 8', () => {
  const r = run('print palette 4\nprint palette 100\nprint palette 8\nsetpalette 9 [100 100 100]\nprint palette 9\nsetpalette 3 [1 2 3]\nprint palette 3');
  assert.equal(r.text.split('\n').join('|'), [
    '99.6108949416342 0 0', '99.6108949416342 0 0', '60.5477988860914 37.5005722133211 23.0472266727703',
    '99.6108949416342 99.6108949416342 99.6108949416342', '0 99.6108949416342 99.6108949416342',
  ].join('|'));
});

test('a SETPALETTE after a line was drawn does not recolour that line; later lines use the new colour', () => {
  const r = run('setpc 9 fd 1 setpalette 9 [0 0 100] fd 1');
  assert.deepEqual(lines(r).map((l) => l.c.join(',')), ['197,136,18', '0,0,255']);
});

test('colour errors name the primitive and the value', () => {
  const r = run('catch "error [setpc -1] show error\ncatch "error [setpc "red] show error\ncatch "error [setpc [1 2]] show error\ncatch "error [setpc 2.5] show error\ncatch "error [palette 1.5] show error\ncatch "error [setpalette 8 5] show error');
  assert.equal(r.text.split('\n').join('|'), [
    "[7 setpc doesn't like -1 as input [] []]", "[7 setpc doesn't like red as input [] []]",
    "[7 setpc doesn't like [1 2] as input [] []]", "[7 setpc doesn't like 2.5 as input [] []]",
    "[7 palette doesn't like 1.5 as input [] []]", "[7 setpalette doesn't like 5 as input [] []]",
  ].join('|'));
});

test('SETBG emits the background colour; the colour reads back as set', () => {
  const r = run('setbg 4\nprint background\nsetbg [50 50 50]\nprint background');
  assert.deepEqual(r.draw.filter((o) => o.op === 'bg').map((o) => o.c), [[255, 0, 0], [127, 127, 127]]);
  assert.equal(r.text, '4\n49.6101319905394 49.6101319905394 49.6101319905394');
});

// ---- state queries --------------------------------------------------------------------------------------------------

test('PEN and SETPEN round-trip the pen', () => {
  const r = run('setpc 3 setpensize 4 pu\nprint pen\nsetpen [pendown erase [2 2] 5 [-1]]\nprint pen\nprint penmode');
  assert.equal(r.text, 'penup paint [4 4] 3 [-1]\npendown erase [2 2] 5 [-1]\nerase');
});

test('SETPENSIZE accepts a number or a list and refuses fractions', () => {
  const r = run('setpensize 3 print pensize setpensize [2 4] print pensize catch "error [setpensize 2.5] show error');
  assert.equal(r.text, "3 3\n2 2\n[7 setpensize doesn't like 2.5 as input [] []]");
});

test('SHOWNP, HIDETURTLE, SETSHAPE and the turtle snapshot', () => {
  const r = run('ht print shownp setshape 1 print shape catch "error [setshape 5] show error st print shownp');
  assert.equal(r.text, "false\nturtle\n[7 setshape doesn't like 5 as input [] []]\ntrue");
  assert.equal(r.turtle.shown, true);
  assert.equal(r.turtle.shape, 'turtle');
});

test('argument errors are the reference\'s', () => {
  const r = run('catch "error [fd "a] show error\ncatch "error [setpos [1]] show error\ncatch "error [setxy 1] show error\ncatch "error [print towards "a] show error');
  assert.equal(r.text.split('\n').join('|'), [
    "[7 fd doesn't like a as input [] []]", "[7 setpos doesn't like [1] as input [] []]",
    '[6 not enough inputs to setxy [] []]', "[7 towards doesn't like a as input [] []]",
  ].join('|'));
});

test('XCOR, YCOR, PEN, SETPEN are library procedures a program may redefine; FD is a primitive', () => {
  const ok = run('to xcor\noutput 42\nend\nprint xcor');
  assert.equal(ok.text, 'xcor defined\n42');
  assert.match(run('to fd :n\nend').text, /fd is a primitive/);
});

// ---- the other drawing operations ------------------------------------------------------------------------------------

test('LABEL emits its text at the turtle, in the pen colour', () => {
  const r = run('setxy 10 20 setpc 4 label [hello world] label 5');
  assert.deepEqual(r.draw.filter((o) => o.op === 'label').map((o) => [o.x, o.y, o.text, o.c, o.h]),
    [[10, 20, 'hello world', [255, 0, 0], 17], [10, 20, '5', [255, 0, 0], 17]]);
});

test('ARC emits an arc about the turtle and leaves it where it was', () => {
  const r = run('rt 30 arc 90 50\nprint pos\nprint heading');
  assert.equal(r.text, '0 0\n30');
  assert.deepEqual(r.draw, [{ op: 'arc', x: 0, y: 0, rx: 50, ry: 50, heading: 30, angle: 90, c: [255, 255, 255], w: 1, m: 'paint' }]);
});

test('FILL emits a flood fill at the turtle', () => {
  const r = run('pu setxy 3 4 setpc 5 fill');
  assert.deepEqual(r.draw, [{ op: 'fill', x: 3, y: 4, c: [255, 0, 255] }]);
});

test('FILLED draws the polygon of the points the turtle visits, beginning and ending where it started', () => {
  const r = run('filled 4 [fd 10 rt 90 fd 10]\nprint pos');
  assert.equal(r.text, '10 10');
  const poly = r.draw.filter((o) => o.op === 'polygon');
  assert.equal(poly.length, 1);
  assert.deepEqual(poly[0].pts, [[0, 0], [0, 10], [10, 10], [0, 0]]);
  assert.deepEqual(poly[0].fill, [255, 0, 0]);
  assert.equal(lines(r).length, 2);          // the pen draws the path as well
});

test('FILLED: STOP and errors inside it abandon that fill and do not leave the next FILLED thinking it is nested', () => {
  const r = run('to f\nfilled 4 [fd 10 stop]\nend\nf\nfilled 1 [fd 1]\ncatch "error [filled 4 [fd "a]]\nfilled 2 [fd 1]\nprint "ok');
  assert.ok(r.text.endsWith('ok'), r.text);
  // Only the two that ran to the end fill; the one STOP left and the one an error left draw their lines, no polygon.
  assert.deepEqual(r.draw.filter((o) => o.op === 'polygon').map((o) => o.fill.join(',')), ['0,0,255', '0,255,0']);
});

test('FILLED inside FILLED is an error, and FILLED is not an operation', () => {
  const r = run('catch "error [filled 4 [filled 5 [fd 1]]] show error\nprint filled 4 [fd 1]');
  assert.match(r.text, /^\[28 FILLED can't be used inside FILLED \[\] \[\]\]/);
  assert.match(r.text, /filled didn't output to print/);
});

// ---- hand-off to the page -------------------------------------------------------------------------------------------

test('Job.step returns draw operations with the slice, and the turtle state only when it changed', () => {
  const it = newInterpreter();
  const job = it.startRun('fd 10\nrt 90\nfd 5');
  const first = job.step(1e9);
  assert.equal(first.state, 'done');
  assert.equal(first.draw.length, 2);
  assert.deepEqual([first.turtle.x, first.turtle.y, first.turtle.heading], [5, 10, 90]);
  const next = it.startRun('print 1').step(1e9);
  assert.deepEqual(next.draw, []);
  assert.equal(next.turtle, null);
});

test('an interrupted drawing loop keeps what it drew and the turtle', () => {
  const it = newInterpreter();
  const job = it.startRun('forever [fd 1 rt 1]');
  let ops = 0;
  const r = job.step(30);
  ops += r.draw.length;
  assert.equal(r.state, 'running');
  job.interrupt();
  const last = job.step(30);
  ops += last.draw.length;
  assert.equal(last.state, 'stopped');
  assert.ok(ops > 100);
  assert.equal(it.run('print 1').text.trim(), '1');
});

test('past the operation cap the turtle still moves, drawing stops, and the cell says so', () => {
  const r = run(`pu setxy 0 0 pd repeat ${MAX_OPS / 2 + 10} [fd 1 bk 1]\nprint pos`);
  assert.equal(r.draw.length, MAX_OPS);
  assert.equal(r.text.split('\n')[0], '0 0');
  assert.ok(r.segments.some((s) => s.kind === 'status' && /drawing truncated/.test(s.text)));
  // CLEAN starts a new picture and the count starts again.
  const again = run(`repeat ${MAX_OPS / 2 + 10} [fd 1 bk 1]\nclean\nfd 5`);
  assert.deepEqual(again.draw[again.draw.length - 1], { op: 'line', x1: 0, y1: 0, x2: 0, y2: 5, c: [255, 255, 255], w: 1, m: 'paint' });
});
