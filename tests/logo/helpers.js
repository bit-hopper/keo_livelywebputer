// Shared by the Logo engine tests: a fresh interpreter (with the always-loaded prelude once it exists), and a runner that
// returns what a terminal would show.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interpreter } from '../../core/lib/logo/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEED_DIR = path.join(here, 'seed');

const preludePath = path.join(here, '..', '..', 'core', 'lib', 'logo', 'prelude', 'core.logo');

// A new interpreter. The turtle primitives arrive in Phase 2; a few probes call fd, so `turtleStub` registers one with its
// real arity so that the "not enough inputs to fd" errors match.
export function newInterpreter({ turtleStub = false, ...opts } = {}) {
  const prelude = fs.existsSync(preludePath) ? fs.readFileSync(preludePath, 'utf8') : undefined;
  const it = new Interpreter({ prelude, ...opts });
  if (turtleStub) for (const n of ['fd', 'forward']) it.procs.set(n, { name: n, key: n, min: 1, def: 1, max: 1, fn: () => {} });
  return it;
}

// Runs a source text to completion on a fresh interpreter; resolves {state, text, segments}. onError defaults to
// 'continue' (the Logo prompt's behaviour) so a test sees every line's result.
export function logo(source, opts = {}) {
  const it = opts.interp || newInterpreter(opts);
  const r = it.run(source, { onError: 'continue', ...opts });
  return { ...r, interp: it };
}

// The text of a run, trailing whitespace trimmed: the convenient thing to compare in a test.
export const out = (source, opts) => logo(source, opts).text.replace(/\s+$/, '');
