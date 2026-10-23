// Numbers and the error table, written out as plain text. The expected values come from the reference interpreter
// (ucblogo 6.2.5, LOGO.md 11.5 items 2-4); printing is C's printf("%.15g"). The same ground is also covered by the
// recorded probes in differential.test.js; these are here so a failure names the one expression that broke.
import test from 'node:test';
import assert from 'node:assert/strict';
import { out } from './helpers.js';

// [source, expected output]: each source is one instruction line.
function table(cases) {
  for (const [src, want] of cases) assert.equal(out(src), want, src);
}

test('division, powers of ten and exponents print as %.15g', () => table([
  ['print 1/3', '0.333333333333333'], ['print 2/1', '2'], ['print 6/2', '3'], ['print 7/2', '3.5'],
  ['print 3.0', '3'], ['print 2*3.5', '7'], ['print 10/4', '2.5'], ['print 0.1+0.2', '0.3'],
  ['print exp 1', '2.71828182845905'], ['print sqrt 2', '1.4142135623731'], ['print sqrt 16', '4'],
  ['print 1e10', '10000000000'], ['print 2147483647+1', '2147483648'], ['print 123456789*1000', '123456789000'],
  ['print 100000000000*100000000000', '1e+22'], ['print 9007199254740993', '9.00719925474099e+15'],
  ['print 123456789012345678', '1.23456789012346e+17'], ['print 1e15 + 1', '1e+15'],
  ['print 0.000001', '1e-06'], ['print 3.14e-5', '3.14e-05'], ['print 3.10', '3.1'], ['print .5', '0.5'], ['print 5.', '5'],
]));

test('rounding, remainders and formatting', () => table([
  ['print int -3.5', '-3'], ['print round 2.5', '3'], ['print round -2.5', '-3'], ['print round 3.5', '4'],
  ['print remainder -7 2', '-1'], ['print modulo -7 2', '1'], ['print quotient 7 2', '3.5'], ['print power 2 10', '1024'],
  ['print form 3.14159 8 2', '    3.14'], ['print form -2.5 6 1', '  -2.5'], ['print form 2.5 0 0', '2'],
]));

test('trigonometry is in degrees, and sqrt of a negative is not an error', () => table([
  ['print sin 90', '1'], ['print arctan 1', '45'], ['print (arctan 0 -1)', '-90'], ['print radsin 1', '0.841470984807897'],
  ['print ln 10', '2.30258509299405'], ['print log10 100', '2'],
  ['print sqrt -1', '-nan'], ['print power -8 1/3', '-nan'],
]));

test('variadic arithmetic; difference and quotient are strictly binary', () => table([
  ['print (sum 1 2 3 4)', '10'], ['print (product 2 3 4)', '24'], ['print (quotient 4)', '0.25'],
  ['print (difference 10 1 2)', 'too many inputs to difference'], ['print (quotient 8 2 2)', 'too many inputs to quotient'],
  ['print difference 1', 'not enough inputs to difference'],
  ['print 1/0', "/ doesn't like 0 as input"], ['print 0/0', "/ doesn't like 0 as input"],
  ['%', "I don't know how  to %"],
]));

test('comparisons are numeric, equalp is not strict about type', () => table([
  ['print "a < "b', "< doesn't like a as input"], ['print equalp 10 "10', 'true'], ['print equalp 3 3.0', 'true'],
  ['print equalp "3 3.0', 'true'], ['print numberp "3', 'true'], ['print sum "3 4', '7'], ['print count 3.50', '3'],
]));

// Top-level error wording, including the two spaces in "how  to" and the empty word shown as ||.
test('top-level error text', () => table([
  ['foo', "I don't know how  to foo"], ['3', "You don't say what to do with 3"], ['3 + 4', "You don't say what to do with 7"],
  ['"abc', "You don't say what to do with abc"], ['[a b]', "You don't say what to do with [a b]"],
  ['print :zzz', 'zzz has no value'], ['print', 'not enough inputs to print'],
  [')', "unexpected ')'"], [']', "unexpected ']'"],
  ['print item 0 [a b c]', "item doesn't like 0 as input"], ['print first []', "first doesn't like [] as input"],
  ['print last "', "last doesn't like || as input"], ['print item 4 [a b c]', "item doesn't like 4 as input"],
]));

// Inside a procedure the message is followed by two spaces, `in <proc>`, and the instruction line as a list; the rest of
// the line never runs.
test('an uncaught error in a procedure names the procedure and shows the line', () => {
  assert.equal(out('to bad\nprint "start\nprint 1 / 0\nprint "never\nend\nbad'),
    "bad defined\nstart\n/ doesn't like 0 as input  in bad\n[print 1 / 0]");
  assert.equal(out('to bad2\nfoo\nend\nbad2'), "bad2 defined\nI don't know how  to foo  in bad2\n[foo]");
  assert.equal(out('print apply [[x] [:x+3]] [5]'), "You don't say what to do with 8  in apply\n[:x+3]");
});

test('words and data primitives', () => table([
  ['print word 1 2', '12'], ['print first 123', '1'], ['print wordp 3', 'true'], ['print listp []', 'true'],
  ['print emptyp "', 'true'], ['print count []', '0'], ['print uppercase "abc', 'ABC'], ['print before? "a "B', 'true'],
  ['print memberp "A [a b c]', 'true'], ['print fput "a "b', 'ab'], ['show array 3', '{[] [] []}'],
  ['show butfirst "a', ''],
]));
