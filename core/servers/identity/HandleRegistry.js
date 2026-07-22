/**
 * core/servers/identity/HandleRegistry.js
 *
 * SQLite-backed registry mapping handles and domains to did:jwk strings.
 *
 * Schema:
 *   handles table:
 *     handle         TEXT PRIMARY KEY  — e.g. "alice", or an alias like "k3f8m2pq"
 *     did            TEXT NOT NULL     — e.g. "did:jwk:eyJ..."
 *     created_at     TEXT NOT NULL     — ISO 8601
 *     updated_at     TEXT NOT NULL     — ISO 8601
 *     is_alias       INTEGER NOT NULL DEFAULT 0  — 1 for a forwarding alias (§3.2)
 *     primary_handle TEXT DEFAULT NULL           — set iff is_alias=1; the
 *                                                   handle inbox delivery
 *                                                   files under
 *     revoked_at     TEXT DEFAULT NULL           — set on alias revocation;
 *                                                   a revoked row resolves
 *                                                   to nothing everywhere
 *                                                   (§3.2's postal invariant)
 *
 *   domains table:
 *     domain     TEXT PRIMARY KEY  — e.g. "alice.com"
 *     did        TEXT NOT NULL
 *     verified_at TEXT NOT NULL    — ISO 8601 of last successful verification
 *
 * The DB file is stored at <WORKSPACE_LK>/identity/handles.db.
 * Created automatically on first use. is_alias/primary_handle/revoked_at
 * are added via idempotent ALTER TABLE on top of a pre-existing handles
 * table (checked against PRAGMA table_info rather than assuming SQLite's
 * ADD COLUMN IF NOT EXISTS is available, since that's a relatively recent
 * SQLite addition) — existing rows get is_alias=0, primary_handle=NULL,
 * revoked_at=NULL, which is exactly "an ordinary primary handle."
 */

'use strict';

var path    = require('path');
var sqlite3 = require('sqlite3').verbose();

var DB_PATH = path.join(
  process.env.WORKSPACE_LK || process.cwd(),
  'identity',
  'handles.db'
);

// Singleton DB connection, opened lazily.
var _db = null;

function withDB(thenDo) {
  if (_db) return thenDo(null, _db);

  var fs = require('fs');
  var dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  var db = new sqlite3.Database(DB_PATH, function(err) {
    if (err) return thenDo(err);
    _db = db;
    db.serialize(function() {
      db.run(
        'CREATE TABLE IF NOT EXISTS handles (' +
        '  handle     TEXT PRIMARY KEY,' +
        '  did        TEXT NOT NULL,' +
        '  created_at TEXT NOT NULL,' +
        '  updated_at TEXT NOT NULL' +
        ')',
        function(err) {
          if (err) return thenDo(err);
          _ensureAliasColumns(db, function(err) {
            if (err) return thenDo(err);
            _createRemainingTables(db, thenDo);
          });
        }
      );
    });
  });
}

// Idempotent migration: adds §3.2's three alias columns to a handles table
// that may predate them. Checked via PRAGMA table_info rather than
// `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (SQLite 3.35+ only) for wider
// compatibility with whatever sqlite3 build this runs against.
function _ensureAliasColumns(db, thenDo) {
  db.all('PRAGMA table_info(handles)', function(err, cols) {
    if (err) return thenDo(err);
    var names = (cols || []).map(function(c) { return c.name; });
    var toAdd = [];
    if (names.indexOf('is_alias') === -1) {
      toAdd.push('ALTER TABLE handles ADD COLUMN is_alias INTEGER NOT NULL DEFAULT 0');
    }
    if (names.indexOf('primary_handle') === -1) {
      toAdd.push('ALTER TABLE handles ADD COLUMN primary_handle TEXT DEFAULT NULL');
    }
    if (names.indexOf('revoked_at') === -1) {
      toAdd.push('ALTER TABLE handles ADD COLUMN revoked_at TEXT DEFAULT NULL');
    }
    (function next(i) {
      if (i >= toAdd.length) return thenDo(null);
      db.run(toAdd[i], function(err) {
        if (err) return thenDo(err);
        next(i + 1);
      });
    })(0);
  });
}

function _createRemainingTables(db, thenDo) {
  db.serialize(function() {
      db.run(
        'CREATE TABLE IF NOT EXISTS domains (' +
        '  domain      TEXT PRIMARY KEY,' +
        '  did         TEXT NOT NULL,' +
        '  verified_at TEXT NOT NULL' +
        ')'
      );
      // Stores the COSE-encoded public key and sign counter for each WebAuthn
      // credential. Required by verifyAuthenticationResponse and for replay
      // protection (counter must increase on every assertion).
      db.run(
        'CREATE TABLE IF NOT EXISTS credentials (' +
        '  credential_id TEXT PRIMARY KEY,' +
        '  did           TEXT NOT NULL,' +
        '  public_key    TEXT NOT NULL,' +
        '  counter       INTEGER NOT NULL DEFAULT 0,' +
        '  created_at    TEXT NOT NULL' +
        ')'
      );
      // Stores the full DID document JSON keyed by DID string.
      // Used by the new-device login path to fetch the DID document without
      // requiring it to exist in the user's content object store.
      db.run(
        'CREATE TABLE IF NOT EXISTS did_documents (' +
        '  did        TEXT PRIMARY KEY,' +
        '  document   TEXT NOT NULL,' +
        '  updated_at TEXT NOT NULL' +
        ')',
        function(err) { thenDo(err, db); }
      );
  });
}

// Register or update a handle → DID mapping.
// Calls thenDo(err).
function register(handle, did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    var now = new Date().toISOString();
    db.run(
      'INSERT INTO handles (handle, did, created_at, updated_at) VALUES (?, ?, ?, ?)' +
      ' ON CONFLICT(handle) DO UPDATE SET did=excluded.did, updated_at=excluded.updated_at',
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
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT did FROM handles WHERE handle = ? AND revoked_at IS NULL',
      [handle],
      function(err, row) { thenDo(err || null, row ? row.did : null); }
    );
  });
}

// Reverse of resolve(): look up the *primary* handle registered for a DID
// — deliberately excludes alias rows (is_alias = 0), even though a DID
// with active aliases now has multiple handles rows. Without this filter,
// which row `db.get`'s unordered SELECT happens to return first is
// unspecified, so a caller could non-deterministically get back an alias —
// exactly the "never returned by any route the recipient's contacts would
// see" leak §3.2 rules out. The one existing caller (IdentityServer.js's
// reactions byEmoji handle resolution) needs this guarantee.
// Calls thenDo(null, handle) or thenDo(null, null) if not found.
function resolveHandleForDid(did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT handle FROM handles WHERE did = ? AND is_alias = 0',
      [did],
      function(err, row) { thenDo(err || null, row ? row.handle : null); }
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
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT did, is_alias, primary_handle FROM handles WHERE handle = ? AND revoked_at IS NULL',
      [handle],
      function(err, row) {
        if (err) return thenDo(err);
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
  withDB(function(err, db) {
    if (err) return thenDo(err);

    (function attempt(triesLeft) {
      if (triesLeft <= 0) {
        return thenDo(new Error('createAlias: could not generate a unique alias after ' + ALIAS_MAX_ATTEMPTS + ' attempts'));
      }
      var candidate = _randomAliasCandidate();
      var now = new Date().toISOString();
      db.run(
        'INSERT INTO handles (handle, did, created_at, updated_at, is_alias, primary_handle, revoked_at)' +
        ' VALUES (?, ?, ?, ?, 1, ?, NULL)',
        [candidate, did, now, now, primaryHandle],
        function(err) {
          if (err) {
            if (err.message && err.message.indexOf('UNIQUE constraint') !== -1) {
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
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all(
      'SELECT handle, created_at FROM handles' +
      ' WHERE is_alias = 1 AND primary_handle = ? AND revoked_at IS NULL' +
      ' ORDER BY created_at DESC',
      [primaryHandle],
      function(err, rows) { thenDo(err || null, rows || []); }
    );
  });
}

// Revoke an alias — scoped to `primaryHandle` so one user can't revoke
// another's alias by guessing/enumerating the random string. Idempotent
// only in the sense that revoking an already-revoked alias reports "not
// found" (the WHERE clause excludes it) rather than erroring.
// Calls thenDo(err, changed) where changed is true iff a row was updated.
function revokeAlias(alias, primaryHandle, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'UPDATE handles SET revoked_at = ?' +
      ' WHERE handle = ? AND is_alias = 1 AND primary_handle = ? AND revoked_at IS NULL',
      [new Date().toISOString(), alias, primaryHandle],
      function(err) {
        if (err) return thenDo(err);
        thenDo(null, this.changes > 0);
      }
    );
  });
}

// List all registered handles with their DIDs.
// Calls thenDo(null, [{ handle, did, created_at, updated_at }]).
function listAll(thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all('SELECT handle, did, created_at, updated_at FROM handles ORDER BY handle', thenDo);
  });
}

// Remove a handle registration.
// Calls thenDo(err).
function remove(handle, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run('DELETE FROM handles WHERE handle = ?', [handle], function(err) {
      thenDo(err || null);
    });
  });
}

// Register a verified domain → DID mapping.
// Called after domain verification succeeds (/.well-known/lively-did sig check).
// Calls thenDo(err).
function registerDomain(domain, did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    var now = new Date().toISOString();
    db.run(
      'INSERT INTO domains (domain, did, verified_at) VALUES (?, ?, ?)' +
      ' ON CONFLICT(domain) DO UPDATE SET did=excluded.did, verified_at=excluded.verified_at',
      [domain, did, now],
      function(err) { thenDo(err || null); }
    );
  });
}

// Resolve a domain to its DID (from the domains table).
// Calls thenDo(null, did) or thenDo(null, null) if not registered/verified.
function resolveDomain(domain, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT did FROM domains WHERE domain = ?',
      [domain],
      function(err, row) { thenDo(err || null, row ? row.did : null); }
    );
  });
}

// Store or update a WebAuthn credential (COSE public key + counter).
// cosePublicKey: Uint8Array or Buffer from result.registrationInfo.credentialPublicKey.
// counter: integer from result.registrationInfo.counter (0 at registration).
// Calls thenDo(err).
function saveCredential(credentialId, did, cosePublicKey, counter, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    var keyB64 = Buffer.from(cosePublicKey).toString('base64');
    var now    = new Date().toISOString();
    db.run(
      'INSERT INTO credentials (credential_id, did, public_key, counter, created_at) VALUES (?, ?, ?, ?, ?)' +
      ' ON CONFLICT(credential_id) DO UPDATE SET public_key=excluded.public_key, counter=excluded.counter',
      [credentialId, did, keyB64, counter || 0, now],
      function(err) { thenDo(err || null); }
    );
  });
}

// Retrieve a stored WebAuthn credential.
// Calls thenDo(null, { did, publicKey: Uint8Array, counter }) or thenDo(null, null).
function getCredential(credentialId, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT did, public_key, counter FROM credentials WHERE credential_id = ?',
      [credentialId],
      function(err, row) {
        if (err) return thenDo(err);
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
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'UPDATE credentials SET counter = ? WHERE credential_id = ?',
      [newCounter, credentialId],
      function(err) { thenDo(err || null); }
    );
  });
}

// Store or replace the full DID document for a DID.
// document: plain object (will be JSON-serialised).
// Calls thenDo(err).
function saveDIDDocument(did, document, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    var now = new Date().toISOString();
    db.run(
      'INSERT INTO did_documents (did, document, updated_at) VALUES (?, ?, ?)' +
      ' ON CONFLICT(did) DO UPDATE SET document=excluded.document, updated_at=excluded.updated_at',
      [did, JSON.stringify(document), now],
      function(err) { thenDo(err || null); }
    );
  });
}

// Retrieve the stored DID document for a DID.
// Calls thenDo(null, document) or thenDo(null, null) if not found.
function getDIDDocument(did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT document FROM did_documents WHERE did = ?',
      [did],
      function(err, row) {
        if (err) return thenDo(err);
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
  saveCredential:   saveCredential,
  getCredential:    getCredential,
  updateCounter:    updateCounter,
  saveDIDDocument:  saveDIDDocument,
  getDIDDocument:   getDIDDocument,
};
