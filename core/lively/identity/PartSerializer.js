/**
 * lively.identity.PartSerializer
 *
 * Builds and reads identity-aware PartsBin envelopes (type: 'part').
 * Parallel to lively.identity.PostCardSerializer's plain (non-Yjs) pair,
 * but for a part's already-serialized Lively JSON instead of a ProseMirror
 * doc — the caller (lively.PartsBin's copyToIdentityPartsSpace) still owns
 * calling morph.getPartItem().serializePart(morph) to get that JSON; this
 * module only turns the result into a signed (and optionally encrypted)
 * envelope, and reverses that on load.
 *
 * Envelope payload shape:
 *   Public   — record.payload = <the part's Lively JSON, exactly as
 *              serializePart() produced it — this is the pre-existing
 *              shape lively.identity.IdentityPartItem.loadPart already
 *              expects, unchanged, so already-published public parts keep
 *              loading with no migration>.
 *   Private/
 *   shared   — record.payload = encryptPayload(json, dek).ciphertext,
 *              record.nonce/wrappedDek/recipients alongside it — same
 *              KEK/DEK/seal machinery as PostCardSerializer.serializePlainEncrypted.
 *
 * envelope.state (partName, comment, tags, htmlLogo) is always plaintext
 * regardless of visibility, same reasoning as FileCrypto's file envelopes:
 * it's what the *myparts* / tag-category listings render without needing a
 * decrypt round trip per item, and none of it is the actual part content.
 *
 * Async pattern: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.Crypto     — computeCid, encryptPayload, decryptPayload,
 *                                wrapDek, unwrapDek, sealForRecipient,
 *                                openSealedBox, signJws
 *   lively.identity.DID        — currentUser(), findMethodByCredentialId
 *   lively.identity.WebKey     — generateGenesisObjId
 *   lively.identity.WebAuthn   — _kekCache, deriveKek, deriveX25519KeyPair
 */

module('lively.identity.PartSerializer')
  .requires(
    'lively.identity.Crypto',
    'lively.identity.DID',
    'lively.identity.WebKey',
    'lively.identity.WebAuthn',
  )
  .toRun(function () {

    Object.subclass('lively.identity.PartSerializer',

    // ─── public parts (signed, unencrypted) ───────────────────────────────────

    'public', {

      // params: {
      //   json:        String  — serializePart(morph).json (required)
      //   partName:    String
      //   comment:     String  — optional
      //   tags:        Array   — optional
      //   htmlLogo:    String  — optional, from serializePart(morph).htmlLogo
      //   prevEnvelope: Object — previous version envelope for chaining
      // }
      // Calls thenDo(null, envelope).
      serializeToEnvelope: function (params, thenDo) {
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('PartSerializer.serializeToEnvelope: no identity session active'));
        if (!params.json) return thenDo(new Error('PartSerializer.serializeToEnvelope: json is required'));

        c.computeCid(params.json, function (err, cid) {
          if (err) return thenDo(err);
          var prevEnvelope = params.prevEnvelope || null;
          var prevCid = prevEnvelope && prevEnvelope.record ? (prevEnvelope.record.cid || null) : null;

          function _buildEnvelope(objId, genesisNonce) {
            var state = {
              partName: params.partName,
              comment:  params.comment || '',
              tags:     params.tags || [],
              htmlLogo: params.htmlLogo || null,
            };
            var envelope = {
              objId: objId,
              did: user.did,
              type: 'part',
              visibility: 'public',
              created: (prevEnvelope && prevEnvelope.created) || new Date().toISOString(),
              record: { cid: cid, prevCid: prevCid, payload: params.json },
              state: state,
            };
            if (genesisNonce) envelope.genesisNonce = genesisNonce;

            _signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
              if (signErr) console.warn('[PartSerializer] Could not sign envelope (non-fatal):', signErr.message);
              thenDo(null, signed || envelope);
            });
          }

          if (prevEnvelope && prevEnvelope.objId) {
            _buildEnvelope(prevEnvelope.objId, null);
          } else {
            lively.identity.webKey.generateGenesisObjId(user.did, function (err, result) {
              if (err) return thenDo(err);
              _buildEnvelope(result.objId, result.genesisNonce);
            });
          }
        });
      },

      // Calls thenDo(null, json, htmlLogo) — json is the plain Lively JSON
      // string, ready for IdentityPartItem.setPartFromJSON.
      deserializeFromEnvelope: function (envelope, thenDo) {
        var c = lively.identity.crypto;
        if (!envelope || !envelope.record || !envelope.record.payload) {
          return thenDo(new Error('PartSerializer.deserializeFromEnvelope: invalid envelope structure'));
        }
        var payload = envelope.record.payload;
        c.computeCid(payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          if (expectedCid !== envelope.record.cid) {
            return thenDo(new Error('PartSerializer.deserializeFromEnvelope: CID mismatch for objId=' + envelope.objId));
          }
          var json = typeof payload === 'string' ? payload : JSON.stringify(payload);
          var htmlLogo = envelope.state && envelope.state.htmlLogo || null;
          thenDo(null, json, htmlLogo);
        });
      },

    },

    // ─── private / shared parts (KEK/DEK plane, mirrors PostCardSerializer) ──

    'private', {

      // Resolve each handle to { did, handle, x25519PublicKey }, no caching
      // (a one-shot publish dialog has no autosave loop to amortize against,
      // unlike PostCardEditor's _resolveRecipientPubKeys). Calls
      // thenDo(null, { resolved: [...], failed: [handle, ...] }).
      resolveRecipientPubKeys: function (handles, thenDo) {
        if (!handles || !handles.length) return thenDo(null, { resolved: [], failed: [] });
        var base = lively.identity.did.baseUrl();
        var resolved = [];
        var failed = [];
        var remaining = handles.length;
        function done() {
          if (--remaining === 0) thenDo(null, { resolved: resolved, failed: failed });
        }
        handles.forEach(function (handle) {
          lively.identity.webKey.resolveHandle(handle, function (err, info) {
            if (err || !info || !info.did) { failed.push(handle); return done(); }
            var xhr = new XMLHttpRequest();
            xhr.open('GET', base + '/@' + encodeURIComponent(handle) + '/profile', true);
            xhr.withCredentials = true;
            xhr.onload = function () {
              if (xhr.status !== 200) { failed.push(handle); return done(); }
              var env;
              try { env = JSON.parse(xhr.responseText); } catch (e) { failed.push(handle); return done(); }
              var pub = env.record && env.record.payload && env.record.payload.accountX25519Pub;
              if (!pub) { failed.push(handle); return done(); }
              lively.identity.crypto.computeCid(env.record.payload, function (cidErr, cid) {
                if (cidErr || cid !== env.record.cid) { failed.push(handle); return done(); }
                resolved.push({ did: info.did, handle: handle, x25519PublicKey: pub });
                done();
              });
            };
            xhr.onerror = function () { failed.push(handle); done(); };
            xhr.send();
          });
        });
      },

      // params: same as serializeToEnvelope, plus:
      //   recipients: Array of { did, x25519PublicKey } — non-empty => 'shared'
      // Requires the KEK to be cached (WebAuthn._kekCache) — call
      // WebAuthn.deriveKek first, same precondition as PostCardSerializer.
      // Calls thenDo(null, envelope).
      serializeEncrypted: function (params, thenDo) {
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('PartSerializer.serializeEncrypted: no identity session'));
        if (!wa || !wa._kekCache || !wa._kekCache[user.credentialId]) {
          return thenDo(new Error(
            'PartSerializer.serializeEncrypted: KEK not cached for this session. ' +
            'Call WebAuthn.deriveKek first (prompts once per session).'
          ));
        }
        if (!params.json) return thenDo(new Error('PartSerializer.serializeEncrypted: json is required'));
        var kek = wa._kekCache[user.credentialId];

        c.wrapDek(kek, function (err, dekResult) {
          if (err) return thenDo(err);
          var dek = dekResult.dek;

          c.encryptPayload(params.json, dek, function (err, encrypted) {
            if (err) return thenDo(err);

            c.computeCid(encrypted.ciphertext, function (err, cid) {
              if (err) return thenDo(err);

              var prevEnvelope = params.prevEnvelope || null;
              var prevCid = prevEnvelope && prevEnvelope.record ? (prevEnvelope.record.cid || null) : null;

              function _buildEnvelope(objId, genesisNonce, recipientWraps) {
                var state = {
                  partName: params.partName,
                  comment:  params.comment || '',
                  tags:     params.tags || [],
                  htmlLogo: params.htmlLogo || null,
                };
                var visibility = (params.recipients && params.recipients.length) ? 'shared' : 'private';
                var envelope = {
                  objId: objId,
                  did: user.did,
                  type: 'part',
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

                _signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
                  if (signErr) console.warn('[PartSerializer] Could not sign encrypted envelope (non-fatal):', signErr.message);
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
                  return _buildEnvelope(objId, genesisNonce, []);
                }
                var recipientWraps = [];
                var remaining = params.recipients.length;
                var hadError = false;
                params.recipients.forEach(function (r) {
                  c.sealForRecipient(dek, r.x25519PublicKey, function (err, sealed) {
                    if (hadError) return;
                    if (err) { hadError = true; return thenDo(err); }
                    recipientWraps.push({ did: r.did, sealedDek: sealed });
                    if (--remaining === 0) _buildEnvelope(objId, genesisNonce, recipientWraps);
                  });
                });
              });
            });
          });
        });
      },

      // Decrypts a private/shared part envelope for either its owner or one
      // of its recipients. Calls thenDo(null, json, htmlLogo).
      deserializeEncrypted: function (envelope, thenDo) {
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('PartSerializer.deserializeEncrypted: no identity session'));
        if (!envelope || !envelope.record || !envelope.record.payload) {
          return thenDo(new Error('PartSerializer.deserializeEncrypted: invalid envelope structure'));
        }

        c.computeCid(envelope.record.payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          if (expectedCid !== envelope.record.cid) {
            return thenDo(new Error('PartSerializer.deserializeEncrypted: CID mismatch for objId=' + envelope.objId));
          }

          _unwrapDekForEnvelope(envelope, user, wa, c, function (err, dek) {
            if (err) return thenDo(err);
            c.decryptPayload(envelope.record.payload, envelope.record.nonce, dek, function (err, parsed) {
              if (err) return thenDo(err);
              // decryptPayload always JSON.parses the plaintext (Crypto.js) —
              // parsed is the part's Lively JSON as a JS object here, not a
              // string. IdentityPartItem.setPartFromJSON wants a string.
              var json = JSON.stringify(parsed);
              var htmlLogo = envelope.state && envelope.state.htmlLogo || null;
              thenDo(null, json, htmlLogo);
            });
          });
        });
      },

    });

    // ─── shared signing helper (mirrors PostCardSerializer._signEnvelopeIfPossible,
    //     itself mirroring SignedSerializer._signEnvelopeIfPossible) ───────────────

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

    // ─── shared DEK-unwrap helper (mirrors PostCardSerializer._unwrapDekForEnvelope) ─

    function _unwrapDekForEnvelope(envelope, user, wa, c, thenDo) {
      var isOwner = user.did === envelope.did;
      if (isOwner) {
        function withKek(dekCallback) {
          if (wa && wa._kekCache && wa._kekCache[user.credentialId]) {
            return dekCallback(null, wa._kekCache[user.credentialId]);
          }
          var ch = new Uint8Array(32);
          crypto.getRandomValues(ch);
          wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, dekCallback);
        }
        withKek(function (err, kek) {
          if (err) return thenDo(err);
          c.unwrapDek(envelope.record.wrappedDek, kek, thenDo);
        });
      } else {
        var myEntry = (envelope.record.recipients || []).find(function (r) { return r.did === user.did; });
        if (!myEntry) return thenDo(new Error('PartSerializer: no sealed DEK for current user'));
        var ch = new Uint8Array(32);
        crypto.getRandomValues(ch);
        wa.deriveX25519KeyPair({ credentialId: user.credentialId, challenge: ch }, function (err, pair) {
          if (err) return thenDo(err);
          c.openSealedBox(myEntry.sealedDek, pair.publicKey, pair.privateKey, thenDo);
        });
      }
    }

    // Singleton: lively.identity.partSerializer.serializeToEnvelope(...), etc.
    lively.identity.partSerializer = new lively.identity.PartSerializer();

  }); // end module('lively.identity.PartSerializer')
