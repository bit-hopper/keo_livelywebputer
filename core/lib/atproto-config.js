/**
 * AT Protocol Configuration Management
 * 
 * Centralized configuration for AT Protocol integration
 * Handles environment variables, PDS endpoints, and constants
 */

const path = require('path');

// Configuration singleton
let config = null;

function getConfig() {
  if (config) return config;

  config = {
    // PDS Configuration
    pds: {
      // Lively's own PDS (for account creation)
      url: process.env.LIVELY_PDS_URL || 'http://localhost:2583',
      adminPassword: process.env.LIVELY_PDS_ADMIN_PASSWORD || 'admin-password',
    },

    // OAuth Configuration
    oauth: {
      clientId: process.env.ATPROTO_CLIENT_ID || 'lively-kernel',
      clientSecret: process.env.ATPROTO_CLIENT_SECRET || undefined,
      redirectUri: process.env.ATPROTO_REDIRECT_URI || 'http://localhost:9001/auth/callback',
      scopes: ['atproto', 'transition:generic'],
    },

    // Server Configuration
    server: {
      host: process.env.LIVELY_HOST || 'localhost',
      port: parseInt(process.env.LIVELY_PORT || '9001', 10),
      baseUrl: process.env.LIVELY_BASE_URL || 'http://localhost:9001',
    },

    // Session Configuration
    session: {
      duration: 180 * 24 * 60 * 60 * 1000, // 180 days in milliseconds
      refreshThreshold: 7 * 24 * 60 * 60 * 1000, // 7 days
      jwtSecret: process.env.JWT_SECRET || 'development-secret-key',
    },

    // Database Configuration
    database: {
      path: path.join(__dirname, '../../objects-identity.sqlite'),
      enableWAL: true,
      busyTimeout: 5000,
    },

    // World Storage Configuration
    worlds: {
      recordType: 'app.lively.world',
      collectionPrefix: 'app.lively.worlds',
    },

    // Environment
    environment: process.env.NODE_ENV || 'development',
    isDevelopment: (process.env.NODE_ENV || 'development') === 'development',
    isProduction: process.env.NODE_ENV === 'production',

    // Logging
    logging: {
      level: process.env.LOG_LEVEL || 'info',
      requests: process.env.LOG_REQUESTS === 'true',
    },
  };

  return config;
}

/**
 * Validate configuration
 * Ensure all required settings are present
 */
function validateConfig() {
  const cfg = getConfig();

  const required = [
    ['server.baseUrl', cfg.server.baseUrl],
    ['session.jwtSecret', cfg.session.jwtSecret],
    ['database.path', cfg.database.path],
  ];

  const missing = required.filter(([name, value]) => !value);

  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration: ${missing.map(([name]) => name).join(', ')}`
    );
  }

  return true;
}

/**
 * Get DID method (did:plc or did:web)
 * For Lively, we use did:plc with SHA256 hash
 */
function generateDID(handle) {
  const crypto = require('crypto');
  const input = `${getConfig().server.host}:${handle}`;
  const hash = crypto.createHash('sha256').update(input).digest();
  const base32 = base32Encode(hash).substring(0, 24).toLowerCase();
  return `did:plc:${base32}`;
}

/**
 * Base32 encoding helper
 */
function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(value >> bits) & 31];
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }

  return output;
}

module.exports = {
  getConfig,
  validateConfig,
  generateDID,
  base32Encode,
};
