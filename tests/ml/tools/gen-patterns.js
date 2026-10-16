// Generates tests/ml/seed/patterns.sml: random clause sets over a few small datatypes, one independent chunk per
// function, so SML/NJ's verdict on each (exhaustive / non-exhaustive / redundant) can be recorded once
// (tests/ml/tools/runindep.sh) and replayed offline by patterns-differential.test.js.
//
//   node tests/ml/tools/gen-patterns.js > tests/ml/seed/patterns.sml
//
// Deterministic: the same seed gives the same file. Chunk 0 is the shared prelude; every later chunk is one `fun`.
const SEED = 20261016;
const COUNT = 400;

let state = SEED >>> 0;
function rnd() { // mulberry32
  state = (state + 0x6D2B79F5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

let varCount = 0;
const fresh = () => 'v' + (varCount++);

// pattern of type `ty` with at most `depth` levels of constructor nesting
function pat(ty, depth) {
  const r = rnd();
  if (r < 0.22) return rnd() < 0.5 ? '_' : fresh();
  switch (ty) {
    case 'bool': return pick(['true', 'false']);
    case 'u': return pick(['X', 'Y', 'Z']);
    case 'int': return pick(['0', '1', '2']);
    case 't': {
      if (depth <= 0) return pick(['A']);
      const c = pick(['A', 'B', 'C', 'C', 'D']);
      if (c === 'A') return 'A';
      if (c === 'B') return 'B(' + pat('int', depth - 1) + ')';
      if (c === 'D') return 'D(' + pat('u', depth - 1) + ')';
      return 'C(' + pat('t', depth - 1) + ', ' + pat('t', depth - 1) + ')';
    }
    default: throw new Error(ty);
  }
}

const COLUMNS = [['t'], ['t'], ['bool', 'bool'], ['t', 'bool'], ['u', 'int'], ['bool', 'u', 'bool'], ['t', 't'], ['int'], ['u'], ['u', 'u']];

const out = ['datatype u = X | Y | Z;\ndatatype t = A | B of int | C of t * t | D of u;'];
for (let i = 0; i < COUNT; i++) {
  const cols = pick(COLUMNS);
  const n = 1 + Math.floor(rnd() * 5);
  const clauses = [];
  for (let k = 0; k < n; k++) {
    const ps = cols.map((c) => pat(c, 2));
    clauses.push((ps.length === 1 ? 'f' + i + '(' + ps[0] + ')' : 'f' + i + '(' + ps.join(', ') + ')') + ' = ' + k);
  }
  // some chunks end with a catch-all so redundancy after it is exercised
  if (rnd() < 0.15) clauses.push('f' + i + '(' + cols.map(() => '_').join(', ') + ') = 9');
  out.push('fun ' + clauses.join('\n  | ') + ';');
}
process.stdout.write(out.join('\n(*--*)\n') + '\n');
