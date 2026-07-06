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
var handleRegistry = require("./identity/HandleRegistry");
var objectRepo = require("./identity/ObjectRepository");
var auth = require("./identity/AuthMiddleware");

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
                var resp = { ok: true, handle: result.handle, did: result.did };
                if (homeWorldObjId) resp.homeWorldObjId = homeWorldObjId;
                res.json(resp);
              });
            });
          });
        });
      } else {
        createHomeWorld(result.did, function (worldErr, homeWorldObjId) {
          createDefaultProfile(result.did, result.handle, function (profileErr, profileObjId) {
            createRecoveryWorld(result.did, function () {
              var resp = { ok: true, handle: result.handle, did: result.did };
              if (homeWorldObjId) resp.homeWorldObjId = homeWorldObjId;
              res.json(resp);
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
  // Visitors with a valid session cookie are redirected straight to their
  // home world so they don't have to click "login" again.
  // Non-authenticated visitors fall through to the static file.

  app.get("/welcome.html", auth.optionalAuth, function (req, res, next) {
    if (!req.identity) return next();
    objectRepo.listForUser(req.identity.did, function (err, envelopes) {
      if (err || !envelopes || !envelopes.length) return next();
      var worlds = envelopes.filter(function (e) { return e.type === "world"; });
      if (!worlds.length) return next();
      worlds.sort(function (a, b) { return a.created < b.created ? -1 : 1; });
      res.redirect("/@" + req.identity.handle + "/" + worlds[0].objId);
    });
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
  // PUT /@handle/uploads/<path> — store a file to identity/uploads/<handle>/
  // GET /@handle/uploads/<path> — serve the file back
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

  app.get("/@:handle/uploads/*", auth.optionalAuth, function (req, res) {
    var resolved = _resolveUploadPath(req.params.handle, req.params[0]);
    if (!resolved) return res.status(400).json({ error: "Invalid file path" });
    fs.stat(resolved.full, function (err, stat) {
      if (err || !stat.isFile())
        return res.status(404).json({ error: "File not found" });
      var mime = _uploadMimeTypes[path.extname(resolved.full).toLowerCase()] ||
        "application/octet-stream";
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

  // ─── GET object ────────────────────────────────────────────────────────────

  app.get("/@:handle/:objId", auth.optionalAuth, function (req, res) {
    var handle = req.params.handle;
    var objId = req.params.objId;

    objectRepo.get(objId, function (err, envelope) {
      if (err) return res.status(500).json({ error: String(err) });
      if (!envelope)
        return res.status(404).json({ error: "Object not found: " + objId });

      if (envelope.visibility !== "public") {
        var isOwner = req.identity && req.identity.did === envelope.did;
        var recipients = (envelope.record && envelope.record.recipients) || [];
        var isRecipient =
          req.identity &&
          recipients.some(function (r) {
            return (r.did || r) === req.identity.did;
          });

        if (!isOwner && !isRecipient) {
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
      }

      if (envelope.type === "world" && req.accepts(["html", "json"]) === "html") {
        var welcomeHandle = null;
        if (req.query.welcome && /^[a-z0-9_]{1,32}$/.test(req.query.welcome)) {
          welcomeHandle = req.query.welcome;
        }
        return res.send(buildWorldPage(envelope, welcomeHandle));
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
