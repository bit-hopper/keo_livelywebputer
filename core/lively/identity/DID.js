/**
 * lively.identity.DID
 *
 * did:jwk identity management for the Lively identity system.
 *
 * Responsibilities:
 *   - Create a did:jwk DID string from a JWK public key
 *   - Build, parse, and validate DID documents
 *   - Add and revoke verification methods (per-device keys)
 *   - Sign and verify DID documents (so tampering is detectable)
 *   - Persist the current user's DID document and device key metadata
 *     in lively.IndexedDB under the 'identity' store
 *   - Integrate with lively.users.User: after DID auth, set the world's
 *     UserName (via lively.Config) so existing L2L / Wiki / PartsBin code
 *     that calls $world.getUserName() continues to work unchanged
 *   - Expose lively.identity.did.currentUser() for the rest of the
 *     identity stack
 *
 * What this module does NOT do:
 *   - WebAuthn ceremony (that is lively.identity.WebAuthn)
 *   - Crypto primitives (that is lively.identity.Crypto)
 *   - URL composition / handle resolution (that is lively.identity.WebKey)
 *   - Server-side DID resolution (that is core/servers/identity/HandleRegistry.js)
 *
 * Async pattern: thenDo(err, result) throughout.
 *
 * Storage layout in lively.IndexedDB 'identity' store:
 *   'identity-did-document'        — the current user's full DID document (JSON)
 *   'identity-did-meta'            — { handle, displayName, did, rpId } (JSON)
 *   'identity-device-<credId>'     — per-device key record (JSON)
 */

module("lively.identity.DID")
  .requires("lively.identity.Crypto")
  // Note: lively.Config and lively.net.SessionTracker are globally available
  // at load time — no requires() needed for them.
  .toRun(function () {
    Object.subclass(
      "lively.identity.DID",

      // ─── did:jwk construction ─────────────────────────────────────────────────────

      "construction",
      {
        // Build a did:jwk string from a JWK public key.
        // The method parameter is base64url(canonicalJson(jwk)).
        // Only the RFC 7638 required members are included (canonicalizeJwk
        // in Crypto strips extras), ensuring the DID is stable across
        // different exportKey() outputs.
        didFromJwk: function (publicKeyJwk) {
          var c = lively.identity.crypto;
          var canonical = c.canonicalizeJwk(publicKeyJwk);
          var encoded = c.base64urlEncode(new TextEncoder().encode(canonical));
          return "did:jwk:" + encoded;
        },

        // Recover the JWK from a did:jwk string (inverse of didFromJwk).
        // Calls thenDo(null, jwk) or thenDo(err).
        jwkFromDid: function (did, thenDo) {
          if (typeof did !== "string" || !did.startsWith("did:jwk:")) {
            return thenDo(
              new Error("jwkFromDid: not a did:jwk string: " + did),
            );
          }
          var encoded = did.slice("did:jwk:".length);
          try {
            var c = lively.identity.crypto;
            var bytes = c.base64urlDecode(encoded);
            var jwk = JSON.parse(new TextDecoder().decode(bytes));
            thenDo(null, jwk);
          } catch (e) {
            thenDo(
              new Error(
                "jwkFromDid: failed to decode JWK from DID: " + e.message,
              ),
            );
          }
        },
      },

      // ─── DID document ─────────────────────────────────────────────────────────────

      "document",
      {
        // Build a new DID document for a freshly registered identity.
        //
        // params: {
        //   did:          String   — the did:jwk string (from didFromJwk)
        //   publicKeyJwk: Object   — the device's EC P-256 public key JWK
        //   credentialId: String   — base64url WebAuthn credential ID
        //   deviceLabel:  String   — human-readable label, e.g. "MacBook Pro 2024"
        //   handle:       String   — the user's chosen handle
        // }
        //
        // The first verification method becomes both the authentication and
        // assertionMethod entry. Additional devices are added via addVerificationMethod.
        buildDocument: function (params) {
          var methodId =
            params.did + "#" + this._methodFragment(params.credentialId);
          return {
            "@context": [
              "https://www.w3.org/ns/did/v1",
              "https://w3id.org/security/suites/jws-2020/v1",
            ],
            id: params.did,
            verificationMethod: [
              {
                id: methodId,
                type: "JsonWebKey2020",
                controller: params.did,
                publicKeyJwk: params.publicKeyJwk,
                // Lively-specific metadata — not part of the W3C spec,
                // stored here for convenience; servers may strip these.
                lively: {
                  credentialId: params.credentialId,
                  deviceLabel: params.deviceLabel || "Device",
                  addedAt: new Date().toISOString(),
                },
              },
            ],
            authentication: [methodId],
            assertionMethod: [methodId],
            // version chain — see updateDocument()
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            prevHash: null, // null for genesis document
            // sig is added by signDocument()
          };
        },

        // Add a new verification method to an existing document (new device).
        //
        // params: {
        //   publicKeyJwk: Object
        //   credentialId: String
        //   deviceLabel:  String
        // }
        //
        // Returns a new document object (does not mutate the original).
        addVerificationMethod: function (document, params) {
          var doc = this._cloneDocument(document);
          var methodId =
            doc.id + "#" + this._methodFragment(params.credentialId);

          // Idempotent: don't add if credentialId already present
          var exists = doc.verificationMethod.some(function (vm) {
            return vm.lively && vm.lively.credentialId === params.credentialId;
          });
          if (exists) return doc;

          doc.verificationMethod.push({
            id: methodId,
            type: "JsonWebKey2020",
            controller: doc.id,
            publicKeyJwk: params.publicKeyJwk,
            lively: {
              credentialId: params.credentialId,
              deviceLabel: params.deviceLabel || "Device",
              addedAt: new Date().toISOString(),
            },
          });
          doc.authentication.push(methodId);
          doc.assertionMethod.push(methodId);
          doc.updated = new Date().toISOString();
          return doc;
        },

        // Remove a verification method by credentialId (device revocation).
        // Returns a new document object. Raises an error if removing the last method.
        revokeVerificationMethod: function (document, credentialId, thenDo) {
          var remaining = document.verificationMethod.filter(function (vm) {
            return !(vm.lively && vm.lively.credentialId === credentialId);
          });
          if (remaining.length === 0) {
            return thenDo(
              new Error(
                "revokeVerificationMethod: cannot remove the last verification method — " +
                  "this would make the DID uncontrollable. Deactivate the DID instead.",
              ),
            );
          }
          var doc = this._cloneDocument(document);
          var revokedId =
            document.id + "#" + this._methodFragment(credentialId);
          doc.verificationMethod = remaining;
          doc.authentication = doc.authentication.filter(function (id) {
            return id !== revokedId;
          });
          doc.assertionMethod = doc.assertionMethod.filter(function (id) {
            return id !== revokedId;
          });
          doc.updated = new Date().toISOString();
          thenDo(null, doc);
        },

        // Find the verification method entry for a given credentialId.
        // Returns the method object or null.
        findMethodByCredentialId: function (document, credentialId) {
          return (
            document.verificationMethod.find(function (vm) {
              return vm.lively && vm.lively.credentialId === credentialId;
            }) || null
          );
        },

        // Compute a method fragment from a credentialId.
        // Uses the first 8 chars of base64url(credentialId) for brevity.
        _methodFragment: function (credentialId) {
          return "key-" + credentialId.slice(0, 8);
        },

        _cloneDocument: function (doc) {
          return JSON.parse(JSON.stringify(doc));
        },
      },

      // ─── document signing & verification ─────────────────────────────────────────

      "signing",
      {
        // Sign a DID document with a device's private key.
        //
        // The document is signed without its existing `sig` field (if any),
        // and a new `sig` (JWS compact) is attached.
        //
        // The `prevHash` field is set to the SHA-256 of the previous document's
        // canonical JSON before signing, forming a hash chain analogous to
        // Wave's HashedVersion. For the genesis document prevHash is null.
        //
        // privateKey: CryptoKey (ECDSA P-256, from Crypto.importPrivateKeyJwk)
        //
        // Calls thenDo(null, signedDocument).
        signDocument: function (
          document,
          privateKey,
          prevDocumentOrNull,
          thenDo,
        ) {
          var self = this;
          var c = lively.identity.crypto;
          var doc = self._cloneDocument(document);
          delete doc.sig;

          function sign(doc) {
            c.signEnvelope(doc, privateKey, function (err, jws) {
              if (err) return thenDo(err);
              doc.sig = jws;
              thenDo(null, doc);
            });
          }

          if (!prevDocumentOrNull) {
            doc.prevHash = null;
            sign(doc);
          } else {
            // Hash the previous document (without its sig) to form the chain link
            var prev = self._cloneDocument(prevDocumentOrNull);
            delete prev.sig;
            c.sha256(c.canonicalJson(prev), function (err, hash) {
              if (err) return thenDo(err);
              doc.prevHash = hash;
              sign(doc);
            });
          }
        },

        // Verify a signed DID document.
        //
        // Cannot use Crypto.verifyEnvelope here — that method is for object
        // envelopes which embed `publicKey` in the document body. DID documents
        // don't have that field; the key lives in verificationMethod[].
        // Instead: check the JWS payload matches the canonical document, then
        // try each verification method's key via Crypto.verifyJws directly.
        //
        // Calls thenDo(null, true|false).
        verifyDocument: function (document, thenDo) {
          var c = lively.identity.crypto;
          if (!document.sig) return thenDo(null, false);

          var parts = document.sig.split(".");
          if (parts.length !== 3) return thenDo(null, false);

          // Confirm JWS payload encodes the canonical document (without sig)
          var docWithoutSig = {};
          Object.keys(document).forEach(function (k) {
            if (k !== "sig") docWithoutSig[k] = document[k];
          });
          var expectedPayloadB64 = c.base64urlEncode(
            new TextEncoder().encode(c.canonicalJson(docWithoutSig))
          );
          if (parts[1] !== expectedPayloadB64) return thenDo(null, false);

          // Try each verification method's key against the JWS signature
          var methods = document.verificationMethod || [];
          if (methods.length === 0) return thenDo(null, false);

          var found = false;
          var remaining = methods.length;
          methods.forEach(function (vm) {
            c.verifyJws(document.sig, vm.publicKeyJwk, function (err, valid) {
              if (found) return;
              if (!err && valid) {
                found = true;
                thenDo(null, true);
              } else {
                if (--remaining === 0) thenDo(null, false);
              }
            });
          });
        },
      },

      // ─── persistence ──────────────────────────────────────────────────────────────

      "persistence",
      {
        // Persist the current user's DID document to IndexedDB.
        saveDocument: function (document, thenDo) {
          lively.IndexedDB.set(
            "identity-did-document",
            JSON.stringify(document),
            thenDo || function () {},
            "identity",
          );
        },

        // Load the persisted DID document from IndexedDB.
        // Calls thenDo(null, document) or thenDo(null, null) if not found.
        loadDocument: function (thenDo) {
          lively.IndexedDB.get(
            "identity-did-document",
            function (err, json) {
              if (err || !json) return thenDo(null, null);
              try {
                thenDo(null, JSON.parse(json));
              } catch (e) {
                thenDo(e);
              }
            },
            "identity",
          );
        },

        // Persist the identity meta record: { handle, displayName, did, rpId }.
        saveMeta: function (meta, thenDo) {
          lively.IndexedDB.set(
            "identity-did-meta",
            JSON.stringify(meta),
            thenDo || function () {},
            "identity",
          );
        },

        // Load the identity meta record.
        // Calls thenDo(null, meta) or thenDo(null, null) if not found.
        loadMeta: function (thenDo) {
          lively.IndexedDB.get(
            "identity-did-meta",
            function (err, json) {
              if (err || !json) return thenDo(null, null);
              try {
                thenDo(null, JSON.parse(json));
              } catch (e) {
                thenDo(e);
              }
            },
            "identity",
          );
        },
      },

      // ─── session integration ──────────────────────────────────────────────────────

      "session",
      {
        // The in-memory current user record. Null until login completes.
        // Shape: { did, handle, displayName, credentialId, rpId, document }
        _currentUser: null,

        // Establish the current identity after a successful WebAuthn authentication.
        //
        // Calls setCurrentUser then integrates with the existing lively.users stack:
        //   - lively.Config.set('UserName', handle) so $world.getUserName() works
        //   - Re-registers L2L session under the new handle
        //   - Signals 'identityChanged' on lively.identity.did for UI bindings
        //
        // params: {
        //   did:          String
        //   handle:       String
        //   displayName:  String
        //   credentialId: String
        //   rpId:         String
        //   document:     Object  — the full DID document
        // }
        //
        // Calls thenDo(null, params) when done.
        establishSession: function (params, thenDo) {
          var self = this;
          self._currentUser = params;

          // 1. Slot into the existing username system so L2L, Wiki, PartsBin
          //    all see the handle as the current user without any changes to them.
          lively.Config.set("UserName", params.handle);

          // 2. Re-register L2L session under the new handle (mirrors what
          //    $world.setUserName does in MorphAddons.js)
          if (
            typeof lively !== "undefined" &&
            lively.net &&
            lively.net.SessionTracker
          ) {
            lively.net.SessionTracker.whenOnline(function (err, sess) {
              if (!err && sess) sess.setUserName(params.handle);
            });
          }

          // 3. Persist meta for next startup
          self.saveMeta(
            {
              did: params.did,
              handle: params.handle,
              displayName: params.displayName,
              credentialId: params.credentialId,
              rpId: params.rpId,
            },
            function () {
              // 4. Signal for UI bindings (MenuBarEntry etc.)
              if (typeof lively !== "undefined" && lively.bindings) {
                lively.bindings.signal(
                  lively.identity.did,
                  "identityChanged",
                  params,
                );
              }
              thenDo && thenDo(null, params);
            },
          );
        },

        // Clear the current identity (logout).
        clearSession: function (thenDo) {
          this._currentUser = null;
          lively.Config.set("UserName", null);
          if (typeof lively !== "undefined" && lively.bindings) {
            lively.bindings.signal(
              lively.identity.did,
              "identityChanged",
              null,
            );
          }
          thenDo && thenDo(null);
        },

        // Return the current in-memory user record, or null if not logged in.
        currentUser: function () {
          return this._currentUser;
        },

        // True if a DID session is currently active.
        isLoggedIn: function () {
          return !!this._currentUser;
        },

        // Attempt to restore a session from persisted meta on page load.
        // Does NOT re-run WebAuthn — only restores the lightweight user record.
        // Full re-authentication still required to derive encryption keys.
        //
        // Calls thenDo(null, meta) if restored, thenDo(null, null) if not found.
        restoreSession: function (thenDo) {
          var self = this;
          self.loadMeta(function (err, meta) {
            if (err || !meta) return thenDo(null, null);
            self.loadDocument(function (err, doc) {
              if (err) return thenDo(err);
              var params = {
                did: meta.did,
                handle: meta.handle,
                displayName: meta.displayName,
                credentialId: meta.credentialId,
                rpId: meta.rpId,
                document: doc,
              };
              // Restore lively.Config.UserName without re-running L2L registration
              // (the L2L connection will register itself when it connects)
              lively.Config.set("UserName", meta.handle);
              self._currentUser = params;
              thenDo(null, params);
            });
          });
        },
      },

      // ─── full registration flow ───────────────────────────────────────────────────

      "flow",
      {
        // Complete registration flow: given a successful WebAuthn registration
        // result (from lively.identity.WebAuthn.register), build and sign the
        // genesis DID document and establish the session.
        //
        // registrationResult: the object returned by WebAuthn.register()
        // params: {
        //   handle:      String
        //   displayName: String
        //   deviceLabel: String
        //   privateKey:  CryptoKey  — from Crypto.importPrivateKeyJwk (stored
        //                             in memory only; never persisted)
        // }
        //
        // Calls thenDo(null, { did, document, meta }).
        completeRegistration: function (registrationResult, params, thenDo) {
          var self = this;
          var did = self.didFromJwk(registrationResult.publicKeyJwk);

          var document = self.buildDocument({
            did: did,
            publicKeyJwk: registrationResult.publicKeyJwk,
            credentialId: registrationResult.credentialId,
            deviceLabel: params.deviceLabel || "Device",
            handle: params.handle,
          });

          self.signDocument(
            document,
            params.privateKey,
            null,
            function (err, signedDoc) {
              if (err) return thenDo(err);

              self.saveDocument(signedDoc, function (saveErr) {
                if (saveErr) return thenDo(saveErr);

                self.establishSession(
                  {
                    did: did,
                    handle: params.handle,
                    displayName: params.displayName || params.handle,
                    credentialId: registrationResult.credentialId,
                    rpId: registrationResult.rpId,
                    document: signedDoc,
                  },
                  function (err) {
                    if (err) return thenDo(err);
                    thenDo(null, { did: did, document: signedDoc });
                  },
                );
              });
            },
          );
        },

        // Complete authentication flow: given a successful WebAuthn assertion,
        // load the persisted DID document, verify it, and establish the session.
        //
        // assertionResult: the object returned by WebAuthn.authenticate()
        // meta: the persisted { did, handle, displayName, credentialId, rpId }
        //
        // Calls thenDo(null, { did, document }).
        completeAuthentication: function (assertionResult, meta, thenDo) {
          var self = this;
          self.loadDocument(function (err, doc) {
            if (err) return thenDo(err);
            if (!doc) {
              return thenDo(
                new Error(
                  "completeAuthentication: no DID document found locally. " +
                    "Has this device completed registration?",
                ),
              );
            }

            self.verifyDocument(doc, function (err, valid) {
              if (err) return thenDo(err);
              if (!valid) {
                return thenDo(
                  new Error(
                    "completeAuthentication: DID document signature is invalid. " +
                      "The document may have been tampered with.",
                  ),
                );
              }

              self.establishSession(
                {
                  did: meta.did,
                  handle: meta.handle,
                  displayName: meta.displayName,
                  credentialId: assertionResult.credentialId,
                  rpId: meta.rpId,
                  document: doc,
                },
                function (err) {
                  if (err) return thenDo(err);
                  thenDo(null, { did: meta.did, document: doc });
                },
              );
            });
          });
        },
      },
    );

    // Singleton
    lively.identity.did = new lively.identity.DID();
  }); // end module('lively.identity.DID')
