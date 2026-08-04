/**
 * scripts/wallet-vault-withdrawal-derivation-test.js
 *
 * WalletSpec.md §15 step 8's own required check, same discipline as step
 * 7's wallet-vault-deposit-derivation-test.js: an independent, Node-side
 * computation of what the vault's real proveWithdrawal (§3.4, RPC-exposed
 * as of this step) SHOULD derive internally, to cross-check against the
 * actual live vault later (via chrome-devtools MCP, driving the real
 * postMessage/Worker path — see this script's own printed instructions).
 *
 * Does NOT call WalletVault.prototype.proveWithdrawal directly — that
 * method's _proverCall goes through a real browser Worker
 * (WalletVaultProver.worker.js), which plain Node has no equivalent for
 * (confirmed directly: new Worker(...) throws "Worker is not available in
 * this context" under Node — there is no polyfill to route around here,
 * same class of environment gap wallet-vault-prover-isolation-test.js
 * already sidesteps by calling CommitmentService/WithdrawalService
 * directly instead of through any Worker). This script does the same:
 * computes the exact derivation proveWithdrawal()'s internals perform
 * (generateDepositSecrets for the existing commitment,
 * generateWithdrawalSecrets for the change output — §6.1's formulas,
 * confirmed exact match against WalletVault.js's own new proveWithdrawal
 * source) using the SDK's real exports directly, then feeds the result
 * into WithdrawalService.proveWithdrawal/.verifyWithdrawal (also called
 * directly, bypassing the Worker) to confirm the exact param shapes/types
 * PrivacyPoolClient.js's buildAndSignWithdrawal sends produce a real,
 * verifying Groth16 proof — i.e. that this step's new derivation +
 * plumbing is correct, even though the Worker-hop itself needs a live
 * browser to exercise (printed cross-check instructions at the end).
 *
 * Run: node scripts/wallet-vault-withdrawal-derivation-test.js
 * (needs the dev server reachable at localhost:9001 for circuit artifacts —
 * same requirement as wallet-vault-prover-isolation-test.js; real
 * wall-clock proving time, the Withdraw circuit is the slower one)
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

function calculateContext(withdrawal, scope) {
  var encoded = viem.encodeAbiParameters(
    [
      { name: 'withdrawal', type: 'tuple', components: [
        { name: 'processooor', type: 'address' },
        { name: 'data', type: 'bytes' },
      ]},
      { name: 'scope', type: 'uint256' },
    ],
    [{ processooor: withdrawal.processooor, data: withdrawal.data }, scope]
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

  // Fixed test scope/index/label — arbitrary, not a real pool's, same
  // convention as this project's other Node-side wallet-vault-*-test.js
  // scripts (reproducible/debuggable, not randomly generated).
  var scope = 999999999999999999999n;
  var depositIndex = 0n;
  var withdrawalIndex = 0n;
  var label = computeLabel(scope, 0n);
  var value = 1000000000000000n; // 0.001 ETH-equivalent test value
  var recipient = '0x000000000000000000000000000000000000dEaD';

  // ── Exactly WalletVault.prototype.proveWithdrawal's own derivation,
  //    replicated here (its own source: generateDepositSecrets(keys,
  //    scope, index) for the existing commitment, generateWithdrawalSecrets
  //    (keys, label, withdrawalIndex) for the change output). ──
  var existingSecrets = proverLibs.generateDepositSecrets(masterKeys, scope, depositIndex);
  var newSecrets = proverLibs.generateWithdrawalSecrets(masterKeys, label, withdrawalIndex);
  assert(typeof existingSecrets.nullifier === 'bigint' && existingSecrets.nullifier > 0n,
    'generateDepositSecrets produced a real existing nullifier');
  assert(typeof newSecrets.nullifier === 'bigint' && newSecrets.nullifier > 0n,
    'generateWithdrawalSecrets produced a real new (change-output) nullifier');
  assert(existingSecrets.nullifier !== newSecrets.nullifier,
    'existing and new nullifiers are distinct (different index spaces, §6.1)');

  // Determinism check — same shape as deposit-derivation-test.js's own.
  var newSecrets2 = proverLibs.generateWithdrawalSecrets(masterKeys, label, withdrawalIndex);
  assert(newSecrets.nullifier === newSecrets2.nullifier && newSecrets.secret === newSecrets2.secret,
    'generateWithdrawalSecrets is deterministic for the same (keys, label, index)');

  var commitment = proverLibs.getCommitment(value, label, existingSecrets.nullifier, existingSecrets.secret);

  // Tiny local test tree (not live chain state) — same pattern as step 6's
  // own isolation test, never a hand-rolled Poseidon tree.
  var dummyStateLeaf = 123456789n;
  var stateMerkleProof = proverLibs.generateMerkleProof([commitment.hash, dummyStateLeaf], commitment.hash);
  var dummyAspLeaf = 987654321n;
  var aspMerkleProof = proverLibs.generateMerkleProof([label, dummyAspLeaf], label);
  // §6.4.1's confirmed NaN workaround — applied here too for parity with
  // PrivacyPoolClient.js's getMerkleProof, even though this tiny test tree
  // isn't expected to trigger it.
  if (Object.is(aspMerkleProof.index, NaN)) aspMerkleProof.index = 0;

  var withdrawal = { processooor: recipient, data: '0x' };
  var context = calculateContext(withdrawal, scope);

  // ── Feed exactly what PrivacyPoolClient.js's buildWithdrawalProofInputs
  //    produces (field names, BigInt types, siblings.length-as-depth) into
  //    the real WithdrawalService — confirming this step's new plumbing,
  //    not just the underlying SDK mechanism step 6 already proved. ──
  var circuits = new proverLibs.Circuits({ baseUrl: 'http://localhost:9001/core/lib/privacy-pools/' });
  var withdrawalService = new proverLibs.WithdrawalService(circuits);

  console.log('Generating Withdraw proof with this step\'s exact param shapes (real Groth16, real wall-clock time)...');
  var proof = await withdrawalService.proveWithdrawal(
    { value: value, label: label, nullifier: existingSecrets.nullifier, secret: existingSecrets.secret },
    {
      context: context,
      withdrawalAmount: value,
      stateMerkleProof: stateMerkleProof,
      aspMerkleProof: aspMerkleProof,
      stateRoot: stateMerkleProof.root,
      stateTreeDepth: BigInt(stateMerkleProof.siblings.length),
      aspRoot: aspMerkleProof.root,
      aspTreeDepth: BigInt(aspMerkleProof.siblings.length),
      newSecret: newSecrets.secret,
      newNullifier: newSecrets.nullifier,
    }
  );
  assert(!!proof.proof && !!proof.publicSignals, 'Withdraw circuit produced a proof + public signals');

  var valid = await withdrawalService.verifyWithdrawal(proof);
  assert(valid === true, 'proof verifies true against the real verification key');

  console.log('');
  console.log('TEST_MNEMONIC:    ' + TEST_MNEMONIC);
  console.log('scope:            ' + scope.toString());
  console.log('depositIndex:     ' + depositIndex.toString());
  console.log('label:            ' + label.toString());
  console.log('value:            ' + value.toString());
  console.log('withdrawalIndex:  ' + withdrawalIndex.toString());
  console.log('recipient:        ' + recipient);
  console.log('');
  console.log('Cross-check (needs a live browser, WalletVaultProver.worker.js\'s real');
  console.log('Worker isn\'t reachable from plain Node): import TEST_MNEMONIC into a real');
  console.log('vault, then call lively.identity.walletVault.proveWithdrawal({');
  console.log('  scope: ' + scope.toString() + 'n, index: ' + depositIndex.toString() + 'n, label: ' + label.toString() + 'n,');
  console.log('  value: ' + value.toString() + 'n, withdrawalIndex: ' + withdrawalIndex.toString() + 'n,');
  console.log('  input: { context: ' + context.toString() + 'n, withdrawalAmount: ' + value.toString() + 'n,');
  console.log('    stateMerkleProof: <same tiny test tree as this script>, aspMerkleProof: <same>,');
  console.log('    stateRoot: ' + stateMerkleProof.root.toString() + 'n, stateTreeDepth: ' + stateMerkleProof.siblings.length + 'n,');
  console.log('    aspRoot: ' + aspMerkleProof.root.toString() + 'n, aspTreeDepth: ' + aspMerkleProof.siblings.length + 'n }');
  console.log('}, onProgress, cb) and confirm it resolves with { proof, publicSignals } and no error.');

  console.log('');
  if (failures.length) {
    console.log(failures.length + ' assertion(s) FAILED:');
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  } else {
    console.log('All withdrawal-derivation assertions passed.');
    process.exit(0);
  }
}

run().catch(function (e) {
  console.error('Script error:', e);
  process.exit(1);
});
