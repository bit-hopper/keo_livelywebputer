/**
 * scripts/build-jenga3d-libs.js
 *
 * One-time build step (Jenga3Dspec_v0.md §3, §13 step 1): bundles the
 * OCCT.js (opencascade.js) Emscripten JS glue + `three` into a single
 * browser-ready IIFE at core/lib/jenga3d/jenga3d-deps.js, and copies the
 * accompanying .wasm binary to core/lib/jenga3d/occt.wasm as-is.
 *
 * Run from the project root: node scripts/build-jenga3d-libs.js
 * (also runs automatically via the postinstall npm script)
 *
 * Unlike build-libsodium.js/build-geo-libs.js, the wasm binary (tens of MB)
 * is NOT inlined into the JS bundle — it's copied as a separate static
 * asset, matched to opencascade.js's own `locateFile` hook so its
 * Emscripten glue fetches it (via WebAssembly.instantiateStreaming) rather
 * than the bundle carrying it as bytes, which would bloat the bundle and
 * defeat streaming instantiation.
 *
 * The OCCT glue (opencascade.js/dist/opencascade.full.js) is Emscripten
 * output with runtime-guarded Node.js code paths (`require('fs')`,
 * `require('path')`) that only execute when ENVIRONMENT_IS_NODE is true —
 * never true in a browser/worker context, but esbuild's static resolver
 * still needs to be told not to fail resolving them; `external: ['fs',
 * 'path']` leaves those calls untouched rather than trying to bundle Node
 * builtins for a browser target. Confirmed this is the only bundling
 * obstacle by esbuilding the glue standalone first.
 *
 * Pinned to opencascade.js 2.0.0-beta.b5ff984 (see package.json) — the
 * actively-developed 2.x line (OCCT 7.6.2, full API surface incl.
 * BRepAlgoAPI_Fuse/Cut/Common, BRepFilletAPI_MakeFillet/MakeChamfer,
 * STEPControl_Writer, IGESControl_Writer) rather than the 1.1.x line, which
 * stopped at OCCT's older API set in 2020. Confirmed against this exact
 * version's dist/opencascade.full.d.ts before pinning.
 *
 * occt-worker.js — the dedicated worker script that actually calls
 * initOpenCascade() and speaks Jenga3D's worker protocol (§4) — is a
 * separate build output added in implementation step 2, not here; step 1
 * only needs the shared dependency bundle + wasm asset to exist so a bare
 * sanity check can run against them.
 *
 * Globals exposed on window after the script loads (window.jenga3dDeps):
 *   THREE            — three.js namespace
 *   initOpenCascade   — the Emscripten module factory (call with a
 *                       { locateFile } option pointing at occt.wasm's URL)
 */

'use strict';

var esbuild = require('esbuild');
var path = require('path');
var fs = require('fs');

var rootDir = path.join(__dirname, '..');
var outDir = path.join(rootDir, 'core', 'lib', 'jenga3d');
fs.mkdirSync(outDir, { recursive: true });

var entryContents = [
  "import * as THREE from 'three';",
  "import initOpenCascade from 'opencascade.js/dist/opencascade.full.js';",
  "window.jenga3dDeps = { THREE: THREE, initOpenCascade: initOpenCascade };",
].join('\n');

esbuild.build({
  stdin: {
    contents:   entryContents,
    resolveDir: rootDir,
    sourcefile: 'jenga3d-deps-entry.js',
  },
  bundle:    true,
  format:    'iife',
  platform:  'browser',
  external:  ['fs', 'path'],
  outfile:   path.join(outDir, 'jenga3d-deps.js'),
  minify:    false,
  sourcemap: false,
  logLevel:  'info',
}).then(function () {
  var stat = fs.statSync(path.join(outDir, 'jenga3d-deps.js'));
  console.log('✓ jenga3d-deps.js  ' + Math.round(stat.size / 1024) + ' KB');
  copyWasm();
}).catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});

function copyWasm() {
  var wasmSrc = path.join(rootDir, 'node_modules', 'opencascade.js', 'dist', 'opencascade.full.wasm');
  var wasmDest = path.join(outDir, 'occt.wasm');
  fs.copyFileSync(wasmSrc, wasmDest);
  var stat = fs.statSync(wasmDest);
  console.log('✓ occt.wasm  ' + Math.round(stat.size / 1024 / 1024) + ' MB copied to ' + outDir);
}
