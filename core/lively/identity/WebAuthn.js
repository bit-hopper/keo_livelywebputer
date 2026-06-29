/**
 * lively.identity.WebAuthn
 *
 * Browser WebAuthn API wrapper for the Lively identity system.
 *
 * Responsibilities:
 *   - Credential registration: create a new passkey, extract the public key
 *     as JWK, return everything needed to build a DID verification method.
 *   - Credential authentication: get a WebAuthn assertion for a challenge
 *     issued by the server, return the raw assertion for server-side
 *     verification (handled by core/servers/identity/AuthMiddleware.js).
 *   - PRF key derivation: use the WebAuthn PRF extension (Level 3) to derive
 *     a deterministic 32-byte symmetric key per (credential, objId) pair,
 *     for use by lively.identity.Crypto.encryptPayload / decryptPayload.
 *   - X25519 key derivation: derive an X25519 key pair from PRF output so
 *     a recipient can open sealed boxes encrypted for their DID.
 *   - Credential roster management: persist the list of registered credential
 *     IDs + metadata in lively.IndexedDB under the 'identity' store so the
 *     correct credential can be selected on subsequent logins.
 *
 * Async pattern: all async operations use thenDo(err, result) callbacks,
 * consistent with lively.identity.Crypto and lively.net.WebSocket patterns.
 *
 * Dependencies:
 *   - lively.identity.Crypto  — COSE-to-JWK conversion, base64url, canonicalJson
 *   - lively.IndexedDB        — credential roster persistence (already in lively)
 *   - lively.LocalStorage     — lightweight flags (e.g. "has any credential?")
 *   - libsodium-wrappers      — X25519 key derivation from PRF bytes
 *     (loaded as /lib/libsodium/sodium.js; not a Lively module)
 *
 * WebAuthn PRF extension note:
 *   The PRF extension is defined in WebAuthn Level 3 (W3C Editor's Draft).
 *   At time of writing it is supported in Chrome 116+, Edge 116+, Safari 17+.
 *   Firefox does not yet support it. The module degrades gracefully — if PRF
 *   is unavailable, encryption-dependent features (private worlds) are
 *   disabled, but registration, authentication, and signing still work.
 */

module("lively.identity.WebAuthn")
  .requires("lively.identity.Crypto")
  .toRun(function () {
    Object.subclass(
      "lively.identity.WebAuthn",

      // ─── availability ─────────────────────────────────────────────────────────────

      "availability",
      {
        // True if the WebAuthn browser API is present.
        isAvailable: function () {
          return (
            typeof window !== "undefined" &&
            typeof window.PublicKeyCredential !== "undefined"
          );
        },

        // Calls thenDo(null, true|false) — true means platform authenticator
        // (passkey) is available on this device. On non-platform devices or
        // incognito/restricted contexts this may return false.
        isPlatformAuthenticatorAvailable: function (thenDo) {
          if (!this.isAvailable()) return thenDo(null, false);
          PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
            .then(function (result) {
              thenDo(null, result);
            })
            .catch(function (err) {
              thenDo(err);
            });
        },

        // True if the WebAuthn PRF extension is likely available.
        // This is a heuristic — definitive confirmation only comes from attempting
        // a registration or authentication with the PRF extension requested.
        isPrfLikelyAvailable: function () {
          // PRF is a Level 3 feature; PublicKeyCredential.getClientCapabilities()
          // is the spec API, but polyfill via UA detection is more reliable today.
          // We return true optimistically and let the actual call fail gracefully.
          return this.isAvailable();
        },
      },

      // ─── COSE → JWK conversion ────────────────────────────────────────────────────

      "cose",
      {
        // Convert a COSE_Key (from authenticatorData, as ArrayBuffer) to JWK.
        //
        // We handle the subset of COSE algorithms used with passkeys:
        //   -7  → EC P-256 (ES256)    most common
        //   -8  → Ed25519 (EdDSA)     newer platform authenticators
        //  -257 → RSA-PKCS1-SHA256    legacy; we do not support this
        //
        // The COSE key is CBOR-encoded. We use a minimal CBOR decoder here to
        // avoid adding a CBOR library dependency — only the subset of CBOR used
        // by WebAuthn attestation is needed.
        //
        // Calls thenDo(null, jwk).
        coseKeyToJwk: function (coseKeyBuffer, thenDo) {
          try {
            var bytes = new Uint8Array(coseKeyBuffer);
            var decoded = this._decodeCborMap(bytes, 0);
            var map = decoded.value;

            // COSE key type (kty): 2 = EC, 1 = OKP
            var kty = map[1];
            // COSE algorithm: -7 = ES256, -8 = EdDSA
            var alg = map[3];

            // Hoist to avoid shadowing window.crypto or duplicate var declarations
            var c = lively.identity.crypto;
            var x, y;

            if (kty === 2 && alg === -7) {
              // EC P-256: crv=-1(256), x=-2, y=-3
              x = map[-2]; // Uint8Array, 32 bytes
              y = map[-3]; // Uint8Array, 32 bytes
              thenDo(null, {
                kty: "EC",
                crv: "P-256",
                x: c.base64urlEncode(x),
                y: c.base64urlEncode(y),
                ext: true,
              });
            } else if (kty === 1 && alg === -8) {
              // OKP Ed25519: x=-2
              x = map[-2];
              thenDo(null, {
                kty: "OKP",
                crv: "Ed25519",
                x: c.base64urlEncode(x),
                ext: true,
              });
            } else {
              thenDo(
                new Error(
                  "Unsupported COSE key type/algorithm: kty=" +
                    kty +
                    " alg=" +
                    alg +
                    ". Only EC P-256 (ES256/-7) and OKP Ed25519 (EdDSA/-8) are supported.",
                ),
              );
            }
          } catch (e) {
            thenDo(e);
          }
        },

        // Minimal CBOR decoder for WebAuthn COSE key maps.
        // Returns { value: <parsed>, nextOffset: <number> }.
        // Handles: unsigned int, negative int, bytes, text, array, map.
        // Does NOT handle: tags, floats, indefinite-length items (not used in COSE keys).
        _decodeCborMap: function (bytes, offset) {
          var initialByte = bytes[offset++];
          var majorType = (initialByte >> 5) & 0x07;
          var additionalInfo = initialByte & 0x1f;

          var length = this._cborReadLength(bytes, offset, additionalInfo);
          offset = length.nextOffset;
          var n = length.value;

          if (majorType === 0) {
            // unsigned integer
            return { value: n, nextOffset: offset };
          }
          if (majorType === 1) {
            // negative integer
            return { value: -1 - n, nextOffset: offset };
          }
          if (majorType === 2) {
            // byte string
            var slice = bytes.slice(offset, offset + n);
            return { value: slice, nextOffset: offset + n };
          }
          if (majorType === 3) {
            // text string
            var textBytes = bytes.slice(offset, offset + n);
            return {
              value: new TextDecoder().decode(textBytes),
              nextOffset: offset + n,
            };
          }
          if (majorType === 4) {
            // array
            var arr = [];
            for (var i = 0; i < n; i++) {
              var item = this._decodeCborMap(bytes, offset);
              arr.push(item.value);
              offset = item.nextOffset;
            }
            return { value: arr, nextOffset: offset };
          }
          if (majorType === 5) {
            // map
            var map = {};
            for (var i = 0; i < n; i++) {
              var key = this._decodeCborMap(bytes, offset);
              offset = key.nextOffset;
              var val = this._decodeCborMap(bytes, offset);
              offset = val.nextOffset;
              map[key.value] = val.value;
            }
            return { value: map, nextOffset: offset };
          }
          throw new Error("Unsupported CBOR major type: " + majorType);
        },

        _cborReadLength: function (bytes, offset, additionalInfo) {
          if (additionalInfo < 24) {
            return { value: additionalInfo, nextOffset: offset };
          }
          if (additionalInfo === 24) {
            return { value: bytes[offset], nextOffset: offset + 1 };
          }
          if (additionalInfo === 25) {
            return {
              value: (bytes[offset] << 8) | bytes[offset + 1],
              nextOffset: offset + 2,
            };
          }
          if (additionalInfo === 26) {
            return {
              value:
                ((bytes[offset] << 24) |
                  (bytes[offset + 1] << 16) |
                  (bytes[offset + 2] << 8) |
                  bytes[offset + 3]) >>>
                0,
              nextOffset: offset + 4,
            };
          }
          throw new Error(
            "CBOR length encoding not supported: additionalInfo=" +
              additionalInfo,
          );
        },

        // Extract the public key bytes from an authenticatorData buffer.
        // authenticatorData layout (per WebAuthn spec §6.1):
        //   [0..31]  rpIdHash (32 bytes)
        //   [32]     flags (1 byte)
        //   [33..36] signCount (4 bytes, big-endian)
        //   [37..]   attestedCredentialData (if AT flag set)
        //     [37..52]  aaguid (16 bytes)
        //     [53..54]  credentialIdLength (2 bytes, big-endian)
        //     [55..55+credentialIdLength-1]  credentialId
        //     [55+credentialIdLength..]      credentialPublicKey (COSE key, CBOR)
        extractPublicKeyFromAuthData: function (authDataBuffer, thenDo) {
          var bytes = new Uint8Array(authDataBuffer);
          var flags = bytes[32];
          var AT = (flags >> 6) & 1; // Attested Credential Data present
          if (!AT) {
            return thenDo(
              new Error(
                "authenticatorData has no attested credential data (AT flag not set)",
              ),
            );
          }
          var credIdLen = (bytes[53] << 8) | bytes[54];
          var coseKeyOffset = 55 + credIdLen;
          var coseKeyBytes = bytes.slice(coseKeyOffset);
          this.coseKeyToJwk(coseKeyBytes.buffer, function (err, jwk) {
            if (err) return thenDo(err);
            // Pass raw COSE bytes as 3rd arg so register() can include them
            // in the roster — @simplewebauthn/server needs Uint8Array COSE bytes
            // for verifyAuthenticationResponse (not JWK).
            thenDo(null, jwk, coseKeyBytes);
          });
        },
      },

      // ─── registration ─────────────────────────────────────────────────────────────

      "registration",
      {
        // Register a new passkey for a user.
        //
        // options: {
        //   handle:      String   — the user's chosen handle (e.g. "alice")
        //   displayName: String   — human-readable name shown in the OS dialog
        //   rpId:        String   — relying party ID (e.g. "example.com" or "localhost")
        //   rpName:      String   — relying party display name
        //   challenge:   Uint8Array|ArrayBuffer  — random bytes from server
        //                           (GET /identity/challenge before calling this)
        //   requestPrf:  Boolean  — request PRF extension for encryption (default: true)
        // }
        //
        // Calls thenDo(null, {
        //   credentialId:  String         — base64url credential ID
        //   publicKeyJwk:  Object         — JWK of the credential public key
        //   attestationObject: String     — base64url, send to server for verification
        //   clientDataJSON:    String     — base64url, send to server for verification
        //   prfAvailable:  Boolean        — true if PRF extension was granted
        // })
        register: function (options, thenDo) {
          var self = this;
          if (!this.isAvailable()) {
            return thenDo(
              new Error("WebAuthn is not available in this browser"),
            );
          }

          var handle = options.handle || "user";
          var displayName = options.displayName || handle;
          var rpId = options.rpId || (lively.Config && lively.Config.get('identityRpId')) || window.location.hostname;
          var rpName = options.rpName || "Lively";
          var requestPrf = options.requestPrf !== false; // default true

          // userId: deterministic from handle so re-registration on same device
          // finds the same resident key slot. SHA-256 of handle bytes.
          var userIdBytes = new TextEncoder().encode("lively-user:" + handle);

          var publicKeyOptions = {
            challenge: options.challenge,
            rp: { id: rpId, name: rpName },
            user: {
              id: userIdBytes,
              name: handle,
              displayName: displayName,
            },
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },   // ES256 (P-256) — preferred
              { type: "public-key", alg: -8 },   // EdDSA (Ed25519) — newer devices
              { type: "public-key", alg: -257 }, // RS256 — legacy fallback for broader compat
            ],
            authenticatorSelection: {
              authenticatorAttachment: "platform", // passkey (device-bound)
              residentKey: "required", // discoverable credential
              userVerification: "required", // biometric / PIN
            },
            attestation: "none", // we don't need attestation; simplifies server
            extensions: requestPrf ? { prf: {} } : undefined,
          };

          navigator.credentials
            .create({ publicKey: publicKeyOptions })
            .then(function (credential) {
              var response = credential.response;
              // getAuthenticatorData() is part of AuthenticatorAttestationResponse
              // (Chrome 106+, Safari 16+, Edge 106+) — always present for our
              // target browsers. attestation:'none' means no CBOR unpacking needed.
              self.extractPublicKeyFromAuthData(
                response.getAuthenticatorData(),
                function (err, publicKeyJwk, coseKeyBytes) {
                  if (err) return thenDo(err);

                  var c = lively.identity.crypto;
                  var credentialId = c.base64urlEncode(
                    new Uint8Array(credential.rawId),
                  );
                  var prfAvailable = !!(
                    credential.getClientExtensionResults &&
                    credential.getClientExtensionResults().prf &&
                    credential.getClientExtensionResults().prf.enabled
                  );

                  var result = {
                    credentialId: credentialId,
                    publicKeyJwk: publicKeyJwk,
                    // Raw COSE bytes — needed by the server's verifyAuthenticationResponse
                    // via @simplewebauthn/server, which expects Uint8Array not JWK.
                    // Stored in roster so LoginDialog can include them in the POST body.
                    credentialPublicKeyBytes: c.base64urlEncode(coseKeyBytes),
                    attestationObject: c.base64urlEncode(
                      new Uint8Array(response.attestationObject),
                    ),
                    clientDataJSON: c.base64urlEncode(
                      new Uint8Array(response.clientDataJSON),
                    ),
                    prfAvailable: prfAvailable,
                    rpId: rpId,
                    handle: handle,
                  };

                  if (!prfAvailable) {
                    console.warn(
                      "[WebAuthn] PRF extension not supported — " +
                        "private world encryption unavailable on this device",
                    );
                  }

                  // Persist to local roster so authenticate() can find this credential
                  self._saveCredentialToRoster(result, function (saveErr) {
                    if (saveErr)
                      console.warn(
                        "WebAuthn: could not save credential to roster:",
                        saveErr,
                      );
                    console.log(
                      "[WebAuthn] Registration successful:",
                      { credentialId: result.credentialId, prfAvailable: result.prfAvailable },
                    );
                    thenDo(null, result);
                  });
                },
              );
            })
            .catch(function (err) {
              thenDo(err);
            });
        },
      },

      // ─── authentication ───────────────────────────────────────────────────────────

      "authentication",
      {
        // Authenticate with an existing passkey.
        //
        // options: {
        //   challenge:      Uint8Array|ArrayBuffer  — from server GET /identity/challenge
        //   rpId:           String                  — must match registration rpId
        //   credentialIds:  String[]                — base64url IDs to allow (optional;
        //                                             if omitted, any resident key is tried)
        // }
        //
        // Calls thenDo(null, {
        //   credentialId:     String   — base64url
        //   authenticatorData: String  — base64url, send to server
        //   clientDataJSON:   String   — base64url, send to server
        //   signature:        String   — base64url, send to server
        //   userHandle:       String   — base64url user ID bytes (may be null)
        // })
        authenticate: function (options, thenDo) {
          if (!this.isAvailable()) {
            return thenDo(
              new Error("WebAuthn is not available in this browser"),
            );
          }

          var c = lively.identity.crypto;
          var allowCredentials = (options.credentialIds || []).map(
            function (id) {
              return { type: "public-key", id: c.base64urlDecode(id) };
            },
          );

          var publicKeyOptions = {
            challenge: options.challenge,
            rpId: options.rpId || (lively.Config && lively.Config.get('identityRpId')) || window.location.hostname,
            allowCredentials: allowCredentials, // empty = any resident key
            userVerification: "required",
          };

          navigator.credentials
            .get({ publicKey: publicKeyOptions })
            .then(function (credential) {
              var response = credential.response;
              var result = {
                credentialId: c.base64urlEncode(
                  new Uint8Array(credential.rawId),
                ),
                authenticatorData: c.base64urlEncode(
                  new Uint8Array(response.authenticatorData),
                ),
                clientDataJSON: c.base64urlEncode(
                  new Uint8Array(response.clientDataJSON),
                ),
                signature: c.base64urlEncode(
                  new Uint8Array(response.signature),
                ),
                userHandle: response.userHandle
                  ? c.base64urlEncode(new Uint8Array(response.userHandle))
                  : null,
              };
              thenDo(null, result);
            })
            .catch(function (err) {
              thenDo(err);
            });
        },
      },

      // ─── PRF key derivation ───────────────────────────────────────────────────────

      "prf",
      {
        // Derive a 32-byte symmetric encryption key for a specific objId using
        // the WebAuthn PRF extension.
        //
        // The PRF input is deterministic: "lively-object-encryption:<objId>"
        // so the same key is always derived for the same (credential, objId) pair.
        //
        // options: {
        //   objId:         String   — the ObjID of the object to encrypt/decrypt
        //   challenge:     Uint8Array|ArrayBuffer  — fresh challenge from server
        //   rpId:          String
        //   credentialIds: String[] — which credential(s) to try
        // }
        //
        // Calls thenDo(null, Uint8Array[32]) — the raw symmetric key bytes.
        // Returns thenDo(new Error('PRF not available')) if the authenticator
        // does not support the PRF extension.
        deriveEncryptionKey: function (options, thenDo) {
          if (!this.isAvailable()) {
            return thenDo(
              new Error("WebAuthn is not available in this browser"),
            );
          }

          var c = lively.identity.crypto;
          var prfInput = new TextEncoder().encode(
            "lively-object-encryption:" + options.objId,
          );

          var allowCredentials = (options.credentialIds || []).map(
            function (id) {
              return { type: "public-key", id: c.base64urlDecode(id) };
            },
          );

          var publicKeyOptions = {
            challenge: options.challenge,
            rpId: options.rpId || (lively.Config && lively.Config.get('identityRpId')) || window.location.hostname,
            allowCredentials: allowCredentials,
            userVerification: "required",
            extensions: {
              prf: {
                eval: {
                  first: prfInput.buffer,
                },
              },
            },
          };

          navigator.credentials
            .get({ publicKey: publicKeyOptions })
            .then(function (credential) {
              var ext = credential.getClientExtensionResults();
              if (!ext.prf || !ext.prf.results || !ext.prf.results.first) {
                return thenDo(
                  new Error(
                    "PRF extension not supported or not enabled for this credential. " +
                      "Private world encryption is unavailable. " +
                      "Try re-registering the credential with PRF requested.",
                  ),
                );
              }
              // PRF result is an ArrayBuffer of exactly 32 bytes
              thenDo(null, new Uint8Array(ext.prf.results.first));
            })
            .catch(function (err) {
              thenDo(err);
            });
        },

        // Derive a second PRF output used as the X25519 private key for ECDH
        // sealed-box key unwrapping. Input: "lively-x25519:<credentialId>"
        //
        // options: same shape as deriveEncryptionKey, but objId is not needed.
        // credentialId: String — base64url credential ID whose PRF to use.
        //
        // Calls thenDo(null, { publicKey: Uint8Array[32], privateKey: Uint8Array[32] })
        // — the X25519 key pair derived from PRF bytes via libsodium crypto_scalarmult_base.
        deriveX25519KeyPair: function (options, thenDo) {
          if (!this.isAvailable()) {
            return thenDo(
              new Error("WebAuthn is not available in this browser"),
            );
          }

          var c = lively.identity.crypto;
          var credentialId = options.credentialId;
          if (!credentialId) {
            return thenDo(
              new Error("deriveX25519KeyPair: credentialId is required"),
            );
          }

          var prfInput = new TextEncoder().encode(
            "lively-x25519:" + credentialId,
          );
          var allowCredentials = [
            {
              type: "public-key",
              id: c.base64urlDecode(credentialId),
            },
          ];

          var publicKeyOptions = {
            challenge: options.challenge,
            rpId: options.rpId || (lively.Config && lively.Config.get('identityRpId')) || window.location.hostname,
            allowCredentials: allowCredentials,
            userVerification: "required",
            extensions: {
              prf: {
                eval: {
                  first: prfInput.buffer,
                },
              },
            },
          };

          navigator.credentials
            .get({ publicKey: publicKeyOptions })
            .then(function (credential) {
              var ext = credential.getClientExtensionResults();
              if (!ext.prf || !ext.prf.results || !ext.prf.results.first) {
                return thenDo(
                  new Error("PRF not available for X25519 key derivation"),
                );
              }

              var prfBytes = new Uint8Array(ext.prf.results.first); // 32 bytes

              // Derive X25519 key pair using libsodium.
              // The PRF output is the private scalar; crypto_scalarmult_base derives
              // the corresponding public key.
              crypto.withSodium(function (err, sodium) {
                if (err) return thenDo(err);
                try {
                  // Clamp the private key as per X25519 spec
                  var privKey = new Uint8Array(prfBytes);
                  privKey[0] &= 248;
                  privKey[31] &= 127;
                  privKey[31] |= 64;

                  var pubKey = sodium.crypto_scalarmult_base(privKey);
                  thenDo(null, { publicKey: pubKey, privateKey: privKey });
                } catch (e) {
                  thenDo(e);
                }
              });
            })
            .catch(function (err) {
              thenDo(err);
            });
        },
      },

      // ─── credential roster ────────────────────────────────────────────────────────

      "roster",
      {
        // Persist a newly registered credential to IndexedDB so it can be
        // retrieved on subsequent page loads.
        //
        // Stored record shape:
        // {
        //   credentialId:  String   — base64url (used as key)
        //   handle:        String
        //   rpId:          String
        //   publicKeyJwk:  Object
        //   prfAvailable:  Boolean
        //   registeredAt:  String   — ISO 8601
        // }
        _saveCredentialToRoster: function (registrationResult, thenDo) {
          var self = this;
          var record = {
            credentialId:             registrationResult.credentialId,
            handle:                   registrationResult.handle,
            rpId:                     registrationResult.rpId,
            publicKeyJwk:             registrationResult.publicKeyJwk,
            credentialPublicKeyBytes: registrationResult.credentialPublicKeyBytes,
            prfAvailable:             registrationResult.prfAvailable,
            registeredAt:             new Date().toISOString(),
          };

          // Fast flag in LocalStorage — avoids IndexedDB roundtrip when
          // checking "has any credential?" at startup
          lively.LocalStorage.set("identity-has-credential", "true");

          lively.IndexedDB.set(
            "identity-credential-" + record.credentialId,
            JSON.stringify(record),
            function (err) {
              if (err) return thenDo(err);
              self._addToCredentialIndex(record.credentialId, thenDo);
            },
            "identity",
          );
        },

        // Retrieve all registered credentials from IndexedDB.
        // Calls thenDo(null, record[]).
        getCredentials: function (thenDo) {
          // lively.IndexedDB doesn't expose a listAll; we store an index separately
          var indexKey = "identity-credential-index";
          lively.IndexedDB.get(
            indexKey,
            function (err, indexJson) {
              var ids = [];
              if (!err && indexJson) {
                try {
                  ids = JSON.parse(indexJson);
                } catch (e) {}
              }

              if (ids.length === 0) return thenDo(null, []);

              var records = [],
                pending = ids.length;
              ids.forEach(function (id) {
                lively.IndexedDB.get(
                  "identity-credential-" + id,
                  function (err, json) {
                    if (!err && json) {
                      try {
                        records.push(JSON.parse(json));
                      } catch (e) {}
                    }
                    if (--pending === 0) thenDo(null, records);
                  },
                  "identity",
                );
              });
            },
            "identity",
          );
        },

        // Remove a credential from the roster (device revocation, local side).
        // The DID document revocation is handled separately in lively.identity.DID.
        removeCredential: function (credentialId, thenDo) {
          var self = this;
          lively.IndexedDB.remove(
            "identity-credential-" + credentialId,
            function (err) {
              if (err) return thenDo(err);
              // Update index
              lively.IndexedDB.get(
                "identity-credential-index",
                function (err, indexJson) {
                  var ids = [];
                  if (!err && indexJson) {
                    try {
                      ids = JSON.parse(indexJson);
                    } catch (e) {}
                  }
                  ids = ids.filter(function (id) {
                    return id !== credentialId;
                  });
                  lively.IndexedDB.set(
                    "identity-credential-index",
                    JSON.stringify(ids),
                    function (err) {
                      if (ids.length === 0)
                        lively.LocalStorage.remove("identity-has-credential");
                      thenDo(err || null);
                    },
                    "identity",
                  );
                },
                "identity",
              );
            },
            "identity",
          );
        },

        // True if lively.LocalStorage fast-path flag is set.
        // Use this before opening IndexedDB to avoid unnecessary async overhead
        // in the common "not yet registered" path.
        hasAnyCredential: function () {
          return lively.LocalStorage.get("identity-has-credential") === "true";
        },
      },

      // ─── credential index maintenance ─────────────────────────────────────────────

      "index",
      {
        // Add a credentialId to the persisted index list.
        // Called internally by _saveCredentialToRoster.
        _addToCredentialIndex: function (credentialId, thenDo) {
          lively.IndexedDB.get(
            "identity-credential-index",
            function (err, indexJson) {
              var ids = [];
              if (!err && indexJson) {
                try {
                  ids = JSON.parse(indexJson);
                } catch (e) {}
              }
              if (ids.indexOf(credentialId) === -1) ids.push(credentialId);
              lively.IndexedDB.set(
                "identity-credential-index",
                JSON.stringify(ids),
                thenDo,
                "identity",
              );
            },
            "identity",
          );
        },
      },
    );

    // Singleton
    lively.identity.webAuthn = new lively.identity.WebAuthn();
  }); // end module('lively.identity.WebAuthn')
