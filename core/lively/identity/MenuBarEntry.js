module("lively.identity.MenuBarEntry")
  .requires(
    "lively.identity.DID",
    "lively.identity.SignedSerializer",
    "lively.identity.PostCardUtils",
    "lively.persistence.BuildSpec",
    "lively.morphic.tools.MenuBar",
  )
  .toRun(function () {

    // Advertise to the MenuBar system (same pattern as Wiki.js / Lively2Lively.js).
    // MenuBar calls module("lively.identity.MenuBarEntry").getMenuBarEntries(),
    // which resolves to lively.identity.MenuBarEntry — so the method must live here.
    Object.extend(lively.identity.MenuBarEntry, {
      getMenuBarEntries: function () {
        return [lively.BuildSpec("lively.identity.MenuBarEntry").createMorph()];
      },
    });

    lively.require("lively.identity.AmbientPresencePanel").toRun(function () {
      lively.identity.AmbientPresencePanel.init();
    });

    lively.BuildSpec(
      "lively.identity.MenuBarEntry",
      lively.BuildSpec("lively.morphic.tools.MenuBarEntry").customize({

        name: "IdentityMenuBarEntry",
        menuBarAlign: "right",
        textString: "sign in",

        style: lively.lang.obj.merge(
          lively.BuildSpec("lively.morphic.tools.MenuBarEntry").attributeStore.style,
          {
            extent: lively.pt(80, 25),
            toolTip: "Identity — sign in or manage your account",
          },
        ),

        // avatar shown to the left of the "@handle" label, once signed in
        AVATAR_SIZE:   16,
        AVATAR_GAP:    2,
        BASE_PADDING:  6,
        BASE_WIDTH:    80,

        morphMenuItems: function morphMenuItems() {
          var self = this;
          if (!lively.identity.did || !lively.identity.did.isLoggedIn()) {
            return [
              ["sign in",         function () { self.openLoginDialog(); }],
              ["Create identity", function () { self.openRegisterDialog(); }],
            ];
          }
          return [
            ["Compose", [
              ["Postcard", function () { self.newPostcard(); }],
              ["Wiki",     function () { self.newWiki(); }],
            ]],
            ["My profile",         function () { self.openMyProfile(); }],
            ["My worlds",          function () { self.openMyWorlds(); }],
            ["My Constellations",  function () { self.openMyConstellations(); }],
            ["Friends",            function () { self.openFriends(); }],
            ["Wallet",             function () { self.openWallet(); }],
            ["Mailbox", [
              ["Received",  function () { self.openMailbox("received");  }],
              ["Delivered", function () { self.openMailbox("delivered"); }],
              ["Returned",  function () { self.openMailbox("returned");  }],
            ]],
            ["Files",              function () { self.openFiles(); }],
            ["Settings",           function () { self.openSettings(); }],
            ["Add device",         function () { self.openRegisterDialog(); }],
            ["Sign out",    function () { self.signOut(); }],
          ];
        },

        openLoginDialog: function openLoginDialog() {
          lively.require("lively.identity.LoginDialog").toRun(function () {
            lively.BuildSpec("lively.identity.LoginDialog")
              .createMorph().openInWorldCenter();
          });
        },

        openRegisterDialog: function openRegisterDialog() {
          lively.require("lively.identity.RegisterDialog").toRun(function () {
            lively.BuildSpec("lively.identity.RegisterDialog")
              .createMorph().openInWorldCenter();
          });
        },

        signOut: function signOut() {
          var did = lively.identity.did;
          var user = did.currentUser();
          $world.confirm(
            "Sign out as @" + user.handle + "?",
            function (ok) {
              if (!ok) return;
              // Clear in-memory state immediately so the menubar updates now.
              did._currentUser = null;
              lively.bindings.signal(did, "identityChanged", null);

              function _finishSignOut() {
                // Clear IndexedDB so restoreSession() cannot revive this session.
                did.clearSession(function () {
                  // Notify other tabs only after the server session is gone so
                  // their /welcome.html redirect won't see a live session.
                  if (typeof BroadcastChannel !== "undefined") {
                    var _ch = new BroadcastChannel("lively-identity");
                    _ch.postMessage({ type: "signed-out" });
                    _ch.close();
                  }
                  if (lively.Config) lively.Config.askBeforeQuit = false;
                  window.location.href = "/welcome.html";
                });
              }

              // Wait for the server to commit the session deletion before
              // navigating — otherwise /welcome.html sees a live cookie and
              // bounces back to the user's home world.
              fetch("/nodejs/IdentityServer/logout", {
                method: "POST",
                credentials: "include",
              }).then(_finishSignOut).catch(function (err) {
                console.warn("[Identity] Server logout failed:", err.message);
                _finishSignOut();
              });
            },
          );
        },

        openMyWorlds: function openMyWorlds() {
          lively.require("lively.identity.WorldsBrowser").toRun(function () {
            lively.BuildSpec("lively.identity.WorldsBrowser").createMorph().openInWorldCenter();
          });
        },

        newPostcard: function newPostcard() {
          var handle = lively.identity.did.currentUser().handle;
          lively.require("lively.identity.PostCardEditor").toRun(function () {
            // _handle is bare (no '@') — PostCardEditor's PUT/GET URL building
            // literally prepends '/@' to it (same convention as PostCardMailbox's
            // inbox/deliveries/settings routes).
            lively.identity.PostCardEditor.newCard(handle);
          });
        },

        newWiki: function newWiki() {
          var handle = lively.identity.did.currentUser().handle;
          lively.require("lively.identity.WikiEditor").toRun(function () {
            lively.identity.WikiEditor.newCard(handle);
          });
        },

        openMailbox: function openMailbox(tab) {
          lively.require("lively.identity.PostCardMailbox").toRun(function () {
            lively.identity.PostCardMailbox.open(tab);
          });
        },

        openMyConstellations: function openMyConstellations() {
          lively.require("lively.identity.ConstellationsBrowser").toRun(function () {
            lively.BuildSpec("lively.identity.ConstellationsBrowser").createMorph().openInWorldCenter();
          });
        },

        openFiles: function openFiles() {
          lively.require("lively.identity.FilesBrowser").toRun(function () {
            lively.identity.FilesBrowser.open();
          });
        },

        // Placeholder — no settings options exist yet. Opens a blank window
        // titled "Settings" to be filled in later.
        openSettings: function openSettings() {
          var box = new lively.morphic.Box(lively.rect(0, 0, 400, 300));
          box.openInWindow({
            title: "Settings",
            pos: lively.morphic.World.current().visibleBounds().center(),
          });
        },

        // Placeholder — no friends list/browser exists yet (the only Friends
        // UI so far is the stub panel on ProfileCard). Opens a blank window
        // titled "Friends" to be filled in later.
        openFriends: function openFriends() {
          var box = new lively.morphic.Box(lively.rect(0, 0, 400, 300));
          box.openInWindow({
            title: "Friends",
            pos: lively.morphic.World.current().visibleBounds().center(),
          });
        },

        openWallet: function openWallet() {
          lively.require("lively.identity.Wallet").toRun(function () {
            lively.identity.Wallet.open();
          });
        },

        openMyProfile: function openMyProfile() {
          lively.require("lively.identity.ProfileCard").toRun(function () {
            lively.identity.ProfileCard.open();
          });
        },

        update: function update() {
          if (!lively.identity || !lively.identity.did) return;
          var loggedIn = lively.identity.did.isLoggedIn();
          var user = loggedIn && lively.identity.did.currentUser();
          this.textString = loggedIn ? "@" + user.handle : "sign in";
          this.updateAvatar(loggedIn ? user.handle : null);
        },

        // Shows a small identicon (or the user's uploaded avatarUrl, once
        // fetched) to the left of the "@handle" label. Grows/shrinks this
        // entry's width to make room and re-triggers the bar's relayout,
        // same as updateText() does for label-width changes.
        updateAvatar: function updateAvatar(handle) {
          var self = this;
          var AV = this.AVATAR_SIZE, GAP = this.AVATAR_GAP, PAD = this.BASE_PADDING;

          if (!handle) {
            if (!this._avatarMorph) return;
            this._avatarMorph.remove();
            this._avatarMorph = null;
            this._avatarHandle = null;
            this.applyStyle({ padding: lively.Rectangle.inset(PAD, 0, PAD, 0) });
            this.setExtent(this.getExtent().withX(this.BASE_WIDTH));
            this.owner && this.owner.relayout && this.owner.relayout();
            this.recenterText();
            return;
          }

          if (!this._avatarMorph) {
            var img = new lively.morphic.Image(lively.rect(PAD, 0, AV, AV));
            img.applyStyle({ borderRadius: AV / 2, borderWidth: 0, clipMode: "hidden" });
            this._avatarMorph = this.addMorph(img);
            this.applyStyle({ padding: lively.Rectangle.inset(PAD + AV + GAP, 0, PAD, 0) });
            this.setExtent(this.getExtent().withX(this.BASE_WIDTH + AV + GAP));
            this.owner && this.owner.relayout && this.owner.relayout();
            this.recenterText();
          }
          this._avatarMorph.setPosition(
            lively.pt(PAD, Math.max(0, (this.getExtent().y - AV) / 2)));

          if (this._avatarHandle === handle) return;
          this._avatarHandle = handle;

          this._avatarMorph.setImageURL(
            lively.identity.postCardUtils.identiconDataUrl(handle, AV));

          fetch("/@" + handle + "/profile", { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (env) {
              if (!env || self._avatarHandle !== handle || !self._avatarMorph) return;
              var payload = (env.record && env.record.payload) || {};
              if (payload.avatarUrl) self._avatarMorph.setImageURL(payload.avatarUrl);
            })
            .catch(function () {});
        },

        // Called when the morph is added to the world from a saved world file,
        // and by onFromBuildSpecCreated when created fresh.
        onLoad: function onLoad() {
          var self = this;
          var connect = function () {
            self.update();
            lively.bindings.connect(
              lively.identity.did, "identityChanged",
              self, "update",
            );
          };
          // If DID.js is already loaded (normal path: module loads before world
          // deserializes), connect immediately. Otherwise defer — toRun() fires
          // as soon as the module's onload callbacks run.
          if (lively.identity && lively.identity.did) {
            connect();
          } else {
            lively.require("lively.identity.DID").toRun(connect);
          }
        },

        onFromBuildSpecCreated: function onFromBuildSpecCreated() {
          this.onLoad();
        },
      }),
    );

  }); // end module('lively.identity.MenuBarEntry')
