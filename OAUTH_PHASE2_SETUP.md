# OAuth Phase 2 Integration Guide

## Files Created (Phase 2)

| File                             | Purpose                       | Size      |
| -------------------------------- | ----------------------------- | --------- |
| `core/servers/OAuthServer.js`    | OAuth 2.1 endpoints with PKCE | 420 lines |
| `core/servers/IdentityServer.js` | User profile & settings APIs  | 450 lines |
| `core/servers/DIDManager.js`     | DID generation & resolution   | 280 lines |
| `bin/test-oauth.js`              | OAuth integration tests       | 380 lines |
| `OAUTH_INTEGRATION.md`           | Complete documentation        | Reference |

## Installation

### 1. Dependencies (Already Installed)

All required packages are already in your environment:

- `sqlite3` - Database
- `tweetnacl` - Signing (via KMS)
- `crypto` - Node.js built-in

### 2. Enable OAuth in Server

Edit `bin/lk-server.js` (or main server entry point):

```javascript
// After Express app is initialized
const app = require("express")();

// ... existing server setup ...

// Add OAuth integration (Phase 2)
const OAuthServer = require("../core/servers/OAuthServer");
const IdentityServer = require("../core/servers/IdentityServer");
const DIDManager = require("../core/servers/DIDManager");

// Mount OAuth endpoints
OAuthServer("/api/auth/", app);

// Mount Identity endpoints
IdentityServer("/api/", app);

// Mount DID resolution endpoints
DIDManager("/api/", app);

// Start server
app.listen(9001, () => {
  console.log("[Lively] Server started with OAuth support on port 9001");
});
```

## Environment Setup (From Phase 1)

Verify you have Phase 1 environment set up:

```bash
# From earlier setup
export IDENTITY_DB=./objects-identity.sqlite
export KMS_PROVIDER=env
export MASTER_KEY="m+o+ju09JDAzF/y9R/muZY9wn0JPcFOwyYtQXZMp934="
export OAUTH_CLIENT_ID=http://localhost:9001/oauth-client-metadata.json
export LIVELY_DOMAIN=example.com
export PDS_ENDPOINT=http://localhost:9001
```

Or load from environment file:

```bash
source .env.identity
```

## API Quick Reference

### OAuth Flow (3 steps)

1. **Authorize**: `GET /api/auth/oauth/authorize?client_id=...&redirect_uri=...&code_challenge=...`
   - Returns: Authorization code
   - Stores: State in oauth_state table

2. **Token**: `POST /api/auth/oauth/token` with authorization code
   - Body: `{grant_type, code, code_verifier, client_id}`
   - Returns: `{access_token, refresh_token, token_type, expires_in}`
   - Stores: Encrypted tokens in sessions table

3. **Callback**: `POST /api/auth/oauth/callback`
   - Handles: OAuth provider response
   - Creates: User session

### User Profile

```bash
# Get public profile (no auth needed)
curl http://localhost:9001/api/identity/profile/alice

# Update own profile (needs Bearer token)
curl -X PUT http://localhost:9001/api/identity/profile \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"display_name":"Alice Smith"}'
```

### Account Settings

```bash
# Get settings
curl http://localhost:9001/api/identity/settings \
  -H "Authorization: Bearer <token>"

# Update settings
curl -X PUT http://localhost:9001/api/identity/settings \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"profile_visibility":"public"}'
```

### Worlds (Morphic Environments)

```bash
# List user's worlds
curl http://localhost:9001/api/identity/worlds \
  -H "Authorization: Bearer <token>"

# Save world
curl -X POST http://localhost:9001/api/identity/worlds \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "worldName": "My World",
    "worldId": "world-123",
    "data": {...},
    "isPinned": true
  }'

# Delete world
curl -X DELETE http://localhost:9001/api/identity/worlds/world-123 \
  -H "Authorization: Bearer <token>"
```

### DID Resolution

```bash
# Server DID document
curl http://localhost:9001/.well-known/did.json

# Resolve user DID
curl http://localhost:9001/api/dids/did:plc:abc123...

# OAuth server metadata
curl http://localhost:9001/.well-known/oauth-authorization-server
```

## Testing

### 1. Run OAuth Tests

```bash
node bin/test-oauth.js
```

Output should show:

```
✅ PASSED - Authorization endpoint accepts request
✅ PASSED - Create test user
✅ PASSED - Get user profile
✅ PASSED - DID format is valid
... etc
```

### 2. Manual OAuth Flow Test

**Terminal 1: Start server**

```bash
npm start
```

**Terminal 2: Test authorization**

```bash
# Generate PKCE challenge
VERIFIER=$(openssl rand -base64 32 | tr -d '\n=+/' | head -c 32)
CHALLENGE=$(echo -n "$VERIFIER" | openssl dgst -sha256 -binary | base64 | tr -d '\n=+/' | head -c 43)

# Request authorization code
curl -i "http://localhost:9001/api/auth/oauth/authorize?
  client_id=https://example.com/oauth-client-metadata.json&
  redirect_uri=http://localhost:3000/callback&
  response_type=code&
  scope=openid+profile&
  code_challenge=$CHALLENGE&
  code_challenge_method=S256"
```

**Capture code, then exchange for token:**

```bash
curl -X POST http://localhost:9001/api/auth/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=<code_from_above>&code_verifier=$VERIFIER&client_id=https://example.com/oauth-client-metadata.json"
```

### 3. Test Identity API

```bash
# Create test user
sqlite3 objects-identity.sqlite "
  INSERT INTO users (username, did, handle, display_name, account_type)
  VALUES ('alice', 'did:plc:test123', 'alice', 'Alice', 'oauth');
"

# Get profile
curl http://localhost:9001/api/identity/profile/alice

# Create session
USERID=1  # From INSERT above
sqlite3 objects-identity.sqlite "
  INSERT INTO sessions (user_id, oauth_access_token, oauth_dpop_token, expires_at)
  VALUES ($USERID, 'test-token', 'dpop', datetime('now', '+1 hour'));
"

# Use Bearer token to access protected endpoints
curl http://localhost:9001/api/identity/worlds \
  -H "Authorization: Bearer test-token"
```

## Database Verification

Check that all tables were created (from Phase 1):

```bash
sqlite3 objects-identity.sqlite ".tables"
```

Should show:

```
account_settings  audit_log         did_documents     kms_key_references
oauth_clients     oauth_state       permissions       pds_commits
pds_records       sessions          users             world_data
```

Check for test data:

```bash
sqlite3 objects-identity.sqlite "SELECT COUNT(*) FROM users;"
sqlite3 objects-identity.sqlite "SELECT COUNT(*) FROM sessions;"
sqlite3 objects-identity.sqlite "SELECT COUNT(*) FROM oauth_state;"
```

## Debugging

### Enable debug logging

```bash
DEBUG=lively-identity:* npm start
```

### Check server logs

```bash
tail -f logs/server.log
```

### Inspect database state

```bash
# List all sessions
sqlite3 objects-identity.sqlite "
  SELECT user_id, LENGTH(oauth_access_token) as token_len, expires_at
  FROM sessions;"

# Check oauth_state
sqlite3 objects-identity.sqlite "
  SELECT state_code, client_id, expires_at
  FROM oauth_state;"

# View DID documents
sqlite3 objects-identity.sqlite "
  SELECT did, document_json FROM did_documents;"
```

### Common Issues

**Issue: "Database is locked"**

- Solution: Close other database connections
- Check: `lsof | grep objects-identity.sqlite`
- Fix: `killall -9 sqlite3`

**Issue: "Key not found" in KMS**

- Solution: Generate keys first: `node bin/test-kms.js`
- Verify: `ls -la .lively-keys/`

**Issue: "Invalid MASTER_KEY"**

- Solution: Regenerate key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
- Update: `export MASTER_KEY="new_key_here"`

**Issue: PKCE validation fails**

- Verify: code_verifier matches code_challenge
- Formula: `SHA256(verifier)` must equal `challenge`
- Test: See manual test in step 2 above

## Next Steps (Phase 3)

The OAuth foundation is now ready. Phase 3 will add:

1. **PDS (Personal Data Server)** - Repository endpoints
2. **MST (Merkle Search Trees)** - Data structure for records
3. **JOSE (JWE/JWS)** - Encrypt records in repository
4. **CAR Format** - Export/import encrypted data
5. **Federated Identity** - Cross-domain DID resolution

Estimated Phase 3 timeline: 4-6 additional files, ~2000 lines of code

## Security Checklist

Before going to production:

- [ ] HTTPS enabled for all OAuth flows
- [ ] CSRF tokens on authorization forms
- [ ] Rate limiting on /oauth/token endpoint
- [ ] Token expiration implemented
- [ ] Refresh token rotation enabled
- [ ] Session invalidation on logout
- [ ] Audit logging for all auth events
- [ ] Multi-factor authentication support
- [ ] Account recovery flow
- [ ] AWS KMS instead of env-based keys

## References

- [Phase 1 KMS Setup](./IDENTITY_SETUP.md)
- [OAuth Specification](./OAUTH_INTEGRATION.md)
- [AT Protocol Docs](./atproto.txt)
- [Database Schema](./core/servers/schema-identity.sql)

## Support

For issues:

1. Check [OAUTH_INTEGRATION.md](./OAUTH_INTEGRATION.md) for detailed flow documentation
2. Run `node bin/test-oauth.js` to verify integration
3. Check logs: `tail -f logs/*.log`
4. Inspect database: `sqlite3 objects-identity.sqlite`
5. Review KMS health: `node bin/test-kms.js`
