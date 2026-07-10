/**
 * lively.identity.RegisterDialog
 *
 * Window dialog for creating a new identity or adding a device to an existing one.
 *
 * Fresh registration flow:
 *   1. User fills handle / display name / device label
 *   2. GET  /nodejs/IdentityServer/challenge
 *   3. WebAuthn.register() → OS passkey prompt
 *   4. POST /nodejs/IdentityServer/register  (handle, did, credentialId, attestation,
 *                                              publicKeyJwk, didDocument)
 *   5. "Enable encryption" / "Skip for now" — a second, explicitly clicked
 *      button (_promptEnableEncryption), not auto-chained from step 3's
 *      prompt. The delegation ceremony (soft signing key + KEK + X25519,
 *      via a second navigator.credentials.get()) needs its own fresh user
 *      activation — several async hops downstream of the original click
 *      was found to silently fail in some browsers (confirmed on Chrome
 *      Canary) rather than reject loudly, leaving the account permanently
 *      without encryption with no obvious cause.
 *   6. DID.completeRegistration() → local session established
 *   7. Dialog closes; MenuBarEntry updates via identityChanged signal
 *
 * Add-device flow (opened while already logged in):
 *   Handle + displayName are pre-filled and locked from the current session.
 *   Same ceremony; server upserts the handle → DID mapping.
 *   Full multi-device DID document merging is a future iteration.
 *
 * Async convention: thenDo(err, result) → matches the rest of lively.identity.
 *
 * Dependencies:
 *   lively.identity.DID      — didFromJwk, buildDocument, completeRegistration, isLoggedIn
 *   lively.identity.WebAuthn — register()
 *   lively.identity.Crypto   — base64urlDecode (via WebAuthn module)
 */

module("lively.identity.RegisterDialog")
  .requires(
    "lively.identity.DID",
    "lively.identity.WebAuthn",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.RegisterDialog", {
      _Extent: lively.pt(400, 268),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "IdentityRegisterDialog",
      titleBar: "Create identity",
      submorphs: [
        {
          _Extent: lively.pt(394, 243),
          _Fill: Color.rgb(250, 250, 250),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: {
            adjustForNewBounds: true,
            resizeHeight: true,
            resizeWidth: true,
          },
          name: "registerContent",
          submorphs: [],
        },
      ],

      // ─── lifecycle ──────────────────────────────────────────────────────────────

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this.buildForm();
      },

      // ─── form construction ──────────────────────────────────────────────────────

      buildForm: function buildForm() {
        var self = this;
        var content = this.get("registerContent");
        if (!content) return;
        content.removeAllMorphs();

        var pad = 14;
        var y = pad;
        var w = content.getExtent().x - pad * 2;

        function addLabel(text) {
          var lbl = new lively.morphic.Text(lively.rect(pad, y, w, 16), text);
          lbl.applyStyle({
            allowInput: false,
            fontSize: 11,
            textColor: Color.rgb(70, 70, 70),
            fill: null,
          });
          content.addMorph(lbl);
          y += 18;
          return lbl;
        }

        function addInput(name) {
          var inp = new lively.morphic.Text(lively.rect(pad, y, w, 22), "");
          inp.name = name;
          inp.applyStyle({
            allowInput: true,
            fontSize: 12,
            fill: Color.white,
            borderWidth: 1,
            borderColor: Color.rgb(190, 190, 190),
            borderRadius: 3,
            padding: lively.rect(4, 3, 0, 0),
          });
          inp.beInputLine();
          content.addMorph(inp);
          y += 28;
          return inp;
        }

        addLabel("Handle (a–z, 0–9, underscore, max 32 chars):");
        addInput("handleInput");

        addLabel("Display name (optional):");
        addInput("displayNameInput");

        addLabel("Device label (optional, defaults to “This device”):");
        addInput("deviceLabelInput");

        y += 2;
        var statusText = new lively.morphic.Text(
          lively.rect(pad, y, w, 28),
          "",
        );
        statusText.name = "statusText";
        statusText.applyStyle({ allowInput: false, fontSize: 11, fill: null });
        content.addMorph(statusText);
        y += 36;

        var regBtn = new lively.morphic.Button(
          lively.rect(pad, y, 100, 24),
          "Register",
        );
        regBtn.name = "registerBtn";
        lively.bindings.connect(regBtn, "fire", self, "register");
        content.addMorph(regBtn);

        var cancelBtn = new lively.morphic.Button(
          lively.rect(pad + 108, y, 80, 24),
          "Cancel",
        );
        cancelBtn.name = "registerCancelBtn";
        lively.bindings.connect(cancelBtn, "fire", self, "remove");
        content.addMorph(cancelBtn);

        // Pre-fill and lock handle + displayName when adding a device to an
        // existing session. The server treats this as an upsert on the handle.
        if (lively.identity.did.isLoggedIn()) {
          var user = lively.identity.did.currentUser();
          this.get("handleInput").setTextString(user.handle);
          this.get("handleInput").applyStyle({ allowInput: false });
          this.get("displayNameInput").setTextString(user.displayName || "");
          this.get("displayNameInput").applyStyle({ allowInput: false });
        }
      },

      // ─── registration ceremony ──────────────────────────────────────────────────

      register: function register() {
        var self = this;

        var handle = (this.get("handleInput").textString || "").trim();
        var displayName = (
          this.get("displayNameInput").textString || ""
        ).trim();
        var deviceLabel = (this.get("deviceLabelInput").textString || "").trim();
        if (!deviceLabel) {
          // auto-detect OS + browser from user agent
          var ua = navigator.userAgent;
          var os = 'Unknown OS';
          if      (/iPad/.test(ua))                      os = 'iPadOS';
          else if (/iPhone|iPod/.test(ua))               os = 'iOS';
          else if (/Android/.test(ua))                   os = 'Android';
          else if (/CrOS/.test(ua))                      os = 'ChromeOS';
          else if (/Mac OS X/.test(ua))                  os = 'macOS';
          else if (/Windows/.test(ua))                   os = 'Windows';
          else if (/Linux/.test(ua))                     os = 'Linux';
          var browser = 'Browser';
          if      (/Edg\//.test(ua))                     browser = 'Edge';
          else if (/OPR\/|Opera/.test(ua))               browser = 'Opera';
          else if (/Chrome\//.test(ua))                  browser = 'Chrome';
          else if (/Firefox\//.test(ua))                 browser = 'Firefox';
          else if (/Safari\//.test(ua))                  browser = 'Safari';
          else if (/SamsungBrowser/.test(ua))            browser = 'Samsung';
          deviceLabel = os + ' · ' + browser;
        }

        if (!handle) {
          return this.setStatus("Handle is required.", true);
        }
        if (!/^[a-z0-9_]{1,32}$/.test(handle)) {
          return this.setStatus(
            "Handle must be 1–32 characters: a–z, 0–9, underscore only.",
            true,
          );
        }

        var btn = this.get("registerBtn");
        if (btn) btn.setActive(false);
        this.setStatus("Requesting challenge…");

        var rpId = window.location.hostname;
        var crypto = lively.identity.crypto;
        var did = lively.identity.did;
        var webAuthn = lively.identity.webAuthn;

        // Step 1: get a fresh challenge from the server
        fetch("/nodejs/IdentityServer/challenge", { credentials: "include" })
          .then(function (res) {
            return res.json();
          })
          .then(function (body) {
            if (body.error) throw new Error(body.error);

            var challengeBytes = crypto.base64urlDecode(body.challenge);
            self.setStatus("Waiting for device authentication…");

            // Step 2: WebAuthn passkey ceremony (OS prompt)
            webAuthn.register(
              {
                handle: handle,
                displayName: displayName || handle,
                rpId: rpId,
                rpName: "Lively",
                challenge: challengeBytes,
                requestPrf: true,
              },
              function (err, reg) {
                if (err) {
                  if (btn) btn.setActive(true);
                  return self.setStatus(
                    "Registration cancelled: " + err.message,
                    true,
                  );
                }

                self.setStatus("Verifying with server…");

                // Step 3: build the DID document client-side so we can include it
                // in the POST body. completeRegistration rebuilds it locally too —
                // the server copy is used for .well-known resolution and by other
                // devices that don't have a local DID document yet.
                var derivedDid = did.didFromJwk(reg.publicKeyJwk);
                var document = did.buildDocument({
                  did: derivedDid,
                  publicKeyJwk: reg.publicKeyJwk,
                  credentialId: reg.credentialId,
                  deviceLabel: deviceLabel,
                  handle: handle,
                });

                // Step 4: register with the server (verifies attestation, saves
                // credential COSE bytes and handle → DID mapping)
                fetch("/nodejs/IdentityServer/register", {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    handle: handle,
                    did: derivedDid,
                    credentialId: reg.credentialId,
                    attestationObject: reg.attestationObject,
                    clientDataJSON: reg.clientDataJSON,
                    publicKeyJwk: reg.publicKeyJwk,
                    credentialPublicKeyBytes: reg.credentialPublicKeyBytes,
                    didDocument: document,
                  }),
                })
                  .then(function (res) {
                    return res.json();
                  })
                  .then(function (serverBody) {
                    if (serverBody.error) throw new Error(serverBody.error);
                    self.setStatus("Generating device signing key…");

                    // Step 5: generate soft signing key + delegation cert + KEK + X25519
                    // All in one combined WebAuthn ceremony so the user sees only
                    // one additional prompt after the registration passkey prompt.
                    crypto.generateSigningKeyPair(function (err, softKeyPair) {
                      if (err) {
                        console.warn('[RegisterDialog] Could not generate soft key pair:', err);
                        return finishRegistration(serverBody, null, null, null);
                      }

                      crypto.exportPublicKeyJwk(softKeyPair.publicKey, function (err, devicePubKeyJwk) {
                        if (err) {
                          console.warn('[RegisterDialog] Could not export soft public key:', err);
                          return finishRegistration(serverBody, null, null, null);
                        }

                        var issuedAt = new Date().toISOString();
                        var delegationPayload = {
                          devicePubKeyJwk: devicePubKeyJwk,
                          credentialId: reg.credentialId,
                          issuedAt: issuedAt
                        };
                        // Compute H(delegationPayload) as the ceremony challenge
                        crypto.sha256(crypto.canonicalJson(delegationPayload), function (err, digestB64) {
                          if (err) {
                            console.warn('[RegisterDialog] Could not hash delegation payload:', err);
                            return finishRegistration(serverBody, null, null, null);
                          }

                          var certChallenge = crypto.base64urlDecode(digestB64);
                          var prfKekInput = new TextEncoder().encode('lively-kek-v1');
                          var prfX25519Input = new TextEncoder().encode('lively-x25519:' + reg.credentialId);

                          self.setStatus("Passkey registered. Enable encryption for private postcards?");

                          // Gated behind its own button (see _promptEnableEncryption):
                          // this ceremony is several async hops downstream of the
                          // original Register click (two network round trips, a
                          // WebCrypto keygen, an OS passkey prompt), and was found to
                          // silently fail in some browsers when fired automatically
                          // here instead of from a fresh click.
                          self._promptEnableEncryption(function onEnableEncryption() {
                            self.setStatus("One more tap to set up encryption…");

                            // Combined ceremony: delegation sig + KEK + X25519 private key
                            navigator.credentials.get({
                              publicKey: {
                                challenge: certChallenge,
                                rpId: rpId,
                                allowCredentials: [{
                                  type: 'public-key',
                                  id: crypto.base64urlDecode(reg.credentialId)
                                }],
                                userVerification: 'required',
                                extensions: {
                                  prf: {
                                    eval: {
                                      first:  prfKekInput.buffer,
                                      second: prfX25519Input.buffer
                                    }
                                  }
                                }
                              }
                            }).then(function (credential) {
                              var assertion = credential.response;
                              var ext = credential.getClientExtensionResults();
                              var c = crypto;

                              // Build delegation cert from assertion
                              var delegationCert = {
                                devicePubKeyJwk: devicePubKeyJwk,
                                credentialId: reg.credentialId,
                                issuedAt: issuedAt,
                                authenticatorData: c.base64urlEncode(new Uint8Array(assertion.authenticatorData)),
                                clientDataJSON:    c.base64urlEncode(new Uint8Array(assertion.clientDataJSON)),
                                signature:         c.base64urlEncode(new Uint8Array(assertion.signature))
                              };

                              var prfResults = ext && ext.prf && ext.prf.results;
                              if (!prfResults || !prfResults.first) {
                                console.warn('[RegisterDialog] PRF not available — KEK and X25519 skipped');
                                return finishRegistration(serverBody, delegationCert, null, null, softKeyPair);
                              }

                              var kek = new Uint8Array(prfResults.first);
                              // Cache the KEK for this session
                              if (!lively.identity.webAuthn._kekCache) lively.identity.webAuthn._kekCache = {};
                              lively.identity.webAuthn._kekCache[reg.credentialId] = kek;

                              // Wrap soft private key with KEK
                              crypto.exportPrivateKeyJwk(softKeyPair.privateKey, function (err, softPrivJwk) {
                                if (err) {
                                  console.warn('[RegisterDialog] Could not export soft private key:', err);
                                  return finishRegistration(serverBody, delegationCert, null, null, softKeyPair);
                                }
                                crypto.wrapDek(kek, function (err, wrapped) {
                                  // Note: wrapDek wraps random bytes; here we need to wrap
                                  // the soft private key JWK. We encrypt it with encryptPayload instead.
                                  // The spec says "KEK-wrapped like everything else" — use encryptPayload
                                  // with the KEK as the symmetric key.
                                  crypto.encryptPayload(softPrivJwk, kek, function (err, enc) {
                                    if (err) {
                                      console.warn('[RegisterDialog] Could not wrap soft private key:', err);
                                      return finishRegistration(serverBody, delegationCert, null, null, softKeyPair);
                                    }
                                    var softSigningKeyWrapped = JSON.stringify({ ciphertext: enc.ciphertext, nonce: enc.nonce });

                                    // Derive X25519 keypair from PRF second output (if available)
                                    var x25519Pub = null;
                                    if (prfResults.second) {
                                      lively.identity.crypto.withSodium(function (err, sodium) {
                                        if (err || !sodium) {
                                          return finishRegistration(serverBody, delegationCert, softSigningKeyWrapped, null, softKeyPair);
                                        }
                                        try {
                                          var privBytes = new Uint8Array(prfResults.second);
                                          // X25519 private key clamping (RFC 7748)
                                          privBytes[0]  &= 248;
                                          privBytes[31] &= 127;
                                          privBytes[31] |= 64;
                                          var pubBytes = sodium.crypto_scalarmult_base(privBytes);
                                          x25519Pub = sodium.to_base64(pubBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
                                          finishRegistration(serverBody, delegationCert, softSigningKeyWrapped, x25519Pub, softKeyPair);
                                        } catch (e) {
                                          console.warn('[RegisterDialog] X25519 derivation failed:', e);
                                          finishRegistration(serverBody, delegationCert, softSigningKeyWrapped, null, softKeyPair);
                                        }
                                      });
                                    } else {
                                      finishRegistration(serverBody, delegationCert, softSigningKeyWrapped, null, softKeyPair);
                                    }
                                  });
                                });
                              });
                            }).catch(function (e) {
                              // e.name (e.g. NotAllowedError) matters as much as
                              // e.message for diagnosing browser-specific failures —
                              // logged separately since DOMException.toString()
                              // doesn't always include it.
                              console.warn('[RegisterDialog] Delegation ceremony failed (non-fatal):', e.name + ': ' + e.message);
                              // Surface it in the dialog itself (not just console) —
                              // previously this degraded to public-only registration
                              // with zero visible indication anything had gone wrong.
                              // Held for 3s before continuing so it's actually
                              // readable, not just flashed before the redirect.
                              self.setStatus(
                                'Encryption setup failed (' + e.name + ') — continuing without it.',
                                true,
                              );
                              setTimeout(function () {
                                finishRegistration(serverBody, null, null, null, null);
                              }, 3000);
                            });
                          }, function onSkipEncryption() {
                            finishRegistration(serverBody, null, null, null, null);
                          });
                        });
                      });
                    });

                    // Step 6: establish session with delegation cert fields
                    function finishRegistration(serverBody, delegationCert, softSigningKeyWrapped, accountX25519Pub) {
                      self.setStatus("Establishing session…");
                      did.completeRegistration(
                        reg,
                        {
                          handle: handle,
                          displayName: displayName || handle,
                          deviceLabel: deviceLabel,
                          delegationCert:        delegationCert       || undefined,
                          softSigningKeyWrapped:  softSigningKeyWrapped || undefined,
                          accountX25519Pub:       accountX25519Pub      || undefined,
                        },
                        function (sessionErr) {
                          if (btn) btn.setActive(true);
                          if (sessionErr) {
                            return self.setStatus(
                              "Session setup failed: " + sessionErr.message,
                              true,
                            );
                          }

                          // Only navigate away (or close the dialog) after the
                          // profile-publish step below has actually settled — it
                          // used to fire-and-forget straight into
                          // window.location.href, and navigating away cancels an
                          // in-flight fetch in most browsers. That silently killed
                          // the profile PUT mid-chain (GET profile → compute CID →
                          // sign → PUT) before it ever reached the server, with no
                          // error surfaced anywhere. Confirmed as a second,
                          // independent cause of postcard_fixes_tranche3.md's
                          // "still shows no encryption" report (alongside the
                          // DID-document sync gap fixed in DID.js#saveDocument).
                          function proceed() {
                            if (serverBody.homeWorldObjId) {
                              if (typeof lively !== 'undefined' && lively.Config) lively.Config.askBeforeQuit = false;
                              window.location.href = "/@" + handle + "/" + serverBody.homeWorldObjId + "?welcome=" + encodeURIComponent(handle);
                            } else {
                              self.remove();
                            }
                          }

                          // If we have accountX25519Pub, save it to the profile.
                          // record.cid is the hash of record.payload (SignedSerializer
                          // hard-fails deserialize on a mismatch) — must be recomputed
                          // after patching payload, not carried over from the GET.
                          //
                          // Also signs the envelope (postcard-audit F22): this is the
                          // profile object other users' clients read accountX25519Pub
                          // from before sealing a shared postcard's DEK to it, and
                          // until now nothing signed profile envelopes at all. Same
                          // opportunistic pattern as SignedSerializer/PostCardSerializer
                          // — sign if a delegation cert + cached KEK are available,
                          // degrade to unsigned otherwise. (Third hand-copy of this
                          // closure; flagged for future unification same as F21/F6.)
                          if (accountX25519Pub) {
                            fetch('/@' + handle + '/profile', { credentials: 'include' })
                              .then(function(r) {
                                if (!r.ok) throw new Error('GET /profile failed: HTTP ' + r.status);
                                return r.json();
                              })
                              .then(function(env) {
                                var payload = env.record && env.record.payload ? env.record.payload : {};
                                payload.accountX25519Pub = accountX25519Pub;
                                env.record.payload = payload;
                                return new Promise(function (resolve, reject) {
                                  lively.identity.crypto.computeCid(payload, function (err, cid) {
                                    if (err) return reject(err);
                                    env.record.cid = cid;
                                    _signProfileEnvelopeIfPossible(env, function (signErr, signedEnv) {
                                      if (signErr) console.warn('[RegisterDialog] Could not sign profile envelope (non-fatal):', signErr.message);
                                      resolve(fetch('/@' + handle + '/profile', {
                                        method: 'PUT',
                                        credentials: 'include',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify(signedEnv || env)
                                      }));
                                    });
                                  });
                                });
                              })
                              // fetch() only rejects on a network error — an HTTP
                              // error status resolves normally, so it must be
                              // checked explicitly or a rejected write looks
                              // identical to a successful one.
                              .then(function (putRes) {
                                if (!putRes.ok) {
                                  return putRes.text().then(function (body) {
                                    throw new Error('PUT /profile failed: HTTP ' + putRes.status + ' ' + body.slice(0, 300));
                                  });
                                }
                              })
                              .catch(function(e) {
                                console.warn('[RegisterDialog] Could not save X25519 pub to profile:', e);
                              })
                              .then(proceed);
                          } else {
                            proceed();
                          }
                        },
                      );
                    }
                  })
                  .catch(function (serverErr) {
                    if (btn) btn.setActive(true);
                    self.setStatus("Server error: " + serverErr.message, true);
                  });
              },
            );
          })
          .catch(function (e) {
            if (btn) btn.setActive(true);
            self.setStatus("Could not get challenge: " + e.message, true);
          });
      },

      // ─── helpers ────────────────────────────────────────────────────────────────

      // Replaces the Register/Cancel buttons with Enable-encryption/Skip
      // buttons, positioned where Register was. Exists because the delegation
      // ceremony's navigator.credentials.get() call — several async hops
      // (two network round trips, a WebCrypto keygen, an OS passkey prompt)
      // downstream of the original Register click — was found to reject in
      // some browsers (confirmed Chrome Canary; likely a browser tightening
      // how long "transient user activation" survives a chained WebAuthn
      // ceremony) with the ceremony silently completing without encryption.
      // Gating the second ceremony behind its own real click gives it fresh
      // activation instead of relying on the original click still counting.
      // Plain DOM buttons rather than lively.morphic.Button + addScript:
      // Lively re-evaluates an addScript body from its source text on every
      // fire (see the Friends/Save buttons' this._prop workaround in
      // ProfileCard.js), which silently drops closures over local variables
      // like onEnable/onSkip/enableBtn/skipBtn — confirmed live
      // ("ReferenceError: enableBtn is not defined" on click). Plain DOM
      // elements with addEventListener use normal JS closures with no such
      // re-evaluation step, same pattern as PostCardEditor.js/FilesBrowser.js's
      // raw-DOM toolbars.
      _promptEnableEncryption: function (onEnable, onSkip) {
        var content = this.get("registerContent");
        var oldBtn = this.get("registerBtn");
        var oldCancel = this.get("registerCancelBtn");
        var pos = oldBtn ? oldBtn.getPosition() : lively.pt(14, 190);
        if (oldBtn) oldBtn.remove();
        if (oldCancel) oldCancel.remove();
        if (!content) return onSkip();

        var shapeNode = content.renderContext().shapeNode;
        var btnStyle = [
          'position:absolute', 'top:' + pos.y + 'px',
          'height:24px', 'font-size:12px', 'cursor:pointer',
          'border:1px solid #ccc', 'border-radius:3px', 'background:#fff',
        ];

        var enableBtn = document.createElement('button');
        enableBtn.textContent = 'Enable encryption';
        enableBtn.style.cssText = btnStyle.concat(
          'left:' + pos.x + 'px', 'width:150px',
          'border-color:#5a5', 'background:#efe',
        ).join(';');

        var skipBtn = document.createElement('button');
        skipBtn.textContent = 'Skip for now';
        skipBtn.style.cssText = btnStyle.concat(
          'left:' + (pos.x + 158) + 'px', 'width:100px',
        ).join(';');

        enableBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          enableBtn.disabled = true;
          skipBtn.disabled = true;
          onEnable();
        });
        skipBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          enableBtn.disabled = true;
          skipBtn.disabled = true;
          onSkip();
        });

        shapeNode.appendChild(enableBtn);
        shapeNode.appendChild(skipBtn);
      },

      setStatus: function setStatus(msg, isError) {
        var t = this.get("statusText");
        if (!t) return;
        t.setTextString(msg || "");
        t.setTextColor(isError ? Color.red : Color.rgb(60, 60, 60));
      },
    });

    // Mirrors SignedSerializer.js / PostCardSerializer.js's private
    // _signEnvelopeIfPossible — signs with the device's soft signing key if
    // a delegation cert and cached KEK are available, no-ops otherwise.
    function _signProfileEnvelopeIfPossible(envelope, thenDo) {
      var did = lively.identity.did;
      var user = did.currentUser();
      if (!user) return thenDo(null, envelope);
      var method = did.findMethodByCredentialId(user.document, user.credentialId);
      if (!method || !method.lively) return thenDo(null, envelope);
      var livelyMeta = method.lively;
      if (!livelyMeta.softSigningKeyWrapped || !livelyMeta.delegationCert) return thenDo(null, envelope);
      var wa = lively.identity.webAuthn;
      if (!wa._kekCache || !wa._kekCache[user.credentialId]) return thenDo(null, envelope);
      var kek = wa._kekCache[user.credentialId];
      var c = lively.identity.crypto;
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
  }); // end module('lively.identity.RegisterDialog')
