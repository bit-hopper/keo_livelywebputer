// The owner's choices about the homestar Wiki pages card
// (core/servers/identity/WikiCard.js): pure, no database.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const wc = require('../../core/servers/identity/WikiCard.js');

test('visibility: never chosen is anyone; the four values pass; anything else is an error naming the key', () => {
  assert.deepEqual(wc.normalizeVisibility(undefined), { value: 'anyone' });
  assert.deepEqual(wc.normalizeVisibility(null), { value: 'anyone' });
  for (const v of ['anyone', 'friends', 'orbit', 'private']) assert.deepEqual(wc.normalizeVisibility(v), { value: v });
  for (const bad of ['public', '', 7, {}, []]) {
    assert.match(wc.normalizeVisibility(bad).error, /^wikiCardVisibility must be one of/, String(bad));
  }
});

test('hidden: absent is empty; ids are kept in order and de-duplicated', () => {
  assert.deepEqual(wc.normalizeHidden(undefined), { hidden: [] });
  assert.deepEqual(wc.normalizeHidden(null), { hidden: [] });
  assert.deepEqual(wc.normalizeHidden(['bbbbbb', 'aaaaaa', 'bbbbbb', 'c_-123']), { hidden: ['bbbbbb', 'aaaaaa', 'c_-123'] });
});

test('hidden: a non-array, a non-id, or too many is an error', () => {
  for (const bad of ['a', 5, {}, [1], [''], ['short'], ['has space'], ['../etc/x'], [{}], ['a'.repeat(65)]]) {
    assert.ok(wc.normalizeHidden(bad).error, JSON.stringify(bad));
  }
  const many = Array.from({ length: wc.MAX_HIDDEN + 1 }, (_, i) => 'page' + String(i).padStart(4, '0'));
  assert.ok(wc.normalizeHidden(many).error);
  assert.equal(wc.normalizeHidden(many.slice(0, wc.MAX_HIDDEN)).hidden.length, wc.MAX_HIDDEN);
});

test('applyHidden: drops the hidden ids, keeps the order, counts what it dropped', () => {
  const rows = [{ objId: 'a' }, { objId: 'b' }, { objId: 'c' }];
  assert.deepEqual(wc.applyHidden(rows, ['b']), { rows: [{ objId: 'a' }, { objId: 'c' }], hiddenCount: 1 });
  assert.deepEqual(wc.applyHidden(rows, ['zzz']), { rows, hiddenCount: 0 });
  assert.deepEqual(wc.applyHidden(rows, undefined), { rows, hiddenCount: 0 });
  assert.deepEqual(wc.applyHidden(rows, ['a', 'b', 'c']), { rows: [], hiddenCount: 3 });
});

test('canView follows the same rule as the map', () => {
  assert.equal(wc.canView('private', 'did:o', 'did:o', false, false), true);
  assert.equal(wc.canView('private', 'did:o', 'did:x', true, true), false);
  assert.equal(wc.canView('friends', 'did:o', 'did:x', true, false), true);
  assert.equal(wc.canView('friends', 'did:o', null, false, false), false);
  assert.equal(wc.canView('orbit', 'did:o', 'did:x', true, false), false);
  assert.equal(wc.canView('orbit', 'did:o', 'did:x', true, true), true);
  assert.equal(wc.canView('anyone', 'did:o', null, false, false), true);
});
