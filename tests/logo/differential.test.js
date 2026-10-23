// Differential test against the reference interpreter (LOGO.md 9.1, 14.4): each probe in tests/logo/seed was run through
// ucblogo 6.2.5 (console build of commit f0ca245) and its output recorded next to it. Here the same probe runs through our
// engine and the two outputs must match -- except where we differ ON PURPOSE. Those places are listed explicitly below, one
// [reference text, our text] pair each, and each pair must really occur in the recorded output, so a stale entry fails.
//
// CI needs no WSL and no network: the recorded outputs are committed. To re-record one, see tests/logo/seed/runprobe.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SEED_DIR, newInterpreter } from './helpers.js';

const WELCOME = /^Welcome to Berkeley Logo version [\d.]+\n/;
const FAREWELL = /Thank you for using Logo\.\nHave a nice day\.\n?$/;

function recorded(name) {
  const ref = fs.readFileSync(path.join(SEED_DIR, name + '.ucblogo-output.txt'), 'utf8').replace(/\r/g, '');
  return ref.replace(WELCOME, '').replace(FAREWELL, '');
}

function ours(name) {
  const src = fs.readFileSync(path.join(SEED_DIR, name + '.lg'), 'utf8');
  const it = newInterpreter();
  return it.run(src, { onError: 'continue' }).text;
}

// Compare ignoring trailing blank lines (the reference ends with a farewell we strip).
const trim = (t) => t.replace(/\s+$/, '');

function check(name, differs = []) {
  let ref = recorded(name);
  for (const [was, now] of differs) {
    assert.ok(ref.includes(was), `[${name}] a "reference differs" entry no longer occurs in the recording:\n${was}`);
    ref = ref.replace(was, now);
  }
  assert.equal(trim(ours(name)), trim(ref));
}

test('numbers, words, print/show/type match the reference', () => check('numbers-words-print'));
test('arithmetic matches the reference', () => check('arithmetic-misc'));

test('backquote matches the reference', () => check('backquote'));

test('an array literal in code is a new array on every evaluation, as in the reference', () => check('array-literal'));

test('a parenthesised name followed by an operator is plain grouping, as in the reference', () => check('paren-infix'));

test('a bare word naming a variable evaluates to it, as in the reference', () => check('bare-variable'));

// ERRACT (LOGO.md 14.6): the handler runs on top of the failing frames, then the error is reported unless the handler read
// it with ERROR. Every case in the probe is identical to the reference (the one with an error inside the handler included).
test('ERRACT runs for an uncaught error and not for a caught one, as in the reference', () => check('erract'));

// A backslash in front of a parenthesis or operator protects it like bars do (`show "r\(s` is the word r(s); only a word
// re-read from its text (runparse of a word) splits there. The probe is identical to the reference.
test('backslash-protected parentheses and operators stay in the word, as in the reference', () => check('backslash'));

// PO (LOGO.md 15.4 item 6): variables as Make "name value with the protection a word needs, property lists newest first,
// lists in alphabetical order. The probe is identical to the reference; the places where our reader keeps less information
// than the reference's are documented above poValue in printer.js.
test('PO prints variables and property lists in the form that reads back, in the reference\'s order', () => check('po-format'));

test('semantics, errors and templates match the reference, except where decisions 14 and 15 differ', () => check('semantics-errors-templates', [
  // Decision 15: a TO whose name is already defined redefines it (and says so) instead of failing and running the body
  // lines as commands; a TO naming a primitive is an error with the reference's "is a primitive" wording.
  [`bad is already defined
9
I don't know how  to end
print is already defined
I don't know how  to end
inner defined
1
I don't know how  to foo  in bad
[foo]
`, `bad redefined
print is a primitive
inner defined
9
`],
  // Decision 14: STOP and OUTPUT leave the procedure through REPEAT, FOREACH, RUN ... so "after" is not reached.
  [`s1 defined
12after
s2 defined
s3 defined
13after3
s4 defined
`, `s1 defined
12s2 defined
s3 defined
1s4 defined
`],
]));

test('STOP and OUTPUT through control constructs: documented semantics (decision 14), reference differs', () => check('stop-through-constructs', [
  [`repeat:xafter

forever:xafter

`, `repeat:x
forever:x
`],
  [`catch:xafter

apply_list:xafter

apply_lambda:xafter

foreach:xxafter

`, `catch:x
apply_list:x
apply_lambda:x
foreach:x
`],
  [`map:xstop didn't output to combine  in map1
[output combine (apply :map.template firsts :template.lists) (map1 bfs :template.lists :template.number+1)]

filter:xstop didn't output to if  in filter
[if apply :filter.template (list first :template.list) [op combine (first :template.list) (filter :filter.template bf :template.list :template.number+1)]]

repeat_nested_if:xafter

cascade:xstop didn't output to fput  in cascade.eval
[op fput (apply first :cascade.templates :template.vars) (cascade.eval bf :cascade.templates)]

`, `map:xstop didn't output to map  in p_map
[ignore map [type "x stop] [1 2]]

filter:xstop didn't output to filter  in p_filter
[ignore filter [type "x stop] [1 2]]

repeat_nested_if:x
cascade:xstop didn't output to cascade  in p_cascade
[ignore cascade 2 [type "x stop] 0]

`],
]));

test('redefinition and primitives: decision 15 replaces the reference behaviour', () => check('stop-and-redefine', [
  [`r1 defined
12after

r2 defined
123after

r3 defined
after
r4 defined
13after

r5 defined
12
`, `r1 defined
12
r2 defined
123
r3 defined
r4 defined
1
r5 defined
12
`],
  [`z defined
z is already defined
2
I don't know how  to end
1
z is already defined
3
I don't know how  to end
1
z defined
4
--- primitives
sum is already defined
mine
I don't know how  to end
You don't say what to do with 3
3
`, `z defined
z redefined
2
z redefined
3
z defined
4
--- primitives
sum defined
mine
mine
sum didn't output to print
`],
]));
