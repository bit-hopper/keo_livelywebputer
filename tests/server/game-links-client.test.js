// GameLinks client (core/lively/gaming/GameLinks.js): the real file loaded with a stub of
// Lively's module() and a fake fetch. Checks what is sent (cookie, JSON accept header, POST for
// sync) and that every kind of failure becomes a stable code the dialog can word itself.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const file = path.join(__dirname, '../../core/lively/gaming/GameLinks.js');
  const saved = { lively: global.lively, module: global.module };
  global.lively = { gaming: {} };
  global.module = () => ({ requires: () => ({ toRun: (fn) => fn() }) });
  try {
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
    return global.lively.gaming.GameLinks;
  } finally {
    global.lively = saved.lively;
    global.module = saved.module;
  }
}
const L = load();

// Installs a fake fetch that answers `reply` ({status, body} or {reject}) and records calls.
function fakeFetch(reply) {
  const calls = [];
  global.fetch = (url, opts) => {
    calls.push({ url, opts });
    if (reply.reject) return Promise.reject(new Error(reply.reject));
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: () => (reply.body === undefined ? Promise.reject(new Error('not json')) : Promise.resolve(reply.body)),
    });
  };
  return calls;
}
const call = (fn, ...args) => new Promise((resolve) => fn.call(L, ...args, (err, res) => resolve({ err, res })));

test('status: GET with the cookie and a JSON accept header', async () => {
  const calls = fakeFetch({ status: 200, body: { providers: {}, accounts: [] } });
  const { err, res } = await call(L.status);
  assert.equal(err, null);
  assert.deepEqual(res, { providers: {}, accounts: [] });
  assert.equal(calls[0].url, '/nodejs/GameLinkServer/status');
  assert.equal(calls[0].opts.method, 'GET');
  assert.equal(calls[0].opts.credentials, 'include');
  assert.equal(calls[0].opts.headers.Accept, 'application/json');
});

test('sync: POSTs to the store\'s own route and normalises the answer', async () => {
  const calls = fakeFetch({ status: 200, body: { candidates: [{ platform: 'steam', external_id: '1', name: 'A' }], partial: true, warnings: ['private'] } });
  const { err, res } = await call(L.sync, 'steam');
  assert.equal(err, null);
  assert.equal(calls[0].url, '/nodejs/GameLinkServer/steam/sync');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(res.platform, 'steam');
  assert.equal(res.total, 1);
  assert.equal(res.partial, true);
  assert.deepEqual(res.warnings, ['private']);
  assert.ok(Date.parse(res.fetched_at));
});

test('sync: the platform name is encoded, so it cannot reach another route', async () => {
  const calls = fakeFetch({ status: 404, body: { error: 'unknown platform' } });
  await call(L.sync, '../status');
  assert.equal(calls[0].url, '/nodejs/GameLinkServer/..%2Fstatus/sync');
});

test('failures map to codes: signin, not_linked, rate_limited (with retry), unavailable, upstream', async () => {
  const cases = [
    [401, {}, 'signin'], [404, {}, 'not_linked'], [429, { retry_after: 42 }, 'rate_limited'],
    [503, {}, 'unavailable'], [502, {}, 'upstream'], [504, {}, 'upstream'], [418, {}, 'unknown'],
  ];
  for (const [status, body, code] of cases) {
    fakeFetch({ status, body });
    const { err } = await call(L.sync, 'steam');
    assert.equal(err.code, code, 'status ' + status);
    assert.equal(err.status, status);
  }
  fakeFetch({ status: 429, body: { retry_after: 42 } });
  assert.equal((await call(L.sync, 'steam')).err.retryAfter, 42);
  fakeFetch({ status: 429, body: {} });
  assert.equal((await call(L.sync, 'steam')).err.retryAfter, null);
});

test('a code the server names itself wins over the status (needs_reconnect arrives as a 4xx)', async () => {
  fakeFetch({ status: 409, body: { code: 'needs_reconnect', error: 'the store refused the saved link' } });
  assert.equal((await call(L.sync, 'itch')).err.code, 'needs_reconnect');
});

test('an OK answer with no candidate list, or no JSON at all, is an upstream failure, not success', async () => {
  fakeFetch({ status: 200, body: { nothing: true } });
  assert.equal((await call(L.sync, 'steam')).err.code, 'upstream');
  fakeFetch({ status: 200 });
  assert.equal((await call(L.sync, 'steam')).err.code, 'upstream');
});

test('a request that never completes is a network failure', async () => {
  fakeFetch({ reject: 'offline' });
  const { err } = await call(L.sync, 'steam');
  assert.equal(err.code, 'network');
  assert.equal(err.status, null);
});

test('syncable: only accounts whose link is active', () => {
  const s = { accounts: [{ platform: 'steam', status: 'active' }, { platform: 'itch', status: 'needs_reconnect' }] };
  assert.deepEqual(L.syncable(s).map((a) => a.platform), ['steam']);
  assert.deepEqual(L.syncable(null), []);
});
