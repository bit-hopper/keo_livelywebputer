// Homestar badge rules (core/servers/identity/Badges.js): pure, no database.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const b = require('../../core/servers/identity/Badges.js');

const place = (o) => Object.assign({ id: 'pl1234', kind: 'place', visibility: 'anyone', label: 'Oakland, CA' }, o);
const transit = (o) => Object.assign({ id: 'tr1234', kind: 'transit', visibility: 'anyone', agency: 'Metro', label: 'Orange Line', color: '#a85200', textColor: '#ffffff' }, o);
const team = (o) => Object.assign({ id: 'tm1234', kind: 'team', visibility: 'friends', label: 'Comets', abbr: 'cm', color: '#1B2A4A', textColor: '#F4C542' }, o);
const school = (o) => Object.assign({ id: 'sc1234', kind: 'school', visibility: 'anyone', label: 'Hilltop College', color: '#1B2A4A', textColor: '#F4C542' }, o);
const library = (o) => Object.assign({ id: 'li1234', kind: 'library', visibility: 'friends', label: 'Oakland Public Library', abbr: 'OPL' }, o);

// ─── contrast ────────────────────────────────────────────────────────────────

test('contrastRatio: black on white is 21, a colour on itself is 1', () => {
  assert.ok(Math.abs(b.contrastRatio('#000000', '#FFFFFF') - 21) < 1e-9);
  assert.ok(Math.abs(b.contrastRatio('#336699', '#336699') - 1) < 1e-9);
  assert.equal(b.contrastRatio('#123456', '#FEDCBA'), b.contrastRatio('#FEDCBA', '#123456'));
});

test('contrastRatio: the map orange fails with white text, as badges.md warns', () => {
  assert.ok(b.contrastRatio('#FF9933', '#FFFFFF') < 2.5);
});

test('contrastRatio: every pair the design mockups use reaches 4.5', () => {
  const pairs = [
    ['#A85200', '#FFFFFF'], ['#0B6E99', '#FFFFFF'], ['#8C0E34', '#FFFFFF'], ['#0B6B3A', '#FFFFFF'],
    ['#1B2A4A', '#F4C542'], ['#A51C30', '#FFC72C'], ['#5B2A86', '#FFFFFF'], ['#0A2E59', '#FFFFFF'],
    ['#0E6B5C', '#FFFFFF'], ['#6CABDD', '#1C2C5B'], ['#7A1F3D', '#FFFFFF'], ['#FBF4E6', '#7D5C33']
  ];
  for (const [c, t] of pairs) assert.ok(b.contrastRatio(c, t) >= 4.5, c + ' on ' + t + ' = ' + b.contrastRatio(c, t));
});

// ─── normalize ───────────────────────────────────────────────────────────────

test('normalize: never set is an empty list', () => {
  assert.deepEqual(b.normalize(undefined), { badges: [] });
  assert.deepEqual(b.normalize(null), { badges: [] });
  assert.deepEqual(b.normalize([]), { badges: [] });
});

test('normalize: not an array is an error', () => {
  for (const bad of ['x', 7, {}, true]) assert.ok(b.normalize(bad).error, String(bad));
});

test('normalize: a valid mix passes, colours and abbreviations upper-cased, extra keys dropped', () => {
  const r = b.normalize([place({ color: '#000000', abbr: 'X', junk: 1 }), transit({ junk: 2 }), team(), school(), library({ color: '#123456' })]);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.badges[0], { id: 'pl1234', kind: 'place', visibility: 'anyone', label: 'Oakland, CA' });
  assert.equal(r.badges[1].color, '#A85200');
  assert.equal(r.badges[1].junk, undefined);
  const t = r.badges.find((x) => x.kind === 'team');
  assert.equal(t.abbr, 'CM');
  const l = r.badges.find((x) => x.kind === 'library');
  assert.deepEqual(l, { id: 'li1234', kind: 'library', visibility: 'friends', label: 'Oakland Public Library', abbr: 'OPL' });
});

test('normalize: visibility defaults to anyone and rejects unknown values', () => {
  const r = b.normalize([place({ visibility: undefined })]);
  assert.equal(r.badges[0].visibility, 'anyone');
  for (const v of ['public', 'Friends', '', 7, {}]) assert.ok(b.normalize([place({ visibility: v })]).error, String(v));
  for (const v of ['anyone', 'friends', 'orbit', 'private']) assert.equal(b.normalize([place({ visibility: v })]).badges[0].visibility, v);
});

test('normalize: the place is moved to index 0, the others keep their order', () => {
  const r = b.normalize([transit(), team(), place(), school()]);
  assert.deepEqual(r.badges.map((x) => x.kind), ['place', 'transit', 'team', 'school']);
});

test('normalize: at most one place', () => {
  assert.ok(b.normalize([place(), place({ id: 'pl5678' })]).error);
});

test('normalize: at most 20 badges', () => {
  const mk = (i) => school({ id: 'sc' + String(1000 + i) });
  assert.equal(b.normalize(Array.from({ length: 20 }, (_, i) => mk(i))).error, undefined);
  assert.ok(b.normalize(Array.from({ length: 21 }, (_, i) => mk(i))).error);
});

test('normalize: ids are 6 to 12 lowercase letters or digits and unique', () => {
  for (const id of ['abc', 'ABCDEF', 'abc-123', 'abcdefghijklm', '', 7, null, b.LEGACY_ID]) {
    assert.ok(b.normalize([place({ id })]).error, String(id));
  }
  assert.equal(b.normalize([place({ id: 'abcdef' })]).error, undefined);
  assert.equal(b.normalize([place({ id: 'abcdefghijkl' })]).error, undefined);
  assert.ok(b.normalize([school(), school()]).error);
});

test('normalize: entries must be plain objects with a known kind', () => {
  for (const bad of [null, 'x', 7, [], undefined]) assert.ok(b.normalize([bad]).error, String(bad));
  assert.ok(b.normalize([place({ kind: 'pet' })]).error);
  assert.ok(b.normalize([place({ kind: undefined })]).error);
});

test('normalize: text is cleaned and length-limited', () => {
  const r = b.normalize([place({ label: '  THE\u0000\u0007  BAY\n\tarea ' })]);
  assert.equal(r.badges[0].label, 'THE BAY area');
  const long = b.normalize([place({ label: 'x'.repeat(60) })]);
  assert.equal(long.badges[0].label.length, 40);
  const t = b.normalize([transit({ agency: 'A'.repeat(40), label: 'L'.repeat(40) })]);
  assert.equal(t.badges[0].agency.length, 24);
  assert.equal(t.badges[0].label.length, 24);
});

test('normalize: a label that is empty after cleaning is an error', () => {
  for (const label of ['', '   ', '\u0000\u0001', undefined, 7]) {
    assert.ok(b.normalize([place({ label })]).error, String(label));
    assert.ok(b.normalize([school({ label })]).error, String(label));
    assert.ok(b.normalize([team({ label })]).error, String(label));
    assert.ok(b.normalize([library({ label })]).error, String(label));
  }
});

test('normalize: transit may omit agency or line, not both', () => {
  const agencyOnly = b.normalize([transit({ label: '' })]);
  assert.equal(agencyOnly.error, undefined);
  assert.equal(agencyOnly.badges[0].label, '');
  const lineOnly = b.normalize([transit({ agency: undefined })]);
  assert.equal(lineOnly.error, undefined);
  assert.equal(lineOnly.badges[0].agency, '');
  assert.ok(b.normalize([transit({ agency: '', label: '' })]).error);
  assert.ok(b.normalize([transit({ agency: '  ', label: undefined })]).error);
});

test('normalize: team and library abbreviations', () => {
  assert.equal(b.normalize([team({ abbr: 'a1' })]).badges[0].abbr, 'A1');
  for (const abbr of ['', 'ABCD', 'A B', 'A-', undefined, 7]) assert.ok(b.normalize([team({ abbr })]).error, String(abbr));
  assert.equal(b.normalize([library({ abbr: 'oplx' })]).badges[0].abbr, 'OPLX');
  for (const abbr of ['', 'ABCDE', 'O.P', undefined]) assert.ok(b.normalize([library({ abbr })]).error, String(abbr));
});

test('normalize: colours must be #RRGGBB for transit, team and school', () => {
  for (const kind of [transit, team, school]) {
    for (const color of ['red', '#FFF', '#GG0000', 'A85200', '#A852000', 7, undefined, null]) {
      assert.ok(b.normalize([kind({ color })]).error, kind.name + ' color ' + String(color));
      assert.ok(b.normalize([kind({ textColor: color })]).error, kind.name + ' textColor ' + String(color));
    }
  }
});

test('normalize: a colour pair under 4.5:1 is refused, one at the threshold side passes', () => {
  assert.ok(b.normalize([transit({ color: '#FF9933', textColor: '#FFFFFF' })]).error);   // the map orange
  assert.ok(b.normalize([team({ color: '#777777', textColor: '#888888' })]).error);
  assert.ok(b.normalize([school({ color: '#FFFFFF', textColor: '#FFFFFF' })]).error);
  assert.equal(b.normalize([transit({ color: '#FFC800', textColor: '#241F2C' })]).error, undefined); // yellow with dark text
  // #767676 on white is the well-known 4.54:1 boundary
  assert.equal(b.normalize([school({ color: '#767676', textColor: '#FFFFFF' })]).error, undefined);
  assert.ok(b.normalize([school({ color: '#777777', textColor: '#FFFFFF' })]).error);
});

test('normalize: the error does not echo the stored label back', () => {
  const r = b.normalize([place({ label: 'SECRET HOME', visibility: 'bogus' })]);
  assert.ok(r.error);
  assert.equal(r.error.indexOf('SECRET HOME'), -1);
});

// ─── legacy place ────────────────────────────────────────────────────────────

test('legacyPlace: a non-empty profile location becomes a public synthetic place', () => {
  assert.deepEqual(b.legacyPlace('  Oakland,   CA '), { id: '_legacy', kind: 'place', visibility: 'anyone', label: 'Oakland, CA' });
});

test('legacyPlace: empty or non-string gives null', () => {
  for (const v of ['', '   ', '\u0000', undefined, null, 7, {}]) assert.equal(b.legacyPlace(v), null, String(v));
});

test('withLegacyPlace: added at index 0 only when there is no real place badge', () => {
  const list = [transit(), school()];
  const r = b.withLegacyPlace(list, 'Oakland');
  assert.deepEqual(r.map((x) => x.id), ['_legacy', 'tr1234', 'sc1234']);
  assert.deepEqual(b.withLegacyPlace(list, ''), list);
  assert.deepEqual(b.withLegacyPlace([place(), transit()], 'Old City').map((x) => x.id), ['pl1234', 'tr1234']);
  assert.deepEqual(b.withLegacyPlace(undefined, 'Oakland').map((x) => x.id), ['_legacy']);
});

test('withLegacyPlace: a Friends-only real place suppresses the legacy fallback', () => {
  // The profile may still hold the old public value; it must not come back as a public badge.
  const r = b.withLegacyPlace([place({ visibility: 'friends' })], 'Oakland');
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'pl1234');
});

// ─── per-viewer filtering ────────────────────────────────────────────────────

const OWNER = 'did:owner';
const rel = (o) => Object.assign({ ownerDid: OWNER, viewerDid: null, isFriend: false, inOrbit: false }, o);
const mixed = () => b.normalize([
  place({ visibility: 'friends' }),
  transit({ visibility: 'anyone' }),
  team({ visibility: 'orbit' }),
  school({ visibility: 'private' }),
  library({ visibility: 'friends' })
]).badges;
const ids = (r) => r.badges.map((x) => x.id);

test('forViewer: the owner sees every badge, with visibility', () => {
  const r = b.forViewer(mixed(), rel({ viewerDid: OWNER }));
  assert.equal(r.isOwner, true);
  assert.deepEqual(ids(r), ['pl1234', 'tr1234', 'tm1234', 'sc1234', 'li1234']);
  assert.ok(r.badges.every((x) => typeof x.visibility === 'string'));
});

test('forViewer: a friend outside the orbit sees anyone + friends, in order', () => {
  const r = b.forViewer(mixed(), rel({ viewerDid: 'did:f', isFriend: true }));
  assert.equal(r.isOwner, false);
  assert.deepEqual(ids(r), ['pl1234', 'tr1234', 'li1234']);
});

test('forViewer: an orbit friend also sees the orbit badge', () => {
  const r = b.forViewer(mixed(), rel({ viewerDid: 'did:f', isFriend: true, inOrbit: true }));
  assert.deepEqual(ids(r), ['pl1234', 'tr1234', 'tm1234', 'li1234']);
});

test('forViewer: a stranger and a signed-out viewer see only anyone', () => {
  assert.deepEqual(ids(b.forViewer(mixed(), rel({ viewerDid: 'did:s' }))), ['tr1234']);
  assert.deepEqual(ids(b.forViewer(mixed(), rel())), ['tr1234']);
});

test('forViewer: a non-owner never gets visibility, a count, or a hidden badge anywhere in the reply', () => {
  const hidden = b.normalize([place({ label: 'HIDDEN PLACE', visibility: 'private' }), transit()]).badges;
  for (const r of [rel(), rel({ viewerDid: 'did:s' }), rel({ viewerDid: 'did:f', isFriend: true, inOrbit: true })]) {
    const out = b.forViewer(hidden, r);
    const json = JSON.stringify(out);
    assert.equal(json.indexOf('HIDDEN PLACE'), -1);
    assert.equal(json.indexOf('visibility'), -1);
    assert.deepEqual(Object.keys(out).sort(), ['badges', 'isOwner']);
    assert.deepEqual(ids(out), ['tr1234']);
  }
});

test('forViewer: a viewer who may see nothing gets an empty list, not a marker', () => {
  const out = b.forViewer(b.normalize([place({ visibility: 'private' })]).badges, rel({ viewerDid: 'did:f', isFriend: true, inOrbit: true }));
  assert.deepEqual(out, { badges: [], isOwner: false });
});

test('forViewer: signed out can never be the owner, even if ownerDid were falsy', () => {
  const out = b.forViewer([place({ visibility: 'private' })], { ownerDid: null, viewerDid: null, isFriend: false, inOrbit: false });
  assert.equal(out.isOwner, false);
  assert.deepEqual(out.badges, []);
});

test('forViewer: the legacy place is public to everyone, as the profile already was', () => {
  const list = b.withLegacyPlace(b.normalize([transit()]).badges, 'Oakland');
  const out = b.forViewer(list, rel());
  assert.deepEqual(ids(out), ['_legacy', 'tr1234']);
});

test('stripForViewer: removes only visibility and does not mutate its input', () => {
  const src = transit();
  const out = b.stripForViewer(src);
  assert.equal(out.visibility, undefined);
  assert.equal(out.agency, 'Metro');
  assert.equal(src.visibility, 'anyone');
});
