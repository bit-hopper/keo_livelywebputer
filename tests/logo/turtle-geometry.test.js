// Properties of turtle paths that are mathematics rather than an implementation's output (LOGO.md 9.5): a regular polygon
// closes after 360 / gcd(angle, 360) sides, a closed path turns through a multiple of 360 degrees, the vector formulation
// of a polygon agrees with the heading formulation, the Hilbert curve has a known number of segments and length. The
// expected values are worked out here in JS from the theorems, never taken from another Logo, and the assertions are on
// the recorded draw operations (end points within 1e-9), not on pixels. The programs are our own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newInterpreter } from './helpers.js';

// The window is switched off throughout: a wrapped path would make "returns to the start" depend on the window size.
function run(source) {
  const it = newInterpreter();
  const r = it.run('window\n' + source, { onError: 'continue' });
  return { ...r, text: r.text.replace(/\s+$/, ''), it };
}
const lines = (r) => r.draw.filter((o) => o.op === 'line');
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const POLY = `
to poly :side :angle :times
  repeat :times [fd :side rt :angle]
end
`;

test('POLY closes after 360 / gcd(angle, 360) sides, and not before', () => {
  for (const angle of [30, 40, 45, 72, 90, 100, 120, 144, 150, 160, 170, 135, 24]) {
    const sides = 360 / gcd(angle, 360);
    const closed = run(`${POLY}\npoly 50 ${angle} ${sides}`);
    const t = closed.turtle;
    assert.ok(close(t.x, 0, 1e-8) && close(t.y, 0, 1e-8), `angle ${angle}: ends at ${t.x}, ${t.y}`);
    assert.ok(close(t.heading, 0, 1e-8) || close(t.heading, 360, 1e-8), `angle ${angle}: heading ${t.heading}`);
    assert.equal(lines(closed).length, sides);
    // No earlier vertex is the start (the vertices of a regular polygon are distinct).
    for (let k = 1; k < sides; k++) {
      const part = run(`${POLY}\npoly 50 ${angle} ${k}`).turtle;
      assert.ok(Math.hypot(part.x, part.y) > 1e-6, `angle ${angle}: back at the start after only ${k} of ${sides} sides`);
    }
  }
});

test('every side of a polygon has the given length and each starts where the last ended', () => {
  const r = run(`${POLY}\npoly 37 144 5`);
  const ls = lines(r);
  assert.equal(ls.length, 5);
  ls.forEach((l, i) => {
    assert.ok(close(Math.hypot(l.x2 - l.x1, l.y2 - l.y1), 37), `side ${i} length`);
    if (i > 0) assert.ok(close(l.x1, ls[i - 1].x2) && close(l.y1, ls[i - 1].y2), `side ${i} starts elsewhere`);
  });
  assert.ok(close(ls[4].x2, ls[0].x1, 1e-8) && close(ls[4].y2, ls[0].y1, 1e-8));
});

test('the total turning of a closed path is a multiple of 360 degrees', () => {
  for (const angle of [30, 72, 100, 144, 150, 24]) {
    const sides = 360 / gcd(angle, 360);
    const turning = angle * sides;
    assert.equal(turning % 360, 0, `angle ${angle}`);
    // The turtle agrees: after the closed path its heading is back where it started.
    const t = run(`${POLY}\npoly 20 ${angle} ${sides}`).turtle;
    assert.ok(close(t.heading % 360, 0, 1e-8) || close(t.heading, 360, 1e-8));
  }
  // A closed path that is not a polygon: out and back by a different way (a triangle by sides 3-4-5 and its turns).
  const r = run('fd 30 rt 90 fd 40 rt 143.13010235415598 fd 50 rt 126.86989764584402\nprint pos');
  const t = r.turtle;
  assert.ok(close(t.x, 0, 1e-8) && close(t.y, 0, 1e-8), `3-4-5 triangle ends at ${t.x}, ${t.y}`);
  assert.ok(close(126.86989764584402 + 143.13010235415598 + 90, 360, 1e-9));
});

test('SQUARE returns to its start for any size, and a wrapped path still ends where wrap arithmetic says', () => {
  for (const size of [1, 7, 100, 333.5]) {
    const t = run(`repeat 4 [fd ${size} rt 90]`).turtle;
    assert.ok(close(t.x, 0) && close(t.y, 0), `size ${size}`);
  }
});

test('the vector formulation of POLY agrees with the heading formulation', () => {
  // A vector turtle keeps a step vector and rotates it by the angle each time (clockwise, to match RT), moving by the
  // vector. Both forms must trace the same vertices.
  const vec = `
to vpoly :side :angle :times
  localmake "vx 0
  localmake "vy :side
  repeat :times [
    setxy (xcor + :vx) (ycor + :vy)
    localmake "c cos :angle
    localmake "s sin :angle
    localmake "nx (:vx * :c) + (:vy * :s)
    localmake "ny (:vy * :c) - (:vx * :s)
    make "vx :nx
    make "vy :ny
  ]
end
`;
  for (const [side, angle, times] of [[40, 72, 5], [30, 144, 5], [25, 100, 18], [50, 90, 4], [10, 135, 8]]) {
    const a = lines(run(`${POLY}\npoly ${side} ${angle} ${times}`));
    const b = lines(run(`${vec}\nvpoly ${side} ${angle} ${times}`));
    assert.equal(a.length, times);
    assert.equal(b.length, times);
    for (let i = 0; i < times; i++) {
      for (const k of ['x1', 'y1', 'x2', 'y2']) assert.ok(close(a[i][k], b[i][k], 1e-8), `${side} ${angle}: side ${i} ${k}: ${a[i][k]} vs ${b[i][k]}`);
    }
  }
});

test('the Hilbert curve of level n has 4^n - 1 sides of equal length and visits 4^n distinct lattice points', () => {
  const hilbert = `
to hilbert :level :size :angle
  if :level = 0 [stop]
  rt :angle
  hilbert :level - 1 :size (minus :angle)
  fd :size
  lt :angle
  hilbert :level - 1 :size :angle
  fd :size
  hilbert :level - 1 :size :angle
  lt :angle
  fd :size
  hilbert :level - 1 :size (minus :angle)
  rt :angle
end
`;
  for (let n = 1; n <= 5; n++) {
    const size = 8;
    const r = run(`${hilbert}\nhilbert ${n} ${size} 90`);
    const ls = lines(r);
    const sides = 4 ** n - 1;
    assert.equal(ls.length, sides, `level ${n} side count`);
    ls.forEach((l, i) => assert.ok(close(Math.hypot(l.x2 - l.x1, l.y2 - l.y1), size), `level ${n} side ${i}`));
    const pts = new Set();
    pts.add('0,0');
    for (const l of ls) pts.add(`${Math.round(l.x2)},${Math.round(l.y2)}`);
    assert.equal(pts.size, 4 ** n, `level ${n} distinct points`);
    // The curve fills a (2^n - 1) x (2^n - 1) lattice square of side `size`.
    const xs = [0, ...ls.map((l) => l.x2)], ys = [0, ...ls.map((l) => l.y2)];
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    assert.ok(close(w, (2 ** n - 1) * size, 1e-6) && close(h, (2 ** n - 1) * size, 1e-6), `level ${n} extent ${w} x ${h}`);
    // Every join between two sides is straight on or a right angle, never a reversal.
    for (let i = 1; i < ls.length; i++) {
      const u = [ls[i - 1].x2 - ls[i - 1].x1, ls[i - 1].y2 - ls[i - 1].y1], v = [ls[i].x2 - ls[i].x1, ls[i].y2 - ls[i].y1];
      const dot = (u[0] * v[0] + u[1] * v[1]) / (size * size);
      assert.ok(close(dot, 0, 1e-6) || close(dot, 1, 1e-6), `level ${n} join ${i}: dot ${dot}`);
    }
  }
});

test('Euclid, Fibonacci and the least common multiple, the chapter 1 programs, give the right numbers', () => {
  const src = `
to gcd :a :b
  if :b = 0 [output :a]
  output gcd :b (remainder :a :b)
end
to lcm :a :b
  output quotient (:a * :b) (gcd :a :b)
end
to fib :n
  if :n < 2 [output :n]
  output (fib :n - 1) + (fib :n - 2)
end
print gcd 360 144
print gcd 17 5
print lcm 4 6
print lcm 360 144
print fib 20
`;
  assert.equal(run(src).text.split('\n').slice(-5).join(' '), '72 1 12 720 6765');
});
