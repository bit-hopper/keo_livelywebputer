/**
 * scripts/build-postcard-libs.js
 *
 * One-time build step: bundles Yjs + y-websocket + y-prosemirror + ProseMirror
 * into a single browser-ready IIFE at core/lib/postcard/postcard-runtime.js.
 *
 * Run from the project root: node scripts/build-postcard-libs.js
 * (also runs automatically via the postinstall npm script)
 *
 * All libs share one copy of Yjs so Y.Doc instances are compatible across
 * the PostCardEditor, WebsocketProvider, and y-prosemirror.
 *
 * Globals exposed on window after the script loads:
 *   window.Y               — Yjs (Y.Doc, Y.Text, Y.Map, Y.encodeStateAsUpdate, …)
 *   window.WebsocketProvider — y-websocket WebsocketProvider
 *   window.yProsemirror    — y-prosemirror (ySyncPlugin, yUndoPlugin, yDocToProsemirrorJSON, …)
 *   window.PM              — { model, state, view, commands, keymap, schemaList }
 *   window.katex           — KaTeX (katex.render, katex.renderToString)
 *   window.hljs            — highlight.js core + a curated language set
 *                             (bash, c, cpp, css, java, javascript, json,
 *                             markdown, plaintext, python, sql, typescript,
 *                             xml) — not the full language bundle, to keep
 *                             the runtime size reasonable.
 *
 * Also copies katex.min.css + fonts/ and highlight.js's theme CSS next to
 * the built runtime (esbuild bundles JS only) — see copy*Assets() below.
 */

'use strict';

var esbuild = require('esbuild');
var path = require('path');
var fs = require('fs');

var rootDir = path.join(__dirname, '..');
var outDir = path.join(rootDir, 'core', 'lib', 'postcard');
fs.mkdirSync(outDir, { recursive: true });

var entryContents = [
  "import * as Y from 'yjs';",
  "import { WebsocketProvider } from 'y-websocket';",
  "import * as yProsemirror from 'y-prosemirror';",
  "import * as ProsemirrorModel from 'prosemirror-model';",
  "import * as ProsemirrorState from 'prosemirror-state';",
  "import * as ProsemirrorView from 'prosemirror-view';",
  "import * as ProsemirrorCommands from 'prosemirror-commands';",
  "import * as ProsemirrorKeymap from 'prosemirror-keymap';",
  "import * as ProsemirrorSchemaList from 'prosemirror-schema-list';",
  "import katex from 'katex';",
  "import hljs from 'highlight.js/lib/core';",
  "import hljsBash from 'highlight.js/lib/languages/bash';",
  "import hljsC from 'highlight.js/lib/languages/c';",
  "import hljsCpp from 'highlight.js/lib/languages/cpp';",
  "import hljsCss from 'highlight.js/lib/languages/css';",
  "import hljsJava from 'highlight.js/lib/languages/java';",
  "import hljsJavascript from 'highlight.js/lib/languages/javascript';",
  "import hljsJson from 'highlight.js/lib/languages/json';",
  "import hljsMarkdown from 'highlight.js/lib/languages/markdown';",
  "import hljsPlaintext from 'highlight.js/lib/languages/plaintext';",
  "import hljsPython from 'highlight.js/lib/languages/python';",
  "import hljsSql from 'highlight.js/lib/languages/sql';",
  "import hljsTypescript from 'highlight.js/lib/languages/typescript';",
  "import hljsXml from 'highlight.js/lib/languages/xml';",
  "",
  "window.Y = Y;",
  "window.WebsocketProvider = WebsocketProvider;",
  "window.yProsemirror = yProsemirror;",
  "window.PM = {",
  "  model:      ProsemirrorModel,",
  "  state:      ProsemirrorState,",
  "  view:       ProsemirrorView,",
  "  commands:   ProsemirrorCommands,",
  "  keymap:     ProsemirrorKeymap,",
  "  schemaList: ProsemirrorSchemaList,",
  "};",
  "window.katex = katex;",
  "hljs.registerLanguage('bash', hljsBash);",
  "hljs.registerLanguage('c', hljsC);",
  "hljs.registerLanguage('cpp', hljsCpp);",
  "hljs.registerLanguage('css', hljsCss);",
  "hljs.registerLanguage('java', hljsJava);",
  "hljs.registerLanguage('javascript', hljsJavascript);",
  "hljs.registerLanguage('json', hljsJson);",
  "hljs.registerLanguage('markdown', hljsMarkdown);",
  "hljs.registerLanguage('plaintext', hljsPlaintext);",
  "hljs.registerLanguage('python', hljsPython);",
  "hljs.registerLanguage('sql', hljsSql);",
  "hljs.registerLanguage('typescript', hljsTypescript);",
  "hljs.registerLanguage('xml', hljsXml);",
  "window.hljs = hljs;",
].join('\n');

// esbuild bundles JS only — KaTeX also needs its stylesheet + font files
// served as static assets alongside the runtime bundle.
function copyKatexAssets() {
  var katexDistDir = path.join(rootDir, 'node_modules', 'katex', 'dist');
  fs.copyFileSync(
    path.join(katexDistDir, 'katex.min.css'),
    path.join(outDir, 'katex.min.css')
  );
  var fontsSrc = path.join(katexDistDir, 'fonts');
  var fontsDest = path.join(outDir, 'fonts');
  fs.mkdirSync(fontsDest, { recursive: true });
  fs.readdirSync(fontsSrc).forEach(function (f) {
    fs.copyFileSync(path.join(fontsSrc, f), path.join(fontsDest, f));
  });
}

// Same deal for highlight.js's theme stylesheet (the .hljs-* classes the
// core module's highlight() output relies on for actual colors).
function copyHljsAssets() {
  fs.copyFileSync(
    path.join(rootDir, 'node_modules', 'highlight.js', 'styles', 'github.css'),
    path.join(outDir, 'hljs-github.css')
  );
}

esbuild.build({
  stdin: {
    contents:   entryContents,
    resolveDir: rootDir,  // resolve imports from project root's node_modules
    sourcefile: 'postcard-runtime-entry.js',
  },
  bundle:    true,
  format:    'iife',
  platform:  'browser',
  outfile:   path.join(outDir, 'postcard-runtime.js'),
  minify:    false,
  sourcemap: false,
  logLevel:  'info',
}).then(function () {
  var stat = fs.statSync(path.join(outDir, 'postcard-runtime.js'));
  console.log('✓ postcard-runtime.js  ' + Math.round(stat.size / 1024) + ' KB');
  copyKatexAssets();
  console.log('✓ katex.min.css + fonts/ copied to ' + outDir);
  copyHljsAssets();
  console.log('✓ hljs-github.css copied to ' + outDir);
}).catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});
