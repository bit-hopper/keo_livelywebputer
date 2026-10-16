/**
 * scripts/build-ml-lib.js
 *
 * Bundles the ML engine (core/lib/ml/src) into one minified browser IIFE:
 *
 *   core/lib/ml/ml-engine.js   (+ ml-engine.js.map)
 *
 * which defines `MLEngine` on the global scope (window or Worker self). The
 * bundle is committed (same convention as core/lib/scheme). Because a stale
 * committed bundle would silently shadow source edits, the build embeds a
 * build id (MLEngine.buildId) and `npm run test:ml` rebuilds first.
 *
 * Run from the project root: node scripts/build-ml-lib.js
 */
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

esbuild.build({
  entryPoints: [path.join(root, 'core', 'lib', 'ml', 'bundle-entry.js')],
  bundle: true,
  outfile: path.join(root, 'core', 'lib', 'ml', 'ml-engine.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2020', // BigInt literals, optional chaining
  minify: true,
  sourcemap: true,
  define: { __ML_BUILD_ID__: JSON.stringify(new Date().toISOString()) },
  logLevel: 'info',
}).catch(() => process.exit(1));
