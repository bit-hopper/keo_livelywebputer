module("lively.identity.VoiceControlPanel")
  .requires(
    "lively.identity.DID",
    "lively.identity.PostCardUtils",
    "lively.persistence.BuildSpec",
  )
  .toRun(function () {

    // NOTE: lively.BuildSpec methods (and anything installed via
    // Morph#addScript) get reconstructed from their own source text at
    // runtime (BuildSpec's evalJS path / addScript's Function.fromString),
    // which throws away the closure over this toRun(function(){...})
    // wrapper's own `var`s — confirmed empirically (a var referenced from
    // an addScript'd function throws "ReferenceError: ... is not defined"
    // even though the file loads fine). So every constant/helper those
    // methods need lives on the lively.identity.VoiceControlPanel namespace
    // object itself instead of a closure var — a dotted global path still
    // resolves fine after reconstruction, only closures are lost.
    Object.extend(lively.identity.VoiceControlPanel, {
      PANEL_W: 306,
      PANEL_H: 52,
      PANEL_BG:       Color.rgb(0x7A, 0x28, 0x59),
      TEXT_PRIMARY:   Color.rgb(242, 243, 245),
      TEXT_SECONDARY: Color.rgb(148, 155, 164),
      ICON_DEFAULT:   Color.rgb(181, 186, 193),
      ICON_DANGER:    Color.rgb(242, 63, 66),
      HOVER_BG:       Color.rgba(255, 255, 255, 0.08),
      STATUS_ONLINE:  Color.rgb(35, 165, 89),
      STATUS_IDLE:    Color.rgb(240, 178, 50),

      makeEllipse: function (rect, fill, borderWidth, borderColor) {
        var m = new lively.morphic.Morph();
        m.setShape(new lively.morphic.Shapes.Ellipse(rect));
        m.applyStyle({ fill: fill, borderWidth: borderWidth || 0,
          borderColor: borderColor || null });
        return m;
      },

      // Icon glyphs render through the vendored Material Symbols Rounded
      // font (core/styles/material-symbols.css, loaded once per world) by
      // setting a Text morph's content to the icon's ligature name — same
      // glyphs as the SVGs under core/media/material-icons/, just as inline
      // text so textColor drives the on/off (gray/red) recoloring instead
      // of image tinting.
      makeIconButton: function (rect, glyph, actionName) {
        var NS = lively.identity.VoiceControlPanel;
        var btn = new lively.morphic.Text(rect);
        btn.textString = glyph;
        btn.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          // fontSize renders as `${size}pt`, not px (core/lively/morphic/HTML.js
          // setFontSizeHTML) — 15pt = 20px, the actual target glyph size. Padding
          // below still uses the real 20px target since padding is genuine px.
          fontSize: 15,
          textColor: NS.ICON_DEFAULT,
          fill: null,
          borderRadius: rect.width / 2,
          borderWidth: 1,
          borderColor: NS.PANEL_BG,
          align: "center",
          padding: lively.Rectangle.inset(0, Math.round((rect.height - 20) / 2), 0, 0),
          allowInput: false,
          selectable: false,
          clipMode: "hidden",
          whiteSpaceHandling: "pre",
          handStyle: "pointer",
        });
        btn._actionName = actionName;
        btn.addScript(function onMouseOver() {
          this.applyStyle({ fill: lively.identity.VoiceControlPanel.HOVER_BG });
        });
        btn.addScript(function onMouseOut() {
          this.applyStyle({ fill: null });
        });
        btn.addScript(function onMouseUp(evt) {
          this.owner[this._actionName]();
          evt.stop();
          return true;
        });
        return btn;
      },
    });

    lively.BuildSpec("lively.identity.VoiceControlPanel", {
      isEpiMorph: true,
      className: "lively.morphic.Box",
      name: "VoiceControlPanel",
      draggingEnabled: false,
      droppingEnabled: false,
      grabbingEnabled: false,
      style: {
        extent: lively.pt(306, 52),
        fill: Color.rgb(0x7A, 0x28, 0x59),
        borderRadius: 12,
        borderWidth: 1,
        borderColor: Color.rgba(255, 255, 255, 0.06),
      },

      micMuted: false,
      deafened: false,

      alignInWorld: function alignInWorld() {
        var wBounds = $world.visibleBounds();
        this.setPosition(lively.pt(
          wBounds.right() - this.getExtent().x - 12,
          wBounds.bottom() - this.getExtent().y - 12,
        ));
      },

      onWorldResize: function onWorldResize() {
        lively.lang.fun.debounceNamed(this.id + "-vcp-world-resize", 100,
          this.alignInWorld.bind(this))();
      },

      _render: function _render() {
        var NS = lively.identity.VoiceControlPanel;
        this.removeAllMorphs();

        this._avatarMorph = new lively.morphic.Image(lively.rect(10, 10, 32, 32));
        this._avatarMorph.applyStyle({ borderRadius: 16, borderWidth: 0, clipMode: "hidden" });
        this.addMorph(this._avatarMorph);

        this._badgeBase = NS.makeEllipse(lively.rect(30, 30, 14, 14), NS.STATUS_ONLINE, 2, NS.PANEL_BG);
        this.addMorph(this._badgeBase);
        this._badgeBite = NS.makeEllipse(lively.rect(27, 27, 9, 9), NS.PANEL_BG, 0, null);
        this._badgeBite.setVisible(false);
        this.addMorph(this._badgeBite);

        // fontSize is in pt, not px (see makeIconButton's comment) — 9pt/8.25pt
        // render at the actual-target 12px/11px, with box heights generous
        // enough (18/16) that clipMode:hidden has real margin to spare.
        this._nameMorph = new lively.morphic.Text(lively.rect(50, 8, 140, 18));
        this._nameMorph.applyStyle({ fontSize: 9, fontWeight: "bold",
          textColor: NS.TEXT_PRIMARY, fill: null, borderWidth: 0, allowInput: false,
          selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre" });
        this.addMorph(this._nameMorph);

        this._statusMorph = new lively.morphic.Text(lively.rect(50, 27, 140, 16));
        this._statusMorph.applyStyle({ fontSize: 8.25, textColor: NS.TEXT_SECONDARY,
          fill: null, borderWidth: 0, allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre" });
        this.addMorph(this._statusMorph);

        this._micBtn = NS.makeIconButton(lively.rect(200, 12, 28, 28), "mic", "toggleMic");
        this.addMorph(this._micBtn);

        this._headsetBtn = NS.makeIconButton(lively.rect(234, 12, 28, 28), "headset_mic", "toggleDeafen");
        this.addMorph(this._headsetBtn);

        this._gearBtn = NS.makeIconButton(lively.rect(268, 12, 28, 28), "settings", "openSettings");
        this.addMorph(this._gearBtn);
      },

      toggleMic: function toggleMic() {
        if (this.deafened) {
          this.deafened = false;
          this.micMuted = false;
        } else {
          this.micMuted = !this.micMuted;
        }
        this._updateControls();
      },

      toggleDeafen: function toggleDeafen() {
        this.deafened = !this.deafened;
        this.micMuted = this.deafened;
        this._updateControls();
      },

      _updateControls: function _updateControls() {
        var NS = lively.identity.VoiceControlPanel;
        this._micBtn.textString = this.micMuted ? "mic_off" : "mic";
        this._micBtn.applyStyle({ textColor: this.micMuted ? NS.ICON_DANGER : NS.ICON_DEFAULT });
        this._headsetBtn.textString = this.deafened ? "headset_off" : "headset_mic";
        this._headsetBtn.applyStyle({ textColor: this.deafened ? NS.ICON_DANGER : NS.ICON_DEFAULT });
      },

      openSettings: function openSettings() {
        var box = new lively.morphic.Box(lively.rect(0, 0, 400, 300));
        box.openInWindow({
          title: "Settings",
          pos: lively.morphic.World.current().visibleBounds().center(),
        });
      },

      _updateStatus: function _updateStatus() {
        var NS = lively.identity.VoiceControlPanel;
        var idle = typeof document !== "undefined" && document.hidden;
        this._statusMorph.textString = idle ? "Idle" : "Online";
        this._badgeBase.applyStyle({ fill: idle ? NS.STATUS_IDLE : NS.STATUS_ONLINE });
        this._badgeBite.setVisible(!!idle);
      },

      update: function update() {
        if (!lively.identity.did || !lively.identity.did.isLoggedIn()) return;
        var handle = lively.identity.did.currentUser().handle;
        this._nameMorph.textString = "@" + handle;
        this._updateControls();
        this._updateStatus();

        if (this._avatarHandle !== handle) {
          this._avatarHandle = handle;
          this._avatarMorph.setImageURL(
            lively.identity.postCardUtils.identiconDataUrl(handle, 32));
          var self = this;
          fetch("/@" + handle + "/profile", { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (env) {
              if (!env || self._avatarHandle !== handle) return;
              var payload = (env.record && env.record.payload) || {};
              if (payload.avatarUrl) self._avatarMorph.setImageURL(payload.avatarUrl);
            })
            .catch(function () {});
        }
      },

      onLoad: function onLoad() {
        this._render();
        this._visibilityHandler = this._updateStatus.bind(this);
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", this._visibilityHandler);
        }
        this.update();
      },

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this.onLoad();
      },
    });

    // Plain vanilla JS object extension (not a BuildSpec/addScript path),
    // so normal closures over `self` etc. are safe here.
    Object.extend(lively.identity.VoiceControlPanel, {
      _panel: null,

      init: function init() {
        var self = this;
        function connectAndSync() {
          self.sync();
          lively.bindings.connect(lively.identity.did, "identityChanged", self, "sync");
        }
        if (lively.identity && lively.identity.did) connectAndSync();
        else lively.require("lively.identity.DID").toRun(connectAndSync);
      },

      sync: function sync() {
        var loggedIn = lively.identity.did && lively.identity.did.isLoggedIn();
        if (loggedIn) this.open(); else this.close();
      },

      open: function open() {
        if (this._panel && this._panel.world()) {
          this._panel.update();
          return this._panel;
        }
        var p = lively.BuildSpec("lively.identity.VoiceControlPanel").createMorph();
        p.openInWorld();
        p.enableFixedPositioning();
        p.alignInWorld();
        this._panel = p;
        return p;
      },

      close: function close() {
        if (!this._panel) return;
        if (this._panel._visibilityHandler && typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", this._panel._visibilityHandler);
        }
        this._panel.remove();
        this._panel = null;
      },
    });

  }); // end module('lively.identity.VoiceControlPanel')
