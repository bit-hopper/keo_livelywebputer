/**
 * lively.identity.WalletBackup
 *
 * WalletSpec.md §7.2, §15 step 10: the wallet's OPTIONAL encrypted backup
 * into the identity's existing private Files/encryption plane
 * (Encryption.md §2-§5) — a fourth payload type through that one plane,
 * not a new one (WalletSpec.md §4). Main-world only; touches no wallet
 * secrets directly — the vault's own exportBackupBlob (§3.4) is the only
 * thing this ever calls into the vault for, and what it returns is already
 * ciphertext (the wallet-blob record already sitting in the vault's own
 * IndexedDB, §7.1), never a decrypted mnemonic or key.
 *
 * Two changes from FileCrypto.js's ordinary private-file path (§7.2's own
 * corrections against an earlier draft):
 *   1. type: 'wallet-backup', not type: 'file' — kept out of
 *      FilesBrowser's listing (it filters client-side for type === 'file')
 *      so a casual look at "my private files" doesn't surface "I have a
 *      wallet."
 *   2. state: {} — no descriptive name field the way FileCrypto sets
 *      state.name in the clear; nothing server-visible identifies this
 *      object as wallet-related beyond the type string itself.
 * No BlobStore involved either (§7.2's own correction to an earlier
 * draft): the vault's exported blob is well under a kilobyte, so it goes
 * directly into record.payload, the same way any other small envelope
 * type already works.
 *
 * Because type: 'wallet-backup' is deliberately excluded from every
 * listing UI, there is no way to rediscover a backup's objId later except
 * by remembering it — WebKey.generateGenesisObjId is randomly generated
 * per call, not derived from anything (confirmed directly from source:
 * a fresh random 16-byte nonce every time), so refresh/delete need SOME
 * pointer. Tracked in localStorage, keyed by DID — the same convention
 * PrivacyPoolClient.js already uses for its own public, non-secret local
 * bookkeeping (deposit index/history).
 *
 * KNOWN LIMITATION, not solved here: clearing localStorage (or using a
 * different browser/profile) loses track of an existing backup's objId on
 * THIS device — the backup itself still exists server-side (this storage
 * layer is append-only, per ObjectRepository.listForUser/put and
 * FilesBrowser.js's own _deleteFile comment) but this module has no way to
 * rediscover it, by the same design that keeps it out of listings. Not a
 * real recovery gap: §7.3 makes the mnemonic itself, not this backup, the
 * actual recovery path — this is a cross-device convenience, never the
 * only copy.
 *
 * "Delete," similarly, can only ever mean "overwrite the current version
 * with inert content and forget the local pointer," never true
 * server-side erasure — objects.db is an append-only version log (same
 * fact FilesBrowser._deleteFile's own comment documents for files). See
 * deleteBackup's own comment.
 *
 * Async pattern: thenDo(err, result), matching the rest of
 * lively.identity.*.
 */

module('lively.identity.WalletBackup')
  .requires(
    'lively.identity.WalletBridge',
    'lively.identity.Crypto',
    'lively.identity.WebAuthn',
    'lively.identity.DID',
    'lively.identity.WebKey',
  )
  .toRun(function () {

Object.subclass('lively.identity.WalletBackup',

// ─── KEK (identity's own Files-encryption-plane key, not the vault's) ───

'kek', {

  // Same withKek pattern as FileCrypto._withKek/PostCardEditor._saveNowPrivate
  // — reuse the session's cached KEK, otherwise prompt once via a fresh
  // WebAuthn ceremony (onWaiting lets a caller show "Confirm passkey…").
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

// ─── local pointer (public, non-secret bookkeeping — see this file's own
//     header on why one is unavoidable) ──────────────────────────────────

'local pointer', {

  _objIdKey: function (did) {
    return 'lively.wallet.filesBackupObjId.' + did;
  },

  _getLocalObjId: function (did) {
    return window.localStorage.getItem(this._objIdKey(did));
  },

  _setLocalObjId: function (did, objId) {
    window.localStorage.setItem(this._objIdKey(did), objId);
  },

  _clearLocalObjId: function (did) {
    window.localStorage.removeItem(this._objIdKey(did));
  },

  // Calls thenDo(null, { exists, objId }) — purely local, no network call,
  // so a Settings-style UI can decide "Create" vs "Refresh/Delete" without
  // waiting on a fetch every time it renders.
  status: function (thenDo) {
    var user = lively.identity.did.currentUser();
    if (!user) return thenDo(new Error('WalletBackup: no identity session active'));
    var objId = this._getLocalObjId(user.did);
    thenDo(null, { exists: !!objId, objId: objId || null });
  },

},

// ─── server I/O (plain PUT/GET /@:handle/:objId, §3's universal envelope
//     route — no new server storage mechanism, §7.2's own point) ────────

'server', {

  _putEnvelope: function (handle, envelope, thenDo) {
    var base = lively.identity.did.baseUrl();
    fetch(base + '/@' + handle + '/' + envelope.objId, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (b) {
        throw new Error(b.error || ('wallet-backup save failed: ' + res.status));
      });
      return res.json();
    }).then(function (body) { thenDo(null, body); })
      .catch(function (e) { thenDo(e); });
  },

  // Resolves null (not an error) on a 404 — refreshBackup/deleteBackup both
  // treat "the local pointer exists but the server object doesn't" as a
  // stale-pointer case to recover from, not a hard failure.
  _getEnvelope: function (handle, objId, thenDo) {
    var base = lively.identity.did.baseUrl();
    fetch(base + '/@' + handle + '/' + objId, { credentials: 'include' })
      .then(function (res) {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('wallet-backup fetch failed: ' + res.status);
        return res.json();
      })
      .then(function (envelope) { thenDo(null, envelope); })
      .catch(function (e) { thenDo(e); });
  },

},

// ─── create / refresh / delete (§9.2's own three actions) ───────────────

'backup', {

  // Encrypts the vault's own opaque exported blob (§3.4 exportBackupBlob —
  // already ciphertext; this module never sees a decrypted mnemonic) under
  // the identity's OWN existing Files-encryption-plane DEK/KEK
  // (Encryption.md §2-3, the same primitives FileCrypto.js uses for a
  // private file's metadata), then PUTs it as a type: 'wallet-backup'
  // envelope. Calls thenDo(null, { objId }).
  _encryptAndPut: function (objId, prevCid, onWaiting, thenDo) {
    var self = this;
    var c = lively.identity.crypto;
    var user = lively.identity.did.currentUser();
    if (!user) return thenDo(new Error('WalletBackup: no identity session active'));

    lively.identity.walletBridge.exportBackupBlob(function (err, blob) {
      if (err) return thenDo(err);
      self._withKek(user, onWaiting, function (err2, kek) {
        if (err2) return thenDo(err2);
        c.wrapDek(kek, function (err3, dekResult) {
          if (err3) return thenDo(err3);
          c.encryptPayload(blob, dekResult.dek, function (err4, encrypted) {
            if (err4) return thenDo(err4);
            c.computeCid(encrypted.ciphertext, function (err5, cid) {
              if (err5) return thenDo(err5);
              var envelope = {
                objId: objId,
                did: user.did,
                type: 'wallet-backup',
                visibility: 'private',
                created: new Date().toISOString(),
                record: {
                  cid: cid,
                  prevCid: prevCid || null,
                  payload: encrypted.ciphertext,
                  nonce: encrypted.nonce,
                  wrappedDek: dekResult.wrappedDek,
                  recipients: [],
                },
                state: {},
              };
              self._putEnvelope(user.handle, envelope, function (err6) {
                if (err6) return thenDo(err6);
                thenDo(null, { objId: objId });
              });
            });
          });
        });
      });
    });
  },

  // Creates a fresh wallet-backup envelope. Errors if one already exists
  // per this device's local pointer — use refreshBackup to update an
  // existing one instead (§9.2: create/refresh/delete are distinct
  // actions, not one "save" button).
  createBackup: function (onWaiting, thenDo) {
    var self = this;
    var user = lively.identity.did.currentUser();
    if (!user) return thenDo(new Error('WalletBackup: no identity session active'));
    if (self._getLocalObjId(user.did)) {
      return thenDo(new Error('createBackup: a backup already exists on this device — use refreshBackup instead'));
    }
    lively.identity.webKey.generateGenesisObjId(user.did, function (err, gen) {
      if (err) return thenDo(err);
      self._encryptAndPut(gen.objId, null, onWaiting, function (err2, result) {
        if (err2) return thenDo(err2);
        self._setLocalObjId(user.did, result.objId);
        thenDo(null, result);
      });
    });
  },

  // Re-encrypts and re-uploads the SAME wallet-backup envelope (e.g. after
  // changing unlock methods, or just to confirm it's still current) —
  // fetches the existing envelope first, both to chain record.prevCid
  // correctly (same versioning convention every other envelope type uses)
  // and to detect a stale local pointer (the object 404s — someone cleared
  // server-side state out from under this device somehow) rather than
  // silently creating an orphaned second envelope under a fresh objId.
  refreshBackup: function (onWaiting, thenDo) {
    var self = this;
    var user = lively.identity.did.currentUser();
    if (!user) return thenDo(new Error('WalletBackup: no identity session active'));
    var objId = self._getLocalObjId(user.did);
    if (!objId) return thenDo(new Error('refreshBackup: no backup exists on this device — use createBackup first'));

    self._getEnvelope(user.handle, objId, function (err, envelope) {
      if (err) return thenDo(err);
      if (!envelope) {
        self._clearLocalObjId(user.did);
        return thenDo(new Error('refreshBackup: the previously-created backup is gone — forgot the stale local pointer, use createBackup to make a new one'));
      }
      self._encryptAndPut(objId, envelope.record.cid, onWaiting, thenDo);
    });
  },

  // Per this module's own header: "delete" can only ever mean "overwrite
  // the current version with inert content and forget the local pointer,"
  // never true server-side erasure — objects.db is an append-only version
  // log, so an older ciphertext version is not guaranteed gone. Overwrites
  // record with a harmless marker payload encrypted under a throwaway,
  // immediately-discarded key (generated here, never persisted or wrapped
  // meaningfully anywhere) so THIS version specifically is provably
  // undecryptable by anyone, including this module a moment later — then
  // forgets the local pointer regardless of whether the PUT succeeds, since
  // an unreachable local pointer isn't worth keeping either way. Needs no
  // passkey/password prompt: unlike create/refresh, nothing here needs the
  // real KEK. Calls thenDo(null) if there was nothing local to delete.
  deleteBackup: function (thenDo) {
    var self = this;
    var c = lively.identity.crypto;
    var user = lively.identity.did.currentUser();
    if (!user) return thenDo(new Error('WalletBackup: no identity session active'));
    var objId = self._getLocalObjId(user.did);
    if (!objId) return thenDo(null);

    self._getEnvelope(user.handle, objId, function (err, envelope) {
      if (err) return thenDo(err);
      var prevCid = envelope && envelope.record ? envelope.record.cid : null;

      var throwawayKek = new Uint8Array(32);
      crypto.getRandomValues(throwawayKek);

      c.wrapDek(throwawayKek, function (err2, dekResult) {
        if (err2) return thenDo(err2);
        c.encryptPayload({ deleted: true }, dekResult.dek, function (err3, encrypted) {
          if (err3) return thenDo(err3);
          c.computeCid(encrypted.ciphertext, function (err4, cid) {
            if (err4) return thenDo(err4);
            var tombstone = {
              objId: objId,
              did: user.did,
              type: 'wallet-backup',
              visibility: 'private',
              created: new Date().toISOString(),
              record: {
                cid: cid,
                prevCid: prevCid,
                payload: encrypted.ciphertext,
                nonce: encrypted.nonce,
                wrappedDek: dekResult.wrappedDek,
                recipients: [],
              },
              state: {},
            };
            self._putEnvelope(user.handle, tombstone, function (errPut) {
              self._clearLocalObjId(user.did);
              thenDo(errPut || null);
            });
          });
        });
      });
    });
  },

});

lively.identity.walletBackup = new lively.identity.WalletBackup();

}); // end module('lively.identity.WalletBackup')
