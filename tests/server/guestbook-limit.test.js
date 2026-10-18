// The guestbook's per-guest limit against a real Postgres
// (ObjectRepository.insertCommentWithin): at most `max` comments from one author on one object
// within a rolling window, older comments and removed ones do not count, other authors and other
// objects are separate, and many posts arriving at once cannot get past the limit.
// Everything it seeds carries a random per-run suffix and is removed again, including on failure.
//
// Needs DATABASE_URL (source .env.local); skipped otherwise. The dev server lives in WSL, so run it
// there (it also runs from a Windows shell that can reach the database):
//   node --test tests/server/guestbook-limit.test.js

'use strict';

const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  test('guestbook limit (skipped: DATABASE_URL is not set)', { skip: true }, () => {});
  return;
}

const root = require('path').resolve(__dirname, '..', '..');
process.env.WORKSPACE_LK = root;
const { Pool } = require('pg');
const repo = require(root + '/core/servers/identity/ObjectRepository.js');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const R = crypto.randomBytes(3).toString('hex');
const HOUR = 3600 * 1000;
const WINDOW = 36 * HOUR;
const MAX = 5;
const NOW = new Date('2026-10-18T12:00:00.000Z');
const ago = (h) => new Date(NOW.getTime() - h * HOUR);
const objs = [];
const obj = (n) => { const o = 'gbtest-' + n + '-' + R; objs.push(o); return o; };
const did = (n) => 'did:test:' + n + R;

const post = (o, d, body, now) => new Promise((res, rej) =>
  repo.insertCommentWithin(o, d, body || 'hi', MAX, WINDOW, (e, v) => (e ? rej(e) : res(v)), now || NOW));
const count = async (o, d) => Number((await pool.query('SELECT COUNT(*) AS n FROM item_comments WHERE obj_id = $1 AND did = $2', [o, d])).rows[0].n);
// a comment as it was left `h` hours before NOW
const seed = (o, d, h) => pool.query('INSERT INTO item_comments (obj_id, did, body, created_at) VALUES ($1, $2, $3, $4)', [o, d, 'old', ago(h).toISOString()]);

after(async () => {
  for (const o of objs) await pool.query('DELETE FROM item_comments WHERE obj_id = $1', [o]);
  await pool.end();
  // the repository keeps its own pool open
  setTimeout(() => process.exit(0), 50).unref();
});

test('the sixth comment within the window is refused and nothing is stored for it', async () => {
  const o = obj('a'), d = did('a');
  for (let i = 1; i <= MAX; i++) assert.ok(await post(o, d, 'n' + i), 'comment ' + i + ' goes in');
  assert.equal(await post(o, d, 'n6'), null);
  assert.equal(await count(o, d), MAX);
});

test('the window rolls: comments older than 36 hours do not count, newer ones do', async () => {
  const old = obj('old'), d = did('old');
  for (let i = 0; i < MAX; i++) await seed(old, d, 37);
  assert.ok(await post(old, d), 'five comments from 37 hours ago leave room');

  const recent = obj('recent');
  for (let i = 0; i < MAX; i++) await seed(recent, d, 35);
  assert.equal(await post(recent, d), null, 'five comments from 35 hours ago do not');

  // a mix: three old and two recent leave room for three more
  const mix = obj('mix');
  for (let i = 0; i < 3; i++) await seed(mix, d, 40);
  for (let i = 0; i < 2; i++) await seed(mix, d, 1);
  for (let i = 0; i < 3; i++) assert.ok(await post(mix, d));
  assert.equal(await post(mix, d), null);
});

test('another author and another object are counted separately; removing a comment makes room', async () => {
  const o = obj('sep'), o2 = obj('sep2'), a = did('s1'), b = did('s2');
  for (let i = 0; i < MAX; i++) await post(o, a);
  assert.equal(await post(o, a), null);
  assert.ok(await post(o, b), 'another author is unaffected');
  assert.ok(await post(o2, a), 'the same author on another object is unaffected');

  const row = (await pool.query('SELECT id FROM item_comments WHERE obj_id = $1 AND did = $2 ORDER BY id LIMIT 1', [o, a])).rows[0];
  await new Promise((res, rej) => repo.deleteComment(row.id, (e) => (e ? rej(e) : res())));
  assert.ok(await post(o, a), 'one removed, one more fits');
  assert.equal(await post(o, a), null);
});

test('posts arriving together cannot get past the limit', async () => {
  const o = obj('race'), d = did('race');
  const results = await Promise.all(Array.from({ length: 14 }, (_, i) => post(o, d, 'p' + i)));
  assert.equal(results.filter(Boolean).length, MAX);
  assert.equal(await count(o, d), MAX);
});
