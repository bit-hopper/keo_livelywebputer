/**
 * scripts/build-wallet-crypto-libs.js
 *
 * One-time build step: bundles the handful of `viem` functions
 * lively.identity.WalletCrypto needs (WalletSpec.md §5.7) into a single
 * browser-ready IIFE at core/lib/wallet/wallet-crypto-libs.js.
 *
 * Run from the project root: node scripts/build-wallet-crypto-libs.js
 * (also runs automatically via the postinstall npm script)
 *
 * Deliberately NOT `@0xbow/privacy-pools-core-sdk` — WalletSpec.md §5.7
 * measured that importing even three of the SDK's named exports
 * (calculateContext/bigintToHash/bigintToHex) drags ~1.5MB minified
 * (snarkjs/Poseidon/.wasm weight included) into the bundle regardless,
 * because the SDK ships one rolled-up dist file with no `sideEffects: false`
 * marking. Those three functions are vendored verbatim into WalletCrypto.js
 * instead, and only their real dependency — a few `viem` primitives — is
 * bundled here (measures ~16KB minified, confirmed against this same
 * esbuild config before adding this script).
 *
 * Globals exposed on window after the script loads:
 *   window.walletCryptoLibs.keccak256
 *   window.walletCryptoLibs.encodeAbiParameters
 *   window.walletCryptoLibs.numberToHex
 *   window.walletCryptoLibs.getAddress   — EIP-55 checksum, throws on invalid address
 *   window.walletCryptoLibs.isAddress    — non-throwing validity check
 */

'use strict';

var esbuild = require('esbuild');
var path = require('path');
var fs = require('fs');

var rootDir = path.join(__dirname, '..');
var outDir = path.join(rootDir, 'core', 'lib', 'wallet');
fs.mkdirSync(outDir, { recursive: true });

var entryContents = [
  "import { keccak256, encodeAbiParameters, numberToHex, getAddress, isAddress } from 'viem';",
  "window.walletCryptoLibs = {",
  "  keccak256: keccak256,",
  "  encodeAbiParameters: encodeAbiParameters,",
  "  numberToHex: numberToHex,",
  "  getAddress: getAddress,",
  "  isAddress: isAddress,",
  "};",
].join('\n');

esbuild.build({
  stdin: {
    contents:   entryContents,
    resolveDir: rootDir,
    sourcefile: 'wallet-crypto-libs-entry.js',
  },
  bundle:    true,
  format:    'iife',
  platform:  'browser',
  outfile:   path.join(outDir, 'wallet-crypto-libs.js'),
  minify:    false,
  sourcemap: false,
  logLevel:  'info',
}).then(function () {
  var stat = fs.statSync(path.join(outDir, 'wallet-crypto-libs.js'));
  console.log('✓ wallet-crypto-libs.js  ' + Math.round(stat.size / 1024) + ' KB');
}).catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});
