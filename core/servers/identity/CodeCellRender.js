// Server-side static render of a wiki `code_cell` node (source only -- no
// output, ever: output is never persisted; see the schema comment in
// WikiEditor.js's _buildSchema).
//
// Matches the client's renderCodeCell in PostCardUtils.js exactly (class
// names, structure) so the client-side hydrateCodeCells finds and wires up a
// server-rendered cell identically to a client-rendered one.
//
// CODE_CELL_LANGUAGES is a copy of the client's registry of the same name
// (PostCardUtils.js; this server module cannot load it), reduced to the fields
// a static render reads. Keep the two in step: a language added there needs a
// row here and its highlight.js grammar registered by the caller.
// tests/e2e/code-cell-registry.spec.js compares the two.

var CODE_CELL_LANGUAGES = {
  python: { id: 'python', label: '🐍 Python', hljsId: 'python', hasReset: false },
  scheme: { id: 'scheme', label: 'λ Scheme', hljsId: 'scheme', hasReset: true },
  sml: {
    id: 'sml', label: '🐪 ML', hljsId: 'sml', hasReset: true,
    help: "Glyphs accepted: → ⇒ ▷ for -> => :>, and α β γ for 'a 'b 'c. A line starting with • is a type box; ⊗ marks a box the book says is rejected.\nPragmas: (*# style: book|sml *)  (*# depth: N *)  (*# verdicts: on|off *)  (*# redundant: error|warning *)",
  },
};

var UNKNOWN_NOTE = 'This page uses a runtime this build doesn\'t have, so this cell can\'t run.';

// deps: { hljs, escapeHtml } -- the caller's highlight.js instance (with the
// grammars registered) and its HTML escaper.
function createCodeCellRenderer(deps) {
  var hljs = deps.hljs;
  var escapeHtml = deps.escapeHtml;

  return function renderCodeCell(node) {
    var attrs = node.attrs || {};
    var text = attrs.source || '';
    // A missing/empty language is the schema's default (python). Any other id this
    // build has no row for renders as plain text with no Run button -- never as
    // python, which would offer to feed that source to the wrong interpreter.
    var rawLanguage = (attrs.language === undefined || attrs.language === null || attrs.language === '')
      ? 'python' : String(attrs.language);
    var def = Object.prototype.hasOwnProperty.call(CODE_CELL_LANGUAGES, rawLanguage)
      ? CODE_CELL_LANGUAGES[rawLanguage] : null;
    if (!def) {
      return '<div class="lively-code-cell lively-code-cell-node" data-language="' + escapeHtml(rawLanguage) + '">' +
             '<div class="lively-code-cell-header">' +
               '<span class="lively-code-cell-badge">' +
                 escapeHtml(rawLanguage.length > 40 ? rawLanguage.slice(0, 40) + '…' : rawLanguage) + '</span>' +
             '</div>' +
             '<pre class="lively-code-cell-source"><code class="hljs">' + escapeHtml(text) + '</code></pre>' +
             '<div class="lively-code-cell-output lively-code-cell-output-empty">' + UNKNOWN_NOTE + '</div>' +
           '</div>';
    }
    var highlighted;
    try { highlighted = hljs.highlight(text, { language: def.hljsId }).value; }
    catch (e) { highlighted = escapeHtml(text); }
    return '<div class="lively-code-cell lively-code-cell-node" data-language="' +
           escapeHtml(def.id) + '">' +
           '<div class="lively-code-cell-header">' +
             '<span class="lively-code-cell-badge">' + def.label + '</span>' +
             '<button type="button" class="lively-code-cell-run-btn" data-hydrate="code-cell">Run</button>' +
             '<button type="button" class="lively-code-cell-stop-btn">Stop</button>' +
             (def.hasReset ? '<button type="button" class="lively-code-cell-reset-btn">Reset</button>' : '') +
             '<span class="lively-code-cell-status">Idle</span>' +
           '</div>' +
           '<pre class="lively-code-cell-source"><code class="hljs">' + highlighted + '</code></pre>' +
           '<div class="lively-code-cell-output lively-code-cell-output-empty">Run to see output.</div>' +
           (def.help ? '<div class="lively-code-cell-help">' + escapeHtml(def.help) + '</div>' : '') +
         '</div>';
  };
}

module.exports = { CODE_CELL_LANGUAGES: CODE_CELL_LANGUAGES, createCodeCellRenderer: createCodeCellRenderer };
