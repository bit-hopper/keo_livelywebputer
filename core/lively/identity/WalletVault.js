/**
 * lively.identity.WalletVault
 *
 * WalletSpec.md step 2 (§15): implements generate/import/encrypt/store/
 * unlock/lock/reveal and runs the §5.1 HKDF synthetic-pool-mnemonic
 * derivation. Step 3 additions: getAddress (the "trivial method"
 * WalletBridge.js's postMessage plumbing is proven against), the vault-side
 * postMessage RPC responder, and the reduced-isolation dev-mode banner
 * (§3.2).
 *
 * §8.3's memory model, implemented as of step 3: an unlocked vault holds
 * the derived DEK at rest (this._unlockedDek), not the decrypted mnemonic.
 * _withUnlockedMnemonic decrypts the stored record on demand — a cheap
 * local symmetric decrypt against the already-cached DEK, no new WebAuthn/
 * password ceremony — for whatever single operation needs the mnemonic,
 * rather than keeping a long-lived plaintext copy in memory.
 *
 * Deliberately PLAIN JS — no module()/Object.subclass(). This file is
 * served standalone by GET /wallet-vault (core/servers/IdentityServer.js),
 * a page that does NOT load bootstrap.js/the morphic stack/PartsBin (§3.3):
 * the Lively class/module system that module()/Object.subclass() depend on
 * only exists after bootstrap.js runs, so this file can't use it. It mirrors
 * the *shape* of lively.identity.Crypto/WebAuthn (thenDo(err, result)
 * throughout, lazy dependency injection, base64url conventions) without
 * depending on those modules being loaded — this page never loads them.
 *
 * Because of that, every DOM/browser-API touch (document, indexedDB,
 * navigator.credentials, window) happens lazily inside method bodies, never
 * at load time. That's what lets the pure derivation logic in the
 * "derivation" section below also run under plain Node (see
 * scripts/wallet-vault-key-separation-test.js), by injecting
 * global.window = global before requiring this file and this
 * vault-deps.js, and never calling the DOM-dependent methods.
 *
 * §5.1's fix, implemented here exactly as specified: the vault never hands
 * the user's real mnemonic (or any of its low account indices) to
 * generateMasterKeys. Instead it derives a second, synthetic BIP-39
 * mnemonic via a one-way KDF over the real mnemonic's BIP-39 seed, and only
 * that synthetic mnemonic ever reaches generateMasterKeys. The synthetic
 * mnemonic is never persisted separately — it's fully reconstructable from
 * the real mnemonic plus this fixed HKDF salt/info every time (§5.1, §6.1).
 *
 * Storage: a dedicated IndexedDB database (NOT lively.IndexedDB's "identity"
 * store — that store's keys already belong to DID/credential data, per
 * IDENTITY_DESIGN.md §13, and this page doesn't load that module anyway).
 * One record: the mnemonic, encrypted at rest under a DEK wrapped by a KEK
 * from either a WebAuthn PRF ceremony or an Argon2id-derived password key.
 *
 * Async pattern: thenDo(err, result), matching the rest of
 * lively.identity.*.
 */

(function () {
  'use strict';

  var HKDF_SALT = 'lively-wallet-pool-v1';
  var HKDF_INFO = 'pool-account-entropy';
  var PRF_SALT = 'lively-kek-v1'; // same fixed salt lively.identity.WebAuthn.deriveKek uses

  var DB_NAME = 'lively-wallet-vault';
  var DB_VERSION = 1;
  var STORE_NAME = 'wallet';
  var RECORD_KEY = 'wallet-blob';

  function WalletVault() {
    // §8.3: holds the derived DEK while unlocked, NOT the decrypted
    // mnemonic — see _withUnlockedMnemonic below. In-memory only, never
    // persisted, cleared on lock()/reload either way.
    this._unlockedDek = null;
  }

  // ─── vault-deps lazy loading (mirrors WalletCrypto.js's withWalletCryptoLibs) ──

  WalletVault.prototype.withVaultLibs = function (thenDo) {
    var self = this;
    var libs = this._vaultLibs ||
                (typeof window !== 'undefined' && window.walletVaultLibs) ||
                (typeof global !== 'undefined' && global.walletVaultLibs) ||
                null;
    if (libs) return thenDo(null, libs);

    if (typeof document === 'undefined') {
      return thenDo(new Error(
        'vault-deps.js not loaded and no document to inject it into ' +
        '(non-browser context) — set walletVault._vaultLibs directly.'
      ));
    }

    if (window._walletVaultLibsLoading) {
      var poll = setInterval(function () {
        if (window.walletVaultLibs) {
          clearInterval(poll);
          self.withVaultLibs(thenDo);
        }
      }, 50);
      return;
    }

    window._walletVaultLibsLoading = true;
    var s = document.createElement('script');
    s.src = '/core/lib/wallet/vault-deps.js';
    s.onload = function () {
      window._walletVaultLibsLoading = false;
      // The script resource can load successfully yet still fail to set
      // window.walletVaultLibs (e.g. a ReferenceError partway through
      // evaluating the bundle) — treat that as a hard error rather than
      // recursing back into "inject a script" again, which would silently
      // reload and re-throw forever instead of surfacing the failure.
      if (!window.walletVaultLibs) {
        return thenDo(new Error(
          '/core/lib/wallet/vault-deps.js loaded but did not set window.walletVaultLibs ' +
          '— it likely threw while evaluating; check the console.'
        ));
      }
      self.withVaultLibs(thenDo);
    };
    s.onerror = function () {
      window._walletVaultLibsLoading = false;
      thenDo(new Error('Failed to load /core/lib/wallet/vault-deps.js'));
    };
    document.head.appendChild(s);
  };

  // ─── libsodium lazy loading (self-contained copy of Crypto.js's withSodium
  //     pattern — this page doesn't load lively.identity.Crypto). Loads its
  //     OWN build (vault-sodium.js, libsodium-wrappers-SUMO), not the main
  //     world's /core/lib/wallet/vault-sodium.js: the base libsodium-wrappers
  //     package that build uses has no crypto_pwhash (Argon2id) at all —
  //     confirmed at implementation time — only the sumo build does, and
  //     swapping the main world's existing build to sumo is out of scope
  //     here (see scripts/build-wallet-vault-sodium.js's header for the
  //     full reasoning). ───────────────────────────────────────────────────

  WalletVault.prototype.withSodium = function (thenDo) {
    var self = this;
    var _sodium = this._sodium ||
                  (typeof window !== 'undefined' && window.sodium) ||
                  (typeof global !== 'undefined' && global.sodium) ||
                  null;
    if (_sodium) {
      return _sodium.ready.then(function () { thenDo(null, _sodium); })
        .catch(function (err) { thenDo(err); });
    }

    if (typeof document === 'undefined') {
      return thenDo(new Error(
        'libsodium-wrappers not loaded and no document to inject it into ' +
        '(non-browser context) — set walletVault._sodium directly.'
      ));
    }

    if (window._sodiumLoading) {
      var poll = setInterval(function () {
        if (window.sodium) { clearInterval(poll); self.withSodium(thenDo); }
      }, 50);
      return;
    }

    window._sodiumLoading = true;
    var s = document.createElement('script');
    s.src = '/core/lib/wallet/vault-sodium.js';
    s.onload = function () {
      window._sodiumLoading = false;
      if (!window.sodium) {
        return thenDo(new Error(
          '/core/lib/wallet/vault-sodium.js loaded but did not set window.sodium ' +
          '— it likely threw while evaluating; check the console.'
        ));
      }
      self.withSodium(thenDo);
    };
    s.onerror = function () {
      window._sodiumLoading = false;
      thenDo(new Error('Failed to load /core/lib/wallet/vault-sodium.js'));
    };
    document.head.appendChild(s);
  };

  // ─── derivation (pure — no DOM/browser API touched here; Node-loadable) ────

  // BIP-39 mnemonic generation. wordCount: 12 or 24 (§0: "12 or 24 BIP-39 words").
  WalletVault.prototype.generateMnemonic = function (wordCount, thenDo) {
    this.withVaultLibs(function (err, libs) {
      if (err) return thenDo(err);
      try {
        var strength = wordCount === 24 ? 256 : 128;
        thenDo(null, libs.generateMnemonic(strength));
      } catch (e) { thenDo(e); }
    });
  };

  WalletVault.prototype.validateMnemonic = function (mnemonic, thenDo) {
    this.withVaultLibs(function (err, libs) {
      if (err) return thenDo(err);
      try { thenDo(null, libs.validateMnemonic(mnemonic)); }
      catch (e) { thenDo(e); }
    });
  };

  // The §5.1 fix, exactly: HKDF-SHA256 over the real mnemonic's BIP-39 seed
  // (salt/info fixed and versioned, never reused for another derivation
  // purpose) → 32 bytes of entropy → a synthetic 24-word mnemonic. Never
  // handed the real mnemonic's account indices; never persisted — fully
  // reconstructable from the real mnemonic alone every time.
  WalletVault.prototype.deriveSyntheticPoolMnemonic = function (realMnemonic, thenDo) {
    this.withVaultLibs(function (err, libs) {
      if (err) return thenDo(err);
      try {
        var seed = libs.mnemonicToSeedSync(realMnemonic);
        var salt = new TextEncoder().encode(HKDF_SALT);
        var info = new TextEncoder().encode(HKDF_INFO);
        var entropy = libs.hkdfSha256(seed, salt, info, 32);
        thenDo(null, libs.entropyToMnemonic(entropy));
      } catch (e) { thenDo(e); }
    });
  };

  // masterNullifier/masterSecret from the SYNTHETIC pool mnemonic only —
  // never the real one. Calls thenDo(null, { masterNullifier, masterSecret })
  // where both are BigInt (poseidon outputs, per @0xbow/privacy-pools-core-sdk).
  WalletVault.prototype.derivePoolMasterKeys = function (realMnemonic, thenDo) {
    var self = this;
    this.deriveSyntheticPoolMnemonic(realMnemonic, function (err, syntheticMnemonic) {
      if (err) return thenDo(err);
      self.withVaultLibs(function (err2, libs) {
        if (err2) return thenDo(err2);
        try { thenDo(null, libs.generateMasterKeys(syntheticMnemonic)); }
        catch (e) { thenDo(e); }
      });
    });
  };

  // ─── KEK derivation: WebAuthn PRF (primary) ─────────────────────────────

  // No credentialId known ahead of time on this standalone page (no
  // lively.identity.DID loaded to read it from) — omit allowCredentials so
  // the platform shows any discoverable credential for this rpId, and
  // capture the credential actually used so future unlocks can target it
  // directly (options.credentialId, once known).
  WalletVault.prototype._resolveRpId = function () {
    return (typeof window !== 'undefined' && window.WalletVaultConfig && window.WalletVaultConfig.identityRpId) ||
           (typeof window !== 'undefined' && window.location.hostname) ||
           'localhost';
  };

  WalletVault.prototype.deriveKekViaWebAuthn = function (options, thenDo) {
    options = options || {};
    var self = this;
    if (typeof navigator === 'undefined' || !navigator.credentials) {
      return thenDo(new Error('WebAuthn is not available in this browser'));
    }

    var challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    var prfInput = new TextEncoder().encode(PRF_SALT);

    var publicKeyOptions = {
      challenge: challenge,
      rpId: options.rpId || self._resolveRpId(),
      userVerification: 'required',
      extensions: { prf: { eval: { first: prfInput.buffer } } }
    };
    if (options.credentialId) {
      publicKeyOptions.allowCredentials = [
        { type: 'public-key', id: self._base64urlDecode(options.credentialId) }
      ];
    }

    navigator.credentials.get({ publicKey: publicKeyOptions })
      .then(function (credential) {
        var ext = credential.getClientExtensionResults();
        if (!ext.prf || !ext.prf.results || !ext.prf.results.first) {
          return thenDo(new Error(
            'deriveKekViaWebAuthn: PRF extension not available for this credential.'
          ));
        }
        var kek = new Uint8Array(ext.prf.results.first);
        thenDo(null, { kek: kek, credentialId: credential.id, rpId: publicKeyOptions.rpId });
      })
      .catch(function (err) { thenDo(err); });
  };

  // ─── KEK derivation: Argon2id password fallback (libsodium crypto_pwhash) ──

  // Uses libsodium's own INTERACTIVE preset (opslimit=2, memlimit=64MiB),
  // which exceeds §7.1's stated OWASP floor (memory >= 19456 KiB, passes
  // >= 2) — reusing a vetted preset rather than hand-picking custom
  // parameters. Real Argon2id (RFC 9106) via libsodium's crypto_pwhash,
  // not a second WASM dependency (the vault already needs libsodium for
  // crypto_secretbox).
  WalletVault.prototype.deriveKekViaPassword = function (password, saltB64, thenDo) {
    this.withSodium(function (err, sodium) {
      if (err) return thenDo(err);
      try {
        var salt = saltB64
          ? sodium.from_base64(saltB64, sodium.base64_variants.URLSAFE_NO_PADDING)
          : sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
        var kek = sodium.crypto_pwhash(
          32,
          password,
          salt,
          sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
          sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
          sodium.crypto_pwhash_ALG_ARGON2ID13
        );
        thenDo(null, {
          kek: kek,
          salt: sodium.to_base64(salt, sodium.base64_variants.URLSAFE_NO_PADDING)
        });
      } catch (e) { thenDo(e); }
    });
  };

  // ─── wrap/unwrap DEK (self-contained copy of Crypto.js's wrapDek/unwrapDek —
  //     this page doesn't load lively.identity.Crypto) ───────────────────────

  WalletVault.prototype._base64urlEncode = function (bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  };

  WalletVault.prototype._base64urlDecode = function (str) {
    var padded = str + '='.repeat((4 - (str.length % 4)) % 4);
    var binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  WalletVault.prototype.wrapDek = function (kek, thenDo) {
    this.withSodium(function (err, sodium) {
      if (err) return thenDo(err);
      try {
        var dek = sodium.randombytes_buf(32);
        var nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        var wrapped = sodium.crypto_secretbox_easy(dek, nonce, kek);
        var combined = new Uint8Array(nonce.length + wrapped.length);
        combined.set(nonce);
        combined.set(wrapped, nonce.length);
        thenDo(null, {
          dek: dek,
          wrappedDek: sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING)
        });
      } catch (e) { thenDo(e); }
    });
  };

  WalletVault.prototype.unwrapDek = function (wrappedDek, kek, thenDo) {
    this.withSodium(function (err, sodium) {
      if (err) return thenDo(err);
      try {
        var combined = sodium.from_base64(wrappedDek, sodium.base64_variants.URLSAFE_NO_PADDING);
        var nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
        var ct = combined.slice(sodium.crypto_secretbox_NONCEBYTES);
        var dek = sodium.crypto_secretbox_open_easy(ct, nonce, kek);
        if (!dek) return thenDo(new Error('unwrapDek: authentication tag mismatch — wrong KEK or corrupted wrappedDek'));
        thenDo(null, dek);
      } catch (e) { thenDo(e); }
    });
  };

  // ─── IndexedDB (dedicated DB — not lively.IndexedDB's "identity" store) ────

  WalletVault.prototype._withDb = function (thenDo) {
    if (typeof indexedDB === 'undefined') {
      return thenDo(new Error('WalletVault: indexedDB is not available in this context'));
    }
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = function () { thenDo(null, req.result); };
    req.onerror = function () { thenDo(req.error || new Error('WalletVault: failed to open IndexedDB')); };
  };

  WalletVault.prototype._putRecord = function (record, thenDo) {
    this._withDb(function (err, db) {
      if (err) return thenDo(err);
      var tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record, RECORD_KEY);
      tx.oncomplete = function () { thenDo(null); };
      tx.onerror = function () { thenDo(tx.error || new Error('WalletVault: failed to store record')); };
    });
  };

  WalletVault.prototype._getRecord = function (thenDo) {
    this._withDb(function (err, db) {
      if (err) return thenDo(err);
      var tx = db.transaction(STORE_NAME, 'readonly');
      var req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
      req.onsuccess = function () { thenDo(null, req.result || null); };
      req.onerror = function () { thenDo(req.error || new Error('WalletVault: failed to read record')); };
    });
  };

  WalletVault.prototype.isSetUp = function (thenDo) {
    this._getRecord(function (err, record) {
      if (err) return thenDo(err);
      thenDo(null, !!record);
    });
  };

  // ─── setup / import / unlock / lock / reveal ────────────────────────────

  // options: { mnemonic (import) | wordCount (fresh generate, default 12),
  //            kdf: 'webauthn-prf' | 'argon2id', password (required for argon2id) }
  // Calls thenDo(null, { mnemonic }) — the caller is expected to have shown
  // the mnemonic to the user for confirmation before calling this (§8.1's
  // verification-step UI is the vault page's own inline UI, not this method).
  WalletVault.prototype.setup = function (options, thenDo) {
    var self = this;
    options = options || {};

    function withMnemonic(cb) {
      if (options.mnemonic) return cb(null, options.mnemonic);
      self.generateMnemonic(options.wordCount || 12, cb);
    }

    withMnemonic(function (err, mnemonic) {
      if (err) return thenDo(err);
      self.validateMnemonic(mnemonic, function (err2, valid) {
        if (err2) return thenDo(err2);
        if (!valid) return thenDo(new Error('setup: invalid mnemonic'));

        function withKek(cb) {
          if (options.kdf === 'argon2id') {
            if (!options.password) return thenDo(new Error('setup: password required for argon2id'));
            self.deriveKekViaPassword(options.password, null, function (err3, res) {
              if (err3) return cb(err3);
              cb(null, { kek: res.kek, kdf: 'argon2id', argon2Salt: res.salt });
            });
          } else {
            self.deriveKekViaWebAuthn({}, function (err3, res) {
              if (err3) return cb(err3);
              cb(null, { kek: res.kek, kdf: 'webauthn-prf', credentialId: res.credentialId, rpId: res.rpId });
            });
          }
        }

        withKek(function (err3, kekInfo) {
          if (err3) return thenDo(err3);
          self.wrapDek(kekInfo.kek, function (err4, dekInfo) {
            if (err4) return thenDo(err4);
            self.withSodium(function (err5, sodium) {
              if (err5) return thenDo(err5);
              try {
                var payload = JSON.stringify({ mnemonic: mnemonic });
                var nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
                var ciphertext = sodium.crypto_secretbox_easy(
                  sodium.from_string(payload), nonce, dekInfo.dek
                );
                var record = {
                  version: 1,
                  kdf: kekInfo.kdf,
                  wrappedDek: dekInfo.wrappedDek,
                  nonce: sodium.to_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING),
                  ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING),
                  createdAt: new Date().toISOString()
                };
                if (kekInfo.kdf === 'argon2id') {
                  record.argon2Salt = kekInfo.argon2Salt;
                } else {
                  record.credentialId = kekInfo.credentialId;
                  record.rpId = kekInfo.rpId;
                }
                self._putRecord(record, function (err6) {
                  if (err6) return thenDo(err6);
                  // §8.3: cache the DEK, not the mnemonic — see
                  // _withUnlockedMnemonic. dekInfo.dek is already the
                  // unwrapped 32-byte key from wrapDek above.
                  self._unlockedDek = dekInfo.dek;
                  thenDo(null, { mnemonic: mnemonic });
                });
              } catch (e) { thenDo(e); }
            });
          });
        });
      });
    });
  };

  // options: { password } for the argon2id path; {} to trigger a WebAuthn
  // ceremony against the stored credentialId/rpId.
  WalletVault.prototype.unlock = function (options, thenDo) {
    var self = this;
    options = options || {};
    this._getRecord(function (err, record) {
      if (err) return thenDo(err);
      if (!record) return thenDo(new Error('unlock: no wallet set up on this device'));

      function withKek(cb) {
        if (record.kdf === 'argon2id') {
          if (!options.password) return thenDo(new Error('unlock: password required'));
          self.deriveKekViaPassword(options.password, record.argon2Salt, function (err2, res) {
            if (err2) return cb(err2);
            cb(null, res.kek);
          });
        } else {
          self.deriveKekViaWebAuthn({ credentialId: record.credentialId, rpId: record.rpId }, function (err2, res) {
            if (err2) return cb(err2);
            cb(null, res.kek);
          });
        }
      }

      withKek(function (err2, kek) {
        if (err2) return thenDo(err2);
        self.unwrapDek(record.wrappedDek, kek, function (err3, dek) {
          if (err3) return thenDo(err3);
          self.withSodium(function (err4, sodium) {
            if (err4) return thenDo(err4);
            try {
              // Decrypt here only to VERIFY the derived DEK is actually
              // correct (a wrong password/credential must surface as an
              // error, same as before) — the decrypted plaintext itself
              // goes out of scope right after this check. §8.3: cache the
              // DEK, not the mnemonic bytes.
              var nonce = sodium.from_base64(record.nonce, sodium.base64_variants.URLSAFE_NO_PADDING);
              var ct = sodium.from_base64(record.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
              var plaintext = sodium.crypto_secretbox_open_easy(ct, nonce, dek);
              if (!plaintext) return thenDo(new Error('unlock: authentication tag mismatch — wrong password/credential or corrupted data'));
              self._unlockedDek = dek;
              thenDo(null, { ok: true });
            } catch (e) { thenDo(e); }
          });
        });
      });
    });
  };

  WalletVault.prototype.lock = function (thenDo) {
    this._unlockedDek = null;
    if (thenDo) thenDo(null, 'ok');
  };

  WalletVault.prototype.isUnlocked = function () {
    return !!this._unlockedDek;
  };

  // §8.3: the vault holds the DEK at rest while unlocked, not the
  // plaintext mnemonic. This decrypts the stored record on demand using
  // the cached DEK — a cheap local symmetric decrypt, no new WebAuthn/
  // password ceremony — for whatever single operation needs the mnemonic
  // right now, rather than keeping a long-lived decrypted copy in memory.
  // Note on limits: this narrows the window a live reference to the
  // plaintext exists; it doesn't (and can't, from JS) guarantee the bytes
  // are scrubbed from the engine's heap — GC timing isn't under our
  // control. Real hardening, not a promise of erasure.
  WalletVault.prototype._withUnlockedMnemonic = function (thenDo) {
    var self = this;
    if (!self._unlockedDek) return thenDo(new Error('vault is locked'));
    self._getRecord(function (err, record) {
      if (err) return thenDo(err);
      if (!record) return thenDo(new Error('vault is locked'));
      self.withSodium(function (err2, sodium) {
        if (err2) return thenDo(err2);
        try {
          var nonce = sodium.from_base64(record.nonce, sodium.base64_variants.URLSAFE_NO_PADDING);
          var ct = sodium.from_base64(record.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
          var plaintext = sodium.crypto_secretbox_open_easy(ct, nonce, self._unlockedDek);
          if (!plaintext) {
            return thenDo(new Error('_withUnlockedMnemonic: authentication tag mismatch — cached DEK no longer matches the stored record'));
          }
          var payload = JSON.parse(sodium.to_string(plaintext));
          thenDo(null, payload.mnemonic);
        } catch (e) { thenDo(e); }
      });
    });
  };

  // Re-derives the KEK fresh (a real ceremony/password prompt) before
  // revealing, regardless of whether the vault is already unlocked in
  // memory — matches WalletSpec.md §3.4's revealMnemonic contract ("re-runs
  // a fresh WebAuthn/password ceremony first"). Rendered by the vault
  // page's own UI; per §3.4 this never crosses the postMessage boundary in
  // either direction, in any step — not exposed in the RPC responder below.
  WalletVault.prototype.revealMnemonic = function (options, thenDo) {
    var self = this;
    this.unlock(options, function (err) {
      if (err) return thenDo(err);
      self._withUnlockedMnemonic(thenDo);
    });
  };

  // Requires an unlocked vault. Re-derives the synthetic pool mnemonic and
  // master keys fresh from the on-demand-decrypted real mnemonic every
  // call — never cached, never persisted (§5.1, §5.3).
  WalletVault.prototype.getPoolMasterKeys = function (thenDo) {
    var self = this;
    this._withUnlockedMnemonic(function (err, mnemonic) {
      if (err) return thenDo(new Error('getPoolMasterKeys: ' + err.message));
      self.derivePoolMasterKeys(mnemonic, thenDo);
    });
  };

  // §15 step 3: the "trivial method" WalletBridge's postMessage plumbing
  // is proven against. §5.1: derived from the REAL mnemonic's account
  // index 0 directly — the ordinary Ethereum spending key, never routed
  // through the synthetic pool mnemonic. Requires an already-unlocked
  // vault — deliberately simple; auto-prompting an unlock here is a later
  // UI-flow concern (§8.3), not this method's job.
  WalletVault.prototype.getAddress = function (thenDo) {
    var self = this;
    this._withUnlockedMnemonic(function (err, mnemonic) {
      if (err) return thenDo(new Error('getAddress: ' + err.message));
      self.withVaultLibs(function (err2, libs) {
        if (err2) return thenDo(err2);
        try {
          thenDo(null, libs.mnemonicToAccount(mnemonic, { accountIndex: 0 }).address);
        } catch (e) { thenDo(e); }
      });
    });
  };

  // ─── same-origin dev-fallback detection (§3.2) ──────────────────────────
  // Self-contained — no coordination needed from whatever embeds this page.
  // Succeeds only when genuinely same-origin (dev fallback, no real cross-
  // origin infra exists in this codebase yet); a real cross-origin embed
  // makes window.top.location inaccessible, so this throws and both the
  // banner and the RPC responder's origin check below naturally stop
  // trusting it — exactly the behavior wanted once a real second origin
  // exists in a later step, with no code change required here.
  function sameOriginParentOrigin() {
    if (window.self === window.top) return null; // not embedded at all
    try {
      var origin = window.top.location.origin;
      return origin === window.location.origin ? origin : null;
    } catch (e) {
      return null;
    }
  }

  // ─── reduced-isolation dev-mode banner (§3.2's checklist item: "actually
  //     renders and is unmissable when identityWalletOrigin is unset") ────

  function renderReducedIsolationBannerIfNeeded() {
    if (!sameOriginParentOrigin()) return;
    var banner = document.createElement('div');
    banner.textContent =
      'Running in reduced-isolation dev mode — the wallet vault is NOT ' +
      'cross-origin isolated. Never use this configuration in production.';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
      'background:#b00020;color:#fff;font:bold 13px/1.4 sans-serif;' +
      'padding:6px 10px;text-align:center;';
    document.body.appendChild(banner);
  }

  // ─── postMessage RPC responder (vault side, §3.4) ───────────────────────
  // Only registered when embedded — direct navigation to /wallet-vault (as
  // in step 2's own testing) never sets this up, matching §3.3's shape:
  // the vault's RPC surface only exists once something has actually
  // embedded it.
  //
  // Method allowlist is deliberately narrow — only what's reachable as of
  // WalletSpec.md §15 step 3: setup/unlock/lock/getAddress. revealMnemonic
  // is NEVER exposed here — see its own comment above; it renders inside
  // the vault's own UI and never crosses this boundary, in any step.

  var RPC_METHODS = {
    setup:      function (params, cb) { window.lively.identity.walletVault.setup(params, cb); },
    unlock:     function (params, cb) { window.lively.identity.walletVault.unlock(params, cb); },
    lock:       function (params, cb) { window.lively.identity.walletVault.lock(cb); },
    getAddress: function (params, cb) { window.lively.identity.walletVault.getAddress(cb); }
  };

  function startRpcResponder() {
    if (window.self === window.top) return; // not embedded, nothing to serve

    window.addEventListener('message', function (event) {
      var expectedOrigin = sameOriginParentOrigin();
      if (!expectedOrigin || event.origin !== expectedOrigin) return;
      if (event.source !== window.top) return;

      var msg = event.data;
      if (!msg || typeof msg.id === 'undefined' || !msg.method) return;

      var handler = RPC_METHODS[msg.method];
      if (!handler) {
        return event.source.postMessage(
          { id: msg.id, error: { message: 'Unknown method: ' + msg.method }, result: null },
          expectedOrigin
        );
      }
      handler(msg.params, function (err, result) {
        event.source.postMessage(
          { id: msg.id, error: err ? { message: err.message } : null, result: result === undefined ? null : result },
          expectedOrigin
        );
      });
    });
  }

  // ─── singleton, namespaced to match WalletSpec.md §11's module map ─────────

  window.lively = window.lively || {};
  window.lively.identity = window.lively.identity || {};
  window.lively.identity.WalletVault = WalletVault;
  window.lively.identity.walletVault = new WalletVault();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WalletVault;
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    renderReducedIsolationBannerIfNeeded();
    startRpcResponder();
  }
})();
