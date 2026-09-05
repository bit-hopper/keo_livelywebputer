/**
 * core/servers/identity/HandleRegistry.js
 *
 * Postgres-backed registry mapping handles and domains to did:jwk strings.
 * Migrated from SQLite (see git history for the original) as part of the
 * storage-layer migration documented in DeployCheckList.md — same
 * postgres-client.js pool + one-shot-bootstrapped-DDL idiom as
 * ObjectRepository.js. Data migration for a pre-existing handles.db:
 * scripts/migrate-handles-to-postgres.js.
 *
 * Schema (Postgres, via DATABASE_URL — see ../support/postgres-client.js):
 *
 *   handles table:
 *     handle         TEXT PRIMARY KEY  — e.g. "alice", or an alias like "k3f8m2pq"
 *     did            TEXT NOT NULL     — e.g. "did:jwk:eyJ..."
 *     created_at     TEXT NOT NULL     — ISO 8601
 *     updated_at     TEXT NOT NULL     — ISO 8601
 *     is_alias       BOOLEAN NOT NULL DEFAULT false  — true for a forwarding alias (§3.2)
 *     primary_handle TEXT DEFAULT NULL           — set iff is_alias; the
 *                                                   handle inbox delivery
 *                                                   files under
 *     revoked_at     TEXT DEFAULT NULL           — set on alias revocation;
 *                                                   a revoked row resolves
 *                                                   to nothing everywhere
 *                                                   (§3.2's postal invariant)
 *
 *   domains table:
 *     domain         TEXT PRIMARY KEY  — e.g. "alice.com"
 *     did            TEXT NOT NULL
 *     verified_at    TEXT NOT NULL    — ISO 8601 of last successful verification
 *     status         TEXT NOT NULL DEFAULT 'verified'  — 'verified' | 'invalid',
 *                                                          kept fresh by DomainVerifier's
 *                                                          periodic recheck job
 *     last_checked_at TEXT DEFAULT NULL — ISO 8601 of the last recheck (may be
 *                                          later than verified_at if the most
 *                                          recent check failed)
 *
 *   credentials table — COSE-encoded public key + sign counter per WebAuthn credential:
 *     credential_id  TEXT PRIMARY KEY
 *     did            TEXT NOT NULL
 *     public_key     TEXT NOT NULL    — base64
 *     counter        INTEGER NOT NULL DEFAULT 0
 *     created_at     TEXT NOT NULL
 *
 *   did_documents table — full DID document JSON, keyed by DID string:
 *     did        TEXT PRIMARY KEY
 *     document   TEXT NOT NULL       — JSON.stringify'd
 *     updated_at TEXT NOT NULL
 *
 * Unlike the original SQLite file, there is no PRAGMA-table_info-guarded
 * ALTER TABLE dance here — this schema has never existed in Postgres before
 * this migration, so every column ships in the initial CREATE TABLE rather
 * than being added incrementally to an already-live table.
 */

'use strict';

var postgresClient = require('../support/postgres-client');

var DDL =
  'CREATE TABLE IF NOT EXISTS handles (' +
  '  handle         TEXT PRIMARY KEY,' +
  '  did            TEXT NOT NULL,' +
  '  created_at     TEXT NOT NULL,' +
  '  updated_at     TEXT NOT NULL,' +
  '  is_alias       BOOLEAN NOT NULL DEFAULT false,' +
  '  primary_handle TEXT DEFAULT NULL,' +
  '  revoked_at     TEXT DEFAULT NULL' +
  ');\n' +
  'CREATE TABLE IF NOT EXISTS domains (' +
  '  domain          TEXT PRIMARY KEY,' +
  '  did             TEXT NOT NULL,' +
  '  verified_at     TEXT NOT NULL,' +
  '  status          TEXT NOT NULL DEFAULT \'verified\',' +
  '  last_checked_at TEXT DEFAULT NULL' +
  ');\n' +
  'CREATE TABLE IF NOT EXISTS credentials (' +
  '  credential_id TEXT PRIMARY KEY,' +
  '  did           TEXT NOT NULL,' +
  '  public_key    TEXT NOT NULL,' +
  '  counter       INTEGER NOT NULL DEFAULT 0,' +
  '  created_at    TEXT NOT NULL' +
  ');\n' +
  'CREATE TABLE IF NOT EXISTS did_documents (' +
  '  did        TEXT PRIMARY KEY,' +
  '  document   TEXT NOT NULL,' +
  '  updated_at TEXT NOT NULL' +
  ');';

var _bootstrapped = false;

// Returns the shared pg.Pool, bootstrapping the schema exactly once per
// process first. Nothing outside this file calls withDB() directly today
// (confirmed via grep) -- its contract changing from "a sqlite3.Database"
// to "a pg.Pool" is safe.
function withDB(thenDo) {
  var pool = postgresClient.getPool();
  if (_bootstrapped) return thenDo(null, pool);
  pool.query(DDL, function (err) {
    if (err) return thenDo(err);
    _bootstrapped = true;
    thenDo(null, pool);
  });
}

// Register or update a handle → DID mapping.
// Calls thenDo(err).
function register(handle, did, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    var now = new Date().toISOString();
    pool.query(
      'INSERT INTO handles (handle, did, created_at, updated_at) VALUES ($1, $2, $3, $4)' +
      ' ON CONFLICT (handle) DO UPDATE SET did = EXCLUDED.did, updated_at = EXCLUDED.updated_at',
      [handle, did, now, now],
      function(err) { thenDo(err || null); }
    );
  });
}

// Resolve a handle to its DID.
// Calls thenDo(null, did) or thenDo(null, null) if not found.
//
// Excludes revoked rows (§3.2): a revoked alias must resolve to nothing
// everywhere, not just at the inbox — that's what makes revocation actually
// cut the alias off, rather than merely hiding it from the owner's own
// alias-management panel while every other route keeps honoring it.
// Primary handles are never revoked through this feature, so their
// revoked_at stays NULL forever and this filter is a no-op for them.
function resolve(handle, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'SELECT did FROM handles WHERE handle = $1 AND revoked_at IS NULL',
      [handle],
      function(err, result) {
        if (err) return thenDo(err);
        var row = result.rows[0];
        if (row) return thenDo(null, row.did);
        // Not a registered handle. If it looks like a domain (contains a
        // "."), fall back to the domains table — regardless of `status`.
        // Resolution must not depend on current verification state, or a
        // domain whose hosted proof lapses would 404 every link to it that
        // was ever shared; `status` only drives the profile card's badge
        // and the add/verify UI (ProfileCard.js), not routing.
        if (handle.indexOf('.') === -1) return thenDo(null, null);
        pool.query(
          'SELECT did FROM domains WHERE domain = $1',
          [handle],
          function(err2, result2) { thenDo(err2 || null, result2.rows[0] ? result2.rows[0].did : null); }
        );
      }
    );
  });
}

// Reverse of resolve(): look up the *primary* handle registered for a DID
// — deliberately excludes alias rows (is_alias = false), even though a DID
// with active aliases now has multiple handles rows. Without this filter,
// which row an unordered SELECT happens to return first is unspecified, so
// a caller could non-deterministically get back an alias — exactly the
// "never returned by any route the recipient's contacts would see" leak
// §3.2 rules out. The one existing caller (IdentityServer.js's reactions
// byEmoji handle resolution) needs this guarantee.
// Calls thenDo(null, handle) or thenDo(null, null) if not found.
function resolveHandleForDid(did, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'SELECT handle FROM handles WHERE did = $1 AND is_alias = false',
      [did],
      function(err, result) { thenDo(err || null, result.rows[0] ? result.rows[0].handle : null); }
    );
  });
}

// Resolve a handle (primary or active, non-revoked alias) to both its DID
// and the primary handle inbox delivery should file under (§3.2, closing
// gap #1 — "mail sent to any of a user's aliases, or their real handle,
// all lands in the same inbox file"). A revoked or nonexistent handle
// resolves to null, deliberately indistinguishable at this layer — the
// caller (POST /inbox) is what turns that into the shared postal-rejection
// response (gap #2 — a spammer can't tell "revoked" from "never existed").
// Calls thenDo(null, { did, primaryHandle } | null).
function resolveForDelivery(handle, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'SELECT did, is_alias, primary_handle FROM handles WHERE handle = $1 AND revoked_at IS NULL',
      [handle],
      function(err, result) {
        if (err) return thenDo(err);
        var row = result.rows[0];
        if (!row) return thenDo(null, null);
        thenDo(null, { did: row.did, primaryHandle: row.is_alias ? row.primary_handle : handle });
      }
    );
  });
}

// ─── forwarding aliases (§3.2) ──────────────────────────────────────────────

var ALIAS_LENGTH = 8;
// Lowercase RFC4648 base32 alphabet (26 letters + digits 2-7 = 32 symbols,
// so a random byte % 32 has no modulo bias). Not user-chosen, per the
// owner's resolution — always generated server-side.
var ALIAS_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
var ALIAS_MAX_ATTEMPTS = 8; // generation retries on a random collision

function _randomAliasCandidate() {
  var bytes = require('crypto').randomBytes(ALIAS_LENGTH);
  var s = '';
  for (var i = 0; i < ALIAS_LENGTH; i++) s += ALIAS_ALPHABET[bytes[i] % ALIAS_ALPHABET.length];
  return s;
}

// Generate and register a new active alias for `primaryHandle`/`did`. Uses
// a plain INSERT (not register()'s upsert) specifically so a random
// collision with an existing handle — alias or primary — fails loudly and
// gets retried with a fresh candidate, rather than silently overwriting
// whatever that handle already pointed to.
// Calls thenDo(err, alias).
function createAlias(primaryHandle, did, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);

    (function attempt(triesLeft) {
      if (triesLeft <= 0) {
        return thenDo(new Error('createAlias: could not generate a unique alias after ' + ALIAS_MAX_ATTEMPTS + ' attempts'));
      }
      var candidate = _randomAliasCandidate();
      var now = new Date().toISOString();
      pool.query(
        'INSERT INTO handles (handle, did, created_at, updated_at, is_alias, primary_handle, revoked_at)' +
        ' VALUES ($1, $2, $3, $4, true, $5, NULL)',
        [candidate, did, now, now, primaryHandle],
        function(err) {
          if (err) {
            // 23505 = unique_violation
            if (err.code === '23505') {
              return attempt(triesLeft - 1);
            }
            return thenDo(err);
          }
          thenDo(null, candidate);
        }
      );
    })(ALIAS_MAX_ATTEMPTS);
  });
}

// Active (non-revoked) aliases for a primary handle, newest first.
// Calls thenDo(null, [{ handle, created_at }]).
function listAliasesForHandle(primaryHandle, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'SELECT handle, created_at FROM handles' +
      ' WHERE is_alias = true AND primary_handle = $1 AND revoked_at IS NULL' +
      ' ORDER BY created_at DESC',
      [primaryHandle],
      function(err, result) { thenDo(err || null, result ? result.rows : []); }
    );
  });
}

// Revoke an alias — scoped to `primaryHandle` so one user can't revoke
// another's alias by guessing/enumerating the random string. Idempotent
// only in the sense that revoking an already-revoked alias reports "not
// found" (the WHERE clause excludes it) rather than erroring.
// Calls thenDo(err, changed) where changed is true iff a row was updated.
function revokeAlias(alias, primaryHandle, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'UPDATE handles SET revoked_at = $1' +
      ' WHERE handle = $2 AND is_alias = true AND primary_handle = $3 AND revoked_at IS NULL',
      [new Date().toISOString(), alias, primaryHandle],
      function(err, result) {
        if (err) return thenDo(err);
        thenDo(null, result.rowCount > 0);
      }
    );
  });
}

// List all registered handles with their DIDs.
// Calls thenDo(null, [{ handle, did, created_at, updated_at }]).
function listAll(thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query('SELECT handle, did, created_at, updated_at FROM handles ORDER BY handle', function(err, result) {
      thenDo(err || null, result ? result.rows : []);
    });
  });
}

// Remove a handle registration.
// Calls thenDo(err).
function remove(handle, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query('DELETE FROM handles WHERE handle = $1', [handle], function(err) {
      thenDo(err || null);
    });
  });
}

// Register a verified domain → DID mapping.
// Called after domain verification succeeds (/.well-known/lively-did sig check).
// Also used by DomainVerifier's periodic recheck to flip a previously-invalid
// domain back to verified, so status is always reset to 'verified' here —
// the only other writer of status is updateDomainStatus.
// Calls thenDo(err).
function registerDomain(domain, did, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    var now = new Date().toISOString();
    pool.query(
      'INSERT INTO domains (domain, did, verified_at, status, last_checked_at) VALUES ($1, $2, $3, \'verified\', $4)' +
      ' ON CONFLICT (domain) DO UPDATE SET did = EXCLUDED.did, verified_at = EXCLUDED.verified_at,' +
      "   status = 'verified', last_checked_at = EXCLUDED.last_checked_at",
      [domain, did, now, now],
      function(err) { thenDo(err || null); }
    );
  });
}

// Resolve a domain to its DID (from the domains table).
// Calls thenDo(null, did) or thenDo(null, null) if not registered.
function resolveDomain(domain, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'SELECT did FROM domains WHERE domain = $1',
      [domain],
      function(err, result) { thenDo(err || null, result.rows[0] ? result.rows[0].did : null); }
    );
  });
}

// Domains registered to a DID, newest-verified first — for the profile
// card's badge list (ProfileCard.js).
// Calls thenDo(null, [{ domain, did, verified_at, status, last_checked_at }]).
function listDomainsForDid(did, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'SELECT domain, did, verified_at, status, last_checked_at FROM domains' +
      ' WHERE did = $1 ORDER BY verified_at DESC',
      [did],
      function(err, result) { thenDo(err || null, result ? result.rows : []); }
    );
  });
}

// Every registered domain, for DomainVerifier's periodic recheck job.
// Calls thenDo(null, [{ domain, did, verified_at, status, last_checked_at }]).
function listAllDomains(thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'SELECT domain, did, verified_at, status, last_checked_at FROM domains ORDER BY domain',
      function(err, result) { thenDo(err || null, result ? result.rows : []); }
    );
  });
}

// Remove a domain claim — scoped to `did` so one user can't remove another's
// verified domain by guessing the domain string (same scoping idea as
// revokeAlias's primaryHandle check).
// Calls thenDo(err, changed) where changed is true iff a row was deleted.
function removeDomain(domain, did, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'DELETE FROM domains WHERE domain = $1 AND did = $2',
      [domain, did],
      function(err, result) {
        if (err) return thenDo(err);
        thenDo(null, result.rowCount > 0);
      }
    );
  });
}

// Update a domain's verification status after a recheck (DomainVerifier).
// status: 'verified' | 'invalid'. Calls thenDo(err).
function updateDomainStatus(domain, status, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'UPDATE domains SET status = $1, last_checked_at = $2 WHERE domain = $3',
      [status, new Date().toISOString(), domain],
      function(err) { thenDo(err || null); }
    );
  });
}

// Store or update a WebAuthn credential (COSE public key + counter).
// cosePublicKey: Uint8Array or Buffer from result.registrationInfo.credentialPublicKey.
// counter: integer from result.registrationInfo.counter (0 at registration).
// Calls thenDo(err).
function saveCredential(credentialId, did, cosePublicKey, counter, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    var keyB64 = Buffer.from(cosePublicKey).toString('base64');
    var now    = new Date().toISOString();
    pool.query(
      'INSERT INTO credentials (credential_id, did, public_key, counter, created_at) VALUES ($1, $2, $3, $4, $5)' +
      ' ON CONFLICT (credential_id) DO UPDATE SET public_key = EXCLUDED.public_key, counter = EXCLUDED.counter',
      [credentialId, did, keyB64, counter || 0, now],
      function(err) { thenDo(err || null); }
    );
  });
}

// Retrieve a stored WebAuthn credential.
// Calls thenDo(null, { did, publicKey: Uint8Array, counter }) or thenDo(null, null).
function getCredential(credentialId, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'SELECT did, public_key, counter FROM credentials WHERE credential_id = $1',
      [credentialId],
      function(err, result) {
        if (err) return thenDo(err);
        var row = result.rows[0];
        if (!row) return thenDo(null, null);
        thenDo(null, {
          did:       row.did,
          publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64')),
          counter:   row.counter
        });
      }
    );
  });
}

// Update the sign counter after a successful WebAuthn assertion (replay protection).
// Calls thenDo(err).
function updateCounter(credentialId, newCounter, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'UPDATE credentials SET counter = $1 WHERE credential_id = $2',
      [newCounter, credentialId],
      function(err) { thenDo(err || null); }
    );
  });
}

// Store or replace the full DID document for a DID.
// document: plain object (will be JSON-serialised).
// Calls thenDo(err).
function saveDIDDocument(did, document, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    var now = new Date().toISOString();
    pool.query(
      'INSERT INTO did_documents (did, document, updated_at) VALUES ($1, $2, $3)' +
      ' ON CONFLICT (did) DO UPDATE SET document = EXCLUDED.document, updated_at = EXCLUDED.updated_at',
      [did, JSON.stringify(document), now],
      function(err) { thenDo(err || null); }
    );
  });
}

// Retrieve the stored DID document for a DID.
// Calls thenDo(null, document) or thenDo(null, null) if not found.
function getDIDDocument(did, thenDo) {
  withDB(function(err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'SELECT document FROM did_documents WHERE did = $1',
      [did],
      function(err, result) {
        if (err) return thenDo(err);
        var row = result.rows[0];
        if (!row) return thenDo(null, null);
        try {
          thenDo(null, JSON.parse(row.document));
        } catch (e) {
          thenDo(new Error('HandleRegistry: corrupt DID document for ' + did));
        }
      }
    );
  });
}

module.exports = {
  withDB:           withDB,
  register:         register,
  resolve:          resolve,
  resolveHandleForDid: resolveHandleForDid,
  resolveForDelivery: resolveForDelivery,
  createAlias:      createAlias,
  listAliasesForHandle: listAliasesForHandle,
  revokeAlias:      revokeAlias,
  listAll:          listAll,
  remove:           remove,
  registerDomain:   registerDomain,
  resolveDomain:    resolveDomain,
  listDomainsForDid: listDomainsForDid,
  listAllDomains:   listAllDomains,
  removeDomain:     removeDomain,
  updateDomainStatus: updateDomainStatus,
  saveCredential:   saveCredential,
  getCredential:    getCredential,
  updateCounter:    updateCounter,
  saveDIDDocument:  saveDIDDocument,
  getDIDDocument:   getDIDDocument,
};
