// Map visibility rules (core/servers/identity/MapVisibility.js): pure, no database.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mv = require('../../core/servers/identity/MapVisibility.js');

test('normalize: never chosen is the default (anyone)', () => {
  assert.deepEqual(mv.normalize(undefined), { value: 'anyone' });
  assert.deepEqual(mv.normalize(null), { value: 'anyone' });
});

test('normalize: the four values pass, anything else is an error', () => {
  for (const v of ['anyone', 'friends', 'orbit', 'private']) assert.deepEqual(mv.normalize(v), { value: v });
  for (const bad of ['public', '', 'Friends', 7, {}, []]) assert.ok(mv.normalize(bad).error, String(bad));
});

test('canView: the owner always sees their own map', () => {
  for (const v of mv.VALUES) assert.equal(mv.canView(v, 'did:o', 'did:o', false, false), true, v);
});

test('canView: anyone includes a signed-out viewer', () => {
  assert.equal(mv.canView('anyone', 'did:o', null, false, false), true);
});

test('canView: friends needs a signed-in friend', () => {
  assert.equal(mv.canView('friends', 'did:o', null, false, false), false);
  assert.equal(mv.canView('friends', 'did:o', 'did:x', false, false), false);
  assert.equal(mv.canView('friends', 'did:o', 'did:x', true, false), true);
});

test('canView: orbit needs a friend who is in the orbit', () => {
  assert.equal(mv.canView('orbit', 'did:o', 'did:x', true, false), false);
  assert.equal(mv.canView('orbit', 'did:o', 'did:x', false, true), false);
  assert.equal(mv.canView('orbit', 'did:o', 'did:x', true, true), true);
  assert.equal(mv.canView('orbit', 'did:o', null, true, true), false);
});

test('canView: only me shuts everyone else out', () => {
  assert.equal(mv.canView('private', 'did:o', 'did:x', true, true), false);
  assert.equal(mv.canView('private', 'did:o', null, false, false), false);
});

test('canView: an unknown stored value is treated as the default (anyone)', () => {
  // The settings PUT rejects unknown values, so this only guards a hand-edited row.
  assert.equal(mv.canView('bogus', 'did:o', 'did:x', false, false), true);
});
