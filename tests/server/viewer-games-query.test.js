// The SQL builder behind GET /@:handle/games (ObjectRepository._buildViewerGamesQuery):
// checks the visibility rule, paging and parameter wiring without a database.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../../core/servers/identity/ObjectRepository.js');

const OWNER = 'did:owner';
const build = (viewer, opts, pivot) => repo._buildViewerGamesQuery(OWNER, viewer, opts || {}, pivot || null);
const RECIPIENTS = "(o.envelope #> '{record,recipients}') @>";

test('only the owner\'s gamelog envelopes are selected, latest version of each', () => {
  const { sql, params } = build(OWNER);
  assert.match(sql, /type = 'gamelog'/);
  assert.match(sql, /MAX\(id\) AS max_id/);
  assert.equal(params[0], OWNER);
});

test('the owner sees every live entry: no visibility clause', () => {
  const { sql, params } = build(OWNER);
  assert.ok(!sql.includes("'visibility'"));
  assert.ok(!sql.includes(RECIPIENTS));
  assert.deepEqual(params, [OWNER, 101]);
});

test('a signed-out viewer sees public entries only', () => {
  const { sql, params } = build(null);
  assert.match(sql, /COALESCE\(o\.envelope ->> 'visibility', 'public'\) = 'public'/);
  assert.ok(!sql.includes(RECIPIENTS));
  assert.deepEqual(params, [OWNER, 101]);
});

test('another viewer sees public entries or ones sealed to them', () => {
  const { sql, params } = build('did:friend');
  assert.ok(sql.includes(RECIPIENTS + ' $2::jsonb'));
  assert.equal(params[1], JSON.stringify([{ did: 'did:friend' }]));
});

test('deleted entries are never listed, for anyone', () => {
  for (const viewer of [OWNER, 'did:friend', null]) {
    assert.match(build(viewer).sql, /\{state,deleted\}'\) <> 'true'/);
  }
});

test('the page size is clamped and one extra row is fetched to detect a next page', () => {
  assert.equal(build(OWNER, { limit: 10 }).limit, 10);
  assert.equal(build(OWNER, { limit: 10 }).params.pop(), 11);
  assert.equal(build(OWNER, { limit: 99999 }).limit, 200);
  assert.equal(build(OWNER, { limit: 0 }).limit, 100);
  assert.equal(build(OWNER, { limit: 'abc' }).limit, 100);
  assert.equal(build(OWNER, { limit: -5 }).limit, 1);
});

test('a cursor adds a strict "older than" bound and keeps newest-first order', () => {
  const { sql, params } = build(OWNER, {}, 4242);
  assert.match(sql, /AND o\.id < \$2 ORDER BY o\.id DESC LIMIT \$3/);
  assert.deepEqual(params, [OWNER, 4242, 101]);
});

test('viewer and cursor are only ever bound parameters, never spliced into the SQL', () => {
  const evil = "did:x'); DROP TABLE objects; --";
  const { sql, params } = build(evil, {}, "1; DROP TABLE objects");
  assert.ok(!sql.includes('DROP TABLE'));
  assert.ok(params.includes(JSON.stringify([{ did: evil }])));   // bound inside the recipients test
  assert.ok(params.includes("1; DROP TABLE objects"));
});
