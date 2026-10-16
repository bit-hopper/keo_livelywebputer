// Test helpers: a compact, fully parenthesised rendering of the parser's AST, so a test can assert on one string.
import { Lexer } from '../../core/lib/ml/src/lexer.js';
import { Parser } from '../../core/lib/ml/src/parser.js';

export function tokens(source) {
  const lx = new Lexer(source);
  const out = [];
  for (let t = lx.next(); t.type !== 'eof'; t = lx.next()) out.push(t);
  return out;
}

// 'type:value' per token, e.g. ['kw:val', 'id:x', 'op:=', 'int:1']
export const lexTokens = (source) => tokens(source).map((t) => t.type + ':' + t.value);

const name = (n) => (n.qual ? n.qual.join('.') + '.' : '') + n.name;

export function showTy(t) {
  switch (t.kind) {
    case 'tyvar': return t.name;
    case 'tycon':
      if (t.args.length === 0) return name(t);
      if (t.args.length === 1) return showTy(t.args[0]) + ' ' + name(t);
      return '(' + t.args.map(showTy).join(', ') + ') ' + name(t);
    case 'ttuple': return '(' + t.items.map(showTy).join(' * ') + ')';
    case 'arrow': return '(' + showTy(t.from) + ' -> ' + showTy(t.to) + ')';
    default: throw new Error('showTy ' + t.kind);
  }
}

export function showPat(p) {
  switch (p.kind) {
    case 'wild': return '_';
    case 'pint': return String(p.value);
    case 'pid': return name(p);
    case 'pcon': return '(' + showPat(p.con) + ' ' + showPat(p.arg) + ')';
    case 'ptuple': return '(' + p.items.map(showPat).join(', ') + ')';
    case 'ptyped': return '(' + showPat(p.pat) + ' : ' + showTy(p.ty) + ')';
    default: throw new Error('showPat ' + p.kind);
  }
}

const showMatch = (m) => m.map((r) => showPat(r.pat) + ' => ' + show(r.exp)).join(' | ');

export function show(n) {
  switch (n.kind) {
    case 'int': return String(n.value);
    case 'var': return name(n);
    case 'tuple': return '(' + n.items.map(show).join(', ') + ')';
    case 'seq': return '(' + n.exps.map(show).join('; ') + ')';
    case 'app': return n.infix ? '(' + show(n.arg.items[0]) + ' ' + n.fn.name + ' ' + show(n.arg.items[1]) + ')'
      : '(' + show(n.fn) + ' ' + show(n.arg) + ')';
    case 'typed': return '(' + show(n.exp) + ' : ' + showTy(n.ty) + ')';
    case 'andalso': return '(' + show(n.left) + ' andalso ' + show(n.right) + ')';
    case 'orelse': return '(' + show(n.left) + ' orelse ' + show(n.right) + ')';
    case 'if': return '(if ' + show(n.cond) + ' then ' + show(n.then) + ' else ' + show(n.else) + ')';
    case 'case': return '(case ' + show(n.exp) + ' of ' + showMatch(n.match) + ')';
    case 'fn': return '(fn ' + showMatch(n.match) + ')';
    case 'raise': return '(raise ' + show(n.exp) + ')';
    case 'handle': return '(' + show(n.exp) + ' handle ' + showMatch(n.match) + ')';
    case 'let': return '(let ' + n.decs.map(show).join(' ') + ' in ' + show(n.body) + ')';
    case 'expstmt': return show(n.exp);
    case 'val': return 'val ' + n.binds.map((b) => (b.rec ? 'rec ' : '') + showPat(b.pat) + ' = ' + show(b.exp)).join(' and ');
    case 'fun': return 'fun ' + n.binds.map((b) => b.clauses.map((c) =>
      b.name + ' ' + c.pats.map(showPat).join(' ') + (c.resultTy ? ' : ' + showTy(c.resultTy) : '') + ' = ' + show(c.exp)).join(' | ')).join(' and ');
    case 'datatype': return 'datatype ' + n.binds.map((b) =>
      (b.tyvars.length ? '(' + b.tyvars.join(', ') + ') ' : '') + b.name + ' = ' +
      b.cons.map((c) => c.name + (c.ty ? ' of ' + showTy(c.ty) : '')).join(' | ')).join(' and ');
    case 'type': return 'type ' + n.binds.map((b) => (b.tyvars.length ? '(' + b.tyvars.join(', ') + ') ' : '') + b.name + ' = ' + showTy(b.ty)).join(' and ');
    case 'exception': return 'exception ' + n.binds.map((b) => b.name + (b.ty ? ' of ' + showTy(b.ty) : '')).join(' and ');
    case 'local': return 'local ' + n.head.map(show).join(' ') + ' in ' + n.body.map(show).join(' ') + ' end';
    case 'signature': return 'signature ' + n.binds.map((b) => b.name + ' = ' + show(b.sig)).join(' and ');
    case 'sig': return 'sig ' + n.specs.map(show).join(' ') + ' end';
    case 'sigid': return n.name;
    case 'where': return show(n.sig) + ' where type ' + (n.tyvars.length ? '(' + n.tyvars.join(', ') + ') ' : '') + name(n.tycon) + ' = ' + showTy(n.ty);
    case 'sigtype': return 'type ' + (n.tyvars.length ? '(' + n.tyvars.join(', ') + ') ' : '') + n.name;
    case 'sigval': return 'val ' + n.name + ' : ' + showTy(n.ty);
    case 'sigexn': return 'exception ' + n.name + (n.ty ? ' of ' + showTy(n.ty) : '');
    case 'sigstruct': return 'structure ' + n.name + ' : ' + show(n.sig);
    case 'sharing': return 'sharing type ' + n.tycons.map(name).join(' = ');
    case 'structure': return 'structure ' + n.binds.map((b) =>
      b.name + (b.ascription ? (b.ascription.opaque ? ' :> ' : ' : ') + show(b.ascription.sig) : '') + ' = ' + show(b.body)).join(' and ');
    case 'functor': return 'functor ' + n.name + '(' + (n.param.kind === 'named' ? n.param.strid + ' : ' + show(n.param.sig) : n.param.specs.map(show).join(' ')) + ')' +
      (n.ascription ? (n.ascription.opaque ? ' :> ' : ' : ') + show(n.ascription.sig) : '') + ' = ' + show(n.body);
    case 'struct': return 'struct ' + n.decs.map(show).join(' ') + ' end';
    case 'strid': return name(n);
    case 'apply': return n.fun + '(' + show(n.arg) + ')';
    case 'decs': return n.decs.map(show).join(' ');
    case 'ascribe': return show(n.str) + (n.opaque ? ' :> ' : ' : ') + show(n.sig);
    case 'letstr': return 'let ' + n.decs.map(show).join(' ') + ' in ' + show(n.body) + ' end';
    case 'open': return 'open ' + n.strid;
    case 'pragma': return '(*# ' + n.name + ': ' + n.value + ' *)';
    default: throw new Error('show ' + n.kind);
  }
}

// Parse a whole source and render each item.
export const items = (source) => new Parser(source).parseAll();
export const parsed = (source) => items(source).map(show);
// The one item of a one-item source, rendered.
export const one = (source) => {
  const its = items(source);
  if (its.length !== 1) throw new Error('expected one item, got ' + its.length);
  return show(its[0]);
};
// The error a source raises: 'class: message'.
export function failure(source) {
  try { new Parser(source).parseAll(); } catch (e) { return e.errorClass + ': ' + e.message; }
  return null;
}

// Split a corpus into its (*--*)-separated chunks, the way tests/ml/seed/runchunks.sh does.
export const chunks = (text) => text.replace(/\r/g, '').split(/^\(\*--\*\)$/m).map((c) => c.trim()).filter(Boolean);
