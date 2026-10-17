// Audience list rules (core/servers/identity/AudienceLists.js): pure, no database.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../core/servers/identity/AudienceLists.js');

const friends = ['did:a', 'did:b', 'did:c', 'did:d'];

test('normalizeLists: missing becomes an empty array', () => {
  assert.deepEqual(rules.normalizeLists(undefined, friends).lists, []);
  assert.deepEqual(rules.normalizeLists(null, friends).lists, []);
});

test('normalizeLists: trims the name and drops non-friends instead of rejecting', () => {
  const r = rules.normalizeLists([{ id: 'l1', name: '  Book club ', memberDids: ['did:a', 'did:stranger', 'did:b'] }], friends);
  assert.deepEqual(r.lists, [{ id: 'l1', name: 'Book club', memberDids: ['did:a', 'did:b'] }]);
});

test('normalizeLists: duplicates and non-strings in members are ignored', () => {
  const r = rules.normalizeLists([{ id: 'l1', name: 'x', memberDids: ['did:a', 'did:a', 7, null, '', 'did:b'] }], friends);
  assert.deepEqual(r.lists[0].memberDids, ['did:a', 'did:b']);
});

test('normalizeLists: a list may have no members', () => {
  assert.deepEqual(rules.normalizeLists([{ id: 'l1', name: 'x' }], friends).lists[0].memberDids, []);
});

test('normalizeLists: bad shapes are errors', () => {
  assert.ok(rules.normalizeLists('x', friends).error);
  assert.ok(rules.normalizeLists({}, friends).error);
  assert.ok(rules.normalizeLists([null], friends).error);
  assert.ok(rules.normalizeLists([{ name: 'x' }], friends).error, 'missing id');
  assert.ok(rules.normalizeLists([{ id: 'bad id!', name: 'x' }], friends).error, 'id with a space');
  assert.ok(rules.normalizeLists([{ id: 'l1', name: '   ' }], friends).error, 'blank name');
  assert.ok(rules.normalizeLists([{ id: 'l1' }], friends).error, 'no name');
  assert.ok(rules.normalizeLists([{ id: 'l1', name: 'x', memberDids: 'did:a' }], friends).error);
  assert.ok(rules.normalizeLists([{ id: 'l1', name: 'x' }, { id: 'l1', name: 'y' }], friends).error, 'duplicate id');
});

test('normalizeLists: caps the name, the count and the members', () => {
  assert.ok(rules.normalizeLists([{ id: 'l1', name: 'x'.repeat(rules.MAX_NAME_LENGTH + 1) }], friends).error);
  const many = [];
  for (let i = 0; i <= rules.MAX_LISTS; i++) many.push({ id: 'l' + i, name: 'n' + i });
  assert.ok(rules.normalizeLists(many, friends).error);
  const crowd = [];
  for (let i = 0; i <= rules.MAX_LIST_MEMBERS; i++) crowd.push('did:f' + i);
  assert.ok(rules.normalizeLists([{ id: 'l1', name: 'x', memberDids: crowd }], crowd).error);
});

test('normalizeLists: an ended friendship removes the member', () => {
  const stored = [{ id: 'l1', name: 'x', memberDids: ['did:a', 'did:b'] }];
  assert.deepEqual(rules.normalizeLists(stored, ['did:a']).lists[0].memberDids, ['did:a']);
});

test('normalizeLists: does not mutate its input', () => {
  const raw = [{ id: 'l1', name: ' x ', memberDids: ['did:a', 'did:zzz'] }];
  const copy = JSON.parse(JSON.stringify(raw));
  rules.normalizeLists(raw, friends);
  assert.deepEqual(raw, copy);
});

const lists = [{ id: 'l1', name: 'Book club', memberDids: [] }];

test('normalizeCardAudiences: keeps built-in tiers, existing list tiers and friend people', () => {
  const r = rules.normalizeCardAudiences({
    card1: { tiers: ['friends', 'orbit', 'list:l1'], people: ['did:a', 'did:stranger'] }
  }, lists, friends);
  assert.deepEqual(r.cardAudiences, { card1: { tiers: ['friends', 'orbit', 'list:l1'], people: ['did:a'] } });
});

test('normalizeCardAudiences: drops a tier whose list is gone, and unknown tiers', () => {
  const r = rules.normalizeCardAudiences({ card1: { tiers: ['list:gone', 'public', 'friends', 'friends', 7] } }, lists, friends);
  assert.deepEqual(r.cardAudiences.card1.tiers, ['friends']);
});

test('normalizeCardAudiences: an entry with nothing in it is kept (only me)', () => {
  const r = rules.normalizeCardAudiences({ card1: {} }, lists, friends);
  assert.deepEqual(r.cardAudiences, { card1: { tiers: [], people: [] } });
});

test('normalizeCardAudiences: missing becomes an empty object', () => {
  assert.deepEqual(rules.normalizeCardAudiences(undefined, lists, friends).cardAudiences, {});
});

test('normalizeCardAudiences: bad shapes are errors', () => {
  assert.ok(rules.normalizeCardAudiences([], lists, friends).error);
  assert.ok(rules.normalizeCardAudiences('x', lists, friends).error);
  assert.ok(rules.normalizeCardAudiences({ card1: null }, lists, friends).error);
  assert.ok(rules.normalizeCardAudiences({ card1: [] }, lists, friends).error);
  assert.ok(rules.normalizeCardAudiences({ card1: { tiers: 'friends' } }, lists, friends).error);
  assert.ok(rules.normalizeCardAudiences({ card1: { people: {} } }, lists, friends).error);
  assert.ok(rules.normalizeCardAudiences({ 'bad key!': {} }, lists, friends).error);
});

test('normalizeCardAudiences: caps people per card', () => {
  const crowd = [];
  for (let i = 0; i <= rules.MAX_PEOPLE_PER_CARD; i++) crowd.push('did:f' + i);
  assert.ok(rules.normalizeCardAudiences({ card1: { people: crowd } }, lists, crowd).error);
});

test('normalizeState: leaves fields the state does not carry absent', () => {
  assert.deepEqual(rules.normalizeState({ blockedDids: [] }, friends), {});
  assert.deepEqual(Object.keys(rules.normalizeState({ audienceLists: [] }, friends)), ['audienceLists']);
});

test('normalizeState: card list tiers are checked against the lists in the same state', () => {
  const r = rules.normalizeState({
    audienceLists: [{ id: 'l1', name: 'x', memberDids: ['did:a'] }],
    cardAudiences: { card1: { tiers: ['list:l1', 'list:l2'] } }
  }, friends);
  assert.deepEqual(r.cardAudiences.card1.tiers, ['list:l1']);
});

test('normalizeState: card audiences with no lists in the state have no list tiers', () => {
  const r = rules.normalizeState({ cardAudiences: { card1: { tiers: ['list:l1', 'orbit'] } } }, friends);
  assert.deepEqual(r.cardAudiences.card1.tiers, ['orbit']);
});

test('normalizeState: an error in either field is returned', () => {
  assert.ok(rules.normalizeState({ audienceLists: 'x' }, friends).error);
  assert.ok(rules.normalizeState({ cardAudiences: 'x' }, friends).error);
});
