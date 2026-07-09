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
].join('\n');

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
}).catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});
