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
  )
  .toRun(function () {

    var PostCardEditorClass = lively.morphic.Box.subclass('lively.identity.PostCardEditor',

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
        this._statusEl = null;
        this._toolbarDiv = null;
        // Public/Private toggle — 'shared' is not a distinct editor-side state,
        // it's what serializeEncrypted derives automatically once
        // _recipientHandles is non-empty.
        this._visibility = 'public';
        this._recipientHandles = [];
        this._visibilityBtn = null;
        // True for a new card (you're creating it) or once _loadExistingNow
        // compares envelope.did to the session DID. Gates editing, Save,
        // Send, and the visibility toggle — a non-owner viewing a shared
        // card is read-only (PUT is owner-only server-side regardless).
        this._isOwner = true;
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

        var shapeNode = this.renderContext().shapeNode;
        shapeNode.style.borderRadius = '8px';
        shapeNode.style.boxShadow = '0 4px 12px rgba(0,0,0,0.18)';

        // Toolbar as a plain DOM div — keeping it out of Lively's morph hierarchy
        // prevents Lively from grabbing the toolbar as an independent draggable morph.
        // The shapeNode background acts as the drag handle for the whole window.
        var toolbarDiv = document.createElement('div');
        toolbarDiv.style.cssText = [
          'position:absolute',
          'top:0',
          'left:0',
          'right:0',
          'height:36px',
          'background:#f0f0f5',
          'border-bottom:1px solid #ccc',
          'box-sizing:border-box',
          'overflow:hidden',
        ].join(';');
        shapeNode.appendChild(toolbarDiv);
        this._toolbarDiv = toolbarDiv;
        this._buildToolbar(toolbarDiv);

        // ProseMirror container div
        var pmDiv = document.createElement('div');
        pmDiv.className = 'lively-postcard-editor-container';
        pmDiv.style.cssText = [
          'position:absolute',
          'top:36px',
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

        if (!document.getElementById('lively-postcard-editor-style')) {
          var styleEl = document.createElement('style');
          styleEl.id = 'lively-postcard-editor-style';
          styleEl.textContent =
            '.lively-postcard-editor-container .ProseMirror > :first-child {' +
            '  font-size:20px;font-weight:bold;margin-bottom:8px;' +
            '}';
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

      _buildToolbar: function (toolbarDiv) {
        var self = this;
        var btnDefs = [
          { label: 'B',    title: 'Bold',        cmd: 'toggleMark',  markType: 'bold' },
          { label: 'I',    title: 'Italic',       cmd: 'toggleMark',  markType: 'italic' },
          { label: '`',    title: 'Inline code',  cmd: 'toggleMark',  markType: 'code' },
          { label: 'H1',   title: 'Heading 1',    cmd: 'setBlockType',nodeType: 'heading', attrs: { level: 1 } },
          { label: 'H2',   title: 'Heading 2',    cmd: 'setBlockType',nodeType: 'heading', attrs: { level: 2 } },
          { label: '•', title: 'Bullet list',  cmd: 'wrapInList',  nodeType: 'bullet_list' },
          { label: '1.',   title: 'Ordered list', cmd: 'wrapInList',  nodeType: 'ordered_list' },
          { label: '❝', title: 'Blockquote',   cmd: 'wrapIn',      nodeType: 'blockquote' },
          { label: '</>',  title: 'Code block',   cmd: 'setBlockType',nodeType: 'code_block', attrs: {} },
          { label: '∑',  title: 'Math inline',  cmd: 'insertMath',  mathType: 'inline' },
          { label: '∑²', title: 'Math display', cmd: 'insertMath',  mathType: 'display' },
        ];

        var x = 8;
        btnDefs.forEach(function (btnDef) {
          var w = btnDef.label.length > 1 ? 36 : 26;
          var btn = document.createElement('button');
          btn.textContent = btnDef.label;
          btn.title = btnDef.title;
          btn.style.cssText = [
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
          btn.addEventListener('mousedown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            self._execToolbarCmd(btnDef);
          });
          toolbarDiv.appendChild(btn);
          x += w + 4;
        });

        // Status feedback (auto-save state)
        var statusSpan = document.createElement('span');
        statusSpan.style.cssText = 'position:absolute;top:11px;right:248px;font-size:10px;color:#888;pointer-events:none;';
        toolbarDiv.appendChild(statusSpan);
        this._statusEl = statusSpan;

        // Save button (green tint)
        var saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.title = 'Save now';
        saveBtn.style.cssText = 'position:absolute;top:6px;right:76px;width:48px;height:24px;padding:0;font-size:12px;cursor:pointer;border:1px solid #5a5;border-radius:3px;background:#efe;';
        saveBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._saveNow();
        });
        toolbarDiv.appendChild(saveBtn);

        // History button
        var histBtn = document.createElement('button');
        histBtn.textContent = 'History';
        histBtn.title = 'View version history (save first)';
        histBtn.style.cssText = 'position:absolute;top:6px;right:4px;width:68px;height:24px;padding:0;font-size:12px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;';
        histBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._openPlayback();
        });
        toolbarDiv.appendChild(histBtn);

        // Visibility toggle (Public ⇄ Private). 'shared' is not a state this
        // button sets — it's derived automatically once a card has recipients.
        var visBtn = document.createElement('button');
        visBtn.style.cssText = 'position:absolute;top:6px;right:128px;width:52px;height:24px;padding:0;font-size:11px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;';
        visBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._visibility = self._visibility === 'public' ? 'private' : 'public';
          self._updateVisibilityBtn();
          self._markEdited();
        });
        toolbarDiv.appendChild(visBtn);
        this._visibilityBtn = visBtn;
        this._updateVisibilityBtn();

        // Share/Send button
        var sendBtn = document.createElement('button');
        sendBtn.textContent = 'Send';
        sendBtn.title = 'Send to a handle';
        sendBtn.style.cssText = 'position:absolute;top:6px;right:184px;width:52px;height:24px;padding:0;font-size:12px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#fff;';
        sendBtn.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          self._promptAndSend();
        });
        toolbarDiv.appendChild(sendBtn);
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
        var s = document.createElement('script');
        s.src = '/core/lib/postcard/postcard-runtime.js';
        s.onload = function () { window._postcardRuntimeLoading = false; callback(); };
        s.onerror = function () {
          window._postcardRuntimeLoading = false;
          self._showError('Failed to load /core/lib/postcard/postcard-runtime.js');
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
          var user = lively.identity.did.currentUser();
          self._isOwner = !!(user && user.did === envelope.did);
          self._updateVisibilityBtn();
          var deserialize = envelope.visibility === 'public'
            ? lively.identity.postCardSerializer.deserializeFromEnvelope
            : lively.identity.postCardSerializer.deserializeEncrypted;
          deserialize.call(lively.identity.postCardSerializer, envelope, function (err, yDoc) {
            if (err) return self._showError('Failed to deserialize: ' + err.message);
            self.yDoc = yDoc;
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
          },
        });
      },

      // Makes the view read-only for non-owners: a shared/public card opened
      // by anyone but its author (PUT is owner-only server-side regardless,
      // see IdentityServer.js). Strips the toolbar down to a plain label
      // rather than leaving Save/Send/visibility controls that would just
      // 403 or make no sense for someone who isn't the owner.
      _applyReadOnlyMode: function () {
        if (this._isOwner) return;
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
        if (this._pmContainer) this._pmContainer.style.top = '28px';
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
        // Belt-and-suspenders: _applyReadOnlyMode already makes the
        // ProseMirror view non-editable for non-owners, so this shouldn't
        // fire from real user input, but PUT is owner-only server-side
        // regardless — no reason to ever schedule a save that can only 403.
        if (!this._isOwner) return;
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
        var params = {
          yDoc:          this.yDoc,
          prevEnvelope:  this._envelope || null,
          constellation: this._constellation,
          replyTo:       this._replyTo,
          visibility:    'public',
          // title omitted — PostCardSerializer extracts it from the first PM block (§10.5)
        };
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
              stateMeta: {
                recipientHandles: result.resolved.map(function (r) { return r.handle; }),
              },
            };
            lively.identity.postCardSerializer.serializeEncrypted(params, function (err, envelope) {
              self._finishSave(err, envelope, cb);
            });
          });
        });
      },

      // Resolve each handle to { did, handle, x25519PublicKey }, cached
      // per-session so repeated autosaves of a shared card don't refetch
      // every recipient's profile on every 2s debounce tick.
      // Calls thenDo(null, { resolved: [...], failed: [handle, ...] }).
      _resolveRecipientPubKeys: function (handles, thenDo) {
        var self = this;
        if (!handles || !handles.length) return thenDo(null, { resolved: [], failed: [] });
        if (!this._recipientPubKeyCache) this._recipientPubKeyCache = {};

        var base = lively.identity.did.baseUrl();
        var resolved = [];
        var failed = [];
        var remaining = handles.length;

        function done() {
          if (--remaining === 0) thenDo(null, { resolved: resolved, failed: failed });
        }

        handles.forEach(function (handle) {
          var cached = self._recipientPubKeyCache[handle];
          if (cached) { resolved.push(cached); return done(); }

          lively.identity.webKey.resolveHandle(handle, function (err, info) {
            if (err || !info || !info.did) { failed.push(handle); return done(); }
            var xhr = new XMLHttpRequest();
            xhr.open('GET', base + '/@' + encodeURIComponent(handle) + '/profile', true);
            xhr.withCredentials = true;
            xhr.onload = function () {
              var pub = null;
              if (xhr.status === 200) {
                try {
                  var env = JSON.parse(xhr.responseText);
                  pub = env.record && env.record.payload && env.record.payload.accountX25519Pub;
                } catch (e) { /* fall through to failed */ }
              }
              if (!pub) { failed.push(handle); return done(); }
              var entry = { did: info.did, handle: handle, x25519PublicKey: pub };
              self._recipientPubKeyCache[handle] = entry;
              resolved.push(entry);
              done();
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

          // Private/shared: grant access first — add as a recipient (if not
          // already one) and reseal, then notify once that's landed.
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
              return thenDo(new Error('@' + handle + ' has not published an encryption key yet — cannot share with them.'));
            }
            self._postInbox(handle, thenDo);
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

      // Builds the PostCard ProseMirror schema: prose nodes + math + embeddedPart.
      _buildSchema: function (modelModule) {
        return new modelModule.Schema({
          nodes: {
            doc:          { content: 'block+' },
            paragraph:    { group: 'block', content: 'inline*',
                            parseDOM: [{ tag: 'p' }], toDOM: function() { return ['p', 0]; } },
            heading:      { group: 'block', content: 'inline*', attrs: { level: { default: 1 } },
                            parseDOM: [1,2,3,4,5,6].map(function(l) { return { tag: 'h'+l, attrs: { level: l } }; }),
                            toDOM: function(n) { return ['h'+n.attrs.level, 0]; } },
            bullet_list:  { group: 'block', content: 'list_item+',
                            parseDOM: [{ tag: 'ul' }], toDOM: function() { return ['ul', 0]; } },
            ordered_list: { group: 'block', content: 'list_item+', attrs: { order: { default: 1 } },
                            parseDOM: [{ tag: 'ol' }], toDOM: function() { return ['ol', 0]; } },
            list_item:    { content: 'paragraph block*',
                            parseDOM: [{ tag: 'li' }], toDOM: function() { return ['li', 0]; } },
            blockquote:   { group: 'block', content: 'block+',
                            parseDOM: [{ tag: 'blockquote' }], toDOM: function() { return ['blockquote', 0]; } },
            code_block:   { group: 'block', content: 'text*', marks: '',
                            parseDOM: [{ tag: 'pre' }], toDOM: function() { return ['pre', ['code', 0]]; } },
            // Math nodes (§10.1): attrs.value holds the LaTeX source string.
            // atom:true keeps the cursor outside the node; editing is via the value attr.
            // TODO (later session): add a KaTeX NodeView that renders the formula when
            // the node is not selected and shows an editable input when it is — the
            // standard prosemirror-math interaction pattern. Also load KaTeX from CDN.
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
            text:         { group: 'inline' },
            hard_break:   { group: 'inline', inline: true, selectable: false,
                            parseDOM: [{ tag: 'br' }], toDOM: function() { return ['br']; } },
          },
          marks: {
            bold:   { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: function() { return ['strong', 0]; } },
            italic: { parseDOM: [{ tag: 'em' }, { tag: 'i' }],     toDOM: function() { return ['em', 0]; } },
            code:   { parseDOM: [{ tag: 'code' }],                  toDOM: function() { return ['code', 0]; } },
            link:   { attrs: { href: {}, title: { default: null } },
                      parseDOM: [{ tag: 'a[href]', getAttrs: function(d) { return { href: d.getAttribute('href'), title: d.getAttribute('title') }; } }],
                      toDOM: function(m) {
                        var href = m.attrs.href || '';
                        var scheme = /^([a-z][a-z0-9+.\-]*):/i.exec(href);
                        var safeHref = (!scheme || scheme[1].toLowerCase() === 'http' || scheme[1].toLowerCase() === 'https' || scheme[1].toLowerCase() === 'mailto') ? href : '#';
                        return ['a', { href: safeHref, title: m.attrs.title, rel: 'noopener noreferrer' }, 0];
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
