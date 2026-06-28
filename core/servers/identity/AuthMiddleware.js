/**
 * core/servers/identity/AuthMiddleware.js
 *
 * Express middleware for WebAuthn-based authentication.
 *
 * Responsibilities:
 *   - Issue challenges (random bytes, stored in server session)
 *   - Verify WebAuthn registration attestations via @simplewebauthn/server
 *   - Verify WebAuthn authentication assertions via @simplewebauthn/server
 *   - Attach verified DID to req.identity for downstream route handlers
 *   - requireAuth / optionalAuth Express middleware factories
 *
 * Session storage:
 *   Challenges are stored in req.session under 'identity-challenge' and
 *   consumed (deleted) after a single use — preventing replay attacks.
 *   Uses the life_star session (Jetty-style connect session via express-session).
 *
 * @simplewebauthn/server is used for:
 *   - verifyRegistrationResponse — validates attestation, extracts public key
 *   - verifyAuthenticationResponse — validates assertion signature
 *
 * The server never stores private keys. Public keys are stored in
 * ObjectRepository as part of the DID document envelope.
 */

'use strict';

var crypto = require('crypto');

// @simplewebauthn/server — loaded lazily so the server starts even if the
// package hasn't been npm-installed yet; routes that need it will 500 cleanly.
var _simpleWebAuthn = null;
function getSimpleWebAuthn() {
  if (_simpleWebAuthn) return _simpleWebAuthn;
  try {
    _simpleWebAuthn = require('@simplewebauthn/server');
  } catch (e) {
    throw new Error(
      'AuthMiddleware requires @simplewebauthn/server. ' +
      'Run: npm install @simplewebauthn/server  in the LivelyKernel directory.'
    );
  }
  return _simpleWebAuthn;
}

var handleRegistry = require('./HandleRegistry');

// ─── challenge management ─────────────────────────────────────────────────────

// Generate a 32-byte random challenge, store it in the session, return base64url.
function issueChallenge(req) {
  var challenge = crypto.randomBytes(32);
  var b64 = challenge.toString('base64url');
  // Store raw base64url string; simplewebauthn expects this form
  req.session['identity-challenge'] = b64;
  return b64;
}

// Consume and return the stored challenge. Returns null if none present.
// Consuming (deleting) prevents replay.
function consumeChallenge(req) {
  var challenge = req.session['identity-challenge'] || null;
  delete req.session['identity-challenge'];
  return challenge;
}

// ─── registration verification ───────────────────────────────────────────────

// Verify a WebAuthn registration response from the client.
//
// body: {
//   handle:            String
//   did:               String
//   attestationObject: String  — base64url
//   clientDataJSON:    String  — base64url
//   credentialId:      String  — base64url
// }
//
// Calls thenDo(err, { verified, credentialId, publicKeyJwk, handle, did }).
// On success, registers handle → DID in HandleRegistry.
function verifyRegistration(req, body, thenDo) {
  var expectedChallenge = consumeChallenge(req);
  if (!expectedChallenge) {
    return thenDo(new Error('No pending challenge for this session'));
  }

  var rpID   = req.hostname || 'localhost';
  var origin = req.protocol + '://' + req.get('host');

  var swAuth;
  try { swAuth = getSimpleWebAuthn(); }
  catch (e) { return thenDo(e); }

  swAuth.verifyRegistrationResponse({
    response: {
      id:                   body.credentialId,
      rawId:                body.credentialId,
      response: {
        attestationObject:  body.attestationObject,
        clientDataJSON:     body.clientDataJSON
      },
      clientExtensionResults: {},
      type: 'public-key'
    },
    expectedChallenge:       expectedChallenge,
    expectedOrigin:          origin,
    expectedRPID:            rpID,
    requireUserVerification: true
  }).then(function(result) {
    if (!result.verified) {
      return thenDo(new Error('WebAuthn registration verification failed'));
    }

    var regInfo = result.registrationInfo;
    // v9+: public key and counter are nested under registrationInfo.credential
    var cred = regInfo.credential;
    handleRegistry.saveCredential(
      body.credentialId,
      body.did,
      cred.publicKey,
      cred.counter,
      function(saveErr) {
        if (saveErr) return thenDo(saveErr);
        handleRegistry.register(body.handle, body.did, function(err) {
          if (err) return thenDo(err);
          thenDo(null, {
            verified:     true,
            credentialId: body.credentialId,
            publicKeyJwk: body.publicKeyJwk,
            handle:       body.handle,
            did:          body.did
          });
        });
      }
    );

  }).catch(function(err) {
    thenDo(new Error('WebAuthn registration error: ' + err.message));
  });
}

// ─── authentication verification ─────────────────────────────────────────────

// Verify a WebAuthn authentication assertion from the client.
//
// body: {
//   credentialId:      String  — base64url
//   authenticatorData: String  — base64url
//   clientDataJSON:    String  — base64url
//   signature:         String  — base64url
//   userHandle:        String|null — base64url
//   handle:            String  — the handle the user claims to be
// }
// COSE public key and counter are looked up server-side from HandleRegistry.
//
// Calls thenDo(err, { verified, did, handle, credentialId }).
// On success, attaches identity to req.session.
function verifyAuthentication(req, body, thenDo) {
  var expectedChallenge = consumeChallenge(req);
  if (!expectedChallenge) {
    return thenDo(new Error('No pending challenge for this session'));
  }

  var rpID   = req.hostname || 'localhost';
  var origin = req.protocol + '://' + req.get('host');

  var swAuth;
  try { swAuth = getSimpleWebAuthn(); }
  catch (e) { return thenDo(e); }

  handleRegistry.resolve(body.handle, function(err, registeredDid) {
    if (err) return thenDo(err);
    if (!registeredDid) {
      return thenDo(new Error('Handle not registered: ' + body.handle));
    }

    handleRegistry.getCredential(body.credentialId, function(err, credential) {
      if (err) return thenDo(err);
      if (!credential) {
        return thenDo(new Error('Credential not found: ' + body.credentialId));
      }

      swAuth.verifyAuthenticationResponse({
        response: {
          id:       body.credentialId,
          rawId:    body.credentialId,
          response: {
            authenticatorData: body.authenticatorData,
            clientDataJSON:    body.clientDataJSON,
            signature:         body.signature,
            userHandle:        body.userHandle || undefined
          },
          clientExtensionResults: {},
          type: 'public-key'
        },
        expectedChallenge:       expectedChallenge,
        expectedOrigin:          origin,
        expectedRPID:            rpID,
        requireUserVerification: true,
        // v9+: credential replaces authenticator; publicKey is COSE Uint8Array from DB
        credential: {
          id:        body.credentialId,
          publicKey: credential.publicKey,
          counter:   credential.counter
        }
      }).then(function(result) {
        if (!result.verified) {
          return thenDo(new Error('WebAuthn authentication verification failed'));
        }

        handleRegistry.updateCounter(body.credentialId, result.authenticationInfo.newCounter, function(counterErr) {
          if (counterErr) console.warn('[AuthMiddleware] Failed to update counter:', counterErr);

          req.session['identity-did']    = registeredDid;
          req.session['identity-handle'] = body.handle;

          thenDo(null, {
            verified:     true,
            did:          registeredDid,
            handle:       body.handle,
            credentialId: body.credentialId
          });
        });

      }).catch(function(err) {
        thenDo(new Error('WebAuthn authentication error: ' + err.message));
      });
    });
  });
}

// ─── Express middleware ───────────────────────────────────────────────────────

// Read the current verified identity from the session.
// Returns { did, handle } or null.
function getSessionIdentity(req) {
  var did    = req.session && req.session['identity-did'];
  var handle = req.session && req.session['identity-handle'];
  if (!did) return null;
  return { did: did, handle: handle };
}

// Middleware: attach req.identity if a verified session exists.
// Does not reject the request — use requireAuth for that.
function optionalAuth(req, res, next) {
  req.identity = getSessionIdentity(req);
  next();
}

// Middleware: reject with 401 if no verified identity in session.
function requireAuth(req, res, next) {
  req.identity = getSessionIdentity(req);
  if (!req.identity) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// Middleware: reject with 403 if the authenticated DID does not match
// the DID of the resource being accessed (prevents cross-user writes).
// Expects req.identity to be set (chain after requireAuth).
// Expects req.resourceDid to be set by the route handler before calling this.
function requireOwner(req, res, next) {
  if (!req.identity) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!req.resourceDid) {
    return res.status(500).json({ error: 'requireOwner: resourceDid not set by route' });
  }
  if (req.identity.did !== req.resourceDid) {
    return res.status(403).json({ error: 'Forbidden: you do not own this resource' });
  }
  next();
}

module.exports = {
  issueChallenge:      issueChallenge,
  consumeChallenge:    consumeChallenge,
  verifyRegistration:  verifyRegistration,
  verifyAuthentication: verifyAuthentication,
  getSessionIdentity:  getSessionIdentity,
  optionalAuth:        optionalAuth,
  requireAuth:         requireAuth,
  requireOwner:        requireOwner
};
