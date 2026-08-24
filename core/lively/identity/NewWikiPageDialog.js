/**
 * lively.identity.NewWikiPageDialog
 *
 * Small BuildSpec dialog collecting Title/Category/Tags for a new wiki
 * page, replacing the old window.prompt()-only flow (WikiIndex.js's and
 * ConstellationCanvas.js's own former _promptNewWikiPage). Styled after
 * lively.morphic.tools.PublishToInventoryDialog (same style tokens: border
 * radii, Color.rgb(...) values, padding, button styling) and opened the
 * same way (world-tracked singleton via lively.BuildSpec(...).createMorph()
 * + openInWorldCenter().comeForward()) — see NewWikiPageDialog.open below.
 *
 * The dialog itself never touches storage/embedding — it only collects and
 * validates { wikiName, title, category, tags } and hands them to the
 * caller's onCreate callback. Callers (WikiIndexController, Constellation-
 * CanvasController) decide what "create" means for their surface (inline
 * embed vs. a new canvas placement).
 *
 * scope (passed to .open, not otherwise used by this dialog) is either
 * { constellation: name } or { handle: handle } — purely informational for
 * callers; kept out of this file's own logic so the dialog stays
 * scope-agnostic.
 *
 * No dropdown/select morph exists anywhere else in this codebase — the
 * Category field is a minimal self-contained morphic dropdown local to
 * this file (trigger Box + a popup list of Text rows added to $world),
 * not a native <select> (this codebase's established strong preference is
 * full morphic construction, see CLAUDE.md's Material Symbols section).
 */

module('lively.identity.NewWikiPageDialog')
  .requires('lively.persistence.BuildSpec')
  .toRun(function () {

    var CATEGORIES = ['Biography', 'Place', 'Event', 'Concept', 'Organization', 'How-To'];

    lively.BuildSpec('lively.identity.NewWikiPageDialog', {
      _BorderRadius: 7,
      _Extent: lively.pt(380.0, 250.0),
      _Fill: Color.rgb(86, 150, 251),
      className: 'lively.morphic.Window',
      name: 'NewWikiPageDialog',
      sourceModule: 'lively.identity.NewWikiPageDialog',
      contentOffset: lively.pt(3.0, 22.0),
      draggingEnabled: true,
      layout: { adjustForNewBounds: true },
      minExtent: lively.pt(380.0, 250.0),
      submorphs: [{
        _BorderColor: Color.rgb(95, 94, 95),
        _BorderRadius: 4,
        _Extent: lively.pt(374.0, 222.0),
        _Fill: Color.rgb(243, 243, 243),
        _Position: lively.pt(3.0, 23.0),
        className: 'lively.morphic.Box',
        doNotCopyProperties: [],
        doNotSerialize: [],
        layout: { adjustForNewBounds: true, resizeWidth: true },
        name: 'NewWikiPageDialogPane',
        sourceModule: 'lively.morphic.Core',
        submorphs: [{
          _Extent: lively.pt(100.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 8.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'TitleLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Title',
        }, {
          _BorderColor: Color.rgb(203, 203, 203),
          _BorderRadius: 3.75,
          _BorderWidth: 1,
          _ClipMode: 'hidden',
          _Extent: lively.pt(354.0, 22.0),
          _Fill: Color.rgb(255, 255, 255),
          _FontFamily: 'Helvetica',
          _Padding: lively.rect(4, 4, 0, 0),
          _Position: lively.pt(10.0, 30.0),
          allowInput: true,
          className: 'lively.morphic.Text',
          doNotSerialize: ['charsTyped'],
          evalEnabled: false,
          fixedHeight: true,
          fixedWidth: true,
          isInputLine: true,
          layout: { resizeWidth: true },
          name: 'TitleText',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: '',
        }, {
          _Extent: lively.pt(150.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 64.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'CategoryLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Category',
        }, {
          _BorderColor: Color.rgb(203, 203, 203),
          _BorderRadius: 3.75,
          _BorderWidth: 1,
          _Extent: lively.pt(354.0, 22.0),
          _Fill: Color.rgb(255, 255, 255),
          _Position: lively.pt(10.0, 86.0),
          className: 'lively.morphic.Box',
          doNotCopyProperties: [],
          doNotSerialize: [],
          name: 'CategoryTrigger',
          sourceModule: 'lively.morphic.Core',
          submorphs: [{
            _Extent: lively.pt(320.0, 18.0),
            _Position: lively.pt(8.0, 2.0),
            _FontFamily: 'Helvetica',
            _FontSize: 12,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'CategoryValueLabel',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(150, 150, 150),
            textString: 'Select…',
          }, {
            _Extent: lively.pt(20.0, 18.0),
            _Position: lively.pt(328.0, 2.0),
            _FontFamily: "'Material Symbols Rounded'",
            _FontSize: 13,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'CategoryChevron',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(120, 120, 120),
            textString: 'expand_more',
          }],
          onMouseDown: function onMouseDown(evt) {
            this.owner.toggleCategoryPopup();
            evt.stop();
            return true;
          },
        }, {
          _Extent: lively.pt(200.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 120.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'TagsLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Tags (comma-separated)',
        }, {
          _BorderColor: Color.rgb(203, 203, 203),
          _BorderRadius: 3.75,
          _BorderWidth: 1,
          _ClipMode: 'hidden',
          _Extent: lively.pt(354.0, 22.0),
          _Fill: Color.rgb(255, 255, 255),
          _FontFamily: 'Helvetica',
          _Padding: lively.rect(4, 4, 0, 0),
          _Position: lively.pt(10.0, 142.0),
          allowInput: true,
          className: 'lively.morphic.Text',
          doNotSerialize: ['charsTyped'],
          evalEnabled: false,
          fixedHeight: true,
          fixedWidth: true,
          isInputLine: true,
          layout: { resizeWidth: true },
          name: 'TagsText',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: '',
        }, {
          _Extent: lively.pt(354.0, 18.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 176.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'StatusText',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textColor: Color.rgb(153, 153, 153),
          textString: '',
        }, {
          _BorderColor: Color.rgb(214, 214, 214),
          _BorderRadius: 5,
          _BorderWidth: 1,
          _Extent: lively.pt(80.0, 24.0),
          _Position: lively.pt(204.0, 182.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'cancel',
          name: 'CancelButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewWikiPageDialogPane'), 'onCancel', {});
          },
        }, {
          _BorderColor: Color.rgb(150, 190, 250),
          _BorderRadius: 5.2,
          _BorderWidth: 1.184,
          _Extent: lively.pt(80.0, 24.0),
          _Fill: Color.rgb(235, 244, 255),
          _Position: lively.pt(288.0, 182.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'create',
          name: 'CreateButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewWikiPageDialogPane'), 'onSubmit', {});
          },
        }],
        target: null,

        // ─── lifecycle ──────────────────────────────────────────────────────────

        // scope: { constellation: name } | { handle: handle } — informational
        // only, threaded straight through to onCreate's caller-supplied
        // callback; this dialog never itself decides what scope means.
        configure: function configure(opts) {
          this._scope = (opts && opts.scope) || null;
          this._onCreateCallback = (opts && opts.onCreate) || null;
          this._category = null;
          this.get('TitleText').textString = '';
          this.get('TagsText').textString = '';
          this.get('CategoryValueLabel').textString = 'Select…';
          this.get('CategoryValueLabel').setTextColor(Color.rgb(150, 150, 150));
          this.setStatus('');
        },

        onCancel: function onCancel() {
          this.owner.remove();
        },

        onRemove: function onRemove() {
          if (this._categoryPopup) { this._categoryPopup.remove(); this._categoryPopup = null; }
          $world.newWikiPageDialog && $world.newWikiPageDialog.remove();
        },

        setStatus: function setStatus(text, isError) {
          var t = this.get('StatusText');
          t.textString = text || '';
          t.setTextColor(isError ? Color.rgb(204, 51, 51) : Color.rgb(153, 153, 153));
        },

        // ─── category dropdown ──────────────────────────────────────────────────
        // No dropdown/select morph exists elsewhere in this codebase — built
        // as a minimal popup here: a floating Box of Text rows added to
        // $world (not nested inside this dialog, so it isn't clipped by the
        // dialog's own bounds), positioned from the trigger's live DOM
        // rect. $world coordinates equal screen pixels in this app (no
        // pan/zoom), same assumption WikiIndex.js's own layout already
        // relies on, so a raw getBoundingClientRect() needs no further
        // translation.

        toggleCategoryPopup: function toggleCategoryPopup() {
          if (this._categoryPopup) {
            this._categoryPopup.remove();
            this._categoryPopup = null;
            return;
          }
          var trigger = this.get('CategoryTrigger');
          var rect = trigger.renderContext().shapeNode.getBoundingClientRect();
          var rowH = 26;
          var categories = ['Biography', 'Place', 'Event', 'Concept', 'Organization', 'How-To'];

          var popup = new lively.morphic.Box(lively.rect(0, 0, rect.width, categories.length * rowH + 8));
          popup.setFill(Color.white);
          popup.applyStyle({ borderWidth: 1, borderColor: Color.rgb(180, 180, 180), borderRadius: 4 });
          popup.setPosition(lively.pt(rect.left, rect.bottom + 4));

          var self = this;
          categories.forEach(function (cat, i) {
            var row = new lively.morphic.Text(lively.rect(6, 4 + i * rowH, rect.width - 12, rowH - 4), cat);
            row.applyStyle({
              fontSize: 12, fontFamily: 'Helvetica', textColor: Color.rgb(40, 40, 40),
              fill: null, borderWidth: 0, borderColor: null,
            });
            row.eventsAreIgnored = false;
            row.renderContext().shapeNode.style.cursor = 'pointer';
            row.onMouseDown = function () { self.selectCategory(cat); return true; };
            row.onMouseOver = function () { row.setFill(Color.rgb(235, 244, 255)); };
            row.onMouseOut = function () { row.setFill(null); };
            popup.addMorph(row);
          });

          $world.addMorph(popup);
          popup.bringToFront();
          this._categoryPopup = popup;
        },

        selectCategory: function selectCategory(cat) {
          this._category = cat;
          var label = this.get('CategoryValueLabel');
          label.textString = cat;
          label.setTextColor(Color.rgb(30, 30, 30));
          if (this._categoryPopup) { this._categoryPopup.remove(); this._categoryPopup = null; }
        },

        // ─── submit ──────────────────────────────────────────────────────────────

        slugify: function slugify(s) {
          return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
        },

        onSubmit: function onSubmit() {
          var titleRaw = this.get('TitleText').textString.trim();
          if (!titleRaw) { this.setStatus('Title is required', true); return; }
          var wikiName = this.slugify(titleRaw);
          if (!wikiName) { this.setStatus('Title must contain at least one letter or number', true); return; }
          if (!this._category) { this.setStatus('Choose a category', true); return; }

          var tagsRaw = this.get('TagsText').textString.trim();
          var tags = tagsRaw
            ? tagsRaw.split(',').map(function (t) { return t.trim(); }).filter(Boolean)
            : [];

          var fields = { wikiName: wikiName, title: titleRaw, category: this._category, tags: tags };
          var cb = this._onCreateCallback;
          this.owner.remove();
          if (cb) cb(fields);
        },
      }],
      titleBar: 'New Wiki Page',
      connectionRebuilder: function connectionRebuilder() {
        lively.bindings.connect(this, 'remove', this.get('NewWikiPageDialogPane'), 'onRemove', {});
      },
    });

    // Static open helper — mirrors the world-tracked-singleton pattern
    // PartsBin.js already uses inline for PublishToInventoryDialog, pulled
    // out here since this dialog has multiple call sites (WikiIndex.js,
    // ConstellationCanvas.js) that would otherwise each repeat the same
    // four lines of BuildSpec/world-tracking boilerplate.
    //
    // Object.extend, NOT a flat `lively.identity.NewWikiPageDialog = {...}`
    // reassignment — lively.BuildSpec('lively.identity.NewWikiPageDialog',
    // {...}) above already registered the real class at that dotted path
    // (same mechanism WikiEditor.js's `.subclass('lively.identity.
    // WikiEditor', ...)` uses, extended with static methods via
    // `Object.extend(WikiEditorClass, {...})` rather than overwriting the
    // path). A flat reassignment here would silently replace that
    // registered class with a plain object — confirmed live: BuildSpec's
    // own createMorph() does `lively.module(object.sourceModule)` to
    // resolve `sourceModule: 'lively.identity.NewWikiPageDialog'` on the
    // spec above, and a clobbered path breaks that lookup with
    // "sourceMod.isLoaded is not a function" the moment .open() runs.
    //
    // opts: { scope: {constellation:name}|{handle:handle}, onCreate(fields) }
    // fields: { wikiName, title, category, tags }
    Object.extend(lively.identity.NewWikiPageDialog, {
      open: function (opts) {
        var world = lively.morphic.World.current();
        if (world.newWikiPageDialog) world.newWikiPageDialog.remove();
        var dlg = lively.BuildSpec('lively.identity.NewWikiPageDialog').createMorph();
        dlg.openInWorldCenter().comeForward();
        world.newWikiPageDialog = dlg;
        dlg.get('NewWikiPageDialogPane').configure(opts || {});
        return dlg;
      },
    });

  }); // end of module
