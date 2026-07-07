/**
 * lively.identity.DID
 *
 * did:jwk identity management for the Lively identity system.
 *
 * Responsibilities:
 *   - Create a did:jwk DID string from a JWK public key
 *   - Build, parse, and validate DID documents
 *   - Add and revoke verification methods (per-device keys)
 *   - IDENTITY: DID document signing deferred — will use WebAuthn assertion
 *     signing in a future iteration once login/encryption works end-to-end
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
        //   did:                   String   — the did:jwk string (from didFromJwk)
        //   publicKeyJwk:          Object   — the device's EC P-256 public key JWK
        //   credentialId:          String   — base64url WebAuthn credential ID
        //   deviceLabel:           String   — human-readable label, e.g. "MacBook Pro 2024"
        //   handle:                String   — the user's chosen handle
        //   // Optional delegation cert fields (§3.6):
        //   delegationCert:        Object   — cert from DID.buildDelegationCert
        //   softSigningKeyWrapped: String   — base64url KEK-wrapped soft signing key JWK
        //   accountX25519Pub:      String   — base64url X25519 account public key
        // }
        //
        // The first verification method becomes both the authentication and
        // assertionMethod entry. Additional devices are added via addVerificationMethod.
        buildDocument: function (params) {
          var methodId =
            params.did + "#" + this._methodFragment(params.credentialId);
          var livelyMeta = {
            credentialId: params.credentialId,
            deviceLabel: params.deviceLabel || "Device",
            addedAt: new Date().toISOString(),
          };
          if (params.delegationCert)        livelyMeta.delegationCert        = params.delegationCert;
          if (params.softSigningKeyWrapped)  livelyMeta.softSigningKeyWrapped  = params.softSigningKeyWrapped;
          if (params.accountX25519Pub)       livelyMeta.accountX25519Pub       = params.accountX25519Pub;
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
                lively: livelyMeta,
              },
            ],
            authentication: [methodId],
            assertionMethod: [methodId],
            // version chain — see updateDocument()
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            prevHash: null, // null for genesis document
            // sig: omitted — DID document signing is deferred (see completeRegistration)
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

      // ─── persistence ──────────────────────────────────────────────────────────────

      "persistence",
      {
        // Persist the current user's DID document to IndexedDB.
        saveDocument: function (document, thenDo) {
          lively.IndexedDB.set(
            "identity-did-document",
            JSON.stringify(document),
            function (err) {
              if (!err) console.log("[DID] saveDocument: DID document saved to IndexedDB");
              (thenDo || function () {})(err);
            },
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
              console.log("[DID] Session established:", { did: params.did, handle: params.handle });
              if (typeof lively !== "undefined" && lively.bindings) {
                lively.bindings.signal(
                  lively.identity.did,
                  "identityChanged",
                  params,
                );
                console.log("[Identity] identityChanged signal fired");
              }
              thenDo && thenDo(null, params);
            },
          );
        },

        // Clear the current identity (logout).
        // Clears in-memory state AND the persisted IndexedDB meta so that
        // restoreSession() does not revive the session on the next page load.
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
          // Use saveMeta so the write goes to the correct "identity" store.
          // Storing null causes loadMeta → JSON.parse("null") = null → !meta
          // is true → restoreSession returns null on the next page load.
          this.saveMeta(null, function () {
            thenDo && thenDo(null);
          });
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
        // result (from lively.identity.WebAuthn.register), build the genesis
        // DID document and establish the session.
        //
        // registrationResult: the object returned by WebAuthn.register()
        // params: {
        //   handle:                String
        //   displayName:           String
        //   deviceLabel:           String
        //   // Optional — populated when delegation cert ceremony succeeded:
        //   delegationCert:        Object
        //   softSigningKeyWrapped: String
        //   accountX25519Pub:      String
        // }
        //
        // Calls thenDo(null, { did, document }).
        completeRegistration: function (registrationResult, params, thenDo) {
          var self = this;
          var did = self.didFromJwk(registrationResult.publicKeyJwk);

          var document = self.buildDocument({
            did: did,
            publicKeyJwk: registrationResult.publicKeyJwk,
            credentialId: registrationResult.credentialId,
            deviceLabel: params.deviceLabel || "Device",
            handle: params.handle,
            delegationCert:        params.delegationCert        || null,
            softSigningKeyWrapped:  params.softSigningKeyWrapped  || null,
            accountX25519Pub:       params.accountX25519Pub       || null,
          });

          self.saveDocument(document, function (saveErr) {
            if (saveErr) return thenDo(saveErr);

            self.establishSession(
              {
                did: did,
                handle: params.handle,
                displayName: params.displayName || params.handle,
                credentialId: registrationResult.credentialId,
                rpId: registrationResult.rpId,
                document: document,
              },
              function (err) {
                if (err) return thenDo(err);
                thenDo(null, { did: did, document: document });
              },
            );
          });
        },

        // Build a delegation certificate that lets a software device signing key
        // sign envelopes on behalf of the user without per-save WebAuthn ceremonies.
        //
        // The passkey signs over H(delegationPayload) as the WebAuthn challenge.
        // Verifiers follow the chain: envelope sig → devicePubKeyJwk → cert sig → passkey → did:jwk.
        //
        // options: {
        //   credentialId:  String      — base64url WebAuthn credential ID
        //   rpId:          String
        //   softKeyPair:   CryptoKeyPair — from Crypto.generateSigningKeyPair
        //   challenge:     Uint8Array  — fresh WebAuthn challenge from server
        //                               (used only to satisfy the ceremony; the actual
        //                               delegation challenge overrides it below)
        // }
        //
        // Calls thenDo(null, { devicePubKeyJwk, credentialId, issuedAt, authenticatorData, clientDataJSON, signature }).
        buildDelegationCert: function (options, thenDo) {
          var self = this;
          var c = lively.identity.crypto;
          var wa = lively.identity.webAuthn;

          c.exportPublicKeyJwk(options.softKeyPair.publicKey, function (err, devicePubKeyJwk) {
            if (err) return thenDo(err);

            var issuedAt = new Date().toISOString();
            var delegationPayload = {
              devicePubKeyJwk: devicePubKeyJwk,
              credentialId: options.credentialId,
              issuedAt: issuedAt
            };

            // challenge = SHA-256(canonicalJson(delegationPayload))
            c.sha256(c.canonicalJson(delegationPayload), function (err, digestB64) {
              if (err) return thenDo(err);
              var delegationChallenge = c.base64urlDecode(digestB64);

              wa.authenticate({
                challenge: delegationChallenge,
                rpId: options.rpId,
                credentialIds: [options.credentialId]
              }, function (err, assertion) {
                if (err) return thenDo(err);
                thenDo(null, {
                  devicePubKeyJwk: devicePubKeyJwk,
                  credentialId: options.credentialId,
                  issuedAt: issuedAt,
                  authenticatorData: assertion.authenticatorData,
                  clientDataJSON: assertion.clientDataJSON,
                  signature: assertion.signature
                });
              });
            });
          });
        },

        // Verify a delegation certificate.
        // Confirms: (1) clientDataJSON.challenge === H(delegationPayload),
        //           (2) the WebAuthn assertion signature is valid for the passkey in `did`.
        //
        // cert: delegation cert object from buildDelegationCert
        // did:  the did:jwk string of the passkey that should have signed this cert
        //
        // Calls thenDo(null, true|false).
        verifyDelegationCert: function (cert, did, thenDo) {
          var c = lively.identity.crypto;

          // Reconstruct the delegation payload to verify the challenge
          var delegationPayload = {
            devicePubKeyJwk: cert.devicePubKeyJwk,
            credentialId: cert.credentialId,
            issuedAt: cert.issuedAt
          };

          c.sha256(c.canonicalJson(delegationPayload), function (err, expectedDigestB64) {
            if (err) return thenDo(err);

            // Parse clientDataJSON (base64url encoded)
            var clientDataBytes = c.base64urlDecode(cert.clientDataJSON);
            var clientData;
            try {
              clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
            } catch (e) {
              return thenDo(null, false);
            }

            // clientData.challenge is base64url in the WebAuthn spec
            if (clientData.challenge !== expectedDigestB64) return thenDo(null, false);

            // Verify the assertion signature: signed over authenticatorData + SHA256(clientDataJSON)
            // This mirrors what @simplewebauthn/server does on the server side.
            // We use the passkey public key extracted from the did:jwk.
            this.jwkFromDid(did, function (err, passkeyJwk) {
              if (err) return thenDo(null, false);

              var authDataBytes = c.base64urlDecode(cert.authenticatorData);
              var clientDataBytesForSig = c.base64urlDecode(cert.clientDataJSON);

              // signingInput = authenticatorData || SHA-256(clientDataJSON)
              c.sha256(clientDataBytesForSig, function (err, clientDataHashB64) {
                if (err) return thenDo(null, false);
                var clientDataHash = c.base64urlDecode(clientDataHashB64);
                var signingInput = new Uint8Array(authDataBytes.length + clientDataHash.length);
                signingInput.set(authDataBytes);
                signingInput.set(clientDataHash, authDataBytes.length);

                c.importPublicKeyJwk(passkeyJwk, function (err, pubKey) {
                  if (err) return thenDo(null, false);
                  var sigBytes = c.base64urlDecode(cert.signature);
                  crypto.subtle.verify(
                    { name: 'ECDSA', hash: { name: 'SHA-256' } },
                    pubKey,
                    sigBytes,
                    signingInput
                  ).then(function (valid) { thenDo(null, valid); })
                  .catch(function () { thenDo(null, false); });
                });
              });
            }.bind(this));
          }.bind(this));
        },

        // Complete authentication flow: given a successful WebAuthn assertion,
        // load the persisted DID document and establish the session.
        //
        // IDENTITY: DID document signature verification deferred — matches the
        // deferral of signDocument in completeRegistration above.
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
            console.log("[DID] completeAuthentication: document loaded, establishing session");

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
        },
      },
    );

    // Singleton
    lively.identity.did = new lively.identity.DID();

    // Restore any persisted session on page load so the menubar and other
    // consumers reflect the signed-in user without requiring an explicit login.
    lively.identity.did.restoreSession(function (err, user) {
      if (user) lively.bindings.signal(lively.identity.did, "identityChanged", user);
    });

    // Cross-tab sign-out: when the user signs out in one tab, clear the
    // in-memory session in every other same-origin tab and redirect to welcome.
    if (typeof BroadcastChannel !== "undefined") {
      var _identityChannel = new BroadcastChannel("lively-identity");
      _identityChannel.onmessage = function (evt) {
        if (!evt.data || evt.data.type !== "signed-out") return;
        lively.identity.did.clearSession(function () {
          if (typeof lively !== "undefined" && lively.Config) lively.Config.askBeforeQuit = false;
          window.location.href = "/welcome.html";
        });
      };
      lively.identity.did._identityChannel = _identityChannel;
    }
  }); // end module('lively.identity.DID')
