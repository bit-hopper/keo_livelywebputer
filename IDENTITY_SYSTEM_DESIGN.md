## Lively Kernel Identity System Architecture

## AT Protocol Integration + SQLite Schema Design

### Date: 2026-04-30

---

## Overview

This document describes how Lively Kernel integrates AT Protocol (OAuth, DIDs, encrypted repositories) with server-side SQLite persistence. The system supports:

- **Federated accounts**: Users with existing AT Protocol accounts authenticate via OAuth
- **Local accounts**: New users create "username.example.com" accounts on Lively's PDS
- **Same identity**: One Lively user = one AT Protocol DID
- **Encrypted storage**: All user data stored as JOSE-encrypted records in MST/CAR format
- **Secure key management**: Cryptographic keys kept in external KMS, DB stores only references

---

## Architecture Layers

### 1. Authentication Layer (OAuth)

**Current Flow (Lively Kernel):**

```
Browser → askForUserName() → localStorage → SessionTracker WebSocket
```

**New Flow (with AT Protocol):**

```
Browser
  → OAuth Client (NodeOAuthClient or similar)
  → Resolve handle/DID to PDS
  → User grants permission on PDS
  → Authorization code redirected to Lively
  → Lively exchanges code for access token + DID
  → Store session + user in DB
  → Create or reuse user record
```

**Key Points:**

- Lively hosts a client metadata document at `https://lively.example.com/oauth-client-metadata.json`
- User can either:
  - Authenticate with existing AT Protocol account (federated)
  - Create new "username.example.com" account via Lively's PDS (local)
- OAuth token stored **encrypted** in `sessions.oauth_access_token`
- DID becomes the canonical user identifier (`users.did`)

### 2. User & Identity Layer

**Table: users**

```
id (internal PK)
│
├─ username (local identifier, unique)
├─ did (AT Protocol DID, unique) ← canonical identifier
├─ handle (AT Protocol handle, e.g., "alice.example.com")
├─ account_type (local | atproto | federated)
│
├─ display_name, avatar_url, bio
├─ email
│
├─ signing_key_id (reference to KMS)
├─ encryption_key_id (reference to KMS)
│
├─ pds_endpoint (user's PDS URL)
├─ repo_root_cid (current MST root hash)
└─ repo_version (TID-like revision counter)
```

**Account Types:**

- `local`: Username/email only, no AT Protocol federation
- `atproto`: Federated account via existing AT Proto PDS
- `federated`: Local account but sync-able with other AT Proto networks

**DID Format:**

- Federated users: Use AT Protocol's `did:plc:...`
- Local users: Generate local DID like `did:lively:username.example.com` or use `did:key:...`

### 3. Data Storage Layer (PDS/Repository)

**File Structure on Disk:**

```
pds/
├─ users/
│  ├─ alice/                                    # username
│  │  ├─ repo/                                  # MST/CAR repository
│  │  │  ├─ objects.car                         # CAR-formatted repo export
│  │  │  └─ current_commit.json                 # current commit metadata
│  │  ├─ .well-known/did.json                   # DID document
│  │  └─ .well-known/host-meta.json            # identity metadata
│  └─ bob/
│     └─ ...
```

**Repository Structure (AT Protocol MST/CAR):**

- Each user has an MST (Merkle Search Tree) containing records
- Records organized by `<collection>/<record-key>`
- Collections for Lively:
  - `com.lively.user.profile` → user profile
  - `com.lively.user.settings` → account settings
  - `com.lively.user.world` → world data/state
  - `com.lively.user.encryption` → key metadata

**Commit Format:**

```json
{
  "did": "did:plc:...",
  "version": 3,
  "data": "bafy2...", // CID of MST root
  "rev": "3jxf7z2k3q2", // TID (timestamp ID)
  "prev": "bafy1...", // previous commit (nullable)
  "sig": "<base64-sig-bytes>" // Ed25519 signature
}
```

**Encryption (JOSE/JWE):**

```
User's plaintext data
  ↓ [JWE encrypt with encryption_key]
  ↓
JOSE encrypted bytes (stored in repo)
  ↓ [CBOR encode + MST insert]
  ↓
Signed repository commit
```

### 4. Session & OAuth Token Storage

**Table: sessions**

```
session_id (unique token identifier)
│
├─ oauth_access_token (encrypted JWE)
├─ oauth_refresh_token (encrypted JWE)
├─ oauth_dpop_token (optional, for DPoP-bound tokens)
│
├─ created_at, last_activity_at, expires_at
└─ client_ip, user_agent (for security tracking)
```

**Token Management:**

- Access tokens valid for ~1 hour
- Refresh tokens valid for ~90 days
- Tokens encrypted in DB using a master key (stored in KMS or env var)
- On token expiry, use refresh token to obtain new access token
- Revoke all sessions if user rotates signing key

### 5. Permissions & RBAC Layer

**Table: permissions**

```
user_id → role (admin | moderator | user | guest)
        → scope (repo:com.lively.* | repo:app.bsky.* | *)
        → action (create | read | update | delete | *)
        → expires_at (for temporary grants)
```

**Permission Model:**

- Inherit from AT Protocol scopes where applicable
- Add Lively-specific scopes for world management, etc.
- Example: `repo:com.lively.user.world?action=create` allows creating worlds

### 6. Cryptographic Key Management (KMS)

**Keys are NOT stored in database:**

- Only key identifiers and public keys stored in `kms_key_references`
- Private keys kept in secure KMS (AWS KMS, HashiCorp Vault, TPM, etc.)

**Table: kms_key_references**

```
key_id (KMS identifier)
│
├─ key_type (signing | encryption | backup)
├─ algorithm (Ed25519 | EcdsaSecp256r1 | A256GCM)
├─ public_key_b64 (for verification, not signing)
│
├─ created_at, rotated_at
└─ is_active (for key rotation)
```

**Key Rotation Flow:**

1. Generate new keypair in KMS
2. Create new entry in `kms_key_references`
3. Create new repository commit (re-signed with new key)
4. Update user's DID document with new public key
5. Archive old key (is_active = 0)

---

## Data Flow Examples

### Example 1: Federated User Login (AT Protocol OAuth)

```
1. User visits Lively, clicks "Sign in with atproto"
2. Browser → NodeOAuthClient.authorize("alice.bsky.social")
3. Redirects to alice's PDS (bsky.social) authorization page
4. User grants permission, PDS redirects back to Lively with code
5. Lively backend: NodeOAuthClient.callback(code)
   → Receive: { did: "did:plc:abc123...", accessToken, refreshToken }
6. Check users table for did="did:plc:abc123..."
   → If not found: INSERT user record
   → If found: UPDATE last_login_at
7. Create session in sessions table
   → oauth_access_token = encrypt(accessToken)
   → oauth_provider = "atproto"
8. Return session_id to browser
9. Browser stores session_id in localStorage
10. All future requests include Authorization: Bearer <session_id>
```

### Example 2: New Local Account Creation

```
1. User visits Lively, clicks "Create account"
2. User enters username "alice", email "alice@example.com", password
3. Frontend validates, sends to backend
4. Backend (AuthServer):
   a. Generate DID: did:lively:alice.example.com
   b. Generate Ed25519 keypair in KMS
   c. INSERT users:
      { username: "alice", did: "did:lively:...",
        account_type: "local",
        signing_key_id: "kms:key:abc...",
        encryption_key_id: "kms:key:xyz..." }
   d. Hash password, store separately (or use OAuth provider internally)
   e. Create pds/users/alice/ directory
   f. Initialize empty MST repository
   g. Create .well-known/did.json with public key
   h. Create initial commit (empty repo)
   i. INSERT kms_key_references for signing + encryption keys
   j. CREATE session
5. User is logged in and can start using Lively
```

### Example 3: Writing User Profile to Repository

```
1. User updates profile display_name → "Alice Smith"
2. Frontend sends PATCH /api/profile with new data
3. Backend (SessionAuth + IdentityServer):
   a. Verify session is valid
   b. Get user from users table
   c. Retrieve signing_key_id from user record
   d. New profile record:
      {
        displayName: "Alice Smith",
        updatedAt: "2026-04-30T12:00:00Z"
      }
   e. JOSE-encrypt with encryption_key_id:
      JWE = encrypt(JSON.stringify(profile), kms.getPublicKey(encryption_key_id))
   f. CBOR-serialize + insert into MST at path:
      com.lively.user.profile/<rkey>
   g. Create new commit:
      - data_cid = MST.root_cid()
      - rev = next_tid()
      - Sign with kms.sign(commit_bytes, signing_key_id)
   h. INSERT pds_commits record
   i. INSERT pds_records with cid + jose_header
   j. Return new profile + commit receipt to client
```

### Example 4: Reading World Data

```
1. Client requests GET /api/worlds/world1
2. Backend:
   a. Query pds_records: collection="com.lively.user.world", rkey="world1"
   b. Get encrypted JWE bytes from pds/users/<username>/repo
   c. Decrypt JWE with kms.decrypt(jwe, encryption_key_id)
   d. Parse CBOR + JSON
   e. Return plaintext to client
```

---

## Integration Points

### AuthServer (core/servers/AuthServer.js)

**Responsibilities:**

- OAuth client initialization + flow
- User creation / account provisioning
- Session management
- DID resolution (local + federated)

**New endpoints:**

- `POST /oauth/authorize` → initiate OAuth
- `GET /oauth/callback` → OAuth redirect handler
- `POST /auth/register` → create local account
- `POST /auth/login` → legacy login + OAuth selection
- `POST /auth/logout` → revoke session

### IdentityServer (NEW: core/servers/IdentityServer.js)

**Responsibilities:**

- User data read/write in PDS repository
- JOSE encryption/decryption orchestration
- MST/CAR commit creation
- Key rotation

**New endpoints:**

- `GET /api/user/<did>/profile`
- `PATCH /api/user/<did>/profile`
- `GET /api/user/<did>/settings`
- `POST /api/user/<did>/worlds`
- etc.

### PDSServer (ENHANCE: core/servers/PDSServer.js or new)

**Responsibilities:**

- Serve pds/users/<username>/ directory
- .well-known/did.json endpoint
- Host metadata document
- CAR file serving (for repo sync)

### SessionTracker (ENHANCE: core/servers/SessionTracker.js)

**Current:** In-memory session tracking
**Enhancement:**

- Query sessions table for persistence across server restarts
- Track OAuth token expiry
- Automatic refresh token rotation

---

## Security Considerations

### 1. Token Encryption

- All OAuth tokens encrypted in DB using AES-256-GCM
- Master encryption key stored in:
  - Environment variable (development)
  - AWS Secrets Manager / Vault (production)
  - KMS (preferred)

### 2. Key Isolation

- Private signing/encryption keys NEVER touch application memory
- KMS handles all cryptographic operations
- Application only receives encrypted results

### 3. Session Security

- Session tokens are random byte strings (not JWTs)
- Tokens expire after inactivity
- IP address + user agent tracked for anomaly detection
- Audit log all sensitive operations

### 4. JOSE/JWE Security

- Use ECDH-ES+HKDF-256+A256GCM for encryption
- Use Ed25519 for signing
- Store JWE header in DB for key rotation tracking

### 5. DID Document Security

- Signed with user's signing key
- Published in .well-known/did.json
- Include public key for verification
- Key rotation updates DID document

---

## Migration Strategy

### Phase 1: Database Setup

1. Run schema-identity.sql to create tables
2. Keep existing users.sqlite for backwards compatibility

### Phase 2: OAuth Integration

1. Implement NodeOAuthClient in AuthServer
2. Add /oauth/authorize, /oauth/callback endpoints
3. Create user record on first OAuth login
4. Migrate existing localStorage usernames → new user records

### Phase 3: PDS/Repository

1. Initialize pds/users/<username>/ structure
2. Create .well-known/did.json for each user
3. Implement IdentityServer for profile read/write
4. Store new data in encrypted JOSE format

### Phase 4: Key Management

1. Generate keys in KMS for existing + new users
2. Store key references in kms_key_references
3. Implement token encryption in SessionTracker

### Phase 5: Federated Features

1. DID resolution (local + federated)
2. Handle user-initiated diaspora (move PDS, etc.)
3. Sync between instances (CAR exports)

---

## Example Queries

### Find user by DID

```sql
SELECT * FROM users WHERE did = 'did:plc:abc123...';
```

### Get active sessions for user

```sql
SELECT * FROM sessions
WHERE user_id = ? AND is_active = 1 AND expires_at > NOW();
```

### Retrieve user's world data

```sql
SELECT * FROM world_data WHERE user_id = ? ORDER BY created_at DESC;
```

### Audit trail for security event

```sql
SELECT * FROM audit_log
WHERE user_id = ? AND event_type = 'oauth_authorize'
ORDER BY created_at DESC LIMIT 10;
```

### Check if user has permission to create posts

```sql
SELECT * FROM permissions
WHERE user_id = ?
  AND role = 'user'
  AND scope LIKE 'repo:app.bsky.feed.post%'
  AND action IN ('create', '*')
  AND is_revoked = 0
  AND (expires_at IS NULL OR expires_at > NOW());
```

---

## References

- [AT Protocol Specs](https://atproto.com/specs)
- [AT Protocol OAuth](https://atproto.com/guides/auth)
- [AT Protocol Repository](https://atproto.com/specs/repository)
- [JOSE Specs](https://jose.readthedocs.io/)
- [DIDs](https://www.w3.org/TR/did-core/)
