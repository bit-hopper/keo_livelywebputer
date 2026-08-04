/**
 * scripts/build-wallet-vault-libs.js
 *
 * One-time build step: bundles the vault-only dependencies WalletVault.js
 * needs (WalletSpec.md §5.4, step-2-scoped subset per the step 2 plan) into
 * a single browser-ready IIFE at core/lib/wallet/vault-deps.js.
 *
 * Run from the project root: node scripts/build-wallet-vault-libs.js
 * (also runs automatically via the postinstall npm script)
 *
 * Scoped lean to what's needed through WalletSpec.md §15 step 3 (mnemonic
 * generate/import/encrypt/store/unlock, the §5.1 HKDF synthetic-pool-
 * mnemonic derivation, and getAddress):
 *   - @scure/bip39 (+ its English wordlist) for mnemonic generate/validate/
 *     entropy<->mnemonic conversion and BIP-39 seed derivation.
 *   - @noble/hashes for HKDF-SHA256 (the §5.1 derivation step).
 *   - @0xbow/privacy-pools-core-sdk's generateMasterKeys — the only export
 *     the vault needs from the SDK at this step; every Poseidon-based
 *     function it wraps takes secret material and is vault-only per §5.7,
 *     called directly here, never reimplemented.
 *   - viem/accounts' mnemonicToAccount — step 3 needs only the address
 *     derivation slice of this (getAddress, account index 0 of the real
 *     mnemonic per §5.1). Full HD/signing surface for actual transaction
 *     building is still step 4's addition, not pulled forward here.
 * NOT included yet (step 4's job): @scure/bip32, @noble/curves, viem's
 * tx-signing surface. Argon2id comes from libsodium instead of a separate
 * package (already required for crypto_secretbox; the vault page loads
 * /core/lib/wallet/vault-sodium.js directly via its own <script> tag rather
 * than re-bundling it here).
 *
 * Step 7 addition: generateDepositSecrets + hashPrecommitment (§6.1/§6.2) —
 * deposit needs only a Poseidon hash, no ZK proof, so these run directly on
 * the vault page's own thread rather than inside the step-6 prover Worker
 * (which already bundles generateDepositSecrets separately, for its own
 * Worker-scope isolation test — this is a second, deliberate copy in a
 * different bundle, not a shared import, matching this project's existing
 * one-bundle-per-consumer convention).
 *
 * Globals exposed on window after the script loads:
 *   window.walletVaultLibs.generateMnemonic(strength)
 *   window.walletVaultLibs.validateMnemonic(mnemonic)
 *   window.walletVaultLibs.mnemonicToEntropy(mnemonic)
 *   window.walletVaultLibs.entropyToMnemonic(entropy)
 *   window.walletVaultLibs.mnemonicToSeedSync(mnemonic)
 *   window.walletVaultLibs.hkdfSha256(ikm, salt, info, length)
 *   window.walletVaultLibs.generateMasterKeys(mnemonic)
 *   window.walletVaultLibs.mnemonicToAccount(mnemonic, { accountIndex })
 *   window.walletVaultLibs.generateDepositSecrets(keys, scope, index)
 *   window.walletVaultLibs.hashPrecommitment(nullifier, secret)
 */

'use strict';

var esbuild = require('esbuild');
var path = require('path');
var fs = require('fs');

var rootDir = path.join(__dirname, '..');
var outDir = path.join(rootDir, 'core', 'lib', 'wallet');
fs.mkdirSync(outDir, { recursive: true });

var entryContents = [
  "import { generateMnemonic, validateMnemonic, mnemonicToEntropy, entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';",
  "import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';",
  "import { hkdf } from '@noble/hashes/hkdf.js';",
  "import { sha256 } from '@noble/hashes/sha2.js';",
  "import { generateMasterKeys, generateDepositSecrets, hashPrecommitment } from '@0xbow/privacy-pools-core-sdk';",
  "import { mnemonicToAccount } from 'viem/accounts';",
  "window.walletVaultLibs = {",
  "  generateMnemonic: function (strength) { return generateMnemonic(englishWordlist, strength || 128); },",
  "  validateMnemonic: function (mnemonic) { return validateMnemonic(mnemonic, englishWordlist); },",
  "  mnemonicToEntropy: function (mnemonic) { return mnemonicToEntropy(mnemonic, englishWordlist); },",
  "  entropyToMnemonic: function (entropy) { return entropyToMnemonic(entropy, englishWordlist); },",
  "  mnemonicToSeedSync: mnemonicToSeedSync,",
  "  hkdfSha256: function (ikm, salt, info, length) { return hkdf(sha256, ikm, salt, info, length); },",
  "  generateMasterKeys: generateMasterKeys,",
  "  mnemonicToAccount: mnemonicToAccount,",
  "  generateDepositSecrets: generateDepositSecrets,",
  "  hashPrecommitment: hashPrecommitment,",
  "};",
].join('\n');

esbuild.build({
  stdin: {
    contents:   entryContents,
    resolveDir: rootDir,
    sourcefile: 'wallet-vault-libs-entry.js',
  },
  bundle:    true,
  format:    'iife',
  platform:  'browser',
  outfile:   path.join(outDir, 'vault-deps.js'),
  minify:    false,
  sourcemap: false,
  logLevel:  'info',
  // @0xbow/privacy-pools-core-sdk's dist bundles a few Node-oriented
  // dependencies (util/assert-adjacent code) that reference the `process`
  // global unconditionally (e.g. `process.env.NODE_DEBUG` with no
  // `typeof process !== 'undefined'` guard). esbuild's browser platform
  // does not auto-provide `process` the way webpack's Node polyfills do —
  // inject the standard browser `process` shim (via a named-export wrapper,
  // since esbuild's `inject` matches free identifiers against named
  // exports, and the `process` package itself is CommonJS) so those
  // references resolve to an inert object instead of throwing
  // ReferenceError at eval time.
  inject: [path.join(__dirname, 'wallet-vault-process-shim.js')],
}).then(function () {
  var stat = fs.statSync(path.join(outDir, 'vault-deps.js'));
  console.log('✓ vault-deps.js  ' + Math.round(stat.size / 1024) + ' KB');
}).catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});
