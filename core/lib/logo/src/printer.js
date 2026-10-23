// Printing Logo data (LOGO.md 5.6; manual, PRINT / SHOW / TYPE; 11.5 item 2 and 4).
//
//   print  words as typed; a list WITHOUT its outer brackets, inner lists with theirs   print [a [b c] d]  ->  a [b c] d
//   show   everything with its brackets                                                 show  [a [b c] d]  ->  [a [b c] d]
//   type   like print, no newline
// Numbers print per numbers.js formatNumber; a word that merely looks like a number prints as typed. An array prints in
// braces ({1 2 3}); the reference does not print the origin (11.5: `show {1 2 3}@5` and `show (array 3 0)` print bare braces).
//
// `showForm` is what error messages embed for a value ("first doesn't like [] as input"); it additionally writes the
// empty word as || as the reference does. Do not use these to build words (WORD, SENTENCE ...): those work on the data.

import { Cell, NIL, LArray, isList, wordText } from './data.js';

// One datum inside a list or array: lists and arrays bracketed, words as text. A barred word prints WITHOUT its bars, as
// the reference does (print [a |b c|] shows a b c).
function item(x) {
  if (x instanceof Cell || x === NIL) return '[' + members(x) + ']';
  if (x instanceof LArray) return arrayText(x);
  return wordText(x);
}

function members(l) {
  const parts = [];
  for (; l instanceof Cell; l = l.rest) parts.push(item(l.first));
  return parts.join(' ');
}

function arrayText(a) {
  return '{' + a.items.map(item).join(' ') + '}';
}

// show-style text of any datum.
export function showText(x) {
  if (x instanceof Cell || x === NIL) return '[' + members(x) + ']';
  if (x instanceof LArray) return arrayText(x);
  return wordText(x);
}

// print-style text: a list loses its outer brackets only.
export function printText(x) {
  if (x instanceof Cell || x === NIL) return members(x);
  if (x instanceof LArray) return arrayText(x);
  return wordText(x);
}

// For error messages: show-style, with the empty word written as ||.
export function showForm(x) {
  if (typeof x === 'string' && x === '') return '||';
  if (x === undefined) return '';
  return showText(x);
}

export { isList };
