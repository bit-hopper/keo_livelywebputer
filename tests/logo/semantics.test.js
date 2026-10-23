// Dynamic scope, CATCH/THROW/ERROR, TEXT/DEFINE round trips, macros, templates and the way STOP/OUTPUT leave a procedure.
// Values were checked against the reference interpreter (ucblogo 6.2.5, 2026-10-23); where the engine differs on purpose
// the comment says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { out, logo, newInterpreter } from './helpers.js';

test('dynamic scope: a callee sees the caller\'s inputs, LOCAL hides a MAKE', () => {
  const pre = 'make "x 1\nto show.x\nprint :x\nend\n';
  assert.equal(out(pre + 'to shadow :x\nshow.x\nend\nshadow 2'), 'show.x defined\nshadow defined\n2');
  assert.equal(out(pre + 'to loc\nlocal "x\nmake "x 3\nshow.x\nend\nloc\nprint :x'), 'show.x defined\nloc defined\n3\n1');
});

test('MAKE assigns the innermost visible binding; LOCALMAKE creates a local one', () => {
  assert.equal(out('to lm\nlocalmake "y 7\nmake "y :y + 1\noutput :y\nend\nprint lm\nprint namep "y'), 'lm defined\n8\nfalse');
  assert.equal(out('to setg\nmake "newglobal 42\nend\nsetg\nprint :newglobal'), 'setg defined\n42');
  assert.equal(out('make "x 1\nto inner\nmake "x 99\nend\nto outer :x\ninner\nprint :x\nend\nouter 5\nprint :x'),
    'inner defined\nouter defined\n99\n1');
});

test('CATCH returns the THROW value', () => {
  assert.equal(out('print catch "t [(throw "t 5) print "no]'), '5');
  assert.equal(out('catch "t [print "a throw "t print "b]\nprint "after'), 'a\nafter');
  assert.equal(out('to thrower\n(throw "tt 3)\nend\nprint catch "tt [thrower]'), 'thrower defined\n3');
  assert.equal(out('catch "zz [catch "yy [throw "zz] print "inner]\nprint "outer'), 'outer');
});

test('(THROW "T) with no value makes the CATCH output nothing', () => {
  assert.equal(out('print catch "t [(throw "t) print "no]'), "catch didn't output to print");
});

test('ERROR is [code message procname line]; it is empty once the error has been read', () => {
  assert.equal(out('catch "error [print 1/0]\nshow error'), "[4 / doesn't like 0 as input [] []]");
  assert.equal(out('catch "error [foo]\nshow error'), "[13 I don't know how  to foo [] []]");
  assert.equal(out('catch "error [print :nothere]\nshow error\nshow error'), '[11 nothere has no value [] []]\n[]');
  assert.equal(out('catch "error [make "r item 5 [a b]]\nshow error'), "[4 item doesn't like 5 as input [] []]");
  assert.equal(out('catch "error [(throw "error "msg)]\nshow error'), '[35 msg [] []]');
  assert.equal(out('catch "error [print 1/0]\nprint first error'), '4');
  assert.equal(out('catch "error [print 1/0]\nmake "e error\nprint item 2 :e\nshow error'), "/ doesn't like 0 as input\n[]");
  assert.equal(out('print first error'), "first doesn't like [] as input");
});

test('a caught error does not stop the procedure that caught it', () => {
  assert.equal(out('to e1\ncatch "error [print 1/0]\nprint "after.error\nend\ne1'), 'e1 defined\nafter.error');
});

test('THROW with no CATCH reports it and the next line runs', () => {
  assert.equal(out('throw "nocatch\nprint "next'), "Can't find catch tag for nocatch\nnext");
});

test('THROW "TOPLEVEL abandons the whole line quietly', () => {
  assert.equal(out('to tl\nprint "before\nthrow "toplevel\nprint "after\nend\ntl\nprint "next'), 'tl defined\nbefore\nnext');
});

test('an error in the middle of a procedure ends it', () => {
  assert.equal(out('to bad3\nprint "x\nfoo\nprint "y\nend\nbad3'), "bad3 defined\nx\nI don't know how  to foo  in bad3\n[foo]");
});

test('TEXT and FULLTEXT show the procedure as lists', () => {
  const sq = 'to sq :n\noutput :n * :n\nend\n';
  assert.equal(out(sq + 'show text "sq'), 'sq defined\n[[n] [output :n * :n]]');
  assert.equal(out(sq + 'show fulltext "sq'), 'sq defined\n[to sq :n output :n * :n end]');
});

test('DEFINE builds a procedure from text; TEXT gives the same text back', () => {
  assert.equal(out('define "cube [[n] [output :n * :n * :n]]\nprint cube 3\nshow text "cube'), '27\n[[n] [output :n * :n * :n]]');
  assert.equal(out('define "two [[] [print "a] [print "b]]\ntwo\nshow arity "two'), 'a\nb\n[0 0 0]');
});

test('COPYDEF, ERASE and the predicates about definitions', () => {
  const sq = 'to sq :n\noutput :n * :n\nend\n';
  assert.equal(out(sq + 'copydef "sq2 "sq\nprint sq2 5\nprint procedurep "sq2\nerase "sq2\nprint procedurep "sq2'), 'sq defined\n25\ntrue\nfalse');
  assert.equal(out(sq + 'print definedp "sq\nprint definedp "sum\nprint primitivep "sum\nprint primitivep "sq'), 'sq defined\ntrue\nfalse\ntrue\nfalse');
});

// The manual's own example.
test('a macro\'s output is run in the caller', () => {
  const def = '.macro my.repeat :num :instr\nif :num = 0 [output []]\noutput (se :instr (list "my.repeat :num-1 :instr))\nend\n';
  assert.equal(out(def + 'my.repeat 3 [type "x]'), 'my.repeat defined\nxxx');
  assert.equal(out(def + 'print macrop "my.repeat\nto plain\nend\nprint macrop "plain'), 'my.repeat defined\ntrue\nplain defined\nfalse');
});

test('the four template forms', () => {
  assert.equal(out('print apply [[x] :x+3] [5]'), '8');
  assert.equal(out('print apply [[x] [output :x+3]] [5]'), '8');
  assert.equal(out('print apply [[x] output :x+3] [5]'), 'Can only use output inside a procedure');
  assert.equal(out('print apply [[x] [:x+3]] [5]'), "You don't say what to do with 8  in apply\n[:x+3]");
  assert.equal(out('print apply "sum [1 2]'), '3');
  assert.equal(out('show map [[x] :x * 2] [1 2 3]\nshow map "first [abc def]'), '[2 4 6]\n[a d]');
});

test('iteration tools', () => {
  assert.equal(out('show map [? * ?] [2 3 4 5]'), '[4 9 16 25]');
  assert.equal(out('show (map [(word ?1 ?2 ?1)] [a b c] [d e f])'), '[ada beb cfc]');
  assert.equal(out('show (map "word [a b c] [d e f])'), '[ad be cf]');
  assert.equal(out('show filter [? > 2] [1 2 3 4]'), '[3 4]');
  assert.equal(out('print reduce "sum [1 2 3]'), '6');
  assert.equal(out('print reduce [?1 - ?2] [10 3 2]'), '9');     // a right fold: 10 - (3 - 2)
  assert.equal(out('show cascade 5 [lput # ?] []'), '[1 2 3 4 5]');
  assert.equal(out('print cascade 5 [# * ?] 1'), '120');
  assert.equal(out('foreach [a b c] [type ?]'), 'abc');
  assert.equal(out('repeat 3 [type repcount]'), '123');
  assert.equal(out('for [i 1 5 2] [type :i]'), '135');
  assert.equal(out('for [i 5 1 -2] [type :i]'), '531');
  assert.equal(out('print find [? > 2] [1 2 3 4]'), '3');
  assert.equal(out('show (crossmap [word ?1 ?2] [a b] [1 2])'), '[a1 a2 b1 b2]');
  assert.equal(out('show iseq 5 1'), '[5 4 3 2 1]');
  assert.equal(out('show remove "a [a b a c]'), '[b c]');
  assert.equal(out('print gensym'), 'g1');
});

// LOGO.md decision 14: STOP and OUTPUT leave the PROCEDURE through every control construct. The reference (11.5 item 1)
// only ends the construct for REPEAT, FOREVER, CATCH, APPLY and FOREACH-with-STOP; these assertions are the documented
// semantics, so the "reference differs" cases are exactly the REPEAT, CATCH and FOREACH ones.
test('STOP leaves the procedure from inside REPEAT (reference differs)', () => {
  assert.equal(out('to s1\nrepeat 5 [if repcount = 3 [stop] type repcount]\nprint "after\nend\ns1'), 's1 defined\n12');
});

test('OUTPUT leaves the procedure from inside every construct', () => {
  const via = (body) => out(`to o\n${body}\nprint "never\nend\nprint o`);
  assert.equal(via('repeat 5 [if repcount = 3 [output repcount * 10]]'), 'o defined\n30');
  assert.equal(via('run [output 5]'), 'o defined\n5');
  assert.equal(via('foreach [1 2 3] [if ? = 2 [output ?]]'), 'o defined\n2');
  assert.equal(via('for [i 1 5] [if :i = 3 [output :i]]'), 'o defined\n3');
  assert.equal(via('catch "t [output 9]'), 'o defined\n9');
  assert.equal(via('ifelse "true [output 1] [output 2]'), 'o defined\n1');
});

test('property lists', () => {
  assert.equal(out('pprop "p "k 5\nprint gprop "p "k\nshow plist "p'), '5\n[k 5]');
});

// ERRACT. The recorded probe (seed/erract.lg, differential.test.js) covers the cases the reference can be the oracle for;
// these are the machine-level properties around it.
test('ERRACT: the line is still abandoned after the handler, and the next line runs', () => {
  assert.equal(out('make "erract [print "h]\nprint 1/0 print "never\nprint "next'), "h\n/ doesn't like 0 as input\nnext");
});

test('ERRACT: an empty or non-list value means no handler', () => {
  assert.equal(out('make "erract []\nprint 1/0'), "/ doesn't like 0 as input");
  assert.equal(out('make "erract 5\nprint 1/0'), "/ doesn't like 0 as input");
});

test('ERRACT: an error inside the handler is reported and does not start the handler again', () => {
  assert.equal(out('make "erract [print "h foo]\nprint 1/0\nprint "next'), "h\nI don't know how  to foo\nnext");
});

test('ERRACT: the machine is clean afterwards (no handler state leaks into the next line)', () => {
  assert.equal(out('make "erract [print "h]\nprint 1/0\nmake "erract []\nprint 2/0\nprint 3'), "h\n/ doesn't like 0 as input\n/ doesn't like 0 as input\n3");
  assert.equal(out('make "erract [print "h]\ncatch "error [print 1/0]\nshow error'), '[4 / doesn\'t like 0 as input [] []]');
});

test('ERRACT: a job interrupted inside the handler leaves the next run usable', () => {
  const it = newInterpreter();
  const job = it.startRun('make "erract [forever [make "n 1]]\nprint 1/0');
  assert.equal(job.step(10).state, 'running');
  job.interrupt();
  assert.equal(job.step(10).state, 'stopped');
  assert.equal(logo('make "erract []\nprint 1/0\nprint "ok', { interp: it }).text.trim(), "/ doesn't like 0 as input\nok");
});
