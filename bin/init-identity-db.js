#!/usr/bin/env node
/**
 * Initialize Identity Database Schema
 *
 * Usage:
 *   node bin/init-identity-db.js
 *   node bin/init-identity-db.js --db path/to/objects-identity.sqlite
 *
 * Creates all tables for Lively Kernel identity system:
 * - users, sessions, permissions, account_settings, world_data
 * - pds_records, pds_commits, kms_key_references
 * - oauth_state, oauth_clients, audit_log
 */

const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");

// Configuration
const DB_PATH =
  process.env.IDENTITY_DB ||
  path.join(__dirname, "..", "objects-identity.sqlite");
const SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "core",
  "servers",
  "schema-identity.sql",
);

console.log("🔧 Lively Kernel Identity Database Initialization");
console.log(`📁 Database: ${DB_PATH}`);
console.log(`📄 Schema: ${SCHEMA_PATH}`);
console.log("");

// Read schema file
if (!fs.existsSync(SCHEMA_PATH)) {
  console.error(`❌ Schema file not found: ${SCHEMA_PATH}`);
  process.exit(1);
}

const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");

// Open/create database
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("❌ Error opening database:", err.message);
    process.exit(1);
  }
  console.log("✅ Database connected");
});

// Execute schema
db.exec(schema, (err) => {
  if (err) {
    console.error("❌ Error executing schema:", err.message);
    db.close();
    process.exit(1);
  }

  console.log("✅ Schema applied successfully");
  console.log("");
  console.log("📊 Verifying tables...");

  // Verify all tables were created
  db.all(`SELECT name FROM sqlite_master WHERE type='table'`, (err, tables) => {
    if (err) {
      console.error("❌ Error verifying tables:", err.message);
      db.close();
      process.exit(1);
    }

    const tableNames = tables.map((t) => t.name);
    const requiredTables = [
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

    const missing = requiredTables.filter((t) => !tableNames.includes(t));

    if (missing.length > 0) {
      console.error(`❌ Missing tables: ${missing.join(", ")}`);
      db.close();
      process.exit(1);
    }

    console.log(`✅ All ${requiredTables.length} tables created:`);
    requiredTables.forEach((t) => {
      console.log(`   - ${t}`);
    });

    console.log("");
    console.log("🎉 Database initialization complete!");
    console.log("");
    console.log("Next steps:");
    console.log("  1. Set environment variables:");
    console.log(`     export IDENTITY_DB="${DB_PATH}"`);
    console.log('     export KMS_PROVIDER="env"');
    console.log('     export MASTER_KEY="<your-base64-aes256-key>"');
    console.log("");
    console.log("  2. Start Lively server:");
    console.log("     npm start");
    console.log("");

    db.close((closeErr) => {
      if (closeErr) {
        console.error("Error closing database:", closeErr.message);
        process.exit(1);
      }
      process.exit(0);
    });
  });
});

// Handle signals
process.on("SIGINT", () => {
  console.log("\n⚠️  Interrupted");
  db.close();
  process.exit(0);
});
