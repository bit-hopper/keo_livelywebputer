#!/usr/bin/env node
/**
 * Lively Kernel Identity System Setup Guide
 *
 * This script initializes the identity system with:
 * - SQLite database schema
 * - Environment-based KMS configuration
 * - Directory structure
 *
 * Usage:
 *   node bin/setup-identity.js
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

console.log("");
console.log("╔═══════════════════════════════════════════════════════════╗");
console.log("║   Lively Kernel Identity System - Interactive Setup       ║");
console.log("╚═══════════════════════════════════════════════════════════╝");
console.log("");

// Step 1: Check dependencies
console.log("📋 Step 1: Checking dependencies...");
const deps = ["sqlite3", "tweetnacl"];
const missing = [];

for (const dep of deps) {
  try {
    require.resolve(dep);
    console.log(`   ✓ ${dep}`);
  } catch {
    missing.push(dep);
    console.log(`   ✗ ${dep} (missing)`);
  }
}

if (missing.length > 0) {
  console.log("");
  console.log("⚠️  Install missing dependencies:");
  console.log(`   npm install ${missing.join(" ")}`);
  console.log("");
  process.exit(1);
}

console.log("");
console.log("✅ All dependencies installed");

// Step 2: Create directory structure
console.log("");
console.log("📋 Step 2: Creating directory structure...");

const dirs = ["./pds", "./pds/users", "./.lively-keys", "./logs"];

for (const dir of dirs) {
  const fullPath = path.resolve(dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true, mode: 0o755 });
    console.log(`   ✓ Created: ${dir}`);
  } else {
    console.log(`   ℹ Exists: ${dir}`);
  }
}

// Step 3: Generate MASTER_KEY
console.log("");
console.log("📋 Step 3: Generating encryption master key...");

const masterKey = crypto.randomBytes(32).toString("base64");
console.log("");
console.log("🔐 New Master Key (store in .env or environment):");
console.log("");
console.log(`   export MASTER_KEY="${masterKey}"`);
console.log("");

// Step 4: Create .env file template
console.log("📋 Step 4: Creating environment configuration...");

const envTemplate = `# Lively Kernel Identity System Configuration
# Generated: ${new Date().toISOString()}

# Database
IDENTITY_DB=./objects-identity.sqlite

# Key Management (env = environment-based, dev/test only)
KMS_PROVIDER=env
KMS_REGION=us-east-1
KMS_KEY_ALIAS=lively-keys
MASTER_KEY=${masterKey}

# OAuth Configuration
OAUTH_CLIENT_ID=http://localhost:9001/oauth-client-metadata.json
OAUTH_REDIRECT_URI=http://localhost:9001/oauth/callback
LIVELY_DOMAIN=example.com

# PDS Configuration
PDS_ENDPOINT=http://localhost:9001
PDS_ROOT=./pds

# Session/Token Expiry (milliseconds)
SESSION_EXPIRY_MS=86400000        # 24 hours
TOKEN_EXPIRY_MS=3600000           # 1 hour
REFRESH_TOKEN_EXPIRY_MS=7776000000  # 90 days

# Features
ENABLE_OAUTH=true
ENABLE_PDS=true
ENABLE_ENCRYPTION=true

# Logging
LOG_LEVEL=info
`;

const envPath = path.resolve(".env.identity");
if (!fs.existsSync(envPath)) {
  fs.writeFileSync(envPath, envTemplate, { mode: 0o600 });
  console.log(`   ✓ Created: .env.identity`);
  console.log("");
  console.log("   To use this configuration:");
  console.log("   source .env.identity");
  console.log("   # or in package.json scripts");
  console.log("   dotenv -e .env.identity npm start");
} else {
  console.log(`   ℹ Exists: .env.identity`);
}

// Step 5: Initialize database
console.log("");
console.log("📋 Step 5: Initializing database schema...");
console.log("");
console.log("   To initialize the database, run:");
console.log("   node bin/init-identity-db.js");
console.log("");

// Step 6: Print next steps
console.log("");
console.log("╔═══════════════════════════════════════════════════════════╗");
console.log("║                      SETUP COMPLETE                       ║");
console.log("╚═══════════════════════════════════════════════════════════╝");
console.log("");
console.log("Next Steps:");
console.log("");
console.log("1. Load environment configuration:");
console.log("   source .env.identity");
console.log("");
console.log("2. Initialize database:");
console.log("   node bin/init-identity-db.js");
console.log("");
console.log("3. Verify KMS health:");
console.log("   node bin/test-kms.js");
console.log("");
console.log("4. Start Lively Kernel:");
console.log("   npm start");
console.log("");
console.log("Security Reminders:");
console.log("   • .lively-keys/ directory should be protected (mode 0o700)");
console.log("   • MASTER_KEY should be stored in secure KMS for production");
console.log("   • Use AWS KMS or HashiCorp Vault instead of env vars in prod");
console.log("   • Never commit .env files to git");
console.log("");
