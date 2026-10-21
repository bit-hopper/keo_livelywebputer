/**
 * core/servers/GameLinkServer.js
 *
 * Links a game-store account to the signed-in profile (Settings -> Connected). Mounted
 * automatically at /nodejs/GameLinkServer/. Every security decision lives in
 * identity/GameLinkFlow.js (pure, unit-tested); the sealed token lives in
 * identity/CredentialVault.js; the rows live in identity/LinkedAccounts.js. This file is
 * only the HTTP and provider plumbing between them.
 *
 * Routes (the route prefix is `route`, ending in "/"):
 *   GET    status               linked accounts for the session DID, and which providers
 *                               are available on this server. Never any credential.
 *   GET    start/:platform      ?return=<same-site path>. Begins a link: stores a
 *                               single-use state in the session, redirects the browser to
 *                               the provider. Signed-out callers are sent straight back
 *                               with ?link_error=not_signed_in (a browser navigation
 *                               should not land on a JSON 401).
 *   GET    callback/:platform   the provider sends the browser back here. Validates the
 *                               state, completes the provider's flow, stores the link,
 *                               then redirects to the original page with ?linked=<platform>
 *                               or ?link_error=<code>. The code is one of a fixed set of
 *                               short words, never provider text.
 *   DELETE :platform            disconnect: best-effort revoke at the provider, then hard
 *                               delete of the row. Same-site callers only.
 *
 * NOT built yet: POST :platform/sync (importing a library). Linking is complete without it.
 *
 * Providers:
 *   steam  A sign-in that only proves who the user is (OpenID 2.0); no token exists, so
 *          the row holds just the public 64-bit id. Needs no server secret, so this link
 *          works even when the credential vault is not configured.
 *   itch   OAuth 2.0 + PKCE (no client secret). The access token never expires, so it is
 *          sealed with the vault and revoked on disconnect. Needs ITCH_CLIENT_ID and a
 *          configured vault (LINKED_ACCOUNTS_KEYS / LINKED_ACCOUNTS_KEY_CURRENT); without
 *          either, it answers "unavailable" rather than storing anything weakly.
 *
 * UNVERIFIED against the real services (no accounts were available when this was
 * written): the shape of the token-issuing provider's token response and of its profile
 * call (this reads `body.user.id` / `body.user.username`), and the other provider's
 * check_authentication reply. The pure parts are unit-tested; the round trips are checked live in the spikes.
 *
 * Never logged, never put in a response: authorization codes, access tokens, the PKCE
 * verifier, OpenID signatures. Upstream error text is not echoed to the browser.
 */

'use strict';

var https = require('https');
var querystring = require('querystring');
var auth = require('./identity/AuthMiddleware');
var vault = require('./identity/CredentialVault');
var linked = require('./identity/LinkedAccounts');
var flow = require('./identity/GameLinkFlow');

var PLATFORMS = linked.PLATFORMS;
var FETCH_TIMEOUT_MS = 8000;
var MAX_RESPONSE_BYTES = 256 * 1024;
var DEFAULT_RETURN = '/blank.html';

var ITCH_TOKEN_URL = 'https://api.itch.io/oauth/token';
var ITCH_PROFILE_URL = 'https://api.itch.io/profile';
var ITCH_REVOKE_URL = 'https://api.itch.io/oauth/revoke';

function itchClientId() {
  var id = process.env.ITCH_CLIENT_ID;
  return id && id.indexOf('REPLACE_WITH') !== 0 ? id : null;
}

// What this server can do right now, per provider. `available` gates the Connect button.
function providerStatus() {
  return {
    steam: { available: true, reason: null },
    itch: {
      available: !!itchClientId() && vault.isConfigured(),
      reason: !itchClientId() ? 'itch.io sign-in is not set up on this server (ITCH_CLIENT_ID)'
        : (!vault.isConfigured() ? 'the credential vault is not configured (LINKED_ACCOUNTS_KEYS)' : null),
    },
  };
}

// Same rule as IdentityServer.js's canonicalOrigin (private there): PUBLIC_BASE_URL pins
// the real public address; otherwise the request's own.
function canonicalOrigin(req) {
  var configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return req.protocol + '://' + req.get('host');
}

// ─── small per-process rate limit for starting links ─────────────────────────

var _starts = {};
function startAllowed(did) {
  var now = Date.now();
  var recent = (_starts[did] || []).filter(function (t) { return now - t < 60 * 1000; });
  if (recent.length >= 10) { _starts[did] = recent; return false; }
  recent.push(now);
  _starts[did] = recent;
  if (Object.keys(_starts).length > 5000) _starts = {};
  return true;
}

// ─── outbound HTTPS ──────────────────────────────────────────────────────────

// opts: { method, url, headers, form }. Calls thenDo(err, { status, body }). Fixed hosts
// only (callers pass constants), a timeout and a size cap; the body is returned as text.
function fetchText(opts, thenDo) {
  var u = new URL(opts.url);
  var body = opts.form ? querystring.stringify(opts.form) : null;
  var headers = Object.assign({ 'Accept': 'application/json' }, opts.headers || {});
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  var done = false;
  function finish(err, res) { if (done) return; done = true; thenDo(err, res); }
  var req = https.request({
    method: opts.method || 'GET', hostname: u.hostname, path: u.pathname + u.search, headers: headers,
  }, function (res) {
    var chunks = [], size = 0;
    res.on('data', function (c) {
      size += c.length;
      if (size > MAX_RESPONSE_BYTES) { req.destroy(); return finish(new Error('response too large')); }
      chunks.push(c);
    });
    res.on('end', function () { finish(null, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
  });
  req.setTimeout(FETCH_TIMEOUT_MS, function () { req.destroy(new Error('timeout')); });
  req.on('error', function (e) { finish(new Error('network: ' + (e.code || e.message))); });
  if (body) req.write(body);
  req.end();
}

function parseJson(text) { try { return JSON.parse(text); } catch (e) { return null; } }

// ─── redirects back to the page ──────────────────────────────────────────────

function backToPage(res, returnTo, key, value) {
  res.redirect(flow.withQuery(flow.safeReturnTo(returnTo, DEFAULT_RETURN), key, value));
}

// ─── provider completion ─────────────────────────────────────────────────────

// OpenID provider: pure checks, then ask the provider whether it signed the assertion. thenDo(err, steamId|null, code).
function completeSteam(req, flowEntry, thenDo) {
  var returnTo = canonicalOrigin(req) + req.baseRoute + 'callback/steam?state=' + encodeURIComponent(flowEntry.state);
  var check = flow.checkSteamAssertion(req.query, { returnTo: returnTo });
  if (!check.ok) return thenDo(null, null, check.code === 'CANCELLED' ? 'cancelled' : 'assertion_rejected');
  if (flow.nonceSeen(check.nonce)) return thenDo(null, null, 'assertion_rejected');
  fetchText({
    method: 'POST', url: flow.STEAM_OPENID_ENDPOINT,
    headers: { 'Accept': 'text/plain' },
    form: querystring.parse(flow.steamVerifyBody(req.query)),
  }, function (err, r) {
    if (err) return thenDo(null, null, 'provider_unreachable');
    if (r.status !== 200 || !flow.steamReplyIsValid(r.body)) return thenDo(null, null, 'assertion_rejected');
    thenDo(null, check.steamId, null);
  });
}

// OAuth provider: code -> token -> profile. thenDo(err, { token, scope, externalId, displayName } | null, code).
function completeItch(req, flowEntry, thenDo) {
  var code = req.query.code;
  if (typeof code !== 'string' || !code) return thenDo(null, null, req.query.error ? 'cancelled' : 'provider_error');
  var redirectUri = canonicalOrigin(req) + req.baseRoute + 'callback/itch';
  fetchText({
    method: 'POST', url: ITCH_TOKEN_URL,
    form: {
      client_id: itchClientId(), grant_type: 'authorization_code', code: code,
      code_verifier: flowEntry.verifier, redirect_uri: redirectUri,
    },
  }, function (err, r) {
    if (err) return thenDo(null, null, 'provider_unreachable');
    var tok = parseJson(r.body);
    if (r.status !== 200 || !tok || typeof tok.access_token !== 'string' || !tok.access_token) return thenDo(null, null, 'provider_error');
    // Verify the scopes only when the response reports them. If it does not, the token
    // is what we asked for; a missing grant shows up later as a rejected request, which
    // marks the link as needing a reconnect.
    var scope = typeof tok.scope === 'string' ? tok.scope : null;
    if (scope !== null && !flow.hasRequiredItchScopes(scope)) return thenDo(null, null, 'scope_denied');
    fetchText({ url: ITCH_PROFILE_URL, headers: { 'Authorization': 'Bearer ' + tok.access_token } }, function (err, p) {
      if (err) return thenDo(null, null, 'provider_unreachable');
      var prof = parseJson(p.body);
      var user = prof && prof.user;
      if (p.status !== 200 || !user || user.id == null) return thenDo(null, null, 'provider_error');
      thenDo(null, {
        token: tok.access_token, scope: scope || flow.ITCH_SCOPES.join(' '),
        externalId: String(user.id), displayName: String(user.display_name || user.username || '').slice(0, 80) || null,
      }, null);
    });
  });
}

// ─── routes ──────────────────────────────────────────────────────────────────

module.exports = function (route, app) {

  app.get(route + 'status', auth.requireAuth, function (req, res) {
    linked.listForDid(req.identity.did, function (err, rows) {
      if (err) return res.status(500).json({ error: 'could not read linked accounts' });
      res.json({ providers: providerStatus(), accounts: rows });
    });
  });

  app.get(route + 'start/:platform', function (req, res) {
    var platform = req.params.platform;
    var returnTo = flow.safeReturnTo(req.query['return'], DEFAULT_RETURN);
    if (PLATFORMS.indexOf(platform) === -1) return res.status(404).json({ error: 'unknown platform' });
    var identity = auth.getSessionIdentity(req);
    if (!identity) return backToPage(res, returnTo, 'link_error', 'not_signed_in');
    if (!providerStatus()[platform].available) return backToPage(res, returnTo, 'link_error', 'unavailable');
    if (!startAllowed(identity.did)) return backToPage(res, returnTo, 'link_error', 'rate_limited');

    var origin = canonicalOrigin(req);
    var pkce = platform === 'itch' ? flow.pkcePair() : null;
    var state = flow.beginFlow(req.session, {
      platform: platform, did: identity.did, returnTo: returnTo, verifier: pkce && pkce.verifier,
    });
    if (platform === 'steam') {
      var cb = origin + route + 'callback/steam?state=' + encodeURIComponent(state);
      return res.redirect(flow.steamLoginUrl(cb, origin));
    }
    res.redirect(flow.itchAuthorizeUrl({
      clientId: itchClientId(), redirectUri: origin + route + 'callback/itch', state: state, challenge: pkce.challenge,
    }));
  });

  app.get(route + 'callback/:platform', function (req, res) {
    var platform = req.params.platform;
    if (PLATFORMS.indexOf(platform) === -1) return res.status(404).json({ error: 'unknown platform' });
    var identity = auth.getSessionIdentity(req);
    // Both providers carry our state back: the OAuth one as ?state, the OpenID one inside return_to's query.
    var state = typeof req.query.state === 'string' ? req.query.state : null;
    if (!identity) return backToPage(res, DEFAULT_RETURN, 'link_error', 'not_signed_in');
    var consumed = flow.consumeFlow(req.session, state, { platform: platform, did: identity.did });
    if (!consumed.ok) return backToPage(res, DEFAULT_RETURN, 'link_error', 'state_invalid');
    var entry = consumed.flow;
    entry.state = state;
    req.baseRoute = route;
    var returnTo = entry.returnTo;

    function save(link) {
      linked.upsertLink(identity.did, platform, link, function (err) {
        if (err && err.code === 'ALREADY_LINKED') return backToPage(res, returnTo, 'link_error', 'already_linked');
        if (err) return backToPage(res, returnTo, 'link_error', 'server_error');
        backToPage(res, returnTo, 'linked', platform);
      });
    }

    if (platform === 'steam') {
      return completeSteam(req, entry, function (err, steamId, code) {
        if (code) return backToPage(res, returnTo, 'link_error', code);
        save({ externalId: steamId, displayName: null, scopes: null, sealed: null });
      });
    }
    completeItch(req, entry, function (err, got, code) {
      if (code) return backToPage(res, returnTo, 'link_error', code);
      var sealed;
      try {
        sealed = vault.seal(got.token, { did: identity.did, platform: 'itch', externalId: got.externalId });
      } catch (e) { return backToPage(res, returnTo, 'link_error', 'unavailable'); }
      save({ externalId: got.externalId, displayName: got.displayName, scopes: got.scope, sealed: sealed });
    });
  });

  app.delete(route + ':platform', auth.requireAuth, function (req, res) {
    var platform = req.params.platform;
    if (PLATFORMS.indexOf(platform) === -1) return res.status(404).json({ error: 'unknown platform' });
    if (!flow.sameOrigin(req.headers, req.get('host'))) return res.status(403).json({ error: 'cross-site request refused' });
    var did = req.identity.did;
    // Row first, upstream revoke second: the user's disconnect must succeed even when the
    // provider is down. The removed row still carries the sealed token for the revoke.
    linked.removeLink(did, platform, function (err, row) {
      if (err) return res.status(500).json({ error: 'could not disconnect' });
      if (!row) return res.json({ ok: true, revoked: false, wasLinked: false });
      if (platform !== 'itch' || !row.sealed) return res.json({ ok: true, revoked: platform === 'steam', wasLinked: true });
      var token;
      try { token = vault.open(row.sealed, { did: did, platform: 'itch', externalId: row.external_id }); }
      catch (e) { return res.json({ ok: true, revoked: false, wasLinked: true }); }
      fetchText({ method: 'POST', url: ITCH_REVOKE_URL, form: { token: token, client_id: itchClientId() } }, function (err, r) {
        res.json({ ok: true, revoked: !err && r.status === 200, wasLinked: true });
      });
    });
  });

  app.get(route, function (req, res) { res.end('GameLinkServer is running!'); });
};

module.exports._providerStatus = providerStatus;
