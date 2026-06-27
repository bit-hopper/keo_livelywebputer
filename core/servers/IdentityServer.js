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
 *   GET  /@:handle/:objId    — fetch a specific object envelope
 *   PUT  /@:handle/:objId    — store a new envelope version (auth required)
 *   GET  /@:handle/:objId/versions        — version history
 *   GET  /@:handle/:objId/since/:prevCid  — sync delta
 */

"use strict";

var url = require("url");
var handleRegistry = require("./identity/HandleRegistry");
var objectRepo = require("./identity/ObjectRepository");
var auth = require("./identity/AuthMiddleware");

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
        var didEnvelope;
        try {
          didEnvelope =
            typeof body.didDocument === "string"
              ? JSON.parse(body.didDocument)
              : body.didDocument;
        } catch (e) {
          return res
            .status(400)
            .json({ error: "Invalid didDocument JSON: " + e.message });
        }

        objectRepo.put(didEnvelope, function (putErr) {
          if (putErr && !putErr.toString().includes("UNIQUE")) {
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

  // ─── GET object ────────────────────────────────────────────────────────────

  app.get("/@:handle/:objId", auth.optionalAuth, function (req, res) {
    var handle = req.params.handle;
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

      res.json(envelope);
    });
  });

  // ─── PUT object ────────────────────────────────────────────────────────────

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
        res.json({
          ok: true,
          objId: result.objId,
          cid: result.cid,
          duplicate: result.duplicate || false,
        });
      });
    });
  });

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
