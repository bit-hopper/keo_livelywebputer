/**
 * core/servers/GoogleBooksProxyServer.js
 *
 * Server-side proxy for the Google Books Volumes API
 * (https://www.googleapis.com/books/v1/volumes), used by the Books world
 * template's add-a-book search (lively.books.Books). Confirmed live
 * 2026-10-05 (see books-template.md): calling this endpoint keyless from the
 * browser is CORS-fine but hits Google's shared default-consumer-project
 * daily quota, which was already exhausted on the first two calls made while
 * investigating it — keyless use is not viable for a real feature. This
 * proxy holds a real per-project API key server-side (never sent to the
 * browser) so the app gets its own quota instead of competing with every
 * other keyless caller on the internet for Google's shared bucket.
 *
 * Key comes from (checked in this order):
 *   - process.env.GOOGLE_BOOKS_API_KEY
 *   - core/apis/google-books-api.json — { "apiKey": "..." }, gitignored (see
 *     .gitignore's "Google Books API" section), same placeholder-file
 *     pattern as core/apis/klipy-api.json / core/apis/511-api.json. Ships
 *     with a REPLACE_WITH_... placeholder until a real key is dropped in.
 * If neither is set, the search route responds 503 with a clear message
 * instead of throwing — Books.js's add-a-book search falls back to Open
 * Library only in that case (see books-template.md's Research Finding #3),
 * rather than erroring the whole dialog.
 *
 * This proxies only the metadata/search JSON call (the one that needs the
 * secret key). Actual cover-image bytes are NOT proxied — Google Books'
 * volumeInfo.imageLinks.* URLs (books.google.com/books/content?...) are
 * plain public, keyless image URLs; the client hot-links those directly as
 * an <img src>, same as Open Library's covers.openlibrary.org URLs.
 *
 * Response shape: forwarded through from Google unmodified (same policy as
 * KlipyProxyServer.js) rather than normalized here, since the Books.js
 * client-side schema wasn't written yet when this proxy was built — confirmed
 * live field names to expect on each item: volumeInfo.{title, authors,
 * description, imageLinks.thumbnail, industryIdentifiers}.
 */

'use strict';

var https = require('https');
var fs = require('fs');
var path = require('path');
var querystring = require('querystring');
var auth = require('./identity/AuthMiddleware');

var FETCH_TIMEOUT_MS = 8000;
var MAX_RESPONSE_BYTES = 512 * 1024;
var API_HOST = 'www.googleapis.com';

var apiKey = process.env.GOOGLE_BOOKS_API_KEY || null;
(function loadApiKeyFromConfigFile() {
  if (apiKey) return;
  try {
    var raw = fs.readFileSync(
      path.join(process.env.WORKSPACE_LK || process.cwd(), 'core/apis/google-books-api.json'),
      'utf8'
    );
    var parsed = JSON.parse(raw);
    if (parsed.apiKey && parsed.apiKey.indexOf('REPLACE_WITH') !== 0) {
      apiKey = parsed.apiKey;
    }
  } catch (e) { /* file missing or not yet filled in — stays unconfigured */ }
})();

// GET https://www.googleapis.com/books/v1/volumes?q=...&key=...&maxResults=...
// Calls thenDo(err, parsedJson).
function volumesRequest(query, thenDo) {
  if (!apiKey) return thenDo(new Error('not-configured'));

  var qs = querystring.stringify(Object.assign({ key: apiKey }, query));
  var reqPath = '/books/v1/volumes?' + qs;

  var called = false;
  function done(err, data) {
    if (called) return;
    called = true;
    thenDo(err || null, data);
  }

  var req = https.get(
    { hostname: API_HOST, path: reqPath, timeout: FETCH_TIMEOUT_MS },
    function (res) {
      var chunks = [];
      var size = 0;
      res.on('data', function (chunk) {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy();
          return done(new Error('Google Books response exceeded ' + MAX_RESPONSE_BYTES + ' bytes'));
        }
        chunks.push(chunk);
      });
      res.on('end', function () {
        var bodyText = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return done(new Error('Google Books responded HTTP ' + res.statusCode + ': ' + bodyText.slice(0, 500)));
        }
        try {
          done(null, JSON.parse(bodyText));
        } catch (e) {
          done(new Error('Malformed JSON from Google Books: ' + e.message));
        }
      });
      res.on('error', function (err) { done(err); });
    }
  );
  req.on('timeout', function () { req.destroy(new Error('Timed out contacting Google Books')); });
  req.on('error', function (err) { done(err); });
}

function sendVolumesResult(res, err, data) {
  if (err) {
    if (err.message === 'not-configured') {
      return res.status(503).json({
        error: 'Google Books search is not configured yet — add a real API key to core/apis/google-books-api.json (or set GOOGLE_BOOKS_API_KEY).',
      });
    }
    return res.status(502).json({ error: String(err.message || err) });
  }
  res.json(data);
}

module.exports = function (route, app) {

  app.get(route + 'search', auth.requireAuth, function (req, res) {
    var q = (req.query.q || '').toString().slice(0, 200);
    if (!q) return res.json({ totalItems: 0, items: [] });
    volumesRequest({
      q: q,
      maxResults: Math.min(parseInt(req.query.maxResults, 10) || 10, 40),
    }, function (err, data) { sendVolumesResult(res, err, data); });
  });

  app.get(route, function (req, res) { res.end('GoogleBooksProxyServer is running!'); });
};
