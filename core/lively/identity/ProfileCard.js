/**
 * lively.identity.ProfileCard
 *
 * Simple single-column profile window.
 * Read view: handle, displayName, bio, links, DID + device info.
 * Owner: Edit button switches to editable fields with Save/Cancel.
 *
 * Button handlers use this.owner._win to reach the Window and
 * this._prop for data stored on the button, avoiding evalJS closure loss.
 *
 * Open: lively.identity.ProfileCard.open(handle?)
 */

module("lively.identity.ProfileCard")
  .requires(
    "lively.identity.UserSpace",
    "lively.identity.DID",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    lively.BuildSpec("lively.identity.ProfileCard", {
      _Extent:         lively.pt(420, 480),
      _BorderRadius:   10,
      className:       "lively.morphic.Window",
      contentOffset:   lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout:          { adjustForNewBounds: true },
      name:            "ProfileCardWindow",

      submorphs: [{
        _Extent:       lively.pt(414, 455),
        _Fill:         Color.rgb(255, 255, 255),
        _Position:     lively.pt(3, 22),
        _BorderRadius: 10,
        className:     "lively.morphic.Box",
        layout:    { adjustForNewBounds: true, resizeHeight: true, resizeWidth: true },
        name:      "ProfileCardPane",
        submorphs: [],
      }],

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this.targetMorph = this.get("ProfileCardPane");
        this._editMode   = false;
        this._handle     = null;
        this._envelope   = null;
        this._isOwner    = false;
        var titleBar = this.makeTitleBar("Profile", this.getExtent().x);
        this.titleBar = this.addMorph(titleBar);
      },

      loadProfile: function loadProfile(handle) {
        var self   = this;
        var user   = lively.identity.did.currentUser();
        var target = handle || (user && user.handle);
        if (!target) { self._showMsg("Not logged in."); return; }

        self._handle  = target;
        self._isOwner = !!(user && user.handle === target);

        fetch("/@" + target + "/profile", { credentials: "include" })
          .then(function (res) {
            if (!res.ok) {
              self._showMsg("Could not load profile (HTTP " + res.status + ")");
              return;
            }
            return res.json().then(function (env) {
              self._envelope = env;
              var payload    = (env.record && env.record.payload) || {};
              var dp = (self._isOwner && user.document)
                ? Promise.resolve(user.document)
                : fetch("/@" + target + "/did-document", { credentials: "include" })
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .catch(function () { return null; });
              dp.then(function (didDoc) {
                self._renderView(target, payload, didDoc, env.did);
              });
            });
          })
          .catch(function (err) {
            self._showMsg("Error: " + err.message);
          });
      },

      _showMsg: function _showMsg(msg) {
        var pane = this.targetMorph;
        if (!pane) return;
        pane.removeAllMorphs();
        var t = new lively.morphic.Text(lively.rect(12, 12, 390, 20), msg);
        t.applyStyle({ allowInput: false, fontSize: 12,
          textColor: Color.rgb(100, 100, 100),
          fill: Color.rgb(255, 255, 255), borderWidth: 0 });
        pane.addMorph(t);
      },

      // ── read view ────────────────────────────────────────────────────────────

      _renderView: function _renderView(handle, payload, didDoc, did) {
        var self = this;
        var pane = this.targetMorph;
        if (!pane) return;
        pane.removeAllMorphs();

        // Store context on the pane so button onFire handlers can reach it
        // without relying on closures (evalJS loses them).
        // _win is excluded from serialization to prevent a circular-reference
        // crash when the world is saved with ProfileCard open.
        pane._win = self;
        if (pane.doNotSerialize && pane.doNotSerialize.indexOf('_win') === -1)
          pane.doNotSerialize.push('_win');
        self._currentDid = did;

        var pw = pane.getExtent().x;
        var y  = 12;

        function txt(str, x, top, w, h, size, r, g, b, bold) {
          var t = new lively.morphic.Text(lively.rect(x, top, w, h), str || "");
          t.applyStyle({ allowInput: false, fontSize: size || 12,
            textColor: Color.rgb(r || 30, g || 30, b || 30),
            fontWeight: bold ? "bold" : "normal",
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          return t;
        }

        // handle + display name
        pane.addMorph(txt("@" + handle, 12, y, pw - 24, 16, 11, 120, 120, 120, false));
        y += 19;
        pane.addMorph(txt(payload.displayName || handle, 12, y, pw - 24, 22, 16, 20, 20, 20, true));
        y += 28;

        // bio
        var bioText = payload.bio ||
          (self._isOwner ? "No bio yet. Click Edit to add one." : "");
        if (bioText) {
          var bio = new lively.morphic.Text(lively.rect(12, y, pw - 24, 50), bioText);
          bio.applyStyle({ allowInput: false, fontSize: 12,
            textColor: Color.rgb(80, 80, 80),
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          pane.addMorph(bio);
          y += 58;
        }

        // links
        (payload.links || []).forEach(function (link) {
          pane.addMorph(txt(link.label || link.url, 12, y, pw - 24, 16, 11, 200, 30, 80, false));
          y += 20;
        });

        // divider
        y += 8;
        var div = new lively.morphic.Box(lively.rect(12, y, pw - 24, 1));
        div.applyStyle({ fill: Color.rgb(220, 220, 220), borderWidth: 0 });
        pane.addMorph(div);
        y += 12;

        // verified identity
        pane.addMorph(txt("Verified identity", 12, y, pw - 24, 16, 10, 140, 140, 140, false));
        y += 18;

        var didStr = did
          ? (did.length > 36 ? did.slice(0, 20) + "…" + did.slice(-12) : did) : "—";
        pane.addMorph(txt(didStr, 12, y, pw - 110, 16, 10, 50, 50, 50, false));

        // Copy DID button — stores DID on itself, no closure needed
        var copyBtn = new lively.morphic.Button(lively.rect(pw - 100, y - 2, 88, 22), "Copy DID");
        copyBtn.applyStyle({ fill: Color.rgb(240, 240, 240),
          borderColor: Color.rgb(200, 200, 200), borderRadius: 3,
          fontSize: 10, textColor: Color.rgb(50, 50, 50), borderWidth: 1 });
        copyBtn._copyDid = did;
        copyBtn.addScript(function onFire() {
          var theDid = this._copyDid;
          var btn    = this;
          if (theDid && navigator.clipboard) {
            navigator.clipboard.writeText(theDid).then(function () {
              btn.setLabel("Copied!");
              setTimeout(function () { btn.setLabel("Copy DID"); }, 1500);
            });
          }
        });
        pane.addMorph(copyBtn);
        y += 24;

        // devices
        var vms = (didDoc && didDoc.verificationMethod) || [];
        if (vms.length === 0) {
          pane.addMorph(txt("No device info available", 12, y, pw - 24, 16, 10, 160, 160, 160, false));
          y += 18;
        } else {
          vms.forEach(function (vm) {
            var label = (vm.lively && vm.lively.deviceLabel) || vm.id || "Device";
            pane.addMorph(txt("• " + label, 12, y, pw - 24, 16, 10, 80, 80, 80, false));
            y += 18;
          });
        }

        // Edit button — navigates to Window via this.owner._win
        if (self._isOwner) {
          var ph = pane.getExtent().y;
          var editBtn = new lively.morphic.Button(
            lively.rect(pw - 78, ph - 36, 66, 26), "Edit");
          editBtn.applyStyle({ fill: Color.rgb(240, 26, 105),
            borderColor: Color.rgb(240, 26, 105), borderRadius: 4,
            fontSize: 12, textColor: Color.white, borderWidth: 1 });
          editBtn.addScript(function onFire() {
            var win = this.owner && this.owner._win;
            if (!win) return;
            var env = win._envelope;
            var p   = (env && env.record && env.record.payload) || {};
            win._renderEdit(win._handle, p, win._currentDid);
          });
          pane.addMorph(editBtn);
        }
      },

      // ── edit view ────────────────────────────────────────────────────────────

      _renderEdit: function _renderEdit(handle, payload, did) {
        var self = this;
        var pane = this.targetMorph;
        if (!pane) return;
        pane.removeAllMorphs();
        self._editMode = true;

        // Store context on pane for button handlers (_win excluded from serialization)
        pane._win = self;
        if (pane.doNotSerialize && pane.doNotSerialize.indexOf('_win') === -1)
          pane.doNotSerialize.push('_win');

        var pw   = pane.getExtent().x;
        var y    = 12;
        var PINK = Color.rgb(240, 26, 105);

        function addField(labelText, inputName, value, h) {
          var lbl = new lively.morphic.Text(lively.rect(12, y, pw - 24, 16), labelText);
          lbl.applyStyle({ allowInput: false, fontSize: 10,
            textColor: Color.rgb(120, 120, 120),
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          pane.addMorph(lbl);
          y += 17;
          var inp = new lively.morphic.Text(
            lively.rect(12, y, pw - 24, h || 24), value || "");
          inp.name = inputName;
          inp.applyStyle({ allowInput: true, fontSize: 12,
            fill: Color.rgb(252, 252, 252),
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 3 });
          inp.beInputLine();
          pane.addMorph(inp);
          y += (h || 24) + 8;
        }

        addField("Display name", "pcDisplayName", payload.displayName || "");
        addField("Bio",          "pcBio",         payload.bio         || "", 52);
        addField("Avatar URL",   "pcAvatarUrl",   payload.avatarUrl   || "");
        addField("Banner URL",   "pcBannerUrl",   payload.bannerUrl   || "");
        addField("Links (JSON)", "pcLinks",       JSON.stringify(payload.links || []), 36);

        y += 6;

        // Save — reads named inputs from pane, calls userSpace.saveProfile
        var saveBtn = new lively.morphic.Button(lively.rect(pw - 166, y, 74, 26), "Save");
        saveBtn.applyStyle({ fill: PINK, borderColor: PINK, borderRadius: 4,
          fontSize: 12, textColor: Color.white, borderWidth: 1 });
        saveBtn.addScript(function onFire() {
          var win  = this.owner && this.owner._win;
          var pane = this.owner;
          if (!win || !pane) return;
          var nameInp   = pane.get("pcDisplayName");
          var bioInp    = pane.get("pcBio");
          var avatarInp = pane.get("pcAvatarUrl");
          var bannerInp = pane.get("pcBannerUrl");
          var linksInp  = pane.get("pcLinks");
          var newLinks;
          try { newLinks = JSON.parse(linksInp && linksInp.textString || "[]"); }
          catch (e) { newLinks = []; }
          var newPayload = {
            displayName: nameInp   && nameInp.textString   || win._handle,
            bio:         bioInp    && bioInp.textString    || "",
            avatarUrl:   avatarInp && avatarInp.textString || null,
            bannerUrl:   bannerInp && bannerInp.textString || null,
            links:       newLinks,
          };
          lively.identity.userSpace.saveProfile(newPayload, function (err) {
            if (err) { alert("Save failed: " + err.message); return; }
            win._editMode = false;
            win.loadProfile(win._handle);
          });
        });
        pane.addMorph(saveBtn);

        // Cancel — navigates to Window and reloads view
        var cancelBtn = new lively.morphic.Button(lively.rect(pw - 84, y, 72, 26), "Cancel");
        cancelBtn.applyStyle({ fill: Color.rgb(160, 160, 160),
          borderColor: Color.rgb(160, 160, 160), borderRadius: 4,
          fontSize: 12, textColor: Color.white, borderWidth: 1 });
        cancelBtn.addScript(function onFire() {
          var win = this.owner && this.owner._win;
          if (!win) return;
          win._editMode = false;
          win.loadProfile(win._handle);
        });
        pane.addMorph(cancelBtn);
      },
    });

    lively.identity.ProfileCard = {
      open: function (handle) {
        var win    = lively.BuildSpec("lively.identity.ProfileCard").createMorph();
        var user   = lively.identity.did.currentUser();
        var target = handle || (user && user.handle);
        win.setTitle(target ? "Profile — @" + target : "Profile");
        win.openInWorldCenter();
        win.loadProfile(handle || null);
        return win;
      },
    };

  }); // end module('lively.identity.ProfileCard')
