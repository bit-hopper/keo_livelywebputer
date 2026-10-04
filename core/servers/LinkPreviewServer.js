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
// oEmbed enrichment (see discoverOembedUrl/fetchOembed below) is a second,
// smaller follow-up fetch -- kept short and tightly bounded since it's
// purely a nice-to-have on top of an already-successful primary fetch, not
// load-bearing the way fetchOnce is.
var OEMBED_FETCH_TIMEOUT_MS = 4000;
var MAX_OEMBED_BYTES = 64 * 1024;

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

// Shared SSRF-safe GET core (dns.lookup()-then-check-then-connect-to-the-
// checked-address, same pattern as RssProxyServer.js's own fetch) — used by
// both fetchOnce (the primary HTML scrape) and fetchOembed (the smaller
// oEmbed follow-up below). Kept as ONE function within this file (rather
// than this file's usual per-module-copy tolerance for the SSRF guard
// itself) since both call sites need the exact same network-level
// protection and there's no reason to risk a second copy drifting out of
// sync with the first.
//
// opts: { timeoutMs, maxBytes, accept (Accept header value),
//   checkContentType(contentType) -> bool, shouldStopEarly(size, bodySoFar) -> bool }
// Calls thenDo(err, { finalUrl, body }).
function _ssrfSafeGet(targetUrl, redirectsLeft, opts, thenDo) {
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
        Accept: opts.accept,
      },
      timeout: opts.timeoutMs,
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        var nextUrl;
        try { nextUrl = new URL(res.headers.location, targetUrl).toString(); } catch (e) { return done(new Error('Invalid redirect target')); }
        return _ssrfSafeGet(nextUrl, redirectsLeft - 1, opts, done);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return done(new Error('Server responded HTTP ' + res.statusCode));
      }
      var contentType = String(res.headers['content-type'] || '');
      if (!opts.checkContentType(contentType)) {
        res.resume();
        return done(new Error('Unexpected content type (' + contentType + ')'));
      }
      var chunks = [];
      var size = 0;
      res.on('data', function (chunk) {
        size += chunk.length;
        chunks.push(chunk);
        if (size > opts.maxBytes) { req.destroy(); return done(null, { finalUrl: targetUrl, body: Buffer.concat(chunks).toString('utf8') }); }
        if (opts.shouldStopEarly(size, Buffer.concat(chunks).toString('utf8'))) {
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

// Fetches targetUrl's HTML as text (stopping early once </head> is seen) —
// metadata never lives past it, and pages can run to many MB beyond that
// point. Rejects non-HTML content types outright via the response headers,
// before reading any body.
function fetchOnce(targetUrl, redirectsLeft, thenDo) {
  _ssrfSafeGet(targetUrl, redirectsLeft, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
    accept: 'text/html,application/xhtml+xml',
    // Lenient on a missing content-type (some servers omit it), but an
    // explicit non-text one (image/video/pdf/etc.) is rejected.
    checkContentType: function (ct) { return !ct || /^text\/|html|xml/i.test(ct); },
    shouldStopEarly: function (size, bodySoFar) { return size > 512 && /<\/head\s*>/i.test(bodySoFar); },
  }, thenDo);
}

// Fetches an oEmbed JSON endpoint (see discoverOembedUrl below) — small,
// read to completion (no early-stop heuristic; oEmbed responses are a
// single flat JSON object, nowhere near MAX_OEMBED_BYTES in practice).
function fetchOembed(targetUrl, redirectsLeft, thenDo) {
  _ssrfSafeGet(targetUrl, redirectsLeft, {
    timeoutMs: OEMBED_FETCH_TIMEOUT_MS,
    maxBytes: MAX_OEMBED_BYTES,
    accept: 'application/json',
    checkContentType: function (ct) { return !ct || /json/i.test(ct); },
    shouldStopEarly: function () { return false; },
  }, thenDo);
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
  // music.youtube.com shares youtube.com's exact video-id space (a YT Music
  // watch URL's ?v= is the same 11-char id a regular youtube.com/watch?v=
  // URL would use) and has no public iframe-embed widget of its own, so it
  // reuses the regular YouTube player rather than needing a new provider.
  if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
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

  // Declared favicon (any rel containing "icon" -- covers "icon",
  // "shortcut icon", "apple-touch-icon", "apple-touch-icon-precomposed")
  // as a universal fallback image for pages with no og:image/twitter:image
  // -- most plain articles/tools/docs sites have one of these even without
  // ever setting up Open Graph tags at all. Takes the FIRST one found
  // (typically the most generic "icon" link, listed before higher-res
  // apple-touch variants in most sites' markup) rather than trying to pick
  // the "best" one -- any real favicon beats no image at all for a small
  // link-card thumbnail.
  var iconMatch = /<link\s+([^>]*rel\s*=\s*["'][^"']*icon[^"']*["'][^>]*)>/i.exec(html);
  var iconHref = null;
  if (iconMatch) {
    var hrefMatch = /href\s*=\s*["']([^"']+)["']/i.exec(iconMatch[1]);
    if (hrefMatch) iconHref = decodeEntities(hrefMatch[1]);
  }

  return {
    title: metas['og:title'] || metas['twitter:title'] || plainTitle || null,
    description: metas['og:description'] || metas['twitter:description'] || metas.description || null,
    image: metas['og:image:secure_url'] || metas['og:image'] || metas['twitter:image'] || null,
    siteName: metas['og:site_name'] || null,
    favicon: iconHref,
  };
}

// oEmbed autodiscovery (https://oembed.com) — a <link rel="alternate"
// type="application/json+oembed" href="..."> tag most real-world embed-
// style providers (Vimeo, Flickr, CodePen, Reddit, Twitter/X, TikTok,
// Imgur, and many more that aren't worth hand-coding into detectEmbed
// individually) declare in their own page markup. This is what makes the
// metadata enrichment below "universal" rather than another hardcoded
// per-provider list: any site that follows the oEmbed spec is picked up
// automatically. JSON format only (the legacy XML variant isn't supported
// here). Resolves a relative href against baseUrl; returns null if no tag
// is found or the href doesn't parse.
function discoverOembedUrl(html, baseUrl) {
  var linkRe = /<link\s+([^>]*)>/gi;
  var m;
  while ((m = linkRe.exec(html))) {
    var attrs = m[1];
    if (!/rel\s*=\s*["']alternate["']/i.test(attrs)) continue;
    if (!/type\s*=\s*["']application\/json\+oembed["']/i.test(attrs)) continue;
    var hrefMatch = /href\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!hrefMatch) continue;
    try { return new URL(decodeEntities(hrefMatch[1]), baseUrl).toString(); } catch (e) { return null; }
  }
  return null;
}

// Parses a fetched oEmbed response body and returns ONLY a whitelist of
// individually-type-checked string fields: title, author_name,
// thumbnail_url, provider_name. Deliberately never looks at (let alone
// returns) the spec's `html` field — that's arbitrary third-party markup
// from whatever host the oEmbed endpoint itself names, and rendering it
// directly into a card would be a real XSS vector. This file only ever
// turns oEmbed data into plain text/attributes, the same way every other
// piece of scraped metadata here is treated.
function parseOembedBody(rawBody) {
  var json;
  try { json = JSON.parse(rawBody); } catch (e) { return null; }
  if (!json || typeof json !== 'object') return null;
  function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }
  return {
    title: str(json.title),
    authorName: str(json.author_name),
    thumbnailUrl: str(json.thumbnail_url),
    providerName: str(json.provider_name),
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

    function finish(meta) {
      var hostname = '', origin = '';
      try {
        var finalU = new URL(result.finalUrl);
        hostname = finalU.hostname;
        origin = finalU.protocol + '//' + finalU.host;
      } catch (e) { /* leave both blank -- result.finalUrl already round-tripped through fetchOnce's own URL parse, so this is unreachable in practice */ }

      // Universal fallback chain for the card's image: a real og:image/
      // twitter:image wins, then an oEmbed thumbnail_url (if the page
      // offered one and OG/Twitter didn't), then the page's own declared
      // favicon, then a guessed /favicon.ico at the same origin --
      // unverified (not every site actually has one there), but harmless
      // either way since the client hotlinks it directly and hides the
      // image slot on a load error (see buildLinkPreviewCard's onerror
      // handler), degrading to a text-only card rather than a broken-image
      // icon. This is what makes "paste literally any link" reliably
      // produce SOME visual card instead of only the subset of pages that
      // happen to set up Open Graph tags.
      var image = safeAbsoluteUrl(meta.image, result.finalUrl) ||
        safeAbsoluteUrl(meta.oembedThumbnail, result.finalUrl) ||
        safeAbsoluteUrl(meta.favicon, result.finalUrl) ||
        (origin ? origin + '/favicon.ico' : null);

      if (!meta.title && !meta.description && !image && !embed) {
        var emptyBody = { error: 'No preview metadata found' };
        cache.set(targetUrl, { expiresAt: Date.now() + CACHE_TTL_MS, status: 422, body: emptyBody });
        return thenDo(null, 422, emptyBody);
      }

      var body = {
        url: result.finalUrl,
        title: truncate(meta.title, MAX_TITLE_LEN),
        description: truncate(meta.description, MAX_DESC_LEN),
        image: image,
        siteName: meta.siteName || hostname,
      };
      if (embed) { body.provider = embed.provider; body.embedUrl = embed.embedUrl; }
      cacheAndReturn(200, body);
    }

    // oEmbed enrichment only kicks in when the primary OG/Twitter/<title>
    // scrape came up short (no title, or no image to show) -- most
    // well-known sites already have good OG tags and don't need a second
    // network round-trip at all. A failure here (no oEmbed link, fetch
    // error, bad JSON, rate limit, timeout) is never fatal -- it just means
    // `finish` runs with whatever the primary scrape already found, same
    // as before this feature existed.
    var needsEnrichment = !meta.title || !(meta.image || meta.favicon);
    var oembedUrl = needsEnrichment ? discoverOembedUrl(result.body, result.finalUrl) : null;
    if (!oembedUrl) return finish(meta);

    fetchOembed(oembedUrl, MAX_REDIRECTS, function (oembedErr, oembedResult) {
      var parsed = oembedErr ? null : parseOembedBody(oembedResult.body);
      if (!parsed) return finish(meta);
      finish({
        title: meta.title || parsed.title,
        description: meta.description || (parsed.authorName ? 'By ' + parsed.authorName : null),
        image: meta.image,
        oembedThumbnail: parsed.thumbnailUrl,
        favicon: meta.favicon,
        siteName: meta.siteName || parsed.providerName,
      });
    });
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
