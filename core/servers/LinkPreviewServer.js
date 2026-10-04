/**
 * core/servers/LinkPreviewServer.js
 *
 * Server-side proxy that fetches an arbitrary external URL and extracts its
 * Open Graph / Twitter Card / plain <title> metadata, for rendering a rich
 * "link preview" card (title/description/image) under a bare URL pasted
 * into a postcard or wiki page. See PostCardUtils.js's hydrateLinkPreviews
 * for the client side.
 *
 * Mirrors RssProxyServer.js's shape and SSRF defenses almost exactly (same
 * dns.lookup()-then-check-then-connect-to-the-checked-address pattern, same
 * redirect re-validation) — see that file's header for the full rationale.
 * Differences:
 *   - No auth.requireAuth here. Postcards and wiki pages can be public and
 *     viewed by a signed-out visitor (PostCardView.js's
 *     envelope.visibility === "public" branch, WikiView.js has no auth
 *     branch at all), so gating preview fetches behind login would silently
 *     break previews for exactly the visitors most likely to see them.
 *     That makes this reachable anonymously, which is a more attractive
 *     abuse target than the authenticated RSS proxy — the per-IP rate
 *     limit below is this route's compensating control, not a perfect one.
 *   - Fetches HTML, not XML, and stops reading once `</head>` shows up in
 *     the accumulated body (metadata lives there) rather than reading the
 *     whole page, bounded by MAX_RESPONSE_BYTES regardless.
 *   - Results are cached in-memory by URL (CACHE_TTL_MS) since a link's
 *     preview rarely changes and the same URL is commonly pasted/viewed
 *     many times.
 *
 * Response fields (title/description/siteName) are plain text, already
 * un-escaped from the page's HTML entities — the client must render them
 * via textContent, never innerHTML, same rule as RssProxyServer's entries.
 * `image` is a URL the client hot-links directly from its original host
 * (not proxied through here, same tradeoff KlipyProxyServer.js documents
 * for GIF images) — client must still scheme-check it before use.
 *
 * Also detects (detectEmbed, pure string transform, no extra network call)
 * whether the URL is a Spotify/YouTube/SoundCloud/Apple Music link and, if
 * so, includes `provider`/`embedUrl` fields the client renders as a
 * sandboxed <iframe> instead of (or alongside) the static card — see
 * PostCardUtils.js's buildLinkPreviewCard. The client re-validates
 * embedUrl's hostname against its own short allow-list before ever using it
 * as an iframe src; this file is the one that decides which hosts qualify.
 */

'use strict';

var http = require('http');
var https = require('https');
var dns = require('dns');

var FETCH_TIMEOUT_MS = 8000;
var MAX_RESPONSE_BYTES = 512 * 1024;
var MAX_REDIRECTS = 3;
var MAX_TITLE_LEN = 200;
var MAX_DESC_LEN = 300;

var CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — previews rarely change
var CACHE_MAX_ENTRIES = 1000;
var cache = new Map(); // url -> { expiresAt, status, body }

var RATE_LIMIT_WINDOW_MS = 60 * 1000;
var RATE_LIMIT_MAX = 20; // per IP per window
var rateLimitState = new Map(); // ip -> { windowStart, count }
setInterval(function () {
  var now = Date.now();
  rateLimitState.forEach(function (entry, ip) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitState.delete(ip);
  });
}, 10 * 60 * 1000).unref();

function isRateLimited(ip) {
  var now = Date.now();
  var entry = rateLimitState.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// Identical to RssProxyServer.js's isPrivateAddress — kept as its own copy
// rather than a shared require, matching this codebase's existing tolerance
// for small per-module copies of this exact SSRF-guard pattern (see
// LocalMap.js's own comment, cited elsewhere in this codebase, on the same
// convention).
function isPrivateAddress(address, family) {
  if (family === 6) {
    var a = address.toLowerCase();
    if (a === '::1') return true;
    if (a.indexOf('fe80:') === 0) return true;
    if (a.indexOf('fc') === 0 || a.indexOf('fd') === 0) return true;
    if (a.indexOf('::ffff:') === 0) return isPrivateAddress(a.slice(7), 4);
    return false;
  }
  var parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(function (n) { return isNaN(n); })) return true;
  var a0 = parts[0], a1 = parts[1];
  if (a0 === 127) return true;
  if (a0 === 10) return true;
  if (a0 === 172 && a1 >= 16 && a1 <= 31) return true;
  if (a0 === 192 && a1 === 168) return true;
  if (a0 === 169 && a1 === 254) return true;
  if (a0 === 0) return true;
  return false;
}

// Fetches targetUrl's HTML as text (stopping early once </head> is seen),
// following up to redirectsLeft redirects (each hop re-validated). Calls
// thenDo(err, { finalUrl, body }). Rejects non-HTML content types outright
// via the response headers, before reading any body.
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
      host: address,
      family: family,
      servername: parsed.protocol === 'https:' ? hostname : undefined,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        Host: hostname,
        'User-Agent': 'LivelyKernel-LinkPreview/1.0 (+link unfurling)',
        Accept: 'text/html,application/xhtml+xml',
      },
      timeout: FETCH_TIMEOUT_MS,
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        var nextUrl;
        try { nextUrl = new URL(res.headers.location, targetUrl).toString(); } catch (e) { return done(new Error('Invalid redirect target')); }
        return fetchOnce(nextUrl, redirectsLeft - 1, done);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return done(new Error('Server responded HTTP ' + res.statusCode));
      }
      var contentType = String(res.headers['content-type'] || '');
      // Lenient on a missing content-type (some servers omit it), but an
      // explicit non-text one (image/video/pdf/etc.) is rejected before
      // reading the body at all.
      if (contentType && !/^text\/|html|xml/i.test(contentType)) {
        res.resume();
        return done(new Error('Not an HTML page (' + contentType + ')'));
      }
      var chunks = [];
      var size = 0;
      res.on('data', function (chunk) {
        size += chunk.length;
        chunks.push(chunk);
        if (size > MAX_RESPONSE_BYTES) { req.destroy(); return done(null, { finalUrl: targetUrl, body: Buffer.concat(chunks).toString('utf8') }); }
        // Early-stop once we've seen the closing </head> — metadata never
        // lives past it, and pages can run to many MB beyond that point.
        if (size > 512 && /<\/head\s*>/i.test(Buffer.concat(chunks).toString('utf8'))) {
          req.destroy();
          return done(null, { finalUrl: targetUrl, body: Buffer.concat(chunks).toString('utf8') });
        }
      });
      res.on('end', function () { done(null, { finalUrl: targetUrl, body: Buffer.concat(chunks).toString('utf8') }); });
      res.on('error', function (err) { done(err); });
    });
    req.on('timeout', function () { req.destroy(new Error('Timed out contacting host')); });
    req.on('error', function (err) { done(err); });
    req.end();
  });
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, function (m, hex) { return String.fromCodePoint(parseInt(hex, 16)); })
    .replace(/&#(\d+);/g, function (m, dec) { return String.fromCodePoint(parseInt(dec, 10)); });
}

function truncate(s, max) {
  if (!s) return s;
  s = s.trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function safeAbsoluteUrl(raw, baseUrl) {
  if (!raw) return null;
  try {
    var u = new URL(raw, baseUrl);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : null;
  } catch (e) { return null; }
}

// Pure pattern-matching against the pasted URL itself -- no network call, no
// dependency on fetchOnce/extractMeta succeeding. Each of these four
// providers' embed players can be reached by a direct string transform of
// the original URL, so there's no need for a real oEmbed round-trip (and no
// oEmbed proxy exists anywhere in this codebase -- see the module header).
// Returns { provider, embedUrl } or null. The client (PostCardUtils.js)
// keeps its own short hostname-only allow-list to re-validate embedUrl
// before ever setting an <iframe src> -- same "small per-module copy of a
// security-relevant list" tolerance this file's isPrivateAddress comment
// already documents, not an oversight.
function detectEmbed(targetUrl) {
  var u;
  try { u = new URL(targetUrl); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  var host = u.hostname.toLowerCase();

  if (host === 'open.spotify.com') {
    var sm = /^\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/.exec(u.pathname);
    if (sm) return { provider: 'spotify', embedUrl: 'https://open.spotify.com/embed/' + sm[1] + '/' + sm[2] };
    return null;
  }
  if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
    var vid = u.searchParams.get('v');
    // Exactly 11 chars -- YouTube's video ids are always this length.
    // BUG FIX: the old /^[A-Za-z0-9_-]+$/ (any non-empty length) accepted
    // a mid-typed, not-yet-complete id (e.g. "d", "dQ", ... while someone
    // is still typing/pasting a full watch URL into the editor) as a
    // "valid" embed, which could briefly render a real (bogus) heavyweight
    // YouTube iframe for a nonexistent video every time the client's
    // debounce window happened to land mid-id -- confirmed live.
    if (vid && /^[A-Za-z0-9_-]{11}$/.test(vid)) return { provider: 'youtube', embedUrl: 'https://www.youtube.com/embed/' + vid };
    return null;
  }
  if (host === 'youtu.be') {
    var ym = /^\/([A-Za-z0-9_-]{11})(?:[/?]|$)/.exec(u.pathname);
    if (ym) return { provider: 'youtube', embedUrl: 'https://www.youtube.com/embed/' + ym[1] };
    return null;
  }
  if (host === 'soundcloud.com' || host === 'www.soundcloud.com') {
    // SoundCloud's player widget resolves the track/set from the original
    // URL itself (no id lookup needed) -- any soundcloud.com/<user>/<track>
    // or /<user>/sets/<set> path is embeddable this way.
    if (/^\/[^\/]+\/[^\/]+/.test(u.pathname)) {
      return { provider: 'soundcloud', embedUrl: 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(u.toString()) + '&auto_play=false' };
    }
    return null;
  }
  if (host === 'music.apple.com') {
    // Swap host only -- same path/query, matching Apple's own documented
    // embed convention (music.apple.com -> embed.music.apple.com).
    return { provider: 'apple-music', embedUrl: 'https://embed.music.apple.com' + u.pathname + u.search };
  }
  return null;
}

// Naive-but-sufficient meta tag extraction (not a general HTML parser,
// matching RssProxyServer.js's own naive-tag-strip pragmatism) — meta/title
// tags are simple enough that this is reliable in practice, and a missed
// one just means a sparser preview, not broken output.
function extractMeta(html) {
  var metas = {};
  var metaRe = /<meta\s+([^>]*)>/gi;
  var m;
  while ((m = metaRe.exec(html))) {
    var attrs = m[1];
    var nameMatch = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(attrs);
    var contentMatch = /content\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (nameMatch && contentMatch) {
      metas[nameMatch[1].toLowerCase()] = decodeEntities(contentMatch[1]);
    }
  }
  var titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  var plainTitle = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : null;

  return {
    title: metas['og:title'] || metas['twitter:title'] || plainTitle || null,
    description: metas['og:description'] || metas['twitter:description'] || metas.description || null,
    image: metas['og:image:secure_url'] || metas['og:image'] || metas['twitter:image'] || null,
    siteName: metas['og:site_name'] || null,
  };
}

function unfurl(targetUrl, thenDo) {
  var cached = cache.get(targetUrl);
  if (cached && cached.expiresAt > Date.now()) return thenDo(null, cached.status, cached.body);

  // Embed detection is a pure string transform of targetUrl -- computed up
  // front, independent of whatever fetchOnce below does. This matters: a
  // real Spotify/YouTube/SoundCloud/Apple Music page is a plausible
  // candidate for this crude scraper to fail against (consent walls, bot
  // detection, JS-gated content, a non-200 from a CDN edge) and that must
  // not take the embed down with it -- the whole point of the embed is that
  // it doesn't need OG scraping to be useful.
  var embed = detectEmbed(targetUrl);

  function cacheAndReturn(status, body) {
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value); // FIFO evict oldest
    cache.set(targetUrl, { expiresAt: Date.now() + CACHE_TTL_MS, status: status, body: body });
    thenDo(null, status, body);
  }

  fetchOnce(targetUrl, MAX_REDIRECTS, function (err, result) {
    if (err) {
      // Scrape failed outright -- still a usable response if we detected an
      // embed (title/description/image just stay empty; the player itself
      // carries that information once it loads).
      if (embed) return cacheAndReturn(200, { url: targetUrl, provider: embed.provider, embedUrl: embed.embedUrl });
      return thenDo(err);
    }
    var meta = extractMeta(result.body);
    var hostname;
    try { hostname = new URL(result.finalUrl).hostname; } catch (e) { hostname = ''; }

    if (!meta.title && !meta.description && !meta.image && !embed) {
      var emptyBody = { error: 'No preview metadata found' };
      cache.set(targetUrl, { expiresAt: Date.now() + CACHE_TTL_MS, status: 422, body: emptyBody });
      return thenDo(null, 422, emptyBody);
    }

    var body = {
      url: result.finalUrl,
      title: truncate(meta.title, MAX_TITLE_LEN),
      description: truncate(meta.description, MAX_DESC_LEN),
      image: safeAbsoluteUrl(meta.image, result.finalUrl),
      siteName: meta.siteName || hostname,
    };
    if (embed) { body.provider = embed.provider; body.embedUrl = embed.embedUrl; }
    cacheAndReturn(200, body);
  });
}

module.exports = function (route, app) {

  app.get(route + 'unfurl', function (req, res) {
    var ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests — try again shortly' });

    var targetUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!targetUrl) return res.status(400).json({ error: 'url is required' });
    if (targetUrl.length > 2000) return res.status(400).json({ error: 'url too long' });

    unfurl(targetUrl, function (err, status, body) {
      if (err) return res.status(502).json({ error: err.message });
      res.status(status).json(body);
    });
  });

  app.get(route, function (req, res) { res.end('LinkPreviewServer is running!'); });
};
