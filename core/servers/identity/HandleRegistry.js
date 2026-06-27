/**
 * core/servers/identity/HandleRegistry.js
 *
 * SQLite-backed registry mapping handles and domains to did:jwk strings.
 *
 * Schema:
 *   handles table:
 *     handle     TEXT PRIMARY KEY  — e.g. "alice"
 *     did        TEXT NOT NULL     — e.g. "did:jwk:eyJ..."
 *     created_at TEXT NOT NULL     — ISO 8601
 *     updated_at TEXT NOT NULL     — ISO 8601
 *
 *   domains table:
 *     domain     TEXT PRIMARY KEY  — e.g. "alice.com"
 *     did        TEXT NOT NULL
 *     verified_at TEXT NOT NULL    — ISO 8601 of last successful verification
 *
 * The DB file is stored at <WORKSPACE_LK>/identity/handles.db.
 * Created automatically on first use.
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
        ')'
      );
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
function resolve(handle, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT did FROM handles WHERE handle = ?',
      [handle],
      function(err, row) { thenDo(err || null, row ? row.did : null); }
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
