/**
 * lively.identity.ConstellationsBrowser
 *
 * Floating window that closes the one real gap in constellation support:
 * nothing in this codebase built the signed payload POST /c/:name expects
 * (`{did, genesisObjId, genesisNonce, createdAt, creationSig}`), even
 * though the server route itself works
 * (ConstellationRegistry.js/IdentityServer.js). Every sibling identity tool
 * (Wallet, Mailbox, Worlds, Files, Profile) is a lively.BuildSpec window
 * opened from the menu bar, not a server-rendered page — this follows the
 * same convention (see WorldsBrowser.js, the closest template).
 *
 * Two sections:
 *   - Create: name + public/private toggle + "Create" button. Builds the
 *     genesis objId/nonce (same lively.identity.webKey.generateGenesisObjId
 *     helper post cards use), the did:web string, signs the creation
 *     payload with the device's soft signing key (same KEK-unwrap dance
 *     UserSpace.js/PostCardSerializer.js already use for envelope signing,
 *     but signing the bare payload directly and erroring rather than
 *     silently no-op'ing — creationSig is mandatory, unlike an envelope's
 *     optional sig), then POSTs it. On success, navigates into the new
 *     constellation's live space.
 *   - Known constellations: a client-side-only (localStorage) list of
 *     constellations created or opened from this browser, plus a plain
 *     "open by name" field for one you didn't create yourself (e.g.
 *     joined via a direct link). No server-side "list my constellations"
 *     route exists yet — out of scope here; nothing today tracks
 *     membership in a way that's cheap to query for this.
 *
 * NOTE: every helper this spec's methods need lives ON the spec object
 * itself (this._foo), not as a free function in the enclosing .toRun()
 * closure — lively.BuildSpec method bodies are eval'd independently and do
 * NOT share that closure (confirmed live: a free `function _loadKnown(){}`
 * declared here throws "ReferenceError: _loadKnown is not defined" when
 * called from a spec method). WorldsBrowser.js's own methods are all
 * self-contained for the same reason.
 *
 * Entry point (same pattern as every other BuildSpec browser here, e.g.
 * MenuBarEntry.js's openMyWorlds):
 *   lively.require("lively.identity.ConstellationsBrowser").toRun(function () {
 *     lively.BuildSpec("lively.identity.ConstellationsBrowser").createMorph().openInWorldCenter();
 *   });
 */

module("lively.identity.ConstellationsBrowser")
  .requires(
    "lively.identity.DID",
    "lively.identity.WebKey",
    "lively.identity.WebAuthn",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    lively.BuildSpec("lively.identity.ConstellationsBrowser", {
      _Extent: lively.pt(460, 460),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "ConstellationsBrowser",
      submorphs: [
        {
          _Extent: lively.pt(454, 435),
          _Fill: Color.rgb(250, 250, 250),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: { adjustForNewBounds: true, resizeHeight: true, resizeWidth: true },
          name: "constellationsBrowserContent",
          submorphs: [],
        },
      ],

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this.targetMorph = this.get("constellationsBrowserContent");
        var titleBar = this.makeTitleBar("My Constellations", this.getExtent().x);
        this.titleBar = this.addMorph(titleBar);
        this._visibility = "public";
        this.buildUI();
        this.renderKnown();
      },

      buildUI: function buildUI() {
        var self = this;
        var content = this.get("constellationsBrowserContent");
        if (!content) return;
        content.removeAllMorphs();

        var pad = 12;
        var w = content.getExtent().x - pad * 2;
        var y = pad;
        var PINK = Color.rgb(240, 26, 105);
        var GRAY = Color.rgb(140, 140, 140);

        var header = new lively.morphic.Text(lively.rect(pad, y, w, 18), "Create a constellation");
        header.applyStyle({ allowInput: false, fontSize: 13, fontWeight: "bold", textColor: Color.rgb(40, 40, 40), fill: null });
        content.addMorph(header);
        y += 26;

        var nameInput = new lively.morphic.Text(lively.rect(pad, y, w - 90, 26), "");
        nameInput.name = "nameInput";
        nameInput.applyStyle({
          allowInput: true, fontSize: 12, fill: Color.white, borderWidth: 1,
          borderColor: Color.rgb(190, 190, 190), borderRadius: 3, padding: lively.rect(6, 5, 0, 0),
        });
        nameInput.beInputLine();
        content.addMorph(nameInput);
        this._nameInput = nameInput;

        var visBtn = new lively.morphic.Text(lively.rect(pad + w - 84, y + 2, 84, 22), "Public ▾");
        visBtn.applyStyle({ allowInput: false, fontSize: 12, textColor: PINK, fill: Color.rgb(255, 255, 255), borderWidth: 1, borderColor: Color.rgb(220, 220, 220), borderRadius: 3 });
        visBtn.onMouseDown = function () {
          self._visibility = self._visibility === "public" ? "private" : "public";
          visBtn.setTextString(self._visibility === "public" ? "Public ▾" : "Private ▾");
        };
        content.addMorph(visBtn);
        this._visBtn = visBtn;
        y += 34;

        var createLink = new lively.morphic.Text(lively.rect(pad, y, 100, 20), "Create →");
        createLink.applyStyle({ allowInput: false, fontSize: 13, fontWeight: "bold", textColor: PINK, fill: null });
        createLink.onMouseDown = function () { self.createConstellation(); };
        content.addMorph(createLink);

        var statusText = new lively.morphic.Text(lively.rect(pad + 100, y + 2, w - 100, 18), "");
        statusText.applyStyle({ allowInput: false, fontSize: 11, textColor: GRAY, fill: null });
        content.addMorph(statusText);
        this._statusText = statusText;
        y += 30;

        var div = new lively.morphic.Box(lively.rect(pad, y, w, 1));
        div.applyStyle({ fill: Color.rgb(220, 220, 220), borderWidth: 0 });
        content.addMorph(div);
        y += 12;

        var knownHeader = new lively.morphic.Text(lively.rect(pad, y, w, 18), "Known constellations");
        knownHeader.applyStyle({ allowInput: false, fontSize: 13, fontWeight: "bold", textColor: Color.rgb(40, 40, 40), fill: null });
        content.addMorph(knownHeader);
        y += 24;

        var listH = content.getExtent().y - y - pad - 40;
        var listBox = new lively.morphic.Box(lively.rect(pad, y, w, listH));
        listBox.name = "knownList";
        listBox.applyStyle({ fill: Color.white, clipMode: "auto", borderWidth: 1, borderColor: Color.rgb(220, 220, 220), borderRadius: 3 });
        content.addMorph(listBox);
        this._listBox = listBox;
        y += listH + 10;

        var openInput = new lively.morphic.Text(lively.rect(pad, y, w - 90, 24), "");
        openInput.name = "openInput";
        openInput.applyStyle({
          allowInput: true, fontSize: 12, fill: Color.white, borderWidth: 1,
          borderColor: Color.rgb(190, 190, 190), borderRadius: 3, padding: lively.rect(6, 4, 0, 0),
        });
        openInput.beInputLine();
        content.addMorph(openInput);
        this._openInput = openInput;

        var openLink = new lively.morphic.Text(lively.rect(pad + w - 78, y + 2, 78, 20), "Open →");
        openLink.applyStyle({ allowInput: false, fontSize: 12, textColor: PINK, fill: null });
        openLink.onMouseDown = function () {
          var name = (self._openInput.textString || "").trim();
          if (name) window.location.href = "/c/" + encodeURIComponent(name);
        };
        content.addMorph(openLink);
      },

      setStatus: function setStatus(msg, isError) {
        if (!this._statusText) return;
        this._statusText.setTextString(msg || "");
        this._statusText.setTextColor(isError ? Color.rgb(200, 50, 50) : Color.rgb(140, 140, 140));
      },

      // ─── localStorage-backed "known constellations" list ──────────────────

      _knownStorageKey: function _knownStorageKey() {
        return "lively.identity.knownConstellations";
      },

      _loadKnown: function _loadKnown() {
        try { return JSON.parse(localStorage.getItem(this._knownStorageKey()) || "[]"); }
        catch (e) { return []; }
      },

      _rememberKnown: function _rememberKnown(name) {
        var known = this._loadKnown().filter(function (k) { return k.name !== name; });
        known.unshift({ name: name, at: new Date().toISOString() });
        try { localStorage.setItem(this._knownStorageKey(), JSON.stringify(known.slice(0, 30))); } catch (e) {}
      },

      renderKnown: function renderKnown() {
        var listBox = this._listBox;
        if (!listBox) return;
        listBox.removeAllMorphs();
        var known = this._loadKnown();
        var w = listBox.getExtent().x;
        var PINK = Color.rgb(240, 26, 105);
        var GRAY = Color.rgb(170, 170, 170);

        if (!known.length) {
          var none = new lively.morphic.Text(lively.rect(10, 10, w - 20, 20), "None yet — create one above.");
          none.applyStyle({ allowInput: false, fontSize: 11, textColor: GRAY, fill: null });
          listBox.addMorph(none);
          return;
        }

        var rowH = 30;
        var y = 4;
        known.forEach(function (k) {
          var row = new lively.morphic.Box(lively.rect(0, y, w, rowH));
          row.applyStyle({ fill: null, borderWidth: 0 });

          var nameText = new lively.morphic.Text(lively.rect(10, 6, w - 90, 18), k.name);
          nameText.applyStyle({ allowInput: false, fontSize: 12, textColor: Color.rgb(40, 40, 40), fill: null });
          row.addMorph(nameText);

          var openLink = new lively.morphic.Text(lively.rect(w - 68, 6, 58, 18), "open →");
          openLink.applyStyle({ allowInput: false, fontSize: 12, textColor: PINK, fill: null });
          openLink._url = "/c/" + encodeURIComponent(k.name);
          openLink.onMouseDown = function () { window.location.href = this._url; };
          row.addMorph(openLink);

          var sep = new lively.morphic.Box(lively.rect(10, rowH - 1, w - 20, 1));
          sep.applyStyle({ fill: Color.rgb(238, 238, 238), borderWidth: 0 });
          row.addMorph(sep);

          listBox.addMorph(row);
          y += rowH;
        });
      },

      // ─── creation ────────────────────────────────────────────────────────

      // did:web spec: a port in the host becomes %3A<port>, not a literal
      // ':' (colons already separate the method-specific-id's own segments).
      _didWebForConstellation: function _didWebForConstellation(name) {
        var host = location.hostname + (location.port ? ("%3A" + location.port) : "");
        return "did:web:" + host + ":c:" + encodeURIComponent(name);
      },

      // Signs the bare creation payload with the device's soft signing key —
      // mirrors UserSpace.js's _signProfileEnvelopeIfPossible/
      // PostCardSerializer.js's _signEnvelopeIfPossible (same KEK-cache/
      // softSigningKeyWrapped/c.signJws dance), except: (1) there is no
      // envelope to wrap the signature into — this signs `payload` directly
      // and returns the raw JWS string; (2) missing prerequisites are a
      // real error here, not a silent no-op, since IdentityServer.js's
      // POST /c/:name hard-requires creationSig. If the KEK isn't cached
      // yet this prompts for it (same on-demand passkey ceremony
      // PostCardEditor.js's _saveNowPrivate already uses), rather than
      // failing outright.
      _signConstellationCreation: function _signConstellationCreation(payload, thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error("Not signed in."));
        var method = lively.identity.did.findMethodByCredentialId(user.document, user.credentialId);
        if (!method || !method.lively || !method.lively.softSigningKeyWrapped || !method.lively.delegationCert) {
          return thenDo(new Error(
            "This device has no signing key set up — add a device with a fresh " +
            "passkey ceremony (menu bar -> Add device), then try again."
          ));
        }
        var livelyMeta = method.lively;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;

        function withKek(cb) {
          if (wa._kekCache && wa._kekCache[user.credentialId]) return cb(null, wa._kekCache[user.credentialId]);
          var ch = new Uint8Array(32);
          crypto.getRandomValues(ch);
          wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err) {
            if (err) return cb(err);
            cb(null, wa._kekCache[user.credentialId]);
          });
        }

        withKek(function (err, kek) {
          if (err) return thenDo(err);
          var wrapped;
          try { wrapped = JSON.parse(livelyMeta.softSigningKeyWrapped); } catch (e) { return thenDo(e); }
          c.decryptPayload(wrapped.ciphertext, wrapped.nonce, kek, function (err, softPrivJwk) {
            if (err) return thenDo(err);
            c.importPrivateKeyJwk(softPrivJwk, function (err, softPrivKey) {
              if (err) return thenDo(err);
              c.signJws(payload, softPrivKey, thenDo);
            });
          });
        });
      },

      createConstellation: function createConstellation() {
        var self = this;
        var name = (this._nameInput.textString || "").trim().toLowerCase();
        if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(name)) {
          return this.setStatus("Invalid name — lowercase letters, digits, hyphens, 3-40 chars.", true);
        }
        var user = lively.identity.did.currentUser();
        if (!user) return this.setStatus("Not signed in.", true);

        this.setStatus("Generating…");
        lively.identity.webKey.generateGenesisObjId(user.did, function (err, gen) {
          if (err) return self.setStatus("Error: " + err.message, true);

          var did = self._didWebForConstellation(name);
          var createdAt = new Date().toISOString();
          var payload = {
            name: name,
            did: did,
            controller: [user.did],
            threshold: 1,
            createdBy: user.did,
            createdAt: createdAt,
          };

          self.setStatus("Signing… (confirm your passkey if prompted)");
          self._signConstellationCreation(payload, function (err, creationSig) {
            if (err) return self.setStatus("Signing failed: " + err.message, true);

            self.setStatus("Creating…");
            var base = lively.identity.did.baseUrl();
            var xhr = new XMLHttpRequest();
            xhr.open("POST", base + "/c/" + encodeURIComponent(name), true);
            xhr.withCredentials = true;
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.onload = function () {
              if (xhr.status === 201) {
                self._rememberKnown(name);
                self.setStatus("Created — opening…");
                window.location.href = "/c/" + encodeURIComponent(name);
                return;
              }
              var msg = "Create failed (" + xhr.status + ")";
              try {
                var body = JSON.parse(xhr.responseText);
                if (body && body.error) msg = body.error;
              } catch (e) {}
              self.setStatus(msg, true);
            };
            xhr.onerror = function () { self.setStatus("Network error", true); };
            xhr.send(JSON.stringify({
              did: did,
              genesisObjId: gen.objId,
              genesisNonce: gen.genesisNonce,
              createdAt: createdAt,
              creationSig: creationSig,
              visibility: self._visibility,
            }));
          });
        });
      },
    });

  }); // end module('lively.identity.ConstellationsBrowser')
