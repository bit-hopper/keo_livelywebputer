/**
 * scripts/build-astro-libs.js
 *
 * Bundles astronomy-engine (MIT) into a browser-ready IIFE at
 * core/lib/astro/astro-runtime.js, used by lively.identity.NatalChart to
 * compute Sun / Moon / Rising signs from a birth date, time and place.
 *
 * Run from the project root: node scripts/build-astro-libs.js
 * (also runs automatically via the postinstall npm script)
 *
 * Global exposed on window after the script loads:
 *   window.Astronomy — astronomy-engine's full API (Body, GeoMoon, SunPosition,
 *                      Ecliptic, SiderealTime, MakeTime, …)
 */

'use strict';

var esbuild = require('esbuild');
var path = require('path');
var fs = require('fs');

var rootDir = path.join(__dirname, '..');
var outDir = path.join(rootDir, 'core', 'lib', 'astro');
fs.mkdirSync(outDir, { recursive: true });

var entryContents = [
  "import * as Astronomy from 'astronomy-engine';",
  "",
  "if (!window.Astronomy) window.Astronomy = Astronomy;",
].join('\n');

esbuild.build({
  stdin: {
    contents:   entryContents,
    resolveDir: rootDir,
    sourcefile: 'astro-runtime-entry.js',
  },
  bundle:    true,
  format:    'iife',
  platform:  'browser',
  outfile:   path.join(outDir, 'astro-runtime.js'),
  minify:    true,
  sourcemap: false,
  logLevel:  'info',
}).then(function () {
  var stat = fs.statSync(path.join(outDir, 'astro-runtime.js'));
  console.log('✓ astro-runtime.js  ' + Math.round(stat.size / 1024) + ' KB');
}).catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});
