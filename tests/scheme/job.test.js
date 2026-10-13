import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newInterp, val, run, stdout } from './helpers.js';

const cases = (pairs, interp) => { for (const [src, want] of pairs) assert.equal(val(src, interp), want, src); };

test('string ports and with-output-to-string', () => {
  const i = newInterp();
  cases([
    ['(with-output-to-string (lambda () (display "hi") (write "x") (newline)))', '"hi\\"x\\"\\n"'],
    ['(call-with-output-string (lambda (p) (display "a" p) (write (list 1 "b") p)))', '"a(1 \\"b\\")"'],
    ['(let ((p (open-output-string))) (write-string "abc" p) (write-char #\\d p) (get-output-string p))', '"abcd"'],
    ['(let ((p (open-input-string "hello (1 2) world"))) (list (read p) (read p) (read p) (eof-object? (read p))))', '(hello (1 2) world #t)'],
    ['(let ((p (open-input-string "ab\\ncd"))) (list (read-char p) (peek-char p) (read-line p) (read-line p) (eof-object? (read-line p))))', '(#\\a #\\b "b" "cd" #t)'],
    ['(read-string 3 (open-input-string "abcdef"))', '"abc"'],
    // output redirection is restored even when the thunk escapes
    ['(guard (e (#t #f)) (with-output-to-string (lambda () (display "lost") (error "x")))) (with-output-to-string (lambda () (display "ok")))', '"ok"'],
  ], i);
  assert.equal(stdout('(guard (e (#t #f)) (with-output-to-string (lambda () (error "x")))) (display "visible")', i), 'visible');
  assert.equal(stdout('(fresh-line) (display "a") (fresh-line) (display "b")', i), 'a\nb');
});

test('console input: the job pauses and resumes', () => {
  const i = newInterp();
  const job = i.startRun('(define name (read-line)) (display (string-append "hello " name)) (define d (read)) (display (* 2 (car d)))');
  let r = job.step(1000);
  assert.equal(r.state, 'input');
  job.provideInput('world');
  r = job.step(1000);
  assert.equal(r.state, 'input');
  job.provideInput('(21 b)');
  r = job.step(1000);
  assert.equal(r.state, 'done');
  assert.equal(job.segments.filter((s) => s.kind === 'stdout').map((s) => s.text).join(''), 'hello world42');
});

test('console input: end of input yields eof', () => {
  const i = newInterp();
  const job = i.startRun('(eof-object? (read-line))');
  assert.equal(job.step(1000).state, 'input');
  job.provideInput(null);
  const r = job.step(1000);
  assert.equal(r.state, 'done');
  assert.equal(job.segments.at(-1).text, '#t');
});

test('read spans lines for an unfinished datum', () => {
  const i = newInterp();
  const job = i.startRun('(read)');
  assert.equal(job.step(1000).state, 'input');
  job.provideInput('(1 2');
  assert.equal(job.step(1000).state, 'input');
  job.provideInput('3)');
  job.step(1000);
  assert.equal(job.segments.at(-1).text, '(1 2 3)');
});

test('time slicing: a long computation yields and can be resumed', () => {
  const i = newInterp();
  const job = i.startRun('(let loop ((n 0)) (if (< n 3000000) (loop (+ n 1)) n))');
  let yields = 0, r;
  do { r = job.step(5); if (r.state === 'running') yields++; } while (r.state === 'running');
  assert.ok(yields >= 2, 'expected several time slices, got ' + yields);
  assert.equal(job.segments.at(-1).text, '3000000');
});

test('Stop: interrupting keeps the global environment', () => {
  const i = newInterp();
  run('(define keep 42)', i);
  const job = i.startRun('(define (spin) (spin)) (spin)');
  assert.equal(job.step(5).state, 'running');
  job.interrupt();
  const r = job.step(5);
  assert.equal(r.state, 'stopped');
  assert.equal(job.segments.at(-1).text, 'Stopped');
  assert.equal(val('keep', i), '42');
});

test('Stop while waiting for input', () => {
  const i = newInterp();
  const job = i.startRun('(read-line)');
  assert.equal(job.step(5).state, 'input');
  job.interrupt();
  assert.equal(job.step(5).state, 'stopped');
});

test('output is capped', () => {
  const i = newInterp();
  const r = i.evalSync('(let loop ((n 0)) (if (< n 200000) (begin (display "0123456789") (loop (+ n 1)))))');
  const text = r.segments.filter((s) => s.kind === 'stdout').map((s) => s.text).join('');
  assert.ok(text.length <= 1_000_000);
  assert.equal(r.segments.at(-1).text, '(output truncated)');
});

test('state persists between jobs, and each job restores console output', () => {
  const i = newInterp();
  run('(define total 0) (define (add! n) (set! total (+ total n)))', i);
  run('(add! 5)', i);
  run('(add! 7)', i);
  assert.equal(val('total', i), '12');
});

test('syntax error in the middle: earlier forms ran, later ones did not', () => {
  const i = newInterp();
  const out = run('(display "one") (display "two"', i);
  assert.match(out, /^out:one\|;Unexpected end of input/);
});

test('values are shown for every top-level expression, defines show nothing', () => {
  const i = newInterp();
  const r = i.evalSync('(define x 1) (+ x 1) "s" (list 1) (if #f #f) (values)');
  assert.deepEqual(r.segments.map((s) => s.kind + ':' + s.text), ['value:2', 'value:"s"', 'value:(1)']);
});

test('#lang selects a library; unknown names are reported; builtin names are accepted', () => {
  const i = newInterp({ libraries: { mylib: '(define (lib-fn x) (* x 100))' } });
  assert.equal(val('#lang mylib\n(lib-fn 3)', i), '300');
  assert.equal(val('(lib-fn 4)', i), '400');
  assert.match(val('#lang nonsuch\n(+ 1 2)', i), /^;Unknown #lang "nonsuch"\. Available: .*mylib/);
  assert.equal(val('#lang scheme\n(+ 1 2)', i), '3');
});

test('library code is immune to the user redefining names it uses', () => {
  const i = newInterp({ libraries: { mylib: '(define (twice-all l) (map (lambda (x) (* 2 x)) l))' } });
  run('(define (map f l) (quote broken))', i);
  assert.equal(val("#lang mylib\n(twice-all '(1 2 3))", i), '(2 4 6)');
});

test('a user-defined name wins over a library one defined earlier, and vice versa after loading', () => {
  const i = newInterp({ libraries: { mylib: '(define lib-val 1)' } });
  run('(define lib-val 99)', i);
  assert.equal(val('lib-val', i), '99');
  run('#lang mylib\n1', i);
  assert.equal(val('lib-val', i), '1');
});

test('console input: end of input given to one run does not carry over to the next', () => {
  const i = newInterp();
  const first = i.startRun('(eof-object? (read-line))');
  first.step(1000);
  first.provideInput(null);
  first.step(1000);
  assert.equal(first.segments.at(-1).text, '#t');
  const second = i.startRun('(read-line)');
  assert.equal(second.step(1000).state, 'input'); // asks for a line instead of seeing the old end of input
  second.provideInput('fresh');
  second.step(1000);
  assert.equal(second.segments.at(-1).text, '"fresh"');
});
