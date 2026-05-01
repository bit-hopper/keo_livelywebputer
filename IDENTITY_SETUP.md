# Lively Kernel Identity System - Setup Guide

## Overview

This document describes how to initialize and configure the Lively Kernel identity system for authentication, user management, and encrypted data storage with AT Protocol integration.

## Quick Start (5 minutes)

### 1. Run Interactive Setup

```bash
node bin/setup-identity.js
```

This creates:

- Directory structure (`pds/`, `.lively-keys/`)
- `.env.identity` configuration file
- Master encryption key

### 2. Load Environment

```bash
source .env.identity
```

Or add to your shell profile:

```bash
export IDENTITY_DB=./objects-identity.sqlite
export KMS_PROVIDER=env
export MASTER_KEY="<your-base64-key>"
export OAUTH_CLIENT_ID=http://localhost:9001/oauth-client-metadata.json
export LIVELY_DOMAIN=example.com
```

### 3. Initialize Database

```bash
node bin/init-identity-db.js
```

Output:

```
✅ Database connected
✅ Schema applied successfully
📊 Verifying tables...
✅ All 11 tables created:
   - users
   - sessions
   - permissions
   - account_settings
   - world_data
   - pds_records
   - pds_commits
   - kms_key_references
   - oauth_state
   - oauth_clients
   - audit_log
```

### 4. Test KMS

```bash
node bin/test-kms.js
```

Output:

```
✅ ALL TESTS PASSED
✨ KMS is working correctly and ready for use!
```

### 5. Start Server

```bash
npm start
```

## Configuration Reference

### Database

```bash
export IDENTITY_DB=./objects-identity.sqlite
```

SQLite database path. Will be created automatically on first initialization.

### Key Management System (KMS)

```bash
export KMS_PROVIDER=env                    # 'env' for dev/test
export KMS_REGION=us-east-1               # (ignored for env provider)
export KMS_KEY_ALIAS=lively-keys          # (ignored for env provider)
export MASTER_KEY="<base64-aes256-key>"   # REQUIRED - 32+ bytes base64
```

**Env-based KMS (Development):**

- Keys stored in `.lively-keys/` directory
- Each key saved as JSON file with permissions 0o600
- Also loaded from `LIVELY_KEY_*` environment variables
- ⚠️ **For development/testing only**

**Production KMS:**

```bash
export KMS_PROVIDER=aws                    # or 'vault', 'hsm'
export KMS_REGION=us-east-1
export KMS_KEY_ALIAS=alias/lively-prod
export AWS_PROFILE=default
```

### OAuth Configuration

```bash
export OAUTH_CLIENT_ID=https://example.com/oauth-client-metadata.json
export OAUTH_REDIRECT_URI=https://example.com/oauth/callback
export LIVELY_DOMAIN=example.com
```

### PDS (Personal Data Server)

```bash
export PDS_ENDPOINT=http://localhost:9001
export PDS_ROOT=./pds
```

Repository structure will be created under `PDS_ROOT/users/{username}/`

### Session & Token Expiry

```bash
export SESSION_EXPIRY_MS=86400000        # 24 hours
export TOKEN_EXPIRY_MS=3600000           # 1 hour
export REFRESH_TOKEN_EXPIRY_MS=7776000000  # 90 days
```

### Feature Flags

```bash
export ENABLE_OAUTH=true
export ENABLE_PDS=true
export ENABLE_ENCRYPTION=true
```

## File Structure

After initialization, your Lively Kernel directory should look like:

```
LivelyKernel/
├── bin/
│   ├── init-identity-db.js          # Database initialization
│   ├── setup-identity.js             # Interactive setup
│   ├── test-kms.js                   # KMS health check
│   └── ...
├── core/
│   ├── servers/
│   │   ├── KMSClient.js              # Key management (env-based)
│   │   ├── schema-identity.sql       # Database schema
│   │   └── ...
│   └── ...
├── lib/
│   └── identity-config.js            # Configuration loader
├── pds/                               # Personal Data Server root
│   └── users/
│       └── alice/
│           ├── repo/
│           │   ├── objects.car
│           │   └── current_commit.json
│           └── .well-known/
│               └── did.json
├── .lively-keys/                     # Key storage (env-based KMS)
│   ├── alice-signing-1.json
│   ├── alice-encryption-1.json
│   └── ...
├── objects-identity.sqlite           # SQLite identity database
└── .env.identity                      # Environment configuration
```

## Database Schema

11 tables for complete identity management:

| Table                | Purpose                                    |
| -------------------- | ------------------------------------------ |
| `users`              | User profiles with DID, account type, keys |
| `sessions`           | OAuth sessions and access tokens           |
| `permissions`        | RBAC roles, scopes, expiry                 |
| `account_settings`   | User preferences and configuration         |
| `world_data`         | Morphic environments and state             |
| `pds_records`        | Encrypted records in repository            |
| `pds_commits`        | Repository commit history                  |
| `kms_key_references` | Key identifiers and metadata               |
| `oauth_state`        | PKCE flow security state                   |
| `oauth_clients`      | Trusted OAuth applications                 |
| `audit_log`          | Security and admin events                  |

## Key Management

### Generate Master Key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Or use Node REPL:

```javascript
const crypto = require("crypto");
const key = crypto.randomBytes(32).toString("base64");
console.log(`export MASTER_KEY="${key}"`);
```

### Verify KMS Setup

```bash
node bin/test-kms.js
```

Tests:

- ✓ Key generation (signing, encryption)
- ✓ Signing and verification
- ✓ Encryption and decryption
- ✓ Key isolation
- ✓ Key rotation

### Working with Keys

```javascript
const KMSClient = require("./core/servers/KMSClient");
const kms = new KMSClient();

// Generate keys for a user
const signingKey = await kms.generateSigningKey("alice", 1);
const encryptionKey = await kms.generateEncryptionKey("alice", 1);

// Sign data
const signature = await kms.sign(signingKey.keyId, messageBytes);

// Verify signature
const verified = await kms.verify(signingKey.keyId, signature, messageBytes);

// Encrypt data
const encrypted = await kms.encrypt(encryptionKey.keyId, dataBytes);

// Decrypt data
const decrypted = await kms.decrypt(encryptionKey.keyId, encrypted);

// Rotate keys
const newKey = await kms.rotateKey(signingKey.keyId);
```

## Integration with Existing Systems

### AuthServer

The AuthServer should be enhanced to:

1. On user creation:
   - Generate DID
   - Create user in `users` table
   - Generate signing + encryption keys
   - Insert into `kms_key_references`

2. On login:
   - Fetch user from database
   - Create session in `sessions` table
   - Return session token to client

3. OAuth callback:
   - Extract DID from authorization server
   - Create or update user record
   - Create session

### SessionTracker

Enhance to persist sessions:

1. Load active sessions from DB on startup
2. Validate session tokens against database
3. Refresh expired tokens using refresh tokens
4. Audit login/logout events

### Morphic Components

User data (profiles, worlds, etc.) should:

1. Serialize to JSON
2. Encrypt with JOSE (JWE)
3. Store in MST repository
4. Create signed commit
5. Track in `pds_records` and `pds_commits` tables

## Troubleshooting

### "Key not found" error

```
Error: Key not found: alice-signing-1
```

**Solution:** Ensure keys are generated before use:

```javascript
await kms.generateSigningKey("alice", 1);
```

### "Auth tag verification failed"

```
Error: Unsupported state or unable to authenticate data
```

**Solution:** Decryption failed - key mismatch or corrupted data. Verify:

- Using correct key for decryption
- Data wasn't modified after encryption

### Database locked

```
Error: database is locked
```

**Solution:**

- Close other connections to database
- Increase timeout: `PRAGMA busy_timeout = 5000;`

### Missing dependencies

```
Error: Cannot find module 'sqlite3'
```

**Solution:**

```bash
npm install sqlite3 tweetnacl
```

## Security Checklist

- [ ] `.env.identity` file is NOT committed to git
- [ ] `.lively-keys/` directory has 0o700 permissions
- [ ] Master key is at least 32 bytes (256 bits)
- [ ] Master key is stored securely (not in code/config)
- [ ] All OAuth tokens are encrypted in database
- [ ] Private keys never stored in database
- [ ] HTTPS enabled for production OAuth flow
- [ ] Session tokens are cryptographically random
- [ ] Audit logging enabled for sensitive operations

## Next Steps

1. **Set up OAuth integration** → See `IDENTITY_SYSTEM_DESIGN.md` Phase 2
2. **Implement IdentityServer** → Handle profile/settings/world data
3. **Build PDS endpoints** → Serve repository and DID documents
4. **Add permissions system** → Implement RBAC checks
5. **Configure production KMS** → Replace env-based with AWS/Vault
6. **Deploy with TLS** → Enable HTTPS for all OAuth flows

## References

- [IDENTITY_SYSTEM_DESIGN.md](../IDENTITY_SYSTEM_DESIGN.md) - Complete architecture
- [atproto.txt](../atproto.txt) - AT Protocol integration guide
- [schema-identity.sql](../core/servers/schema-identity.sql) - Database schema
- [KMSClient.js](../core/servers/KMSClient.js) - Key management implementation
- [identity-config.js](../lib/identity-config.js) - Configuration management

## Support

For issues or questions:

1. Check the troubleshooting section above
2. Review logs in `./logs/identity.log`
3. Run health check: `node bin/test-kms.js`
4. Verify configuration: `node -e "const c = require('./lib/identity-config'); c.getConfig().printSummary()"`
