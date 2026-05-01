/**
 * Identity System Configuration
 *
 * Centralizes all environment variables and configuration for the identity system.
 * Provides sensible defaults and validation.
 */

const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

// Load .env.identity if it exists and variables aren't already set
function loadDotEnvIdentity() {
  const envFile = path.join(process.cwd(), ".env.identity");
  if (fs.existsSync(envFile) && !process.env.IDENTITY_DB) {
    try {
      const content = fs.readFileSync(envFile, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const [key, ...valueParts] = trimmed.split("=");
        const value = valueParts.join("=").trim();
        if (key && value && !process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch (err) {
      console.warn(
        "[IdentityConfig] Could not load .env.identity:",
        err.message,
      );
    }
  }
}

class IdentityConfig {
  constructor() {
    this.validated = false;
    loadDotEnvIdentity(); // Load environment before initializing
  }

  /**
   * Load and validate configuration from environment
   */
  load() {
    // Database
    this.identityDb =
      process.env.IDENTITY_DB ||
      path.join(process.cwd(), "objects-identity.sqlite");

    // KMS Configuration
    this.kmsProvider = process.env.KMS_PROVIDER || "env";
    this.kmsRegion = process.env.KMS_REGION || "us-east-1";
    this.kmsKeyAlias = process.env.KMS_KEY_ALIAS || "lively-keys";

    // OAuth Configuration
    this.oauthClientId =
      process.env.OAUTH_CLIENT_ID ||
      "http://localhost:9001/oauth-client-metadata.json";
    this.oauthRedirectUri =
      process.env.OAUTH_REDIRECT_URI || "http://localhost:9001/oauth/callback";
    this.livelyDomain = process.env.LIVELY_DOMAIN || "example.com";
    this.pdsEndpoint = process.env.PDS_ENDPOINT || "http://localhost:9001";

    // PDS Configuration
    this.pdsRoot = process.env.PDS_ROOT || path.join(process.cwd(), "pds");

    // Encryption Configuration
    this.masterKey = process.env.MASTER_KEY;
    if (!this.masterKey) {
      // Generate default master key if not provided
      this.masterKey = crypto.randomBytes(32).toString("base64");
      console.warn(
        "[IdentityConfig] ⚠️  MASTER_KEY not set. Generated random key.",
      );
      console.warn(
        '[IdentityConfig] ⚠️  For production, set: export MASTER_KEY="<base64-key>"',
      );
    }

    // Session Configuration
    this.sessionExpiryMs = parseInt(
      process.env.SESSION_EXPIRY_MS || "86400000",
    ); // 24 hours
    this.tokenExpiryMs = parseInt(process.env.TOKEN_EXPIRY_MS || "3600000"); // 1 hour
    this.refreshTokenExpiryMs = parseInt(
      process.env.REFRESH_TOKEN_EXPIRY_MS || "7776000000",
    ); // 90 days

    // Feature Flags
    this.enableOAuth = process.env.ENABLE_OAUTH !== "false";
    this.enablePDS = process.env.ENABLE_PDS !== "false";
    this.enableEncryption = process.env.ENABLE_ENCRYPTION !== "false";

    this.validated = true;
    return this;
  }

  /**
   * Get configuration as object
   */
  toObject() {
    return {
      // Database
      identityDb: this.identityDb,

      // KMS
      kms: {
        provider: this.kmsProvider,
        region: this.kmsRegion,
        keyAlias: this.kmsKeyAlias,
        masterKey: this.masterKey ? "***MASKED***" : undefined,
      },

      // OAuth
      oauth: {
        clientId: this.oauthClientId,
        redirectUri: this.oauthRedirectUri,
      },

      // Lively
      lively: {
        domain: this.livelyDomain,
        pdsEndpoint: this.pdsEndpoint,
        pdsRoot: this.pdsRoot,
      },

      // Session/Token
      session: {
        expiryMs: this.sessionExpiryMs,
        tokenExpiryMs: this.tokenExpiryMs,
        refreshTokenExpiryMs: this.refreshTokenExpiryMs,
      },

      // Features
      features: {
        oauth: this.enableOAuth,
        pds: this.enablePDS,
        encryption: this.enableEncryption,
      },
    };
  }

  /**
   * Print configuration summary
   */
  printSummary() {
    console.log("");
    console.log(
      "╔═══════════════════════════════════════════════════════════╗",
    );
    console.log(
      "║         Lively Kernel Identity System Configuration       ║",
    );
    console.log(
      "╚═══════════════════════════════════════════════════════════╝",
    );
    console.log("");
    console.log("🗄️  DATABASE");
    console.log(`   Path: ${this.identityDb}`);
    console.log("");
    console.log("🔐 KEY MANAGEMENT");
    console.log(`   Provider: ${this.kmsProvider}`);
    if (this.kmsProvider === "env") {
      console.log("   Mode: Environment-based (dev/test only)");
      console.log(`   Keys stored in: .lively-keys/ directory`);
    }
    console.log("");
    console.log("🔑 OAUTH");
    console.log(`   Client ID: ${this.oauthClientId}`);
    console.log(`   Redirect: ${this.oauthRedirectUri}`);
    console.log("");
    console.log("🌐 LIVELY");
    console.log(`   Domain: ${this.livelyDomain}`);
    console.log(`   PDS Endpoint: ${this.pdsEndpoint}`);
    console.log(`   PDS Root: ${this.pdsRoot}`);
    console.log("");
    console.log("⏱️  EXPIRY");
    console.log(`   Sessions: ${this.sessionExpiryMs / 1000 / 3600} hours`);
    console.log(`   Access Tokens: ${this.tokenExpiryMs / 1000 / 60} minutes`);
    console.log(
      `   Refresh Tokens: ${this.refreshTokenExpiryMs / 1000 / 3600 / 24} days`,
    );
    console.log("");
    console.log("✨ FEATURES");
    console.log(`   OAuth: ${this.enableOAuth ? "✓" : "✗"}`);
    console.log(`   PDS: ${this.enablePDS ? "✓" : "✗"}`);
    console.log(`   Encryption: ${this.enableEncryption ? "✓" : "✗"}`);
    console.log("");
  }

  /**
   * Validate that master key is strong enough
   */
  validateMasterKey() {
    if (!this.masterKey) {
      throw new Error("MASTER_KEY is required");
    }

    try {
      const buffer = Buffer.from(this.masterKey, "base64");
      if (buffer.length < 32) {
        throw new Error(
          "MASTER_KEY must be at least 32 bytes (256 bits) when base64-decoded",
        );
      }
    } catch (err) {
      throw new Error(`Invalid MASTER_KEY: ${err.message}`);
    }
  }

  /**
   * Generate a new master key
   */
  static generateMasterKey() {
    return crypto.randomBytes(32).toString("base64");
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create config instance
 */
function getConfig() {
  if (!instance) {
    instance = new IdentityConfig();
    instance.load();
  }
  return instance;
}

module.exports = {
  IdentityConfig,
  getConfig,
  generateMasterKey: IdentityConfig.generateMasterKey,
};
