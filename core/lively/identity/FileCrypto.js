/**
 * lively.identity.FileCrypto
 *
 * Encrypt-before-upload file handling for the Lively identity system
 * (Encryption.md §5). Shared by FilesBrowser, ProfileCard, and (§6)
 * PostCardEditor's attachment flow.
 *
 * A "file" object is a small encrypted-metadata envelope (type: 'file',
 * stored via the ordinary PUT /@:handle/:objId route) plus the actual file
 * bytes in the content-addressed BlobStore (PUT/GET /@:handle/blobs/:cid).
 * Both halves share one DEK — wrapping/sealing already covers both, so
 * there's no separate key ceremony for the blob.
 *
 * Envelope payload shape (§5.1), before encryption:
 *   { name, mime, size, blobCid, blobNonce }
 * blobCid = sha256 of the RAW ciphertext bytes (or plaintext bytes for a
 * public file) — must match exactly what BlobStore.put verifies server-side,
 * so it is computed via Crypto.sha256 on the raw bytes, NOT via computeCid's
 * canonical-JSON path (which is only for the envelope's own record.cid).
 *
 * Async pattern: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.Crypto     — encryptBytes/decryptBytes, encryptPayload/
 *                                decryptPayload, wrapDek/unwrapDek, sha256,
 *                                sealForRecipient/openSealedBox, computeCid
 *   lively.identity.WebAuthn   — _kekCache, deriveKek, deriveX25519KeyPair
 *   lively.identity.DID        — currentUser()
 *   lively.identity.WebKey     — generateGenesisObjId
 */

module('lively.identity.FileCrypto')
  .requires(
    'lively.identity.Crypto',
    'lively.identity.WebAuthn',
    'lively.identity.DID',
    'lively.identity.WebKey',
  )
  .toRun(function () {

    Object.subclass('lively.identity.FileCrypto',

    'kek', {

      // Same withKek pattern as PostCardEditor._saveNowPrivate: reuse the
      // session's cached KEK, otherwise prompt once (this may show a
      // "Confirm passkey…" moment to the caller via the optional onWaiting
      // callback — FilesBrowser/ProfileCard can use it to update status text).
      _withKek: function (user, onWaiting, thenDo) {
        var wa = lively.identity.webAuthn;
        if (wa._kekCache && wa._kekCache[user.credentialId]) {
          return thenDo(null, wa._kekCache[user.credentialId]);
        }
        if (onWaiting) onWaiting();
        var ch = new Uint8Array(32);
        crypto.getRandomValues(ch);
        wa.deriveKek({ credentialId: user.credentialId, challenge: ch }, thenDo);
      },

    },

    'upload', {

      // Read a File/Blob into a Uint8Array.
      _readFile: function (file, thenDo) {
        var reader = new FileReader();
        reader.onload = function () { thenDo(null, new Uint8Array(reader.result)); };
        reader.onerror = function () { thenDo(reader.error || new Error('FileCrypto: could not read file')); };
        reader.readAsArrayBuffer(file);
      },

      // PUT raw bytes to the content-addressed blob store.
      _putBlob: function (handle, cid, bytes, thenDo) {
        var base = lively.identity.did.baseUrl();
        fetch(base + '/@' + handle + '/blobs/' + cid, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        }).then(function (res) {
          if (!res.ok) return res.json().then(function (b) {
            throw new Error('Blob upload failed: ' + (b.error || res.status));
          });
          return res.json();
        }).then(function (body) { thenDo(null, body); })
          .catch(function (e) { thenDo(e); });
      },

      _putFileEnvelope: function (handle, envelope, thenDo) {
        var base = lively.identity.did.baseUrl();
        fetch(base + '/@' + handle + '/' + envelope.objId, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(envelope),
        }).then(function (res) {
          if (!res.ok) return res.json().then(function (b) {
            throw new Error('File envelope save failed: ' + (b.error || res.status));
          });
          return res.json();
        }).then(function (body) { thenDo(null, body); })
          .catch(function (e) { thenDo(e); });
      },

      // opts: {
      //   visibility: 'private' | 'public'  (default 'private' — §0 goal:
      //               encrypted unless explicitly marked public)
      //   recipients: [{ did, x25519PublicKey }]  — for 'shared' (implied by
      //               a non-empty recipients list, same rule as postcards)
      //   name:       optional override for file.name — a cropped-avatar
      //               canvas Blob (ProfileCard.js) has no .name of its own
      //   onWaiting:  optional callback fired if a passkey prompt is needed
      // }
      // Calls thenDo(null, { objId, blobCid, dek }). dek (Uint8Array, or null
      // for a public file) is returned so a caller embedding this file inside
      // another encrypted payload (postcard attachments, §6) can carry the
      // same key without a second key ceremony.
      encryptAndUpload: function (file, opts, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('encryptAndUpload: no identity session active'));

        opts = opts || {};
        var isPublic = opts.visibility === 'public';
        var fileName = opts.name || file.name || 'file';
        var recipients = opts.recipients || [];

        self._readFile(file, function (err, plainBytes) {
          if (err) return thenDo(err);

          function withDek(cb) {
            if (isPublic) return cb(null, null);
            self._withKek(user, opts.onWaiting, function (err, kek) {
              if (err) return cb(err);
              c.wrapDek(kek, function (err, dekResult) { cb(err, dekResult); });
            });
          }

          withDek(function (err, dekResult) {
            if (err) return thenDo(err);
            var dek = dekResult ? dekResult.dek : null;

            function withCipherBytes(cb) {
              if (isPublic) return cb(null, { bytes: plainBytes, nonce: null });
              c.encryptBytes(plainBytes, dek, function (err, result) {
                if (err) return cb(err);
                cb(null, { bytes: result.ciphertext, nonce: result.nonce });
              });
            }

            withCipherBytes(function (err, blob) {
              if (err) return thenDo(err);

              c.sha256(blob.bytes, function (err, blobCid) {
                if (err) return thenDo(err);

                self._putBlob(user.handle, blobCid, blob.bytes, function (err) {
                  if (err) return thenDo(err);

                  var metadata = {
                    name: fileName,
                    mime: file.type || 'application/octet-stream',
                    size: plainBytes.length,
                    blobCid: blobCid,
                    blobNonce: blob.nonce,
                  };

                  lively.identity.webKey.generateGenesisObjId(user.did, function (err, gen) {
                    if (err) return thenDo(err);

                    function _buildAndPut(record, envelopeExtra) {
                      var envelope = Object.assign({
                        objId: gen.objId,
                        did: user.did,
                        type: 'file',
                        visibility: isPublic ? 'public' : (recipients.length ? 'shared' : 'private'),
                        created: new Date().toISOString(),
                        record: record,
                        blobCid: blobCid,
                        state: { name: fileName },
                      }, envelopeExtra || {});
                      self._putFileEnvelope(user.handle, envelope, function (err) {
                        if (err) return thenDo(err);
                        // blobNonce is null for a public file — its blob is
                        // plaintext, encrypted only for the private/shared
                        // path (see withCipherBytes above). Returned (along
                        // with dek) for callers that embed both directly
                        // rather than going through fetchAndDecrypt — e.g.
                        // postcard attachments (Encryption.md §6).
                        thenDo(null, { objId: gen.objId, blobCid: blobCid, blobNonce: blob.nonce, dek: dek });
                      });
                    }

                    if (isPublic) {
                      c.computeCid(metadata, function (err, cid) {
                        if (err) return thenDo(err);
                        _buildAndPut({ cid: cid, prevCid: null, payload: metadata });
                      });
                      return;
                    }

                    c.encryptPayload(metadata, dek, function (err, encrypted) {
                      if (err) return thenDo(err);
                      c.computeCid(encrypted.ciphertext, function (err, cid) {
                        if (err) return thenDo(err);

                        function _withRecipientWraps(cb) {
                          if (!recipients.length) return cb(null, []);
                          var wraps = [];
                          var remaining = recipients.length;
                          var hadError = false;
                          recipients.forEach(function (r) {
                            c.sealForRecipient(dek, r.x25519PublicKey, function (err, sealed) {
                              if (hadError) return;
                              if (err) { hadError = true; return cb(err); }
                              wraps.push({ did: r.did, sealedDek: sealed });
                              if (--remaining === 0) cb(null, wraps);
                            });
                          });
                        }

                        _withRecipientWraps(function (err, recipientWraps) {
                          if (err) return thenDo(err);
                          _buildAndPut({
                            cid: cid,
                            prevCid: null,
                            payload: encrypted.ciphertext,
                            nonce: encrypted.nonce,
                            wrappedDek: dekResult.wrappedDek,
                            recipients: recipientWraps,
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      },

    },

    'fetch', {

      // Fetch a file envelope + blob and decrypt back to the original bytes.
      // handle: owner's handle. objId: the file envelope's objId.
      // Calls thenDo(null, { bytes: Uint8Array, mime, name, size }).
      fetchAndDecrypt: function (handle, objId, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var base = lively.identity.did.baseUrl();

        fetch(base + '/@' + handle + '/' + objId, { credentials: 'include' })
          .then(function (res) {
            if (!res.ok) throw new Error('Could not fetch file envelope (HTTP ' + res.status + ')');
            return res.json();
          })
          .then(function (envelope) {
            if (envelope.type !== 'file') {
              throw new Error('fetchAndDecrypt: envelope ' + objId + ' is not a file');
            }
            if (envelope.visibility === 'public') {
              return self._fetchPublic(handle, envelope, thenDo);
            }
            self._fetchPrivate(handle, envelope, thenDo);
          })
          .catch(function (e) { thenDo(e); });
      },

      _fetchPublic: function (handle, envelope, thenDo) {
        var metadata = envelope.record.payload;
        this._fetchBlobBytes(handle, metadata.blobCid, function (err, bytes) {
          if (err) return thenDo(err);
          thenDo(null, { bytes: bytes, mime: metadata.mime, name: metadata.name, size: metadata.size });
        });
      },

      _fetchPrivate: function (handle, envelope, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('fetchAndDecrypt: no identity session'));

        // CID check on the ciphertext, same invariant as every other envelope type.
        c.computeCid(envelope.record.payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          if (expectedCid !== envelope.record.cid) {
            return thenDo(new Error('fetchAndDecrypt: CID mismatch for objId=' + envelope.objId));
          }

          function withDek(cb) {
            var isOwner = user.did === envelope.did;
            if (isOwner) {
              self._withKek(user, null, function (err, kek) {
                if (err) return cb(err);
                c.unwrapDek(envelope.record.wrappedDek, kek, cb);
              });
              return;
            }
            var myEntry = (envelope.record.recipients || []).find(function (r) { return r.did === user.did; });
            if (!myEntry) return cb(new Error('fetchAndDecrypt: no sealed DEK for current user'));
            var ch = new Uint8Array(32);
            crypto.getRandomValues(ch);
            wa.deriveX25519KeyPair({ credentialId: user.credentialId, challenge: ch }, function (err, pair) {
              if (err) return cb(err);
              c.openSealedBox(myEntry.sealedDek, pair.publicKey, pair.privateKey, cb);
            });
          }

          withDek(function (err, dek) {
            if (err) return thenDo(err);
            c.decryptPayload(envelope.record.payload, envelope.record.nonce, dek, function (err, metadata) {
              if (err) return thenDo(err);
              self._fetchBlobBytes(handle, metadata.blobCid, function (err, cipherBytes) {
                if (err) return thenDo(err);
                c.decryptBytes(cipherBytes, metadata.blobNonce, dek, function (err, plainBytes) {
                  if (err) return thenDo(err);
                  thenDo(null, { bytes: plainBytes, mime: metadata.mime, name: metadata.name, size: metadata.size });
                });
              });
            });
          });
        });
      },

      _fetchBlobBytes: function (handle, blobCid, thenDo) {
        var base = lively.identity.did.baseUrl();
        fetch(base + '/@' + handle + '/blobs/' + blobCid, { credentials: 'include' })
          .then(function (res) {
            if (!res.ok) throw new Error('Could not fetch blob ' + blobCid + ' (HTTP ' + res.status + ')');
            return res.arrayBuffer();
          })
          .then(function (buf) { thenDo(null, new Uint8Array(buf)); })
          .catch(function (e) { thenDo(e); });
      },

    },

    'objectUrl', {

      // fetchAndDecrypt -> Blob -> URL.createObjectURL, cached per objId+cid
      // so repeated opens/renders of the same version don't re-decrypt.
      // Calls thenDo(null, objectUrl).
      objectUrlFor: function (handle, objId, thenDo) {
        if (!this._urlCache) this._urlCache = {};
        var cacheKey = handle + '/' + objId;
        if (this._urlCache[cacheKey]) return thenDo(null, this._urlCache[cacheKey]);

        var self = this;
        this.fetchAndDecrypt(handle, objId, function (err, result) {
          if (err) return thenDo(err);
          var blob = new Blob([result.bytes], { type: result.mime });
          var url = URL.createObjectURL(blob);
          self._urlCache[cacheKey] = url;
          thenDo(null, url);
        });
      },

      // Postcard-attachment variant of objectUrlFor (Encryption.md §6): the
      // attachment's dek travels inside the postcard's own decrypted payload
      // rather than being wrapped/sealed in the attachment's own file
      // envelope, so this skips fetchAndDecrypt's envelope fetch + KEK/
      // sealedDek unwrap entirely and goes straight blob-fetch -> decrypt.
      // attachment: { blobCid, blobNonce, dek, mime } — dek/blobNonce null
      // for a public postcard's attachment (blob is already plaintext).
      // Cached per blobCid (content-addressed, so this is safe across
      // versions/attachments that happen to share bytes).
      // Calls thenDo(null, objectUrl).
      resolveAttachmentUrl: function (handle, attachment, thenDo) {
        if (!this._urlCache) this._urlCache = {};
        var cacheKey = 'attachment:' + attachment.blobCid;
        if (this._urlCache[cacheKey]) return thenDo(null, this._urlCache[cacheKey]);

        var self = this;
        var c = lively.identity.crypto;

        function withPlainBytes(plainBytes) {
          var blob = new Blob([plainBytes], { type: attachment.mime || 'application/octet-stream' });
          var url = URL.createObjectURL(blob);
          self._urlCache[cacheKey] = url;
          thenDo(null, url);
        }

        this._fetchBlobBytes(handle, attachment.blobCid, function (err, bytes) {
          if (err) return thenDo(err);
          if (!attachment.dek) return withPlainBytes(bytes); // public: already plaintext
          c.decryptBytes(bytes, attachment.blobNonce, attachment.dek, function (err, plainBytes) {
            if (err) return thenDo(err);
            withPlainBytes(plainBytes);
          });
        });
      },

      // Revoke and forget every cached object URL — call on world unload.
      revokeAll: function () {
        var self = this;
        Object.keys(this._urlCache || {}).forEach(function (key) {
          URL.revokeObjectURL(self._urlCache[key]);
        });
        this._urlCache = {};
      },

    });

    // Singleton: lively.identity.fileCrypto.encryptAndUpload(...), etc.
    lively.identity.fileCrypto = new lively.identity.FileCrypto();

  }); // end module('lively.identity.FileCrypto')
