# OAuth Integration for Lively Kernel - Phase 2 Implementation

## Overview

This document describes the OAuth 2.1 integration with AT Protocol support for Lively Kernel. The implementation includes:

1. **OAuthServer.js** - OAuth 2.1 endpoints with PKCE support
2. **IdentityServer.js** - User profile, settings, and world management
3. **DIDManager.js** - DID generation and resolution
4. **KMSClient.js** - Key management (from Phase 1)

## Architecture Layers

```
┌─────────────────────────────────────────────┐
│         Client Applications                 │
│    (Desktop Lively, Browser, Mobile)        │
└────────────────┬────────────────────────────┘
                 │
                 │ OAuth 2.1 + PKCE
                 ▼
┌─────────────────────────────────────────────┐
│      OAuth Authorization Server             │
│  - /oauth/authorize (PKCE code flow)        │
│  - /oauth/token (exchange code)             │
│  - /oauth/callback (redirect handler)       │
└────────────┬────────────────────────────────┘
             │
             │ Authorization codes + Tokens
             ▼
┌─────────────────────────────────────────────┐
│      Identity Service Layer                 │
│  - /identity/profile (read/write)           │
│  - /identity/settings (preferences)         │
│  - /identity/worlds (morphic envs)          │
│  - /identity/permissions (RBAC)             │
└────────────┬────────────────────────────────┘
             │
             │ DID & User lookups
             ▼
┌─────────────────────────────────────────────┐
│   DID Manager + KMS                         │
│  - DID generation (did:plc)                 │
│  - DID resolution (.well-known/did.json)    │
│  - Key management (signing, encryption)     │
└────────────┬────────────────────────────────┘
             │
             │ Encrypted data + Keys
             ▼
┌─────────────────────────────────────────────┐
│      SQLite Identity Database               │
│  - users, sessions, permissions             │
│  - account_settings, world_data             │
│  - pds_records, kms_key_references          │
└─────────────────────────────────────────────┘
```

## OAuth 2.1 Authorization Code Flow (PKCE)

### Step 1: Client Requests Authorization

```http
GET /oauth/authorize?
  client_id=https://example.com/oauth-client-metadata.json&
  redirect_uri=https://app.example.com/callback&
  response_type=code&
  scope=openid+profile+email&
  code_challenge=E9Mrozoa2owUednwPqpeVegQE5ZHxo2W76sPiMj1xfM&
  code_challenge_method=S256
```

**Parameters:**

- `client_id`: OAuth client identifier (typically a URL to metadata)
- `redirect_uri`: Where to send the authorization code
- `scope`: Requested permissions (OIDC standard: openid, profile, email)
- `code_challenge`: SHA256(code_verifier) in base64url
- `code_challenge_method`: S256 (SHA256) - only supported method

### Step 2: OAuthServer Generates Code

```javascript
// OAuthServer.generateAuthCode()
const code = crypto.randomBytes(32).toString("hex");
// Store in oauth_state table with 10-minute expiry
// Return code to client
```

**Database record:**

```sql
INSERT INTO oauth_state (state_code, code_challenge, client_id, redirect_uri, scope, expires_at)
VALUES ('...', 'E9Mrozoa2owUednwPqpeVegQE5ZHxo2W76sPiMj1xfM', '...', '...', 'openid profile', now+10min);
```

### Step 3: Client Exchanges Code for Tokens

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=<state_code_from_step_2>&
code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXo&
client_id=https://example.com/oauth-client-metadata.json
```

**Parameters:**

- `grant_type`: authorization_code
- `code`: Authorization code from step 2
- `code_verifier`: Original code (before hashing) used to generate code_challenge
- `client_id`: Same as authorization request

### Step 4: OAuthServer Validates PKCE and Returns Tokens

```javascript
// OAuthServer.exchangeCodeForToken()
1. Lookup oauth_state record by code + client_id
2. Validate not expired
3. Validate PKCE: SHA256(code_verifier) == code_challenge
4. Generate tokens:
   - access_token: 32-byte random hex
   - refresh_token: 32-byte random hex
   - dpop_token: DPoP proof token
5. Create encrypted session in database
6. Return tokens to client
```

**Response:**

```json
{
  "access_token": "abc123def456...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "xyz789...",
  "dpop_token": "eyJhbGc...",
  "scope": "openid profile email"
}
```

**Database storage:**

```sql
INSERT INTO sessions
(user_id, oauth_access_token, oauth_refresh_token, oauth_dpop_token, expires_at)
VALUES
  (123, ENCRYPT(access_token), ENCRYPT(refresh_token), dpop_token, now+1hour);
```

## Integration Points

### 1. Register OAuth Server in bin/lk-server.js

```javascript
// In Express app setup
const oauthServer = require("../core/servers/OAuthServer");
oauthServer("/api/auth/", app); // Routes: /api/auth/oauth/authorize, etc.
```

### 2. Register Identity Server

```javascript
const identityServer = require("../core/servers/IdentityServer");
identityServer("/api/", app); // Routes: /api/identity/profile, etc.
```

### 3. Register DID Manager

```javascript
const didManager = require("../core/servers/DIDManager");
didManager("/api/", app); // Routes: /api/dids/:did, /.well-known/did.json
```

## API Endpoints

### OAuth Endpoints

| Method | Endpoint           | Description              |
| ------ | ------------------ | ------------------------ |
| GET    | `/oauth/authorize` | Start PKCE flow          |
| POST   | `/oauth/token`     | Exchange code for tokens |
| POST   | `/oauth/callback`  | Handle OAuth callback    |
| GET    | `/oauth/userinfo`  | Get current user info    |

### Identity Endpoints

| Method | Endpoint                    | Auth   | Description          |
| ------ | --------------------------- | ------ | -------------------- |
| GET    | `/identity/profile/:userId` | None   | Get public profile   |
| PUT    | `/identity/profile`         | Bearer | Update own profile   |
| GET    | `/identity/settings`        | Bearer | Get account settings |
| PUT    | `/identity/settings`        | Bearer | Update settings      |
| GET    | `/identity/worlds`          | Bearer | List user's worlds   |
| POST   | `/identity/worlds`          | Bearer | Save world data      |
| DELETE | `/identity/worlds/:worldId` | Bearer | Delete world         |
| GET    | `/identity/permissions`     | Bearer | List permissions     |
| GET    | `/identity/audit-log`       | Bearer | Get audit log        |

### DID Endpoints

| Method | Endpoint                | Description         |
| ------ | ----------------------- | ------------------- |
| GET    | `/.well-known/did.json` | Server DID document |
| GET    | `/dids/:did`            | Resolve user DID    |

### OAuth Metadata

| Endpoint                                  | Response                  |
| ----------------------------------------- | ------------------------- |
| `/.well-known/oauth-authorization-server` | OAuth 2.0 server metadata |

## Client Implementation Example

### Basic OAuth Flow

```javascript
// 1. Generate PKCE challenge
const codeVerifier = crypto.randomBytes(32).toString("base64url");
const codeChallenge = crypto
  .createHash("sha256")
  .update(codeVerifier)
  .digest("base64url");

// 2. Redirect to authorization endpoint
const authURL = new URL("http://localhost:9001/api/auth/oauth/authorize");
authURL.searchParams.set(
  "client_id",
  "https://example.com/oauth-client-metadata.json",
);
authURL.searchParams.set("redirect_uri", window.location.origin + "/callback");
authURL.searchParams.set("response_type", "code");
authURL.searchParams.set("scope", "openid profile email");
authURL.searchParams.set("code_challenge", codeChallenge);
authURL.searchParams.set("code_challenge_method", "S256");

window.location.href = authURL.toString();

// 3. Handle callback (in /callback page)
const code = new URLSearchParams(window.location.search).get("code");

// 4. Exchange code for tokens (from backend)
const response = await fetch("http://localhost:9001/api/auth/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    code_verifier: codeVerifier,
    client_id: "https://example.com/oauth-client-metadata.json",
  }),
});

const tokens = await response.json();
localStorage.setItem("access_token", tokens.access_token);

// 5. Use access token for API requests
fetch("http://localhost:9001/api/identity/profile", {
  headers: { Authorization: "Bearer " + tokens.access_token },
});
```

## Security Features

### 1. PKCE Protection

- Prevents authorization code interception attacks
- Code verifier never transmitted to auth server directly
- Only code challenge stored

### 2. Token Encryption

- Access tokens encrypted in database with AES-256-GCM
- Uses KMS encryption keys per user
- Encryption key never shared

### 3. Session Management

- Automatic session expiry (configurable)
- Session tied to user ID
- Audit logging of session events

### 4. DID Binding

- Each user has unique DID
- DID cannot be spoofed (deterministic generation)
- DID includes domain for federation

### 5. Key Rotation

- Support for multiple key versions per user
- Old signing key automatically marked inactive
- Transparent upgrade path

## Configuration

Set environment variables (from Phase 1 setup):

```bash
# Database
export IDENTITY_DB=./objects-identity.sqlite

# KMS
export KMS_PROVIDER=env
export MASTER_KEY="m+o+ju09JDAzF/y9R/muZY9wn0JPcFOwyYtQXZMp934="

# OAuth
export OAUTH_CLIENT_ID=http://localhost:9001/oauth-client-metadata.json
export OAUTH_REDIRECT_URI=http://localhost:9001/oauth/callback
export LIVELY_DOMAIN=example.com

# PDS
export PDS_ENDPOINT=http://localhost:9001
export PDS_ROOT=./pds

# Session expiry
export SESSION_EXPIRY_MS=86400000
export TOKEN_EXPIRY_MS=3600000
export REFRESH_TOKEN_EXPIRY_MS=7776000000
```

## Testing

### 1. Test OAuth Authorization Flow

```bash
curl -i "http://localhost:9001/api/auth/oauth/authorize?
  client_id=https://example.com/oauth-client-metadata.json&
  redirect_uri=http://localhost:3000/callback&
  response_type=code&
  scope=openid&
  code_challenge=E9Mrozoa2owUednwPqpeVegQE5ZHxo2W76sPiMj1xfM&
  code_challenge_method=S256"
```

### 2. Test Token Exchange

```bash
# After getting authorization code from previous step
curl -X POST http://localhost:9001/api/auth/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=<code>&code_verifier=<verifier>&client_id=<client_id>"
```

### 3. Test User Info

```bash
curl -i http://localhost:9001/api/auth/oauth/userinfo \
  -H "Authorization: Bearer <access_token>"
```

### 4. Test Identity Endpoints

```bash
# Get profile
curl http://localhost:9001/api/identity/profile/alice

# Update profile (authenticated)
curl -X PUT http://localhost:9001/api/identity/profile \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"display_name":"Alice Smith"}'

# Get user worlds
curl http://localhost:9001/api/identity/worlds \
  -H "Authorization: Bearer <access_token>"
```

### 5. Test DID Resolution

```bash
# Get server DID document
curl http://localhost:9001/.well-known/did.json

# Resolve user DID
curl http://localhost:9001/api/dids/did:plc:abc123...
```

## Database Changes

New tables created by schema-identity.sql:

- `oauth_state` - PKCE state tracking
- `oauth_clients` - Trusted OAuth clients
- `sessions` - OAuth sessions with encrypted tokens
- `did_documents` - User DID documents
- `account_settings` - User preferences
- `world_data` - Morphic environment states
- `permissions` - RBAC permissions
- `audit_log` - Security event log

## Next Steps (Phase 3)

1. **PDS Implementation** - Personal Data Server with MST
2. **Repository Operations** - Store/retrieve encrypted records
3. **JOSE Encryption** - JWE/JWS for records
4. **CAR Format** - Export/import encrypted data
5. **Federated Identity** - Cross-domain DID resolution

## Debugging

### Enable verbose logging

```javascript
// In OAuthServer.js or IdentityServer.js
process.env.DEBUG = "lively-identity:*";
```

### Check database state

```bash
sqlite3 objects-identity.sqlite

# List users
SELECT id, username, did, account_type FROM users;

# Check sessions
SELECT user_id, oauth_access_token, expires_at FROM sessions;

# View oauth_state records
SELECT state_code, client_id, expires_at FROM oauth_state;

# Check keys
SELECT key_id, key_type, is_active FROM kms_key_references;
```

### Monitor token encryption

```bash
# Verify tokens are encrypted in database
sqlite3 objects-identity.sqlite \
  "SELECT LENGTH(oauth_access_token) FROM sessions LIMIT 1"
# Should be base64-encoded and longer than original token
```

## Production Considerations

1. **Use AWS KMS** for production key management

   ```bash
   export KMS_PROVIDER=aws
   export KMS_REGION=us-east-1
   ```

2. **Enable HTTPS** for all OAuth flows

3. **Rate limiting** on `/oauth/token` endpoint

4. **CSRF protection** for OAuth authorization

5. **Account recovery** flow for lost devices

6. **Multi-factor authentication** support

7. **Session revocation** for compromised tokens

8. **Audit logging** for compliance

## References

- [OAuth 2.1 Specification](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-09)
- [PKCE (RFC 7636)](https://tools.ietf.org/html/rfc7636)
- [AT Protocol OAuth](https://github.com/bluesky-social/atproto/blob/main/packages/oauth/oauth-client-node/README.md)
- [DID Specification](https://www.w3.org/TR/did-core/)
- [OIDC Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html)
