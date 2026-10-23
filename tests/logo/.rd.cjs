const fs = require('fs');
const p = 'core/lib/logo/src/reader.js';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 50)); s = s.replace(a, () => b); };
rep("    let word = null;      // the word being built, or null: {buf, special, quoted, barred}",
    "    let word = null;      // the word being built, or null: {buf, special, quoted, bsSpecial, barSpecial}");
rep("      top().items.push(word.special ? new QWord(word.buf) : word.buf);\n      word = null;",
    "      // A quoted word at the top level whose protected characters were all backslashed (no bars) remembers that, so PO\n      // can print it as typed.\n      const viaBackslash = word.special && word.bsSpecial === true && word.barSpecial !== true && word.quoted === true && stack.length === 1;\n      top().items.push(word.special ? new QWord(word.buf, viaBackslash) : word.buf);\n      word = null;");
rep("    const addChar = (c, quoting) => {\n      if (word === null) word = { buf: '', special: false, quotedWord: false };\n      word.buf += c;\n      if (quoting && SPECIAL_RE.test(c)) word.special = true;\n    };",
    "    // `how` is 'bar' or 'backslash' for a protected character, else absent.\n    const addChar = (c, how) => {\n      if (word === null) word = { buf: '', special: false, quoted: false };\n      word.buf += c;\n      if (how !== undefined && SPECIAL_RE.test(c)) {\n        word.special = true;\n        if (how === 'bar') word.barSpecial = true; else word.bsSpecial = true;\n      }\n    };");
rep("        if (c === '\\' && i + 1 < n) { addChar(text[i + 1], true); i += 2; continue; }\n        addChar(c, true);   // a newline",
    "        if (c === '\\' && i + 1 < n) { addChar(text[i + 1], 'bar'); i += 2; continue; }\n        addChar(c, 'bar');   // a newline");
rep("        addChar(text[i + 1], true);\n        if (word.special && !word.barred) word.viaBackslash = true;\n", "        addChar(text[i + 1], 'backslash');\n");
rep("      addChar(c, false);\n      i++;", "      addChar(c);\n      i++;");
fs.writeFileSync(p, s);
let d = fs.readFileSync('core/lib/logo/src/data.js', 'utf8');
const a = "export class QWord {\n  constructor(text) { this.text = text; }";
if (!d.includes(a)) throw new Error('data');
d = d.replace(a, () => "export class QWord {\n  // viaBackslash: the protection came from backslashes alone, in a word typed as \"word (PO prints such a word with them).\n  constructor(text, viaBackslash = false) { this.text = text; this.viaBackslash = viaBackslash; }");
fs.writeFileSync('core/lib/logo/src/data.js', d);
