// Small programs of the kind a word-and-sentence course asks for (output procedures, tables,
// typed input), written fresh here; the expected text is the sample output the course
// textbook prints for the same task. Operands are evaluated left to right in this engine, so
// the programs use let where the order of two effects matters (the textbook says to do the same).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newInterp, run, val, stdout } from './helpers.js';

function lib() {
  const i = newInterp();
  assert.equal(run('#lang simply', i), '');
  return i;
}

// runs source, answering each request for input with the next scripted line (then end of input)
function runScripted(i, src, inputs) {
  const job = i.startRun(src);
  let k = 0, out = '', value = null, error = null;
  for (let guard = 0; guard < 10000; guard++) {
    const r = job.step(1000);
    for (const s of r.segments) {
      if (s.kind === 'stdout') out += s.text;
      else if (s.kind === 'value') value = s.text;
      else if (s.kind === 'error') error = s.text;
    }
    if (r.state === 'input') { job.provideInput(k < inputs.length ? inputs[k++] : null); continue; }
    if (r.state !== 'running') break;
  }
  return { out, value, error };
}

test('simply programs: counting down verses with show, newline and display', () => {
  const i = lib();
  run(`(define (verse n)
         (display n) (show " bottles of beer on the wall,")
         (display n) (show " bottles of beer.")
         (show "If one of those bottles should happen to fall,")
         (display (- n 1)) (show " bottles of beer on the wall.")
         (newline))
       (define (bottles n) (if (= n 0) 'burp (begin (verse n) (bottles (- n 1)))))`, i);
  assert.equal(stdout('(verse 6)', i), [
    '6 bottles of beer on the wall,',
    '6 bottles of beer.',
    'If one of those bottles should happen to fall,',
    '5 bottles of beer on the wall.',
    '', ''].join('\n'));
  assert.equal(val('(bottles 2)', i), 'burp');
  const two = stdout('(bottles 2)', i);
  assert.equal(two.split('\n\n').length, 3);          // a blank line after each of the two verses
});

test('simply programs: effects and values, show-addition, show-list, for-each', () => {
  const i = lib();
  run(`(define (effect x) (show x) 'done)
       (define (value x) x)
       (define (show-addition x y) (display x) (display '+) (display y) (display '=) (show (+ x y)))
       (define (show-list lst) (if (null? lst) 'done (begin (show (car lst)) (show-list (cdr lst)))))`, i);
  assert.equal(stdout("(effect '(oh! darling))", i), '(oh! darling)\n');
  assert.equal(val("(bf (effect '(oh! darling)))", i), 'one');
  assert.equal(val("(bf (value '(oh! darling)))", i), '(darling)');
  assert.equal(stdout("(begin (show-addition 3 4) (show-addition 6 8) 'done)", i), '3+4=7\n6+8=14\n');
  assert.equal(stdout("(show-list '((dig a pony) (doctor robert) (for you blue)))", i),
    '(dig a pony)\n(doctor robert)\n(for you blue)\n');
  assert.equal(stdout("(for-each show '((mean mr mustard) (no reply) (tell me why)))", i),
    '(mean mr mustard)\n(no reply)\n(tell me why)\n');
});

test('simply programs: tables laid out with align', () => {
  const i = lib();
  run(`(define (square-root-table nums)
         (if (null? nums)
             'done
             (begin (display (align (car nums) 7 1))
                    (show (align (sqrt (car nums)) 10 5))
                    (square-root-table (cdr nums)))))
       (define (name-table names)
         (if (null? names)
             'done
             (begin (display (align (cadar names) 11))
                    (show (caar names))
                    (name-table (cdr names)))))`, i);
  assert.equal(stdout("(square-root-table '(7 8 9 10 20 98 99 100 101 1234 56789))", i), [
    '    7.0   2.64575',
    '    8.0   2.82843',
    '    9.0   3.00000',
    '   10.0   3.16228',
    '   20.0   4.47214',
    '   98.0   9.89949',
    '   99.0   9.94987',
    '  100.0  10.00000',
    '  101.0  10.04988',
    ' 1234.0  35.12834',
    '56789.0 238.30443', ''].join('\n'));
  assert.equal(stdout("(name-table '((john lennon) (paul mccartney) (george harrison) (ringo starr)))", i), [
    'lennon     john',
    'mccartney  paul',
    'harrison   george',
    'starr      ringo', ''].join('\n'));
});

test('simply programs: a read loop and a prompt for two words', () => {
  const i = lib();
  run(`(define (echo)
         (display "What? ")
         (let ((expr (read)))
           (if (equal? expr 'stop)
               'okay
               (begin (show expr) (echo)))))
       (define (ask-for-name)
         (show "Please type your first name, then your last name:")
         (let ((first-name (read)))
           (list first-name (read))))`, i);
  const echo = runScripted(i, '(echo)', ['hello', '(+ 2 3)', '(first (glass onion))', 'stop']);
  assert.equal(echo.out, 'What? hello\nWhat? (+ 2 3)\nWhat? (first (glass onion))\nWhat? ');
  assert.equal(echo.value, 'okay');
  const name = runScripted(i, '(ask-for-name)', ['Ada', 'Lovelace']);
  assert.equal(name.out, 'Please type your first name, then your last name:\n');
  assert.equal(name.value, '(Ada Lovelace)');          // the engine is case-sensitive, so the capitals stay
});

test('simply programs: read-line gives a sentence, show-line prints it plainly', () => {
  const i = lib();
  run(`(define (music-critic)
         (show "What's your favorite song?")
         (let ((song (read-line)))
           (show-line (se "I like" song "too."))))
       (define (music-critic-return)
         (show "What's your favorite song?")
         (let ((song (read-line)))
           (se "I like" song "too.")))`, i);
  const a = runScripted(i, '(music-critic)', ['Blue Moon Rising']);
  assert.equal(a.out, "What's your favorite song?\nI like Blue Moon Rising too.\n");
  // returned instead of printed: the pieces keep their quotes when the value is written out
  const b = runScripted(i, '(music-critic-return)', ['Blue Moon Rising']);
  assert.equal(b.value, '("I like" Blue Moon Rising "too.")');
});

test('simply programs: a read leaves the rest of its line, so a later read-line sees an empty line', () => {
  const i = lib();
  const r = runScripted(i, '(let* ((a (read)) (b (read-line))) (list a b))', ['hello', 'second line']);
  assert.equal(r.value, '(hello ())');
});

test('simply programs: the order of two effects inside one call is left to right here, let fixes it either way', () => {
  const i = lib();
  run('(define (show-and-return x) (show x) x)', i);
  assert.equal(stdout('(list (show-and-return (+ 3 4)) (show-and-return (- 10 2)))', i), '7\n8\n');
  assert.equal(stdout('(let ((left (show-and-return (+ 3 4)))) (list left (show-and-return (- 10 2))))', i), '7\n8\n');
  assert.equal(val('(let ((left (show-and-return (+ 3 4)))) (list left (show-and-return (- 10 2))))', i), '(7 8)');
});
