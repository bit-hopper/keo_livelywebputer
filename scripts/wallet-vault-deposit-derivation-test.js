/**
 * scripts/wallet-vault-deposit-derivation-test.js
 *
 * WalletSpec.md §15 step 7's own required check: an independent, vault-
 * free computation of a deposit's precommitment to compare the live
 * vault's real deriveDepositSecrets RPC result against (via chrome-devtools
 * MCP, driving the actual unlocked-vault path) — the same
 * independent-cross-check pattern every prior step has used (viem address
 * recomputation in step 4, Node-side proof generation in step 6).
 *
 * Does NOT go through setup()/unlock() — that plumbing is already proven by
 * wallet-vault-key-separation-test.js and WalletBridge's own live tests.
 * This script only needs derivePoolMasterKeys(mnemonic) (a pure function of
 * the mnemonic, already proven correct) plus generateDepositSecrets/
 * hashPrecommitment (§6.1's exact formula) — the same two functions
 * WalletVault.prototype.deriveDepositSecrets calls internally, computed
 * here independently for a fixed test mnemonic/scope/index.
 *
 * Run: node scripts/wallet-vault-deposit-derivation-test.js
 */

'use strict';

global.window = global;
require('../core/lib/wallet/vault-deps.js');
var WalletVault = require('../core/lively/identity/WalletVault.js');

var wv = new WalletVault();

// Same fixed BIP-39 test vector as wallet-vault-key-separation-test.js —
// reproducible/debuggable, not a random mnemonic that happened to work.
var TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Arbitrary fixed test scope/index — not a real pool's scope. Only used to
// get a known-correct precommitment to compare a live RPC result against.
var TEST_SCOPE = 999999999999999999999n;
var TEST_INDEX = 0n;

var failures = [];
function assert(condition, message) {
  if (!condition) failures.push(message);
  console.log((condition ? 'PASS' : 'FAIL') + ' — ' + message);
}

wv.derivePoolMasterKeys(TEST_MNEMONIC, function (err, keys) {
  if (err) throw err;
  assert(typeof keys.masterNullifier === 'bigint' && keys.masterNullifier > 0n,
    'derived a real masterNullifier from the test mnemonic');
  assert(typeof keys.masterSecret === 'bigint' && keys.masterSecret > 0n,
    'derived a real masterSecret from the test mnemonic');

  wv.withVaultLibs(function (err2, libs) {
    if (err2) throw err2;

    var secrets = libs.generateDepositSecrets(keys, TEST_SCOPE, TEST_INDEX);
    assert(typeof secrets.nullifier === 'bigint' && secrets.nullifier > 0n,
      'generateDepositSecrets produced a real nullifier');
    assert(typeof secrets.secret === 'bigint' && secrets.secret > 0n,
      'generateDepositSecrets produced a real secret');

    var precommitment = libs.hashPrecommitment(secrets.nullifier, secrets.secret);
    assert(typeof precommitment === 'bigint' && precommitment > 0n,
      'hashPrecommitment produced a real precommitment hash');

    // Determinism check — deriving twice for the same (keys, scope, index)
    // must produce the identical precommitment (WalletVault.prototype.
    // deriveDepositSecrets relies on this: the vault is stateless per call,
    // the same inputs always yield the same output).
    var secrets2 = libs.generateDepositSecrets(keys, TEST_SCOPE, TEST_INDEX);
    var precommitment2 = libs.hashPrecommitment(secrets2.nullifier, secrets2.secret);
    assert(precommitment === precommitment2,
      'deriving twice for the same (keys, scope, index) is deterministic');

    // Different index must produce a different precommitment — the whole
    // point of index-based derivation (§6.1) is that each deposit gets a
    // distinct nullifier/secret/precommitment.
    var secretsOtherIndex = libs.generateDepositSecrets(keys, TEST_SCOPE, TEST_INDEX + 1n);
    var precommitmentOtherIndex = libs.hashPrecommitment(secretsOtherIndex.nullifier, secretsOtherIndex.secret);
    assert(precommitment !== precommitmentOtherIndex,
      'a different index produces a different precommitment');

    console.log('');
    console.log('TEST_MNEMONIC: ' + TEST_MNEMONIC);
    console.log('TEST_SCOPE:    ' + TEST_SCOPE.toString());
    console.log('TEST_INDEX:    ' + TEST_INDEX.toString());
    console.log('EXPECTED PRECOMMITMENT: ' + precommitment.toString());
    console.log('');
    console.log('Cross-check: unlock a vault with TEST_MNEMONIC imported, then call');
    console.log('walletVault.deriveDepositSecrets(' + TEST_SCOPE.toString() + 'n, ' + TEST_INDEX.toString() + 'n, cb)');
    console.log('and confirm the result matches EXPECTED PRECOMMITMENT above.');

    console.log('');
    if (failures.length) {
      console.log(failures.length + ' assertion(s) FAILED:');
      failures.forEach(function (f) { console.log('  - ' + f); });
      process.exit(1);
    } else {
      console.log('All deposit-derivation assertions passed.');
      process.exit(0);
    }
  });
});
