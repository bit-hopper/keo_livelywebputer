// Account export and deletion against a real Postgres (settings.md §5, §5a, §8).
//
// Seeds two cross-linked synthetic accounts across EVERY table AccountData
// knows about, exports one with the real exporter and re-verifies the archive
// with the system `tar`, then deletes it and checks the other is untouched.
// Everything it seeds is removed again, including on failure.
//
// Needs DATABASE_URL (source .env.local) and a tar binary; skipped otherwise.
// The dev server lives in WSL, so run it there:
//   node --test tests/server/account-lifecycle.test.js
// It writes under identity/ and users/ in the workspace (all cleaned up) and
// touches only rows whose ids carry a random per-run suffix.

'use strict';

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

if (!process.env.DATABASE_URL) {
  test('account lifecycle (skipped: DATABASE_URL is not set)', { skip: true }, () => {});
  return;
}

const root = path.resolve(__dirname, '..', '..');
process.env.WORKSPACE_LK = root;
const { Pool } = require('pg');
const AD = require(root + '/core/servers/identity/AccountData.js');
const AccountDeletion = require(root + '/core/servers/identity/AccountDeletion.js');
const AccountExport = require(root + '/core/servers/identity/AccountExport.js');
const HandleRegistry = require(root + '/core/servers/identity/HandleRegistry.js');
const LinkedAccounts = require(root + '/core/servers/identity/LinkedAccounts.js');
const blobStore = require(root + '/core/servers/identity/BlobStore.js');
const constellationRegistry = require(root + '/core/servers/identity/ConstellationRegistry.js');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
const p = (fn, ...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v))));
const R = crypto.randomBytes(3).toString('hex');
const now = new Date().toISOString();
const cidOf = (buf) => crypto.createHash('sha256').update(buf).digest('base64url');
const ws = (...parts) => path.join(root, ...parts);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-test-'));
let A, B, C, D, E, room, ev, cidX, cidS, cidH;
const names = { a: 'ctest_a' + R, a2: 'ctest_a2' + R, c: 'ctest_c' + R };
const longRel = Array.from({ length: 6 }, (_, i) => 'd' + i + 'x'.repeat(58)).join('/') + '/ünï-日本-' + R + '.txt';

async function ins(table, obj) {
  const cols = Object.keys(obj);
  const rows = await q('INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + cols.map((c, i) => '$' + (i + 1)).join(',') + ') RETURNING *',
    cols.map((c) => (obj[c] !== null && typeof obj[c] === 'object') ? JSON.stringify(obj[c]) : obj[c]));
  return rows[0];
}
async function account(tag) {
  const did = 'did:test:' + tag + R, handle = 'hometest_' + tag.toLowerCase() + R;
  await ins('handles', { handle, did, created_at: now, updated_at: now });
  await ins('credentials', { credential_id: 'cred_' + tag + R, did, public_key: 'pk', counter: 0, created_at: now });
  await ins('did_documents', { did, document: JSON.stringify({ id: did, verificationMethod: [] }), updated_at: now });
  return { did, handle };
}
function writeFiles(a, extra) {
  const mk = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
  mk(ws('users', a.handle, 'config.js'), '//x');
  mk(ws('identity', 'uploads', a.handle, 'x.txt'), 'x');
  mk(ws('identity', 'inbox', a.handle + '.jsonl'), '{}\n');
  mk(ws('identity', 'deliveries', a.handle + '.jsonl'), '{}\n');
  if (extra) mk(ws('identity', 'uploads', a.handle, longRel), 'long path content ' + R);
}
const filesExist = (a) => ({
  users: fs.existsSync(ws('users', a.handle)), uploads: fs.existsSync(ws('identity', 'uploads', a.handle)),
  inbox: fs.existsSync(ws('identity', 'inbox', a.handle + '.jsonl')), deliveries: fs.existsSync(ws('identity', 'deliveries', a.handle + '.jsonl')),
});
const env = (objId, did, type, extra) => Object.assign({ objId, did, type, visibility: 'private', record: { cid: 'x', payload: {} } }, extra || {});
const objRow = (obj_id, did, cid, type, prev, extra) => ins('objects', { obj_id, did, cid, prev_cid: prev || null, type, visibility: 'private', envelope: env(obj_id, did, type, extra), created_at: now });
const del = (acct) => new Promise((res) => AccountDeletion.deleteAccount({ did: acct.did, handle: acct.handle, blobStore, constellationRegistry }, (e, v) => res({ e, v })));

async function exportTo(acct, file) {
  const out = fs.createWriteStream(file);
  const manifest = await new Promise((res, rej) => AccountExport.writeExport({ did: acct.did, handle: acct.handle, blobStore }, out, (e, m) => (e ? rej(e) : res(m))));
  await new Promise((r) => out.end(r));
  return manifest;
}
// Extracts with the SYSTEM tar (relative paths: GNU tar treats "C:\..." as a remote host) and re-checks every manifest entry.
function extractAndVerify(file, manifest) {
  const dir = file.replace(/\.keo$/, '');
  fs.mkdirSync(dir);
  const r = spawnSync('tar', ['-xf', path.basename(file), '-C', path.basename(dir)], { cwd: path.dirname(file) });
  assert.equal(r.status, 0, 'system tar could not extract the archive: ' + (r.stderr || '').toString());
  const bad = [];
  for (const e of manifest.entries) {
    const f = path.join(dir, e.path);
    if (!fs.existsSync(f)) { bad.push('missing ' + e.path); continue; }
    const buf = fs.readFileSync(f);
    if (buf.length !== e.size) bad.push('size ' + e.path);
    if (crypto.createHash('sha256').update(buf).digest('hex') !== e.sha256) bad.push('sha256 ' + e.path);
  }
  return { dir, bad };
}

before(async () => {
  A = await account('A'); B = await account('B'); C = await account('C'); D = await account('D');
  E = 'did:test:0E' + R; // sorts before A, so A is friendships.did_b

  const bufX = Buffer.from('only-A-' + R), bufS = Buffer.from('shared-' + R), bufH = Buffer.from('history-only-' + R);
  cidX = cidOf(bufX); cidS = cidOf(bufS); cidH = cidOf(bufH);
  await p(blobStore.put, cidX, bufX); await p(blobStore.put, cidS, bufS); await p(blobStore.put, cidH, bufH);

  await objRow('A1' + R, A.did, 'a1v1' + R, 'postcard'); await objRow('A1' + R, A.did, 'a1v2' + R, 'postcard', 'a1v1' + R);
  await objRow('A2' + R, A.did, 'a2' + R, 'file'); await objRow('A3' + R, A.did, 'a3' + R, 'file'); await objRow('Arec' + R, A.did, 'arec' + R, 'recovery');
  // a part whose OLD version referenced a blob the current tip does not: no blob_refs row exists for it
  await objRow('P1' + R, A.did, 'p1v1' + R, 'part', null, { blobCid: cidH });
  await objRow('P1' + R, A.did, 'p1v2' + R, 'part', 'p1v1' + R);
  await objRow('B1' + R, B.did, 'b1' + R, 'file'); await objRow('B2' + R, B.did, 'b2' + R, 'postcard');
  await objRow('D1' + R, D.did, 'd1' + R, 'postcard');
  await ins('blob_refs', { blob_cid: cidX, obj_id: 'A2' + R }); await ins('blob_refs', { blob_cid: cidS, obj_id: 'A3' + R }); await ins('blob_refs', { blob_cid: cidS, obj_id: 'B1' + R });

  await ins('postcard_reactions', { obj_id: 'A1' + R, did: B.did, emoji: '+', created_at: now });
  await ins('postcard_reactions', { obj_id: 'B2' + R, did: A.did, emoji: '+', created_at: now });
  await ins('postcard_mailbox_hidden', { did: A.did, obj_id: 'B2' + R, hidden_at: now });
  await ins('postcard_mailbox_hidden', { did: B.did, obj_id: 'A1' + R, hidden_at: now });
  await ins('postcard_collections', { did: A.did, obj_id: 'B2' + R, saved_at: now });
  await ins('postcard_collections', { did: B.did, obj_id: 'A1' + R, saved_at: now });
  await ins('item_stars', { obj_id: 'A1' + R, did: B.did, created_at: now }); await ins('item_stars', { obj_id: 'B2' + R, did: A.did, created_at: now });
  await ins('item_comments', { obj_id: 'A1' + R, did: B.did, body: 'hi', created_at: now }); await ins('item_comments', { obj_id: 'B2' + R, did: A.did, body: 'yo', created_at: now });
  await ins('part_aliases', { did: A.did, alias_name: 'p' + R, obj_id: 'A1' + R, updated_at: now });
  await ins('user_status', { did: A.did, status: 'online', updated_at: now }); await ins('user_status', { did: B.did, status: 'online', updated_at: now });
  await ins('inbox_thread_state', { did: A.did, root_obj_id: 'B2' + R }); await ins('inbox_thread_state', { did: B.did, root_obj_id: 'A1' + R });
  const [lo, hi] = [A.did, B.did].sort();
  await ins('friendships', { did_a: lo, did_b: hi, created_at: now });
  await ins('friendships', { did_a: E, did_b: A.did, created_at: now });
  await ins('friend_requests', { requester_did: A.did, target_did: B.did, requested_at: now });
  await ins('friend_requests', { requester_did: B.did, target_did: A.did, requested_at: now });
  await ins('dm_mailbox', { msg_id: 'm1' + R, thread_id: 't' + R, sender_did: A.did, recipient_did: B.did, sender_device_pub: 'p', ciphertext: 'c', sig: 's', sent_at: now });
  await ins('dm_mailbox', { msg_id: 'm2' + R, thread_id: 't' + R, sender_did: B.did, recipient_did: A.did, sender_device_pub: 'p', ciphertext: 'c', sig: 's', sent_at: now });
  // linked accounts: one tokenless link and one with a sealed credential (a real bytea,
  // which ins() would mangle into JSON, so it goes in with its own statement)
  await p(LinkedAccounts.withDB);
  await ins('linked_accounts', { did: A.did, platform: 'steam', external_id: '7656' + R, display_name: 'a-steam', status: 'active', linked_at: now });
  await q('INSERT INTO linked_accounts (did, platform, external_id, display_name, credential_ct, credential_nonce, key_version, scopes, status, linked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [A.did, 'itch', 'itch' + R, 'a-itch', Buffer.from('sealed-secret-' + R), Buffer.alloc(12, 7), 1, 'profile:me', 'active', now]);
  await ins('instances', { base_url: 'https://inst' + R + '.example', display_name: 'x', added_by: A.did, added_at: now });
  await ins('domains', { domain: 'a' + R + '.example', did: A.did, verified_at: now });
  await ins('handles', { handle: 'alias' + R, did: A.did, created_at: now, updated_at: now, is_alias: true, primary_handle: A.handle });

  const cons = (name, createdBy, controllers, members, bots) => ins('constellations', { name, did: 'did:web:x:c:' + name, genesis_obj_id: 'g' + name, genesis_nonce: 'n', controllers, threshold: 1, members, created_by: createdBy, created_at: now, creation_sig: 's', visibility: 'public', bots });
  await cons(names.a, B.did, [B.did], [B.did, A.did], [A.did]);
  await cons(names.a2, B.did, [B.did, A.did], [B.did, A.did], []);
  await cons(names.c, C.did, [C.did], [C.did], []); // C created one -> C is blocked
  room = await ins('rooms', { constellation: names.a, name: 'r', access: 'open', created_by: A.did, created_at: now, e2ee_enabled: true });
  ev = await ins('constellation_events', { constellation: names.a, title: 'e', starts_at: now, created_by: A.did, created_at: now });
  await ins('event_rsvps', { event_id: ev.id, did: A.did, status: 'going', responded_at: now }); await ins('event_rsvps', { event_id: ev.id, did: B.did, status: 'going', responded_at: now });
  await ins('join_requests', { constellation: names.a2, did: A.did, requested_at: now });
  await ins('room_join_requests', { room_id: room.id, did: A.did, requested_at: now });
  await ins('constellation_invites', { constellation: names.a, did: A.did, invited_by: B.did, obj_id: 'inv1' + R, created_at: now });
  await ins('constellation_invites', { constellation: names.a2, did: B.did, invited_by: A.did, obj_id: 'inv2' + R, created_at: now });
  await ins('constellation_invites', { constellation: names.a2, did: C.did, invited_by: B.did, obj_id: 'A2' + R, created_at: now }); // obj_id of one of A's objects
  [A, B, C, D].forEach((a) => writeFiles(a, a === A));
});

after(async () => {
  try {
    const dids = [A, B, C, D].filter(Boolean).map((a) => a.did).concat([E]);
    for (const t of AD.DID_REFS) { if (t.mode !== 'blocker') await q(`DELETE FROM ${t.table} WHERE ${t.column} = ANY($1)`, [dids]).catch(() => {}); }
    const cn = Object.values(names);
    await q('DELETE FROM rooms WHERE constellation = ANY($1)', [cn]); await q('DELETE FROM constellation_events WHERE constellation = ANY($1)', [cn]);
    await q('DELETE FROM constellations WHERE name = ANY($1)', [cn]);
    await q('DELETE FROM instances WHERE base_url = $1', ['https://inst' + R + '.example']);
    await q("DELETE FROM reserved_handles WHERE handle LIKE '%' || $1 OR handle = $2", [R, 'alias' + R]);
    for (const t of ['objects', 'blob_refs', 'postcard_reactions', 'item_stars', 'item_comments', 'postcard_collections', 'postcard_mailbox_hidden']) {
      await q(`DELETE FROM ${t} WHERE obj_id LIKE '%' || $1`, [R]).catch(() => {});
    }
    await q("DELETE FROM inbox_thread_state WHERE root_obj_id LIKE '%' || $1", [R]);
    if (ev) await q('DELETE FROM event_rsvps WHERE event_id = $1', [ev.id]);
    await q("DELETE FROM account_export_tokens WHERE did LIKE 'did:test:%'").catch(() => {});
    [A, B, C, D].filter(Boolean).forEach((a) => {
      for (const f of [['users', a.handle], ['identity', 'uploads', a.handle], ['identity', 'inbox', a.handle + '.jsonl'], ['identity', 'deliveries', a.handle + '.jsonl']]) fs.rmSync(ws(...f), { recursive: true, force: true });
    });
    for (const c of [cidX, cidS, cidH]) if (c) await p(blobStore.delete, c).catch(() => {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    await pool.end();
  }
});

test('the seed touches every column and table the account manifest lists (no vacuous pass)', async () => {
  const left = await p(AD.countRemaining, pool, A.did, await p(AD.objectIds, pool, A.did));
  const missing = AD.DID_REFS.filter((r) => r.mode !== 'blocker').map((r) => r.table + '.' + r.column).filter((k) => !left[k]);
  assert.deepEqual(missing, [], 'DID-keyed columns with no seeded row');
  assert.deepEqual(AD.OBJECT_REFS.map((r) => r.table + '.' + r.column).filter((k) => !left[k]), [], 'object-keyed tables with no seeded row');
  for (const k of ['members', 'controllers', 'bots']) assert.ok(left['constellations.' + k + '[]'], 'no seeded constellation ' + k + ' entry');
});

test('export: a plain tar that verifies against its own manifest, with every version, blob and file', async () => {
  const file = path.join(tmp, 'a.keo');
  const m = await exportTo(A, file);
  const listing = spawnSync('tar', ['-tf', 'a.keo'], { cwd: tmp }).stdout.toString().split(/\r?\n/).filter(Boolean);
  assert.equal(listing[0], 'format.json');
  assert.equal(listing[listing.length - 1], 'manifest.json');
  assert.equal(new Set(listing).size, listing.length, 'an entry path appears twice');

  const { dir, bad } = extractAndVerify(file, m);
  assert.deepEqual(bad, []);
  assert.equal(m.counts.objects, 5);
  assert.equal(m.counts.versions, 7);
  assert.equal(m.counts.blobs, 3, 'tip blobs plus the history-only one');
  assert.deepEqual(m.warnings.filter((w) => !/DID document/.test(w)), []);
  assert.ok(fs.existsSync(path.join(dir, 'blobs', cidH)), 'the history-only blob was exported');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'blobs', cidX))).digest('base64url'), cidX, 'an exported blob hashes to its cid');
  const ents = m.entries.map((e) => e.path);
  assert.ok(ents.some((e) => Buffer.byteLength(e) > 255), 'the over-255-byte non-ASCII path went through a PAX header');
  assert.ok(ents.includes('data/friendships.json') && ents.includes('data/dm_mailbox.json') && ents.includes('data/constellations.json'));
  assert.ok(ents.includes('data/linked_accounts.json'), 'linked accounts are exported');
  const linkedJson = fs.readFileSync(path.join(dir, 'data', 'linked_accounts.json'), 'utf8');
  assert.equal(JSON.parse(linkedJson).length, 2);
  assert.ok(!/credential_ct|credential_nonce|key_version|sealed-secret/.test(linkedJson), 'no credential column or value in the export');
  const first = m.entries.find((e) => e.path === 'objects/A1' + R + '/000001.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, first.path), 'utf8')),
    (await q('SELECT envelope FROM objects WHERE obj_id=$1 ORDER BY id LIMIT 1', ['A1' + R]))[0].envelope, 'exported envelope equals the stored one');

  const again = await exportTo(A, path.join(tmp, 'a2.keo'));
  assert.deepEqual(again.entries, m.entries, 'a second export is identical');
});

test('export tokens: single-use, bound to the account, expiring, replaced on re-mint', async () => {
  const d = 'did:test:tok' + R;
  const t1 = await p(AccountExport.mintToken, d);
  assert.equal(await p(AccountExport.consumeToken, t1, d), true);
  assert.equal(await p(AccountExport.consumeToken, t1, d), false, 'second redemption');
  const t2 = await p(AccountExport.mintToken, d);
  assert.equal(await p(AccountExport.consumeToken, t2, 'did:test:other' + R), false, 'another account');
  assert.equal(await p(AccountExport.consumeToken, t2, d), true, 'a wrong-account attempt must not burn the token');
  const t3 = await p(AccountExport.mintToken, d);
  await q('UPDATE account_export_tokens SET expires_at = 1 WHERE did = $1', [d]);
  assert.equal(await p(AccountExport.consumeToken, t3, d), false, 'expired');
  const t4a = await p(AccountExport.mintToken, d), t4b = await p(AccountExport.mintToken, d);
  assert.equal(await p(AccountExport.consumeToken, t4a, d), false, 'replaced by a newer mint');
  assert.equal(await p(AccountExport.consumeToken, t4b, d), true);
  assert.equal(await p(AccountExport.consumeToken, undefined, d), false);
  assert.equal(await p(AccountExport.consumeToken, 'nope', d), false);
});

test('deleting a constellation creator is refused (BLOCKED) and changes nothing', async () => {
  const { e } = await del(C);
  assert.equal(e && e.code, 'BLOCKED');
  assert.deepEqual(e.constellations, [names.c]);
  assert.equal((await q('SELECT count(*)::int n FROM handles WHERE did=$1', [C.did]))[0].n, 1);
  assert.ok(filesExist(C).users);
});

test('a verify failure rolls EVERYTHING back, including the handle reservation', async () => {
  const real = AD.countRemaining;
  AD.countRemaining = (db, did, ids, cb) => real(db, did, ids, (e, left) => cb(e, Object.assign({ 'forced.failure': 1 }, left)));
  let r;
  try { r = await del(D); } finally { AD.countRemaining = real; }
  assert.equal(r.e && r.e.code, 'VERIFY_FAILED');
  assert.equal((await q('SELECT count(*)::int n FROM objects WHERE did=$1', [D.did]))[0].n, 1);
  assert.equal((await q('SELECT count(*)::int n FROM handles WHERE did=$1', [D.did]))[0].n, 1);
  assert.equal((await q('SELECT count(*)::int n FROM credentials WHERE did=$1', [D.did]))[0].n, 1);
  assert.equal((await q('SELECT count(*)::int n FROM reserved_handles WHERE handle=$1', [D.handle]))[0].n, 0);
  assert.ok(filesExist(D).users && filesExist(D).inbox);
});

test('delete: A is gone from every table, B and shared data are untouched', async () => {
  const stat = (c) => p(blobStore.stat, c);
  assert.ok(await stat(cidX) && await stat(cidS) && await stat(cidH));
  const { e, v: rep } = await del(A);
  assert.equal(e, null);
  assert.equal(rep.objects, 5);
  assert.equal(rep.versions, 7);
  assert.equal(rep.blobsDeleted, 2, 'the A-only blob and the history-only blob');
  assert.equal(rep.blobsKept, 1, 'the blob B still references');
  assert.equal(rep.filesRemoved, 4);
  assert.deepEqual(rep.warnings, []);

  const left = await p(AD.countRemaining, pool, A.did, ['A1' + R, 'A2' + R, 'A3' + R, 'Arec' + R, 'P1' + R]);
  assert.deepEqual(left, {}, 'rows still present for A');
  assert.equal((await q('SELECT count(*)::int n FROM handles WHERE did=$1', [A.did]))[0].n, 0, 'primary and alias handle rows');
  assert.deepEqual((await q('SELECT handle FROM reserved_handles WHERE handle = ANY($1) ORDER BY handle', [[A.handle, 'alias' + R]])).map((x) => x.handle), [A.handle, 'alias' + R].sort());
  assert.equal(await p(HandleRegistry.isReserved, A.handle), true);
  assert.ok(!(await stat(cidX)) && !(await stat(cidH)) && await stat(cidS), 'blob bytes: A-only and history-only gone, shared kept');
  assert.deepEqual(filesExist(A), { users: false, uploads: false, inbox: false, deliveries: false });
  assert.deepEqual(filesExist(B), { users: true, uploads: true, inbox: true, deliveries: true });

  assert.equal((await q('SELECT count(*)::int n FROM objects WHERE did=$1', [B.did]))[0].n, 2);
  assert.equal((await q('SELECT count(*)::int n FROM credentials WHERE did=$1', [B.did]))[0].n, 1);
  assert.equal((await q('SELECT count(*)::int n FROM user_status WHERE did=$1', [B.did]))[0].n, 1);
  assert.equal((await q('SELECT count(*)::int n FROM blob_refs WHERE blob_cid=$1', [cidS]))[0].n, 1);
  assert.equal((await q('SELECT count(*)::int n FROM event_rsvps WHERE did=$1', [B.did]))[0].n, 1);

  const ca = (await q('SELECT * FROM constellations WHERE name=$1', [names.a]))[0], ca2 = (await q('SELECT * FROM constellations WHERE name=$1', [names.a2]))[0];
  assert.equal(ca.members, JSON.stringify([B.did]));
  assert.equal(ca.controllers, JSON.stringify([B.did]));
  assert.equal(ca.bots, '[]');
  assert.equal(ca2.controllers, JSON.stringify([B.did]));
  const rm = (await q('SELECT * FROM rooms WHERE id=$1', [room.id]))[0];
  assert.equal(rm.created_by, 'deleted', 'a room others use stays, anonymised');
  assert.equal((await q('SELECT created_by FROM constellation_events WHERE id=$1', [ev.id]))[0].created_by, 'deleted');
  assert.equal(rm.e2ee_rotation_pending, true, 'the departed member still holds the old room key');
  assert.equal((await q('SELECT added_by FROM instances WHERE base_url=$1', ['https://inst' + R + '.example']))[0].added_by, null);
});

test('a second delete of the same account fails cleanly (NOT_FOUND)', async () => {
  const { e } = await del(A);
  assert.equal(e && e.code, 'NOT_FOUND');
});
