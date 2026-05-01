#!/usr/bin/env node
/**
 * KMS Health Check & Test
 *
 * Verifies that the KMS is working correctly:
 * - Key generation
 * - Signing/verification
 * - Encryption/decryption
 *
 * Usage:
 *   node bin/test-kms.js
 */

const KMSClient = require("../core/servers/KMSClient");

async function main() {
  console.log("");
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║           KMS Health Check & Functionality Test          ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log("");

  try {
    // Initialize KMS
    console.log("🔧 Initializing KMS...");
    const kms = new KMSClient();
    const health = await kms.healthCheck();

    if (health.status === "unhealthy") {
      console.log(`❌ KMS Health Check Failed: ${health.error}`);
      process.exit(1);
    }

    console.log(`✅ KMS initialized (${health.keysLoaded} keys loaded)`);
    console.log("");

    // Test 1: Generate signing key
    console.log("📋 Test 1: Generate signing key");
    const signingKey = await kms.generateSigningKey("test-user", 1);
    console.log(`   ✓ Key ID: ${signingKey.keyId}`);
    console.log(`   ✓ Algorithm: ${signingKey.algorithm}`);
    console.log(`   ✓ Public Key: ${signingKey.publicKey.substring(0, 32)}...`);
    console.log("");

    // Test 2: Sign and verify
    console.log("📋 Test 2: Sign and verify message");
    const message = Buffer.from("Hello, Lively!");
    const signature = await kms.sign(signingKey.keyId, message);
    console.log(`   ✓ Message: "${message.toString()}"`);
    console.log(`   ✓ Signature: ${signature.substring(0, 32)}...`);

    const verified = await kms.verify(signingKey.keyId, signature, message);
    if (verified) {
      console.log("   ✓ Verification: PASSED");
    } else {
      console.log("   ✗ Verification: FAILED");
      process.exit(1);
    }
    console.log("");

    // Test 3: Verify with corrupted message fails
    console.log("📋 Test 3: Verify with corrupted message (should fail)");
    const corruptedMessage = Buffer.from("Hacked, Lively!");
    const verifiedCorrupted = await kms.verify(
      signingKey.keyId,
      signature,
      corruptedMessage,
    );
    if (!verifiedCorrupted) {
      console.log("   ✓ Correctly rejected corrupted message");
    } else {
      console.log("   ✗ ERROR: Accepted corrupted message!");
      process.exit(1);
    }
    console.log("");

    // Test 4: Generate encryption key
    console.log("📋 Test 4: Generate encryption key");
    const encryptionKey = await kms.generateEncryptionKey("test-user", 1);
    console.log(`   ✓ Key ID: ${encryptionKey.keyId}`);
    console.log(`   ✓ Algorithm: ${encryptionKey.algorithm}`);
    console.log("");

    // Test 5: Encrypt and decrypt
    console.log("📋 Test 5: Encrypt and decrypt data");
    const secretData = Buffer.from(
      JSON.stringify({
        username: "alice",
        email: "alice@example.com",
        password_hash: "xxx",
      }),
    );
    console.log(`   Plaintext: ${secretData.toString().substring(0, 50)}...`);

    const encrypted = await kms.encrypt(encryptionKey.keyId, secretData);
    console.log(`   ✓ Encrypted: ${encrypted.substring(0, 50)}...`);

    const decrypted = await kms.decrypt(encryptionKey.keyId, encrypted);
    if (decrypted.equals(secretData)) {
      console.log(
        `   ✓ Decrypted: ${decrypted.toString().substring(0, 50)}...`,
      );
      console.log("   ✓ Match: PASSED");
    } else {
      console.log("   ✗ Decrypted data does not match original");
      process.exit(1);
    }
    console.log("");

    // Test 6: Decrypt with wrong key fails
    console.log("📋 Test 6: Decrypt with different key (should fail)");
    const wrongKey = await kms.generateEncryptionKey("test-user", 2);
    try {
      const wrongDecrypted = await kms.decrypt(wrongKey.keyId, encrypted);
      console.log("   ✗ ERROR: Decryption with wrong key should have failed!");
      process.exit(1);
    } catch (err) {
      console.log("   ✓ Correctly rejected decryption with wrong key");
    }
    console.log("");

    // Test 7: List keys
    console.log("📋 Test 7: List all keys for user");
    const userKeys = await kms.listKeys("test-user");
    console.log(`   ✓ Found ${userKeys.length} keys:`);
    for (const key of userKeys) {
      console.log(
        `     - ${key.keyId} (${key.keyType}, ${key.isActive ? "active" : "inactive"})`,
      );
    }
    console.log("");

    // Test 8: Key rotation
    console.log("📋 Test 8: Key rotation");
    const oldKeyId = signingKey.keyId;
    const newKey = await kms.rotateKey(oldKeyId);
    console.log(`   ✓ Old key: ${oldKeyId}`);
    console.log(`   ✓ New key: ${newKey.keyId}`);

    const oldKeyData = await kms.getKey(oldKeyId);
    const newKeyData = await kms.getKey(newKey.keyId);
    console.log(`   ✓ Old key active: ${oldKeyData.isActive}`);
    console.log(`   ✓ New key active: ${newKeyData.isActive}`);
    console.log("");

    // Success
    console.log(
      "╔═══════════════════════════════════════════════════════════╗",
    );
    console.log(
      "║                    ✅ ALL TESTS PASSED                    ║",
    );
    console.log(
      "╚═══════════════════════════════════════════════════════════╝",
    );
    console.log("");
    console.log("✨ KMS is working correctly and ready for use!");
    console.log("");
  } catch (err) {
    console.error("");
    console.error("❌ Test failed:", err.message);
    console.error("");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
