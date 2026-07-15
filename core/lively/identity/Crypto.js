/**
 * lively.identity.Crypto
 *
 * Pure cryptographic utilities for the Lively identity system.
 * No Lively UI deps, no WebAuthn — fully testable in isolation.
 *
 * Responsibilities:
 *   - base64url encode/decode and canonical JSON serialization
 *   - ES256 (ECDSA P-256) key generation, import/export, sign, verify (Web Crypto API)
 *   - JWS Compact Serialization (sign + verify)
 *   - Object envelope signing and verification
 *   - ObjID computation (SHA-256 of canonical JWK, first 12 chars base64url)
 *   - CID computation (BLAKE2b-256 via libsodium crypto_generichash)
 *   - Symmetric encryption/decryption (XSalsa20-Poly1305 via libsodium crypto_secretbox_easy)
 *   - ECDH sealed-box key wrapping (X25519 via libsodium crypto_box_seal)
 *
 * Async pattern: all async ops take a final `thenDo(err, result)` callback,
 * consistent with Lively's WebResource and lively.bindings signal patterns.
 *
 * libsodium dependency: withSodium() lazily injects
 * /core/lib/libsodium/sodium.js (built by scripts/build-libsodium.js, which
 * runs automatically via the postinstall npm script) the first time it's
 * needed, so callers don't need to load it themselves. The sodium global
 * exposes `sodium.ready` (a Promise), matching libsodium-wrappers' classic
 * API.
 */

module('lively.identity.Crypto')
  .requires()
  // Note: libsodium-wrappers is NOT a Lively module so it cannot appear in
  // .requires() — withSodium() injects it as a plain script on first use.
  .toRun(function() {

Object.subclass('lively.identity.Crypto',

// ─── base64url & canonical JSON ──────────────────────────────────────────────

'base64url', {

  base64urlEncode: function(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  },

  base64urlDecode: function(str) {
    // Restore standard base64 padding
    var padded = str + '='.repeat((4 - (str.length % 4)) % 4);
    var binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  },

  // Deterministic JSON serialization with recursively sorted keys (RFC 8785 spirit).
  // Used for signing so key ordering doesn't affect the digest regardless of engine.
  canonicalJson: function(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) {
      var self = this;
      return '[' + obj.map(function(item) { return self.canonicalJson(item); }).join(',') + ']';
    }
    var self = this;
    var keys = Object.keys(obj).sort();
    return '{' + keys.map(function(k) {
      return JSON.stringify(k) + ':' + self.canonicalJson(obj[k]);
    }).join(',') + '}';
  },

  // Canonical form of a JWK per RFC 7638 §3.2: only the required members for
  // the key type, lexicographically sorted. Extra fields (key_ops, ext, use,
  // alg, kid, d) are excluded so the thumbprint is stable regardless of what
  // crypto.subtle.exportKey returns.
  canonicalizeJwk: function(jwk) {
    var required;
    if (jwk.kty === 'EC') {
      required = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
    } else if (jwk.kty === 'OKP') {
      required = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
    } else {
      required = { kty: jwk.kty };
    }
    return this.canonicalJson(required);
  }

},

// ─── ECDSA P-256 key management ──────────────────────────────────────────────

'keys', {

  generateSigningKeyPair: function(thenDo) {
    crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,  // extractable so we can export JWK for storage
      ['sign', 'verify']
    ).then(function(keyPair) {
      thenDo(null, keyPair);
    }).catch(function(err) { thenDo(err); });
  },

  exportPublicKeyJwk: function(cryptoKey, thenDo) {
    crypto.subtle.exportKey('jwk', cryptoKey)
      .then(function(jwk) { thenDo(null, jwk); })
      .catch(function(err) { thenDo(err); });
  },

  exportPrivateKeyJwk: function(cryptoKey, thenDo) {
    crypto.subtle.exportKey('jwk', cryptoKey)
      .then(function(jwk) { thenDo(null, jwk); })
      .catch(function(err) { thenDo(err); });
  },

  importPublicKeyJwk: function(jwk, thenDo) {
    crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify']
    ).then(function(key) { thenDo(null, key); })
    .catch(function(err) { thenDo(err); });
  },

  importPrivateKeyJwk: function(jwk, thenDo) {
    crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign']
    ).then(function(key) { thenDo(null, key); })
    .catch(function(err) { thenDo(err); });
  },

  // Convert a DER-encoded ECDSA signature (ASN.1 SEQUENCE of two INTEGERs
  // r, s — the format a real WebAuthn assertion signature comes in, per the
  // WebAuthn/CTAP2 spec) to the raw r||s format crypto.subtle.verify
  // requires for ECDSA (Web Crypto always uses raw IEEE P1363, never DER).
  // P-256 only (32-byte r/s, 64-byte output). Throws on malformed input.
  derToRawEcdsaSignature: function(derBytes) {
    var bytes = derBytes instanceof Uint8Array ? derBytes : new Uint8Array(derBytes);
    if (bytes[0] !== 0x30) throw new Error('derToRawEcdsaSignature: not a DER SEQUENCE');
    // P-256 signatures are always short enough for single-byte DER lengths
    // (content length <= ~70 bytes, well under the 0x80 long-form threshold).
    var offset = 2;
    if (bytes[offset] !== 0x02) throw new Error('derToRawEcdsaSignature: expected INTEGER (r)');
    var rLen = bytes[offset + 1];
    var rStart = offset + 2;
    var rBytes = bytes.slice(rStart, rStart + rLen);
    offset = rStart + rLen;
    if (bytes[offset] !== 0x02) throw new Error('derToRawEcdsaSignature: expected INTEGER (s)');
    var sLen = bytes[offset + 1];
    var sStart = offset + 2;
    var sBytes = bytes.slice(sStart, sStart + sLen);

    function toFixed32(intBytes) {
      // DER INTEGER is signed — a leading 0x00 pad byte is present whenever
      // the true value's high bit would otherwise look negative. Strip it,
      // then left-pad (with zeros) to the fixed 32-byte P-256 field width.
      var b = intBytes;
      if (b.length > 32 && b[0] === 0x00) b = b.slice(1);
      if (b.length > 32) throw new Error('derToRawEcdsaSignature: integer too long for P-256');
      var out = new Uint8Array(32);
      out.set(b, 32 - b.length);
      return out;
    }

    var raw = new Uint8Array(64);
    raw.set(toFixed32(rBytes), 0);
    raw.set(toFixed32(sBytes), 32);
    return raw;
  }

},

// ─── ObjID ───────────────────────────────────────────────────────────────────

'objId', {

  // ObjID = base64url(SHA-256(canonicalJwk))[0..12]
  // Used for the home manifest (backed by a held device key). All other objects
  // use computeGenesisObjId below.
  computeObjId: function(publicKeyJwk, thenDo) {
    var self = this;
    var canonical = this.canonicalizeJwk(publicKeyJwk);
    var encoded = new TextEncoder().encode(canonical);
    crypto.subtle.digest('SHA-256', encoded)
      .then(function(hash) {
        thenDo(null, self.base64urlEncode(new Uint8Array(hash)).slice(0, 12));
      })
      .catch(function(err) { thenDo(err); });
  },

  // objId = base64url(SHA-256(authorDid + ":" + base64url(genesisNonce)))[0..12]
  // Self-certifying: the genesis envelope proves it hashes to this objId;
  // every version chains via prevCid; every version is signed by its author.
  // No per-object private key exists.
  //
  // authorDid: String — the author's did:jwk string
  // genesisNonce: Uint8Array (16 bytes) — caller provides fresh random bytes
  // thenDo(null, objId) where objId is a 12-char base64url string.
  computeGenesisObjId: function(authorDid, genesisNonce, thenDo) {
    var self = this;
    var nonceB64 = self.base64urlEncode(genesisNonce);
    var input = new TextEncoder().encode(authorDid + ':' + nonceB64);
    crypto.subtle.digest('SHA-256', input)
      .then(function(hash) {
        thenDo(null, self.base64urlEncode(new Uint8Array(hash)).slice(0, 12));
      })
      .catch(function(err) { thenDo(err); });
  }

},

// ─── libsodium bridge ────────────────────────────────────────────────────────

'sodium', {

  // Ensures libsodium is loaded and initialized, then calls thenDo(null, sodium).
  // libsodium-wrappers exposes `window.sodium` with a `.ready` Promise. If it
  // isn't present yet in a browser context, lazily injects the bundled build
  // (see scripts/build-libsodium.js) the same way PostCardEditor._ensureRuntime
  // does for Yjs/ProseMirror — so callers don't each need their own loading logic.
  //
  // For Node.js testing, inject a sodium instance directly:
  //   lively.identity.crypto._sodium = require('libsodium-wrappers');
  withSodium: function(thenDo) {
    var self = this;
    var _sodium = this._sodium ||
                  (typeof window !== 'undefined' && window.sodium) ||
                  (typeof global !== 'undefined' && global.sodium) ||
                  (typeof sodium !== 'undefined' && sodium) ||
                  null;
    if (_sodium) {
      return _sodium.ready.then(function() { thenDo(null, _sodium); })
        .catch(function(err) { thenDo(err); });
    }

    if (typeof document === 'undefined') {
      return thenDo(new Error(
        'libsodium-wrappers not loaded and no document to inject it into ' +
        '(non-browser context) — set lively.identity.crypto._sodium directly.'
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
    s.src = '/core/lib/libsodium/sodium.js';
    s.onload = function () { window._sodiumLoading = false; self.withSodium(thenDo); };
    s.onerror = function () {
      window._sodiumLoading = false;
      thenDo(new Error('Failed to load /core/lib/libsodium/sodium.js'));
    };
    document.head.appendChild(s);
  }

},

// ─── hashing ─────────────────────────────────────────────────────────────────

'hashing', {

  // CID = base64url(SHA-256(canonicalJson(payload)))
  // Uses Web Crypto API — no external dependency required.
  computeCid: function(payload, thenDo) {
    var self = this;
    try {
      var json = typeof payload === 'string' ? payload : JSON.stringify(payload);
      self.sha256(json, thenDo);
    } catch (e) { thenDo(e); }
  },

  // SHA-256 via Web Crypto, returns base64url string.
  sha256: function(data, thenDo) {
    var self = this;
    var bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    crypto.subtle.digest('SHA-256', bytes)
      .then(function(hash) {
        thenDo(null, self.base64urlEncode(new Uint8Array(hash)));
      })
      .catch(function(err) { thenDo(err); });
  }

},

// ─── JWS & envelope signing ──────────────────────────────────────────────────

'signing', {

  // Sign any JSON-serializable payload with ES256.
  // Returns a JWS Compact Serialization string: header.payload.signature
  // The payload is canonicalJson(payload) for objects, or the raw string if a string.
  signJws: function(payload, privateKey, thenDo) {
    var self = this;
    var header = { alg: 'ES256' };
    var headerB64 = self.base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
    var canonical = typeof payload === 'string' ? payload : self.canonicalJson(payload);
    var payloadB64 = self.base64urlEncode(new TextEncoder().encode(canonical));
    var signingInput = new TextEncoder().encode(headerB64 + '.' + payloadB64);

    crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      privateKey,
      signingInput
    ).then(function(signature) {
      thenDo(null, headerB64 + '.' + payloadB64 + '.' + self.base64urlEncode(new Uint8Array(signature)));
    }).catch(function(err) { thenDo(err); });
  },

  // Verify a JWS Compact string against a public key JWK.
  // Calls thenDo(null, true|false).
  verifyJws: function(jws, publicKeyJwk, thenDo) {
    var self = this;
    var parts = jws.split('.');
    if (parts.length !== 3) return thenDo(new Error('Invalid JWS compact: expected 3 parts'));

    var signingInput = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    var signature = self.base64urlDecode(parts[2]);

    self.importPublicKeyJwk(publicKeyJwk, function(err, cryptoKey) {
      if (err) return thenDo(err);
      crypto.subtle.verify(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        cryptoKey,
        signature,
        signingInput
      ).then(function(valid) { thenDo(null, valid); })
      .catch(function(err) { thenDo(err); });
    });
  },

  // IDENTITY: signEnvelope and verifyEnvelope are deferred.
  // Public object envelopes will use WebAuthn assertion signing (the challenge
  // will be SHA-256(canonicalJson(envelopeWithoutSig))) in a future iteration.
  // Private object envelopes are tamper-protected by libsodium authentication
  // tags on the ciphertext (XSalsa20-Poly1305 includes an auth tag).
  // signJws and verifyJws below are kept — they will be wired to WebAuthn
  // assertion verification when signing is implemented.

},

// ─── symmetric encryption (XSalsa20-Poly1305) ────────────────────────────────

'encryption', {

  // Encrypt a JSON-serializable payload with a 32-byte symmetric key.
  // encKey: Uint8Array (32 bytes) or base64url string.
  // Returns thenDo(null, { ciphertext: <base64url>, nonce: <base64url> }).
  encryptPayload: function(payload, encKey, thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var json = typeof payload === 'string' ? payload : JSON.stringify(payload);
        var message = sodium.from_string(json);
        var nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        var keyBytes = encKey instanceof Uint8Array
          ? encKey
          : sodium.from_base64(encKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        var ciphertext = sodium.crypto_secretbox_easy(message, nonce, keyBytes);
        thenDo(null, {
          ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING),
          nonce:      sodium.to_base64(nonce,       sodium.base64_variants.URLSAFE_NO_PADDING)
        });
      } catch (e) { thenDo(e); }
    });
  },

  // Generate a fresh random 32-byte DEK and wrap it under a KEK.
  // Returns thenDo(null, { dek: Uint8Array[32], wrappedDek: base64url }).
  // The wrappedDek is stored in the envelope; the dek is used for encryption
  // and then discarded. To recover the dek, call unwrapDek(wrappedDek, kek).
  wrapDek: function(kek, thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var dek = sodium.randombytes_buf(32); // fresh random DEK
        var kekBytes = kek instanceof Uint8Array
          ? kek
          : sodium.from_base64(kek, sodium.base64_variants.URLSAFE_NO_PADDING);
        var nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        var wrapped = sodium.crypto_secretbox_easy(dek, nonce, kekBytes);
        // Store nonce prepended to ciphertext so unwrapDek is self-contained
        var combined = new Uint8Array(nonce.length + wrapped.length);
        combined.set(nonce);
        combined.set(wrapped, nonce.length);
        thenDo(null, {
          dek: dek,
          wrappedDek: sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING)
        });
      } catch (e) { thenDo(e); }
    });
  },

  // Unwrap a DEK that was wrapped by wrapDek.
  // wrappedDek: base64url string produced by wrapDek.
  // kek: Uint8Array or base64url string (32 bytes).
  // Returns thenDo(null, Uint8Array[32] dek).
  unwrapDek: function(wrappedDek, kek, thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var combined = sodium.from_base64(wrappedDek, sodium.base64_variants.URLSAFE_NO_PADDING);
        var nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
        var ct = combined.slice(sodium.crypto_secretbox_NONCEBYTES);
        var kekBytes = kek instanceof Uint8Array
          ? kek
          : sodium.from_base64(kek, sodium.base64_variants.URLSAFE_NO_PADDING);
        var dek = sodium.crypto_secretbox_open_easy(ct, nonce, kekBytes);
        if (!dek) return thenDo(new Error('unwrapDek: authentication tag mismatch — wrong KEK or corrupted wrappedDek'));
        thenDo(null, dek);
      } catch (e) { thenDo(e); }
    });
  },

  // Decrypt a ciphertext produced by encryptPayload.
  // ciphertext, nonce: base64url strings or Uint8Arrays.
  // encKey: Uint8Array (32 bytes) or base64url string.
  // Calls thenDo(null, parsedObject) on success.
  decryptPayload: function(ciphertext, nonce, encKey, thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var ctBytes = ciphertext instanceof Uint8Array
          ? ciphertext
          : sodium.from_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
        var nonceBytes = nonce instanceof Uint8Array
          ? nonce
          : sodium.from_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING);
        var keyBytes = encKey instanceof Uint8Array
          ? encKey
          : sodium.from_base64(encKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        var plaintext = sodium.crypto_secretbox_open_easy(ctBytes, nonceBytes, keyBytes);
        if (!plaintext) return thenDo(new Error('Decryption failed: authentication tag mismatch'));

        thenDo(null, JSON.parse(sodium.to_string(plaintext)));
      } catch (e) { thenDo(e); }
    });
  }

},

// ─── ECDH sealed-box key wrapping (X25519) ───────────────────────────────────

'ecdh', {

  // Encrypt (seal) a symmetric key for a recipient's X25519 public key.
  // encKey: Uint8Array or base64url string.
  // recipientX25519PubKey: Uint8Array or base64url string (32 bytes, X25519 public key).
  // Returns thenDo(null, <base64url sealed-box string>).
  sealForRecipient: function(encKey, recipientX25519PubKey, thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var keyBytes = encKey instanceof Uint8Array
          ? encKey
          : sodium.from_base64(encKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        var pubBytes = recipientX25519PubKey instanceof Uint8Array
          ? recipientX25519PubKey
          : sodium.from_base64(recipientX25519PubKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        var sealed = sodium.crypto_box_seal(keyBytes, pubBytes);
        thenDo(null, sodium.to_base64(sealed, sodium.base64_variants.URLSAFE_NO_PADDING));
      } catch (e) { thenDo(e); }
    });
  },

  // Open a sealed box (decrypt a wrapped key for a recipient).
  // wrappedKey: base64url string or Uint8Array.
  // recipientX25519PubKey, recipientX25519PrivKey: Uint8Array or base64url strings.
  // Returns thenDo(null, <Uint8Array encKey>).
  openSealedBox: function(wrappedKey, recipientX25519PubKey, recipientX25519PrivKey, thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var wrappedBytes = wrappedKey instanceof Uint8Array
          ? wrappedKey
          : sodium.from_base64(wrappedKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        var pubBytes = recipientX25519PubKey instanceof Uint8Array
          ? recipientX25519PubKey
          : sodium.from_base64(recipientX25519PubKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        var privBytes = recipientX25519PrivKey instanceof Uint8Array
          ? recipientX25519PrivKey
          : sodium.from_base64(recipientX25519PrivKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        var decrypted = sodium.crypto_box_seal_open(wrappedBytes, pubBytes, privBytes);
        if (!decrypted) return thenDo(new Error('Failed to open sealed box: wrong key or corrupted data'));
        thenDo(null, decrypted);
      } catch (e) { thenDo(e); }
    });
  },

  // Generate a random X25519 key pair for ECDH key wrapping.
  // Returns thenDo(null, { publicKey: <base64url>, privateKey: <base64url> }).
  // In production, the recipient's X25519 key pair is derived in WebAuthn.js:
  // PRF gives 32 bytes → private key; crypto_scalarmult_base → public key.
  // Use this generator for tests and initial setup only.
  generateX25519KeyPair: function(thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var keyPair = sodium.crypto_box_keypair();
        thenDo(null, {
          publicKey:  sodium.to_base64(keyPair.publicKey,  sodium.base64_variants.URLSAFE_NO_PADDING),
          privateKey: sodium.to_base64(keyPair.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING)
        });
      } catch (e) { thenDo(e); }
    });
  }

});

// Singleton: lively.identity.crypto.computeCid(...), .encryptPayload(...), etc.
lively.identity.crypto = new lively.identity.Crypto();

}); // end module('lively.identity.Crypto')
