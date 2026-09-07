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
    lively.morphic.Text.addMethods("rich text formatting toolbar", {
      onFocusAction: function onFocusAction() {
        if (!this.richTextToolbarEnabled) return;
        lively.morphic.TextFormattingToolbar.showFor(this);
      },
      onBlurAction: function onBlurAction() {
        if (!this.richTextToolbarEnabled) return;
        lively.morphic.TextFormattingToolbar.hideForSoon(this);
      },
      enableFormattingToolbar: function enableFormattingToolbar() {
        this.richTextToolbarEnabled = true;
        return this;
      },
      disableFormattingToolbar: function disableFormattingToolbar() {
        this.richTextToolbarEnabled = false;
        return this;
      },
    });

  });
