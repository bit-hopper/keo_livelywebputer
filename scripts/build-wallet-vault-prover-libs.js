/**
 * scripts/build-wallet-vault-prover-libs.js
 *
 * One-time build step: bundles snarkjs plus the @0xbow/privacy-pools-core-sdk
 * pieces WalletVaultProver.worker.js needs (WalletSpec.md §5.6, §15 step 6)
 * into a single browser-ready IIFE at core/lib/wallet/vault-prover-libs.js.
 *
 * Run from the project root: node scripts/build-wallet-vault-prover-libs.js
 * (also runs automatically via the postinstall npm script)
 *
 * Its own dedicated bundle, not folded into vault-deps.js — matching this
 * project's one-thin-bundle-per-consumer convention (WalletCrypto ->
 * wallet-crypto-libs.js, WalletVault -> vault-deps.js/vault-sodium.js,
 * PrivacyPoolClient -> privacy-pool-client-libs.js). Assigned to `self`,
 * not `window`: this bundle is loaded inside a Web Worker (via
 * importScripts()), which has no `window` global at all.
 *
 * Confirmed working before committing to this approach: snarkjs alone
 * bundles clean at ~909KB unminified; this full bundle (snarkjs + the SDK
 * pieces below) is ~4.1MB unminified — Worker-only weight, never touches
 * the main world or even the vault's own top-level page load (lazy,
 * loaded only when a proof is actually requested).
 *
 * Same `process` shim as build-wallet-vault-libs.js needs, for the same
 * reason (§5.7/§15 step 2's finding): the SDK's bundled dependencies
 * reference the Node `process` global unconditionally in a few places.
 *
 * Every Poseidon/circuit-facing function bundled here (generateMasterKeys,
 * generateDepositSecrets, generateWithdrawalSecrets, getCommitment) is
 * called directly against the SDK's own implementation, never
 * reimplemented — same principle §5.7 already established, extended here
 * to CommitmentService/WithdrawalService's proof orchestration itself:
 * never hand-roll the snarkjs.groth16.fullProve/.verify calls when the
 * SDK's own tested wrapper classes already do exactly this.
 *
 * Globals exposed on self after the script loads (self.walletVaultProverLibs):
 *   snarkjs, Circuits, CommitmentService, WithdrawalService,
 *   generateMerkleProof, getCommitment, generateDepositSecrets,
 *   generateWithdrawalSecrets, generateMasterKeys, calculateContext
 */

'use strict';

var esbuild = require('esbuild');
var path = require('path');
var fs = require('fs');

var rootDir = path.join(__dirname, '..');
var outDir = path.join(rootDir, 'core', 'lib', 'wallet');
fs.mkdirSync(outDir, { recursive: true });

var entryContents = [
  "import * as snarkjs from 'snarkjs';",
  "import {",
  "  Circuits, CommitmentService, WithdrawalService, generateMerkleProof,",
  "  getCommitment, generateDepositSecrets, generateWithdrawalSecrets,",
  "  generateMasterKeys, calculateContext",
  "} from '@0xbow/privacy-pools-core-sdk';",
  "self.walletVaultProverLibs = {",
  "  snarkjs: snarkjs,",
  "  Circuits: Circuits,",
  "  CommitmentService: CommitmentService,",
  "  WithdrawalService: WithdrawalService,",
  "  generateMerkleProof: generateMerkleProof,",
  "  getCommitment: getCommitment,",
  "  generateDepositSecrets: generateDepositSecrets,",
  "  generateWithdrawalSecrets: generateWithdrawalSecrets,",
  "  generateMasterKeys: generateMasterKeys,",
  "  calculateContext: calculateContext,",
  "};",
].join('\n');

esbuild.build({
  stdin: {
    contents:   entryContents,
    resolveDir: rootDir,
    sourcefile: 'wallet-vault-prover-libs-entry.js',
  },
  bundle:    true,
  format:    'iife',
  platform:  'browser',
  outfile:   path.join(outDir, 'vault-prover-libs.js'),
  minify:    false,
  sourcemap: false,
  logLevel:  'info',
  inject: [path.join(__dirname, 'wallet-vault-process-shim.js')],
}).then(function () {
  var stat = fs.statSync(path.join(outDir, 'vault-prover-libs.js'));
  console.log('✓ vault-prover-libs.js  ' + Math.round(stat.size / 1024) + ' KB');
}).catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});
