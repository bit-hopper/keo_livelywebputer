// Orbit rules (core/servers/identity/Orbit.js): pure, no database.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const orbit = require('../../core/servers/identity/Orbit.js');

const friends = ['did:a', 'did:b', 'did:c', 'did:d', 'did:e'];

test('normalize: a missing orbit becomes an empty Friends-only one', () => {
  assert.deepEqual(orbit.normalize(undefined, friends).orbit, { visibility: 'friends', members: [], pinned: [] });
  assert.deepEqual(orbit.normalize(null, friends).orbit, { visibility: 'friends', members: [], pinned: [] });
});

test('normalize: members who are not friends are dropped, not rejected', () => {
  const r = orbit.normalize({ visibility: 'friends', members: ['did:a', 'did:stranger', 'did:b'], pinned: [] }, friends);
  assert.deepEqual(r.orbit.members, ['did:a', 'did:b']);
  assert.equal(r.error, undefined);
});

test('normalize: pinned must be a subset of members and is capped at three', () => {
  const r = orbit.normalize({
    visibility: 'anyone',
    members: ['did:a', 'did:b', 'did:c', 'did:d'],
    pinned: ['did:e', 'did:d', 'did:c', 'did:b', 'did:a']
  }, friends);
  assert.deepEqual(r.orbit.pinned, ['did:d', 'did:c', 'did:b']);
});

test('normalize: duplicates and non-strings are ignored', () => {
  const r = orbit.normalize({ members: ['did:a', 'did:a', 7, null, '', 'did:b'], pinned: ['did:a', 'did:a'] }, friends);
  assert.deepEqual(r.orbit.members, ['did:a', 'did:b']);
  assert.deepEqual(r.orbit.pinned, ['did:a']);
});

test('normalize: an ended friendship removes the member and its pin', () => {
  const stored = { visibility: 'friends', members: ['did:a', 'did:b'], pinned: ['did:b'] };
  const r = orbit.normalize(stored, ['did:a']);
  assert.deepEqual(r.orbit.members, ['did:a']);
  assert.deepEqual(r.orbit.pinned, []);
});

test('normalize: bad shapes are errors', () => {
  assert.ok(orbit.normalize('x', friends).error);
  assert.ok(orbit.normalize([], friends).error);
  assert.ok(orbit.normalize({ visibility: 'everyone' }, friends).error);
  assert.ok(orbit.normalize({ members: 'did:a' }, friends).error);
  assert.ok(orbit.normalize({ pinned: {} }, friends).error);
});

test('normalize: defaults visibility to friends when omitted', () => {
  assert.equal(orbit.normalize({ members: [] }, friends).orbit.visibility, 'friends');
});

test('normalize: does not mutate its input', () => {
  const raw = { visibility: 'anyone', members: ['did:a', 'did:zzz'], pinned: ['did:a'] };
  const copy = JSON.parse(JSON.stringify(raw));
  orbit.normalize(raw, friends);
  assert.deepEqual(raw, copy);
});

test('canView: the owner always sees it', () => {
  for (const v of ['anyone', 'friends', 'private']) {
    assert.equal(orbit.canView({ visibility: v }, 'did:o', 'did:o', false), true);
  }
});

test('canView: anyone includes signed-out viewers', () => {
  assert.equal(orbit.canView({ visibility: 'anyone' }, 'did:o', null, false), true);
});

test('canView: friends needs a signed-in friend', () => {
  assert.equal(orbit.canView({ visibility: 'friends' }, 'did:o', null, false), false);
  assert.equal(orbit.canView({ visibility: 'friends' }, 'did:o', 'did:v', false), false);
  assert.equal(orbit.canView({ visibility: 'friends' }, 'did:o', 'did:v', true), true);
});

test('canView: private hides it from everyone but the owner', () => {
  assert.equal(orbit.canView({ visibility: 'private' }, 'did:o', 'did:v', true), false);
  assert.equal(orbit.canView({ visibility: 'private' }, 'did:o', null, false), false);
});

test('canView: a missing orbit is treated as friends-only', () => {
  assert.equal(orbit.canView(null, 'did:o', 'did:v', true), true);
  assert.equal(orbit.canView(null, 'did:o', 'did:v', false), false);
});
