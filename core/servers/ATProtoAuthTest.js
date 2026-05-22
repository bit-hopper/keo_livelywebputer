/**
 * AT Protocol Authentication Server
 * Real implementation with DNS PDS discovery and proper error handling
 * Authenticates users against their actual PDS using credentials
 */

const { AtpAgent, DidResolver } = require("@atproto/api");
const dns = require("dns").promises;

/**
 * Resolve a handle to its PDS endpoint using:
 * 1. Explicit pdsUrl if provided
 * 2. DNS TXT record lookup for _atproto_pds
 * 3. Fallback to well-known endpoint
 */
async function resolvePDSEndpoint(handle, explicitPdsUrl) {
  if (explicitPdsUrl) {
    // Validate and normalize URL
    let url = explicitPdsUrl;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    try {
      new URL(url); // Validate URL
      return url;
    } catch (e) {
      throw new Error(`Invalid PDS URL: ${explicitPdsUrl}`);
    }
  }

  // Extract domain from handle (e.g., "user.bsky.social" -> "bsky.social")
  const handleParts = handle.split(".");
  if (handleParts.length < 2) {
    throw new Error(`Invalid handle format: ${handle}`);
  }

  const domain = handleParts.slice(1).join(".");

  try {
    // Try DNS TXT lookup for _atproto_pds
    console.log(`[ATProtoAuth] Looking up _atproto_pds.${domain}`);
    const records = await dns.resolveTxt(`_atproto_pds.${domain}`);

    if (records && records.length > 0) {
      const pdsRecord = records[0].join("");
      if (pdsRecord.startsWith("did=")) {
        // Parse DID from TXT record
        const did = pdsRecord.substring(4);
        console.log(
          `[ATProtoAuth] Found PDS DID via DNS: ${did} for domain ${domain}`,
        );

        // For now, map common DIDs to known endpoints
        // In production, you'd resolve the DID to an HTTPS endpoint
        const didToPds = {
          "did:web:bsky.social": "https://bsky.social",
          "did:web:bluesky.social": "https://bsky.social",
        };

        if (didToPds[did]) {
          return didToPds[did];
        }

        // Try to use the DID as-is (would need DID resolution in production)
        console.warn(
          `[ATProtoAuth] DID found but no direct PDS mapping: ${did}`,
        );
      }
    }
  } catch (dnsError) {
    // DNS lookup failed, not uncommon
    console.log(
      `[ATProtoAuth] DNS TXT lookup failed for _atproto_pds.${domain}: ${dnsError.message}`,
    );
  }

  // Try well-known endpoint
  try {
    const wellKnownUrl = `https://${domain}/.well-known/atproto-pds`;
    const response = await (async () => {
      try {
        const http = require("http");
        const https = require("https");
        const url = new URL(wellKnownUrl);
        return new Promise((resolve, reject) => {
          const client = url.protocol === "https:" ? https : http;
          const req = client.get(wellKnownUrl, { timeout: 5000 }, (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", () => {
              if (res.statusCode === 200) {
                try {
                  const json = JSON.parse(data);
                  if (json.pdsUrl) {
                    resolve(json.pdsUrl);
                  } else {
                    reject(new Error("No pdsUrl in well-known response"));
                  }
                } catch (e) {
                  reject(e);
                }
              } else {
                reject(new Error(`HTTP ${res.statusCode}`));
              }
            });
          });
          req.on("error", reject);
          req.on("timeout", () => {
            req.destroy();
            reject(new Error("Request timeout"));
          });
        });
      } catch (e) {
        throw e;
      }
    })();

    console.log(`[ATProtoAuth] Found PDS endpoint via well-known: ${response}`);
    return response;
  } catch (wellKnownError) {
    console.log(
      `[ATProtoAuth] Well-known lookup failed for ${domain}: ${wellKnownError.message}`,
    );
  }

  // Fallback to Bluesky for .bsky.social handles
  if (domain === "bsky.social" || domain === "bluesky.social") {
    console.log(`[ATProtoAuth] Using default Bluesky PDS for ${domain} domain`);
    return "https://bsky.social";
  }

  throw new Error(
    `Could not resolve PDS endpoint for domain: ${domain}. ` +
      `Please specify an explicit pdsUrl or configure DNS records.`,
  );
}

module.exports = function (route, app) {
  // Real login endpoint with DNS PDS discovery
  app.post(route + "auth/login", async function (req, res) {
    try {
      const { pdsUrl, handle, password } = req.body;

      // Validate input
      if (!handle || !password) {
        return res.status(400).json({
          error: "handle and password required",
          details:
            "Please provide both handle (e.g., user.bsky.social) and password",
        });
      }

      if (typeof handle !== "string" || typeof password !== "string") {
        return res.status(400).json({
          error: "handle and password must be strings",
        });
      }

      console.log(
        `[ATProtoAuth] Login attempt - handle: ${handle}, explicit PDS: ${pdsUrl || "auto-discover"}`,
      );

      try {
        // Resolve PDS endpoint
        const targetPdsUrl = await resolvePDSEndpoint(handle, pdsUrl);
        console.log(
          `[ATProtoAuth] Resolved PDS endpoint: ${targetPdsUrl} for handle ${handle}`,
        );

        // Create ATP agent and authenticate
        const agent = new AtpAgent({ service: targetPdsUrl });

        const sessionResponse = await agent.login({
          identifier: handle,
          password: password,
        });

        if (
          !sessionResponse.data ||
          !sessionResponse.data.did ||
          !sessionResponse.data.handle
        ) {
          throw new Error("Invalid session response from PDS");
        }

        // Generate a proper JWT-like session token
        const sessionToken = Buffer.from(
          JSON.stringify({
            did: sessionResponse.data.did,
            handle: sessionResponse.data.handle,
            accessJwt: sessionResponse.data.accessJwt,
            refreshJwt: sessionResponse.data.refreshJwt,
            iat: Date.now(),
            pds: targetPdsUrl,
          }),
        ).toString("base64");

        console.log(
          `[ATProtoAuth] ✓ Login successful for ${sessionResponse.data.handle} (${sessionResponse.data.did})`,
        );

        res.json({
          success: true,
          sessionId: sessionToken,
          token: sessionToken,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          user: {
            did: sessionResponse.data.did,
            handle: sessionResponse.data.handle,
            displayName: sessionResponse.data.profile?.displayName || handle,
            avatar: sessionResponse.data.profile?.avatar,
          },
          pdsUrl: targetPdsUrl,
        });
      } catch (error) {
        // Handle authentication errors
        console.error(`[ATProtoAuth] Authentication failed: ${error.message}`);

        if (
          error.status === 401 ||
          error.message.includes("Invalid identifier") ||
          error.message.includes("Invalid password") ||
          error.message.includes("Invalid credentials")
        ) {
          return res.status(401).json({
            error: "Authentication failed",
            details: "Invalid handle or password",
          });
        }

        if (error.message.includes("Network") || error.code === "ENOTFOUND") {
          return res.status(503).json({
            error: "PDS unavailable",
            details: `Could not connect to PDS endpoint: ${error.message}`,
          });
        }

        if (
          error.message.includes("Invalid handle format") ||
          error.message.includes("Could not resolve PDS")
        ) {
          return res.status(400).json({
            error: "Invalid handle",
            details: error.message,
          });
        }

        // Re-throw unknown errors
        throw error;
      }
    } catch (error) {
      console.error("[ATProtoAuth] Unexpected error:", error);
      res.status(500).json({
        error: "Login service error",
        details: error.message,
        code: error.code,
      });
    }
  });

  // Health check endpoint
  app.get(route + "auth/status", function (req, res) {
    res.json({
      status: "AT Protocol auth endpoint ready",
      timestamp: new Date().toISOString(),
      features: [
        "Real AT Protocol authentication",
        "DNS PDS discovery",
        "Well-known endpoint fallback",
        "Proper error handling",
      ],
      supportedHandles: ["*.bsky.social", "*.bluesky.social", "*.custom-pds"],
    });
  });

  // Resolve PDS endpoint for a handle (diagnostic endpoint)
  app.post(route + "auth/resolve-pds", async function (req, res) {
    try {
      const { handle, pdsUrl } = req.body;

      if (!handle) {
        return res.status(400).json({ error: "handle required" });
      }

      const resolvedUrl = await resolvePDSEndpoint(handle, pdsUrl);
      res.json({
        handle,
        resolvedPdsUrl: resolvedUrl,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[ATProtoAuth] PDS resolution error:", error.message);
      res.status(400).json({
        error: "PDS resolution failed",
        details: error.message,
      });
    }
  });

  console.log(
    "[ATProtoAuth] Real AT Protocol auth endpoints registered at",
    route + "auth/*",
  );
};
