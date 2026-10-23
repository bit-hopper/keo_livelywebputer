/**
 * scripts/build-logo-lib.js
 *
 * Bundles the Logo engine (core/lib/logo/src, LOGO.md) plus its always-loaded
 * prelude (core/lib/logo/prelude/core.logo) into one minified browser IIFE:
 *
 *   core/lib/logo/logo-engine.js   (+ logo-engine.js.map)
 *
 * which defines `LogoEngine` on the global scope (window or Worker self).
 *
 * The bundle is committed (same convention as core/lib/scheme and core/lib/ml).
 * Because a stale committed bundle would silently shadow source edits, the
 * build embeds a build id (LogoEngine.buildId) and `npm run test:logo`
 * rebuilds first.
 *
 * Run from the project root: node scripts/build-logo-lib.js
 */
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

esbuild.build({
  entryPoints: [path.join(root, 'core', 'lib', 'logo', 'bundle-entry.js')],
  bundle: true,
  outfile: path.join(root, 'core', 'lib', 'logo', 'logo-engine.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  sourcemap: true,
  loader: { '.logo': 'text' },
  define: { __LOGO_BUILD_ID__: JSON.stringify(new Date().toISOString()) },
  logLevel: 'info',
}).catch(() => process.exit(1));
