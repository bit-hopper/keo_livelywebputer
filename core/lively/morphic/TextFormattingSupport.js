module("lively.morphic.TextFormattingSupport")
  .requires(
    "lively.morphic.TextCore",
    "lively.morphic.TextFormattingToolbar",
  )
  .toRun(function () {

    // Wires the live formatting toolbar (lively.morphic.TextFormattingToolbar)
    // into lively.morphic.Text, replacing the Ctrl-L raw markup-spec editor
    // as the default way to format text. See TextMarkupEditorSpec.md at the
    // repo root for the full design and the reasoning below.
    //
    // Earlier version of this file introduced a real subclass,
    // lively.morphic.Text.subclass("lively.morphic.RichText", ...), for
    // scoping (only instances of the subclass show the toolbar, so input
    // lines/labels/button text elsewhere are unaffected) and persistence
    // safety (a real class keeps normal closures, unlike lively.BuildSpec,
    // matching the calendar app's Box.subclass-not-BuildSpec precedent for
    // inventory-published parts). That approach hit two problems, both
    // confirmed live rather than assumed:
    //
    // 1. NAME COLLISION: "lively.morphic.RichText" is already an unrelated
    //    internal class -- a plain value object (not a Morph) representing
    //    a chunk-based rich-text *string*, used by Text#getRichText() /
    //    #setRichText() (`new lively.morphic.RichText(str)`, TextCore.js
    //    ~2052). Defining a Text subclass under that same name silently
    //    clobbered it; `new lively.morphic.RichText(bounds)` then produced
    //    that broken value object instead of a Morph (no applyStyle,
    //    `instanceof Morph` false). Renaming to lively.morphic.FormattedText
    //    fixed this specific problem, but exposed the next one:
    //
    // 2. FRAMEWORK BUG WITH ANY lively.morphic.Text SUBCLASS: Text's own
    //    onFocus (TextCore.js "event handling" category) does
    //    `this.constructor.prototype.activeInstance = this`. For a plain
    //    Text instance this.constructor is lively.morphic.Text itself, so
    //    that's the same object the static reader
    //    `lively.morphic.Text.activeInstance()` (TextCore.js ~2678,
    //    `return this.prototype.activeInstance`) reads back from -- but for
    //    ANY subclass, this.constructor is the subclass, so onFocus writes
    //    to the *subclass's* prototype while activeInstance() always reads
    //    lively.morphic.Text's own prototype specifically. The two never
    //    meet. Confirmed live (blank.html, a throwaway FormattedText
    //    instance, driven with real clicks via chrome-devtools CLI): after
    //    a genuine focus + real double-click word selection (window
    //    .getSelection().toString() correctly returned "world"),
    //    Text#isFocused() (`lively.morphic.Text.activeInstance() === this`)
    //    still returned false, and Text#getSelectionRange() -- which bails
    //    out to `this.priorSelectionRange` whenever `!this.isFocused()`
    //    (TextCore.js:1685) -- returned undefined instead of the real
    //    selection. This isn't specific to our subclass; it would break
    //    identically for any lively.morphic.Text subclass that relies on
    //    isFocused()/getSelectionRange() (e.g. a future one), and plausibly
    //    already affects existing subclasses like
    //    lively.morphic.ColorChooserSwitcher (ColorChooserDraft.js) if they
    //    ever exercise this path -- not checked, flagging as a suspect
    //    rather than a confirmed second casualty.
    //
    //    The real fix belongs in TextCore.js's onFocus (write to
    //    lively.morphic.Text.prototype.activeInstance directly, not
    //    this.constructor.prototype), but that's a shared-framework change
    //    with system-wide blast radius and deserves its own deliberate
    //    change/review, not a drive-by inside this feature. Documented here
    //    and in TextMarkupEditorSpec.md as a known pre-existing bug to fix
    //    separately.
    //
    // SIDESTEP CHOSEN INSTEAD: no subclass at all. Add onFocusAction /
    // onBlurAction to lively.morphic.Text itself (the existing extension
    // points TextCore.js's registerForFocusAndBlurEvents already calls
    // unconditionally: "self.onFocusAction && self.onFocusAction()"), but
    // gate the toolbar behind a plain per-instance boolean flag,
    // richTextToolbarEnabled. This keeps the identical scoping guarantee a
    // subclass was meant to provide -- input lines/labels/button text never
    // set the flag, so they're never affected -- without creating a new
    // class at all, so `this.constructor` stays lively.morphic.Text for
    // every instance and the activeInstance bug above never triggers.
    // Persistence safety is unaffected: a boolean instance property
    // serializes fine (unlike a closure), same as any other Text style flag.
    // Replaces the browser's native focus ring (a black `outline: auto` that
    // Main.js puts on every `.visibleSelection:focus`) with a pink glow, for
    // rich text morphs only. Done as a scoped CSS class rather than a JS style
    // write on the inner editable node, which is rebuilt on re-render.
    var GLOW_CLASS = "rich-text-glow";
    function ensureGlowCss() {
      var STYLE_ID = "rich-text-glow-style";
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        ".Text." + GLOW_CLASS + " .visibleSelection:focus {",
        "  outline: none;",
        "  border-radius: 7px;",
        "  box-shadow: 0 0 0 1px rgba(255,64,160,0.9), 0 0 10px 3px rgba(255,64,160,0.55);",
        "}"
      ].join("\n");
      document.head.appendChild(styleEl);
    }

    // A text whose height should hug its content (fixedHeight false) only
    // re-fits on key-up and when added to the world. Pasting, cutting, undo,
    // and every toolbar format change (font size, family, ...) rewrite the
    // content without either, leaving the box taller or shorter than its
    // text. Watch the content and re-fit, debounced. Mutations of the text
    // node's own attributes are ignored: those are fit()'s own writes
    // (setTextNodeToFitMorphExtent), and reacting to them would loop. The
    // observer lives on the DOM node, not the morph, so it is never
    // serialized and a re-rendered node simply gets a fresh one.
    function watchContentSize(text) {
      var node = text.renderContext() && text.renderContext().textNode;
      if (!node || node._richTextFitObserver || typeof MutationObserver === "undefined") return;
      var pending = null;
      var observer = new MutationObserver(function (records) {
        if (!records.some(function (r) { return r.target !== node; })) return;
        if (pending) return;
        pending = setTimeout(function () {
          pending = null;
          if (text.world()) text.fit();
        }, 40);
      });
      observer.observe(node, {
        childList: true, characterData: true, subtree: true,
        attributes: true, attributeFilter: ["style", "class"]
      });
      node._richTextFitObserver = observer;
    }

    // setExtent and fit are overridden below, but they are Text's own
    // methods: inside addMethods, $super means the SUPERCLASS's method
    // (Morph's), which has no fit() at all and would skip Text's own
    // setExtent. So call the originals directly. Kept on the prototype so a
    // module reload doesn't capture (and then recurse into) its own override.
    var TextProto = lively.morphic.Text.prototype;
    if (!TextProto._richTextOriginals) {
      Object.defineProperty(TextProto, "_richTextOriginals", {
        value: { setExtent: TextProto.setExtent, fit: TextProto.fit },
        enumerable: false
      });
    }
    var ORIGINAL = TextProto._richTextOriginals;

    lively.morphic.Text.addMethods("rich text formatting toolbar", {
      // Resizing (e.g. dragging a halo handle) reflows the text but never
      // re-fit the height, so widening a box left it as tall as it was when
      // the text was still wrapped into more lines.
      setExtent: function setExtent(value) {
        var result = ORIGINAL.setExtent.call(this, value);
        if (this.richTextToolbarEnabled && this.fixedWidth && !this.fixedHeight) this.fit();
        return result;
      },
      // fit() measures through getTextExtent(), which clears the text node's
      // max-width and only puts it back for white-space "pre" (HTML.js). A
      // fixed-width text is left uncapped, so its lines run out to the box's
      // right edge, past the right padding. Put the cap back after measuring.
      // The measurement was taken WITHOUT the cap, so it can count fewer
      // lines than the capped text really wraps into: read the real rendered
      // height back and correct the box. The busy flag (on the DOM node, so
      // it isn't serialized) keeps fit, the setExtent hook above and this
      // correction from re-triggering each other.
      // The correction only runs once the text node is attached to the page.
      // While a saved world is being rendered, setExtent runs from initHTML
      // with the morph already in the world but its node not yet in the DOM,
      // where offsetHeight reads 0: the box would be set to border + padding
      // alone (12px) and the text would hang out below it.
      fit: function fit() {
        if (!this.richTextToolbarEnabled || !this.fixedWidth) return ORIGINAL.fit.call(this);
        var node = this.renderContext() && this.renderContext().textNode;
        if (node && node._richTextFitBusy) return;
        if (node) node._richTextFitBusy = true;
        try {
          var result = ORIGINAL.fit.call(this);
          this.setTextNodeToFitMorphExtent();
          if (node && node.isConnected && this.world() && !this.fixedHeight) {
            var padding = this.getPadding(),
                want = node.offsetHeight + this.getBorderWidth() * 2 + padding.top() + padding.bottom(),
                extent = this.getExtent();
            if (Math.abs(extent.y - want) > 1) ORIGINAL.setExtent.call(this, lively.pt(extent.x, want));
          }
          return result;
        } finally {
          if (node) node._richTextFitBusy = false;
        }
      },
      onFocusAction: function onFocusAction() {
        if (!this.richTextToolbarEnabled) return;
        // also here, not just in enableFormattingToolbar: a morph restored
        // from a saved world has the flag but never had that method called
        ensureGlowCss();
        this.addStyleClassName(GLOW_CLASS);
        watchContentSize(this);
        lively.morphic.TextFormattingToolbar.showFor(this);
      },
      onBlurAction: function onBlurAction() {
        if (!this.richTextToolbarEnabled) return;
        lively.morphic.TextFormattingToolbar.hideForSoon(this);
      },
      enableFormattingToolbar: function enableFormattingToolbar() {
        this.richTextToolbarEnabled = true;
        ensureGlowCss();
        this.addStyleClassName(GLOW_CLASS);
        watchContentSize(this);
        return this;
      },
      disableFormattingToolbar: function disableFormattingToolbar() {
        this.richTextToolbarEnabled = false;
        return this;
      },
    });

  });
