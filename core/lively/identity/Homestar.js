/**
 * lively.identity.Homestar
 *
 * A handle's home page, served by GET /@:handle (buildHomestarPage in
 * IdentityServer.js): what a new user lands on after registering, what a
 * shared profile link opens, and what the profile card's Enter button goes to.
 *
 * Like the constellation lounge it is a Lively world whose whole UI is morphs
 * (Box / Text / Image added to $world), created fresh on every page load — it
 * is not a saved world object, and every visitor gets the same fixed layout.
 * Everything is rebuilt from current state by _render(), which runs on load,
 * whenever a fetch lands, and (debounced) on window resize.
 *
 * So far: identity header, an orbit panel, the postcard reel (PostcardReel.js)
 * and a worlds panel, each with its empty state. Audience control and the
 * remaining widgets are separate steps (homestar.md §8).
 *
 * Open: lively.identity.Homestar.open(data) — buildHomestarPage's onStartWorld
 * hook passes the JSON it embedded: { handle, displayHandle, did, viewer,
 * isOwner, profile }.
 *
 * Handlers below are plain assignments / closures inside an Object.subclass, not
 * BuildSpec or addScript, so module-level helpers are safe to reference.
 */

module("lively.identity.Homestar")
  .requires(
    "lively.identity.DID",
    "lively.identity.PostCardUtils",
    "lively.identity.HomestarUI",
    "lively.identity.PostcardReel",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    var UI = lively.identity.HomestarUI;
    var PINK = UI.PINK, PINK_SOFT = UI.PINK_SOFT, PAGE_FILL = UI.PAGE_FILL;
    var CARD_BORDER = UI.CARD_BORDER, INK = UI.INK, MUTED = UI.MUTED;
    var noDrag = UI.noDrag, trunc = UI.trunc, textW = UI.textW;
    var label = UI.label, icon = UI.icon, panel = UI.panel, pill = UI.pill;

    var TOP = 64;                  // clears the menu bar
    var PAD = 24;                  // page side margin, and hero inner margin
    var MAX_W = 1240;
    var GAP = 20;
    var LEFT_W = 290, RIGHT_W = 310;
    var WIDE_MIN = 1100;           // content width needed for three columns
    var BANNER_H = 168, AVATAR = 108;
    var TEXT_X = PAD + AVATAR + 20;   // hero text column, right of the avatar
    var BIO_LINE_H = 21, BIO_MAX_LINES = 3;

    var SIGNS  = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
                  "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
    var GLYPHS = ["♈︎", "♉︎", "♊︎", "♋︎", "♌︎", "♍︎", "♎︎", "♏︎", "♐︎", "♑︎", "♒︎", "♓︎"];

    // Safe to use as a CSS url() / <img>: http(s) or a same-site path.
    function safeUrl(u) {
      u = String(u || "").trim();
      return /^(https?:\/\/|\/(?!\/))/i.test(u) ? u : null;
    }

    function chip(x, y, text, opts) {
      opts = opts || {};
      var px = 12;
      var w = textW(text, px, false) + 24, h = 24;
      var box = new lively.morphic.Box(lively.rect(x, y, w, h));
      box.applyStyle({ fill: opts.fill || PINK_SOFT, borderRadius: h / 2, borderWidth: 0, clipMode: "hidden" });
      noDrag(box);
      box.addMorph(label(lively.rect(0, 1, w, 20), text, { px: px, color: opts.color || PINK, align: "center" }));
      if (opts.onClick) {
        box.applyStyle({ handStyle: "pointer" });
        box.onMouseUp = function (evt) { evt.stop(); opts.onClick(); return true; };
      }
      return {morph: box, w: w, h: h};
    }

    var getJSON = UI.getJSON;

    Object.subclass("lively.identity.HomestarController",
    "init", {
      initialize: function (data) {
        this._data = data;
        this._handle = data.handle;
        this._shown = data.displayHandle || data.handle;
        this._did = data.did;
        this._viewer = data.viewer || null;
        this._isOwner = !!data.isOwner;
        this._profile = data.profile || {};

        this._morphs = [];        // top-level page morphs, replaced wholesale by _render()
        this._friendStatus = null;  // null = not loaded / not applicable
        this._orbit = null;         // null = loading
        this._worlds = null;        // null = loading
        this._renderTimer = null;
      },
    },

    "boot", {
      start: function () {
        var staticEl = document.getElementById("homestar-static");
        if (staticEl) staticEl.remove();
        var loader = document.getElementById("homestar-loader");
        if (loader) loader.remove();

        // Reserve the scrollbar's width up front so the world's width (taken from
        // clientWidth) doesn't shift when the page grows taller than the window.
        document.documentElement.style.overflowY = "scroll";
        $world.setFill(PAGE_FILL);

        this._render();
        this._load();
        this._installMenuBarEntry();
        window.addEventListener("resize", this._onResize.bind(this));
      },

      _load: function () {
        var self = this;
        var base = "/@" + encodeURIComponent(this._handle);

        getJSON(base + "/orbit", function (err, body) {
          self._orbit = body || { locked: false, members: [], pinned: [], failed: true };
          self._scheduleRender();
        });
        getJSON(base + "/worlds", function (err, body) {
          var worlds = (body && body.worlds) || [];
          self._worlds = self._featuredWorlds(worlds);
          self._scheduleRender();
        });
        if (this._viewer && !this._isOwner) {
          getJSON(base + "/friend-status", function (err, body) {
            self._friendStatus = (body && body.status) || "none";
            self._scheduleRender();
          });
        }
      },

      // The worlds the page lists: the profile's featured ones, in that order,
      // limited to what /worlds says this viewer may open. Accounts from before
      // featured worlds existed have none recorded, so they get their oldest
      // world (the one the old landing page used to open).
      _featuredWorlds: function (visibleWorlds) {
        var hs = this._profile.homestar || {};
        var ids = hs.featuredWorlds;
        if (!Array.isArray(ids)) return visibleWorlds.slice(0, 1);
        var byId = {};
        visibleWorlds.forEach(function (w) { byId[w.objId] = w; });
        return ids.map(function (id) { return byId[id]; }).filter(Boolean);
      },

      // Re-reads the profile after the profile card edited it, then redraws.
      _refreshProfile: function () {
        var self = this;
        getJSON("/@" + encodeURIComponent(this._handle) + "/profile", function (err, env) {
          var p = env && env.record && env.record.payload;
          if (!p) return;
          self._profile = p;
          self._scheduleRender();
        });
      },

      _installMenuBarEntry: function () {
        var self = this;
        var attempts = 0;
        (function tryInstall() {
          var menuBar = typeof $world !== "undefined" && $world && $world.get(/^MenuBar/);
          var entry = menuBar && (menuBar.submorphs || []).find(function (m) { return m.name === "WorldNameMenuBarEntry"; });
          if (entry) return self._patchMenuBarEntry(entry);
          if (++attempts > 25) return;
          setTimeout(tryInstall, 200);
        })();
      },

      // The entry normally names the current saved world and opens its
      // save/rename menu; this page is neither, so it names the page instead.
      _patchMenuBarEntry: function (entry) {
        var self = this;
        var name = "@" + this._shown;
        entry.currentWorldDisplayName = function () { return name; };
        entry.toolTip = name + "'s homestar";
        entry.onMouseUp = function (evt) {
          var pos = entry.worldPoint(lively.pt(0, entry.getExtent().y));
          lively.morphic.Menu.openAt(pos, name, [
            ["Copy link", function () { self._copyLink(); }],
          ]);
          evt.stop();
          return true;
        };
        entry.update();
      },

      _copyLink: function () {
        var url = lively.identity.did.baseUrl() + "/@" + encodeURIComponent(this._shown);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).catch(function () { window.prompt("Copy this link:", url); });
        } else {
          window.prompt("Copy this link:", url);
        }
      },
    },

    "render", {
      _scheduleRender: function () {
        var self = this;
        if (this._renderTimer) return;
        this._renderTimer = setTimeout(function () { self._renderTimer = null; self._render(); }, 30);
      },

      _onResize: function () {
        lively.lang.fun.debounceNamed("homestar-resize-" + this._handle, 150, this._render.bind(this))();
      },

      _add: function (m) {
        $world.addMorph(m);
        this._morphs.push(m);
        return m;
      },

      _render: function () {
        this._morphs.forEach(function (m) { m.remove(); });
        this._morphs = [];

        var W = document.documentElement.clientWidth - 1;
        var contentW = Math.min(W - PAD * 2, MAX_W);
        var x0 = Math.round((W - contentW) / 2);
        var wide = contentW >= WIDE_MIN;

        var y = TOP;
        y = this._buildHero(x0, y, contentW) + GAP;

        var bottom;
        if (wide) {
          var centerX = x0 + LEFT_W + GAP;
          var centerW = contentW - LEFT_W - RIGHT_W - GAP * 2;
          var leftBottom = this._buildOrbit(x0, y, LEFT_W);
          var centerBottom = this._buildPostcards(centerX, y, centerW);
          var rightBottom = this._buildWorlds(x0 + contentW - RIGHT_W, y, RIGHT_W);
          bottom = Math.max(leftBottom, centerBottom, rightBottom);
        } else {
          // One column: the postcards first, then worlds, then orbit.
          y = this._buildPostcards(x0, y, contentW) + GAP;
          y = this._buildWorlds(x0, y, contentW) + GAP;
          bottom = this._buildOrbit(x0, y, contentW);
        }

        // Taller than the window: grow the world so the page scrolls.
        var H = Math.max(window.innerHeight, bottom + 40);
        $world.setExtent(lively.pt(W, H));
      },
    },

    "hero", {
      _buildHero: function (x, y, w) {
        var self = this;
        var p = this._profile;
        var name = p.displayName || this._shown;

        // Actions are laid out first because their width decides how much room
        // the name has; on a narrow hero they drop below the chips instead.
        var actions = this._buildActions();
        var actionsW = actions.reduce(function (s, a) { return s + a.getExtent().x + 10; }, 0);
        var actionsBeside = w - TEXT_X - PAD - actionsW > 220;

        var hero = panel(lively.rect(x, y, w, 300));
        hero.applyStyle({ borderRadius: 18 });
        this._add(hero);

        var banner = new lively.morphic.Box(lively.rect(0, 0, w, BANNER_H));
        banner.applyStyle({ fill: null, borderWidth: 0 });
        noDrag(banner);
        banner.eventsAreIgnored = true;
        hero.addMorph(banner);
        var bannerUrl = safeUrl(p.bannerUrl);
        banner.renderContext().shapeNode.style.background = bannerUrl
          ? "center / cover no-repeat url(" + JSON.stringify(bannerUrl) + ")"
          : [
              "radial-gradient(2px 2px at 8% 24%, #fff 50%, transparent 52%)",
              "radial-gradient(1.5px 1.5px at 21% 62%, #fff 50%, transparent 52%)",
              "radial-gradient(2px 2px at 37% 18%, #fff 50%, transparent 52%)",
              "radial-gradient(1.5px 1.5px at 52% 48%, #fff 50%, transparent 52%)",
              "radial-gradient(2px 2px at 66% 22%, #fff 50%, transparent 52%)",
              "radial-gradient(1.5px 1.5px at 79% 58%, #fff 50%, transparent 52%)",
              "radial-gradient(2px 2px at 91% 30%, #fff 50%, transparent 52%)",
              "radial-gradient(ellipse 70% 60% at 50% 125%, rgba(232,73,126,0.65), transparent 70%)",
              "linear-gradient(180deg, #14103a, #2b2160)",
            ].join(", ");

        var avatar = new lively.morphic.Image(lively.rect(PAD, BANNER_H - AVATAR / 2, AVATAR, AVATAR));
        avatar.setImageURL(safeUrl(p.avatarUrl) || lively.identity.postCardUtils.identiconDataUrl(this._did || this._handle, AVATAR));
        avatar.applyStyle({ borderRadius: AVATAR / 2, borderWidth: 4, borderColor: Color.white, clipMode: "hidden" });
        noDrag(avatar);
        avatar.eventsAreIgnored = true;
        hero.addMorph(avatar);

        var textTop = BANNER_H + 10;
        var nameW = actionsBeside ? w - TEXT_X - PAD - actionsW - 12 : w - TEXT_X - PAD;
        hero.addMorph(label(lively.rect(TEXT_X, textTop, nameW, 34), trunc(name, 40), { px: 26, bold: true }));

        var sub = "@" + this._shown + (p.pronouns ? "  ·  " + trunc(p.pronouns, 24) : "");
        hero.addMorph(label(lively.rect(TEXT_X, textTop + 36, nameW, 22), sub, { px: 14, color: MUTED }));

        var cy = textTop + 66;
        var bio = String(p.bio || "").trim();
        if (bio) {
          var bioW = w - TEXT_X - PAD;
          var cap = BIO_MAX_LINES * Math.max(20, Math.floor(bioW / 7.6));
          hero.addMorph(label(lively.rect(TEXT_X, cy, bioW, BIO_LINE_H * BIO_MAX_LINES + 6), trunc(bio, cap),
            { px: 14, color: Color.rgb(91, 84, 112), wrap: true }));
          cy += BIO_LINE_H * Math.min(BIO_MAX_LINES, Math.max(1, Math.ceil(Math.min(bio.length, cap) / Math.max(20, Math.floor(bioW / 7.6))))) + 12;
        }

        cy = this._buildChips(hero, TEXT_X, cy, w - TEXT_X - PAD);

        // Action pills.
        if (actionsBeside) {
          var ax = w - PAD;
          actions.slice().reverse().forEach(function (a) {
            ax -= a.getExtent().x;
            a.setPosition(lively.pt(ax, textTop + 2));
            hero.addMorph(a);
            ax -= 10;
          });
        } else {
          var bx = TEXT_X;
          actions.forEach(function (a) {
            a.setPosition(lively.pt(bx, cy));
            hero.addMorph(a);
            bx += a.getExtent().x + 10;
          });
          cy += 40;
        }

        var heroH = Math.max(cy + 12, BANNER_H + AVATAR / 2 + 20);
        hero.setExtent(lively.pt(w, heroH));
        return y + heroH;
      },

      // Sun/moon/rising and status, then up to five links; flows onto further
      // rows when they don't fit. Returns the y below the last row.
      _buildChips: function (hero, x, y, maxW) {
        var p = this._profile;
        var items = [];
        var st = p.orbit && p.orbit.status;
        if (st && st.label) items.push({ text: (st.emoji ? st.emoji + " " : "") + trunc(st.label, 16) });
        [["☉", p.sunSign], ["☽", p.moonSign], ["↑", p.risingSign]].forEach(function (pair) {
          var i = SIGNS.indexOf(pair[1]);
          if (i >= 0) items.push({ text: pair[0] + " " + GLYPHS[i] + " " + SIGNS[i] });
        });
        (p.links || []).slice(0, 5).forEach(function (l) {
          var url = l && safeUrl(l.url);
          if (!url) return;
          items.push({
            text: "↗ " + trunc(l.label || url.replace(/^https?:\/\/(www\.)?/i, ""), 28),
            onClick: function () { window.open(url, "_blank", "noopener"); },
          });
        });
        if (!items.length) return y;

        var cx = x, rowY = y;
        items.forEach(function (it) {
          var c = chip(cx, rowY, it.text, { onClick: it.onClick });
          if (cx > x && cx + c.w > x + maxW) {
            cx = x; rowY += 30;
            c.morph.setPosition(lively.pt(cx, rowY));
          }
          hero.addMorph(c.morph);
          cx += c.w + 8;
        });
        return rowY + 30;
      },

      // The viewer-dependent pills. Built unpositioned; _buildHero places them.
      _buildActions: function () {
        var self = this;
        var out = [];
        var handle = this._handle;

        if (this._isOwner) {
          out.push(pill(0, 0, "Edit profile", { primary: true, onClick: function () { self._openProfileCard(); } }));
          return out;
        }

        out.push(pill(0, 0, "Profile", { onClick: function () { self._openProfileCard(); } }));

        if (!this._viewer) {
          out.unshift(pill(0, 0, "Sign in to say hi", { primary: true, onClick: function () { self._openLogin(); } }));
          return out;
        }

        var st = this._friendStatus;
        if (st === "friends") {
          out.unshift(pill(0, 0, "Message", { primary: true, onClick: function () { self._openDM(); } }));
        } else if (st === "none") {
          out.unshift(pill(0, 0, "Add friend", { primary: true, onClick: function () { self._sendFriendRequest(); } }));
        } else if (st === "pending-outgoing") {
          out.unshift(pill(0, 0, "Request sent", { disabled: true }));
        } else if (st === "pending-incoming") {
          out.unshift(pill(0, 0, "Accept friend request", { primary: true, onClick: function () { self._approveFriendRequest(); } }));
        }
        return out;
      },
    },

    "orbit", {
      _buildOrbit: function (x, y, w) {
        var self = this;
        var box = panel(lively.rect(x, y, w, 140));
        box.applyStyle({ fill: Color.rgb(249, 246, 253), borderColor: Color.rgb(232, 224, 244) });
        this._add(box);
        box.addMorph(icon(lively.rect(16, 14, 22, 22), "group", 18, PINK));
        box.addMorph(label(lively.rect(44, 14, w - 60, 22), "Orbit", { px: 15, bold: true }));

        var o = this._orbit;
        var bodyY = 46, bodyH = 40, text, color = MUTED;
        if (!o) {
          text = "Loading…";
        } else if (o.locked) {
          text = "@" + this._shown + " keeps their orbit " + (o.visibility === "friends" ? "for friends." : "private.");
        } else if (!o.members.length) {
          text = this._isOwner ? "Your orbit is empty. Close friends you add will show up here." : "Nobody in orbit yet.";
        }

        if (text) {
          box.addMorph(label(lively.rect(16, bodyY, w - 32, bodyH), text, { px: 13, color: color, wrap: true }));
          box.setExtent(lively.pt(w, bodyY + bodyH + 14));
          return y + bodyY + bodyH + 14;
        }

        // Members: a wrapped row of avatars, pinned ones first, each opening the
        // mini profile. (The ring layout is a later step.)
        var D = 44, step = D + 10;
        var perRow = Math.max(1, Math.floor((w - 32 + 10) / step));
        var pinned = o.pinned || [];
        var members = o.members.slice().sort(function (a, b) {
          return (pinned.indexOf(b.did) >= 0 ? 1 : 0) - (pinned.indexOf(a.did) >= 0 ? 1 : 0);
        });
        members.slice(0, perRow * 3).forEach(function (m, i) {
          var ax = 16 + (i % perRow) * step, ay = bodyY + Math.floor(i / perRow) * step;
          var img = new lively.morphic.Image(lively.rect(ax, ay, D, D));
          img.setImageURL(lively.identity.postCardUtils.identiconDataUrl(m.did, D));
          img.applyStyle({
            borderRadius: D / 2, clipMode: "hidden", handStyle: "pointer",
            borderWidth: pinned.indexOf(m.did) >= 0 ? 2 : 0, borderColor: PINK,
          });
          noDrag(img);
          if (m.handle) {
            img.onMouseUp = function (evt) {
              evt.stop();
              lively.require("lively.identity.MiniProfileCard").toRun(function () {
                lively.identity.MiniProfileCard.open(m.handle, m.did, img);
              });
              return true;
            };
          }
          box.addMorph(img);
        });
        var rows = Math.min(3, Math.ceil(members.length / perRow));
        var h = bodyY + rows * step + 8;
        box.setExtent(lively.pt(w, h));
        return y + h;
      },
    },

    "postcards", {
      // The reel is one long-lived object with its own morphs (so a resize does
      // not restart the card); this only positions it.
      _buildPostcards: function (x, y, w) {
        if (!this._reel) {
          var self = this;
          this._reel = new lively.identity.PostcardReel({
            handle: this._handle,
            shown: this._shown,
            viewer: this._viewer,
            isOwner: this._isOwner,
            onNew: function () { self._newPostcard(); },
            onResize: function () { self._scheduleRender(); },
          });
        }
        return this._reel.attach(x, y, w);
      },
    },

    "worlds", {
      _buildWorlds: function (x, y, w) {
        var self = this;
        var worlds = this._worlds;
        // Nothing to show a visitor: leave the panel out rather than draw an empty one.
        if (worlds && !worlds.length && !this._isOwner) return y - GAP;

        var box = panel(lively.rect(x, y, w, 120));
        this._add(box);
        box.addMorph(icon(lively.rect(16, 14, 22, 22), "public", 18, PINK));
        box.addMorph(label(lively.rect(44, 14, w - 60, 22), "Worlds", { px: 15, bold: true }));

        var cy = 46;
        if (!worlds) {
          box.addMorph(label(lively.rect(16, cy, w - 32, 20), "Loading…", { px: 13, color: MUTED }));
          cy += 28;
        } else if (!worlds.length) {
          box.addMorph(label(lively.rect(16, cy, w - 32, 20), "No worlds featured yet.", { px: 13, color: MUTED }));
          cy += 28;
        } else {
          worlds.forEach(function (wd) {
            box.addMorph(self._worldRow(wd, 12, cy, w - 24));
            cy += 60;
          });
        }

        if (this._isOwner) {
          var t = label(lively.rect(16, cy + 2, w - 32, 20), "All my worlds →", { px: 13, bold: true, color: PINK });
          t.eventsAreIgnored = false;
          t.applyStyle({ handStyle: "pointer" });
          t.onMouseUp = function (evt) { evt.stop(); self._openWorldsBrowser(); return true; };
          box.addMorph(t);
          cy += 30;
        }

        var h = cy + 12;
        box.setExtent(lively.pt(w, h));
        return y + h;
      },

      _worldRow: function (wd, x, y, w) {
        var self = this;
        var row = new lively.morphic.Box(lively.rect(x, y, w, 52));
        row.applyStyle({ fill: Color.rgb(250, 248, 252), borderRadius: 10, borderWidth: 1, borderColor: CARD_BORDER, clipMode: "hidden", handStyle: "pointer" });
        noDrag(row);

        var tile = new lively.morphic.Box(lively.rect(8, 8, 36, 36));
        tile.applyStyle({ fill: PINK_SOFT, borderRadius: 9, borderWidth: 0 });
        noDrag(tile);
        tile.eventsAreIgnored = true;
        row.addMorph(tile);
        tile.addMorph(icon(lively.rect(5, 5, 26, 26), "language", 20, PINK));

        var detail = wd.template ? String(wd.template).replace(/[-_]/g, " ") : "blank world";
        row.addMorph(label(lively.rect(54, 7, w - 90, 20), trunc(wd.name || "Untitled", 28), { px: 14, bold: true }));
        row.addMorph(label(lively.rect(54, 27, w - 90, 18), trunc(detail, 28), { px: 12, color: MUTED }));
        var vis = wd.visibility === "public" ? "lock_open" : (wd.visibility === "shared" ? "group" : "lock");
        row.addMorph(icon(lively.rect(w - 30, 16, 20, 20), vis, 16, MUTED));

        row.onMouseOver = function () { row.applyStyle({ fill: PINK_SOFT }); };
        row.onMouseOut  = function () { row.applyStyle({ fill: Color.rgb(250, 248, 252) }); };
        row.onMouseUp = function (evt) {
          evt.stop();
          window.location.href = "/@" + encodeURIComponent(self._handle) + "/" + encodeURIComponent(wd.objId);
          return true;
        };
        return row;
      },
    },

    "actions", {
      _openProfileCard: function () {
        var self = this;
        lively.require("lively.identity.ProfileCard").toRun(function () {
          var win = lively.identity.ProfileCard.open(self._handle);
          // An edit saved in the card should show up here once it is closed.
          var origRemove = win.remove;
          win.remove = function () {
            var r = origRemove.apply(this, arguments);
            if (self._isOwner) self._refreshProfile();
            return r;
          };
        });
      },

      _openLogin: function () {
        lively.require("lively.identity.LoginDialog").toRun(function () {
          lively.BuildSpec("lively.identity.LoginDialog").createMorph().openInWorldCenter();
        });
      },

      _openDM: function () {
        var self = this;
        lively.require("lively.identity.DMChat").toRun(function () {
          lively.identity.DMChat.open(self._handle, self._did);
        });
      },

      _newPostcard: function () {
        var handle = this._viewer && this._viewer.handle;
        if (!handle) return;
        lively.require("lively.identity.PostCardEditor").toRun(function () {
          lively.identity.PostCardEditor.newCard(handle);
        });
      },

      _openWorldsBrowser: function () {
        lively.require("lively.identity.WorldsBrowser").toRun(function () {
          lively.BuildSpec("lively.identity.WorldsBrowser").createMorph().openInWorldCenter();
        });
      },

      _sendFriendRequest: function () {
        var self = this;
        fetch("/@" + encodeURIComponent(this._handle) + "/friend-requests", { method: "POST", credentials: "include" })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body.error) return $world.alert(body.error);
            // A request answered the other way round befriends at once.
            self._friendStatus = body.status === "accepted" ? "friends" : "pending-outgoing";
            self._scheduleRender();
          })
          .catch(function (err) { $world.alert("Could not send the request: " + err.message); });
      },

      _approveFriendRequest: function () {
        var self = this;
        fetch("/@" + encodeURIComponent(this._viewer.handle) + "/friend-requests/" + encodeURIComponent(this._did), {
          method: "PUT", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body.error) return $world.alert(body.error);
            self._friendStatus = "friends";
            self._scheduleRender();
          })
          .catch(function (err) { $world.alert("Could not accept the request: " + err.message); });
      },
    });

    lively.identity.Homestar = {
      open: function (data) {
        var controller = new lively.identity.HomestarController(data);
        controller.start();
        return controller;
      },
    };

  });
