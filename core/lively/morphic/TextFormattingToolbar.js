module("lively.morphic.TextFormattingToolbar")
  .requires(
    "lively.morphic.TextCore",
    "lively.persistence.BuildSpec",
  )
  .toRun(function () {

    // NOTE: lively.BuildSpec methods (and anything installed via
    // Morph#addScript) get reconstructed from their own source text at
    // runtime (BuildSpec's evalJS path / addScript's Function.fromString),
    // which throws away the closure over this toRun(function(){...})
    // wrapper's own `var`s (see CLAUDE.md's "lively.BuildSpec / Morph#addScript
    // methods lose their closure" section, confirmed twice already in this
    // codebase). So every constant/helper those methods need lives on the
    // lively.morphic.TextFormattingToolbar namespace object itself instead
    // of a closure var. This toolbar is a runtime-only ephemeral HUD
    // (isEpiMorph, one shared instance, never itself saved into a world or
    // published to PartsBin) so BuildSpec is fine here -- unlike
    // lively.morphic.RichText, which IS meant to be saved/published and
    // therefore uses a real subclass instead (see RichText.js).
    Object.extend(lively.morphic.TextFormattingToolbar, {
      BAR_H: 34,
      BTN_SIZE: 26,
      GAP: 2,
      GROUP_GAP: 8,
      BAR_BG: Color.rgb(43, 45, 49),
      ICON_DEFAULT: Color.rgb(220, 222, 226),
      ICON_ACTIVE_BG: Color.rgb(90, 140, 240),
      HOVER_BG: Color.rgba(255, 255, 255, 0.12),
      SWATCH_COLORS: [
        Color.rgb(230, 230, 230), Color.rgb(235, 87, 87),
        Color.rgb(242, 153, 74), Color.rgb(45, 156, 219),
        Color.rgb(39, 174, 96), Color.rgb(155, 81, 224)
      ],

      // Icon glyphs render through the vendored Material Symbols Rounded
      // font (core/styles/material-symbols.css) -- same idiom as
      // AmbientPresencePanel.js. fontSize renders as `${size}pt`, not px
      // (core/lively/morphic/HTML.js setFontSizeHTML) -- 13.5pt ~= 18px.
      makeIconButton: function (x, glyph, actionName) {
        var NS = lively.morphic.TextFormattingToolbar;
        var size = NS.BTN_SIZE;
        var btn = new lively.morphic.Text(lively.rect(x, (NS.BAR_H - size) / 2, size, size));
        btn.textString = glyph;
        btn.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          fontSize: 13.5,
          textColor: NS.ICON_DEFAULT,
          fill: null,
          borderRadius: 5,
          borderWidth: 0,
          align: "center",
          padding: lively.Rectangle.inset(0, Math.round((size - 18) / 2), 0, 0),
          allowInput: false,
          selectable: false,
          clipMode: "hidden",
          whiteSpaceHandling: "pre",
          handStyle: "pointer",
        });
        btn._actionName = actionName;
        btn.draggingEnabled = false;
        btn.droppingEnabled = false;
        btn.grabbingEnabled = false;
        btn.addScript(function onMouseOver() {
          if (!this._active) this.applyStyle({ fill: lively.morphic.TextFormattingToolbar.HOVER_BG });
        });
        btn.addScript(function onMouseOut() {
          if (!this._active) this.applyStyle({ fill: null });
        });
        // preventDefault-equivalent on mousedown: keeps the target Text
        // morph's native focus from being stolen away by clicking the
        // button, so the toolbar doesn't hide itself before onMouseUp runs.
        // (Flagged in TextMarkupEditorSpec.md as needing live verification --
        // untested until driven with real events in a browser.)
        btn.addScript(function onMouseDown(evt) {
          this.owner._interacting = true;
          evt.stop();
            return true;
        });
        btn.addScript(function onMouseUp(evt) {
          this.owner[this._actionName]();
          this.owner._interacting = false;
          this.owner.refreshToggleState();
          evt.stop();
          return true;
        });
        return btn;
      },

      makeSwatchButton: function (x, color, actionName) {
        var NS = lively.morphic.TextFormattingToolbar;
        var size = NS.BTN_SIZE;
        var btn = new lively.morphic.Morph();
        btn.setShape(new lively.morphic.Shapes.Ellipse(
          lively.rect(x + 5, (NS.BAR_H - (size - 10)) / 2, size - 10, size - 10)));
        btn.applyStyle({ fill: color, borderWidth: 1, borderColor: Color.rgba(255,255,255,0.3) });
        btn._actionName = actionName;
        btn._swatchColor = color;
        btn.draggingEnabled = false;
        btn.droppingEnabled = false;
        btn.grabbingEnabled = false;
        btn.addScript(function onMouseUp(evt) {
          this.owner[this._actionName](this._swatchColor);
          this.owner._interacting = false;
          evt.stop();
          return true;
        });
        btn.addScript(function onMouseDown(evt) {
          this.owner._interacting = true;
          evt.stop();
          return true;
        });
        return btn;
      },

      // -- shared-instance lifecycle -----------------------------------
      sharedInstance: null,
      _hideTimer: null,

      showFor: function (targetMorph) {
        var NS = lively.morphic.TextFormattingToolbar;
        if (NS._hideTimer) { clearTimeout(NS._hideTimer); NS._hideTimer = null; }
        var inst = NS.sharedInstance;
        if (!inst || !inst.world()) {
          inst = NS.sharedInstance = lively.BuildSpec("lively.morphic.TextFormattingToolbar").createMorph();
          (targetMorph.world() || $world).addMorph(inst);
          inst.installNativeMousedownGuards();
        }
        inst._target = targetMorph;
        inst.positionAboveTarget(targetMorph);
        inst.refreshToggleState();
        inst.setVisible(true);
        inst.bringToFront();
      },

      hideForSoon: function (targetMorph) {
        var NS = lively.morphic.TextFormattingToolbar;
        NS._hideTimer = setTimeout(function () {
          var inst = NS.sharedInstance;
          if (inst && inst._target === targetMorph && !inst._interacting) {
            inst.setVisible(false);
          }
        }, 200);
      },
    });

    lively.BuildSpec("lively.morphic.TextFormattingToolbar", {
      isEpiMorph: true,
      className: "lively.morphic.Box",
      name: "TextFormattingToolbar",
      draggingEnabled: false,
      droppingEnabled: false,
      grabbingEnabled: false,
      style: {
        fill: undefined, // set in _render once width is known
        borderRadius: 8,
        borderWidth: 0,
      },

      _target: null,
      _interacting: false,

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this._render();
        this.setVisible(false);
        // Poll-based selection-state refresh (TextMarkupEditorSpec.md
        // section 1.3 -- there is no selectionRange signal to hook yet, so
        // this is the "start with a poll" option from that section, using
        // Lively's own step-loop idiom rather than a raw setInterval; the
        // same mechanism TextCore.js itself uses for logTextForSharing).
        // Without this, refreshToggleState() only ran right after showFor()
        // and after each button's own click, so moving the caret without
        // clicking a button left the toggle-highlight stale.
        this.startStepping(300, "refreshToggleState");
      },

      // Lively's own evt.stop() (called from each button's addScript'd
      // onMouseDown) only reaches Lively's morphic dispatch -- confirmed
      // live that it does NOT stop the browser's native mousedown from
      // moving focus/collapsing the target Text morph's selection first,
      // same underlying class of issue as CLAUDE.md's "eventsAreIgnored
      // does not stop native browser clicks" gotcha. Fix: a real capture-
      // phase native listener calling actual preventDefault() on each
      // button's own DOM node, installed once the toolbar (and therefore
      // its buttons) actually has a renderContext -- i.e. after the first
      // addMorph into a world, not at spec-definition time.
      installNativeMousedownGuards: function installNativeMousedownGuards() {
        this.submorphs.forEach(function (btn) {
          var node = btn.renderContext && btn.renderContext().shapeNode;
          if (node) node.addEventListener("mousedown", function (e) { e.preventDefault(); }, true);
        });
      },

      _render: function _render() {
        var NS = lively.morphic.TextFormattingToolbar;
        this.removeAllMorphs();
        var x = NS.GAP;

        this._boldBtn = NS.makeIconButton(x, "format_bold", "toggleBold"); this.addMorph(this._boldBtn); x += NS.BTN_SIZE + NS.GAP;
        this._italicBtn = NS.makeIconButton(x, "format_italic", "toggleItalic"); this.addMorph(this._italicBtn); x += NS.BTN_SIZE + NS.GAP;
        this._underlineBtn = NS.makeIconButton(x, "format_underlined", "toggleUnderline"); this.addMorph(this._underlineBtn); x += NS.BTN_SIZE + NS.GAP;
        this._linkBtn = NS.makeIconButton(x, "link", "toggleLink"); this.addMorph(this._linkBtn); x += NS.BTN_SIZE + NS.GROUP_GAP;

        this._swatchBtns = [];
        NS.SWATCH_COLORS.forEach(function (color) {
          var swatch = NS.makeSwatchButton(x, color, "pickTextColor");
          this.addMorph(swatch);
          this._swatchBtns.push(swatch);
          x += NS.BTN_SIZE;
        }, this);
        x += NS.GROUP_GAP - NS.BTN_SIZE + NS.GAP;

        this._alignLeftBtn = NS.makeIconButton(x, "format_align_left", "alignLeft"); this.addMorph(this._alignLeftBtn); x += NS.BTN_SIZE + NS.GAP;
        this._alignCenterBtn = NS.makeIconButton(x, "format_align_center", "alignCenter"); this.addMorph(this._alignCenterBtn); x += NS.BTN_SIZE + NS.GAP;
        this._alignRightBtn = NS.makeIconButton(x, "format_align_right", "alignRight"); this.addMorph(this._alignRightBtn); x += NS.BTN_SIZE + NS.GROUP_GAP;

        this._fontDecBtn = NS.makeIconButton(x, "text_decrease", "decreaseFontSize"); this.addMorph(this._fontDecBtn); x += NS.BTN_SIZE + NS.GAP;
        this._fontIncBtn = NS.makeIconButton(x, "text_increase", "increaseFontSize"); this.addMorph(this._fontIncBtn); x += NS.BTN_SIZE + NS.GAP;

        this.setExtent(lively.pt(x + NS.GAP, NS.BAR_H));
        this.applyStyle({ fill: NS.BAR_BG });
      },

      positionAboveTarget: function positionAboveTarget(targetMorph) {
        var topLeftWorld = targetMorph.worldPoint(lively.pt(0, 0));
        var extent = this.getExtent();
        var world = targetMorph.world() || $world;
        var visible = world.visibleBounds ? world.visibleBounds() : null;
        var y = topLeftWorld.y - extent.y - 8;
        if (visible && y < visible.top()) {
          // not enough room above -- show below the target instead
          var bottomLeftWorld = targetMorph.worldPoint(lively.pt(0, targetMorph.getExtent().y));
          y = bottomLeftWorld.y + 8;
        }
        this.setPosition(lively.pt(topLeftWorld.x, y));
      },

      // -- target-mutating actions (all delegate to lively.morphic.Text's
      // own existing rich-text API -- see TextCore.js. No new mutation
      // logic here, just wiring.) --------------------------------------
      toggleBold: function toggleBold() { this._target && this._target.toggleEmphasisForSelection("Boldness"); },
      toggleItalic: function toggleItalic() { this._target && this._target.toggleEmphasisForSelection("Italics"); },
      toggleUnderline: function toggleUnderline() { this._target && this._target.toggleEmphasisForSelection("Underline"); },
      toggleLink: function toggleLink() { this._target && this._target.toggleEmphasisForSelection("Link"); },
      pickTextColor: function pickTextColor(color) { this._target && this._target.emphasizeSelection({ color: color }); },
      alignLeft: function alignLeft() { this._target && this._target.applyStyle({ align: "left" }); },
      alignCenter: function alignCenter() { this._target && this._target.applyStyle({ align: "center" }); },
      alignRight: function alignRight() { this._target && this._target.applyStyle({ align: "right" }); },
      increaseFontSize: function increaseFontSize() { this._target && this._target.increaseFontSizeOfSelection(); },
      decreaseFontSize: function decreaseFontSize() { this._target && this._target.decreaseFontSizeOfSelection(); },

      // -- selection-state readback (poll-based per TextMarkupEditorSpec.md
      // section 1.3 -- there is no selectionRange signal to hook yet) ----
      refreshToggleState: function refreshToggleState() {
        var NS = lively.morphic.TextFormattingToolbar;
        if (!this._target || !this.isVisible()) return;
        var range = this._target.getSelectionRange && this._target.getSelectionRange();
        var emph = range && this._target.getEmphasisAt(range[0]);
        var setActive = function (btn, isActive) {
          btn._active = isActive;
          btn.applyStyle({ fill: isActive ? NS.ICON_ACTIVE_BG : null });
        };
        setActive(this._boldBtn, !!emph && emph.getFontWeight() === "bold");
        setActive(this._italicBtn, !!emph && emph.getItalics() === "italic");
        setActive(this._underlineBtn, !!emph && emph.getTextDecoration() === "underline");
        setActive(this._linkBtn, !!emph && !!emph.getURI());
      },
    });

  });
