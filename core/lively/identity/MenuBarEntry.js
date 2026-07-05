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
        textString: "sign in",

        style: lively.lang.obj.merge(
          lively.BuildSpec("lively.morphic.tools.MenuBarEntry").attributeStore.style,
          {
            extent: lively.pt(80, 22),
            toolTip: "Identity — sign in or manage your account",
          },
        ),

        morphMenuItems: function morphMenuItems() {
          var self = this;
          if (!lively.identity.did || !lively.identity.did.isLoggedIn()) {
            return [
              ["sign in",         function () { self.openLoginDialog(); }],
              ["Create identity", function () { self.openRegisterDialog(); }],
            ];
          }
          return [
            ["Add device",  function () { self.openRegisterDialog(); }],
            ["Sign out",    function () { self.signOut(); }],
            ["My worlds",   function () { self.openMyWorlds(); }],
            ["My profile",  function () { self.openMyProfile(); }],
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

        openMyProfile: function openMyProfile() {
          lively.require("lively.identity.ProfileCard").toRun(function () {
            lively.identity.ProfileCard.open();
          });
        },

        update: function update() {
          if (!lively.identity || !lively.identity.did) return;
          var label = lively.identity.did.isLoggedIn()
            ? "@" + lively.identity.did.currentUser().handle
            : "sign in";
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
