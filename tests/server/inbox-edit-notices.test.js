// Edit notices in the inbox listing, and the "who engaged with a card" query, against
// a real Postgres (ObjectRepository.listInboxForHandle / getEngagedDidsForCard).
//
// The inbox itself is a per-handle log on disk, so this points WORKSPACE_LK at a
// throwaway directory; the card rows it looks up are seeded in Postgres with a random
// per-run suffix and removed again, including on failure.
//
// Needs DATABASE_URL (source .env.local); skipped otherwise. The dev server lives in
// WSL, so run it there:
//   node --test tests/server/inbox-edit-notices.test.js

'use strict';

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DATABASE_URL) {
  test('inbox edit notices (skipped: DATABASE_URL is not set)', { skip: true }, () => {});
  return;
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-inbox-'));
process.env.WORKSPACE_LK = workspace;
const root = path.resolve(__dirname, '..', '..');
const { Pool } = require('pg');
const repo = require(root + '/core/servers/identity/ObjectRepository.js');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
const p = (fn, ...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v))));
const R = crypto.randomBytes(3).toString('hex');
const OWNER = 'did:test:owner' + R;
const VIEWER = 'did:test:viewer' + R;
const REACTOR = 'did:test:reactor' + R;
const REPLIER = 'did:test:replier' + R;
const GONE = 'did:test:gone' + R;
const HANDLE = 'viewer' + R;
const X = 'cardx' + R;       // a public card that gets edited
const Y = 'cardy' + R;       // a card shared with VIEWER that gets edited
const t = (n) => new Date(Date.UTC(2026, 9, 17, 12, n)).toISOString();

let seq = 0;
async function card(objId, did, opts) {
  opts = opts || {};
  const cid = 'cid' + (seq++) + R;
  const envelope = {
    objId, did, type: 'postcard', visibility: opts.visibility || 'public', created: t(0),
    record: { cid, prevCid: null, payload: {} },
    state: Object.assign({ title: opts.title || objId }, opts.state || {})
  };
  if (opts.replyTo) envelope.replyTo = { objId: opts.replyTo };
  await q('INSERT INTO objects (obj_id, did, cid, prev_cid, type, visibility, envelope, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [objId, did, cid, null, 'postcard', envelope.visibility, JSON.stringify(envelope), t(0)]);
}
const putInbox = (rec) => p(repo.putInboxRecord, HANDLE, rec);
const edit = (objId, minute) => ({ edited: true, objId, senderDid: OWNER, senderHandle: 'own', sentAt: t(minute) });
const list = () => p(repo.listInboxForHandle, HANDLE, { limit: 50, did: VIEWER });

function resetInbox() {
  const f = path.join(workspace, 'identity', 'inbox', HANDLE + '.jsonl');
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

async function cleanup() {
  await q('DELETE FROM objects WHERE obj_id LIKE $1', ['%' + R]);
  await q('DELETE FROM postcard_reactions WHERE obj_id LIKE $1', ['%' + R]);
  await q('DELETE FROM inbox_thread_state WHERE did = $1', [VIEWER]);
}

before(async () => {
  await p(repo.getReactionsForObjId, 'warmup' + R);   // runs the schema bootstrap
  await cleanup();
  await card(X, OWNER, { title: 'Public card' });
  await card(Y, OWNER, { visibility: 'shared', title: 'Shared card' });
});

after(async () => {
  await cleanup();
  await pool.end();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('edit notices fold to one row per card, newest first, each unread', async () => {
  resetInbox();
  await putInbox(edit(X, 1));
  await putInbox(edit(X, 5));
  await putInbox(edit(Y, 3));
  const r = await list();
  assert.equal(r.records.length, 2);
  assert.deepEqual(r.records.map((x) => x.objId), [X, Y]);
  assert.ok(r.records.every((x) => x.edited === true && x.unread === 1));
  assert.equal(r.records[0].sentAt, t(5));
  assert.equal(r.records[0].title, 'Public card');
  assert.equal(r.unreadReplies, 2);
});

test('a card that also has a thread row carries the notice on that row instead', async () => {
  resetInbox();
  await putInbox(edit(X, 5));
  await putInbox(edit(Y, 3));
  await putInbox({ reply: true, objId: 'reply1' + R, rootObjId: X, senderDid: REPLIER, senderHandle: 'rep', sentAt: t(4) });
  const r = await list();
  const thread = r.records.find((x) => x.thread);
  assert.ok(thread, 'the thread row is there');
  assert.equal(thread.objId, X);
  assert.equal(thread.edited.senderHandle, 'own');
  assert.equal(thread.sentAt, t(5));              // the edit is newer than the reply
  assert.equal(thread.unread, 2);                 // one reply and one edit
  assert.equal(r.records.filter((x) => x.objId === X).length, 1);   // no second row for X
  assert.equal(r.records.filter((x) => x.edited === true).length, 1); // only Y stands alone
  assert.equal(r.unreadReplies, 3);
});

test('reading the card clears its notice, on a row of its own and on a thread row', async () => {
  resetInbox();
  await putInbox(edit(Y, 3));
  await p(repo.markThreadRead, VIEWER, Y);
  const r = await list();
  assert.equal(r.records[0].unread, 0);
  assert.equal(r.unreadReplies, 0);
});

test('mark all read covers edit notices', async () => {
  resetInbox();
  await q('DELETE FROM inbox_thread_state WHERE did = $1', [VIEWER]);
  await putInbox(edit(X, 2));
  await putInbox(edit(Y, 3));
  assert.equal((await list()).unreadReplies, 2);
  await p(repo.markAllThreadsRead, HANDLE, VIEWER);
  assert.equal((await list()).unreadReplies, 0);
});

test('a notice for a card that has been deleted is dropped', async () => {
  resetInbox();
  await putInbox(edit(X, 2));
  await putInbox(edit(Y, 3));
  const cid = 'tomb' + R;
  const tomb = {
    objId: Y, did: OWNER, type: 'postcard', visibility: 'shared', created: t(0),
    record: { cid, prevCid: 'x', payload: {} }, state: { deleted: true }
  };
  await q('INSERT INTO objects (obj_id, did, cid, prev_cid, type, visibility, envelope, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [Y, OWNER, cid, 'x', 'postcard', 'shared', JSON.stringify(tomb), t(9)]);
  const r = await list();
  assert.deepEqual(r.records.map((x) => x.objId), [X]);
});

test('getEngagedDidsForCard: reactors and live repliers, once each, not deleted replies', async () => {
  await q('INSERT INTO postcard_reactions (obj_id, did, emoji, created_at) VALUES ($1,$2,$3,$4),($1,$2,$5,$4)',
    [X, REACTOR, '⭐', t(1), '🔥']);              // two emoji, one person
  await card('rep-a' + R, REPLIER, { replyTo: X });
  await card('rep-b' + R, REACTOR, { replyTo: X });               // reacted and replied: still once
  await card('rep-c' + R, GONE, { replyTo: X, state: { deleted: true } });
  await card('rep-d' + R, VIEWER, { replyTo: Y });                // a reply to a different card
  const dids = await p(repo.getEngagedDidsForCard, X);
  assert.deepEqual(dids.slice().sort(), [REACTOR, REPLIER].sort());
  assert.deepEqual(await p(repo.getEngagedDidsForCard, 'nothing' + R), []);
});
