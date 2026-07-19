/**
 * scripts/build-geo-libs.js
 *
 * One-time build step: bundles Leaflet + open-location-code (Plus Codes)
 * into a single browser-ready IIFE at core/lib/geo/geo-runtime.js.
 *
 * Run from the project root: node scripts/build-geo-libs.js
 * (also runs automatically via the postinstall npm script)
 *
 * Both libs are needed together by exactly one consumer (LocalMap.js), so
 * they're combined into one bundle behind one lazy-load call — same
 * rationale as postcard-runtime.js combining Yjs/ProseMirror/KaTeX/hljs.
 *
 * Globals exposed on window after the script loads:
 *   window.L                 — Leaflet (L.map, L.tileLayer, L.marker, L.divIcon, …)
 *   window.OpenLocationCode   — open-location-code's OpenLocationCode constructor
 *                               (`new window.OpenLocationCode()` for .encode/.decode/…)
 *
 * Also copies leaflet.css + images/ next to the built runtime (esbuild
 * bundles JS only) — see copyLeafletAssets() below.
 */

'use strict';

var esbuild = require('esbuild');
var path = require('path');
var fs = require('fs');

var rootDir = path.join(__dirname, '..');
var outDir = path.join(rootDir, 'core', 'lib', 'geo');
fs.mkdirSync(outDir, { recursive: true });

var entryContents = [
  "import * as L from 'leaflet';",
  "import { OpenLocationCode } from 'open-location-code';",
  "",
  "if (!window.L) window.L = L;",
  "if (!window.OpenLocationCode) window.OpenLocationCode = OpenLocationCode;",
].join('\n');

// esbuild bundles JS only — Leaflet also needs its stylesheet + marker
// image assets served as static files alongside the runtime bundle.
function copyLeafletAssets() {
  var leafletDistDir = path.join(rootDir, 'node_modules', 'leaflet', 'dist');
  fs.copyFileSync(
    path.join(leafletDistDir, 'leaflet.css'),
    path.join(outDir, 'leaflet.css')
  );
  var imagesSrc = path.join(leafletDistDir, 'images');
  var imagesDest = path.join(outDir, 'images');
  fs.mkdirSync(imagesDest, { recursive: true });
  fs.readdirSync(imagesSrc).forEach(function (f) {
    fs.copyFileSync(path.join(imagesSrc, f), path.join(imagesDest, f));
  });
}

esbuild.build({
  stdin: {
    contents:   entryContents,
    resolveDir: rootDir,  // resolve imports from project root's node_modules
    sourcefile: 'geo-runtime-entry.js',
  },
  bundle:    true,
  format:    'iife',
  platform:  'browser',
  outfile:   path.join(outDir, 'geo-runtime.js'),
  minify:    false,
  sourcemap: false,
  logLevel:  'info',
}).then(function () {
  var stat = fs.statSync(path.join(outDir, 'geo-runtime.js'));
  console.log('✓ geo-runtime.js  ' + Math.round(stat.size / 1024) + ' KB');
  copyLeafletAssets();
  console.log('✓ leaflet.css + images/ copied to ' + outDir);
}).catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});
