module("lively.identity.MenuBarEntry")
  .requires(
    "lively.identity.DID",
    "lively.identity.SignedSerializer",
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

    lively.BuildSpec(
      "lively.identity.MenuBarEntry",
      lively.BuildSpec("lively.morphic.tools.MenuBarEntry").customize({

        name: "IdentityMenuBarEntry",
        menuBarAlign: "right",
        textString: "Sign in",

        style: {
          extent: lively.pt(80, 22),
          toolTip: "Identity — sign in or manage your account",
        },

        morphMenuItems: function morphMenuItems() {
          var self = this;
          if (!lively.identity.did || !lively.identity.did.isLoggedIn()) {
            return [
              ["Sign in",         function () { self.openLoginDialog(); }],
              ["Create identity", function () { self.openRegisterDialog(); }],
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
          if (!lively.identity || !lively.identity.did) return;
          var label = lively.identity.did.isLoggedIn()
            ? "@" + lively.identity.did.currentUser().handle
            : "Sign in";
          this.textString = label;
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
