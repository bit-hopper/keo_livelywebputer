/**
 * lively.identity.LoginDialog
 *
 * Window dialog for signing in to an existing identity.
 *
 * Two paths:
 *
 *   Known-device path — local WebAuthn roster has a credential for this rpId.
 *     The handle input narrows which credential to offer; leaving it blank
 *     lets the OS pick from all resident keys on this device.
 *     Succeeds without fetching the DID document from the server because
 *     completeAuthentication() reads it from local lively.IndexedDB.
 *
 *   New-device path — no local roster entry matches.
 *     Uses an empty allowCredentials list so the OS shows a discoverable-
 *     credential picker. After the authenticator fires, the handle is
 *     extracted from userHandle bytes ("lively-user:<handle>"), the server
 *     verifies the assertion, and the DID document is fetched from /@handle
 *     and saved to local lively.IndexedDB before completeAuthentication runs.
 *
 * Async convention: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.DID         — completeAuthentication, saveDocument, isLoggedIn
 *   lively.identity.WebAuthn    — authenticate, getCredentials
 *   lively.identity.ObjectStore — sync (post-login background pull)
 *   lively.identity.Crypto      — base64urlDecode (via WebAuthn module)
 */

module("lively.identity.LoginDialog")
  .requires(
    "lively.identity.DID",
    "lively.identity.WebAuthn",
    "lively.identity.ObjectStore",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.LoginDialog", {
      _Extent: lively.pt(400, 210),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "IdentityLoginDialog",
      titleBar: "Sign in",
      submorphs: [
        {
          _Extent: lively.pt(394, 185),
          _Fill: Color.rgb(250, 250, 250),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: {
            adjustForNewBounds: true,
            resizeHeight: true,
            resizeWidth: true,
          },
          name: "loginContent",
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
        var content = this.get("loginContent");
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

        addLabel("Handle (optional — leave blank for device picker):");
        addInput("handleInput");

        y += 2;
        var statusText = new lively.morphic.Text(
          lively.rect(pad, y, w, 28),
          "",
        );
        statusText.name = "statusText";
        statusText.applyStyle({ allowInput: false, fontSize: 11, fill: null });
        content.addMorph(statusText);
        y += 36;

        var signInBtn = new lively.morphic.Button(
          lively.rect(pad, y, 100, 24),
          "Sign in",
        );
        signInBtn.name = "signInBtn";
        lively.bindings.connect(signInBtn, "fire", self, "signIn");
        content.addMorph(signInBtn);

        var cancelBtn = new lively.morphic.Button(
          lively.rect(pad + 108, y, 80, 24),
          "Cancel",
        );
        lively.bindings.connect(cancelBtn, "fire", self, "remove");
        content.addMorph(cancelBtn);
      },

      // ─── sign-in ceremony ───────────────────────────────────────────────────────

      signIn: function signIn() {
        var self = this;
        var typedHandle = (this.get("handleInput").textString || "").trim().replace(/^@/, "");
        var btn = this.get("signInBtn");
        if (btn) btn.setEnabled(false);
        this.setStatus("Requesting challenge…");

        fetch("/nodejs/IdentityServer/challenge", { credentials: "include" })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body.error) throw new Error(body.error);

            var c = lively.identity.crypto;
            var challengeBytes = c.base64urlDecode(body.challenge);
            var rpId = window.location.hostname;
            var webAuthn = lively.identity.webAuthn;

            // Decide which path based on local roster.
            webAuthn.getCredentials(function (err, records) {
              if (err) records = [];

              // Filter to credentials matching the typed handle and current rpId.
              var matching = records.filter(function (r) {
                var rpOk = r.rpId === rpId;
                if (!typedHandle) return rpOk;
                return rpOk && r.handle === typedHandle;
              });

              if (matching.length > 0) {
                // ── known-device path ──────────────────────────────────────
                self.setStatus("Waiting for device authentication…");
                var credentialIds = matching.map(function (r) { return r.credentialId; });
                webAuthn.authenticate(
                  { challenge: challengeBytes, rpId: rpId, credentialIds: credentialIds },
                  function (authErr, assertion) {
                    if (authErr) {
                      if (btn) btn.setEnabled(true);
                      return self.setStatus("Authentication cancelled: " + authErr.message, true);
                    }
                    // Pass the roster record for this credential so the POST body
                    // includes credentialPublicKeyBytes (belt-and-suspenders; server
                    // already has COSE bytes in HandleRegistry).
                    var rosterRecord = null;
                    for (var i = 0; i < matching.length; i++) {
                      if (matching[i].credentialId === assertion.credentialId) {
                        rosterRecord = matching[i];
                        break;
                      }
                    }
                    self._postAuthenticate(assertion, typedHandle || matching[0].handle, rpId, btn, rosterRecord);
                  },
                );
              } else {
                // ── new-device path ────────────────────────────────────────
                self.setStatus("No local credential found — opening device picker…");
                webAuthn.authenticate(
                  { challenge: challengeBytes, rpId: rpId, credentialIds: [] },
                  function (authErr, assertion) {
                    if (authErr) {
                      if (btn) btn.setEnabled(true);
                      return self.setStatus("Authentication cancelled: " + authErr.message, true);
                    }
                    // Extract handle from userHandle bytes ("lively-user:<handle>").
                    var handle = typedHandle;
                    if (!handle && assertion.userHandle) {
                      try {
                        handle = new TextDecoder()
                          .decode(c.base64urlDecode(assertion.userHandle))
                          .replace(/^lively-user:/, "");
                      } catch (e) {
                        // userHandle decode failed — fall through with empty handle
                      }
                    }
                    if (!handle) {
                      if (btn) btn.setEnabled(true);
                      return self.setStatus(
                        "Could not determine handle. Enter your handle and try again.",
                        true,
                      );
                    }
                    self._postAuthenticateNewDevice(assertion, handle, rpId, btn);
                  },
                );
              }
            });
          })
          .catch(function (e) {
            if (btn) btn.setEnabled(true);
            self.setStatus("Could not get challenge: " + e.message, true);
          });
      },

      // ─── known-device POST + session ────────────────────────────────────────────

      _postAuthenticate: function _postAuthenticate(assertion, handle, rpId, btn, rosterRecord) {
        var self = this;
        self.setStatus("Verifying with server…");
        var postBody = {
          handle: handle,
          credentialId: assertion.credentialId,
          authenticatorData: assertion.authenticatorData,
          clientDataJSON: assertion.clientDataJSON,
          signature: assertion.signature,
          userHandle: assertion.userHandle,
        };
        if (rosterRecord && rosterRecord.credentialPublicKeyBytes) {
          postBody.credentialPublicKeyBytes = rosterRecord.credentialPublicKeyBytes;
        }
        fetch("/nodejs/IdentityServer/authenticate", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(postBody),
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body.error) throw new Error(body.error);
            self.setStatus("Establishing session…");
            var did = lively.identity.did;
            did.completeAuthentication(
              assertion,
              {
                did: body.did,
                handle: body.handle,
                displayName: body.handle,
                credentialId: assertion.credentialId,
                rpId: rpId,
              },
              function (sessionErr) {
                if (btn) btn.setEnabled(true);
                if (sessionErr) {
                  return self.setStatus("Session setup failed: " + sessionErr.message, true);
                }
                self._backgroundSync(body.handle);
                self.remove();
              },
            );
          })
          .catch(function (e) {
            if (btn) btn.setEnabled(true);
            self.setStatus("Server error: " + e.message, true);
          });
      },

      // ─── new-device POST + DID fetch + session ──────────────────────────────────

      _postAuthenticateNewDevice: function _postAuthenticateNewDevice(assertion, handle, rpId, btn) {
        var self = this;
        self.setStatus("Verifying with server…");
        fetch("/nodejs/IdentityServer/authenticate", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            handle: handle,
            credentialId: assertion.credentialId,
            authenticatorData: assertion.authenticatorData,
            clientDataJSON: assertion.clientDataJSON,
            signature: assertion.signature,
            userHandle: assertion.userHandle,
          }),
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body.error) throw new Error(body.error);

            // Fetch the DID document from the dedicated endpoint so that
            // completeAuthentication can read it via loadDocument().
            self.setStatus("Fetching identity document…");
            return fetch("/@" + body.handle + "/did-document", { credentials: "include" })
              .then(function (res) {
                if (!res.ok) throw new Error("Could not fetch DID document for @" + body.handle + " (HTTP " + res.status + ")");
                return res.json();
              })
              .then(function (didDoc) {
                if (didDoc.error) throw new Error(didDoc.error);

                // Save to local lively.IndexedDB so completeAuthentication's
                // loadDocument() call succeeds on this new device.
                self.setStatus("Saving identity document locally…");
                var did = lively.identity.did;
                did.saveDocument(didDoc, function (saveErr) {
                  if (saveErr) {
                    if (btn) btn.setEnabled(true);
                    return self.setStatus("Could not save DID document: " + saveErr.message, true);
                  }

                  self.setStatus("Establishing session…");
                  did.completeAuthentication(
                    assertion,
                    {
                      did: body.did,
                      handle: body.handle,
                      displayName: body.handle,
                      credentialId: assertion.credentialId,
                      rpId: rpId,
                    },
                    function (sessionErr) {
                      if (btn) btn.setEnabled(true);
                      if (sessionErr) {
                        return self.setStatus("Session setup failed: " + sessionErr.message, true);
                      }
                      self._backgroundSync(body.handle);
                      self.remove();
                    },
                  );
                });
              });
          })
          .catch(function (e) {
            if (btn) btn.setEnabled(true);
            self.setStatus("Error: " + e.message, true);
          });
      },

      // ─── post-login sync ────────────────────────────────────────────────────────

      _backgroundSync: function _backgroundSync(handle) {
        // Pull any remote updates accumulated since the last login.
        // Non-blocking — failure is logged but does not affect the login outcome.
        lively.identity.objectStore.sync(
          handle,
          window.location.origin,
          function (err, result) {
            if (err) {
              console.warn("[Identity] Post-login sync failed:", err.message);
            }
          },
        );
      },

      // ─── helpers ────────────────────────────────────────────────────────────────

      setStatus: function setStatus(msg, isError) {
        var t = this.get("statusText");
        if (!t) return;
        t.setTextString(msg || "");
        t.setTextColor(isError ? Color.red : Color.rgb(60, 60, 60));
      },
    });
  }); // end module('lively.identity.LoginDialog')
