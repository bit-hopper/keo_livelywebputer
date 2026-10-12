/**
 * scripts/build-scheme-lib.js
 *
 * Bundles the Scheme engine (core/lib/scheme/src, SchemeSpec.md) plus its
 * always-loaded prelude into one minified browser IIFE:
 *
 *   core/lib/scheme/scheme-engine.js   (+ scheme-engine.js.map)
 *
 * which defines `SchemeEngine` on the global scope (window or Worker self).
 * Optional libraries (prelude/<name>.scm, selected with `#lang <name>`) are NOT
 * bundled; the worker fetches them on demand.
 *
 * The bundle is committed (same convention as core/lib/jenga3d/*). Because a
 * stale committed bundle would silently shadow source edits, the build embeds
 * a build id (SchemeEngine.buildId) and `npm run test:scheme` rebuilds first.
 *
 * Run from the project root: node scripts/build-scheme-lib.js
 */
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outfile = path.join(root, 'core', 'lib', 'scheme', 'scheme-engine.js');

esbuild.build({
  entryPoints: [path.join(root, 'core', 'lib', 'scheme', 'bundle-entry.js')],
  bundle: true,
  outfile,
  format: 'iife',
  platform: 'browser',
  target: 'es2020', // BigInt literals, optional chaining
  minify: true,
  sourcemap: true,
  loader: { '.scm': 'text' },
  define: { __SCHEME_BUILD_ID__: JSON.stringify(new Date().toISOString()) },
  logLevel: 'info',
}).catch(() => process.exit(1));
