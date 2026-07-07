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
    'lively.identity.DID',
  )
  .toRun(function () {

    lively.morphic.Box.subclass('lively.identity.PostCardEditor',

    // ─── serialization guard ──────────────────────────────────────────────────────

    'serialization', {
      doNotSerialize: ['editorView', 'yDoc', 'wsProvider', '_saveTimer', '_pmContainer'],
    },

    // ─── initialization ──────────────────────────────────────────────────────────

    'initialization', {

      // No initialize override — Lively's Morph.initialize sets up submorphs etc.
      // State is set directly in newCard/openCard before _setup() is called.

      // Called after the morph is in the world and DOM is available.
      _setup: function () {
        this._envelope = null;
        this.editorView = null;
        this.yDoc = null;
        this.wsProvider = null;
        this._saveTimer = null;
        this._pmContainer = null;
        this._statusLabel = null;
        this._titleInput = null;
        this._buildChrome();
        if (this._isNew) {
          this._createNewDoc();
        } else {
          this._loadExisting();
        }
      },

    },

    // ─── chrome (UI scaffolding) ─────────────────────────────────────────────────

    'chrome', {

      _buildChrome: function () {
        var self = this;
        this.setFill(Color.white);

        // Toolbar strip at the top
        var toolbar = new lively.morphic.Box(lively.rect(0, 0, 680, 36));
        toolbar.setFill(Color.rgb(240, 240, 245));
        this.addMorph(toolbar);
        this._toolbar = toolbar;
        this._buildToolbar(toolbar);

        // Title input below toolbar
        var titleBox = new lively.morphic.Box(lively.rect(0, 36, 680, 34));
        titleBox.setFill(Color.white);
        this.addMorph(titleBox);

        // We use a lively Text morph as an editable input for the title.
        // Alternatively, an HtmlWrapMorph with <input> could be used.
        var titleText = new lively.morphic.Text(lively.rect(12, 6, 640, 22));
        titleText.setFontSize(15);
        titleText.textString = 'Title…';
        titleText.beInputLine();
        titleText.onKeyUp = function () { self._markEdited(); };
        titleBox.addMorph(titleText);
        this._titleInput = titleText;

        // Status label (auto-save feedback)
        var statusLabel = lively.morphic.Text.makeLabel('', { fontSize: 10, textColor: Color.gray });
        statusLabel.setPosition(lively.pt(600, 14));
        statusLabel.setExtent(lively.pt(70, 16));
        toolbar.addMorph(statusLabel);
        this._statusLabel = statusLabel;

        // ProseMirror container div — appended directly to the DOM node
        var shapeNode = this.renderContext().shapeNode;
        shapeNode.style.borderRadius = '8px';
        shapeNode.style.boxShadow = '0 4px 12px rgba(0,0,0,0.18)';
        var pmDiv = document.createElement('div');
        pmDiv.className = 'lively-postcard-editor-container';
        pmDiv.style.cssText = [
          'position:absolute',
          'top:70px',
          'left:0',
          'right:0',
          'bottom:0',
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

        // Isolate pmDiv from Lively's EventHandler (which lives on shapeNode in bubble phase).
        // Without this: mousedown bubbles up and Lively starts a morph drag; keydown is
        // intercepted before ProseMirror can handle Backspace/Delete/Enter.
        ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick'].forEach(function (t) {
          pmDiv.addEventListener(t, function (e) { e.stopPropagation(); });
        });
        ['keydown', 'keyup', 'keypress', 'input'].forEach(function (t) {
          pmDiv.addEventListener(t, function (e) { e.stopPropagation(); });
        });
      },

      _buildToolbar: function (toolbar) {
        var self = this;
        var buttons = [
          { label: 'B',  title: 'Bold',          cmd: 'toggleMark', markType: 'bold' },
          { label: 'I',  title: 'Italic',         cmd: 'toggleMark', markType: 'italic' },
          { label: 'H1', title: 'Heading 1',      cmd: 'setBlockType', nodeType: 'heading', attrs: { level: 1 } },
          { label: 'H2', title: 'Heading 2',      cmd: 'setBlockType', nodeType: 'heading', attrs: { level: 2 } },
          { label: '•',  title: 'Bullet list',    cmd: 'wrapInList', nodeType: 'bullet_list' },
          { label: '1.', title: 'Ordered list',   cmd: 'wrapInList', nodeType: 'ordered_list' },
          { label: '∑',  title: 'Math inline',    cmd: 'insertMath', mathType: 'inline' },
          { label: '∑²', title: 'Math display',   cmd: 'insertMath', mathType: 'display' },
        ];

        var x = 8;
        buttons.forEach(function (btnDef) {
          var w = btnDef.label.length > 1 ? 32 : 26;
          var domBtn = document.createElement('button');
          domBtn.textContent = btnDef.label;
          domBtn.title = btnDef.title;
          domBtn.style.cssText = [
            'position:absolute',
            'top:6px',
            'left:' + x + 'px',
            'width:' + w + 'px',
            'height:24px',
            'padding:0',
            'font-size:12px',
            'cursor:pointer',
            'border:1px solid #ccc',
            'border-radius:3px',
            'background:#fff',
          ].join(';');
          domBtn.addEventListener('mousedown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            self._execToolbarCmd(btnDef);
          });
          toolbar.renderContext().shapeNode.appendChild(domBtn);
          x += w + 4;
        });

        // Separator, then save button
        var saveBtn = new lively.morphic.Button(lively.rect(540, 6, 50, 24));
        saveBtn.setLabel('Save');
        saveBtn.onMouseDown = function () { self._saveNow(); };
        toolbar.addMorph(saveBtn);

        // Playback button
        var playBtn = new lively.morphic.Button(lively.rect(476, 6, 60, 24));
        playBtn.setLabel('History');
        playBtn.onMouseDown = function () { self._openPlayback(); };
        toolbar.addMorph(playBtn);
      },

    },

    // ─── ProseMirror setup ────────────────────────────────────────────────────────

    'editor', {

      // Create a fresh Y.Doc (gc: false) and attach a ProseMirror editor.
      _createNewDoc: function () {
        var Y = this._Y();
        if (!Y) return this._showError('Yjs not loaded — cannot create editor');
        this.yDoc = new Y.Doc({ gc: false });
        this._attachEditor();
        this._connectSync();
      },

      // Load the existing envelope from the server, reconstruct the Y.Doc, then attach.
      _loadExisting: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = base + '/' + encodeURIComponent(this._handle) + '/' + encodeURIComponent(this._objId);
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
          if (self._titleInput && envelope.state && envelope.state.title) {
            self._titleInput.textString = envelope.state.title;
          }
          lively.identity.postCardSerializer.deserializeFromEnvelope(envelope, function (err, yDoc) {
            if (err) return self._showError('Failed to deserialize: ' + err.message);
            self.yDoc = yDoc;
            self._attachEditor();
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
          yPM.yUndoPlugin(),
          prosemirror.history.history(),
          prosemirror.keymap.keymap({ 'Shift-Enter': hardBreakCmd }),
          prosemirror.keymap.keymap(prosemirror.commands.baseKeymap),
        ];

        this.editorView = new prosemirror.view.EditorView(this._pmContainer, {
          state: prosemirror.state.EditorState.create({ schema: schema, plugins: plugins }),
          dispatchTransaction: function (tr) {
            // ProseMirror calls this as dispatchTransaction.call(editorView, tr),
            // so 'this' is the EditorView. self.editorView is null during construction
            // because ySyncPlugin fires a dispatch synchronously in new EditorView().
            var view = self.editorView || this;
            var newState = view.state.apply(tr);
            view.updateState(newState);
            if (tr.docChanged) self._markEdited();
          },
        });
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

        var syncPort = (typeof window !== 'undefined' && window.POSTCARD_SYNC_PORT) || 1234;
        var wsUrl = 'ws://' + location.hostname + ':' + syncPort;
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
        this._userHasEdited = true;
        this._scheduleSave();
      },

      _saveNow: function () {
        clearTimeout(this._saveTimer);
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return this._setStatus('Not signed in');
        if (!this.yDoc) return this._setStatus('No document');

        var params = {
          yDoc:         this.yDoc,
          title:        this._titleInput ? this._titleInput.textString : '',
          prevEnvelope: this._envelope || null,
          constellation: this._constellation,
          replyTo:      this._replyTo,
        };

        this._setStatus('Saving…');
        lively.identity.postCardSerializer.serializeToEnvelope(params, function (err, envelope) {
          if (err) return self._setStatus('Error');
          self._putEnvelope(envelope, function (putErr) {
            if (putErr) return self._setStatus('Error');
            self._envelope = envelope;
            self._objId = envelope.objId;
            // If this was a new card, wire up sync now that we have an objId
            if (self._isNew) {
              self._isNew = false;
              self._connectSync();
            }
            self._setStatus('Saved');
          });
        });
      },

      _putEnvelope: function (envelope, callback) {
        var base = lively.identity.did.baseUrl();
        var url = base + '/' + encodeURIComponent(this._handle) + '/' + encodeURIComponent(envelope.objId);
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
          case 'insertMath': {
            var mathStr = btnDef.mathType === 'display' ? '$$  $$' : '$  $';
            var tr = state.tr.insertText(mathStr);
            dispatch(tr);
            break;
          }
        }
        view.focus();
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

      // Builds a minimal ProseMirror schema with heading, lists, code, blockquote.
      _buildSchema: function (modelModule) {
        var nodes = modelModule.schema ? modelModule.schema.spec.nodes : null;
        if (!nodes) {
          // Build a minimal basic schema matching our PM snapshot format
          return new modelModule.Schema({
            nodes: {
              doc:        { content: 'block+' },
              paragraph:  { group: 'block', content: 'inline*', parseDOM: [{ tag: 'p' }], toDOM: function() { return ['p', 0]; } },
              heading:    { group: 'block', content: 'inline*', attrs: { level: { default: 1 } },
                            parseDOM: [1,2,3,4,5,6].map(function(l) { return { tag: 'h'+l, attrs: { level: l } }; }),
                            toDOM: function(n) { return ['h'+n.attrs.level, 0]; } },
              bullet_list:  { group: 'block', content: 'list_item+', parseDOM: [{ tag: 'ul' }], toDOM: function() { return ['ul', 0]; } },
              ordered_list: { group: 'block', content: 'list_item+', attrs: { order: { default: 1 } },
                              parseDOM: [{ tag: 'ol' }], toDOM: function() { return ['ol', 0]; } },
              list_item:    { content: 'paragraph block*', parseDOM: [{ tag: 'li' }], toDOM: function() { return ['li', 0]; } },
              blockquote:   { group: 'block', content: 'block+', parseDOM: [{ tag: 'blockquote' }], toDOM: function() { return ['blockquote', 0]; } },
              code_block:   { group: 'block', content: 'text*', marks: '', parseDOM: [{ tag: 'pre' }], toDOM: function() { return ['pre', ['code', 0]]; } },
              text:         { group: 'inline' },
              hard_break:   { group: 'inline', inline: true, selectable: false, parseDOM: [{ tag: 'br' }], toDOM: function() { return ['br']; } },
            },
            marks: {
              bold:   { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: function() { return ['strong', 0]; } },
              italic: { parseDOM: [{ tag: 'em' }, { tag: 'i' }],     toDOM: function() { return ['em', 0]; } },
              code:   { parseDOM: [{ tag: 'code' }],                   toDOM: function() { return ['code', 0]; } },
              link:   { attrs: { href: {}, title: { default: null } },
                        parseDOM: [{ tag: 'a[href]', getAttrs: function(d) { return { href: d.getAttribute('href'), title: d.getAttribute('title') }; } }],
                        toDOM: function(m) { return ['a', m.attrs, 0]; } },
            },
          });
        }
        return modelModule.schema;
      },

      _setStatus: function (msg) {
        console.log('[PostCardEditor] status:', msg);
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

    Object.extend(lively.identity.PostCardEditor, {

      // Load an existing postcard and open the editor.
      openCard: function (handle, objId, options) {
        var opts = options || {};
        var editor = new lively.identity.PostCardEditor(lively.rect(0, 0, 680, 520));
        editor._handle = handle;
        editor._objId = objId;
        editor._isNew = false;
        if (opts.target) {
          opts.target.addMorph(editor);
          editor._setup();
        } else {
          editor.openInWorldCenter();
          editor.bringToFront();
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
          editor.openInWorldCenter();
          editor.bringToFront();
          editor._setup();
        }
        return editor;
      },

    });

  }); // end module('lively.identity.PostCardEditor')
