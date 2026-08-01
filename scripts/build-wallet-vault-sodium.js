/**
 * scripts/build-wallet-vault-sodium.js
 *
 * One-time build step: bundles libsodium-wrappers-**sumo** into a single
 * browser-ready IIFE at core/lib/wallet/vault-sodium.js, for the Wallet
 * Vault page only.
 *
 * Run from the project root: node scripts/build-wallet-vault-sodium.js
 * (also runs automatically via the postinstall npm script)
 *
 * Why a second, separate libsodium build instead of reusing the main
 * world's /core/lib/libsodium/sodium.js (scripts/build-libsodium.js): the
 * base `libsodium-wrappers` package that build uses does NOT include
 * crypto_pwhash (Argon2id) at all — confirmed by direct testing at
 * implementation time (sodium.crypto_pwhash_ALG_ARGON2ID13 is undefined on
 * that build). crypto_pwhash only exists in the "sumo" build. Rather than
 * swap the main world's existing, working libsodium build to sumo (out of
 * scope for the wallet vault, and WalletSpec.md's own top-level instruction
 * not to modify existing identity-system encryption-plane internals outside
 * its one named integration point), the vault gets its own sumo build,
 * loaded only by /wallet-vault, exactly like vault-deps.js already keeps
 * the SDK/circuit weight out of the main world's bootstrap path.
 *
 * Exposes the same global shape lively.identity.Crypto's withSodium (and
 * WalletVault.js's own withSodium) expect: window.sodium with a .ready
 * Promise.
 */

'use strict';

var esbuild = require('esbuild');
var path = require('path');
var fs = require('fs');

var rootDir = path.join(__dirname, '..');
var outDir = path.join(rootDir, 'core', 'lib', 'wallet');
fs.mkdirSync(outDir, { recursive: true });

var entryContents = [
  "import sodium from 'libsodium-wrappers-sumo';",
  "window.sodium = sodium;",
].join('\n');

esbuild.build({
  stdin: {
    contents:   entryContents,
    resolveDir: rootDir,
    sourcefile: 'wallet-vault-sodium-entry.js',
  },
  bundle:    true,
  format:    'iife',
  platform:  'browser',
  outfile:   path.join(outDir, 'vault-sodium.js'),
  minify:    false,
  sourcemap: false,
  logLevel:  'info',
}).then(function () {
  var stat = fs.statSync(path.join(outDir, 'vault-sodium.js'));
  console.log('✓ vault-sodium.js  ' + Math.round(stat.size / 1024) + ' KB');
}).catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});
