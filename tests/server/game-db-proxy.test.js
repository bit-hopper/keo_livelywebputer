// GameDbProxyServer: the pure parts (normalisation, query quoting) and the
// unconfigured behaviour (503 with a clear message, no throw). No network, no
// credentials: the live provider calls are not covered here.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

// Make sure the module sees NO credentials whatever this machine has set up, so the
// "unconfigured" tests are about the code and not about the local environment.
delete process.env.IGDB_CLIENT_ID;
delete process.env.IGDB_CLIENT_SECRET;
process.env.WORKSPACE_LK = os.tmpdir() + '/no-such-workspace-for-game-db-test';
const proxy = require('../../core/servers/GameDbProxyServer.js');

test('normalizeGame: a full provider record becomes the stored shape', () => {
  const g = proxy._normalizeGame({
    id: 1942, name: 'Sample Quest: First Light', first_release_date: 1431993600,
    cover: { id: 1, image_id: 'co1wyy' }, genres: [{ name: 'Role-playing (RPG)' }, { name: 'Adventure' }],
    involved_companies: [{ developer: false, company: { name: 'Publisher Co' } }, { developer: true, company: { name: 'Example Studio' } }],
    platforms: [{ abbreviation: 'PC' }, { name: 'Handheld One' }]
  });
  assert.deepEqual(g, {
    igdb_id: 1942, title: 'Sample Quest: First Light', year: 2015, genre: 'Role-playing (RPG)', studio: 'Example Studio',
    platforms: ['PC', 'Handheld One'], cover_url: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1wyy.jpg'
  });
});

test('normalizeGame: every optional field may be missing', () => {
  const g = proxy._normalizeGame({ id: 7, name: 'Bare' });
  assert.deepEqual(g, { igdb_id: 7, title: 'Bare', year: null, genre: null, studio: null, platforms: [], cover_url: null });
});

test('normalizeGame: with no developer flagged the first company is used; junk is rejected', () => {
  assert.equal(proxy._normalizeGame({ id: 1, name: 'x', involved_companies: [{ company: { name: 'First' } }] }).studio, 'First');
  assert.equal(proxy._normalizeGame(null), null);
  assert.equal(proxy._normalizeGame({ id: 'nope', name: 'x' }), null);
  assert.equal(proxy._normalizeGame({ id: 1 }), null);
});

test('normalizeGame: an image id that is not plain alphanumerics never becomes a URL', () => {
  assert.equal(proxy._normalizeGame({ id: 1, name: 'x', cover: { image_id: '../../evil' } }).cover_url, null);
});

test('quoteForQuery: quotes and backslashes cannot break out of the string literal', () => {
  assert.equal(proxy._quoteForQuery('zelda'), '"zelda"');
  assert.equal(proxy._quoteForQuery('say "hi"'), '"say \\"hi\\""');
  assert.equal(proxy._quoteForQuery('a\\b'), '"a\\\\b"');
  assert.equal(proxy._quoteForQuery('x"; fields *; where id > 0; "'), '"x\\"; fields *; where id > 0; \\""');
  assert.equal(proxy._quoteForQuery('line\nbreak'), '"line break"');
  assert.equal(proxy._quoteForQuery('a'.repeat(500)).length, 102);
});

// A stand-in for the old Express app: records handlers by path, ignoring the auth step.
function mount() {
  const routes = {};
  proxy('/nodejs/GameDbProxyServer/', { get: (p, ...fns) => { routes[p] = fns[fns.length - 1]; } });
  return routes;
}
function call(handler, req) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); }, end(t) { resolve({ status: this.statusCode, body: t }); } };
    handler(Object.assign({ query: {}, params: {} }, req), res);
  });
}

test('unconfigured: /status says so, and every data route answers 503 with a message instead of throwing', async () => {
  const r = mount();
  assert.deepEqual((await call(r['/nodejs/GameDbProxyServer/status'])).body, { configured: false });
  for (const [p, req] of [['search', { query: { q: 'zelda' } }], ['popular', {}], ['game/:id', { params: { id: '5' } }]]) {
    const out = await call(r['/nodejs/GameDbProxyServer/' + p], req);
    assert.equal(out.status, 503, p);
    assert.equal(out.body.configured, false);
    assert.match(out.body.error, /not configured/);
  }
});

test('an empty search returns no games without touching the provider', async () => {
  const r = mount();
  assert.deepEqual((await call(r['/nodejs/GameDbProxyServer/search'], { query: { q: '   ' } })).body, { games: [] });
});

test('a bad game id is a 400, not a provider call', async () => {
  const r = mount();
  assert.equal((await call(r['/nodejs/GameDbProxyServer/game/:id'], { params: { id: 'abc' } })).status, 400);
  assert.equal((await call(r['/nodejs/GameDbProxyServer/game/:id'], { params: { id: '0' } })).status, 400);
});
