/**
 * lively.identity.FilesBrowser
 *
 * Browser for the user's encrypted-by-default file space (Encryption.md §5).
 * Files are "file"-type envelopes (listed via the home manifest, GET
 * /@:handle) whose bytes live in the content-addressed BlobStore
 * (PUT/GET/DELETE /@:handle/blobs/:cid) — see lively.identity.FileCrypto for
 * the encrypt-before-upload / decrypt-after-fetch logic.
 *
 * Uploads default to private (§0 goal: encrypted unless explicitly public);
 * an "Upload as public" checkbox opts a given upload out for cases like
 * banners that must stay anonymously fetchable (ProfileCard.js handles
 * avatars/banners itself, always passing visibility: 'public' explicitly —
 * see FileCrypto.encryptAndUpload). There is deliberately no folder/move
 * support here (§5.5 doesn't call for it, and the new model has no path
 * concept — objects are flat, addressed by objId) — a real reduction from
 * the legacy plaintext-uploads browser this replaces, traded for the
 * encryption-by-default guarantee.
 *
 * Entry point:
 *   lively.identity.FilesBrowser.open()
 */

module('lively.identity.FilesBrowser')
  .requires(
    'lively.identity.DID',
    'lively.identity.FileCrypto',
    'lively.identity.FilePreview',
    'lively.identity.WarpDrop',
  )
  .toRun(function () {

    var IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
    var PREVIEWABLE_EXTS = IMAGE_EXTS.concat(
      ['txt', 'json', 'md', 'js', 'css', 'html', 'csv', 'log'],
      ['mp3', 'wav', 'ogg'],
      ['mp4', 'webm', 'mov'],
    );

    // Modern content design system for the toolbar / cards / buttons —
    // same token-and-component approach as PostCardMailbox.js's own
    // _ensureMailboxContentStyle (see that file for the fuller writeup),
    // duplicated here under its own `.fls-root`/`fls-*` prefix rather than
    // shared, since these are independent windows/modules — matches this
    // codebase's existing tolerance for small per-module style copies
    // (see LocalMap.js's _ensureGeoRuntime comment). Blue accent, distinct
    // from Mailbox's green and Wallet's purple. The public/private badge
    // pair deliberately uses its own fixed warn/neutral colors rather than
    // this accent token, so the two stay visually distinct regardless of
    // which color a given window's accent happens to be.
    function _ensureFilesContentStyle() {
      var STYLE_ID = 'files-browser-content-style';
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        '.fls-root {',
        '  --fls-bg: #fafafa; --fls-surface: #ffffff;',
        '  --fls-border: #e4e4e7; --fls-border-strong: #d4d4d8;',
        '  --fls-text: #18181b; --fls-text-secondary: #52525b; --fls-text-tertiary: #a1a1aa;',
        '  --fls-accent: #2563eb; --fls-accent-soft: #eff6ff; --fls-accent-soft-border: #bfdbfe;',
        '  --fls-danger: #e11d48; --fls-danger-soft: #fff1f2; --fls-danger-soft-border: #fecdd3;',
        '  --fls-warn: #b45309; --fls-warn-soft: #fffbeb; --fls-warn-soft-border: #fde68a;',
        '  --fls-radius: 12px; --fls-radius-sm: 8px; --fls-radius-pill: 999px;',
        '  --fls-shadow-card: 0 1px 2px rgba(24,24,27,0.04), 0 1px 8px rgba(24,24,27,0.04);',
        '  --fls-shadow-card-hover: 0 2px 6px rgba(24,24,27,0.06), 0 4px 16px rgba(24,24,27,0.08);',
        '  --fls-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;',
        '  font-family: var(--fls-font);',
        '}',
        '.fls-content::-webkit-scrollbar { width: 9px; height: 9px; }',
        '.fls-content::-webkit-scrollbar-thumb { background: var(--fls-border-strong); border-radius: 5px; border: 2px solid var(--fls-bg); }',
        '.fls-content::-webkit-scrollbar-track { background: transparent; }',

        '.fls-toolbar { display: flex; align-items: center; gap: 10px; height: 100%; }',
        '.fls-toolbar-label { flex: 1; color: var(--fls-text); font-weight: 600; font-size: 12.5px; }',

        '.fls-toggle { font-size: 11.5px; color: var(--fls-text-secondary); display: flex; align-items: center;',
        '  gap: 5px; cursor: pointer; user-select: none; }',
        '.fls-toggle input { accent-color: var(--fls-accent); }',

        '.fls-status { font-size: 11px; color: var(--fls-text-tertiary); white-space: nowrap; }',

        '.fls-card { background: var(--fls-surface); border: 1px solid var(--fls-border);',
        '  border-radius: var(--fls-radius); padding: 12px 14px; margin-bottom: 8px; position: relative;',
        '  box-shadow: var(--fls-shadow-card); transition: box-shadow .15s, border-color .15s; }',
        '.fls-card:hover { box-shadow: var(--fls-shadow-card-hover); border-color: var(--fls-border-strong); }',

        '.fls-empty { display: flex; flex-direction: column; align-items: center; justify-content: center;',
        '  gap: 8px; color: var(--fls-text-tertiary); padding: 48px 16px; text-align: center; font-size: 12.5px; }',
        '.fls-empty-icon { font-family: "Material Symbols Rounded"; font-size: 32px; color: var(--fls-border-strong); }',
        '.fls-empty.danger { color: var(--fls-danger); }',
        '.fls-empty.danger .fls-empty-icon { color: var(--fls-danger); }',

        '.fls-btn { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 500;',
        '  padding: 5px 11px; cursor: pointer; border-radius: var(--fls-radius-pill); border: 1px solid var(--fls-border);',
        '  background: var(--fls-surface); color: var(--fls-text-secondary); font-family: var(--fls-font);',
        '  transition: background .15s, border-color .15s, color .15s; white-space: nowrap; }',
        '.fls-btn:hover { background: var(--fls-bg); }',
        '.fls-btn:disabled { opacity: .5; cursor: default; }',
        '.fls-btn-icon-glyph { font-family: "Material Symbols Rounded"; font-size: 13px; line-height: 1; }',
        '.fls-btn-accent { border-color: var(--fls-accent-soft-border); color: var(--fls-accent); background: var(--fls-accent-soft); }',
        '.fls-btn-accent:hover { background: var(--fls-accent-soft-border); }',
        '.fls-btn-danger { border-color: var(--fls-danger-soft-border); color: var(--fls-danger); background: var(--fls-danger-soft); }',
        '.fls-btn-danger:hover { background: var(--fls-danger-soft-border); }',
        '.fls-btn-ghost-danger { border-color: var(--fls-border); color: var(--fls-danger); background: var(--fls-surface); }',
        '.fls-btn-ghost-danger:hover { background: var(--fls-danger-soft); border-color: var(--fls-danger-soft-border); }',

        '.fls-badge { display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px; font-size: 10px;',
        '  font-weight: 600; border-radius: var(--fls-radius-pill); background: var(--fls-bg); color: var(--fls-text-tertiary); }',
        '.fls-badge-icon { font-family: "Material Symbols Rounded"; font-size: 11px; line-height: 1; }',
        '.fls-badge-public { background: var(--fls-warn-soft); color: var(--fls-warn); }',
        // Neutral rather than tied to --fls-accent, so it stays distinct
        // from the accent-colored buttons regardless of which color a
        // given window's accent happens to be (see comment above).
        '.fls-badge-private { background: var(--fls-border); color: var(--fls-text-secondary); }',

        '.fls-file-icon { width: 38px; height: 38px; border-radius: var(--fls-radius-sm); flex: none;',
        '  display: flex; align-items: center; justify-content: center; background: var(--fls-bg);',
        '  color: var(--fls-text-tertiary); font-family: "Material Symbols Rounded"; font-size: 19px; }',
        '.fls-file-thumb { width: 38px; height: 38px; object-fit: cover; border-radius: var(--fls-radius-sm);',
        '  flex: none; border: 1px solid var(--fls-border); box-sizing: border-box; }',
      ].join('\n');
      document.head.appendChild(styleEl);
    }

    // Same accent-chrome fix DMChat.js/Wallet.js/PostCardMailbox.js already
    // apply (title-text contrast + suppressing the base theme's white
    // focus-ring border on `.highlighted`) — see PostCardMailbox.js's own
    // _ensureAccentChromeCss for the confirmed-live bug writeup this
    // pattern fixes.
    function _ensureAccentChromeCss() {
      var STYLE_ID = 'files-browser-accent-chrome-style';
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        '.Window.files-accent-chrome { background-color: #2563EB !important; }',
        '.Window.files-accent-chrome .Text.window-title { color: #fff; }',
        '.Window.files-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }',
        '.Window.files-accent-chrome.highlighted { border: none !important; box-shadow: 0px 3px 10px rgba(10,30,80,0.35) !important; }',
      ].join('\n');
      document.head.appendChild(styleEl);
    }

    var FilesBrowserClass = lively.morphic.Box.subclass('lively.identity.FilesBrowser',

    'serialization', {
      doNotSerialize: ['_contentDiv', '_toolbarDiv'],
    },

    'initialization', {

      initialize: function ($super, bounds) {
        $super(bounds);
        this._contentDiv = null;
        this._toolbarDiv = null;
        this._files = []; // raw file-type envelopes from the home manifest
        this._buildChrome();
        this._loadFiles();
      },

      // Chrome (title bar, close button) is now the real classic
      // lively.morphic.Window this morph is framed in via openInWindow()
      // below — see CalendarApp.js's identical precedent — so this only
      // builds the toolbar / content area, not a hand-rolled title bar.
      _buildChrome: function () {
        _ensureFilesContentStyle();
        this.setFill(Color.white);
        this.setDroppingEnabled(false);
        var shapeNode = this.renderContext().shapeNode;
        shapeNode.classList.add('fls-root');

        var toolbarDiv = document.createElement('div');
        toolbarDiv.style.cssText = [
          'position:absolute', 'top:0', 'left:0', 'right:0', 'height:44px',
          'background:var(--fls-surface)', 'border-bottom:1px solid var(--fls-border)',
          'display:flex', 'align-items:center', 'padding:0 14px', 'box-sizing:border-box',
        ].join(';');
        shapeNode.appendChild(toolbarDiv);
        this._toolbarDiv = toolbarDiv;

        var contentDiv = document.createElement('div');
        contentDiv.className = 'fls-content';
        contentDiv.style.cssText = [
          'position:absolute', 'top:44px', 'left:0', 'right:0', 'bottom:0',
          'overflow-y:auto', 'padding:14px 16px', 'box-sizing:border-box',
          'font-family:var(--fls-font)', 'font-size:13px', 'background:var(--fls-bg)',
        ].join(';');
        shapeNode.appendChild(contentDiv);
        this._contentDiv = contentDiv;

        this._renderToolbar();
      },

      // Centered icon + message — same helper shape as
      // PostCardMailbox.js's _emptyHtml/_emptyEl.
      _emptyHtml: function (icon, text, danger) {
        return '<div class="fls-empty' + (danger ? ' danger' : '') + '"><span class="fls-empty-icon">' + icon + '</span><div>' + text + '</div></div>';
      },

      // ── data fetching ─────────────────────────────────────────────────────

      _loadFiles: function () {
        var self = this;
        var handle = lively.identity.did.currentUser().handle;
        var base = lively.identity.did.baseUrl();
        this._contentDiv.innerHTML = this._emptyHtml('hourglass_top', 'Loading…');
        // Accept header is required here, not optional: GET /@:handle content-
        // negotiates between the JSON object listing and an HTML profile-card
        // page (IdentityServer.js), and a fetch() with no explicit Accept
        // sends "*/*", which that route's req.accepts(["html","json"]) then
        // resolves to "html" (first match wins) — silently handing this res.json()
        // call an HTML page to parse, hence "Unexpected token '<'".
        fetch(base + '/@' + handle, { credentials: 'include', headers: { 'Accept': 'application/json' } })
          .then(function (res) {
            if (!res.ok) throw new Error('Could not load files (' + res.status + ')');
            return res.json();
          })
          .then(function (body) {
            self._files = (body.objects || []).filter(function (e) { return e.type === 'file'; });
            self._files.sort(function (a, b) { return (b.created || '').localeCompare(a.created || ''); });
            self._renderContent();
          })
          .catch(function (e) { self._showError(e.message); });
      },

      _uploadFile: function (file, isPublic, thenDo) {
        var self = this;
        lively.identity.fileCrypto.encryptAndUpload(file, {
          visibility: isPublic ? 'public' : 'private',
          onWaiting: function () { self._setUploadStatus('Confirm passkey…'); },
        }, function (err) { thenDo(err); });
      },

      // Deletes the underlying blob so the ciphertext/plaintext bytes are
      // actually reclaimed. The envelope itself is not deletable — objects.db
      // is an append-only version log (same as worlds/postcards) — so the
      // listing entry is hidden client-side rather than removed server-side;
      // re-opening it after this will 404 on the (now-gone) blob.
      _deleteFile: function (envelope, thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base = lively.identity.did.baseUrl();
        fetch(base + '/@' + handle + '/blobs/' + envelope.blobCid, {
          method: 'DELETE',
          credentials: 'include',
        }).then(function (res) {
          if (!res.ok) return res.json().then(function (b) {
            throw new Error(b.error || ('Delete failed: ' + res.status));
          });
          thenDo(null);
        }).catch(function (e) { thenDo(e); });
      },

      // ── rendering ─────────────────────────────────────────────────────────

      _renderToolbar: function () {
        var self = this;
        var bar = this._toolbarDiv;
        bar.innerHTML = '';
        bar.className = 'fls-toolbar';

        var label = document.createElement('span');
        label.textContent = 'Your files';
        label.className = 'fls-toolbar-label';
        bar.appendChild(label);

        var statusSpan = document.createElement('span');
        statusSpan.className = 'fls-status';
        bar.appendChild(statusSpan);
        this._uploadStatusSpan = statusSpan;

        var publicToggle = document.createElement('label');
        publicToggle.className = 'fls-toggle';
        var publicCheckbox = document.createElement('input');
        publicCheckbox.type = 'checkbox';
        publicToggle.appendChild(publicCheckbox);
        publicToggle.appendChild(document.createTextNode('Public'));
        bar.appendChild(publicToggle);

        var uploadBtn = this._makeToolbarBtn('upload', 'Upload', 'accent');
        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', function () {
          var f = fileInput.files[0];
          fileInput.value = '';
          if (!f) return;
          uploadBtn.disabled = true;
          self._setUploadStatus('Encrypting…');
          self._uploadFile(f, publicCheckbox.checked, function (err) {
            uploadBtn.disabled = false;
            self._setUploadStatus('');
            if (err) return self._showError(err.message);
            self._loadFiles();
          });
        });
        uploadBtn.addEventListener('click', function () { fileInput.click(); });
        bar.appendChild(uploadBtn);
        bar.appendChild(fileInput);

        var dropBtn = this._makeToolbarBtn('bolt', 'Drop', 'plain');
        dropBtn.addEventListener('click', function () {
          lively.require('lively.identity.WarpDrop').toRun(function () {
            lively.identity.WarpDrop.open();
          });
        });
        bar.appendChild(dropBtn);
      },

      _setUploadStatus: function (msg) {
        if (this._uploadStatusSpan) this._uploadStatusSpan.textContent = msg;
      },

      // variant: 'accent' or 'plain' (matching pcm-btn-* naming elsewhere
      // in this codebase — see PostCardMailbox.js's _makeIconTextButton).
      _makeToolbarBtn: function (glyph, label, variant) {
        var btn = document.createElement('button');
        btn.className = 'fls-btn' + (variant === 'accent' ? ' fls-btn-accent' : '');
        var icon = document.createElement('span');
        icon.className = 'fls-btn-icon-glyph';
        icon.textContent = glyph;
        btn.appendChild(icon);
        btn.appendChild(document.createTextNode(label));
        return btn;
      },

      _renderContent: function () {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        if (!this._files.length) {
          content.innerHTML = this._emptyHtml('folder_open', 'No files yet.');
          return;
        }

        this._files.forEach(function (envelope) {
          var card = self._makeCard();
          var name = (envelope.state && envelope.state.name) || envelope.objId;
          var ext = self._extOf(name);
          var isPublic = envelope.visibility === 'public';

          var row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding-right:132px;';

          if (IMAGE_EXTS.indexOf(ext) !== -1 && isPublic) {
            var thumb = document.createElement('img');
            var meta = envelope.record && envelope.record.payload;
            var handle = lively.identity.did.currentUser().handle;
            var base = lively.identity.did.baseUrl();
            thumb.src = base + '/@' + handle + '/blobs/' + (meta && meta.blobCid);
            thumb.className = 'fls-file-thumb';
            row.appendChild(thumb);
          } else {
            var icon = document.createElement('div');
            icon.className = 'fls-file-icon';
            icon.textContent = self._iconFor(ext);
            row.appendChild(icon);
          }

          var info = document.createElement('div');
          info.style.cssText = 'min-width:0;';
          var nameDiv = document.createElement('div');
          nameDiv.style.cssText = 'font-weight:600;color:var(--fls-text);word-break:break-all;margin-bottom:3px;';
          nameDiv.textContent = name;
          info.appendChild(nameDiv);

          var badge = document.createElement('span');
          badge.className = 'fls-badge ' + (isPublic ? 'fls-badge-public' : 'fls-badge-private');
          var badgeIcon = document.createElement('span');
          badgeIcon.className = 'fls-badge-icon';
          badgeIcon.textContent = isPublic ? 'public' : 'lock';
          badge.appendChild(badgeIcon);
          badge.appendChild(document.createTextNode(isPublic ? 'Public' : 'Private'));
          info.appendChild(badge);

          var metaDiv = document.createElement('div');
          metaDiv.style.cssText = 'color:var(--fls-text-tertiary);font-size:11px;margin-top:3px;';
          var sizeText = (envelope.record && envelope.record.payload && typeof envelope.record.payload.size === 'number')
            ? self._formatSize(envelope.record.payload.size) : 'encrypted';
          metaDiv.textContent = sizeText + ' · ' + self._formatDate(envelope.created);
          info.appendChild(metaDiv);
          row.appendChild(info);

          card.appendChild(row);

          var actions = document.createElement('div');
          actions.style.cssText = 'position:absolute;top:12px;right:14px;display:flex;gap:6px;align-items:center;';

          var openBtn = document.createElement('button');
          openBtn.textContent = 'Open';
          openBtn.className = 'fls-btn fls-btn-accent';
          openBtn.addEventListener('click', function () { self._openFile(envelope); });
          actions.appendChild(openBtn);

          var deleteBtn = document.createElement('button');
          deleteBtn.textContent = 'Delete';
          deleteBtn.className = 'fls-btn fls-btn-ghost-danger';
          deleteBtn.addEventListener('click', function () {
            $world.confirm('Delete ' + name + '?', function (ok) {
              if (!ok) return;
              deleteBtn.disabled = true;
              self._deleteFile(envelope, function (err) {
                deleteBtn.disabled = false;
                if (err) return self._showError(err.message || 'Failed to delete');
                self._loadFiles();
              });
            });
          });
          actions.appendChild(deleteBtn);

          card.appendChild(actions);
          content.appendChild(card);
        });
      },

      _openFile: function (envelope) {
        var self = this;
        var name = (envelope.state && envelope.state.name) || envelope.objId;
        var ext = this._extOf(name);
        var handle = lively.identity.did.currentUser().handle;

        lively.identity.fileCrypto.objectUrlFor(handle, envelope.objId, function (err, url) {
          if (err) return self._showError('Could not open file: ' + err.message);
          if (PREVIEWABLE_EXTS.indexOf(ext) !== -1) {
            lively.require('lively.identity.FilePreview').toRun(function () {
              lively.identity.FilePreview.open({ path: name, url: url });
            });
          } else {
            window.open(url, '_blank');
          }
        });
      },

      // ── helpers ───────────────────────────────────────────────────────────

      _makeCard: function () {
        var card = document.createElement('div');
        card.className = 'fls-card';
        return card;
      },

      _extOf: function (p) {
        var m = /\.([a-z0-9]+)$/i.exec(p || '');
        return m ? m[1].toLowerCase() : '';
      },

      // Material Symbols Rounded glyph for a non-image/non-thumbnailed
      // file's icon tile, grouped by rough file family.
      _iconFor: function (ext) {
        if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].indexOf(ext) !== -1) return 'audio_file';
        if (['mp4', 'webm', 'mov', 'avi', 'mkv'].indexOf(ext) !== -1) return 'video_file';
        if (IMAGE_EXTS.indexOf(ext) !== -1) return 'image';
        if (['zip', 'rar', '7z', 'tar', 'gz'].indexOf(ext) !== -1) return 'folder_zip';
        if (ext === 'pdf') return 'picture_as_pdf';
        if (['txt', 'md', 'log'].indexOf(ext) !== -1) return 'description';
        if (['js', 'css', 'html', 'json', 'csv'].indexOf(ext) !== -1) return 'code';
        return 'draft';
      },

      _formatSize: function (bytes) {
        if (typeof bytes !== 'number') return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      },

      _formatDate: function (iso) {
        if (!iso) return '';
        try {
          var d = new Date(iso);
          return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) { return iso; }
      },

      _showError: function (msg) {
        this._contentDiv.innerHTML = this._emptyHtml('error', msg, true);
      },

    }); // end subclass

    // ── class-side entry point ───────────────────────────────────────────────

    Object.extend(FilesBrowserClass, {
      open: function () {
        // 520px wide — the toolbar's pill buttons + "Public" toggle need a
        // bit more room than the old plain-text buttons did.
        var morph = new lively.identity.FilesBrowser(lively.rect(0, 0, 520, 460));
        morph.setName('Files');
        // Real classic Window chrome (drag/resize/collapse/close, Material
        // Symbols icon controls by default) rather than the hand-rolled
        // title bar this used to draw itself — same pattern as
        // CalendarApp.js's CalendarAppClass.open.
        morph.openInWindow({
          title: 'Files',
          pos: lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(260, 230)),
        });
        var win = morph.getWindow();
        _ensureAccentChromeCss();
        win.addStyleClassName('files-accent-chrome');
        win.comeForward();
        return morph;
      },
    });

  }); // end module('lively.identity.FilesBrowser')
