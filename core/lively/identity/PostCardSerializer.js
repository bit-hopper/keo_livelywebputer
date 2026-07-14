/**
 * lively.identity.PostCardSerializer
 *
 * Serializes and deserializes post card envelopes for the Lively identity system.
 * Parallel to lively.identity.SignedSerializer, but for Yjs-based documents
 * rather than ObjectGraphLinearizer-based worlds/parts.
 *
 * Envelope payload shape (§3.2):
 *   record.payload = {
 *     format:   "yjs-update-v1",
 *     update:   "<base64url(Y.encodeStateAsUpdate(doc))>",
 *     snapshot: <ProseMirror JSON from y-prosemirror>
 *   }
 *
 * CRITICAL: All post card Y.Docs MUST be created with gc: false (§9.3).
 *           This cannot be retrofitted. The serializer enforces this by
 *           checking doc.gc when a yDoc is passed in.
 *
 * Key architecture (§3.6):
 *   - objIds are genesis-derived: H(authorDid + ":" + genesisNonce)[0..12]
 *     via lively.identity.webKey.generateGenesisObjId
 *   - Encryption uses KEK/DEK (§3.6 Plane 3): Crypto.wrapDek / encryptPayload
 *     rather than per-object PRF calls
 *
 * Yjs dependency:
 *   Yjs must be loaded as a plain script (/lib/yjs/yjs.js or CDN) before
 *   calling serializeToEnvelope. The global Y (or window.Y) must expose
 *   Y.encodeStateAsUpdate and Y.Doc. y-prosemirror must also be loaded for
 *   snapshot extraction. This module does NOT require() Yjs — same pattern
 *   as Crypto.js's libsodium dependency.
 *
 * Async pattern: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.Crypto     — computeCid, encryptPayload, wrapDek, signJws
 *   lively.identity.DID        — currentUser(), findMethodByCredentialId
 *   lively.identity.WebKey     — generateGenesisObjId, buildObjectUrl
 *   lively.identity.WebAuthn   — _kekCache (for envelope signing)
 */

module('lively.identity.PostCardSerializer')
  .requires(
    'lively.identity.Crypto',
    'lively.identity.DID',
    'lively.identity.WebKey',
    'lively.identity.WebAuthn',
  )
  .toRun(function () {

    Object.subclass('lively.identity.PostCardSerializer',

    // ─── Yjs access ──────────────────────────────────────────────────────────────

    'yjs', {

      // Returns the global Y (Yjs) object, or null if not loaded.
      _Y: function () {
        return (typeof Y !== 'undefined' && Y) ||
               (typeof window !== 'undefined' && window.Y) ||
               null;
      },

      // Returns the global yProsemirror object, or null.
      _yProsemirror: function () {
        return (typeof yProsemirror !== 'undefined' && yProsemirror) ||
               (typeof window !== 'undefined' && window.yProsemirror) ||
               null;
      },

      // Checks that yDoc.gc is false. Logs a hard warning if not — this cannot
      // be fixed at runtime; the doc must be recreated.
      _checkGcDisabled: function (yDoc) {
        if (yDoc && yDoc.gc !== false) {
          console.error(
            '[PostCardSerializer] CRITICAL: Y.Doc has gc: true. ' +
            'Post card docs must be created with gc: false or history playback ' +
            '(§9) will be permanently unavailable for this document. ' +
            'Recreate the doc with new Y.Doc({ gc: false }).'
          );
        }
      },

    },

    // ─── public objects (signed, unencrypted) ────────────────────────────────────

    'public', {

      // Serialize a Yjs document to a signed postcard envelope.
      //
      // params: {
      //   yDoc:        Y.Doc     — MUST have been created with gc: false
      //   title:       String    — optional; auto-extracted from first block if absent
      //   titleExplicit: Boolean — if true, title was user-set (§10.5)
      //   constellation: String  — optional; constellation name for indexing (§2.2)
      //   replyTo:     Object    — optional; { objId, anchor } for inline replies (§10.3)
      //   visibility:  String    — 'public' | 'private' | 'shared' (default 'public')
      //   prevEnvelope: Object   — previous version envelope for version chaining
      //   stateMeta:   Object    — extra state fields to merge into envelope.state
      // }
      //
      // Calls thenDo(null, envelope).
      serializeToEnvelope: function (params, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();

        if (!user) {
          return thenDo(new Error(
            'PostCardSerializer.serializeToEnvelope: no identity session active. ' +
            'Call lively.identity.did.establishSession() before serializing.'
          ));
        }

        var Y = self._Y();
        if (!Y) {
          return thenDo(new Error(
            'PostCardSerializer.serializeToEnvelope: Yjs not loaded. ' +
            'Include /lib/yjs/yjs.js before calling this method.'
          ));
        }

        var yDoc = params.yDoc;
        if (!yDoc) return thenDo(new Error('PostCardSerializer: yDoc is required'));
        self._checkGcDisabled(yDoc);

        // Step 1: Extract Yjs update bytes and encode as base64url
        var updateBytes;
        try {
          updateBytes = Y.encodeStateAsUpdate(yDoc);
        } catch (e) {
          return thenDo(new Error('PostCardSerializer: Y.encodeStateAsUpdate failed: ' + e.message));
        }
        var updateB64 = c.base64urlEncode(updateBytes);

        // Step 2: Extract ProseMirror snapshot for fast read-only rendering
        var snapshot = self._extractSnapshot(yDoc);

        // Step 3: Extract title from first block unless explicitly set
        var title = params.title;
        if (!title && snapshot && snapshot.content && snapshot.content.length) {
          title = self._extractFirstBlockText(snapshot.content[0]);
        }

        var payload = {
          format: 'yjs-update-v1',
          update: updateB64,
          snapshot: snapshot
        };

        // Step 4: Compute CID over the canonical JSON payload (§3.5)
        c.computeCid(payload, function (err, cid) {
          if (err) return thenDo(err);

          // Step 5: Determine objId — reuse on update, generate new on genesis
          var prevEnvelope = params.prevEnvelope || null;
          var prevCid = prevEnvelope && prevEnvelope.record ? (prevEnvelope.record.cid || null) : null;

          if (prevEnvelope && prevEnvelope.objId) {
            _buildEnvelope(prevEnvelope.objId, null);
          } else {
            lively.identity.webKey.generateGenesisObjId(user.did, function (err, result) {
              if (err) return thenDo(err);
              _buildEnvelope(result.objId, result.genesisNonce);
            });
          }

          function _buildEnvelope(objId, genesisNonce) {
            var state = Object.assign({}, params.stateMeta || {}, { title: title || '' });
            if (params.titleExplicit) state.titleExplicit = true;

            var envelope = {
              objId:  objId,
              did:    user.did,
              type:   'postcard',
              visibility: params.visibility || 'public',
              created: (prevEnvelope && prevEnvelope.created) || new Date().toISOString(),
              record: { cid: cid, prevCid: prevCid, payload: payload },
              state:  state,
            };
            if (genesisNonce) envelope.genesisNonce = genesisNonce;
            if (params.constellation) envelope.constellation = params.constellation;
            if (params.replyTo)       envelope.replyTo       = params.replyTo;

            // Step 6: Sign with device soft key if delegation cert + KEK available
            _signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
              if (signErr) console.warn('[PostCardSerializer] Could not sign envelope (non-fatal):', signErr.message);
              thenDo(null, signed || envelope);
            });
          }
        });
      },

      // Deserialize a postcard envelope back into a Y.Doc.
      // Creates a new Y.Doc (with gc: false) and applies the stored Yjs update.
      //
      // Returns thenDo(null, Y.Doc).
      deserializeFromEnvelope: function (envelope, thenDo) {
        var self = this;
        var c = lively.identity.crypto;

        if (!envelope || !envelope.record || !envelope.record.payload) {
          return thenDo(new Error('deserializeFromEnvelope: invalid envelope structure'));
        }

        var payload = envelope.record.payload;
        if (payload.format !== 'yjs-update-v1') {
          return thenDo(new Error(
            'deserializeFromEnvelope: unsupported payload format "' + payload.format + '"'
          ));
        }

        // CID integrity check
        c.computeCid(payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          if (expectedCid !== envelope.record.cid) {
            return thenDo(new Error(
              'deserializeFromEnvelope: CID mismatch for objId=' + envelope.objId +
              '. Expected ' + expectedCid + ' but envelope has ' + envelope.record.cid
            ));
          }

          var Y = self._Y();
          if (!Y) {
            return thenDo(new Error('deserializeFromEnvelope: Yjs not loaded'));
          }

          var doc = new Y.Doc({ gc: false });
          try {
            var updateBytes = c.base64urlDecode(payload.update);
            Y.applyUpdate(doc, updateBytes);
            thenDo(null, doc);
          } catch (e) {
            thenDo(new Error('deserializeFromEnvelope: failed to apply Yjs update: ' + e.message));
          }
        });
      },

    },

    // ─── encrypted post cards (§3.6 KEK/DEK plan) ────────────────────────────────

    'private', {

      // Serialize and encrypt a postcard for owner-only or shared access.
      //
      // params: same as serializeToEnvelope, plus:
      //   recipients: Array of { did, x25519PublicKey } for shared visibility
      //               (each recipient's account X25519 public key, base64url)
      //
      // Requires the KEK to be cached in WebAuthn._kekCache[credentialId].
      // If not cached, fails with an actionable error — call WebAuthn.deriveKek first.
      //
      // Calls thenDo(null, envelope).
      serializeEncrypted: function (params, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();

        if (!user) return thenDo(new Error('serializeEncrypted: no identity session'));

        if (!wa || !wa._kekCache || !wa._kekCache[user.credentialId]) {
          return thenDo(new Error(
            'serializeEncrypted: KEK not cached for this session. ' +
            'Call WebAuthn.deriveKek first (prompts once per session).'
          ));
        }
        var kek = wa._kekCache[user.credentialId];

        var Y = self._Y();
        if (!Y) return thenDo(new Error('serializeEncrypted: Yjs not loaded'));

        var yDoc = params.yDoc;
        if (!yDoc) return thenDo(new Error('serializeEncrypted: yDoc is required'));
        self._checkGcDisabled(yDoc);

        // Extract and encode the Yjs update
        var updateBytes;
        try { updateBytes = Y.encodeStateAsUpdate(yDoc); }
        catch (e) { return thenDo(new Error('serializeEncrypted: encodeStateAsUpdate failed: ' + e.message)); }

        var snapshot = self._extractSnapshot(yDoc);
        var title = params.title;
        if (!title && snapshot && snapshot.content && snapshot.content.length) {
          title = self._extractFirstBlockText(snapshot.content[0]);
        }

        var payload = {
          format: 'yjs-update-v1',
          update: c.base64urlEncode(updateBytes),
          snapshot: snapshot
        };

        // Generate a fresh DEK, wrap it with the KEK
        c.wrapDek(kek, function (err, dekResult) {
          if (err) return thenDo(err);
          var dek = dekResult.dek;

          // Encrypt the payload JSON with the DEK
          c.encryptPayload(payload, dek, function (err, encrypted) {
            if (err) return thenDo(err);

            c.computeCid(encrypted.ciphertext, function (err, cid) {
              if (err) return thenDo(err);

              // Build recipient key wraps for shared visibility
              var prevEnvelope = params.prevEnvelope || null;
              var prevCid = prevEnvelope && prevEnvelope.record ? (prevEnvelope.record.cid || null) : null;

              function _buildEncryptedEnvelope(objId, genesisNonce, recipientWraps) {
                var state = Object.assign({}, params.stateMeta || {}, { title: title || '' });
                var visibility = (params.recipients && params.recipients.length) ? 'shared' : 'private';

                var envelope = {
                  objId: objId,
                  did: user.did,
                  type: 'postcard',
                  visibility: visibility,
                  created: (prevEnvelope && prevEnvelope.created) || new Date().toISOString(),
                  record: {
                    cid: cid,
                    prevCid: prevCid,
                    payload: encrypted.ciphertext,
                    nonce: encrypted.nonce,
                    wrappedDek: dekResult.wrappedDek,
                    recipients: recipientWraps,
                  },
                  state: state,
                };
                if (genesisNonce) envelope.genesisNonce = genesisNonce;
                if (params.constellation) envelope.constellation = params.constellation;
                if (params.replyTo) envelope.replyTo = params.replyTo;

                _signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
                  if (signErr) console.warn('[PostCardSerializer] Could not sign encrypted envelope (non-fatal):', signErr.message);
                  thenDo(null, signed || envelope);
                });
              }

              function _withObjId(callback) {
                if (prevEnvelope && prevEnvelope.objId) return callback(prevEnvelope.objId, null);
                lively.identity.webKey.generateGenesisObjId(user.did, function (err, r) {
                  if (err) return thenDo(err);
                  callback(r.objId, r.genesisNonce);
                });
              }

              _withObjId(function (objId, genesisNonce) {
                if (!params.recipients || !params.recipients.length) {
                  return _buildEncryptedEnvelope(objId, genesisNonce, []);
                }
                // Seal the DEK for each recipient's account X25519 public key
                var recipientWraps = [];
                var remaining = params.recipients.length;
                var hadError = false;
                params.recipients.forEach(function (r) {
                  c.sealForRecipient(dek, r.x25519PublicKey, function (err, sealed) {
                    if (hadError) return;
                    if (err) { hadError = true; return thenDo(err); }
                    recipientWraps.push({ did: r.did, sealedDek: sealed });
                    if (--remaining === 0) _buildEncryptedEnvelope(objId, genesisNonce, recipientWraps);
                  });
                });
              });
            });
          });
        });
      },

      // Decrypt and deserialize a private/shared postcard envelope.
      // Returns thenDo(null, Y.Doc).
      deserializeEncrypted: function (envelope, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();

        if (!user) return thenDo(new Error('deserializeEncrypted: no identity session'));

        if (!envelope || !envelope.record || !envelope.record.payload) {
          return thenDo(new Error('deserializeEncrypted: invalid envelope structure'));
        }

        // CID check on ciphertext
        c.computeCid(envelope.record.payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          if (expectedCid !== envelope.record.cid) {
            return thenDo(new Error('deserializeEncrypted: CID mismatch for objId=' + envelope.objId));
          }

          // Unwrap the DEK: owner uses KEK, recipients use sealedDek
          function _unwrapDek(callback) {
            var isOwner = user.did === envelope.did;
            if (isOwner) {
              if (!wa || !wa._kekCache || !wa._kekCache[user.credentialId]) {
                return callback(new Error('deserializeEncrypted: KEK not cached. Call deriveKek first.'));
              }
              var kek = wa._kekCache[user.credentialId];
              c.unwrapDek(envelope.record.wrappedDek, kek, callback);
            } else {
              // Recipient: find their sealed DEK entry and open it
              var myEntry = (envelope.record.recipients || []).find(function (r) {
                return r.did === user.did;
              });
              if (!myEntry) return callback(new Error('deserializeEncrypted: no sealed DEK for current user'));
              // Recipient's account X25519 keypair — deterministically re-derived
              // from PRF (same credentialId + salt as at registration) and cached
              // by WebAuthn.deriveX25519KeyPair, same pattern as the owner's KEK.
              var ch = new Uint8Array(32);
              crypto.getRandomValues(ch);
              wa.deriveX25519KeyPair({ credentialId: user.credentialId, challenge: ch }, function (err, pair) {
                if (err) return callback(err);
                c.openSealedBox(myEntry.sealedDek, pair.publicKey, pair.privateKey, callback);
              });
            }
          }

          _unwrapDek(function (err, dek) {
            if (err) return thenDo(err);

            c.decryptPayload(envelope.record.payload, envelope.record.nonce, dek, function (err, payload) {
              if (err) return thenDo(err);

              var Y = self._Y();
              if (!Y) return thenDo(new Error('deserializeEncrypted: Yjs not loaded'));

              var doc = new Y.Doc({ gc: false });
              try {
                var updateBytes = c.base64urlDecode(payload.update);
                Y.applyUpdate(doc, updateBytes);
                thenDo(null, doc);
              } catch (e) {
                thenDo(new Error('deserializeEncrypted: Yjs apply failed: ' + e.message));
              }
            });
          });
        });
      },

    },

    // ─── helpers ─────────────────────────────────────────────────────────────────

    'helpers', {

      // Extract a ProseMirror document JSON from a Y.Doc using y-prosemirror.
      // Returns null if y-prosemirror is not loaded.
      _extractSnapshot: function (yDoc) {
        var yPM = this._yProsemirror();
        if (!yPM || !yPM.yDocToProsemirrorJSON) return null;
        try {
          return yPM.yDocToProsemirrorJSON(yDoc, 'prosemirror');
        } catch (e) {
          console.warn('[PostCardSerializer] Could not extract PM snapshot:', e.message);
          return null;
        }
      },

      // Extract the plain-text content of the first block node (§10.5).
      _extractFirstBlockText: function (node) {
        if (!node || !node.content) return '';
        return node.content.map(function (child) {
          if (child.text) return child.text;
          if (child.content) return child.content.map(function(c) { return c.text || ''; }).join('');
          return '';
        }).join('').trim().slice(0, 200);
      },

    });

    // ─── shared signing helper (mirrors SignedSerializer._signEnvelopeIfPossible) ──

    function _signEnvelopeIfPossible(envelope, user, c, thenDo) {
      var method = lively.identity.did.findMethodByCredentialId(user.document, user.credentialId);
      if (!method || !method.lively) return thenDo(null, envelope);
      var livelyMeta = method.lively;
      if (!livelyMeta.softSigningKeyWrapped || !livelyMeta.delegationCert) return thenDo(null, envelope);
      var wa = lively.identity.webAuthn;
      if (!wa || !wa._kekCache || !wa._kekCache[user.credentialId]) return thenDo(null, envelope);
      var kek = wa._kekCache[user.credentialId];
      var wrapped;
      try { wrapped = JSON.parse(livelyMeta.softSigningKeyWrapped); } catch (e) { return thenDo(e); }
      c.decryptPayload(wrapped.ciphertext, wrapped.nonce, kek, function (err, softPrivJwk) {
        if (err) return thenDo(err);
        c.importPrivateKeyJwk(softPrivJwk, function (err, softPrivKey) {
          if (err) return thenDo(err);
          var envelopeToSign = Object.assign({}, envelope);
          delete envelopeToSign.sig;
          c.signJws(envelopeToSign, softPrivKey, function (err, sig) {
            if (err) return thenDo(err);
            thenDo(null, Object.assign({}, envelope, { sig: sig }));
          });
        });
      });
    }

    // Singleton
    lively.identity.postCardSerializer = new lively.identity.PostCardSerializer();

  }); // end module('lively.identity.PostCardSerializer')
