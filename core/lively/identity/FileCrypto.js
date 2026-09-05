/**
 * lively.identity.FileCrypto
 *
 * Encrypt-before-upload file handling for the Lively identity system
 * (Encryption.md §5). Shared by FilesBrowser, ProfileCard, and (§6)
 * PostCardEditor's attachment flow. Also owns the encrypted-folder
 * operations (Encryption.md §15, added 2026-09-04) — a folder is not
 * different enough from a file to warrant a separate module: both are
 * KEK/DEK/sealedDek envelopes over the same BlobStore, just with a folder's
 * DEK fixed for its lifetime instead of rotated per version (see §15.2 for
 * why, and the "folder" section below).
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
        wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, thenDo);
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

      _putEnvelope: function (handle, envelope, thenDo) {
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

                self._putBlob(user.handle, blobCid, blob.bytes, function (err, putResult) {
                  if (err) return thenDo(err);
                  // Server-computed, federation-safe absolute URL for this
                  // blob (see IdentityServer.js's canonicalOrigin) -- never
                  // construct one client-side from location.origin, which
                  // just reflects whichever hostname alias served this page.
                  var blobUrl = putResult && putResult.url;

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
                      self._putEnvelope(user.handle, envelope, function (err) {
                        if (err) return thenDo(err);
                        // blobNonce is null for a public file — its blob is
                        // plaintext, encrypted only for the private/shared
                        // path (see withCipherBytes above). Returned (along
                        // with dek) for callers that embed both directly
                        // rather than going through fetchAndDecrypt — e.g.
                        // postcard attachments (Encryption.md §6).
                        thenDo(null, { objId: gen.objId, blobCid: blobCid, blobNonce: blob.nonce, dek: dek, url: blobUrl });
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
            wa.deriveX25519KeyPair({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err, pair) {
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
        this._folderDekCache = {};
      },

    },

    'folder', {

      // Random opaque id for a folder member entry (Encryption.md §15.3) —
      // deliberately NOT generateGenesisObjId: a folder member has no
      // standalone envelope of its own to address, this is purely a stable
      // list key for UI/fetch calls into the folder's own decrypted list.
      _randomId: function () {
        var bytes = new Uint8Array(9);
        crypto.getRandomValues(bytes);
        return lively.identity.crypto.base64urlEncode(bytes);
      },

      _cacheFolderDek: function (objId, dek) {
        if (!this._folderDekCache) this._folderDekCache = {};
        this._folderDekCache[objId] = dek;
      },

      // Generic envelope GET — factored out here (rather than reusing
      // fetchAndDecrypt's inline fetch) since every folder operation below
      // needs the raw envelope first, whereas fetchAndDecrypt's fetch is
      // file-specific and already covered by its own test path.
      _getEnvelope: function (handle, objId, thenDo) {
        var base = lively.identity.did.baseUrl();
        fetch(base + '/@' + handle + '/' + objId, { credentials: 'include' })
          .then(function (res) {
            if (!res.ok) throw new Error('Could not fetch envelope (HTTP ' + res.status + ')');
            return res.json();
          })
          .then(function (envelope) { thenDo(null, envelope); })
          .catch(function (e) { thenDo(e); });
      },

      // Re-encrypt {name, files} with the SAME dek (fresh nonce) as a new
      // envelope version — the shared tail of create/add/remove/rename.
      // prevEnvelope supplies did/wrappedDek/recipients/created unchanged;
      // only record.{cid,prevCid,payload,nonce} and blobCids/state advance.
      _saveFolderVersion: function (handle, prevEnvelope, dek, name, files, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var payload = { name: name, files: files };
        c.encryptPayload(payload, dek, function (err, encrypted) {
          if (err) return thenDo(err);
          c.computeCid(encrypted.ciphertext, function (err, cid) {
            if (err) return thenDo(err);
            var envelope = {
              objId: prevEnvelope.objId,
              did: prevEnvelope.did,
              type: 'folder',
              visibility: (prevEnvelope.record.recipients || []).length ? 'shared' : 'private',
              created: prevEnvelope.created,
              record: {
                cid: cid,
                prevCid: prevEnvelope.record.cid,
                payload: encrypted.ciphertext,
                nonce: encrypted.nonce,
                wrappedDek: prevEnvelope.record.wrappedDek,
                recipients: prevEnvelope.record.recipients || [],
              },
              blobCids: files.map(function (f) { return f.blobCid; }),
              state: { name: name, fileCount: files.length },
            };
            self._putEnvelope(handle, envelope, function (err) {
              if (err) return thenDo(err);
              self._cacheFolderDek(envelope.objId, dek);
              thenDo(null, { objId: envelope.objId, cid: cid, fileCount: files.length });
            });
          });
        });
      },

      // opts: { recipients, onWaiting } — same shape as encryptAndUpload.
      // Calls thenDo(null, { objId, dek }).
      createFolder: function (name, opts, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('createFolder: no identity session active'));
        opts = opts || {};
        var recipients = opts.recipients || [];

        self._withKek(user, opts.onWaiting, function (err, kek) {
          if (err) return thenDo(err);
          c.wrapDek(kek, function (err, dekResult) {
            if (err) return thenDo(err);
            var dek = dekResult.dek;

            c.encryptPayload({ name: name, files: [] }, dek, function (err, encrypted) {
              if (err) return thenDo(err);
              c.computeCid(encrypted.ciphertext, function (err, cid) {
                if (err) return thenDo(err);

                function withRecipientWraps(cb) {
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

                withRecipientWraps(function (err, recipientWraps) {
                  if (err) return thenDo(err);
                  lively.identity.webKey.generateGenesisObjId(user.did, function (err, gen) {
                    if (err) return thenDo(err);
                    var envelope = {
                      objId: gen.objId,
                      did: user.did,
                      type: 'folder',
                      visibility: recipientWraps.length ? 'shared' : 'private',
                      created: new Date().toISOString(),
                      record: {
                        cid: cid,
                        prevCid: null,
                        payload: encrypted.ciphertext,
                        nonce: encrypted.nonce,
                        wrappedDek: dekResult.wrappedDek,
                        recipients: recipientWraps,
                      },
                      blobCids: [],
                      state: { name: name, fileCount: 0 },
                    };
                    self._putEnvelope(user.handle, envelope, function (err) {
                      if (err) return thenDo(err);
                      self._cacheFolderDek(envelope.objId, dek);
                      thenDo(null, { objId: envelope.objId, dek: dek });
                    });
                  });
                });
              });
            });
          });
        });
      },

      // GET + decrypt a folder envelope. Calls thenDo(null, { objId, name,
      // files, dek, isOwner, envelope }). Caches the dek per objId so a
      // session's worth of add/remove/rename/fetch calls only pay the
      // KEK/sealedDek ceremony once.
      fetchFolder: function (handle, folderObjId, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('fetchFolder: no identity session'));

        self._getEnvelope(handle, folderObjId, function (err, envelope) {
          if (err) return thenDo(err);
          if (envelope.type !== 'folder') {
            return thenDo(new Error('fetchFolder: ' + folderObjId + ' is not a folder'));
          }

          c.computeCid(envelope.record.payload, function (err, expectedCid) {
            if (err) return thenDo(err);
            if (expectedCid !== envelope.record.cid) {
              return thenDo(new Error('fetchFolder: CID mismatch for objId=' + envelope.objId));
            }

            var isOwner = user.did === envelope.did;

            function withDek(cb) {
              var cached = self._folderDekCache && self._folderDekCache[envelope.objId];
              if (cached) return cb(null, cached);
              if (isOwner) {
                self._withKek(user, null, function (err, kek) {
                  if (err) return cb(err);
                  c.unwrapDek(envelope.record.wrappedDek, kek, cb);
                });
                return;
              }
              var myEntry = (envelope.record.recipients || []).find(function (r) { return r.did === user.did; });
              if (!myEntry) return cb(new Error('fetchFolder: no sealed DEK for current user'));
              var ch = new Uint8Array(32);
              crypto.getRandomValues(ch);
              wa.deriveX25519KeyPair({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err, pair) {
                if (err) return cb(err);
                c.openSealedBox(myEntry.sealedDek, pair.publicKey, pair.privateKey, cb);
              });
            }

            withDek(function (err, dek) {
              if (err) return thenDo(err);
              self._cacheFolderDek(envelope.objId, dek);
              c.decryptPayload(envelope.record.payload, envelope.record.nonce, dek, function (err, payload) {
                if (err) return thenDo(err);
                thenDo(null, {
                  objId: envelope.objId,
                  name: payload.name,
                  files: payload.files || [],
                  dek: dek,
                  isOwner: isOwner,
                  envelope: envelope,
                });
              });
            });
          });
        });
      },

      // Encrypt+upload a new member file under the folder's existing dek,
      // then save a new folder version whose file list includes it.
      // opts: { name } — override for file.name, same as encryptAndUpload.
      // Calls thenDo(null, { id, blobCid }).
      addFileToFolder: function (handle, folderObjId, file, opts, thenDo) {
        if (typeof opts === 'function') { thenDo = opts; opts = {}; }
        opts = opts || {};
        var self = this;
        var c = lively.identity.crypto;

        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          self._readFile(file, function (err, plainBytes) {
            if (err) return thenDo(err);
            c.encryptBytes(plainBytes, folder.dek, function (err, result) {
              if (err) return thenDo(err);
              c.sha256(result.ciphertext, function (err, blobCid) {
                if (err) return thenDo(err);
                self._putBlob(handle, blobCid, result.ciphertext, function (err) {
                  if (err) return thenDo(err);
                  var entry = {
                    id: self._randomId(),
                    name: opts.name || file.name || 'file',
                    mime: file.type || 'application/octet-stream',
                    size: plainBytes.length,
                    blobCid: blobCid,
                    blobNonce: result.nonce,
                    addedAt: new Date().toISOString(),
                  };
                  var newFiles = folder.files.concat([entry]);
                  self._saveFolderVersion(handle, folder.envelope, folder.dek, folder.name, newFiles, function (err) {
                    if (err) return thenDo(err);
                    thenDo(null, { id: entry.id, blobCid: blobCid });
                  });
                });
              });
            });
          });
        });
      },

      // Drops one member entry from the folder's file list. Does NOT delete
      // the now-unreferenced blob from BlobStore — storage reclamation isn't
      // built anywhere else in this codebase either, left as a separate,
      // not-yet-built concern (Encryption.md §15.5).
      removeFileFromFolder: function (handle, folderObjId, fileId, thenDo) {
        var self = this;
        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          var newFiles = folder.files.filter(function (f) { return f.id !== fileId; });
          self._saveFolderVersion(handle, folder.envelope, folder.dek, folder.name, newFiles, thenDo);
        });
      },

      renameFolder: function (handle, folderObjId, newName, thenDo) {
        var self = this;
        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          self._saveFolderVersion(handle, folder.envelope, folder.dek, newName, folder.files, thenDo);
        });
      },

      // Owner-only: seal the folder's existing (unchanged) dek for each new
      // recipient and PUT the envelope. Payload ciphertext is untouched, so
      // this lands on ObjectRepository's same-cid metadata-update path —
      // no file bytes are re-encrypted (Encryption.md §15.2).
      // recipients: [{ did, x25519PublicKey }]. Calls thenDo(null, { objId, added }).
      shareFolder: function (handle, folderObjId, recipients, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          if (!folder.isOwner) return thenDo(new Error('shareFolder: only the owner can share a folder'));

          var existingDids = (folder.envelope.record.recipients || []).map(function (r) { return r.did; });
          var toAdd = (recipients || []).filter(function (r) { return existingDids.indexOf(r.did) === -1; });
          if (!toAdd.length) return thenDo(null, { objId: folderObjId, added: 0 });

          var wraps = [];
          var remaining = toAdd.length;
          var hadError = false;
          toAdd.forEach(function (r) {
            c.sealForRecipient(folder.dek, r.x25519PublicKey, function (err, sealed) {
              if (hadError) return;
              if (err) { hadError = true; return thenDo(err); }
              wraps.push({ did: r.did, sealedDek: sealed });
              if (--remaining === 0) {
                var envelope = Object.assign({}, folder.envelope);
                envelope.record = Object.assign({}, folder.envelope.record, {
                  recipients: (folder.envelope.record.recipients || []).concat(wraps),
                });
                envelope.visibility = 'shared';
                self._putEnvelope(handle, envelope, function (err) {
                  if (err) return thenDo(err);
                  thenDo(null, { objId: folderObjId, added: wraps.length });
                });
              }
            });
          });
        });
      },

      // Owner-only: drop one recipient's sealedDek entry. See Encryption.md
      // §15.2 before presenting this as an unconditional "they can no longer
      // read anything" in any UI copy that calls this — it stops them from
      // being resealed into any FUTURE save, it does not retroactively
      // invalidate a dek they already obtained.
      revokeFolderRecipient: function (handle, folderObjId, did, thenDo) {
        var self = this;
        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          if (!folder.isOwner) return thenDo(new Error('revokeFolderRecipient: only the owner can revoke access'));
          var remainingRecipients = (folder.envelope.record.recipients || []).filter(function (r) { return r.did !== did; });
          var envelope = Object.assign({}, folder.envelope);
          envelope.record = Object.assign({}, folder.envelope.record, { recipients: remainingRecipients });
          envelope.visibility = remainingRecipients.length ? 'shared' : 'private';
          self._putEnvelope(handle, envelope, function (err) {
            if (err) return thenDo(err);
            thenDo(null, { objId: folderObjId, remaining: remainingRecipients.length });
          });
        });
      },

      // fetchFolder (dek cache hit after the first call) -> blob fetch ->
      // decrypt -> object URL, cached per blobCid same as objectUrlFor.
      // fileEntry: one entry from fetchFolder's `files` array.
      folderFileUrl: function (handle, folderObjId, fileEntry, thenDo) {
        if (!this._urlCache) this._urlCache = {};
        var cacheKey = 'folder-file:' + fileEntry.blobCid;
        if (this._urlCache[cacheKey]) return thenDo(null, this._urlCache[cacheKey]);

        var self = this;
        var c = lively.identity.crypto;

        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          self._fetchBlobBytes(handle, fileEntry.blobCid, function (err, cipherBytes) {
            if (err) return thenDo(err);
            c.decryptBytes(cipherBytes, fileEntry.blobNonce, folder.dek, function (err, plainBytes) {
              if (err) return thenDo(err);
              var blob = new Blob([plainBytes], { type: fileEntry.mime || 'application/octet-stream' });
              var url = URL.createObjectURL(blob);
              self._urlCache[cacheKey] = url;
              thenDo(null, url);
            });
          });
        });
      },

    });

    // Singleton: lively.identity.fileCrypto.encryptAndUpload(...), etc.
    lively.identity.fileCrypto = new lively.identity.FileCrypto();

  }); // end module('lively.identity.FileCrypto')
