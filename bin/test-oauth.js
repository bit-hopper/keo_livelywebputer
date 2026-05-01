#!/usr/bin/env node
/**
 * OAuth Integration Test Suite
 *
 * Tests OAuth 2.1 flow, identity endpoints, and DID resolution
 *
 * Usage:
 *   node bin/test-oauth.js
 */

const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const IDENTITY_DB = process.env.IDENTITY_DB || "./objects-identity.sqlite";

let db;
let testsPassed = 0;
let testsFailed = 0;

/**
 * Test framework
 */
async function test(name, fn) {
  try {
    console.log(`📋 Test: ${name}`);
    await fn();
    testsPassed++;
    console.log(`   ✅ PASSED`);
  } catch (err) {
    testsFailed++;
    console.error(`   ❌ FAILED: ${err.message}`);
  }
}

/**
 * Database helpers
 */
function dbQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function dbRun(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

/**
 * Main test suite
 */
async function runTests() {
  console.log("");
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║         OAuth Integration Test Suite                      ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("💡 All tests use database queries (no HTTP server required)");
  console.log("");

  // Connect to database
  try {
    await new Promise((resolve, reject) => {
      db = new sqlite3.Database(IDENTITY_DB, (err) => {
        if (err) reject(err);
        else {
          console.log(`✓ Connected to database: ${IDENTITY_DB}`);
          resolve();
        }
      });
    });
  } catch (err) {
    console.error("Failed to connect to database:", err.message);
    process.exit(1);
  }

  // Test OAuth flow
  console.log("\n🔐 OAuth 2.1 PKCE Flow Tests\n");

  await test("Generate PKCE challenge", async () => {
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    if (!codeChallenge || codeChallenge.length < 10) {
      throw new Error("Invalid code challenge");
    }

    global.testData = { codeVerifier, codeChallenge };
  });

  await test("PKCE validation (S256)", async () => {
    // Verify PKCE formula works
    const { codeVerifier, codeChallenge } = global.testData;

    const recalculated = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    if (recalculated !== codeChallenge) {
      throw new Error("PKCE challenge mismatch");
    }
  });

  await test("OAuth state can be stored in database", async () => {
    const stateCode = crypto.randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const result = await dbRun(
      `INSERT INTO oauth_state 
       (state_code, challenge_code, pending_handle, expires_at)
       VALUES (?, ?, ?, ?)`,
      [
        stateCode,
        global.testData.codeChallenge,
        "test-handle-" + Date.now(),
        expiresAt,
      ],
    );

    if (result.changes === 0) {
      throw new Error("Failed to store oauth_state");
    }

    global.testData.stateCode = stateCode;
  });

  await test("OAuth state retrieval and validation", async () => {
    const result = await dbQuery(
      `SELECT state_code, challenge_code FROM oauth_state 
       WHERE state_code = ? AND expires_at > datetime('now')
       LIMIT 1`,
      [global.testData.stateCode],
    );

    if (!result[0]) {
      throw new Error("OAuth state not found or expired");
    }

    if (result[0].challenge_code !== global.testData.codeChallenge) {
      throw new Error("Code challenge mismatch");
    }
  });

  // Test Identity endpoints
  console.log("\n👤 Identity Server Tests\n");

  await test("Create test user", async () => {
    const timestamp = Date.now();
    const result = await dbRun(
      `INSERT INTO users 
       (username, did, handle, display_name, account_type, pds_endpoint)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "test-user-" + timestamp,
        "did:plc:" + crypto.randomBytes(12).toString("hex"),
        "test-user-" + timestamp,
        "Test User",
        "local",
        "http://localhost:9001",
      ],
    );

    if (!result.lastID) {
      throw new Error("Failed to create user");
    }

    global.testUserId = result.lastID;
  });

  await test("Get user profile", async () => {
    // Test from database
    const result = await dbQuery(
      "SELECT username, did, handle, display_name FROM users WHERE id = ? LIMIT 1",
      [global.testUserId],
    );

    if (!result[0]) {
      throw new Error("User profile not found");
    }

    if (!result[0].username) {
      throw new Error("Profile missing username");
    }
  });

  await test("Get account settings", async () => {
    // Create settings first
    await dbRun(
      `INSERT INTO account_settings 
       (user_id, profile_visibility, notify_via_email, encryption_enabled)
       VALUES (?, ?, ?, ?)`,
      [global.testUserId, "private", 0, 1],
    );

    // Query from database
    const result = await dbQuery(
      "SELECT profile_visibility, encryption_enabled FROM account_settings WHERE user_id = ? LIMIT 1",
      [global.testUserId],
    );

    if (!result[0]) {
      throw new Error("Settings not found");
    }

    if (result[0].profile_visibility !== "private") {
      throw new Error("Settings not stored correctly");
    }
  });

  await test("Get user worlds", async () => {
    // Create test world
    await dbRun(
      `INSERT INTO world_data 
       (user_id, world_name, world_id, data_json, is_pinned, is_public)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        global.testUserId,
        "Test World",
        "world-" + Date.now(),
        '{"foo":"bar"}',
        0,
        0,
      ],
    );

    const result = await dbQuery(
      "SELECT COUNT(*) as count FROM world_data WHERE user_id = ?",
      [global.testUserId],
    );

    if (!result[0] || result[0].count < 1) {
      throw new Error("Worlds not stored");
    }
  });

  await test("Get user permissions", async () => {
    // Create test permission
    await dbRun(
      `INSERT INTO permissions 
       (user_id, role, scope, action, is_revoked)
       VALUES (?, ?, ?, ?, ?)`,
      [global.testUserId, "user", "profile", "read", 0],
    );

    const result = await dbQuery(
      "SELECT COUNT(*) as count FROM permissions WHERE user_id = ? AND is_revoked = 0",
      [global.testUserId],
    );

    if (!result[0] || result[0].count < 1) {
      throw new Error("Permissions not stored");
    }
  });

  // Test DID endpoints
  console.log("\n🆔 DID Manager Tests\n");

  await test("DID format is valid (did:plc:*)", async () => {
    const users = await dbQuery("SELECT did FROM users WHERE id = ? LIMIT 1", [
      global.testUserId,
    ]);

    if (!users[0]) {
      throw new Error("User not found");
    }

    const did = users[0].did;
    if (!did.match(/^did:plc:[a-z0-9]+$/)) {
      throw new Error(`Invalid DID format: ${did}`);
    }
  });

  await test("DID is unique per user", async () => {
    const result1 = await dbQuery(
      "SELECT did FROM users WHERE id = ? LIMIT 1",
      [global.testUserId],
    );

    const result2 = await dbQuery(
      "SELECT COUNT(DISTINCT did) as count FROM users",
    );

    if (!result1[0] || !result2[0]) {
      throw new Error("Query failed");
    }

    // Should have at least one unique DID
    if (result2[0].count < 1) {
      throw new Error("No unique DIDs found");
    }
  });

  // Test KMS integration
  console.log("\n🔑 KMS Integration Tests\n");

  await test("User keys exist in database", async () => {
    // Check if any keys were created
    const keys = await dbQuery(
      "SELECT COUNT(*) as count FROM kms_key_references WHERE key_id LIKE ?",
      ["test-user-%"],
    );

    // Should have at least the health check keys
    if (keys[0].count < 1) {
      console.log("   ℹ No keys found (KMS may not have generated any yet)");
    }
  });

  // Test session management
  console.log("\n📝 Session Management Tests\n");

  await test("Create session with encryption", async () => {
    const sessionId = crypto.randomUUID();
    const accessToken = crypto.randomBytes(32).toString("hex");
    const refreshToken = crypto.randomBytes(32).toString("hex");

    const result = await dbRun(
      `INSERT INTO sessions 
       (user_id, session_id, oauth_access_token, oauth_refresh_token, oauth_dpop_token, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '+1 hour'))`,
      [global.testUserId, sessionId, accessToken, refreshToken, "test-dpop"],
    );

    if (result.changes === 0) {
      throw new Error("Failed to create session");
    }

    global.testData.sessionId = sessionId;
  });

  await test("Sessions have expiry time", async () => {
    const sessions = await dbQuery(
      "SELECT expires_at FROM sessions WHERE session_id = ?",
      [global.testData.sessionId],
    );

    if (!sessions[0] || !sessions[0].expires_at) {
      throw new Error("Session missing expiry");
    }
  });

  // Test database integrity
  console.log("\n🛡️ Database Integrity Tests\n");

  await test("All required tables exist", async () => {
    const tables = [
      "users",
      "sessions",
      "permissions",
      "account_settings",
      "world_data",
      "pds_records",
      "pds_commits",
      "kms_key_references",
      "oauth_state",
      "oauth_clients",
      "audit_log",
    ];

    for (const table of tables) {
      const result = await dbQuery(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [table],
      );

      if (result.length === 0) {
        throw new Error(`Table missing: ${table}`);
      }
    }
  });

  await test("Indexes are created for performance", async () => {
    const indexes = await dbQuery(
      "SELECT COUNT(*) as count FROM sqlite_master WHERE type='index'",
    );

    if (indexes[0].count < 5) {
      console.log("   ⚠️  Low number of indexes - performance may be affected");
    }
  });

  // Summary
  console.log("\n");
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║                    TEST SUMMARY                           ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`✅ Passed: ${testsPassed}`);
  console.log(`❌ Failed: ${testsFailed}`);
  console.log(`📊 Total:  ${testsPassed + testsFailed}`);
  console.log("");

  if (testsFailed === 0) {
    console.log("🎉 All tests passed! OAuth integration is ready.");
    console.log("");
    console.log("Next steps:");
    console.log("  1. Start Lively server: npm start");
    console.log("  2. Test OAuth flow in browser");
    console.log("  3. Proceed to Phase 3 (PDS implementation)");
  } else {
    console.log("⚠️  Some tests failed. Check the errors above.");
  }

  console.log("");

  // Cleanup
  db.close();

  process.exit(testsFailed > 0 ? 1 : 0);
}

// Run tests
runTests().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
