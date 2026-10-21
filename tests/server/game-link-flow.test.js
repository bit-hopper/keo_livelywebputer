// GameLinkFlow: the security decisions of account linking, with no network and no
// database. The provider's own verdict (its check_authentication reply) is
// represented by canned text.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const flow = require('../../core/servers/identity/GameLinkFlow.js');

const DID = 'did:web:example.test:alice';
const NOW = Date.parse('2026-10-21T12:00:00Z');

// ─── returnTo ────────────────────────────────────────────────────────────────

test('safeReturnTo keeps same-site paths and drops everything else', () => {
  assert.equal(flow.safeReturnTo('/blank.html?x=1#a'), '/blank.html?x=1#a');
  assert.equal(flow.safeReturnTo('/'), '/');
  for (const bad of [
    'https://evil.example/', '//evil.example/x', '/\\evil.example', '\\\\evil.example', 'javascript:alert(1)',
    'blank.html', '', null, undefined, 42, '/a\nb', '/a\u0000b', '/' + 'x'.repeat(600), '/\t/evil.example',
  ]) {
    assert.equal(flow.safeReturnTo(bad), '/', JSON.stringify(bad));
  }
  assert.equal(flow.safeReturnTo('//evil.example', '/home'), '/home');
});

test('withQuery appends or replaces one parameter', () => {
  assert.equal(flow.withQuery('/w?a=1', 'linked', 'steam'), '/w?a=1&linked=steam');
  assert.equal(flow.withQuery('/w?linked=old', 'linked', 'itch'), '/w?linked=itch');
  assert.equal(flow.withQuery('/w#h', 'link_error', 'x y'), '/w?link_error=x+y#h');
});

// ─── flow state ──────────────────────────────────────────────────────────────

test('a flow state is random, session-bound and works exactly once', () => {
  const session = {};
  const s = flow.beginFlow(session, { platform: 'steam', did: DID, returnTo: '/w' }, NOW);
  assert.match(s, /^[A-Za-z0-9_-]{43}$/);
  const first = flow.consumeFlow(session, s, { platform: 'steam', did: DID }, NOW + 1000);
  assert.equal(first.ok, true);
  assert.equal(first.flow.returnTo, '/w');
  assert.deepEqual(flow.consumeFlow(session, s, { platform: 'steam', did: DID }, NOW + 2000), { ok: false, code: 'STATE_UNKNOWN' });
});

test('a state from another session is unknown (the stranger-callback case)', () => {
  const mine = {}, theirs = {};
  const s = flow.beginFlow(theirs, { platform: 'steam', did: 'did:web:example.test:mallory', returnTo: '/' }, NOW);
  assert.deepEqual(flow.consumeFlow(mine, s, { platform: 'steam', did: DID }, NOW), { ok: false, code: 'STATE_UNKNOWN' });
});

test('state expires after ten minutes', () => {
  const session = {};
  const s = flow.beginFlow(session, { platform: 'itch', did: DID, returnTo: '/', verifier: 'v' }, NOW);
  assert.deepEqual(flow.consumeFlow(session, s, { platform: 'itch', did: DID }, NOW + flow.FLOW_TTL_MS + 1), { ok: false, code: 'STATE_EXPIRED' });
  const s2 = flow.beginFlow(session, { platform: 'itch', did: DID, returnTo: '/', verifier: 'v' }, NOW);
  assert.equal(flow.consumeFlow(session, s2, { platform: 'itch', did: DID }, NOW + flow.FLOW_TTL_MS - 1).ok, true);
});

test('state is bound to the platform and to the DID that started it; a failed check still burns it', () => {
  const session = {};
  let s = flow.beginFlow(session, { platform: 'steam', did: DID, returnTo: '/' }, NOW);
  assert.deepEqual(flow.consumeFlow(session, s, { platform: 'itch', did: DID }, NOW), { ok: false, code: 'STATE_MISMATCH' });
  assert.deepEqual(flow.consumeFlow(session, s, { platform: 'steam', did: DID }, NOW), { ok: false, code: 'STATE_UNKNOWN' }, 'burned');
  s = flow.beginFlow(session, { platform: 'steam', did: DID, returnTo: '/' }, NOW);
  assert.deepEqual(flow.consumeFlow(session, s, { platform: 'steam', did: 'did:web:example.test:bob' }, NOW), { ok: false, code: 'DID_MISMATCH' });
  assert.deepEqual(flow.consumeFlow(session, s, { platform: 'steam', did: DID }, NOW), { ok: false, code: 'STATE_UNKNOWN' }, 'burned');
  assert.deepEqual(flow.consumeFlow(session, 'x', { platform: 'steam', did: DID }, NOW), { ok: false, code: 'STATE_UNKNOWN' });
  assert.deepEqual(flow.consumeFlow(session, '__proto__', { platform: 'steam', did: DID }, NOW), { ok: false, code: 'STATE_UNKNOWN' });
  assert.deepEqual(flow.consumeFlow(session, undefined, { platform: 'steam', did: DID }, NOW), { ok: false, code: 'STATE_UNKNOWN' });
  assert.deepEqual(flow.consumeFlow(session, s, { platform: 'steam', did: undefined }, NOW), { ok: false, code: 'STATE_UNKNOWN' });
});

test('an unauthenticated expectation (no DID) never matches', () => {
  const session = {};
  const s = flow.beginFlow(session, { platform: 'steam', did: DID, returnTo: '/' }, NOW);
  assert.equal(flow.consumeFlow(session, s, { platform: 'steam', did: '' }, NOW).ok, false);
});

test('pending attempts per session are capped and old ones pruned', () => {
  const session = {};
  const states = [];
  for (let i = 0; i < 8; i++) states.push(flow.beginFlow(session, { platform: 'steam', did: DID, returnTo: '/' }, NOW + i));
  assert.equal(Object.keys(session[flow.SESSION_KEY]).length, 5);
  assert.equal(flow.consumeFlow(session, states[0], { platform: 'steam', did: DID }, NOW + 9).ok, false, 'oldest dropped');
  assert.equal(flow.consumeFlow(session, states[7], { platform: 'steam', did: DID }, NOW + 9).ok, true);
  flow.beginFlow(session, { platform: 'steam', did: DID, returnTo: '/' }, NOW + flow.FLOW_TTL_MS * 3);
  assert.equal(Object.keys(session[flow.SESSION_KEY]).length, 1, 'expired entries pruned');
});

// ─── same origin ─────────────────────────────────────────────────────────────

test('sameOrigin trusts Sec-Fetch-Site, else compares Origin to Host, else allows non-browser callers', () => {
  assert.equal(flow.sameOrigin({ 'sec-fetch-site': 'same-origin' }, 'h.test'), true);
  assert.equal(flow.sameOrigin({ 'sec-fetch-site': 'none' }, 'h.test'), true);
  assert.equal(flow.sameOrigin({ 'sec-fetch-site': 'cross-site' }, 'h.test'), false);
  assert.equal(flow.sameOrigin({ 'sec-fetch-site': 'same-site' }, 'h.test'), false);
  assert.equal(flow.sameOrigin({ origin: 'https://h.test' }, 'h.test'), true);
  assert.equal(flow.sameOrigin({ origin: 'https://evil.test' }, 'h.test'), false);
  assert.equal(flow.sameOrigin({ origin: 'null' }, 'h.test'), false);
  assert.equal(flow.sameOrigin({}, 'h.test'), true);
});

// ─── OpenID (steam) ───────────────────────────────────────────────────────────────────

const RETURN_TO = 'https://lk.example/nodejs/GameLinkServer/callback/steam?state=' + 'a'.repeat(43);
const SIGNED = 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle';
function goodQuery(over) {
  return Object.assign({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001',
    'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000001',
    'openid.return_to': RETURN_TO,
    'openid.response_nonce': '2026-10-21T12:00:00ZAbCdEf123',
    'openid.assoc_handle': '1234567890',
    'openid.signed': SIGNED,
    'openid.sig': 'c2ln',
  }, over || {});
}

test('steamLoginUrl asks the provider to choose the identity and returns to our callback', () => {
  const u = new URL(flow.steamLoginUrl(RETURN_TO, 'https://lk.example'));
  assert.equal(u.origin + u.pathname, 'https://steamcommunity.com/openid/login');
  assert.equal(u.searchParams.get('openid.mode'), 'checkid_setup');
  assert.equal(u.searchParams.get('openid.return_to'), RETURN_TO);
  assert.equal(u.searchParams.get('openid.realm'), 'https://lk.example');
  assert.equal(u.searchParams.get('openid.identity'), 'http://specs.openid.net/auth/2.0/identifier_select');
});

test('a well-formed assertion yields the 64-bit id', () => {
  const r = flow.checkSteamAssertion(goodQuery(), { returnTo: RETURN_TO }, NOW);
  assert.deepEqual(r, { ok: true, steamId: '76561198000000001', nonce: '2026-10-21T12:00:00ZAbCdEf123' });
});

test('assertion checks: each tampering is refused with its own code', () => {
  const cases = [
    [{ 'openid.mode': 'cancel' }, 'CANCELLED'],
    [{ 'openid.mode': 'setup_needed' }, 'ASSERTION_MALFORMED'],
    [{ 'openid.ns': 'http://specs.openid.net/auth/1.1' }, 'ASSERTION_MALFORMED'],
    [{ 'openid.op_endpoint': 'https://evil.example/openid/login' }, 'WRONG_PROVIDER'],
    [{ 'openid.return_to': RETURN_TO.replace('a'.repeat(43), 'b'.repeat(43)) }, 'RETURN_TO_MISMATCH'],
    [{ 'openid.claimed_id': 'https://evil.example/openid/id/76561198000000001', 'openid.identity': 'https://evil.example/openid/id/76561198000000001' }, 'BAD_CLAIMED_ID'],
    [{ 'openid.claimed_id': 'https://steamcommunity.com/openid/id/123' }, 'BAD_CLAIMED_ID'],
    [{ 'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000002' }, 'BAD_CLAIMED_ID'],
    [{ 'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,assoc_handle' }, 'UNSIGNED_FIELD'],
    [{ 'openid.signed': 'signed,claimed_id,identity,return_to,response_nonce,assoc_handle' }, 'UNSIGNED_FIELD'],
    [{ 'openid.response_nonce': '2026-10-21T10:00:00ZOld' }, 'STALE_NONCE'],
    [{ 'openid.response_nonce': 'garbage' }, 'STALE_NONCE'],
    [{ 'openid.claimed_id': ['a', 'b'] }, 'ASSERTION_MALFORMED'],
  ];
  for (const [over, code] of cases) {
    assert.equal(flow.checkSteamAssertion(goodQuery(over), { returnTo: RETURN_TO }, NOW).code, code, JSON.stringify(over));
  }
  assert.equal(flow.checkSteamAssertion({}, { returnTo: RETURN_TO }, NOW).code, 'ASSERTION_MALFORMED');
  assert.equal(flow.checkSteamAssertion(null, { returnTo: RETURN_TO }, NOW).code, 'ASSERTION_MALFORMED');
});

test('the verification body repeats every openid.* parameter with the mode switched, and nothing else', () => {
  const body = new URLSearchParams(flow.steamVerifyBody(Object.assign(goodQuery(), { state: 'x', evil: 'y' })));
  assert.equal(body.get('openid.mode'), 'check_authentication');
  assert.equal(body.get('openid.sig'), 'c2ln');
  assert.equal(body.get('openid.claimed_id'), 'https://steamcommunity.com/openid/id/76561198000000001');
  assert.equal(body.get('state'), null);
  assert.equal(body.get('evil'), null);
});

test('only an exact is_valid:true counts as the provider vouching for the assertion', () => {
  assert.equal(flow.steamReplyIsValid('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'), true);
  assert.equal(flow.steamReplyIsValid('ns:http://specs.openid.net/auth/2.0\r\nis_valid:true\r\n'), true);
  for (const bad of ['is_valid:false\n', '', null, 'is_valid:true_ish', 'xis_valid:true', '<html>is_valid:true</html>']) {
    assert.equal(flow.steamReplyIsValid(bad), false, JSON.stringify(bad));
  }
});

test('a response nonce works once inside the window', () => {
  flow._resetNonces();
  assert.equal(flow.nonceSeen('2026-10-21T12:00:00Zn1', NOW), false);
  assert.equal(flow.nonceSeen('2026-10-21T12:00:00Zn1', NOW + 1000), true, 'replay');
  assert.equal(flow.nonceSeen('2026-10-21T12:00:00Zn2', NOW + 1000), false);
  assert.equal(flow.nonceSeen('2026-10-21T12:00:00Zn1', NOW + flow.FLOW_TTL_MS + 5), false, 'forgotten after the window (the timestamp check rejects it by then)');
});

// ─── OAuth (itch) ─────────────────────────────────────────────────────────────────

test('PKCE: the challenge is the S256 of the verifier, both URL-safe', () => {
  const crypto = require('crypto');
  const { verifier, challenge } = flow.pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(flow.pkcePair().verifier, verifier);
});

test('the authorize URL asks only for the narrow scopes', () => {
  const u = new URL(flow.itchAuthorizeUrl({ clientId: 'cid', redirectUri: 'http://localhost:9001/cb', state: 's'.repeat(43), challenge: 'ch' }));
  assert.equal(u.origin + u.pathname, 'https://itch.io/user/oauth');
  assert.equal(u.searchParams.get('scope'), 'profile:me profile:owned');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('client_id'), 'cid');
});

test('the granted scope must include everything requested', () => {
  assert.equal(flow.hasRequiredItchScopes('profile:me profile:owned'), true);
  assert.equal(flow.hasRequiredItchScopes('profile:owned,profile:me'), true);
  assert.equal(flow.hasRequiredItchScopes('profile'), true);
  for (const bad of ['profile:me', 'profile:owned', '', undefined, null, 'profile:games']) {
    assert.equal(flow.hasRequiredItchScopes(bad), false, JSON.stringify(bad));
  }
});
