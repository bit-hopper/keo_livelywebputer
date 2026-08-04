/**
 * scripts/wallet-vault-ragequit-derivation-test.js
 *
 * WalletSpec.md §15 step 9's own required check, same discipline as step
 * 8's wallet-vault-withdrawal-derivation-test.js: an independent, Node-side
 * computation of what the vault's real proveCommitment (§6.6, RPC-exposed
 * as of this step) SHOULD derive internally, to cross-check against the
 * actual live vault later (via chrome-devtools MCP, driving the real
 * postMessage/Worker path — see this script's own printed instructions).
 *
 * Does NOT call WalletVault.prototype.proveCommitment directly — same
 * environment gap wallet-vault-withdrawal-derivation-test.js already
 * documents: _proverCall goes through a real browser Worker
 * (WalletVaultProver.worker.js), and `new Worker(...)` throws under plain
 * Node. This script computes the exact derivation proveCommitment()'s
 * internals perform (generateDepositSecrets(scope, index) — the SAME
 * nullifier/secret the original deposit used, §6.1/§6.6's corrected
 * finding that ragequit spends the original commitment outright rather
 * than producing a change output) using the SDK's real exports directly,
 * then feeds the result into CommitmentService.proveCommitment/
 * .verifyCommitment (also called directly, bypassing the Worker) to
 * confirm the exact param shapes/types PrivacyPoolClient.js's
 * buildAndSignRagequit sends produce a real, verifying Groth16 proof.
 *
 * Run: node scripts/wallet-vault-ragequit-derivation-test.js
 * (needs the dev server reachable at localhost:9001 for circuit artifacts —
 * same requirement as wallet-vault-prover-isolation-test.js)
 */

'use strict';

global.window = global;
require('../core/lib/wallet/vault-deps.js');
var WalletVault = require('../core/lively/identity/WalletVault.js');

global.self = global;
require('../core/lib/wallet/vault-prover-libs.js');
var proverLibs = self.walletVaultProverLibs;

var viem = require('viem');

var TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
var SNARK_SCALAR_FIELD = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

var failures = [];
function assert(condition, message) {
  if (!condition) failures.push(message);
  console.log((condition ? 'PASS' : 'FAIL') + ' — ' + message);
}

function computeLabel(scope, nonce) {
  var encoded = viem.encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }],
    [scope, nonce]
  );
  return BigInt(viem.keccak256(encoded)) % SNARK_SCALAR_FIELD;
}

async function run() {
  var wv = new WalletVault();

  var masterKeys = await new Promise(function (resolve, reject) {
    wv.derivePoolMasterKeys(TEST_MNEMONIC, function (err, keys) {
      if (err) return reject(err);
      resolve(keys);
    });
  });
  assert(typeof masterKeys.masterNullifier === 'bigint' && masterKeys.masterNullifier > 0n,
    'derived a real masterNullifier from the test mnemonic');

  // Same fixed test scope/index/label convention as this project's other
  // Node-side wallet-vault-*-test.js scripts.
  var scope = 999999999999999999999n;
  var depositIndex = 0n;
  var label = computeLabel(scope, 0n);
  var value = 1000000000000000n; // 0.001 ETH-equivalent test value

  // ── Exactly WalletVault.prototype.proveCommitment's own derivation,
  //    replicated here: generateDepositSecrets(keys, scope, index) — the
  //    SAME call proveWithdrawal makes for its existingSecrets, since
  //    ragequit spends the original commitment, not a change output. ──
  var secrets = proverLibs.generateDepositSecrets(masterKeys, scope, depositIndex);
  assert(typeof secrets.nullifier === 'bigint' && secrets.nullifier > 0n,
    'generateDepositSecrets produced a real nullifier');

  // Determinism check — same shape as deposit/withdrawal-derivation-test.js's own.
  var secrets2 = proverLibs.generateDepositSecrets(masterKeys, scope, depositIndex);
  assert(secrets.nullifier === secrets2.nullifier && secrets.secret === secrets2.secret,
    'generateDepositSecrets is deterministic for the same (keys, scope, index)');

  var commitment = proverLibs.getCommitment(value, label, secrets.nullifier, secrets.secret);
  assert(typeof commitment.hash === 'bigint' && commitment.hash > 0n,
    'computed a real Poseidon commitment hash for the test deposit');

  // ── Feed exactly what PrivacyPoolClient.js's buildAndSignRagequit sends
  //    (value, label, nullifier, secret — no Merkle proofs, no context, no
  //    change output, §6.6's corrected finding) into the real
  //    CommitmentService — confirming this step's new plumbing, not just
  //    the underlying SDK mechanism step 6 already proved in isolation. ──
  var circuits = new proverLibs.Circuits({ baseUrl: 'http://localhost:9001/core/lib/privacy-pools/' });
  var commitmentService = new proverLibs.CommitmentService(circuits);

  console.log('Generating Commitment (ragequit) proof with this step\'s exact param shapes (real Groth16)...');
  var proof = await commitmentService.proveCommitment(
    value, label, secrets.nullifier, secrets.secret
  );
  assert(!!proof.proof && !!proof.publicSignals, 'Commitment circuit produced a proof + public signals');

  var valid = await commitmentService.verifyCommitment(proof);
  assert(valid === true, 'proof verifies true against the real verification key');

  console.log('');
  console.log('TEST_MNEMONIC:  ' + TEST_MNEMONIC);
  console.log('scope:          ' + scope.toString());
  console.log('depositIndex:   ' + depositIndex.toString());
  console.log('label:          ' + label.toString());
  console.log('value:          ' + value.toString());
  console.log('');
  console.log('Cross-check (needs a live browser, WalletVaultProver.worker.js\'s real');
  console.log('Worker isn\'t reachable from plain Node): import TEST_MNEMONIC into a real');
  console.log('vault, then call lively.identity.walletVault.proveCommitment({');
  console.log('  scope: ' + scope.toString() + 'n, index: ' + depositIndex.toString() + 'n,');
  console.log('  label: ' + label.toString() + 'n, value: ' + value.toString() + 'n');
  console.log('}, onProgress, cb) and confirm it resolves with { proof, publicSignals } and no error.');

  console.log('');
  if (failures.length) {
    console.log(failures.length + ' assertion(s) FAILED:');
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  } else {
    console.log('All ragequit-derivation assertions passed.');
    process.exit(0);
  }
}

run().catch(function (e) {
  console.error('Script error:', e);
  process.exit(1);
});
