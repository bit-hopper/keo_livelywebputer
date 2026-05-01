#!/usr/bin/env node
/**
 * Standalone OAuth Server Test
 *
 * Tests the OAuth, Identity, and DID servers outside of life_star
 * to verify they work correctly
 *
 * Usage: node bin/test-oauth-server.js
 * Server will run on: http://localhost:9002
 */

const express = require("express");
const path = require("path");

// Load identity environment
require("../lib/identity-config");

// Create Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log all requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ready",
    message: "Lively Kernel OAuth Test Server",
    version: "1.0.0",
  });
});

// Register OAuth servers
try {
  console.log("\n📋 Registering Identity Servers...\n");

  // OAuth Server
  try {
    const OAuthServer = require("../core/servers/oauth/OAuthServer");
    OAuthServer("/api/auth/", app);
    console.log("✅ OAuth Server registered at /api/auth/");
  } catch (err) {
    console.error("❌ OAuth Server failed:", err.message);
  }

  // Identity Server
  try {
    const IdentityServer = require("../core/servers/oauth/IdentityServer");
    IdentityServer("/api/", app);
    console.log("✅ Identity Server registered at /api/");
  } catch (err) {
    console.error("❌ Identity Server failed:", err.message);
  }

  // DID Manager
  try {
    const DIDManager = require("../core/servers/oauth/DIDManager");
    DIDManager("/api/", app);
    console.log("✅ DID Manager registered at /.well-known/");
  } catch (err) {
    console.error("❌ DID Manager failed:", err.message);
  }

  console.log("\n");
} catch (err) {
  console.error("Failed to register servers:", err);
}

// Error handler
app.use((err, req, res, next) => {
  console.error("Request error:", err);
  res.status(500).json({
    error: "server_error",
    message: err.message,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "not_found",
    message: `Route not found: ${req.method} ${req.path}`,
  });
});

// Start server
const PORT = process.env.PORT || 9002;
app.listen(PORT, "localhost", () => {
  console.log(`\n🚀 OAuth Test Server running at http://localhost:${PORT}`);
  console.log("\n📝 Test endpoints:\n");
  console.log("  GET  /api/auth/oauth/authorize");
  console.log("  POST /api/auth/oauth/token");
  console.log("  GET  /api/identity/profile/:id");
  console.log("  GET  /.well-known/did.json");
  console.log("  POST /api/dids");
  console.log("\n");
});
