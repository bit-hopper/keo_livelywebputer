module("lively.identity.MenuBarEntry")
  .requires(
    "lively.identity.DID",
    "lively.persistence.BuildSpec",
    "lively.morphic.tools.MenuBar",
  )
  .toRun(function () {

    // Advertise to the MenuBar system (same pattern as Wiki.js / Lively2Lively.js).
    Object.extend(lively.identity, {
      getMenuBarEntries: function () {
        return [lively.BuildSpec("lively.identity.MenuBarEntry").createMorph()];
      },
    });

    lively.BuildSpec(
      "lively.identity.MenuBarEntry",
      lively.BuildSpec("lively.morphic.tools.MenuBarEntry").customize({

        name: "IdentityMenuBarEntry",
        menuBarAlign: "right",
        textString: "Sign in",

        style: lively.lang.obj.merge(
          lively.BuildSpec("lively.morphic.tools.MenuBarEntry").attributeStore.style,
          {
            extent: lively.pt(80, 22),
            toolTip: "Identity — sign in or manage your account",
          },
        ),

        morphMenuItems: function morphMenuItems() {
          var self = this;
          if (!lively.identity.did.isLoggedIn()) {
            return [
              ["Sign in", function () { self.openLoginDialog(); }],
            ];
          }
          return [
            ["Add device", function () { self.openRegisterDialog(); }],
            ["Sign out",   function () { self.signOut(); }],
            ["My worlds",  function () { self.openMyWorlds(); }],
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
              // Clear in-memory session first so the UI updates immediately.
              did._currentUser = null;
              lively.bindings.signal(did, "identityChanged", null);
              // Invalidate the server session cookie; failure is non-fatal.
              fetch("/nodejs/IdentityServer/logout", {
                method: "POST",
                credentials: "include",
              }).catch(function (err) {
                console.warn("[Identity] Server logout failed:", err.message);
              });
            },
          );
        },

        openMyWorlds: function openMyWorlds() {
          // TODO: open a worlds browser backed by lively.identity.userSpace.getHomeManifest()
          $world.inform("My worlds — coming soon");
        },

        update: function update() {
          var label = lively.identity.did.isLoggedIn()
            ? "@" + lively.identity.did.currentUser().handle
            : "Sign in";
          this.textString = label;
        },

        // Called when the morph is added to the world from a saved world file.
        onLoad: function onLoad() {
          var self = this;
          this.update();
          // DID.establishSession fires identityChanged — reconnect to it here
          // so the label updates without polling.
          lively.bindings.connect(
            lively.identity.did, "identityChanged",
            self, "update",
          );
        },

        onFromBuildSpecCreated: function onFromBuildSpecCreated() {
          this.onLoad();
        },
      }),
    );

  }); // end module('lively.identity.MenuBarEntry')
