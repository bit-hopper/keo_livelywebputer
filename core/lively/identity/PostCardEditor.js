/**
 * lively.identity.PostCardEditor
 *
 * BuildSpec morph — a windowed morph that embeds a ProseMirror EditorView
 * bound to a Y.Doc via ySyncPlugin. Handles live collaborative editing,
 * auto-save to identity envelopes, and toolbar actions.
 *
 * Architecture:
 *   - Extends lively.morphic.Box (windowed morph).
 *   - ProseMirror EditorView appended to renderContext().shapeNode (DOM).
 *     This is the same pattern as CodeEditor which appends CodeMirror.
 *   - ySyncPlugin + yUndoPlugin bind EditorView ↔ Y.Doc.getXmlFragment('prosemirror').
 *   - WebsocketProvider (y-websocket) attaches to PostCardSyncServer on port
 *     POSTCARD_SYNC_PORT (default 1234) using the postcard objId as room name.
 *   - Auto-save: debounced 2 s after the last change, serializes to a
 *     PostCardSerializer envelope and PUTs /@:handle/:objId.
 *   - Title field: plain text input above the editor, not part of the yDoc
 *     (synced separately as state.title in the envelope).
 *
 * CRITICAL (§9.3): Y.Doc MUST be created with gc: false before passing to
 * PostCardSerializer or attaching a WebsocketProvider. This file enforces
 * that at create-time.
 *
 * Entry point:
 *   lively.identity.PostCardEditor.open(handle, objId)
 *     — loads an existing postcard and opens the editor
 *   lively.identity.PostCardEditor.create(handle, options)
 *     — creates a new genesis postcard and opens the editor
 *
 * doNotSerialize list:
 *   editorView, yDoc, wsProvider
 *   (All three are non-serializable external objects; they are reconstructed
 *    from the envelope on next open.)
 *
 * Dependencies (must be loaded as plain scripts before first use):
 *   /lib/yjs/yjs.js, /lib/prosemirror/*, /lib/y-prosemirror/*, /lib/y-websocket/
 *
 * Dependencies (Lively modules, loaded via .requires):
 *   lively.identity.PostCardSerializer
 *   lively.identity.DID
 */

module('lively.identity.PostCardEditor')
  .requires(
    'lively.identity.PostCardSerializer',
    'lively.identity.PostCardPlayback',
    'lively.identity.DID',
    'lively.identity.WebAuthn',
    'lively.identity.WebKey',
    'lively.identity.FileCrypto',
  )
  .toRun(function () {

    // See _resolveRecipientPubKeys (postcard-audit F25).
    var RECIPIENT_KEY_CACHE_TTL_MS = 60 * 1000;

    // Shared by paragraph/heading/list_item toDOM/parseDOM (§10.1 align/indent) —
    // module-scope so schema node specs can reference them without a `this`.
    var ALLOWED_ALIGN = { left: 1, center: 1, right: 1, justify: 1 };
    function _parseAlignIndent(dom) {
      var align = dom.style && dom.style.textAlign;
      var indent = dom.style && parseInt(dom.style.marginLeft, 10);
      return {
        align: ALLOWED_ALIGN[align] ? align : 'left',
        indent: (indent > 0) ? Math.round(indent / 24) : 0,
      };
    }
    function _alignIndentAttrs(node) {
      var style = '';
      if (node.attrs.align && node.attrs.align !== 'left') style += 'text-align:' + node.attrs.align + ';';
      if (node.attrs.indent) style += 'margin-left:' + (node.attrs.indent * 24) + 'px;';
      return style ? { style: style } : {};
    }

    var PostCardEditorClass = lively.morphic.Box.subclass('lively.identity.PostCardEditor',

    // ─── serialization guard ──────────────────────────────────────────────────────

    'serialization', {
      doNotSerialize: ['editorView', 'yDoc', 'wsProvider', '_saveTimer', '_pmContainer'],
    },

    // ─── initialization ──────────────────────────────────────────────────────────

    'initialization', {

      // No initialize override — Lively's Morph.initialize sets up submorphs etc.
      // State is set directly in newCard/openCard before _setup() is called.

      // Called after the morph is in the world and DOM is available. Also
      // re-invoked by prepareForNewRenderContext below after a world
      // save/reload restores this morph — none of the DOM _buildChrome
      // builds (toolbar, pmDiv, etc.) survives serialization, so without
      // that it would come back as a blank shell.
      _setup: function () {
        // This morph is meant to live inside a lively.morphic.Window (see
        // openCard/newCard) whose title bar is the drag handle — without this,
        // Lively's default whole-body dragging (Events.js) intercepts mousedown
        // on pmDiv before native text-selection drag ever gets a chance, so
        // trying to drag-select text drags the whole editor instead.
        this.disableDragging();
        this.disableGrabbing();
        this._envelope = null;
        this.editorView = null;
        this.yDoc = null;
        this.wsProvider = null;
        this._saveTimer = null;
        this._pmContainer = null;
        this._statusLabel = null;
        this._statusEl = null;
        this._toolbarDiv = null;
        // Public/Private toggle — 'shared' is not a distinct editor-side state,
        // it's what serializeEncrypted derives automatically once
        // _recipientHandles is non-empty.
        this._visibility = 'public';
        this._recipientHandles = [];
        this._visibilityBtn = null;
        // Attachment metadata (§6): { objId, dek, blobCid, blobNonce, name,
        // mime } entries — pass-through inside the postcard payload, hydrated
        // from the loaded envelope in _loadExistingNow.
        this._attachments = [];
        // Optional location tag (a floored, <=6-significant-digit Plus
        // Code — see PostCardUtils.js's encodeLocation). _locationCleared
        // distinguishes "never attached one" (both null) from "explicitly
        // removed" (code null, cleared true) — a save must be able to send
        // stateMeta.location: null on removal rather than just omitting the
        // field, or the server can't tell "no change" from "clear it."
        this._locationCode = null;
        this._locationCleared = false;
        this._locationBtn = null;
        // True for a new card (you're creating it) or once _loadExistingNow
        // compares envelope.did to the session DID. Gates editing, Save,
        // Send, and the visibility toggle — a non-owner viewing a shared
        // card is read-only (PUT is owner-only server-side regardless).
        this._isOwner = true;
        // Set by PostCardEditor.openCard's forceReadOnly option — used only
        // by PostCardView, which embeds a target-mode editor purely to
        // decrypt+render private-card content (no plaintext snapshot exists
        // for encrypted envelopes, unlike public ones) and must never let
        // that embed become editable/autosaving, even for the card's own
        // owner. See _applyReadOnlyMode and _markEdited.
        // Preserved (not reset to false) across a restore-triggered re-run
        // of _setup() — openCard already set it correctly before the first
        // run, and a world reload must not silently turn a forced-read-only
        // content viewer back into an editable instance.
        this._forceReadOnly = !!this._forceReadOnly;
        this._buildChrome();
        if (this._isNew) {
          this._createNewDoc();
        } else {
          this._loadExisting();
        }
      },

      // Fires once, harmlessly, during construction — before openCard/
      // newCard have set _handle, so the guard below skips it (those
      // factories call _setup() themselves once configured). Fires again,
      // recursively for every submorph in the world, whenever a saved world
      // is reloaded (see Rendering.js's prepareForNewRenderContext) or this
      // morph is copied — _handle/_objId/_isNew/_forceReadOnly are plain
      // fields and survive serialization fine, but the DOM _buildChrome
      // builds does not, so without this a restored editor comes back
      // blank. Matches the identical fix in PostCardView.js.
      prepareForNewRenderContext: function ($super, renderCtx) {
        $super(renderCtx);
        if (!this._handle) return;
        this._setup();
      },

    },

    // ─── chrome (UI scaffolding) ─────────────────────────────────────────────────

    'chrome', {

      _buildChrome: function () {
        var self = this;
        this.setFill(Color.white);

        var shapeNode = this.renderContext().shapeNode;
        shapeNode.innerHTML = ''; // idempotent: safe if _setup() ever runs twice on one instance
        shapeNode.style.borderRadius = '8px';
        shapeNode.style.boxShadow = '0 4px 12px rgba(0,0,0,0.18)';

        // Toolbar as a plain DOM div — keeping it out of Lively's morph hierarchy
        // prevents Lively from grabbing the toolbar as an independent draggable morph.
        // This morph's own body-dragging is disabled (_setup) — drag via the
        // enclosing lively.morphic.Window's title bar instead (openCard/newCard).
        var toolbarDiv = document.createElement('div');
        toolbarDiv.style.cssText = [
          'position:absolute',
          'top:0',
          'left:0',
          'right:0',
          'height:64px',
          'background:#f0f0f5',
          'border-bottom:1px solid #ccc',
          'box-sizing:border-box',
          'overflow:hidden',
        ].join(';');
        shapeNode.appendChild(toolbarDiv);
        this._toolbarDiv = toolbarDiv;
        this._buildToolbar(toolbarDiv);

        // Footer: card-level actions — History leftmost, Save/visibility/Send
        // on the right.
        var footerDiv = document.createElement('div');
        footerDiv.style.cssText = [
          'position:absolute', 'left:0', 'right:0', 'bottom:0', 'height:36px',
          'background:#f0f0f5', 'border-top:1px solid #ccc', 'box-sizing:border-box',
        ].join(';');
        shapeNode.appendChild(footerDiv);
        this._footerDiv = footerDiv;
        this._buildFooter(footerDiv);

        this._buildLinkPreview(shapeNode);

        // ProseMirror container div. The 'selectable' class matters, not just
        // cosmetically: Lively's global base stylesheet (Main.js) sets
        // `*:not(:focus) { user-select: none }` on everything by default (to
        // stop drag-selecting morph contents), with `.selectable, .selectable *`
        // as the opt-out. ProseMirror's own contenteditable node and its text
        // content are descendants of pmDiv, not pmDiv itself, and never match
        // `:focus` individually — without this class, native browser text
        // selection/caret operations over that content (notably Backspace/
        // Delete, which ProseMirror deliberately leaves to native contenteditable
        // handling — see prosemirror-view's captureKeyDown) silently don't work.
        var pmDiv = document.createElement('div');
        pmDiv.className = 'lively-postcard-editor-container selectable';
        pmDiv.style.cssText = [
          'position:absolute',
          'top:64px',
          'left:0',
          'right:0',
          'bottom:36px',
          'overflow-y:auto',
          'padding:16px 20px',
          'box-sizing:border-box',
          'font-family:sans-serif',
          'font-size:14px',
          'line-height:1.6',
          'white-space:pre-wrap',
        ].join(';');
        shapeNode.appendChild(pmDiv);
        this._pmContainer = pmDiv;

        if (!document.getElementById('lively-postcard-editor-style')) {
          var styleEl = document.createElement('style');
          styleEl.id = 'lively-postcard-editor-style';
          styleEl.textContent =
            '.lively-postcard-editor-container .ProseMirror > :first-child {' +
            '  font-size:20px;font-weight:bold;margin-bottom:8px;' +
            '}' +
            '.lively-postcard-image{max-width:100%;max-height:320px;vertical-align:middle;' +
            'border-radius:4px;}' +
            '.lively-math-node{cursor:pointer;border-radius:3px;}' +
            '.lively-math-node.lively-math-selected,' +
            '.lively-math-node.ProseMirror-selectednode{outline:2px solid #8cf;}' +
            '.lively-math-node.math-inline{padding:0 2px;}' +
            '.lively-math-node.math-display{display:block;padding:8px;text-align:center;}' +
            '.lively-math-empty{color:#999;font-style:italic;border:1px dashed #ccc;padding:0 4px;}' +
            '.lively-math-error{color:#c33;border:1px dashed #c33;padding:0 4px;}' +
            '.lively-math-input{font-family:monospace;font-size:13px;border:1px solid #55c;' +
            'border-radius:3px;padding:2px 4px;}' +
            'input.lively-math-input{min-width:80px;}' +
            'textarea.lively-math-input{width:100%;min-height:48px;box-sizing:border-box;}' +
            '.lively-embedded-part-node{position:relative;min-height:32px;margin:4px 0;' +
            'border:1px solid #ddd;border-radius:4px;overflow:hidden;}' +
            '.lively-embedded-part-content{padding:4px;}' +
            '.lively-embedded-part-content.lively-embed-error{color:#c33;font-style:italic;padding:8px;}' +
            '.lively-embed-overlay{position:absolute;top:2px;right:2px;display:flex;gap:4px;z-index:10;}' +
            '.lively-embed-overlay button{font-size:10px;padding:2px 6px;cursor:pointer;' +
            'border:1px solid #ccc;border-radius:3px;background:#fff;}' +
            '.lively-embed-overlay button.lively-embed-remove-btn{border-color:#c33;color:#c33;}';
          document.head.appendChild(styleEl);
        }

        // Stop keyboard and mouse events from bubbling up to Lively's morph handlers.
        // Bubble phase only — capture phase would block events from reaching PM's div inside pmDiv.
        ['keydown', 'keyup', 'keypress', 'input'].forEach(function (t) {
          pmDiv.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick'].forEach(function (t) {
          pmDiv.addEventListener(t, function (e) { e.stopPropagation(); });
        });
      },

      // Two evenly-balanced formatting rows (13 items each). Card-level
      // actions (History/Save/visibility/Send) live in the footer bar
      // instead (_buildFooter) — History is leftmost there per request.
      _buildToolbar: function (toolbarDiv) {
        var self = this;

        // Row A: character-level formatting — marks, headings, colors, fonts.
        var markDefs = [
          { label: 'B',    title: 'Bold',              cmd: 'toggleMark', markType: 'bold' },
          { label: 'I',    title: 'Italic',             cmd: 'toggleMark', markType: 'italic' },
          { label: 'U',    title: 'Underline',          cmd: 'toggleMark', markType: 'underline' },
          { label: 'S',    title: 'Strikethrough',      cmd: 'toggleMark', markType: 'strike' },
          { label: 'x²',   title: 'Superscript',        cmd: 'toggleMark', markType: 'superscript' },
          { label: 'x₂',   title: 'Subscript',          cmd: 'toggleMark', markType: 'subscript' },
          { label: '`',    title: 'Inline code',        cmd: 'toggleMark', markType: 'code' },
          { label: 'H1',   title: 'Heading 1',          cmd: 'setBlockType', nodeType: 'heading', attrs: { level: 1 } },
          { label: 'H2',   title: 'Heading 2',          cmd: 'setBlockType', nodeType: 'heading', attrs: { level: 2 } },
        ];

        // Row B: block structure, alignment, and insert commands.
        var blockDefs = [
          { label: '•',    title: 'Bullet list',        cmd: 'wrapInList',   nodeType: 'bullet_list' },
          { label: '1.',   title: 'Ordered list',       cmd: 'wrapInList',   nodeType: 'ordered_list' },
          { label: '❝',    title: 'Blockquote',         cmd: 'wrapIn',       nodeType: 'blockquote' },
          { label: '</>',  title: 'Code block',         cmd: 'setBlockType', nodeType: 'code_block', attrs: {} },
          { label: '≡',    title: 'Cycle alignment (left/center/right/justify)', cmd: 'cycleAlign' },
          { label: '→|',   title: 'Indent',             cmd: 'indent' },
          { label: '|←',   title: 'Outdent',            cmd: 'outdent' },
          { label: '✕',    title: 'Clear formatting',   cmd: 'clearFormatting' },
          { label: '🔗',   title: 'Insert/remove link', cmd: 'link' },
          { label: '📎',   title: 'Insert attachment',  cmd: 'attachment' },
          { label: '🧩',   title: 'Insert part',        cmd: 'insertPart' },
          { label: '∑',    title: 'Math inline',        cmd: 'insertMath', mathType: 'inline' },
          { label: '∑²',   title: 'Math display',       cmd: 'insertMath', mathType: 'display' },
        ];

        function buildRow(top) {
          var row = document.createElement('div');
          row.style.cssText = [
            'position:absolute', 'top:' + top + 'px', 'left:6px', 'right:6px', 'height:26px',
            'display:flex', 'align-items:center', 'gap:6px', 'padding:0 2px',
            'overflow-x:auto', 'overflow-y:hidden', 'white-space:nowrap',
          ].join(';');
          toolbarDiv.appendChild(row);
          return row;
        }

        this._toggleButtons = [];

        function addButtons(row, defs) {
          defs.forEach(function (btnDef) {
            var w = btnDef.label.length > 1 ? 32 : 24;
            var btn = document.createElement('button');
            btn.textContent = btnDef.label;
            btn.title = btnDef.title;
            btn.style.cssText = [
              'flex:0 0 auto',
              'width:' + w + 'px',
              'height:24px',
              'padding:0',
              'font-size:12px',
              'cursor:pointer',
              'border:1px solid #ccc',
              'border-radius:3px',
              'background:#fff',
            ].join(';');
            btn.addEventListener('mousedown', function (e) {
              e.preventDefault();
              e.stopPropagation();
              self._execToolbarCmd(btnDef);
            });
            row.appendChild(btn);
            if (btnDef.cmd === 'toggleMark') {
              self._toggleButtons.push({ btn: btn, markType: btnDef.markType });
            }
          });
        }

        var rowA = buildRow(2);
        addButtons(rowA, markDefs);
        this._textColorInput = this._buildColorInput('textColor', 'Text color', '#000000');
        rowA.appendChild(this._textColorInput);
        this._bgColorInput = this._buildColorInput('backgroundColor', 'Background color', '#ffffff');
        rowA.appendChild(this._bgColorInput);
        this._fontFamilySelect = this._buildFontFamilySelect();
        rowA.appendChild(this._fontFamilySelect);
        this._fontSizeInput = this._buildFontSizeInput();
        rowA.appendChild(this._fontSizeInput);

        var rowB = buildRow(32);
        addButtons(rowB, blockDefs);
      },

      // Persistent (not popup-triggered) native color input — reflects the
      // current selection's color (_updateToolbarState) and applies on pick.
      _buildColorInput: function (markName, title, fallback) {
        var self = this;
        var input = document.createElement('input');
        input.type = 'color';
        input.title = title;
        input.value = fallback;
        input.style.cssText = 'flex:0 0 auto;width:26px;height:24px;padding:0;border:1px solid #ccc;border-radius:3px;cursor:pointer;';
        ['mousedown', 'click'].forEach(function (t) {
          input.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        input.addEventListener('input', function () {
          if (!self.editorView) return;
          var view = self.editorView;
          var markType = view.state.schema.marks[markName];
          if (!markType) return;
          var from = view.state.selection.from, to = view.state.selection.to;
          if (from === to) return; // requires a text selection
          view.dispatch(view.state.tr.addMark(from, to, markType.create({ color: input.value })));
        });
        input.addEventListener('change', function () { if (self.editorView) self.editorView.focus(); });
        return input;
      },

      _buildFontFamilySelect: function () {
        var self = this;
        var options = [
          ['', 'Font'],
          ['sans-serif', 'Sans'],
          ['serif', 'Serif'],
          ['monospace', 'Mono'],
          ['"Comic Sans MS", cursive', 'Comic'],
          ['Georgia, serif', 'Georgia'],
        ];
        var select = document.createElement('select');
        select.title = 'Font family';
        select.style.cssText = [
          'flex:0 0 auto', 'height:24px', 'font-size:11px', 'cursor:pointer',
          'border:1px solid #ccc', 'border-radius:3px', 'background:#fff',
        ].join(';');
        options.forEach(function (opt) {
          var optionEl = document.createElement('option');
          optionEl.value = opt[0];
          optionEl.textContent = opt[1];
          select.appendChild(optionEl);
        });
        ['mousedown', 'click'].forEach(function (t) {
          select.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        select.addEventListener('change', function () {
          if (!self.editorView) return;
          var view = self.editorView;
          var markType = view.state.schema.marks.fontFamily;
          if (!markType) return;
          var from = view.state.selection.from, to = view.state.selection.to;
          if (from === to) return; // requires a text selection
          var tr = view.state.tr.removeMark(from, to, markType);
          if (select.value) tr = tr.addMark(from, to, markType.create({ family: select.value }));
          view.dispatch(tr);
          view.focus();
        });
        return select;
      },

      // Editable number input (not a fixed-preset dropdown) — reflects the
      // current selection's size (_updateToolbarState) and applies on commit.
      _buildFontSizeInput: function () {
        var self = this;
        var input = document.createElement('input');
        input.type = 'number';
        input.title = 'Font size (px)';
        input.placeholder = '14';
        input.min = '6';
        input.max = '128';
        input.style.cssText = 'flex:0 0 auto;width:44px;height:24px;padding:0 2px;font-size:11px;' +
          'border:1px solid #ccc;border-radius:3px;background:#fff;';
        ['mousedown', 'click'].forEach(function (t) {
          input.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        function commit() {
          if (!self.editorView) return;
          var view = self.editorView;
          var markType = view.state.schema.marks.fontSize;
          if (!markType) return;
          var from = view.state.selection.from, to = view.state.selection.to;
          if (from === to) return; // requires a text selection
          var tr = view.state.tr.removeMark(from, to, markType);
          if (input.value) tr = tr.addMark(from, to, markType.create({ size: input.value + 'px' }));
          view.dispatch(tr);
          view.focus();
        }
        input.addEventListener('change', commit);
        input.addEventListener('keydown', function (e) {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
        });
        return input;
      },

      // Footer bar: card-level actions, bottom-right (moved out of the
      // formatting toolbar so it reads as a distinct "card" action group).
      _buildFooter: function (footerDiv) {
        var self = this;

        // History is leftmost — a "view this card" action, distinct from
        // the Save/visibility/Send cluster on the right.
        var histBtn = document.createElement('button');
        histBtn.textContent = 'History';
        histBtn.title = 'View version history (save first)';
        histBtn.style.cssText = 'position:absolute;top:6px;left:8px;width:64px;height:24px;padding:0;font-size:11px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;';
        histBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._openPlayback();
        });
        footerDiv.appendChild(histBtn);

        var statusSpan = document.createElement('span');
        statusSpan.style.cssText = 'position:absolute;top:7px;right:252px;font-size:10px;color:#888;pointer-events:none;';
        footerDiv.appendChild(statusSpan);
        this._statusEl = statusSpan;

        var saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.title = 'Save now';
        saveBtn.style.cssText = 'position:absolute;top:6px;right:80px;width:48px;height:24px;padding:0;font-size:12px;cursor:pointer;border:1px solid #5a5;border-radius:3px;background:#efe;';
        saveBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._saveNow();
        });
        footerDiv.appendChild(saveBtn);

        // Visibility toggle (Public ⇄ Private). 'shared' is not a state this
        // button sets — it's derived automatically once a card has recipients.
        var visBtn = document.createElement('button');
        visBtn.style.cssText = 'position:absolute;top:6px;right:132px;width:52px;height:24px;padding:0;font-size:11px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;';
        visBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._visibility = self._visibility === 'public' ? 'private' : 'public';
          self._updateVisibilityBtn();
          self._markEdited();
        });
        footerDiv.appendChild(visBtn);
        this._visibilityBtn = visBtn;
        this._updateVisibilityBtn();

        var sendBtn = document.createElement('button');
        sendBtn.textContent = 'Send';
        sendBtn.title = 'Send to a handle';
        sendBtn.style.cssText = 'position:absolute;top:6px;right:188px;width:52px;height:24px;padding:0;font-size:12px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;';
        sendBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._promptAndSend();
        });
        footerDiv.appendChild(sendBtn);

        var postBtn = document.createElement('button');
        postBtn.textContent = 'Post to…';
        postBtn.title = 'Post this card to a constellation you are a member of';
        postBtn.style.cssText = 'position:absolute;top:6px;right:320px;width:80px;height:24px;padding:0;font-size:11px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;';
        postBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._promptPostToConstellation();
        });
        footerDiv.appendChild(postBtn);

        // Opt-in coarse location tag (~5.5km cell, never more precise —
        // see PostCardUtils.js's encodeLocation) — click attaches your
        // current location, click again (once attached) to remove it.
        var locationBtn = document.createElement('button');
        locationBtn.style.cssText = 'position:absolute;top:6px;right:410px;width:110px;height:24px;padding:0;font-size:11px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;';
        locationBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          if (self._locationCode) self._removeLocation();
          else self._promptAttachLocation();
        });
        footerDiv.appendChild(locationBtn);
        this._locationBtn = locationBtn;
        this._updateLocationBtn();
      },

      // Reflects the current selection's formatting into the toolbar: active
      // marks get highlighted, color/font/size controls show the current
      // value. Called after every transaction (dispatchTransaction).
      _updateToolbarState: function () {
        if (!this.editorView) return;
        var state = this.editorView.state;

        function activeMarksAtSelection() {
          if (state.selection.empty) return state.storedMarks || state.selection.$from.marks();
          var found = [];
          state.doc.nodesBetween(state.selection.from, state.selection.to, function (node) {
            (node.marks || []).forEach(function (m) {
              if (found.indexOf(m) === -1) found.push(m);
            });
          });
          return found;
        }

        var marks = activeMarksAtSelection();
        function markOfType(name) {
          var type = state.schema.marks[name];
          if (!type) return null;
          for (var i = 0; i < marks.length; i++) {
            if (marks[i].type === type) return marks[i];
          }
          return null;
        }

        (this._toggleButtons || []).forEach(function (entry) {
          var active = !!markOfType(entry.markType);
          entry.btn.style.background = active ? '#dbe9ff' : '#fff';
          entry.btn.style.borderColor = active ? '#58c' : '#ccc';
        });

        if (this._textColorInput) {
          var tMark = markOfType('textColor');
          this._textColorInput.value = (tMark && tMark.attrs.color) || '#000000';
        }
        if (this._bgColorInput) {
          var bMark = markOfType('backgroundColor');
          this._bgColorInput.value = (bMark && bMark.attrs.color) || '#ffffff';
        }
        if (this._fontFamilySelect) {
          var fMark = markOfType('fontFamily');
          this._fontFamilySelect.value = (fMark && fMark.attrs.family) || '';
        }
        if (this._fontSizeInput) {
          var sMark = markOfType('fontSize');
          this._fontSizeInput.value = (sMark && sMark.attrs.size) ? parseInt(sMark.attrs.size, 10) : '';
        }
      },

      _updateVisibilityBtn: function () {
        if (!this._visibilityBtn) return;
        var isPublic = this._visibility === 'public';
        this._visibilityBtn.textContent = isPublic ? 'Public' : (this._recipientHandles.length ? 'Shared' : 'Private');
        this._visibilityBtn.title = isPublic
          ? 'Public — anyone can read. Click to make private.'
          : 'Encrypted — only you' + (this._recipientHandles.length ? ' and ' + this._recipientHandles.length + ' recipient(s)' : '') + ' can read. Click to make public.';
        this._visibilityBtn.style.background = isPublic ? '#fff' : '#eef';
        this._visibilityBtn.style.borderColor = isPublic ? '#ccc' : '#55c';
      },

      _updateLocationBtn: function () {
        if (!this._locationBtn) return;
        var has = !!this._locationCode;
        this._locationBtn.textContent = has ? ('📍 ' + this._locationCode) : '📍 Add location';
        this._locationBtn.title = has
          ? 'Location tag: ' + this._locationCode + ' (click to remove)'
          : 'Tag this card with your current coarse location (~5.5km, never more precise)';
        this._locationBtn.style.background = has ? '#eef' : '#fff';
        this._locationBtn.style.borderColor = has ? '#55c' : '#ccc';
      },

      // Captures the device's current position and immediately floors it to
      // a 6-significant-digit Plus Code (encodeLocation) — raw coordinates
      // are never assigned to a persistent field or held past this callback,
      // so there's nothing more precise than the floor left to leak even if
      // a bug elsewhere mishandled it (server-side PlusCode.js enforces the
      // same floor independently as the actual trust boundary).
      _promptAttachLocation: function () {
        var self = this;
        if (!navigator.geolocation) {
          this._setStatus('Geolocation unavailable');
          return;
        }
        this._ensureGeoRuntime(function () {
          self._setStatus('Locating…');
          navigator.geolocation.getCurrentPosition(function (pos) {
            var code = lively.identity.postCardUtils.encodeLocation(pos.coords.latitude, pos.coords.longitude);
            if (!code) { self._setStatus('Location error'); return; }
            self._locationCode = code;
            self._locationCleared = false;
            self._updateLocationBtn();
            self._markEdited();
            self._setStatus('Location attached');
          }, function () {
            self._setStatus('Location unavailable');
          }, { timeout: 8000, maximumAge: 300000 });
        });
      },

      _removeLocation: function () {
        this._locationCode = null;
        this._locationCleared = true;
        this._updateLocationBtn();
        this._markEdited();
      },

      // A save's stateMeta.location: value | null | undefined — omitted
      // entirely when a location was never attached/removed this session
      // (so an unrelated save doesn't touch an existing stored value),
      // explicit null on removal (so the server can tell "clear it" apart
      // from "no change"), or the floored code when attached.
      _locationStateMeta: function () {
        if (this._locationCode) return { location: this._locationCode };
        if (this._locationCleared) return { location: null };
        return null;
      },

      // A small floating chip shown under the cursor when it's inside a link
      // (Google Docs-style) — plain click inside a contenteditable region
      // only places the cursor (browser convention; Ctrl/Cmd-click still
      // opens the link natively), so this is the discoverable way to see the
      // URL, open it, edit it, or remove it without hunting for a selection.
      _buildLinkPreview: function (shapeNode) {
        var self = this;
        var el = document.createElement('div');
        el.className = 'lively-link-preview';
        el.style.cssText = [
          'position:absolute', 'display:none', 'z-index:1000', 'align-items:center', 'gap:8px',
          'background:#fff', 'border:1px solid #ccc', 'border-radius:6px',
          'box-shadow:0 4px 12px rgba(0,0,0,0.18)', 'padding:5px 8px',
          'font-family:sans-serif', 'font-size:12px', 'max-width:320px',
        ].join(';');

        var link = document.createElement('a');
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.cssText = 'color:#15c;text-decoration:underline;max-width:200px;overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap;';
        el.appendChild(link);

        var editBtn = document.createElement('button');
        editBtn.textContent = 'Edit';
        editBtn.style.cssText = 'flex:0 0 auto;font-size:11px;padding:2px 8px;cursor:pointer;' +
          'border:1px solid #ccc;border-radius:3px;background:#fff;';
        el.appendChild(editBtn);

        var removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.style.cssText = 'flex:0 0 auto;font-size:11px;padding:2px 8px;cursor:pointer;' +
          'border:1px solid #c33;border-radius:3px;background:#fff;color:#c33;';
        el.appendChild(removeBtn);

        ['mousedown', 'click'].forEach(function (t) {
          el.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        editBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          if (self._currentLinkRange) self._linkPreviewAction('edit', self._currentLinkRange);
        });
        removeBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          if (self._currentLinkRange) self._linkPreviewAction('remove', self._currentLinkRange);
        });

        shapeNode.appendChild(el);
        this._linkPreviewEl = el;
        this._linkPreviewLinkEl = link;
      },

      _hideLinkPreview: function () {
        this._currentLinkRange = null;
        if (this._linkPreviewEl) this._linkPreviewEl.style.display = 'none';
      },

      // Finds the link mark (if any) touching a collapsed cursor. Only
      // scans the immediate parent block's direct children — sufficient for
      // this schema, where marked text runs are never nested deeper.
      _findLinkRangeAtSelection: function (state, linkType) {
        if (!state.selection.empty) return null;
        var $pos = state.selection.$from;
        var parent = $pos.parent;
        var parentStart = $pos.start();
        var result = null;
        parent.forEach(function (child, childOffset) {
          if (result) return;
          var mark = linkType.isInSet(child.marks || []);
          if (!mark) return;
          var from = parentStart + childOffset;
          var to = from + child.nodeSize;
          if ($pos.pos >= from && $pos.pos <= to) result = { mark: mark, from: from, to: to };
        });
        return result;
      },

      _updateLinkPreview: function () {
        if (!this.editorView || !this._linkPreviewEl) return;
        var view = this.editorView;
        var state = view.state;
        var linkType = state.schema.marks.link;
        if (!linkType) return;

        var range = this._findLinkRangeAtSelection(state, linkType);
        this._currentLinkRange = range;
        if (!range) {
          this._linkPreviewEl.style.display = 'none';
          return;
        }

        this._linkPreviewLinkEl.href = range.mark.attrs.href;
        this._linkPreviewLinkEl.textContent = range.mark.attrs.href;

        var coords = view.coordsAtPos(range.from);
        var shapeRect = this.renderContext().shapeNode.getBoundingClientRect();
        this._linkPreviewEl.style.display = 'flex';
        this._linkPreviewEl.style.left = Math.max(4, coords.left - shapeRect.left) + 'px';
        this._linkPreviewEl.style.top = (coords.bottom - shapeRect.top + 4) + 'px';
      },

      _linkPreviewAction: function (action, range) {
        var view = this.editorView;
        if (!view) return;
        var linkType = view.state.schema.marks.link;
        if (action === 'remove') {
          view.dispatch(view.state.tr.removeMark(range.from, range.to, linkType));
          view.focus();
        } else if (action === 'edit') {
          var href = window.prompt('Edit link URL (blank to remove):', range.mark.attrs.href || 'https://');
          if (href === null) { this._hideLinkPreview(); return; }
          href = href.trim();
          var tr = view.state.tr.removeMark(range.from, range.to, linkType);
          if (href) tr = tr.addMark(range.from, range.to, linkType.create({ href: href }));
          view.dispatch(tr);
          view.focus();
        }
        this._hideLinkPreview();
      },

    },

    // ─── morph-level event overrides ────────────────────────────────────────────────
    // lively.morphic.Morph's default onKeyDown (Events.js) special-cases several
    // keys for every morph regardless of what's actually focused inside it:
    // Backspace unconditionally calls evt.preventDefault() (a guard against
    // legacy browser back-navigation), and Ctrl/Cmd-C / -V are redirected to
    // Lively's own morph-clipboard ("copy this morph") instead of native text
    // clipboard. Both silently break ProseMirror, which relies on the browser's
    // native contenteditable behavior for ordinary backspace/copy/paste. Bypass
    // all of it whenever the ProseMirror view itself actually has focus.

    'morph events', {

      onKeyDown: function ($super, evt) {
        var view = this.editorView;
        // view.hasFocus() is `document.activeElement === view.dom` exactly
        // (prosemirror-view's own source, non-IE branch) — it does NOT count
        // as focused when a custom NodeView has injected its own <input>/
        // <textarea> (e.g. the math NodeView's edit box), which is a
        // descendant of view.dom, never view.dom itself. That gap let this
        // override fall through to Lively's default onBackspacePressed while
        // editing a math formula, reintroducing the exact preventDefault bug
        // this override exists to avoid — hence the extra `contains` check.
        if (view && (view.hasFocus() || (view.dom && view.dom.contains(document.activeElement)))) {
          return false;
        }
        return $super(evt);
      },

    },

    // ─── ProseMirror setup ────────────────────────────────────────────────────────

    'editor', {

      // Inject postcard-runtime.js if Yjs/PM aren't on the page yet, then call back.
      _ensureRuntime: function (callback) {
        if (this._Y() && this._ProseMirror() && this._yProsemirror()) {
          return callback();
        }
        var self = this;
        if (window._postcardRuntimeLoading) {
          var poll = setInterval(function () {
            if (self._Y() && self._ProseMirror()) { clearInterval(poll); callback(); }
          }, 80);
          return;
        }
        window._postcardRuntimeLoading = true;
        this._setStatus('Loading…');
        if (!document.getElementById('katex-css')) {
          var link = document.createElement('link');
          link.id = 'katex-css';
          link.rel = 'stylesheet';
          link.href = '/core/lib/postcard/katex.min.css';
          document.head.appendChild(link);
        }
        if (!document.getElementById('hljs-css')) {
          var hljsLink = document.createElement('link');
          hljsLink.id = 'hljs-css';
          hljsLink.rel = 'stylesheet';
          hljsLink.href = '/core/lib/postcard/hljs-github.css';
          document.head.appendChild(hljsLink);
        }
        var s = document.createElement('script');
        s.src = '/core/lib/postcard/postcard-runtime.js';
        s.onload = function () { window._postcardRuntimeLoading = false; callback(); };
        s.onerror = function () {
          window._postcardRuntimeLoading = false;
          self._showError('Failed to load /core/lib/postcard/postcard-runtime.js');
        };
        document.head.appendChild(s);
      },

      // Lazy-loads core/lib/geo/geo-runtime.js (window.L + window.OpenLocationCode
      // — Leaflet + open-location-code, bundled together since LocalMap.js
      // needs both; PostCardEditor only needs OpenLocationCode, but shares
      // the one bundle rather than adding a second lazy-load path, matching
      // this file's own _ensureRuntime combining several unrelated libs
      // behind one load). Same guard/poll/CSS-link shape as _ensureRuntime.
      _ensureGeoRuntime: function (callback) {
        if (window.L && window.OpenLocationCode) return callback();
        var self = this;
        if (window._geoRuntimeLoading) {
          var poll = setInterval(function () {
            if (window.L && window.OpenLocationCode) { clearInterval(poll); callback(); }
          }, 80);
          return;
        }
        window._geoRuntimeLoading = true;
        if (!document.getElementById('leaflet-css')) {
          var link = document.createElement('link');
          link.id = 'leaflet-css';
          link.rel = 'stylesheet';
          link.href = '/core/lib/geo/leaflet.css';
          document.head.appendChild(link);
        }
        var s = document.createElement('script');
        s.src = '/core/lib/geo/geo-runtime.js';
        s.onload = function () { window._geoRuntimeLoading = false; callback(); };
        s.onerror = function () {
          window._geoRuntimeLoading = false;
          self._showError('Failed to load /core/lib/geo/geo-runtime.js');
        };
        document.head.appendChild(s);
      },

      // Create a fresh Y.Doc (gc: false) and attach a ProseMirror editor.
      _createNewDoc: function () {
        var self = this;
        this._ensureRuntime(function () {
          var Y = self._Y();
          if (!Y) return self._showError('Yjs not loaded — cannot create editor');
          self.yDoc = new Y.Doc({ gc: false });
          self._attachEditor();
          self._connectSync();
        });
      },

      // Load the existing envelope from the server, reconstruct the Y.Doc, then attach.
      _loadExisting: function () {
        var self = this;
        this._ensureRuntime(function () { self._loadExistingNow(); });
      },

      _loadExistingNow: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = base + '/@' + encodeURIComponent(this._handle) + '/' + encodeURIComponent(this._objId);
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError('Failed to load postcard: ' + xhr.status);
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) {
            return self._showError('Invalid envelope JSON: ' + e.message);
          }
          self._envelope = envelope;
          self._visibility = envelope.visibility === 'public' ? 'public' : 'private';
          self._recipientHandles = (envelope.state && envelope.state.recipientHandles) || [];
          self._locationCode = (envelope.state && envelope.state.location) || null;
          self._locationCleared = false;
          self._updateLocationBtn();
          var user = lively.identity.did.currentUser();
          self._isOwner = !!(user && user.did === envelope.did);
          self._updateVisibilityBtn();
          var deserialize = envelope.visibility === 'public'
            ? lively.identity.postCardSerializer.deserializeFromEnvelope
            : lively.identity.postCardSerializer.deserializeEncrypted;
          deserialize.call(lively.identity.postCardSerializer, envelope, function (err, yDoc, payload) {
            if (err) return self._showError('Failed to deserialize: ' + err.message);
            self.yDoc = yDoc;
            // §6: attachments travel inside the (now-decrypted, for a
            // private/shared card) payload — the image NodeView/link click
            // handler resolve against this array, not a fresh fetch.
            self._attachments = (payload && payload.attachments) || [];
            self._attachEditor();
            self._applyReadOnlyMode();
            self._connectSync();
          });
        };
        xhr.onerror = function () { self._showError('Network error loading postcard'); };
        xhr.send();
      },

      // Append a ProseMirror EditorView to _pmContainer, bound to yDoc via ySyncPlugin.
      _attachEditor: function () {
        var self = this;
        if (!this._pmContainer) return;

        var prosemirror = this._ProseMirror();
        var yPM = this._yProsemirror();
        if (!prosemirror) return this._showError('ProseMirror not loaded');
        if (!yPM) return this._showError('y-prosemirror not loaded');

        var schema = this._buildSchema(prosemirror.model);
        var yXmlFragment = this.yDoc.getXmlFragment('prosemirror');

        var hardBreakCmd = function (state, dispatch) {
          var hb = state.schema.nodes.hard_break;
          if (!hb) return false;
          if (dispatch) dispatch(state.tr.replaceSelectionWith(hb.create()).scrollIntoView());
          return true;
        };

        var plugins = [
          yPM.ySyncPlugin(yXmlFragment),
          yPM.yUndoPlugin(), // sole undo/redo — do NOT add prosemirror history() alongside this
          this._buildHighlightPlugin(prosemirror),
          // yUndoPlugin only exposes undo/redo commands, it does not bind any
          // keys itself (confirmed against y-prosemirror's own source/README) —
          // this keymap is required, not optional, or Mod-z/Mod-y do nothing.
          prosemirror.keymap.keymap({ 'Mod-z': yPM.undo, 'Mod-y': yPM.redo, 'Mod-Shift-z': yPM.redo }),
          prosemirror.keymap.keymap({ 'Shift-Enter': hardBreakCmd }),
          prosemirror.keymap.keymap(prosemirror.commands.baseKeymap),
        ];

        // List-aware keymaps: Enter splits list items, Tab sinks/lifts them.
        // Must be inserted before baseKeymap so Enter is handled by splitListItem first.
        var sl = prosemirror.schemaList;
        if (sl && schema.nodes.list_item) {
          plugins.unshift(prosemirror.keymap.keymap({
            'Enter':     sl.splitListItem(schema.nodes.list_item),
            'Tab':       sl.sinkListItem(schema.nodes.list_item),
            'Shift-Tab': sl.liftListItem(schema.nodes.list_item),
          }));
        }

        this.editorView = new prosemirror.view.EditorView(this._pmContainer, {
          state: prosemirror.state.EditorState.create({ schema: schema, plugins: plugins }),
          nodeViews: {
            math_inline:  function (node, view, getPos) { return self._mathNodeView(node, view, getPos); },
            math_display: function (node, view, getPos) { return self._mathNodeView(node, view, getPos); },
            embeddedPart: function (node, view, getPos) { return self._embeddedPartNodeView(node, view, getPos); },
            image:        function (node, view, getPos) { return self._attachmentImageNodeView(node, view, getPos); },
          },
          handleDOMEvents: {
            blur: function () { self._hideLinkPreview(); return false; },
            // Non-image attachment links (§6): a private/shared one has no
            // real href (see the link mark's toDOM above) — intercept the
            // click and resolve+decrypt on demand instead of navigating.
            click: function (view, event) {
              var a = event.target && event.target.closest && event.target.closest('a[data-attachment-obj-id]');
              if (!a) return false;
              event.preventDefault();
              self._openAttachment(a.getAttribute('data-attachment-obj-id'));
              return true;
            },
          },
          dispatchTransaction: function (tr) {
            // ProseMirror calls this as dispatchTransaction.call(editorView, tr),
            // so 'this' is the EditorView. self.editorView is null during construction
            // because ySyncPlugin fires a dispatch synchronously in new EditorView().
            var view = self.editorView || this;
            var newState = view.state.apply(tr);
            view.updateState(newState);
            if (tr.docChanged) {
              console.log('[PostCardEditor] docChanged steps:', tr.steps.length,
                'content:', JSON.stringify(newState.doc.toJSON()).slice(0, 120));
              self._markEdited();
            }
            self._updateToolbarState();
            self._updateLinkPreview();
          },
        });
        this._updateToolbarState();
        this._updateLinkPreview();
      },

      // Syntax-highlights code_block content via inline Decorations rather
      // than a NodeView — code_block's content is real editable text
      // (unlike the atomic math/embed nodes), so we can't just replace its
      // DOM; decorations let highlight.js's classes render on top of the
      // exact same ProseMirror-managed text without touching editability.
      // Re-highlights on every doc change (recomputing per code_block on
      // each keystroke is cheap at postcard-sized documents).
      _buildHighlightPlugin: function (prosemirror) {
        var Plugin = prosemirror.state.Plugin;
        var PluginKey = prosemirror.state.PluginKey;
        var Decoration = prosemirror.view.Decoration;
        var DecorationSet = prosemirror.view.DecorationSet;
        // props.decorations is called as a plain function (view.someProp does
        // `f(view.state)`, not `f.call(plugin, ...)`), so `this` inside it is
        // NOT the plugin instance — read state via a closed-over PluginKey
        // instead of `this.getState(...)`.
        var key = new PluginKey('postcardHighlight');

        function highlightCodeBlock(pos, text) {
          var hljs = (typeof window !== 'undefined' && window.hljs) || null;
          if (!hljs || !text) return [];
          var result;
          try { result = hljs.highlightAuto(text); } catch (e) { return []; }
          // hljs's output is the same text wrapped in nested <span class="hljs-...">
          // — walk it to recover flat (start, end, classes) ranges over the
          // original plain-text offsets (pos+1 is the first character inside
          // the node, per ProseMirror's position convention).
          var container = document.createElement('div');
          container.innerHTML = result.value;
          var decos = [];
          var offset = 0;
          function walk(domNode, classes) {
            if (domNode.nodeType === 3) {
              var len = domNode.nodeValue.length;
              if (classes.length) {
                decos.push(Decoration.inline(pos + 1 + offset, pos + 1 + offset + len,
                  { class: classes.join(' ') }));
              }
              offset += len;
              return;
            }
            if (domNode.nodeType === 1) {
              var childClasses = domNode.className ? classes.concat(domNode.className.split(' ')) : classes;
              for (var i = 0; i < domNode.childNodes.length; i++) walk(domNode.childNodes[i], childClasses);
            }
          }
          for (var i = 0; i < container.childNodes.length; i++) walk(container.childNodes[i], []);
          return decos;
        }

        return new Plugin({
          key: key,
          state: {
            init: function (_config, state) { return computeDecorations(state); },
            apply: function (tr, old, _oldState, newState) {
              return tr.docChanged ? computeDecorations(newState) : old;
            },
          },
          props: {
            decorations: function (state) { return key.getState(state); },
          },
        });

        function computeDecorations(state) {
          var decos = [];
          state.doc.descendants(function (node, pos) {
            if (node.type.name !== 'code_block') return;
            decos = decos.concat(highlightCodeBlock(pos, node.textContent));
          });
          return DecorationSet.create(state.doc, decos);
        }
      },

      // NodeView for math_inline/math_display (§10.1): renders via KaTeX when
      // not selected, swaps to a plain input/textarea for editing the LaTeX
      // source when selected — the standard prosemirror-math interaction.
      // Shared by both math node types; node.type.name picks displayMode.
      _mathNodeView: function (node, view, getPos) {
        var isDisplay = node.type.name === 'math_display';
        var dom = document.createElement(isDisplay ? 'div' : 'span');
        dom.className = 'lively-math-node ' + (isDisplay ? 'math-display' : 'math-inline');
        var editing = false;
        var input = null;

        function render() {
          dom.innerHTML = '';
          dom.classList.remove('lively-math-error', 'lively-math-empty');
          if (!node.attrs.value) {
            dom.classList.add('lively-math-empty');
            dom.textContent = isDisplay ? '∑ (click to edit)' : '∑';
            return;
          }
          var katex = (typeof window !== 'undefined' && window.katex) || null;
          if (!katex) { dom.textContent = node.attrs.value; return; }
          try {
            katex.render(node.attrs.value, dom, { throwOnError: true, displayMode: isDisplay });
          } catch (e) {
            dom.textContent = node.attrs.value;
            dom.classList.add('lively-math-error');
            dom.title = e.message;
          }
        }

        function commit() {
          if (!editing) return;
          editing = false;
          var value = input ? input.value : node.attrs.value;
          input = null;
          if (value === node.attrs.value) return render();
          var pos = typeof getPos === 'function' ? getPos() : null;
          if (pos === null || pos === undefined) return render();
          view.dispatch(view.state.tr.setNodeMarkup(pos, null,
            Object.assign({}, node.attrs, { value: value })));
        }

        function startEditing() {
          if (editing) return;
          editing = true;
          dom.innerHTML = '';
          input = document.createElement(isDisplay ? 'textarea' : 'input');
          input.className = 'lively-math-input';
          input.value = node.attrs.value || '';
          input.addEventListener('mousedown', function (e) { e.stopPropagation(); });
          input.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Escape' || (e.key === 'Enter' && !isDisplay)) {
              e.preventDefault();
              commit();
              view.focus();
            }
          });
          input.addEventListener('blur', function () { commit(); });
          dom.appendChild(input);
          input.focus();
        }

        // Click-to-edit only — NOT tied to selectNode(). A NodeSelection can
        // land on this node for reasons that have nothing to do with wanting
        // to edit it (Backspace's "select before delete" step, arrow-key
        // navigation stepping past it) — auto-entering edit mode from
        // selectNode() hijacked that native focus, which broke both the
        // normal "select, then Backspace again to delete" flow (the second
        // Backspace just edited the LaTeX text instead of removing the node)
        // and made arrow-keying past a formula look like it randomly
        // switched to a raw-text rendering glitch.
        dom.addEventListener('mousedown', function (e) {
          if (editing) return; // let the input's own mousedown handler run
          e.preventDefault();
          startEditing();
        });

        // A freshly-inserted node (the toolbar's ∑ button creates one with
        // value:'') needs to be immediately typeable — otherwise the very
        // next keystroke lands on a NodeSelection over an atomic node, which
        // ProseMirror treats as "replace the selection," deleting the node
        // and leaving plain typed text behind (looks like the formula
        // "disappeared"). Existing non-empty formulas never hit this path
        // (their NodeView is reused via update(), not reconstructed), so
        // this doesn't reintroduce the selectNode()-auto-edit bug above.
        if (!node.attrs.value) startEditing();
        else render();

        return {
          dom: dom,
          update: function (newNode) {
            if (newNode.type !== node.type) return false;
            node = newNode;
            if (!editing) render();
            return true;
          },
          selectNode: function () { dom.classList.add('lively-math-selected'); },
          deselectNode: function () { dom.classList.remove('lively-math-selected'); commit(); },
          stopEvent: function () { return editing; },
          ignoreMutation: function () { return true; },
        };
      },

      // Makes the view read-only for non-owners: a shared/public card opened
      // by anyone but its author (PUT is owner-only server-side regardless,
      // see IdentityServer.js). Strips the toolbar down to a plain label
      // rather than leaving Save/Send/visibility controls that would just
      // 403 or make no sense for someone who isn't the owner.
      _applyReadOnlyMode: function () {
        if (this._isOwner && !this._forceReadOnly) return;
        if (this.editorView) {
          this.editorView.setProps({ editable: function () { return false; } });
        }
        if (this._toolbarDiv) {
          this._toolbarDiv.innerHTML = '';
          this._toolbarDiv.style.cssText = [
            'position:absolute', 'top:0', 'left:0', 'right:0', 'height:28px',
            'background:#f0f0f5', 'border-bottom:1px solid #ccc',
            'box-sizing:border-box', 'display:flex', 'align-items:center',
            'padding:0 10px',
          ].join(';');
          var label = document.createElement('span');
          label.style.cssText = 'font-size:11px;color:#888;font-family:sans-serif;';
          label.textContent = 'Read-only — shared by @' + (this._handle || '');
          this._toolbarDiv.appendChild(label);
        }
        if (this._footerDiv) this._footerDiv.style.display = 'none';
        if (this._pmContainer) {
          this._pmContainer.style.top = '28px';
          this._pmContainer.style.bottom = '0';
        }
      },

      // Connects to PostCardSyncServer via WebsocketProvider for live collaboration.
      // Gracefully degrades if y-websocket is unavailable.
      _connectSync: function () {
        if (!this._objId) return; // no sync until first save establishes objId

        var WebsocketProvider = this._WebsocketProvider();
        if (!WebsocketProvider) {
          console.warn('[PostCardEditor] WebsocketProvider not loaded — live sync disabled');
          return;
        }

        // PostCardSyncServer runs on its own standalone port (must be
        // separately reachable over TLS wherever this app is deployed).
        // wss: required whenever the page itself is https: — browsers
        // block insecure ws: connections from a secure page.
        var syncPort = (typeof window !== 'undefined' && window.POSTCARD_SYNC_PORT) || 1234;
        var wsScheme = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
        var wsUrl = wsScheme + '//' + location.hostname + ':' + syncPort;
        try {
          this.wsProvider = new WebsocketProvider(wsUrl, this._objId, this.yDoc, { connect: true });
          this.wsProvider.on('status', function (event) {
            console.log('[PostCardEditor] sync status:', event.status);
          });
        } catch (e) {
          console.warn('[PostCardEditor] Failed to start WebSocket sync (non-fatal):', e.message);
        }
      },

    },

    // ─── auto-save ────────────────────────────────────────────────────────────────

    'autosave', {

      _scheduleSave: function () {
        if (!this._userHasEdited) return; // skip ySyncPlugin init transaction
        var self = this;
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(function () { self._saveNow(); }, 2000);
        this._setStatus('…');
      },

      _markEdited: function () {
        // Belt-and-suspenders: _applyReadOnlyMode already makes the
        // ProseMirror view non-editable for non-owners, so this shouldn't
        // fire from real user input, but PUT is owner-only server-side
        // regardless — no reason to ever schedule a save that can only 403.
        if (!this._isOwner || this._forceReadOnly) return;
        this._userHasEdited = true;
        this._scheduleSave();
      },

      // callback: optional (err) — invoked after PUT completes/fails, in
      // addition to the normal status-line feedback. Used by _doSend to wait
      // for a reseal-save to finish before notifying the recipient.
      _saveNow: function (callback) {
        clearTimeout(this._saveTimer);
        var cb = callback || function () {};
        var user = lively.identity.did.currentUser();
        if (!user) { this._setStatus('Not signed in'); return cb(new Error('Not signed in')); }
        if (!this.yDoc) { this._setStatus('No document'); return cb(new Error('No document')); }

        if (this._visibility === 'public') return this._saveNowPublic(user, cb);
        this._saveNowPrivate(user, cb);
      },

      _saveNowPublic: function (user, callback) {
        var self = this;
        var cb = callback || function () {};
        var locationMeta = this._locationStateMeta();
        var params = {
          yDoc:          this.yDoc,
          prevEnvelope:  this._envelope || null,
          constellation: this._constellation,
          replyTo:       this._replyTo,
          visibility:    'public',
          attachments:   this._attachments || [],
          // title omitted — PostCardSerializer extracts it from the first PM block (§10.5)
        };
        if (locationMeta) params.stateMeta = locationMeta;
        this._setStatus('Saving…');
        lively.identity.postCardSerializer.serializeToEnvelope(params, function (err, envelope) {
          self._finishSave(err, envelope, cb);
        });
      },

      // Private/shared save: cache the KEK for this session (one WebAuthn
      // prompt), re-resolve every recipient's current public key (their key
      // may have changed since the last save, and serializeEncrypted always
      // reseals a fresh DEK for the full recipient list — there is no
      // persistent DEK across versions), then encrypt.
      _saveNowPrivate: function (user, callback) {
        var self = this;
        var cb = callback || function () {};
        var wa = lively.identity.webAuthn;
        this._setStatus('Saving…');

        function withKek(cb2) {
          if (wa._kekCache && wa._kekCache[user.credentialId]) return cb2(null);
          self._setStatus('Confirm passkey…');
          var ch = new Uint8Array(32);
          crypto.getRandomValues(ch);
          wa.deriveKek({ credentialId: user.credentialId, challenge: ch }, function (err) { cb2(err); });
        }

        withKek(function (err) {
          if (err) {
            console.error('[PostCardEditor] deriveKek error:', err.message);
            self._setStatus('Error (passkey)');
            return cb(err);
          }
          self._resolveRecipientPubKeys(self._recipientHandles, function (_e, result) {
            if (result.failed.length) {
              console.warn('[PostCardEditor] Dropping recipient(s) with no published key from this save:', result.failed.join(', '));
            }
            var params = {
              yDoc:          self.yDoc,
              prevEnvelope:  self._envelope || null,
              constellation: self._constellation,
              replyTo:       self._replyTo,
              recipients:    result.resolved.map(function (r) {
                return { did: r.did, x25519PublicKey: r.x25519PublicKey };
              }),
              attachments: self._attachments || [],
              stateMeta: Object.assign(
                { recipientHandles: result.resolved.map(function (r) { return r.handle; }) },
                self._locationStateMeta()
              ),
            };
            lively.identity.postCardSerializer.serializeEncrypted(params, function (err, envelope) {
              self._finishSave(err, envelope, cb);
            });
          });
        });
      },

      // Resolve each handle to { did, handle, x25519PublicKey }, cached
      // per-session so repeated autosaves of a shared card don't refetch
      // every recipient's profile on every 2s debounce tick. Cache entries
      // expire after RECIPIENT_KEY_CACHE_TTL_MS so a key rotated by a
      // recipient mid-session is eventually picked up rather than never
      // (postcard-audit F25) — long enough to still absorb the debounce
      // storm, short enough to not go stale for an editor left open a while.
      // Calls thenDo(null, { resolved: [...], failed: [handle, ...] }).
      _resolveRecipientPubKeys: function (handles, thenDo) {
        var self = this;
        if (!handles || !handles.length) return thenDo(null, { resolved: [], failed: [] });
        if (!this._recipientPubKeyCache) this._recipientPubKeyCache = {};

        var base = lively.identity.did.baseUrl();
        var resolved = [];
        var failed = [];
        var remaining = handles.length;
        var now = Date.now();

        function done() {
          if (--remaining === 0) thenDo(null, { resolved: resolved, failed: failed });
        }

        handles.forEach(function (handle) {
          var cached = self._recipientPubKeyCache[handle];
          if (cached && (now - cached.at) < RECIPIENT_KEY_CACHE_TTL_MS) {
            resolved.push(cached.entry);
            return done();
          }

          lively.identity.webKey.resolveHandle(handle, function (err, info) {
            if (err || !info || !info.did) { failed.push(handle); return done(); }
            var xhr = new XMLHttpRequest();
            xhr.open('GET', base + '/@' + encodeURIComponent(handle) + '/profile', true);
            xhr.withCredentials = true;
            xhr.onload = function () {
              if (xhr.status !== 200) { failed.push(handle); return done(); }
              var env;
              try { env = JSON.parse(xhr.responseText); } catch (e) { failed.push(handle); return done(); }
              var pub = env.record && env.record.payload && env.record.payload.accountX25519Pub;
              if (!pub) { failed.push(handle); return done(); }

              // Integrity check (postcard-audit F22): every other envelope
              // consumer in this codebase verifies record.cid before trusting
              // record.payload; this was the one that didn't, despite the
              // payload feeding straight into who a DEK gets sealed to. This
              // only catches accidental corruption / a CID that doesn't match
              // its own payload — it does not by itself prove the payload is
              // the real recipient's, since a malicious server can compute a
              // matching CID for a substituted payload too. Full protection
              // needs signature verification against the recipient's
              // delegated device key (see the envelope-signing added in
              // RegisterDialog.js/UserSpace.js), which isn't wired up yet —
              // tracked as the F20/F22 verifier follow-up.
              lively.identity.crypto.computeCid(env.record.payload, function (cidErr, expectedCid) {
                if (cidErr || expectedCid !== env.record.cid) {
                  console.warn('[PostCardEditor] Profile envelope for @' + handle +
                    ' failed CID integrity check — refusing to seal to its accountX25519Pub');
                  failed.push(handle);
                  return done();
                }
                var entry = { did: info.did, handle: handle, x25519PublicKey: pub };
                self._recipientPubKeyCache[handle] = { entry: entry, at: Date.now() };
                resolved.push(entry);
                done();
              });
            };
            xhr.onerror = function () { failed.push(handle); done(); };
            xhr.send();
          });
        });
      },

      _finishSave: function (err, envelope, callback) {
        var self = this;
        var cb = callback || function () {};
        if (err) {
          console.error('[PostCardEditor] serialize error:', err && (err.message || String(err)));
          self._setStatus('Error');
          return cb(err);
        }
        self._putEnvelope(envelope, function (putErr) {
          if (putErr) {
            console.error('[PostCardEditor] PUT error:', putErr && (putErr.message || String(putErr)));
            self._setStatus('Error');
            return cb(putErr);
          }
          self._envelope = envelope;
          self._objId = envelope.objId;
          self._recipientHandles = (envelope.state && envelope.state.recipientHandles) || self._recipientHandles;
          self._locationCode = (envelope.state && envelope.state.location) || null;
          self._locationCleared = false;
          self._updateLocationBtn();
          self._updateVisibilityBtn();
          // If this was a new card, wire up sync now that we have an objId
          if (self._isNew) {
            self._isNew = false;
            self._connectSync();
          }
          self._setStatus('Saved');
          cb(null);
        });
      },

      _putEnvelope: function (envelope, callback) {
        var base = lively.identity.did.baseUrl();
        var url = base + '/@' + encodeURIComponent(this._handle) + '/' + encodeURIComponent(envelope.objId);
        console.log('[PostCardEditor] PUT', url, 'objId:', envelope.objId);
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status === 200 || xhr.status === 201) return callback(null);
          console.error('[PostCardEditor] PUT failed', xhr.status, xhr.responseText.slice(0, 300));
          callback(new Error('PUT failed: ' + xhr.status));
        };
        xhr.onerror = function () {
          console.error('[PostCardEditor] PUT network error');
          callback(new Error('Network error'));
        };
        xhr.send(JSON.stringify(envelope));
      },

    },

    // ─── constellation posting ──────────────────────────────────────────────────
    // "Post to a constellation": tags this card with that constellation (so
    // it shows in its feed, same field the original constellation stub
    // routes already read) and places it in the constellation's live space
    // at a default position — server-side, see POST /c/:name/posts.

    'constellation', {

      _promptPostToConstellation: function () {
        var self = this;
        if (!this._objId) {
          this._setStatus('Save first');
          return;
        }
        var name = window.prompt('Post to which constellation? (must be a member)');
        if (!name) return;

        var objId = this._objId;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open('POST', base + '/c/' + encodeURIComponent(name) + '/posts', true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
          if (xhr.status === 200) {
            self._setStatus('Posted to ' + name);
            return;
          }
          var msg = 'Post failed (' + xhr.status + ')';
          try {
            var body = JSON.parse(xhr.responseText);
            if (body && body.error) msg = body.error;
          } catch (e) {}
          self._setStatus(msg);
          console.error('[PostCardEditor] post-to-constellation failed:', msg);
        };
        xhr.onerror = function () { self._setStatus('Network error'); };
        xhr.send(JSON.stringify({ objId: objId }));
      },

    },

    // ─── send ─────────────────────────────────────────────────────────────────────
    // Per spec §2.3, sending = grant access (reseal the DEK to include the
    // recipient, for private/shared cards) + POST /@:handle/inbox to notify
    // them. A public card just gets the notify — anyone can already read it.

    'send', {

      _promptAndSend: function () {
        if (this._sendPanel) { this._sendPanel.remove(); this._sendPanel = null; return; }
        var self = this;
        var shapeNode = this.renderContext().shapeNode;

        var panel = document.createElement('div');
        panel.style.cssText = [
          'position:absolute', 'top:40px', 'right:4px', 'width:220px',
          'background:#fff', 'border:1px solid #ccc', 'border-radius:6px',
          'box-shadow:0 4px 12px rgba(0,0,0,0.18)', 'padding:10px',
          'z-index:1000', 'box-sizing:border-box', 'font-family:sans-serif',
        ].join(';');

        var label = document.createElement('div');
        label.textContent = this._visibility === 'public' ? 'Send to @handle' : 'Share & send to @handle';
        label.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:6px;color:#333;';
        panel.appendChild(label);

        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'handle (no @)';
        input.style.cssText = 'width:100%;box-sizing:border-box;font-size:12px;padding:4px 6px;border:1px solid #ccc;border-radius:3px;margin-bottom:6px;';
        panel.appendChild(input);

        var msg = document.createElement('div');
        msg.style.cssText = 'font-size:11px;color:#999;min-height:14px;margin-bottom:6px;';
        panel.appendChild(msg);

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'font-size:11px;padding:4px 10px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;';
        cancelBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          panel.remove();
          self._sendPanel = null;
        });
        btnRow.appendChild(cancelBtn);

        // Live encryption-status hint as the handle is typed, for private/shared
        // cards only — surfaces "hasn't set up encryption yet" up front rather
        // than only after a failed Send attempt (the failure path below still
        // applies as a safety net; this is purely informational and doesn't
        // block clicking Send).
        var checkTimer = null;
        if (this._visibility !== 'public') {
          input.addEventListener('input', function () {
            clearTimeout(checkTimer);
            var handle = input.value.trim().replace(/^@/, '');
            if (!handle) { msg.textContent = ''; return; }
            msg.textContent = 'Checking…';
            msg.style.color = '#999';
            checkTimer = setTimeout(function () {
              lively.identity.webKey.resolveHandle(handle, function (err, info) {
                if (input.value.trim().replace(/^@/, '') !== handle) return; // stale — input changed since
                if (err || !info || !info.did) {
                  msg.textContent = 'Handle not found';
                  msg.style.color = '#c33';
                  return;
                }
                self._resolveRecipientPubKeys([handle], function (_e, result) {
                  if (input.value.trim().replace(/^@/, '') !== handle) return; // stale
                  if (result.resolved.length) {
                    msg.textContent = '🔒 can receive encrypted cards';
                    msg.style.color = '#2a2';
                  } else {
                    msg.textContent = "🔓 hasn't set up encryption yet";
                    msg.style.color = '#c60';
                  }
                });
              });
            }, 400);
          });
        }

        var sendBtn = document.createElement('button');
        sendBtn.textContent = 'Send';
        sendBtn.style.cssText = 'font-size:11px;padding:4px 10px;cursor:pointer;border:1px solid #5a5;border-radius:3px;background:#efe;';
        function submit() {
          var handle = input.value.trim().replace(/^@/, '');
          if (!handle) { msg.textContent = 'Enter a handle'; msg.style.color = '#c33'; return; }
          sendBtn.disabled = true;
          msg.textContent = 'Sending…';
          msg.style.color = '#888';
          self._doSend(handle, function (err, result) {
            sendBtn.disabled = false;
            if (err) { msg.textContent = err.message || 'Failed'; msg.style.color = '#c33'; return; }
            if (result && result.returned) {
              msg.textContent = 'Not delivered (blocked, or handle unknown)';
              msg.style.color = '#c33';
              return;
            }
            msg.textContent = 'Sent to @' + handle;
            msg.style.color = '#2a2';
            self._updateVisibilityBtn();
            setTimeout(function () {
              if (self._sendPanel === panel) { panel.remove(); self._sendPanel = null; }
            }, 1200);
          });
        }
        sendBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          submit();
        });
        btnRow.appendChild(sendBtn);
        panel.appendChild(btnRow);

        ['keydown', 'keyup', 'keypress', 'mousedown', 'mousemove', 'mouseup', 'click'].forEach(function (t) {
          panel.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') submit();
        });

        shapeNode.appendChild(panel);
        this._sendPanel = panel;
        input.focus();
      },

      // thenDo(err, result) — result is the inbox POST's JSON body
      // ({ok:true, delivered:true} or the POSTAL_REJECTION shape).
      _doSend: function (handle, thenDo) {
        var self = this;
        if (!this._objId) return thenDo(new Error('Save the card before sending'));

        lively.identity.webKey.resolveHandle(handle, function (err, info) {
          if (err || !info || !info.did) return thenDo(new Error('Handle not found: @' + handle));

          if (self._visibility === 'public') {
            return self._postInbox(handle, thenDo);
          }

          // Private/shared: preflight-check the recipient can actually
          // receive encrypted content before doing a full autosave + reseal
          // of every existing recipient just to find out they can't. The
          // post-save check below stays as a safety net (their key could in
          // principle stop resolving between this check and the save).
          self._resolveRecipientPubKeys([handle], function (_e, preflight) {
            if (preflight.failed.length) {
              return thenDo(new Error("@" + handle + " hasn't set up encryption yet — cannot share with them."));
            }

            // Grant access — add as a recipient (if not already one) and
            // reseal, then notify once that's landed.
            if (self._recipientHandles.indexOf(handle) === -1) {
              self._recipientHandles = self._recipientHandles.concat([handle]);
            }
            self._saveNow(function (saveErr) {
              if (saveErr) return thenDo(saveErr);
              // _saveNow -> _finishSave refreshes _recipientHandles from the
              // envelope actually stored. If the handle isn't in it, their key
              // couldn't be resolved and they were silently dropped from
              // record.recipients (see _resolveRecipientPubKeys) — don't
              // notify someone who was never actually granted access, or
              // they'd see the card in their inbox and hit a 403 opening it.
              if (self._recipientHandles.indexOf(handle) === -1) {
                return thenDo(new Error("@" + handle + " hasn't set up encryption yet — cannot share with them."));
              }
              // §6: sync each attachment's own transport ACL to the new
              // recipient too — non-fatal, see _grantAttachmentsAccess.
              self._grantAttachmentsAccess(handle, function () {
                self._postInbox(handle, thenDo);
              });
            });
          });
        });
      },

      _postInbox: function (handle, thenDo) {
        var base = lively.identity.did.baseUrl();
        var url = base + '/@' + encodeURIComponent(handle) + '/inbox';
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { result = null; }
          if (xhr.status !== 200) {
            return thenDo(new Error('Send failed: ' + xhr.status));
          }
          thenDo(null, result);
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send(JSON.stringify({ objId: this._objId }));
      },

    },

    // ─── embedded parts (§6, §10.8) ─────────────────────────────────────────────────
    // Insert-part toolbar button opens a picker over the user's own
    // identity-aware parts (lively.identity.IdentityPartsSpace) — never
    // classic WebDAV PartsBin. Embeds default to pinned (§6.2).

    'embeds', {

      _openPartsPicker: function () {
        if (this._partsPanel) { this._partsPanel.remove(); this._partsPanel = null; return; }
        var self = this;
        var shapeNode = this.renderContext().shapeNode;

        var panel = document.createElement('div');
        panel.style.cssText = [
          'position:absolute', 'top:40px', 'right:4px', 'width:240px',
          'background:#fff', 'border:1px solid #ccc', 'border-radius:6px',
          'box-shadow:0 4px 12px rgba(0,0,0,0.18)', 'padding:10px',
          'z-index:1000', 'box-sizing:border-box', 'font-family:sans-serif',
        ].join(';');

        var label = document.createElement('div');
        label.textContent = 'Insert part';
        label.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:6px;color:#333;';
        panel.appendChild(label);

        var listDiv = document.createElement('div');
        listDiv.style.cssText = 'max-height:220px;overflow-y:auto;margin-bottom:6px;font-size:12px;color:#888;';
        listDiv.textContent = 'Loading…';
        panel.appendChild(listDiv);

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'font-size:11px;padding:4px 10px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;float:right;';
        cancelBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          panel.remove();
          self._partsPanel = null;
        });
        panel.appendChild(cancelBtn);

        ['keydown', 'keyup', 'keypress', 'mousedown', 'mousemove', 'mouseup', 'click'].forEach(function (t) {
          panel.addEventListener(t, function (e) { e.stopPropagation(); });
        });

        shapeNode.appendChild(panel);
        this._partsPanel = panel;

        if (typeof lively === 'undefined' || !lively.require) {
          listDiv.textContent = 'Lively module system not available';
          return;
        }
        lively.require('lively.identity.UserSpace').toRun(function () {
          lively.identity.userSpace.getPersonalPartsSpace(function (spaceErr, space) {
            if (spaceErr) { listDiv.textContent = 'Error: ' + spaceErr.message; return; }
            space.load(function (loadErr) {
              if (loadErr) { listDiv.textContent = 'Error: ' + loadErr.message; return; }
              var items = space.getPartItems();
              listDiv.textContent = '';
              if (!items.length) {
                listDiv.textContent = 'No parts yet — right-click a morph and choose "Save to My Parts" first.';
                return;
              }
              items.forEach(function (item) {
                var meta = item.loadedMetaInfo;
                var row = document.createElement('div');
                row.textContent = (meta && meta.partName) || item.name;
                if (meta && meta.comment) row.title = meta.comment;
                row.style.cssText = 'padding:4px 6px;cursor:pointer;border-radius:3px;color:#333;';
                row.addEventListener('mouseenter', function () { row.style.background = '#eef'; });
                row.addEventListener('mouseleave', function () { row.style.background = ''; });
                row.addEventListener('mousedown', function (e) {
                  e.preventDefault(); e.stopPropagation();
                  self._insertPartEmbed(item);
                  panel.remove();
                  self._partsPanel = null;
                });
                listDiv.appendChild(row);
              });
            });
          });
        });
      },

      // Inserts an embeddedPart node pinned to the part's current cid (§6.2
      // default). item is an IdentityPartItem with .envelope already loaded
      // (IdentityPartsSpace.load populates this synchronously from ObjectStore).
      _insertPartEmbed: function (item) {
        if (!this.editorView) return;
        var envelope = item.envelope;
        if (!envelope || !envelope.record) return;
        var view = this.editorView;
        var state = view.state;
        var nodeType = state.schema.nodes.embeddedPart;
        if (!nodeType) return;
        var user = lively.identity.did.currentUser();
        var node = nodeType.create({
          objId: envelope.objId,
          cid: envelope.record.cid,
          handle: user && user.handle,
          embedId: this._generateEmbedId(),
        });
        view.dispatch(state.tr.replaceSelectionWith(node));
        view.focus();
      },

      _generateEmbedId: function () {
        return 'embed-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      },

      // NodeView for embeddedPart (§6, §10.8). Parts are Lively Morphs, and
      // this editor already runs inside a live Morphic world — so unlike
      // Wave's gadget iframes, a part can be deserialized and mounted
      // directly into the same DOM/JS realm, no cross-frame bridge needed.
      // `dom` (returned to ProseMirror) wraps a separate `contentDiv` so the
      // pinned/live overlay (appended to `dom`) survives contentDiv reloads.
      _embeddedPartNodeView: function (node, view, getPos) {
        var self = this;
        var destroyed = false;

        var dom = document.createElement('div');
        dom.className = 'lively-embedded-part-node';
        var contentDiv = document.createElement('div');
        contentDiv.className = 'lively-embedded-part-content';
        dom.appendChild(contentDiv);

        function showError(msg) {
          contentDiv.innerHTML = '';
          contentDiv.classList.add('lively-embed-error');
          contentDiv.textContent = msg;
        }

        function fetchAndRender(currentNode) {
          contentDiv.innerHTML = '';
          contentDiv.classList.remove('lively-embed-error');
          contentDiv.textContent = 'Loading part…';
          var handle = currentNode.attrs.handle;
          var objId = currentNode.attrs.objId;
          var cid = currentNode.attrs.cid;
          if (!handle || !objId) { showError('Embed missing objId/handle'); return; }
          var base = lively.identity.did.baseUrl();
          var url = base + '/@' + encodeURIComponent(handle) + '/' + encodeURIComponent(objId) +
            (cid ? ('/at/' + encodeURIComponent(cid)) : '');
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.setRequestHeader('Accept', 'application/json');
          xhr.withCredentials = true;
          xhr.onload = function () {
            if (destroyed) return;
            if (xhr.status === 404) { showError(cid ? 'This part was removed.' : 'Part not found.'); return; }
            if (xhr.status !== 200) { showError('Failed to load part: HTTP ' + xhr.status); return; }
            var envelope;
            try { envelope = JSON.parse(xhr.responseText); } catch (e) { showError('Invalid part data'); return; }
            renderMorphFromEnvelope(envelope);
          };
          xhr.onerror = function () { if (!destroyed) showError('Network error loading part'); };
          xhr.send();
        }

        function renderMorphFromEnvelope(envelope) {
          if (typeof lively === 'undefined' || !lively.identity || !lively.identity.IdentityPartsSpace) {
            showError('Parts module not loaded'); return;
          }
          if (envelope.type !== 'part' || !envelope.record) { showError('Not a part envelope'); return; }
          var space = new lively.identity.IdentityPartsSpace(node.attrs.handle, null);
          var item = space.createPartItemFromEnvelope(envelope);
          if (!item) { showError('Missing partName in embedded object'); return; }
          item.loadPart(false, false, envelope.record.cid, function (err, part) {
            if (destroyed) return;
            if (err || !part) {
              showError('Could not render part: ' + ((err && err.message) || 'unknown error'));
              return;
            }
            contentDiv.innerHTML = '';
            var partDom = part.renderContext && part.renderContext().shapeNode;
            if (partDom) contentDiv.appendChild(partDom);
            else { showError('Part has no renderable content'); return; }
            if (typeof part.onPostCardEmbed === 'function') {
              part.onPostCardEmbed(self._embedStateApi(node.attrs.embedId));
            }
          });
        }

        fetchAndRender(node);

        return {
          dom: dom,
          update: function (newNode) {
            if (newNode.type !== node.type) return false;
            var changed = newNode.attrs.cid !== node.attrs.cid || newNode.attrs.objId !== node.attrs.objId;
            node = newNode;
            if (changed) fetchAndRender(node);
            return true;
          },
          selectNode: function () { self._showEmbedOverlay(dom, node, view, getPos); },
          deselectNode: function () { self._hideEmbedOverlay(dom); },
          destroy: function () { destroyed = true; },
          ignoreMutation: function () { return true; },
        };
      },

      // NodeView for the image node (Encryption.md §6). Attachments uploaded
      // via FileCrypto never carry a real, permanently-fetchable src for a
      // private/shared postcard (its blob is encrypted) — this resolves the
      // node's objId to a decrypted, session-local blob: URL asynchronously
      // and swaps it into the DOM directly, WITHOUT ever touching
      // node.attrs/dispatching a transaction. That distinction matters: this
      // node is synced via y-prosemirror, so a dispatched change would push
      // a transient, per-browser blob: URL into the shared Y.Doc and even
      // persist it on next save — a bug, not a feature. A node with a real
      // src already (public attachment, or a pre-Phase-2 legacy one) just
      // renders it directly, same as plain toDOM.
      _attachmentImageNodeView: function (node, view, getPos) {
        var self = this;
        var destroyed = false;
        var img = document.createElement('img');
        img.className = 'lively-postcard-image';

        function render(currentNode) {
          img.alt = currentNode.attrs.alt || '';
          if (currentNode.attrs.title) img.title = currentNode.attrs.title;
          img.classList.remove('lively-attachment-loading', 'lively-attachment-error');

          if (currentNode.attrs.src) {
            img.src = currentNode.attrs.src;
            return;
          }
          if (!currentNode.attrs.objId) return; // nothing to show

          img.classList.add('lively-attachment-loading');
          var entry = (self._attachments || []).find(function (a) { return a.objId === currentNode.attrs.objId; });
          if (!entry) {
            img.classList.remove('lively-attachment-loading');
            img.classList.add('lively-attachment-error');
            img.alt = 'Attachment data unavailable';
            return;
          }
          lively.identity.fileCrypto.resolveAttachmentUrl(self._handle, entry, function (err, url) {
            if (destroyed) return;
            img.classList.remove('lively-attachment-loading');
            if (err) {
              img.classList.add('lively-attachment-error');
              img.alt = 'Failed to load attachment';
              console.error('[PostCardEditor] attachment image resolve failed:', err);
              return;
            }
            img.src = url;
          });
        }

        render(node);

        return {
          dom: img,
          update: function (newNode) {
            if (newNode.type !== node.type) return false;
            var changed = newNode.attrs.objId !== node.attrs.objId || newNode.attrs.src !== node.attrs.src;
            node = newNode;
            if (changed) render(node);
            return true;
          },
          destroy: function () { destroyed = true; },
          ignoreMutation: function () { return true; },
        };
      },

      // Floating pinned/live toggle + remove button, shown while the embed
      // node is selected. Appended to the outer `dom` (not contentDiv) so a
      // content refetch never wipes it out from under an open overlay.
      _showEmbedOverlay: function (dom, node, view, getPos) {
        this._hideEmbedOverlay(dom);
        var self = this;
        var overlay = document.createElement('div');
        overlay.className = 'lively-embed-overlay';

        var toggleBtn = document.createElement('button');
        toggleBtn.textContent = node.attrs.cid ? '📌 Pinned' : '🔴 Live';
        toggleBtn.title = node.attrs.cid
          ? 'Pinned to a fixed version — click to make live (always shows latest)'
          : 'Live — always shows the latest version — click to pin to the current version';
        toggleBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._toggleEmbedPinning(node, view, getPos);
        });
        overlay.appendChild(toggleBtn);

        var removeBtn = document.createElement('button');
        removeBtn.textContent = '✕';
        removeBtn.title = 'Remove embed';
        removeBtn.className = 'lively-embed-remove-btn';
        removeBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          var pos = typeof getPos === 'function' ? getPos() : null;
          if (pos === null || pos === undefined) return;
          view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
          view.focus();
        });
        overlay.appendChild(removeBtn);

        dom.appendChild(overlay);
      },

      _hideEmbedOverlay: function (dom) {
        var existing = dom.querySelector && dom.querySelector('.lively-embed-overlay');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      },

      // Flip pinned <-> live (§6.2). Going live just drops cid; going pinned
      // re-resolves the part's current cid first, then sets it.
      _toggleEmbedPinning: function (node, view, getPos) {
        var pos = typeof getPos === 'function' ? getPos() : null;
        if (pos === null || pos === undefined) return;
        if (node.attrs.cid) {
          view.dispatch(view.state.tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, { cid: null })));
          return;
        }
        var base = lively.identity.did.baseUrl();
        var url = base + '/@' + encodeURIComponent(node.attrs.handle) + '/' + encodeURIComponent(node.attrs.objId);
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) { return; }
          if (!envelope.record || !envelope.record.cid) return;
          view.dispatch(view.state.tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, { cid: envelope.record.cid })));
        };
        xhr.send();
      },

      // Wraps a nested Y.Map at yDoc.getMap('partState').get(embedId) — the
      // per-embed shared state store (§10.8). Created lazily on first embed
      // render; playback replays it for free since it's part of the same
      // Yjs update blob as the rest of the document.
      _embedStateApi: function (embedId) {
        var Y = this._Y();
        if (!Y || !this.yDoc || !embedId) return null;
        var partStateMap = this.yDoc.getMap('partState');
        var embedMap = partStateMap.get(embedId);
        if (!(embedMap instanceof Y.Map)) {
          embedMap = new Y.Map();
          partStateMap.set(embedId, embedMap);
        }
        return {
          get: function (key) { return embedMap.get(key); },
          set: function (key, value) { embedMap.set(key, value); },
          observe: function (fn) {
            embedMap.observe(fn);
            return function () { embedMap.unobserve(fn); };
          },
        };
      },

    },

    // ─── toolbar commands ─────────────────────────────────────────────────────────

    'toolbar', {

      _execToolbarCmd: function (btnDef) {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var dispatch = view.dispatch.bind(view);
        var prosemirror = this._ProseMirror();
        if (!prosemirror) return;

        switch (btnDef.cmd) {
          case 'toggleMark': {
            var markType = state.schema.marks[btnDef.markType];
            if (!markType) return;
            prosemirror.commands.toggleMark(markType)(state, dispatch);
            break;
          }
          case 'setBlockType': {
            var nodeType = state.schema.nodes[btnDef.nodeType];
            if (!nodeType) return;
            prosemirror.commands.setBlockType(nodeType, btnDef.attrs)(state, dispatch);
            break;
          }
          case 'wrapInList': {
            var listNodeType = state.schema.nodes[btnDef.nodeType];
            if (!listNodeType) return;
            if (prosemirror.schemaList && prosemirror.schemaList.wrapInList) {
              prosemirror.schemaList.wrapInList(listNodeType)(state, dispatch);
            }
            break;
          }
          case 'wrapIn': {
            var wrapNodeType = state.schema.nodes[btnDef.nodeType];
            if (!wrapNodeType) return;
            prosemirror.commands.wrapIn(wrapNodeType)(state, dispatch);
            break;
          }
          case 'insertMath': {
            var mathNodeType = btnDef.mathType === 'display'
              ? state.schema.nodes.math_display
              : state.schema.nodes.math_inline;
            if (!mathNodeType) return;
            var mathNode = mathNodeType.create({ value: '' });
            dispatch(state.tr.replaceSelectionWith(mathNode));
            break;
          }
          case 'cycleAlign': {
            var alignOrder = ['left', 'center', 'right', 'justify'];
            var $ap = state.selection.$from;
            var alignNode = $ap.parent;
            if (alignNode.attrs.align === undefined) return;
            var nextAlign = alignOrder[(alignOrder.indexOf(alignNode.attrs.align) + 1) % alignOrder.length];
            dispatch(state.tr.setNodeMarkup($ap.before($ap.depth), null,
              Object.assign({}, alignNode.attrs, { align: nextAlign })));
            break;
          }
          case 'indent':
          case 'outdent': {
            var $ip = state.selection.$from;
            var indentNode = $ip.parent;
            if (indentNode.attrs.indent === undefined) return;
            var delta = btnDef.cmd === 'indent' ? 1 : -1;
            var nextIndent = Math.max(0, Math.min(8, (indentNode.attrs.indent || 0) + delta));
            dispatch(state.tr.setNodeMarkup($ip.before($ip.depth), null,
              Object.assign({}, indentNode.attrs, { indent: nextIndent })));
            break;
          }
          case 'clearFormatting': {
            var clearTr = state.tr;
            var from = state.selection.from, to = state.selection.to;
            Object.keys(state.schema.marks).forEach(function (name) {
              clearTr = clearTr.removeMark(from, to, state.schema.marks[name]);
            });
            dispatch(clearTr);
            break;
          }
          case 'link': {
            this._promptLink();
            break;
          }
          case 'attachment': {
            this._promptAttachment();
            break;
          }
          case 'insertPart': {
            if (this._openPartsPicker) this._openPartsPicker();
            else alert('Insert part — coming soon');
            break;
          }
        }
        view.focus();
      },

      // Insert/edit/remove a link mark over the current selection.
      _promptLink: function () {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var linkType = state.schema.marks.link;
        if (!linkType) return;
        var from = state.selection.from, to = state.selection.to;
        if (from === to) return; // requires a text selection
        var existingHref = null;
        state.doc.nodesBetween(from, to, function (node) {
          if (existingHref) return false;
          var mark = linkType.isInSet(node.marks || []);
          if (mark) existingHref = mark.attrs.href;
        });
        var href = window.prompt(
          existingHref ? 'Edit link URL (blank to remove):' : 'Link URL:',
          existingHref || 'https://'
        );
        if (href === null) return; // cancelled
        href = href.trim();
        var tr = state.tr.removeMark(from, to, linkType);
        if (href) tr = tr.addMark(from, to, linkType.create({ href: href }));
        view.dispatch(tr);
        view.focus();
      },

      // Encrypt-and-upload a file via FileCrypto, then insert a reference to
      // it at the cursor (§10.1's insert-attachment; Encryption.md §6 for
      // the encrypted-attachment design).
      _promptAttachment: function () {
        var self = this;
        var input = document.createElement('input');
        input.type = 'file';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          if (input.parentNode) input.parentNode.removeChild(input);
          if (file) self._uploadAttachment(file);
        });
        input.click();
      },

      // Attachment visibility/recipients mirror the postcard's own (§6) —
      // resolved fresh at upload time so a just-added recipient (this
      // session, not yet saved) still gets sealed in.
      _uploadAttachment: function (file) {
        var self = this;
        if (!this._handle) return;
        var isImage = /^image\//.test(file.type || '');

        function withRecipients(cb) {
          if (self._visibility === 'public' || !self._recipientHandles || !self._recipientHandles.length) {
            return cb([]);
          }
          self._resolveRecipientPubKeys(self._recipientHandles, function (_e, result) {
            cb(result.resolved.map(function (r) { return { did: r.did, x25519PublicKey: r.x25519PublicKey }; }));
          });
        }

        this._setStatus('Encrypting…');
        withRecipients(function (recipients) {
          lively.identity.fileCrypto.encryptAndUpload(file, {
            visibility: self._visibility,
            recipients: recipients,
            onWaiting: function () { self._setStatus('Confirm passkey…'); },
          }, function (err, result) {
            if (err) {
              self._setStatus('Upload failed');
              console.error('[PostCardEditor] attachment upload failed:', err);
              return;
            }
            var entry = {
              objId: result.objId,
              // dek travels inside the postcard's own encrypted payload
              // (§6) — base64url so it round-trips through JSON like every
              // other field there. null for a public card (blob already
              // plaintext, see FileCrypto.encryptAndUpload).
              dek: result.dek ? lively.identity.crypto.base64urlEncode(result.dek) : null,
              blobCid: result.blobCid,
              blobNonce: result.blobNonce,
              name: file.name,
              mime: file.type || 'application/octet-stream',
            };
            if (!self._attachments) self._attachments = [];
            self._attachments.push(entry);
            // Inserting the node/mark below dispatches a doc-changing
            // transaction, which dispatchTransaction already routes through
            // _markEdited/_scheduleSave — no separate save trigger needed.
            if (isImage) self._insertAttachmentImage(entry);
            else self._insertAttachmentLink(entry);
            self._setStatus('Uploaded');
          });
        });
      },

      // Image attachments render inline (§10.1) rather than as a text link.
      // A public attachment gets a real, permanently-fetchable src right
      // away (its blob is plaintext); a private/shared one gets an empty
      // src and relies on _attachmentImageNodeView to resolve+decrypt it
      // per-session (never baked into the synced doc — see that NodeView's
      // comment for why).
      _insertAttachmentImage: function (entry) {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var imageType = state.schema.nodes.image;
        if (!imageType) return;
        var src = entry.dek ? '' : this._publicBlobUrl(entry.blobCid);
        var node = imageType.create({ src: src, alt: entry.name, title: entry.name, objId: entry.objId });
        view.dispatch(state.tr.replaceSelectionWith(node));
        view.focus();
      },

      // Non-image files: a plain link carrying the attachment's objId.
      // Public gets a real href (see _insertAttachmentImage); private/shared
      // gets no href — clicking is intercepted by the editor's
      // handleDOMEvents.click and resolved on demand (see _openAttachment).
      _insertAttachmentLink: function (entry) {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var linkType = state.schema.marks.link;
        var from = state.selection.from;
        var text = '📎 ' + entry.name;
        var href = entry.dek ? '' : this._publicBlobUrl(entry.blobCid);
        var tr = state.tr.insertText(text, from);
        tr = tr.addMark(from, from + text.length, linkType.create({ href: href, title: entry.name, objId: entry.objId }));
        view.dispatch(tr);
        view.focus();
      },

      _publicBlobUrl: function (blobCid) {
        return lively.identity.did.baseUrl() + '/@' + encodeURIComponent(this._handle) + '/blobs/' + blobCid;
      },

      // Click handler target for a private/shared attachment link (§6):
      // resolve+decrypt via the dek embedded in the postcard's own payload,
      // then open it — no envelope round trip needed.
      _openAttachment: function (objId) {
        var self = this;
        var entry = (this._attachments || []).find(function (a) { return a.objId === objId; });
        if (!entry) return;
        this._setStatus('Decrypting…');
        lively.identity.fileCrypto.resolveAttachmentUrl(this._handle, entry, function (err, url) {
          if (err) {
            self._setStatus('Failed to open attachment');
            console.error('[PostCardEditor] attachment open failed:', err);
            return;
          }
          self._setStatus('');
          window.open(url, '_blank');
        });
      },

      // Sync each attachment's own file-envelope ACL to a newly-added
      // postcard recipient (§6) — non-fatal: the recipient already holds
      // every attachment's dek via the postcard payload itself once they can
      // decrypt the card, so a failed grant here only means a transient 403
      // on the blob route until the next save retries it (existing
      // grant-access route semantics; see IdentityServer.js).
      _grantAttachmentsAccess: function (recipientHandle, thenDo) {
        var attachments = this._attachments || [];
        var cb = thenDo || function () {};
        if (!attachments.length) return cb();
        var base = lively.identity.did.baseUrl();
        var remaining = attachments.length;
        attachments.forEach(function (a) {
          fetch(base + '/nodejs/IdentityServer/grant-access/' + encodeURIComponent(a.objId), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipientHandle: recipientHandle }),
          }).catch(function (e) {
            console.warn('[PostCardEditor] grant-access failed for attachment', a.objId, '(non-fatal):', e.message);
          }).then(function () {
            if (--remaining === 0) cb();
          });
        });
      },

    },

    // ─── playback ─────────────────────────────────────────────────────────────────

    'playback', {

      _openPlayback: function () {
        if (!this._objId) return alert('Save the card first before viewing history.');
        lively.identity.PostCardPlayback.openPlayback(this._handle, this._objId);
      },

    },

    // ─── helpers ─────────────────────────────────────────────────────────────────

    'helpers', {

      _Y: function () {
        return (typeof Y !== 'undefined' && Y) ||
               (typeof window !== 'undefined' && window.Y) ||
               null;
      },

      _ProseMirror: function () {
        // ProseMirror modules are typically exposed under window.PM or
        // a bundle namespace. Check common patterns.
        if (typeof window === 'undefined') return null;
        if (window.PM) return window.PM;
        // If modules loaded individually, assemble them
        var model   = window.ProsemirrorModel;
        var state   = window.ProsemirrorState;
        var view    = window.ProsemirrorView;
        var commands = window.ProsemirrorCommands;
        var keymap  = window.ProsemirrorKeymap;
        var history = window.ProsemirrorHistory;
        if (!model || !state || !view) return null;
        return { model, state, view, commands: commands || {}, keymap: keymap || {}, history: history || {} };
      },

      _yProsemirror: function () {
        return (typeof yProsemirror !== 'undefined' && yProsemirror) ||
               (typeof window !== 'undefined' && window.yProsemirror) ||
               null;
      },

      _WebsocketProvider: function () {
        return (typeof WebsocketProvider !== 'undefined' && WebsocketProvider) ||
               (typeof window !== 'undefined' && window.WebsocketProvider) ||
               null;
      },

      // Builds the PostCard ProseMirror schema: prose nodes + math + embeddedPart.
      _buildSchema: function (modelModule) {
        return new modelModule.Schema({
          nodes: {
            doc:          { content: 'block+' },
            // align/indent (§10.1): presentation-only paragraph attrs, not
            // separate node types — matches the same "decoration, not schema
            // constraint" reasoning §10.5 uses for the title styling.
            paragraph:    { group: 'block', content: 'inline*',
                            attrs: { align: { default: 'left' }, indent: { default: 0 } },
                            parseDOM: [{ tag: 'p', getAttrs: _parseAlignIndent }],
                            toDOM: function(n) { return ['p', _alignIndentAttrs(n), 0]; } },
            heading:      { group: 'block', content: 'inline*',
                            attrs: { level: { default: 1 }, align: { default: 'left' } },
                            parseDOM: [1,2,3,4,5,6].map(function(l) {
                              return { tag: 'h'+l, attrs: { level: l }, getAttrs: _parseAlignIndent };
                            }),
                            toDOM: function(n) {
                              var attrs = _alignIndentAttrs(n);
                              return ['h'+n.attrs.level, attrs, 0];
                            } },
            bullet_list:  { group: 'block', content: 'list_item+',
                            parseDOM: [{ tag: 'ul' }], toDOM: function() { return ['ul', 0]; } },
            ordered_list: { group: 'block', content: 'list_item+', attrs: { order: { default: 1 } },
                            parseDOM: [{ tag: 'ol' }], toDOM: function() { return ['ol', 0]; } },
            list_item:    { content: 'paragraph block*', attrs: { indent: { default: 0 } },
                            parseDOM: [{ tag: 'li', getAttrs: _parseAlignIndent }],
                            toDOM: function(n) { return ['li', _alignIndentAttrs(n), 0]; } },
            blockquote:   { group: 'block', content: 'block+',
                            parseDOM: [{ tag: 'blockquote' }], toDOM: function() { return ['blockquote', 0]; } },
            // class:'hljs' matches the bundled highlight.js theme's base
            // styling selector (background/text color) — the per-token
            // .hljs-keyword/.hljs-string/etc colors come from Decorations
            // (_buildHighlightPlugin), not from this node's own toDOM.
            code_block:   { group: 'block', content: 'text*', marks: '',
                            parseDOM: [{ tag: 'pre' }],
                            toDOM: function() { return ['pre', ['code', { class: 'hljs' }, 0]]; } },
            // Math nodes (§10.1): attrs.value holds the LaTeX source string.
            // atom:true keeps the cursor outside the node; editing is via the value attr.
            // Rendered by KaTeX via a custom NodeView (_mathNodeView) when live-edited;
            // toDOM below is the fallback used for parseDOM round-tripping only.
            math_inline:  { group: 'inline', inline: true, atom: true,
                            attrs: { value: { default: '' } },
                            parseDOM: [{ tag: 'code.math-inline', getAttrs: function(d) { return { value: d.textContent }; } }],
                            toDOM: function(n) { return ['code', { class: 'math-inline' }, n.attrs.value]; } },
            math_display: { group: 'block', atom: true,
                            attrs: { value: { default: '' } },
                            parseDOM: [{ tag: 'pre.math-display', getAttrs: function(d) { return { value: d.textContent }; } }],
                            toDOM: function(n) { return ['pre', { class: 'math-display' }, n.attrs.value]; } },
            // Embedded parts (§6.1): embedId used as key into ydoc.getMap('partState') (§10.8).
            embeddedPart: { group: 'block', atom: true,
                            attrs: { objId: { default: null }, cid: { default: null },
                                     handle: { default: null }, embedId: { default: null } },
                            parseDOM: [{ tag: 'div.lively-embedded-part', getAttrs: function(d) {
                              return { objId: d.getAttribute('data-obj-id'),
                                       cid:   d.getAttribute('data-cid'),
                                       handle: d.getAttribute('data-handle'),
                                       embedId: d.getAttribute('data-embed-id') };
                            }}],
                            toDOM: function(n) {
                              return ['div', { class: 'lively-embedded-part',
                                'data-obj-id': n.attrs.objId || '',
                                'data-cid':    n.attrs.cid    || '',
                                'data-handle': n.attrs.handle || '',
                                'data-embed-id': n.attrs.embedId || '' }];
                            } },
            // Inline image attachments (§10.1's insert-attachment, image case —
            // non-image files fall back to a plain link, see _insertAttachmentLink).
            // objId (Encryption.md §6): set for attachments uploaded via
            // FileCrypto; src is empty for a private/shared one (the actual
            // URL is resolved async, per-session, by the image NodeView —
            // see _attachmentImageNodeView) and a real, permanently-fetchable
            // blob URL for a public one or a pre-Phase-2 legacy attachment
            // (both render via plain toDOM/parseDOM with no NodeView
            // involvement needed, e.g. in postCardUtils.snapshotToHtml).
            image:        { group: 'inline', inline: true, atom: true,
                            attrs: { src: { default: '' }, alt: { default: '' }, title: { default: null },
                                     objId: { default: null } },
                            parseDOM: [{ tag: 'img[src]', getAttrs: function(d) {
                              return { src: d.getAttribute('src'), alt: d.getAttribute('alt') || '',
                                       title: d.getAttribute('title'), objId: d.getAttribute('data-obj-id') || null };
                            }}],
                            toDOM: function(n) {
                              return ['img', { src: n.attrs.src, alt: n.attrs.alt, title: n.attrs.title,
                                'data-obj-id': n.attrs.objId || '', 'class': 'lively-postcard-image' }];
                            } },
            text:         { group: 'inline' },
            hard_break:   { group: 'inline', inline: true, selectable: false,
                            parseDOM: [{ tag: 'br' }], toDOM: function() { return ['br']; } },
          },
          marks: {
            bold:      { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: function() { return ['strong', 0]; } },
            italic:    { parseDOM: [{ tag: 'em' }, { tag: 'i' }],     toDOM: function() { return ['em', 0]; } },
            code:      { parseDOM: [{ tag: 'code' }],                  toDOM: function() { return ['code', 0]; } },
            underline:   { parseDOM: [{ tag: 'u' }], toDOM: function() { return ['u', 0]; } },
            strike:      { parseDOM: [{ tag: 's' }, { tag: 'strike' }, { tag: 'del' }], toDOM: function() { return ['s', 0]; } },
            superscript: { excludes: 'subscript', parseDOM: [{ tag: 'sup' }], toDOM: function() { return ['sup', 0]; } },
            subscript:   { excludes: 'superscript', parseDOM: [{ tag: 'sub' }], toDOM: function() { return ['sub', 0]; } },
            textColor:       { attrs: { color: {} },
                               parseDOM: [{ style: 'color', getAttrs: function(v) { return { color: v }; } }],
                               toDOM: function(m) { return ['span', { style: 'color:' + m.attrs.color }, 0]; } },
            backgroundColor: { attrs: { color: {} },
                               parseDOM: [{ style: 'background-color', getAttrs: function(v) { return { color: v }; } }],
                               toDOM: function(m) { return ['span', { style: 'background-color:' + m.attrs.color }, 0]; } },
            fontFamily: { attrs: { family: {} },
                          parseDOM: [{ style: 'font-family', getAttrs: function(v) { return { family: v }; } }],
                          toDOM: function(m) { return ['span', { style: 'font-family:' + m.attrs.family }, 0]; } },
            fontSize:   { attrs: { size: {} },
                          parseDOM: [{ style: 'font-size', getAttrs: function(v) { return { size: v }; } }],
                          toDOM: function(m) { return ['span', { style: 'font-size:' + m.attrs.size }, 0]; } },
            // objId (Encryption.md §6): set for a non-image attachment link
            // (uploaded via FileCrypto). A private/shared one has no usable
            // href (its blob is encrypted) — clicking it is intercepted by
            // the editor's handleDOMEvents.click, which resolves+decrypts on
            // demand (see _openAttachment). A public one gets a real,
            // permanently-fetchable href directly, same reasoning as the
            // image node above.
            link:   { attrs: { href: { default: '' }, title: { default: null }, objId: { default: null } },
                      parseDOM: [{ tag: 'a[href]', getAttrs: function(d) {
                        return { href: d.getAttribute('href'), title: d.getAttribute('title'),
                                 objId: d.getAttribute('data-attachment-obj-id') || null };
                      } }],
                      toDOM: function(m) {
                        var href = m.attrs.href || '';
                        var scheme = /^([a-z][a-z0-9+.\-]*):/i.exec(href);
                        var safeHref = (!scheme || scheme[1].toLowerCase() === 'http' || scheme[1].toLowerCase() === 'https' || scheme[1].toLowerCase() === 'mailto') ? href : '#';
                        var attrs = { href: safeHref || '#', title: m.attrs.title, rel: 'noopener noreferrer' };
                        if (m.attrs.objId) attrs['data-attachment-obj-id'] = m.attrs.objId;
                        return ['a', attrs, 0];
                      } },
          },
        });
      },

      _setStatus: function (msg) {
        console.log('[PostCardEditor] status:', msg);
        if (this._statusEl) this._statusEl.textContent = msg;
        if (this._statusLabel) this._statusLabel.textString = msg;
      },

      _showError: function (msg) {
        console.error('[PostCardEditor]', msg);
        this._setStatus('Error');
      },

    });

    // ─── class-side entry points ─────────────────────────────────────────────────
    // Object.extend adds these as class methods (not instance methods).
    // 'class-side' is not a magic keyword in Lively's Object.subclass —
    // it would have added these as instance methods, shadowing Object.create.

    Object.extend(PostCardEditorClass, {

      // Wraps a freshly-created, freestanding editor in a lively.morphic.Window
      // (title bar drag handle, close (X) and minimize (–) controls) and
      // centers it — the standard Lively pattern for windowed content morphs
      // (see Widgets.js's own "Boxes inside a window cannot be dragged by just
      // clicking and moving" comment). _setup() separately disables the
      // editor's own body-dragging so text-selection drags don't move the
      // window instead.
      _openInCenteredWindow: function (editor, title) {
        var win = editor.openInWindow({ title: title });
        if (win) {
          win.align(win.bounds().center(), lively.morphic.World.current().visibleBounds().center());
          win.bringToFront();
        }
      },

      // Load an existing postcard and open the editor.
      // opts.forceReadOnly: used only by PostCardView to embed this editor
      // purely as a decrypt+render engine for private/shared card content —
      // strips all editing chrome and disables autosave regardless of
      // ownership (see _forceReadOnly, _applyReadOnlyMode, _markEdited).
      openCard: function (handle, objId, options) {
        var opts = options || {};
        var editor = new lively.identity.PostCardEditor(opts.bounds || lively.rect(0, 0, 680, 520));
        editor._handle = handle;
        editor._objId = objId;
        editor._isNew = false;
        editor._forceReadOnly = !!opts.forceReadOnly;
        if (opts.target) {
          opts.target.addMorph(editor);
          editor._setup();
        } else {
          this._openInCenteredWindow(editor, 'Post Card');
          editor._setup();
        }
        return editor;
      },

      // Create a new genesis postcard (objId not yet known) and open the editor.
      newCard: function (handle, options) {
        var opts = options || {};
        var editor = new lively.identity.PostCardEditor(lively.rect(0, 0, 680, 520));
        editor._handle = handle;
        editor._objId = null;
        editor._isNew = true;
        editor._constellation = opts.constellation || null;
        editor._replyTo = opts.replyTo || null;
        if (opts.target) {
          opts.target.addMorph(editor);
          editor._setup();
        } else {
          this._openInCenteredWindow(editor, 'New Post Card');
          editor._setup();
        }
        return editor;
      },

    });

  }); // end module('lively.identity.PostCardEditor')
