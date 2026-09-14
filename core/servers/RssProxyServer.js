/**
 * core/servers/RssProxyServer.js
 *
 * Server-side proxy that fetches and parses an external RSS/Atom feed URL on
 * behalf of PostCardMailbox.js's RSS tab. A plain browser fetch() straight
 * to an arbitrary external feed URL almost always fails on CORS (most feeds
 * never set Access-Control-Allow-Origin) — this mirrors the shape of
 * KlipyProxyServer.js/TransitProxyServer.js (server-side fetch + JSON
 * normalization), except the reason for the server hop here is CORS, not
 * hiding a secret API key.
 *
 * Unlike those two proxies, the target host is caller-supplied, not fixed —
 * that makes this an SSRF surface (a signed-in user could ask this server to
 * fetch an internal-network URL). Defenses, best-effort not bulletproof:
 *   - auth.requireAuth: only signed-in users can call this at all.
 *   - http:/https: only, and the connection is made to the address this
 *     module itself resolved via dns.lookup() (checked against
 *     loopback/private/link-local ranges BEFORE connecting), not by handing
 *     the raw hostname to http(s).request — a hostname whose DNS record
 *     points at an internal address is caught the same as a literal
 *     internal-looking URL. This still doesn't fully close true DNS
 *     rebinding (a name that resolves differently between two separate
 *     lookups), since nothing here pins a single resolution across a
 *     redirect chain beyond re-checking each hop the same way.
 *   - 8s timeout, 2MB response cap, at most 3 redirects (each one
 *     re-validated from scratch).
 *
 * Response entries are sent as plain text (title/summary run through a
 * naive tag-stripping pass server-side) — PostCardMailbox.js's RSS tab must
 * still render them via textContent, never innerHTML, since the feed itself
 * is untrusted third-party content.
 */

'use strict';

var http = require('http');
var https = require('https');
var dns = require('dns');
var auth = require('./identity/AuthMiddleware');
var XMLParser = require('fast-xml-parser').XMLParser;

var FETCH_TIMEOUT_MS = 8000;
var MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
var MAX_REDIRECTS = 3;
var MAX_ENTRIES = 30;

function isPrivateAddress(address, family) {
  if (family === 6) {
    var a = address.toLowerCase();
    if (a === '::1') return true;
    if (a.indexOf('fe80:') === 0) return true;              // link-local
    if (a.indexOf('fc') === 0 || a.indexOf('fd') === 0) return true; // unique local fc00::/7
    if (a.indexOf('::ffff:') === 0) return isPrivateAddress(a.slice(7), 4); // IPv4-mapped
    return false;
  }
  var parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(function (n) { return isNaN(n); })) return true; // malformed -> reject closed
  var a0 = parts[0], a1 = parts[1];
  if (a0 === 127) return true;                          // loopback
  if (a0 === 10) return true;                            // 10.0.0.0/8
  if (a0 === 172 && a1 >= 16 && a1 <= 31) return true;   // 172.16.0.0/12
  if (a0 === 192 && a1 === 168) return true;             // 192.168.0.0/16
  if (a0 === 169 && a1 === 254) return true;             // link-local
  if (a0 === 0) return true;                              // 0.0.0.0/8
  return false;
}

// Fetches targetUrl's body as text, following up to redirectsLeft redirects
// (each hop re-validated by the same SSRF checks). Calls thenDo(err, text).
function fetchOnce(targetUrl, redirectsLeft, thenDo) {
  var parsed;
  try { parsed = new URL(targetUrl); } catch (e) { return thenDo(new Error('Invalid URL')); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return thenDo(new Error('Only http/https URLs are allowed'));
  }
  var hostname = parsed.hostname;
  if (hostname === 'localhost') return thenDo(new Error('That host is not allowed'));

  dns.lookup(hostname, function (dnsErr, address, family) {
    if (dnsErr) return thenDo(new Error('Could not resolve host: ' + dnsErr.message));
    if (isPrivateAddress(address, family)) return thenDo(new Error('That host is not allowed'));

    var lib = parsed.protocol === 'https:' ? https : http;
    var called = false;
    function done(err, data) { if (called) return; called = true; thenDo(err || null, data); }

    var req = lib.request({
      // Connect to the address already vetted above, not the hostname
      // itself — the Host header (and TLS servername, for SNI + hostname
      // verification) still carry the real hostname so normal virtual-
      // hosted/SNI-routed targets keep working.
      host: address,
      family: family,
      servername: parsed.protocol === 'https:' ? hostname : undefined,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        Host: hostname,
        'User-Agent': 'LivelyKernel-RssProxy/1.0',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      timeout: FETCH_TIMEOUT_MS,
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        var nextUrl;
        try { nextUrl = new URL(res.headers.location, targetUrl).toString(); } catch (e) { return done(new Error('Invalid redirect target')); }
        return fetchOnce(nextUrl, redirectsLeft - 1, done);
      }
      var chunks = [];
      var size = 0;
      res.on('data', function (chunk) {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(); return done(new Error('Feed response too large')); }
        chunks.push(chunk);
      });
      res.on('end', function () {
        if (res.statusCode !== 200) return done(new Error('Feed server responded HTTP ' + res.statusCode));
        done(null, Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', function (err) { done(err); });
    });
    req.on('timeout', function () { req.destroy(new Error('Timed out contacting feed host')); });
    req.on('error', function (err) { done(err); });
    req.end();
  });
}

function asArray(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }

// fast-xml-parser gives back a plain string for a tag with no attributes,
// or { '@_...': ..., '#text': ... } for one that has attributes alongside
// text content (e.g. Atom's <title type="html">...</title>).
function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return v['#text'] != null ? String(v['#text']) : '';
  return String(v);
}

// RSS <link> is plain text; Atom <link> is one (or several, disambiguated
// by rel=) self-closing element with an href attribute.
function linkOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    var alt = v.find(function (l) { return l && (l['@_rel'] === 'alternate' || !l['@_rel']); });
    return (alt && alt['@_href']) || (v[0] && v[0]['@_href']) || '';
  }
  if (typeof v === 'object') return v['@_href'] || textOf(v);
  return '';
}

// Naive tag-strip for a display snippet — NOT an HTML sanitizer. The client
// must still render this via textContent (see this file's header); this
// just keeps the payload small and free of literal markup for the preview.
function cleanSummary(raw) {
  var text = String(raw || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 400 ? text.slice(0, 400) + '…' : text;
}

// Calls thenDo via return value (synchronous) — throws on unrecognized XML,
// caught by the route handler.
function normalizeFeed(xmlText) {
  var parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });
  var doc = parser.parse(xmlText);

  if (doc.feed) { // Atom
    var feed = doc.feed;
    var entries = asArray(feed.entry).slice(0, MAX_ENTRIES).map(function (e) {
      return {
        title: textOf(e.title) || '(untitled)',
        link: linkOf(e.link),
        published: textOf(e.published || e.updated) || null,
        summary: cleanSummary(textOf(e.summary || e.content)),
      };
    });
    return { title: textOf(feed.title), link: linkOf(feed.link), entries: entries };
  }

  var channel = doc.rss && doc.rss.channel;
  if (channel) { // RSS 2.0
    var items = asArray(channel.item).slice(0, MAX_ENTRIES).map(function (it) {
      return {
        title: textOf(it.title) || '(untitled)',
        link: textOf(it.link),
        published: textOf(it.pubDate || it['dc:date']) || null,
        summary: cleanSummary(textOf(it.description)),
      };
    });
    return { title: textOf(channel.title), link: textOf(channel.link), entries: items };
  }

  throw new Error('Unrecognized feed format (not RSS 2.0 or Atom)');
}

module.exports = function (route, app) {

  app.get(route + 'fetch', auth.requireAuth, function (req, res) {
    var targetUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!targetUrl) return res.status(400).json({ error: 'url is required' });
    if (targetUrl.length > 2000) return res.status(400).json({ error: 'url too long' });

    fetchOnce(targetUrl, MAX_REDIRECTS, function (err, xmlText) {
      if (err) return res.status(502).json({ error: err.message });
      var normalized;
      try { normalized = normalizeFeed(xmlText); }
      catch (e) { return res.status(422).json({ error: 'Could not parse feed: ' + e.message }); }
      res.json(normalized);
    });
  });

  app.get(route, function (req, res) { res.end('RssProxyServer is running!'); });
};
