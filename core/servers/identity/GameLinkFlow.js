/**
 * core/servers/identity/GameLinkFlow.js
 *
 * The pure, unit-tested half of linking a game-store account to a profile
 * (tests/server/game-link-flow.test.js): no Express, no database, no network. The
 * routes in core/servers/GameLinkServer.js do the I/O and call into this for every
 * decision that matters for security.
 *
 * What is decided here, and why each exists:
 *   - flow state     beginFlow() / consumeFlow(): a random `state` per link attempt,
 *                    kept in the SESSION, bound to the signed-in DID and the platform,
 *                    valid for ten minutes, and removed when used. This is what stops a
 *                    stranger's callback URL from attaching THEIR account to YOUR
 *                    profile (login CSRF): their state is not in your session.
 *                    LIMIT: this server's session is a signed client-side cookie
 *                    (express.cookieSession in life_star), not a server-side record.
 *                    The cookie is tamper-proof and HttpOnly but readable by its owner,
 *                    and "removed when used" only changes the NEXT cookie the browser
 *                    gets: someone replaying an OLDER copy of their own cookie could
 *                    present a consumed state again. That does not open the stranger
 *                    case (they would need the victim's cookie, which is the session
 *                    itself); the replay is further limited by the provider rejecting a
 *                    reused assertion or authorization code, and by nonceSeen() below.
 *                    Do not describe the state as server-enforced single use.
 *   - returnTo       safeReturnTo(): where the browser lands afterwards. Only a path on
 *                    this site is accepted, so the start route cannot be turned into an
 *                    open redirect.
 *   - sign-in 1      the OpenID 2.0 pieces (steam): the login URL, the pure checks on the
 *                    assertion the browser brings back, and the body for the
 *                    check_authentication call that asks the provider whether it really signed it.
 *   - sign-in 2      the OAuth 2.0 + PKCE pieces (itch): PKCE pair, authorize URL, scope check.
 *   - same origin    sameOrigin(): state-changing routes accept only same-site callers.
 *
 * Nothing here ever talks to a provider; the verdict "the provider says this assertion
 * is valid" arrives as the text of its reply, handed to steamReplyIsValid().
 *
 * What NOT to do: do not skip consumeFlow() because "the state looks right" (it also
 * deletes the entry, which is the single-use guarantee); do not trust openid.claimed_id
 * before BOTH checkSteamAssertion() and the provider's check_authentication succeed;
 * do not build a redirect target from anything but safeReturnTo()'s output.
 */

'use strict';

var crypto = require('crypto');

var FLOW_TTL_MS = 10 * 60 * 1000;
var MAX_PENDING_FLOWS = 5;            // per session; the oldest is dropped past this
var SESSION_KEY = 'game-link-flows';

var STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
var OPENID_NS = 'http://specs.openid.net/auth/2.0';
var OPENID_IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
var STEAM_CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

var ITCH_AUTHORIZE_URL = 'https://itch.io/user/oauth';
var ITCH_SCOPES = ['profile:me', 'profile:owned'];

function _b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── returnTo ────────────────────────────────────────────────────────────────

// Accepts only a same-site path ("/world?x=1"). Anything else (an absolute URL, a
// protocol-relative "//host", a backslash trick, control characters, an over-long value)
// becomes `fallback`. Returns a string that starts with exactly one "/".
function safeReturnTo(raw, fallback) {
  fallback = typeof fallback === 'string' ? fallback : '/';
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return fallback;
  if (raw.charAt(0) !== '/' || raw.charAt(1) === '/' || raw.charAt(1) === '\\') return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  try {
    // Resolve against a throwaway origin: if the result is on a different origin the
    // input was not really a path.
    var u = new URL(raw, 'http://same.invalid');
    if (u.origin !== 'http://same.invalid') return fallback;
    return u.pathname + u.search + u.hash;
  } catch (e) { return fallback; }
}

// Adds ?key=value to a safe path, replacing an existing one. `path` must already have
// passed safeReturnTo().
function withQuery(path, key, value) {
  var u = new URL(path, 'http://same.invalid');
  u.searchParams.set(key, value);
  return u.pathname + u.search + u.hash;
}

// ─── flow state (kept in the session) ────────────────────────────────────────

function newState() {
  return _b64url(crypto.randomBytes(32));   // 43 characters
}

function _flows(session) {
  var f = session[SESSION_KEY];
  if (!f || typeof f !== 'object' || Array.isArray(f)) f = session[SESSION_KEY] = {};
  return f;
}

// Starts a link attempt. `flow` is { platform, did, returnTo, verifier? }. Stores it in
// the session under a fresh random state and returns that state. `now` is for tests.
function beginFlow(session, flow, now) {
  now = now || Date.now();
  var flows = _flows(session);
  // prune expired, then cap the number of pending attempts so a page that hits the
  // start route in a loop cannot grow the session without bound
  Object.keys(flows).forEach(function (s) { if (!flows[s] || now - flows[s].createdAt > FLOW_TTL_MS) delete flows[s]; });
  var keys = Object.keys(flows).sort(function (a, b) { return flows[a].createdAt - flows[b].createdAt; });
  while (keys.length >= MAX_PENDING_FLOWS) delete flows[keys.shift()];
  var state = newState();
  flows[state] = {
    platform: flow.platform,
    did: flow.did,
    returnTo: flow.returnTo,
    verifier: flow.verifier || null,
    createdAt: now,
  };
  return state;
}

// Looks up and ALWAYS removes the attempt for `state`. Returns
//   { ok: true, flow }                                  or
//   { ok: false, code }   code: STATE_UNKNOWN | STATE_EXPIRED | STATE_MISMATCH | DID_MISMATCH
// The entry is deleted before any check, so a failed or replayed callback cannot be
// retried with the same state.
function consumeFlow(session, state, expect, now) {
  now = now || Date.now();
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) return { ok: false, code: 'STATE_UNKNOWN' };
  var flows = _flows(session);
  if (!Object.prototype.hasOwnProperty.call(flows, state)) return { ok: false, code: 'STATE_UNKNOWN' };
  var flow = flows[state];
  delete flows[state];
  if (!flow || now - flow.createdAt > FLOW_TTL_MS) return { ok: false, code: 'STATE_EXPIRED' };
  if (flow.platform !== expect.platform) return { ok: false, code: 'STATE_MISMATCH' };
  // The session can outlive a sign-out / sign-in as someone else; the attempt belongs to
  // whoever started it.
  if (!expect.did || flow.did !== expect.did) return { ok: false, code: 'DID_MISMATCH' };
  return { ok: true, flow: flow };
}

// ─── same-origin guard ───────────────────────────────────────────────────────

// `headers` is a plain lowercase-keyed object (req.headers). A browser always sends
// Sec-Fetch-Site on modern versions: "same-origin" is the page itself, "none" is a
// typed address. When it is absent, fall back to comparing Origin with Host. A request
// with neither (curl, a server) is allowed: it carries no browser cookie it was tricked
// into sending, and still has to present the session cookie.
function sameOrigin(headers, host) {
  var site = headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  var origin = headers['origin'];
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch (e) { return false; }
}

// ─── OpenID 2.0 (steam) ──────────────────────────────────────────────────────

// The URL to send the browser to. `returnTo` is OUR callback including ?state=…;
// `realm` is our origin.
function steamLoginUrl(returnTo, realm) {
  var p = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': OPENID_IDENTIFIER_SELECT,
    'openid.claimed_id': OPENID_IDENTIFIER_SELECT,
  });
  return STEAM_OPENID_ENDPOINT + '?' + p.toString();
}

// The nonce's leading timestamp ("2026-10-21T12:00:00Z<random>") as epoch ms, or NaN.
function _nonceTime(nonce) {
  var m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z/.exec(nonce || '');
  return m ? Date.parse(m[1] + 'Z') : NaN;
}

// Seen response nonces, per process, so a captured assertion cannot be replayed within
// the freshness window. (The provider's own check_authentication and the single-use
// session state are the primary defences; this is a third. It is per worker: a replay
// that lands on another worker would still have to get past the single-use state.)
var _seenNonces = {};
function nonceSeen(nonce, now) {
  now = now || Date.now();
  Object.keys(_seenNonces).forEach(function (n) { if (now - _seenNonces[n] > FLOW_TTL_MS) delete _seenNonces[n]; });
  if (Object.prototype.hasOwnProperty.call(_seenNonces, nonce)) return true;
  if (Object.keys(_seenNonces).length > 10000) return true;   // refuse rather than grow without bound
  _seenNonces[nonce] = now;
  return false;
}
function _resetNonces() { _seenNonces = {}; }

// Pure checks on the query the browser brought back. `query` is req.query; `expect` is
// { returnTo } (the exact return_to we sent). Returns { ok: true, steamId } or
// { ok: false, code }. This is necessary but NOT sufficient: the caller must also get
// is_valid:true from the provider (steamVerifyBody / steamReplyIsValid).
function checkSteamAssertion(query, expect, now) {
  now = now || Date.now();
  var q = {};
  var bad = false;
  Object.keys(query || {}).forEach(function (k) {
    if (k.indexOf('openid.') !== 0) return;
    if (typeof query[k] !== 'string') bad = true;       // repeated or nested parameter
    else q[k] = query[k];
  });
  if (bad) return { ok: false, code: 'ASSERTION_MALFORMED' };
  if (q['openid.mode'] === 'cancel') return { ok: false, code: 'CANCELLED' };
  if (q['openid.ns'] !== OPENID_NS || q['openid.mode'] !== 'id_res') return { ok: false, code: 'ASSERTION_MALFORMED' };
  if (q['openid.op_endpoint'] !== STEAM_OPENID_ENDPOINT) return { ok: false, code: 'WRONG_PROVIDER' };
  if (q['openid.return_to'] !== expect.returnTo) return { ok: false, code: 'RETURN_TO_MISMATCH' };
  var m = STEAM_CLAIMED_ID_RE.exec(q['openid.claimed_id'] || '');
  if (!m) return { ok: false, code: 'BAD_CLAIMED_ID' };
  if (q['openid.identity'] !== q['openid.claimed_id']) return { ok: false, code: 'BAD_CLAIMED_ID' };
  // The signature must cover what we rely on, or an attacker could splice in their own
  // values around a genuine signed core.
  var signed = (q['openid.signed'] || '').split(',');
  var must = ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle'];
  for (var i = 0; i < must.length; i++) if (signed.indexOf(must[i]) === -1) return { ok: false, code: 'UNSIGNED_FIELD' };
  var t = _nonceTime(q['openid.response_nonce']);
  if (isNaN(t) || Math.abs(now - t) > FLOW_TTL_MS) return { ok: false, code: 'STALE_NONCE' };
  return { ok: true, steamId: m[1], nonce: q['openid.response_nonce'] };
}

// The form body to POST to the provider's endpoint to ask "did you sign this?": every
// openid.* parameter exactly as received, with the mode switched.
function steamVerifyBody(query) {
  var p = new URLSearchParams();
  Object.keys(query || {}).forEach(function (k) {
    if (k.indexOf('openid.') === 0 && typeof query[k] === 'string') p.set(k, query[k]);
  });
  p.set('openid.mode', 'check_authentication');
  return p.toString();
}

// The provider's reply is key:value lines; only an exact "is_valid:true" counts.
function steamReplyIsValid(text) {
  return /^is_valid:true\s*$/m.test(String(text || ''));
}

// ─── OAuth 2.0 + PKCE (itch) ──────────────────────────────────────────────

function pkcePair() {
  var verifier = _b64url(crypto.randomBytes(32));
  var challenge = _b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier: verifier, challenge: challenge };
}

function itchAuthorizeUrl(opts) {
  var p = new URLSearchParams({
    client_id: opts.clientId,
    scope: ITCH_SCOPES.join(' '),
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    state: opts.state,
  });
  return ITCH_AUTHORIZE_URL + '?' + p.toString();
}

// True when the scope the token response reports includes everything we asked for. The
// user may be able to narrow what they grant, and a library import without
// profile:owned would silently return nothing. An absent scope string is not enough.
function hasRequiredItchScopes(granted) {
  if (typeof granted !== 'string') return false;
  var have = granted.split(/[\s,]+/).filter(Boolean);
  return ITCH_SCOPES.every(function (s) { return have.indexOf(s) !== -1 || have.indexOf('profile') !== -1; });
}

module.exports = {
  FLOW_TTL_MS: FLOW_TTL_MS,
  SESSION_KEY: SESSION_KEY,
  ITCH_SCOPES: ITCH_SCOPES,
  STEAM_OPENID_ENDPOINT: STEAM_OPENID_ENDPOINT,
  safeReturnTo: safeReturnTo,
  withQuery: withQuery,
  newState: newState,
  beginFlow: beginFlow,
  consumeFlow: consumeFlow,
  sameOrigin: sameOrigin,
  steamLoginUrl: steamLoginUrl,
  checkSteamAssertion: checkSteamAssertion,
  steamVerifyBody: steamVerifyBody,
  steamReplyIsValid: steamReplyIsValid,
  nonceSeen: nonceSeen,
  _resetNonces: _resetNonces,
  pkcePair: pkcePair,
  itchAuthorizeUrl: itchAuthorizeUrl,
  hasRequiredItchScopes: hasRequiredItchScopes,
};
