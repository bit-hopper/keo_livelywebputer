/**
 * core/servers/IdentityServer.js
 *
 * life_star subserver for the Lively identity system.
 * Auto-discovered by life_star from core/servers/*.js (flat scan).
 *
 * Routes:
 *
 *   GET  /nodejs/IdentityServer/challenge
 *   POST /nodejs/IdentityServer/register
 *   POST /nodejs/IdentityServer/authenticate
 *   POST /nodejs/IdentityServer/logout
 *   GET  /nodejs/IdentityServer/session
 *
 *   GET  /.well-known/lively-did?handle=<handle>
 *
 *   GET  /@:handle              — home manifest (all objects for this handle)
 *   GET  /@:handle/profile      — fetch profile envelope (public singleton)
 *   PUT  /@:handle/profile      — save/update profile (owner only)
 *   PUT    /@:handle/blobs/:cid — store file ciphertext bytes (owner only; Encryption.md §5.2)
 *   GET    /@:handle/blobs/:cid — fetch file bytes (gated by the referencing file envelope)
 *   DELETE /@:handle/blobs/:cid — delete a blob (owner only; refused if still referenced)
 *   GET  /@:handle/:objId       — fetch a specific object envelope (owner or
 *                                 recipient; renders an HTML access-denied page
 *                                 with a "Request Access" button for browsers)
 *   PUT  /@:handle/:objId       — store a new envelope version (owner only)
 *   GET  /@:handle/:objId/versions        — version history
 *   GET  /@:handle/:objId/since/:prevCid  — sync delta
 *
 *   POST /nodejs/IdentityServer/access-request/:objId  — request read access
 *   POST /nodejs/IdentityServer/grant-access/:objId    — owner grants access
 */

"use strict";

var url = require("url");
var fs = require("fs");
var path = require("path");
var nodeCrypto = require("crypto");
var katex = require("katex");
var hljs = require("highlight.js/lib/core");
hljs.registerLanguage("bash", require("highlight.js/lib/languages/bash"));
hljs.registerLanguage("c", require("highlight.js/lib/languages/c"));
hljs.registerLanguage("cpp", require("highlight.js/lib/languages/cpp"));
hljs.registerLanguage("css", require("highlight.js/lib/languages/css"));
hljs.registerLanguage("java", require("highlight.js/lib/languages/java"));
hljs.registerLanguage("javascript", require("highlight.js/lib/languages/javascript"));
hljs.registerLanguage("json", require("highlight.js/lib/languages/json"));
hljs.registerLanguage("markdown", require("highlight.js/lib/languages/markdown"));
hljs.registerLanguage("plaintext", require("highlight.js/lib/languages/plaintext"));
hljs.registerLanguage("python", require("highlight.js/lib/languages/python"));
hljs.registerLanguage("sql", require("highlight.js/lib/languages/sql"));
hljs.registerLanguage("typescript", require("highlight.js/lib/languages/typescript"));
hljs.registerLanguage("xml", require("highlight.js/lib/languages/xml"));
var handleRegistry = require("./identity/HandleRegistry");
var objectRepo = require("./identity/ObjectRepository");
var blobStore = require("./identity/BlobStore");
var auth = require("./identity/AuthMiddleware");
var constellationRegistry = require("./identity/ConstellationRegistry");
var cryptoVerify = require("./identity/CryptoVerify");
var constellationSpace = require("./identity/ConstellationSpace");
var plusCode = require("./identity/PlusCode");

// ─── home-world bootstrap helpers ─────────────────────────────────────────────

var _blankWorldJso = null;
function getBlankWorldJso() {
  if (_blankWorldJso) return _blankWorldJso;
  var html = fs.readFileSync(path.join(__dirname, "..", "..", "blank.html"), "utf8");
  var tagStart = html.indexOf('<script type="text/x-lively-world"');
  if (tagStart === -1) throw new Error("blank.html: x-lively-world script tag not found");
  var contentStart = html.indexOf(">", tagStart) + 1;
  var contentEnd = html.indexOf("</script>", contentStart);
  _blankWorldJso = JSON.parse(html.slice(contentStart, contentEnd));
  return _blankWorldJso;
}

// welcome.html is a static saved-world snapshot (no separate template) —
// this doesn't rewrite any of that snapshot's morph JSON, it splices one
// small <script> in before the bootstrap.js tag that mounts LocalMap once
// $world exists, via Config.onStartWorld (fires after world-load regardless
// of snapshot vs. from-scratch loading — same mechanism buildWarpDropPage/
// buildConstellationSpacePage use, just without manuallyCreateWorld since
// there's no snapshot to bypass here).
//
// Deliberately NOT cached (unlike getBlankWorldJso/getRestoreWorldJso
// below): those two are fixed templates that never change at runtime, but
// welcome.html is a live-edited world — the "Save World" command PUTs a
// freshly regenerated welcome.html straight to disk via lively-davfs's
// catch-all handler (see WEBDAV.md), completely independent of this route.
// A cached-once read here previously meant every GET kept serving the
// first-request snapshot forever, silently masking every save after the
// first (the save itself always worked — the read just never reflected
// it) until the server was restarted.
function getWelcomeHtmlWithMap() {
  var html = fs.readFileSync(path.join(__dirname, "..", "..", "welcome.html"), "utf8");
  var bootstrapTag = '<script type="text/javascript" src="core/lively/bootstrap.js">';
  var idx = html.indexOf(bootstrapTag);
  if (idx === -1) throw new Error("welcome.html: bootstrap.js script tag not found");
  var mountScript =
    "<script>window.Config=window.Config||{};window.Config.onStartWorld=function(){" +
    "lively.require('lively.identity.LocalMap').toRun(function(){" +
    'var el=document.createElement("div");el.id="lofi-social-map";' +
    "document.body.appendChild(el);lively.identity.LocalMap.open(el);" +
    "});};</script>";
  return html.slice(0, idx) + mountScript + html.slice(idx);
}

// restore.html is a stable copy of blank.html used exclusively as the seed
// for recovery worlds. Kept separate so changes to blank.html don't affect
// existing users' recovery worlds.
var _restoreWorldJso = null;
function getRestoreWorldJso() {
  if (_restoreWorldJso) return _restoreWorldJso;
  var html = fs.readFileSync(path.join(__dirname, "..", "..", "restore.html"), "utf8");
  var tagStart = html.indexOf('<script type="text/x-lively-world"');
  if (tagStart === -1) throw new Error("restore.html: x-lively-world script tag not found");
  var contentStart = html.indexOf(">", tagStart) + 1;
  var contentEnd = html.indexOf("</script>", contentStart);
  _restoreWorldJso = JSON.parse(html.slice(contentStart, contentEnd));
  return _restoreWorldJso;
}

function genObjId() {
  return nodeCrypto.randomBytes(9).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function computeCidSync(jso) {
  return nodeCrypto.createHash("sha256")
    .update(JSON.stringify(jso))
    .digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Creates a blank home world for a newly registered user.
// Skips silently if the user already owns any object (add-device path).
// Calls thenDo(err, objId|null).
function createHomeWorld(did, thenDo) {
  objectRepo.listForUser(did, function (err, existing) {
    if (err || (existing && existing.length > 0)) return thenDo(err, null);
    var worldJso;
    try { worldJso = getBlankWorldJso(); }
    catch (e) {
      console.warn("[IdentityServer] Could not load blank.html for home world:", e.message);
      return thenDo(null, null);
    }
    var objId = genObjId();
    var envelope = {
      objId: objId,
      did: did,
      type: "world",
      visibility: "public",
      created: new Date().toISOString(),
      record: { cid: computeCidSync(worldJso), prevCid: null, payload: worldJso },
      state: { name: "Home" },
    };
    objectRepo.put(envelope, function (putErr) {
      if (putErr) {
        console.warn("[IdentityServer] Could not create home world:", putErr.message);
        return thenDo(null, null);
      }
      thenDo(null, objId);
    });
  });
}

// Creates a blank profile envelope for a newly registered user.
// Calls thenDo(err, objId|null).
function createDefaultProfile(did, handle, thenDo) {
  var payload = { displayName: handle || '', bio: '', avatarUrl: null, bannerUrl: null, links: [] };
  var objId   = genObjId();
  var envelope = {
    objId:      objId,
    did:        did,
    type:       'profile',
    visibility: 'public',
    created:    new Date().toISOString(),
    record:     { cid: computeCidSync(payload), prevCid: null, payload: payload },
    state:      { name: 'profile' }
  };
  objectRepo.put(envelope, function(putErr) {
    if (putErr) {
      console.warn('[IdentityServer] Could not create default profile:', putErr.message);
      return thenDo(null, null);
    }
    thenDo(null, objId);
  });
}

// Creates a read-only recovery world from restore.html for a new user.
// Stored as type:'recovery', visibility:'private'. Never shown in the UI.
// Served at /@handle/:objId/versions as the Lively boot vehicle.
// Calls thenDo(err, objId|null).
function createRecoveryWorld(did, thenDo) {
  var worldJso;
  try { worldJso = getRestoreWorldJso(); }
  catch (e) {
    console.warn("[IdentityServer] Could not load restore.html for recovery world:", e.message);
    return thenDo(null, null);
  }
  var objId = genObjId();
  var envelope = {
    objId:      objId,
    did:        did,
    type:       "recovery",
    visibility: "private",
    created:    new Date().toISOString(),
    record:     { cid: computeCidSync(worldJso), prevCid: null, payload: worldJso },
    state:      { name: "recovery" }
  };
  objectRepo.put(envelope, function(putErr) {
    if (putErr) {
      console.warn("[IdentityServer] Could not create recovery world:", putErr.message);
      return thenDo(null, null);
    }
    thenDo(null, objId);
  });
}

// Creates the legacy users/<handle>/config.js module for a newly registered
// user. The old (pre-identity) boot path unconditionally tries to load this
// module at startup (see defaultconfig.js#loadUserConfigModule) as a
// per-user customization hook; nothing in the identity system ever wrote it,
// so every identity account 404's on it at every boot. This plugs the
// identity registration flow into that legacy hook instead of replacing it.
// Skips silently if the file already exists (add-device path) or if handle
// isn't filesystem-safe. Calls thenDo(err, path|null).
function createUserConfigFile(handle, thenDo) {
  if (!handle || !/^[A-Za-z0-9_-]+$/.test(handle)) return thenDo(null, null);
  var userDir = path.join(process.env.WORKSPACE_LK || process.cwd(), "users", handle);
  var configPath = path.join(userDir, "config.js");
  fs.mkdir(userDir, { recursive: true }, function (mkdirErr) {
    if (mkdirErr) {
      console.warn("[IdentityServer] Could not create user dir for config.js:", mkdirErr.message);
      return thenDo(null, null);
    }
    fs.access(configPath, fs.constants.F_OK, function (existsErr) {
      if (!existsErr) return thenDo(null, configPath);
      var template =
        "module('users." + handle + ".config').requires().toRun(function() {\n\n" +
        "// Enter your code here\n\n" +
        "}) // end of module\n";
      fs.writeFile(configPath, template, function (writeErr) {
        if (writeErr) {
          console.warn("[IdentityServer] Could not write user config.js:", writeErr.message);
          return thenDo(null, null);
        }
        thenDo(null, configPath);
      });
    });
  });
}

// ─── HTML helpers (world bootstrap / access-denied / access-requested pages) ──

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
    return (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ]
    );
  });
}

// Returns a safe href, or '#' if the scheme is not allow-listed.
// Blocks javascript:, data:, vbscript:, etc. Allows http(s), mailto, and
// relative/anchor URLs (no scheme).
function safeHref(raw) {
  var s = String(raw || '').trim();
  var m = /^([a-z][a-z0-9+.\-]*):/i.exec(s);
  if (!m) return s; // relative or anchor — allowed
  var scheme = m[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return s;
  return '#';
}

// Serves a stored world envelope as a bootable Lively page.
// Embeds record.payload as JSON in a <script type="text/x-lively-world"> tag
// so the existing JSONMorphicData / World.createFromJSOOn path picks it up
// unmodified — same mechanism as static .html world files, just server-rendered.
// </script> inside JSON payload is escaped to <\/script> to prevent tag break.
// welcomeHandle: when set, injects Config.onStartWorld to show a welcome alert.
function buildWorldPage(envelope, welcomeHandle) {
  var name = (envelope.state && envelope.state.name) || envelope.objId;
  var title = escapeHtml(name);
  var payload = JSON.stringify(envelope.record.payload || {})
    .replace(/<\/script>/gi, "<\\/script>");

  // Pre-set codeBase and rootPath before bootstrap.js runs. JSLoader.makeAbsolute
  // only fast-paths on ^http/^file/^// — root-relative /... paths get prepended
  // with currentDir(), which from /@handle/objId resolves to the wrong base
  // (@handle/core/ instead of /core/). findCodeBase/findRootPath check these
  // Config fields first and short-circuit if already set.
  var configScript;
  if (welcomeHandle) {
    var msgJson = JSON.stringify(
      "New passkey registered successfully. Welcome to Lively @" + welcomeHandle + "!"
    );
    configScript =
      "<script>window.Config={" +
      "codeBase:location.protocol+'//'+location.host+'/core/'," +
      "rootPath:location.protocol+'//'+location.host+'/'," +
      "verboseLogging:true," +
      "onStartWorld:function(){$world.alertOK(" + msgJson + ",8);}" +
      "}</script>";
  } else {
    configScript =
      "<script>window.Config={" +
      "codeBase:location.protocol+'//'+location.host+'/core/'," +
      "rootPath:location.protocol+'//'+location.host+'/'" +
      "}</script>";
  }

  return (
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">" +
    "<link rel=\"shortcut icon\" href=\"/core/media/lively.ico\">" +
    "<title>" + title + "</title>" +
    configScript +
    "</head><body>" +
    "<script type=\"text/javascript\" src=\"/core/lively/bootstrap.js\"></script>" +
    "<script type=\"text/x-lively-world\" id=\"" + escapeHtml(envelope.objId) + "\">" +
    payload +
    "</script>" +
    "</body></html>"
  );
}

// Serves the standalone WarpDrop world at GET /warpdrop: a plain Lively
// world (no saved envelope, no @handle) that opens the WarpDrop panel
// immediately on boot. Modeled on buildWorldPage() above, minus the
// <script type="text/x-lively-world"> payload tag. Omitting that tag is
// NOT enough by itself: lively.Main.WorldDataAccessor.forHTMLDoc (Main.js)
// still tries to JSON-parse whatever it finds in the (now missing) tag,
// throwing "Unexpected end of JSON input" on an empty match. Setting
// manuallyCreateWorld routes world creation through WorldDataAccessor.
// fromScratch instead (see Main.js's Loader#getWorldData), which builds a
// blank World directly -- this is the actual fresh-world mechanism.
//
// Mobile-friendly by design (this is meant to be reachable from a phone
// browser, not just desktop): a real viewport meta tag (buildWorldPage()
// above has never set one -- without it mobile browsers render at a fake
// ~980px desktop width) and showMenuBar:false to skip booting the full
// desktop IDE chrome (system browser, code editor tools, etc.), which
// has no purpose on this single-panel entry point and would otherwise
// load by default. WarpDrop.open() itself sizes the panel responsively
// (see WarpDrop.js) based on the now-correctly-reported viewport size.
function buildWarpDropPage() {
  return (
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">" +
    "<link rel=\"shortcut icon\" href=\"/core/media/lively.ico\">" +
    "<title>WarpDrop</title>" +
    "<script>window.Config={" +
    "codeBase:location.protocol+'//'+location.host+'/core/'," +
    "rootPath:location.protocol+'//'+location.host+'/'," +
    "manuallyCreateWorld:true," +
    "showMenuBar:false," +
    "onStartWorld:function(){" +
    "lively.require('lively.identity.WarpDrop').toRun(function(){" +
    "lively.identity.WarpDrop.open();" +
    "});" +
    "}" +
    "}</script>" +
    "</head><body>" +
    "<script type=\"text/javascript\" src=\"/core/lively/bootstrap.js\"></script>" +
    "</body></html>"
  );
}

// Serve a post card envelope as a standalone HTML page (§4.3).
// Static mode: renders record.payload.snapshot as server-side HTML for fast
// first paint, crawlers, and link previews — no Lively runtime required.
// Live mode: the same page then boots a minimal Lively runtime that replaces
// the static render with the live PostCardEditor / PostCardFeed morph.
function buildPostCardPage(envelope) {
  var meta = envelope.state || {};
  var title = escapeHtml(meta.title || envelope.objId);
  var snapshot = envelope.record && envelope.record.payload && envelope.record.payload.snapshot;
  var staticHtml = '';
  if (snapshot && snapshot.content) {
    staticHtml = _snapshotToHtml(snapshot);
  }
  var dataEnv = JSON.stringify(envelope).replace(/<\/script>/gi, '<\\/script>');

  return (
    '<!DOCTYPE html><html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<link rel="shortcut icon" href="/core/media/lively.ico">' +
    '<link rel="stylesheet" href="/core/lib/postcard/katex.min.css">' +
    '<link rel="stylesheet" href="/core/lib/postcard/hljs-github.css">' +
    '<title>' + title + '</title>' +
    '<style>' +
    'body{margin:0;font-family:system-ui,sans-serif;background:#fafafa}' +
    '.postcard-static{max-width:720px;margin:48px auto;padding:0 24px}' +
    '.postcard-static h1{font-size:2em;font-weight:700;margin:0 0 24px}' +
    '.postcard-static .lively-postcard-image{max-width:100%;max-height:480px;border-radius:4px;' +
    'vertical-align:middle}' +
    '.postcard-loader{position:fixed;bottom:12px;right:12px;font-size:12px;' +
    'color:#999;background:#fff;border:1px solid #eee;border-radius:4px;padding:4px 8px}' +
    '</style>' +
    '</head><body>' +
    '<div class="postcard-static" id="postcard-static">' + staticHtml + '</div>' +
    '<div class="postcard-loader" id="postcard-loader">Loading live mode…</div>' +
    '<script type="application/json" id="postcard-envelope">' + dataEnv + '</script>' +
    '<script>window.Config={' +
    'codeBase:location.protocol+"//"+location.host+"/core/",' +
    'rootPath:location.protocol+"//"+location.host+"/"' +
    '}</script>' +
    '<script src="/core/lib/postcard/postcard-runtime.js"></script>' +
    '<script src="/core/lively/bootstrap.js"></script>' +
    '<script>' +
    '(function waitForLively(){' +
    'if(typeof lively==="undefined"||!lively.require)return setTimeout(waitForLively,200);' +
    'document.getElementById("postcard-loader").textContent="Live mode ready";' +
    'lively.require("lively.identity.PostCardFeed").toRun(function(){' +
    'document.getElementById("postcard-static").style.display="none";' +
    'document.getElementById("postcard-loader").style.display="none";' +
    '});})();' +
    '</script>' +
    '</body></html>'
  );
}

// Convert a constellation space's stored layout snapshot to simple
// absolutely-positioned HTML for static rendering — same "fast first paint,
// no runtime required" purpose as _snapshotToHtml below, just over a
// placement map instead of a ProseMirror doc.
function _layoutSnapshotToHtml(snapshot) {
  var layout = (snapshot && snapshot.layout) || {};
  var ids = Object.keys(layout);
  if (!ids.length) {
    return '<p class="constellation-empty">No items placed yet.</p>';
  }
  return ids.map(function (id) {
    var p = layout[id] || {};
    var x = p.x || 0, y = p.y || 0, w = p.w || 200, h = p.h || 120;
    var kind = escapeHtml(p.kind || 'item');
    var objId = (p.ref && p.ref.objId) ? escapeHtml(p.ref.objId) : '';
    return '<div class="constellation-placement" style="left:' + x + 'px;top:' + y +
      'px;width:' + w + 'px;height:' + h + 'px">' +
      '<div class="constellation-placement-label">' + kind + (objId ? ': ' + objId : '') + '</div>' +
      '</div>';
  }).join('');
}

// Serve a constellation's space as a standalone HTML page, same two-mode
// shape as buildPostCardPage: static layout render for fast first paint,
// then boots the live ConstellationSpace morph (Yjs-synced, multi-user).
// A constellation's space is served as a full, freshly-built Lively world
// (same category as a user's home world at /@handle, just shared/synced
// instead of private), not a window opened inside someone else's world.
//
// A bare page that boots bootstrap.js without an embedded
// <script type="text/x-lively-world"> tag (the mechanism buildWorldPage
// uses for stored worlds) never gets a working $world: the default fallback
// tries to load the *viewing* user's own home-world config
// (/users/<handle>/config.js) to construct one, which 404s today for every
// account (a separate, pre-existing gap — per-user config.js is never
// auto-created on registration) and aborts startup entirely.
//
// manuallyCreateWorld routes world creation through
// WorldDataAccessor.fromScratch instead (see Main.js's Loader#getWorldData)
// — builds a blank, viewport-sized World directly, sidestepping that
// fallback altogether. Same mechanism buildWarpDropPage already uses for
// GET /warpdrop; onStartWorld is Lively's own "$world is ready" callback,
// used here instead of polling for it.
function buildConstellationSpacePage(constellation, spaceEnvelope) {
  var title = escapeHtml(constellation.name);
  var snapshot = spaceEnvelope && spaceEnvelope.record && spaceEnvelope.record.payload &&
    spaceEnvelope.record.payload.snapshot;
  var staticHtml = _layoutSnapshotToHtml(snapshot);
  var pageData = {
    name: constellation.name,
    did: constellation.did,
    genesisObjId: constellation.genesisObjId,
    visibility: constellation.visibility
  };
  var dataJson = JSON.stringify(pageData).replace(/<\/script>/gi, '<\\/script>');

  return (
    '<!DOCTYPE html><html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="apple-mobile-web-app-capable" content="yes">' +
    '<link rel="shortcut icon" href="/core/media/lively.ico">' +
    '<title>' + title + '</title>' +
    '<style>' +
    'body{margin:0;font-family:system-ui,sans-serif;background:#fafafa}' +
    '.constellation-static{position:relative;min-height:100vh;overflow:auto}' +
    '.constellation-empty{padding:48px;text-align:center;color:#999}' +
    '.constellation-placement{position:absolute;border:1px solid #ddd;background:#fff;' +
    'border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden}' +
    '.constellation-placement-label{padding:6px 8px;font-size:12px;color:#666}' +
    '.constellation-loader{position:fixed;bottom:12px;right:12px;font-size:12px;' +
    'color:#999;background:#fff;border:1px solid #eee;border-radius:4px;padding:4px 8px}' +
    '</style>' +
    '</head><body>' +
    '<div class="constellation-static" id="constellation-static">' + staticHtml + '</div>' +
    '<div class="constellation-loader" id="constellation-loader">Loading live mode…</div>' +
    '<script type="application/json" id="constellation-data">' + dataJson + '</script>' +
    '<script src="/core/lib/postcard/postcard-runtime.js"></script>' +
    '<script>window.Config={' +
    'codeBase:location.protocol+"//"+location.host+"/core/",' +
    'rootPath:location.protocol+"//"+location.host+"/",' +
    'manuallyCreateWorld:true,' +
    // Unlike WarpDrop's kiosk-style panel, a constellation is a place the
    // user inhabits — they need their normal menu bar (identity, "my
    // postcards", etc.) available here, not a stripped-down single-purpose
    // view.
    'onStartWorld:function(){' +
    // removeDOMContentBeforeWorldLoad (default true) already wiped
    // #constellation-static/#constellation-loader along with the rest of
    // the page's prior DOM before this callback runs — nothing left to hide.
    'lively.require("lively.identity.ConstellationSpace").toRun(function(){' +
    'lively.identity.ConstellationSpace.open(' + JSON.stringify(constellation.name) + ');' +
    '});' +
    '}' +
    '}</script>' +
    '<script src="/core/lively/bootstrap.js"></script>' +
    '</body></html>'
  );
}

// Convert a ProseMirror snapshot JSON to simple HTML for static rendering.
// Only handles the node types defined in §6.1 (paragraph, heading, list, etc.).
function _snapshotToHtml(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.content)) return '';
  return snapshot.content.map(function(node) {
    return _pmNodeToHtml(node);
  }).join('');
}

// Syntax-highlighted code_block render. hljs.highlightAuto's .value output
// already HTML-escapes the source text itself — reads raw text directly
// from node.content rather than the pre-escaped `inner` the caller built,
// to avoid double-escaping.
function _renderHighlightedCode(node) {
  var text = (node.content || []).map(function(n) { return n.text || ''; }).join('');
  if (!text) return '<pre><code class="hljs"></code></pre>';
  try {
    return '<pre><code class="hljs">' + hljs.highlightAuto(text).value + '</code></pre>';
  } catch (e) {
    return '<pre><code class="hljs">' + escapeHtml(text) + '</code></pre>';
  }
}

// Server-side KaTeX render for static pages (§10.1/F17). Falls back to the
// raw LaTeX source, escaped, if the input doesn't parse — matches the
// editor NodeView's non-throwing behavior for malformed input.
function _renderKatex(value, displayMode) {
  if (!value) {
    return displayMode
      ? '<pre class="math-display"></pre>'
      : '<code class="math-inline"></code>';
  }
  try {
    return katex.renderToString(value, { throwOnError: true, displayMode: displayMode });
  } catch (e) {
    var tag = displayMode ? 'pre' : 'code';
    return '<' + tag + ' class="math-' + (displayMode ? 'display' : 'inline') + ' math-error">' +
           escapeHtml(value) + '</' + tag + '>';
  }
}

// §10.1 align/indent (matches PostCardEditor.js's _alignIndentAttrs).
function _alignIndentAttr(node) {
  var attrs = node.attrs || {};
  var style = '';
  if (attrs.align && attrs.align !== 'left') style += 'text-align:' + attrs.align + ';';
  if (attrs.indent) style += 'margin-left:' + (attrs.indent * 24) + 'px;';
  return style ? ' style="' + escapeHtml(style) + '"' : '';
}

function _pmNodeToHtml(node) {
  if (!node) return '';
  var text = '';
  if (node.text) {
    text = escapeHtml(node.text);
    if (node.marks) {
      node.marks.forEach(function(mark) {
        // Mark type names match the client schema (PostCardEditor.js's
        // _buildSchema), not ProseMirror's own default 'strong'/'em' names.
        if (mark.type === 'bold') text = '<strong>' + text + '</strong>';
        else if (mark.type === 'italic') text = '<em>' + text + '</em>';
        else if (mark.type === 'underline') text = '<u>' + text + '</u>';
        else if (mark.type === 'strike') text = '<s>' + text + '</s>';
        else if (mark.type === 'superscript') text = '<sup>' + text + '</sup>';
        else if (mark.type === 'subscript') text = '<sub>' + text + '</sub>';
        else if (mark.type === 'textColor' && mark.attrs && mark.attrs.color)
          text = '<span style="color:' + escapeHtml(mark.attrs.color) + '">' + text + '</span>';
        else if (mark.type === 'backgroundColor' && mark.attrs && mark.attrs.color)
          text = '<span style="background-color:' + escapeHtml(mark.attrs.color) + '">' + text + '</span>';
        else if (mark.type === 'fontFamily' && mark.attrs && mark.attrs.family)
          text = '<span style="font-family:' + escapeHtml(mark.attrs.family) + '">' + text + '</span>';
        else if (mark.type === 'fontSize' && mark.attrs && mark.attrs.size)
          text = '<span style="font-size:' + escapeHtml(mark.attrs.size) + '">' + text + '</span>';
        else if (mark.type === 'link' && mark.attrs && mark.attrs.href)
          text = '<a href="' + escapeHtml(safeHref(mark.attrs.href)) +
                 '" rel="noopener noreferrer">' + text + '</a>';
      });
    }
    return text;
  }
  var inner = (node.content || []).map(_pmNodeToHtml).join('');
  switch (node.type) {
    case 'paragraph': return '<p' + _alignIndentAttr(node) + '>' + inner + '</p>';
    case 'heading':
      var level = (node.attrs && node.attrs.level) || 1;
      return '<h' + level + _alignIndentAttr(node) + '>' + inner + '</h' + level + '>';
    case 'bullet_list': return '<ul>' + inner + '</ul>';
    case 'ordered_list': return '<ol>' + inner + '</ol>';
    case 'list_item': return '<li' + _alignIndentAttr(node) + '>' + inner + '</li>';
    case 'blockquote': return '<blockquote>' + inner + '</blockquote>';
    case 'code_block': return _renderHighlightedCode(node);
    case 'horizontal_rule': return '<hr>';
    case 'hard_break': return '<br>';
    case 'image':
      var src = (node.attrs && node.attrs.src) || '';
      var alt = (node.attrs && node.attrs.alt) || '';
      var imgTitle = node.attrs && node.attrs.title;
      return '<img class="lively-postcard-image" src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt) + '"' +
             (imgTitle ? ' title="' + escapeHtml(imgTitle) + '"' : '') + '>';
    case 'math_inline': return _renderKatex((node.attrs && node.attrs.value) || '', false);
    case 'math_display': return _renderKatex((node.attrs && node.attrs.value) || '', true);
    case 'embeddedPart':
      var objId = (node.attrs && node.attrs.objId) || '';
      return '<div class="lively-embedded-part" data-obj-id="' + escapeHtml(objId) +
             '">[embedded part: ' + escapeHtml(objId) + ']</div>';
    default: return inner;
  }
}

// Renders a minimal standalone HTML page (no Lively/morphic context — this is
// served to a plain browser navigation, not loaded inside a running world).
// params: { title, heading, message, objId, showRequestButton, loggedIn }
function buildAccessDeniedPage(params) {
  var title = escapeHtml(params.title || "Access denied");
  var heading = escapeHtml(params.heading || title);
  var message = escapeHtml(params.message || "");
  var objId = escapeHtml(params.objId || "");

  var action = "";
  if (params.showRequestButton) {
    action = params.loggedIn
      ? '<form method="POST" action="/nodejs/IdentityServer/access-request/' +
        objId +
        '"><button type="submit">Request Access</button></form>'
      : "<p>Sign in to request access to this object.</p>";
  }

  return (
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    "<title>" +
    title +
    "</title>" +
    "<style>body{font-family:sans-serif;max-width:480px;margin:80px auto;" +
    "text-align:center;color:#333}button{font-size:14px;padding:8px 16px;" +
    "cursor:pointer}</style></head><body>" +
    "<h2>" +
    heading +
    "</h2>" +
    (message ? "<p>" + message + "</p>" : "") +
    action +
    "</body></html>"
  );
}

// Can the requester read this envelope? True if public, or the requester is
// the owner, or the requester's DID is in envelope.record.recipients (shared
// visibility). Shared by every full-envelope GET route so they don't drift
// out of sync with each other (audit F19).
function _canReadEnvelope(envelope, identity) {
  if (envelope.visibility === "public") return true;
  if (!identity) return false;
  if (identity.did === envelope.did) return true;
  var recipients = (envelope.record && envelope.record.recipients) || [];
  return recipients.some(function (r) {
    return (r.did || r) === identity.did;
  });
}

// A shared envelope's record.recipients carries every recipient's
// {did, sealedDek} — needed in full by the owner (to reseal on the next
// save) but a non-owner recipient has no need to see who else has access.
// Trims to just the requester's own entry for non-owner readers. Shared by
// every full-envelope GET route, same reasoning as _canReadEnvelope above
// (audit F23).
function _trimRecipientsForNonOwner(envelope, identity) {
  if (!envelope.record || !envelope.record.recipients || !envelope.record.recipients.length) {
    return envelope;
  }
  if (identity && identity.did === envelope.did) return envelope;
  return Object.assign({}, envelope, {
    record: Object.assign({}, envelope.record, {
      recipients: envelope.record.recipients.filter(function (r) {
        return identity && (r.did || r) === identity.did;
      }),
    }),
  });
}

// Can `viewerDid` (may be null for anonymous) see this postcard metadata row?
// meta comes from ObjectRepository's postcard listing projection, which
// carries `visibility` and `recipients` for exactly this decision (§10.4).
function _canSeePostcardMeta(meta, viewerDid) {
  if (!meta) return false;
  if (meta.visibility === 'public' || meta.visibility == null) return true;
  if (!viewerDid) return false;
  if (meta.did === viewerDid) return true; // owner
  return (meta.recipients || []).some(function (r) {
    return (r && (r.did || r)) === viewerDid; // shared recipient
  });
}

// Batch DID -> handle resolution for a set of postcard metadata rows (the
// listing projection only carries `did` — see _runPostcardQuery in
// ObjectRepository.js — but PostCardView.open(handle, objId) needs a
// handle. Every other existing caller of this projection already has
// `handle` from its own data, e.g. ConstellationSpace's placement layout;
// /postcards/nearby is the first cross-user listing route that doesn't, so
// it resolves once here rather than adding handle to the shared projection
// for every caller). Calls thenDo(null, { [did]: handle|null }).
function _resolveHandlesForDids(dids, thenDo) {
  var uniqueDids = dids.filter(function (d, i, a) { return d && a.indexOf(d) === i; });
  if (!uniqueDids.length) return thenDo(null, {});
  var map = {};
  var remaining = uniqueDids.length;
  var firstErr = null;
  uniqueDids.forEach(function (did) {
    handleRegistry.resolveHandleForDid(did, function (err, handle) {
      if (err) firstErr = firstErr || err;
      map[did] = handle || null;
      if (--remaining === 0) thenDo(firstErr, map);
    });
  });
}

module.exports = function (route, app) {
  // ─── challenge ─────────────────────────────────────────────────────────────

  app.get(route + "challenge", function (req, res) {
    if (!req.session) {
      return res
        .status(500)
        .json({
          error: "Session not available — check life_star session config",
        });
    }
    var challenge = auth.issueChallenge(req);
    res.json({ challenge: challenge });
  });

  // ─── registration ──────────────────────────────────────────────────────────

  app.post(route + "register", function (req, res) {
    var body = req.body;
    if (!body || !body.handle || !body.did || !body.credentialId) {
      return res
        .status(400)
        .json({ error: "Missing required fields: handle, did, credentialId" });
    }

    auth.verifyRegistration(req, body, function (err, result) {
      if (err)
        return res.status(400).json({ error: String(err.message || err) });

      // Establish a server session so the new user can immediately write
      // objects (PUT /@handle/:objId) without a separate sign-in step.
      req.session['identity-did']    = result.did;
      req.session['identity-handle'] = result.handle;

      if (body.didDocument) {
        var didDoc;
        try {
          didDoc =
            typeof body.didDocument === "string"
              ? JSON.parse(body.didDocument)
              : body.didDocument;
        } catch (e) {
          return res
            .status(400)
            .json({ error: "Invalid didDocument JSON: " + e.message });
        }

        handleRegistry.saveDIDDocument(result.did, didDoc, function (putErr) {
          if (putErr) {
            console.warn(
              "[IdentityServer] Failed to store DID document:",
              putErr,
            );
          }
          createHomeWorld(result.did, function (worldErr, homeWorldObjId) {
            createDefaultProfile(result.did, result.handle, function (profileErr, profileObjId) {
              createRecoveryWorld(result.did, function () {
                createUserConfigFile(result.handle, function () {
                  var resp = { ok: true, handle: result.handle, did: result.did };
                  if (homeWorldObjId) resp.homeWorldObjId = homeWorldObjId;
                  res.json(resp);
                });
              });
            });
          });
        });
      } else {
        createHomeWorld(result.did, function (worldErr, homeWorldObjId) {
          createDefaultProfile(result.did, result.handle, function (profileErr, profileObjId) {
            createRecoveryWorld(result.did, function () {
              createUserConfigFile(result.handle, function () {
                var resp = { ok: true, handle: result.handle, did: result.did };
                if (homeWorldObjId) resp.homeWorldObjId = homeWorldObjId;
                res.json(resp);
              });
            });
          });
        });
      }
    });
  });

  // ─── authentication ────────────────────────────────────────────────────────

  app.post(route + "authenticate", function (req, res) {
    var body = req.body;
    if (!body || !body.handle || !body.credentialId) {
      return res
        .status(400)
        .json({ error: "Missing required fields: handle, credentialId" });
    }

    auth.verifyAuthentication(req, body, function (err, result) {
      if (err)
        return res.status(401).json({ error: String(err.message || err) });
      res.json({ ok: true, did: result.did, handle: result.handle });
    });
  });

  // ─── logout ────────────────────────────────────────────────────────────────

  app.post(route + "logout", function (req, res) {
    if (req.session) {
      delete req.session["identity-did"];
      delete req.session["identity-handle"];
      delete req.session["identity-challenge"];
    }
    res.json({ ok: true });
  });

  // ─── session status ────────────────────────────────────────────────────────

  app.get(route + "session", auth.optionalAuth, function (req, res) {
    res.json({ identity: req.identity || null });
  });

  // ─── well-known handle resolution ──────────────────────────────────────────

  app.get("/.well-known/lively-did", function (req, res) {
    var query = url.parse(req.url, true).query;
    var handle = query.handle;

    if (!handle) {
      return res
        .status(404)
        .json({
          error: "Provide ?handle=<handle> to resolve a specific identity",
        });
    }

    handle = handle.replace(/^@/, "");

    handleRegistry.resolve(handle, function (err, did) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!did)
        return res.status(404).json({ error: "Handle not found: " + handle });

      // The .well-known document is served unsigned for now.
      // Client WebKey._verifyWellKnown treats absent sig as unverified but
      // still resolves the DID — verification is a separate flag.
      res.json({ did: did, handle: handle });
    });
  });

  // ─── welcome.html redirect for signed-in users ────────────────────────────
  // Intercept GET /welcome.html before the static file server.
  // Visitors with a valid session cookie and a saved world are redirected
  // straight to their home world so they don't have to click "login" again.
  // Everyone else (true anonymous visitors, and signed-in visitors who
  // haven't saved a world yet — both are "landing page" traffic) gets the
  // static welcome world with the lofi social map (LocalMap.js) mounted
  // into it, via getWelcomeHtmlWithMap() below.

  app.get("/welcome.html", auth.optionalAuth, function (req, res) {
    function serveWelcomeWithMap() {
      res.send(getWelcomeHtmlWithMap());
    }
    if (!req.identity) return serveWelcomeWithMap();
    objectRepo.listForUser(req.identity.did, function (err, envelopes) {
      if (err || !envelopes || !envelopes.length) return serveWelcomeWithMap();
      var worlds = envelopes.filter(function (e) { return e.type === "world"; });
      if (!worlds.length) return serveWelcomeWithMap();
      worlds.sort(function (a, b) { return a.created < b.created ? -1 : 1; });
      res.redirect("/@" + req.identity.handle + "/" + worlds[0].objId);
    });
  });

  // ─── WarpDrop standalone entry point ───────────────────────────────────────
  // No FilesBrowser, no saved world, no @handle required -- see WarpDrop.md.

  app.get("/warpdrop", function (req, res) {
    res.send(buildWarpDropPage());
  });

  // ─── home manifest ─────────────────────────────────────────────────────────
  // Route is app-level (not under /nodejs/IdentityServer/) so clients reach it
  // at the canonical /@handle URL.

  app.get("/@:handle", function (req, res) {
    var handle = req.params.handle;

    handleRegistry.resolve(handle, function (err, did) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!did)
        return res.status(404).json({ error: "Handle not found: @" + handle });

      objectRepo.listForUser(did, function (err, envelopes) {
        if (err) return res.status(500).json({ error: String(err) });
        res.json({ handle: handle, did: did, objects: envelopes });
      });
    });
  });

  // ─── DID document ──────────────────────────────────────────────────────────
  // Returns the stored DID document for a handle.
  // Used by the new-device login path to populate local lively.IndexedDB.

  app.get("/@:handle/did-document", function (req, res) {
    var handle = req.params.handle;

    handleRegistry.resolve(handle, function (err, did) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!did)
        return res.status(404).json({ error: "Handle not found: @" + handle });

      handleRegistry.getDIDDocument(did, function (err, doc) {
        if (err) return res.status(500).json({ error: String(err) });
        if (!doc)
          return res.status(404).json({ error: "No DID document stored for @" + handle });

        res.json(doc);
      });
    });
  });

  // Owner-only update — needed because the delegation ceremony (soft signing
  // key + KEK + account X25519 key, see RegisterDialog.js) runs *after* the
  // initial POST /register that first stores the DID document, so its
  // results (delegationCert/softSigningKeyWrapped/accountX25519Pub on the
  // matching verificationMethod's "lively" metadata) have to be pushed here
  // afterward. Full-document overwrite, same trust model as the initial
  // register write (client sends the authoritative rebuilt document; no
  // signature verification anywhere yet, see postcard_audit.md F20).
  app.put("/@:handle/did-document", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    var doc = req.body;
    if (!doc || !doc.id || !doc.verificationMethod)
      return res.status(400).json({ error: "Invalid DID document" });

    handleRegistry.resolve(handle, function (err, did) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!did) return res.status(404).json({ error: "Handle not found: @" + handle });
      if (req.identity.did !== did || doc.id !== did)
        return res.status(403).json({ error: "Forbidden: not your DID document" });

      handleRegistry.saveDIDDocument(did, doc, function (saveErr) {
        if (saveErr) return res.status(500).json({ error: String(saveErr) });
        res.json({ ok: true });
      });
    });
  });

  // ─── profile ───────────────────────────────────────────────────────────────
  // Singleton per user. Registered before uploads/* and :objId so the literal
  // segment "profile" is never captured by a wildcard route.

  app.get("/@:handle/profile", auth.optionalAuth, function (req, res) {
    var handle = req.params.handle;
    handleRegistry.resolve(handle, function (err, did) {
      if (err)  return res.status(500).json({ error: String(err) });
      if (!did) return res.status(404).json({ error: "Handle not found: @" + handle });
      objectRepo.getProfileForDid(did, function (err, envelope) {
        if (err) return res.status(500).json({ error: String(err) });
        if (envelope) return res.json(envelope);
        // No profile yet — upsert on first read so existing accounts self-heal.
        createDefaultProfile(did, handle, function (createErr) {
          if (createErr) return res.status(500).json({ error: String(createErr) });
          objectRepo.getProfileForDid(did, function (err2, newEnvelope) {
            if (err2)         return res.status(500).json({ error: String(err2) });
            if (!newEnvelope) return res.status(500).json({ error: "Profile creation failed" });
            res.json(newEnvelope);
          });
        });
      });
    });
  });

  app.put("/@:handle/profile", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    if (req.identity.handle !== handle)
      return res.status(403).json({ error: "Forbidden: not your profile" });
    var envelope = req.body;
    if (!envelope || !envelope.objId || !envelope.record || !envelope.record.cid)
      return res.status(400).json({ error: "Invalid profile envelope" });
    if (envelope.type !== "profile")
      return res.status(400).json({ error: 'Envelope type must be "profile"' });
    objectRepo.put(envelope, function (err, result) {
      if (err) return res.status(500).json({ error: String(err) });
      res.json({ ok: true, objId: result.objId, cid: result.cid, changed: result.changed });
    });
  });

  // ─── user file uploads ─────────────────────────────────────────────────────
  // GET /@handle/uploads         — list files (owner-only)
  // PUT /@handle/uploads/<path>  — store a file to identity/uploads/<handle>/
  // GET /@handle/uploads/<path>  — serve the file back
  //
  // Files are kept in identity/uploads/ alongside objects.db — outside the
  // git repo (identity/uploads/ is gitignored). Registered before the generic
  // /@:handle/:objId routes so the literal segment "uploads" is never treated
  // as a 12-char objId.

  var _uploadsBase = path.join(
    process.env.WORKSPACE_LK || process.cwd(),
    "identity",
    "uploads",
  );

  // Resolve a handle + raw wildcard path to an absolute on-disk path.
  // Returns null if the path would escape the owner's upload directory.
  function _resolveUploadPath(handle, rawPath) {
    var ownerRoot = path.resolve(_uploadsBase, handle);
    var normalized = path
      .normalize(rawPath || "")
      .replace(/^(\.\.[\/\\])+/, "")
      .replace(/^[\/\\]+/, "");
    var full = path.resolve(ownerRoot, normalized);
    if (full !== ownerRoot && !full.startsWith(ownerRoot + path.sep))
      return null;
    return {
      full: full,
      dir: path.dirname(full),
      urlPath: normalized.replace(/\\/g, "/"),
    };
  }

  var _uploadMimeTypes = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
    ".txt": "text/plain", ".json": "application/json",
  };

  // GET  /@:handle/uploads       — recursively list the owner's upload space
  // POST /@:handle/uploads       — create an empty folder ({path: "..."})
  // Owner-only (unlike GET .../uploads/<path>'s optionalAuth — a single
  // upload like an avatar is meant to be publicly fetchable by URL, but
  // browsing/managing the space is treated as private, same as PUT/DELETE).
  // Registered as an exact match, distinct from the "/uploads/*" wildcard
  // below (Express's "*" requires a segment after "uploads/", so a bare
  // "/uploads" request never reaches that route).
  app.get("/@:handle/uploads", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    if (req.identity.handle !== handle)
      return res.status(403).json({ error: "Forbidden: not your upload space" });
    var root = path.resolve(_uploadsBase, handle);
    _walkUploads(root, root, function (err, result) {
      if (err) {
        if (err.code === "ENOENT") return res.json({ files: [], folders: [] });
        return res.status(500).json({ error: String(err) });
      }
      result.files.sort(function (a, b) { return b.mtime.localeCompare(a.mtime); });
      result.folders.sort();
      res.json({
        files: result.files.map(function (f) {
          return {
            path: f.path,
            size: f.size,
            mtime: f.mtime,
            url: "/@" + handle + "/uploads/" + _encodeUploadPath(f.path),
          };
        }),
        folders: result.folders,
      });
    });
  });

  app.post("/@:handle/uploads", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    if (req.identity.handle !== handle)
      return res.status(403).json({ error: "Forbidden: not your upload space" });
    var folderPath = req.body && req.body.path;
    if (!folderPath || typeof folderPath !== "string")
      return res.status(400).json({ error: "path is required" });
    var resolved = _resolveUploadPath(handle, folderPath);
    if (!resolved) return res.status(400).json({ error: "Invalid folder path" });
    fs.mkdir(resolved.full, { recursive: true }, function (err) {
      if (err) return res.status(500).json({ error: String(err) });
      res.json({ ok: true, path: resolved.urlPath });
    });
  });

  // POST /@:handle/uploads/move — {from, to}, both relative to the owner's
  // upload root. Registered under a literal "move" segment so it never
  // collides with the "/uploads/*" GET/PUT/DELETE file routes below (those
  // are registered for different HTTP methods, and Express matches routes
  // per-method — a POST here only matches a route explicitly registered
  // for POST).
  app.post("/@:handle/uploads/move", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    if (req.identity.handle !== handle)
      return res.status(403).json({ error: "Forbidden: not your upload space" });
    var fromRaw = req.body && req.body.from;
    var toRaw   = req.body && req.body.to;
    if (!fromRaw || typeof fromRaw !== "string" || !toRaw || typeof toRaw !== "string")
      return res.status(400).json({ error: "from and to are required" });
    var from = _resolveUploadPath(handle, fromRaw);
    var to   = _resolveUploadPath(handle, toRaw);
    if (!from || !to) return res.status(400).json({ error: "Invalid path" });
    fs.stat(to.full, function (err, stat) {
      if (!err && stat.isFile() && to.full !== from.full)
        return res.status(409).json({ error: "A file already exists at the destination" });
      fs.mkdir(to.dir, { recursive: true }, function (err) {
        if (err) return res.status(500).json({ error: String(err) });
        fs.rename(from.full, to.full, function (err) {
          if (err) {
            if (err.code === "ENOENT") return res.status(404).json({ error: "File not found" });
            return res.status(500).json({ error: String(err) });
          }
          res.json({ ok: true, url: "/@" + handle + "/uploads/" + _encodeUploadPath(to.urlPath) });
        });
      });
    });
  });

  // Encodes each segment of a relative upload path for safe use in a URL —
  // f.path/urlPath are raw filesystem paths (e.g. from fs.readdir), which
  // can contain characters like "#", "?", "&", or spaces that would
  // otherwise corrupt the URL for any client consuming it directly
  // (<img src>, window.open(), fetch()).
  function _encodeUploadPath(relPath) {
    return (relPath || "").split("/").map(encodeURIComponent).join("/");
  }

  // Recursively lists dir, returning { files: [{path, size, mtime}, ...],
  // folders: [path, ...] } — both relative to root (posix-style forward
  // slashes). folders includes every directory encountered, even empty
  // ones, so explicitly-created folders (see the POST route above) show up
  // before anything is uploaded into them.
  function _walkUploads(root, dir, thenDo) {
    fs.readdir(dir, { withFileTypes: true }, function (err, entries) {
      if (err) return thenDo(err);
      var files = [];
      var folders = [];
      var pending = entries.length;
      var failed = false;
      if (!pending) return thenDo(null, { files: files, folders: folders });
      entries.forEach(function (entry) {
        var full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          folders.push(path.relative(root, full).replace(/\\/g, "/"));
          _walkUploads(root, full, function (err, sub) {
            if (failed) return;
            if (err) { failed = true; return thenDo(err); }
            files = files.concat(sub.files);
            folders = folders.concat(sub.folders);
            if (--pending === 0) thenDo(null, { files: files, folders: folders });
          });
        } else if (entry.isFile()) {
          fs.stat(full, function (err, stat) {
            if (failed) return;
            if (err) { failed = true; return thenDo(err); }
            files.push({
              path: path.relative(root, full).replace(/\\/g, "/"),
              size: stat.size,
              mtime: stat.mtime.toISOString(),
            });
            if (--pending === 0) thenDo(null, { files: files, folders: folders });
          });
        } else if (--pending === 0) {
          thenDo(null, { files: files, folders: folders });
        }
      });
    });
  }

  // Owner-only now (Encryption.md §1/§11.1) — this legacy plaintext store had
  // no visibility concept at all, so optionalAuth meant "anyone with the URL
  // reads any file." Exception during the migration window (§11 step 4):
  // avatars/ and banners/ must stay anonymously fetchable (<img src>, no
  // cookie) until UploadMigration (§11 step 2-3) has rewritten the profile
  // envelope to point at public blob URLs instead — after that this whole
  // route family is deleted, exception included.
  function _legacyUploadsGetAuth(req, res, next) {
    var raw = req.params[0] || "";
    if (/^(avatars|banners)\//.test(raw)) return auth.optionalAuth(req, res, next);
    return auth.requireAuth(req, res, function () {
      if (req.identity.handle !== req.params.handle) {
        return res.status(403).json({ error: "Forbidden: not your upload space" });
      }
      next();
    });
  }

  app.get("/@:handle/uploads/*", _legacyUploadsGetAuth, function (req, res) {
    var resolved = _resolveUploadPath(req.params.handle, req.params[0]);
    if (!resolved) return res.status(400).json({ error: "Invalid file path" });
    fs.stat(resolved.full, function (err, stat) {
      if (err || !stat.isFile())
        return res.status(404).json({ error: "File not found" });
      var mime = _uploadMimeTypes[path.extname(resolved.full).toLowerCase()] ||
        "application/octet-stream";
      // SVG rule (Encryption.md §5.2): an <img>/direct-navigation SVG can
      // carry <script> — force download instead of inline render (stored-XSS
      // fix; this route previously served .svg as image/svg+xml with no
      // mitigation at all).
      if (mime === "image/svg+xml") res.setHeader("Content-Disposition", "attachment");
      res.setHeader("Content-Type", mime);
      res.setHeader("Content-Length", stat.size);
      fs.createReadStream(resolved.full).pipe(res);
    });
  });

  app.put("/@:handle/uploads/*", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    if (req.identity.handle !== handle) {
      return res
        .status(403)
        .json({ error: "Forbidden: not your upload space" });
    }
    var resolved = _resolveUploadPath(handle, req.params[0]);
    if (!resolved) return res.status(400).json({ error: "Invalid file path" });

    function _writeFile(content) {
      try {
        fs.mkdirSync(resolved.dir, { recursive: true });
      } catch (e) {
        return res
          .status(500)
          .json({ error: "Could not create directory: " + e.message });
      }
      fs.writeFile(resolved.full, content, function (err) {
        if (err) return res.status(500).json({ error: String(err) });
        res.json({
          ok: true,
          url: "/@" + handle + "/uploads/" + resolved.urlPath,
        });
      });
    }

    // body-parser does not process binary content — read raw from the stream.
    // If some middleware already buffered it as a Buffer, use that directly.
    if (req.body && Buffer.isBuffer(req.body)) return _writeFile(req.body);
    if (req.body && typeof req.body === "string")
      return _writeFile(Buffer.from(req.body));
    var chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () { _writeFile(Buffer.concat(chunks)); });
    req.on("error", function (e) {
      res.status(500).json({ error: String(e) });
    });
  });

  app.delete("/@:handle/uploads/*", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    if (req.identity.handle !== handle)
      return res.status(403).json({ error: "Forbidden: not your upload space" });
    var resolved = _resolveUploadPath(handle, req.params[0]);
    if (!resolved) return res.status(400).json({ error: "Invalid file path" });
    fs.unlink(resolved.full, function (err) {
      if (err) return res.status(404).json({ error: "File not found" });
      res.json({ ok: true });
    });
  });

  // ─── file blobs (Encryption.md §4/§5) ──────────────────────────────────────
  // Content-addressed ciphertext (or, for public files, plaintext) bytes for
  // the "file" envelope type. The gating file envelope itself is stored and
  // fetched through the ordinary /@:handle/:objId routes below — only the
  // raw bytes live here. Registered before /@:handle/:objId — "blobs" is a
  // literal segment, same ordering rule as "uploads"/"postcards" above.

  app.put("/@:handle/blobs/:cid", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    var cid = req.params.cid;
    if (req.identity.handle !== handle) {
      return res.status(403).json({ error: "Forbidden: not your blob space" });
    }
    if (!blobStore.CID_RE.test(cid)) {
      return res.status(400).json({ error: "Invalid cid" });
    }

    function onResult(err, result) {
      if (err) return res.status(400).json({ error: String(err.message || err) });
      res.json({ ok: true, cid: result.cid, size: result.size });
    }

    // body-parser does not process binary content — stream raw bytes into
    // BlobStore.put directly (same reasoning as the legacy uploads PUT route
    // above). If some middleware already buffered it as a Buffer/string, use that.
    if (req.body && Buffer.isBuffer(req.body)) return blobStore.put(cid, req.body, onResult);
    if (req.body && typeof req.body === "string") return blobStore.put(cid, Buffer.from(req.body), onResult);
    blobStore.put(cid, req, onResult);
  });

  app.get("/@:handle/blobs/:cid", auth.optionalAuth, function (req, res) {
    var cid = req.params.cid;
    if (!blobStore.CID_RE.test(cid)) {
      return res.status(400).json({ error: "Invalid cid" });
    }
    objectRepo.getObjIdsForBlob(cid, function (err, objIds) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!objIds.length) return res.status(404).json({ error: "Blob not found" });

      // Normally exactly one envelope references a given blob cid — walk the
      // (rare) rest so one dedup-shared blob doesn't 403 just because the
      // first referencing envelope isn't readable by this requester.
      (function tryNext(i) {
        if (i >= objIds.length) return res.status(403).json({ error: "Forbidden" });
        objectRepo.get(objIds[i], function (err, envelope) {
          if (err) return res.status(500).json({ error: String(err) });
          if (!envelope || !_canReadEnvelope(envelope, req.identity)) {
            return tryNext(i + 1);
          }
          blobStore.get(cid, function (err, stream) {
            if (err) return res.status(500).json({ error: String(err) });
            if (!stream) return res.status(404).json({ error: "Blob not found" });
            if (envelope.visibility === "public") {
              var mime = (envelope.record && envelope.record.payload &&
                envelope.record.payload.mime) || "application/octet-stream";
              // SVG rule (Encryption.md §5.2): never let a served SVG execute
              // as a document — same fix as the legacy uploads route below.
              if (mime === "image/svg+xml") res.setHeader("Content-Disposition", "attachment");
              res.setHeader("Content-Type", mime);
            } else {
              // Private/shared: the server cannot read the real mime out of
              // the encrypted metadata. Serve as ciphertext — the client
              // decrypts and re-types it via FileCrypto.fetchAndDecrypt.
              res.setHeader("Content-Type", "application/octet-stream");
            }
            stream.pipe(res);
          });
        });
      })(0);
    });
  });

  app.delete("/@:handle/blobs/:cid", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    var cid = req.params.cid;
    if (req.identity.handle !== handle) {
      return res.status(403).json({ error: "Forbidden: not your blob space" });
    }
    if (!blobStore.CID_RE.test(cid)) {
      return res.status(400).json({ error: "Invalid cid" });
    }
    objectRepo.getObjIdsForBlob(cid, function (err, objIds) {
      if (err) return res.status(500).json({ error: String(err) });
      if (objIds.length > 1) {
        return res.status(409).json({ error: "Blob is still referenced by another object" });
      }
      blobStore.delete(cid, function (err, result) {
        if (err) return res.status(500).json({ error: String(err) });
        res.json(result);
      });
    });
  });

  // ─── postcards listing ─────────────────────────────────────────────────────
  // Must be registered before /@:handle/:objId — "postcards" would otherwise be
  // captured as an objId literal (same ordering rule as "did-document").

  app.get("/@:handle/postcards", auth.optionalAuth, function (req, res) {
    var handle = req.params.handle;
    var limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    var cursor = req.query.cursor || null;

    handleRegistry.resolve(handle, function (err, did) {
      if (err)  return res.status(500).json({ error: String(err) });
      if (!did) return res.status(404).json({ error: "Handle not found: @" + handle });
      objectRepo.listPostcardsForUser(did, { limit: limit, cursor: cursor }, function (err, result) {
        if (err) return res.status(500).json({ error: String(err) });
        var viewerDid = req.identity ? req.identity.did : null;
        result.postcards = result.postcards
          .filter(function (m) { return _canSeePostcardMeta(m, viewerDid); })
          .map(function (m) { delete m.recipients; return m; });
        res.json(result);
      });
    });
  });

  // ─── inbox ─────────────────────────────────────────────────────────────────
  // Must be registered before /@:handle/:objId.

  app.get("/@:handle/inbox", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    if (req.identity.handle !== handle)
      return res.status(403).json({ error: "Forbidden: not your inbox" });
    var limit  = Math.min(parseInt(req.query.limit,  10) || 20, 100);
    var offset = parseInt(req.query.offset, 10) || 0;
    objectRepo.listInboxForHandle(handle, { limit: limit, offset: offset }, function (err, result) {
      if (err) return res.status(500).json({ error: String(err) });
      res.json(result);
    });
  });

  // POST /@:handle/inbox — deliver a post card reference to a recipient.
  // Checks the recipient's block list before writing.
  // Returns the byte-identical postal response for all failure causes (§2.3 anti-leak invariant).
  // Also records the delivery outcome in the sender's own deliveries log.
  //
  // Timing: every outcome (unknown handle, blocked, delivered) performs the
  // same registry lookup + settings lookup + one awaited write before
  // responding, so response latency doesn't reveal which outcome occurred
  // (§2.3 INVARIANT — audit F7). The settings lookup runs even for an unknown
  // handle (recipientDid null is a normal, equally-fast no-match query); the
  // delivery-log write is awaited on every path instead of fire-and-forget.
  // The one residual asymmetry — a delivered card also writes an inbox
  // record — is an unavoidable extra write the audit calls out as acceptable
  // residual, not the structural gap being closed here.
  app.post("/@:handle/inbox", auth.requireAuth, function (req, res) {
    var handle       = req.params.handle;
    var body         = req.body;
    var senderHandle = req.identity ? req.identity.handle : null;
    var senderDid    = req.identity ? req.identity.did : null;
    var POSTAL_REJECTION = { returned: true, reason: "Returned to sender. Not deliverable as addressed / unable to forward." };

    if (!body || !body.objId) {
      return res.status(400).json({ error: "Missing required field: objId" });
    }
    if (!senderDid) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    function _recordDelivery(status, thenDo) {
      if (!senderHandle) return thenDo();
      var rec = { objId: body.objId, recipientHandle: handle, sentAt: new Date().toISOString(), status: status };
      objectRepo.putDeliveryRecord(senderHandle, rec, function (err) {
        if (err) console.warn('[IdentityServer] putDeliveryRecord failed:', err.message);
        thenDo();
      });
    }

    handleRegistry.resolve(handle, function (err, recipientDid) {
      var unknownHandle = !!(err || !recipientDid);

      // Load settings unconditionally — even for an unknown handle — so the
      // response timing is the same shape regardless of outcome.
      objectRepo.getSettingsForDid(recipientDid || null, function (err2, settingsEnv) {
        var settings = (settingsEnv && settingsEnv.state) || {};
        var blockedDids    = settings.blockedDids    || [];
        var blockedHandles = settings.blockedHandles || [];

        var isBlocked = !unknownHandle && (
          blockedDids.indexOf(senderDid) !== -1 ||
          (senderHandle && blockedHandles.indexOf(senderHandle) !== -1)
        );

        if (unknownHandle || isBlocked) {
          return _recordDelivery('returned', function () {
            res.json(POSTAL_REJECTION);
          });
        }

        // Confirm the sender actually has access to what they're claiming to
        // send — without this, any authenticated user could push an
        // arbitrary objId into anyone's inbox (postcard-audit F24). Runs
        // after the block-list decision above so the two existing outcomes'
        // response shape/timing (F7) is untouched; a bad objId is a
        // genuinely different error class, not a delivery outcome.
        objectRepo.get(body.objId, function (getErr, objEnvelope) {
          if (getErr) return res.status(500).json({ error: String(getErr) });
          if (!objEnvelope) return res.status(404).json({ error: "Object not found: " + body.objId });
          var isOwner = objEnvelope.did === senderDid;
          var isRecipient = ((objEnvelope.record && objEnvelope.record.recipients) || []).some(function (r) {
            return (r.did || r) === senderDid;
          });
          if (!isOwner && !isRecipient) {
            return res.status(403).json({ error: "Forbidden: you do not have access to this object" });
          }

          var record = { objId: body.objId, senderDid: senderDid, senderHandle: senderHandle, sentAt: new Date().toISOString() };
          objectRepo.putInboxRecord(handle, record, function (err3) {
            if (err3) return res.status(500).json({ error: String(err3) });
            _recordDelivery('delivered', function () {
              res.json({ ok: true, delivered: true });
            });
          });
        });
      });
    });
  });

  // ─── deliveries (sender-side outbound log) ─────────────────────────────────
  // Must be registered before /@:handle/:objId.

  app.get("/@:handle/deliveries", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    if (req.identity.handle !== handle)
      return res.status(403).json({ error: "Forbidden: not your deliveries" });
    var limit  = Math.min(parseInt(req.query.limit,  10) || 20, 100);
    var offset = parseInt(req.query.offset, 10) || 0;
    var status = req.query.status || null; // 'delivered' | 'returned' | null (all)
    objectRepo.listDeliveriesForHandle(handle, { limit: limit, offset: offset, status: status }, function (err, result) {
      if (err) return res.status(500).json({ error: String(err) });
      res.json(result);
    });
  });

  // ─── settings ──────────────────────────────────────────────────────────────
  // Must be registered before /@:handle/:objId.

  app.get("/@:handle/settings", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    if (req.identity.handle !== handle)
      return res.status(403).json({ error: "Forbidden: not your settings" });
    objectRepo.getSettingsForDid(req.identity.did, function (err, envelope) {
      if (err) return res.status(500).json({ error: String(err) });
      if (envelope) return res.json(envelope);
      // Auto-create default settings on first read.
      // Block list lives in state (server-readable denormalized metadata),
      // not payload — settings need to be checked without decrypting a
      // payload (audit F18).
      var payload  = {};
      var objId    = genObjId();
      var defEnv   = {
        objId: objId, did: req.identity.did, type: 'settings', visibility: 'private',
        created: new Date().toISOString(),
        record: { cid: computeCidSync(payload), prevCid: null, payload: payload },
        state: { name: 'settings', blockedDids: [], blockedHandles: [] }
      };
      objectRepo.put(defEnv, function (putErr) {
        if (putErr) return res.status(500).json({ error: String(putErr) });
        res.json(defEnv);
      });
    });
  });

  app.put("/@:handle/settings", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    if (req.identity.handle !== handle)
      return res.status(403).json({ error: "Forbidden: not your settings" });
    var envelope = req.body;
    if (!envelope || !envelope.objId || !envelope.record || !envelope.record.cid)
      return res.status(400).json({ error: "Invalid settings envelope" });
    if (envelope.type !== 'settings')
      return res.status(400).json({ error: 'Envelope type must be "settings"' });
    if (envelope.did !== req.identity.did)
      return res.status(403).json({ error: "Forbidden: DID mismatch" });
    // Normalize: block list must live in state so the inbox handler can read it
    // without decrypting a payload. Move it out of payload if an old client
    // put it there (audit F18). record.cid is defined as the hash of
    // record.payload (SignedSerializer.js hard-fails deserialize on a
    // mismatch) — since we're changing payload's content, cid must be
    // recomputed for it, not carried over from what the client sent.
    var pl = (envelope.record && envelope.record.payload) || {};
    if (pl.blockedDids || pl.blockedHandles) {
      var newPayload = Object.assign({}, pl);
      delete newPayload.blockedDids;
      delete newPayload.blockedHandles;
      envelope = Object.assign({}, envelope, {
        state: Object.assign({}, envelope.state || {}, {
          blockedDids:    pl.blockedDids    || (envelope.state && envelope.state.blockedDids)    || [],
          blockedHandles: pl.blockedHandles || (envelope.state && envelope.state.blockedHandles) || [],
        }),
        record: Object.assign({}, envelope.record, {
          payload: newPayload,
          cid: computeCidSync(newPayload),
        }),
      });
    }
    objectRepo.put(envelope, function (err, result) {
      if (err) return res.status(500).json({ error: String(err) });
      res.json({ ok: true, objId: result.objId, cid: result.cid, changed: result.changed });
    });
  });

  // ─── inline replies listing ─────────────────────────────────────────────────
  // Sub-route under /:objId — registered before /:objId/versions to take priority.

  app.get("/@:handle/:objId/replies", auth.optionalAuth, function (req, res) {
    var objId  = req.params.objId;
    var limit  = Math.min(parseInt(req.query.limit,  10) || 20, 100);
    var cursor = req.query.cursor || null;

    objectRepo.get(objId, function (err, parentEnv) {
      if (err)         return res.status(500).json({ error: String(err) });
      if (!parentEnv)  return res.status(404).json({ error: "Object not found: " + objId });

      objectRepo.listRepliesForPostcard(objId, { limit: limit, cursor: cursor }, function (err, result) {
        if (err) return res.status(500).json({ error: String(err) });
        // Visibility filter: omit envelopes the requester cannot read (§10.4)
        var viewerDid = req.identity ? req.identity.did : null;
        result.postcards = result.postcards
          .filter(function (m) { return _canSeePostcardMeta(m, viewerDid); })
          .map(function (m) { delete m.recipients; return m; });
        res.json(result);
      });
    });
  });

  // ─── GET object ────────────────────────────────────────────────────────────

  app.get("/@:handle/:objId", auth.optionalAuth, function (req, res) {
    var handle = req.params.handle;
    var objId = req.params.objId;

    objectRepo.get(objId, function (err, envelope) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!envelope)
        return res.status(404).json({ error: "Object not found: " + objId });

      if (!_canReadEnvelope(envelope, req.identity)) {
        if (req.accepts(["html", "json"]) === "html") {
          return res
            .status(403)
            .send(
              buildAccessDeniedPage({
                title: "Access denied",
                heading: "This world is private",
                message:
                  "@" +
                  handle +
                  " has not shared this object with you.",
                objId: objId,
                showRequestButton: true,
                loggedIn: !!req.identity,
              }),
            );
        }
        return res.status(403).json({ error: "Forbidden" });
      }

      envelope = _trimRecipientsForNonOwner(envelope, req.identity);

      if (envelope.type === "world" && req.accepts(["html", "json"]) === "html") {
        var welcomeHandle = null;
        if (req.query.welcome && /^[a-z0-9_]{1,32}$/.test(req.query.welcome)) {
          welcomeHandle = req.query.welcome;
        }
        return res.send(buildWorldPage(envelope, welcomeHandle));
      }
      if (envelope.type === "postcard" && req.accepts(["html", "json"]) === "html") {
        return res.send(buildPostCardPage(envelope));
      }
      res.json(envelope);
    });
  });

  // ─── PUT object ────────────────────────────────────────────────────────────
  // Intentionally owner-only — Phase 1 "shared" visibility grants read access
  // via record.recipients (see GET above / addRecipient), not write access.
  // Co-editing shared objects is a future iteration, not implied by "shared".

  app.put("/@:handle/:objId", auth.requireAuth, function (req, res) {
    var handle = req.params.handle;
    var objId = req.params.objId;

    var envelope = req.body;
    if (typeof envelope === "string") {
      try {
        envelope = JSON.parse(envelope);
      } catch (e) {
        return res
          .status(400)
          .json({ error: "Invalid envelope JSON: " + e.message });
      }
    }

    if (!envelope || !envelope.objId) {
      return res.status(400).json({ error: "Invalid envelope: missing objId" });
    }

    if (envelope.objId !== objId) {
      return res.status(400).json({
        error:
          "objId mismatch: URL has " +
          objId +
          " but envelope has " +
          envelope.objId,
      });
    }

    if (envelope.type === "recovery") {
      return res.status(403).json({ error: "Recovery worlds are read-only" });
    }

    if (req.identity.did !== envelope.did) {
      return res
        .status(403)
        .json({ error: "Forbidden: envelope DID does not match session DID" });
    }

    handleRegistry.resolve(handle, function (err, registeredDid) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!registeredDid) {
        return res
          .status(404)
          .json({ error: "Handle not registered: @" + handle });
      }
      if (registeredDid !== envelope.did) {
        return res
          .status(403)
          .json({ error: "Forbidden: handle DID mismatch" });
      }

      // Location tags (state.location, a Plus Code) must never be stored
      // more precisely than a 6-significant-digit floor (~5.5km cell) —
      // enforced here regardless of what the client sent, since the client
      // is not the trust boundary. Coerces (floors) a too-precise code
      // rather than hard-rejecting it — a no-op for an honest client, which
      // already floors before ever sending; only a malformed/unparseable
      // code is a hard 400.
      if (envelope.state && envelope.state.location != null) {
        var flooredLocation = plusCode.truncateToFloor(envelope.state.location);
        if (!flooredLocation) {
          return res.status(400).json({ error: "Invalid location code" });
        }
        envelope = Object.assign({}, envelope, {
          state: Object.assign({}, envelope.state, { location: flooredLocation }),
        });
      }

      objectRepo.put(envelope, function (err, result) {
        if (err) return res.status(500).json({ error: String(err) });
        // IDENTITY: future — WaveBus-style fan-out on PUT.
        // After a successful write, notify any WebSocket connections subscribed
        // to this objId so other clients can pull the new version. This maps to
        // Wave's WaveBus.publish(). Use lively.net.SessionTracker (L2L) as the
        // transport when implementing. Not needed until live collaboration.
        res.json({
          ok: true,
          objId: result.objId,
          cid: result.cid,
          duplicate: result.duplicate || false,
          changed: result.changed || "content",
        });
      });
    });
  });

  // ─── access request ────────────────────────────────────────────────────────
  // Records that req.identity is asking the owner of objId for read access.
  // This intentionally does NOT attempt live L2L delivery to the owner: L2L
  // sessions are keyed by the legacy lively username (world.getUserName(true)),
  // not by identity handle/DID, so there is no existing way to look up "the
  // owner's session" from a DID alone. Wiring that requires the owner's client
  // to register its session under its identity handle first — a separate,
  // larger change. For now this is request-recording only; the owner finds
  // out by checking back, or a future notification mechanism.

  app.post(
    "/nodejs/IdentityServer/access-request/:objId",
    auth.requireAuth,
    function (req, res) {
      var objId = req.params.objId;

      objectRepo.get(objId, function (err, envelope) {
        if (err) return res.status(500).json({ error: String(err) });
        if (!envelope)
          return res.status(404).json({ error: "Object not found: " + objId });

        console.log(
          "[IdentityServer] Access requested for " +
            objId +
            " by " +
            req.identity.did +
            " (@" +
            req.identity.handle +
            "), owner=" +
            envelope.did,
        );

        if (req.accepts(["html", "json"]) === "html") {
          return res.send(
            buildAccessDeniedPage({
              title: "Request sent",
              heading: "Access requested",
              message:
                "The owner has been notified. Check back once they grant access.",
            }),
          );
        }
        res.json({ ok: true, requested: true });
      });
    },
  );

  // ─── grant access ──────────────────────────────────────────────────────────
  // Owner-only: adds recipientHandle's DID to the object's recipient list,
  // granting them read access (see ObjectRepository.addRecipient — this is an
  // ACL grant, not a re-encryption; see that function's doc comment for the
  // caveat on genuinely encrypted private objects).

  app.post(
    "/nodejs/IdentityServer/grant-access/:objId",
    auth.requireAuth,
    function (req, res) {
      var objId = req.params.objId;
      var recipientHandle = req.body && req.body.recipientHandle;

      if (!recipientHandle) {
        return res
          .status(400)
          .json({ error: "Missing required field: recipientHandle" });
      }

      objectRepo.get(objId, function (err, envelope) {
        if (err) return res.status(500).json({ error: String(err) });
        if (!envelope)
          return res.status(404).json({ error: "Object not found: " + objId });

        if (req.identity.did !== envelope.did) {
          return res
            .status(403)
            .json({ error: "Forbidden: only the owner can grant access" });
        }

        handleRegistry.resolve(recipientHandle, function (err, recipientDid) {
          if (err) return res.status(500).json({ error: String(err) });
          if (!recipientDid) {
            return res
              .status(404)
              .json({ error: "Handle not found: @" + recipientHandle });
          }

          objectRepo.addRecipient(objId, recipientDid, function (err, updated) {
            if (err) return res.status(500).json({ error: String(err) });
            res.json({
              ok: true,
              objId: objId,
              recipientDid: recipientDid,
              visibility: updated.visibility,
            });
          });
        });
      });
    },
  );

  // ─── view a specific version as a bootable world page ─────────────────────
  // Non-destructive: serves the stored payload at an exact CID as a live world.
  // Navigating away and back to /@handle returns to the current (latest) version.

  app.get("/@:handle/:objId/at/:cid", auth.optionalAuth, function (req, res) {
    var objId = req.params.objId;
    var cid   = req.params.cid;

    objectRepo.getVersion(objId, cid, function (err, envelope) {
      if (err)      return res.status(500).json({ error: String(err) });
      if (!envelope) return res.status(404).json({ error: "Version not found: " + cid });

      if (envelope.visibility !== "public") {
        if (!req.identity || req.identity.did !== envelope.did)
          return res.status(403).json({ error: "Forbidden" });
      }

      if (!req.accepts("html")) return res.json(envelope);

      var name = (envelope.state && envelope.state.name) || objId;
      var page = buildWorldPage(envelope);
      // Inject a banner so it's clear this is a historical snapshot, not current.
      var banner =
        '<div style="position:fixed;top:0;left:0;right:0;z-index:99999;' +
        'background:#f01a69;color:#fff;font:13px/32px sans-serif;text-align:center;' +
        'padding:0 12px;">' +
        '⚠ Viewing snapshot: <b>' + escapeHtml(name) + '</b> — ' +
        new Date(envelope.created || "").toLocaleString() +
        ' &nbsp;|&nbsp; <a href="javascript:history.back()" style="color:#fff;text-decoration:underline;">← back to current</a>' +
        '</div>';
      res.send(page.replace(/<body/, banner + '<body'));
    });
  });

  // ─── version history ───────────────────────────────────────────────────────

  app.get("/@:handle/:objId/versions", auth.optionalAuth, function (req, res) {
    var handle = req.params.handle;
    var objId  = req.params.objId;

    objectRepo.get(objId, function (err, envelope) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!envelope)
        return res.status(404).json({ error: "Object not found: " + objId });

      if (envelope.visibility !== "public") {
        if (!req.identity || req.identity.did !== envelope.did) {
          return res.status(403).json({ error: "Forbidden" });
        }
      }

      objectRepo.listVersions(objId, function (err, versions) {
        if (err) return res.status(500).json({ error: String(err) });

        if (!req.accepts("html")) return res.json({ versions: versions });

        var isOwner = !!(req.identity && req.identity.handle === handle);

        // Owner: boot the recovery world and open the Lively VersionViewer.
        // Falls back to static HTML if no recovery world exists yet.
        if (isOwner) {
          objectRepo.getRecoveryWorldForDid(envelope.did, function (rErr, recoveryEnvelope) {
            if (!rErr && recoveryEnvelope) {
              var livelyPage = buildWorldPage(recoveryEnvelope);
              var startupScript =
                '<script>' +
                '(function waitForLively(){' +
                'if(typeof lively==="undefined"||!lively.require)return setTimeout(waitForLively,200);' +
                'var _w=lively.morphic&&lively.morphic.World&&lively.morphic.World.current();' +
                'if(_w){' +
                  '_w.showsMorphMenu=false;' +
                  // Recovery page is read-only — block the old WebDAV save from firing
                  // (it would PUT to the full /versions URL which has no handler).
                  '_w.saveWorldAs=function(u,c,b,done){done&&done(null);};' +
                  '_w.saveWorld=function(done){done&&done(null);};' +
                '}' +
                'lively.require("lively.identity.VersionViewer").toRun(function(){' +
                'lively.identity.VersionViewer.open("' + handle + '","' + objId + '");' +
                '});})();' +
                '<\/script>';
              return res.send(livelyPage.replace('</body>', startupScript + '</body>'));
            }
            serveStaticHtml();
          });
          return;
        }

        serveStaticHtml();

        function serveStaticHtml() {
          var worldName = escapeHtml((envelope.state && envelope.state.name) || objId);
          var rows = versions.slice().reverse().map(function (v, idx) {
            var isCurrent = idx === 0;
            var dateStr   = v.createdAt
              ? new Date(v.createdAt).toLocaleString(undefined,
                  { dateStyle: "medium", timeStyle: "short" })
              : "—";
            var cidShort  = v.cid ? v.cid.slice(0, 16) + "…" : "—";
            var vName     = escapeHtml(v.name || "—");
            var viewUrl   = "/@" + escapeHtml(handle) + "/" + escapeHtml(objId) +
                            "/at/" + encodeURIComponent(v.cid);
            var actions = isCurrent
              ? '<span class="badge">current</span>'
              : '<a class="btn-view" href="' + viewUrl + '">view</a>' +
                (isOwner
                  ? ' <button class="btn-restore" onclick="doRestore(\'' +
                    v.cid + '\')">restore to here</button>'
                  : "");
            return '<li class="row">' +
              '<div class="meta">' +
              '<span class="name">' + vName + '</span>' +
              '<span class="date">' + dateStr + '</span>' +
              '<span class="cid">' + cidShort + '</span></div>' +
              '<div class="actions">' + actions + '</div></li>';
          }).join("\n");

          var page = '<!DOCTYPE html><html lang="en"><head>' +
            '<meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>Versions — ' + worldName + '</title>' +
            '<style>' +
            'body{font-family:system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#222}' +
            'h1{font-size:18px;font-weight:700;margin:0 0 4px}' +
            '.sub{font-size:13px;color:#888;margin:0 0 28px}' +
            'ul{list-style:none;margin:0;padding:0}' +
            '.row{display:flex;align-items:center;padding:12px 0;border-bottom:1px solid #eee}' +
            '.meta{flex:1}.name{font-size:14px;font-weight:700;display:block}' +
            '.date{font-size:12px;color:#666;display:block}' +
            '.cid{font-size:11px;color:#bbb;font-family:monospace}' +
            '.actions{display:flex;gap:8px;align-items:center}' +
            '.badge{font-size:11px;color:#aaa}' +
            '.btn-view{font-size:12px;color:#f01a69;text-decoration:none}' +
            '.btn-view:hover{text-decoration:underline}' +
            '.btn-restore{font-size:12px;background:none;border:1px solid #d44;color:#d44;' +
            'border-radius:4px;padding:2px 8px;cursor:pointer}' +
            '.btn-restore:hover{background:#fdf0f0}' +
            '#msg{margin-top:20px;font-size:13px}' +
            '</style></head><body>' +
            '<p><a href="/@' + escapeHtml(handle) + '/' + escapeHtml(objId) + '" ' +
            'style="font-size:13px;color:#f01a69;text-decoration:none">← current version</a></p>' +
            '<h1>' + worldName + '</h1>' +
            '<p class="sub">Version history &mdash; newest first</p>' +
            '<ul>' + rows + '</ul>' +
            '<p id="msg"></p>' +
            '<script>' +
            'function doRestore(cid){' +
            'if(!confirm("Restore to this version?\\nAll newer versions will be permanently deleted."))return;' +
            'document.getElementById("msg").textContent="Restoring…";' +
            'fetch("/@' + handle + '/' + objId + '/after/"+encodeURIComponent(cid),' +
            '{method:"DELETE",credentials:"include"})' +
            '.then(function(r){return r.json()})' +
            '.then(function(b){' +
            'if(b.ok){document.getElementById("msg").textContent="Restored. "+b.deleted+" newer version(s) removed.";' +
            'setTimeout(function(){location.reload()},1200)}' +
            'else{document.getElementById("msg").textContent="Error: "+(b.error||"unknown")}})' +
            '.catch(function(e){document.getElementById("msg").textContent="Error: "+e.message});}' +
            '<\/script></body></html>';

          res.send(page);
        }
      });
    });
  });

  // ─── sync delta ────────────────────────────────────────────────────────────

  app.get(
    "/@:handle/:objId/since/:prevCid",
    auth.optionalAuth,
    function (req, res) {
      var objId = req.params.objId;
      var prevCid = req.params.prevCid;

      objectRepo.get(objId, function (err, latestEnvelope) {
        if (err) return res.status(500).json({ error: String(err) });
        if (!latestEnvelope)
          return res.status(404).json({ error: "Object not found: " + objId });

        if (latestEnvelope.visibility !== "public") {
          if (!req.identity || req.identity.did !== latestEnvelope.did) {
            return res.status(403).json({ error: "Forbidden" });
          }
        }

        var since = prevCid === "genesis" ? null : prevCid;
        objectRepo.getVersionsSince(objId, since, function (err, deltas) {
          if (err) return res.status(500).json({ error: String(err) });
          res.json({ deltas: deltas });
        });
      });
    },
  );

  // ─── version revert ────────────────────────────────────────────────────────
  // Owner-only. Deletes all versions of an object written after the given cid,
  // making that cid the new current head. Used by the WorldsBrowser revert UI.

  app.delete(
    "/@:handle/:objId/after/:cid",
    auth.requireAuth,
    function (req, res) {
      var handle = req.params.handle;
      var objId  = req.params.objId;
      var cid    = req.params.cid;

      if (req.identity.handle !== handle)
        return res.status(403).json({ error: "Forbidden" });

      objectRepo.deleteVersionsAfter(objId, cid, function (err, result) {
        if (err) return res.status(500).json({ error: String(err) });
        res.json({ ok: true, deleted: result.deleted });
      });
    }
  );

  // ─── version diff ──────────────────────────────────────────────────────────
  // Returns a unified diff of two versions' payloads.
  // ?from=<cid>&to=<cid>  (from = older, to = newer)

  app.get("/@:handle/:objId/diff", auth.optionalAuth, function (req, res) {
    var objId = req.params.objId;
    var from  = req.query.from;
    var to    = req.query.to;

    if (!from || !to)
      return res.status(400).json({ error: 'Missing "from" or "to" query params' });

    objectRepo.getVersion(objId, from, function (err, envA) {
      if (err)   return res.status(500).json({ error: String(err) });
      if (!envA) return res.status(404).json({ error: "Version not found: " + from });

      if (envA.visibility !== "public" && (!req.identity || req.identity.did !== envA.did))
        return res.status(403).json({ error: "Forbidden" });

      objectRepo.getVersion(objId, to, function (err, envB) {
        if (err)   return res.status(500).json({ error: String(err) });
        if (!envB) return res.status(404).json({ error: "Version not found: " + to });

        var os   = require("os");
        var fs   = require("fs");
        var cp   = require("child_process");
        var path = require("path");
        var ts   = Date.now() + "-" + Math.random().toString(36).slice(2);
        var tmpA = path.join(os.tmpdir(), "lk-diff-a-" + ts + ".json");
        var tmpB = path.join(os.tmpdir(), "lk-diff-b-" + ts + ".json");

        try {
          fs.writeFileSync(tmpA, JSON.stringify((envA.record && envA.record.payload) || {}, null, 2));
          fs.writeFileSync(tmpB, JSON.stringify((envB.record && envB.record.payload) || {}, null, 2));
        } catch (e) {
          return res.status(500).json({ error: "Could not write temp files: " + e.message });
        }

        cp.exec("diff -u " + tmpA + " " + tmpB, function (err, stdout) {
          try { fs.unlinkSync(tmpA); } catch (e) {}
          try { fs.unlinkSync(tmpB); } catch (e) {}
          // diff exits 1 when there are differences — not an error
          res.json({ diff: stdout || "(no differences)" });
        });
      });
    });
  });

  // ─── constellation routes ───────────────────────────────────────────────────
  // /c/:constellation routes are app-level, not under /@:handle. Route
  // ordering: named segments (did.json, space-token) must be registered
  // before the /:objId wildcard, same discipline as /@:handle/* above.
  // Membership logic (canRead/canWrite) lives in ConstellationRegistry.js so
  // the HTTP routes here and the Yjs sync socket (PostCardSyncServer.js)
  // share exactly one source of truth for who can read/write a constellation.

  app.post("/c/:name", auth.requireAuth, function (req, res) {
    var name = req.params.name;
    var body = req.body || {};

    if (!constellationRegistry.isValidName(name)) {
      return res.status(400).json({ error: "Invalid or reserved constellation name: " + name });
    }
    if (!body.did || !body.genesisObjId || !body.genesisNonce || !body.createdAt || !body.creationSig) {
      return res
        .status(400)
        .json({ error: "Missing required fields: did, genesisObjId, genesisNonce, createdAt, creationSig" });
    }

    constellationRegistry.exists(name, function (err, taken) {
      if (err) return res.status(500).json({ error: String(err) });
      if (taken) return res.status(409).json({ error: "Constellation name already taken: " + name });

      var expectedPayload = {
        name: name,
        did: body.did,
        controller: [req.identity.did],
        threshold: 1,
        createdBy: req.identity.did,
        createdAt: body.createdAt
      };

      handleRegistry.getDIDDocument(req.identity.did, function (err, didDocument) {
        if (err) return res.status(500).json({ error: String(err) });
        if (!didDocument) {
          return res.status(400).json({ error: "No DID document on file for " + req.identity.did });
        }

        var verification = cryptoVerify.verifySignedPayload(expectedPayload, body.creationSig, didDocument);
        if (!verification.valid) {
          return res.status(400).json({ error: "creationSig verification failed: " + verification.reason });
        }

        constellationRegistry.create({
          name: name,
          did: body.did,
          genesisObjId: body.genesisObjId,
          genesisNonce: body.genesisNonce,
          controllers: [req.identity.did],
          threshold: 1,
          members: [req.identity.did],
          createdBy: req.identity.did,
          createdAt: body.createdAt,
          creationSig: body.creationSig,
          visibility: body.visibility === "private" ? "private" : "public"
        }, function (err) {
          if (err) return res.status(500).json({ error: String(err) });
          res.status(201).json({ name: name, did: body.did, genesisObjId: body.genesisObjId });
        });
      });
    });
  });

  app.get("/c/:name/did.json", auth.optionalAuth, function (req, res) {
    constellationRegistry.get(req.params.name, function (err, constellation) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!constellation) return res.status(404).json({ error: "Constellation not found: " + req.params.name });
      res.json({
        id: constellation.did,
        controller: constellation.controllers,
        threshold: constellation.threshold,
        createdBy: constellation.createdBy,
        createdAt: constellation.createdAt,
        creationSig: constellation.creationSig
      });
    });
  });

  app.get("/c/:name/space-token", auth.optionalAuth, function (req, res) {
    var name = req.params.name;
    constellationRegistry.get(name, function (err, constellation) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!constellation) return res.status(404).json({ error: "Constellation not found: " + name });
      var viewerDid = req.identity ? req.identity.did : null;
      if (!constellationRegistry.canRead(constellation, viewerDid)) {
        return res.status(404).json({ error: "Constellation not found: " + name });
      }
      res.json({
        token: constellationSpace.mintSpaceToken(constellation, req.identity),
        genesisObjId: constellation.genesisObjId,
        canWrite: constellationRegistry.canWrite(constellation, viewerDid)
      });
    });
  });

  // Post an existing (owned) post card to a constellation: tags the card
  // with this constellation (so it shows in the feed, same as the original
  // stub routes already relied on) and adds it to the live space's layout
  // map at a default cascading position (server-side, no WS connection
  // needed — see ConstellationSpace.js's addPlacementToSpace).
  app.post("/c/:name/posts", auth.requireAuth, function (req, res) {
    var name = req.params.name;
    var objId = (req.body || {}).objId;
    if (!objId) return res.status(400).json({ error: "Missing required field: objId" });

    constellationRegistry.get(name, function (err, constellation) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!constellation) return res.status(404).json({ error: "Constellation not found: " + name });
      if (!constellationRegistry.canWrite(constellation, req.identity.did)) {
        return res.status(403).json({ error: "Forbidden: not a member of " + name });
      }

      objectRepo.get(objId, function (err, envelope) {
        if (err) return res.status(500).json({ error: String(err) });
        if (!envelope) return res.status(404).json({ error: "Post card not found: " + objId });
        if (envelope.type !== "postcard") {
          return res.status(400).json({ error: "Not a post card: " + objId });
        }
        if (envelope.did !== req.identity.did) {
          return res.status(403).json({ error: "Forbidden: you can only post your own post cards" });
        }

        var updated = Object.assign({}, envelope, { constellation: name });
        objectRepo.put(updated, function (err) {
          if (err) return res.status(500).json({ error: String(err) });

          constellationSpace.addPlacementToSpace(constellation, {
            ref: { handle: req.identity.handle, objId: objId, cid: envelope.record.cid },
            kind: "postcard"
          }, function (err, result) {
            if (err) return res.status(500).json({ error: String(err) });
            res.status(200).json({ ok: true, placementId: result.id });
          });
        });
      });
    });
  });

  // Cross-user public postcards near a (already-coarse) Plus Code prefix —
  // backs the welcome page's lofi social map (LocalMap.js). No lat/lng
  // bounding-box math: Plus Codes are prefix-friendly, so a shared string
  // prefix already means a shared/nearby grid cell.
  app.get("/postcards/nearby", auth.optionalAuth, function (req, res) {
    // Floor the caller-supplied prefix through the same invariant as the
    // PUT path — never let an un-truncated code reach the query, even
    // though it only narrows the caller's own search (consistency, not a
    // privacy hole either way).
    var truncated = plusCode.truncateToFloor(req.query.code || "");
    if (!truncated) return res.status(400).json({ error: "Invalid location code" });
    var limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    var cursor = req.query.cursor || null;

    objectRepo.listPostcardsNearby(truncated, { limit: limit, cursor: cursor }, function (err, result) {
      if (err) return res.status(500).json({ error: String(err) });
      var viewerDid = req.identity ? req.identity.did : null;
      // visibility:'public' is already filtered at the SQL level — this is
      // defense-in-depth matching the other listing routes' pattern, so a
      // future SQL change can't silently drop the safety net.
      var visible = result.postcards.filter(function (m) { return _canSeePostcardMeta(m, viewerDid); });
      var dids = visible.map(function (m) { return m.did; });
      _resolveHandlesForDids(dids, function (resolveErr, didToHandle) {
        if (resolveErr) return res.status(500).json({ error: String(resolveErr) });
        result.postcards = visible.map(function (m) {
          var out = Object.assign({}, m, { handle: didToHandle[m.did] || null });
          delete out.recipients;
          return out;
        });
        res.json(result);
      });
    });
  });

  app.get("/c/:constellation/feed", auth.optionalAuth, function (req, res) {
    var name = req.params.constellation;
    constellationRegistry.get(name, function (err, constellation) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!constellation) return res.status(404).json({ error: "Constellation not found: " + name });
      if (!constellationRegistry.canRead(constellation, req.identity ? req.identity.did : null)) {
        return res.status(404).json({ error: "Constellation not found: " + name });
      }

      var limit  = Math.min(parseInt(req.query.limit,  10) || 20, 100);
      var cursor = req.query.cursor || null;
      objectRepo.listPostcardsForConstellation(name, { limit: limit, cursor: cursor }, function (err, result) {
        if (err) return res.status(500).json({ error: String(err) });
        var viewerDid = req.identity ? req.identity.did : null;
        result.postcards = result.postcards
          .filter(function (m) { return _canSeePostcardMeta(m, viewerDid); })
          .map(function (m) { delete m.recipients; return m; });
        res.json(result);
      });
    });
  });

  app.get("/c/:constellation/:objId", auth.optionalAuth, function (req, res) {
    var name  = req.params.constellation;
    var objId = req.params.objId;

    constellationRegistry.get(name, function (err, constellation) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!constellation) return res.status(404).json({ error: "Constellation not found: " + name });
      if (!constellationRegistry.canRead(constellation, req.identity ? req.identity.did : null)) {
        return res.status(404).json({ error: "Constellation not found: " + name });
      }

      objectRepo.get(objId, function (err, envelope) {
        if (err)      return res.status(500).json({ error: String(err) });
        if (!envelope) return res.status(404).json({ error: "Object not found: " + objId });

        // Validate constellation membership — this route's purpose is membership
        // verification, so the check is load-bearing (spec §4.2)
        if (envelope.constellation !== name) {
          return res.status(404).json({ error: "Post card " + objId + " is not in constellation " + name });
        }

        if (!_canReadEnvelope(envelope, req.identity)) {
          return res.status(403).json({ error: "Forbidden" });
        }

        envelope = _trimRecipientsForNonOwner(envelope, req.identity);

        if (req.accepts(["html", "json"]) === "html") {
          return res.send(buildPostCardPage(envelope));
        }
        res.json(envelope);
      });
    });
  });

  app.get("/c/:constellation", auth.optionalAuth, function (req, res) {
    var name = req.params.constellation;
    var viewerDid = req.identity ? req.identity.did : null;
    constellationRegistry.get(name, function (err, constellation) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!constellation) return res.status(404).json({ error: "Constellation not found: " + name });
      if (!constellationRegistry.canRead(constellation, viewerDid)) {
        return res.status(404).json({ error: "Constellation not found: " + name });
      }

      // HTML: the constellation's live space (static layout render, then
      // boots the live ConstellationSpace morph). JSON: unchanged, still the
      // post card feed listing — no breaking change for existing API callers.
      if (req.accepts(["html", "json"]) === "html") {
        return objectRepo.get(constellation.genesisObjId, function (err, spaceEnvelope) {
          if (err) return res.status(500).json({ error: String(err) });
          res.send(buildConstellationSpacePage(constellation, spaceEnvelope));
        });
      }

      var limit  = Math.min(parseInt(req.query.limit,  10) || 20, 100);
      var cursor = req.query.cursor || null;
      objectRepo.listPostcardsForConstellation(name, { limit: limit, cursor: cursor }, function (err, result) {
        if (err) return res.status(500).json({ error: String(err) });
        var postcards = result.postcards
          .filter(function (m) { return _canSeePostcardMeta(m, viewerDid); })
          .map(function (m) { delete m.recipients; return m; });
        res.json({ constellation: name, postcards: postcards, cursor: result.cursor });
      });
    });
  });

  // ─── catch-all for unmatched /@handle paths ────────────────────────────────
  // Anything under /@handle/... that didn't match a registered route above
  // would otherwise fall through to the WebDAV file server and land on disk
  // inside the git repo. Return 404 here to close that gap entirely.

  app.all("/@:handle/*", function (req, res) {
    res.status(404).json({ error: "Not found: " + req.path });
  });

  // ─── health check ──────────────────────────────────────────────────────────

  app.get(route, function (req, res) {
    res.json({ status: "lively identity server running" });
  });
};
