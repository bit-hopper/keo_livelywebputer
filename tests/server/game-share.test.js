// Sharing logic of the Gaming template's data layer (core/lively/gaming/GameLog.js): which
// facts a postcard about a game carries, and how a save decides WHO an entry is sealed to
// (the ordering rules that keep a half-finished change from leaving a game open to people or
// quietly sharing it again). Loaded with a stub of Lively's module() so the real files are
// what is tested; the audience machinery is replaced by recorders. The cryptography and the
// real server are covered by tests/e2e/gaming-sharing.spec.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Loads GameLog.js and AudienceRules.js into one fake `lively`, in this realm so deepEqual works.
function load() {
  const saved = { lively: global.lively, module: global.module, extend: Object.extend };
  global.lively = { gaming: {}, identity: {} };
  Object.extend = (dest, src) => Object.assign(dest, src);
  global.module = (name) => {
    // module('a.b.C') makes the namespace object a.b.C, as Lively's module() does
    const parts = name.split('.');
    let o = global;
    parts.forEach((p) => { o[p] = o[p] || {}; o = o[p]; });
    return { requires: () => ({ toRun: (fn) => fn() }) };
  };
  try {
    for (const f of ['core/lively/identity/AudienceRules.js', 'core/lively/gaming/GameLog.js']) {
      const file = path.join(__dirname, '../../', f);
      vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
    }
    return { GL: global.lively.gaming.GameLog, rules: global.lively.identity.AudienceRules };
  } finally {
    global.module = saved.module;
    if (saved.extend) Object.extend = saved.extend; else delete Object.extend;
  }
}

const { GL } = load();   // leaves global.lively in place: _sharing reaches AudienceRules through it

// What the owner's settings and friends look like to the audience helpers.
function ctxOf(extra) {
  return Object.assign({
    ownerDid: 'did:me', friendDids: ['did:a', 'did:b'], orbitDids: ['did:a'], lists: [],
    handleByDid: { 'did:a': 'ann', 'did:b': 'bo' }, cardAudiences: {},
  }, extra || {});
}

// Replaces the audience helpers with recorders. Returns the log.
function stubAudience(ctx) {
  const log = { loads: 0, recorded: [] };
  global.lively.identity.postcardAudience = {
    loadContext: (cb) => { log.loads++; cb(null, JSON.parse(JSON.stringify(ctx))); },
    setCardAudience: (objId, audience, cb) => { log.recorded.push({ objId, audience }); cb(null); },
  };
  GL.forgetContext();
  return log;
}

const sharing = (entry, visibility, audience) => new Promise((res, rej) => GL._sharing(entry, visibility, audience, (e, v) => (e ? rej(e) : res(v))));
const entryOf = (visibility) => ({ objId: 'obj1', visibility });

// ─── what a postcard carries ────────────────────────────────────────────────

const PAYLOAD = GL.defaults({
  title: 'Moon Quest', cover_url: 'https://img.example/h.jpg', igdb_id: 4242, status: 'playing', rating: 4,
  review: 'Escaping never gets dull.', playtime_minutes: 600, playtime_source: 'steam', manual_playtime_minutes: 30,
});

test('shareBlock: title, cover, id and status always; rating and playtime only when chosen', () => {
  assert.deepEqual(GL.shareBlock(PAYLOAD, {}), { title: 'Moon Quest', cover_url: 'https://img.example/h.jpg', igdb_id: 4242, status: 'playing' });
  assert.deepEqual(GL.shareBlock(PAYLOAD, { rating: true }), { title: 'Moon Quest', cover_url: 'https://img.example/h.jpg', igdb_id: 4242, status: 'playing', rating: 4 });
  const both = GL.shareBlock(PAYLOAD, { rating: true, playtime: true });
  assert.equal(both.playtime_minutes, 600);
  assert.equal(both.playtime_source, 'steam');
});

test('shareBlock: never carries the review, and leaves out what does not exist', () => {
  const all = GL.shareBlock(PAYLOAD, { rating: true, playtime: true });
  assert.equal(JSON.stringify(all).includes('Escaping'), false);
  const bare = GL.defaults({ title: 'Untouched' });
  const b = GL.shareBlock(bare, { rating: true, playtime: true });
  assert.equal('rating' in b, false);                 // not rated: no rating even when asked
  assert.equal('playtime_minutes' in b, false);       // no playtime: none even when asked
  assert.equal(b.cover_url, null);
});

test('shareBlock: playtime keeps its source, a typed value says it was typed', () => {
  const typed = GL.defaults({ title: 'T', manual_playtime_minutes: 90 });
  const b = GL.shareBlock(typed, { playtime: true });
  assert.equal(b.playtime_minutes, 90);
  assert.equal(b.playtime_source, 'manual');
});

test('shareText: one line for what happened, then the review as its own paragraph', () => {
  assert.deepEqual(GL.shareText(GL.defaults({ title: 'Moon Quest', status: 'playing', review: '' })), ['Just started Moon Quest']);
  assert.deepEqual(GL.shareText(GL.defaults({ title: 'Moon Quest', status: 'completed', review: '  Loved it. ' })), ['Finished Moon Quest', 'Loved it.']);
  assert.deepEqual(GL.shareText(GL.defaults({ title: 'Moon Quest', status: 'wishlist' })), ['Wishlisting Moon Quest']);
});

// ─── who a save is sealed to ────────────────────────────────────────────────

test('_sharing: private to public (and back) never touches the friend list or the settings', async () => {
  const log = stubAudience(ctxOf());
  for (const [from, to] of [['private', 'public'], ['public', 'private'], ['private', 'private'], ['public', 'public']]) {
    assert.deepEqual(await sharing(entryOf(from), to, null), { audience: null, dids: [], ctx: null, clearAfter: false });
  }
  assert.equal(log.loads, 0);
  assert.deepEqual(log.recorded, []);
});

test('_sharing: sharing records the audience, seals to the union and reads the friend list fresh', async () => {
  const log = stubAudience(ctxOf({ lists: [{ id: 'l1', name: 'Raid', memberDids: ['did:b'] }] }));
  const r = await sharing(entryOf('private'), 'shared', { tiers: ['orbit', 'list:l1'], people: [] });
  assert.deepEqual(r.dids.sort(), ['did:a', 'did:b']);
  assert.deepEqual(r.audience, { tiers: ['orbit', 'list:l1'], people: [] });
  assert.equal(r.clearAfter, false);
  assert.deepEqual(log.recorded, [{ objId: 'obj1', audience: { tiers: ['orbit', 'list:l1'], people: [] } }]);
  assert.equal(log.loads, 1);
});

test('_sharing: only friends can be sealed to, however the audience names them', async () => {
  stubAudience(ctxOf());
  const r = await sharing(entryOf('private'), 'shared', { tiers: [], people: ['did:a', 'did:stranger', 'did:me'] });
  assert.deepEqual(r.dids, ['did:a']);
});

test('_sharing: leaving shared names NOBODY first and asks for the record to be removed after the write', async () => {
  const log = stubAudience(ctxOf({ cardAudiences: { obj1: { tiers: ['friends'], people: [] } } }));
  const r = await sharing(entryOf('shared'), 'private', null);
  assert.deepEqual(r, { audience: null, dids: [], ctx: null, clearAfter: true });
  assert.deepEqual(log.recorded, [{ objId: 'obj1', audience: { tiers: [], people: [] } }]);   // never a bare delete first
  const pub = await sharing(entryOf('shared'), 'public', null);
  assert.equal(pub.clearAfter, true);
});

test('_sharing: leaving shared with nothing recorded has nothing to clear', async () => {
  const log = stubAudience(ctxOf());
  assert.deepEqual(await sharing(entryOf('shared'), 'private', null), { audience: null, dids: [], ctx: null, clearAfter: false });
  assert.deepEqual(log.recorded, []);
});

test('_sharing: an ordinary edit of a shared game keeps its recorded audience and reuses the friend list for a minute', async () => {
  const log = stubAudience(ctxOf({ cardAudiences: { obj1: { tiers: ['friends'], people: [] } } }));
  const a = await sharing(entryOf('shared'), 'shared', null);
  assert.deepEqual(a.dids.sort(), ['did:a', 'did:b']);
  assert.deepEqual(log.recorded, []);                  // an edit does not rewrite the settings
  await sharing(entryOf('shared'), 'shared', null);
  assert.equal(log.loads, 1);                          // second edit: served from the short-lived copy
  GL.forgetContext();
  await sharing(entryOf('shared'), 'shared', null);
  assert.equal(log.loads, 2);                          // forgotten: read again
});

test('_sharing: a change of audience always reads fresh, and a failure to load stops the save', async () => {
  const ctx = ctxOf({ cardAudiences: { obj1: { tiers: ['friends'], people: [] } } });
  const log = stubAudience(ctx);
  await sharing(entryOf('shared'), 'shared', null);
  await sharing(entryOf('shared'), 'shared', { tiers: ['orbit'], people: [] });
  assert.equal(log.loads, 2);
  global.lively.identity.postcardAudience.loadContext = (cb) => cb(new Error('offline'));
  GL.forgetContext();
  await assert.rejects(sharing(entryOf('shared'), 'shared', null), /offline/);   // never guess who to seal to
});

test('_sharing: a failure to record the audience stops the save before anything is written', async () => {
  stubAudience(ctxOf());
  global.lively.identity.postcardAudience.setCardAudience = (o, a, cb) => cb(new Error('settings refused'));
  await assert.rejects(sharing(entryOf('private'), 'shared', { tiers: ['friends'], people: [] }), /settings refused/);
});
