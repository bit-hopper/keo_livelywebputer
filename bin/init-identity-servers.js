#!/usr/bin/env node
/**
 * Initialize OAuth Integration
 *
 * This file shows how to register the OAuth, Identity, and DID servers
 * in your main Lively Kernel server (bin/lk-server.js)
 *
 * Copy this code into your server initialization:
 */

const path = require("path");

/**
 * Register identity servers with Express app
 * Call this after Express app is created and before .listen()
 *
 * Usage in bin/lk-server.js:
 *   const initializeIdentity = require('./bin/init-identity-servers');
 *   const app = require('express')();
 *
 *   // ... existing server setup ...
 *
 *   // Initialize identity system
 *   initializeIdentity(app);
 *
 *   app.listen(9001);
 */
module.exports = function initializeIdentityServers(app) {
  // Ensure environment is loaded
  require("../lib/identity-config").getConfig().printSummary();

  // Register OAuth Server (handles authorization and tokens)
  try {
    const OAuthServer = require("../core/servers/OAuthServer");
    OAuthServer("/api/auth/", app);
    console.log("✅ OAuth Server registered at /api/auth/");
  } catch (err) {
    console.warn("⚠️  OAuth Server registration failed:", err.message);
  }

  // Register Identity Server (handles profiles, settings, worlds)
  try {
    const IdentityServer = require("../core/servers/IdentityServer");
    IdentityServer("/api/", app);
    console.log("✅ Identity Server registered at /api/");
  } catch (err) {
    console.warn("⚠️  Identity Server registration failed:", err.message);
  }

  // Register DID Manager (handles DID resolution)
  try {
    const DIDManager = require("../core/servers/DIDManager");
    DIDManager("/api/", app);
    console.log("✅ DID Manager registered at /.well-known/");
  } catch (err) {
    console.warn("⚠️  DID Manager registration failed:", err.message);
  }

  return app;
};

/**
 * If run directly, create a test Express server
 */
if (require.main === module) {
  const express = require("express");
  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Mock session for testing
  app.use((req, res, next) => {
    req.livelySession = {
      userId: req.query.userId || 1,
      username: req.query.username || "test-user",
    };
    next();
  });

  // Initialize identity servers
  const init = module.exports;
  init(app);

  // Health check
  app.get("/", (req, res) => {
    res.json({
      status: "ready",
      message: "Lively Kernel Identity System",
      endpoints: {
        oauth:
          "/api/auth/oauth/authorize, /api/auth/oauth/token, /api/auth/oauth/userinfo",
        identity:
          "/api/identity/profile, /api/identity/settings, /api/identity/worlds, /api/identity/permissions",
        did: "/.well-known/did.json, /api/dids/:did",
      },
    });
  });

  // Start server
  const PORT = process.env.PORT || 9001;
  app.listen(PORT, () => {
    console.log(`\n🚀 Lively Kernel Identity Server started on port ${PORT}`);
    console.log(`   http://localhost:${PORT}/\n`);
  });
}
