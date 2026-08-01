/**
 * scripts/build-privacy-pool-client-libs.js
 *
 * One-time build step: bundles the handful of `viem` functions
 * lively.identity.PrivacyPoolClient needs (WalletSpec.md §11, §15 step 4's
 * plain-ETH subset) into a single browser-ready IIFE at
 * core/lib/wallet/privacy-pool-client-libs.js.
 *
 * Run from the project root: node scripts/build-privacy-pool-client-libs.js
 * (also runs automatically via the postinstall npm script)
 *
 * Deliberately its own bundle, not folded into wallet-crypto-libs.js:
 * that file's own header scopes it specifically to what
 * lively.identity.WalletCrypto needs (public-input-only helpers, no RPC
 * client), and PrivacyPoolClient.js is a different main-world module with a
 * different job (RPC calls, balance queries — still no secrets, still
 * main-world, but a distinct dependency set) — matching this project's
 * existing convention of one thin lazy-loaded bundle per module
 * (WalletCrypto -> wallet-crypto-libs.js, WalletVault ->
 * vault-deps.js/vault-sodium.js).
 *
 * sendRawTransaction is deliberately NOT included — WalletSpec.md §15 step
 * 4 builds the full simulate-then-sign path but never broadcasts; the
 * capability doesn't exist in this bundle at all, not just unused in the UI.
 *
 * Globals exposed on window after the script loads:
 *   window.privacyPoolClientLibs.createPublicClient
 *   window.privacyPoolClientLibs.http
 *   window.privacyPoolClientLibs.mainnet    — viem/chains chain definition
 *   window.privacyPoolClientLibs.parseEther
 *   window.privacyPoolClientLibs.formatEther
 */

'use strict';

var esbuild = require('esbuild');
var path = require('path');
var fs = require('fs');

var rootDir = path.join(__dirname, '..');
var outDir = path.join(rootDir, 'core', 'lib', 'wallet');
fs.mkdirSync(outDir, { recursive: true });

var entryContents = [
  "import { createPublicClient, http, parseEther, formatEther } from 'viem';",
  "import { mainnet } from 'viem/chains';",
  "window.privacyPoolClientLibs = {",
  "  createPublicClient: createPublicClient,",
  "  http: http,",
  "  mainnet: mainnet,",
  "  parseEther: parseEther,",
  "  formatEther: formatEther,",
  "};",
].join('\n');

esbuild.build({
  stdin: {
    contents:   entryContents,
    resolveDir: rootDir,
    sourcefile: 'privacy-pool-client-libs-entry.js',
  },
  bundle:    true,
  format:    'iife',
  platform:  'browser',
  outfile:   path.join(outDir, 'privacy-pool-client-libs.js'),
  minify:    false,
  sourcemap: false,
  logLevel:  'info',
}).then(function () {
  var stat = fs.statSync(path.join(outDir, 'privacy-pool-client-libs.js'));
  console.log('✓ privacy-pool-client-libs.js  ' + Math.round(stat.size / 1024) + ' KB');
}).catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});
