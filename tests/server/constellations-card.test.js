// The owner's choices about the homestar Constellations card
// (core/servers/identity/ConstellationsCard.js): pure, no database.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cc = require('../../core/servers/identity/ConstellationsCard.js');

test('visibility: never chosen is anyone; the four values pass; anything else is an error naming the key', () => {
  assert.deepEqual(cc.normalizeVisibility(undefined), { value: 'anyone' });
  assert.deepEqual(cc.normalizeVisibility(null), { value: 'anyone' });
  for (const v of ['anyone', 'friends', 'orbit', 'private']) assert.deepEqual(cc.normalizeVisibility(v), { value: v });
  for (const bad of ['public', '', 7, {}, []]) {
    const r = cc.normalizeVisibility(bad);
    assert.match(r.error, /^constellationsVisibility must be one of/, String(bad));
  }
});

test('hidden: absent is empty; names are kept in order and de-duplicated', () => {
  assert.deepEqual(cc.normalizeHidden(undefined), { hidden: [] });
  assert.deepEqual(cc.normalizeHidden(null), { hidden: [] });
  assert.deepEqual(cc.normalizeHidden(['b', 'a', 'b', 'c-1']), { hidden: ['b', 'a', 'c-1'] });
});

test('hidden: a non-array, a non-name, or too many is an error', () => {
  for (const bad of ['a', 5, {}, [1], [''], ['Has Space'], ['UPPER'], ['-lead'], [{}], ['a'.repeat(64)]]) {
    assert.ok(cc.normalizeHidden(bad).error, JSON.stringify(bad));
  }
  const many = Array.from({ length: cc.MAX_HIDDEN + 1 }, (_, i) => 'c' + i);
  assert.ok(cc.normalizeHidden(many).error);
  assert.equal(cc.normalizeHidden(many.slice(0, cc.MAX_HIDDEN)).hidden.length, cc.MAX_HIDDEN);
});

test('applyHidden: drops the hidden names, keeps the order, counts what it dropped', () => {
  const rows = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  assert.deepEqual(cc.applyHidden(rows, ['b']), { rows: [{ name: 'a' }, { name: 'c' }], hiddenCount: 1 });
  assert.deepEqual(cc.applyHidden(rows, ['zzz']), { rows, hiddenCount: 0 });
  assert.deepEqual(cc.applyHidden(rows, undefined), { rows, hiddenCount: 0 });
  assert.deepEqual(cc.applyHidden(rows, ['a', 'b', 'c']), { rows: [], hiddenCount: 3 });
});

test('canView follows the same rule as the map', () => {
  assert.equal(cc.canView('private', 'did:o', 'did:o', false, false), true);
  assert.equal(cc.canView('private', 'did:o', 'did:x', true, true), false);
  assert.equal(cc.canView('friends', 'did:o', 'did:x', true, false), true);
  assert.equal(cc.canView('friends', 'did:o', null, false, false), false);
  assert.equal(cc.canView('orbit', 'did:o', 'did:x', true, false), false);
  assert.equal(cc.canView('orbit', 'did:o', 'did:x', true, true), true);
  assert.equal(cc.canView('anyone', 'did:o', null, false, false), true);
});
