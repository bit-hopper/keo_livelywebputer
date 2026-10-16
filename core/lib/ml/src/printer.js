// Printing values and declaration echoes (MLspec.md section 5.9). Two styles over one printer:
//
//                          book (default)             sml
//   constructor + argument Onion(Skewer)              Onion Skewer
//   nested                 Onion(Onion(Skewer))       Onion (Onion Skewer)
//   tuple, unit            (Calamari,Ravioli), ()     the same
//   function               fn                         fn
//   exception value        No_bacon(0)                No_bacon 0
//   type variables         α β γ                      'a 'b 'c
//
// Types are printed by `typeToString` (types.js). A value deeper than `depth` shows as `…`.
import { typeToString } from './types.js';

export const DEFAULT_DEPTH = 100;

const intText = (x) => (x < 0 ? '~' + String(-x) : String(x));

// SML puts a constructor's argument in parentheses unless it is a single token or already bracketed.
function atomicSml(v) {
  if (typeof v === 'number' || typeof v === 'bigint' || Array.isArray(v)) return true;
  return (v.tag === 'con' || v.tag === 'exn') ? v.arg === undefined : true;
}

export function showValue(v, style = 'book', depth = DEFAULT_DEPTH) {
  if (depth <= 0) return '…';
  if (typeof v === 'number' || typeof v === 'bigint') return intText(v);
  if (Array.isArray(v)) return '(' + v.map((x) => showValue(x, style, depth - 1)).join(',') + ')';
  if (v.tag === 'con' || v.tag === 'exn') {
    const name = v.tag === 'con' ? v.con.name : v.excon.name;
    if (v.arg === undefined) return name;
    const arg = showValue(v.arg, style, depth - 1);
    if (style === 'book') return Array.isArray(v.arg) && v.arg.length > 1 ? name + arg : name + '(' + arg + ')';
    return name + ' ' + (atomicSml(v.arg) ? arg : '(' + arg + ')');
  }
  return 'fn';
}

// A type in argument position of `of`: the book parenthesises every compound type, SML only where precedence needs it.
const compound = (t) => {
  while (t.tag === 'var' && t.ref) t = t.ref;
  return t.tag === 'fn' || (t.tag === 'tuple' && t.items.length > 1) || (t.tag === 'con' && t.args.length > 0);
};
function ofType(t, style, names) {
  const s = typeToString(t, style, names);
  return style === 'book' && compound(t) ? '(' + s + ')' : s;
}

const tyvarHead = (params, style, names) => {
  const ps = params.map((p) => typeToString(p, style, names));
  if (ps.length === 0) return '';
  return ps.length === 1 ? ps[0] + ' ' : '(' + ps.join(', ') + ') ';
};

export function datatypeText(tn, style = 'book') {
  const names = new Map();
  const head = tyvarHead(tn.params, style, names);
  const cons = tn.cons.map((c) => (c.ty ? c.name + ' of ' + ofType(c.ty, style, names) : c.name));
  return 'datatype ' + head + tn.name + ' = ' + cons.join(' | ');
}

// One echo entry from the elaborator -> its text. `valueOf(name)` gives the run-time value of a `val` entry.
export function echoText(entry, valueOf, style = 'book', depth = DEFAULT_DEPTH) {
  switch (entry.kind) {
    case 'val': return 'val ' + entry.name + ' = ' + showValue(valueOf(entry.name), style, depth) + ' : ' + typeToString(entry.type, style, new Map());
    case 'datatype': return entry.names.map((tn) => datatypeText(tn, style)).join('\n');
    case 'type': {
      const names = new Map();
      const head = tyvarHead(entry.params, style, names);
      return 'type ' + head + entry.name + ' = ' + typeToString(entry.body, style, names);
    }
    case 'exception': return 'exception ' + entry.name + (entry.ty ? ' of ' + ofType(entry.ty, style, new Map()) : '');
    default: return entry.kind;
  }
}
