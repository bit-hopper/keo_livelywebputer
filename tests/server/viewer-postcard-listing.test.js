// Viewer-aware postcard / world listings against a real Postgres
// (ObjectRepository.listPostcardsForViewer / listWorldsForViewer).
//
// Seeds one synthetic owner and three viewers, with postcards interleaved across
// audiences, then checks what each viewer gets, that pages and cursors stay
// correct when many rows are hidden from the viewer, the sorts, hasLocation, the
// per-viewer mailbox hide, and that the recipients lookup can use its GIN index.
// Everything it seeds carries a random per-run suffix and is removed again,
// including on failure.
//
// Needs DATABASE_URL (source .env.local); skipped otherwise. The dev server lives
// in WSL, so run it there:
//   node --test tests/server/viewer-postcard-listing.test.js

'use strict';

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  test('viewer postcard listing (skipped: DATABASE_URL is not set)', { skip: true }, () => {});
  return;
}

const root = require('path').resolve(__dirname, '..', '..');
process.env.WORKSPACE_LK = root;
const { Pool } = require('pg');
const repo = require(root + '/core/servers/identity/ObjectRepository.js');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
const p = (fn, ...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v))));
const R = crypto.randomBytes(3).toString('hex');
const OWNER = 'did:test:owner' + R;
const FRIEND = 'did:test:friend' + R;     // in the recipients of the "friends" cards
const OTHER = 'did:test:other' + R;       // signed in, but in no recipient list
const now = new Date().toISOString();
const id = (s) => s + R;

let seq = 0;
async function card(objId, opts) {
  opts = opts || {};
  const visibility = opts.visibility || 'public';
  const recipients = (opts.to || []).map((did) => ({ did, sealedDek: 'x' }));
  const cid = 'cid' + (seq++) + R;
  const envelope = {
    objId, did: OWNER, type: 'postcard', visibility, created: now,
    record: { cid, prevCid: null, payload: {}, recipients: recipients.length ? recipients : undefined },
    state: Object.assign({ title: opts.title || objId }, opts.state || {})
  };
  if (opts.replyTo) envelope.replyTo = { objId: opts.replyTo };
  await q('INSERT INTO objects (obj_id, did, cid, prev_cid, type, visibility, envelope, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [objId, OWNER, cid, null, 'postcard', visibility, JSON.stringify(envelope), now]);
}
async function world(objId, visibility, name, template) {
  const cid = 'wcid' + (seq++) + R;
  const envelope = {
    objId, did: OWNER, type: 'world', visibility, created: new Date(Date.now() + seq).toISOString(),
    record: { cid, prevCid: null, payload: {} }, state: { name, template }
  };
  await q('INSERT INTO objects (obj_id, did, cid, prev_cid, type, visibility, envelope, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [objId, OWNER, cid, null, 'world', visibility, JSON.stringify(envelope), now]);
}
const ids = (r) => r.postcards.map((c) => c.objId);

async function cleanup() {
  await q("DELETE FROM objects WHERE did = $1", [OWNER]);
  await q("DELETE FROM postcard_mailbox_hidden WHERE did = $1", [FRIEND]);
  await q("DELETE FROM postcard_reactions WHERE did = $1", [FRIEND]);
}

before(async () => {
  await p(repo.listPostcardsForViewer, OWNER, null, {});   // runs the schema bootstrap, creating the index
  await cleanup();
  // Oldest to newest: p1 f1 p2 o1 p3 f2 p4 l1 p5 (p = public, f = friends tier, o = orbit-only tier, l = located public)
  await card(id('p1'));
  await card(id('f1'), { visibility: 'shared', to: [FRIEND] });
  await card(id('p2'));
  await card(id('o1'), { visibility: 'shared', to: [OTHER + 'x'] });   // someone else only
  await card(id('p3'));
  await card(id('f2'), { visibility: 'shared', to: [FRIEND] });
  await card(id('p4'));
  await card(id('l1'), { state: { location: '849VQHFJ+X6' } });
  await card(id('p5'));
  await card(id('priv'), { visibility: 'private' });
  await card(id('gone'), { state: { deleted: true } });
  await card(id('reply'), { replyTo: id('p1') });
  await card(id('join'), { state: { kind: 'room-join-request' } });
  await card(id('chat'), { state: { kind: 'room-message' } });
});

after(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

test('signed-out viewer: public cards only, newest first, no system cards', async () => {
  const r = await p(repo.listPostcardsForViewer, OWNER, null, { limit: 50 });
  assert.deepEqual(ids(r), ['p5', 'l1', 'p4', 'p3', 'p2', 'p1'].map(id));
  assert.equal(r.cursor, null);
});

test('a recipient sees public cards plus the ones shared with them', async () => {
  const r = await p(repo.listPostcardsForViewer, OWNER, FRIEND, { limit: 50 });
  assert.deepEqual(ids(r), ['p5', 'l1', 'p4', 'f2', 'p3', 'p2', 'f1', 'p1'].map(id));
});

test('a signed-in viewer who is in no recipient list sees only the public cards', async () => {
  const r = await p(repo.listPostcardsForViewer, OWNER, OTHER, { limit: 50 });
  assert.deepEqual(ids(r), ['p5', 'l1', 'p4', 'p3', 'p2', 'p1'].map(id));
});

test('the owner sees every card including private ones, but not deleted, replies or system cards', async () => {
  const r = await p(repo.listPostcardsForViewer, OWNER, OWNER, { limit: 50 });
  assert.deepEqual(ids(r).sort(), ['p1', 'f1', 'p2', 'o1', 'p3', 'f2', 'p4', 'l1', 'p5', 'priv'].map(id).sort());
});

test('pagination is stable when rows the viewer cannot see are interleaved', async () => {
  // The signed-out viewer can see 6 of 11 candidate rows. Pages of 2 must walk all
  // six, in order, with no short page and no repeats (the old route filtered after
  // LIMIT, which returned short pages).
  const seen = [];
  let cursor = null, pages = 0;
  do {
    const r = await p(repo.listPostcardsForViewer, OWNER, null, { limit: 2, cursor });
    if (r.cursor) assert.equal(r.postcards.length, 2, 'a page with a next cursor is full');
    seen.push(...ids(r));
    cursor = r.cursor;
    pages++;
  } while (cursor && pages < 10);
  assert.deepEqual(seen, ['p5', 'l1', 'p4', 'p3', 'p2', 'p1'].map(id));
  assert.equal(pages, 3);
});

test('hasLocation keeps only located cards', async () => {
  const r = await p(repo.listPostcardsForViewer, OWNER, null, { hasLocation: true });
  assert.deepEqual(ids(r), [id('l1')]);
});

test('q filters on the title', async () => {
  const r = await p(repo.listPostcardsForViewer, OWNER, FRIEND, { q: 'f2' });
  assert.deepEqual(ids(r), [id('f2')]);
});

test('starred sort puts the most-starred card first and never returns a cursor', async () => {
  await q('INSERT INTO postcard_reactions (obj_id, did, emoji, created_at) VALUES ($1,$2,$3,$4)', [id('p2'), FRIEND, '⭐', now]);
  const r = await p(repo.listPostcardsForViewer, OWNER, null, { sort: 'starred', limit: 3 });
  assert.equal(r.postcards[0].objId, id('p2'));
  assert.equal(r.cursor, null);
  assert.equal(r.postcards.length, 3);
});

test('a card the viewer hid from their own mailbox is left out for that viewer only', async () => {
  await q('INSERT INTO postcard_mailbox_hidden (did, obj_id, hidden_at) VALUES ($1,$2,$3)', [FRIEND, id('p3'), now]);
  const mine = await p(repo.listPostcardsForViewer, OWNER, FRIEND, { limit: 50 });
  assert.ok(!ids(mine).includes(id('p3')));
  const theirs = await p(repo.listPostcardsForViewer, OWNER, OTHER, { limit: 50 });
  assert.ok(ids(theirs).includes(id('p3')));
});

test('recipient rows are metadata only: no payload, recipients present for the route to strip', async () => {
  const r = await p(repo.listPostcardsForViewer, OWNER, FRIEND, { limit: 50 });
  assert.equal(r.postcards[0].record.payload, undefined);
  assert.ok(Array.isArray(r.postcards[0].recipients));
});

test('the query is anchored on the owner via idx_did, not a scan of all postcards', async () => {
  const built = repo._buildViewerPostcardQuery(OWNER, FRIEND, { limit: 20 }, null);
  const plan = (await pool.query('EXPLAIN ' + built.sql, built.params)).rows.map((r) => r['QUERY PLAN']).join('\n');
  assert.match(plan, /idx_did/, plan);
});

test('listWorldsForViewer: metadata only, filtered by visibility, oldest first', async () => {
  await world(id('w1'), 'public', 'Workshop', null);
  await world(id('w2'), 'private', 'Secret', 'gallery');
  await world(id('w3'), 'shared', 'Friends only', 'books');
  await q("UPDATE objects SET envelope = jsonb_set(envelope, '{record,recipients}', $1::jsonb) WHERE obj_id = $2",
    [JSON.stringify([{ did: FRIEND, sealedDek: 'x' }]), id('w3')]);

  const anon = await p(repo.listWorldsForViewer, OWNER, null);
  assert.deepEqual(anon.map((w) => w.objId), [id('w1')]);
  const friend = await p(repo.listWorldsForViewer, OWNER, FRIEND);
  assert.deepEqual(friend.map((w) => w.objId), [id('w1'), id('w3')]);
  const owner = await p(repo.listWorldsForViewer, OWNER, OWNER);
  assert.deepEqual(owner.map((w) => w.objId), [id('w1'), id('w2'), id('w3')]);
  assert.deepEqual(Object.keys(owner[1]).sort(), ['created', 'name', 'objId', 'template', 'visibility']);
  assert.equal(owner[1].name, 'Secret');
  assert.equal(owner[1].template, 'gallery');
});
