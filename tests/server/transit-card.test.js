// The owner's choices about the homestar Transit card
// (core/servers/identity/TransitCard.js): pure, no database.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tc = require('../../core/servers/identity/TransitCard.js');

test('visibility: never chosen is anyone; the four values pass; anything else is an error naming the key', () => {
  assert.deepEqual(tc.normalizeVisibility(undefined), { value: 'anyone' });
  assert.deepEqual(tc.normalizeVisibility(null), { value: 'anyone' });
  for (const v of ['anyone', 'friends', 'orbit', 'private']) assert.deepEqual(tc.normalizeVisibility(v), { value: v });
  for (const bad of ['public', '', 7, {}, []]) {
    assert.match(tc.normalizeVisibility(bad).error, /^transitVisibility must be one of/, String(bad));
  }
});

test('station: absent, null or empty means no card; a station code passes', () => {
  for (const none of [undefined, null, '']) assert.deepEqual(tc.normalizeStation(none), { value: null });
  for (const code of ['EMBR', '12TH', 'MONT', 'SFO']) assert.deepEqual(tc.normalizeStation(code), { value: code });
});

test('station: anything that is not a station code is an error', () => {
  for (const bad of ['embr', 'E', 'TOOLONG1', 'EM BR', 'EM-BR', '../x', '<b>', 7, {}, [], ['EMBR'], true]) {
    assert.match(tc.normalizeStation(bad).error, /^transitStation must be a BART station code/, JSON.stringify(bad));
  }
});

test('canView follows the same rule as the map', () => {
  assert.equal(tc.canView('private', 'did:o', 'did:o', false, false), true);
  assert.equal(tc.canView('private', 'did:o', 'did:x', true, true), false);
  assert.equal(tc.canView('friends', 'did:o', 'did:x', true, false), true);
  assert.equal(tc.canView('friends', 'did:o', null, false, false), false);
  assert.equal(tc.canView('orbit', 'did:o', 'did:x', true, false), false);
  assert.equal(tc.canView('orbit', 'did:o', 'did:x', true, true), true);
  assert.equal(tc.canView('anyone', 'did:o', null, false, false), true);
});
