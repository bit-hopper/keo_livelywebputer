/**
 * core/servers/GameDbProxyServer.js
 *
 * Server-side proxy for a third-party game database (its v4 HTTP API), used by the
 * Gaming world template's "Add a game" search (lively.gaming.GameDialogs). The service
 * authenticates with a developer application: a client id and a client SECRET, from
 * which the server fetches a short-lived app access token. Neither the secret nor the
 * token is ever sent to the browser, which is the reason this is a proxy at all (same
 * shape as the books-search proxy, GoogleBooksProxyServer.js).
 *
 * Credentials come from (checked in this order):
 *   - process.env.IGDB_CLIENT_ID and process.env.IGDB_CLIENT_SECRET
 *   - core/apis/igdb-api.json: { "clientId": "...", "clientSecret": "..." }, gitignored
 *     (see .gitignore). Anything starting with REPLACE_WITH counts as "not filled in yet".
 * If neither is set every route except /status answers 503 with a clear message and the
 * client falls back to adding a game by title only. It never throws.
 *
 * Routes (all require a signed-in session, so the quota is not open to the internet):
 *   GET /status            { configured: bool }  (never 503; the client asks this first)
 *   GET /search?q=         up to 12 matches for a title
 *   GET /popular           the "Popular right now" list shown before the user types
 *   GET /game/:id          one game by its database id
 * Every game is returned in one normalised shape, not as the service's raw JSON:
 *   { igdb_id, title, year, genre, studio, platforms, cover_url }
 *
 * UNVERIFIED (no credentials were available when this was written): the exact query
 * syntax below (the text body, the field names, the `search` clause) and the image URL
 * pattern are written from the service's documented conventions, not from a response
 * seen live. The first real call with credentials should be compared against
 * normalizeGame()'s expectations; the unit test only covers normalizeGame() on a
 * hand-written sample.
 *
 * Provider limits honoured here: 4 requests per second (a minimum gap between calls,
 * queued, not dropped) and an app token that is refreshed before it expires, with one
 * refresh in flight at a time so a burst of searches does not stampede the token
 * endpoint. The limiter is per PROCESS: with several server workers the real rate can
 * reach 4 x workers, so move it to Redis (as RoomPresence does) before running more than
 * one worker against a real account.
 */

'use strict';

var https = require('https');
var fs = require('fs');
var path = require('path');
var querystring = require('querystring');
var auth = require('./identity/AuthMiddleware');

var FETCH_TIMEOUT_MS = 8000;
var MAX_RESPONSE_BYTES = 512 * 1024;
var MIN_GAP_MS = 260;                 // 4 requests per second, with a little air
var TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
var IMAGE_BASE = 'https://images.igdb.com/igdb/image/upload/t_cover_big/';

// ─── credentials ──────────────────────────────────────────────────────────────

var creds = null;
(function loadCredentials() {
  var id = process.env.IGDB_CLIENT_ID;
  var secret = process.env.IGDB_CLIENT_SECRET;
  if (id && secret) { creds = { clientId: id, clientSecret: secret }; return; }
  try {
    var raw = fs.readFileSync(
      path.join(process.env.WORKSPACE_LK || process.cwd(), 'core/apis/igdb-api.json'),
      'utf8'
    );
    var parsed = JSON.parse(raw);
    if (parsed.clientId && parsed.clientSecret &&
        parsed.clientId.indexOf('REPLACE_WITH') !== 0 &&
        parsed.clientSecret.indexOf('REPLACE_WITH') !== 0) {
      creds = { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
    }
  } catch (e) { /* file missing or not filled in yet: stays unconfigured */ }
})();

// ─── normalisation (pure; unit-tested) ───────────────────────────────────────

// The service's raw game object -> the one shape the client stores and shows.
// `raw` is an element of the array it returns; every field may be missing.
function normalizeGame(raw) {
  if (!raw || typeof raw.id !== 'number' || !raw.name) return null;
  var year = null;
  if (typeof raw.first_release_date === 'number') {
    year = new Date(raw.first_release_date * 1000).getUTCFullYear();   // seconds since the epoch
  }
  var genre = (raw.genres && raw.genres[0] && raw.genres[0].name) || null;
  // The studio is the company flagged as developer; fall back to the first company.
  var companies = raw.involved_companies || [];
  var dev = companies.filter(function (c) { return c && c.developer && c.company && c.company.name; })[0]
    || companies.filter(function (c) { return c && c.company && c.company.name; })[0];
  var imageId = raw.cover && raw.cover.image_id;
  return {
    igdb_id: raw.id,
    title: String(raw.name),
    year: year,
    genre: genre,
    studio: dev ? dev.company.name : null,
    platforms: (raw.platforms || []).map(function (p) { return p && (p.abbreviation || p.name); }).filter(Boolean).slice(0, 6),
    cover_url: imageId && /^[a-z0-9_]+$/i.test(imageId) ? IMAGE_BASE + imageId + '.jpg' : null
  };
}

// A user's search text as a query string literal: backslash and double quote escaped,
// control characters dropped, length capped. The text goes into a query BODY, so this
// is what keeps one search from rewriting the rest of the query.
function quoteForQuery(s) {
  return '"' + String(s).slice(0, 100).replace(/[\u0000-\u001f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

var FIELDS = 'fields name,first_release_date,cover.image_id,genres.name,' +
  'involved_companies.developer,involved_companies.company.name,platforms.abbreviation;';

// ─── HTTP plumbing ───────────────────────────────────────────────────────────

// One HTTPS request with a timeout and a response-size cap. Calls thenDo(err, {status, body}).
function request(options, body, thenDo) {
  var called = false;
  function done(err, data) { if (called) return; called = true; thenDo(err || null, data); }
  var req = https.request(Object.assign({ timeout: FETCH_TIMEOUT_MS }, options), function (res) {
    var chunks = [], size = 0;
    res.on('data', function (chunk) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) { req.destroy(); return done(new Error('response too large')); }
      chunks.push(chunk);
    });
    res.on('end', function () { done(null, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
    res.on('error', done);
  });
  req.on('timeout', function () { req.destroy(new Error('timed out')); });
  req.on('error', done);
  if (body) req.write(body);
  req.end();
}

// ─── app token (single flight, refreshed before it expires) ──────────────────

var token = null;            // { value, expiresAt }
var tokenWaiters = null;     // callbacks waiting on the refresh in flight

function withToken(thenDo) {
  if (token && token.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return thenDo(null, token.value);
  if (tokenWaiters) { tokenWaiters.push(thenDo); return; }
  tokenWaiters = [thenDo];
  var form = querystring.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: 'client_credentials' });
  request({
    hostname: 'id.twitch.tv', path: '/oauth2/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }
  }, form, function (err, res) {
    var waiters = tokenWaiters; tokenWaiters = null;
    var parsed = null;
    if (!err && res.status === 200) { try { parsed = JSON.parse(res.body); } catch (e) { err = e; } }
    else if (!err) err = new Error('token endpoint answered HTTP ' + res.status);
    if (!err && (!parsed || !parsed.access_token)) err = new Error('token endpoint sent no token');
    if (!err) token = { value: parsed.access_token, expiresAt: Date.now() + (parsed.expires_in || 0) * 1000 };
    waiters.forEach(function (w) { err ? w(err) : w(null, token.value); });
  });
}

// ─── rate limit: a minimum gap between calls to the service, queued in order ─

var lastCallAt = 0;
var queue = [];
var draining = false;

function schedule(task) {
  queue.push(task);
  if (draining) return;
  draining = true;
  (function next() {
    var t = queue.shift();
    if (!t) { draining = false; return; }
    var wait = Math.max(0, lastCallAt + MIN_GAP_MS - Date.now());
    setTimeout(function () { lastCallAt = Date.now(); t(); next(); }, wait);
  })();
}

// POST an apicalypse query to /v4/games and normalise the result. Calls thenDo(err, [game]).
function queryGames(queryText, thenDo) {
  if (!creds) return thenDo(new Error('not-configured'));
  schedule(function () {
    withToken(function (err, tokenValue) {
      if (err) return thenDo(err);
      request({
        hostname: 'api.igdb.com', path: '/v4/games', method: 'POST',
        headers: { 'Client-ID': creds.clientId, Authorization: 'Bearer ' + tokenValue, 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(queryText) }
      }, queryText, function (err, res) {
        if (err) return thenDo(err);
        if (res.status === 401) { token = null; return thenDo(new Error('the game database rejected the token')); }   // next call fetches a fresh one
        if (res.status === 429) return thenDo(new Error('the game database rate limit was reached'));
        if (res.status !== 200) return thenDo(new Error('the game database answered HTTP ' + res.status));
        var arr;
        try { arr = JSON.parse(res.body); } catch (e) { return thenDo(new Error('malformed JSON from the game database')); }
        thenDo(null, (Array.isArray(arr) ? arr : []).map(normalizeGame).filter(Boolean));
      });
    });
  });
}

function send(res, err, payload) {
  if (err) {
    if (err.message === 'not-configured') {
      return res.status(503).json({
        configured: false,
        error: 'Game search is not configured yet: add a client id and secret to core/apis/igdb-api.json (or set IGDB_CLIENT_ID and IGDB_CLIENT_SECRET).'
      });
    }
    // Never echo upstream bodies: they can contain the client id.
    return res.status(502).json({ error: String(err.message || err) });
  }
  res.json(payload);
}

module.exports = function (route, app) {

  app.get(route + 'status', auth.requireAuth, function (req, res) {
    res.json({ configured: !!creds });
  });

  app.get(route + 'search', auth.requireAuth, function (req, res) {
    var q = (req.query.q || '').toString().trim();
    if (!q) return res.json({ games: [] });
    queryGames('search ' + quoteForQuery(q) + '; ' + FIELDS + ' limit 12;', function (err, games) {
      send(res, err, err ? null : { games: games });
    });
  });

  // UNVERIFIED query: "well rated and well known, with a cover". Replace with a
  // dedicated popularity source if the service offers one for this account.
  app.get(route + 'popular', auth.requireAuth, function (req, res) {
    queryGames(FIELDS + ' where cover != null & total_rating_count > 200; sort total_rating_count desc; limit 12;', function (err, games) {
      send(res, err, err ? null : { games: games });
    });
  });

  app.get(route + 'game/:id', auth.requireAuth, function (req, res) {
    var id = parseInt(req.params.id, 10);
    if (!(id > 0)) return res.status(400).json({ error: 'bad id' });
    queryGames(FIELDS + ' where id = ' + id + '; limit 1;', function (err, games) {
      if (err) return send(res, err);
      if (!games[0]) return res.status(404).json({ error: 'not found' });
      res.json({ game: games[0] });
    });
  });

  app.get(route, function (req, res) { res.end('GameDbProxyServer is running!'); });
};

module.exports._normalizeGame = normalizeGame;
module.exports._quoteForQuery = quoteForQuery;
