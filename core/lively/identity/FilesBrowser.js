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

      _buildChrome: function () {
        this.setFill(Color.white);
        var shapeNode = this.renderContext().shapeNode;
        shapeNode.style.borderRadius = '8px';
        shapeNode.style.boxShadow    = '0 4px 16px rgba(0,0,0,0.18)';

        var titleBar = document.createElement('div');
        titleBar.style.cssText = [
          'position:absolute', 'top:0', 'left:0', 'right:0', 'height:36px',
          'background:#2c2c2e', 'border-radius:8px 8px 0 0',
          'display:flex', 'align-items:center', 'padding:0 12px',
          'box-sizing:border-box',
        ].join(';');
        var titleText = document.createElement('span');
        titleText.textContent = 'Files';
        titleText.style.cssText = 'color:#fff;font-size:13px;font-weight:600;font-family:sans-serif;';
        titleBar.appendChild(titleText);
        shapeNode.appendChild(titleBar);

        var toolbarDiv = document.createElement('div');
        toolbarDiv.style.cssText = [
          'position:absolute', 'top:36px', 'left:0', 'right:0', 'height:34px',
          'background:#f2f2f7', 'border-bottom:1px solid #d1d1d6',
          'display:flex', 'align-items:center', 'padding:0 10px',
          'box-sizing:border-box', 'gap:8px', 'font-family:sans-serif',
        ].join(';');
        shapeNode.appendChild(toolbarDiv);
        this._toolbarDiv = toolbarDiv;

        var contentDiv = document.createElement('div');
        contentDiv.style.cssText = [
          'position:absolute', 'top:70px', 'left:0', 'right:0', 'bottom:0',
          'overflow-y:auto', 'padding:12px 16px', 'box-sizing:border-box',
          'font-family:sans-serif', 'font-size:13px',
        ].join(';');
        shapeNode.appendChild(contentDiv);
        this._contentDiv = contentDiv;

        this._renderToolbar();
      },

      // ── data fetching ─────────────────────────────────────────────────────

      _loadFiles: function () {
        var self = this;
        var handle = lively.identity.did.currentUser().handle;
        var base = lively.identity.did.baseUrl();
        this._contentDiv.innerHTML = '<div style="color:#999;padding:20px 0;">Loading…</div>';
        fetch(base + '/@' + handle, { credentials: 'include' })
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

        var label = document.createElement('span');
        label.textContent = 'Your files';
        label.style.cssText = 'flex:1;color:#1c1c1e;font-weight:600;font-size:12px;';
        bar.appendChild(label);

        var publicToggle = document.createElement('label');
        publicToggle.style.cssText = 'font-size:11px;color:#636366;display:flex;align-items:center;gap:4px;cursor:pointer;';
        var publicCheckbox = document.createElement('input');
        publicCheckbox.type = 'checkbox';
        publicToggle.appendChild(publicCheckbox);
        publicToggle.appendChild(document.createTextNode('Upload as public'));
        bar.appendChild(publicToggle);

        var uploadBtn = this._makeToolbarBtn('Upload');
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

        var statusSpan = document.createElement('span');
        statusSpan.style.cssText = 'font-size:11px;color:#8e8e93;';
        bar.appendChild(statusSpan);
        this._uploadStatusSpan = statusSpan;

        var dropBtn = this._makeToolbarBtn('Drop');
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

      _makeToolbarBtn: function (label) {
        var btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = [
          'font-size:11px', 'padding:4px 10px', 'cursor:pointer',
          'border:1px solid #007aff', 'color:#007aff',
          'background:#fff', 'border-radius:4px', 'white-space:nowrap',
        ].join(';');
        return btn;
      },

      _renderContent: function () {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        if (!this._files.length) {
          content.innerHTML = '<div style="color:#999;padding:20px 0;text-align:center;">No files yet.</div>';
          return;
        }

        this._files.forEach(function (envelope) {
          var card = self._makeCard();
          var name = (envelope.state && envelope.state.name) || envelope.objId;
          var ext = self._extOf(name);

          var row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:10px;padding-right:170px;';

          if (IMAGE_EXTS.indexOf(ext) !== -1 && envelope.visibility === 'public') {
            var thumb = document.createElement('img');
            var meta = envelope.record && envelope.record.payload;
            var handle = lively.identity.did.currentUser().handle;
            var base = lively.identity.did.baseUrl();
            thumb.src = base + '/@' + handle + '/blobs/' + (meta && meta.blobCid);
            thumb.style.cssText = 'width:36px;height:36px;object-fit:cover;border-radius:4px;flex:none;';
            row.appendChild(thumb);
          } else {
            var icon = document.createElement('div');
            icon.textContent = envelope.visibility === 'public' ? '🌐' : '🔒';
            icon.style.cssText = 'width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:18px;flex:none;';
            row.appendChild(icon);
          }

          var info = document.createElement('div');
          info.style.cssText = 'min-width:0;';
          var nameDiv = document.createElement('div');
          nameDiv.style.cssText = 'font-weight:600;color:#1c1c1e;word-break:break-all;';
          nameDiv.textContent = name;
          var metaDiv = document.createElement('div');
          metaDiv.style.cssText = 'color:#8e8e93;font-size:11px;';
          var sizeText = (envelope.record && envelope.record.payload && typeof envelope.record.payload.size === 'number')
            ? self._formatSize(envelope.record.payload.size) : 'encrypted';
          metaDiv.textContent = envelope.visibility + ' · ' + sizeText + ' · ' + self._formatDate(envelope.created);
          info.appendChild(nameDiv);
          info.appendChild(metaDiv);
          row.appendChild(info);

          card.appendChild(row);

          var openBtn = document.createElement('button');
          openBtn.textContent = 'Open';
          openBtn.style.cssText = [
            'position:absolute', 'top:10px', 'right:60px',
            'font-size:11px', 'padding:3px 8px', 'cursor:pointer',
            'border:1px solid #007aff', 'color:#007aff',
            'background:#fff', 'border-radius:4px',
          ].join(';');
          openBtn.addEventListener('click', function () { self._openFile(envelope); });
          card.appendChild(openBtn);

          var deleteBtn = document.createElement('button');
          deleteBtn.textContent = 'Delete';
          deleteBtn.style.cssText = [
            'position:absolute', 'top:10px', 'right:10px',
            'font-size:11px', 'padding:3px 8px', 'cursor:pointer',
            'border:1px solid #ff3b30', 'color:#ff3b30',
            'background:#fff', 'border-radius:4px',
          ].join(';');
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
          card.appendChild(deleteBtn);

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
        card.style.cssText = [
          'background:#fff', 'border:1px solid #e5e5ea', 'border-radius:8px',
          'padding:10px 12px', 'margin-bottom:8px', 'position:relative',
        ].join(';');
        return card;
      },

      _extOf: function (p) {
        var m = /\.([a-z0-9]+)$/i.exec(p || '');
        return m ? m[1].toLowerCase() : '';
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
        this._contentDiv.innerHTML =
          '<div style="color:#ff3b30;padding:20px 0;">' + msg + '</div>';
      },

    }); // end subclass

    // ── class-side entry point ───────────────────────────────────────────────

    Object.extend(FilesBrowserClass, {
      open: function () {
        var morph = new lively.identity.FilesBrowser(lively.rect(0, 0, 480, 460));
        morph.openInWorldCenter();
        morph.bringToFront();
        return morph;
      },
    });

  }); // end module('lively.identity.FilesBrowser')
