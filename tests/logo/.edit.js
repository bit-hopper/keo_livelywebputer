const fs = require('fs');
const p = 'core/lib/logo/src/workspace.js';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a); s = s.replace(a, () => b); };
rep("import { showForm, showText, printText } from './printer.js';", "import { showForm, printText, poValue, poName } from './printer.js';");
rep(`    for (const n of vars) m.interp.out('Make ' + JSON.stringify(n).replace(/^"|"$/g, '"') + ' ' + showText(m.lookupVar(nameKey(n), n)) + '\n');`,
    `    for (const n of vars) m.interp.out('Make ' + poName(n) + ' ' + poValue(m.lookupVar(nameKey(n), n)) + '\n');`);
rep(`      if (pl) for (const [, e] of pl) m.interp.out('Pprop "' + n + ' "' + e[0] + ' ' + showText(e[1]) + '\n');`,
    `      if (pl) for (const e of plistEntries(pl)) m.interp.out('Pprop ' + poName(n) + ' ' + poName(e[0]) + ' ' + poValue(e[1]) + '\n');`);
rep(`    if (pl) for (const [, e] of pl) out.push(e[0], e[1]);`, `    if (pl) for (const e of plistEntries(pl)) out.push(e[0], e[1]);`);
rep(`  const plistOf = (m, name, create) => {`, `  // A property list's [name, value] pairs, newest property first: that is the order PLIST and PO give (a PPROP on a property
  // that already exists changes its value and keeps its place).
  const plistEntries = (pl) => [...pl.values()].reverse();
  const plistOf = (m, name, create) => {`);
rep(`  const userProcNames = (m) => [...m.interp.procs.values()].filter((p) => p.fn === undefined && p.op === undefined && !p.library).map((p) => p.name);`,
    `  // PROCEDURES, NAMES, PLISTS, CONTENTS and the PO family list in alphabetical order, as the reference does.
  const byName = (a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
  const userProcNames = (m) => [...m.interp.procs.values()].filter((p) => p.fn === undefined && p.op === undefined && !p.library).map((p) => p.name).sort(byName);`);
rep(`filter(([k, st]) => st.length > 0 && !m.interp.systemVars.has(k)).map(([k]) => k);`, `filter(([k, st]) => st.length > 0 && !m.interp.systemVars.has(k)).map(([k]) => k).sort(byName);`);
rep(`const plistNames = (m) => [...m.interp.plists.keys()];`, `const plistNames = (m) => [...m.interp.plists.keys()].sort(byName);`);
fs.writeFileSync(p, s);
