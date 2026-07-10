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
      _Extent:         lively.pt(840, 620),
      _BorderRadius:   10,
      className:       "lively.morphic.Window",
      contentOffset:   lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout:          { adjustForNewBounds: true },
      name:            "ProfileCardWindow",

      submorphs: [{
        _Extent:       lively.pt(834, 595),
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

        var pw   = pane.getExtent().x;
        var BH   = 160;
        var AV   = 72;
        var RING = 4;

        // banner — always rendered; image if set, placeholder otherwise
        var hasBanner = true;
        if (payload.bannerUrl) {
          var banner = new lively.morphic.Image(lively.rect(0, 0, pw, BH));
          banner.setImageURL(payload.bannerUrl);
          banner.applyStyle({ borderWidth: 0 });
          pane.addMorph(banner);
        } else {
          var bannerBg = new lively.morphic.Box(lively.rect(0, 0, pw, BH));
          bannerBg.applyStyle({ fill: Color.rgb(225, 222, 232), borderWidth: 0 });
          pane.addMorph(bannerBg);
        }

        // avatar always straddles banner bottom-left
        var avX = 32;
        var avY = BH - Math.floor(AV / 2);

        // white ring behind avatar
        var RS = AV + RING * 2;
        var avRing = new lively.morphic.Box(lively.rect(avX - RING, avY - RING, RS, RS));
        avRing.applyStyle({ fill: Color.white, borderRadius: RS / 2, borderWidth: 0 });
        pane.addMorph(avRing);

        // avatar image or blockie identicon
        if (payload.avatarUrl) {
          var img = new lively.morphic.Image(lively.rect(avX, avY, AV, AV));
          img.setImageURL(payload.avatarUrl);
          img.applyStyle({ borderRadius: AV / 2, borderWidth: 0, clipMode: 'hidden' });
          pane.addMorph(img);
        } else {
          (function () {
            var seed = (handle || '?').toLowerCase();
            var SZ = 8, SC = Math.ceil(AV / SZ);
            var rs = [0, 0, 0, 0];
            for (var i = 0; i < seed.length; i++) {
              rs[i % 4] = ((rs[i % 4] << 5) - rs[i % 4]) + seed.charCodeAt(i);
              rs[i % 4] |= 0;
            }
            function rnd() {
              var t = rs[0] ^ (rs[0] << 11);
              rs[0] = rs[1]; rs[1] = rs[2]; rs[2] = rs[3];
              rs[3] = (rs[3] ^ (rs[3] >> 19) ^ t ^ (t >> 8));
              return (rs[3] >>> 0) / ((1 << 31) >>> 0);
            }
            function hsl() {
              return 'hsl(' + Math.floor(rnd() * 360) + ',' +
                (rnd() * 60 + 40) + '%,' +
                ((rnd() + rnd() + rnd() + rnd()) * 25) + '%)';
            }
            var fg = hsl(), bg = hsl(), spot = hsl();
            var half = Math.ceil(SZ / 2);
            var cells = [];
            for (var r = 0; r < SZ; r++) {
              var row = [];
              for (var x = 0; x < half; x++) row.push(Math.floor(rnd() * 2.3));
              var mir = row.slice(0, SZ - half).reverse();
              cells.push(row.concat(mir));
            }
            var bc = document.createElement('canvas');
            bc.width = bc.height = SZ * SC;
            var bctx = bc.getContext('2d');
            cells.forEach(function (row, r) {
              row.forEach(function (v, col) {
                bctx.fillStyle = v === 1 ? fg : v === 2 ? spot : bg;
                bctx.fillRect(col * SC, r * SC, SC, SC);
              });
            });
            var bi = new lively.morphic.Image(lively.rect(avX, avY, AV, AV));
            bi.setImageURL(bc.toDataURL());
            bi.applyStyle({ borderRadius: AV / 2, borderWidth: 0, clipMode: 'hidden' });
            pane.addMorph(bi);
          })();
        }

        var y = avY + AV + 12;

        var contentX = avX; // left margin for all text content

        // astrological signs box — top-right, below banner
        var BW     = 190; // astro box width — also used to constrain content cw
        var SIGNS  = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
                      'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
        var GLYPHS = ['♈︎','♉︎','♊︎','♋︎','♌︎','♍︎','♎︎','♏︎','♐︎','♑︎','♒︎','♓︎'];
        var astroItems = [
          { sym: '☉', label: 'Sun',    val: payload.sunSign    || null },
          { sym: '☽', label: 'Moon',   val: payload.moonSign   || null },
          { sym: '↑', label: 'Rising', val: payload.risingSign || null },
        ];
        var hasAstro = astroItems.some(function (a) { return !!a.val; });
        var bx        = pw - BW - contentX;
        var by        = hasBanner ? (BH + 12) : 12;
        var ROW       = 22;
        var astroBoxH = ROW * 3 + 20;
        if (hasAstro || self._isOwner) {
          var astroBox = new lively.morphic.Box(
            lively.rect(bx, by, BW, astroBoxH));
          astroBox.applyStyle({ fill: Color.rgb(249, 249, 251),
            borderRadius: 8, borderColor: Color.rgb(218, 218, 224), borderWidth: 1 });
          pane.addMorph(astroBox);
          astroItems.forEach(function (item, i) {
            var ry = 7 + i * ROW;
            var si = SIGNS.indexOf(item.val);
            var symM = new lively.morphic.Text(lively.rect(10, ry, 20, ROW), item.sym);
            symM.applyStyle({ allowInput: false, fontSize: 14,
              textColor: Color.rgb(90, 90, 90),
              fill: Color.rgba(0,0,0,0), borderWidth: 0 });
            astroBox.addMorph(symM);
            var lblM = new lively.morphic.Text(lively.rect(32, ry + 4, 44, 14), item.label);
            lblM.applyStyle({ allowInput: false, fontSize: 9,
              textColor: Color.rgb(160, 160, 160),
              fill: Color.rgba(0,0,0,0), borderWidth: 0 });
            astroBox.addMorph(lblM);
            var signStr = item.val && si >= 0 ? (GLYPHS[si] + ' ' + item.val) : '—';
            var valM = new lively.morphic.Text(lively.rect(80, ry + 2, BW - 88, ROW - 2), signStr);
            valM.applyStyle({ allowInput: false, fontSize: 11,
              fontWeight: item.val ? 'bold' : 'normal',
              textColor: item.val ? Color.rgb(35, 35, 35) : Color.rgb(180, 180, 180),
              fill: Color.rgba(0,0,0,0), borderWidth: 0 });
            astroBox.addMorph(valM);
          });
        }

        function txt(str, x, top, w, h, size, r, g, b, bold) {
          var t = new lively.morphic.Text(lively.rect(x, top, w, h), str || "");
          t.applyStyle({ allowInput: false, fontSize: size || 12,
            textColor: Color.rgb(r || 30, g || 30, b || 30),
            fontWeight: bold ? "bold" : "normal",
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          return t;
        }

        var cw = bx - contentX - 12; // stop before astro box (12px gap)

        // handle + display name
        pane.addMorph(txt("@" + handle, contentX, y, cw, 16, 11, 120, 120, 120, false));
        y += 19;
        pane.addMorph(txt(payload.displayName || handle, contentX, y, cw, 22, 16, 20, 20, 20, true));
        y += 24;
        if (payload.pronouns) {
          pane.addMorph(txt(payload.pronouns, contentX, y, cw, 14, 10, 120, 120, 120, false));
          y += 17;
        }

        // bio
        var bioText = payload.bio ||
          (self._isOwner ? "No bio yet. Click Edit to add one." : "");
        if (bioText) {
          var bio = new lively.morphic.Text(lively.rect(contentX, y, cw, 50), bioText);
          bio.applyStyle({ allowInput: false, fontSize: 12,
            textColor: Color.rgb(80, 80, 80),
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          pane.addMorph(bio);
          y += 58;
        }

        // links
        (payload.links || []).forEach(function (link) {
          pane.addMorph(txt(link.label || link.url, contentX, y, cw, 16, 11, 200, 30, 80, false));
          y += 20;
        });

        // divider
        y += 8;
        var div = new lively.morphic.Box(lively.rect(contentX, y, pw - contentX * 2, 1));
        div.applyStyle({ fill: Color.rgb(220, 220, 220), borderWidth: 0 });
        pane.addMorph(div);
        var dividerY = y;
        y += 12;

        // encryption status — whether this account can receive private/shared
        // postcards. Surfaced here (rather than only failing at Send time,
        // see PostCardEditor.js's Send dialog) so it's visible up front,
        // including to the owner themselves if their own device never
        // completed the WebAuthn PRF delegation ceremony that publishes this.
        var encLabel = payload.accountX25519Pub
          ? "🔒 Can receive encrypted postcards"
          : "🔓 Hasn't set up encryption yet";
        var encColor = payload.accountX25519Pub ? [46, 125, 50] : [170, 130, 20];
        pane.addMorph(txt(encLabel, contentX, y, cw, 14, 10,
          encColor[0], encColor[1], encColor[2], false));
        y += 17;

        // Friends button — shown to all; behaviour is ownership-aware
        // TODO: wire to /identity/friends/:handle once that endpoint exists
        (function () {
          var btnW = 108, btnH = 26;
          var btnX = bx + Math.floor((BW - btnW) / 2);
          var btnY = Math.round((by + astroBoxH + dividerY) / 2 - btnH / 2);
          var friendsBtn = new lively.morphic.Button(lively.rect(btnX, btnY, btnW, btnH), '✉︎  Friends');
          friendsBtn.applyStyle({ borderRadius: 26, borderWidth: 1,
            borderColor: Color.rgb(200, 200, 210),
            fill: Color.rgb(249, 249, 251), fontSize: 12 });
          friendsBtn.setAppearanceStylingMode(false);
          friendsBtn.setBorderStylingMode(false);
          friendsBtn._handle  = handle;
          friendsBtn._isOwner = !!self._isOwner;
          friendsBtn.addScript(function doAction() {
            var FW     = 280;
            var FH     = this._isOwner ? 160 : 120;
            var btnPos = this.getGlobalTransform().getTranslation();
            var panel  = new lively.morphic.Box(
              lively.rect(btnPos.x, btnPos.y + this.getExtent().y + 4, FW, FH));
            panel.applyStyle({ fill: Color.white, borderRadius: 8,
              borderColor: Color.rgb(218, 218, 224), borderWidth: 1 });
            var titleM = new lively.morphic.Text(lively.rect(12, 10, FW - 44, 18), 'Friends');
            titleM.applyStyle({ allowInput: false, fontSize: 13, fontWeight: 'bold',
              fill: Color.rgba(0,0,0,0), borderWidth: 0,
              textColor: Color.rgb(30, 30, 30) });
            panel.addMorph(titleM);
            if (this._isOwner) {
              var emptyM = new lively.morphic.Text(lively.rect(12, 36, FW - 24, 80), 'No friends yet.');
              emptyM.applyStyle({ allowInput: false, fontSize: 12,
                textColor: Color.rgb(150, 150, 150),
                fill: Color.rgba(0,0,0,0), borderWidth: 0 });
              panel.addMorph(emptyM);
            } else {
              var msgM = new lively.morphic.Text(lively.rect(12, 36, FW - 24, 40),
                'You and @' + this._handle + ' are not yet friends.');
              msgM.applyStyle({ allowInput: false, fontSize: 12,
                textColor: Color.rgb(60, 60, 60),
                fill: Color.rgba(0,0,0,0), borderWidth: 0 });
              panel.addMorph(msgM);
              var reqBtn = new lively.morphic.Button(lively.rect(12, 80, FW - 24, 28));
              reqBtn.setLabel('Send friend request');
              reqBtn.applyStyle({ borderRadius: 6, fontSize: 12, borderWidth: 1,
                borderColor: Color.rgb(200, 200, 210),
                fill: Color.rgb(249, 249, 251) });
              reqBtn.setAppearanceStylingMode(false);
              reqBtn.setBorderStylingMode(false);
              reqBtn._handle = this._handle;
              reqBtn.addScript(function doAction() {
                // TODO: POST to /identity/friends/:handle once that endpoint exists
                $world.inform('Friend request sent to @' + this._handle + '!');
              });
              lively.bindings.connect(reqBtn, 'fire', reqBtn, 'doAction');
              panel.addMorph(reqBtn);
            }
            var closeBtn = new lively.morphic.Button(lively.rect(FW - 28, 6, 22, 22));
            closeBtn.setLabel('✕');
            closeBtn.applyStyle({ borderRadius: 11, fontSize: 11, borderWidth: 0,
              fill: Color.rgba(0,0,0,0), textColor: Color.rgb(100, 100, 100) });
            closeBtn.addScript(function doAction() { this.owner.remove(); });
            lively.bindings.connect(closeBtn, 'fire', closeBtn, 'doAction');
            panel.addMorph(closeBtn);
            $world.addMorph(panel);
          });
          lively.bindings.connect(friendsBtn, 'fire', friendsBtn, 'doAction');
          pane.addMorph(friendsBtn);
        })();


        // verified identity
        pane.addMorph(txt("Verified identity", contentX, y, cw, 16, 10, 140, 140, 140, false)).applyStyle({ fixedWidth: false });
        y += 18;

        var didStr = did
          ? (did.length > 36 ? did.slice(0, 20) + "…" + did.slice(-12) : did) : "—";
        var didW = Math.ceil(didStr.length * 7.5) + 16;
        pane.addMorph(txt(didStr, contentX, y, didW, 16, 10, 50, 50, 50, false));

        // Copy DID button — sits immediately after the DID text
        var copyBtn = new lively.morphic.Button(lively.rect(contentX + didW + 4, y - 2, 26, 22), '⧉︎');
        copyBtn.applyStyle({ fill: Color.rgb(240, 240, 240),
          borderColor: Color.rgb(200, 200, 200), borderRadius: 4,
          fontSize: 14, textColor: Color.rgb(80, 80, 80), borderWidth: 1 });
        copyBtn.setAppearanceStylingMode(false);
        copyBtn.setBorderStylingMode(false);
        copyBtn._copyDid = did;
        copyBtn.addScript(function doAction() {
          var theDid = this._copyDid;
          var btn    = this;
          if (theDid && navigator.clipboard) {
            navigator.clipboard.writeText(theDid).then(function () {
              btn.setLabel('✓︎');
              setTimeout(function () { btn.setLabel('⧉︎'); }, 1500);
            });
          }
        });
        lively.bindings.connect(copyBtn, 'fire', copyBtn, 'doAction');
        pane.addMorph(copyBtn);
        copyBtn.renderContext().morphNode.title = 'Copy DID';
        y += 24;

        // device
        pane.addMorph(txt("Device", contentX, y, cw, 16, 10, 140, 140, 140, false)).applyStyle({ fixedWidth: false });
        y += 18;
        var vms = (didDoc && didDoc.verificationMethod) || [];
        if (vms.length === 0) {
          pane.addMorph(txt("No device registered", contentX, y, cw, 16, 10, 160, 160, 160, false)).applyStyle({ fixedWidth: false });
          y += 18;
        } else {
          vms.forEach(function (vm) {
            var label = (vm.lively && vm.lively.deviceLabel) || vm.id || "Unknown device";
            pane.addMorph(txt(label, contentX, y, cw, 16, 10, 80, 80, 80, false)).applyStyle({ fixedWidth: false });
            y += 18;
          });
        }

        // joined + hosting
        var joinedStr = "—";
        if (self._envelope && self._envelope.created) {
          var d = new Date(self._envelope.created);
          var months = ["Jan","Feb","Mar","Apr","May","Jun",
                        "Jul","Aug","Sep","Oct","Nov","Dec"];
          joinedStr = months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
        }
        var hostStr = (window.location.hostname) || "—";
        y += 6;
        pane.addMorph(txt("Joined: " + joinedStr, contentX, y, cw, 16, 10, 100, 100, 100, false)).applyStyle({ fixedWidth: false });
        y += 18;
        pane.addMorph(txt("Hosting: " + hostStr, contentX, y, cw, 16, 10, 100, 100, 100, false)).applyStyle({ fixedWidth: false });
        y += 18;

        // Edit button — navigates to Window via this.owner._win
        if (self._isOwner) {
          var ph = pane.getExtent().y;
          var editBtn = new lively.morphic.Button(
            lively.rect(pw - 78, ph - 36, 66, 26), "Edit");
          editBtn.applyStyle({ fill: Color.rgb(240, 26, 105),
            borderColor: Color.rgb(240, 26, 105), borderRadius: 4,
            fontSize: 12, textColor: Color.white, borderWidth: 1 });
          editBtn.setAppearanceStylingMode(false);
          editBtn.setBorderStylingMode(false);
          editBtn.addScript(function doAction() {
            var pane = this.owner;
            var win  = pane && pane.owner;
            if (!win) return;
            var env = win._envelope;
            var p   = (env && env.record && env.record.payload) || {};
            win._renderEdit(win._handle, p, win._currentDid);
          });
          lively.bindings.connect(editBtn, 'fire', editBtn, 'doAction');
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
        var ew   = Math.min(pw - 24, 500); // cap form width so inputs don't span the full pane

        function addField(labelText, inputName, value, h) {
          var lbl = new lively.morphic.Text(lively.rect(12, y, ew, 16), labelText);
          lbl.applyStyle({ allowInput: false, fontSize: 10,
            textColor: Color.rgb(120, 120, 120),
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          pane.addMorph(lbl);
          y += 17;
          var inp = new lively.morphic.Text(
            lively.rect(12, y, ew, h || 24), value || "");
          inp.name = inputName;
          inp.applyStyle({ allowInput: true, fontSize: 12,
            fill: Color.rgb(252, 252, 252),
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 3 });
          inp.beInputLine();
          pane.addMorph(inp);
          y += (h || 24) + 8;
        }

        addField("Display name", "pcDisplayName", payload.displayName || "");
        addField("Pronouns",     "pcPronouns",    payload.pronouns    || "");
        addField("Bio",          "pcBio",         payload.bio         || "", 52);

        // Avatar URL — label + narrow input + Upload button on same row
        var avUrlLbl = new lively.morphic.Text(lively.rect(12, y, ew, 16), "Avatar URL");
        avUrlLbl.applyStyle({ allowInput: false, fontSize: 10,
          textColor: Color.rgb(120, 120, 120),
          fill: Color.rgb(255, 255, 255), borderWidth: 0 });
        pane.addMorph(avUrlLbl);
        y += 17;
        var avUrlInp = new lively.morphic.Text(lively.rect(12, y, ew - 84, 24), payload.avatarUrl || "");
        avUrlInp.name = "pcAvatarUrl";
        avUrlInp.applyStyle({ allowInput: true, fontSize: 12,
          fill: Color.rgb(252, 252, 252),
          borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 3 });
        avUrlInp.beInputLine();
        pane.addMorph(avUrlInp);
        var avUploadBtn = new lively.morphic.Button(lively.rect(12 + ew - 76, y, 76, 26), "Upload...");
        avUploadBtn.applyStyle({ fill: Color.rgb(240, 240, 240),
          borderColor: Color.rgb(200, 200, 200), borderRadius: 4,
          fontSize: 11, textColor: Color.rgb(50, 50, 50), borderWidth: 1 });
        avUploadBtn.setAppearanceStylingMode(false);
        avUploadBtn.setBorderStylingMode(false);
        avUploadBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (!win) return;
          var input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.style.display = 'none';
          document.body.appendChild(input);
          input.addEventListener('change', function () {
            var file = input.files && input.files[0];
            document.body.removeChild(input);
            if (!file) return;
            win._openCropper(file, function (url) {
              var pane2 = win.targetMorph;
              var inp2  = pane2 && pane2.get('pcAvatarUrl');
              if (inp2) inp2.textString = url;
            });
          });
          input.click();
        });
        lively.bindings.connect(avUploadBtn, 'fire', avUploadBtn, 'doAction');
        pane.addMorph(avUploadBtn);
        y += 32;

        // Banner URL row — manual layout for Upload button
        var bnLbl = new lively.morphic.Text(lively.rect(12, y, ew, 16), "Banner URL");
        bnLbl.applyStyle({ allowInput: false, fontSize: 10,
          textColor: Color.rgb(120, 120, 120),
          fill: Color.rgb(255, 255, 255), borderWidth: 0 });
        pane.addMorph(bnLbl);
        y += 17;
        var bnInp = new lively.morphic.Text(lively.rect(12, y, ew - 84, 24), payload.bannerUrl || "");
        bnInp.name = "pcBannerUrl";
        bnInp.applyStyle({ allowInput: true, fontSize: 12,
          fill: Color.rgb(252, 252, 252),
          borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 3 });
        bnInp.beInputLine();
        pane.addMorph(bnInp);
        var bnUploadBtn = new lively.morphic.Button(lively.rect(12 + ew - 76, y, 76, 26), "Upload...");
        bnUploadBtn.applyStyle({ fill: Color.rgb(240, 240, 240),
          borderColor: Color.rgb(200, 200, 200), borderRadius: 4,
          fontSize: 11, textColor: Color.rgb(50, 50, 50), borderWidth: 1 });
        bnUploadBtn.setAppearanceStylingMode(false);
        bnUploadBtn.setBorderStylingMode(false);
        bnUploadBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (!win) return;
          var input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.style.display = 'none';
          document.body.appendChild(input);
          input.addEventListener('change', function () {
            var file = input.files && input.files[0];
            document.body.removeChild(input);
            if (!file) return;
            win._openCropper(file, function (url) {
              var pane2 = win.targetMorph;
              var inp2  = pane2 && pane2.get('pcBannerUrl');
              if (inp2) inp2.textString = url;
            }, { width: 834, height: 160, shape: 'rect',
                 title: 'Crop Banner', subfolder: 'banners', basename: 'banner' });
          });
          input.click();
        });
        lively.bindings.connect(bnUploadBtn, 'fire', bnUploadBtn, 'doAction');
        pane.addMorph(bnUploadBtn);
        y += 32;

        addField("Links (JSON)", "pcLinks", JSON.stringify(payload.links || []), 36);

        // astrological signs steppers
        var SIGNS  = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
                      'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
        var GLYPHS = ['♈︎','♉︎','♊︎','♋︎','♌︎','♍︎','♎︎','♏︎','♐︎','♑︎','♒︎','♓︎'];

        y += 6;
        var astroLbl = new lively.morphic.Text(lively.rect(12, y, ew, 16), "Astrological signs");
        astroLbl.applyStyle({ allowInput: false, fontSize: 10,
          textColor: Color.rgb(120, 120, 120),
          fill: Color.rgb(255, 255, 255), borderWidth: 0 });
        pane.addMorph(astroLbl);
        y += 20;

        function addSignPicker(symbol, fieldName, currentSign) {
          var idx = Math.max(0, SIGNS.indexOf(currentSign));
          var symLbl = new lively.morphic.Text(lively.rect(12, y, 30, 26), symbol);
          symLbl.applyStyle({ allowInput: false, fontSize: 15,
            textColor: Color.rgb(70, 70, 70),
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          pane.addMorph(symLbl);
          var prevBtn = new lively.morphic.Button(lively.rect(46, y, 30, 26), '◀');
          prevBtn.applyStyle({ fill: Color.rgb(245, 245, 245),
            borderColor: Color.rgb(200, 200, 200), borderRadius: 4,
            fontSize: 11, textColor: Color.rgb(60, 60, 60), borderWidth: 1 });
          prevBtn.setAppearanceStylingMode(false);
          prevBtn.setBorderStylingMode(false);
          prevBtn._targetField = fieldName;
          prevBtn.addScript(function doAction() {
            var pane = this.owner;
            var disp = pane && pane.get(this._targetField);
            if (!disp) return;
            var S = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
                     'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
            var G = ['♈︎','♉︎','♊︎','♋︎','♌︎','♍︎','♎︎','♏︎','♐︎','♑︎','♒︎','♓︎'];
            disp._signIdx = (((disp._signIdx || 0) - 1) + 12) % 12;
            disp.textString = G[disp._signIdx] + '  ' + S[disp._signIdx];
          });
          lively.bindings.connect(prevBtn, 'fire', prevBtn, 'doAction');
          pane.addMorph(prevBtn);
          var disp = new lively.morphic.Text(lively.rect(80, y, 200, 26),
            GLYPHS[idx] + '  ' + SIGNS[idx]);
          disp.name = fieldName;
          disp._signIdx = idx;
          disp.applyStyle({ allowInput: false, fontSize: 13, fontWeight: 'bold',
            textColor: Color.rgb(35, 35, 35),
            fill: Color.rgb(248, 248, 251),
            borderColor: Color.rgb(218, 218, 224), borderWidth: 1, borderRadius: 4,
            align: 'center' });
          pane.addMorph(disp);
          var nextBtn = new lively.morphic.Button(lively.rect(284, y, 30, 26), '▶');
          nextBtn.applyStyle({ fill: Color.rgb(245, 245, 245),
            borderColor: Color.rgb(200, 200, 200), borderRadius: 4,
            fontSize: 11, textColor: Color.rgb(60, 60, 60), borderWidth: 1 });
          nextBtn.setAppearanceStylingMode(false);
          nextBtn.setBorderStylingMode(false);
          nextBtn._targetField = fieldName;
          nextBtn.addScript(function doAction() {
            var pane = this.owner;
            var disp = pane && pane.get(this._targetField);
            if (!disp) return;
            var S = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
                     'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
            var G = ['♈︎','♉︎','♊︎','♋︎','♌︎','♍︎','♎︎','♏︎','♐︎','♑︎','♒︎','♓︎'];
            disp._signIdx = ((disp._signIdx || 0) + 1) % 12;
            disp.textString = G[disp._signIdx] + '  ' + S[disp._signIdx];
          });
          lively.bindings.connect(nextBtn, 'fire', nextBtn, 'doAction');
          pane.addMorph(nextBtn);
          y += 32;
        }

        addSignPicker('☉', 'pcSunSign',    payload.sunSign    || '');
        addSignPicker('☽', 'pcMoonSign',   payload.moonSign   || '');
        addSignPicker('↑', 'pcRisingSign', payload.risingSign || '');

        y += 6;

        // Save — reads named inputs from pane, calls userSpace.saveProfile
        var saveBtn = new lively.morphic.Button(lively.rect(12 + ew - 154, y, 74, 26), "Save");
        saveBtn.applyStyle({ fill: PINK, borderColor: PINK, borderRadius: 4,
          fontSize: 12, textColor: Color.white, borderWidth: 1 });
        saveBtn.setAppearanceStylingMode(false);
        saveBtn.setBorderStylingMode(false);
        saveBtn.addScript(function doAction() {
          var win  = this.owner && this.owner.owner;
          var pane = this.owner;
          if (!win || !pane) return;
          var nameInp     = pane.get("pcDisplayName");
          var pronounsInp = pane.get("pcPronouns");
          var bioInp      = pane.get("pcBio");
          var avatarInp   = pane.get("pcAvatarUrl");
          var bannerInp   = pane.get("pcBannerUrl");
          var linksInp    = pane.get("pcLinks");
          var sunInp      = pane.get("pcSunSign");
          var moonInp     = pane.get("pcMoonSign");
          var risingInp   = pane.get("pcRisingSign");
          var newLinks;
          try { newLinks = JSON.parse(linksInp && linksInp.textString || "[]"); }
          catch (e) { newLinks = []; }
          var SV = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
                    'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
          var newPayload = {
            displayName: nameInp     && nameInp.textString     || win._handle,
            pronouns:    pronounsInp && pronounsInp.textString || "",
            bio:         bioInp      && bioInp.textString      || "",
            avatarUrl:   avatarInp   && avatarInp.textString   || null,
            bannerUrl:   bannerInp   && bannerInp.textString   || null,
            links:       newLinks,
            sunSign:     sunInp    ? SV[sunInp._signIdx    || 0] : "",
            moonSign:    moonInp   ? SV[moonInp._signIdx   || 0] : "",
            risingSign:  risingInp ? SV[risingInp._signIdx || 0] : "",
          };
          lively.identity.userSpace.saveProfile(newPayload, function (err) {
            if (err) { alert("Save failed: " + err.message); return; }
            win._editMode = false;
            win.loadProfile(win._handle);
          });
        });
        lively.bindings.connect(saveBtn, 'fire', saveBtn, 'doAction');
        pane.addMorph(saveBtn);

        // Cancel — navigates to Window and reloads view
        var cancelBtn = new lively.morphic.Button(lively.rect(12 + ew - 72, y, 72, 26), "Cancel");
        cancelBtn.applyStyle({ fill: Color.rgb(160, 160, 160),
          borderColor: Color.rgb(160, 160, 160), borderRadius: 4,
          fontSize: 12, textColor: Color.white, borderWidth: 1 });
        cancelBtn.setAppearanceStylingMode(false);
        cancelBtn.setBorderStylingMode(false);
        cancelBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (!win) return;
          win._editMode = false;
          win.loadProfile(win._handle);
        });
        lively.bindings.connect(cancelBtn, 'fire', cancelBtn, 'doAction');
        pane.addMorph(cancelBtn);
      },

      // ── avatar crop/upload ────────────────────────────────────────────────────

      _openCropper: function _openCropper(imageFile, onDone, opts) {
        var user = lively.identity.did.currentUser();
        if (!user) { alert("Not logged in"); return; }
        opts = opts || {};

        var W         = opts.width     || 300;
        var H         = opts.height    || 300;
        var shape     = opts.shape     || 'circle';
        var title     = opts.title     || 'Crop Avatar';
        var subfolder = opts.subfolder || 'avatars';
        var basename  = opts.basename  || 'avatar';

        var state = { x: 0, y: 0, scale: 1 };
        var img   = new Image();

        var overlay = document.createElement('div');
        overlay.style.cssText =
          'position:fixed;top:0;left:0;width:100%;height:100%;' +
          'background:rgba(0,0,0,0.72);z-index:99999;' +
          'display:flex;align-items:center;justify-content:center;';

        var panel = document.createElement('div');
        panel.style.cssText =
          'background:#1e1e1e;border-radius:10px;padding:20px;' +
          'box-shadow:0 8px 32px rgba(0,0,0,0.6);';

        var titleEl = document.createElement('div');
        titleEl.textContent = title;
        titleEl.style.cssText =
          'color:#fff;font-size:14px;font-weight:bold;' +
          'text-align:center;margin-bottom:12px;font-family:sans-serif;';

        var canvas = document.createElement('canvas');
        canvas.width  = W;
        canvas.height = H;
        canvas.style.cssText = 'display:block;cursor:move;border-radius:4px;';

        var hint = document.createElement('div');
        hint.textContent = 'Drag to reposition  ·  Scroll to zoom';
        hint.style.cssText =
          'color:#888;font-size:10px;text-align:center;' +
          'margin-top:8px;font-family:sans-serif;';

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;margin-top:14px;';

        var saveBtn   = document.createElement('button');
        var cancelBtn = document.createElement('button');
        saveBtn.textContent   = 'Crop & Upload';
        cancelBtn.textContent = 'Cancel';
        var btnBase = 'flex:1;padding:9px 0;border:none;border-radius:4px;' +
                      'cursor:pointer;font-size:12px;font-family:sans-serif;';
        saveBtn.style.cssText   = btnBase + 'background:#f01a69;color:#fff;';
        cancelBtn.style.cssText = btnBase + 'background:#555;color:#fff;';

        panel.appendChild(titleEl);
        panel.appendChild(canvas);
        panel.appendChild(hint);
        panel.appendChild(btnRow);
        btnRow.appendChild(saveBtn);
        btnRow.appendChild(cancelBtn);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        var ctx = canvas.getContext('2d');

        function draw() {
          ctx.clearRect(0, 0, W, H);
          ctx.save();
          ctx.translate(state.x + W / 2, state.y + H / 2);
          ctx.scale(state.scale, state.scale);
          ctx.drawImage(img, -img.width / 2, -img.height / 2);
          ctx.restore();
          if (shape === 'circle') {
            var R = Math.min(W, H) / 2 - 4;
            ctx.save();
            ctx.fillStyle = 'rgba(0,0,0,0.52)';
            ctx.beginPath();
            ctx.rect(0, 0, W, H);
            ctx.arc(W / 2, H / 2, R, 0, Math.PI * 2, true);
            ctx.fill('evenodd');
            ctx.restore();
            ctx.save();
            ctx.strokeStyle = 'rgba(255,255,255,0.7)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(W / 2, H / 2, R, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          } else {
            ctx.save();
            ctx.strokeStyle = 'rgba(255,255,255,0.7)';
            ctx.lineWidth = 2;
            ctx.strokeRect(4, 4, W - 8, H - 8);
            ctx.restore();
          }
        }

        img.onload = function () {
          state.scale = Math.max(W / img.width, H / img.height);
          draw();
        };
        img.src = URL.createObjectURL(imageFile);

        var dragging = false, lx = 0, ly = 0;
        canvas.addEventListener('mousedown', function (e) {
          dragging = true; lx = e.clientX; ly = e.clientY;
          e.preventDefault();
        });
        canvas.addEventListener('mousemove', function (e) {
          if (!dragging) return;
          state.x += e.clientX - lx; state.y += e.clientY - ly;
          lx = e.clientX; ly = e.clientY;
          draw();
        });
        canvas.addEventListener('mouseup',    function () { dragging = false; });
        canvas.addEventListener('mouseleave', function () { dragging = false; });
        canvas.addEventListener('wheel', function (e) {
          e.preventDefault();
          state.scale *= e.deltaY > 0 ? 0.9 : 1.1;
          state.scale  = Math.max(0.2, Math.min(10, state.scale));
          draw();
        }, { passive: false });

        function close() {
          document.body.removeChild(overlay);
          URL.revokeObjectURL(img.src);
        }

        cancelBtn.addEventListener('click', close);

        saveBtn.addEventListener('click', function () {
          var out  = document.createElement('canvas');
          out.width  = W;
          out.height = H;
          var octx = out.getContext('2d');
          octx.save();
          octx.translate(state.x + W / 2, state.y + H / 2);
          octx.scale(state.scale, state.scale);
          octx.drawImage(img, -img.width / 2, -img.height / 2);
          octx.restore();

          saveBtn.textContent = 'Uploading…';
          saveBtn.disabled    = true;

          out.toBlob(function (blob) {
            if (!blob) { saveBtn.textContent = 'Crop & Upload'; saveBtn.disabled = false; return; }
            var filename = basename + '-' + Date.now() + '.jpg';
            fetch('/@' + user.handle + '/uploads/' + subfolder + '/' + filename, {
              method:      'PUT',
              credentials: 'include',
              headers:     { 'Content-Type': 'image/jpeg' },
              body:        blob,
            })
            .then(function (r) { return r.json(); })
            .then(function (result) {
              close();
              if (result.url) { onDone(result.url); }
              else { alert('Upload failed: ' + JSON.stringify(result)); }
            })
            .catch(function (e) {
              saveBtn.textContent = 'Crop & Upload';
              saveBtn.disabled    = false;
              alert('Upload error: ' + e.message);
            });
          }, 'image/jpeg', 0.92);
        });
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
