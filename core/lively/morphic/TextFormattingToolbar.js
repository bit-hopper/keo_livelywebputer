module("lively.morphic.TextFormattingToolbar")
  .requires(
    "lively.morphic.TextCore",
    "lively.morphic.ColorChooserDraft",
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
      BAR_BG: Color.rgb(153, 83, 143), // #99538F
      ICON_DEFAULT: Color.rgb(220, 222, 226),
      ICON_ACTIVE_BG: Color.rgb(90, 140, 240),
      HOVER_BG: Color.rgba(255, 255, 255, 0.12),
      // 12 presets in a compact popup grid (replaces the old always-visible
      // 6-swatch strip, which ate toolbar width for no benefit over a
      // popup -- feedback from playtesting: the swatches applied instantly
      // (good) but cost too much bar space; the full AwesomeColorPicker is
      // richer but visibly slower to open (it builds ~1000 individual tile
      // morphs for its saturation/brightness field every time). This grid
      // is built once and cached, same idiom as getFontList/_fontMenu, so
      // opening it is instant; the picker stays reachable via a "More
      // colors..." row for when a preset isn't enough.
      QUICK_COLORS: [
        Color.rgb(0, 0, 0), Color.rgb(80, 80, 80), Color.rgb(230, 230, 230), Color.rgb(255, 255, 255),
        Color.rgb(235, 87, 87), Color.rgb(242, 153, 74), Color.rgb(242, 201, 76), Color.rgb(111, 207, 151),
        Color.rgb(39, 174, 96), Color.rgb(45, 156, 219), Color.rgb(155, 81, 224), Color.rgb(216, 90, 167)
      ],
      QUICK_COLOR_COLS: 6,
      QUICK_SWATCH_SIZE: 20,
      QUICK_SWATCH_GAP: 6,
      QUICK_MENU_PAD: 8,
      QUICK_MENU_MORE_H: 20,
      FONT_MENU_W: 180,
      FONT_MENU_ITEM_H: 22,
      FONT_MENU_MAX_VISIBLE: 8,

      // Vendored decorative Google Fonts (core/lib/google-fonts/, loaded via
      // core/styles/google-fonts.css) -- also listed in TextCore.js's
      // getKnownFonts(). Kept here too because browsers lazy-load
      // @font-face resources: nothing fetches the actual font file until
      // something on the page tries to render with that family, and
      // availableFonts()'s width-comparison check is synchronous. Confirmed
      // live: the very first call to availableFonts() after a fresh page
      // load measured ALL 43 of these as "unavailable" (0% hit rate) purely
      // because none of their downloads had been triggered yet, not because
      // anything was actually missing -- a second call moments later (after
      // that first call's own measurements had incidentally triggered the
      // downloads in the background) found 42/43. This list exists so
      // warmVendoredFonts() (below) can explicitly request each one via the
      // CSS Font Loading API and await real completion before the
      // availability check ever runs, rather than depending on incidental
      // prior triggers or racing an in-flight download.
      VENDORED_FONT_NAMES: [
        'Alex Brush', 'Bitcount Ink', 'Bitcount Prop Double Ink', 'Bitcount Single Ink',
        'Cedarville Cursive', 'Coiny', 'Creepster', 'Eater', 'Emilys Candy', 'Foldit',
        'Freckle Face', 'Gloria Hallelujah', 'Gluten', 'Gochi Hand', 'Grandstander',
        'Gravitas One', 'IBM Plex Serif', 'Indie Flower', 'Jolly Lodger',
        'Just Me Again Down Here', 'Kablammo', 'Kalnia Glaze', 'Loved by the King',
        'Manufacturing Consent', 'Matemasie', 'Mea Culpa', 'Menbere', 'Miltonian',
        'Mystery Quest', 'Offside', 'Patrick Hand', 'Rancho', 'Reem Kufi Fun',
        'Rubik Beastly', 'Rubik Burned', 'Rubik Distressed', 'Rubik Gemstones',
        'Rubik Maps', 'Rubik Puddles', 'Shadows Into Light Two', 'Yarndings 20',
        'Yuyu', 'Yuyu Short'
      ],

      // Returns a Promise (resolves once every vendored font has either
      // loaded or failed) -- awaited by showFontMenu before the first
      // getFontList() call. A no-op after the first successful run, and
      // safe to call even where the CSS Font Loading API is unavailable.
      warmVendoredFonts: function () {
        var NS = lively.morphic.TextFormattingToolbar;
        if (NS._fontsWarmed) return Promise.resolve();
        if (!document.fonts || !document.fonts.load) { NS._fontsWarmed = true; return Promise.resolve(); }
        var loads = NS.VENDORED_FONT_NAMES.map(function (name) {
          return document.fonts.load('16px "' + name + '"').catch(function () {});
        });
        return Promise.all(loads).then(function () { NS._fontsWarmed = true; });
      },

      // TextCore.js's lively.morphic.Text.Fonts.availableFonts() actually
      // measures each candidate name's rendered glyph width against the
      // browser's own default, so this returns only fonts genuinely
      // available on this deployment -- not a guessed "web-safe" list
      // (TextMarkupEditorSpec.md section 3, "verify against what's
      // actually available"). Cached because the measurement re-appends a
      // throwaway <span> to document.body per call. Callers must await
      // warmVendoredFonts() first (see showFontMenu) or this cache can
      // permanently exclude vendored fonts whose download hadn't finished
      // yet on the first call.
      getFontList: function () {
        var NS = lively.morphic.TextFormattingToolbar;
        if (!NS._fontListCache) {
          NS._fontListCache = lively.morphic.Text.Fonts.availableFonts(
            lively.morphic.Text.Fonts.getKnownFonts());
        }
        return NS._fontListCache;
      },

      // Same native-mousedown-stealing-focus fix as
      // installNativeMousedownGuards below, factored out so morphs created
      // lazily after the toolbar is already in the world (the font-menu
      // items) can be guarded individually at creation time.
      guardMousedown: function (morph) {
        var node = morph.renderContext && morph.renderContext().shapeNode;
        if (node) node.addEventListener("mousedown", function (e) { e.preventDefault(); }, true);
      },

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

      // Used only inside the quick-color popup grid (_buildQuickColorMenu
      // below) -- owner there is the popup Box, not the toolbar itself, so
      // (unlike makeIconButton's buttons, which use this.owner) the
      // toolbar and callback are stored directly on the item and read back
      // via this._toolbar/this._callbackName.
      makeQuickColorSwatch: function (x, y, size, color, toolbar, callbackName) {
        var btn = new lively.morphic.Morph();
        btn.setShape(new lively.morphic.Shapes.Ellipse(lively.rect(x, y, size, size)));
        btn.applyStyle({ fill: color, borderWidth: 1, borderColor: Color.rgba(255, 255, 255, 0.3) });
        btn._color = color;
        btn._toolbar = toolbar;
        btn._callbackName = callbackName;
        btn.draggingEnabled = false;
        btn.droppingEnabled = false;
        btn.grabbingEnabled = false;
        btn.addScript(function onMouseDown(evt) { this._toolbar._interacting = true; evt.stop(); return true; });
        btn.addScript(function onMouseUp(evt) {
          this._toolbar[this._callbackName](this._color);
          this._toolbar._interacting = false;
          this._toolbar.hideQuickColorMenus();
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
        inst.hideFontMenu();
        inst.hideQuickColorMenus();
        inst.setVisible(true);
        inst.bringToFront();
      },

      hideForSoon: function (targetMorph) {
        var NS = lively.morphic.TextFormattingToolbar;
        NS._hideTimer = setTimeout(function () {
          var inst = NS.sharedInstance;
          if (inst && inst._target === targetMorph && !inst._interacting && !inst._colorPickerOpen) {
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

        this._textColorPickerBtn = NS.makeIconButton(x, "palette", "toggleTextColorMenu"); this.addMorph(this._textColorPickerBtn); x += NS.BTN_SIZE + NS.GAP;
        this._bgColorPickerBtn = NS.makeIconButton(x, "format_color_fill", "toggleBackgroundColorMenu"); this.addMorph(this._bgColorPickerBtn); x += NS.BTN_SIZE + NS.GROUP_GAP;

        this._fontBtn = NS.makeIconButton(x, "font_download", "toggleFontMenu"); this.addMorph(this._fontBtn); x += NS.BTN_SIZE + NS.GROUP_GAP;

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
      pickBackgroundColor: function pickBackgroundColor(color) { this._target && this._target.emphasizeSelection({ backgroundColor: color }); },

      // -- fast quick-color popups (playtest feedback, 2026-09-07: the old
      // always-visible 6-swatch strip took too much bar width; the full
      // AwesomeColorPicker below is noticeably slower to open since it
      // builds ~1000 tile morphs each time. This is the fast common case --
      // built once, cached, instant to open and apply -- with "More
      // colors..." as the deliberate escape hatch to the rich picker. --
      toggleTextColorMenu: function toggleTextColorMenu() { this._toggleQuickColorMenu("text"); },
      toggleBackgroundColorMenu: function toggleBackgroundColorMenu() { this._toggleQuickColorMenu("background"); },

      _toggleQuickColorMenu: function _toggleQuickColorMenu(kind) {
        var menuProp = kind === "text" ? "_textColorMenu" : "_bgColorMenu";
        if (this[menuProp] && this[menuProp].isVisible()) { this.hideQuickColorMenus(); return; }
        this.hideQuickColorMenus();
        this._showQuickColorMenu(kind);
      },

      _showQuickColorMenu: function _showQuickColorMenu(kind) {
        var NS = lively.morphic.TextFormattingToolbar;
        var menuProp = kind === "text" ? "_textColorMenu" : "_bgColorMenu";
        var anchorBtn = kind === "text" ? this._textColorPickerBtn : this._bgColorPickerBtn;
        this.hideFontMenu();
        if (!this[menuProp]) this._buildQuickColorMenu(kind);
        this[menuProp].setPosition(lively.pt(anchorBtn.getPosition().x, NS.BAR_H + 4));
        this[menuProp].setVisible(true);
        this[menuProp].bringToFront();
      },

      hideQuickColorMenus: function hideQuickColorMenus() {
        if (this._textColorMenu) this._textColorMenu.setVisible(false);
        if (this._bgColorMenu) this._bgColorMenu.setVisible(false);
      },

      _buildQuickColorMenu: function _buildQuickColorMenu(kind) {
        var NS = lively.morphic.TextFormattingToolbar;
        var toolbar = this;
        var callbackName = kind === "text" ? "pickTextColor" : "pickBackgroundColor";
        var openFullPickerName = kind === "text" ? "openTextColorPicker" : "openBackgroundColorPicker";
        var cols = NS.QUICK_COLOR_COLS;
        var sw = NS.QUICK_SWATCH_SIZE, gap = NS.QUICK_SWATCH_GAP, pad = NS.QUICK_MENU_PAD;
        var rows = Math.ceil(NS.QUICK_COLORS.length / cols);
        var gridW = cols * sw + (cols - 1) * gap;
        var gridH = rows * sw + (rows - 1) * gap;
        var menu = new lively.morphic.Box(lively.rect(0, 0, gridW + pad * 2, gridH + pad * 2 + NS.QUICK_MENU_MORE_H + 4));
        menu.applyStyle({ fill: NS.BAR_BG, borderRadius: 6, borderWidth: 0 });
        menu.draggingEnabled = false;
        menu.droppingEnabled = false;
        menu.grabbingEnabled = false;

        NS.QUICK_COLORS.forEach(function (color, i) {
          var col = i % cols, row = Math.floor(i / cols);
          var swatch = NS.makeQuickColorSwatch(
            pad + col * (sw + gap), pad + row * (sw + gap), sw, color, toolbar, callbackName);
          menu.addMorph(swatch);
          NS.guardMousedown(swatch);
        });

        var moreBtn = new lively.morphic.Text(
          lively.rect(pad, pad + gridH + 6, gridW, NS.QUICK_MENU_MORE_H), "More colors…");
        moreBtn.applyStyle({
          fontSize: 9.5, textColor: NS.ICON_DEFAULT, fill: null, borderWidth: 0,
          allowInput: false, selectable: false, clipMode: "hidden",
          whiteSpaceHandling: "pre", handStyle: "pointer", align: "center",
          padding: lively.Rectangle.inset(0, 3, 0, 0),
        });
        moreBtn._toolbar = toolbar;
        moreBtn._openFullPickerName = openFullPickerName;
        moreBtn.draggingEnabled = false;
        moreBtn.droppingEnabled = false;
        moreBtn.grabbingEnabled = false;
        moreBtn.addScript(function onMouseOver() { this.applyStyle({ fill: lively.morphic.TextFormattingToolbar.HOVER_BG }); });
        moreBtn.addScript(function onMouseOut() { this.applyStyle({ fill: null }); });
        moreBtn.addScript(function onMouseDown(evt) { this._toolbar._interacting = true; evt.stop(); return true; });
        moreBtn.addScript(function onMouseUp(evt) {
          this._toolbar.hideQuickColorMenus();
          this._toolbar[this._openFullPickerName]();
          this._toolbar._interacting = false;
          evt.stop();
          return true;
        });
        menu.addMorph(moreBtn);
        NS.guardMousedown(moreBtn);

        menu.setVisible(false);
        this.addMorph(menu);
        this[kind === "text" ? "_textColorMenu" : "_bgColorMenu"] = menu;
      },

      // -- richer color pickers (TextMarkupEditorSpec.md section 7 item 2 --
      // reuses the existing lively.morphic.AwesomeColorPicker
      // (ColorChooserDraft.js) rather than a new custom picker, per that
      // section's own note. Reached only via a quick-color menu's "More
      // colors..." row now, not directly from the toolbar. --
      openTextColorPicker: function openTextColorPicker() { this._openColorPicker("pickTextColor"); },
      openBackgroundColorPicker: function openBackgroundColorPicker() { this._openColorPicker("pickBackgroundColor"); },

      _openColorPicker: function _openColorPicker(callbackName) {
        var NS = lively.morphic.TextFormattingToolbar;
        var toolbar = this;
        var picker = new lively.morphic.AwesomeColorPicker();
        var pos = this.worldPoint(lively.pt(0, NS.BAR_H + 4));
        picker.open($world, pos);
        // AwesomeColorPicker's hue/sat-brightness fields and its alpha
        // slider are plain morphic drag surfaces (Boxes with addScript'd
        // onMouseDown/onDrag), not native inputs -- guarding their native
        // mousedown the same way as every toolbar button (guardMousedown
        // above) stops the browser's default focus-shift from collapsing
        // the *target* Text morph's real selection while dragging them.
        // Deliberately NOT applied to picker.rgbValueField -- that one IS
        // a real native <input> (isInputLine) that needs genuine native
        // focus to accept typed hex values; guarding it would break typing
        // into it, the same class of mistake CLAUDE.md already warns about
        // (preventDefault at the wrong scope kills a wanted native focus).
        NS.guardMousedown(picker.hueField);
        NS.guardMousedown(picker.satBrtField);
        NS.guardMousedown(picker.alphaSlider);
        // Keep the toolbar itself from auto-hiding while this popup --
        // which lives outside the toolbar's own submorph tree, on $world,
        // so it isn't covered by the _interacting flag any button's own
        // onMouseUp already resets to false right after firing its action
        // (see makeIconButton above) -- is open. A separate flag avoids
        // that clobbering; hideForSoon checks it alongside _interacting.
        // Restored to false once the popup is dismissed (world's own
        // currentMenu click-away handling, Events.js removeOpenMenu, calls
        // this same remove()).
        toolbar._colorPickerOpen = true;
        var origRemove = picker.remove;
        picker.remove = function () {
          toolbar._colorPickerOpen = false;
          return origRemove.call(this);
        };
        lively.bindings.connect(picker, "color", toolbar, callbackName);
      },
      alignLeft: function alignLeft() { this._target && this._target.applyStyle({ align: "left" }); },
      alignCenter: function alignCenter() { this._target && this._target.applyStyle({ align: "center" }); },
      alignRight: function alignRight() { this._target && this._target.applyStyle({ align: "right" }); },
      increaseFontSize: function increaseFontSize() { this._target && this._target.increaseFontSizeOfSelection(); },
      decreaseFontSize: function decreaseFontSize() { this._target && this._target.decreaseFontSizeOfSelection(); },
      // TextEmphasis's fontFamily.apply() (TextCore.js) writes
      // node.style.fontFamily whenever hasOwnProperty("fontFamily") is
      // true, regardless of the value -- so emphasizeSelection({fontFamily:
      // undefined}) (the hover-preview revert case below, when the
      // selection had no font override to begin with) still creates that
      // own property and writes it, and a real CSSOM style property
      // assigned JS `undefined` coerces via ToString to the literal string
      // "undefined" -- confirmed live, node.style.fontFamily read back as
      // the actual string "undefined", a real (if harmless-looking)
      // font-family name applied to the DOM. `null` behaves differently:
      // CSSOM's LegacyNullToEmptyString coerces it to "" instead, and
      // assigning "" to a style property is a real property removal, so
      // the font cleanly falls back to the cascade instead of resolving to
      // a bogus family name. Normalize undefined -> null here so every
      // caller (button clicks, hover-preview revert) gets a real clear.
      pickFontFamily: function pickFontFamily(font) { this._target && this._target.emphasizeSelection({ fontFamily: font === undefined ? null : font }); },

      // -- font-family dropdown (TextMarkupEditorSpec.md section 7 item 3 --
      // no new mutation API, same emphasizeSelection() call as every other
      // button; the list itself comes from the existing
      // lively.morphic.Text.Fonts availability check, not a guessed list) --
      toggleFontMenu: function toggleFontMenu() {
        if (this._fontMenu && this._fontMenu.isVisible()) { this.hideFontMenu(); return; }
        this.showFontMenu();
      },

      showFontMenu: function showFontMenu() {
        var NS = lively.morphic.TextFormattingToolbar;
        var toolbar = this;
        this.hideQuickColorMenus();
        // Capture the current selection's font synchronously, before the
        // possible async gap below, so hover-preview (below) can revert to
        // it when the mouse leaves an item without a click -- Google-Docs-
        // style live preview, playtest feedback 2026-09-07.
        var range = this._target && this._target.getSelectionRange && this._target.getSelectionRange();
        var emph = range && this._target.getEmphasisAt(range[0]);
        this._fontMenuOriginalFamily = emph ? emph.getFontFamily() : undefined;
        // Reset each time the menu opens -- see the onMouseUp/onMouseOut
        // comment below for why this exists.
        this._fontMenuCommitted = false;

        if (this._fontMenu) {
          this._positionAndShowFontMenu();
          return;
        }
        // First open only: wait for the vendored Google Fonts to actually
        // finish loading before measuring availability / building the list
        // (see warmVendoredFonts/getFontList above) -- otherwise they race
        // their own @font-face download and get permanently cached as
        // "unavailable" (confirmed live, see VENDORED_FONT_NAMES comment).
        NS.warmVendoredFonts().then(function () {
          toolbar._buildFontMenu();
          toolbar._positionAndShowFontMenu();
        });
      },

      _positionAndShowFontMenu: function _positionAndShowFontMenu() {
        var NS = lively.morphic.TextFormattingToolbar;
        this._fontMenu.setPosition(lively.pt(this._fontBtn.getPosition().x, NS.BAR_H + 4));
        this._fontMenu.setVisible(true);
        this._fontMenu.bringToFront();
      },

      hideFontMenu: function hideFontMenu() {
        if (this._fontMenu) this._fontMenu.setVisible(false);
      },

      _buildFontMenu: function _buildFontMenu() {
        var NS = lively.morphic.TextFormattingToolbar;
        var toolbar = this;
        var fonts = NS.getFontList();
        var itemH = NS.FONT_MENU_ITEM_H;
        var visibleCount = Math.max(1, Math.min(fonts.length, NS.FONT_MENU_MAX_VISIBLE));
        var menu = new lively.morphic.Box(lively.rect(0, 0, NS.FONT_MENU_W, itemH * visibleCount));
        menu.applyStyle({ fill: NS.BAR_BG, borderRadius: 6, borderWidth: 0, clipMode: "auto" });
        menu.draggingEnabled = false;
        menu.droppingEnabled = false;
        menu.grabbingEnabled = false;
        fonts.forEach(function (font, i) {
          var item = new lively.morphic.Text(lively.rect(0, i * itemH, NS.FONT_MENU_W, itemH), font);
          item.applyStyle({
            fontFamily: font, fontSize: 10.5, textColor: NS.ICON_DEFAULT, fill: null,
            borderWidth: 0, padding: lively.Rectangle.inset(8, Math.round((itemH - 14) / 2), 0, 0),
            allowInput: false, selectable: false, clipMode: "hidden",
            whiteSpaceHandling: "pre", handStyle: "pointer",
          });
          item._font = font;
          item._toolbar = toolbar;
          item.draggingEnabled = false;
          item.droppingEnabled = false;
          item.grabbingEnabled = false;
          // Live document preview (Google-Docs style, playtest feedback
          // 2026-09-07): hovering a font name temporarily applies it to the
          // real selection via the same emphasizeSelection() every other
          // button uses -- no new mutation API -- and reverts to whatever
          // font the selection had when the menu opened (captured in
          // showFontMenu) if the mouse leaves without a click.
          //
          // Real bug found live (playtest feedback, "changing font doesn't
          // apply it"): clicking a font appeared to work for an instant and
          // then silently reverted. Root cause -- onMouseUp below applies
          // the font and then calls hideFontMenu(), which hides this very
          // item's DOM node out from under the still-hovering cursor; the
          // browser responds by firing a native mouseout on it (an element
          // that disappears while the mouse is over it gets a synthesized
          // leave event), which ran this onMouseOut's revert-to-original
          // logic *after* onMouseUp's commit had already applied the real
          // pick -- undoing it. Confirmed live: getEmphasisAt().getFontFamily()
          // read back the pre-menu original, not the clicked font, even
          // though the click's own onMouseUp had fired and closed the menu.
          // Fixed with _fontMenuCommitted (reset per menu-open in
          // showFontMenu): onMouseUp sets it before hiding the menu, and
          // onMouseOut's revert becomes a no-op once it's set, so a
          // same-tick "hide fired a mouseout" can't undo a real click.
          item.addScript(function onMouseOver() {
            this.applyStyle({ fill: lively.morphic.TextFormattingToolbar.HOVER_BG });
            if (this._toolbar._target) this._toolbar.pickFontFamily(this._font);
          });
          item.addScript(function onMouseOut() {
            this.applyStyle({ fill: null });
            if (this._toolbar._fontMenuCommitted) return;
            if (this._toolbar._target) this._toolbar.pickFontFamily(this._toolbar._fontMenuOriginalFamily);
          });
          item.addScript(function onMouseDown(evt) { this._toolbar._interacting = true; evt.stop(); return true; });
          item.addScript(function onMouseUp(evt) {
            this._toolbar._fontMenuCommitted = true;
            this._toolbar.pickFontFamily(this._font);
            this._toolbar._interacting = false;
            this._toolbar.hideFontMenu();
            evt.stop();
            return true;
          });
          menu.addMorph(item);
          // The toolbar itself is already in the world by the time a menu
          // is first opened (lazy-built on click), so each item already has
          // a renderContext right after addMorph -- unlike
          // installNativeMousedownGuards below, this doesn't need to wait
          // for a separate post-addMorph pass.
          NS.guardMousedown(item);
        }, this);
        menu.setVisible(false);
        this.addMorph(menu);
        this._fontMenu = menu;
      },

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
