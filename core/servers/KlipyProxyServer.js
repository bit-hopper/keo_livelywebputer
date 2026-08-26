/**
 * core/servers/KlipyProxyServer.js
 *
 * Server-side proxy for the Klipy GIF/sticker search API
 * (https://klipy.com/developers), used by the room chat's GIF/sticker picker
 * (lively.identity.MediaPickerDialog / RoomView.js). Klipy's own API shape
 * embeds the API key directly in the request path
 * (`https://api.klipy.com/api/v1/<API_KEY>/gifs/search`), so calling it
 * straight from browser JS would ship the key to every client and expose it
 * in the Network tab — this route holds the real key server-side (never
 * sent to the browser) and forwards only the search/trending JSON through.
 * Actual GIF/sticker image bytes are NOT proxied — the client loads those
 * directly from Klipy's own CDN URLs found in the JSON, same as any other
 * hot-linked image; only the JSON call (the one that needs the secret key)
 * goes through this server.
 *
 * Key comes from (checked in this order):
 *   - process.env.KLIPY_API_KEY
 *   - core/apis/klipy-api.json — { "apiKey": "..." }, gitignored (see
 *     .gitignore's "Klipy API" section), same pattern as
 *     core/apis/github-api.json / GithubOAuth.js. Ships with a placeholder
 *     value until a real key is dropped in.
 * If neither is set, the routes below respond 503 with a clear message
 * instead of throwing — the picker's GIF/Sticker tabs show a "not
 * configured" empty state rather than erroring the whole dialog.
 *
 * Response shape note: Klipy's exact per-item JSON field for the actual
 * image URL (nested under a `files` key, per third-party docs) could not be
 * confirmed against a live response while building this — no API key was
 * available in that session. This proxy forwards Klipy's JSON through
 * unmodified (see _extractMediaUrl in MediaPickerDialog.js for the
 * client-side parsing, which defensively searches the response for a
 * plausible media URL rather than assuming one exact field path). Revisit
 * that function once a real key is in place and a live response can be
 * inspected.
 */

'use strict';

var https = require('https');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var querystring = require('querystring');
var auth = require('./identity/AuthMiddleware');

var FETCH_TIMEOUT_MS = 8000;
var MAX_RESPONSE_BYTES = 512 * 1024;
var KLIPY_HOST = 'api.klipy.com';

var apiKey = process.env.KLIPY_API_KEY || null;
(function loadApiKeyFromConfigFile() {
  if (apiKey) return;
  try {
    var raw = fs.readFileSync(
      path.join(process.env.WORKSPACE_LK || process.cwd(), 'core/apis/klipy-api.json'),
      'utf8'
    );
    var parsed = JSON.parse(raw);
    if (parsed.apiKey && parsed.apiKey.indexOf('REPLACE_WITH') !== 0) {
      apiKey = parsed.apiKey;
    }
  } catch (e) { /* file missing or not yet filled in — stays unconfigured */ }
})();

// Fetch https://api.klipy.com/api/v1/<key>/<category>/<action>?<query>,
// same timeout/size-cap/JSON-parse shape as identity/DomainVerifier.js's
// fetchWellKnown. Calls thenDo(err, parsedJson).
function klipyRequest(category, action, query, thenDo) {
  if (!apiKey) return thenDo(new Error('not-configured'));

  var qs = querystring.stringify(query);
  var reqPath = '/api/v1/' + encodeURIComponent(apiKey) + '/' + category + '/' + action +
    (qs ? '?' + qs : '');

  var called = false;
  function done(err, data) {
    if (called) return;
    called = true;
    thenDo(err || null, data);
  }

  var req = https.get(
    { hostname: KLIPY_HOST, path: reqPath, timeout: FETCH_TIMEOUT_MS },
    function (res) {
      var chunks = [];
      var size = 0;
      res.on('data', function (chunk) {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy();
          return done(new Error('Klipy response exceeded ' + MAX_RESPONSE_BYTES + ' bytes'));
        }
        chunks.push(chunk);
      });
      res.on('end', function () {
        var bodyText = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return done(new Error('Klipy responded HTTP ' + res.statusCode + ': ' + bodyText.slice(0, 500)));
        }
        try {
          done(null, JSON.parse(bodyText));
        } catch (e) {
          done(new Error('Malformed JSON from Klipy: ' + e.message));
        }
      });
      res.on('error', function (err) { done(err); });
    }
  );
  req.on('timeout', function () { req.destroy(new Error('Timed out contacting Klipy')); });
  req.on('error', function (err) { done(err); });
}

function sendKlipyResult(res, err, data) {
  if (err) {
    if (err.message === 'not-configured') {
      return res.status(503).json({
        error: 'GIF/sticker search is not configured yet — add a real Klipy API key to core/apis/klipy-api.json (or set KLIPY_API_KEY).',
      });
    }
    return res.status(502).json({ error: String(err.message || err) });
  }
  res.json(data);
}

// Klipy's customer_id (its own per-end-user id for its monetization
// metrics) caps out at 128 chars (confirmed live via Klipy's own 422
// validation error) — this app's DIDs are did:jwk:<base64url-encoded-JWK>,
// routinely 170+ chars, so the raw DID doesn't fit. Hash it down to a
// short, still-per-user-stable id instead of truncating it (truncating a
// base64 JWK could collide across different keys sharing a prefix).
function customerIdFor(req) {
  var did = (req.identity && req.identity.did) || 'anonymous';
  return crypto.createHash('sha256').update(did).digest('hex').slice(0, 40);
}

module.exports = function (route, app) {
  ['gifs', 'stickers'].forEach(function (category) {

    app.get(route + category + '/search', auth.requireAuth, function (req, res) {
      var q = (req.query.q || '').toString().slice(0, 200);
      if (!q) return res.json({ result: true, data: { data: [], current_page: 1, per_page: 0, has_next: false } });
      klipyRequest(category, 'search', {
        q: q,
        page: parseInt(req.query.page, 10) || 1,
        per_page: Math.min(parseInt(req.query.per_page, 10) || 24, 50),
        customer_id: customerIdFor(req),
      }, function (err, data) { sendKlipyResult(res, err, data); });
    });

    app.get(route + category + '/trending', auth.requireAuth, function (req, res) {
      klipyRequest(category, 'trending', {
        page: parseInt(req.query.page, 10) || 1,
        per_page: Math.min(parseInt(req.query.per_page, 10) || 24, 50),
        customer_id: customerIdFor(req),
      }, function (err, data) { sendKlipyResult(res, err, data); });
    });
  });

  app.get(route, function (req, res) { res.end('KlipyProxyServer is running!'); });
};
