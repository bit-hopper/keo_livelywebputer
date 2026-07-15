/**
 * lively.identity.FilesBrowser
 *
 * Browser for the user's own upload space (GET/POST /@:handle/uploads,
 * GET/PUT/DELETE /@:handle/uploads/<path>, POST /@:handle/uploads/move —
 * see IdentityServer.js), backed by identity/uploads/<handle>/ on disk.
 * Supports folder navigation, uploading, moving files between folders,
 * and previewing/opening a file without leaving the world (via
 * lively.identity.FilePreview for image/text/audio/video; everything
 * else falls back to window.open()).
 *
 * Entry point:
 *   lively.identity.FilesBrowser.open()
 */

module('lively.identity.FilesBrowser')
  .requires(
    'lively.identity.DID',
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
        this._contentDiv  = null;
        this._toolbarDiv  = null;
        this._currentFolder = '';
        this._files   = [];
        this._folders = [];
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
      },

      // ── data fetching ─────────────────────────────────────────────────────

      _loadFiles: function () {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        this._contentDiv.innerHTML = '<div style="color:#999;padding:20px 0;">Loading…</div>';
        var xhr = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/uploads');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError('Could not load files (' + xhr.status + ')');
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { return self._showError('Bad response'); }
          self._files   = result.files   || [];
          self._folders = result.folders || [];
          self._render();
        };
        xhr.onerror = function () { self._showError('Network error'); };
        xhr.send();
      },

      _createFolder: function (folderPath, thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open('POST', base + '/@' + handle + '/uploads');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status === 200) return thenDo(null);
          thenDo(new Error('Create folder failed: ' + xhr.status));
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send(JSON.stringify({ path: folderPath }));
      },

      _uploadFile: function (fileObj, destFolder, thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var relPath = (destFolder ? destFolder + '/' : '') + fileObj.name;
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', base + '/@' + handle + '/uploads/' +
          relPath.split('/').map(encodeURIComponent).join('/'));
        // Force a neutral content type rather than the browser's
        // extension-guessed one (e.g. "application/json" for a .json
        // file): the server's global body-parser middleware would
        // otherwise intercept and consume the request stream for
        // json/urlencoded/multipart types, leaving the upload route's
        // raw-stream fallback (req.on('data', ...)) with nothing to
        // read — the request would just hang.
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status === 200) return thenDo(null);
          thenDo(new Error('Upload failed: ' + xhr.status));
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send(fileObj);
      },

      _moveFile: function (fromPath, toFolder, thenDo) {
        var handle   = lively.identity.did.currentUser().handle;
        var base     = lively.identity.did.baseUrl();
        var filename = fromPath.split('/').pop();
        var toPath   = (toFolder ? toFolder + '/' : '') + filename;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', base + '/@' + handle + '/uploads/move');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status === 200) return thenDo(null);
          thenDo(new Error('Move failed: ' + xhr.status));
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send(JSON.stringify({ from: fromPath, to: toPath }));
      },

      _deleteFile: function (relPath, thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open('DELETE', base + '/@' + handle + '/uploads/' +
          relPath.split('/').map(encodeURIComponent).join('/'));
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status === 200) return thenDo(null);
          thenDo(new Error('Delete failed: ' + xhr.status));
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send();
      },

      // ── rendering ─────────────────────────────────────────────────────────

      _render: function () {
        this._renderToolbar();
        this._renderContent();
      },

      _renderToolbar: function () {
        var self = this;
        var bar  = this._toolbarDiv;
        bar.innerHTML = '';

        // breadcrumb
        var crumbWrap = document.createElement('div');
        crumbWrap.style.cssText = 'flex:1;overflow:hidden;white-space:nowrap;font-size:12px;';
        var segments = this._currentFolder ? this._currentFolder.split('/') : [];
        function addCrumb(label, folderPath, isLast) {
          var span = document.createElement('span');
          span.textContent = label;
          span.style.cssText = isLast
            ? 'color:#1c1c1e;font-weight:600;'
            : 'color:#007aff;cursor:pointer;';
          if (!isLast) {
            span.addEventListener('click', function () {
              self._currentFolder = folderPath;
              self._render();
            });
          }
          crumbWrap.appendChild(span);
          if (!isLast) {
            var sep = document.createElement('span');
            sep.textContent = ' / ';
            sep.style.color = '#8e8e93';
            crumbWrap.appendChild(sep);
          }
        }
        addCrumb('Files', '', segments.length === 0);
        var acc = '';
        segments.forEach(function (seg, i) {
          acc = acc ? acc + '/' + seg : seg;
          addCrumb(seg, acc, i === segments.length - 1);
        });
        bar.appendChild(crumbWrap);

        var newFolderBtn = this._makeToolbarBtn('New Folder');
        newFolderBtn.addEventListener('click', function () {
          self._promptText('New folder name', '', function (name) {
            if (!name) return;
            var folderPath = (self._currentFolder ? self._currentFolder + '/' : '') + name;
            self._createFolder(folderPath, function (err) {
              if (err) return self._showError(err.message);
              self._loadFiles();
            });
          });
        });
        bar.appendChild(newFolderBtn);

        var uploadBtn = this._makeToolbarBtn('Upload');
        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', function () {
          var f = fileInput.files[0];
          fileInput.value = '';
          if (!f) return;
          uploadBtn.disabled = true;
          self._uploadFile(f, self._currentFolder, function (err) {
            uploadBtn.disabled = false;
            if (err) return self._showError(err.message);
            self._loadFiles();
          });
        });
        uploadBtn.addEventListener('click', function () { fileInput.click(); });
        bar.appendChild(uploadBtn);
        bar.appendChild(fileInput);

        var dropBtn = this._makeToolbarBtn('Drop');
        dropBtn.addEventListener('click', function () {
          lively.require('lively.identity.WarpDrop').toRun(function () {
            lively.identity.WarpDrop.open();
          });
        });
        bar.appendChild(dropBtn);
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
        var self    = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var prefix = this._currentFolder ? this._currentFolder + '/' : '';
        var subfolders = this._folders.filter(function (f) {
          if (self._currentFolder) {
            if (f === self._currentFolder || f.indexOf(prefix) !== 0) return false;
          }
          var rest = f.slice(prefix.length);
          return rest.length > 0 && rest.indexOf('/') === -1;
        });
        var filesHere = this._files.filter(function (f) {
          var dir = f.path.indexOf('/') === -1 ? '' : f.path.slice(0, f.path.lastIndexOf('/'));
          return dir === self._currentFolder;
        });

        if (!subfolders.length && !filesHere.length) {
          content.innerHTML = '<div style="color:#999;padding:20px 0;text-align:center;">Empty folder.</div>';
          return;
        }

        subfolders.forEach(function (folderPath) {
          var name = folderPath.slice(prefix.length);
          var card = self._makeCard();
          card.style.cursor = 'pointer';

          var label = document.createElement('div');
          label.style.cssText = 'font-weight:600;color:#1c1c1e;';
          label.textContent = '📁 ' + name;
          card.appendChild(label);

          card.addEventListener('click', function () {
            self._currentFolder = folderPath;
            self._render();
          });
          content.appendChild(card);
        });

        filesHere.forEach(function (f) {
          var card = self._makeCard();

          var row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:10px;padding-right:170px;';

          var ext = self._extOf(f.path);
          if (IMAGE_EXTS.indexOf(ext) !== -1) {
            var thumb = document.createElement('img');
            thumb.src = f.url;
            thumb.style.cssText = 'width:36px;height:36px;object-fit:cover;border-radius:4px;flex:none;';
            row.appendChild(thumb);
          }

          var info = document.createElement('div');
          info.style.cssText = 'min-width:0;';
          var name = document.createElement('div');
          name.style.cssText = 'font-weight:600;color:#1c1c1e;word-break:break-all;';
          name.textContent = f.path.slice(prefix.length);
          var meta = document.createElement('div');
          meta.style.cssText = 'color:#8e8e93;font-size:11px;';
          meta.textContent = self._formatSize(f.size) + ' · ' + self._formatDate(f.mtime);
          info.appendChild(name);
          info.appendChild(meta);
          row.appendChild(info);

          card.appendChild(row);

          var openBtn = document.createElement('button');
          openBtn.textContent = 'Open';
          openBtn.style.cssText = [
            'position:absolute', 'top:10px', 'right:112px',
            'font-size:11px', 'padding:3px 8px', 'cursor:pointer',
            'border:1px solid #007aff', 'color:#007aff',
            'background:#fff', 'border-radius:4px',
          ].join(';');
          openBtn.addEventListener('click', function () { self._openFile(f); });
          card.appendChild(openBtn);

          var moveBtn = document.createElement('button');
          moveBtn.textContent = 'Move';
          moveBtn.style.cssText = [
            'position:absolute', 'top:10px', 'right:60px',
            'font-size:11px', 'padding:3px 8px', 'cursor:pointer',
            'border:1px solid #636366', 'color:#636366',
            'background:#fff', 'border-radius:4px',
          ].join(';');
          moveBtn.addEventListener('click', function () {
            self._promptText('Move to folder (blank = top level)', self._currentFolder, function (dest) {
              if (dest === null) return;
              self._moveFile(f.path, dest, function (err) {
                if (err) return self._showError(err.message);
                self._loadFiles();
              });
            });
          });
          card.appendChild(moveBtn);

          var deleteBtn = document.createElement('button');
          deleteBtn.textContent = 'Delete';
          deleteBtn.style.cssText = [
            'position:absolute', 'top:10px', 'right:10px',
            'font-size:11px', 'padding:3px 8px', 'cursor:pointer',
            'border:1px solid #ff3b30', 'color:#ff3b30',
            'background:#fff', 'border-radius:4px',
          ].join(';');
          deleteBtn.addEventListener('click', function () {
            $world.confirm('Delete ' + f.path + '?', function (ok) {
              if (!ok) return;
              deleteBtn.disabled = true;
              self._deleteFile(f.path, function (err) {
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

      _openFile: function (file) {
        var ext = this._extOf(file.path);
        if (PREVIEWABLE_EXTS.indexOf(ext) !== -1) {
          lively.require('lively.identity.FilePreview').toRun(function () {
            lively.identity.FilePreview.open(file);
          });
        } else {
          window.open(file.url, '_blank');
        }
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

      // Raw-DOM modal overlay for a single text input — matches the
      // convention already used for the avatar crop dialog (ProfileCard.js):
      // a position:fixed backdrop appended to document.body, since no morph
      // dialog widgets exist to reuse for this kind of prompt.
      _promptText: function (label, defaultValue, thenDo) {
        var overlay = document.createElement('div');
        overlay.style.cssText =
          'position:fixed;top:0;left:0;width:100%;height:100%;' +
          'background:rgba(0,0,0,0.5);z-index:99999;' +
          'display:flex;align-items:center;justify-content:center;';

        var panel = document.createElement('div');
        panel.style.cssText =
          'background:#fff;border-radius:8px;padding:16px;width:280px;' +
          'font-family:sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.3);';

        var labelEl = document.createElement('div');
        labelEl.textContent = label;
        labelEl.style.cssText = 'font-size:13px;color:#1c1c1e;margin-bottom:8px;';
        panel.appendChild(labelEl);

        var input = document.createElement('input');
        input.type = 'text';
        input.value = defaultValue || '';
        input.style.cssText =
          'width:100%;box-sizing:border-box;padding:6px 8px;font-size:13px;' +
          'border:1px solid #d1d1d6;border-radius:4px;margin-bottom:12px;';
        panel.appendChild(input);

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

        function close(result) {
          document.body.removeChild(overlay);
          thenDo(result);
        }

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText =
          'font-size:12px;padding:5px 12px;cursor:pointer;border:1px solid #d1d1d6;' +
          'background:#fff;border-radius:4px;';
        cancelBtn.addEventListener('click', function () { close(null); });

        var okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.cssText =
          'font-size:12px;padding:5px 12px;cursor:pointer;border:1px solid #007aff;' +
          'background:#007aff;color:#fff;border-radius:4px;';
        okBtn.addEventListener('click', function () { close(input.value.trim()); });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') close(input.value.trim());
          if (e.key === 'Escape') close(null);
        });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        panel.appendChild(btnRow);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        input.focus();
        input.select();
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
