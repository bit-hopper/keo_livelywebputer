// Runs the interpreters published for the textbook (a separate checkout; see
// README.md here) through #lang eopl and returns the output of their own test suites.
//
// That code is written as one (module name lang body ...) per file, each file
// requiring its neighbours. This loader reads the files with our own reader, orders
// them by their requires, drops the module wrappers and requires/provides, gives
// every module its own namespace for the few names that several modules define
// (for instance two different list-index procedures), and runs the lot in one
// interpreter after a small shim for the test harness it expects.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interpreter } from '../../../core/lib/scheme/src/index.js';
import { Parser } from '../../../core/lib/scheme/src/reader.js';
import { toWrite } from '../../../core/lib/scheme/src/printer.js';
import { Pair, Sym, SString, stripSym, listToArray, intern } from '../../../core/lib/scheme/src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const preludeDir = path.join(here, '../../../core/lib/scheme/prelude');
const prelude = (n) => fs.readFileSync(path.join(preludeDir, n), 'utf8');
const symName = (x) => (x instanceof Sym ? stripSym(x).name : null);

export function newBookInterpreter() {
  const interp = new Interpreter({ prelude: prelude('core.scm'), libraries: { eopl: prelude('eopl.scm') } });
  const r = interp.startRun(fs.readFileSync(path.join(here, 'glue.scm'), 'utf8')).runToCompletion();
  if (r.state === 'error') throw new Error('glue failed: ' + r.segments.map((s) => s.text).join('; '));
  return interp;
}

function moduleOrder(topFile) {
  const order = [], seen = new Set();
  (function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const forms = new Parser(fs.readFileSync(file, 'utf8')).readAll();
    const mod = forms.find((f) => f instanceof Pair && symName(f.car) === 'module');
    const body = mod ? listToArray(mod).slice(3) : forms;
    const reqs = [];
    for (const f of body) {
      if (f instanceof Pair && symName(f.car) === 'require') {
        for (const spec of listToArray(f.cdr)) {
          if (spec instanceof SString && !spec.s.endsWith('-init.scm')) {
            const dep = path.join(path.dirname(file), spec.s);
            reqs.push(dep);
            visit(dep);
          }
        }
      }
    }
    order.push({ file, body, reqs });
  })(topFile);
  return order;
}

function definedNames(body) {
  const names = new Set();
  for (const f of body) {
    if (f instanceof Pair && symName(f.car) === 'define') {
      let t = f.cdr.car;
      while (t instanceof Pair) t = t.car;
      if (t instanceof Sym) names.add(stripSym(t).name);
    }
  }
  return names;
}

function separateNamespaces(order) {
  for (const m of order) m.defs = definedNames(m.body);
  const counts = new Map();
  for (const m of order) for (const n of m.defs) counts.set(n, (counts.get(n) || 0) + 1);
  const conflicts = new Set([...counts].filter(([, c]) => c > 1).map(([n]) => n));
  if (!conflicts.size) return conflicts;
  const byFile = new Map(order.map((m) => [m.file, m]));
  const owner = (m, n) => {
    if (m.defs.has(n)) return m;
    for (const r of m.reqs) { const o = byFile.get(r); if (o && o.defs.has(n)) return o; }
    for (let k = order.indexOf(m) - 1; k >= 0; k--) if (order[k].defs.has(n)) return order[k];
    return null;
  };
  const rename = (d, m) => {
    if (d instanceof Sym) {
      const n = stripSym(d).name;
      const o = conflicts.has(n) ? owner(m, n) : null;
      return o ? intern(n + '@' + path.basename(o.file)) : d;
    }
    if (d instanceof Pair) return symName(d.car) === 'quote' ? d : new Pair(rename(d.car, m), rename(d.cdr, m));
    return Array.isArray(d) ? d.map((x) => rename(x, m)) : d;
  };
  for (const m of order) m.body = m.body.map((f) => rename(f, m));
  return conflicts;
}

// Loads the language in `dir` (its top file, default top.scm) and evaluates `expr`.
// Returns { output, errors } where output is everything printed and the final value.
export function runBookLanguage(dir, { top = 'top.scm', expr = '(run-all)' } = {}) {
  const order = moduleOrder(path.join(dir, top));
  separateNamespaces(order);
  const interp = newBookInterpreter();
  const skip = new Set(['require', 'provide', 'print-struct']);
  const run = (text) => {
    const r = interp.startRun(text).runToCompletion();
    return {
      output: r.segments.filter((s) => s.kind === 'stdout' || s.kind === 'value').map((s) => s.text).join('\n'),
      errors: r.segments.filter((s) => s.kind === 'error').map((s) => s.text),
    };
  };
  for (const { file, body } of order) {
    const text = body.filter((f) => !(f instanceof Pair && skip.has(symName(f.car)))).map((f) => toWrite(f)).join('\n');
    const r = run(text);
    if (r.errors.length) return { output: r.output, errors: [path.basename(file) + ': ' + r.errors.join('; ')] };
  }
  return run(expr);
}
