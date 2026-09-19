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
    "lively.identity.ImageCropper",
    "lively.identity.PostCardUtils",
    "lively.identity.QuiltPatterns",
    "lively.identity.WebKey",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    lively.BuildSpec("lively.identity.ProfileCard", {
      _Extent:         lively.pt(840, 620),
      _BorderRadius:   10,
      // Fill-frame/mat technique (see NewWikiPageDialog.js): the window's
      // own fill shows through as a colored margin around the white
      // ProfileCardPane below and behind the title bar (which has its own
      // background: none in base_theme.css), giving a colored frame with
      // no separate border morph needed.
      _Fill:           Color.rgb(0xCC, 0x00, 0x57),
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
        this._ensureAccentChromeCss();
        this.addStyleClassName("identity-accent-chrome");
      },

      // Title text sits on the window's colored fill, so the base theme's
      // #555 is hard to read -- same shared class/technique as
      // LoginDialog.js's _ensureAccentChromeCss.
      _ensureAccentChromeCss: function () {
        var STYLE_ID = "identity-accent-chrome-style";
        if (document.getElementById(STYLE_ID)) return;
        var styleEl = document.createElement("style");
        styleEl.id = STYLE_ID;
        styleEl.textContent = [
          ".Window.identity-accent-chrome .Text.window-title { color: #fff; }",
          ".Window.identity-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }",
        ].join("\n");
        document.head.appendChild(styleEl);
      },

      loadProfile: function loadProfile(handle, worldObjId) {
        var self   = this;
        var user   = lively.identity.did.currentUser();
        var target = handle || (user && user.handle);
        if (!target) { self._showMsg("Not logged in."); return; }

        self._handle      = target;
        self._isOwner     = !!(user && user.handle === target);
        self._worldObjId  = worldObjId || null;

        fetch("/@" + target + "/profile", { credentials: "include" })
          .then(function (res) {
            if (!res.ok) {
              self._showMsg("Could not load profile (HTTP " + res.status + ")");
              return;
            }
            return res.json().then(function (env) {
              self._envelope = env;
              var payload    = (env.record && env.record.payload) || {};
              // The card may be opened by domain handle (/@example.com), which
              // never equals the session's registered handle — the DID is the
              // identity that always matches.
              if (user && env.did && user.did === env.did) self._isOwner = true;
              var dp = (self._isOwner && user.document)
                ? Promise.resolve(user.document)
                : fetch("/@" + target + "/did-document", { credentials: "include" })
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .catch(function () { return null; });
              var domainsP = fetch("/@" + target + "/domains", { credentials: "include" })
                .then(function (r) { return r.ok ? r.json() : { domains: [] }; })
                .then(function (r) { return r.domains || []; })
                .catch(function () { return []; });
              // Friends widget data — shape differs by who's looking:
              //   owner viewing their own card: their actual friends list.
              //   signed-in visitor: relationship status vs. this handle.
              //   signed-out visitor: neither route can be called
              //   (both require auth), so friendInfo stays { status: 'signed-out' }.
              var friendInfoP;
              if (self._isOwner) {
                friendInfoP = fetch("/@" + target + "/friends", { credentials: "include" })
                  .then(function (r) { return r.ok ? r.json() : { friends: [] }; })
                  .then(function (r) { return { status: "owner", friends: r.friends || [] }; })
                  .catch(function () { return { status: "owner", friends: [] }; });
              } else if (user) {
                friendInfoP = fetch("/@" + target + "/friend-status", { credentials: "include" })
                  .then(function (r) { return r.ok ? r.json() : { status: "none" }; })
                  .then(function (r) { return { status: r.status || "none" }; })
                  .catch(function () { return { status: "none" }; });
              } else {
                friendInfoP = Promise.resolve({ status: "signed-out" });
              }
              Promise.all([dp, domainsP, friendInfoP]).then(function (results) {
                var didDoc     = results[0];
                var domains    = results[1];
                var friendInfo = results[2];
                self._domains = domains;
                self._renderView(target, payload, didDoc, env.did, domains, friendInfo);
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

      // ── invite-to-constellation (friend nameplate menu) ─────────────────────
      // Real top-level BuildSpec methods (not addScript handlers), so they're
      // reachable as plain `win._openInviteToConstellationPicker(...)` calls
      // from inside a friend nameplate's addScript-reconstructed three-dot
      // menu handler — same "closure is lost, but a real method call on the
      // object graph isn't" idiom loadProfile/_renderEdit already rely on
      // elsewhere in this file.

      _openInviteToConstellationPicker: function _openInviteToConstellationPicker(targetDid, targetHandle, screenPos) {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        fetch('/@' + user.handle + '/constellations', { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : { constellations: [] }; })
          .then(function (r) {
            var list = r.constellations || [];
            if (!list.length) {
              $world.alert("You don't control any constellations to invite @" + (targetHandle || targetDid) + " to.");
              return;
            }
            var items = list.map(function (c) {
              return [c.name + ' (' + c.memberCount + ' member' + (c.memberCount === 1 ? '' : 's') + ')',
                function () { self._sendConstellationInvite(c.name, targetDid, targetHandle); }];
            });
            lively.morphic.Menu.openAt(screenPos, 'Invite @' + (targetHandle || targetDid) + ' to…', items);
          })
          .catch(function () { $world.alert('Could not load your constellations.'); });
      },

      // Identical postal-rail flow to ConstellationLounge.js's _requestJoin
      // (a real, client-signed postcard, never server-fabricated) with the
      // direction reversed: the controller signs+PUTs the card, then POSTs
      // its objId + the target's DID to /c/:name/invites, which records the
      // invite and delivers the card to the target's own inbox.
      _sendConstellationInvite: function _sendConstellationInvite(constellationName, targetDid, targetHandle) {
        var user = lively.identity.did.currentUser();
        if (!user) return;
        lively.require("lively.identity.PostCardSerializer").toRun(function () {
          var doc = {
            type: "doc",
            content: [{
              type: "paragraph",
              content: [{ type: "text",
                text: "@" + user.handle + " invited @" + (targetHandle || targetDid) + " to join c/" + constellationName + "." }],
            }],
          };
          lively.identity.postCardSerializer.serializePlainToEnvelope({
            doc: doc,
            title: "Invitation to join c/" + constellationName,
            titleExplicit: true,
            constellation: constellationName,
            visibility: "public",
            stateMeta: { kind: "constellation-invite" },
          }, function (err, envelope) {
            if (err) return $world.alert("Could not create invite: " + err.message);

            var base = lively.identity.did.baseUrl();
            var putXhr = new XMLHttpRequest();
            putXhr.open("PUT", base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(envelope.objId), true);
            putXhr.withCredentials = true;
            putXhr.setRequestHeader("Content-Type", "application/json");
            putXhr.onload = function () {
              if (putXhr.status !== 200) return $world.alert("Could not save invite card (" + putXhr.status + ")");

              var postXhr = new XMLHttpRequest();
              postXhr.open("POST", base + "/c/" + encodeURIComponent(constellationName) + "/invites", true);
              postXhr.withCredentials = true;
              postXhr.setRequestHeader("Content-Type", "application/json");
              postXhr.onload = function () {
                if (postXhr.status !== 201) {
                  var msg = "Invite failed (" + postXhr.status + ")";
                  try { var body = JSON.parse(postXhr.responseText); if (body.error) msg = body.error; } catch (e) {}
                  return $world.alert(msg);
                }
                $world.alert("Invite sent to @" + (targetHandle || targetDid) + ".");
              };
              postXhr.onerror = function () { $world.alert("Network error sending invite"); };
              postXhr.send(JSON.stringify({ objId: envelope.objId, targetDid: targetDid }));
            };
            putXhr.onerror = function () { $world.alert("Network error saving invite card"); };
            putXhr.send(JSON.stringify(envelope));
          });
        });
      },

      // ── read view ────────────────────────────────────────────────────────────

      _renderView: function _renderView(handle, payload, didDoc, did, domains, friendInfo) {
        var self = this;
        var pane = this.targetMorph;
        if (!pane) return;
        pane.removeAllMorphs();

        // Bio lines wrap at ~80 chars, so a full 300-char bio is ~4 lines,
        // which the base layout has room for. Only if it wraps to more
        // (wide glyphs) grow the window by the extra lines, and shrink back
        // on the next render. Done before anything is laid out so
        // pane.getExtent() below is already final.
        var bioLines = payload.bio ? Math.ceil(payload.bio.length / 75) : 0;
        var bioExtra = Math.max(0, bioLines - 4) * 18;
        var prevExtra = self._bioExtra || 0;
        if (bioExtra !== prevExtra) {
          var curExt = self.getExtent();
          self.setExtent(lively.pt(curExt.x, curExt.y + bioExtra - prevExtra));
          self._bioExtra = bioExtra;
        }

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

        // Material Symbols glyph as a plain Text morph (see CLAUDE.md's icon
        // section). Declared locally, not at module scope, for the same
        // evalJS closure-loss reason as SOCIAL_PLATFORMS above. `px` is the
        // real rendered glyph size; fontSize is points (px * 0.75). The box
        // is px + 8 so the shapeNode's fixed internal padding doesn't clip
        // it, and it's shifted back by 4 so the glyph's top-left lands at
        // (x, y). Purely decorative, so it ignores Lively events.
        function ico(name, x, y, px, r, g, b) {
          var box = px + 8;
          // +2 (net of the -4 padding shift): the icon font's glyph center
          // sits ~6px above a regular-font text line's center at the same
          // box y, measured live via getBoundingClientRect on the spans.
          var m = new lively.morphic.Text(lively.rect(x - 4, y + 2, box, box), name);
          m.draggingEnabled = false; m.droppingEnabled = false; m.grabbingEnabled = false;
          m.applyStyle({ allowInput: false, selectable: false, clipMode: 'hidden',
            fontFamily: "'Material Symbols Rounded'", fontSize: px * 0.75, align: 'center',
            whiteSpaceHandling: 'pre', padding: lively.Rectangle.inset(0, 0, 0, 0),
            textColor: Color.rgb(r, g, b),
            fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
          m.eventsAreIgnored = true;
          return m;
        }

        // Button label color: applyStyle({textColor}) on a Button updates the
        // model but not the label's DOM (see CLAUDE.md), so write it directly.
        function tint(btn, r, g, b) {
          var c = 'rgb(' + r + ',' + g + ',' + b + ')';
          var n = btn.label && btn.label.renderContext().shapeNode;
          if (!n) return;
          n.style.color = c;
          var kids = n.querySelectorAll('*');
          for (var i = 0; i < kids.length; i++) kids[i].style.color = c;
        }

        // banner — always rendered; image if set, placeholder otherwise
        var hasBanner = true;
        if (payload.bannerUrl) {
          var banner = new lively.morphic.Image(lively.rect(0, 0, pw, BH));
          banner.setImageURL(payload.bannerUrl);
          banner.applyStyle({ borderWidth: 0 });
          pane.addMorph(banner);
        } else {
          var bannerBg = new lively.morphic.Box(lively.rect(0, 0, pw, BH));
          lively.identity.quiltPatterns.applyQuiltBackground(bannerBg, handle);
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
          { sym: 'wb_sunny',   label: 'Sun',    val: payload.sunSign    || null },
          { sym: 'dark_mode',  label: 'Moon',   val: payload.moonSign   || null },
          { sym: 'north',      label: 'Rising', val: payload.risingSign || null },
        ];
        var hasAstro = astroItems.some(function (a) { return !!a.val; });
        var bx        = pw - BW - contentX;
        var by        = hasBanner ? (BH + 12) : 12;
        var ROW       = 22;
        var astroBoxH = ROW * 3 + 20;
        if (hasAstro || self._isOwner) {
          var astroBox = new lively.morphic.Box(
            lively.rect(bx, by, BW, astroBoxH));
          astroBox.applyStyle({ fill: Color.rgb(247, 246, 249),
            borderRadius: 12, borderColor: Color.rgb(232, 230, 236), borderWidth: 1 });
          pane.addMorph(astroBox);
          astroItems.forEach(function (item, i) {
            var ry = 7 + i * ROW;
            var si = SIGNS.indexOf(item.val);
            astroBox.addMorph(ico(item.sym, 12, ry, 16, 204, 0, 87));
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
        pane.addMorph(txt(payload.displayName || handle, contentX, y, cw, 28, 16, 20, 20, 20, true));
        y += 28;
        if (payload.pronouns) {
          pane.addMorph(txt(payload.pronouns, contentX, y, cw, 14, 10, 120, 120, 120, false));
          y += 17;
        }

        // bio
        var bioText = payload.bio ||
          (self._isOwner ? "No bio yet. Click Edit to add one." : "");
        if (bioText) {
          // Bio is capped at 300 chars, i.e. up to ~5 wrapped lines, so size
          // the box from a chars-per-line estimate instead of a fixed 50px
          // (which clipped anything past ~2 lines). ~18px/line, per the
          // multi-line sizing note in CLAUDE.md.
          var bioH = Math.max(32, Math.ceil(bioText.length / 75) * 18 + 8);
          var bio = new lively.morphic.Text(lively.rect(contentX, y, cw, bioH), bioText);
          bio.applyStyle({ allowInput: false, fontSize: 12,
            textColor: Color.rgb(80, 80, 80),
            fill: Color.rgb(255, 255, 255), borderWidth: 0 });
          pane.addMorph(bio);
          y += bioH + 8;
        }

        // Reserve room below the astro-signs box (drawn above at a fixed
        // [by, by+astroBoxH] independent of this y accumulator) so the
        // divider/Connect row/Friends button below never collide with it
        // when the left column has little content (short/no bio, no
        // pronouns, no links) — confirmed live on a bare profile (@candle):
        // with nothing above pushing y down, dividerY landed just 1px below
        // astroBoxH's bottom edge, and the Friends button (centered between
        // the two) rendered 12px inside the astro box.
        if (hasAstro || self._isOwner) {
          y = Math.max(y, by + astroBoxH + 40);
        }

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
          // the astro box's item labels (fontSize 9, gray). Only shown when
          // there's actually a row of circles under it: the owner always
          // gets one (empty "add" placeholders included), but a visitor
          // with zero filled accounts would otherwise see this caption
          // floating alone with nothing below it (confirmed live on
          // @tinasnow, who has no social accounts set).
          if (self._isOwner || accounts.length) {
            var connectLbl = new lively.morphic.Text(
              lively.rect(rowStartX, dividerY + 6, rowEndX - rowStartX, 12), "Connect");
            connectLbl.applyStyle({ allowInput: false, fontSize: 9,
              textColor: Color.rgb(160, 160, 160),
              fill: Color.rgba(0, 0, 0, 0), borderWidth: 0, align: 'center' });
            pane.addMorph(connectLbl);
          }

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

          // Websites (up to 3), listed below the social circles in the same
          // right-aligned strip. Only http(s) URLs are rendered/opened.
          var sites = (payload.links || []).filter(function (l) {
            return l && l.url && /^https?:\/\//i.test(l.url);
          }).slice(0, 3);
          var wy = ry + ((self._isOwner || accounts.length) ? CIRC + 14 : 0);
          if (sites.length) {
            // Same small centered caption style as "Connect" above.
            var sitesLbl = new lively.morphic.Text(
              lively.rect(rowStartX, wy, rowEndX - rowStartX, 12), "Websites");
            sitesLbl.applyStyle({ allowInput: false, fontSize: 9,
              textColor: Color.rgb(160, 160, 160),
              fill: Color.rgba(0, 0, 0, 0), borderWidth: 0, align: 'center' });
            pane.addMorph(sitesLbl);
            wy += 20;
          }
          sites.forEach(function (site) {
            var shown = (site.label || site.url).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
            if (shown.length > 38) shown = shown.slice(0, 37) + '…';
            pane.addMorph(ico('language', rowStartX, wy, 14, 150, 150, 158));
            var siteM = txt(shown, rowStartX + 22, wy, rowEndX - rowStartX - 22, 16, 11, 204, 0, 87, false);
            siteM.applyStyle({ fill: Color.rgba(0, 0, 0, 0), handStyle: 'pointer',
              selectable: false });
            siteM.draggingEnabled = false; siteM.droppingEnabled = false; siteM.grabbingEnabled = false;
            siteM._openUrl = site.url;
            siteM.addScript(function onMouseUp(evt) {
              if (this._openUrl) window.open(this._openUrl, '_blank', 'noopener');
              evt.stop(); return true;
            });
            pane.addMorph(siteM);
            siteM.renderContext().morphNode.title = site.url;
            wy += 22;
          });
        })();

        // encryption status — whether this account can receive private/shared
        // postcards. Surfaced here (rather than only failing at Send time,
        // see PostCardEditor.js's Send dialog) so it's visible up front,
        // including to the owner themselves if their own device never
        // completed the WebAuthn PRF delegation ceremony that publishes this.
        var encLabel = payload.accountX25519Pub
          ? "Can receive encrypted postcards"
          : "Hasn't set up encryption yet";
        var encColor = payload.accountX25519Pub ? [46, 125, 50] : [170, 130, 20];
        var encW = Math.min(cw - 20, Math.ceil(encLabel.length * 7.5) + 16);
        pane.addMorph(ico(payload.accountX25519Pub ? 'lock' : 'lock_open',
          contentX, y, 14, encColor[0], encColor[1], encColor[2]));
        pane.addMorph(txt(encLabel, contentX + 20, y, encW, 14, 10,
          encColor[0], encColor[1], encColor[2], false));
        y += 17;

        // Section heading: small gray icon + caption, used for the
        // identity/domain/wallet/device/meta rows below. Local for the same
        // closure-loss reason as ico() above.
        function heading(icon, label) {
          pane.addMorph(ico(icon, contentX, y + 1, 12, 150, 150, 158));
          pane.addMorph(txt(label, contentX + 18, y, cw - 18, 16, 10, 140, 140, 148, false))
            .applyStyle({ fixedWidth: false });
          y += 18;
        }

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

        // Friends button — shown to all; behaviour/content is driven by
        // friendInfo (fetched in loadProfile: FriendRegistry-backed
        // /@:handle/friends for the owner's own card, /@:handle/friend-status
        // for a signed-in visitor). Every nested button below stores what it
        // needs directly on itself (_handle/_targetDid/etc.) rather than
        // closing over this IIFE's locals — addScript handlers are
        // reconstructed from their own source text at runtime and lose that
        // closure (see this file's own header comment / CLAUDE.md's
        // BuildSpec-closure-loss gotcha).
        (function () {
          var info = friendInfo || { status: self._isOwner ? 'owner' : 'signed-out' };
          // Label reflects the viewer's relationship to this handle: only
          // 'Friends' when they actually are (or it's the owner's own card,
          // where it opens their friends list); otherwise it's the action.
          var FRIEND_LABELS = { owner: 'Friends', friends: 'Friends',
            none: '+ Friend request', 'signed-out': '+ Friend request',
            'pending-outgoing': 'Request sent', 'pending-incoming': 'Respond to request' };
          var friendLabel = FRIEND_LABELS[info.status] || '+ Friend request';
          var btnW = friendLabel.length > 9 ? 136 : 108, btnH = 26;
          var btnX = bx + Math.floor((BW - btnW) / 2);
          var btnY = Math.round((by + astroBoxH + dividerY) / 2 - btnH / 2);
          var friendsBtn = new lively.morphic.Button(lively.rect(btnX, btnY, btnW, btnH), friendLabel);
          friendsBtn.applyStyle({ borderRadius: 26, borderWidth: 1,
            borderColor: Color.rgb(204, 0, 87),
            fill: Color.rgb(255, 255, 255), textColor: Color.rgb(204, 0, 87), fontSize: 12 });
          friendsBtn.setAppearanceStylingMode(false);
          friendsBtn.setBorderStylingMode(false);
          friendsBtn._handle     = handle;
          friendsBtn._targetDid  = did;
          friendsBtn._status     = info.status;
          friendsBtn._friends    = info.friends || [];
          friendsBtn.addScript(function doAction() {
            var pane = this.owner;
            var win  = pane && pane.owner;
            var status = this._status;
            // No relationship yet: the button IS the action, no panel.
            if (status === 'none') {
              fetch('/@' + this._handle + '/friend-requests',
                { method: 'POST', credentials: 'include' })
                .then(function (r) {
                  if (!r.ok) alert('Could not send friend request (HTTP ' + r.status + ')');
                  if (win) win.loadProfile(win._handle, win._worldObjId);
                });
              return;
            }
            // Owner's list renders one nameplate row (avatar + handle + chat
            // icon + three-dot menu) per friend rather than a plain text
            // line, so it gets its own wider panel and taller row height —
            // ROWH matches the nameplate build below exactly (32px avatar +
            // 6px top/bottom breathing room).
            var FW   = status === 'owner' ? 320 : 280;
            var ROWH = 44;
            var rows = status === 'owner' ? Math.min(this._friends.length, 5) : 0;
            // Each status renders a fixed, known set of rows below the
            // title (msg line(s) + 0-2 stacked action buttons) — heights
            // below match that layout exactly rather than guessing, same
            // "measure/derive, don't assume" discipline as elsewhere in
            // this file's own layout code.
            var FH = { owner: this._friends.length
                ? (34 + rows * ROWH + (this._friends.length > 5 ? 20 : 0) + 10)
                : 80,
              friends: 120, 'pending-outgoing': 120, 'pending-incoming': 160,
              'signed-out': 96 }[status];
            if (FH == null) FH = 120; // 'none' — msg + one action button
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

            function msg(text, top, height) {
              var m = new lively.morphic.Text(lively.rect(12, top, FW - 24, height || 40), text);
              m.applyStyle({ allowInput: false, fontSize: 12,
                textColor: Color.rgb(60, 60, 60),
                fill: Color.rgba(0,0,0,0), borderWidth: 0 });
              panel.addMorph(m);
              return m;
            }

            function actionBtn(label, top) {
              var b = new lively.morphic.Button(lively.rect(12, top, FW - 24, 28));
              b.setLabel(label);
              b.applyStyle({ borderRadius: 6, fontSize: 12, borderWidth: 1,
                borderColor: Color.rgb(200, 200, 210),
                fill: Color.rgb(249, 249, 251) });
              b.setAppearanceStylingMode(false);
              b.setBorderStylingMode(false);
              panel.addMorph(b);
              return b;
            }

            if (status === 'owner') {
              if (!this._friends.length) {
                msg('No friends yet.', 36, 20).applyStyle({ textColor: Color.rgb(150, 150, 150) });
              } else {
                // Nameplate row: avatar circle, @handle, a disabled chat-icon
                // placeholder (no 1:1 DM system exists yet — this just marks
                // the spot for when one does), and a three-dot menu (Invite
                // to constellation / Remove friend) opened via the
                // framework's own lively.morphic.Menu.openAt, same idiom
                // ConstellationLounge.js's _openMembershipMenu uses — it
                // handles click-outside-to-close for free, unlike a
                // hand-rolled dropdown box would.
                var AVSZ = 32;
                var rowW = FW - 16;
                this._friends.slice(0, 5).forEach(function (f, i) {
                  var row = new lively.morphic.Box(lively.rect(8, 34 + i * ROWH, rowW, ROWH - 4));
                  row.applyStyle({ fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
                  row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
                  panel.addMorph(row);

                  var avatarImg = new lively.morphic.Image(
                    lively.rect(0, Math.round((ROWH - 4 - AVSZ) / 2), AVSZ, AVSZ));
                  avatarImg.setImageURL(f.avatarUrl ||
                    lively.identity.postCardUtils.identiconDataUrl(f.handle || f.did, AVSZ));
                  avatarImg.applyStyle({ borderRadius: AVSZ / 2, borderWidth: 0, clipMode: 'hidden' });
                  avatarImg.draggingEnabled = false; avatarImg.droppingEnabled = false; avatarImg.grabbingEnabled = false;
                  avatarImg.eventsAreIgnored = true;
                  row.addMorph(avatarImg);

                  var DOTSZ  = 20;
                  var CHATSZ = 28;
                  var dotX   = rowW - DOTSZ;
                  var nameH  = 16;
                  var nameX  = AVSZ + 8;
                  var nameW  = 100;
                  var chatX  = nameX + nameW + 6;
                  // y is nudged 4.33px above the box-center formula every
                  // other row element uses — a plain Text morph's glyph
                  // renders with its visual vertical center sitting lower
                  // than its own box's geometric center (font line-height,
                  // not a bug in the box math), confirmed by measuring the
                  // live rendered span's getBoundingClientRect against the
                  // avatar's (a true image, so box-center == visual-center)
                  // until both landed on the same row-relative y. Without
                  // this, avatar/name/chat-icon don't share one visual
                  // midline even though their boxes are all centered.
                  var nameM = new lively.morphic.Text(
                    lively.rect(nameX, Math.round((ROWH - 4 - nameH) / 2) - 4.33, nameW, nameH),
                    '@' + (f.handle || f.did));
                  nameM.applyStyle({ allowInput: false, fontSize: 12,
                    textColor: Color.rgb(40, 40, 40),
                    fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
                  nameM.draggingEnabled = false; nameM.droppingEnabled = false; nameM.grabbingEnabled = false;
                  nameM.eventsAreIgnored = true;
                  row.addMorph(nameM);

                  // Chat icon — opens a real 1:1 P2P E2EE DM window
                  // (lively.identity.DMChat, p2pchat.md) with this friend.
                  // Messaging is friend-gated server-side (FriendRegistry),
                  // so every row here is already a valid DM target — no
                  // separate lookup/permission UI needed. Same
                  // box-center-vs-visual-center nudge as nameM above,
                  // measured the same way (+0.67px here — small because the
                  // icon font's glyph sits much closer to its own line-box
                  // center than the regular text font's does).
                  var chatIcon = new lively.morphic.Text(
                    lively.rect(chatX, Math.round((ROWH - 4 - CHATSZ) / 2) + 0.67, CHATSZ, CHATSZ), 'chat_bubble');
                  chatIcon.draggingEnabled = false; chatIcon.droppingEnabled = false; chatIcon.grabbingEnabled = false;
                  chatIcon._friendHandle = f.handle;
                  chatIcon._friendDid    = f.did;
                  // fontSize is points, not px (1pt = 4/3px) — 16pt renders
                  // as a real ~21px glyph that fills this 28px box almost
                  // exactly with no extra padding needed, confirmed by
                  // measuring the live rendered span (getBoundingClientRect)
                  // rather than guessing; see CLAUDE.md's fontSize gotcha.
                  chatIcon.applyStyle({ allowInput: false, selectable: false, clipMode: 'hidden',
                    fontFamily: "'Material Symbols Rounded'", fontSize: 16, align: 'center',
                    whiteSpaceHandling: 'pre', padding: lively.Rectangle.inset(0, 0, 0, 0),
                    textColor: Color.black, handStyle: 'pointer',
                    fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
                  row.addMorph(chatIcon);
                  chatIcon.renderContext().morphNode.title = 'Message';
                  chatIcon.addScript(function onMouseUp(evt) {
                    var handle = this._friendHandle, did = this._friendDid;
                    lively.require('lively.identity.DMChat').toRun(function () {
                      lively.identity.DMChat.open(handle, did);
                    });
                    evt.stop(); return true;
                  });

                  var moreBtn = new lively.morphic.Text(
                    lively.rect(dotX, Math.round((ROWH - 4 - DOTSZ) / 2), DOTSZ, DOTSZ), 'more_vert');
                  moreBtn.draggingEnabled = false; moreBtn.droppingEnabled = false; moreBtn.grabbingEnabled = false;
                  moreBtn.applyStyle({ allowInput: false, selectable: false, clipMode: 'hidden',
                    fontFamily: "'Material Symbols Rounded'", fontSize: 14, align: 'center',
                    whiteSpaceHandling: 'pre', padding: lively.Rectangle.inset(0, 3, 0, 0),
                    textColor: Color.rgb(100, 100, 100), handStyle: 'pointer',
                    fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
                  moreBtn._friendDid    = f.did;
                  moreBtn._friendHandle = f.handle;
                  row.addMorph(moreBtn);
                  moreBtn.renderContext().morphNode.title = 'More';
                  // Toggle-close, part 1/2: snapshot "is my own menu still
                  // open" at mousedown time, INTO a flag onMouseUp reads.
                  // Checking $world.currentMenu directly inside onMouseUp
                  // doesn't work — confirmed live by tracing both handlers:
                  // World's own onMouseUp (Events.js) already runs its
                  // "close whatever menu is open, the click target isn't a
                  // menu item" check and clears $world.currentMenu BEFORE
                  // this button's own onMouseUp handler is reached, so by
                  // then it always looks like nothing was open and this
                  // just reopens an identical menu. Reading the same state
                  // one event earlier, at onMouseDown (which always fires
                  // before any mouseup handling, world's or this button's),
                  // sees the true pre-close state instead.
                  moreBtn.addScript(function onMouseDown(evt) {
                    this._wasMyMenuOpen = !!(this._openMenu && $world.currentMenu === this._openMenu);
                  });
                  moreBtn.addScript(function onMouseUp(evt) {
                    var btn = this;
                    // Toggle-close, part 2/2: the snapshot from onMouseDown
                    // above tells us the click that just landed was a
                    // second click while our own menu was still open (and
                    // the world has since closed it as a side effect of
                    // this same click) — respect that as "close", don't
                    // reopen. Same toggle idiom as PostCardMailbox.js's
                    // _toggleRowMenu, just keyed off a different signal
                    // since that file's menus aren't lively.morphic.Menu.
                    if (btn._wasMyMenuOpen) {
                      btn._wasMyMenuOpen = false;
                      btn._openMenu = null;
                      evt.stop();
                      return true;
                    }
                    var did   = btn._friendDid;
                    var hndl  = btn._friendHandle;
                    var rowM  = btn.owner;
                    var pnl   = rowM && rowM.owner;
                    var pn    = pnl && pnl.owner;
                    var w     = pn && pn.owner;
                    var pos   = btn.worldPoint(lively.pt(0, btn.getExtent().y));
                    var items = [
                      ["Invite to constellation…", function () {
                        if (w) w._openInviteToConstellationPicker(did, hndl, pos);
                      }],
                      ["Remove friend", function () {
                        fetch('/@' + lively.identity.did.currentUser().handle + '/friends/' + did,
                          { method: 'DELETE', credentials: 'include' })
                          .then(function () {
                            if (pnl) pnl.remove();
                            if (w) w.loadProfile(w._handle, w._worldObjId);
                          });
                      }],
                    ];
                    btn._openMenu = lively.morphic.Menu.openAt(pos, '@' + (hndl || did), items);
                    evt.stop();
                    return true;
                  });
                });
                if (this._friends.length > 5) {
                  msg((this._friends.length - 5) + ' more…', 34 + 5 * ROWH, 16)
                    .applyStyle({ fontSize: 10, textColor: Color.rgb(150, 150, 150) });
                }
              }
            } else if (status === 'friends') {
              msg('You and @' + this._handle + ' are friends.', 36);
              var removeBtn = actionBtn('Remove friend', 80);
              removeBtn._targetDid = this._targetDid;
              removeBtn.addScript(function doAction() {
                var self_ = this;
                fetch('/@' + lively.identity.did.currentUser().handle + '/friends/' + this._targetDid,
                  { method: 'DELETE', credentials: 'include' })
                  .then(function () {
                    var w = self_.owner && self_.owner.owner && self_.owner.owner.owner;
                    self_.owner.remove();
                    if (w) w.loadProfile(w._handle, w._worldObjId);
                  });
              });
              lively.bindings.connect(removeBtn, 'fire', removeBtn, 'doAction');
            } else if (status === 'pending-outgoing') {
              msg('Friend request sent — pending.', 36);
              var cancelBtn = actionBtn('Cancel request', 80);
              cancelBtn.applyStyle({ textColor: Color.rgb(150, 40, 40) });
              cancelBtn._targetDid = this._targetDid;
              cancelBtn.addScript(function doAction() {
                var self_ = this;
                fetch('/@' + lively.identity.did.currentUser().handle + '/friend-requests/' + this._targetDid,
                  { method: 'DELETE', credentials: 'include' })
                  .then(function () {
                    var w = self_.owner && self_.owner.owner && self_.owner.owner.owner;
                    self_.owner.remove();
                    if (w) w.loadProfile(w._handle, w._worldObjId);
                  });
              });
              lively.bindings.connect(cancelBtn, 'fire', cancelBtn, 'doAction');
            } else if (status === 'pending-incoming') {
              msg('@' + this._handle + ' sent you a friend request.', 36, 40);
              var acceptBtn = actionBtn('Accept', 80);
              var declineBtn = actionBtn('Decline', 116);
              declineBtn.applyStyle({ textColor: Color.rgb(150, 40, 40) });
              acceptBtn._targetDid  = this._targetDid;
              declineBtn._targetDid = this._targetDid;
              // Deliberately duplicated (not a shared `respond` helper) —
              // addScript reconstructs each button's handler from its own
              // source text at click time, discarding any closure over a
              // function declared in this outer doAction's scope (same
              // BuildSpec-closure-loss gotcha as everywhere else in this
              // file); only this._targetDid and real global paths
              // (fetch, lively.identity.did) survive that reconstruction.
              acceptBtn.addScript(function doAction() {
                var self_ = this;
                fetch('/@' + lively.identity.did.currentUser().handle + '/friend-requests/' + this._targetDid,
                  { method: 'PUT', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'approve' }) })
                  .then(function () {
                    var w = self_.owner && self_.owner.owner && self_.owner.owner.owner;
                    self_.owner.remove();
                    if (w) w.loadProfile(w._handle, w._worldObjId);
                  });
              });
              declineBtn.addScript(function doAction() {
                var self_ = this;
                fetch('/@' + lively.identity.did.currentUser().handle + '/friend-requests/' + this._targetDid,
                  { method: 'PUT', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'decline' }) })
                  .then(function () {
                    var w = self_.owner && self_.owner.owner && self_.owner.owner.owner;
                    self_.owner.remove();
                    if (w) w.loadProfile(w._handle, w._worldObjId);
                  });
              });
              lively.bindings.connect(acceptBtn, 'fire', acceptBtn, 'doAction');
              lively.bindings.connect(declineBtn, 'fire', declineBtn, 'doAction');
            } else if (status === 'signed-out') {
              msg('Sign in to connect with @' + this._handle + '.', 36);
            } else {
              // 'none' — no relationship on file either direction.
              msg('You and @' + this._handle + ' are not yet friends.', 36);
              var reqBtn = actionBtn('Send friend request', 80);
              reqBtn._handle = this._handle;
              reqBtn.addScript(function doAction() {
                var self_ = this;
                fetch('/@' + this._handle + '/friend-requests',
                  { method: 'POST', credentials: 'include' })
                  .then(function () {
                    var w = self_.owner && self_.owner.owner && self_.owner.owner.owner;
                    self_.owner.remove();
                    if (w) w.loadProfile(w._handle, w._worldObjId);
                  });
              });
              lively.bindings.connect(reqBtn, 'fire', reqBtn, 'doAction');
            }

            // See copyBtn's comment further down (below the astro box) for
            // why this is a Text morph, not a Button.
            var closeBtn = new lively.morphic.Text(lively.rect(FW - 28, 6, 22, 22), 'close');
            closeBtn.draggingEnabled = false;
            closeBtn.droppingEnabled = false;
            closeBtn.grabbingEnabled = false;
            closeBtn.applyStyle({ borderRadius: 11, borderWidth: 0, fill: Color.rgba(0,0,0,0),
              fontFamily: "'Material Symbols Rounded'", fontSize: 12,
              textColor: Color.rgb(100, 100, 100), align: 'center',
              padding: lively.Rectangle.inset(0, 5, 0, 0),
              allowInput: false, selectable: false, clipMode: 'hidden',
              whiteSpaceHandling: 'pre', handStyle: 'pointer' });
            closeBtn.addScript(function onMouseUp(evt) {
              this.owner.remove();
              evt.stop();
              return true;
            });
            panel.addMorph(closeBtn);
            if (pane) pane.addMorph(panel);
          });
          lively.bindings.connect(friendsBtn, 'fire', friendsBtn, 'doAction');
          pane.addMorph(friendsBtn);
          tint(friendsBtn, 204, 0, 87);
        })();


        // verified identity
        heading('fingerprint', "Verified identity");

        var didStr = did ? lively.identity.postCardUtils.truncateDid(did) : "—";
        var didW = Math.ceil(didStr.length * 7.5) + 16;
        pane.addMorph(txt(didStr, contentX, y, didW, 16, 10, 50, 50, 50, false));

        // Copy DID button — sits immediately after the DID text. A real
        // lively.morphic.Text (not a Button) rendering a Material Symbols
        // Rounded glyph, same construction AmbientPresencePanel.js's
        // makeIconButton uses — confirmed live that this is NOT
        // interchangeable with a Button: lively.morphic.Button renders its
        // text through an internal child `this.label` Text morph, and
        // applyStyle({fontFamily:...}) on that child silently no-ops (the
        // glyph stayed literal "content_copy" text in the default font even
        // after direct application on an already-rendered label — root
        // cause not fully pinned down, textColor applies fine through the
        // same call so it isn't a blanket style-application failure). A
        // bare Text morph styled and clicked the same way as this file's
        // BuildSpec makeIconButton reference doesn't have that problem.
        // Box grown from the original 26x22 (with a 5px top `padding`) to
        // 24x24 with no custom padding -- confirmed live (chrome-devtools
        // MCP, cropped/zoomed screenshot + getBoundingClientRect) that the
        // old box clipped the glyph's bottom by ~5px, matching the clip
        // already flagged (but not yet fixed here) in inventory.md's
        // write-up of this exact button. `y - 4` instead of `y - 2` keeps
        // the taller box vertically centered on the 16px-tall value line
        // above it.
        var copyBtn = new lively.morphic.Text(lively.rect(contentX + didW + 4, y - 4, 24, 24), 'content_copy');
        copyBtn.draggingEnabled = false;
        copyBtn.droppingEnabled = false;
        copyBtn.grabbingEnabled = false;
        copyBtn.applyStyle({ fill: Color.rgba(0, 0, 0, 0),
          borderRadius: 12, borderWidth: 0,
          fontFamily: "'Material Symbols Rounded'", fontSize: 12,
          textColor: Color.rgb(120, 120, 128), align: 'center',
          allowInput: false, selectable: false, clipMode: 'hidden',
          whiteSpaceHandling: 'pre', handStyle: 'pointer' });
        copyBtn._copyDid = did;
        copyBtn.addScript(function onMouseUp(evt) {
          var theDid = this._copyDid;
          var m      = this;
          if (theDid && navigator.clipboard) {
            navigator.clipboard.writeText(theDid).then(function () {
              m.setTextString('check');
              setTimeout(function () { m.setTextString('content_copy'); }, 1500);
            });
          }
          evt.stop();
          return true;
        });
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
          heading('language', "Domain");
          domains.forEach(function (d) {
            var isVerified = d.status === 'verified';
            var domW = Math.ceil(d.domain.length * 7.5) + 16;
            pane.addMorph(txt(d.domain, contentX, y, domW, 16, 10, 50, 50, 50, false));
            var bc = isVerified ? [34, 139, 34] : [200, 150, 0];
            var badgeIcon = ico(isVerified ? 'verified' : 'error', contentX + domW + 4, y - 2, 14, bc[0], bc[1], bc[2]);
            pane.addMorph(badgeIcon);
            var badge = txt(isVerified ? 'Verified' : 'Invalid', contentX + domW + 24, y, 70, 16, 10,
              bc[0], bc[1], bc[2], false);
            pane.addMorph(badge);
            badge.renderContext().morphNode.title = isVerified ? 'Verified domain' : 'Invalid domain';
            y += 20;
          });
          y += 6;
        }

        // ETH address — heading line, then the copiable address on its own line.
        if (payload.ethAddress) {
          heading('account_balance_wallet', "ETH address");
          var addrStr = lively.identity.postCardUtils.truncateAddress(payload.ethAddress);
          var addrW = Math.ceil(addrStr.length * 7.5) + 16;
          pane.addMorph(txt(addrStr, contentX, y, addrW, 16, 10, 50, 50, 50, false));
          // See copyBtn above for why this is a Text morph, not a Button.
          // See copyBtn above for why this is 24x24 with no custom padding.
          var addrCopyBtn = new lively.morphic.Text(lively.rect(contentX + addrW + 4, y - 4, 24, 24), 'content_copy');
          addrCopyBtn.draggingEnabled = false;
          addrCopyBtn.droppingEnabled = false;
          addrCopyBtn.grabbingEnabled = false;
          addrCopyBtn.applyStyle({ fill: Color.rgba(0, 0, 0, 0),
            borderRadius: 12, borderWidth: 0,
            fontFamily: "'Material Symbols Rounded'", fontSize: 12,
            textColor: Color.rgb(120, 120, 128), align: 'center',
            allowInput: false, selectable: false, clipMode: 'hidden',
            whiteSpaceHandling: 'pre', handStyle: 'pointer' });
          addrCopyBtn._copyText = payload.ethAddress;
          addrCopyBtn.addScript(function onMouseUp(evt) {
            var theText = this._copyText;
            var m       = this;
            if (theText && navigator.clipboard) {
              navigator.clipboard.writeText(theText).then(function () {
                m.setTextString('check');
                setTimeout(function () { m.setTextString('content_copy'); }, 1500);
              });
            }
            evt.stop();
            return true;
          });
          pane.addMorph(addrCopyBtn);
          addrCopyBtn.renderContext().morphNode.title = 'Copy ETH address';
          y += 24;
        }

        // device
        heading('devices', "Device");
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
        pane.addMorph(ico('calendar_today', contentX, y + 1, 12, 150, 150, 158));
        pane.addMorph(txt("Joined " + joinedStr, contentX + 18, y, cw - 18, 16, 10, 100, 100, 108, false)).applyStyle({ fixedWidth: false });
        y += 18;
        pane.addMorph(ico('dns', contentX, y + 1, 12, 150, 150, 158));
        pane.addMorph(txt("Hosted on " + hostStr, contentX + 18, y, cw - 18, 16, 10, 100, 100, 108, false)).applyStyle({ fixedWidth: false });
        y += 18;

        var ph = pane.getExtent().y;

        // Enter World button — only shown when this handle has a world to
        // link to (passed in from IdentityServer.js's GET /@:handle when it
        // renders this card as the handle's landing page). Sits to the left
        // of the owner's Edit button when both are present, otherwise takes
        // the Edit button's usual bottom-right slot.
        if (self._worldObjId) {
          var EW = 130;
          var ex = self._isOwner ? (pw - 78 - 8 - EW) : (pw - EW - 12);
          var worldBtn = new lively.morphic.Button(
            lively.rect(ex, ph - 36, EW, 26), "Enter World →");
          worldBtn.applyStyle({ fill: Color.rgb(255, 255, 255),
            borderColor: Color.rgb(204, 0, 87), borderRadius: 13,
            fontSize: 12, textColor: Color.rgb(204, 0, 87), borderWidth: 1 });
          worldBtn.setAppearanceStylingMode(false);
          worldBtn.setBorderStylingMode(false);
          worldBtn._targetHandle     = handle;
          worldBtn._targetWorldObjId = self._worldObjId;
          worldBtn.addScript(function doAction() {
            window.location.href = '/@' + this._targetHandle + '/' + this._targetWorldObjId;
          });
          lively.bindings.connect(worldBtn, 'fire', worldBtn, 'doAction');
          pane.addMorph(worldBtn);
          tint(worldBtn, 204, 0, 87);
        }

        // Edit button — navigates to Window via this.owner._win
        if (self._isOwner) {
          var editBtn = new lively.morphic.Button(
            lively.rect(pw - 78, ph - 36, 66, 26), "Edit");
          editBtn.applyStyle({ fill: Color.rgb(204, 0, 87),
            borderColor: Color.rgb(204, 0, 87), borderRadius: 13,
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
          tint(editBtn, 255, 255, 255);
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

        // Store context on pane for button handlers (_win excluded from serialization)
        pane._win = self;
        if (pane.doNotSerialize && pane.doNotSerialize.indexOf('_win') === -1)
          pane.doNotSerialize.push('_win');

        var pw   = pane.getExtent().x;
        var y    = 12;
        var PINK = Color.rgb(204, 0, 87);
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
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 6 });
          inp.beInputLine();
          pane.addMorph(inp);
          y += (h || 24) + 8;
        }

        // Tab headers — switching tabs snapshots the currently-visible
        // fields into self._editPayload first (via win._snapshotEditFields)
        // so in-progress edits on the tab being left aren't lost, since each
        // tab is a full pane rebuild rather than a show/hide of two
        // pre-built panels (only one tab's fields exist in the pane at a time).
        // Button label color: applyStyle({textColor}) doesn't reach a
        // Button's label DOM (see CLAUDE.md), so write it directly.
        function tint(btn, r, g, b) {
          var c = 'rgb(' + r + ',' + g + ',' + b + ')';
          var n = btn.label && btn.label.renderContext().shapeNode;
          if (!n) return;
          n.style.color = c;
          var kids = n.querySelectorAll('*');
          for (var i = 0; i < kids.length; i++) kids[i].style.color = c;
        }

        function addTabButton(label, tabName, x) {
          var isActive = tab === tabName;
          var tb = new lively.morphic.Button(lively.rect(x, y, 124, 28), label);
          tb.applyStyle({
            fill:       isActive ? PINK : Color.rgb(255, 255, 255),
            borderColor: isActive ? PINK : Color.rgb(222, 222, 228),
            borderRadius: 14, fontSize: 11,
            textColor:  isActive ? Color.white : Color.rgb(90, 90, 98),
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
          if (isActive) tint(tb, 255, 255, 255); else tint(tb, 90, 90, 98);
        }
        addTabButton("Profile", "profile", 12);
        addTabButton("Accounts", "accounts", 142);
        addTabButton("Domain Handle", "domains", 272);
        y += 40;

        if (tab === 'profile') {

        addField("Display name", "pcDisplayName", payload.displayName || "");
        addField("Pronouns",     "pcPronouns",    payload.pronouns    || "");
        // Bio is capped at 300 chars. The counter sits on the label row,
        // right-aligned, and is fed by the input's 'textString' signal
        // (fired from Text#onKeyUp); anything past the cap is trimmed
        // there, and again on snapshot/save.
        var bioLblY = y;
        var bioStart = (payload.bio || "").slice(0, 300);
        addField("Bio",          "pcBio",         bioStart, 88);
        var bioCounter = new lively.morphic.Text(
          lively.rect(12 + ew - 90, bioLblY, 90, 16), bioStart.length + " / 300");
        bioCounter.applyStyle({ allowInput: false, fontSize: 10, align: 'right',
          textColor: Color.rgb(140, 140, 148),
          fill: Color.rgb(255, 255, 255), borderWidth: 0 });
        bioCounter.addScript(function onBioChanged(s) {
          s = s || '';
          var inp = this.owner && this.owner.get('pcBio');
          if (s.length > 300) {
            s = s.slice(0, 300);
            if (inp) {
              inp.textString = s;
              // Resetting textString drops the caret to the start; put it
              // back at the end so continued typing doesn't prepend.
              inp.setSelectionRange(s.length, s.length);
            }
          }
          this.setTextString(s.length + ' / 300');
          this.applyStyle({ textColor: s.length >= 300 ? Color.rgb(200, 40, 40) : Color.rgb(140, 140, 148) });
        });
        pane.addMorph(bioCounter);
        lively.bindings.connect(pane.get("pcBio"), 'textString', bioCounter, 'onBioChanged');

        y = self._buildProfileExtras(pane, payload, y, ew);

        } else if (tab === 'accounts') {

        // ── Accounts tab ─────────────────────────────────────────────────

        addField("ETH wallet address", "pcEthAddress", payload.ethAddress || "");

        y = self._buildSocials(pane, payload, y, ew);

        // ── websites (up to 3 — listed under the social circles on the
        // read view). Saved as payload.links = [{label, url}]. ────────────
        y += 8;
        var wsLbl = new lively.morphic.Text(lively.rect(12, y, ew, 16), "Websites (up to 3)");
        wsLbl.applyStyle({ allowInput: false, fontSize: 10,
          textColor: Color.rgb(120, 120, 120),
          fill: Color.rgb(255, 255, 255), borderWidth: 0 });
        pane.addMorph(wsLbl);
        y += 20;
        var siteLinks = payload.links || [];
        for (var wi = 0; wi < 3; wi++) {
          var wsInp = new lively.morphic.Text(lively.rect(12, y, ew, 24),
            (siteLinks[wi] && (siteLinks[wi].url || siteLinks[wi].label)) || "");
          wsInp.name = "pcWebsite" + wi;
          wsInp.applyStyle({ allowInput: true, fontSize: 12,
            fill: Color.rgb(252, 252, 252),
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 3 });
          wsInp.beInputLine();
          pane.addMorph(wsInp);
          y += 30;
        }

        } else {

        y = self._buildDomainTab(pane, y, ew);

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
        saveBtn.applyStyle({ fill: PINK, borderColor: PINK, borderRadius: 13,
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
        tint(saveBtn, 255, 255, 255);

        // Cancel — navigates to Window and reloads view
        var cancelBtn = new lively.morphic.Button(lively.rect(pw - 84, btnY, 72, 26), "Cancel");
        cancelBtn.applyStyle({ fill: Color.rgb(255, 255, 255),
          borderColor: Color.rgb(200, 200, 208), borderRadius: 13,
          fontSize: 12, textColor: Color.rgb(90, 90, 98), borderWidth: 1 });
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
        tint(cancelBtn, 90, 90, 98);
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
        var sunInp     = pane.get("pcSunSign");
        var moonInp     = pane.get("pcMoonSign");
        var risingInp   = pane.get("pcRisingSign");
        var ethInp      = pane.get("pcEthAddress");
        if (nameInp)     partial.displayName = nameInp.textString || "";
        if (pronounsInp) partial.pronouns    = pronounsInp.textString || "";
        if (bioInp)      partial.bio         = (bioInp.textString || "").slice(0, 300);
        if (avatarInp)   partial.avatarUrl   = avatarInp.textString || null;
        if (bannerInp)   partial.bannerUrl   = bannerInp.textString || null;
        if (pane.get("pcWebsite0")) {
          var links = [];
          for (var wi = 0; wi < 3; wi++) {
            var wInp = pane.get("pcWebsite" + wi);
            var wUrl = ((wInp && wInp.textString) || "").trim();
            if (!wUrl) continue;
            if (!/^https?:\/\//i.test(wUrl)) wUrl = "https://" + wUrl;
            links.push({ label: wUrl.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, ""), url: wUrl });
          }
          partial.links = links;
        }
        if (sunInp)    partial.sunSign = sunInp._signIdx >= 0 ? SV[sunInp._signIdx] : '';
        if (moonInp)   partial.moonSign = moonInp._signIdx >= 0 ? SV[moonInp._signIdx] : '';
        if (risingInp) partial.risingSign = risingInp._signIdx >= 0 ? SV[risingInp._signIdx] : '';
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

      // ── edit-tab builders (Accounts / Domain Handle) ─────────────────────────
      // Each returns the new y cursor. Everything they (or the handlers they
      // install) need from outside the method body goes through
      // lively.identity.ProfileCard.* — see the namespace helpers at the end
      // of this file — never module-scope vars (evalJS closure loss).

      _buildProfileExtras: function _buildProfileExtras(pane, payload, y, ew) {
        var PC = lively.identity.ProfileCard;
        var ui = PC.ui;

        // Image URL row: label, input, Upload pill. `cropOpts` (optional)
        // is passed through to the cropper (banner is a wide rect).
        function imageRow(label, inputName, value, cropOpts) {
          ui.text(pane, label, 12, y, ew, 16, 10, 120, 120, 128, false);
          y += 18;
          ui.input(pane, inputName, 12, y, ew - 92, value || '');
          var up = ui.pill(pane, 'Upload', 12 + ew - 84, y, 84, 26, false, function () {
            var p   = lively.identity.ProfileCard.ui.paneOf(this);
            var win = p && p._win;
            if (!win) return;
            var target = this._targetInput, opts = this._cropOpts;
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.display = 'none';
            document.body.appendChild(input);
            input.addEventListener('change', function () {
              var file = input.files && input.files[0];
              document.body.removeChild(input);
              if (!file) return;
              lively.identity.imageCropper.open(file, function (url) {
                var inp2 = win.targetMorph && win.targetMorph.get(target);
                if (inp2) inp2.textString = url;
              }, opts);
            });
            input.click();
          });
          up._targetInput = inputName;
          up._cropOpts = cropOpts;
          y += 36;
        }
        imageRow('Avatar URL', 'pcAvatarUrl', payload.avatarUrl);
        imageRow('Banner URL', 'pcBannerUrl', payload.bannerUrl,
          { width: 834, height: 160, shape: 'rect', title: 'Crop Banner', basename: 'banner' });

        y += 4;
        ui.text(pane, 'Astrological signs', 12, y, ew, 16, 10, 120, 120, 128, false);
        y += 22;

        // Each row steps through "Not set" (-1) and the 12 signs, so a
        // blank sign stays blank instead of silently saving as Aries.
        [['Sun', 'pcSunSign', payload.sunSign], ['Moon', 'pcMoonSign', payload.moonSign],
         ['Rising', 'pcRisingSign', payload.risingSign]].forEach(function (row) {
          var idx = PC.ZODIAC.SIGNS.indexOf(row[2]);
          ui.text(pane, row[0], 12, y + 4, 56, 18, 11, 90, 90, 98, false);
          var prev = ui.iconBtn(pane, 'chevron_left', 72, y + 2, 90, 90, 98, 'Previous');
          var disp = new lively.morphic.Text(lively.rect(100, y, 200, 26), PC.signLabel(idx));
          disp.name = row[1];
          disp._signIdx = idx;
          ui.noDrag(disp);
          disp.applyStyle({ allowInput: false, fontSize: 12, fontWeight: 'bold',
            textColor: idx < 0 ? Color.rgb(150, 150, 158) : Color.rgb(35, 35, 35),
            fill: Color.rgb(248, 248, 251), borderColor: Color.rgb(225, 225, 231),
            borderWidth: 1, borderRadius: 13, align: 'center' });
          pane.addMorph(disp);
          var next = ui.iconBtn(pane, 'chevron_right', 304, y + 2, 90, 90, 98, 'Next');
          prev._field = next._field = row[1];
          prev._step = -1; next._step = 1;
          prev.onMouseUp = next.onMouseUp = function (evt) {
            evt.stop();
            var P = lively.identity.ProfileCard;
            var p = P.ui.paneOf(this);
            var d = p && p.get(this._field);
            if (!d) return true;
            // -1..11 → 13 states
            d._signIdx = ((d._signIdx + 1 + this._step + 13) % 13) - 1;
            d.textString = P.signLabel(d._signIdx);
            var c = d._signIdx < 0 ? 'rgb(150,150,158)' : 'rgb(35,35,35)';
            var n = d.renderContext().shapeNode;
            n.style.color = c;
            var kids = n.querySelectorAll('*');
            for (var i = 0; i < kids.length; i++) kids[i].style.color = c;
            return true;
          };
          y += 34;
        });
        return y + 6;
      },

      _buildSocials: function _buildSocials(pane, payload, y, ew) {
        var PC  = lively.identity.ProfileCard;
        var ui  = PC.ui;
        var MAX = 5;
        var accounts = payload.socialAccounts || [];
        pane._selPlatform = null; // tiles are rebuilt unhighlighted

        y += 8;
        ui.text(pane, 'Social accounts', 12, y, ew - 80, 18, 11, 60, 60, 68, true);
        var counter = ui.text(pane, accounts.length + ' / ' + MAX, 12 + ew - 80, y, 80, 18, 10, 140, 140, 148, false);
        counter.applyStyle({ align: 'right' });
        y += 26;

        if (!accounts.length) {
          ui.text(pane, 'Nothing here yet. Pick a platform below and paste your profile link.',
            12, y, ew, 18, 11, 150, 150, 158, false);
          y += 26;
        }

        accounts.forEach(function (acc, idx) {
          var info = PC.platformInfo(acc.platform);
          var chip = ui.chip(pane, 12, y, 30);
          ui.chipIcon(chip, acc.platform, 30);
          ui.text(pane, info ? info.label : acc.platform, 50, y - 2, ew - 100, 18, 11, 40, 40, 48, true);
          ui.text(pane, String(acc.url || '').replace(/^https?:\/\/(www\.)?/i, ''),
            50, y + 14, ew - 100, 18, 10, 120, 120, 128, false);
          var rm = ui.iconBtn(pane, 'close', 12 + ew - 28, y + 3, 150, 30, 30, 'Remove');
          rm._idx = idx;
          rm.onMouseUp = function (evt) {
            evt.stop();
            var p   = lively.identity.ProfileCard.ui.paneOf(this);
            var win = p && p._win;
            if (!win) return true;
            var current = ((win._editPayload && win._editPayload.socialAccounts) || []).slice();
            current.splice(this._idx, 1);
            win._editPayload = Object.assign({}, win._editPayload, win._snapshotEditFields(p), { socialAccounts: current });
            win._renderEdit(win._handle, win._editPayload, win._currentDid, 'accounts');
            return true;
          };
          y += 36;
        });

        if (accounts.length >= MAX) {
          ui.text(pane, 'Maximum of ' + MAX + ' social accounts reached. Remove one to add another.',
            12, y, ew, 18, 10, 140, 140, 148, false);
          return y + 24;
        }

        y += 6;
        ui.text(pane, 'Add an account', 12, y, ew, 16, 10, 120, 120, 128, false);
        y += 20;

        var STEP = 38;
        var cols = Math.max(1, Math.floor((ew + 6) / STEP));
        PC.SOCIAL_PLATFORMS.forEach(function (p, i) {
          var chip = ui.chip(pane, 12 + (i % cols) * STEP, y + Math.floor(i / cols) * STEP, 32);
          chip.name = 'pcPlat_' + p.key;
          chip._platformKey = p.key;
          ui.chipIcon(chip, p.key, 32);
          chip.renderContext().morphNode.title = p.label;
          chip.onMouseUp = function (evt) {
            evt.stop();
            lively.identity.ProfileCard.ui.selectPlatform(this.owner, this._platformKey);
            return true;
          };
        });
        y += Math.ceil(PC.SOCIAL_PLATFORMS.length / cols) * STEP + 2;

        var sel = ui.text(pane, 'Choose a platform', 12, y, ew, 18, 11, 120, 120, 128, true);
        sel.name = 'pcSelPlatLbl';
        // Pasting a recognisable link picks the platform automatically
        // (same textString-signal + addScript idiom as the bio counter).
        sel.addScript(function onUrlChanged(s) {
          var P = lively.identity.ProfileCard;
          var key = P.platformForUrl(s);
          if (key && this.owner) P.ui.selectPlatform(this.owner, key);
        });
        y += 24;

        var urlInp = ui.input(pane, 'pcNewSocialUrl', 12, y, ew - 84, '');
        lively.bindings.connect(urlInp, 'textString', sel, 'onUrlChanged');
        ui.pill(pane, 'Add', 12 + ew - 76, y, 76, 26, true, function () {
          var P   = lively.identity.ProfileCard;
          var p   = P.ui.paneOf(this);
          var win = p && p._win;
          if (!win) return;
          function fail(t) { P.ui.setMsg(p, 'pcSocialMsg', t, true); }
          var inp = p.get('pcNewSocialUrl');
          var url = ((inp && inp.textString) || '').trim();
          var key = p._selPlatform || P.platformForUrl(url);
          if (!key) return fail('Pick a platform first.');
          if (!url) return fail('Paste your ' + P.platformInfo(key).label + ' profile link.');
          if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
          var current = ((win._editPayload && win._editPayload.socialAccounts) || []).slice();
          if (current.length >= 5) return fail('Maximum 5 social accounts.');
          current.push({ platform: key, url: url });
          win._editPayload = Object.assign({}, win._editPayload, win._snapshotEditFields(p), { socialAccounts: current });
          win._renderEdit(win._handle, win._editPayload, win._currentDid, 'accounts');
        });
        y += 32;

        var msg = ui.text(pane, '', 12, y, ew, 18, 10, 200, 40, 40, false);
        msg.name = 'pcSocialMsg';
        return y + 22;
      },

      _buildDomainTab: function _buildDomainTab(pane, y, ew) {
        var self = this;
        var PC   = lively.identity.ProfileCard;
        var ui   = PC.ui;
        var rows = self._domains || [];

        // ── A domain is already set: show it as a status card ─────────────
        if (rows.length) {
          self._pendingDomain = null;
          self._domainMethod  = null;
          var d  = rows[0];
          var ok = d.status === 'verified';
          ui.text(pane, 'Domain handle', 12, y, ew, 18, 11, 60, 60, 68, true);
          y += 26;
          var card = ui.card(pane, 12, y, ew, 58);
          ui.icon(card, 'language', 14, 17, 22, 90, 90, 98);
          ui.text(card, d.domain, 48, 8, ew - 110, 20, 13, 30, 30, 38, true);
          if (ok) {
            ui.icon(card, 'check_circle', 48, 32, 14, 34, 139, 34);
            ui.text(card, 'Verified', 66, 30, 200, 18, 10, 34, 139, 34, false);
          } else {
            ui.icon(card, 'error', 48, 32, 14, 200, 140, 20);
            ui.text(card, "Couldn't verify right now", 66, 30, 240, 18, 10, 170, 115, 10, false);
          }
          var rm = ui.iconBtn(card, 'delete', ew - 36, 18, 150, 30, 30, 'Remove domain');
          rm._domain = d.domain;
          rm.onMouseUp = function (evt) {
            evt.stop();
            var p   = lively.identity.ProfileCard.ui.paneOf(this);
            var win = p && p._win;
            if (!win) return true;
            win._editPayload = Object.assign({}, win._editPayload, win._snapshotEditFields(p));
            lively.identity.userSpace.removeDomain(this._domain, function (err) {
              if (err) { alert('Could not remove domain: ' + err.message); return; }
              lively.identity.userSpace.listDomains(win._handle, function (err2, rows2) {
                win._domains = rows2 || [];
                win._renderEdit(win._handle, win._editPayload, win._currentDid, 'domains');
              });
            });
            return true;
          };
          y += 70;
          if (!ok) {
            var re = ui.pill(pane, 'Re-check now', 12, y, 120, 26, false, function () {
              lively.identity.ProfileCard.ui.runVerify(this);
            });
            re._domain = d.domain;
            var reMsg = ui.text(pane, '', 144, y, ew - 132, 30, 10, 200, 40, 40, false);
            reMsg.name = 'pcDomainMsg';
            y += 38;
          }
          ui.text(pane, 'One domain handle per identity. Remove it to use a different domain.',
            12, y, ew, 30, 10, 140, 140, 148, false);
          return y + 34;
        }

        // ── Step 1: enter a domain ────────────────────────────────────────
        if (!self._pendingDomain) {
          ui.text(pane, 'Use your own domain as your handle', 12, y, ew, 20, 12, 40, 40, 48, true);
          y += 24;
          ui.text(pane, "Add a domain to your profile e.g example.com and verify ownership with a single DNS record check.",
            12, y, ew, 44, 10, 120, 120, 128, false);
          y += 50;
          ui.text(pane, 'Your domain', 12, y, ew, 16, 10, 120, 120, 128, false);
          y += 18;
          ui.input(pane, 'pcNewDomain', 12, y, ew - 108, '');
          ui.pill(pane, 'Continue', 12 + ew - 100, y, 100, 26, true, function () {
            var P   = lively.identity.ProfileCard;
            var p   = P.ui.paneOf(this);
            var win = p && p._win;
            if (!win) return;
            var inp = p.get('pcNewDomain');
            var dom = P.normalizeDomain(inp && inp.textString);
            if (!dom) return P.ui.setMsg(p, 'pcDomainMsg', 'Enter a valid domain, like example.com.', true);
            win._editPayload   = Object.assign({}, win._editPayload, win._snapshotEditFields(p));
            win._pendingDomain = dom;
            win._domainMethod  = 'dns';
            win._renderEdit(win._handle, win._editPayload, win._currentDid, 'domains');
          });
          y += 34;
          var m1 = ui.text(pane, '', 12, y, ew, 18, 10, 200, 40, 40, false);
          m1.name = 'pcDomainMsg';
          return y + 22;
        }

        // ── Step 2: prove ownership ───────────────────────────────────────
        var dom    = self._pendingDomain;
        var method = self._domainMethod || 'dns';

        var back = ui.iconBtn(pane, 'arrow_back', 12, y - 1, 90, 90, 98, 'Use a different domain');
        back.onMouseUp = function (evt) {
          evt.stop();
          var p   = lively.identity.ProfileCard.ui.paneOf(this);
          var win = p && p._win;
          if (!win) return true;
          win._pendingDomain = null;
          win._renderEdit(win._handle, win._editPayload, win._currentDid, 'domains');
          return true;
        };
        ui.text(pane, 'Verify ' + dom, 44, y, ew - 44, 20, 13, 30, 30, 38, true);
        y += 34;

        if (method === 'dns') {
          ui.text(pane, "Add this TXT record in your domain's DNS settings:", 12, y, ew, 18, 11, 80, 80, 88, false);
          y += 26;
          // The value is a did:jwk: (~180+ chars, one unbroken token), so the
          // row's height comes from its length — a fixed height overflowed
          // the card. Deliberately conservative (8px/char, 18px/line) since
          // a short box clips/overflows while a slightly tall one is harmless.
          var recVal   = 'did=' + self._currentDid;
          var perLine  = Math.max(10, Math.floor((ew - 100) / 8));
          var valueH   = Math.ceil(recVal.length / perLine) * 18 + 8;
          var rec = ui.card(pane, 12, y, ew, 76 + valueH + 8);
          ui.recordRow(rec, 'Type',  'TXT',         12, 30, null,          ew);
          ui.recordRow(rec, 'Name',  '_lively-did', 44, 30, '_lively-did', ew);
          ui.recordRow(rec, 'Value', recVal,        76, valueH, recVal,    ew, 10);
          y += 76 + valueH + 8 + 10;
          ui.text(pane, 'If your DNS provider wants the full name, use _lively-did.' + dom + ' instead.',
            12, y, ew, 30, 10, 140, 140, 148, false);
          y += 34;
        } else {
          ui.text(pane, 'Publish a signed file at this address on your site:', 12, y, ew, 18, 11, 80, 80, 88, false);
          y += 26;
          var url = 'https://' + dom + '/.well-known/lively-did';
          var fcard = ui.card(pane, 12, y, ew, 44);
          ui.recordRow(fcard, 'URL', url, 12, 30, url, ew);
          y += 54;
          var gen = ui.pill(pane, 'Generate signed file', 12, y, 170, 26, false, function () {
            var P   = lively.identity.ProfileCard;
            var btn = this;
            var p   = P.ui.paneOf(btn);
            var win = p && p._win;
            if (!win) return;
            btn.setLabel('Signing…');
            btn.setActive(false);
            function reset() { btn.setLabel('Generate signed file'); btn.setActive(true); }
            win._getSoftSigningKey(function (err, key) {
              if (err) { reset(); return P.ui.setMsg(p, 'pcDomainMsg', 'Could not sign: ' + err.message, true); }
              var doc = lively.identity.webKey.buildWellKnownPayload({
                did: win._currentDid, handle: win._handle, domain: win._pendingDomain });
              lively.identity.webKey.signWellKnown(doc, key, function (err2, signed) {
                if (err2) { reset(); return P.ui.setMsg(p, 'pcDomainMsg', 'Signing failed: ' + err2.message, true); }
                var json = JSON.stringify(signed, null, 2);
                var box  = p.get('pcSignedJson');
                if (box) { box.setTextString(json); box._json = json; }
                var cp = p.get('pcCopyJson');
                if (cp) cp._copyText = json;
                btn.setLabel('Regenerate');
                btn.setActive(true);
                P.ui.setMsg(p, 'pcDomainMsg', 'Save this as the file above, then click Verify.', false);
              });
            });
          });
          y += 34;
          var jbox = new lively.morphic.Text(lively.rect(12, y, ew - 30, 84),
            'The signed file will appear here.');
          jbox.name = 'pcSignedJson';
          jbox.applyStyle({ allowInput: false, fixedWidth: true, fixedHeight: true,
            wordBreak: 'break-all', clipMode: 'auto', fontSize: 9, textColor: Color.rgb(60, 60, 68),
            fill: Color.rgb(248, 248, 251), borderColor: Color.rgb(225, 225, 231),
            borderWidth: 1, borderRadius: 8 });
          pane.addMorph(jbox);
          var cpj = ui.copyBtn(pane, 12 + ew - 24, y + 2, '');
          cpj.name = 'pcCopyJson';
          y += 94;
        }

        var vb = ui.pill(pane, 'Verify', 12, y, 96, 28, true, function () {
          lively.identity.ProfileCard.ui.runVerify(this);
        });
        vb._domain = dom;
        var vm = ui.text(pane, (method === 'dns' ? 'DNS changes can take a few minutes to show up.' : 'Verify once the file is live on your site.'), 120, y + 2, ew - 108, 30, 10, 140, 140, 148, false);
        vm.name = 'pcDomainMsg';
        y += 42;

        var alt = ui.link(pane, method === 'dns' ? "Can't edit DNS? Use a signed file instead"
                                                 : 'Use a DNS record instead', 12, y, ew);
        alt.onMouseUp = function (evt) {
          evt.stop();
          var p   = lively.identity.ProfileCard.ui.paneOf(this);
          var win = p && p._win;
          if (!win) return true;
          win._domainMethod = win._domainMethod === 'file' ? 'dns' : 'file';
          win._renderEdit(win._handle, win._editPayload, win._currentDid, 'domains');
          return true;
        };
        return y + 26;
      },
    });

    lively.identity.ProfileCard = {
      // worldObjId (optional): when given, the card shows an "Enter World →"
      // button linking to /@handle/worldObjId — used when this card is the
      // handle's own landing page (see IdentityServer.js's GET /@:handle).
      open: function (handle, worldObjId) {
        var win    = lively.BuildSpec("lively.identity.ProfileCard").createMorph();
        var user   = lively.identity.did.currentUser();
        var target = handle || (user && user.handle);
        win.setTitle(target ? "Profile — @" + target : "Profile");
        win.openInWorldCenter();
        win.loadProfile(handle || null, worldObjId || null);
        return win;
      },
    };

    // Shared data + widget helpers for the edit tabs (_buildSocials /
    // _buildDomainTab). They live on the namespace, not as module-scope
    // vars, because BuildSpec methods and addScript'd handlers are rebuilt
    // from source text and lose their enclosing closure — a dotted global
    // path is the only thing that survives (see CLAUDE.md).
    Object.extend(lively.identity.ProfileCard, {
      PINK: Color.rgb(204, 0, 87),
      ZODIAC: {
        SIGNS:  ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
                 'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'],
        GLYPHS: ['♈︎','♉︎','♊︎','♋︎','♌︎','♍︎','♎︎','♏︎','♐︎','♑︎','♒︎','♓︎'],
      },
      signLabel: function (idx) {
        var Z = lively.identity.ProfileCard.ZODIAC;
        return idx < 0 ? 'Not set' : Z.GLYPHS[idx] + '  ' + Z.SIGNS[idx];
      },

      // hosts: hostnames (and their subdomains) used to auto-detect the
      // platform from a pasted profile link; the longest match wins, so
      // music.youtube.com resolves to ytmusic rather than youtube.
      SOCIAL_PLATFORMS: [
        { key: 'discord',    label: 'Discord',             hosts: ['discord.com', 'discord.gg'] },
        { key: 'spotify',    label: 'Spotify',             hosts: ['spotify.com'] },
        { key: 'instagram',  label: 'Instagram',           hosts: ['instagram.com'] },
        { key: 'github',     label: 'GitHub',              hosts: ['github.com'] },
        { key: 'youtube',    label: 'YouTube',             hosts: ['youtube.com', 'youtu.be'] },
        { key: 'tiktok',     label: 'TikTok',              hosts: ['tiktok.com'] },
        { key: 'twitch',     label: 'Twitch',              hosts: ['twitch.tv'] },
        { key: 'bluesky',    label: 'Bluesky',             hosts: ['bsky.app'] },
        { key: 'blacksky',   label: 'Blacksky',            hosts: ['blacksky.community'] },
        { key: 'behance',    label: 'Behance',             hosts: ['behance.net'] },
        { key: 'steam',      label: 'Steam',               hosts: ['steamcommunity.com'] },
        { key: 'cashapp',    label: 'Cash App',            hosts: ['cash.app'] },
        { key: 'pinterest',  label: 'Pinterest',           hosts: ['pinterest.com'] },
        { key: 'arena',      label: 'Are.na',              hosts: ['are.na'] },
        { key: 'goodreads',  label: 'Goodreads',           hosts: ['goodreads.com'] },
        { key: 'applemusic', label: 'Apple Music',         hosts: ['music.apple.com'] },
        { key: 'ytmusic',    label: 'YT Music',            hosts: ['music.youtube.com'] },
        { key: 'storygraph', label: 'StoryGraph',          hosts: ['thestorygraph.com'] },
        { key: 'itch',       label: 'itch.io',             hosts: ['itch.io'] },
        { key: 'psn',        label: 'PlayStation Network', hosts: ['psnprofiles.com', 'playstation.com'] },
        { key: 'mynintendo', label: 'My Nintendo',         hosts: ['nintendo.com'] },
        { key: 'xbox',       label: 'Xbox',                hosts: ['xbox.com'] },
        { key: 'epic',       label: 'Epic Games',          hosts: ['epicgames.com'] },
        { key: 'tumblr',     label: 'Tumblr',              hosts: ['tumblr.com'] },
        { key: 'threads',    label: 'Threads',             hosts: ['threads.net', 'threads.com'] },
      ],

      platformInfo: function (key) {
        var L = lively.identity.ProfileCard.SOCIAL_PLATFORMS;
        for (var i = 0; i < L.length; i++) if (L[i].key === key) return L[i];
        return null;
      },

      // Absolute path — the card is viewed at nested URLs like /@handle/obj.
      iconUrl: function (key) { return '/core/media/social-icons/' + key + '.svg'; },

      platformForUrl: function (url) {
        var m = /^(?:[a-z]+:\/\/)?([^\/?#\s]+)/i.exec(String(url || '').trim());
        if (!m) return null;
        var host = m[1].toLowerCase().replace(/^www\./, '');
        var L = lively.identity.ProfileCard.SOCIAL_PLATFORMS;
        var best = null, bestLen = 0;
        L.forEach(function (p) {
          p.hosts.forEach(function (h) {
            if ((host === h || host.slice(-(h.length + 1)) === '.' + h) && h.length > bestLen) {
              best = p.key; bestLen = h.length;
            }
          });
        });
        return best;
      },

      // "https://Alice.com/foo" -> "alice.com"; null when it isn't a plausible domain.
      normalizeDomain: function (str) {
        var d = String(str || '').trim().toLowerCase()
          .replace(/^[a-z]+:\/\//, '').replace(/[\/?#].*$/, '').replace(/^www\./, '');
        return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d) ? d : null;
      },

      ui: {
        noDrag: function (m) {
          m.draggingEnabled = false; m.droppingEnabled = false; m.grabbingEnabled = false;
          return m;
        },

        // Owning edit pane (the morph carrying _win), whatever the nesting depth.
        paneOf: function (m) {
          while (m && !m._win) m = m.owner;
          return m || null;
        },

        // Button label colour: applyStyle({textColor}) doesn't reach a
        // Button's label DOM (CLAUDE.md), so write it directly.
        tint: function (btn, r, g, b) {
          var c = 'rgb(' + r + ',' + g + ',' + b + ')';
          var n = btn.label && btn.label.renderContext().shapeNode;
          if (!n) return;
          n.style.color = c;
          var kids = n.querySelectorAll('*');
          for (var i = 0; i < kids.length; i++) kids[i].style.color = c;
        },

        // Plain label. Default Text border is 1px black, so zero it.
        text: function (parent, str, x, y, w, h, size, r, g, b, bold) {
          var t = new lively.morphic.Text(lively.rect(x, y, w, h), str);
          lively.identity.ProfileCard.ui.noDrag(t);
          t.applyStyle({ allowInput: false, fontSize: size, fontWeight: bold ? 'bold' : 'normal',
            textColor: Color.rgb(r, g, b), fill: Color.rgba(0, 0, 0, 0),
            borderWidth: 0, borderColor: null });
          parent.addMorph(t);
          return t;
        },

        input: function (parent, name, x, y, w, value) {
          var inp = new lively.morphic.Text(lively.rect(x, y, w, 26), value || '');
          inp.name = name;
          inp.applyStyle({ allowInput: true, fontSize: 12, fill: Color.rgb(252, 252, 252),
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 6 });
          inp.beInputLine();
          parent.addMorph(inp);
          return inp;
        },

        // Rounded surface for grouped content; children use card-local coords.
        card: function (parent, x, y, w, h) {
          var b = new lively.morphic.Box(lively.rect(x, y, w, h));
          lively.identity.ProfileCard.ui.noDrag(b);
          b.applyStyle({ fill: Color.rgb(248, 248, 251), borderColor: Color.rgb(225, 225, 231),
            borderWidth: 1, borderRadius: 10 });
          parent.addMorph(b);
          return b;
        },

        // Square clickable tile (platform picker / account row icon).
        chip: function (parent, x, y, size) {
          var b = new lively.morphic.Box(lively.rect(x, y, size, size));
          lively.identity.ProfileCard.ui.noDrag(b);
          b.applyStyle({ fill: Color.white, borderColor: Color.rgb(225, 225, 231),
            borderWidth: 1, borderRadius: 8, handStyle: 'pointer' });
          parent.addMorph(b);
          return b;
        },

        chipIcon: function (chip, platformKey, size) {
          var s   = size - 14;
          var img = new lively.morphic.Image(lively.rect(7, 7, s, s));
          img.setImageURL(lively.identity.ProfileCard.iconUrl(platformKey));
          img.applyStyle({ borderWidth: 0, clipMode: 'hidden' });
          lively.identity.ProfileCard.ui.noDrag(img);
          img.eventsAreIgnored = true;
          chip.addMorph(img);
          return img;
        },

        // Highlight one platform tile, update the caption.
        selectPlatform: function (pane, key) {
          var PC = lively.identity.ProfileCard;
          pane._selPlatform = key;
          pane.submorphs.forEach(function (m) {
            if (!m._platformKey) return;
            var on = m._platformKey === key;
            var border = on ? PC.PINK : Color.rgb(225, 225, 231);
            var fill   = on ? Color.rgb(255, 240, 246) : Color.white;
            m.applyStyle({ borderColor: border, fill: fill });
            // Model updates on an already-rendered morph don't always reach
            // the DOM (CLAUDE.md) — write it directly too.
            var n = m.renderContext().shapeNode;
            n.style.borderColor = border.toString();
            n.style.background  = fill.toString();
          });
          var lbl  = pane.get('pcSelPlatLbl');
          var info = PC.platformInfo(key);
          if (lbl && info) {
            lbl.setTextString(info.label);
            var n2 = lbl.renderContext().shapeNode;
            n2.style.color = 'rgb(204,0,87)';
            var kids = n2.querySelectorAll('*');
            for (var i = 0; i < kids.length; i++) kids[i].style.color = 'rgb(204,0,87)';
          }
        },

        // Material Symbols glyph as a non-interactive Text morph; see
        // _renderView's ico() for the box/padding/offset reasoning.
        icon: function (parent, name, x, y, px, r, g, b) {
          var box = px + 8;
          var m = new lively.morphic.Text(lively.rect(x - 4, y + 2, box, box), name);
          lively.identity.ProfileCard.ui.noDrag(m);
          m.applyStyle({ allowInput: false, selectable: false, clipMode: 'hidden',
            fontFamily: "'Material Symbols Rounded'", fontSize: px * 0.75, align: 'center',
            whiteSpaceHandling: 'pre', padding: lively.Rectangle.inset(0, 0, 0, 0),
            textColor: Color.rgb(r, g, b), fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
          m.eventsAreIgnored = true;
          parent.addMorph(m);
          return m;
        },

        // Clickable icon: same recipe as the profile card's own close button.
        // Caller assigns .onMouseUp on the returned morph.
        iconBtn: function (parent, name, x, y, r, g, b, tip) {
          var m = new lively.morphic.Text(lively.rect(x, y, 22, 22), name);
          lively.identity.ProfileCard.ui.noDrag(m);
          m.applyStyle({ borderRadius: 11, borderWidth: 0, fill: Color.rgba(0, 0, 0, 0),
            fontFamily: "'Material Symbols Rounded'", fontSize: 12,
            textColor: Color.rgb(r, g, b), align: 'center',
            padding: lively.Rectangle.inset(0, 5, 0, 0),
            allowInput: false, selectable: false, clipMode: 'hidden',
            whiteSpaceHandling: 'pre', handStyle: 'pointer' });
          parent.addMorph(m);
          if (tip) m.renderContext().morphNode.title = tip;
          return m;
        },

        copyBtn: function (parent, x, y, text) {
          var m = lively.identity.ProfileCard.ui.iconBtn(parent, 'content_copy', x, y, 120, 120, 128, 'Copy');
          m._copyText = text;
          m.onMouseUp = function (evt) {
            evt.stop();
            var self = this;
            var txt  = this._copyText;
            if (!txt || !navigator.clipboard) return true;
            navigator.clipboard.writeText(txt).then(function () {
              self.setTextString('check');
              setTimeout(function () { self.setTextString('content_copy'); }, 1200);
            });
            return true;
          };
          return m;
        },

        // One "Label   value  [copy]" row inside a card. copyValue null = no copy button.
        recordRow: function (card, label, value, y, h, copyValue, cardW, size) {
          var ui = lively.identity.ProfileCard.ui;
          ui.text(card, label, 12, y + 2, 44, 18, 10, 140, 140, 148, false);
          var v = ui.text(card, value, 60, y + 1, cardW - 60 - 40, h - 2, size || 11, 30, 30, 38, false);
          v.applyStyle({ wordBreak: 'break-all', fixedWidth: true });
          if (copyValue) ui.copyBtn(card, cardW - 32, y - 1, copyValue);
        },

        // Text link (pink, pointer). Caller assigns .onMouseUp.
        link: function (parent, str, x, y, w) {
          var t = lively.identity.ProfileCard.ui.text(parent, str, x, y, w, 18, 10, 204, 0, 87, false);
          t.applyStyle({ handStyle: 'pointer' });
          return t;
        },

        // Inline status line under a control; replaces alert().
        setMsg: function (pane, name, str, isError) {
          var m = pane.get(name);
          if (!m) return;
          m.setTextString(str);
          var c = isError ? 'rgb(200,40,40)' : 'rgb(140,140,148)';
          var n = m.renderContext().shapeNode;
          n.style.color = c;
          var kids = n.querySelectorAll('*');
          for (var i = 0; i < kids.length; i++) kids[i].style.color = c;
        },

        // Pill button; fn is stored as _onClick and must be self-contained.
        pill: function (parent, label, x, y, w, h, primary, fn) {
          var PC = lively.identity.ProfileCard;
          var b  = new lively.morphic.Button(lively.rect(x, y, w, h), label);
          b.applyStyle({
            fill:        primary ? PC.PINK : Color.white,
            borderColor: primary ? PC.PINK : Color.rgb(222, 222, 228),
            borderRadius: h / 2, fontSize: 11, borderWidth: 1,
            textColor:   primary ? Color.white : Color.rgb(90, 90, 98),
          });
          b.setAppearanceStylingMode(false);
          b.setBorderStylingMode(false);
          b._idleLabel = label;
          b._onClick = fn;
          b.addScript(function doAction() { this._onClick(); });
          lively.bindings.connect(b, 'fire', b, 'doAction');
          parent.addMorph(b);
          if (primary) PC.ui.tint(b, 255, 255, 255); else PC.ui.tint(b, 90, 90, 98);
          return b;
        },

        // Ask the server to verify btn._domain (or the pending one); shows
        // progress/errors on the pane's 'pcDomainMsg' line, and on success
        // reloads the Domain Handle tab.
        runVerify: function (btn) {
          var PC   = lively.identity.ProfileCard;
          var pane = PC.ui.paneOf(btn);
          var win  = pane && pane._win;
          var dom  = btn._domain || (win && win._pendingDomain);
          if (!win || !dom) return;
          var tint = btn._idleLabel === 'Verify' ? [255, 255, 255] : [90, 90, 98];
          btn.setLabel('Checking…');
          btn.setActive(false);
          PC.ui.setMsg(pane, 'pcDomainMsg', 'Checking ' + dom + '…', false);
          lively.identity.userSpace.verifyDomain(dom, function (err) {
            if (err) {
              btn.setLabel(btn._idleLabel);
              btn.setActive(true);
              PC.ui.tint(btn, tint[0], tint[1], tint[2]);
              return PC.ui.setMsg(pane, 'pcDomainMsg', err.message, true);
            }
            lively.identity.userSpace.listDomains(win._handle, function (err2, rows) {
              win._domains       = rows || [];
              win._pendingDomain = null;
              win._renderEdit(win._handle, win._editPayload, win._currentDid, 'domains');
            });
          });
        },
      },
    });

  }); // end module('lively.identity.ProfileCard')
