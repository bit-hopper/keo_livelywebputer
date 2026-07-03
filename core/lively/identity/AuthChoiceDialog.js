/**
 * lively.identity.AuthChoiceDialog
 *
 * Floating choice panel opened from welcome.html's login doit.
 * Lets the user pick between signing in with an existing passkey
 * or creating a new identity.
 */

module("lively.identity.AuthChoiceDialog")
  .requires(
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.AuthChoiceDialog", {
      _Extent: lively.pt(320, 112),
      className: "lively.morphic.Box",
      draggingEnabled: true,
      name: "AuthChoiceDialog",
      submorphs: [],

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this.buildUI();
      },

      buildUI: function buildUI() {
        var self = this;
        this.removeAllMorphs();
        this.applyStyle({
          fill: Color.rgb(250, 250, 250),
          borderRadius: 6,
          borderWidth: 1,
          borderColor: Color.rgb(200, 200, 200),
        });

        var pad = 16;
        var w = this.getExtent().x;

        var label = new lively.morphic.Text(
          lively.rect(pad, pad, w - pad * 2, 20),
          "How would you like to continue?"
        );
        label.applyStyle({
          allowInput: false,
          fontSize: 13,
          textColor: Color.rgb(40, 40, 40),
          fill: null,
        });
        this.addMorph(label);

        var signInBtn = new lively.morphic.Button(
          lively.rect(pad, 50, 125, 28),
          "Sign in"
        );
        lively.bindings.connect(signInBtn, "fire", self, "openSignIn");
        this.addMorph(signInBtn);

        var newBtn = new lively.morphic.Button(
          lively.rect(pad + 133, 50, 154, 28),
          "Create new passkey"
        );
        lively.bindings.connect(newBtn, "fire", self, "openRegister");
        this.addMorph(newBtn);

        var cancelText = new lively.morphic.Text(
          lively.rect(pad, 88, 50, 14),
          "cancel"
        );
        cancelText.applyStyle({
          allowInput: false,
          fontSize: 11,
          textColor: Color.rgb(160, 160, 160),
          fill: null,
        });
        cancelText.onMouseDown = function () { self.remove(); };
        this.addMorph(cancelText);
      },

      openSignIn: function openSignIn() {
        this.remove();
        lively.require("lively.identity.LoginDialog").toRun(function () {
          lively.BuildSpec("lively.identity.LoginDialog").createMorph().openInWorldCenter();
        });
      },

      openRegister: function openRegister() {
        this.remove();
        lively.require("lively.identity.RegisterDialog").toRun(function () {
          lively.BuildSpec("lively.identity.RegisterDialog").createMorph().openInWorldCenter();
        });
      },
    });
  }); // end module('lively.identity.AuthChoiceDialog')
