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
        '.lively-postcard-video{max-width:100%;max-height:400px;display:block;border-radius:4px;}' +
        '.lively-postcard-audio{max-width:100%;width:320px;display:block;}' +
        '.lively-embedded-part{position:relative;min-height:32px;margin:4px 0;padding:4px;}' +
        '.lively-embedded-part.lively-embed-error{color:#c33;font-style:italic;padding:8px;}';
      document.head.appendChild(styleEl);
    }

    function snapshotToHtml(snapshot) {
      if (!snapshot || !snapshot.content) return '';
      return snapshot.content.map(pmNodeToHtml).join('');
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
        case 'hard_break':
          return '<br>';
        case 'image': {
          var src = (node.attrs && node.attrs.src) || '';
          var alt = (node.attrs && node.attrs.alt) || '';
          var imgTitle = node.attrs && node.attrs.title;
          return '<img class="lively-postcard-image" src="' + escapeAttr(src) + '" alt="' + escapeAttr(alt) + '"' +
                 (imgTitle ? ' title="' + escapeAttr(imgTitle) + '"' : '') + '>';
        }
        case 'video': {
          var vsrc = (node.attrs && node.attrs.src) || '';
          if (!vsrc) return '';
          return '<video class="lively-postcard-video" controls preload="metadata" src="' + escapeAttr(vsrc) + '"></video>';
        }
        case 'audio': {
          var asrc = (node.attrs && node.attrs.src) || '';
          if (!asrc) return '';
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
