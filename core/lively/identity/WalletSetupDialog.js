/**
 * lively.identity.WalletSetupDialog
 *
 * WalletSpec.md §8.1/§8.2, §15 step 4. Mirrors RegisterDialog.js's own
 * BuildSpec Window shape and instantiation pattern
 * (lively.BuildSpec("...").createMorph().openInWorldCenter()). RegisterDialog
 * itself has no multi-step-screen precedent to copy (it's one flat form) —
 * this dialog's content area swaps between a few main-world-rendered
 * screens (choice, options, success, error) and the vault iframe itself
 * (positioned over the content area, never reparented — see
 * lively.identity.WalletBridge's showVaultFrame/hideVaultFrame for why).
 *
 * Flow: choice (create/import) -> options (word count for create, unlock
 * method + password) -> vault becomes visible over the content area and
 * WalletBridge.setup() fires; the vault's OWN UI (WalletVault.js) handles
 * mnemonic display + confirmation quiz (create) or the import textarea
 * (import) entirely inside itself — this dialog never sees the mnemonic,
 * only the final {address} result (§3.4: the mnemonic never crosses the
 * postMessage boundary, in any flow) -> success screen with the address.
 *
 * Dependencies:
 *   lively.identity.WalletBridge — setup, showVaultFrame, hideVaultFrame
 */

module("lively.identity.WalletSetupDialog")
  .requires(
    "lively.identity.WalletBridge",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.WalletSetupDialog", {
      _Extent: lively.pt(520, 560),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "WalletSetupDialog",
      titleBar: "Set up Wallet",
      submorphs: [
        {
          _Extent: lively.pt(514, 535),
          _Fill: Color.rgb(250, 250, 250),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: {
            adjustForNewBounds: true,
            resizeHeight: true,
            resizeWidth: true,
          },
          name: "setupContent",
          submorphs: [],
        },
      ],

      // ─── lifecycle ──────────────────────────────────────────────────────────

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this._wordCount = 12;
        this._kdf = "argon2id";
        this.buildChoiceScreen();
      },

      // ─── screen helpers ─────────────────────────────────────────────────────

      _clearContent: function _clearContent() {
        var content = this.get("setupContent");
        content.removeAllMorphs();
        return content;
      },

      _addHeading: function _addHeading(content, text, y) {
        var w = content.getExtent().x - 28;
        var heading = new lively.morphic.Text(lively.rect(14, y, w, 24), text);
        heading.applyStyle({ allowInput: false, fontSize: 16, fill: null });
        content.addMorph(heading);
        return y + 36;
      },

      _addText: function _addText(content, text, y, style) {
        var w = content.getExtent().x - 28;
        var t = new lively.morphic.Text(lively.rect(14, y, w, 40), text);
        t.applyStyle(Object.assign({ allowInput: false, fontSize: 12, fill: null }, style || {}));
        content.addMorph(t);
        return y + 44;
      },

      // ─── choice screen ──────────────────────────────────────────────────────

      buildChoiceScreen: function buildChoiceScreen() {
        var self = this;
        var content = this._clearContent();
        var y = this._addHeading(content, "Set up your wallet", 14);

        var createBtn = new lively.morphic.Button(lively.rect(14, y, 220, 28), "Create New Wallet");
        lively.bindings.connect(createBtn, "fire", self, "startCreate");
        content.addMorph(createBtn);
        y += 36;

        var importBtn = new lively.morphic.Button(lively.rect(14, y, 220, 28), "Import Existing Wallet");
        lively.bindings.connect(importBtn, "fire", self, "startImport");
        content.addMorph(importBtn);
        y += 44;

        var cancelBtn = new lively.morphic.Button(lively.rect(14, y, 80, 24), "Cancel");
        lively.bindings.connect(cancelBtn, "fire", self, "remove");
        content.addMorph(cancelBtn);
      },

      startCreate: function startCreate() { this.buildOptionsScreen("create"); },
      startImport: function startImport() { this.buildOptionsScreen("import"); },

      // ─── options screen (word count for create; unlock method + password) ──

      buildOptionsScreen: function buildOptionsScreen(mode) {
        var self = this;
        this._mode = mode;
        var content = this._clearContent();
        var y = this._addHeading(
          content,
          mode === "create" ? "Create New Wallet" : "Import Existing Wallet",
          14,
        );

        if (mode === "create") {
          y = this._addText(content, "Word count:", y - 20, { fontSize: 11 });
          var wc12 = new lively.morphic.Button(lively.rect(14, y, 60, 24), "12 words");
          var wc24 = new lively.morphic.Button(lively.rect(80, y, 60, 24), "24 words");
          this._wc12Btn = wc12;
          this._wc24Btn = wc24;
          lively.bindings.connect(wc12, "fire", self, "_selectWordCount12");
          lively.bindings.connect(wc24, "fire", self, "_selectWordCount24");
          this._paintWordCount();
          content.addMorph(wc12);
          content.addMorph(wc24);
          y += 36;
        }

        y = this._addText(content, "Unlock method:", y, { fontSize: 11 });
        y -= 24;
        var kdfWebAuthn = new lively.morphic.Button(lively.rect(14, y, 120, 24), "Passkey (WebAuthn)");
        var kdfPassword = new lively.morphic.Button(lively.rect(140, y, 120, 24), "Password");
        var passwordInput = new lively.morphic.Text(lively.rect(14, y + 32, 246, 22), "");
        passwordInput.applyStyle({
          allowInput: true, fontSize: 12, fill: Color.white,
          borderWidth: 1, borderColor: Color.rgb(190, 190, 190), borderRadius: 3,
          padding: lively.rect(4, 3, 0, 0),
        });
        passwordInput.beInputLine();

        this._kdfWebAuthnBtn = kdfWebAuthn;
        this._kdfPasswordBtn = kdfPassword;
        this._passwordInput = passwordInput;
        lively.bindings.connect(kdfWebAuthn, "fire", self, "_selectKdfWebAuthn");
        lively.bindings.connect(kdfPassword, "fire", self, "_selectKdfPassword");
        this._paintKdf();
        content.addMorph(kdfWebAuthn);
        content.addMorph(kdfPassword);
        content.addMorph(passwordInput);
        y += 64;

        var statusText = new lively.morphic.Text(lively.rect(14, y, content.getExtent().x - 28, 22), "");
        statusText.name = "statusText";
        statusText.applyStyle({ allowInput: false, fontSize: 11, fill: null, fontColor: Color.rgb(180, 40, 40) });
        content.addMorph(statusText);
        this._statusText = statusText;
        y += 30;

        var continueBtn = new lively.morphic.Button(lively.rect(14, y, 100, 24), "Continue");
        lively.bindings.connect(continueBtn, "fire", self, "_onOptionsContinue");
        content.addMorph(continueBtn);

        var backBtn = new lively.morphic.Button(lively.rect(122, y, 80, 24), "Back");
        lively.bindings.connect(backBtn, "fire", self, "buildChoiceScreen");
        content.addMorph(backBtn);
      },

      _paintWordCount: function _paintWordCount() {
        if (!this._wc12Btn) return;
        this._wc12Btn.applyStyle({ fill: this._wordCount === 12 ? Color.rgb(200, 220, 255) : Color.white });
        this._wc24Btn.applyStyle({ fill: this._wordCount === 24 ? Color.rgb(200, 220, 255) : Color.white });
      },
      _selectWordCount12: function _selectWordCount12() { this._wordCount = 12; this._paintWordCount(); },
      _selectWordCount24: function _selectWordCount24() { this._wordCount = 24; this._paintWordCount(); },

      _paintKdf: function _paintKdf() {
        if (!this._kdfWebAuthnBtn) return;
        this._kdfWebAuthnBtn.applyStyle({ fill: this._kdf === "webauthn-prf" ? Color.rgb(200, 220, 255) : Color.white });
        this._kdfPasswordBtn.applyStyle({ fill: this._kdf === "argon2id" ? Color.rgb(200, 220, 255) : Color.white });
        this._passwordInput.setVisible(this._kdf === "argon2id");
      },
      _selectKdfWebAuthn: function _selectKdfWebAuthn() { this._kdf = "webauthn-prf"; this._paintKdf(); },
      _selectKdfPassword: function _selectKdfPassword() { this._kdf = "argon2id"; this._paintKdf(); },

      _onOptionsContinue: function _onOptionsContinue() {
        if (this._kdf === "argon2id") {
          var pw = this._passwordInput ? this._passwordInput.textString : "";
          if (!pw) {
            if (this._statusText) this._statusText.setTextString("Enter a password, or choose Passkey instead.");
            return;
          }
          this._password = pw;
        }
        this.startVaultFlow();
      },

      // ─── vault-visible screen (§8.1/§8.2's actual secret-touching UI) ──────

      startVaultFlow: function startVaultFlow() {
        var self = this;
        var content = this._clearContent();
        this._addText(
          content,
          "Continue in the panel below…",
          14,
          { fontSize: 13 },
        );

        // The vault iframe is positioned over this dialog's own content
        // area (never reparented — see WalletBridge.showVaultFrame's own
        // header for why: reparenting an iframe reloads it in most
        // browsers, which would wipe WalletVault's in-memory _unlockedDek
        // mid-flow).
        var shapeNode = this.renderContext().shapeNode;
        var domRect = shapeNode.getBoundingClientRect();
        var contentOffset = this.contentOffset || lively.pt(3, 22);
        lively.identity.walletBridge.showVaultFrame({
          top: domRect.top + contentOffset.y,
          left: domRect.left + contentOffset.x,
          width: domRect.width - contentOffset.x * 2,
          height: domRect.height - contentOffset.y - contentOffset.x,
        });

        var options = {
          mode: this._mode,
          wordCount: this._wordCount,
          kdf: this._kdf,
          password: this._password,
        };
        lively.identity.walletBridge.setup(options, function (err, result) {
          lively.identity.walletBridge.hideVaultFrame();
          if (err) return self.buildErrorScreen(err);
          self.buildSuccessScreen(result.address);
        });
      },

      // ─── success / error screens ────────────────────────────────────────────

      buildSuccessScreen: function buildSuccessScreen(address) {
        var self = this;
        var content = this._clearContent();
        var y = this._addHeading(content, "Wallet created", 14);
        y = this._addText(content, "Address:\n" + address, y, { fontSize: 12 });

        var openBtn = new lively.morphic.Button(lively.rect(14, y, 100, 24), "Open Wallet");
        lively.bindings.connect(openBtn, "fire", self, "_onOpenWallet");
        content.addMorph(openBtn);
      },

      _onOpenWallet: function _onOpenWallet() {
        this.remove();
        lively.require("lively.identity.Wallet").toRun(function () {
          lively.identity.Wallet.open();
        });
      },

      buildErrorScreen: function buildErrorScreen(err) {
        var self = this;
        var content = this._clearContent();
        var y = this._addHeading(content, "Setup didn't complete", 14);
        y = this._addText(content, err && err.message ? err.message : String(err), y, { fontSize: 12, fontColor: Color.rgb(180, 40, 40) });

        var retryBtn = new lively.morphic.Button(lively.rect(14, y, 100, 24), "Try Again");
        lively.bindings.connect(retryBtn, "fire", self, "buildChoiceScreen");
        content.addMorph(retryBtn);

        var closeBtn = new lively.morphic.Button(lively.rect(122, y, 80, 24), "Close");
        lively.bindings.connect(closeBtn, "fire", self, "remove");
        content.addMorph(closeBtn);
      },
    });
  }); // end module('lively.identity.WalletSetupDialog')
