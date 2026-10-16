// The initial basis (MLspec.md section 5.6), deliberately tiny.
//   types   int bool exn unit
//   values  true false not ~ + - * div mod < > <= >= = <>
//   exceptions  Div Overflow Match Bind
// Nothing else: no list, no print, no hd. The returned scope is the root every cell's environment extends; it is
// never modified after this function returns.
import {
  Scope, TVar, tfn, ttuple, tInt, tBool, tExn, tUnit, INT, BOOL, EXN,
} from './types.js';

export function makeBasis() {
  const root = new Scope();

  root.types.set('int', { kind: 'tyname', tyname: INT });
  root.types.set('exn', { kind: 'tyname', tyname: EXN });
  root.types.set('bool', { kind: 'tyname', tyname: BOOL });
  root.types.set('unit', { kind: 'abbrev', params: [], body: tUnit });

  // datatype bool = false | true
  BOOL.cons = [];
  [['false', false], ['true', true]].forEach(([name], index) => {
    const info = { kind: 'con', name, scheme: tBool, tyname: BOOL, hasArg: false, index };
    BOOL.cons.push({ name, ty: null, info });
    root.vals.set(name, info);
  });

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
