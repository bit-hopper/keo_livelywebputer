// GameLinkServer: the route wiring that needs no database and no provider: what is
// offered, where a start redirects, and that a callback with a bad or foreign state is
// turned away before anything is stored. Uses a fake app/req/res, so nothing listens.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// A known vault/OAuth-client environment, whatever this machine has set up.
delete process.env.ITCH_CLIENT_ID;
delete process.env.LINKED_ACCOUNTS_KEYS;
delete process.env.LINKED_ACCOUNTS_KEY_CURRENT;
delete process.env.PUBLIC_BASE_URL;

const flow = require('../../core/servers/identity/GameLinkFlow.js');
const mount = require('../../core/servers/GameLinkServer.js');

const ROUTE = '/nodejs/GameLinkServer/';
const DID = 'did:web:example.test:alice';

// Collects the handlers a subserver registers, by "VERB path".
function registered() {
  const routes = {};
  const app = {};
  ['get', 'post', 'delete', 'put'].forEach((verb) => {
    app[verb] = (path, ...handlers) => { routes[verb.toUpperCase() + ' ' + path] = handlers[handlers.length - 1]; };
  });
  mount(ROUTE, app);
  return routes;
}

function fakeReq(over) {
  return Object.assign({
    params: {}, query: {}, headers: {}, session: {}, protocol: 'https',
    get(h) { return h.toLowerCase() === 'host' ? 'lk.example' : undefined; },
  }, over);
}
function fakeRes() {
  const r = { redirected: null, statusCode: 200, body: undefined };
  r.redirect = (u) => { r.redirected = u; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; };
  r.end = (b) => { r.body = b; };
  return r;
}
const signedIn = (session) => { session['identity-did'] = DID; session['identity-handle'] = 'alice'; return session; };

test('every route is registered with a verb that life_star tracks (no app.use)', () => {
  const r = registered();
  for (const k of ['GET ' + ROUTE + 'status', 'GET ' + ROUTE + 'start/:platform', 'GET ' + ROUTE + 'callback/:platform', 'DELETE ' + ROUTE + ':platform']) {
    assert.equal(typeof r[k], 'function', k);
  }
});

test('providers: steam is always offered; itch needs both its client id and the vault', () => {
  let s = mount._providerStatus();
  assert.equal(s.steam.available, true);
  assert.equal(s.itch.available, false);
  assert.match(s.itch.reason, /ITCH_CLIENT_ID/);
  process.env.ITCH_CLIENT_ID = 'cid';
  s = mount._providerStatus();
  assert.equal(s.itch.available, false);
  assert.match(s.itch.reason, /vault/);
  process.env.LINKED_ACCOUNTS_KEYS = JSON.stringify({ 1: Buffer.alloc(32, 3).toString('base64') });
  process.env.LINKED_ACCOUNTS_KEY_CURRENT = '1';
  assert.equal(mount._providerStatus().itch.available, true);
  delete process.env.ITCH_CLIENT_ID; delete process.env.LINKED_ACCOUNTS_KEYS; delete process.env.LINKED_ACCOUNTS_KEY_CURRENT;
});

test('start: signed out goes straight back with an error, not a JSON 401', () => {
  const start = registered()['GET ' + ROUTE + 'start/:platform'];
  const res = fakeRes();
  start(fakeReq({ params: { platform: 'steam' }, query: { 'return': '/blank.html?x=1' } }), res);
  assert.equal(res.redirected, '/blank.html?x=1&link_error=not_signed_in');
});

test('start: an unknown platform is a 404, and a hostile return target is replaced', () => {
  const start = registered()['GET ' + ROUTE + 'start/:platform'];
  let res = fakeRes();
  start(fakeReq({ params: { platform: 'nope' } }), res);
  assert.equal(res.statusCode, 404);
  res = fakeRes();
  start(fakeReq({ params: { platform: 'steam' }, query: { 'return': 'https://evil.example/x' } }), res);
  assert.equal(res.redirected, '/blank.html?link_error=not_signed_in');
});

test('start: steam redirects to the provider with our callback and a session-held state', () => {
  const start = registered()['GET ' + ROUTE + 'start/:platform'];
  const req = fakeReq({ params: { platform: 'steam' }, query: { 'return': '/w' }, session: signedIn({}) });
  const res = fakeRes();
  start(req, res);
  const u = new URL(res.redirected);
  assert.equal(u.origin + u.pathname, 'https://steamcommunity.com/openid/login');
  const returnTo = new URL(u.searchParams.get('openid.return_to'));
  assert.equal(returnTo.origin + returnTo.pathname, 'https://lk.example' + ROUTE + 'callback/steam');
  const state = returnTo.searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(u.searchParams.get('openid.realm'), 'https://lk.example');
  // the state is only in the session, bound to this DID
  const back = flow.consumeFlow(req.session, state, { platform: 'steam', did: DID });
  assert.equal(back.ok, true);
  assert.equal(back.flow.returnTo, '/w');
});

test('start: itch is refused while unconfigured', () => {
  const start = registered()['GET ' + ROUTE + 'start/:platform'];
  const res = fakeRes();
  start(fakeReq({ params: { platform: 'itch' }, query: { 'return': '/w' }, session: signedIn({}) }), res);
  assert.equal(res.redirected, '/w?link_error=unavailable');
});

test('start: more than ten attempts a minute are refused', () => {
  const start = registered()['GET ' + ROUTE + 'start/:platform'];
  const session = signedIn({});
  let refused = 0;
  for (let i = 0; i < 14; i++) {
    const res = fakeRes();
    start(fakeReq({ params: { platform: 'steam' }, query: { 'return': '/w' }, session }), res);
    if (/rate_limited/.test(res.redirected)) refused++;
  }
  assert.ok(refused >= 3, 'refused ' + refused);
});

test('callback: no session, no state, a foreign state, a burned state, and a state for another platform all end in an error and store nothing', () => {
  const cb = registered()['GET ' + ROUTE + 'callback/:platform'];
  const run = (platform, query, session) => { const res = fakeRes(); cb(fakeReq({ params: { platform }, query, session }), res); return res.redirected; };

  assert.equal(run('steam', { state: 'x' }, {}), '/blank.html?link_error=not_signed_in');
  assert.equal(run('steam', {}, signedIn({})), '/blank.html?link_error=state_invalid');
  assert.equal(run('steam', { state: flow.newState() }, signedIn({})), '/blank.html?link_error=state_invalid');

  const session = signedIn({});
  const s = flow.beginFlow(session, { platform: 'itch', did: DID, returnTo: '/w', verifier: 'v' });
  assert.equal(run('steam', { state: s }, session), '/blank.html?link_error=state_invalid', 'wrong platform');
  assert.equal(run('itch', { state: s }, session), '/blank.html?link_error=state_invalid', 'already burned by the failed check');

  const other = signedIn({});
  const s2 = flow.beginFlow(other, { platform: 'steam', did: 'did:web:example.test:mallory', returnTo: '/w' });
  assert.equal(run('steam', { state: s2 }, other), '/blank.html?link_error=state_invalid', 'attempt started by a different account');
});

test('callback: a steam assertion that fails the local checks is rejected before any network call', () => {
  const cb = registered()['GET ' + ROUTE + 'callback/:platform'];
  const session = signedIn({});
  const s = flow.beginFlow(session, { platform: 'steam', did: DID, returnTo: '/w' });
  const res = fakeRes();
  cb(fakeReq({ params: { platform: 'steam' }, query: { state: s, 'openid.mode': 'id_res' }, session }), res);
  assert.equal(res.redirected, '/w?link_error=assertion_rejected');
  const cancelled = flow.beginFlow(session, { platform: 'steam', did: DID, returnTo: '/w' });
  const res2 = fakeRes();
  cb(fakeReq({ params: { platform: 'steam' }, query: { state: cancelled, 'openid.mode': 'cancel' }, session }), res2);
  assert.equal(res2.redirected, '/w?link_error=cancelled');
});

test('disconnect: unknown platform is 404 and a cross-site caller is refused before the database is touched', () => {
  const del = registered()['DELETE ' + ROUTE + ':platform'];
  let res = fakeRes();
  del(fakeReq({ params: { platform: 'nope' }, identity: { did: DID } }), res);
  assert.equal(res.statusCode, 404);
  res = fakeRes();
  del(fakeReq({ params: { platform: 'steam' }, identity: { did: DID }, headers: { 'sec-fetch-site': 'cross-site' } }), res);
  assert.equal(res.statusCode, 403);
});
