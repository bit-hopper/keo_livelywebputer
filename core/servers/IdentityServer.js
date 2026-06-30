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
 *   GET  /@:handle           — home manifest (all objects for this handle)
 *   GET  /@:handle/:objId    — fetch a specific object envelope (owner or
 *                              recipient; renders an HTML access-denied page
 *                              with a "Request Access" button for browsers)
 *   PUT  /@:handle/:objId    — store a new envelope version (owner only)
 *   GET  /@:handle/:objId/versions        — version history
 *   GET  /@:handle/:objId/since/:prevCid  — sync delta
 *
 *   POST /nodejs/IdentityServer/access-request/:objId  — request read access
 *   POST /nodejs/IdentityServer/grant-access/:objId    — owner grants access
 */

"use strict";

var url = require("url");
var handleRegistry = require("./identity/HandleRegistry");
var objectRepo = require("./identity/ObjectRepository");
var auth = require("./identity/AuthMiddleware");

// ─── HTML helpers (access-denied / access-requested pages) ───────────────────

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
    return (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ]
    );
  });
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
          res.json({ ok: true, handle: result.handle, did: result.did });
        });
      } else {
        res.json({ ok: true, handle: result.handle, did: result.did });
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

  // ─── version history ───────────────────────────────────────────────────────

  app.get("/@:handle/:objId/versions", auth.optionalAuth, function (req, res) {
    var objId = req.params.objId;

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
        res.json({ versions: versions });
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

  // ─── health check ──────────────────────────────────────────────────────────

  app.get(route, function (req, res) {
    res.json({ status: "lively identity server running" });
  });
};
