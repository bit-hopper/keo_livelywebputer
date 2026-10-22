// Import logic (core/lively/gaming/GamingImport.js): pure client-side code, loaded here with
// a stub of Lively's module() so the real file is what is tested. Covers what an import
// offers and what it refuses to touch (the owner's own status, rating, review, visibility
// and typed playtime), and the write queue that runs it.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Runs in this realm (not a separate vm context) so arrays and objects share prototypes
// with the test's own and deepEqual can compare them.
function load() {
  const file = path.join(__dirname, '../../core/lively/gaming/GamingImport.js');
  const saved = { lively: global.lively, module: global.module };
  global.lively = { gaming: {} };
  global.module = () => ({ requires: () => ({ toRun: (fn) => fn() }) });
  try {
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
    return global.lively.gaming.GamingImport;
  } finally {
    global.lively = saved.lively;
    global.module = saved.module;
  }
}

const G = load();
// fieldsOf / plan reach back through the global namespace (lively.gaming.GamingImport.x),
// which is how they run in the browser, so it has to exist for the tests too.
global.lively = { gaming: { GamingImport: G } };

const NOW = Date.parse('2026-10-21T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const SYNCED = '2026-10-21T12:00:00.000Z';

const steam = (id, name, extra) => Object.assign({ platform: 'steam', external_id: String(id), name, cover_url: null, playtime_minutes: 0, last_played_at: null, url: null }, extra);
const itch = (id, name, extra) => Object.assign({ platform: 'itch', external_id: String(id), name, cover_url: null, playtime_minutes: null, last_played_at: null, url: null }, extra);

// A library entry as GameLog hands it out ({ payload, ... }), with every personal field set so
// a test can prove a refresh left them alone.
const entry = (ids, over) => ({
  objId: 'obj-' + Object.values(ids).join('-'), did: 'did:me', visibility: 'private',
  payload: Object.assign({
    title: 'T', external_ids: ids, status: 'completed', rating: 4, review: 'loved it',
    playtime_minutes: 60, playtime_source: 'steam', manual_playtime_minutes: 999, last_played_at: iso(100 * DAY),
    last_synced_at: '2026-01-01T00:00:00.000Z',
  }, over),
});

// ─── status suggestion ─────────────────────────────────────────────────────

test('suggestStatus: played in the last 14 days is Playing, anything else Backlog', () => {
  assert.equal(G.suggestStatus(steam(1, 'A', { last_played_at: iso(2 * DAY) }), NOW), 'playing');
  assert.equal(G.suggestStatus(steam(1, 'A', { last_played_at: iso(14 * DAY) }), NOW), 'playing');
  assert.equal(G.suggestStatus(steam(1, 'A', { last_played_at: iso(15 * DAY) }), NOW), 'backlog');
  assert.equal(G.suggestStatus(steam(1, 'A', { last_played_at: iso(400 * DAY) }), NOW), 'backlog');
});

test('suggestStatus: unknown, unparseable or future times are Backlog; it never guesses Completed', () => {
  assert.equal(G.suggestStatus(steam(1, 'A'), NOW), 'backlog');
  assert.equal(G.suggestStatus(steam(1, 'A', { last_played_at: 'not a date' }), NOW), 'backlog');
  assert.equal(G.suggestStatus(steam(1, 'A', { last_played_at: iso(-30 * DAY) }), NOW), 'backlog');
  assert.equal(G.suggestStatus(steam(1, 'A', { playtime_minutes: 100000 }), NOW), 'backlog');
  assert.equal(G.suggestStatus(null, NOW), 'backlog');
});

// ─── new entries ───────────────────────────────────────────────────────────

test('fieldsOf: imported facts filled in, nothing personal set, source named with the playtime', () => {
  const f = G.fieldsOf(steam(570, '  Dota 2 ', { cover_url: 'https://x/c.jpg', playtime_minutes: 125.4, last_played_at: iso(DAY) }), SYNCED, NOW);
  assert.equal(f.title, 'Dota 2');
  assert.deepEqual(f.external_ids, { steam: '570' });
  assert.deepEqual(f.platforms, ['Steam']);
  assert.equal(f.cover_url, 'https://x/c.jpg');
  assert.equal(f.cover_source, 'steam');
  assert.equal(f.playtime_minutes, 125);
  assert.equal(f.playtime_source, 'steam');
  assert.equal(f.status, 'playing');
  assert.equal(f.last_synced_at, SYNCED);
  assert.equal('rating' in f, false);
  assert.equal('review' in f, false);
  assert.equal('manual_playtime_minutes' in f, false);
  assert.equal(f.last_activity.kind, 'added');
});

test('fieldsOf: a store with no playtime leaves the number AND its source empty', () => {
  const f = G.fieldsOf(itch(341190, 'Some Game'), SYNCED, NOW);
  assert.equal(f.playtime_minutes, null);
  assert.equal(f.playtime_source, null);
  assert.equal(f.cover_source, null);
  assert.deepEqual(f.external_ids, { itch: '341190' });
  assert.deepEqual(f.platforms, ['itch.io']);
});

test('fieldsOf: zero playtime is a real value from the store, kept with its source', () => {
  const f = G.fieldsOf(steam(1, 'Unplayed', { playtime_minutes: 0 }), SYNCED, NOW);
  assert.equal(f.playtime_minutes, 0);
  assert.equal(f.playtime_source, 'steam');
});

// ─── refreshing existing entries ───────────────────────────────────────────

test('refreshChanges: updates only imported facts, never the owner\'s own', () => {
  const e = entry({ steam: '10' });
  const ch = G.refreshChanges(e.payload, steam(10, 'T', { playtime_minutes: 300, last_played_at: iso(DAY) }), SYNCED);
  assert.deepEqual(Object.keys(ch).sort(), ['last_played_at', 'last_synced_at', 'playtime_minutes', 'playtime_source']);
  for (const own of ['status', 'rating', 'review', 'visibility', 'manual_playtime_minutes', 'title', 'cover_url']) {
    assert.equal(own in ch, false, own + ' must not be in a refresh');
  }
  assert.equal(ch.playtime_minutes, 300);
  assert.equal(ch.last_synced_at, SYNCED);
});

test('refreshChanges: null when nothing the store supplies has changed (no pointless rewrite)', () => {
  const e = entry({ steam: '10' }, { playtime_minutes: 60, last_played_at: iso(100 * DAY) });
  assert.equal(G.refreshChanges(e.payload, steam(10, 'T', { playtime_minutes: 60, last_played_at: iso(100 * DAY) }), SYNCED), null);
});

test('refreshChanges: a store with no playtime cannot wipe an existing number', () => {
  const e = entry({ steam: '10' }, { playtime_minutes: 60 });
  assert.equal(G.refreshChanges(e.payload, steam(10, 'T', { playtime_minutes: null, last_played_at: null }), SYNCED), null);
});

// ─── planning ──────────────────────────────────────────────────────────────

test('plan: new games are offered, known ones are matched by the store id, not the title', () => {
  const lib = [entry({ steam: '10' }, { title: 'Old Name' })];
  const p = G.plan([steam(10, 'Renamed By Store', { playtime_minutes: 60, last_played_at: iso(100 * DAY) }), steam(11, 'Brand New')], lib, { syncedAt: SYNCED });
  assert.deepEqual(p.fresh.map((c) => c.external_id), ['11']);
  assert.equal(p.refresh.length, 0);
  assert.equal(p.unchanged, 1);
  assert.equal(p.total, 2);
});

test('plan: the same id on a different store is a different game', () => {
  const lib = [entry({ steam: '10' })];
  const p = G.plan([itch(10, 'Other Store Same Number')], lib, {});
  assert.equal(p.fresh.length, 1);
});

test('plan: a game added by hand (no store id) is not matched, so it is offered, not merged', () => {
  const lib = [{ objId: 'h', payload: { title: 'Hades', external_ids: {} } }];
  const p = G.plan([steam(1145360, 'Hades')], lib, {});
  assert.equal(p.fresh.length, 1);
  assert.equal(p.refresh.length, 0);
});

test('plan: a matched game whose playtime grew is a refresh, with the patch ready', () => {
  const lib = [entry({ steam: '10' }, { playtime_minutes: 60 })];
  const p = G.plan([steam(10, 'T', { playtime_minutes: 90 })], lib, { syncedAt: SYNCED });
  assert.equal(p.fresh.length, 0);
  assert.equal(p.refresh.length, 1);
  assert.equal(p.refresh[0].changes.playtime_minutes, 90);
  assert.equal(p.refresh[0].entry, lib[0]);
});

test('plan: repeated candidates count once; a later one with playtime replaces one without', () => {
  const p = G.plan([itch(5, 'Twice'), itch(5, 'Twice', { playtime_minutes: 30 }), itch(5, 'Twice', { playtime_minutes: 999 })], [], {});
  assert.equal(p.fresh.length, 1);
  assert.equal(p.fresh[0].playtime_minutes, 30);
  assert.equal(p.total, 3);
});

test('plan: unusable candidates are skipped and counted, not thrown on', () => {
  const p = G.plan([steam('', 'No Id'), steam(2, '   '), null, { external_id: '3', name: 'No platform' }, steam(4, 'Fine')], [], {});
  assert.equal(p.skipped, 4);
  assert.deepEqual(p.fresh.map((c) => c.name), ['Fine']);
});

test('plan: empty and missing inputs are fine', () => {
  assert.deepEqual(G.plan([], [], {}).fresh, []);
  assert.equal(G.plan(undefined, undefined).total, 0);
});

// ─── write queue ───────────────────────────────────────────────────────────

const jobs = (n) => Array.from({ length: n }, (_, i) => ({ i }));

test('runWrites: never more than `concurrency` writes at once, and every job runs once', async () => {
  let running = 0, peak = 0; const ran = [];
  const summary = await new Promise((resolve) => G.runWrites(jobs(25), {
    concurrency: 4,
    write(job, cb) { running++; peak = Math.max(peak, running); ran.push(job.i); setTimeout(() => { running--; cb(null); }, 2); },
  }, resolve));
  assert.equal(peak, 4);
  assert.deepEqual(ran.slice().sort((a, b) => a - b), jobs(25).map((j) => j.i));
  assert.equal(summary.written, 25);
  assert.equal(summary.failed.length, 0);
});

test('runWrites: synchronous callbacks for thousands of jobs do not overflow the stack', async () => {
  const summary = await new Promise((resolve) => G.runWrites(jobs(20000), { write: (job, cb) => cb(null) }, resolve));
  assert.equal(summary.written, 20000);
});

test('runWrites: progress counts every finished job, ending at the total', async () => {
  const seen = [];
  await new Promise((resolve) => G.runWrites(jobs(7), { write: (j, cb) => setTimeout(() => cb(null), 1), onProgress: (n, t) => seen.push([n, t]) }, resolve));
  assert.equal(seen.length, 7);
  assert.deepEqual(seen[6], [7, 7]);
  assert.deepEqual(seen.map((s) => s[0]), [1, 2, 3, 4, 5, 6, 7]);
});

test('runWrites: shouldSkip is asked right before each write, so a job done meanwhile is not written twice', async () => {
  const done = new Set(); const writes = [];
  const list = [{ k: 'a' }, { k: 'b' }, { k: 'a' }, { k: 'c' }, { k: 'b' }];        // the same key twice
  const summary = await new Promise((resolve) => G.runWrites(list, {
    concurrency: 1,
    shouldSkip: (j) => done.has(j.k),
    write(j, cb) { writes.push(j.k); setTimeout(() => { done.add(j.k); cb(null); }, 1); },
  }, resolve));
  assert.deepEqual(writes, ['a', 'b', 'c']);
  assert.equal(summary.written, 3);
  assert.equal(summary.skipped, 2);
});

test('runWrites: a failure is recorded and does not stop the others', async () => {
  const summary = await new Promise((resolve) => G.runWrites(jobs(6), {
    write: (j, cb) => setTimeout(() => cb(j.i === 2 ? new Error('boom') : null), 1),
  }, resolve));
  assert.equal(summary.written, 5);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].job.i, 2);
  assert.equal(summary.failed[0].error.message, 'boom');
});

test('runWrites: a write that throws counts as a failure; a second callback is ignored', async () => {
  const summary = await new Promise((resolve) => G.runWrites(jobs(3), {
    write(j, cb) { if (j.i === 0) throw new Error('threw'); cb(null); if (j.i === 1) cb(new Error('late')); },
  }, resolve));
  assert.equal(summary.written, 2);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].error.message, 'threw');
});

test('runWrites: cancelling stops new writes, lets the ones in flight settle, and says so', async () => {
  let cancel = false; const started = [];
  const summary = await new Promise((resolve) => G.runWrites(jobs(40), {
    concurrency: 4,
    isCancelled: () => cancel,
    write(j, cb) { started.push(j.i); if (started.length === 6) cancel = true; setTimeout(() => cb(null), 2); },
  }, resolve));
  assert.equal(summary.cancelled, true);
  assert.equal(started.length, summary.written);
  assert.ok(started.length >= 6 && started.length < 40);
});

test('runWrites: no jobs finishes at once', async () => {
  const summary = await new Promise((resolve) => G.runWrites([], { write: () => assert.fail('no write expected') }, resolve));
  assert.equal(summary.written, 0);
});
