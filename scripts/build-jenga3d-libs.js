/**
 * scripts/build-jenga3d-libs.js
 *
 * Build step (Jenga3Dspec_v0.md §3, §13 steps 1-2) producing three files
 * under core/lib/jenga3d/:
 *
 *   jenga3d-deps.js  — `three` plus its STLExporter/OBJExporter (added §13 step
 *                       11, from three/examples/jsm/exporters/ — not part of the
 *                       core `three` package export, need bundling separately),
 *                       as a browser IIFE (window.jenga3dDeps.{THREE,STLExporter,
 *                       OBJExporter}). Main-thread only, for lively.jenga3d.Viewport
 *                       (§13 step 4) and lively.jenga3d.Export (§13 step 11).
 *   occt-worker.js   — core/lively/jenga3d/occt-worker-src.js (the actual worker
 *                       protocol/Disposer/evaluate logic, §4) bundled together
 *                       with the OCCT Emscripten glue. Worker-only.
 *   occt.wasm        — opencascade.js's wasm binary, copied as-is (tens of MB —
 *                       kept out of both JS bundles so it's fetched via
 *                       WebAssembly.instantiateStreaming rather than inlined).
 *
 * Run from the project root: node scripts/build-jenga3d-libs.js
 * (also runs automatically via the postinstall npm script)
 *
 * Deviation from §3's literal wording, recorded here and in the spec
 * itself: §3 originally described ONE combined bundle (glue + three) that
 * occt-worker.js would then "bundle". Building step 2 surfaced two real
 * problems with that: (1) nothing on the main thread ever calls into OCCT
 * directly (the worker returns raw typed arrays; only the worker touches
 * `oc`), so shipping the glue to the main thread and `three` to the worker
 * would each be pure dead weight — the opposite of §4.1's whole reason for
 * a dedicated lean worker; (2) a combined bundle built as `window.X` can't
 * even be loaded inside a worker via importScripts(), since workers have
 * no `window` global (self only) — confirmed against this repo's own
 * build-wallet-vault-prover-libs.js, which hit the identical issue and
 * assigns to `self`, not `window`, for exactly this reason. Splitting into
 * two single-purpose bundles avoids both problems outright rather than
 * working around them.
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
 */

'use strict';

var esbuild = require('esbuild');
var path = require('path');
var fs = require('fs');

var rootDir = path.join(__dirname, '..');
var outDir = path.join(rootDir, 'core', 'lib', 'jenga3d');
fs.mkdirSync(outDir, { recursive: true });

function buildDeps() {
  var entryContents = [
    "import * as THREE from 'three';",
    "import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';",
    "import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';",
    "window.jenga3dDeps = { THREE: THREE, STLExporter: STLExporter, OBJExporter: OBJExporter };",
  ].join('\n');

  return esbuild.build({
    stdin: {
      contents:   entryContents,
      resolveDir: rootDir,
      sourcefile: 'jenga3d-deps-entry.js',
    },
    bundle:    true,
    format:    'iife',
    platform:  'browser',
    outfile:   path.join(outDir, 'jenga3d-deps.js'),
    minify:    false,
    sourcemap: false,
    logLevel:  'info',
  }).then(function () {
    var stat = fs.statSync(path.join(outDir, 'jenga3d-deps.js'));
    console.log('✓ jenga3d-deps.js  ' + Math.round(stat.size / 1024) + ' KB');
  });
}

function buildOcctWorker() {
  return esbuild.build({
    entryPoints: [path.join(rootDir, 'core', 'lively', 'jenga3d', 'occt-worker-src.js')],
    bundle:    true,
    format:    'iife',
    platform:  'browser',
    external:  ['fs', 'path'],
    outfile:   path.join(outDir, 'occt-worker.js'),
    minify:    false,
    sourcemap: false,
    logLevel:  'info',
  }).then(function () {
    var stat = fs.statSync(path.join(outDir, 'occt-worker.js'));
    console.log('✓ occt-worker.js  ' + Math.round(stat.size / 1024) + ' KB');
  });
}

function copyWasm() {
  var wasmSrc = path.join(rootDir, 'node_modules', 'opencascade.js', 'dist', 'opencascade.full.wasm');
  var wasmDest = path.join(outDir, 'occt.wasm');
  fs.copyFileSync(wasmSrc, wasmDest);
  var stat = fs.statSync(wasmDest);
  console.log('✓ occt.wasm  ' + Math.round(stat.size / 1024 / 1024) + ' MB copied to ' + outDir);
}

Promise.all([buildDeps(), buildOcctWorker()]).then(function () {
  copyWasm();
}).catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});
