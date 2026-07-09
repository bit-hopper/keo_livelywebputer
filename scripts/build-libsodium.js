/**
 * scripts/build-libsodium.js
 *
 * One-time build step: bundles libsodium-wrappers into a single browser-ready
 * IIFE at core/lib/libsodium/sodium.js, matching the classic libsodium-wrappers
 * "browsers" distribution shape that lively.identity.Crypto's withSodium
 * expects (a global `sodium` object with a `.ready` Promise).
 *
 * Run from the project root: node scripts/build-libsodium.js
 * (also runs automatically via the postinstall npm script)
 *
 * The modern libsodium-wrappers npm package (0.8.x) only ships CommonJS/ESM
 * builds, no plain-<script> global build — this replaces the "browsers" dist
 * folder older versions used to ship, using the same esbuild approach as
 * scripts/build-postcard-libs.js.
 */

'use strict';

var esbuild = require('esbuild');
var path = require('path');
var fs = require('fs');

var rootDir = path.join(__dirname, '..');
var outDir = path.join(rootDir, 'core', 'lib', 'libsodium');
fs.mkdirSync(outDir, { recursive: true });

var entryContents = [
  "import sodium from 'libsodium-wrappers';",
  "window.sodium = sodium;",
].join('\n');

esbuild.build({
  stdin: {
    contents:   entryContents,
    resolveDir: rootDir,
    sourcefile: 'libsodium-entry.js',
  },
  bundle:    true,
  format:    'iife',
  platform:  'browser',
  outfile:   path.join(outDir, 'sodium.js'),
  minify:    false,
  sourcemap: false,
  logLevel:  'info',
}).then(function () {
  var stat = fs.statSync(path.join(outDir, 'sodium.js'));
  console.log('✓ sodium.js  ' + Math.round(stat.size / 1024) + ' KB');
}).catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});
