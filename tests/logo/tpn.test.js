// The TPN reader and analyser (core/lib/logo/src/tpn.js, LOGO.md 4.3). The programs here are our own; the expected output of
// each was worked out by hand from what the notation means, not recorded from anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newInterpreter } from './helpers.js';

// Runs a TPN source on `interp` (a fresh one by default) and returns what it printed, trailing blanks trimmed. The
// "x defined" lines are left in; use `quiet` to drop them.
function tpn(source, { interp = newInterpreter(), quiet = true, ...opts } = {}) {
  const r = interp.run(source, { dialect: 'tpn', onError: 'continue', quiet, ...opts });
  return r.text.replace(/\s+$/, '');
}
const lines = (...xs) => xs.join('\n');

test('arithmetic precedence, grouping, exponent and unary minus', () => {
  assert.equal(tpn(lines('PRINT 5+2*3-7', 'PRINT (5+2)*(3-7)', 'PRINT 2 ^ 3 ^ 2', 'PRINT -2 ^ 2', 'PRINT 10 - -3', 'PRINT 7 / 2')),
    lines('4', '-28', '512', '-4', '13', '3.5'));
});

test('strings, variables, and the arrow in both spellings', () => {
  assert.equal(tpn(lines('BIG <- 10000', 'SMALL <- .005', 'CHEER <- "TURTLE, TURTLE, RAH"', 'PRINT BIG * SMALL', 'PRINT CHEER', 'Z ← 4', 'PRINT Z + 1')),
    lines('50', 'TURTLE, TURTLE, RAH', '5'));
  assert.equal(tpn('PRINT "SQRT 144"\nPRINT SQRT 144'), lines('SQRT 144', '12'));
});

test('comments and blank lines are ignored wherever they are, whatever their indentation', () => {
  const src = lines(
    '; a comment at the top',
    'TO TWICE N',
    '        ; a comment indented more than the body',
    '   RETURN N * 2   ; and one after code',
    '',
    '   ; and one between lines',
    'PRINT TWICE 21',
    'PRINT "a;b"');
  assert.equal(tpn(src), lines('42', 'a;b'));
});

test('a prefix call takes as many inputs as the procedure does; infix binds tighter than a prefix input', () => {
  const src = lines(
    'TO AVG A B',
    '   RETURN (A + B) / 2',
    'X <- 1',
    'PRINT AVG X + 3 AVG 3 * 2 SQRT 4',
    'PRINT AVG 5 7',
    'AV <- (AVG 5 7) - 6',
    'PRINT AV');
  // AVG(X + 3, AVG(3 * 2, SQRT 4)) = AVG(4, AVG(6, 2)) = AVG(4, 4) = 4
  assert.equal(tpn(src), lines('4', '6', '0'));
});

test('a parenthesised, comma separated input list; a paren straight after a name is that call; a spaced group is grouping', () => {
  const src = lines(
    'TO F A B C',
    '   RETURN A * 100 + B * 10 + C',
    'PRINT F (1, 2, 3)',
    'PRINT F(4, 5, 6)',
    'PRINT ABS(0 - 7) + 1',
    'PRINT (SQRT 144) + (SQRT 144)',
    'PRINT REMAINDER (7, 4) = 3',
    'PRINT F 1 F 0 0 0 F (0, 0, 0)');
  assert.equal(tpn(src), lines('123', '456', '8', '24', 'true', '100'));
});

test('a spaced group with two inputs and no comma is a call (RAND ( - A A ))', () => {
  const src = lines(
    'TO SPAN A',
    '   RETURN RAND ( - A A )',
    'REPEAT 200',
    '   V <- SPAN 5',
    '   IF V < -5 THEN PRINT "low"',
    '   IF V > 5 THEN PRINT "high"',
    'PRINT "ok"');
  assert.equal(tpn(src), 'ok');
});

test('RAND with whole numbers gives whole numbers from both ends; with reals, a real in the range', () => {
  const it = newInterpreter();
  let n = 0;
  it.rng = () => [0, 0.999999, 0.5, 0.25][n++ % 4];
  assert.equal(tpn('PRINT RAND(3, 6)\nPRINT RAND(3, 6)\nPRINT RAND(1, 2)', { interp: it }), lines('3', '6', '2'));
  it.rng = () => 0.5;
  assert.equal(tpn('PRINT RAND(1.5, 2.5)', { interp: it }), '2');
});

test('IF: inline THEN and ELSE, no THEN, a THEN-less block, and RETURN with no value', () => {
  const src = lines(
    'TO GREATER X Y',
    '   IF X > Y THEN RETURN X ELSE RETURN Y',
    'TO LAZY D',
    '   IF D > 50 THEN RETURN',
    '   PRINT D',
    'TO SIGN N',
    '   IF N < 0 RETURN "neg"',
    '   IF N = 0',
    '      RETURN "zero"',
    '   RETURN "pos"',
    'PRINT GREATER 3 9',
    'PRINT GREATER 9 3',
    'LAZY 100',
    'LAZY 20',
    'PRINT SIGN -4',
    'PRINT SIGN 0',
    'PRINT SIGN 4');
  assert.equal(tpn(src), lines('9', '9', '20', 'neg', 'zero', 'pos'));
});

test('IF: THEN and ELSE each followed by an indented block, alone on their lines or with the first action beside them', () => {
  const src = lines(
    'TO CLASSIFY N',
    '   IF N < 0',
    '      THEN',
    '         PRINT "negative"',
    '         PRINT "below zero"',
    '      ELSE',
    '         PRINT "not negative"',
    '         IF N = 0',
    '            THEN PRINT "zero"',
    '               PRINT "exactly"',
    '            ELSE PRINT "positive"',
    'CLASSIFY -1',
    'CLASSIFY 0',
    'CLASSIFY 3');
  assert.equal(tpn(src), lines('negative', 'below zero', 'not negative', 'zero', 'exactly', 'not negative', 'positive'));
});

test('IF: an ELSE on the line after, at the same indentation as the IF; the same at the top level of a cell', () => {
  const src = lines(
    'TO T N',
    '   IF N > 0',
    '      PRINT "yes"',
    '   ELSE',
    '      PRINT "no"',
    '   PRINT "end"',
    'T 1',
    'T 0',
    'IF 1 > 2 PRINT "a"',
    'ELSE PRINT "b"',
    'IF 2 > 1',
    '   PRINT "c"',
    'ELSE',
    '   PRINT "d"');
  assert.equal(tpn(src), lines('yes', 'end', 'no', 'end', 'b', 'c'));
});

test('REPEAT n, with the body on following lines or beside it', () => {
  assert.equal(tpn(lines('N <- 0', 'REPEAT 3', '   N <- N + 2', '   PRINT N', 'REPEAT 2 PRINT "x"')), lines('2', '4', '6', 'x', 'x'));
});

test('REPEAT FOREVER ends through RETURN, STOP or an error; REPEAT UNTIL tests first; REPEAT ... UNTIL tests after', () => {
  const src = lines(
    'TO COUNT.TO N',
    '   I <- 0',
    '   REPEAT FOREVER',
    '      I <- I + 1',
    '      IF I > N THEN RETURN I',
    'TO TEST.FIRST',
    '   X <- 5',
    '   REPEAT UNTIL X > 3',
    '      PRINT "never"',
    '      X <- X + 1',
    '   PRINT "done first"',
    'TO TEST.AFTER',
    '   X <- 5',
    '   REPEAT',
    '      PRINT "once"',
    '      X <- X + 1',
    '   UNTIL X > 3',
    '   PRINT X',
    'TO LEAVE',
    '   REPEAT FOREVER',
    '      REPEAT 3',
    '         STOP',
    '   PRINT "not reached"',
    'PRINT COUNT.TO 4',
    'TEST.FIRST',
    'TEST.AFTER',
    'LEAVE',
    'PRINT "after"');
  assert.equal(tpn(src), lines('5', 'done first', 'once', '6', 'after'));
});

test('REPEAT FOR counts up or down, and over the items of a list', () => {
  const src = lines(
    'TO SEQ X Y',
    '   REPEAT FOR I = X TO Y',
    '      PRINT I',
    'SEQ 3 5',
    'SEQ 2 0',
    'REPEAT FOR W IN [1 (1+1) 3 * 4]',
    '   PRINT W',
    'REPEAT FOR W IN []',
    '   PRINT "none"');
  assert.equal(tpn(src), lines('3', '4', '5', '2', '1', '0', '1', '2', '12'));
});

test('lists: items are evaluated, nest, and a minus with a blank before and none after starts a new item', () => {
  const src = lines(
    'A <- 2',
    'L <- [1 (3+5) A]',
    'PRINT L',
    'PRINT [1 2 [3 4 5]]',
    'B <- [5 -1]',
    'PRINT B',
    'PRINT COUNT B',
    'PRINT [5 - 1]',
    'PRINT ITEM (ITEM ([1 2 [3 4 5]], 3), 2)',
    'PRINT ITEM([7 8 9], 1)',
    'PRINT FIRST [7 8 9]',
    'PRINT REST [7 8 9]',
    'PRINT [A A * A]');
  assert.equal(tpn(src), lines('1 8 2', '1 2 [3 4 5]', '5 -1', '2', '4', '4', '7', '7', '8 9', '2 4'));
});

test('structure-directed assignment and structured inputs', () => {
  const src = lines(
    'TO VSUM (V, W)',
    '   RETURN [ITEM(V,1)+ITEM(W,1) ITEM(V,2)+ITEM(W,2)]',
    'TO VSUM2 ([V1 V2], [W1 W2])',
    '   RETURN [(V1 + W1) (V2 + W2)]',
    'TO SWAP2 ([P [Q R]])',
    '   RETURN [R Q P]',
    'A <- [1 3]',
    'B <- [5 -1]',
    'PRINT VSUM (A, B)',
    'PRINT VSUM2 (A, B)',
    '[X Y] <- B',
    'PRINT X',
    'PRINT Y',
    '[P [Q R]] <- [1 [2 3]]',
    'PRINT P + Q + R',
    'PRINT SWAP2 [1 [2 3]]');
  assert.equal(tpn(src), lines('6 2', '6 2', '5', '-1', '6', '3 2 1'));
});

test('inputs are local to each call, so recursion keeps one per level', () => {
  const src = lines(
    'TO FACT N',
    '   IF N < 2 THEN RETURN 1',
    '   RETURN N * FACT N - 1',
    'TO DOWN N',
    '   IF N < 1 THEN STOP',
    '   PRINT N',
    '   DOWN N - 1',
    '   PRINT N',
    'N <- 10',
    'PRINT FACT 6',
    'DOWN 2',
    'PRINT N');
  assert.equal(tpn(src), lines('720', '2', '1', '1', '2', '10'));
});

test('a tail-recursive TPN procedure runs in constant space', () => {
  const src = lines(
    'TO SPIN N ACC',
    '   IF N = 0 THEN RETURN ACC',
    '   RETURN SPIN (N - 1, ACC + 1)',
    'PRINT SPIN (300000, 0)');
  assert.equal(tpn(src), '300000');
});

test('a name that is a Logo primitive can be defined as a TPN procedure without touching the primitive', () => {
  const it = newInterpreter();
  assert.equal(tpn(lines('TO SUM (V, W)', '   RETURN [ITEM(V,1)+ITEM(W,1) ITEM(V,2)+ITEM(W,2)]', 'PRINT SUM([1 3], [5 -1])'), { interp: it, quiet: false }),
    lines('SUM defined', '6 2'));
  // The primitive is still what Logo cells (and the prelude) call.
  assert.equal(it.run('print sum 1 2', { onError: 'continue' }).text.trim(), '3');
  assert.equal(it.run('print list "a "b', { onError: 'continue' }).text.trim(), 'a b');
  // Redefining says so.
  assert.equal(tpn('TO SUM A B\n   RETURN A\nPRINT SUM (4, 5)', { interp: it, quiet: false }), lines('SUM redefined', '4'));
});

test('a procedure defined in a tpn cell is callable from a logo cell and the reverse', () => {
  const it = newInterpreter();
  tpn(lines('TO SQ SIZE', '   REPEAT 4', '      FORWARD SIZE', '      RIGHT 90'), { interp: it });
  tpn(lines('TO DOUBLE N', '   RETURN N * 2'), { interp: it });
  const r = it.run(lines('sq 10', 'print pos', 'print double 21', 'to triple :n', 'output :n * 3', 'end'), { onError: 'continue', quiet: true });
  assert.equal(r.text.trim(), lines('0 0', '42'));
  assert.equal(tpn('PRINT TRIPLE 5', { interp: it }), '15');
  assert.equal(it.procs.get('sq').dialect, 'tpn');
  assert.equal(it.procs.get('triple').dialect, 'logo');
});

test('an input shadows a procedure of the same name, and so does a name the body assigns', () => {
  const src = lines(
    'TO F SQRT',
    '   RETURN SQRT + 1',
    'TO G',
    '   ABS <- 7',
    '   RETURN ABS',
    'PRINT F 4',
    'PRINT G',
    'PRINT ABS(0 - 2)');
  assert.equal(tpn(src), lines('5', '7', '2'));
});

test('a name nothing defines reads a global of that name at run time, and says so when there is none', () => {
  const it = newInterpreter();
  tpn('TO SHOW.IT\n   PRINT LATER', { interp: it });
  assert.match(tpn('SHOW.IT', { interp: it }), /I don't know how  to LATER/);
  assert.equal(tpn('LATER <- 3\nSHOW.IT', { interp: it }), '3');
});

test('the turtle: a square closes, and POLY with the angle given closes after 360/gcd sides', () => {
  const src = lines(
    'TO POLY SIDE ANGLE',
    '   TURN <- 0',
    '   REPEAT',
    '      FORWARD SIDE',
    '      LEFT ANGLE',
    '      TURN <- TURN + ANGLE',
    '   UNTIL REMAINDER (TURN, 360) = 0',
    'POLY 10 90',
    'PRINT XCOR',
    'PRINT YCOR');
  const it = newInterpreter();
  const r = it.run(src, { dialect: 'tpn', onError: 'continue', quiet: true });
  assert.equal(r.draw.filter((o) => o.op === 'line').length, 4);
  assert.ok(Math.abs(Number(r.text.split('\n')[0])) < 1e-9);
  const r2 = it.run('CLEARSCREEN\nPOLY 10 144', { dialect: 'tpn', onError: 'continue', quiet: true });
  assert.equal(r2.draw.filter((o) => o.op === 'line').length, 5);
});

test('syntax errors name the problem and the procedure; nothing is defined', () => {
  assert.match(tpn('ELSE PRINT 1'), /unexpected ELSE/);
  assert.match(tpn('THEN PRINT 1'), /unexpected THEN/);
  assert.match(tpn('REPEAT\n   PRINT 1'), /REPEAT needs a count/);
  assert.match(tpn('PRINT (1 + 2'), /missing '\)'/);
  assert.match(tpn('PRINT [1 2'), /missing '\]'/);
  assert.match(tpn('PRINT 3 +'), /the line ends where a value is needed/);
  assert.match(tpn('PRINT "abc'), /missing closing "/);
  assert.match(tpn('PRINT 1 # 2'), /don't understand the character #/);
  assert.match(tpn('PRINT 1\n   PRINT 2'), /indented under one that does not take a block/);
  assert.match(tpn('X <- (1, 2)'), /comma only separates the inputs of a call/);
  assert.equal(tpn('PRINT (1, 2)'), '1 2');   // a name followed by a group with a comma is a call with those inputs
  const it = newInterpreter();
  assert.match(tpn('TO BAD N\n   ELSE PRINT N', { interp: it }), /unexpected ELSE/);
  assert.equal(it.procs.has('bad'), false);
  assert.match(tpn('TO\n', { interp: it }), /TO needs a procedure name/);
});

test('a run-time error inside a TPN procedure names it and shows the TPN line', () => {
  const src = lines(
    'TO BOOM X',
    '   PRINT "before"',
    '   PRINT X + NOSUCH.THING',
    'BOOM 1');
  const out = tpn(src);
  assert.match(out, /before/);
  assert.match(out, /I don't know how {2}to NOSUCH\.THING {2}in BOOM\n\[PRINT X \+ NOSUCH\.THING\]/);
});

test('too few inputs and too many inputs are reported when the call runs', () => {
  const src = lines('TO TWO A B', '   RETURN A + B', 'PRINT TWO 1', 'PRINT TWO (1, 2, 3)', 'PRINT TWO (1, 2)');
  const out = tpn(src);
  assert.match(out, /not enough inputs to TWO/);
  assert.match(out, /too many inputs to TWO/);
  assert.ok(out.endsWith('3'));
});

test('a title line may separate inputs with commas and wrap them in parentheses, and a bracket left open continues the line', () => {
  const src = lines(
    'TO ADD3 (A, B,',
    '         C)',
    '   RETURN [A',
    '           B C]',
    'PRINT ADD3 (1, 2, 3)');
  assert.equal(tpn(src), '1 2 3');
});

test('re-running a cell redefines its procedures and says so; ;# quiet style options are the Job\'s', () => {
  const it = newInterpreter();
  assert.equal(tpn('TO P\n   PRINT 1', { interp: it, quiet: false }), 'P defined');
  assert.equal(tpn('TO P\n   PRINT 2\nP', { interp: it, quiet: false }), lines('P redefined', '2'));
});

test('TEXT / PO show a TPN procedure as typed', () => {
  const it = newInterpreter();
  tpn('TO P A\n   PRINT A', { interp: it });
  const r = it.run('po "p', { onError: 'continue' });
  assert.equal(r.text.trim(), lines('TO P A', '   PRINT A'));
});
