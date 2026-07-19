/**
 * lively.identity.PostCardUtils
 *
 * Shared client-side utilities for rendering ProseMirror snapshot JSON as HTML.
 * Used by PostCardFeed and PostCardPlayback, so those two stay in sync.
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
      encodeLocation:      encodeLocation,
      sanitizeLocationCode: sanitizeLocationCode,
    };

    function snapshotToHtml(snapshot) {
      if (!snapshot || !snapshot.content) return '';
      return snapshot.content.map(pmNodeToHtml).join('');
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
        case 'math_inline':
          return renderKatex((node.attrs && node.attrs.value) || '', false);
        case 'math_display':
          return renderKatex((node.attrs && node.attrs.value) || '', true);
        case 'embeddedPart': {
          var partId = (node.attrs && node.attrs.objId) ? node.attrs.objId : '(embedded)';
          return '<div class="embedded-part-placeholder" data-obj-id="' + escapeAttr(partId) + '">' +
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
