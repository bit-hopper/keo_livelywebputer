/**
 * lively.identity.PostCardUtils
 *
 * Shared client-side utilities for rendering ProseMirror snapshot JSON as HTML.
 * Used by PostCardFeed and WikiPlayback, so those two stay in sync.
 *
 * NOT shared with the server: IdentityServer.js's `_pmNodeToHtml` is an
 * independent copy for static server-side rendering, and PostCardEditor.js's
 * ProseMirror `toDOM` specs are a third independent render path for the live
 * editor view. All three currently support a different subset of marks/nodes
 * (audit F21) — treat changes here as needing the same change made in both
 * other places until they're consolidated into one shared module.
 */

module('lively.identity.PostCardUtils')
  .requires()
  .toRun(function () {

    lively.identity = lively.identity || {};

    lively.identity.postCardUtils = {
      snapshotToHtml:      snapshotToHtml,
      pmNodeToHtml:        pmNodeToHtml,
      escapeHtml:          escapeHtml,
      identiconDataUrl:    identiconDataUrl,
      truncateDid:         truncateDid,
      truncateAddress:     truncateAddress,
      encodeLocation:      encodeLocation,
      sanitizeLocationCode: sanitizeLocationCode,
      hydrateEmbeddedParts: hydrateEmbeddedParts,
      hydrateAttachments:  hydrateAttachments,
      hydrateCodeCells:    hydrateCodeCells,
      runCodeCell:         runCodeCell,
      stopCodeCell:        stopCodeCell,
      openImageViewer:     openImageViewer,
    };

    // BUG FIX: the .lively-postcard-image/.lively-postcard-video max-width/
    // max-height sizing rules used to live ONLY inside PostCardEditor.js's
    // and WikiEditor.js's own instance-level style injection (guarded by
    // document.getElementById('lively-postcard-editor-style')) — which never
    // runs unless a PostCardEditor/WikiEditor is actually instantiated. Every
    // read-only render path (PostCardView, PostCardFeed, WikiView,
    // WikiPlayback — none of which instantiate the editor just to display a
    // card) never got this CSS at all, so images/videos rendered at full
    // native pixel size, uncropped by their container. Harmless-looking for
    // a modest-sized photo, but a full-resolution video rendered many times
    // its intended embed size — confirmed live via a permalink page
    // (/@handle/objId) that never touches the editor. This module is
    // required (transitively or directly) by every one of those read paths,
    // so injecting it here — independently of whether the editor ever loads
    // — is the actual fix. The editors keep their own (now redundant, still
    // harmless — identical values) copy of the same rules; see this
    // function's values if the two ever need to be kept in sync.
    _ensureMediaStyle();

    function _ensureMediaStyle() {
      if (document.getElementById('lively-postcard-media-style')) return;
      var styleEl = document.createElement('style');
      styleEl.id = 'lively-postcard-media-style';
      styleEl.textContent =
        '.lively-postcard-image{max-width:100%;max-height:320px;vertical-align:middle;border-radius:4px;}' +
        '.lively-postcard-video{display:block;width:100%;max-height:480px;object-fit:contain;background:#000;border-radius:4px;}' +
        '.lively-postcard-audio{max-width:100%;width:320px;display:block;}' +
        // Photo galleries (see blocksToHtml): fixed-size cells, each photo
        // zoomed to fill its cell (object-fit:cover, edges may be cropped).
        // 1 = full width, natural shape; 2 = side by side; 3 = one tall left
        // + two stacked right; 4 = 2x2.
        '.lively-media-grid{display:grid;gap:4px;margin:6px 0;}' +
        '.lively-media-grid.lively-media-n2{grid-template-columns:1fr 1fr;height:280px;}' +
        '.lively-media-grid.lively-media-n3{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;height:380px;}' +
        '.lively-media-grid.lively-media-n3 .lively-media-cell:first-child{grid-row:1 / span 2;}' +
        '.lively-media-grid.lively-media-n4{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;height:380px;}' +
        '.lively-media-cell{position:relative;overflow:hidden;border-radius:4px;min-height:0;min-width:0;}' +
        '.lively-postcard-view-content img.lively-postcard-image{cursor:zoom-in;}' +
        '.lively-media-cell img.lively-postcard-image{display:block;width:100%;height:100%;max-width:none;max-height:none;object-fit:cover;border-radius:0;}' +
        '.lively-media-grid.lively-media-n1 .lively-media-cell img.lively-postcard-image{height:auto;max-height:480px;}' +
        '.lively-embedded-part{position:relative;min-height:32px;margin:4px 0;padding:4px;}' +
        '.lively-embedded-part.lively-embed-error{color:#c33;font-style:italic;padding:8px;}' +
        // Links inside a wiki page (read-only view + editor + preview) are green,
        // not the browser's default blue. Scoped to wiki containers only: the
        // editor's ProseMirror container class is shared with PostCardEditor,
        // so WikiEditor adds its own lively-wiki-editor-container marker.
        '.lively-wiki-view-content a,.lively-wiki-editor-container a{color:#1a7f37;}' +
        '.lively-wiki-view-content a:visited,.lively-wiki-editor-container a:visited{color:#1a7f37;}' +
        '.lively-wiki-view-content a:hover,.lively-wiki-editor-container a:hover{color:#116329;}' +
        '.lively-attachment-loading{opacity:0.35;}' +
        '.lively-attachment-error{opacity:0.5;filter:grayscale(1);}' +
        // code_cell (CodeEditorSpec.md §2.3) read-only/hydrated rendering.
        // Same class name and identical rules as WikiEditor.js's own
        // editor-only copy (guarded by a separate <style> id there) so a
        // read-only view (WikiView/WikiPlayback/Preview) gets correct
        // styling without needing the editor loaded at all -- same
        // duplication-is-fine reasoning as this function's own header note
        // about postcard-image/video sizing.
        '.lively-code-cell-node{border:1px solid #ddd;border-radius:6px;margin:8px 0;' +
        'background:#fafafa;overflow:hidden;}' +
        '.lively-code-cell-header{display:flex;align-items:center;gap:8px;padding:4px 8px;' +
        'background:#eef0f5;border-bottom:1px solid #ddd;font-size:12px;}' +
        '.lively-code-cell-badge{font-weight:bold;color:#306998;}' +
        '.lively-code-cell-run-btn,.lively-code-cell-stop-btn{cursor:pointer;' +
        'border:1px solid #ccc;border-radius:3px;background:#fff;font-size:11px;padding:2px 8px;}' +
        '.lively-code-cell-stop-btn{display:none;border-color:#c33;color:#c33;}' +
        '.lively-code-cell-status{margin-left:auto;color:#666;font-style:italic;}' +
        '.lively-code-cell-source{margin:0;padding:8px;background:#282c34;color:#eee;' +
        'font-family:monospace;font-size:13px;overflow-x:auto;}' +
        '.lively-code-cell-output{padding:8px;border-top:1px solid #ddd;font-family:monospace;font-size:12px;}' +
        '.lively-code-cell-output.lively-code-cell-output-empty{color:#999;font-style:italic;}' +
        '.lively-code-cell-output pre{margin:0 0 6px 0;white-space:pre-wrap;word-break:break-word;}' +
        '.lively-code-cell-output pre.lively-code-cell-stderr{color:#c33;}' +
        '.lively-code-cell-output img{max-width:100%;display:block;margin:4px 0;}';
      document.head.appendChild(styleEl);
    }

    // Photo viewer. imgs: the <img> elements of one card, in order (their
    // current src — a decrypted blob: URL for a private photo — is read at
    // open time, so it works for every attachment kind); index: which one to
    // open. Two modes:
    //   - opts.container (an element): opens *inside* that element (the card),
    //     covering it, with an icon button that switches to the full-screen mode.
    //   - no container: full-screen, appended to document.body (not into a
    //     morph's DOM — see CLAUDE.md on overlays) so it sits above the whole
    //     world.
    // Both: X / click outside the photo / Escape closes, arrows / Left-Right
    // keys step through the card's other photos.
    var _fullscreenViewerOpen = false;

    function openImageViewer(imgs, index, opts) {
      if (!imgs || !imgs.length || typeof document === 'undefined') return;
      var container = opts && opts.container;
      var i = Math.max(0, index || 0);
      var overlay = document.createElement('div');
      overlay.style.cssText = container
        ? 'position:absolute;inset:0;z-index:20;background:#111;display:flex;align-items:center;justify-content:center;'
        : 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;';
      var full = document.createElement('img');
      full.style.cssText = (container
        ? 'max-width:100%;max-height:100%;'
        : 'max-width:96vw;max-height:94vh;box-shadow:0 4px 40px rgba(0,0,0,0.6);') +
        'object-fit:contain;border-radius:4px;';
      overlay.appendChild(full);

      // Icon buttons use the vendored Material Symbols font (ligature names).
      function btn(icon, css, title) {
        var b = document.createElement('button');
        b.textContent = icon;
        b.title = title;
        b.style.cssText = 'position:absolute;width:36px;height:36px;padding:0;border:none;border-radius:18px;' +
          "background:rgba(255,255,255,0.18);color:#fff;font-family:'Material Symbols Rounded';font-size:22px;" +
          'line-height:36px;cursor:pointer;' + css;
        overlay.appendChild(b);
        return b;
      }
      var closeBtn = btn('close', 'top:10px;right:10px;', 'Close (Esc)');
      var fsBtn = container ? btn('fullscreen', 'top:10px;right:54px;', 'Full screen') : null;
      var prevBtn = imgs.length > 1 ? btn('chevron_left', 'left:10px;top:50%;margin-top:-18px;', 'Previous') : null;
      var nextBtn = imgs.length > 1 ? btn('chevron_right', 'right:10px;top:50%;margin-top:-18px;', 'Next') : null;

      function show(n) {
        i = (n + imgs.length) % imgs.length;
        full.src = imgs[i].src;
        full.alt = imgs[i].alt || '';
      }
      function close() {
        document.removeEventListener('keydown', onKey, true);
        if (!container) _fullscreenViewerOpen = false;
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }
      function onKey(e) {
        // A full-screen viewer opened from this in-card one owns the keys.
        if (container && _fullscreenViewerOpen) return;
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowLeft' && imgs.length > 1) show(i - 1);
        else if (e.key === 'ArrowRight' && imgs.length > 1) show(i + 1);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }
      overlay.addEventListener('click', function (e) {
        e.stopPropagation();
        if (e.target === closeBtn || e.target === overlay) close();
        else if (e.target === prevBtn) show(i - 1);
        else if (e.target === nextBtn) show(i + 1);
        else if (e.target === fsBtn) openImageViewer(imgs, i);
      });
      // Keep Lively's own mouse/key handlers (registered on the window) from
      // seeing events aimed at the viewer.
      ['mousedown', 'mouseup', 'mousemove', 'keyup', 'keypress'].forEach(function (t) {
        overlay.addEventListener(t, function (e) { e.stopPropagation(); });
      });
      document.addEventListener('keydown', onKey, true);
      show(i);
      if (container) {
        container.appendChild(overlay);
      } else {
        _fullscreenViewerOpen = true;
        document.body.appendChild(overlay);
      }
    }

    function snapshotToHtml(snapshot) {
      if (!snapshot || !snapshot.content) return '';
      return blocksToHtml(snapshot.content);
    }

    // A paragraph holding nothing but images (and blank text) is a photo row.
    // Consecutive photo rows merge into one gallery, chunked 4 at a time so
    // each gallery fits one of the 1/2/3/4 layouts.
    function imageOnlyParagraph(node) {
      if (!node || node.type !== 'paragraph' || !node.content || !node.content.length) return null;
      var imgs = [];
      for (var i = 0; i < node.content.length; i++) {
        var c = node.content[i];
        if (c.type === 'image') imgs.push(c);
        else if (c.type === 'text' && !/\S/.test(c.text || '')) continue;
        else return null;
      }
      return imgs.length ? imgs : null;
    }

    function blocksToHtml(nodes) {
      var out = '', pending = [];
      function flush() {
        for (var i = 0; i < pending.length; i += 4) out += galleryHtml(pending.slice(i, i + 4));
        pending = [];
      }
      (nodes || []).forEach(function (node) {
        var imgs = imageOnlyParagraph(node);
        if (imgs) { pending = pending.concat(imgs); return; }
        flush();
        out += pmNodeToHtml(node);
      });
      flush();
      return out;
    }

    function galleryHtml(imgs) {
      return '<div class="lively-media-grid lively-media-n' + imgs.length + '">' +
        imgs.map(function (img) {
          return '<div class="lively-media-cell">' + imageTagHtml(img, '', false) + '</div>';
        }).join('') + '</div>';
    }

    function imageTagHtml(node, extraClass, decorative) {
      var src = (node.attrs && node.attrs.src) || '';
      var alt = decorative ? '' : ((node.attrs && node.attrs.alt) || '');
      var imgTitle = !decorative && node.attrs && node.attrs.title;
      var deco = decorative ? ' aria-hidden="true"' : '';
      if (!src && node.attrs && node.attrs.objId) {
        return '<img class="lively-postcard-image' + extraClass + attachmentPlaceholderClass() + '"' +
               attachmentPlaceholderAttrs(node) + ' alt="' + escapeAttr(alt) + '"' + deco + '>';
      }
      return '<img class="lively-postcard-image' + extraClass + '" src="' + escapeAttr(src) + '" alt="' + escapeAttr(alt) + '"' +
             (imgTitle ? ' title="' + escapeAttr(imgTitle) + '"' : '') + deco + '>';
    }

    // BUG FIX: no read-only view (PostCardView, PostCardFeed, WikiView,
    // WikiPlayback) ever turned a rendered .lively-embedded-part placeholder
    // into the actual live Lively morph it references — confirmed live, the
    // placeholder text is permanent, not just a brief loading state. The
    // live editor's NodeView (_embeddedPartNodeView in PostCardEditor.js/
    // WikiEditor.js) already has this exact fetch-envelope+loadPart logic;
    // this is the same thing, standalone (no ProseMirror view/getPos to
    // thread through, no selection overlay). Callers: after setting
    // .innerHTML from snapshotToHtml(...), call
    // hydrateEmbeddedParts(thatContainerEl) to upgrade every placeholder
    // inside it in place.
    function hydrateEmbeddedParts(containerEl) {
      if (!containerEl || typeof document === 'undefined') return;
      var placeholders = containerEl.querySelectorAll('.lively-embedded-part[data-obj-id]');
      Array.prototype.forEach.call(placeholders, _hydrateOneEmbeddedPart);
    }

    function _hydrateOneEmbeddedPart(el) {
      var handle = el.getAttribute('data-handle');
      var objId = el.getAttribute('data-obj-id');
      var cid = el.getAttribute('data-cid');
      // No data-handle: a pre-fix embed saved before this attr existed, or a
      // malformed one. Nothing to fetch from — leave the placeholder text.
      if (!handle || !objId) return;
      if (typeof lively === 'undefined' || !lively.require) return;

      function showError(msg) {
        el.textContent = msg;
        el.classList.add('lively-embed-error');
      }

      lively.require('lively.identity.IdentityPartsSpace').toRun(function () {
        var base = lively.identity.did.baseUrl();
        var url = base + '/@' + encodeURIComponent(handle) + '/' + encodeURIComponent(objId) +
          (cid ? ('/at/' + encodeURIComponent(cid)) : '');
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status === 404) { showError(cid ? 'This part was removed.' : 'Part not found.'); return; }
          if (xhr.status !== 200) { showError('Failed to load part: HTTP ' + xhr.status); return; }
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) { showError('Invalid part data'); return; }
          if (envelope.type !== 'part' || !envelope.record) { showError('Not a part envelope'); return; }
          var space = new lively.identity.IdentityPartsSpace(handle, null);
          var item = space.createPartItemFromEnvelope(envelope);
          if (!item) { showError('Missing partName in embedded object'); return; }
          item.loadPart(false, false, envelope.record.cid, function (err, part) {
            if (err || !part) {
              showError('Could not render part: ' + ((err && err.message) || 'unknown error'));
              return;
            }
            el.innerHTML = '';
            var partDom = part.renderContext && part.renderContext().shapeNode;
            if (partDom) el.appendChild(partDom);
            else { showError('Part has no renderable content'); return; }
            // BUG FIX: same clipping issue as the editor's NodeView (see its
            // matching fix in PostCardEditor.js/WikiEditor.js) — a Lively
            // morph's shapeNode is position:absolute and never grows el's
            // flow height, so el stayed at its ~32px min-height regardless
            // of the morph's real size.
            if (part.getExtent) {
              var partExtent = part.getExtent();
              el.style.width = partExtent.x + 'px';
              el.style.height = partExtent.y + 'px';
            }
          });
        };
        xhr.onerror = function () { showError('Network error loading part'); };
        xhr.send();
      });
    }

    // Post-processes rendered HTML from snapshotToHtml to resolve private/
    // shared attachment placeholders (img/video/audio with no src, emitted
    // by pmNodeToHtml when node.attrs.objId is set) into session-local
    // blob: URLs — the same decrypt-once-per-blobCid logic
    // PostCardEditor.js's NodeViews (_attachmentImageNodeView etc.) already
    // use live in the editor. attachments: array of
    // { objId, dek, blobCid, blobNonce, name, mime } — payload.attachments
    // from deserializeEncryptedAuto (dek/blobNonce absent for a public
    // attachment, present for private/shared). Call after
    // hydrateEmbeddedParts, once per decrypt-in-place render.
    function hydrateAttachments(containerEl, handle, attachments) {
      if (!containerEl || typeof document === 'undefined') return;
      var placeholders = containerEl.querySelectorAll('.lively-attachment-placeholder[data-obj-id]');
      Array.prototype.forEach.call(placeholders, function (el) {
        _hydrateOneAttachment(el, handle, attachments || []);
      });
    }

    function _hydrateOneAttachment(el, handle, attachments) {
      var objId = el.getAttribute('data-obj-id');
      if (!objId) return;
      if (typeof lively === 'undefined' || !lively.require) return;

      function showError() {
        el.classList.remove('lively-attachment-loading');
        el.classList.add('lively-attachment-error');
      }

      var entry = attachments.filter(function (a) { return a.objId === objId; })[0];
      if (!entry) { showError(); return; }

      lively.require('lively.identity.FileCrypto').toRun(function () {
        lively.identity.fileCrypto.resolveAttachmentUrl(handle, entry, function (err, url) {
          if (err) { showError(); return; }
          el.classList.remove('lively-attachment-loading');
          el.src = url; // valid IDL attribute for img/video/audio alike
        });
      });
    }

    // Wires up every code_cell placeholder's Run button in a read-only
    // render (WikiView/WikiPlayback/WikiEditor's own Preview mode -- see
    // WikiEditor._togglePreview) to the same runCodeCell/stopCodeCell
    // orchestration the live editor's NodeView uses. The read-only source
    // is inert text -- Run just executes whatever static source is already
    // embedded in the HTML; there is nothing to edit here.
    function hydrateCodeCells(containerEl) {
      if (!containerEl || typeof document === 'undefined') return;
      var buttons = containerEl.querySelectorAll('.lively-code-cell-run-btn[data-hydrate="code-cell"]');
      Array.prototype.forEach.call(buttons, _hydrateOneCodeCell);
    }

    function _hydrateOneCodeCell(runBtn) {
      var cellEl = runBtn.closest ? runBtn.closest('.lively-code-cell') : null;
      if (!cellEl) return;
      var sourceEl = cellEl.querySelector('pre.lively-code-cell-source');
      var outputEl = cellEl.querySelector('.lively-code-cell-output');
      var statusEl = cellEl.querySelector('.lively-code-cell-status');
      var stopBtn = cellEl.querySelector('.lively-code-cell-stop-btn');
      if (!sourceEl || !outputEl) return;

      function setRunning(isRunning, statusText) {
        runBtn.style.display = isRunning ? 'none' : '';
        if (stopBtn) stopBtn.style.display = isRunning ? '' : 'none';
        if (statusEl) statusEl.textContent = statusText;
      }

      function renderOutput(response, err) {
        outputEl.innerHTML = '';
        outputEl.classList.remove('lively-code-cell-output-empty');
        var hasContent = false;
        if (response && response.stdout) {
          var stdoutPre = document.createElement('pre');
          stdoutPre.textContent = response.stdout;
          outputEl.appendChild(stdoutPre);
          hasContent = true;
        }
        (response && response.images || []).forEach(function (b64) {
          var img = document.createElement('img');
          img.src = 'data:image/png;base64,' + b64;
          outputEl.appendChild(img);
          hasContent = true;
        });
        if (response && response.result != null) {
          var resultPre = document.createElement('pre');
          resultPre.textContent = response.result;
          outputEl.appendChild(resultPre);
          hasContent = true;
        }
        if (response && response.stderr) {
          var stderrPre = document.createElement('pre');
          stderrPre.className = 'lively-code-cell-stderr';
          stderrPre.textContent = response.stderr;
          outputEl.appendChild(stderrPre);
          hasContent = true;
        }
        if (err) {
          var errPre = document.createElement('pre');
          errPre.className = 'lively-code-cell-stderr';
          errPre.textContent = err.message || String(err);
          outputEl.appendChild(errPre);
          hasContent = true;
        }
        if (!hasContent) {
          outputEl.classList.add('lively-code-cell-output-empty');
          outputEl.textContent = 'Ran with no output.';
        }
      }

      runBtn.addEventListener('click', function () {
        runCodeCell(sourceEl.textContent, {
          onStatus: function (text) { setRunning(true, text); },
          onDone: function (err, response) { setRunning(false, err ? 'Error' : 'Ran just now'); renderOutput(response, err); },
        });
      });
      if (stopBtn) {
        stopBtn.addEventListener('click', function () { stopCodeCell(); setRunning(false, 'Stopped'); });
      }
    }

    // Shared confirm-gate + Pyodide Worker orchestration for a Python code
    // cell's Run button (CodeEditorSpec.md §2.3) -- used by both
    // WikiEditor's live NodeView and this module's own hydrateCodeCells, so
    // the click-to-run confirm + Worker call only exists once. callbacks:
    // {onStatus(text), onDone(err, response)}. Fires the confirm dialog on
    // every call -- no remembered trust (a wiki page's source can change
    // between two clicks; see the schema comment in WikiEditor.js).
    function runCodeCell(source, callbacks) {
      callbacks = callbacks || {};
      var onStatus = callbacks.onStatus || function () {};
      var onDone = callbacks.onDone || function () {};
      if (typeof $world === 'undefined' || !$world.multipleChoicePrompt) { onDone(new Error('Run unavailable')); return; }
      $world.multipleChoicePrompt(
        'Run this Python cell? It executes in your own browser (via Pyodide/WebAssembly) ' +
        'with the same page privileges as any script here — nothing is sent to a server.',
        ['Run', 'Cancel'],
        function (choice) {
          if (choice !== 'Run') return;
          if (typeof lively === 'undefined' || !lively.require) { onDone(new Error('Run unavailable')); return; }
          lively.require('lively.identity.PyodideWorker').toRun(function () {
            var pyodideWorker = lively.identity.PyodideWorker;
            onStatus('Loading Python runtime…');
            pyodideWorker.ensureReady(function (err) {
              if (err) { onStatus('Error'); onDone(err, null); return; }
              onStatus('Running…');
              pyodideWorker.run(source, function (runErr, response) { onDone(runErr, response); });
            });
          });
        }
      );
    }

    // Stops whatever cell is currently running on this page's shared
    // interpreter (CodeEditorSpec.md §2.3's one-worker-per-page model) --
    // a real worker.terminate(), same acknowledged can't-interrupt-mid-
    // computation limitation as lively.jenga3d.Worker.
    function stopCodeCell() {
      if (typeof lively === 'undefined' || !lively.identity || !lively.identity.PyodideWorker) return;
      lively.identity.PyodideWorker.terminate();
    }

    // A private/shared attachment's src is only known once decrypted (see
    // FileCrypto.resolveAttachmentUrl) — a snapshot rendered before that
    // has objId set and src empty. These two helpers emit a placeholder
    // hydrateAttachments can find and resolve in place, mirroring the
    // .lively-embedded-part[data-obj-id] convention below.
    function attachmentPlaceholderClass() {
      return ' lively-attachment-placeholder lively-attachment-loading';
    }
    function attachmentPlaceholderAttrs(node) {
      var objId = (node.attrs && node.attrs.objId) || '';
      return ' data-obj-id="' + escapeAttr(objId) + '"';
    }

    function pmNodeToHtml(node) {
      if (!node) return '';
      switch (node.type) {
        case 'paragraph':
          return '<p' + alignIndentAttr(node) + '>' + inlineContent(node.content) + '</p>';
        case 'heading': {
          var level = Math.min(6, Math.max(1, (node.attrs && node.attrs.level) ? node.attrs.level : 1));
          return '<h' + level + alignIndentAttr(node) + '>' + inlineContent(node.content) + '</h' + level + '>';
        }
        case 'bullet_list':
          return '<ul>' + (node.content || []).map(pmNodeToHtml).join('') + '</ul>';
        case 'ordered_list':
          return '<ol>' + (node.content || []).map(pmNodeToHtml).join('') + '</ol>';
        case 'list_item':
          return '<li' + alignIndentAttr(node) + '>' + (node.content || []).map(pmNodeToHtml).join('') + '</li>';
        case 'blockquote':
          return '<blockquote>' + (node.content || []).map(pmNodeToHtml).join('') + '</blockquote>';
        case 'code_block':
          return renderHighlightedCode(node);
        case 'code_cell':
          return renderCodeCell(node);
        case 'hard_break':
          return '<br>';
        case 'image':
          return imageTagHtml(node, '', false);
        case 'video': {
          var vsrc = (node.attrs && node.attrs.src) || '';
          if (!vsrc) {
            if (node.attrs && node.attrs.objId) {
              return '<video class="lively-postcard-video' + attachmentPlaceholderClass() + '"' +
                     attachmentPlaceholderAttrs(node) + ' controls preload="metadata"></video>';
            }
            return '';
          }
          return '<video class="lively-postcard-video" controls preload="metadata" src="' + escapeAttr(vsrc) + '"></video>';
        }
        case 'audio': {
          var asrc = (node.attrs && node.attrs.src) || '';
          if (!asrc) {
            if (node.attrs && node.attrs.objId) {
              return '<audio class="lively-postcard-audio' + attachmentPlaceholderClass() + '"' +
                     attachmentPlaceholderAttrs(node) + ' controls preload="metadata"></audio>';
            }
            return '';
          }
          return '<audio class="lively-postcard-audio" controls preload="metadata" src="' + escapeAttr(asrc) + '"></audio>';
        }
        case 'math_inline':
          return renderKatex((node.attrs && node.attrs.value) || '', false);
        case 'math_display':
          return renderKatex((node.attrs && node.attrs.value) || '', true);
        case 'embeddedPart': {
          // BUG FIX: this used to emit only data-obj-id, dropping
          // handle/cid/embed-id — hydrateEmbeddedParts (and, previously, no
          // code at all) has no way to look up which account's object store
          // to fetch the part from without data-handle, so every embedded
          // part in a read-only view (feed, permalink page) rendered as a
          // permanent, un-clickable "[Embedded Part: <objId>]" text stub.
          // Matches the schema's own toDOM (PostCardEditor.js/WikiEditor.js)
          // attr-for-attr, including the class name, so the same
          // .lively-embedded-part querySelector finds both.
          var attrs = node.attrs || {};
          var partId = attrs.objId || '(embedded)';
          return '<div class="lively-embedded-part" data-obj-id="' + escapeAttr(attrs.objId || '') +
                 '" data-cid="' + escapeAttr(attrs.cid || '') +
                 '" data-handle="' + escapeAttr(attrs.handle || '') +
                 '" data-embed-id="' + escapeAttr(attrs.embedId || '') + '">' +
                 '[Embedded Part: ' + escapeHtml(partId) + ']</div>';
        }
        default:
          if (node.content) return (node.content || []).map(pmNodeToHtml).join('');
          return '';
      }
    }

    // §10.1 align/indent (matches PostCardEditor.js's _alignIndentAttrs).
    function alignIndentAttr(node) {
      var attrs = node.attrs || {};
      var style = '';
      if (attrs.align && attrs.align !== 'left') style += 'text-align:' + attrs.align + ';';
      if (attrs.indent) style += 'margin-left:' + (attrs.indent * 24) + 'px;';
      return style ? ' style="' + escapeAttr(style) + '"' : '';
    }

    function inlineContent(content) {
      if (!content) return '';
      return content.map(function (node) {
        if (node.type === 'text') {
          var text = escapeHtml(node.text || '');
          (node.marks || []).forEach(function (mark) {
            switch (mark.type) {
              case 'bold':   text = '<strong>' + text + '</strong>'; break;
              case 'italic': text = '<em>' + text + '</em>'; break;
              case 'code':   text = '<code>' + text + '</code>'; break;
              case 'underline':   text = '<u>' + text + '</u>'; break;
              case 'strike':      text = '<s>' + text + '</s>'; break;
              case 'superscript': text = '<sup>' + text + '</sup>'; break;
              case 'subscript':   text = '<sub>' + text + '</sub>'; break;
              case 'textColor':
                if (mark.attrs && mark.attrs.color)
                  text = '<span style="color:' + escapeAttr(mark.attrs.color) + '">' + text + '</span>';
                break;
              case 'backgroundColor':
                if (mark.attrs && mark.attrs.color)
                  text = '<span style="background-color:' + escapeAttr(mark.attrs.color) + '">' + text + '</span>';
                break;
              case 'fontFamily':
                if (mark.attrs && mark.attrs.family)
                  text = '<span style="font-family:' + escapeAttr(mark.attrs.family) + '">' + text + '</span>';
                break;
              case 'fontSize':
                if (mark.attrs && mark.attrs.size)
                  text = '<span style="font-size:' + escapeAttr(mark.attrs.size) + '">' + text + '</span>';
                break;
              case 'link': {
                var raw  = mark.attrs && mark.attrs.href ? mark.attrs.href : '#';
                var href = escapeAttr(safeHref(raw));
                text = '<a href="' + href + '" rel="noopener noreferrer">' + text + '</a>';
                break;
              }
            }
          });
          return text;
        }
        return pmNodeToHtml(node);
      }).join('');
    }

    // Client-side KaTeX render for the read-only feed/playback/standalone-page
    // paths (window.katex comes from postcard-runtime.js). Falls back to the
    // raw LaTeX source, escaped, if katex isn't loaded yet or input is malformed.
    function renderKatex(value, displayMode) {
      var tag = displayMode ? 'pre' : 'code';
      if (!value) return '<' + tag + ' class="math-' + (displayMode ? 'display' : 'inline') + '"></' + tag + '>';
      var katex = (typeof window !== 'undefined' && window.katex) || null;
      if (!katex) return '<' + tag + ' class="math-' + (displayMode ? 'display' : 'inline') + '">' + escapeHtml(value) + '</' + tag + '>';
      try {
        return katex.renderToString(value, { throwOnError: true, displayMode: displayMode });
      } catch (e) {
        return '<' + tag + ' class="math-' + (displayMode ? 'display' : 'inline') + ' math-error">' +
               escapeHtml(value) + '</' + tag + '>';
      }
    }

    // Client-side syntax-highlighted code_block render (window.hljs comes
    // from postcard-runtime.js). Reads raw text directly from node.content —
    // hljs's .value output already escapes it, so running it through
    // escapeHtml() again would double-escape entities.
    function renderHighlightedCode(node) {
      var text = (node.content || []).map(function (n) { return n.text || ''; }).join('');
      if (!text) return '<pre><code class="hljs"></code></pre>';
      var hljs = (typeof window !== 'undefined' && window.hljs) || null;
      if (!hljs) return '<pre><code class="hljs">' + escapeHtml(text) + '</code></pre>';
      try {
        return '<pre><code class="hljs">' + hljs.highlightAuto(text).value + '</code></pre>';
      } catch (e) {
        return '<pre><code class="hljs">' + escapeHtml(text) + '</code></pre>';
      }
    }

    // Runnable Python cell (CodeEditorSpec.md §2.3), read-only/hydrated
    // rendering. Matches the schema's toDOM shape (div.lively-code-cell,
    // pre.lively-code-cell-source holding the plain source text) so a
    // pasted-back copy still round-trips through the schema's parseDOM --
    // plus the interactive chrome (Run/Stop/status, empty output
    // placeholder) hydrateCodeCells wires up below. The outer div also
    // carries lively-code-cell-node so it picks up the exact same CSS as
    // the live editor's NodeView (see _ensureMediaStyle's header note on
    // why this is a second, deliberately-identical copy of those rules).
    function renderCodeCell(node) {
      var attrs = node.attrs || {};
      var source = attrs.source || '';
      var hljs = (typeof window !== 'undefined' && window.hljs) || null;
      var highlighted;
      try { highlighted = hljs ? hljs.highlight(source, { language: 'python' }).value : escapeHtml(source); }
      catch (e) { highlighted = escapeHtml(source); }
      return '<div class="lively-code-cell lively-code-cell-node" data-language="' +
             escapeAttr(attrs.language || 'python') + '">' +
             '<div class="lively-code-cell-header">' +
               '<span class="lively-code-cell-badge">Python</span>' +
               '<button type="button" class="lively-code-cell-run-btn" data-hydrate="code-cell">Run</button>' +
               '<button type="button" class="lively-code-cell-stop-btn">Stop</button>' +
               '<span class="lively-code-cell-status">Idle</span>' +
             '</div>' +
             '<pre class="lively-code-cell-source"><code class="hljs">' + highlighted + '</code></pre>' +
             '<div class="lively-code-cell-output lively-code-cell-output-empty">Run to see output.</div>' +
           '</div>';
    }

    // Deterministic seeded-PRNG "blockie" identicon, rendered to a canvas and
    // returned as a data URL. Extracted from ProfileCard.js's inline avatar
    // fallback (same xorshift128 PRNG + mirrored-cell layout) so PostCardView
    // can embed it as a plain <img src="..."> alongside ProfileCard's morphic
    // Image use of the same bits — keep both in sync if this changes.
    function identiconDataUrl(seedStr, sizePx) {
      var seed = (seedStr || '?').toLowerCase();
      var SZ = 8, SC = Math.ceil(sizePx / SZ);
      var rs = [0, 0, 0, 0];
      for (var i = 0; i < seed.length; i++) {
        rs[i % 4] = ((rs[i % 4] << 5) - rs[i % 4]) + seed.charCodeAt(i);
        rs[i % 4] |= 0;
      }
      function rnd() {
        var t = rs[0] ^ (rs[0] << 11);
        rs[0] = rs[1]; rs[1] = rs[2]; rs[2] = rs[3];
        rs[3] = (rs[3] ^ (rs[3] >> 19) ^ t ^ (t >> 8));
        return (rs[3] >>> 0) / ((1 << 31) >>> 0);
      }
      function hsl() {
        return 'hsl(' + Math.floor(rnd() * 360) + ',' +
          (rnd() * 60 + 40) + '%,' +
          ((rnd() + rnd() + rnd() + rnd()) * 25) + '%)';
      }
      var fg = hsl(), bg = hsl(), spot = hsl();
      var half = Math.ceil(SZ / 2);
      var cells = [];
      for (var r = 0; r < SZ; r++) {
        var row = [];
        for (var x = 0; x < half; x++) row.push(Math.floor(rnd() * 2.3));
        var mir = row.slice(0, SZ - half).reverse();
        cells.push(row.concat(mir));
      }
      var bc = document.createElement('canvas');
      bc.width = bc.height = SZ * SC;
      var bctx = bc.getContext('2d');
      cells.forEach(function (row, r) {
        row.forEach(function (v, col) {
          bctx.fillStyle = v === 1 ? fg : v === 2 ? spot : bg;
          bctx.fillRect(col * SC, r * SC, SC, SC);
        });
      });
      return bc.toDataURL();
    }

    // Shortened display form of a DID: first 20 + last 12 chars, matching
    // the pattern originally inline in ProfileCard.js's identity panel.
    function truncateDid(did) {
      var s = String(did || '');
      return s.length > 36 ? s.slice(0, 20) + '…' + s.slice(-12) : s;
    }

    // Shortened display form of a wallet address (e.g. "0x998b…c4a2"):
    // first 6 + last 4 chars, same truncate-in-the-middle idea as truncateDid.
    function truncateAddress(addr) {
      var s = String(addr || '');
      return s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : s;
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
      return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Returns a safe href, or '#' if the scheme is not allow-listed.
    // Blocks javascript:, data:, vbscript:, etc. Allows http(s), mailto, and
    // relative/anchor URLs (no scheme).
    function safeHref(raw) {
      var s = String(raw || '').trim();
      var m = /^([a-z][a-z0-9+.\-]*):/i.exec(s);
      if (!m) return s; // relative or anchor — allowed
      var scheme = m[1].toLowerCase();
      if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return s;
      return '#';
    }

    // Location tag support — Plus Codes (Open Location Code), floored to 6
    // significant digits (~5.5km x 5.5km cell) so a location tag can never
    // be more precise than that, even transiently in memory before it's
    // ever sent anywhere. Requires window.OpenLocationCode
    // (core/lib/geo/geo-runtime.js) — callers ensure it's loaded first via
    // their own _ensureGeoRuntime. Server-side enforcement of this same
    // floor is an INDEPENDENT copy (core/servers/identity/PlusCode.js, same
    // rationale as this file's header note about _pmNodeToHtml) — this
    // client-side floor is a courtesy / defense-in-depth, not the trust
    // boundary.
    var LOCATION_CODE_LENGTH = 6;

    function encodeLocation(lat, lng) {
      if (!window.OpenLocationCode) return null;
      try {
        return new window.OpenLocationCode().encode(lat, lng, LOCATION_CODE_LENGTH);
      } catch (e) { return null; }
    }

    // Re-derives a floored Plus Code from a string of unknown/untrusted
    // precision (e.g. re-validating a previously-saved envelope's
    // state.location when reopening a card) — decode+re-encode, not
    // substring slicing, since Plus Codes place the '+' at a fixed offset
    // and support shortened forms a naive truncation would mangle. Returns
    // null if the code isn't a valid, full (decodable) Plus Code.
    function sanitizeLocationCode(code) {
      if (!window.OpenLocationCode || !code) return null;
      try {
        var olc = new window.OpenLocationCode();
        if (!olc.isValid(code) || !olc.isFull(code)) return null;
        var area = olc.decode(code);
        return olc.encode(area.latitudeCenter, area.longitudeCenter, LOCATION_CODE_LENGTH);
      } catch (e) { return null; }
    }

  }); // end module('lively.identity.PostCardUtils')
