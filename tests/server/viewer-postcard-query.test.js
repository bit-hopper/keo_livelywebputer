// The SQL builder behind the homestar's viewer-aware postcard listing
// (ObjectRepository._buildViewerPostcardQuery): checks the visibility rule and the
// parameter wiring without a database. The DB-backed behaviour (what rows actually
// come back, GIN index use) is covered in viewer-postcard-listing.test.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../../core/servers/identity/ObjectRepository.js');

const OWNER = 'did:owner';
const build = (viewer, opts, pivot) => repo._buildViewerPostcardQuery(OWNER, viewer, opts || {}, pivot || null);
const RECIPIENTS = "(o.envelope #> '{record,recipients}') @>";

test('signed-out viewer: public rows only, no recipients test, no hidden-list join', () => {
  const { sql, params } = build(null);
  assert.match(sql, /COALESCE\(o\.envelope ->> 'visibility', 'public'\) = 'public'/);
  assert.ok(!sql.includes(RECIPIENTS));
  assert.ok(!sql.includes('postcard_mailbox_hidden'));
  assert.deepEqual(params, [OWNER, 21]);
});

test('the owner sees everything: no visibility clause at all', () => {
  const { sql, params } = build(OWNER);
  assert.ok(!sql.includes("'visibility'"));
  assert.ok(!sql.includes(RECIPIENTS));
  assert.ok(!sql.includes('postcard_mailbox_hidden'));
  assert.deepEqual(params, [OWNER, 21]);
});

test('another viewer: public OR in record.recipients, written on the indexed expression', () => {
  const { sql, params } = build('did:friend');
  assert.ok(sql.includes(RECIPIENTS + ' $2::jsonb'));
  assert.equal(params[1], JSON.stringify([{ did: 'did:friend' }]));
  assert.ok(sql.includes('postcard_mailbox_hidden'));
  assert.equal(params[2], 'did:friend');
});

test('the viewer id is only ever a bound parameter, never spliced into the SQL', () => {
  const evil = "did:x'); DROP TABLE objects; --";
  const { sql, params } = build(evil, { q: "50%'; --" });
  assert.ok(!sql.includes('DROP TABLE'));
  assert.ok(!sql.includes('50%'));
  assert.ok(params.includes(evil));
});

test('system cards and replies are excluded', () => {
  const { sql } = build('did:friend');
  assert.match(sql, /room-message/);
  assert.match(sql, /constellation-join-request/);
  assert.match(sql, /replyTo,objId/);
  assert.match(sql, /state,deleted/);
});

test('new sort: LIMIT is limit+1 so the cursor can tell there is another page', () => {
  const { sql, params, limit, ranked } = build('did:friend', { limit: 5 });
  assert.equal(limit, 5);
  assert.equal(ranked, false);
  assert.equal(params[params.length - 1], 6);
  assert.match(sql, /ORDER BY o\.id DESC LIMIT \$\d+$/);
});

test('a cursor adds an id < pivot bound ahead of the ORDER BY', () => {
  const { sql, params } = build('did:friend', { limit: 5 }, 123);
  assert.match(sql, /AND o\.id < \$\d+ ORDER BY/);
  assert.ok(params.includes(123));
});

test('ranked sorts: join the counts, order by them, exactly `limit` rows, never a cursor bound', () => {
  for (const sort of ['starred', 'goosed', 'hyphy']) {
    const { sql, params, ranked } = build('did:friend', { limit: 5, sort }, 123);
    assert.equal(ranked, true, sort);
    assert.match(sql, /ORDER BY COALESCE\(rc\.c, 0\) DESC, o\.id DESC/, sort);
    assert.ok(!sql.includes('o.id <'), sort);
    assert.equal(params[params.length - 1], 5, sort);
  }
});

test('starred and goosed bind different emoji; unknown sorts fall back to newest first', () => {
  assert.ok(build(null, { sort: 'starred' }).params.includes('⭐'));
  assert.ok(build(null, { sort: 'goosed' }).params.includes('🪿'));
  assert.equal(build(null, { sort: 'bogus' }).ranked, false);
});

test('hasLocation keeps only cards carrying a state.location', () => {
  assert.match(build(null, { hasLocation: true }).sql, /state,location\}'\) IS NOT NULL/);
  assert.ok(!build(null, {}).sql.includes('state,location'));
});

test('placeholders are contiguous and every one has a parameter', () => {
  const variants = [
    build(null), build(OWNER), build('did:f'),
    build('did:f', { q: 'moon', hasLocation: true, limit: 7 }, 9),
    build('did:f', { sort: 'starred', q: 'x' }),
    build(null, { sort: 'hyphy' })
  ];
  for (const { sql, params } of variants) {
    const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    assert.deepEqual(used, params.map((_, i) => i + 1), sql);
  }
});
