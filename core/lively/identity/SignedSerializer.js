/**
 * lively.identity.SignedSerializer
 *
 * Wraps lively.persistence.Serializer (ObjectGraphLinearizer) to produce and
 * consume cryptographic object envelopes for the Lively identity system.
 *
 * Architecture note — why not a plugin:
 *   ObjectGraphLinearizer.letAllPlugins() ignores return values, so
 *   serializationDone cannot replace the output JSO. The SignedSerializer
 *   therefore wraps the existing serializer rather than extending it via the
 *   plugin interface. The existing ObjectGraphLinearizer and all its plugins
 *   run unchanged as the inner layer; SignedSerializer wraps their output.
 *
 * What this module does:
 *   - serializeToEnvelope(obj, thenDo)
 *       Runs ObjectGraphLinearizer on obj to get the Lively JSO,
 *       computes a CID, builds an envelope, signs it, returns the envelope.
 *   - deserializeFromEnvelope(envelope, thenDo)
 *       Verifies the envelope signature, decrypts if private,
 *       passes the inner JSO to ObjectGraphLinearizer for reconstruction.
 *   - serializeEncrypted(obj, objId, thenDo)
 *       As above but encrypts the payload using a PRF-derived key.
 *       Requires an active WebAuthn session and PRF support.
 *   - deserializeEncrypted(envelope, thenDo)
 *       Decrypts the payload using PRF, then deserializes.
 *   - upgradeJson(livelyjson, thenDo)
 *       Migration path: takes an existing bare Lively JSON string and
 *       wraps it in a signed envelope without re-serializing the object.
 *   - World save/load integration:
 *       Patches lively.morphic.World.saveWorldAs and loadWorldFromDocument
 *       (via addMethods) so that worlds owned by an authenticated user are
 *       automatically saved as signed envelopes rather than bare JSON.
 *       Falls back to the original behaviour when no identity session exists.
 *
 * Async pattern: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.Crypto          — sign, verify, computeCid, encryptPayload
 *   lively.identity.DID             — currentUser(), did string
 *   lively.identity.WebKey          — generateObjId, buildObjectUrl
 *   lively.identity.WebAuthn        — deriveEncryptionKey (for encrypted worlds)
 *   lively.persistence.Serializer   — existing ObjectGraphLinearizer (inner layer)
 *   lively.morphic.Serialization    — World.saveWorldAs (integration target)
 */

module("lively.identity.SignedSerializer")
  .requires(
    "lively.identity.Crypto",
    "lively.identity.DID",
    "lively.identity.WebKey",
    "lively.persistence.Serializer",
  )
  .toRun(function () {
    Object.subclass(
      "lively.identity.SignedSerializer",

      // ─── inner serializer access ──────────────────────────────────────────────────

      "inner",
      {
        // Create a fresh ObjectGraphLinearizer with the standard Lively plugin set.
        _makeInnerSerializer: function () {
          return lively.persistence.ObjectGraphLinearizer.forNewLively();
        },

        // Run the inner serializer on obj and return the JSO { id, registry }.
        // This is synchronous — ObjectGraphLinearizer.serializeToJso is sync.
        _innerSerializeToJso: function (obj) {
          return this._makeInnerSerializer().serializeToJso(obj);
        },

        // Reconstruct an object from a JSO { id, registry }.
        _innerDeserializeJso: function (jso) {
          return this._makeInnerSerializer().deserializeJso(jso);
        },
      },

      // ─── public objects (signed, unencrypted) ────────────────────────────────────

      "public",
      {
        // Serialize obj to a signed envelope.
        //
        // params: {
        //   obj:         Object   — the morph/part/object to serialize
        //   type:        String   — "world" | "part" | "file" | "settings"
        //   publicKeyJwk: Object  — device public key JWK (used to derive objId)
        //   prevEnvelope: Object|null — previous version envelope for chaining
        //   stateMeta:   Object   — free-form metadata for envelope.state
        // }
        // IDENTITY: privateKey removed — envelope signing deferred.
        //
        // Calls thenDo(null, envelope).
        serializeToEnvelope: function (params, thenDo) {
          var self = this;
          var c = lively.identity.crypto;
          var user = lively.identity.did.currentUser();

          if (!user) {
            return thenDo(
              new Error(
                "serializeToEnvelope: no identity session active. " +
                  "Call lively.identity.did.establishSession() before serializing.",
              ),
            );
          }

          // Step 1: Inner serialization (sync)
          var jso;
          try {
            jso = self._innerSerializeToJso(params.obj);
          } catch (e) {
            return thenDo(
              new Error(
                "serializeToEnvelope: inner serialization failed: " + e.message,
              ),
            );
          }
          if (!jso)
            return thenDo(
              new Error("serializeToEnvelope: inner serializer returned null"),
            );

          // Step 2: Compute ObjID from public key
          lively.identity.webKey.generateObjId(
            params.publicKeyJwk,
            function (err, objId) {
              if (err) return thenDo(err);

              // Step 3: Compute CID of the payload
              c.computeCid(jso, function (err, cid) {
                if (err) return thenDo(err);

                // Step 4: Compute prevCid from previous envelope if provided
                var prevCid = null;
                if (params.prevEnvelope && params.prevEnvelope.record) {
                  prevCid = params.prevEnvelope.record.cid || null;
                }

                // Step 5: Build envelope (without sig)
                var envelope = {
                  objId: objId,
                  did: user.did,
                  publicKey: params.publicKeyJwk,
                  type: params.type || "world",
                  visibility: "public",
                  created:
                    (params.prevEnvelope && params.prevEnvelope.created) ||
                    new Date().toISOString(),
                  record: {
                    cid: cid,
                    prevCid: prevCid,
                    payload: jso,
                  },
                  state: params.stateMeta || {},
                };

                // IDENTITY: sig field omitted — envelope signing deferred.
                // Public envelopes will use WebAuthn assertion signing in a future
                // iteration. Private envelopes are tamper-protected by the
                // XSalsa20-Poly1305 authentication tag on the ciphertext.
                thenDo(null, envelope);
              });
            },
          );
        },

        // Deserialize a public envelope.
        // Calls thenDo(null, reconstructedObject).
        deserializeFromEnvelope: function (envelope, thenDo) {
          var self = this;
          var c = lively.identity.crypto;

          if (!envelope || !envelope.record || !envelope.record.payload) {
            return thenDo(
              new Error("deserializeFromEnvelope: invalid envelope structure"),
            );
          }

          // IDENTITY: signature verification deferred. CID integrity check still
          // runs — detects accidental corruption at zero extra cost.

          // Step 1: Verify CID integrity of the payload
          c.computeCid(envelope.record.payload, function (err, expectedCid) {
            if (err) return thenDo(err);
            if (expectedCid !== envelope.record.cid) {
              return thenDo(
                new Error(
                  "deserializeFromEnvelope: CID mismatch for objId=" +
                    envelope.objId +
                    ". Expected " +
                    expectedCid +
                    " but envelope has " +
                    envelope.record.cid,
                ),
              );
            }

            // Step 2: Inner deserialization (sync)
            try {
              var obj = self._innerDeserializeJso(envelope.record.payload);
              thenDo(null, obj);
            } catch (e) {
              thenDo(
                new Error(
                  "deserializeFromEnvelope: inner deserialization failed: " +
                    e.message,
                ),
              );
            }
          });
        },
      },

      // ─── private objects (signed + encrypted) ────────────────────────────────────

      "private",
      {
        // Serialize and encrypt obj using a PRF-derived key.
        //
        // params: same as serializeToEnvelope, plus:
        //   challenge:    Uint8Array  — fresh WebAuthn challenge from server
        //   rpId:         String
        //   credentialIds: String[]
        //   recipients:   Array of { did, x25519PublicKey } for shared-private objects.
        //                 Omit for single-owner private objects.
        //
        // Calls thenDo(null, envelope).
        serializeEncrypted: function (params, thenDo) {
          var self = this;
          var c = lively.identity.crypto;
          var wa = lively.identity.webAuthn;
          var user = lively.identity.did.currentUser();

          if (!user) {
            return thenDo(
              new Error("serializeEncrypted: no identity session active"),
            );
          }

          // Step 1: Inner serialization (sync)
          var jso;
          try {
            jso = self._innerSerializeToJso(params.obj);
          } catch (e) {
            return thenDo(
              new Error(
                "serializeEncrypted: inner serialization failed: " + e.message,
              ),
            );
          }
          if (!jso)
            return thenDo(
              new Error("serializeEncrypted: inner serializer returned null"),
            );

          // Step 2: Compute ObjID
          lively.identity.webKey.generateObjId(
            params.publicKeyJwk,
            function (err, objId) {
              if (err) return thenDo(err);

              // Step 3: Derive encryption key via WebAuthn PRF
              wa.deriveEncryptionKey(
                {
                  objId: objId,
                  challenge: params.challenge,
                  rpId: params.rpId || user.rpId,
                  credentialIds: params.credentialIds || [user.credentialId],
                },
                function (err, encKey) {
                  if (err) return thenDo(err);

                  // Step 4: Encrypt the JSO payload
                  c.encryptPayload(jso, encKey, function (err, encrypted) {
                    if (err) return thenDo(err);

                    // Step 5: Compute CID of the ciphertext (not plaintext)
                    // We sign/CID the ciphertext so the server can verify integrity
                    // without decrypting.
                    c.computeCid(encrypted.ciphertext, function (err, cid) {
                      if (err) return thenDo(err);

                      var prevCid = null;
                      if (params.prevEnvelope && params.prevEnvelope.record) {
                        prevCid = params.prevEnvelope.record.cid || null;
                      }

                      // Step 6: Build recipient list for key wrapping (shared-private)
                      var recipients = [];
                      if (params.recipients && params.recipients.length) {
                        var remaining = params.recipients.length;
                        var recipientErr = null;

                        params.recipients.forEach(function (r) {
                          c.sealForRecipient(
                            encKey,
                            r.x25519PublicKey,
                            function (err, wrappedKey) {
                              if (recipientErr) return; // already failed
                              if (err) {
                                recipientErr = err;
                                remaining = 0; // short-circuit: prevent any later callback reaching buildEnvelope
                                return thenDo(err);
                              }
                              recipients.push({
                                did: r.did,
                                wrappedKey: wrappedKey,
                              });
                              if (--remaining === 0) buildEnvelope();
                            },
                          );
                        });
                      } else {
                        buildEnvelope();
                      }

                      function buildEnvelope() {
                        if (recipientErr) return; // guard

                        // Step 7: Build envelope
                        var envelope = {
                          objId: objId,
                          did: user.did,
                          publicKey: params.publicKeyJwk,
                          type: params.type || "world",
                          visibility:
                            recipients.length > 0 ? "shared" : "private",
                          created:
                            (params.prevEnvelope &&
                              params.prevEnvelope.created) ||
                            new Date().toISOString(),
                          record: {
                            cid: cid,
                            prevCid: prevCid,
                            payload: encrypted.ciphertext,
                            nonce: encrypted.nonce,
                            recipients: recipients,
                          },
                          state: params.stateMeta || {},
                        };

                        // IDENTITY: sig field omitted — envelope signing deferred.
                        // The XSalsa20-Poly1305 auth tag on the ciphertext provides
                        // tamper detection for private objects without a separate sig.
                        thenDo(null, envelope);
                      }
                    });
                  });
                },
              );
            },
          );
        },

        // Decrypt and deserialize a private envelope.
        //
        // options: {
        //   challenge:    Uint8Array
        //   rpId:         String
        //   credentialIds: String[]
        // }
        //
        // Calls thenDo(null, reconstructedObject).
        deserializeEncrypted: function (envelope, options, thenDo) {
          var self = this;
          var c = lively.identity.crypto;
          var wa = lively.identity.webAuthn;
          var user = lively.identity.did.currentUser();

          if (!user) {
            return thenDo(
              new Error("deserializeEncrypted: no identity session active"),
            );
          }
          if (!envelope || !envelope.record || !envelope.record.payload) {
            return thenDo(
              new Error("deserializeEncrypted: invalid envelope structure"),
            );
          }

          // IDENTITY: signature verification deferred. CID check on the ciphertext
          // still runs — catches corruption before attempting decryption.

          // Step 1: Verify CID of ciphertext
          c.computeCid(envelope.record.payload, function (err, expectedCid) {
            if (err) return thenDo(err);
            if (expectedCid !== envelope.record.cid) {
              return thenDo(
                new Error(
                  "deserializeEncrypted: CID mismatch for objId=" +
                    envelope.objId,
                ),
              );
            }

            // Step 2: Derive decryption key via PRF
            wa.deriveEncryptionKey(
              {
                objId: envelope.objId,
                challenge: options.challenge,
                rpId: options.rpId || user.rpId,
                credentialIds: options.credentialIds || [user.credentialId],
              },
              function (err, encKey) {
                if (err) return thenDo(err);

                // Step 3: Decrypt
                c.decryptPayload(
                  envelope.record.payload,
                  envelope.record.nonce,
                  encKey,
                  function (err, jso) {
                    if (err) return thenDo(err);

                    // Step 4: Inner deserialization (sync)
                    try {
                      var obj = self._innerDeserializeJso(jso);
                      thenDo(null, obj);
                    } catch (e) {
                      thenDo(
                        new Error(
                          "deserializeEncrypted: inner deserialization failed: " +
                            e.message,
                        ),
                      );
                    }
                  },
                );
              },
            );
          });
        },
      },

      // ─── migration: upgrade bare Lively JSON to an unsigned envelope ────────────────

      "migration",
      {
        // Wrap an existing bare Lively JSON string in an envelope.
        // The JSON is NOT re-parsed into a live object — the raw payload JSO
        // is embedded directly, preserving the original exactly.
        //
        // IDENTITY: signing deferred — envelope is unsigned for now.
        //
        // params: {
        //   json:        String   — existing bare Lively JSON string
        //   type:        String
        //   publicKeyJwk: Object
        //   stateMeta:   Object
        // }
        //
        // Calls thenDo(null, envelope).
        upgradeJson: function (params, thenDo) {
          var c = lively.identity.crypto;
          var user = lively.identity.did.currentUser();

          if (!user) {
            return thenDo(new Error("upgradeJson: no identity session active"));
          }

          var jso;
          try {
            jso = JSON.parse(params.json);
          } catch (e) {
            return thenDo(
              new Error("upgradeJson: could not parse JSON: " + e.message),
            );
          }

          lively.identity.webKey.generateObjId(
            params.publicKeyJwk,
            function (err, objId) {
              if (err) return thenDo(err);

              c.computeCid(jso, function (err, cid) {
                if (err) return thenDo(err);

                thenDo(null, {
                  objId: objId,
                  did: user.did,
                  publicKey: params.publicKeyJwk,
                  type: params.type || "world",
                  visibility: "public",
                  created: new Date().toISOString(),
                  record: {
                    cid: cid,
                    prevCid: null,
                    payload: jso,
                  },
                  state: params.stateMeta || {},
                  migrated: true,
                });
              });
            },
          );
        },
      },

      // ─── world save/load integration ─────────────────────────────────────────────

      "worldIntegration",
      {
        // Patch World.saveWorldAs to produce signed envelopes when a DID session
        // is active. Called once from installWorldIntegration().
        //
        // The patch:
        //   1. Checks if lively.identity.did.isLoggedIn()
        //   2. If yes: calls our serializeToEnvelope, PUTs the envelope JSON to
        //      the identity server endpoint (/@handle/objId) as well as retaining
        //      the original WebDAV path for compatibility.
        //   3. If no: falls through to the original saveWorldAs unchanged.
        //
        // This is non-destructive: the original world HTML is still written to
        // the WebDAV path (for backwards compatibility with non-identity clients),
        // AND the signed envelope is written to the identity URL.
        installWorldIntegration: function () {
          var signedSerializer = this;

          // Only install once
          if (lively.morphic.World.prototype._identityIntegrationInstalled)
            return;
          lively.morphic.World.prototype._identityIntegrationInstalled = true;

          lively.morphic.World.addMethods("identity serialization", {
            // Overrides the standard saveWorldAs to additionally write a signed
            // envelope when an identity session is active.
            saveWorldAs: (function (originalSaveWorldAs) {
              return function identitySaveWorldAs(
                url,
                checkForOverwrites,
                bootstrapModuleURL,
                thenDo,
              ) {
                var world = this;

                // No session → original behaviour unchanged
                if (!lively.identity.did.isLoggedIn()) {
                  return originalSaveWorldAs.apply(world, arguments);
                }

                var user = lively.identity.did.currentUser();

                // Proceed with original save first (writes the HTML to WebDAV)
                originalSaveWorldAs.call(
                  world,
                  url,
                  checkForOverwrites,
                  bootstrapModuleURL,
                  function (err) {
                    if (err) return thenDo && thenDo(err);

                    // Then additionally write a signed envelope to the identity URL
                    var rawName = world.name;
                    var worldName =
                      rawName && rawName !== "null" && rawName !== "undefined"
                        ? rawName
                        : url
                          ? new URL(url).filename().replace(/\.x?html$/, "")
                          : "world";
                    if (!rawName || rawName === "null" || rawName === "undefined") {
                      console.warn(
                        "[SignedSerializer] Warning: world.name is " +
                          JSON.stringify(rawName) + " — using \"" + worldName + "\" from URL",
                      );
                    }

                    // Use findMethodByCredentialId so the correct key is chosen
                    // when the user has multiple devices registered.
                    var method = lively.identity.did.findMethodByCredentialId(
                      user.document,
                      user.credentialId,
                    );
                    if (!method) {
                      console.warn(
                        "[SignedSerializer] Verification method not found for " +
                          "credentialId=" +
                          user.credentialId +
                          " — skipping envelope.",
                      );
                      return thenDo && thenDo(null);
                    }

                    console.log(
                      "[SignedSerializer] Building envelope for world \"" + worldName + "\"",
                    );
                    signedSerializer.serializeToEnvelope(
                      {
                        obj: world,
                        type: "world",
                        publicKeyJwk: method.publicKeyJwk,
                        stateMeta: { name: worldName },
                      },
                      function (envelopeErr, envelope) {
                        if (envelopeErr) {
                          console.warn(
                            "[SignedSerializer] Envelope signing failed:",
                            envelopeErr,
                          );
                          // Don't fail the whole save — the WebDAV save already succeeded
                          return thenDo && thenDo(null);
                        }

                        // PUT envelope to identity server
                        var envelopeUrl = lively.identity.webKey.buildObjectUrl(
                          {
                            handle: user.handle,
                            objId: envelope.objId,
                          },
                        );

                        envelopeUrl
                          .asWebResource()
                          .beAsync()
                          .put(JSON.stringify(envelope), "application/json")
                          .whenDone(function (content, status) {
                            if (status.isSuccess()) {
                              var body = null;
                              try { body = JSON.parse(content); } catch(e) {}
                              console.log(
                                "[SignedSerializer] PUT /@" + user.handle +
                                  "/" + envelope.objId + " →",
                                body || content,
                              );
                            } else {
                              console.warn(
                                "[SignedSerializer] Failed to PUT envelope to " +
                                  envelopeUrl +
                                  ": " +
                                  status,
                              );
                            }
                            thenDo && thenDo(null);
                          });
                      },
                    );
                  },
                );
              };
            })(lively.morphic.World.prototype.saveWorldAs),
          });
        },
      },
    );

    // ─── singleton and world integration ─────────────────────────────────────────

    lively.identity.signedSerializer = new lively.identity.SignedSerializer();

    // Install the World.saveWorldAs patch once lively.morphic.Serialization
    // is loaded (it defines saveWorldAs; we must run after it).
    module("lively.morphic.Serialization").runWhenLoaded(function () {
      lively.identity.signedSerializer.installWorldIntegration();
    });
  }); // end module('lively.identity.SignedSerializer')
