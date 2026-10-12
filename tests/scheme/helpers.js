// Shared test helpers: build an interpreter with the real prelude and run source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interpreter } from '../../core/lib/scheme/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const preludeDir = path.join(here, '../../core/lib/scheme/prelude');

export function readPrelude(name) {
  return fs.readFileSync(path.join(preludeDir, name), 'utf8');
}

// Libraries available as `#lang <name>` -- every prelude/*.scm except core.scm.
export function allLibraries() {
  const libs = {};
  for (const f of fs.readdirSync(preludeDir)) {
    if (f.endsWith('.scm') && f !== 'core.scm') libs[f.replace(/\.scm$/, '')] = readPrelude(f);
  }
  return libs;
}

export function newInterp(opts = {}) {
  return new Interpreter({ prelude: readPrelude('core.scm'), libraries: allLibraries(), ...opts });
}

let shared = null;
// One shared interpreter for the many small expression tests (fast); tests that
// redefine globals should build their own with newInterp().
export function sharedInterp() { return shared || (shared = newInterp()); }

// Evaluate source; returns the result of the last top-level form as written
// text (REPL value), or ';error text' for an uncaught error. stdout is included
// ahead of the value, separated by '|'.
export function run(source, interp = sharedInterp()) {
  const r = interp.evalSync(source);
  const parts = [];
  for (const s of r.segments) {
    if (s.kind === 'stdout') parts.push('out:' + s.text);
    else if (s.kind === 'value') parts.push(s.text);
    else if (s.kind === 'error') parts.push(';' + s.text);
    else parts.push('[' + s.text + ']');
  }
  return parts.join('|');
}

// Just the final value text (ignores stdout), for terse assertions.
export function val(source, interp = sharedInterp()) {
  const r = interp.evalSync(source);
  const vals = r.segments.filter((s) => s.kind === 'value' || s.kind === 'error');
  const last = vals[vals.length - 1];
  return last ? (last.kind === 'error' ? ';' + last.text : last.text) : '';
}

export function stdout(source, interp = sharedInterp()) {
  const r = interp.evalSync(source);
  return r.segments.filter((s) => s.kind === 'stdout').map((s) => s.text).join('');
}
