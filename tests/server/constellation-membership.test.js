// ConstellationRegistry.listPublicByMembership against a real Postgres: what a homestar's
// Constellations card may list. A viewer gets only the public constellations the account is in;
// the account itself (includePrivate) also gets its private ones; a DID that is merely a substring
// of a member's DID is not a member; archived rooms do not count; the biggest constellation is
// first. Everything it seeds carries a random per-run suffix and is removed again.
//
// Needs DATABASE_URL (source .env.local); skipped otherwise. The dev server lives in WSL, so run it
// there (it also runs from a Windows shell that can reach the database):
//   node --test tests/server/constellation-membership.test.js

'use strict';

const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  test('constellation membership (skipped: DATABASE_URL is not set)', { skip: true }, () => {});
  return;
}

const root = require('path').resolve(__dirname, '..', '..');
process.env.WORKSPACE_LK = root;
const reg = require(root + '/core/servers/identity/ConstellationRegistry.js');

const R = crypto.randomBytes(3).toString('hex');
const ME = 'did:test:me' + R;
const LONGER = ME + 'x';   // contains ME as a substring but is a different account
const OTHER = 'did:test:other' + R;
const names = [];
const rooms = [];

const call = (fn, ...args) => new Promise((res, rej) => fn(...args, (e, v) => (e ? rej(e) : res(v))));
const make = async (n, visibility, members) => {
  const name = 'zz-' + n + '-' + R;
  names.push(name);
  await call(reg.create, {
    name, did: 'did:web:test:c:' + name, genesisObjId: 'g-' + name, genesisNonce: 'n',
    controllers: [members[0]], members, createdBy: members[0], createdAt: new Date().toISOString(),
    creationSig: 'sig', visibility,
  });
  return name;
};
const list = (did, opts) => call(reg.listPublicByMembership, did, opts);

after(async () => {
  const pool = await call(reg.withDB);
  for (const n of names) await pool.query('DELETE FROM constellations WHERE name = $1', [n]);
  for (const id of rooms) await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  await pool.end();
  setTimeout(() => process.exit(0), 50).unref();
});

test('a viewer sees only public constellations; the account itself also sees private ones', async () => {
  const pub = await make('pub', 'public', [ME, OTHER]);
  const priv = await make('priv', 'private', [ME, OTHER]);

  const forViewer = (await list(ME, {})).map((c) => c.name);
  assert.ok(forViewer.includes(pub));
  assert.ok(!forViewer.includes(priv), 'a private membership must not be listed to a viewer');

  const forOwner = await list(ME, { includePrivate: true });
  const byName = Object.fromEntries(forOwner.map((c) => [c.name, c]));
  assert.equal(byName[pub].visibility, 'public');
  assert.equal(byName[priv].visibility, 'private');
});

test('a row exposes only name, visibility, counts and avatar', async () => {
  const name = await make('shape', 'public', [ME, OTHER]);
  const row = (await list(ME, {})).find((c) => c.name === name);
  assert.deepEqual(Object.keys(row).sort(), ['avatarUrl', 'memberCount', 'name', 'roomCount', 'visibility']);
  assert.equal(row.memberCount, 2);
  assert.equal(row.roomCount, 0);
});

test('a DID that only contains the account DID as a substring is not a member', async () => {
  const name = await make('substr', 'public', [LONGER]);
  assert.ok(!(await list(ME, {})).some((c) => c.name === name));
  assert.ok((await list(LONGER, {})).some((c) => c.name === name));
});

test('an account that is in none gets an empty list', async () => {
  assert.deepEqual(await list('did:test:nobody' + R, { includePrivate: true }), []);
});

test('rooms are counted, archived ones are not', async () => {
  const name = await make('rooms', 'public', [ME]);
  const pool = await call(reg.withDB);
  const add = async (archived) => {
    const r = await pool.query(
      "INSERT INTO rooms (constellation, name, created_by, created_at, archived_at) VALUES ($1, 'r', $2, $3, $4) RETURNING id",
      [name, ME, new Date().toISOString(), archived ? new Date().toISOString() : null]);
    rooms.push(r.rows[0].id);
  };
  await add(false); await add(false); await add(true);
  const row = (await list(ME, {})).find((c) => c.name === name);
  assert.equal(row.roomCount, 2);
});

test('the largest constellation comes first and the limit is applied', async () => {
  const r2 = 'did:test:r2' + R;
  const small = await make('small', 'public', [r2]);
  const big = await make('big', 'public', [r2, OTHER, ME + 'q']);
  const all = (await list(r2, {})).map((c) => c.name);
  assert.deepEqual(all.filter((n) => n === big || n === small), [big, small]);
  assert.equal((await list(r2, { limit: 1 })).length, 1);
});
