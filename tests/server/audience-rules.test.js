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
