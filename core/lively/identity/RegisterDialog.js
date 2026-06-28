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
 *   5. DID.completeRegistration() → local session established
 *   6. Dialog closes; MenuBarEntry updates via identityChanged signal
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
        var deviceLabel =
          (this.get("deviceLabelInput").textString || "").trim() ||
          "This device";

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
                    self.setStatus("Establishing session…");

                    // Step 5: local session (saves DID document, fires identityChanged)
                    did.completeRegistration(
                      reg,
                      {
                        handle: handle,
                        displayName: displayName || handle,
                        deviceLabel: deviceLabel,
                      },
                      function (sessionErr) {
                        if (btn) btn.setActive(true);
                        if (sessionErr) {
                          return self.setStatus(
                            "Session setup failed: " + sessionErr.message,
                            true,
                          );
                        }
                        self.remove(); // success — close dialog
                      },
                    );
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

      setStatus: function setStatus(msg, isError) {
        var t = this.get("statusText");
        if (!t) return;
        t.setTextString(msg || "");
        t.setTextColor(isError ? Color.red : Color.rgb(60, 60, 60));
      },
    });
  }); // end module('lively.identity.RegisterDialog')
