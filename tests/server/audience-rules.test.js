// Audience rules (core/lively/identity/AudienceRules.js): pure client-side logic,
// loaded here with a stub of Lively's module() so the real file is what is tested.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Runs in this realm (not a separate vm context) so the arrays the rules return
// share Array.prototype with the test's own and deepEqual can compare them.
function loadRules() {
  const file = path.join(__dirname, '../../core/lively/identity/AudienceRules.js');
  const saved = { lively: global.lively, module: global.module };
  global.lively = { identity: {} };
  global.module = () => ({ requires: () => ({ toRun: (fn) => fn() }) });
  try {
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
    return global.lively.identity.AudienceRules;
  } finally {
    global.lively = saved.lively;
    global.module = saved.module;
  }
}

const rules = loadRules();

const ctx = {
  ownerDid: 'did:me',
  friendDids: ['did:a', 'did:b', 'did:c', 'did:d'],
  orbitDids: ['did:a', 'did:b'],
  lists: [
    { id: 'club', memberDids: ['did:c', 'did:d'] },
    { id: 'empty', memberDids: [] }
  ]
};

test('unionDids: a single tier expands to its members', () => {
  assert.deepEqual(rules.unionDids({ tiers: ['orbit'] }, ctx), ['did:a', 'did:b']);
  assert.deepEqual(rules.unionDids({ tiers: ['friends'] }, ctx), ['did:a', 'did:b', 'did:c', 'did:d']);
  assert.deepEqual(rules.unionDids({ tiers: ['list:club'] }, ctx), ['did:c', 'did:d']);
});

test('unionDids: several tiers count a person who is in more than one just once', () => {
  assert.deepEqual(rules.unionDids({ tiers: ['orbit', 'friends', 'list:club'] }, ctx),
    ['did:a', 'did:b', 'did:c', 'did:d']);
});

test('unionDids: named people join the tiers, also without duplicates', () => {
  assert.deepEqual(rules.unionDids({ tiers: ['orbit'], people: ['did:d', 'did:a'] }, ctx),
    ['did:a', 'did:b', 'did:d']);
  assert.deepEqual(rules.unionDids({ tiers: [], people: ['did:c'] }, ctx), ['did:c']);
});

test('unionDids: the owner is never a recipient', () => {
  const c = Object.assign({}, ctx, { friendDids: ['did:me', 'did:a'] });
  assert.deepEqual(rules.unionDids({ tiers: ['friends'], people: ['did:me'] }, c), ['did:a']);
});

test('unionDids: someone who is no longer a friend stands for nobody, in a list or by name', () => {
  const c = Object.assign({}, ctx, { friendDids: ['did:a', 'did:c'] });
  assert.deepEqual(rules.unionDids({ tiers: ['list:club'], people: ['did:b', 'did:a'] }, c), ['did:c', 'did:a']);
});

test('unionDids: an unknown tier, a missing list or no audience is nobody', () => {
  assert.deepEqual(rules.unionDids({ tiers: ['public', 'list:gone', 'nonsense'] }, ctx), []);
  assert.deepEqual(rules.unionDids({ tiers: ['list:empty'] }, ctx), []);
  assert.deepEqual(rules.unionDids(null, ctx), []);
  assert.deepEqual(rules.unionDids({}, ctx), []);
});

test('unionDids: ignores non-string and empty entries', () => {
  assert.deepEqual(rules.unionDids({ people: [7, null, '', 'did:a'] }, ctx), ['did:a']);
});

test('unionDids: does not mutate the context or the audience', () => {
  const c = JSON.parse(JSON.stringify(ctx));
  const a = { tiers: ['orbit', 'list:club'], people: ['did:a'] };
  const copy = JSON.parse(JSON.stringify(a));
  rules.unionDids(a, c);
  assert.deepEqual(c, ctx);
  assert.deepEqual(a, copy);
});

const sealed = (did) => ({ did, sealedDek: 'sealed-for-' + did });

test('planRecipients: nothing to do when the sets already match', () => {
  const plan = rules.planRecipients([sealed('did:a'), sealed('did:b')], ['did:a', 'did:b']);
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.add, []);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.keep.map((e) => e.did), ['did:a', 'did:b']);
});

test('planRecipients: a new friend is added and an existing entry is kept as it is', () => {
  const plan = rules.planRecipients([sealed('did:a')], ['did:a', 'did:b']);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.add, ['did:b']);
  assert.deepEqual(plan.keep, [sealed('did:a')]);
  assert.deepEqual(plan.remove, []);
});

test('planRecipients: someone no longer in the audience is withdrawn', () => {
  const plan = rules.planRecipients([sealed('did:a'), sealed('did:b')], ['did:a']);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.remove, ['did:b']);
  assert.deepEqual(plan.keep.map((e) => e.did), ['did:a']);
});

test('planRecipients: an entry with no sealed key is sealed again', () => {
  const plan = rules.planRecipients([{ did: 'did:a' }, sealed('did:b')], ['did:a', 'did:b']);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.add, ['did:a']);
  assert.deepEqual(plan.keep.map((e) => e.did), ['did:b']);
});

test('planRecipients: an unsealed entry for someone who should not be there is withdrawn', () => {
  const plan = rules.planRecipients([{ did: 'did:z' }], []);
  assert.deepEqual(plan.remove, ['did:z']);
  assert.equal(plan.changed, true);
});

test('planRecipients: a card with no recipients and an empty audience is unchanged', () => {
  assert.equal(rules.planRecipients([], []).changed, false);
  assert.equal(rules.planRecipients(undefined, []).changed, false);
});

test('planRecipients: duplicate current entries are reported once', () => {
  const plan = rules.planRecipients([sealed('did:a'), sealed('did:a'), sealed('did:z')], ['did:a']);
  assert.deepEqual(plan.remove, ['did:z']);
  assert.deepEqual(plan.keep.map((e) => e.did), ['did:a']);
});

test('planRecipients: the order of the new recipients follows the audience', () => {
  const plan = rules.planRecipients([sealed('did:b'), sealed('did:a')], ['did:a', 'did:b', 'did:c']);
  assert.deepEqual(plan.keep.map((e) => e.did), ['did:a', 'did:b']);
  assert.deepEqual(plan.add, ['did:c']);
});

test('visibilityFor: shared when anyone else can open it, otherwise private', () => {
  assert.equal(rules.visibilityFor(0), 'private');
  assert.equal(rules.visibilityFor(1), 'shared');
  assert.equal(rules.visibilityFor(40), 'shared');
});

test('mirrorFor: keeps only the coarse tiers, never a list id or a person', () => {
  assert.deepEqual(rules.mirrorFor({ tiers: ['friends', 'orbit'], people: [] }), { tiers: ['friends', 'orbit'] });
  assert.deepEqual(rules.mirrorFor({ tiers: ['friends', 'list:club'] }), { tiers: ['friends'], custom: true });
  assert.deepEqual(rules.mirrorFor({ tiers: [], people: ['did:a'] }), { tiers: [], custom: true });
  assert.deepEqual(rules.mirrorFor({ tiers: ['list:club'] }), { tiers: [], custom: true });
  assert.deepEqual(rules.mirrorFor(null), { tiers: [] });
});

test('mirrorFor: the serialized mirror contains no list id and no DID', () => {
  const s = JSON.stringify(rules.mirrorFor({ tiers: ['orbit', 'list:club'], people: ['did:secret'] }));
  assert.ok(s.indexOf('club') === -1);
  assert.ok(s.indexOf('did:') === -1);
});

test('sameMirror: compares by value', () => {
  assert.equal(rules.sameMirror({ tiers: ['orbit'] }, { tiers: ['orbit'] }), true);
  assert.equal(rules.sameMirror({ tiers: ['orbit'] }, { tiers: ['friends'] }), false);
  assert.equal(rules.sameMirror(undefined, null), true);
  assert.equal(rules.sameMirror(undefined, { tiers: [] }), false);
});

// ─── the dialog's state and the chip labels ────────────────────────────────────

const dctx = Object.assign({}, ctx, {
  lists: [{ id: 'club', name: 'Book club', memberDids: ['did:c', 'did:d'] }, { id: 'empty', name: 'Nobody', memberDids: [] }]
});

test('stateFromAudience / audienceFromState round trip, with tiers in a fixed order', () => {
  const s = rules.stateFromAudience({ tiers: ['list:club', 'orbit', 'friends'], people: ['did:a'] }, false);
  assert.deepEqual(s, { pub: false, friends: true, orbit: true, lists: { club: true }, people: ['did:a'] });
  assert.deepEqual(rules.audienceFromState(s, dctx), { tiers: ['friends', 'orbit', 'list:club'], people: ['did:a'] });
});

test('stateFromAudience: a public card starts with only Public ticked', () => {
  assert.deepEqual(rules.stateFromAudience({ tiers: ['friends'] }, true),
    { pub: true, friends: false, orbit: false, lists: {}, people: [] });
});

test('toggle: ticking Public clears every other choice, and ticking anything else clears Public', () => {
  let s = rules.stateFromAudience({ tiers: ['friends', 'list:club'], people: ['did:a'] }, false);
  s = rules.toggle(s, 'pub');
  assert.deepEqual(s, { pub: true, friends: false, orbit: false, lists: {}, people: [] });
  s = rules.toggle(s, 'orbit');
  assert.deepEqual(s, { pub: false, friends: false, orbit: true, lists: {}, people: [] });
  s = rules.toggle(s, 'pub');
  s = rules.toggle(s, 'list:club');
  assert.equal(s.pub, false);
  assert.deepEqual(s.lists, { club: true });
  s = rules.toggle(rules.toggle(rules.emptyState(), 'pub'), 'pub');                  // un-ticking Public leaves nothing ticked
  assert.deepEqual(s, rules.emptyState());
});

test('toggle: a second click un-ticks, and an unknown key changes nothing', () => {
  let s = rules.toggle(rules.emptyState(), 'friends');
  assert.equal(s.friends, true);
  s = rules.toggle(s, 'friends');
  assert.equal(s.friends, false);
  assert.deepEqual(rules.toggle(rules.emptyState(), 'bogus'), rules.emptyState());
});

test('togglePerson: adds and removes a named person, and ticking one clears Public', () => {
  let s = rules.toggle(rules.emptyState(), 'pub');
  s = rules.togglePerson(s, 'did:a');
  assert.deepEqual(s.people, ['did:a']);
  assert.equal(s.pub, false);
  s = rules.togglePerson(s, 'did:b');
  s = rules.togglePerson(s, 'did:a');
  assert.deepEqual(s.people, ['did:b']);
});

test('toggle functions do not mutate the state they are given', () => {
  const s = rules.stateFromAudience({ tiers: ['friends', 'list:club'], people: ['did:a'] }, false);
  const copy = JSON.parse(JSON.stringify(s));
  rules.toggle(s, 'orbit'); rules.toggle(s, 'list:club'); rules.toggle(s, 'pub'); rules.togglePerson(s, 'did:b');
  assert.deepEqual(s, copy);
});

test('sealedCount: the de-duplicated union, and nobody for Public', () => {
  const s = rules.stateFromAudience({ tiers: ['friends', 'orbit', 'list:club'], people: ['did:a'] }, false);
  assert.equal(rules.sealedCount(s, dctx), 4);
  assert.equal(rules.sealedCount(rules.stateFromAudience({ tiers: ['orbit'] }, false), dctx), 2);
  assert.equal(rules.sealedCount(rules.stateFromAudience(null, true), dctx), 0);
});

test('footerText: names what is shared when the caller says so', () => {
  assert.equal(rules.footerText(rules.stateFromAudience(null, true), dctx, 'game'), 'Anyone can read this game. It is not encrypted.');
  assert.equal(rules.footerText(rules.emptyState(), dctx, 'game'), 'Only you can open this game.');
  assert.equal(rules.footerText(rules.stateFromAudience({ tiers: ['friends'] }, false), dctx, 'game'), 'Sealed to 4 people. Only they can open it.');
});

test('footerText: says what is true of each state', () => {
  assert.equal(rules.footerText(rules.stateFromAudience(null, true), dctx), 'Anyone can read this card. It is not encrypted.');
  assert.equal(rules.footerText(rules.emptyState(), dctx), 'Only you can open this card.');
  assert.equal(rules.footerText(rules.stateFromAudience({ tiers: ['list:empty'] }, false), dctx), 'Only you can open this card.');
  assert.equal(rules.footerText(rules.stateFromAudience({ people: ['did:a'] }, false), dctx), 'Sealed to 1 person. Only they can open it.');
  assert.equal(rules.footerText(rules.stateFromAudience({ tiers: ['friends'] }, false), dctx), 'Sealed to 4 people. Only they can open it.');
});

test('ownerChipLabel: names the ticked sets with the de-duplicated count', () => {
  assert.equal(rules.ownerChipLabel({ tiers: ['friends'] }, dctx, false), 'Friends · 4');
  assert.equal(rules.ownerChipLabel({ tiers: ['orbit', 'list:club'] }, dctx, false), 'Orbit + Book club · 4');
  assert.equal(rules.ownerChipLabel({ tiers: ['friends', 'orbit', 'list:club'] }, dctx, false), '3 audiences · 4');
  assert.equal(rules.ownerChipLabel({ tiers: [], people: ['did:a'] }, dctx, false), 'Specific people · 1');
  assert.equal(rules.ownerChipLabel({ tiers: [], people: [] }, dctx, false), 'Only me');
  assert.equal(rules.ownerChipLabel(null, dctx, false), 'Only me');
  assert.equal(rules.ownerChipLabel({ tiers: ['friends'] }, dctx, true), 'Public');
});

test('viewerChipLabel: only Friends / Orbit by name, never a list or a person', () => {
  assert.equal(rules.viewerChipLabel('public', null), 'Public');
  assert.equal(rules.viewerChipLabel('shared', { tiers: ['friends'] }), 'Friends');
  assert.equal(rules.viewerChipLabel('shared', { tiers: ['orbit'], custom: true }), 'Orbit');
  assert.equal(rules.viewerChipLabel('shared', { tiers: ['friends', 'orbit'] }), 'Friends + Orbit');
  assert.equal(rules.viewerChipLabel('shared', { tiers: [], custom: true }), 'Just a few people');
  assert.equal(rules.viewerChipLabel('shared', undefined), 'Just a few people');
  assert.equal(rules.viewerChipLabel('private', { tiers: [] }), null);
});

test('sinceCidFor: a person new to the card starts at the new version', () => {
  assert.equal(rules.sinceCidFor([], 'did:a', 'V2'), 'V2');
  assert.equal(rules.sinceCidFor(undefined, 'did:a', 'V2'), 'V2');
  assert.equal(rules.sinceCidFor([{ did: 'did:b', sealedDek: 's', sinceCid: 'V1' }], 'did:a', 'V2'), 'V2');
});

test('sinceCidFor: a person already on the card keeps the baseline they had', () => {
  const prev = [{ did: 'did:a', sealedDek: 's', sinceCid: 'V1' }];
  assert.equal(rules.sinceCidFor(prev, 'did:a', 'V5'), 'V1');
});

test('sinceCidFor: an older entry with no baseline stays without one', () => {
  const prev = [{ did: 'did:a', sealedDek: 's' }];
  assert.equal(rules.sinceCidFor(prev, 'did:a', 'V5'), undefined);
});

test('isOnlyMe: true when nothing is ticked and the card is not public', () => {
  assert.equal(rules.isOnlyMe(rules.emptyState()), true);
  assert.equal(rules.isOnlyMe(rules.toggle(rules.emptyState(), 'friends')), false);
  assert.equal(rules.isOnlyMe(rules.toggle(rules.emptyState(), 'pub')), false);
  assert.equal(rules.isOnlyMe(rules.togglePerson(rules.emptyState(), 'did:a')), false);
  assert.equal(rules.isOnlyMe(rules.toggle(rules.emptyState(), 'list:club')), false);
});

test('toggle me: clears every other choice, including Public and people', () => {
  let s = rules.toggle(rules.emptyState(), 'friends');
  s = rules.toggle(s, 'orbit');
  s = rules.toggle(s, 'list:club');
  s = rules.togglePerson(s, 'did:a');
  const me = rules.toggle(s, 'me');
  assert.equal(rules.isOnlyMe(me), true);
  assert.deepEqual(rules.audienceFromState(me, ctx), { tiers: [], people: [] });
  assert.equal(rules.toggle(rules.toggle(rules.emptyState(), 'pub'), 'me').pub, false);
});

test('toggle me: choosing it again leaves it chosen, and ticking anything else leaves it', () => {
  const me = rules.toggle(rules.emptyState(), 'me');
  assert.equal(rules.isOnlyMe(rules.toggle(me, 'me')), true);
  assert.equal(rules.isOnlyMe(rules.toggle(me, 'friends')), false);
});

test('newListId: letters and digits only, and never an id already in use', () => {
  const id = rules.newListId([{ id: 'taken' }]);
  assert.match(id, /^[A-Za-z0-9]{1,64}$/);
  // A random source that first collides with an existing id must be skipped.
  const seq = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  let i = 0;
  const taken = [{ id: 'l' + '0'.repeat(9) }];
  assert.equal(rules.newListId(taken, () => seq[i++]), 'l' + 'i'.repeat(9));
});

test('listNameError: empty, too long and duplicate names are refused', () => {
  const lists = [{ id: 'a', name: 'Book club' }, { id: 'b', name: 'Family' }];
  assert.equal(rules.listNameError('', lists), 'Give the list a name');
  assert.equal(rules.listNameError('   ', lists), 'Give the list a name');
  assert.match(rules.listNameError('x'.repeat(61), lists), /at most 60/);
  assert.match(rules.listNameError('  book   CLUB ', lists), /already have a list/);
  assert.equal(rules.listNameError('Work', lists), null);
});

test('listNameError: a list may keep its own name when it is renamed', () => {
  const lists = [{ id: 'a', name: 'Book club' }, { id: 'b', name: 'Family' }];
  assert.equal(rules.listNameError('Book club', lists, 'a'), null);
  assert.match(rules.listNameError('Family', lists, 'a'), /already have a list/);
});

test('toggleDid adds and removes without touching the original', () => {
  const a = ['did:a'];
  assert.deepEqual(rules.toggleDid(a, 'did:b'), ['did:a', 'did:b']);
  assert.deepEqual(rules.toggleDid(a, 'did:a'), []);
  assert.deepEqual(a, ['did:a']);
});
