// PostcardAudience.js orchestration (core/lively/identity/PostcardAudience.js),
// run in node with the network, crypto and signing stubbed. This checks the control
// flow and what is written (same cid, new recipients, signature dropped and redone,
// visibility, the coarse mirror); the real sealing and signing need a browser and a
// passkey and are checked live.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ME = 'did:me';
const user = { did: ME, handle: 'me', credentialId: 'cred', rpId: 'localhost' };

// Builds a fresh world: stub globals, the two real client files loaded into it, and a
// fake server keyed by "METHOD path". Returns helpers to inspect what was sent.
function setup(serverState) {
  // Node's global crypto is a getter-only property, so it is swapped with
  // defineProperty and put back with its original descriptor.
  const names = ['lively', 'module', 'fetch', 'crypto'];
  const saved = {};
  names.forEach((n) => { saved[n] = Object.getOwnPropertyDescriptor(global, n); });

  const requests = [];
  const calls = { unwrap: 0, seal: [], sign: 0, kek: 0 };

  const lively = {
    identity: {
      did: { currentUser: () => user, baseUrl: () => '' },
      crypto: {
        computeCid: (payload, cb) => cb(null, 'cid-of-' + JSON.stringify(payload)),
        unwrapDek: (wrapped, kek, cb) => { calls.unwrap++; cb(null, 'DEK'); },
        sealForRecipient: (dek, pub, cb) => { calls.seal.push(pub); cb(null, 'sealed-with-' + pub); }
      },
      webAuthn: { deriveKek: (opts, cb) => { calls.kek++; cb(null, 'KEK'); } },
      envelopeSigning: {
        signEnvelopeIfPossible: (env, u, c, cb) => {
          calls.sign++;
          if (serverState.signError) return cb(new Error('passkey cancelled'));
          cb(null, Object.assign({}, env, { sig: 'new-sig' }));
        }
      }
    }
  };
  // Object.subclass('a.b.C', { methods }) -> constructor placed at that path.
  global.Object.subclass = function (name, methods) {
    const parts = name.split('.');
    let target = global;
    parts.slice(0, -1).forEach((p) => { target = target[p]; });
    const ctor = function () {};
    Object.assign(ctor.prototype, methods);
    target[parts[parts.length - 1]] = ctor;
  };
  global.lively = lively;
  global.module = () => ({ requires: () => ({ toRun: (fn) => fn() }) });
  Object.defineProperty(global, 'crypto', { value: { getRandomValues: (a) => a }, writable: true, configurable: true });
  global.fetch = (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
    requests.push({ method, url, body, headers: (opts && opts.headers) || {} });
    const handler = serverState.routes[method + ' ' + url];
    const r = handler ? handler(body) : { status: 404, json: { error: 'no route' } };
    return Promise.resolve({ status: r.status, text: () => Promise.resolve(r.json === undefined ? '' : JSON.stringify(r.json)) });
  };

  ['AudienceRules.js', 'PostcardAudience.js'].forEach((f) => {
    const file = path.join(__dirname, '../../core/lively/identity', f);
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  });
  const api = lively.identity.postcardAudience;

  return {
    api, requests, calls,
    puts: () => requests.filter((r) => r.method === 'PUT'),
    restore: () => {
      names.forEach((n) => {
        if (saved[n]) Object.defineProperty(global, n, saved[n]); else delete global[n];
      });
      delete global.Object.subclass;
    }
  };
}

const call = (fn, ...args) => new Promise((resolve, reject) => {
  fn(...args, (err, result) => (err ? reject(err) : resolve(result)));
});

function profileEnvelope(did, pub) {
  const payload = { accountX25519Pub: pub };
  return { status: 200, json: { did, record: { payload, cid: 'cid-of-' + JSON.stringify(payload) } } };
}

function card(overrides) {
  return Object.assign({
    objId: 'card1', did: ME, type: 'postcard', visibility: 'shared', created: '2026-10-01T00:00:00Z',
    record: { cid: 'C1', prevCid: null, payload: 'ciphertext', nonce: 'n', wrappedDek: 'wrapped',
              recipients: [{ did: 'did:a', sealedDek: 'sealed-with-pubA' }] },
    state: { title: 'Hello' }, sig: 'old-sig'
  }, overrides);
}

function ctxFor(over) {
  return Object.assign({
    ownerDid: ME, handle: 'me',
    friendDids: ['did:a', 'did:b'], orbitDids: ['did:a'],
    handleByDid: { 'did:a': 'ann', 'did:b': 'bo' },
    lists: [], cardAudiences: { card1: { tiers: ['friends'], people: [] } }
  }, over);
}

test('syncCard: adds a new friend in place, same cid, re-signed, with the new recipient sealed', async () => {
  const server = { routes: {
    'GET /@me/card1': () => ({ status: 200, json: card() }),
    'GET /@bo/profile': () => profileEnvelope('did:b', 'pubB'),
    'PUT /@me/card1': () => ({ status: 200, json: { ok: true } })
  } };
  const t = setup(server);
  try {
    const r = await call(t.api.syncCard.bind(t.api), 'card1', ctxFor());
    assert.equal(r.result, 'updated');
    assert.deepEqual(r.added, ['did:b']);
    assert.deepEqual(r.removed, []);
    const put = t.puts()[0].body;
    assert.equal(put.record.cid, 'C1', 'same record.cid');
    assert.equal(put.record.payload, 'ciphertext', 'payload untouched');
    assert.equal(put.record.wrappedDek, 'wrapped');
    assert.deepEqual(put.record.recipients, [
      { did: 'did:a', sealedDek: 'sealed-with-pubA' },
      { did: 'did:b', sealedDek: 'sealed-with-pubB' }
    ]);
    assert.equal(put.visibility, 'shared');
    assert.equal(put.sig, 'new-sig', 'the old signature is replaced by a fresh one');
    assert.deepEqual(put.state.audience, { tiers: ['friends'] });
    assert.equal(put.state.title, 'Hello', 'other state is kept');
    assert.equal(t.calls.unwrap, 1);
    assert.deepEqual(t.calls.seal, ['pubB'], 'sealed only for the person added');
  } finally { t.restore(); }
});

test('syncCard: withdrawing someone needs no key and removes only that entry', async () => {
  const env = card({ record: { cid: 'C1', prevCid: null, payload: 'ciphertext', nonce: 'n', wrappedDek: 'wrapped',
    recipients: [{ did: 'did:a', sealedDek: 'sA' }, { did: 'did:b', sealedDek: 'sB' }] } });
  const server = { routes: {
    'GET /@me/card1': () => ({ status: 200, json: env }),
    'PUT /@me/card1': () => ({ status: 200, json: { ok: true } })
  } };
  const t = setup(server);
  try {
    const ctx = ctxFor({ cardAudiences: { card1: { tiers: ['orbit'], people: [] } } });
    const r = await call(t.api.syncCard.bind(t.api), 'card1', ctx);
    assert.equal(r.result, 'updated');
    assert.deepEqual(r.removed, ['did:b']);
    assert.deepEqual(t.puts()[0].body.record.recipients, [{ did: 'did:a', sealedDek: 'sA' }]);
    assert.equal(t.calls.unwrap, 0, 'the key is not opened to remove someone');
    assert.deepEqual(t.puts()[0].body.state.audience, { tiers: ['orbit'] });
  } finally { t.restore(); }
});

test('syncCard: withdrawing everyone makes the card private', async () => {
  const server = { routes: {
    'GET /@me/card1': () => ({ status: 200, json: card() }),
    'PUT /@me/card1': () => ({ status: 200, json: { ok: true } })
  } };
  const t = setup(server);
  try {
    const ctx = ctxFor({ cardAudiences: { card1: { tiers: [], people: [] } } });
    await call(t.api.syncCard.bind(t.api), 'card1', ctx);
    const put = t.puts()[0].body;
    assert.deepEqual(put.record.recipients, []);
    assert.equal(put.visibility, 'private');
  } finally { t.restore(); }
});

test('syncCard: a card that is already right is not written', async () => {
  const env = card({ state: { title: 'Hello', audience: { tiers: ['orbit'] } } });
  const server = { routes: { 'GET /@me/card1': () => ({ status: 200, json: env }) } };
  const t = setup(server);
  try {
    const ctx = ctxFor({ cardAudiences: { card1: { tiers: ['orbit'], people: [] } } });
    const r = await call(t.api.syncCard.bind(t.api), 'card1', ctx);
    assert.deepEqual([r.result, r.reason], ['skipped', 'current']);
    assert.equal(t.puts().length, 0);
    assert.equal(t.calls.sign, 0);
  } finally { t.restore(); }
});

test('syncCard: skips a card with no recorded audience, a sent card, a deleted card and a public one', async () => {
  const cases = [
    ['unmanaged', null, ctxFor({ cardAudiences: {} })],
    ['sent', card({ state: { sentAt: '2026-10-02T00:00:00Z' } }), ctxFor()],
    ['deleted', card({ state: { deleted: true } }), ctxFor()],
    ['not-encrypted', card({ visibility: 'public' }), ctxFor()],
    ['not-owner', card({ did: 'did:someone-else' }), ctxFor()]
  ];
  for (const [reason, env, ctx] of cases) {
    const server = { routes: { 'GET /@me/card1': () => ({ status: 200, json: env }) } };
    const t = setup(server);
    try {
      const r = await call(t.api.syncCard.bind(t.api), 'card1', ctx);
      assert.deepEqual([r.result, r.reason], ['skipped', reason], reason);
      assert.equal(t.puts().length, 0, reason + ' must not write');
    } finally { t.restore(); }
  }
});

test('syncCard: a card the server no longer has is skipped', async () => {
  const t = setup({ routes: { 'GET /@me/card1': () => ({ status: 404, json: { error: 'x' } }) } });
  try {
    const r = await call(t.api.syncCard.bind(t.api), 'card1', ctxFor());
    assert.deepEqual([r.result, r.reason], ['skipped', 'missing']);
  } finally { t.restore(); }
});

test('syncCard: the server freezing a delivered card (409) is a skip, not an error', async () => {
  const server = { routes: {
    'GET /@me/card1': () => ({ status: 200, json: card() }),
    'GET /@bo/profile': () => profileEnvelope('did:b', 'pubB'),
    'PUT /@me/card1': () => ({ status: 409, json: { error: 'already sent' } })
  } };
  const t = setup(server);
  try {
    const r = await call(t.api.syncCard.bind(t.api), 'card1', ctxFor());
    assert.deepEqual([r.result, r.reason], ['skipped', 'sent']);
  } finally { t.restore(); }
});

test('syncCard: someone whose key cannot be fetched is reported and the rest still go through', async () => {
  const server = { routes: {
    'GET /@me/card1': () => ({ status: 200, json: card() }),
    'GET /@bo/profile': () => ({ status: 404, json: {} }),
    'GET /@cy/profile': () => profileEnvelope('did:c', 'pubC'),
    'PUT /@me/card1': () => ({ status: 200, json: { ok: true } })
  } };
  const t = setup(server);
  try {
    const ctx = ctxFor({ friendDids: ['did:a', 'did:b', 'did:c'], handleByDid: { 'did:a': 'ann', 'did:b': 'bo', 'did:c': 'cy' } });
    const r = await call(t.api.syncCard.bind(t.api), 'card1', ctx);
    assert.equal(r.result, 'updated');
    assert.deepEqual(r.added, ['did:c']);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].did, 'did:b');
    assert.deepEqual(t.puts()[0].body.record.recipients.map((e) => e.did), ['did:a', 'did:c']);
  } finally { t.restore(); }
});

test('syncCard: when nobody can be added and nothing changes, it does not write', async () => {
  const env = card({ state: { title: 'Hello', audience: { tiers: ['friends'] } } });
  const server = { routes: {
    'GET /@me/card1': () => ({ status: 200, json: env }),
    'GET /@bo/profile': () => ({ status: 404, json: {} })
  } };
  const t = setup(server);
  try {
    const r = await call(t.api.syncCard.bind(t.api), 'card1', ctxFor());
    assert.deepEqual([r.result, r.reason], ['skipped', 'unsealable']);
    assert.equal(r.failed[0].did, 'did:b');
    assert.equal(t.puts().length, 0);
  } finally { t.restore(); }
});

test('syncCard: refuses to seal to a profile that belongs to a different account', async () => {
  const server = { routes: {
    'GET /@me/card1': () => ({ status: 200, json: card() }),
    'GET /@bo/profile': () => profileEnvelope('did:impostor', 'pubX'),
    'PUT /@me/card1': () => ({ status: 200, json: {} })
  } };
  const t = setup(server);
  try {
    const r = await call(t.api.syncCard.bind(t.api), 'card1', ctxFor());
    assert.deepEqual(t.calls.seal, [], 'nothing sealed to the wrong account');
    assert.equal(r.failed[0].did, 'did:b');
  } finally { t.restore(); }
});

test('syncCard: refuses to seal to a profile that fails its integrity check', async () => {
  const bad = profileEnvelope('did:b', 'pubB');
  bad.json.record.cid = 'tampered';
  const server = { routes: {
    'GET /@me/card1': () => ({ status: 200, json: card() }),
    'GET /@bo/profile': () => bad,
    'PUT /@me/card1': () => ({ status: 200, json: {} })
  } };
  const t = setup(server);
  try {
    const r = await call(t.api.syncCard.bind(t.api), 'card1', ctxFor());
    assert.deepEqual(t.calls.seal, []);
    assert.equal(r.failed[0].did, 'did:b');
    // the card has no recorded audience mirror yet, so it is still written, but
    // with the same recipients as before
    assert.deepEqual(t.puts()[0].body.record.recipients, [{ did: 'did:a', sealedDek: 'sealed-with-pubA' }]);
  } finally { t.restore(); }
});

test('syncCard: if signing fails nothing is written and the error comes back', async () => {
  const server = { signError: true, routes: {
    'GET /@me/card1': () => ({ status: 200, json: card() }),
    'GET /@bo/profile': () => profileEnvelope('did:b', 'pubB'),
    'PUT /@me/card1': () => ({ status: 200, json: {} })
  } };
  const t = setup(server);
  try {
    await assert.rejects(call(t.api.syncCard.bind(t.api), 'card1', ctxFor()), /passkey cancelled/);
    assert.equal(t.puts().length, 0);
  } finally { t.restore(); }
});

test('syncCard: someone who is no longer a friend is withdrawn even though a list still names them', async () => {
  const env = card({ record: { cid: 'C1', prevCid: null, payload: 'p', nonce: 'n', wrappedDek: 'w',
    recipients: [{ did: 'did:a', sealedDek: 'sA' }, { did: 'did:b', sealedDek: 'sB' }] } });
  const server = { routes: {
    'GET /@me/card1': () => ({ status: 200, json: env }),
    'PUT /@me/card1': () => ({ status: 200, json: {} })
  } };
  const t = setup(server);
  try {
    const ctx = ctxFor({
      friendDids: ['did:a'],
      lists: [{ id: 'club', memberDids: ['did:a', 'did:b'] }],
      cardAudiences: { card1: { tiers: ['list:club'], people: [] } }
    });
    const r = await call(t.api.syncCard.bind(t.api), 'card1', ctx);
    assert.deepEqual(r.removed, ['did:b']);
  } finally { t.restore(); }
});

test('syncAudiences: loads the context, handles each card on its own and reports', async () => {
  const settings = { state: { audienceLists: [], cardAudiences: {
    card1: { tiers: ['friends'], people: [] },
    gone: { tiers: ['friends'], people: [] }
  } } };
  const server = { routes: {
    'GET /@me/friends': () => ({ status: 200, json: { friends: [{ did: 'did:a', handle: 'ann' }, { did: 'did:b', handle: 'bo' }] } }),
    'GET /@me/orbit': () => ({ status: 200, json: { members: [], pinned: [] } }),
    'GET /@me/settings': () => ({ status: 200, json: settings }),
    'GET /@me/card1': () => ({ status: 200, json: card() }),
    'GET /@me/gone': () => ({ status: 404, json: {} }),
    'GET /@bo/profile': () => profileEnvelope('did:b', 'pubB'),
    'PUT /@me/card1': () => ({ status: 200, json: {} })
  } };
  const t = setup(server);
  try {
    const report = await call(t.api.syncAudiences.bind(t.api));
    assert.equal(report.updated.length, 1);
    assert.equal(report.updated[0].objId, 'card1');
    assert.deepEqual(report.skipped.map((s) => [s.objId, s.reason]), [['gone', 'missing']]);
    assert.deepEqual(report.failed, []);
  } finally { t.restore(); }
});

test('syncAudiences: a failed friends load stops everything, so nobody is withdrawn by mistake', async () => {
  const server = { routes: {
    'GET /@me/friends': () => ({ status: 500, json: { error: 'db down' } }),
    'GET /@me/orbit': () => ({ status: 200, json: { members: [] } }),
    'GET /@me/settings': () => ({ status: 200, json: { state: { cardAudiences: { card1: { tiers: ['friends'], people: [] } } } } }),
    'GET /@me/card1': () => ({ status: 200, json: card() }),
    'PUT /@me/card1': () => ({ status: 200, json: {} })
  } };
  const t = setup(server);
  try {
    await assert.rejects(call(t.api.syncAudiences.bind(t.api)), /Loading friends failed/);
    assert.equal(t.puts().length, 0);
    // and the guard is released, so a later sync can run
    server.routes['GET /@me/friends'] = () => ({ status: 200, json: { friends: [] } });
    const again = await call(t.api.syncAudiences.bind(t.api));
    assert.equal(again.busy, undefined);
  } finally { t.restore(); }
});

test('syncAudiences: a card that errors is reported and the others still run', async () => {
  const settings = { state: { cardAudiences: {
    bad: { tiers: ['friends'], people: [] }, card1: { tiers: ['friends'], people: [] } } } };
  const server = { routes: {
    'GET /@me/friends': () => ({ status: 200, json: { friends: [{ did: 'did:a', handle: 'ann' }, { did: 'did:b', handle: 'bo' }] } }),
    'GET /@me/orbit': () => ({ status: 200, json: { members: [] } }),
    'GET /@me/settings': () => ({ status: 200, json: settings }),
    'GET /@me/bad': () => ({ status: 500, json: { error: 'boom' } }),
    'GET /@me/card1': () => ({ status: 200, json: card() }),
    'GET /@bo/profile': () => profileEnvelope('did:b', 'pubB'),
    'PUT /@me/card1': () => ({ status: 200, json: {} })
  } };
  const t = setup(server);
  try {
    const report = await call(t.api.syncAudiences.bind(t.api));
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0].objId, 'bad');
    assert.equal(report.updated.length, 1);
  } finally { t.restore(); }
});

test('patchSettings: reads fresh, edits, recomputes the cid and writes', async () => {
  const stored = { objId: 's1', did: ME, type: 'settings', record: { cid: 'old', payload: {} }, state: { blockedDids: ['did:x'] } };
  const server = { routes: {
    'GET /@me/settings': () => ({ status: 200, json: JSON.parse(JSON.stringify(stored)) }),
    'PUT /@me/settings': () => ({ status: 200, json: { ok: true } })
  } };
  const t = setup(server);
  try {
    await call(t.api.setCardAudience.bind(t.api), 'card9', { tiers: ['orbit'], people: ['did:a'] });
    const put = t.puts()[0].body;
    assert.deepEqual(put.state.cardAudiences, { card9: { tiers: ['orbit'], people: ['did:a'] } });
    assert.deepEqual(put.state.blockedDids, ['did:x'], 'other settings are kept');
    assert.equal(put.record.cid, 'cid-of-{}');
  } finally { t.restore(); }
});

test('setCardAudience: null clears a card, and saveLists replaces the lists', async () => {
  let current = { objId: 's1', did: ME, type: 'settings', record: { cid: 'c', payload: {} },
    state: { cardAudiences: { card9: { tiers: [], people: [] }, card8: { tiers: ['friends'], people: [] } } } };
  const server = { routes: {
    'GET /@me/settings': () => ({ status: 200, json: JSON.parse(JSON.stringify(current)) }),
    'PUT /@me/settings': (body) => { current = body; return { status: 200, json: {} }; }
  } };
  const t = setup(server);
  try {
    await call(t.api.setCardAudience.bind(t.api), 'card9', null);
    assert.deepEqual(Object.keys(current.state.cardAudiences), ['card8']);
    await call(t.api.saveLists.bind(t.api), [{ id: 'l1', name: 'Club', memberDids: ['did:a'] }]);
    assert.deepEqual(current.state.audienceLists, [{ id: 'l1', name: 'Club', memberDids: ['did:a'] }]);
    assert.deepEqual(Object.keys(current.state.cardAudiences), ['card8'], 'card audiences survive a list save');
  } finally { t.restore(); }
});

test('every request asks for JSON, because GET /@handle/<objId> answers "*/*" with an HTML page', async () => {
  const server = { routes: {
    'GET /@me/friends': () => ({ status: 200, json: { friends: [{ did: 'did:a', handle: 'ann' }] } }),
    'GET /@me/orbit': () => ({ status: 200, json: { members: [] } }),
    'GET /@me/settings': () => ({ status: 200, json: { record: { cid: 'c', payload: {} }, state: { cardAudiences: { card1: { tiers: ['friends'], people: [] } } } } }),
    'PUT /@me/settings': () => ({ status: 200, json: {} }),
    'GET /@me/card1': () => ({ status: 200, json: card() }),
    'PUT /@me/card1': () => ({ status: 200, json: {} })
  } };
  const t = setup(server);
  try {
    await call(t.api.syncAudiences.bind(t.api));
    await call(t.api.setCardAudience.bind(t.api), 'card1', null);
    assert.ok(t.requests.length >= 5);
    for (const r of t.requests) assert.equal(r.headers.Accept, 'application/json', r.method + ' ' + r.url);
  } finally { t.restore(); }
});
