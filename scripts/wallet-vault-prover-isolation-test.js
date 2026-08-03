/**
 * scripts/wallet-vault-prover-isolation-test.js
 *
 * WalletSpec.md §15 step 6's own required check: "provable in isolation
 * (feed it known test vectors, check the proof verifies)." Standalone
 * Node script (same convention as wallet-vault-key-separation-test.js —
 * pure crypto, no DOM/Worker-specific behavior to exercise here).
 *
 * Constructs a fully self-contained, valid witness for BOTH circuits using
 * the SDK's own exported helpers — a real test mnemonic, HKDF-derived per
 * §5.1 the same way WalletVault.js does it, a tiny local LeanIMT test
 * tree (not live chain state) — then generates and verifies REAL Groth16
 * proofs via CommitmentService/WithdrawalService (which themselves wrap
 * snarkjs.groth16.fullProve/.verify directly, per those files' own
 * source — nothing here reimplements circuit-facing crypto).
 *
 * Deliberately not mocked: your own finding this session was that
 * privacy-pools-website's reference zkProofWorker.ts is currently a mock
 * stub returning hardcoded zero proofs. This script is the opposite of
 * that — real artifacts, real snarkjs, real Groth16 verification.
 *
 * Run: node scripts/wallet-vault-prover-isolation-test.js
 * (expect real wall-clock time — Groth16 proving is CPU-bound, especially
 * for the Withdraw circuit; WalletSpec.md §5.6 flags this as expected)
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

  // ── §5.1 derivation, exactly as WalletVault.js does it ──
  var masterKeys = await new Promise(function (resolve, reject) {
    wv.derivePoolMasterKeys(TEST_MNEMONIC, function (err, keys) {
      if (err) return reject(err);
      resolve(keys);
    });
  });
  assert(typeof masterKeys.masterNullifier === 'bigint' && masterKeys.masterNullifier > 0n,
    'derived real masterNullifier from the §5.1 HKDF chain');

  // browser: true (fetch-based) against the actual running dev server —
  // not just a workaround, this is also more realistic: it's exactly how
  // the real Worker will load these files too (§5.6). The SDK's Node-mode
  // (browser: false, fs-based) loader turned out to have a real bug on
  // Windows: it reads artifactUrl.pathname raw instead of going through
  // url.fileURLToPath(), which mangles the drive letter for a file:// URL
  // (confirmed directly: produced a literal "C:\C:\Users\..." path and
  // ENOENT'd). That's an SDK bug, not something to route around by
  // reimplementing artifact loading — using its own fetch-based path
  // (which has no such bug) sidesteps it entirely rather than fighting it.
  var circuits = new proverLibs.Circuits({
    baseUrl: 'http://localhost:9001/core/lib/privacy-pools/',
  });

  // ── Commitment proof: fully self-contained, no tree needed ──
  var scope = 999999999999999999999n; // arbitrary test scope — not a real pool's
  var nonce = 0n;
  var index = 0n;
  var label = computeLabel(scope, nonce);
  var value = 1000000000000000n; // 0.001 ETH-equivalent test value

  var depositSecrets = proverLibs.generateDepositSecrets(masterKeys, scope, index);
  var commitment = proverLibs.getCommitment(value, label, depositSecrets.nullifier, depositSecrets.secret);
  assert(typeof commitment.hash === 'bigint' && commitment.hash > 0n,
    'computed a real Poseidon commitment hash for the test deposit');

  console.log('Generating Commitment proof (real Groth16, real wall-clock time)...');
  var commitmentService = new proverLibs.CommitmentService(circuits);
  var commitmentProof = await commitmentService.proveCommitment(
    value, label, depositSecrets.nullifier, depositSecrets.secret
  );
  assert(!!commitmentProof.proof && !!commitmentProof.publicSignals,
    'Commitment circuit produced a proof + public signals');

  var commitmentValid = await commitmentService.verifyCommitment(commitmentProof);
  assert(commitmentValid === true, 'Commitment proof verifies true against the real verification key');

  // ── Withdrawal proof: built on top of the commitment above, using a
  //    tiny local test tree (not live chain state) via the SDK's own
  //    generateMerkleProof — never a hand-rolled Poseidon tree. ──
  var dummyStateLeaf = 123456789n;
  var stateMerkleProof = proverLibs.generateMerkleProof([commitment.hash, dummyStateLeaf], commitment.hash);
  var dummyAspLeaf = 987654321n;
  var aspMerkleProof = proverLibs.generateMerkleProof([label, dummyAspLeaf], label);

  // siblings.length is the tree depth for a LeanIMT inclusion proof — one
  // sibling per level, confirmed by construction (no separate depth query
  // needed, and none is available without the SDK's own internal poseidon
  // instance, which isn't exported — see this script's own commit message
  // for why that's deliberately not reimplemented here).
  var stateTreeDepth = BigInt(stateMerkleProof.siblings.length);
  var aspTreeDepth = BigInt(aspMerkleProof.siblings.length);

  var withdrawal = {
    processooor: '0x000000000000000000000000000000000000dEaD',
    data: '0x',
  };

  // Same formula WalletCrypto.js's calculateContext uses (§6.4) — computed
  // directly via viem here since this is a plain Node script, not the
  // vault's own lazy-loaded module instance.
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
  var context = BigInt(viem.keccak256(encoded)) % SNARK_SCALAR_FIELD;

  var withdrawalSecrets = proverLibs.generateWithdrawalSecrets(masterKeys, label, index);

  var withdrawalService = new proverLibs.WithdrawalService(circuits);

  console.log('Generating Withdraw proof (real Groth16, real wall-clock time, this one is slower)...');
  var withdrawalProof = await withdrawalService.proveWithdrawal(
    { value: value, label: label, nullifier: depositSecrets.nullifier, secret: depositSecrets.secret },
    {
      context: context,
      withdrawalAmount: value,
      stateMerkleProof: stateMerkleProof,
      aspMerkleProof: aspMerkleProof,
      stateRoot: stateMerkleProof.root,
      stateTreeDepth: stateTreeDepth,
      aspRoot: aspMerkleProof.root,
      aspTreeDepth: aspTreeDepth,
      newSecret: withdrawalSecrets.secret,
      newNullifier: withdrawalSecrets.nullifier,
    }
  );
  assert(!!withdrawalProof.proof && !!withdrawalProof.publicSignals,
    'Withdraw circuit produced a proof + public signals');

  var withdrawalValid = await withdrawalService.verifyWithdrawal(withdrawalProof);
  assert(withdrawalValid === true, 'Withdraw proof verifies true against the real verification key');

  console.log('');
  if (failures.length) {
    console.log(failures.length + ' assertion(s) FAILED:');
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  } else {
    console.log('All prover isolation assertions passed — real Groth16 proofs, really verified.');
    process.exit(0);
  }
}

run().catch(function (e) {
  console.error('Script error:', e);
  process.exit(1);
});
