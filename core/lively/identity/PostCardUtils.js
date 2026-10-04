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
      excerptText:         excerptText,
      buildPreviewSplit:   buildPreviewSplit,
      encodeLocation:      encodeLocation,
      sanitizeLocationCode: sanitizeLocationCode,
      hydrateEmbeddedParts: hydrateEmbeddedParts,
      hydrateAttachments:  hydrateAttachments,
      hydrateCodeCells:    hydrateCodeCells,
      hydrateLinkPreviews: hydrateLinkPreviews,
      fetchLinkPreview:    _fetchLinkPreview,
      peekLinkPreview:     peekLinkPreview,
      buildLinkPreviewCard: buildLinkPreviewCard,
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
        '.lively-code-cell-output img{max-width:100%;display:block;margin:4px 0;}' +
        // Media-forward ("Reddit-like") preview wrappers — see
        // buildPreviewSplit above. Shared by PostCardFeed's row rendering
        // and PostCardView's opt-in previewMode. -rest is unclamped by
        // default (a card that grows to fit its content, like
        // ConstellationLounge's reel via _fitCardToContent, should show all
        // of it) — -rest-clamped is an opt-in modifier PostCardFeed adds
        // for its own fixed-max-height row, since that context has no
        // "just grow taller" option.
        '.lively-postcard-preview-lead{font-size:11px;color:#333;margin:2px 0 4px;}' +
        '.lively-postcard-preview-media{margin:2px 0 4px;}' +
        '.lively-postcard-preview-rest{font-size:11.5px;color:#333;}' +
        '.lively-postcard-preview-rest.lively-postcard-preview-rest-clamped{max-height:140px;overflow:hidden;' +
        '-webkit-mask-image:linear-gradient(#000 70%, transparent 100%);' +
        'mask-image:linear-gradient(#000 70%, transparent 100%);}' +
        // Unfurled link-preview card (see hydrateLinkPreviews below) —
        // inserted as a block right after a "bare link" paragraph.
        '.lively-link-preview-card{display:flex;margin:6px 0;border:1px solid #ddd;border-radius:8px;' +
        'overflow:hidden;text-decoration:none;color:inherit;background:#fff;max-width:480px;}' +
        '.lively-link-preview-card:hover{border-color:#aaa;background:#fafafa;}' +
        '.lively-link-preview-card-image-wrap{flex:0 0 96px;background:#eee;}' +
        '.lively-link-preview-card-image-wrap img{display:block;width:96px;height:96px;object-fit:cover;}' +
        '.lively-link-preview-card-text{flex:1 1 auto;min-width:0;padding:8px 10px;overflow:hidden;}' +
        '.lively-link-preview-card-site{font-size:10.5px;color:#888;text-transform:uppercase;' +
        'letter-spacing:0.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.lively-link-preview-card-title{font-size:12.5px;font-weight:600;color:#222;margin-top:2px;' +
        'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}' +
        '.lively-link-preview-card-desc{font-size:11.5px;color:#666;margin-top:2px;' +
        'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}' +
        // Playable embed variant (Spotify/YouTube/SoundCloud/Apple Music) —
        // a plain div, not an <a>, since an <iframe> is interactive content
        // and HTML forbids nesting that inside an anchor. buildLinkPreviewCard
        // picks block vs. inline height per provider via a data attribute.
        '.lively-link-preview-embed{display:block;margin:6px 0;max-width:480px;}' +
        '.lively-link-preview-embed iframe{display:block;width:100%;border:0;border-radius:8px;}' +
        '.lively-link-preview-embed[data-embed-shape="video"] iframe{aspect-ratio:16/9;height:auto;}' +
        '.lively-link-preview-embed[data-embed-shape="audio"] iframe{height:152px;}';
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

    // opts.feedMode: thread through to blocksToHtml's opts.suppressEmbeds —
    // for a condensed multi-row context rendering many snapshots at once
    // (ConstellationLounge.js's reply list, PostCardView.js's no-other-media
    // preview fallback) where a persisted link_preview_card node should
    // render as a plain text link, never a card/iframe. Omit for a single
    // full-card/page render (the common case), where the real card/embed is
    // exactly what should show.
    function snapshotToHtml(snapshot, opts) {
      if (!snapshot || !snapshot.content) return '';
      // Same feedMode -> suppressEmbeds translation as buildPreviewSplit's
      // own blocksOpts -- public callers pass {feedMode: true} (matching
      // buildPreviewSplit's option name), blocksToHtml's internal opts key
      // is suppressEmbeds.
      return blocksToHtml(snapshot.content, opts && opts.feedMode ? { suppressEmbeds: true } : undefined);
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

    // opts.suppressEmbeds: render a link_preview_card node as a plain text
    // link, never a card/iframe (see pmNodeToHtml's 'link_preview_card'
    // case) — set by buildPreviewSplit's feedMode for PostCardFeed.js's
    // condensed rows, matching hydrateLinkPreviews's own long-standing "no
    // preview card per row — noisy and expensive" posture (this file's
    // comment on MAX_LINK_PREVIEWS_PER_CONTAINER), now also covering the
    // persisted-node render path that posture didn't originally anticipate.
    // Threaded as a module-level flag rather than a second argument to
    // pmNodeToHtml (and every one of its recursive .map(pmNodeToHtml)
    // call sites) since this is synchronous, non-reentrant top-to-bottom
    // recursion — no risk of one caller's flag leaking into an unrelated
    // concurrent call.
    var _suppressEmbeds = false;

    function blocksToHtml(nodes, opts) {
      var prevSuppress = _suppressEmbeds;
      if (opts && opts.suppressEmbeds) _suppressEmbeds = true;
      var out = '', pending = [];
      var lastCardUrl = null; // dedup: collapse adjacent link_preview_card
      // siblings sharing the same url -- the one residual symptom of the
      // rare two-collaborators-insert-at-once Yjs race (WikiEditor.js's
      // dedup claim-check narrows but can't fully close that window; see
      // PostCardEditor.js's _buildLinkPreviewPlugin). Cosmetic only, and
      // self-heals the moment anyone edits near the duplicate.
      function flush() {
        for (var i = 0; i < pending.length; i += 4) out += galleryHtml(pending.slice(i, i + 4));
        pending = [];
      }
      (nodes || []).forEach(function (node) {
        var imgs = imageOnlyParagraph(node);
        if (imgs) { pending = pending.concat(imgs); return; }
        flush();
        if (node.type === 'link_preview_card') {
          var url = (node.attrs && node.attrs.url) || '';
          if (url && url === lastCardUrl) return; // skip duplicate
          lastCardUrl = url;
        } else {
          lastCardUrl = null;
        }
        out += pmNodeToHtml(node);
      });
      flush();
      _suppressEmbeds = prevSuppress;
      return out;
    }

    function galleryHtml(imgs) {
      return '<div class="lively-media-grid lively-media-n' + imgs.length + '">' +
        imgs.map(function (img) {
          return '<div class="lively-media-cell">' + imageTagHtml(img, '', false) + '</div>';
        }).join('') + '</div>';
    }

    // Recursively concatenates plain text out of a ProseMirror node tree —
    // deeper than PostCardSerializer.js's private _extractFirstBlockText
    // (which only looks one level down), needed here because "the rest of
    // the body" in a preview can include list_item/blockquote-wrapped
    // paragraphs, not just a single top-level one.
    function _plainTextOfNode(node) {
      if (!node) return '';
      if (node.type === 'text') return node.text || '';
      if (!node.content) return '';
      return node.content.map(_plainTextOfNode).join(' ');
    }

    // buildPreviewSplit(docContent, opts) — walks a ProseMirror doc's
    // top-level block array (the same shape blocksToHtml/snapshotToHtml
    // already consume) and splits it into a short leading text excerpt, the
    // first media block (promoted to appear early even if it means cutting
    // remaining pre-media text — media always shows if the doc has any),
    // and whatever comes after. Used by PostCardFeed's row rendering and
    // PostCardView's opt-in preview mode (ConstellationLounge's reel) to
    // build a "Reddit-like" media-forward preview instead of showing
    // content in plain document order. Reuses blocksToHtml/
    // imageOnlyParagraph for actual HTML generation — no second renderer,
    // no duplicated per-node-type logic (image/video/gallery/attachment-
    // placeholder rendering all come along for free).
    //
    // opts.leadBudget (default 140): char budget for the lead excerpt.
    // opts.restBudget (default 400): char budget for the "rest" segment,
    // enforced at whole-block granularity only (never a mid-block string
    // cut, which could produce broken HTML) — a single verbose trailing
    // block can run a bit over this; callers that need a hard visual cap
    // (e.g. PostCardFeed's fixed-max-height row) apply their own CSS
    // clamp/fade on top of this.
    //
    // Returns { hasMedia, leadExcerpt, mediaHtml, restHtml, restTruncated }.
    // hasMedia:false means the doc has no image/video content at all —
    // callers should ignore leadExcerpt/mediaHtml/restHtml entirely and
    // fall back to their own plain/unsplit rendering in that case.
    //
    // opts.feedMode: condensed-row context (PostCardFeed.js, ConstellationLounge's
    // reel card) — suppresses link-preview cards/iframes in mediaHtml/restHtml
    // (see blocksToHtml's opts.suppressEmbeds), same posture as this file's
    // existing "no card in a condensed row" rule for hydrateLinkPreviews.
    function buildPreviewSplit(docContent, opts) {
      opts = opts || {};
      var leadBudget = opts.leadBudget || 140;
      var restBudget = opts.restBudget || 400;
      var blocksOpts = opts.feedMode ? { suppressEmbeds: true } : undefined;
      var nodes = docContent || [];

      var leadPlain = '';
      var mediaNodes = [];
      var hasMedia = false;
      var i = 0;

      for (; i < nodes.length; i++) {
        var node = nodes[i];
        var imgs = imageOnlyParagraph(node);
        var isBareMedia = !imgs && node && (node.type === 'image' || node.type === 'video' || node.type === 'audio');
        if (imgs || isBareMedia) {
          hasMedia = true;
          if (imgs) {
            // Merge the maximal *consecutive* run of image-only paragraphs,
            // mirroring blocksToHtml's own pending/flush merge exactly (so
            // the eventual render goes through the same 4-per-gallery
            // chunking via galleryHtml).
            while (i < nodes.length && imageOnlyParagraph(nodes[i])) { mediaNodes.push(nodes[i]); i++; }
          } else {
            // A bare top-level image/video/audio node — blocksToHtml never
            // merges these with neighbors either, so neither do we.
            mediaNodes.push(node);
            i++;
          }
          break;
        }
        // Once leadBudget is exceeded we keep *scanning* for media (per the
        // "media always gets promoted" rule) — we just stop *appending* to
        // leadPlain, via this guard.
        if (leadPlain.length < leadBudget) {
          var text = _plainTextOfNode(node);
          if (text) leadPlain += (leadPlain ? ' ' : '') + text;
        }
      }

      // "Rest" is whatever whole blocks come after the media run, capped by
      // restBudget at block granularity only.
      var restNodes = [];
      var restPlainLen = 0;
      var restTruncated = false;
      for (; i < nodes.length; i++) {
        var rNode = nodes[i];
        var rLen = _plainTextOfNode(rNode).length;
        if (restNodes.length > 0 && restPlainLen + rLen > restBudget) {
          restTruncated = true;
          break;
        }
        restNodes.push(rNode);
        restPlainLen += rLen;
        if (restPlainLen > restBudget) {
          restTruncated = (i + 1 < nodes.length);
          break;
        }
      }

      return {
        hasMedia: hasMedia,
        leadExcerpt: excerptText(leadPlain, leadBudget),
        mediaHtml: hasMedia ? blocksToHtml(mediaNodes, blocksOpts) : '',
        restHtml: blocksToHtml(restNodes, blocksOpts),
        restTruncated: restTruncated,
      };
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

    // ── Link previews ───────────────────────────────────────────────────
    // Scans a rendered container for "bare link" blocks — a <p>/<li> whose
    // ENTIRE content is one URL, either already a <a> (a link mark applied
    // over a selection, see PostCardEditor.js's _promptLink) or plain text
    // that looks like a URL (PostCardEditor.js/WikiEditor.js have no
    // autolink-on-paste input rule, so a pasted bare URL is otherwise inert
    // text — this both auto-linkifies it for display and treats it as an
    // unfurl candidate). Mirrors the common chat-app convention (Slack/
    // Discord/iMessage): a URL inline within a sentence stays a plain
    // hyperlink; a URL that IS its paragraph gets a title/description/image
    // card fetched through LinkPreviewServer.js and inserted right after
    // it. Call after hydrateEmbeddedParts/hydrateCodeCells, same "upgrade
    // in place" convention as those — containerEl must already be in the
    // document (card insertion is a plain DOM sibling-insert, no live-ness
    // requirement beyond that).
    //
    // Capped at MAX_LINK_PREVIEWS_PER_CONTAINER fetches per call so a long
    // document full of bare links can't fire off unbounded parallel
    // requests. Not called from PostCardFeed.js's row rendering or
    // WikiPlayback.js's version viewer — both render many condensed/
    // historical entries at once (see PostCardFeed.js's own comment on why
    // it deliberately limits hydration there), where a preview card per row
    // would be noisy and expensive.
    var MAX_LINK_PREVIEWS_PER_CONTAINER = 6;
    var BARE_URL_RE = /^(https?:\/\/[^\s<>"']+)$/i;
    var _linkPreviewCache = {}; // url -> array of pending callbacks, or {done:true, err, body}

    function hydrateLinkPreviews(containerEl) {
      if (!containerEl || typeof document === 'undefined') return;
      var candidates = _findBareLinkBlocks(containerEl);
      candidates.slice(0, MAX_LINK_PREVIEWS_PER_CONTAINER).forEach(function (c) {
        _fetchLinkPreview(c.url, function (err, body) {
          if (err || !body || body.error) return; // silent — no card, no error UI
          _insertLinkPreviewCard(c.el, body);
        });
      });
    }

    function _findBareLinkBlocks(containerEl) {
      var out = [];
      var seen = {};
      var blocks = containerEl.querySelectorAll('p, li');
      Array.prototype.forEach.call(blocks, function (block) {
        var url = _bareLinkUrlOf(block);
        if (!url || seen[url]) return;
        // A persisted link_preview_card node (schema's toDOM, or this
        // function's own _insertLinkPreviewCard below) already rendered as
        // the next sibling — this is legacy-content territory only (a bare
        // URL paragraph saved before the persisted-node change existed);
        // once a real card already sits here, don't insert a second,
        // separately-live-fetched one next to it.
        var next = block.nextElementSibling;
        if (next && next.classList && next.classList.contains('lively-link-preview-card')) return;
        seen[url] = true;
        out.push({ el: block, url: url });
      });
      return out;
    }

    // Returns the URL if `block`'s only meaningful child is a single link
    // (ignoring whitespace-only text nodes), else null. A plain-text URL
    // match is rewritten into a real <a> in place as a side effect, so it's
    // clickable even while/if the preview fetch is still pending or fails.
    function _bareLinkUrlOf(block) {
      var kids = Array.prototype.filter.call(block.childNodes, function (n) {
        return !(n.nodeType === 3 && !/\S/.test(n.textContent || ''));
      });
      if (kids.length !== 1) return null;
      var only = kids[0];
      if (only.nodeType === 1 && only.tagName === 'A') {
        var href = safeHref(only.getAttribute('href') || '');
        return /^https?:\/\//i.test(href) ? href : null;
      }
      if (only.nodeType === 3) {
        var text = (only.textContent || '').trim();
        var m = BARE_URL_RE.exec(text);
        if (!m) return null;
        var a = document.createElement('a');
        a.href = m[1];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = m[1];
        block.replaceChild(a, only);
        return m[1];
      }
      return null;
    }

    // Fetches (or reuses an in-flight/cached fetch of) url's preview
    // metadata. thenDo(err, body) — body.error set means "fetched fine, but
    // nothing worth showing" (e.g. a page with no OG tags at all), treated
    // the same as a network error by callers (no card). Exported (below) as
    // fetchLinkPreview — also used directly by PostCardEditor.js/
    // WikiEditor.js's live-editor decoration plugin (via peekLinkPreview,
    // next function), so a link previewed once while composing and once
    // more after the card is saved/viewed hits the same cache.
    function _fetchLinkPreview(url, thenDo) {
      var entry = _linkPreviewCache[url];
      if (entry && entry.done) return thenDo(entry.err, entry.body);
      if (entry) { entry.waiters.push(thenDo); return; }
      _linkPreviewCache[url] = { done: false, waiters: [thenDo] };

      var base = lively.identity.did.baseUrl();
      var xhr = new XMLHttpRequest();
      xhr.open('GET', base + '/nodejs/LinkPreviewServer/unfurl?url=' + encodeURIComponent(url));
      xhr.withCredentials = true;
      function finish(err, body) {
        var waiters = _linkPreviewCache[url].waiters;
        _linkPreviewCache[url] = { done: true, err: err, body: body };
        waiters.forEach(function (cb) { cb(err, body); });
      }
      xhr.onload = function () {
        var body = null;
        try { body = JSON.parse(xhr.responseText); } catch (e) {}
        finish((xhr.status === 200 || xhr.status === 422) ? null : new Error('HTTP ' + xhr.status), body);
      };
      xhr.onerror = function () { finish(new Error('Network error'), null); };
      xhr.send();
    }

    // Non-fetching read of the cache _fetchLinkPreview maintains: returns
    // undefined if url has never been requested (caller should kick off a
    // real fetchLinkPreview call), null while a fetch is in flight (ask
    // again later — e.g. once the caller's own refresh hook fires), or
    // { err, body } once settled. Lets a ProseMirror decorations() function
    // (which must be a pure, synchronous read of state — see
    // _buildLinkPreviewPlugin) check "is there something to render right
    // now" without ever itself triggering an XHR as a side effect.
    function peekLinkPreview(url) {
      var entry = _linkPreviewCache[url];
      if (!entry) return undefined;
      if (!entry.done) return null;
      return { err: entry.err, body: entry.body };
    }

    // Client-side re-validation allow-list for embedUrl's hostname — defense
    // in depth on top of LinkPreviewServer.js's own detectEmbed, which is
    // the one that actually decides provider/embedUrl (see that file's
    // header). Never render an <iframe src> whose hostname isn't exactly
    // one of these, even though the server should only ever send a
    // known-good one. "shape" picks the embed's aspect ratio (video, 16:9)
    // vs. fixed-height (audio) in the CSS above, and "label" is the
    // "Open in ..." text link shown alongside the iframe.
    var EMBED_HOSTS = {
      'open.spotify.com':     { label: 'Open in Spotify',     shape: 'audio' },
      'www.youtube.com':      { label: 'Open in YouTube',     shape: 'video' },
      'w.soundcloud.com':     { label: 'Open in SoundCloud',  shape: 'audio' },
      'embed.music.apple.com': { label: 'Open in Apple Music', shape: 'audio' },
    };

    function _embedHostInfo(embedUrl) {
      try {
        var host = new URL(embedUrl).hostname.toLowerCase();
        return EMBED_HOSTS[host] || null;
      } catch (e) { return null; }
    }

    // data: { url, title, description, image, siteName, provider, embedUrl }
    // from LinkPreviewServer.js — all untrusted third-party strings, rendered
    // via textContent only (same rule as RssProxyServer's entries); `url`/
    // `image`/`embedUrl` go through safeHref/_embedHostInfo since the server
    // only allow-lists http(s) at the scheme level, not full trust. Shared by
    // _insertLinkPreviewCard (read-only renders), PostCardEditor.js/
    // WikiEditor.js's live-editor decoration widget AND their
    // _linkPreviewCardNodeView (the persisted-node render) — one card
    // builder, several insertion mechanisms.
    function buildLinkPreviewCard(data) {
      var embedInfo = data.embedUrl ? _embedHostInfo(data.embedUrl) : null;
      if (embedInfo) return _buildLinkPreviewEmbed(data, embedInfo);

      var card = document.createElement('a');
      card.className = 'lively-link-preview-card';
      card.href = safeHref(data.url);
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      // Belongs in a contenteditable ProseMirror doc as inert chrome, not
      // editable/selectable text — harmless (and ignored) in the plain
      // read-only-render call sites.
      card.contentEditable = 'false';

      var safeImage = data.image ? safeHref(data.image) : null;
      if (safeImage && safeImage !== '#') {
        var imgWrap = document.createElement('div');
        imgWrap.className = 'lively-link-preview-card-image-wrap';
        var img = document.createElement('img');
        img.src = safeImage;
        img.alt = '';
        img.loading = 'lazy';
        // LinkPreviewServer.js's image field now has a fallback chain that
        // ends in an UNVERIFIED guessed "<origin>/favicon.ico" (not every
        // site actually has one there) -- hide the whole image slot rather
        // than show a broken-image icon when that guess 404s/errors.
        img.onerror = function () { imgWrap.remove(); };
        imgWrap.appendChild(img);
        card.appendChild(imgWrap);
      }

      var textWrap = document.createElement('div');
      textWrap.className = 'lively-link-preview-card-text';
      if (data.siteName) {
        var site = document.createElement('div');
        site.className = 'lively-link-preview-card-site';
        site.textContent = data.siteName;
        textWrap.appendChild(site);
      }
      if (data.title) {
        var title = document.createElement('div');
        title.className = 'lively-link-preview-card-title';
        title.textContent = data.title;
        textWrap.appendChild(title);
      }
      if (data.description) {
        var desc = document.createElement('div');
        desc.className = 'lively-link-preview-card-desc';
        desc.textContent = data.description;
        textWrap.appendChild(desc);
      }
      card.appendChild(textWrap);

      ['mousedown', 'click'].forEach(function (t) {
        card.addEventListener(t, function (e) { e.stopPropagation(); });
      });
      return card;
    }

    // Playable-embed variant — a plain div, never an <a> (HTML forbids
    // nesting an <iframe>, which is interactive content, inside an anchor).
    // sandbox intentionally omits allow-top-navigation/allow-forms; allow-
    // same-origin is needed for Spotify/YouTube/SoundCloud's own players to
    // read their own storage, allow-popups for "open in app" links some of
    // them show internally.
    function _buildLinkPreviewEmbed(data, embedInfo) {
      var wrap = document.createElement('div');
      wrap.className = 'lively-link-preview-card lively-link-preview-embed';
      wrap.setAttribute('data-embed-shape', embedInfo.shape);
      wrap.contentEditable = 'false';

      var iframe = document.createElement('iframe');
      iframe.src = data.embedUrl;
      iframe.loading = 'lazy';
      // BUG FIX (caught live testing the YouTube embed): matches each
      // provider's own documented embed snippet (YouTube's in particular)
      // rather than a guessed minimal set -- without allowfullscreen +
      // allow-presentation, the player's own fullscreen button silently
      // doesn't work (no error, it just does nothing). strict-origin-when-
      // cross-origin (the browser's own default) instead of no-referrer:
      // no-referrer wasn't actually the cause of a real "Error 153" hit
      // while testing (confirmed by removing it and still seeing the same
      // error -- that one turned out to be YouTube's own embed-origin
      // policy for a plain-http/localhost origin, unrelated to any
      // attribute here), but there's no reason to strip more than the
      // default, and matching each provider's own recommended snippet is
      // the safer default to start from.
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      iframe.sandbox = 'allow-scripts allow-same-origin allow-popups allow-presentation';
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';
      iframe.setAttribute('allowfullscreen', '');
      iframe.title = data.title || embedInfo.label;
      if (embedInfo.shape === 'video') iframe.height = '270'; // overridden by aspect-ratio CSS once loaded
      wrap.appendChild(iframe);

      // No separate "Open in <provider>" caption here -- every one of the
      // four embeddable providers' own official players (Spotify/YouTube/
      // SoundCloud/Apple Music) already carries its own "open externally"
      // affordance inside the iframe itself (confirmed live for YouTube:
      // title/channel links and a "Watch on YouTube" badge all present in
      // the embedded player's own UI), so a redundant link alongside it was
      // pure visual clutter that didn't do anything the embed itself didn't
      // already offer.

      ['mousedown', 'click'].forEach(function (t) {
        wrap.addEventListener(t, function (e) { e.stopPropagation(); });
      });
      return wrap;
    }

    function _insertLinkPreviewCard(afterEl, data) {
      if (!afterEl.parentNode) return; // container was replaced/removed meanwhile
      afterEl.parentNode.insertBefore(buildLinkPreviewCard(data), afterEl.nextSibling);
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
        case 'link_preview_card':
          return linkPreviewCardHtml(node.attrs || {});
        default:
          if (node.content) return (node.content || []).map(pmNodeToHtml).join('');
          return '';
      }
    }

    // String-emitting counterpart of buildLinkPreviewCard (that one builds
    // real DOM, for the live editor's NodeView and the DOM-scan hydration
    // fallback; this one is used by pmNodeToHtml's string-concatenation
    // render path) — kept visually in sync by hand, same three-way-
    // duplication convention this file's header comment already documents
    // for every other node type. data-* attrs round-trip through the
    // schema's own toDOM/parseDOM (PostCardEditor.js/WikiEditor.js) exactly
    // like .lively-embedded-part above.
    //
    // _suppressEmbeds (set by blocksToHtml's opts.suppressEmbeds, via
    // buildPreviewSplit's feedMode): a condensed feed row never mounts a
    // card or iframe for this node — just a plain text link — matching this
    // file's pre-existing "no preview card per row" posture for
    // hydrateLinkPreviews (see MAX_LINK_PREVIEWS_PER_CONTAINER's comment),
    // which otherwise wouldn't apply here since this node is reachable from
    // any generic doc-walk, not just hydrateLinkPreviews's own call sites.
    function linkPreviewCardHtml(attrs) {
      var dataAttrs = ' data-url="' + escapeAttr(attrs.url || '') +
        '" data-title="' + escapeAttr(attrs.title || '') +
        '" data-description="' + escapeAttr(attrs.description || '') +
        '" data-image="' + escapeAttr(attrs.image || '') +
        '" data-site-name="' + escapeAttr(attrs.siteName || '') +
        '" data-provider="' + escapeAttr(attrs.provider || '') +
        '" data-embed-url="' + escapeAttr(attrs.embedUrl || '') + '"';

      if (_suppressEmbeds) {
        var label = attrs.title || attrs.siteName || attrs.url || '';
        return '<a href="' + escapeAttr(safeHref(attrs.url || '')) + '" rel="noopener noreferrer"' +
          dataAttrs + '>' + escapeHtml(label) + '</a>';
      }

      var embedInfo = attrs.embedUrl ? _embedHostInfo(attrs.embedUrl) : null;
      if (embedInfo) {
        return '<div class="lively-link-preview-card lively-link-preview-embed" data-embed-shape="' +
          escapeAttr(embedInfo.shape) + '"' + dataAttrs + '>' +
          '<iframe src="' + escapeAttr(attrs.embedUrl) + '" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" ' +
          'sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" allowfullscreen ' +
          'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" ' +
          'title="' + escapeAttr(attrs.title || embedInfo.label) + '"></iframe>' +
          '</div>';
      }

      var safeImage = attrs.image ? safeHref(attrs.image) : null;
      var imgHtml = (safeImage && safeImage !== '#')
        ? '<div class="lively-link-preview-card-image-wrap"><img src="' + escapeAttr(safeImage) + '" alt="" loading="lazy"></div>'
        : '';
      var textHtml = (attrs.siteName ? '<div class="lively-link-preview-card-site">' + escapeHtml(attrs.siteName) + '</div>' : '') +
        (attrs.title ? '<div class="lively-link-preview-card-title">' + escapeHtml(attrs.title) + '</div>' : '') +
        (attrs.description ? '<div class="lively-link-preview-card-desc">' + escapeHtml(attrs.description) + '</div>' : '');
      return '<a class="lively-link-preview-card" href="' + escapeAttr(safeHref(attrs.url || '')) +
        '" target="_blank" rel="noopener noreferrer"' + dataAttrs + '>' +
        imgHtml + '<div class="lively-link-preview-card-text">' + textHtml + '</div></a>';
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

    // Head-truncate (not middle-truncate, unlike truncateDid/truncateAddress
    // above) arbitrary prose to maxChars, word-boundary-aware, ellipsis-
    // suffixed — for rendering a short preview *snippet* of body text, not
    // an opaque identifier. Differs from PostCardSerializer.js's private
    // _extractFirstBlockText: that's a save-time, single-block (content[0]
    // only), no-ellipsis, hard 200-char slice used only to derive
    // envelope.state.title. This is a render-time, exported,
    // multi-block-aggregate-input helper for body preview text (see
    // buildPreviewSplit below).
    function excerptText(text, maxChars) {
      var s = String(text || '').replace(/\s+/g, ' ').trim();
      maxChars = maxChars || 140;
      if (s.length <= maxChars) return s;
      var cut = s.slice(0, maxChars);
      var lastSpace = cut.lastIndexOf(' ');
      if (lastSpace > maxChars * 0.6) cut = cut.slice(0, lastSpace); // avoid an ugly mid-word cut when reasonable
      return cut.replace(/[,;:.\-–—]+$/, '') + '…';
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
