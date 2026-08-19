/**
 * lively.identity.WikiEditor
 *
 * BuildSpec morph — a windowed morph that embeds a ProseMirror EditorView
 * bound to a Y.Doc via ySyncPlugin, for constellation wiki pages
 * specifically. Split out of lively.identity.PostCardEditor when wiki pages
 * became their own envelope type (type: 'wikipage') instead of a
 * type:'postcard' + state.wikiName combination — PostCardEditor keeps only
 * the plain (single-author, no Yjs) editing path; this file keeps exactly
 * the live-multi-writer machinery wiki pages actually need. Toolbar, schema,
 * and NodeViews (math/embedded-part/image) are ported near-verbatim — they
 * were always generic, never postcard-specific — while save/load/sync logic
 * is wiki-only throughout (no plain-mode branch to speak of, since a
 * WikiEditor instance is never anything else).
 *
 * Deliberately NOT ported from PostCardEditor (postcard-only features that
 * never applied to wiki pages): reactions, tip jar, hashtags, location
 * tags, mute/block, forwarding aliases, sent/immutability freeze, the
 * mailbox-hide delete mechanism, the visibility toggle (a wiki page's
 * readability is its constellation's canRead check, not its own — see
 * WikiSerializer.js's header), Send/inbox delivery, and "post to
 * constellation" (a wiki page is tied to its constellation at creation,
 * never posted into one after the fact).
 *
 * Architecture:
 *   - Extends lively.morphic.Box (windowed morph).
 *   - ProseMirror EditorView appended to renderContext().shapeNode (DOM).
 *   - ySyncPlugin + yUndoPlugin bind EditorView <-> Y.Doc.getXmlFragment('prosemirror').
 *   - WebsocketProvider (y-websocket) attaches to PostCardSyncServer on port
 *     POSTCARD_SYNC_PORT (default 1234) using the wiki page's objId as room name.
 *   - Auto-save: debounced 2s after the last change, serializes to a
 *     WikiSerializer envelope and PUTs /@:handle/:objId.
 *
 * CRITICAL: Y.Doc MUST be created with gc: false before passing to
 * WikiSerializer or attaching a WebsocketProvider. This file enforces that
 * at create-time.
 *
 * Entry points:
 *   lively.identity.WikiEditor.openCard(handle, objId)
 *     — loads an existing wiki page and opens the editor
 *   lively.identity.WikiEditor.newCard(handle, { constellation, wikiName })
 *     — creates a new genesis wiki page and opens the editor
 *
 * doNotSerialize list:
 *   editorView, yDoc, wsProvider
 *
 * Dependencies (must be loaded as plain scripts before first use):
 *   /lib/yjs/yjs.js, /lib/prosemirror/*, /lib/y-prosemirror/*, /lib/y-websocket/
 *
 * Dependencies (Lively modules, loaded via .requires):
 *   lively.identity.WikiSerializer
 *   lively.identity.DID
 */

module('lively.identity.WikiEditor')
  .requires(
    'lively.identity.WikiSerializer',
    'lively.identity.WikiPlayback',
    'lively.identity.DID',
    'lively.identity.WebAuthn',
    'lively.identity.WebKey',
    'lively.identity.FileCrypto',
  )
  .toRun(function () {

    // Shared by paragraph/heading/list_item toDOM/parseDOM (align/indent) —
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

    var WikiEditorClass = lively.morphic.Box.subclass('lively.identity.WikiEditor',

    // ─── serialization guard ──────────────────────────────────────────────────────

    'serialization', {
      doNotSerialize: ['editorView', 'yDoc', 'wsProvider', '_saveTimer', '_pmContainer', '_contentLoadStarted'],
    },

    // ─── initialization ──────────────────────────────────────────────────────────

    'initialization', {

      _setup: function () {
        // This morph is meant to live inside a lively.morphic.Window (see
        // openCard/newCard) whose title bar is the drag handle — without this,
        // Lively's default whole-body dragging intercepts mousedown on pmDiv
        // before native text-selection drag ever gets a chance.
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
        // Attachment metadata: { objId, dek, blobCid, blobNonce, name, mime }
        // entries — pass-through inside the wiki page payload, hydrated from
        // the loaded envelope in _loadExistingNow.
        this._attachments = [];
        // True for a new page (you're creating it) or once _loadExistingNow
        // compares envelope.did to the session DID. envelope.did is fixed at
        // genesis (WikiSerializer.js) — it identifies the original author,
        // not "who's editing now."
        this._isOwner = true;
        // Whether THIS session may edit/save this page at all. Equals
        // _isOwner for a new/not-yet-loaded page. For a loaded page, a
        // non-owner may still have write access via constellation
        // membership — _loadExistingNow resolves that asynchronously (one
        // GET .../space-token round trip) before finalizing this flag.
        this._canEdit = true;
        // Set by WikiEditor.openCard's forceReadOnly option — used only by
        // WikiView, which embeds a target-mode editor purely to render
        // content and must never let that embed become editable/autosaving.
        // Preserved (not reset to false) across a restore-triggered re-run
        // of _setup().
        this._forceReadOnly = !!this._forceReadOnly;
        // _constellation/_wikiName are set by newCard's opts or
        // _loadExistingNow (from the loaded envelope) and are fixed for the
        // lifetime of this objId — a wiki page's constellation/name never
        // change after creation.
        this._constellation = this._constellation || null;
        this._wikiName = this._wikiName || null;
        this._buildChrome();

        // Guards against double-firing the async content-load dispatch
        // below — see PostCardEditor.js's identical guard for the full
        // race explanation (openCard/newCard's explicit _setup() call vs.
        // prepareForNewRenderContext's own call when this morph is added
        // to its window).
        if (this._contentLoadStarted) return;
        this._contentLoadStarted = true;
        if (this._isNew) {
          this._createNewDoc();
        } else {
          this._loadExisting();
        }
      },

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

        var toolbarDiv = document.createElement('div');
        toolbarDiv.style.cssText = [
          'position:absolute', 'top:0', 'left:0', 'right:0', 'height:64px',
          'background:#f0f0f5', 'border-bottom:1px solid #ccc', 'box-sizing:border-box',
          'overflow:hidden',
        ].join(';');
        shapeNode.appendChild(toolbarDiv);
        this._toolbarDiv = toolbarDiv;
        this._buildToolbar(toolbarDiv);

        var footerDiv = document.createElement('div');
        footerDiv.style.cssText = [
          'position:absolute', 'left:0', 'right:0', 'bottom:0', 'height:36px',
          'background:#f0f0f5', 'border-top:1px solid #ccc', 'box-sizing:border-box',
        ].join(';');
        shapeNode.appendChild(footerDiv);
        this._footerDiv = footerDiv;
        this._buildFooter(footerDiv);

        this._buildLinkPreview(shapeNode);

        var pmDiv = document.createElement('div');
        pmDiv.className = 'lively-postcard-editor-container selectable';
        pmDiv.style.cssText = [
          'position:absolute', 'top:64px', 'left:0', 'right:0', 'bottom:36px',
          'overflow-y:auto', 'padding:16px 20px', 'box-sizing:border-box',
          'font-family:sans-serif', 'font-size:14px', 'line-height:1.6', 'white-space:pre-wrap',
        ].join(';');
        shapeNode.appendChild(pmDiv);
        this._pmContainer = pmDiv;

        // Shared stylesheet with PostCardEditor.js — same class names, same
        // rendering rules (math/embed/image), so it's fine for both editors
        // to insert the same singleton <style> tag idempotently.
        if (!document.getElementById('lively-postcard-editor-style')) {
          var styleEl = document.createElement('style');
          styleEl.id = 'lively-postcard-editor-style';
          styleEl.textContent =
            '.lively-postcard-editor-container .ProseMirror > :first-child {' +
            '  font-size:20px;font-weight:bold;margin-bottom:8px;' +
            '}' +
            '.lively-postcard-image{max-width:100%;max-height:320px;vertical-align:middle;' +
            'border-radius:4px;}' +
            '.lively-postcard-video{max-width:100%;max-height:400px;display:block;border-radius:4px;}' +
            '.lively-postcard-audio{max-width:100%;width:320px;display:block;}' +
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

        ['keydown', 'keyup', 'keypress', 'input'].forEach(function (t) {
          pmDiv.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick'].forEach(function (t) {
          pmDiv.addEventListener(t, function (e) { e.stopPropagation(); });
        });
      },

      // Two evenly-balanced formatting rows — identical to PostCardEditor.js's
      // toolbar (generic ProseMirror commands, never postcard-specific).
      _buildToolbar: function (toolbarDiv) {
        var self = this;

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
              'flex:0 0 auto', 'width:' + w + 'px', 'height:24px', 'padding:0',
              'font-size:12px', 'cursor:pointer', 'border:1px solid #ccc',
              'border-radius:3px', 'background:#fff',
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
          if (from === to) return;
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
          if (from === to) return;
          var tr = view.state.tr.removeMark(from, to, markType);
          if (select.value) tr = tr.addMark(from, to, markType.create({ family: select.value }));
          view.dispatch(tr);
          view.focus();
        });
        return select;
      },

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
          if (from === to) return;
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

      // Footer bar: much smaller than PostCardEditor.js's — a wiki page has
      // no Send/visibility/post-to-constellation actions (see file header).
      _buildFooter: function (footerDiv) {
        var self = this;

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
        statusSpan.style.cssText = 'position:absolute;top:7px;right:80px;font-size:10px;color:#888;pointer-events:none;';
        footerDiv.appendChild(statusSpan);
        this._statusEl = statusSpan;

        var saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.title = 'Save now';
        saveBtn.style.cssText = 'position:absolute;top:6px;right:8px;width:64px;height:24px;padding:0;font-size:12px;cursor:pointer;border:1px solid #5a5;border-radius:3px;background:#efe;';
        saveBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._saveNow();
        });
        footerDiv.appendChild(saveBtn);
      },

      // Reflects the current selection's formatting into the toolbar —
      // identical to PostCardEditor.js's (generic ProseMirror state read).
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

      // A small floating chip shown under the cursor when it's inside a link —
      // identical to PostCardEditor.js's.
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
    // Bypasses lively.morphic.Morph's default Backspace/Ctrl-C/-V handling
    // whenever the ProseMirror view itself has focus — identical rationale
    // to PostCardEditor.js's override.

    'morph events', {

      onKeyDown: function ($super, evt) {
        var view = this.editorView;
        if (view && (view.hasFocus() || (view.dom && view.dom.contains(document.activeElement)))) {
          return false;
        }
        return $super(evt);
      },

    },

    // ─── ProseMirror setup ────────────────────────────────────────────────────────

    'editor', {

      // Inject postcard-runtime.js if Yjs/PM aren't on the page yet — shared
      // runtime bundle with PostCardEditor.js, same lazy-load mechanism.
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

      // A new wiki page always gets a fresh Y.Doc — there is no plain mode
      // to fork between.
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
          if (xhr.status !== 200) return self._showError('Failed to load wiki page: ' + xhr.status);
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) {
            return self._showError('Invalid envelope JSON: ' + e.message);
          }
          self._envelope = envelope;
          self._constellation = envelope.constellation || null;
          self._wikiName = (envelope.state && envelope.state.wikiName) || null;
          var user = lively.identity.did.currentUser();
          self._isOwner = !!(user && user.did === envelope.did);
          self._canEdit = self._isOwner;

          function finishLoad() {
            self._attachEditor();
            self._applyReadOnlyMode();
            self._connectSync();
          }

          function onDeserialized(err, doc, payload) {
            if (err) return self._showError('Failed to deserialize: ' + err.message);
            self.yDoc = doc;
            self._attachments = (payload && payload.attachments) || [];

            // Non-owner (§16.6): resolve constellation write access before
            // attaching the editor, so a legitimate member doesn't get
            // stuck read-only.
            if (!self._isOwner && self._constellation) {
              var spaceTokenUrl = base + '/c/' + encodeURIComponent(self._constellation) + '/space-token';
              var swxhr = new XMLHttpRequest();
              swxhr.open('GET', spaceTokenUrl, true);
              swxhr.setRequestHeader('Accept', 'application/json');
              swxhr.withCredentials = true;
              swxhr.onload = function () {
                if (swxhr.status === 200) {
                  try {
                    self._canEdit = !!JSON.parse(swxhr.responseText).canWrite;
                  } catch (e) { /* leave _canEdit at its not-owner default (false) */ }
                }
                finishLoad();
              };
              swxhr.onerror = function () { finishLoad(); };
              swxhr.send();
              return;
            }

            finishLoad();
          }

          lively.identity.wikiSerializer.deserializeFromEnvelope(envelope, onDeserialized);
        };
        xhr.onerror = function () { self._showError('Network error loading wiki page'); };
        xhr.send();
      },

      // Append a ProseMirror EditorView to _pmContainer, bound to yDoc via
      // ySyncPlugin — undo/redo goes through yUndoPlugin (tracks the CRDT's
      // own undo stack), never prosemirror-history (which would fight over
      // document state with no shared doc to reconcile against).
      _attachEditor: function () {
        var self = this;
        if (!this._pmContainer) return;

        var prosemirror = this._ProseMirror();
        if (!prosemirror) return this._showError('ProseMirror not loaded');

        var schema = this._buildSchema(prosemirror.model);

        var hardBreakCmd = function (state, dispatch) {
          var hb = state.schema.nodes.hard_break;
          if (!hb) return false;
          if (dispatch) dispatch(state.tr.replaceSelectionWith(hb.create()).scrollIntoView());
          return true;
        };

        var yPM = this._yProsemirror();
        if (!yPM) return this._showError('y-prosemirror not loaded');
        var yXmlFragment = this.yDoc.getXmlFragment('prosemirror');
        var plugins = [
          yPM.ySyncPlugin(yXmlFragment),
          yPM.yUndoPlugin(), // sole undo/redo — do NOT add prosemirror history() alongside this
          this._buildHighlightPlugin(prosemirror),
          prosemirror.keymap.keymap({ 'Mod-z': yPM.undo, 'Mod-y': yPM.redo, 'Mod-Shift-z': yPM.redo }),
          prosemirror.keymap.keymap({ 'Shift-Enter': hardBreakCmd }),
          prosemirror.keymap.keymap(prosemirror.commands.baseKeymap),
        ];

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
            video:        function (node, view, getPos) { return self._attachmentVideoNodeView(node, view, getPos); },
            audio:        function (node, view, getPos) { return self._attachmentAudioNodeView(node, view, getPos); },
          },
          handleDOMEvents: {
            blur: function () { self._hideLinkPreview(); return false; },
            click: function (view, event) {
              var a = event.target && event.target.closest && event.target.closest('a[data-attachment-obj-id]');
              if (!a) return false;
              event.preventDefault();
              self._openAttachment(a.getAttribute('data-attachment-obj-id'));
              return true;
            },
          },
          dispatchTransaction: function (tr) {
            var view = self.editorView || this;
            var newState = view.state.apply(tr);
            view.updateState(newState);
            if (tr.docChanged) self._markEdited();
            self._updateToolbarState();
            self._updateLinkPreview();
          },
        });
        this._updateToolbarState();
        this._updateLinkPreview();
      },

      // Syntax-highlights code_block content via inline Decorations —
      // identical to PostCardEditor.js's.
      _buildHighlightPlugin: function (prosemirror) {
        var Plugin = prosemirror.state.Plugin;
        var PluginKey = prosemirror.state.PluginKey;
        var Decoration = prosemirror.view.Decoration;
        var DecorationSet = prosemirror.view.DecorationSet;
        var key = new PluginKey('postcardHighlight');

        function highlightCodeBlock(pos, text) {
          var hljs = (typeof window !== 'undefined' && window.hljs) || null;
          if (!hljs || !text) return [];
          var result;
          try { result = hljs.highlightAuto(text); } catch (e) { return []; }
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

      // NodeView for math_inline/math_display — identical to PostCardEditor.js's.
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

        dom.addEventListener('mousedown', function (e) {
          if (editing) return;
          e.preventDefault();
          startEditing();
        });

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

      // Makes the view read-only for a viewer without write access (not the
      // owner, and not a constellation member with canWrite).
      _applyReadOnlyMode: function () {
        if (this._canEdit && !this._forceReadOnly) return;
        if (this.editorView) {
          this.editorView.setProps({ editable: function () { return false; } });
        }
        if (this._toolbarDiv) {
          this._toolbarDiv.innerHTML = '';
          this._toolbarDiv.style.cssText = [
            'position:absolute', 'top:0', 'left:0', 'right:0', 'height:28px',
            'background:#f0f0f5', 'border-bottom:1px solid #ccc',
            'box-sizing:border-box', 'display:flex', 'align-items:center', 'padding:0 10px',
          ].join(';');
          var label = document.createElement('span');
          label.style.cssText = 'font-size:11px;color:#888;font-family:sans-serif;';
          label.textContent = 'Read-only — ' + (this._constellation ? ('join ' + this._constellation + ' to edit') : 'not a member');
          this._toolbarDiv.appendChild(label);
        }
        if (this._footerDiv) this._footerDiv.style.display = 'none';
        if (this._pmContainer) {
          this._pmContainer.style.top = '28px';
          this._pmContainer.style.bottom = '0';
        }
      },

      // Connects to PostCardSyncServer via WebsocketProvider for live
      // multi-writer collaboration. Gracefully degrades if y-websocket is
      // unavailable.
      _connectSync: function () {
        if (!this._objId) return; // no sync until first save establishes objId
        if (!this.yDoc) return;

        var WebsocketProvider = this._WebsocketProvider();
        if (!WebsocketProvider) {
          console.warn('[WikiEditor] WebsocketProvider not loaded — live sync disabled');
          return;
        }

        var syncPort = (typeof window !== 'undefined' && window.POSTCARD_SYNC_PORT) || 1234;
        var wsScheme = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
        var wsUrl = wsScheme + '//' + location.hostname + ':' + syncPort;
        try {
          this.wsProvider = new WebsocketProvider(wsUrl, this._objId, this.yDoc, { connect: true });
          this.wsProvider.on('status', function (event) {
            console.log('[WikiEditor] sync status:', event.status);
          });
        } catch (e) {
          console.warn('[WikiEditor] Failed to start WebSocket sync (non-fatal):', e.message);
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
        // A wiki-mode PUT can legitimately succeed for a non-owner
        // constellation member (§16.6), so this mirrors _canEdit's fuller
        // condition, not just ownership.
        if (!this._canEdit || this._forceReadOnly) return;
        this._userHasEdited = true;
        this._scheduleSave();
      },

      // callback: optional (err) — invoked after PUT completes/fails.
      _saveNow: function (callback) {
        clearTimeout(this._saveTimer);
        var self = this;
        var cb = callback || function () {};
        var user = lively.identity.did.currentUser();
        if (!user) { this._setStatus('Not signed in'); return cb(new Error('Not signed in')); }
        if (!this.editorView) { this._setStatus('No document'); return cb(new Error('No document')); }

        var params = {
          prevEnvelope:  this._envelope || null,
          constellation: this._constellation,
          wikiName:      this._wikiName,
          yDoc:          this.yDoc,
          attachments:   this._attachments || [],
          stateMeta:     {},
          // title omitted — WikiSerializer extracts it from the first PM block
        };
        this._setStatus('Saving…');
        lively.identity.wikiSerializer.serializeToEnvelope(params, function (err, envelope) {
          self._finishSave(err, envelope, cb);
        });
      },

      _finishSave: function (err, envelope, callback) {
        var self = this;
        var cb = callback || function () {};
        if (err) {
          console.error('[WikiEditor] serialize error:', err && (err.message || String(err)));
          self._setStatus('Error');
          return cb(err);
        }
        self._putEnvelope(envelope, function (putErr) {
          if (putErr) {
            console.error('[WikiEditor] PUT error:', putErr && (putErr.message || String(putErr)));
            self._setStatus('Error');
            return cb(putErr);
          }
          self._envelope = envelope;
          self._objId = envelope.objId;
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
        console.log('[WikiEditor] PUT', url, 'objId:', envelope.objId);
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status === 200 || xhr.status === 201) return callback(null);
          console.error('[WikiEditor] PUT failed', xhr.status, xhr.responseText.slice(0, 300));
          callback(new Error('PUT failed: ' + xhr.status));
        };
        xhr.onerror = function () {
          console.error('[WikiEditor] PUT network error');
          callback(new Error('Network error'));
        };
        xhr.send(JSON.stringify(envelope));
      },

    },

    // ─── embedded parts ─────────────────────────────────────────────────────────
    // Identical to PostCardEditor.js's — parts are Lively Morphs, deserialized
    // and mounted directly into this editor's own DOM/JS realm.

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
        // See the KNOWN BUG note on _insertAttachmentVideo: if this embed
        // ends up as the doc's last node, the next block-atom insert can
        // silently replace it (shared replaceSelectionWith exposure).
        view.dispatch(state.tr.replaceSelectionWith(node));
        view.focus();
      },

      _generateEmbedId: function () {
        return 'embed-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      },

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
          if (!currentNode.attrs.objId) return;

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
              console.error('[WikiEditor] attachment image resolve failed:', err);
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

      // NodeView for the video node — same reasoning as _attachmentImageNodeView
      // above (private/shared attachments resolve to a session-local blob:
      // URL asynchronously, swapped into the DOM directly without ever
      // touching node.attrs/dispatching a transaction).
      _attachmentVideoNodeView: function (node, view, getPos) {
        var self = this;
        var destroyed = false;
        var video = document.createElement('video');
        video.className = 'lively-postcard-video';
        video.controls = true;
        video.preload = 'metadata';

        function render(currentNode) {
          if (currentNode.attrs.name) video.title = currentNode.attrs.name;
          video.classList.remove('lively-attachment-loading', 'lively-attachment-error');

          if (currentNode.attrs.src) {
            video.src = currentNode.attrs.src;
            return;
          }
          if (!currentNode.attrs.objId) return;

          video.classList.add('lively-attachment-loading');
          var entry = (self._attachments || []).find(function (a) { return a.objId === currentNode.attrs.objId; });
          if (!entry) {
            video.classList.remove('lively-attachment-loading');
            video.classList.add('lively-attachment-error');
            return;
          }
          lively.identity.fileCrypto.resolveAttachmentUrl(self._handle, entry, function (err, url) {
            if (destroyed) return;
            video.classList.remove('lively-attachment-loading');
            if (err) {
              video.classList.add('lively-attachment-error');
              console.error('[WikiEditor] attachment video resolve failed:', err);
              return;
            }
            video.src = url;
          });
        }

        render(node);

        return {
          dom: video,
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

      // NodeView for the audio node — same reasoning as
      // _attachmentVideoNodeView above.
      _attachmentAudioNodeView: function (node, view, getPos) {
        var self = this;
        var destroyed = false;
        var audio = document.createElement('audio');
        audio.className = 'lively-postcard-audio';
        audio.controls = true;
        audio.preload = 'metadata';

        function render(currentNode) {
          if (currentNode.attrs.name) audio.title = currentNode.attrs.name;
          audio.classList.remove('lively-attachment-loading', 'lively-attachment-error');

          if (currentNode.attrs.src) {
            audio.src = currentNode.attrs.src;
            return;
          }
          if (!currentNode.attrs.objId) return;

          audio.classList.add('lively-attachment-loading');
          var entry = (self._attachments || []).find(function (a) { return a.objId === currentNode.attrs.objId; });
          if (!entry) {
            audio.classList.remove('lively-attachment-loading');
            audio.classList.add('lively-attachment-error');
            return;
          }
          lively.identity.fileCrypto.resolveAttachmentUrl(self._handle, entry, function (err, url) {
            if (destroyed) return;
            audio.classList.remove('lively-attachment-loading');
            if (err) {
              audio.classList.add('lively-attachment-error');
              console.error('[WikiEditor] attachment audio resolve failed:', err);
              return;
            }
            audio.src = url;
          });
        }

        render(node);

        return {
          dom: audio,
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

      // Per-embed shared state, backed by a nested Y.Map at
      // yDoc.getMap('partState').get(embedId) — always the Yjs path, since
      // a WikiEditor instance is never anything else. Multiple writers can
      // observe each other's changes live, and playback replays it for
      // free (same Yjs update blob as the rest of the document).
      _embedStateApi: function (embedId) {
        if (!embedId) return null;
        var Y = this._Y();
        if (!Y || !this.yDoc) return null;
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
    // Identical to PostCardEditor.js's — generic ProseMirror commands plus
    // the attachment-upload flow, neither of which are postcard-specific.

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
            // See the KNOWN BUG note on _insertAttachmentVideo — applies to
            // math_display (block atom), not math_inline.
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

      _promptLink: function () {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var linkType = state.schema.marks.link;
        if (!linkType) return;
        var from = state.selection.from, to = state.selection.to;
        if (from === to) return;
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
        if (href === null) return;
        href = href.trim();
        var tr = state.tr.removeMark(from, to, linkType);
        if (href) tr = tr.addMark(from, to, linkType.create({ href: href }));
        view.dispatch(tr);
        view.focus();
      },

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

      // Wiki pages are always public/unencrypted (WikiSerializer.js), so
      // attachments never need recipient key-sealing the way a
      // private/shared postcard's do.
      _uploadAttachment: function (file) {
        var self = this;
        if (!this._handle) return;
        var isImage = /^image\//.test(file.type || '');
        var isVideo = /^video\//.test(file.type || '');
        var isAudio = /^audio\//.test(file.type || '');

        this._setStatus('Uploading…');
        lively.identity.fileCrypto.encryptAndUpload(file, {
          visibility: 'public',
          recipients: [],
          onWaiting: function () { self._setStatus('Confirm passkey…'); },
        }, function (err, result) {
          if (err) {
            self._setStatus('Upload failed');
            console.error('[WikiEditor] attachment upload failed:', err);
            return;
          }
          var entry = {
            objId: result.objId,
            dek: result.dek ? lively.identity.crypto.base64urlEncode(result.dek) : null,
            blobCid: result.blobCid,
            blobNonce: result.blobNonce,
            name: file.name,
            mime: file.type || 'application/octet-stream',
          };
          if (!self._attachments) self._attachments = [];
          self._attachments.push(entry);
          if (isImage) self._insertAttachmentImage(entry);
          else if (isVideo) self._insertAttachmentVideo(entry);
          else if (isAudio) self._insertAttachmentAudio(entry);
          else self._insertAttachmentLink(entry);
          self._setStatus('Uploaded');
        });
      },

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

      // KNOWN BUG (README.md "Fix before Deploying"): if this video ends up
      // as the doc's last node, replaceSelectionWith below leaves a
      // NodeSelection on it (ProseMirror's Selection.atEnd can't find a
      // trailing text cursor after a block atom with no following
      // paragraph) — the next attachment/embed insert then silently
      // replaces this video instead of adding alongside it. Not specific to
      // video: embeddedPart/math_display share the same replaceSelectionWith
      // pattern and the same exposure.
      _insertAttachmentVideo: function (entry) {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var videoType = state.schema.nodes.video;
        if (!videoType) return;
        var src = entry.dek ? '' : this._publicBlobUrl(entry.blobCid);
        var node = videoType.create({ src: src, name: entry.name, objId: entry.objId });
        view.dispatch(state.tr.replaceSelectionWith(node));
        view.focus();
      },

      // Audio attachments: same reasoning as _insertAttachmentVideo.
      //
      // KNOWN BUG (README.md "Fix before Deploying"): same exposure as
      // _insertAttachmentVideo's note — this is a block atom, so it can be
      // silently replaced by the next attachment/embed insert if it ends up
      // as the doc's last node.
      _insertAttachmentAudio: function (entry) {
        if (!this.editorView) return;
        var view = this.editorView;
        var state = view.state;
        var audioType = state.schema.nodes.audio;
        if (!audioType) return;
        var src = entry.dek ? '' : this._publicBlobUrl(entry.blobCid);
        var node = audioType.create({ src: src, name: entry.name, objId: entry.objId });
        view.dispatch(state.tr.replaceSelectionWith(node));
        view.focus();
      },

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

      _openAttachment: function (objId) {
        var self = this;
        var entry = (this._attachments || []).find(function (a) { return a.objId === objId; });
        if (!entry) return;
        this._setStatus('Decrypting…');
        lively.identity.fileCrypto.resolveAttachmentUrl(this._handle, entry, function (err, url) {
          if (err) {
            self._setStatus('Failed to open attachment');
            console.error('[WikiEditor] attachment open failed:', err);
            return;
          }
          self._setStatus('');
          window.open(url, '_blank');
        });
      },

    },

    // ─── playback ─────────────────────────────────────────────────────────────────

    'playback', {

      _openPlayback: function () {
        if (!this._objId) return alert('Save the page first before viewing history.');
        lively.identity.WikiPlayback.openPlayback(this._handle, this._objId);
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
        if (typeof window === 'undefined') return null;
        if (window.PM) return window.PM;
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

      // Same schema PostCardEditor.js builds — prose nodes + math +
      // embeddedPart + image attachments. Kept as a separate copy rather
      // than a shared module (see file header on the toolbar/schema
      // duplication tradeoff).
      _buildSchema: function (modelModule) {
        return new modelModule.Schema({
          nodes: {
            doc:          { content: 'block+' },
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
            code_block:   { group: 'block', content: 'text*', marks: '',
                            parseDOM: [{ tag: 'pre' }],
                            toDOM: function() { return ['pre', ['code', { class: 'hljs' }, 0]]; } },
            math_inline:  { group: 'inline', inline: true, atom: true,
                            attrs: { value: { default: '' } },
                            parseDOM: [{ tag: 'code.math-inline', getAttrs: function(d) { return { value: d.textContent }; } }],
                            toDOM: function(n) { return ['code', { class: 'math-inline' }, n.attrs.value]; } },
            math_display: { group: 'block', atom: true,
                            attrs: { value: { default: '' } },
                            parseDOM: [{ tag: 'pre.math-display', getAttrs: function(d) { return { value: d.textContent }; } }],
                            toDOM: function(n) { return ['pre', { class: 'math-display' }, n.attrs.value]; } },
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
            video:        { group: 'block', atom: true,
                            attrs: { src: { default: '' }, name: { default: '' }, objId: { default: null } },
                            parseDOM: [{ tag: 'video[src]', getAttrs: function(d) {
                              return { src: d.getAttribute('src'), name: d.getAttribute('data-name') || '',
                                       objId: d.getAttribute('data-obj-id') || null };
                            }}],
                            toDOM: function(n) {
                              return ['video', { src: n.attrs.src, controls: 'true', preload: 'metadata',
                                'data-name': n.attrs.name || '', 'data-obj-id': n.attrs.objId || '',
                                'class': 'lively-postcard-video' }];
                            } },
            audio:        { group: 'block', atom: true,
                            attrs: { src: { default: '' }, name: { default: '' }, objId: { default: null } },
                            parseDOM: [{ tag: 'audio[src]', getAttrs: function(d) {
                              return { src: d.getAttribute('src'), name: d.getAttribute('data-name') || '',
                                       objId: d.getAttribute('data-obj-id') || null };
                            }}],
                            toDOM: function(n) {
                              return ['audio', { src: n.attrs.src, controls: 'true', preload: 'metadata',
                                'data-name': n.attrs.name || '', 'data-obj-id': n.attrs.objId || '',
                                'class': 'lively-postcard-audio' }];
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
        console.log('[WikiEditor] status:', msg);
        if (this._statusEl) this._statusEl.textContent = msg;
        if (this._statusLabel) this._statusLabel.textString = msg;
      },

      _showError: function (msg) {
        console.error('[WikiEditor]', msg);
        this._setStatus('Error');
      },

    });

    // ─── class-side entry points ─────────────────────────────────────────────────

    Object.extend(WikiEditorClass, {

      _openInCenteredWindow: function (editor, title) {
        var win = editor.openInWindow({ title: title });
        if (win) {
          win.align(win.bounds().center(), lively.morphic.World.current().visibleBounds().center());
          win.bringToFront();
        }
      },

      // Load an existing wiki page and open the editor.
      // opts.forceReadOnly: used only by WikiView to embed this editor
      // purely as a render engine for content — strips all editing chrome
      // and disables autosave regardless of ownership.
      openCard: function (handle, objId, options) {
        var opts = options || {};
        var editor = new lively.identity.WikiEditor(opts.bounds || lively.rect(0, 0, 680, 520));
        editor._handle = handle;
        editor._objId = objId;
        editor._isNew = false;
        editor._forceReadOnly = !!opts.forceReadOnly;
        if (opts.target) {
          opts.target.addMorph(editor);
          editor._setup();
        } else {
          this._openInCenteredWindow(editor, 'Wiki Page');
          editor._setup();
        }
        return editor;
      },

      // Create a new genesis wiki page and open the editor.
      // options: { constellation, wikiName } — both required; mode-switching
      // isn't supported, so a wiki page's constellation/name are fixed from
      // the moment it's created (matches PostcardDesignSpec-v2.md §1.3's
      // "no path to convert a plain card into a wiki page or vice versa").
      newCard: function (handle, options) {
        var opts = options || {};
        var editor = new lively.identity.WikiEditor(lively.rect(0, 0, 680, 520));
        editor._handle = handle;
        editor._objId = null;
        editor._isNew = true;
        editor._constellation = opts.constellation || null;
        editor._wikiName = opts.wikiName || null;
        if (opts.target) {
          opts.target.addMorph(editor);
          editor._setup();
        } else {
          this._openInCenteredWindow(editor, 'New Wiki Page');
          editor._setup();
        }
        return editor;
      },

    });

  }); // end module('lively.identity.WikiEditor')
