/**
 * scripts/wallet-vault-key-separation-test.js
 *
 * Standalone Node script (not wired into run_tests.js/TestCase — see the
 * step 2 plan for why: no core/lively/identity/* module has ever been
 * tested in that browser-oriented framework, and WalletVault.js is
 * deliberately plain JS outside the Lively module system).
 *
 * Proves WalletSpec.md §5.1's key-separation fix is actually implemented,
 * not just designed — the single highest-consequence check in §16's
 * verification checklist. The hazard §5.1 identifies: privacy-pools-core's
 * generateMasterKeys(mnemonic) computes masterNullifier/masterSecret from
 * that SAME mnemonic's account-index-0/1 HD private keys. If a wallet fed
 * its real, user-backed-up mnemonic directly into generateMasterKeys (the
 * naive approach), the pool's master nullifier/secret would be one Poseidon
 * hash away from the same mnemonic's ordinary Ethereum spending key — a
 * genuine preimage relationship, not a theoretical one.
 *
 * The fix (WalletVault.js's deriveSyntheticPoolMnemonic): HKDF-SHA256 over
 * the real mnemonic's BIP-39 seed produces a second, synthetic mnemonic;
 * only THAT ever reaches generateMasterKeys. This script asserts that fix
 * actually holds for a real mnemonic, not just that the code compiles.
 *
 * Run: node scripts/wallet-vault-key-separation-test.js
 */

'use strict';

global.window = global;
require('../core/lib/wallet/vault-deps.js');
var WalletVault = require('../core/lively/identity/WalletVault.js');
var mnemonicToAccount = require('viem/accounts').mnemonicToAccount;

var wv = new WalletVault();

// Standard BIP-39 test vector — fixed and well-known, so this test's
// expected properties are reproducible and debuggable, not just "some
// random mnemonic happened to pass."
var TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

var failures = [];
function assert(condition, message) {
  if (!condition) failures.push(message);
  console.log((condition ? 'PASS' : 'FAIL') + ' — ' + message);
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function run(thenDo) {
  wv.validateMnemonic(TEST_MNEMONIC, function (err, valid) {
    if (err) throw err;
    assert(valid, 'test mnemonic is a valid BIP-39 mnemonic');

    wv.deriveSyntheticPoolMnemonic(TEST_MNEMONIC, function (err2, synthetic1) {
      if (err2) throw err2;

      assert(synthetic1 !== TEST_MNEMONIC,
        'synthetic pool mnemonic differs from the real mnemonic (not the same string reused)');
      assert(synthetic1.trim().split(/\s+/).length === 24,
        'synthetic pool mnemonic is 24 words (256 bits of entropy)');

      wv.deriveSyntheticPoolMnemonic(TEST_MNEMONIC, function (err3, synthetic2) {
        if (err3) throw err3;
        assert(synthetic1 === synthetic2,
          'synthetic pool mnemonic is deterministic (same real mnemonic -> same synthetic mnemonic every time)');

        // Root-cause check: the actual HD private keys at account index 0/1
        // must differ between the real mnemonic and the synthetic one —
        // this is the literal preimage relationship §5.1 identifies as the
        // hazard, checked directly rather than only through hashed outputs.
        var realKey0 = mnemonicToAccount(TEST_MNEMONIC, { accountIndex: 0 }).getHdKey().privateKey;
        var realKey1 = mnemonicToAccount(TEST_MNEMONIC, { accountIndex: 1 }).getHdKey().privateKey;
        var synKey0 = mnemonicToAccount(synthetic1, { accountIndex: 0 }).getHdKey().privateKey;
        var synKey1 = mnemonicToAccount(synthetic1, { accountIndex: 1 }).getHdKey().privateKey;

        assert(hex(realKey0) !== hex(synKey0),
          'real mnemonic\'s account-index-0 key differs from the synthetic mnemonic\'s account-index-0 key');
        assert(hex(realKey1) !== hex(synKey1),
          'real mnemonic\'s account-index-1 key differs from the synthetic mnemonic\'s account-index-1 key');

        wv.derivePoolMasterKeys(TEST_MNEMONIC, function (err4, actualKeys) {
          if (err4) throw err4;

          // The naive, rejected approach §5.1 describes: feed the REAL
          // mnemonic directly into generateMasterKeys. If our fix works,
          // this must NOT match what the vault actually produces.
          wv.withVaultLibs(function (err5, libs) {
            if (err5) throw err5;
            var naiveKeys = libs.generateMasterKeys(TEST_MNEMONIC);

            assert(naiveKeys.masterNullifier !== actualKeys.masterNullifier,
              'masterNullifier is NOT what the naive "same mnemonic, different index" approach would have produced');
            assert(naiveKeys.masterSecret !== actualKeys.masterSecret,
              'masterSecret is NOT what the naive "same mnemonic, different index" approach would have produced');

            assert(typeof actualKeys.masterNullifier === 'bigint' && actualKeys.masterNullifier > 0n,
              'masterNullifier is a non-zero bigint');
            assert(typeof actualKeys.masterSecret === 'bigint' && actualKeys.masterSecret > 0n,
              'masterSecret is a non-zero bigint');

            thenDo();
          });
        });
      });
    });
  });
}

run(function () {
  console.log('');
  if (failures.length) {
    console.log(failures.length + ' assertion(s) FAILED:');
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  } else {
    console.log('All key-separation assertions passed.');
    process.exit(0);
  }
});
