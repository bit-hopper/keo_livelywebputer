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
 * sendRawTransaction was deliberately NOT included through step 4 —
 * WalletSpec.md §15 step 4 builds the full simulate-then-sign path but
 * never broadcasts; the capability didn't exist in this bundle at all, not
 * just unused in the UI. Step 7 lifts that absence — createPublicClient's
 * returned client already carries sendRawTransaction as one of viem's
 * standard "public actions" (it's not a separate import; viem attaches the
 * full public-action set regardless of which ones a caller uses), so no
 * new import is needed to reach it — only PrivacyPoolClient.js's own choice
 * to actually call it, for the new deposit flow specifically.
 * buildAndSignTransfer's plain-send path still never calls it.
 *
 * Also step 7: IEntrypointABI/IPrivacyPoolABI, needed for the deposit
 * simulate/build/decode steps (§6.2, §6.6's Deposited event). The installed
 * SDK ships these at src/abi/*.ts but doesn't re-export them from its
 * public entry point (its package.json "exports" map blocks a bare-
 * specifier subpath import — confirmed by a failing esbuild resolve).
 * Importing via an absolute filesystem path instead works fine (esbuild
 * resolves absolute paths regardless of the exports map) and avoids ever
 * hand-transcribing the ABI JSON.
 *
 * Globals exposed on window after the script loads:
 *   window.privacyPoolClientLibs.createPublicClient
 *   window.privacyPoolClientLibs.http
 *   window.privacyPoolClientLibs.mainnet    — viem/chains chain definition
 *   window.privacyPoolClientLibs.parseEther
 *   window.privacyPoolClientLibs.formatEther
 *   window.privacyPoolClientLibs.encodeFunctionData
 *   window.privacyPoolClientLibs.decodeEventLog
 *   window.privacyPoolClientLibs.getAddress
 *   window.privacyPoolClientLibs.IEntrypointABI
 *   window.privacyPoolClientLibs.IPrivacyPoolABI
 */

'use strict';

var esbuild = require('esbuild');
var path = require('path');
var fs = require('fs');

var rootDir = path.join(__dirname, '..');
var outDir = path.join(rootDir, 'core', 'lib', 'wallet');
fs.mkdirSync(outDir, { recursive: true });

var sdkAbiDir = path.join(rootDir, 'node_modules', '@0xbow', 'privacy-pools-core-sdk', 'src', 'abi');
var entrypointAbiPath = path.join(sdkAbiDir, 'IEntrypoint.ts');
var privacyPoolAbiPath = path.join(sdkAbiDir, 'IPrivacyPool.ts');

var entryContents = [
  "import { createPublicClient, http, parseEther, formatEther, encodeFunctionData, decodeEventLog, getAddress } from 'viem';",
  "import { mainnet } from 'viem/chains';",
  "import { IEntrypointABI } from " + JSON.stringify(entrypointAbiPath) + ";",
  "import { IPrivacyPoolABI } from " + JSON.stringify(privacyPoolAbiPath) + ";",
  "window.privacyPoolClientLibs = {",
  "  createPublicClient: createPublicClient,",
  "  http: http,",
  "  mainnet: mainnet,",
  "  parseEther: parseEther,",
  "  formatEther: formatEther,",
  "  encodeFunctionData: encodeFunctionData,",
  "  decodeEventLog: decodeEventLog,",
  "  getAddress: getAddress,",
  "  IEntrypointABI: IEntrypointABI,",
  "  IPrivacyPoolABI: IPrivacyPoolABI,",
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
