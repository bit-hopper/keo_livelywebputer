/**
 * lively.identity.PostCardUtils
 *
 * Shared client-side utilities for rendering ProseMirror snapshot JSON as HTML.
 * Used by PostCardFeed and PostCardPlayback — single source of truth for the
 * snapshot → HTML transform so all three render paths (feed preview, playback
 * viewer, server-side) stay in sync.
 */

module('lively.identity.PostCardUtils')
  .requires()
  .toRun(function () {

    lively.identity = lively.identity || {};

    lively.identity.postCardUtils = {
      snapshotToHtml: snapshotToHtml,
      pmNodeToHtml:   pmNodeToHtml,
      escapeHtml:     escapeHtml,
    };

    function snapshotToHtml(snapshot) {
      if (!snapshot || !snapshot.content) return '';
      return snapshot.content.map(pmNodeToHtml).join('');
    }

    function pmNodeToHtml(node) {
      if (!node) return '';
      switch (node.type) {
        case 'paragraph':
          return '<p>' + inlineContent(node.content) + '</p>';
        case 'heading': {
          var level = Math.min(6, Math.max(1, (node.attrs && node.attrs.level) ? node.attrs.level : 1));
          return '<h' + level + '>' + inlineContent(node.content) + '</h' + level + '>';
        }
        case 'bullet_list':
          return '<ul>' + (node.content || []).map(pmNodeToHtml).join('') + '</ul>';
        case 'ordered_list':
          return '<ol>' + (node.content || []).map(pmNodeToHtml).join('') + '</ol>';
        case 'list_item':
          return '<li>' + (node.content || []).map(pmNodeToHtml).join('') + '</li>';
        case 'blockquote':
          return '<blockquote>' + (node.content || []).map(pmNodeToHtml).join('') + '</blockquote>';
        case 'code_block':
          return '<pre><code>' + escapeHtml(inlineContent(node.content)) + '</code></pre>';
        case 'hard_break':
          return '<br>';
        case 'math_inline':
          return '<code class="math-inline">' + escapeHtml((node.attrs && node.attrs.value) || '') + '</code>';
        case 'math_display':
          return '<pre class="math-display">' + escapeHtml((node.attrs && node.attrs.value) || '') + '</pre>';
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
              case 'link': {
                var href = mark.attrs && mark.attrs.href ? escapeAttr(mark.attrs.href) : '#';
                text = '<a href="' + href + '">' + text + '</a>';
                break;
              }
            }
          });
          return text;
        }
        return pmNodeToHtml(node);
      }).join('');
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

  }); // end module('lively.identity.PostCardUtils')
