// The badge picker's data (core/lively/identity/BadgeCatalog.js): a browser module, loaded here in a
// stubbed sandbox. Every colour pair must reach 4.5:1 and every entry must be something the server's
// own validation (core/servers/identity/Badges.js) accepts as a stored badge.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const badges = require('../../core/servers/identity/Badges.js');

function loadCatalog() {
  const src = fs.readFileSync(path.join(__dirname, '../../core/lively/identity/BadgeCatalog.js'), 'utf8');
  const sandbox = {
    lively: { identity: {} },
    Color: { rgb: (r, g, b) => ({ r, g, b }), rgba: (r, g, b, a) => ({ r, g, b, a }) },
    module: () => ({ requires: () => ({ toRun: (fn) => fn() }) })
  };
  vm.runInNewContext(src, sandbox, { filename: 'BadgeCatalog.js' });
  return sandbox.lively.identity.BadgeCatalog;
}

const C = loadCatalog();
const HEX = /^#[0-9A-F]{6}$/;
const SOURCES = ['agency-api', 'agency-feed', 'league-logo', 'club-logo', 'club-site', 'brand-site'];

// Every colour pair in the catalog, with where it is.
function pairs() {
  const out = [];
  C.AGENCIES.forEach((a) => {
    if (a.color) out.push([a.label + ' (agency)', a.color, a.textColor]);
    a.lines.forEach((l) => out.push([a.label + ' ' + l.label, l.color, l.textColor]));
  });
  C.TEAMS.forEach((t) => out.push([t.name, t.color, t.textColor]));
  C.SCHOOLS.forEach((s) => out.push([s.name, s.color, s.textColor]));
  return out;
}

test('the catalog has data: agencies with lines, teams in several leagues, schools', () => {
  assert.ok(C.AGENCIES.length >= 3);
  C.AGENCIES.forEach((a) => assert.ok(a.lines.length >= 1, a.key));
  assert.ok(new Set(C.TEAMS.map((t) => t.league)).size >= 6);
  assert.ok(C.SCHOOLS.length >= 2);
});

test('every colour is upper-case #RRGGBB and every pair reaches 4.5:1', () => {
  for (const [name, color, text] of pairs()) {
    assert.match(color, HEX, name + ' color');
    assert.match(text, HEX, name + ' textColor');
    assert.ok(badges.contrastRatio(color, text) >= 4.5, name + ' ' + color + ' on ' + text + ' = ' + badges.contrastRatio(color, text).toFixed(2));
  }
});

test('the client contrast maths agrees with the server\'s', () => {
  for (const [, color, text] of pairs()) assert.ok(Math.abs(C.contrast(color, text) - badges.contrastRatio(color, text)) < 1e-9);
  assert.ok(Math.abs(C.contrast('#000000', '#FFFFFF') - 21) < 1e-9);
});

test('every entry is a stored badge the server accepts', () => {
  const list = [];
  let n = 0;
  const id = () => 'cat' + String(100000 + n++);
  C.AGENCIES.forEach((a) => {
    if (a.color) list.push({ id: id(), kind: 'transit', visibility: 'anyone', agency: a.label, label: '', color: a.color, textColor: a.textColor });
    a.lines.forEach((l) => list.push({ id: id(), kind: 'transit', visibility: 'anyone', agency: a.label, label: l.label, color: l.color, textColor: l.textColor }));
  });
  C.TEAMS.forEach((t) => list.push({ id: id(), kind: 'team', visibility: 'anyone', label: t.name, abbr: t.abbr, color: t.color, textColor: t.textColor }));
  C.SCHOOLS.forEach((s) => list.push({ id: id(), kind: 'school', visibility: 'anyone', label: s.name, color: s.color, textColor: s.textColor }));
  // the server caps a list at 20, so check in chunks; each chunk must come back untouched
  for (let i = 0; i < list.length; i += badges.MAX) {
    const chunk = list.slice(i, i + badges.MAX);
    const r = badges.normalize(chunk);
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.badges.length, chunk.length);
    r.badges.forEach((b, j) => {
      assert.equal(b.label, chunk[j].label, 'label kept whole (not cut by the server limit)');
      if (chunk[j].agency) assert.equal(b.agency, chunk[j].agency);
      if (chunk[j].abbr) assert.equal(b.abbr, chunk[j].abbr);
    });
  }
});

test('names are unique and abbreviations fit a crest', () => {
  assert.equal(new Set(C.TEAMS.map((t) => t.name)).size, C.TEAMS.length);
  assert.equal(new Set(C.AGENCIES.map((a) => a.key)).size, C.AGENCIES.length);
  C.TEAMS.forEach((t) => assert.match(t.abbr, /^[A-Z0-9]{1,3}$/, t.name));
  C.AGENCIES.forEach((a) => assert.equal(new Set(a.lines.map((l) => l.label)).size, a.lines.length, a.key + ' lines'));
});

test('every entry names the kind of official source its colours came from', () => {
  [...C.AGENCIES, ...C.TEAMS, ...C.SCHOOLS].forEach((e) => assert.ok(SOURCES.includes(e.src), (e.key || e.name) + ': ' + e.src));
});

test('textColorFor: white, else the ink, else black; nothing only for a non-colour', () => {
  assert.equal(C.textColorFor('#1D428A'), '#FFFFFF');
  assert.equal(C.textColorFor('#FF9933'), '#241F2C');
  assert.equal(C.textColorFor('#339933'), '#000000');        // fails with white and the ink
  assert.equal(C.textColorFor('#FF0000'), '#000000');
  assert.equal(C.textColorFor('#808080'), '#000000');        // white gives 3.9 here, black 5.3: some pair always reaches 4.5:1
  assert.equal(C.textColorFor('red'), null);
  assert.equal(C.textColorFor(undefined), null);
});

test('rgb: a hex becomes a colour, anything else the fallback', () => {
  assert.deepEqual(C.rgb('#102030'), { r: 16, g: 32, b: 48 });
  assert.deepEqual(C.rgb('nope', { r: 1, g: 2, b: 3 }), { r: 1, g: 2, b: 3 });
  assert.ok(C.rgb('nope'));
});
