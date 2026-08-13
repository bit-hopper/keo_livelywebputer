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
    "lively.identity.FileCrypto",
    "lively.identity.PostCardUtils",
    "lively.identity.WebKey",
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
              var domainsP = fetch("/@" + target + "/domains", { credentials: "include" })
                .then(function (r) { return r.ok ? r.json() : { domains: [] }; })
                .then(function (r) { return r.domains || []; })
                .catch(function () { return []; });
              Promise.all([dp, domainsP]).then(function (results) {
                var didDoc  = results[0];
                var domains = results[1];
                self._domains = domains;
                self._renderView(target, payload, didDoc, env.did, domains);
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

      _renderView: function _renderView(handle, payload, didDoc, did, domains) {
        var self = this;
        var pane = this.targetMorph;
        if (!pane) return;
        pane.removeAllMorphs();

        // Preset platform catalog for the social-account circles below.
        // Declared locally (not shared from outer module scope) because
        // lively.BuildSpec methods are rehydrated via evalJS from their
        // source text, which discards any closure over the enclosing
        // .toRun(function(){...}) scope — same reason SIGNS/GLYPHS are
        // redeclared locally rather than shared, see _renderEdit below.
        // Each key doubles as the icon's filename under
        // core/media/social-icons/<key>.svg.
        var SOCIAL_PLATFORMS = [
          { key: 'discord',     label: 'Discord' },
          { key: 'spotify',     label: 'Spotify' },
          { key: 'instagram',   label: 'Instagram' },
          { key: 'github',      label: 'GitHub' },
          { key: 'youtube',     label: 'YouTube' },
          { key: 'tiktok',      label: 'TikTok' },
          { key: 'twitch',      label: 'Twitch' },
          { key: 'bluesky',     label: 'Bluesky' },
          { key: 'blacksky',    label: 'Blacksky' },
          { key: 'behance',     label: 'Behance' },
          { key: 'steam',       label: 'Steam' },
          { key: 'cashapp',     label: 'Cash App' },
          { key: 'pinterest',   label: 'Pinterest' },
          { key: 'arena',       label: 'Are.na' },
          { key: 'goodreads',   label: 'Goodreads' },
          { key: 'applemusic',  label: 'Apple Music' },
          { key: 'ytmusic',     label: 'YT Music' },
          { key: 'storygraph',  label: 'StoryGraph' },
          { key: 'itch',        label: 'itch.io' },
          { key: 'psn',         label: 'PlayStation Network' },
          { key: 'mynintendo',  label: 'My Nintendo' },
          { key: 'xbox',        label: 'Xbox' },
          { key: 'epic',        label: 'Epic Games' },
          { key: 'tumblr',      label: 'Tumblr' },
          { key: 'threads',     label: 'Threads' },
        ];
        function socialPlatformInfo(key) {
          for (var i = 0; i < SOCIAL_PLATFORMS.length; i++) {
            if (SOCIAL_PLATFORMS[i].key === key) return SOCIAL_PLATFORMS[i];
          }
          return null;
        }
        function socialIconUrl(platformKey) {
          // Absolute path (leading slash) — this card is normally viewed at
          // a nested URL like /@handle/objId, where a relative path would
          // resolve against that path instead of site root and 404.
          return '/core/media/social-icons/' + platformKey + '.svg';
        }

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
          var bi = new lively.morphic.Image(lively.rect(avX, avY, AV, AV));
          bi.setImageURL(lively.identity.postCardUtils.identiconDataUrl(handle, AV));
          bi.applyStyle({ borderRadius: AV / 2, borderWidth: 0, clipMode: 'hidden' });
          pane.addMorph(bi);
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
          astroBox.applyStyle({ fill: Color.rgb(242, 203, 217),
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

        // social account circles — right column, directly under the
        // divider, in the space below the astro-signs box/Friends button
        // (same x = bx as that column, so it reads as one aligned strip).
        // Owner always sees all 5 slots (filled + empty "add" placeholders,
        // clicking an empty one jumps straight to the Accounts tab);
        // visitors only see the filled ones, packed with no gaps for the
        // slots the owner hasn't used.
        (function () {
          // CIRC=38 (up from the original 32) with a generous GAP=20 so the
          // row reads as clearly-separated icons rather than a packed
          // strip. The row is right-aligned to the card's existing right
          // margin (pw - contentX, same edge the divider/astro box use)
          // and, since 5*CIRC+4*GAP (270px) is wider than the ~190px astro
          // -box column below which it sits, its start point extends left
          // of that column into the space below the "encryption status"
          // line — safe because that line is short (ends around x=300) and
          // nothing else on the left column shares this row's y.
          // ICON_PAD insets the icon inside the circle rather than filling
          // it edge-to-edge, since a full-bleed icon gets its corners cut
          // by the circular clip mask on any non-circular SVG.
          var CIRC = 38, GAP = 20, ICON_PAD = 6;
          var ICON_BOX = CIRC - ICON_PAD * 2;
          var rowEndX = pw - contentX;
          var rowStartX = rowEndX - (5 * CIRC + 4 * GAP);
          var accounts = (payload.socialAccounts || []).slice(0, 5);

          // "Connect" caption — centered over the icon row, between the
          // divider and the circles, in the same small-caption style as
          // the astro box's item labels (fontSize 9, gray).
          var connectLbl = new lively.morphic.Text(
            lively.rect(rowStartX, dividerY + 6, rowEndX - rowStartX, 12), "Connect");
          connectLbl.applyStyle({ allowInput: false, fontSize: 9,
            textColor: Color.rgb(160, 160, 160),
            fill: Color.rgba(0, 0, 0, 0), borderWidth: 0, align: 'center' });
          pane.addMorph(connectLbl);

          var ry = dividerY + 6 + 12 + 6;

          function addFilledCircle(cx, acc) {
            var btn = new lively.morphic.Button(lively.rect(cx, ry, CIRC, CIRC), '');
            btn.applyStyle({ fill: Color.rgb(255, 255, 255), borderRadius: CIRC / 2,
              borderColor: Color.rgb(225, 225, 231), borderWidth: 1 });
            btn.setAppearanceStylingMode(false);
            btn.setBorderStylingMode(false);
            var icon = new lively.morphic.Image(lively.rect(ICON_PAD, ICON_PAD, ICON_BOX, ICON_BOX));
            icon.applyStyle({ borderWidth: 0 });
            icon.ignoreEvents();
            btn.addMorph(icon);
            // useNativeExtent + max{Width,Height} scales the icon down to
            // fit within its padded box while preserving aspect ratio
            // (plain setImageURL stretches to exactly fill ICON_BOX x
            // ICON_BOX, distorting any non-square icon) — then re-center
            // it, since the resulting extent may be narrower/shorter than
            // ICON_BOX once aspect ratio is preserved.
            icon.setImageURL(socialIconUrl(acc.platform),
              { useNativeExtent: true, maxWidth: ICON_BOX, maxHeight: ICON_BOX },
              function (err, loadedIcon) {
                if (err) return;
                var ext = loadedIcon.getExtent();
                loadedIcon.setPosition(lively.pt(
                  Math.round((CIRC - ext.x) / 2),
                  Math.round((CIRC - ext.y) / 2)));
                // lively.morphic.Shapes.Image's <img> DOM node is created
                // with `position: absolute` but no explicit left/top
                // (Rendering.js's htmlImg() leaves them commented out) — as
                // a child of this circle's Button, it inherits the
                // Button's own `text-align: center` styling (meant for
                // centering the button's label), which shifts an <img>
                // with left:auto right by roughly half its own width.
                // Pin left/top explicitly so the morph's own (already
                // correct) position isn't overridden by that inherited
                // centering.
                var imgNode = loadedIcon.renderContext && loadedIcon.renderContext().imgNode;
                if (imgNode) { imgNode.style.left = '0px'; imgNode.style.top = '0px'; }
              });
            btn._openUrl = acc.url;
            btn.addScript(function doAction() {
              if (this._openUrl) window.open(this._openUrl, '_blank', 'noopener');
            });
            lively.bindings.connect(btn, 'fire', btn, 'doAction');
            pane.addMorph(btn);
            var info = socialPlatformInfo(acc.platform);
            btn.renderContext().morphNode.title = info ? info.label : acc.platform;
          }

          function addEmptyCircle(cx) {
            var btn = new lively.morphic.Button(lively.rect(cx, ry, CIRC, CIRC), '');
            btn.applyStyle({
              fill: new lively.morphic.LinearGradient([
                { offset: 0, color: Color.rgb(230, 230, 238) },
                { offset: 1, color: Color.rgb(248, 248, 251) },
              ], 'northwest'),
              borderRadius: CIRC / 2,
              borderColor: Color.rgb(222, 222, 228), borderWidth: 1,
            });
            btn.setAppearanceStylingMode(false);
            btn.setBorderStylingMode(false);
            btn.addScript(function doAction() {
              var pane = this.owner;
              var win  = pane && pane.owner;
              if (!win) return;
              var env = win._envelope;
              var p   = (env && env.record && env.record.payload) || {};
              win._renderEdit(win._handle, p, win._currentDid, 'accounts');
            });
            lively.bindings.connect(btn, 'fire', btn, 'doAction');
            pane.addMorph(btn);
            btn.renderContext().morphNode.title = 'Add a social account';
          }

          if (self._isOwner) {
            for (var i = 0; i < 5; i++) {
              var cx = rowStartX + i * (CIRC + GAP);
              if (accounts[i]) addFilledCircle(cx, accounts[i]);
              else addEmptyCircle(cx);
            }
          } else {
            accounts.forEach(function (acc, i) {
              addFilledCircle(rowStartX + i * (CIRC + GAP), acc);
            });
          }
        })();

        // encryption status — whether this account can receive private/shared
        // postcards. Surfaced here (rather than only failing at Send time,
        // see PostCardEditor.js's Send dialog) so it's visible up front,
        // including to the owner themselves if their own device never
        // completed the WebAuthn PRF delegation ceremony that publishes this.
        var encLabel = payload.accountX25519Pub
          ? "🔒 Can receive encrypted postcards"
          : "🔓 Hasn't set up encryption yet";
        var encColor = payload.accountX25519Pub ? [46, 125, 50] : [170, 130, 20];
        var encW = Math.min(cw, Math.ceil(encLabel.length * 7.5) + 16);
        pane.addMorph(txt(encLabel, contentX, y, encW, 14, 10,
          encColor[0], encColor[1], encColor[2], false));
        y += 17;

        // Enable-encryption button — owner only, only while missing. Prior
        // to this there was no way to complete this after skipping
        // RegisterDialog.js's "Enable encryption?" prompt (or having its PRF
        // ceremony fail) — the account would be permanently unable to
        // receive private/shared postcards or files, only ever discovering
        // that as a "hasn't set up encryption yet" failure when someone else
        // tried to send them one.
        if (self._isOwner && !payload.accountX25519Pub) {
          var encBtn = new lively.morphic.Button(lively.rect(contentX, y, 140, 24), 'Enable encryption');
          encBtn.applyStyle({ borderRadius: 6, borderWidth: 1,
            borderColor: Color.rgb(200, 200, 210),
            fill: Color.rgb(249, 249, 251), fontSize: 11 });
          encBtn.setAppearanceStylingMode(false);
          encBtn.setBorderStylingMode(false);
          encBtn.addScript(function doAction() {
            var win = this.owner && this.owner.owner;
            var btn = this;
            btn.setLabel('Confirm passkey…');
            btn.setActive(false);
            lively.identity.userSpace.enableEncryption(function (err) {
              if (err) {
                alert('Could not enable encryption: ' + err.message);
                btn.setLabel('Enable encryption');
                btn.setActive(true);
                return;
              }
              if (win && typeof win.loadProfile === 'function') win.loadProfile(win._handle);
            });
          });
          lively.bindings.connect(encBtn, 'fire', encBtn, 'doAction');
          pane.addMorph(encBtn);
          y += 30;
        }

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
            var pane   = this.owner;
            var FW     = 280;
            var FH     = this._isOwner ? 160 : 120;
            var anchorPos = this.getPosition();
            var px = pane ? Math.min(anchorPos.x, Math.max(0, pane.getExtent().x - FW - 8)) : anchorPos.x;
            var panel  = new lively.morphic.Box(
              lively.rect(px, anchorPos.y + this.getExtent().y + 4, FW, FH));
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
            if (pane) pane.addMorph(panel);
          });
          lively.bindings.connect(friendsBtn, 'fire', friendsBtn, 'doAction');
          pane.addMorph(friendsBtn);
        })();


        // verified identity
        pane.addMorph(txt("Verified identity", contentX, y, cw, 16, 10, 140, 140, 140, false)).applyStyle({ fixedWidth: false });
        y += 18;

        var didStr = did ? lively.identity.postCardUtils.truncateDid(did) : "—";
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

        // Domain — same heading/content convention as "Verified identity"/DID
        // above: gray label line, then the value(s) on their own line(s).
        // Verified domains get a green tick immediately after the domain
        // text (not way off at the content edge); lapsed ones get a yellow
        // "?" (tooltip "Invalid domain"). The @handle line up top is never
        // replaced by a domain, verified or not, so an invalid domain
        // "falls back to the original handle" by construction.
        if (domains && domains.length) {
          pane.addMorph(txt("Domain", contentX, y, cw, 16, 10, 140, 140, 140, false)).applyStyle({ fixedWidth: false });
          y += 18;
          domains.forEach(function (d) {
            var isVerified = d.status === 'verified';
            var domW = Math.ceil(d.domain.length * 7.5) + 16;
            pane.addMorph(txt(d.domain, contentX, y, domW, 16, 10, 50, 50, 50, false));
            var badge = txt(isVerified ? 'Verified!' : 'Invalid!', contentX + domW + 4, y, 70, 16, 10,
              isVerified ? 34 : 200, isVerified ? 139 : 150, isVerified ? 34 : 0, false);
            pane.addMorph(badge);
            badge.renderContext().morphNode.title = isVerified ? 'Verified domain' : 'Invalid domain';
            y += 20;
          });
          y += 6;
        }

        // ETH address — heading line, then the copiable address on its own line.
        if (payload.ethAddress) {
          pane.addMorph(txt("ETH address", contentX, y, cw, 16, 10, 140, 140, 140, false)).applyStyle({ fixedWidth: false });
          y += 18;
          var addrStr = lively.identity.postCardUtils.truncateAddress(payload.ethAddress);
          var addrW = Math.ceil(addrStr.length * 7.5) + 16;
          pane.addMorph(txt(addrStr, contentX, y, addrW, 16, 10, 50, 50, 50, false));
          var addrCopyBtn = new lively.morphic.Button(lively.rect(contentX + addrW + 4, y - 2, 26, 22), '⧉︎');
          addrCopyBtn.applyStyle({ fill: Color.rgb(240, 240, 240),
            borderColor: Color.rgb(200, 200, 200), borderRadius: 4,
            fontSize: 14, textColor: Color.rgb(80, 80, 80), borderWidth: 1 });
          addrCopyBtn.setAppearanceStylingMode(false);
          addrCopyBtn.setBorderStylingMode(false);
          addrCopyBtn._copyText = payload.ethAddress;
          addrCopyBtn.addScript(function doAction() {
            var theText = this._copyText;
            var btn     = this;
            if (theText && navigator.clipboard) {
              navigator.clipboard.writeText(theText).then(function () {
                btn.setLabel('✓︎');
                setTimeout(function () { btn.setLabel('⧉︎'); }, 1500);
              });
            }
          });
          lively.bindings.connect(addrCopyBtn, 'fire', addrCopyBtn, 'doAction');
          pane.addMorph(addrCopyBtn);
          addrCopyBtn.renderContext().morphNode.title = 'Copy ETH address';
          y += 24;
        }

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

      _renderEdit: function _renderEdit(handle, payload, did, tab) {
        var self = this;
        var pane = this.targetMorph;
        if (!pane) return;
        pane.removeAllMorphs();
        self._editMode    = true;
        self._editPayload = payload; // authoritative merged state across tab switches
        tab = tab || 'profile';

        // Local copy — see _renderView's identical block for why this can't
        // be shared from outer module scope (evalJS closure loss).
        var SOCIAL_PLATFORMS = [
          { key: 'discord',     label: 'Discord' },
          { key: 'spotify',     label: 'Spotify' },
          { key: 'instagram',   label: 'Instagram' },
          { key: 'github',      label: 'GitHub' },
          { key: 'youtube',     label: 'YouTube' },
          { key: 'tiktok',      label: 'TikTok' },
          { key: 'twitch',      label: 'Twitch' },
          { key: 'bluesky',     label: 'Bluesky' },
          { key: 'blacksky',    label: 'Blacksky' },
          { key: 'behance',     label: 'Behance' },
          { key: 'steam',       label: 'Steam' },
          { key: 'cashapp',     label: 'Cash App' },
          { key: 'pinterest',   label: 'Pinterest' },
          { key: 'arena',       label: 'Are.na' },
          { key: 'goodreads',   label: 'Goodreads' },
          { key: 'applemusic',  label: 'Apple Music' },
          { key: 'ytmusic',     label: 'YT Music' },
          { key: 'storygraph',  label: 'StoryGraph' },
          { key: 'itch',        label: 'itch.io' },
          { key: 'psn',         label: 'PlayStation Network' },
          { key: 'mynintendo',  label: 'My Nintendo' },
          { key: 'xbox',        label: 'Xbox' },
          { key: 'epic',        label: 'Epic Games' },
          { key: 'tumblr',      label: 'Tumblr' },
          { key: 'threads',     label: 'Threads' },
        ];
        function socialPlatformInfo(key) {
          for (var i = 0; i < SOCIAL_PLATFORMS.length; i++) {
            if (SOCIAL_PLATFORMS[i].key === key) return SOCIAL_PLATFORMS[i];
          }
          return null;
        }
        function socialIconUrl(platformKey) {
          // Absolute path (leading slash) — this card is normally viewed at
          // a nested URL like /@handle/objId, where a relative path would
          // resolve against that path instead of site root and 404.
          return '/core/media/social-icons/' + platformKey + '.svg';
        }

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

        // Tab headers — switching tabs snapshots the currently-visible
        // fields into self._editPayload first (via win._snapshotEditFields)
        // so in-progress edits on the tab being left aren't lost, since each
        // tab is a full pane rebuild rather than a show/hide of two
        // pre-built panels (only one tab's fields exist in the pane at a time).
        function addTabButton(label, tabName, x) {
          var isActive = tab === tabName;
          var tb = new lively.morphic.Button(lively.rect(x, y, 138, 26), label);
          tb.applyStyle({
            fill:       isActive ? PINK : Color.rgb(245, 245, 245),
            borderColor: isActive ? PINK : Color.rgb(200, 200, 200),
            borderRadius: 4, fontSize: 11,
            textColor:  isActive ? Color.white : Color.rgb(60, 60, 60),
            borderWidth: 1,
          });
          tb.setAppearanceStylingMode(false);
          tb.setBorderStylingMode(false);
          tb._targetTab = tabName;
          tb.addScript(function doAction() {
            var pane = this.owner;
            var win  = pane && pane.owner;
            if (!win) return;
            win._editPayload = Object.assign({}, win._editPayload, win._snapshotEditFields(pane));
            win._renderEdit(win._handle, win._editPayload, win._currentDid, this._targetTab);
          });
          lively.bindings.connect(tb, 'fire', tb, 'doAction');
          pane.addMorph(tb);
        }
        addTabButton("Profile", "profile", 12);
        addTabButton("Accounts", "accounts", 154);
        addTabButton("Domain", "domains", 296);
        y += 36;

        if (tab === 'profile') {

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

        } else if (tab === 'accounts') {

        // ── Accounts tab ─────────────────────────────────────────────────

        addField("ETH wallet address", "pcEthAddress", payload.ethAddress || "");
        addField("Links (JSON)", "pcLinks", JSON.stringify(payload.links || []), 36);

        // ── social accounts (up to 5 — rendered as circles on the read
        // view, right column under the divider) ──────────────────────────
        y += 8;
        var saLbl = new lively.morphic.Text(lively.rect(12, y, ew, 16), "Social accounts (up to 5)");
        saLbl.applyStyle({ allowInput: false, fontSize: 10,
          textColor: Color.rgb(120, 120, 120),
          fill: Color.rgb(255, 255, 255), borderWidth: 0 });
        pane.addMorph(saLbl);
        y += 20;

        var socialAccounts = payload.socialAccounts || [];
        if (socialAccounts.length === 0) {
          var noneSA = new lively.morphic.Text(lively.rect(12, y, ew, 16), "No social accounts yet.");
          noneSA.applyStyle({ allowInput: false, fontSize: 11,
            textColor: Color.rgb(160, 160, 160),
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          pane.addMorph(noneSA);
          y += 22;
        } else {
          socialAccounts.forEach(function (acc, idx) {
            var info = socialPlatformInfo(acc.platform);
            var rowIcon = new lively.morphic.Image(lively.rect(12, y - 1, 20, 20));
            rowIcon.setImageURL(socialIconUrl(acc.platform));
            rowIcon.applyStyle({ borderWidth: 0, clipMode: 'hidden' });
            pane.addMorph(rowIcon);
            var rowM = new lively.morphic.Text(lively.rect(38, y, ew - 116, 18),
              (info ? info.label : acc.platform) + "  —  " + acc.url);
            rowM.applyStyle({ allowInput: false, fontSize: 12,
              textColor: Color.rgb(60, 60, 60),
              fill: Color.rgb(255, 255, 255), borderWidth: 0 });
            pane.addMorph(rowM);
            var rmSaBtn = new lively.morphic.Button(lively.rect(12 + ew - 80, y - 2, 80, 22), "Remove");
            rmSaBtn.applyStyle({ fill: Color.rgb(245, 245, 245),
              borderColor: Color.rgb(200, 200, 200), borderRadius: 4,
              fontSize: 10, textColor: Color.rgb(150, 30, 30), borderWidth: 1 });
            rmSaBtn.setAppearanceStylingMode(false);
            rmSaBtn.setBorderStylingMode(false);
            rmSaBtn._idx = idx;
            rmSaBtn.addScript(function doAction() {
              var pane = this.owner;
              var win  = pane && pane.owner;
              if (!win) return;
              var current = ((win._editPayload && win._editPayload.socialAccounts) || []).slice();
              current.splice(this._idx, 1);
              win._editPayload = Object.assign({}, win._editPayload, win._snapshotEditFields(pane), { socialAccounts: current });
              win._renderEdit(win._handle, win._editPayload, win._currentDid, 'accounts');
            });
            lively.bindings.connect(rmSaBtn, 'fire', rmSaBtn, 'doAction');
            pane.addMorph(rmSaBtn);
            y += 22;
          });
        }

        y += 8;
        if (socialAccounts.length < 5) {
          var platLbl = new lively.morphic.Text(lively.rect(12, y, 200, 14), "Platform");
          platLbl.applyStyle({ allowInput: false, fontSize: 9,
            textColor: Color.rgb(140, 140, 140),
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          pane.addMorph(platLbl);
          y += 15;

          // Icon preview swatch — a fixed-position container Box with a
          // child Image (same two-morph structure as the read-view's
          // circles, for the same reason: setImageURL's useNativeExtent
          // callback repositions whatever morph it's called on to
          // re-center it, so that morph can't also be the one carrying the
          // container's own fixed (12, y) position — it would fight itself
          // on every icon change). Kept in sync with the dropdown's
          // selection via a 'selection' binding below, same connect+
          // addScript pattern as every button's fire->doAction in this
          // file. updateIcon is self-contained (no outer-scope refs) since
          // addScript-attached methods lose their enclosing closure.
          var platIconPreview = new lively.morphic.Box(lively.rect(12, y, 24, 24));
          platIconPreview.name = 'pcNewSocialPlatformIcon';
          platIconPreview.applyStyle({ fill: Color.rgb(255, 255, 255), borderWidth: 1,
            borderColor: Color.rgb(225, 225, 231), borderRadius: 4 });
          pane.addMorph(platIconPreview);
          var platIconImg = new lively.morphic.Image(lively.rect(3, 3, 18, 18));
          platIconImg.applyStyle({ borderWidth: 0 });
          platIconPreview.addMorph(platIconImg);
          platIconPreview.addScript(function updateIcon(platformKey) {
            if (!platformKey) return;
            var BOX = 24, ICON_BOX = 18;
            var img = this.submorphs && this.submorphs[0];
            if (!img) return;
            img.setImageURL('/core/media/social-icons/' + platformKey + '.svg',
              { useNativeExtent: true, maxWidth: ICON_BOX, maxHeight: ICON_BOX },
              function (err, loadedIcon) {
                if (err) return;
                var ext = loadedIcon.getExtent();
                loadedIcon.setPosition(lively.pt(
                  Math.round((BOX - ext.x) / 2), Math.round((BOX - ext.y) / 2)));
                var imgNode = loadedIcon.renderContext && loadedIcon.renderContext().imgNode;
                if (imgNode) { imgNode.style.left = '0px'; imgNode.style.top = '0px'; }
              });
          });

          // Custom combo box: a trigger button showing the current
          // selection, which opens a genuine in-page scrollable list
          // (lively.morphic.List) anchored below it. A native <select>
          // (lively.morphic.DropDownList) can't be used here — its open
          // popup is entirely OS/browser-controlled and always shows every
          // option with no way to cap it at a handful of visible rows.
          // This list is sized to show ~5-6 rows at once (its own default
          // listItemHeight is 19px — matches VersionViewer.js's List
          // usage elsewhere in this app) with a scrollbar for the rest of
          // the 25 platforms, so the owner can browse without either
          // guessing (the old ◀/▶ stepper) or facing an unstyleable wall
          // of 25 native options at once.
          var platTrigger = new lively.morphic.Button(
            lively.rect(44, y, ew - 44, 24), SOCIAL_PLATFORMS[0].label + '  ▾');
          platTrigger.name = 'pcNewSocialPlatform';
          platTrigger.applyStyle({ fill: Color.rgb(252, 252, 252),
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 3,
            fontSize: 12, textColor: Color.rgb(35, 35, 35) });
          platTrigger.setAppearanceStylingMode(false);
          platTrigger.setBorderStylingMode(false);
          platTrigger._selectedKey = SOCIAL_PLATFORMS[0].key;
          platTrigger.addScript(function getSelection() { return this._selectedKey; });
          platTrigger.addScript(function doAction() {
            var pane = this.owner;
            if (!pane) return;
            // Toggle closed if already open.
            var existingPopup = pane.get('pcNewSocialPlatformPopup');
            if (existingPopup) { existingPopup.remove(); return; }

            var P = [
              { key: 'discord', label: 'Discord' }, { key: 'spotify', label: 'Spotify' },
              { key: 'instagram', label: 'Instagram' }, { key: 'github', label: 'GitHub' },
              { key: 'youtube', label: 'YouTube' }, { key: 'tiktok', label: 'TikTok' },
              { key: 'twitch', label: 'Twitch' }, { key: 'bluesky', label: 'Bluesky' },
              { key: 'blacksky', label: 'Blacksky' },
              { key: 'behance', label: 'Behance' }, { key: 'steam', label: 'Steam' },
              { key: 'cashapp', label: 'Cash App' }, { key: 'pinterest', label: 'Pinterest' },
              { key: 'arena', label: 'Are.na' }, { key: 'goodreads', label: 'Goodreads' },
              { key: 'applemusic', label: 'Apple Music' }, { key: 'ytmusic', label: 'YT Music' },
              { key: 'storygraph', label: 'StoryGraph' }, { key: 'itch', label: 'itch.io' },
              { key: 'psn', label: 'PlayStation Network' }, { key: 'mynintendo', label: 'My Nintendo' },
              { key: 'xbox', label: 'Xbox' }, { key: 'epic', label: 'Epic Games' },
              { key: 'tumblr', label: 'Tumblr' }, { key: 'threads', label: 'Threads' },
            ];
            var items = P.map(function (p) { return { string: p.label, value: p.key }; });

            var pos = this.getPosition();
            var ext = this.getExtent();
            var ROW_H = 19; // lively.morphic.List's own default row height
            var ROWS_VISIBLE = 5.5; // .5 hints there's more to scroll to
            var popup = new lively.morphic.List(
              lively.rect(pos.x, pos.y + ext.y + 2, ext.x, Math.round(ROWS_VISIBLE * ROW_H)),
              items);
            popup.name = 'pcNewSocialPlatformPopup';
            popup._platforms = P; // so onPlatformPicked below doesn't need its own copy
            popup.applyStyle({ fontSize: 12, borderColor: Color.rgb(180, 180, 190), borderWidth: 1 });
            pane.addMorph(popup);

            popup.addScript(function onPlatformPicked(newVal) {
              var pane = this.owner;
              if (!newVal || !pane) return;
              var trig    = pane.get('pcNewSocialPlatform');
              var iconBox = pane.get('pcNewSocialPlatformIcon');
              var picked  = (this._platforms || []).filter(function (p) { return p.key === newVal; })[0];
              if (trig) {
                trig._selectedKey = newVal;
                trig.setLabel((picked ? picked.label : newVal) + '  ▾');
              }
              if (iconBox) iconBox.updateIcon(newVal);
              this.remove();
            });
            lively.bindings.connect(popup, 'selection', popup, 'onPlatformPicked');
          });
          lively.bindings.connect(platTrigger, 'fire', platTrigger, 'doAction');
          pane.addMorph(platTrigger);
          platIconPreview.updateIcon(SOCIAL_PLATFORMS[0].key);
          y += 32;

          addField("Profile URL", "pcNewSocialUrl", "");

          var addSaBtn = new lively.morphic.Button(lively.rect(12, y, 130, 28), "Add account");
          addSaBtn.applyStyle({ fill: Color.rgb(240, 240, 240),
            borderColor: Color.rgb(200, 200, 200), borderRadius: 4,
            fontSize: 11, textColor: Color.rgb(50, 50, 50), borderWidth: 1 });
          addSaBtn.setAppearanceStylingMode(false);
          addSaBtn.setBorderStylingMode(false);
          addSaBtn.addScript(function doAction() {
            var pane = this.owner;
            var win  = pane && pane.owner;
            if (!win) return;
            var platTrigger = pane.get('pcNewSocialPlatform');
            var urlInp   = pane.get('pcNewSocialUrl');
            var platKey  = (platTrigger && platTrigger.getSelection()) || 'discord';
            var url = urlInp && urlInp.textString && urlInp.textString.trim();
            if (!url) { alert('Enter a profile URL first.'); return; }
            if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
            var current = ((win._editPayload && win._editPayload.socialAccounts) || []).slice();
            if (current.length >= 5) { alert('Maximum 5 social accounts.'); return; }
            current.push({ platform: platKey, url: url });
            win._editPayload = Object.assign({}, win._editPayload, win._snapshotEditFields(pane), { socialAccounts: current });
            win._renderEdit(win._handle, win._editPayload, win._currentDid, 'accounts');
          });
          lively.bindings.connect(addSaBtn, 'fire', addSaBtn, 'doAction');
          pane.addMorph(addSaBtn);
          y += 36;
        } else {
          var maxSA = new lively.morphic.Text(lively.rect(12, y, ew, 16), "Maximum of 5 social accounts reached.");
          maxSA.applyStyle({ allowInput: false, fontSize: 11,
            textColor: Color.rgb(160, 160, 160),
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          pane.addMorph(maxSA);
          y += 22;
        }

        } else {

        // ── Domain Handles tab ──────────────────────────────────────────────

        var dhLbl = new lively.morphic.Text(lively.rect(12, y, ew, 16), "Domain Handles");
        dhLbl.applyStyle({ allowInput: false, fontSize: 10,
          textColor: Color.rgb(120, 120, 120),
          fill: Color.rgb(255, 255, 255), borderWidth: 0 });
        pane.addMorph(dhLbl);
        y += 20;

        var domainRows = self._domains || [];
        if (domainRows.length === 0) {
          var noneM = new lively.morphic.Text(lively.rect(12, y, ew, 16), "No domain handles yet.");
          noneM.applyStyle({ allowInput: false, fontSize: 11,
            textColor: Color.rgb(160, 160, 160),
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          pane.addMorph(noneM);
          y += 22;
        } else {
          domainRows.forEach(function (d) {
            var isVerified = d.status === 'verified';
            var rowM = new lively.morphic.Text(lively.rect(12, y, ew - 90, 18),
              d.domain + "  —  " + (isVerified ? "Verified" : "Invalid"));
            rowM.applyStyle({ allowInput: false, fontSize: 12,
              textColor: isVerified ? Color.rgb(34, 139, 34) : Color.rgb(190, 140, 20),
              fill: Color.rgb(255, 255, 255), borderWidth: 0 });
            pane.addMorph(rowM);
            var rmBtn = new lively.morphic.Button(lively.rect(12 + ew - 80, y - 2, 80, 22), "Remove");
            rmBtn.applyStyle({ fill: Color.rgb(245, 245, 245),
              borderColor: Color.rgb(200, 200, 200), borderRadius: 4,
              fontSize: 10, textColor: Color.rgb(150, 30, 30), borderWidth: 1 });
            rmBtn.setAppearanceStylingMode(false);
            rmBtn.setBorderStylingMode(false);
            rmBtn._domain = d.domain;
            rmBtn.addScript(function doAction() {
              var pane = this.owner;
              var win  = pane && pane.owner;
              if (!win) return;
              var domainName = this._domain;
              var btn = this;
              btn.setLabel('…');
              btn.setActive(false);
              win._editPayload = Object.assign({}, win._editPayload, win._snapshotEditFields(pane));
              lively.identity.userSpace.removeDomain(domainName, function (err) {
                if (err) {
                  alert('Could not remove domain: ' + err.message);
                  btn.setLabel('Remove');
                  btn.setActive(true);
                  return;
                }
                lively.identity.userSpace.listDomains(win._handle, function (err2, rows2) {
                  win._domains = rows2 || [];
                  win._renderEdit(win._handle, win._editPayload, win._currentDid, 'domains');
                });
              });
            });
            lively.bindings.connect(rmBtn, 'fire', rmBtn, 'doAction');
            pane.addMorph(rmBtn);
            y += 22;
          });
        }

        y += 8;
        addField("Add a domain (e.g. alice.com)", "pcNewDomain", "");

        var addDomainBtn = new lively.morphic.Button(lively.rect(12, y, 130, 28), "Add domain");
        addDomainBtn.applyStyle({ fill: Color.rgb(240, 240, 240),
          borderColor: Color.rgb(200, 200, 200), borderRadius: 4,
          fontSize: 11, textColor: Color.rgb(50, 50, 50), borderWidth: 1 });
        addDomainBtn.setAppearanceStylingMode(false);
        addDomainBtn.setBorderStylingMode(false);
        addDomainBtn.addScript(function doAction() {
          var pane = this.owner;
          var win  = pane && pane.owner;
          if (!win) return;
          var domainInp = pane.get('pcNewDomain');
          var domain = domainInp && domainInp.textString &&
            domainInp.textString.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
          if (!domain) { alert('Enter a domain first.'); return; }
          win._showDomainVerifyPanel(this, domain, win);
        });
        lively.bindings.connect(addDomainBtn, 'fire', addDomainBtn, 'doAction');
        pane.addMorph(addDomainBtn);
        y += 36;

        }

        // Save/Cancel are pinned to the bottom-right of the card (matching
        // the read view's "Edit" button anchoring) rather than following
        // wherever the current tab's content happens to end — the Account
        // tab's content is much shorter than Profile's, which otherwise
        // left them stranded near the top with a large dead area below.
        var btnY = pane.getExtent().y - 36;

        // Save — reads named inputs from pane, merges onto self._editPayload
        // so fields from whichever tab isn't currently visible survive.
        var saveBtn = new lively.morphic.Button(lively.rect(pw - 166, btnY, 74, 26), "Save");
        saveBtn.applyStyle({ fill: PINK, borderColor: PINK, borderRadius: 4,
          fontSize: 12, textColor: Color.white, borderWidth: 1 });
        saveBtn.setAppearanceStylingMode(false);
        saveBtn.setBorderStylingMode(false);
        saveBtn.addScript(function doAction() {
          var win  = this.owner && this.owner.owner;
          var pane = this.owner;
          if (!win || !pane) return;
          var merged = Object.assign({}, win._editPayload, win._snapshotEditFields(pane));
          if (merged.ethAddress && !/^0x[a-fA-F0-9]{40}$/.test(merged.ethAddress)) {
            alert('ETH address must be a 42-character 0x-prefixed hex address (or left blank).');
            return;
          }
          var newPayload = {
            displayName: merged.displayName || win._handle,
            pronouns:    merged.pronouns    || "",
            bio:         merged.bio         || "",
            avatarUrl:   merged.avatarUrl   || null,
            bannerUrl:   merged.bannerUrl   || null,
            links:       merged.links       || [],
            sunSign:     merged.sunSign     || "",
            moonSign:    merged.moonSign    || "",
            risingSign:  merged.risingSign  || "",
            ethAddress:  merged.ethAddress  || "",
            socialAccounts: merged.socialAccounts || [],
          };
          lively.identity.userSpace.saveProfile(newPayload, function (err) {
            if (err) { alert("Save failed: " + err.message); return; }
            win._editMode    = false;
            win._editPayload = null;
            win.loadProfile(win._handle);
          });
        });
        lively.bindings.connect(saveBtn, 'fire', saveBtn, 'doAction');
        pane.addMorph(saveBtn);

        // Cancel — navigates to Window and reloads view
        var cancelBtn = new lively.morphic.Button(lively.rect(pw - 84, btnY, 72, 26), "Cancel");
        cancelBtn.applyStyle({ fill: Color.rgb(160, 160, 160),
          borderColor: Color.rgb(160, 160, 160), borderRadius: 4,
          fontSize: 12, textColor: Color.white, borderWidth: 1 });
        cancelBtn.setAppearanceStylingMode(false);
        cancelBtn.setBorderStylingMode(false);
        cancelBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (!win) return;
          win._editMode    = false;
          win._editPayload = null;
          win.loadProfile(win._handle);
        });
        lively.bindings.connect(cancelBtn, 'fire', cancelBtn, 'doAction');
        pane.addMorph(cancelBtn);
      },

      // Reads whichever named inputs are currently present in `pane` (only
      // one tab's worth exist at a time — see _renderEdit) into a partial
      // payload object, for merging onto self._editPayload on tab switch
      // or Save so fields from the tab not currently visible aren't lost.
      _snapshotEditFields: function _snapshotEditFields(pane) {
        var SV = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
                  'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
        var partial = {};
        var nameInp     = pane.get("pcDisplayName");
        var pronounsInp = pane.get("pcPronouns");
        var bioInp      = pane.get("pcBio");
        var avatarInp   = pane.get("pcAvatarUrl");
        var bannerInp   = pane.get("pcBannerUrl");
        var linksInp    = pane.get("pcLinks");
        var sunInp      = pane.get("pcSunSign");
        var moonInp     = pane.get("pcMoonSign");
        var risingInp   = pane.get("pcRisingSign");
        var ethInp      = pane.get("pcEthAddress");
        if (nameInp)     partial.displayName = nameInp.textString || "";
        if (pronounsInp) partial.pronouns    = pronounsInp.textString || "";
        if (bioInp)      partial.bio         = bioInp.textString || "";
        if (avatarInp)   partial.avatarUrl   = avatarInp.textString || null;
        if (bannerInp)   partial.bannerUrl   = bannerInp.textString || null;
        if (linksInp) {
          try { partial.links = JSON.parse(linksInp.textString || "[]"); }
          catch (e) { partial.links = []; }
        }
        if (sunInp)    partial.sunSign    = SV[sunInp._signIdx    || 0];
        if (moonInp)   partial.moonSign   = SV[moonInp._signIdx   || 0];
        if (risingInp) partial.risingSign = SV[risingInp._signIdx || 0];
        if (ethInp)    partial.ethAddress = (ethInp.textString || "").trim();
        return partial;
      },

      // Resolve this device's soft signing private key (imported CryptoKey),
      // deriving/caching the KEK via a passkey ceremony if not already
      // cached this session — same recipe as UserSpace.js's
      // _signProfileEnvelopeIfPossible, used here to sign the domain
      // verification .well-known document.
      // Calls thenDo(err, privateKey).
      _getSoftSigningKey: function _getSoftSigningKey(thenDo) {
        var didMod = lively.identity.did;
        var user   = didMod.currentUser();
        if (!user) return thenDo(new Error('Not logged in'));
        var method = didMod.findMethodByCredentialId(user.document, user.credentialId);
        var livelyMeta = method && method.lively;
        if (!livelyMeta || !livelyMeta.softSigningKeyWrapped || !livelyMeta.delegationCert) {
          return thenDo(new Error('This device has not set up signing yet — use "Enable encryption" on the profile first.'));
        }
        var wa = lively.identity.webAuthn;
        var c  = lively.identity.crypto;

        function withKek(kek) {
          var wrapped;
          try { wrapped = JSON.parse(livelyMeta.softSigningKeyWrapped); }
          catch (e) { return thenDo(e); }
          c.decryptPayload(wrapped.ciphertext, wrapped.nonce, kek, function (err, softPrivJwk) {
            if (err) return thenDo(err);
            c.importPrivateKeyJwk(softPrivJwk, thenDo);
          });
        }

        if (wa._kekCache && wa._kekCache[user.credentialId]) {
          return withKek(wa._kekCache[user.credentialId]);
        }
        var challenge = new Uint8Array(32);
        crypto.getRandomValues(challenge);
        wa.deriveKek({ credentialId: user.credentialId, challenge: challenge, rpId: user.rpId }, function (err, kek) {
          if (err) return thenDo(err);
          withKek(kek);
        });
      },

      // Shows two ways to prove ownership of a domain the owner is trying
      // to add, plus a "Verify now" button that asks the server to
      // independently check whichever one was actually done:
      //   1. A DNS TXT record — no signing, DNS control is the proof.
      //   2. A signed .well-known/lively-did file — generated on demand
      //      (the passkey ceremony only runs if this option is opened).
      // Attached as a submorph of `pane` (in pane-local coordinates) so it
      // stays anchored to the card — moves/scrolls with the window instead
      // of floating at a fixed $world position like the old version did
      // (same fix applied to the "Friends" panel in _renderView). Button
      // handlers read data from `_prop` fields (never outer-scope closures)
      // per this file's addScript convention.
      _showDomainVerifyPanel: function _showDomainVerifyPanel(anchorMorph, domain, win) {
        var pane = anchorMorph.owner;

        // Anchored below the "Add domain" button, like a normal dropdown.
        // This button sits fairly far down the Account tab, leaving little
        // room before the pane's bottom edge — that used to be a problem
        // (content spilling past the card's own bottom edge), but the DID/
        // JSON boxes below are now fixed-height and internally scrollable
        // (clipMode: 'auto', precedented in lively.morphic.Panel#newTextPane),
        // and the panel itself falls back to the same scrolling if it's
        // still taller than the room available, so however little space is
        // left here, content stays contained rather than spilling out.
        var paneW = pane ? pane.getExtent().x : 834;
        var paneH = pane ? pane.getExtent().y : 595;
        var FW = 420;
        var anchorPos = anchorMorph.getPosition();
        var panelX = pane ? Math.min(anchorPos.x, Math.max(0, paneW - FW - 8)) : anchorPos.x;
        var panelY = anchorPos.y + anchorMorph.getExtent().y + 4;
        // Leave room above the bottom-pinned Save/Cancel row (btnY = paneH - 36).
        var maxPanelH = Math.max(120, (paneH - 36 - 10) - panelY);

        var panel = new lively.morphic.Box(lively.rect(panelX, panelY, FW, 100));
        panel.applyStyle({ fill: Color.white, borderRadius: 8,
          borderColor: Color.rgb(218, 218, 224), borderWidth: 1 });
        panel._win = win;
        panel._domain = domain;
        if (panel.doNotSerialize && panel.doNotSerialize.indexOf('_win') === -1)
          panel.doNotSerialize.push('_win');

        // Attached to `pane` (already in the world) before any content is
        // added, not after — getTextExtent() below only reports genuine
        // wrapped-line heights once a Text morph is actually rendered in
        // the world (confirmed live, same requirement WalletSetupDialog.js's
        // _fitTextHeight documents).
        if (pane) pane.addMorph(panel);

        // Resizes a just-added Text LABEL (short, plain-prose lines only)
        // to its real wrapped height, so a label that happens to wrap to 2
        // lines at this panel's modest width doesn't overlap what's next.
        function fitTextHeight(t, w, minHeight) {
          var textHeight = t.getTextExtent().y;
          var h = Math.max(minHeight, textHeight || minHeight);
          t.setExtent(lively.pt(w, h));
          return h;
        }

        // Fixed-size, internally-scrollable box for a copyable value of
        // unpredictable length (a DID, a signed-JSON blob) — clipMode
        // 'auto' gives it a real scrollbar instead of growing the box (and
        // therefore the panel) to fit, which is what let content spill
        // past the panel/card in the first place. wordBreak: 'break-all'
        // still matters even with scrolling on: these values are one
        // unbroken token with no spaces, so without it the browser never
        // finds a place to wrap and the text overflows sideways instead of
        // filling the box vertically (same fix WalletSetupDialog.js's
        // _addText uses for 0x... addresses).
        function addScrollBox(x, boxY, w, h, text) {
          var t = new lively.morphic.Text(lively.rect(x, boxY, w, h), text);
          t.applyStyle({ allowInput: false, fixedWidth: true, fixedHeight: true,
            wordBreak: 'break-all', clipMode: 'auto',
            fontSize: 10, textColor: Color.rgb(40, 40, 40),
            fill: Color.rgb(248, 248, 251), borderColor: Color.rgb(218, 218, 224),
            borderWidth: 1, borderRadius: 3 });
          panel.addMorph(t);
          return t;
        }

        function addCopyButton(x, btnY, copyValue, w) {
          var cpBtn = new lively.morphic.Button(lively.rect(x, btnY, w || 60, 22), 'Copy');
          cpBtn.applyStyle({ fill: Color.rgb(245, 245, 245), borderColor: Color.rgb(200, 200, 200),
            borderRadius: 4, fontSize: 10, textColor: Color.rgb(50, 50, 50), borderWidth: 1 });
          cpBtn.setAppearanceStylingMode(false);
          cpBtn.setBorderStylingMode(false);
          cpBtn._copyText = copyValue;
          cpBtn.addScript(function doAction() {
            var btn = this;
            if (navigator.clipboard) {
              navigator.clipboard.writeText(this._copyText).then(function () {
                btn.setLabel('✓');
                setTimeout(function () { btn.setLabel('Copy'); }, 1200);
              });
            }
          });
          lively.bindings.connect(cpBtn, 'fire', cpBtn, 'doAction');
          panel.addMorph(cpBtn);
          return cpBtn;
        }

        var y = 10;

        var titleM = new lively.morphic.Text(lively.rect(12, y, FW - 44, 18), 'Verify ' + domain);
        titleM.applyStyle({ allowInput: false, fontSize: 13, fontWeight: 'bold',
          fill: Color.rgba(0, 0, 0, 0), borderWidth: 0, textColor: Color.rgb(30, 30, 30) });
        panel.addMorph(titleM);
        y += fitTextHeight(titleM, FW - 44, 18) + 8;

        var opt1Lbl = new lively.morphic.Text(lively.rect(12, y, FW - 24, 16),
          'Option 1 — DNS TXT record (no extra steps)');
        opt1Lbl.applyStyle({ allowInput: false, fontSize: 11, fontWeight: 'bold',
          textColor: Color.rgb(90, 90, 90), fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
        panel.addMorph(opt1Lbl);
        y += fitTextHeight(opt1Lbl, FW - 24, 16) + 6;

        var hostLbl = new lively.morphic.Text(lively.rect(12, y, FW - 24, 14), 'Host:');
        hostLbl.applyStyle({ allowInput: false, fontSize: 10, textColor: Color.rgb(120, 120, 120),
          fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
        panel.addMorph(hostLbl);
        y += 16;
        var hostValue = '_lively-did.' + domain;
        addScrollBox(12, y, FW - 24, 32, hostValue);
        y += 32 + 6;
        addCopyButton(12, y, hostValue);
        y += 22 + 14;

        var valueLbl = new lively.morphic.Text(lively.rect(12, y, FW - 24, 14), 'Value:');
        valueLbl.applyStyle({ allowInput: false, fontSize: 10, textColor: Color.rgb(120, 120, 120),
          fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
        panel.addMorph(valueLbl);
        y += 16;
        var didValue = 'did=' + win._currentDid;
        addScrollBox(12, y, FW - 24, 56, didValue);
        y += 56 + 6;
        addCopyButton(12, y, didValue);
        y += 22 + 14;

        var divider = new lively.morphic.Box(lively.rect(12, y, FW - 24, 1));
        divider.applyStyle({ fill: Color.rgb(225, 225, 225), borderWidth: 0 });
        panel.addMorph(divider);
        y += 12;

        var opt2Lbl = new lively.morphic.Text(lively.rect(12, y, FW - 24, 16),
          'Option 2 — signed file (needs your passkey)');
        opt2Lbl.applyStyle({ allowInput: false, fontSize: 11, fontWeight: 'bold',
          textColor: Color.rgb(90, 90, 90), fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
        panel.addMorph(opt2Lbl);
        y += fitTextHeight(opt2Lbl, FW - 24, 16) + 6;

        var instrM = new lively.morphic.Text(lively.rect(12, y, FW - 24, 16),
          'Host the generated JSON at https://' + domain + '/.well-known/lively-did.');
        instrM.applyStyle({ allowInput: false, fontSize: 10, textColor: Color.rgb(120, 120, 120),
          fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
        panel.addMorph(instrM);
        y += fitTextHeight(instrM, FW - 24, 16) + 8;

        // Reserved up-front, fixed-size scroll area for the signed JSON —
        // "Generate signed file" occupies this space until clicked, then
        // gets removed and the box (same position/size, so nothing below
        // has to move) takes its place. No panel resize needed at generate
        // time, unlike the previous version — the height was already
        // budgeted into the panel's total from the start, which is what
        // keeps the whole thing bounded regardless of how long the JSON
        // (specifically the sig field) turns out to be.
        var jsonAreaY = y;
        var jsonAreaH = 130;
        var genBtn = new lively.morphic.Button(lively.rect(12, jsonAreaY, 170, 26), 'Generate signed file');
        genBtn.applyStyle({ fill: Color.rgb(245, 245, 245), borderColor: Color.rgb(200, 200, 200),
          borderRadius: 4, fontSize: 11, textColor: Color.rgb(50, 50, 50), borderWidth: 1 });
        genBtn.setAppearanceStylingMode(false);
        genBtn.setBorderStylingMode(false);
        genBtn.addScript(function doAction() {
          var panel = this.owner;
          var win2  = panel && panel._win;
          var dom   = panel && panel._domain;
          if (!win2 || !dom) return;
          var btn = this;
          btn.setLabel('Signing…');
          btn.setActive(false);
          win2._getSoftSigningKey(function (err, softPrivKey) {
            if (err) {
              alert('Could not sign — ' + err.message);
              btn.setLabel('Generate signed file');
              btn.setActive(true);
              return;
            }
            var wellKnownPayload = lively.identity.webKey.buildWellKnownPayload({
              did: win2._currentDid, handle: win2._handle, domain: dom,
            });
            lively.identity.webKey.signWellKnown(wellKnownPayload, softPrivKey, function (err2, signedDoc) {
              if (err2) {
                alert('Signing failed: ' + err2.message);
                btn.setLabel('Generate signed file');
                btn.setActive(true);
                return;
              }
              var jy = btn.getPosition().y;
              var jw = panel.getExtent().x - 24;
              var jh = panel._jsonAreaH || 130;
              var jsonStr = JSON.stringify(signedDoc, null, 2);
              var jsonM = new lively.morphic.Text(lively.rect(12, jy, jw, jh), jsonStr);
              jsonM.applyStyle({ allowInput: false, fixedWidth: true, fixedHeight: true,
                wordBreak: 'break-all', clipMode: 'auto',
                fontSize: 9, textColor: Color.rgb(40, 40, 40), fill: Color.rgb(248, 248, 251),
                borderColor: Color.rgb(218, 218, 224), borderWidth: 1, borderRadius: 4 });
              panel.addMorph(jsonM);
              btn.remove();

              var copyJsonBtn = panel.get('pcCopyJsonBtn');
              if (copyJsonBtn) {
                copyJsonBtn._copyText = jsonStr;
                copyJsonBtn.setVisible(true);
              }
            });
          });
        });
        lively.bindings.connect(genBtn, 'fire', genBtn, 'doAction');
        panel.addMorph(genBtn);
        panel._jsonAreaH = jsonAreaH;
        y += jsonAreaH + 8;

        // Present but hidden until "Generate signed file" succeeds — kept
        // at a fixed position/name from the start (rather than being
        // created inline after generating, which is what previously forced
        // everything below it to shift down) so Verify now's position
        // never has to move.
        var copyJsonBtn = new lively.morphic.Button(lively.rect(12, y, 90, 24), 'Copy JSON');
        copyJsonBtn.name = 'pcCopyJsonBtn';
        copyJsonBtn.applyStyle({ fill: Color.rgb(245, 245, 245), borderColor: Color.rgb(200, 200, 200),
          borderRadius: 4, fontSize: 10, textColor: Color.rgb(50, 50, 50), borderWidth: 1 });
        copyJsonBtn.setAppearanceStylingMode(false);
        copyJsonBtn.setBorderStylingMode(false);
        copyJsonBtn.addScript(function doAction() {
          var b = this;
          if (navigator.clipboard && this._copyText) {
            navigator.clipboard.writeText(this._copyText).then(function () {
              b.setLabel('Copied!');
              setTimeout(function () { b.setLabel('Copy JSON'); }, 1200);
            });
          }
        });
        lively.bindings.connect(copyJsonBtn, 'fire', copyJsonBtn, 'doAction');
        panel.addMorph(copyJsonBtn);
        copyJsonBtn.setVisible(false);
        y += 24 + 14;

        var verifyNowBtn = new lively.morphic.Button(lively.rect(12, y, 110, 28), 'Verify now');
        verifyNowBtn.applyStyle({ fill: Color.rgb(240, 26, 105), borderColor: Color.rgb(240, 26, 105),
          borderRadius: 4, fontSize: 11, textColor: Color.white, borderWidth: 1 });
        verifyNowBtn.setAppearanceStylingMode(false);
        verifyNowBtn.setBorderStylingMode(false);
        verifyNowBtn.addScript(function doAction() {
          var btn   = this;
          var panel = this.owner;
          var win2  = panel && panel._win;
          var dom   = panel && panel._domain;
          btn.setLabel('Verifying…');
          btn.setActive(false);
          lively.identity.userSpace.verifyDomain(dom, function (err) {
            if (err) {
              alert('Verification failed: ' + err.message);
              btn.setLabel('Verify now');
              btn.setActive(true);
              return;
            }
            if (panel) panel.remove();
            if (!win2) return;
            lively.identity.userSpace.listDomains(win2._handle, function (err2, rows2) {
              win2._domains = rows2 || [];
              win2._renderEdit(win2._handle, win2._editPayload, win2._currentDid, 'domains');
            });
          });
        });
        lively.bindings.connect(verifyNowBtn, 'fire', verifyNowBtn, 'doAction');
        panel.addMorph(verifyNowBtn);
        y += 28 + 12;

        var closeBtn = new lively.morphic.Button(lively.rect(FW - 28, 6, 22, 22), '✕');
        closeBtn.applyStyle({ borderRadius: 11, fontSize: 11, borderWidth: 0,
          fill: Color.rgba(0, 0, 0, 0), textColor: Color.rgb(100, 100, 100) });
        closeBtn.addScript(function doAction() { this.owner.remove(); });
        lively.bindings.connect(closeBtn, 'fire', closeBtn, 'doAction');
        panel.addMorph(closeBtn);

        // The panel's own content is now fully bounded/deterministic (no
        // runtime growth from JSON/DID length), so clamp its final height
        // to the space actually available above Save/Cancel as a hard
        // backstop — with fixed scrollable value boxes this shouldn't ever
        // bite, but it means a future content addition fails safe (an
        // internal scrollbar) instead of spilling past the card again.
        panel.setExtent(lively.pt(FW, Math.min(y, maxPanelH)));
        if (y > maxPanelH) panel.applyStyle({ clipMode: 'auto' });
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
            // Avatars/banners must stay anonymously <img src>-fetchable, so
            // visibility is explicitly 'public' here — never the encrypted
            // default (Encryption.md §5.5). The resulting blob URL
            // (/@handle/blobs/<cid>) is public-optionalAuth and served with
            // the real image mime, same as the old uploads/<subfolder> URL.
            lively.identity.fileCrypto.encryptAndUpload(blob, {
              visibility: 'public',
              name: filename,
            }, function (err, result) {
              if (err) {
                saveBtn.textContent = 'Crop & Upload';
                saveBtn.disabled    = false;
                alert('Upload error: ' + err.message);
                return;
              }
              close();
              var base = lively.identity.did.baseUrl();
              onDone(base + '/@' + user.handle + '/blobs/' + result.blobCid);
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
