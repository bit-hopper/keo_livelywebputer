// Lexer for the Standard ML subset of MLspec.md section 5.1/5.2. Lazy: `next()` produces one token,
// so an error late in a cell surfaces only when the parser reaches it, after the earlier items have run.
//
// Token: { type, value, line, col, start, end, ...extras }
//   int       value: number (BigInt beyond 2^53), text
//   id        alphanumeric identifier (letters, digits, _ and '); qual: ['A','B'] for A.B.name
//   sym       symbolic identifier (+ - * < <= <> ^ @ ~ ...); not a reserved symbol
//   kw        reserved word
//   op        reserved symbol or punctuation: ( ) [ ] { } , ; : :> -> => | = _ . # and the ⊗ mark
//   tyvar     'a or ''a (eq: true); glyph: true when written α β γ δ
//   ellipsis  … or ... (a placeholder in the book's ⊗ boxes)
//   pragma    (*# name: value *); name, value
//   eof
// Glyph aliases: → -> ,  ⇒ =>,  ▷ :>,  ∗ *,  α β γ δ 'a 'b 'c 'd. A line whose first non-blank character is
// • is a type box: the rest of the line is wrapped as ( ... ); . ⊗ is a statement prefix (op '⊗').
import { syntaxError, ungrammatical } from './errors.js';

export const RESERVED = new Set([
  'and', 'andalso', 'as', 'case', 'datatype', 'else', 'end', 'exception', 'fn', 'fun', 'functor',
  'handle', 'if', 'in', 'let', 'local', 'of', 'op', 'open', 'orelse', 'raise', 'rec', 'sharing',
  'sig', 'signature', 'struct', 'structure', 'then', 'type', 'val', 'where', 'with',
  // reserved in SML but outside the accepted subset: the parser answers them with a pointed message
  'abstype', 'do', 'eqtype', 'include', 'infix', 'infixr', 'nonfix', 'while', 'withtype',
]);

const SYMCHARS = '!%&$#+-/:<=>?@\\~`^|*';
// Symbol runs that are reserved rather than identifiers. '=' is both: it is an op and the equality operator.
const RESERVED_SYM = new Set([':', ':>', '|', '=', '=>', '->', '#']);
const GREEK = { 'α': "'a", 'β': "'b", 'γ': "'c", 'δ': "'d" };

// int is 63-bit (MLspec.md row 15a): -2^62 .. 2^62-1.
const INT_MIN = -(1n << 62n);
const INT_MAX = (1n << 62n) - 1n;

const isDigit = (c) => c >= '0' && c <= '9';
const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isIdChar = (c) => isLetter(c) || isDigit(c) || c === '_' || c === "'";

export class Lexer {
  constructor(source) {
    this.src = source;
    this.i = 0;
    this.line = 1;
    this.col = 1;
    this.queue = [];        // synthetic tokens waiting to be delivered (the end of a • type box)
    this.boxOpen = false;   // inside a • type box: the end of the line closes it
    this.lineStart = true;  // only blanks seen so far on this line (for •)
  }

  // Positions are taken before consuming, so error and token locations are the first character.
  here() { return { line: this.line, col: this.col, start: this.i }; }

  adv(n = 1) {
    for (let k = 0; k < n; k++) {
      const c = this.src[this.i++];
      if (c === '\n') { this.line++; this.col = 1; this.lineStart = true; } else this.col++;
    }
  }

  tok(type, value, from, extra) {
    return Object.assign({ type, value, line: from.line, col: from.col, start: from.start, end: this.i }, extra);
  }

  next() {
    if (this.queue.length) return this.queue.shift();
    for (;;) {
      const src = this.src;
      if (this.i >= src.length) {
        if (this.boxOpen) return this._closeBox(this.here());
        return this.tok('eof', null, this.here());
      }
      const c = src[this.i];
      if (c === '\n') {
        if (this.boxOpen) { const t = this._closeBox(this.here()); this.adv(); return t; }
        this.adv();
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { this.adv(); continue; }
      if (c === '(' && src[this.i + 1] === '*') {
        const p = this._comment();
        if (p) return p;
        continue;
      }
      const from = this.here();
      const wasLineStart = this.lineStart;
      this.lineStart = false;

      if (c === '•' && wasLineStart && !this.boxOpen) {
        this.adv();
        this.boxOpen = true;
        return this.tok('op', '(', from);
      }
      if (c === '⊗') { this.adv(); return this.tok('op', '⊗', from); }
      if (c === '…') { this.adv(); return this.tok('ellipsis', '…', from); }
      if (c === '.' && src.startsWith('...', this.i)) { this.adv(3); return this.tok('ellipsis', '...', from); }
      if (GREEK[c]) { this.adv(); return this.tok('tyvar', GREEK[c], from, { eq: false, glyph: true }); }
      if (c === '→') { this.adv(); return this.tok('op', '->', from, { glyph: true }); }
      if (c === '⇒') { this.adv(); return this.tok('op', '=>', from, { glyph: true }); }
      if (c === '▷') { this.adv(); return this.tok('op', ':>', from, { glyph: true }); }
      if (c === '∗') { this.adv(); return this.tok('sym', '*', from, { glyph: true }); }

      if (isDigit(c) || (c === '~' && isDigit(src[this.i + 1] || ''))) return this._number(from);
      if (isLetter(c)) return this._identifier(from);
      if (c === "'") return this._tyvar(from);
      if (c === '"') {
        this._skipString();
        throw syntaxError('strings are not part of the core the book uses', from);
      }
      if (c === '_') {
        if (isIdChar(src[this.i + 1] || '')) {
          this.adv();
          throw syntaxError('a name cannot start with _; a lone _ is the wildcard pattern', from);
        }
        this.adv();
        return this.tok('op', '_', from);
      }
      if ('()[]{},;'.includes(c)) { this.adv(); return this.tok('op', c, from); }
      if (c === '.') { this.adv(); return this.tok('op', '.', from); }
      if (SYMCHARS.includes(c)) return this._symbol(from);

      this.adv();
      throw syntaxError('unexpected character ' + JSON.stringify(c), from);
    }
  }

  _closeBox(from) {
    this.boxOpen = false;
    this.queue.push(this.tok('op', ';', from));
    return this.tok('op', ')', from);
  }

  // Comment starting at (*. Nested. (*# name: value *) is a pragma, returned as a token; others return null.
  _comment() {
    const src = this.src;
    const from = this.here();
    const isPragma = src[this.i + 2] === '#';
    this.adv(2);
    let depth = 1;
    const bodyStart = this.i;
    let bodyEnd = this.i;
    while (this.i < src.length) {
      if (src[this.i] === '(' && src[this.i + 1] === '*') { depth++; this.adv(2); }
      else if (src[this.i] === '*' && src[this.i + 1] === ')') {
        depth--;
        if (depth === 0) { bodyEnd = this.i; this.adv(2); break; }
        this.adv(2);
      } else this.adv();
    }
    if (depth !== 0) throw syntaxError('this comment is never closed (missing *))', from);
    this.lineStart = false;
    if (!isPragma) return null;
    const body = src.slice(bodyStart + 1, bodyEnd).trim();
    const m = /^([A-Za-z_]+)\s*:\s*(.*)$/s.exec(body);
    return this.tok('pragma', m ? m[2].trim() : null, from, { name: m ? m[1] : body });
  }

  _skipString() {
    const src = this.src;
    this.adv();
    while (this.i < src.length && src[this.i] !== '"' && src[this.i] !== '\n') {
      if (src[this.i] === '\\') this.adv();
      this.adv();
    }
    if (src[this.i] === '"') this.adv();
  }

  _number(from) {
    const src = this.src;
    let j = this.i;
    if (src[j] === '~') j++;
    while (isDigit(src[j] || '')) j++;
    const text = src.slice(this.i, j);
    const after = src[j] || '';
    const after2 = src[j + 1] || '';
    if ((after === '.' && isDigit(after2)) || ((after === 'e' || after === 'E') && (isDigit(after2) || after2 === '~'))) {
      this.adv(j - this.i);
      throw syntaxError('reals are not part of the core the book uses', from);
    }
    this.adv(j - this.i);
    const big = BigInt(text.replace('~', '-'));
    if (big < INT_MIN || big > INT_MAX) throw ungrammatical('the integer ' + text + ' is too large for int', from);
    const value = (big >= -(2n ** 53n) && big <= 2n ** 53n) ? Number(big) : big;
    return this.tok('int', value, from, { text });
  }

  _identifier(from) {
    const src = this.src;
    const qual = [];
    let name;
    for (;;) {
      let j = this.i;
      while (isIdChar(src[j] || '')) j++;
      name = src.slice(this.i, j);
      this.adv(j - this.i);
      // A.B: a structure path, only when a letter follows the dot (so `x.` and `...` are left alone).
      if (src[this.i] === '.' && isLetter(src[this.i + 1] || '') && !RESERVED.has(name)) {
        qual.push(name);
        this.adv();
        continue;
      }
      break;
    }
    if (qual.length === 0 && RESERVED.has(name)) return this.tok('kw', name, from);
    return this.tok('id', name, from, { qual: qual.length ? qual : null });
  }

  _tyvar(from) {
    const src = this.src;
    let j = this.i;
    let eq = false;
    if (src[j + 1] === "'") { eq = true; j += 2; } else j += 1;
    if (!isLetter(src[j] || '')) {
      this.adv(j - this.i);
      throw syntaxError("a type variable is ' followed by a letter, like 'a", from);
    }
    while (isIdChar(src[j] || '')) j++;
    const text = src.slice(this.i, j);
    this.adv(j - this.i);
    return this.tok('tyvar', text, from, { eq, glyph: false });
  }

  _symbol(from) {
    const src = this.src;
    let j = this.i;
    while (j < src.length && SYMCHARS.includes(src[j])) j++;
    const text = src.slice(this.i, j);
    this.adv(j - this.i);
    if (RESERVED_SYM.has(text)) return this.tok('op', text, from);
    return this.tok('sym', text, from);
  }

  // Error recovery: the lexer already moved past whatever it rejected, so there is nothing to undo.
  // Used by the parser's resynchronisation, which swallows lexical errors while skipping an item.
}
