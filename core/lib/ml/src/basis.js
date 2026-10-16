// The initial basis (MLspec.md section 5.6), deliberately tiny.
//   types   int bool exn unit
//   values  true false not ~ + - * div mod < > <= >= = <>
//   exceptions  Div Overflow Match Bind
// Nothing else: no list, no print, no hd. The returned scope is the root every cell's environment extends; it is
// never modified after this function returns.
import {
  Scope, TVar, tfn, ttuple, tInt, tBool, tExn, tUnit, INT, BOOL, EXN,
} from './types.js';

// datatype bool = false | true. Made once per process (not per basis): the machine hands out these very objects as the results
// of comparisons, so every interpreter's `true` and `false` must be the same ConInfo.
const boolInfo = (name, index) => ({ kind: 'con', name, scheme: tBool, tyname: BOOL, hasArg: false, index });
export const FALSE_INFO = boolInfo('false', 0);
export const TRUE_INFO = boolInfo('true', 1);
BOOL.cons = [{ name: 'false', ty: null, info: FALSE_INFO }, { name: 'true', ty: null, info: TRUE_INFO }];

export function makeBasis() {
  const root = new Scope();

  root.types.set('int', { kind: 'tyname', tyname: INT });
  root.types.set('exn', { kind: 'tyname', tyname: EXN });
  root.types.set('bool', { kind: 'tyname', tyname: BOOL });
  root.types.set('unit', { kind: 'abbrev', params: [], body: tUnit });

  root.vals.set('false', FALSE_INFO);
  root.vals.set('true', TRUE_INFO);

  const prim = (name, scheme) => root.vals.set(name, { kind: 'prim', name, scheme });
  const intPair = ttuple([tInt, tInt]);
  prim('not', tfn(tBool, tBool));
  prim('~', tfn(tInt, tInt));
  for (const op of ['+', '-', '*', 'div', 'mod']) prim(op, tfn(intPair, tInt));
  for (const op of ['<', '>', '<=', '>=']) prim(op, tfn(intPair, tBool));
  for (const op of ['=', '<>']) {
    const a = new TVar(0, true);
    a.generic = true;
    prim(op, tfn(ttuple([a, a]), tBool));
  }

  for (const name of ['Div', 'Overflow', 'Match', 'Bind']) {
    root.vals.set(name, { kind: 'exn', name, scheme: tExn, hasArg: false, basis: true });
  }
  return root;
}
