// #lang eopl: define-datatype / cases, the small support library, the
// scanner/parser generator, and interpreter corpora built on them. Message
// wording and scanner behaviour follow the language library distributed with
// the reference implementation; interpreter expectations are worked out
// by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newInterp, run, val, stdout } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = (name) => fs.readFileSync(path.join(here, 'corpora', name + '.scm'), 'utf8');

function lib() {
  const i = newInterp();
  assert.equal(run('#lang eopl', i), '');
  return i;
}
function loaded(name) {
  const i = newInterp();
  const out = run(corpus(name), i);
  assert.equal(out, '', name + ' should load silently, got: ' + out);
  return i;
}
function check(i, pairs) {
  for (const [src, want] of pairs) assert.equal(val(src, i), want, src);
}

const SHAPES = `
(define-datatype shape shape?
  (circle (radius number?))
  (rect (w number?) (h number?))
  (unit))
(define (area s)
  (cases shape s
    (circle (r) (* 3 r r))
    (rect (w h) (* w h))
    (else 'no-area)))`;

test('eopl: define-datatype builds checked constructors and a predicate', () => {
  const i = lib();
  run(SHAPES, i);
  check(i, [
    ['(shape? (circle 2))', '#t'],
    ['(shape? (unit))', '#t'],
    ['(shape? 5)', '#f'],
    ["(shape? '(circle 2))", '#f'],
    ['(circle 2)', '#(struct:circle 2)'],
    ['(rect 2 3)', '#(struct:rect 2 3)'],
    ['(unit)', '#(struct:unit)'],
    ["(circle 'a)", ';circle: bad value for radius field: a'],
    ['(rect 1 "x")', ';rect: bad value for h field: "x"'],
    // make-VARIANT is defined too, as the same constructor
    ['(make-rect 2 3)', '#(struct:rect 2 3)'],
    ['(eq? make-circle circle)', '#t'],
    ['(shape? (make-unit))', '#t'],
  ]);
  // wrong argument count is the ordinary procedure arity error
  assert.match(val('(circle 1 2)', i), /^;The procedure #\[compound-procedure \d+ circle\] has been called with 2 arguments; it requires exactly 1 argument/);
  // a variant constructor is a procedure
  assert.equal(val('(map circle (list 1 2))', i), '(#(struct:circle 1) #(struct:circle 2))');
});

test('eopl: cases dispatches on the variant, with else and error cases', () => {
  const i = lib();
  run(SHAPES, i);
  check(i, [
    ['(area (circle 2))', '12'],
    ['(area (rect 4 5))', '20'],
    ['(area (unit))', 'no-area'],
    ['(area 7)', ';cases: not a shape: 7'],
    ['(area (quote (circle 2)))', ';cases: not a shape: (circle 2)'],
    // a variant with no clause and no else
    ['(cases shape (unit) (circle (r) r))', ';cases: no variant case matched'],
    // a clause that names the wrong number of fields
    ['(cases shape (rect 1 2) (rect (w) w))', ";cases: variant case `rect' for `shape' has wrong field count (expected 2, found 1)"],
    ['(cases nosuch 1 (a () 1))', ';cases: not a datatype name: nosuch'],
    ['(cases shape (unit) (else 1) (unit () 2))', ';cases: else clause must be last: (%cases shape (unit) (else 1) (unit () 2))'],
  ]);
  // clause bodies are bodies: several forms, internal defines, tail position
  assert.equal(val('(cases shape (rect 2 3) (rect (w h) (define a (* w h)) (+ a 1)))', i), '7');
  assert.equal(val('(let loop ((n 0)) (cases shape (unit) (unit () (if (< n 300000) (loop (+ n 1)) n))))', i), '300000');
  // a field called like a special form shadows it inside the clause
  assert.equal(val('(cases shape (circle 4) (circle (if) if))', i), '4');
  // the field names are bound only inside their clause
  assert.equal(val('(define r 99) (cases shape (circle 4) (circle (r) r))', i), '4');
  assert.equal(val('r', i), '99');
});

test('eopl: cases checks the datatype when the clause is reached, so a type may be defined or redefined later', () => {
  const i = lib();
  // the function mentions a type that does not exist yet
  assert.equal(run('(define (f x) (cases later x (late (n) n) (else 0)))', i), '');
  assert.equal(val('(f 1)', i), ';cases: not a datatype name: later');
  run('(define-datatype later later? (late (n number?)))', i);
  assert.equal(val('(f (late 5))', i), '5');
  // redefine the type with another shape: the old clause is now wrong, and says so only when reached
  run('(define-datatype later later? (late (n number?) (m number?)))', i);
  assert.equal(val('(f (late 1 2))', i), ";cases: variant case `late' for `later' has wrong field count (expected 2, found 1)");
});

test('eopl: structural equality, printing, hash-table keys', () => {
  const i = lib();
  run(SHAPES, i);
  check(i, [
    ['(equal? (rect 1 2) (rect 1 2))', '#t'],
    ['(equal? (rect 1 2) (rect 2 1))', '#f'],
    ['(equal? (circle 1) (rect 1 1))', '#f'],
    ['(eqv? (rect 1 2) (rect 1 2))', '#f'],
    ['(let ((c (circle 1))) (eqv? c c))', '#t'],
    ['(let ((h (make-equal-hash-table))) (hash-table-set! h (rect 1 2) 5) (hash-table-ref/default h (rect 1 2) 0))', '5'],
    ["(list (circle 1) 'x)", '(#(struct:circle 1) x)'],
    ['(rect (circle 1) 2)', ';rect: bad value for w field: #(struct:circle 1)'],
  ]);
});

test('eopl: field predicates are evaluated lazily, so types can refer forward and to themselves', () => {
  const i = lib();
  run(`
(define-datatype tree tree?
  (leaf (n number?))
  (node (kids (list-of tree?))))
(define-datatype wrapper wrapper?
  (wrap (item later?)))
(define (later? x) (symbol? x))`, i);
  check(i, [
    ['(tree? (node (list (leaf 1) (node (list)))))', '#t'],
    ["(node (list (leaf 1) 'x))", ';node: bad value for kids field: (#(struct:leaf 1) x)'],
    ["(wrap 'a)", '#(struct:wrap a)'],
    ['(wrap 1)', ';wrap: bad value for item field: 1'],
  ]);
});

test('eopl: redefining a datatype replaces it; list-of, maybe, always?, empty', () => {
  const i = lib();
  run('(define-datatype t t? (a (x number?)))', i);
  assert.equal(val('(t? (a 1))', i), '#t');
  run('(define-datatype t t? (b (y symbol?)))', i);
  check(i, [
    ["(t? (b 'q))", '#t'],
    ['(t? (a 1))', '#f'], // the old type is gone; its values are no longer instances
    ['(a 1)', '#(struct:a 1)'], // the old constructor still builds an old-type value
    ['((list-of number?) (list 1 2 3))', '#t'],
    ['((list-of number?) (list 1 (quote a)))', '#f'],
    ['((list-of number?) 5)', '#f'],
    ['((list-of number?) (quote ()))', '#t'],
    ['((list-of (list-of symbol?)) (quote ((a) () (b c))))', '#t'],
    // several predicates are applied in turn, cycling; the length must be a whole number of rounds
    ['((list-of number? symbol?) (list 1 (quote a) 2 (quote b)))', '#t'],
    ['((list-of number? symbol?) (list 1 (quote a) 2))', '#f'],
    ['((list-of number? symbol?) (list (quote a) 1))', '#f'],
    ['((maybe number?) #f)', '#t'],
    ['((maybe number?) 5)', '#t'],
    ["((maybe number?) 'a)", '#f'],
    ['(always? 1)', '#t'],
    ['empty', '()'],
  ]);
  assert.match(val("(always? 1 'a)", i), /^;The procedure #\[compound-procedure \d+ always\?\] has been called with 2 arguments; it requires exactly 1 argument/);
});

test('eopl: eopl:error, eopl:printf, eopl:pretty-print', () => {
  const i = lib();
  check(i, [
    // a symbol first: who, then a format string with its arguments
    ["(eopl:error 'apply-env \"No binding for ~s\" 'x)", ';apply-env: No binding for x'],
    ["(eopl:error 'f \"a ~a b ~s\" \"str\" \"str\")", ';f: a str b "str"'],
    ["(eopl:error 'f \"no directives\")", ';f: no directives'],
    ["(guard (e (#t (condition/report-string e))) (eopl:error 'f \"n=~s~%\" 5))", '"f: n=5\\n"'],
    // a string first is the plain error procedure: message, then irritants
    ['(eopl:error "plain" 1 "two")', ';plain 1 "two"'],
    ['(eopl:error (quote f) "~s")', ';format: too few arguments for "~s"'],
    ['(eopl:error (quote f) "x" 1)', ';format: too many arguments for "x"'],
    ['(eopl:error (quote f) "~z")', ';format: unsupported directive ~z in "~z"'],
  ]);
  assert.equal(stdout('(eopl:printf "x=~s y=~a~%" "s" "s") (eopl:printf "~~ ~n.")', i), 'x="s" y=s\n~ \n.');
  assert.equal(stdout("(eopl:pretty-print '(a (b) \"c\"))", i), '(a (b) "c")\n');
});

test('eopl: a parameter called with one argument sets it', () => {
  const i = lib();
  check(i, [['(define pr (make-parameter 1))', ''], ['(pr 5)', ''], ['(pr)', '5'], ['(parameterize ((pr 9)) (pr))', '9'], ['(pr)', '5']]);
});

test('eopl: the library is only present after #lang eopl, and the core is unaffected', () => {
  const i = newInterp();
  assert.match(val('(define-datatype d d? (a))', i), /^;Unbound variable/);
  assert.match(val('(sllgen:make-string-parser 1 2)', i), /^;Unbound variable: sllgen:make-string-parser/);
  assert.equal(run('#lang eopl', i), '');
  assert.equal(val('(define-datatype d d? (a)) (d? (a))', i), '#t');
  // a user may still define their own procedures with these names
  const j = lib();
  assert.equal(val('(define (list-of x) (list x x)) (list-of 3)', j), '(3 3)');
  check(j, [['(sort (list 3 1 2) <)', '(1 2 3)']]);
});

// ---- sllgen ----------------------------------------------------------------------

const SCANNER = `
(define scanner
  '((ws (whitespace) skip)
    (identifier (letter (arbno (or letter digit "_" "-" "?"))) symbol)
    (number (digit (arbno digit)) number)
    (number ("-" digit (arbno digit)) number)
    (str ("\\"" (arbno (not #\\")) "\\"") string)))`;

function g1(i) {
  run(SCANNER, i);
  run(`(define g1 '((s (item) top)
                   (item ("if" item "then" item "else" item) if-it)
                   (item ("-" item) neg)
                   (item (number) num)
                   (item (identifier) id)
                   (item (str) text)))
       (sllgen:make-define-datatypes scanner g1)
       (define p (sllgen:make-string-parser scanner g1))`, i);
}

test('sllgen: scanning picks the longest match, and keywords beat identifiers', () => {
  const i = lib();
  g1(i);
  check(i, [
    ['(p "42")', '#(struct:top #(struct:num 42))'],
    ['(p "-42")', '#(struct:top #(struct:num -42))'],   // the number rule is longer than the keyword "-"
    ['(p "- 42")', '#(struct:top #(struct:neg #(struct:num 42)))'],
    ['(p "iffy")', '#(struct:top #(struct:id iffy))'],  // longer than the keyword "if"
    ['(p "if a then b else c")', '#(struct:top #(struct:if-it #(struct:id a) #(struct:id b) #(struct:id c)))'],
    ['(p "x-y?")', '#(struct:top #(struct:id x-y?))'],
    ['(p "  7  ")', '#(struct:top #(struct:num 7))'],
    // a string token keeps its text exactly as scanned, quotes included
    ['(p "\\"hi there\\"")', '#(struct:top #(struct:text "\\"hi there\\""))'],
  ]);
});

test('sllgen: scan and parse errors', () => {
  const i = lib();
  g1(i);
  check(i, [
    ['(p "if")', ';parsing: at line 1: nonterminal <item> can\'t begin with end-marker #f'],
    ['(p "if a b")', ';parsing: at line 1: looking for "then", found identifier b'],
    ['(p "a b")', ';parsing: at line 1: symbols left over: identifier b etc...'],
    ['(p "")', ';parsing: at line 1: nonterminal <s> can\'t begin with end-marker #f'],
    ['(p "\\n\\n  if a then")', ';parsing: at line 3: nonterminal <item> can\'t begin with end-marker #f'],
    // a character no rule can start with ends the token stream there, silently
    ['(p "a $ b")', '#(struct:top #(struct:id a))'],
    ['(p "$")', ';parsing: at line 1: nonterminal <s> can\'t begin with end-marker #f'],
    // characters consumed by a rule that then fails to accept are an error
    ['(p "\\"abc")', ';scanning: no actions found for (#\\" #\\a #\\b #\\c)'],
  ]);
});

test('sllgen: the string scanner returns (class data line) tokens', () => {
  const i = lib();
  g1(i);
  run('(define sc (sllgen:make-string-scanner scanner g1))', i);
  const toks = val('(sc "if x\\n then -5 - 5")', i);
  assert.match(toks, /^\(\(literal-string\d+ "if" 1\) \(identifier x 1\) \(literal-string\d+ "then" 2\) \(number -5 2\) \(literal-string\d+ "-" 2\) \(number 5 2\)\)$/);
  assert.equal(val('(sc "")', i), '()');
});

test('sllgen: when several rules accept the same text the action preference decides', () => {
  const i = lib();
  run(`(define sc2 (sllgen:make-string-scanner
         '((skipper (letter) skip) (sym (letter) symbol) (str (letter) string))
         '((top (sym) t))))
       (define sc3 (sllgen:make-string-scanner
         '((a-num (digit) number) (a-sym (digit) symbol))
         '((top (a-num) t))))`, i);
  // string beats symbol beats number beats skip, whatever the order of the rules
  assert.equal(val('(sc2 "a")', i), '((str "a" 1))');
  assert.equal(val('(sc3 "7")', i), '((a-sym 7 1))');
});

test('sllgen: arbno, separated-list, nested repetition and backtracking', () => {
  const i = lib();
  run(SCANNER, i);
  run(`(define g2 '((prog (stmt (arbno stmt)) block)
                   (stmt ("set" identifier "=" expr) assign)
                   (stmt ("{" (separated-list expr ",") "}") tuple)
                   (stmt ("[" (arbno identifier (arbno number)) "]") table)
                   (expr (number) lit)
                   (expr (identifier) ref)
                   (expr ("(" expr (arbno "+" expr) ")") sum)))
       (sllgen:make-define-datatypes scanner g2)
       (define p2 (sllgen:make-string-parser scanner g2))`, i);
  check(i, [
    ['(p2 "set x = 1")', '#(struct:block #(struct:assign x #(struct:lit 1)) ())'],
    ['(p2 "set x = 1 set y = z")', '#(struct:block #(struct:assign x #(struct:lit 1)) (#(struct:assign y #(struct:ref z))))'],
    ['(p2 "{} {1} {1, a, 3}")',
      '#(struct:block #(struct:tuple ()) (#(struct:tuple (#(struct:lit 1))) #(struct:tuple (#(struct:lit 1) #(struct:ref a) #(struct:lit 3)))))'],
    // a repetition with two items makes one list per item
    ['(p2 "[a 1 2 b c 3]")', '#(struct:block #(struct:table (a b c) ((1 2) () (3))) ())'],
    ['(p2 "[]")', '#(struct:block #(struct:table () ()) ())'],
    ['(p2 "{(1 + a + 2)}")',
      '#(struct:block #(struct:tuple (#(struct:sum #(struct:lit 1) (#(struct:ref a) #(struct:lit 2))))) ())'],
    ['(p2 "{(1)}")', '#(struct:block #(struct:tuple (#(struct:sum #(struct:lit 1) ()))) ())'],
  ]);
  assert.match(val('(p2 "{1,}")', i), /^;parsing: at line 1: nonterminal <expr> can't begin with literal-string\d+ "}"$/);
  // the field predicates generated for the repetitions accept exactly these shapes
  assert.equal(val('(stmt? (table (list (quote a)) (list (list 1))))', i), '#t');
  assert.match(val('(table (list 1) (list))', i), /^;table: bad value for table\d+ field: \(1\)/);
});

test('sllgen: generated datatypes name fields after the variant plus a running counter', () => {
  const i = lib();
  run(SCANNER, i);
  run(`(define g3 '((top (item) top-node)
                   (item (identifier "=" identifier) pair-node)
                   (item (number (arbno number)) nums-node)
                   (item (item "+" item) never-used-left-recursive)))`, i);
  assert.equal(val('(sllgen:list-define-datatypes scanner g3)', i),
    '((define-datatype top top? (top-node (top-node1 item?))) '
    + '(define-datatype item item? (pair-node (pair-node2 symbol?) (pair-node3 symbol?)) '
    + '(nums-node (nums-node4 number?) (nums-node5 (list-of number?))) '
    + '(never-used-left-recursive (never-used-left-recursive6 item?) (never-used-left-recursive7 item?))))');
  // the counter is never reset, so a second listing carries on from 8
  assert.match(val('(sllgen:list-define-datatypes scanner g3)', i), /^\(\(define-datatype top top\? \(top-node \(top-node8 item\?\)\)\)/);
  assert.equal(stdout('(sllgen:show-define-datatypes scanner g3)', i).split('\n').filter(Boolean).length, 2);
  // a left-recursive production is not an error until it is the only way to parse
  run('(sllgen:make-define-datatypes scanner g3) (define p3 (sllgen:make-string-parser scanner g3))', i);
  check(i, [
    ['(p3 "a = b")', '#(struct:top-node #(struct:pair-node a b))'],
    ['(p3 "1 2 3")', '#(struct:top-node #(struct:nums-node 1 (2 3)))'],
  ]);
  assert.match(val('(p3 "a + b")', i), /^;parsing: at line 1: /);
});

test('sllgen: malformed specifications and unusable productions are reported', () => {
  const i = lib();
  run(SCANNER, i);
  check(i, [
    ["(sllgen:make-string-parser scanner '((s (nosuch) x)))", ';defining-datatypes: illegal item nosuch (unknown symbol) in rhs (nosuch)'],
    ["(sllgen:make-string-parser scanner '())", ';parser-generation: empty grammar'],
    ["(sllgen:make-string-parser '((a (digit) frobnicate)) '((s (a) x)))", ';scanner-generation: bad scanner item (a (digit) frobnicate)'],
    ["(sllgen:make-string-parser '((a (wombat) skip)) '((s (\"x\") y)))", ';scanner-generation: unknown tester wombat'],
    ["(sllgen:make-string-parser scanner '((s (number) x y)))", ';parser-generation: bad production (s (number) x y)'],
  ]);
  // the datatype for a production must exist before parsing
  run("(define pg '((s (number) lonely-node))) (define pp1 (sllgen:make-string-parser scanner pg))", i);
  assert.equal(val('(pp1 "1")', i),
    ';sllgen: no datatype defines the variant lonely-node (run sllgen:make-define-datatypes, or define it with define-datatype)');
  run('(define-datatype s s? (lonely-node (a number?) (b number?)))', i);
  assert.equal(val('(pp1 "1")', i), ';sllgen: variant lonely-node has 2 fields but the grammar gives 1');
  run('(define-datatype s s? (lonely-node (a number?)))', i);
  assert.equal(val('(pp1 "1")', i), '#(struct:lonely-node 1)');
});

test('sllgen: a hand-written datatype can receive the parser output', () => {
  const i = lib();
  run(SCANNER, i);
  run(`(define-datatype calc calc?
         (num (n number?))
         (neg (e calc?)))
       (define cg '((c (number) num) (c ("-" c) neg)))
       (define cp (sllgen:make-string-parser scanner cg))`, i);
  assert.equal(val('(cp "- - 3")', i), '#(struct:neg #(struct:neg #(struct:num 3)))');
});

test('sllgen: make-rep-loop reads expressions (across lines, several per line), evaluates, writes the value', () => {
  const i = loaded('eopl-3-let');
  run(`(define rep (sllgen:make-rep-loop "calc> " (lambda (pgm) (value-of-program pgm))
                    (sllgen:make-stream-parser the-lexical-spec the-grammar)))`, i);
  const job = i.startRun('(rep)');
  assert.equal(job.step(1000).state, 'input');
  job.provideInput('let x = 5 in -(x,2)');
  assert.equal(job.step(1000).state, 'input');
  job.provideInput('');                        // a blank line is skipped
  assert.equal(job.step(1000).state, 'input');
  job.provideInput('if zero?(0)');             // an expression may continue on the next lines
  assert.equal(job.step(1000).state, 'input');
  job.provideInput(' then 1 else 2 7');        // ...and a second one can share the line
  assert.equal(job.step(1000).state, 'input');
  job.provideInput(null);                      // end of input ends the loop
  const r = job.step(1000);
  assert.equal(r.state, 'done');
  const text = job.segments.filter((s) => s.kind === 'stdout').map((s) => s.text).join('');
  assert.equal(text, 'calc> #(struct:num-val 3)\ncalc> #(struct:num-val 1)\ncalc> #(struct:num-val 7)\ncalc> ');
  // an unfinished expression at end of input is an error
  const j2 = i.startRun('(rep)');
  j2.step(1000); j2.provideInput('-(1,'); j2.step(1000); j2.provideInput(null);
  j2.step(1000);
  assert.match(j2.segments.filter((s) => s.kind === 'error').map((s) => s.text).join(), /^parsing: at line 2: nonterminal <expression> can't begin with end-marker #f/);
});

// ---- corpora ------------------------------------------------------------------------

test('chapters 1-2: list programs, expression datatype, environments, trees', () => {
  const i = loaded('eopl-1-2');
  check(i, [
    ["(list-set '(a b c d) 2 '(1 5 2))", '(a b (1 5 2) d)'],
    ["(occurs-free? 'x 'x)", '#t'],
    ["(occurs-free? 'x '(lambda (y) (a x)))", '#t'],
    ["(occurs-free? 'x '(lambda (x) (x y)))", '#f'],
    ["(number-elements '(v0 v1 v2))", '((0 v0) (1 v1) (2 v2))'],
    ["(unparse-lc-exp (parse-expression '((lambda (x) x) y)))", '((lambda (x) x) y)'],
    ["(free-vars (parse-expression '(lambda (x) (x y))))", '(y)'],
    ["(free-vars (parse-expression '((a b) (a c))))", '(a b c)'],
    ["(var-exp 'lambda)", ';var-exp: bad value for var field: lambda'],
    ['(parse-expression 5)', ';parse-expression: Invalid concrete syntax 5'],
    ["(apply-env (extend-env 'a 1 (extend-env 'b 2 (empty-env))) 'b)", '2'],
    ["(has-binding? (extend-env 'a 1 (empty-env)) 'z)", '#f'],
    ["(env-size (extend-env 'a 1 (extend-env 'b 2 (empty-env))))", '2'],
    ["(apply-env (empty-env) 'z)", ';apply-env: No binding for z'],
    ["(leaf-sum (interior-node 'a (leaf-node 3) (interior-node 'b (leaf-node 4) (leaf-node 5))))", '12'],
    ["(bintree-to-list (interior-node 'a (leaf-node 3) (leaf-node 4)))", '(interior-node a (leaf-node 3) (leaf-node 4))'],
    ["(forest-total (grove 'g (list (leaf-node 1) (leaf-node 2))))", '3'],
    ["(grove 'g (list 1))", ';grove: bad value for trees field: (1)'],
  ]);
});

const PROGRAMS = [
  ['let f = proc (x) -(x,11) in (f (f 77))', '55'],
  ['(proc (f) (f (f 77)) proc (x) -(x,11))', '55'],
  ['letrec double(x) = if zero?(x) then 0 else -((double -(x,1)), -2) in (double 6)', '12'],
  ['let makeadder = proc (x) proc (y) -(y, -(0,x)) in let add3 = (makeadder 3) in (add3 4)', '7'],
  ['let x = 7 in let y = 2 in let y = let x = -(x,1) in -(x,y) in -(-(x,8),y)', '-5'],
  ['if zero?(-(3,3)) then 10 else 20', '10'],
];

test('chapter 3: the let language, from a scanner and grammar specification', () => {
  const i = loaded('eopl-3-let');
  check(i, [
    ['(run-num "-(44,33)")', '11'],
    ['(run-num "let x = 5 in -(x,1)")', '4'],
    ['(expval->bool (run "zero?(-(3,3))"))', '#t'],
    ['(run-num "let x = 7 in let y = 2 in let y = let x = -(x,1) in -(x,y) in -(-(x,8),y)")', '-5'],
    ['(run-num "if zero?(-(3,3)) then 10 else 20")', '10'],
    ['(run-num "-(5,%x\n 2)")', '3'],                                   // % comments run to the end of the line
    ['(run "zz")', ';apply-env: No binding for zz'],
    ['(run "if 1 then 2")', ';parsing: at line 1: looking for "else", found end-marker #f'],
    ['(run "ifx")', ';apply-env: No binding for ifx'],
    ['(run "if zero?(1) then 1 else zero?(1)")', '#(struct:bool-val #f)'],
    ['(expval->num (run "zero?(0)"))', ';expval->num: Not a number: #(struct:bool-val #t)'],
    ['(scan&parse "-(1,-2)")', '#(struct:a-program #(struct:diff-exp #(struct:const-exp 1) #(struct:const-exp -2)))'],
    // an unscannable character ends the program there
    ['(run "@")', ';parsing: at line 1: nonterminal <program> can\'t begin with end-marker #f'],
  ]);
  // `if` is a keyword, so it cannot be a variable name
  assert.match(val('(run "let if = 1 in if")', i), /^;parsing: at line 1: looking for identifier, found literal-string\d+ "if"$/);
  assert.equal(val('(sllgen:list-define-datatypes the-lexical-spec the-grammar)', i),
    '((define-datatype program program? (a-program (a-program14 expression?))) '
    + '(define-datatype expression expression? (const-exp (const-exp15 number?)) '
    + '(diff-exp (diff-exp16 expression?) (diff-exp17 expression?)) (zero?-exp (zero?-exp18 expression?)) '
    + '(if-exp (if-exp19 expression?) (if-exp20 expression?) (if-exp21 expression?)) '
    + '(var-exp (var-exp22 symbol?)) (let-exp (let-exp23 symbol?) (let-exp24 expression?) (let-exp25 expression?))))');
});

test('chapter 3: procedures and recursive procedures (square-bracket source)', () => {
  const i = loaded('eopl-3-proc');
  for (const [src, want] of PROGRAMS) assert.equal(val(`(run-num "${src}")`, i), want, src);
  check(i, [
    ['(run-num "letrec loop(n) = if zero?(n) then 0 else (loop -(n,1)) in (loop 30000)")', '0'],
    ['(run "(1 2)")', ';expval->proc: Not a procedure: #(struct:num-val 1)'],
  ]);
});

test('chapters 5-6: data-structure continuations, exceptions, and a CPS interpreter with a trampoline', () => {
  for (const name of ['eopl-5-cont', 'eopl-6-cps']) {
    const i = loaded(name);
    for (const [src, want] of PROGRAMS) assert.equal(val(`(run-num "${src}")`, i), want, name + ': ' + src);
    check(i, [
      ['(run-num "letrec loop(n) = if zero?(n) then 0 else (loop -(n,1)) in (loop 30000)")', '0'],
      ['(run "(1 2)")', ';expval->proc: Not a procedure: #(struct:num-val 1)'],
      ['(run "zz")', ';apply-env: No binding for zz'],
    ]);
  }
  const i = loaded('eopl-5-cont');
  check(i, [
    ['(run-num "try -(1, raise 5) catch (e) e")', '5'],
    ['(run-num "try 3 catch (e) 0")', '3'],
    ['(run-num "try try raise 1 catch (e) raise -(e,1) catch (f) f")', '0'],  // a handler's raise goes to the outer try
    ['(run-num "let f = proc (x) raise x in try (f 7) catch (e) -(e,1)")', '6'],
    ['(run-num "try if zero?(raise 4) then 1 else 2 catch (e) -(0,e)")', '-4'],
    ['(run "raise 9")', ';apply-handler: Uncaught exception: #(struct:num-val 9)'],
  ]);
  const c = loaded('eopl-6-cps');
  check(c, [
    ["(begin (reset-fresh!) (cps '(f 1) (lambda (x) x)))", '(f 1 (lambda (v1) v1))'],
    ["(begin (reset-fresh!) (cps '(+ (f 1) 2) (lambda (x) x)))", '(f 1 (lambda (v1) (+ v1 2)))'],
    ["(begin (reset-fresh!) (cps '(f (g 1)) (lambda (x) x)))", '(g 1 (lambda (v1) (f v1 (lambda (v2) v2))))'],
    ["(begin (reset-fresh!) (cps '(if a (f 1) 2) (lambda (x) x)))", '(let-cont v1 v2 v2 (if a (f 1 (lambda (v3) (v1 v3))) (v1 2)))'],
    ["(simple? '(+ 1 (+ x 2)))", '#t'],
    ["(simple? '(+ 1 (f 2)))", '#f'],
  ]);
});
