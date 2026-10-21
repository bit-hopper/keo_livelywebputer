// CredentialVault: sealing and opening a linked-account credential. Pure, no
// database and no network; the key material is passed in as a fake environment
// object so nothing depends on this machine's own settings.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const vault = require('../../core/servers/identity/CredentialVault.js');

const k = () => crypto.randomBytes(32).toString('base64');
const ENV1 = { LINKED_ACCOUNTS_KEYS: JSON.stringify({ 1: k() }), LINKED_ACCOUNTS_KEY_CURRENT: '1' };
const ctx = { did: 'did:web:example.test:alice', platform: 'itch', externalId: '12345' };
const TOKEN = 'tok_' + crypto.randomBytes(18).toString('hex');

test('round trip: what was sealed opens to the same string', () => {
  const s = vault.seal(TOKEN, ctx, ENV1);
  assert.ok(Buffer.isBuffer(s.ct) && Buffer.isBuffer(s.nonce));
  assert.equal(s.nonce.length, 12);
  assert.equal(s.keyVersion, 1);
  assert.equal(vault.open(s, ctx, ENV1), TOKEN);
});

test('the ciphertext does not contain the plaintext, and two seals differ (fresh nonce)', () => {
  const a = vault.seal(TOKEN, ctx, ENV1), b = vault.seal(TOKEN, ctx, ENV1);
  assert.ok(!a.ct.includes(Buffer.from(TOKEN)));
  assert.notDeepEqual(a.nonce, b.nonce);
  assert.notDeepEqual(a.ct, b.ct);
});

test('non-ASCII tokens survive', () => {
  const t = 'tök€n-日本-' + TOKEN;
  assert.equal(vault.open(vault.seal(t, ctx, ENV1), ctx, ENV1), t);
});

test('wrong context fails: another account, platform or external id cannot open the row', () => {
  const s = vault.seal(TOKEN, ctx, ENV1);
  for (const other of [
    { ...ctx, did: 'did:web:example.test:mallory' },
    { ...ctx, platform: 'steam' },
    { ...ctx, externalId: '99999' },
  ]) {
    assert.throws(() => vault.open(s, other, ENV1), (e) => e.name === 'VaultError' && e.code === 'DECRYPT');
  }
});

test('context parts cannot be shifted across the separator', () => {
  assert.throws(() => vault.seal(TOKEN, { did: 'a|b', platform: 'c', externalId: 'd' }, ENV1), (e) => e.code === 'BAD_INPUT');
  for (const bad of [{ did: '', platform: 'itch', externalId: '1' }, { did: 'd', platform: '', externalId: '1' }, { did: 'd', platform: 'itch' }, null]) {
    assert.throws(() => vault.seal(TOKEN, bad, ENV1), (e) => e.code === 'BAD_INPUT');
  }
});

test('tampered ciphertext, tag, or nonce fails', () => {
  const s = vault.seal(TOKEN, ctx, ENV1);
  const flip = (buf, i) => { const c = Buffer.from(buf); c[i] ^= 1; return c; };
  assert.throws(() => vault.open({ ...s, ct: flip(s.ct, 0) }, ctx, ENV1), (e) => e.code === 'DECRYPT');
  assert.throws(() => vault.open({ ...s, ct: flip(s.ct, s.ct.length - 1) }, ctx, ENV1), (e) => e.code === 'DECRYPT');
  assert.throws(() => vault.open({ ...s, nonce: flip(s.nonce, 0) }, ctx, ENV1), (e) => e.code === 'DECRYPT');
});

test('malformed sealed records are rejected, not crashed on', () => {
  const s = vault.seal(TOKEN, ctx, ENV1);
  for (const bad of [null, {}, { ...s, ct: Buffer.alloc(4) }, { ...s, nonce: Buffer.alloc(5) }, { ...s, ct: 'text' }]) {
    assert.throws(() => vault.open(bad, ctx, ENV1), (e) => e.code === 'BAD_INPUT');
  }
});

test('empty plaintext is refused', () => {
  assert.throws(() => vault.seal('', ctx, ENV1), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => vault.seal(null, ctx, ENV1), (e) => e.code === 'BAD_INPUT');
});

test('a different key cannot open the row; an unknown key version is named as such', () => {
  const s = vault.seal(TOKEN, ctx, ENV1);
  const other = { LINKED_ACCOUNTS_KEYS: JSON.stringify({ 1: k() }), LINKED_ACCOUNTS_KEY_CURRENT: '1' };
  assert.throws(() => vault.open(s, ctx, other), (e) => e.code === 'DECRYPT');
  const v2only = { LINKED_ACCOUNTS_KEYS: JSON.stringify({ 2: k() }), LINKED_ACCOUNTS_KEY_CURRENT: '2' };
  assert.throws(() => vault.open(s, ctx, v2only), (e) => e.code === 'UNKNOWN_KEY');
});

test('rotation: a row sealed under the old version still opens, is flagged, and re-seals under the new one', () => {
  const k1 = k(), k2 = k();
  const before = { LINKED_ACCOUNTS_KEYS: JSON.stringify({ 1: k1 }), LINKED_ACCOUNTS_KEY_CURRENT: '1' };
  const after = { LINKED_ACCOUNTS_KEYS: JSON.stringify({ 1: k1, 2: k2 }), LINKED_ACCOUNTS_KEY_CURRENT: '2' };
  const old = vault.seal(TOKEN, ctx, before);
  assert.equal(old.keyVersion, 1);
  assert.equal(vault.needsReseal(old, before), false);
  assert.equal(vault.needsReseal(old, after), true);
  const plain = vault.open(old, ctx, after);
  assert.equal(plain, TOKEN);
  const fresh = vault.seal(plain, ctx, after);
  assert.equal(fresh.keyVersion, 2);
  assert.equal(vault.needsReseal(fresh, after), false);
  // once the old key is retired the re-sealed row still opens and the old one does not
  const retired = { LINKED_ACCOUNTS_KEYS: JSON.stringify({ 2: k2 }), LINKED_ACCOUNTS_KEY_CURRENT: '2' };
  assert.equal(vault.open(fresh, ctx, retired), TOKEN);
  assert.throws(() => vault.open(old, ctx, retired), (e) => e.code === 'UNKNOWN_KEY');
});

test('missing configuration: unconfigured, never a plaintext fallback', () => {
  for (const env of [{}, { LINKED_ACCOUNTS_KEYS: JSON.stringify({ 1: k() }) }, { LINKED_ACCOUNTS_KEY_CURRENT: '1' }]) {
    assert.equal(vault.isConfigured(env), false);
    assert.throws(() => vault.seal(TOKEN, ctx, env), (e) => e.code === 'UNCONFIGURED');
  }
  assert.equal(vault.isConfigured(ENV1), true);
});

test('malformed configuration is reported as unusable', () => {
  const short = Buffer.alloc(16, 1).toString('base64');
  const long = Buffer.alloc(33, 1).toString('base64');
  const cases = [
    { LINKED_ACCOUNTS_KEYS: 'not json', LINKED_ACCOUNTS_KEY_CURRENT: '1' },
    { LINKED_ACCOUNTS_KEYS: '[]', LINKED_ACCOUNTS_KEY_CURRENT: '1' },
    { LINKED_ACCOUNTS_KEYS: JSON.stringify({ 1: short }), LINKED_ACCOUNTS_KEY_CURRENT: '1' },
    { LINKED_ACCOUNTS_KEYS: JSON.stringify({ 1: long }), LINKED_ACCOUNTS_KEY_CURRENT: '1' },
    { LINKED_ACCOUNTS_KEYS: JSON.stringify({ 1: '!!!notbase64!!!' }), LINKED_ACCOUNTS_KEY_CURRENT: '1' },
    { LINKED_ACCOUNTS_KEYS: JSON.stringify({ one: k() }), LINKED_ACCOUNTS_KEY_CURRENT: 'one' },
    { LINKED_ACCOUNTS_KEYS: JSON.stringify({ 1: k() }), LINKED_ACCOUNTS_KEY_CURRENT: '2' },
  ];
  for (const env of cases) {
    assert.equal(vault.isConfigured(env), false, JSON.stringify(env));
    assert.throws(() => vault.seal(TOKEN, ctx, env), (e) => e.name === 'VaultError' && (e.code === 'BAD_KEY' || e.code === 'UNCONFIGURED'));
  }
});

test('errors never carry the plaintext or key material', () => {
  const keyB64 = k();
  const env = { LINKED_ACCOUNTS_KEYS: JSON.stringify({ 1: keyB64 }), LINKED_ACCOUNTS_KEY_CURRENT: '1' };
  const s = vault.seal(TOKEN, ctx, env);
  let err;
  try { vault.open({ ...s, ct: Buffer.concat([Buffer.from([s.ct[0] ^ 1]), s.ct.slice(1)]) }, ctx, env); } catch (e) { err = e; }
  assert.ok(err);
  const text = err.message + ' ' + err.stack;
  assert.ok(!text.includes(TOKEN) && !text.includes(keyB64));
});
