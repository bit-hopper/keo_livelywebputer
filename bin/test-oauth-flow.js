#!/usr/bin/env node
/**
 * Complete OAuth 2.1 PKCE Flow Test
 * Tests: authorize -> token exchange -> userinfo
 */

const crypto = require("crypto");
const http = require("http");
const querystring = require("querystring");

const BASE_URL = "http://localhost:9002";

// Generate PKCE challenge/verifier pair
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("hex");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return { verifier, challenge };
}

// Make HTTP request
function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
      },
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve({
            status: res.statusCode,
            body: parsed,
            headers: res.headers,
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            body,
            headers: res.headers,
          });
        }
      });
    });

    req.on("error", reject);

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function runTest() {
  console.log("🔐 OAuth 2.1 PKCE Flow Test\n");

  try {
    // Step 1: Generate PKCE pair
    console.log("Step 1: Generate PKCE Challenge/Verifier");
    const pkce = generatePKCE();
    console.log("  ✓ Verifier:", pkce.verifier.substring(0, 20) + "...");
    console.log("  ✓ Challenge:", pkce.challenge.substring(0, 20) + "...\n");

    // Step 2: Request authorization code
    console.log("Step 2: Request Authorization Code");
    const authPath = `/api/auth/oauth/authorize?client_id=test-client&redirect_uri=http://localhost:3000/callback&code_challenge=${pkce.challenge}&scope=openid%20profile`;
    const authResponse = await makeRequest("GET", authPath);
    console.log("  Status:", authResponse.status);

    // Extract authorization code from redirect
    let authCode = null;
    if (authResponse.headers.location) {
      const match = authResponse.headers.location.match(
        /authorization_code=([^&]+)/,
      );
      authCode = match ? match[1] : null;
      console.log(
        "  ✓ Authorization Code:",
        authCode ? authCode.substring(0, 20) + "..." : "NOT FOUND",
      );
    } else if (typeof authResponse.body === "string") {
      const match = authResponse.body.match(/authorization_code=([^&]+)/);
      authCode = match ? decodeURIComponent(match[1]) : null;
      console.log(
        "  ✓ Authorization Code:",
        authCode ? authCode.substring(0, 20) + "..." : "NOT FOUND",
      );
    }

    if (!authCode) {
      console.log("  ✗ Failed to get authorization code");
      console.log("  Response:", authResponse);
      return;
    }
    console.log();

    // Step 3: Exchange code for tokens
    console.log("Step 3: Exchange Authorization Code for Tokens");
    const tokenData = {
      grant_type: "authorization_code",
      code: authCode,
      code_verifier: pkce.verifier,
      client_id: "test-client",
    };
    const tokenResponse = await makeRequest(
      "POST",
      "/api/auth/oauth/token",
      tokenData,
    );
    console.log("  Status:", tokenResponse.status);

    if (tokenResponse.body.error) {
      console.log("  ✗ Error:", tokenResponse.body.error_description);
      return;
    }

    const accessToken = tokenResponse.body.access_token;
    console.log(
      "  ✓ Access Token:",
      accessToken ? accessToken.substring(0, 20) + "..." : "NOT FOUND",
    );
    console.log("  ✓ Token Type:", tokenResponse.body.token_type);
    console.log("  ✓ Expires In:", tokenResponse.body.expires_in);
    console.log();

    // Step 4: Get user info
    console.log("Step 4: Request User Info");
    const userinfoPath = `/api/auth/oauth/userinfo?access_token=${accessToken}`;
    const userResponse = await makeRequest("GET", userinfoPath);
    console.log("  Status:", userResponse.status);
    console.log("  User Info:", JSON.stringify(userResponse.body, null, 2));
    console.log();

    console.log("✅ OAuth 2.1 PKCE Flow Test Complete!");
  } catch (error) {
    console.error("❌ Test Error:", error.message);
    process.exit(1);
  }
}

// Wait for server to be ready
setTimeout(runTest, 1000);
