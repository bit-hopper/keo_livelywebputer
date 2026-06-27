/**
 * core/servers/identity/ObjectRepository.js
 *
 * Envelope storage and delta log for signed Lively identity objects.
 *
 * Each object (world, part, file, settings, home manifest) is stored as a
 * sequence of signed envelope versions. The version chain is a DAG via
 * the prevCid field — analogous to Wave's DeltaStore.
 *
 * Schema (SQLite, file: <WORKSPACE_LK>/identity/objects.db):
 *
 *   objects table — one row per envelope version:
 *     id          INTEGER PRIMARY KEY AUTOINCREMENT
 *     obj_id      TEXT NOT NULL      — stable ObjID (12-char base64url)
 *     did         TEXT NOT NULL      — author's DID
 *     cid         TEXT NOT NULL      — content hash of this version
 *     prev_cid    TEXT               — NULL for genesis version
 *     type        TEXT NOT NULL      — world|part|file|settings|home
 *     visibility  TEXT NOT NULL      — public|private|shared
 *     envelope    TEXT NOT NULL      — full JSON envelope
 *     created_at  TEXT NOT NULL      — ISO 8601
 *
 *   CREATE UNIQUE INDEX idx_obj_cid ON objects(obj_id, cid)
 *   CREATE INDEX idx_obj_id ON objects(obj_id)
 *   CREATE INDEX idx_did ON objects(did)
 *
 * The latest version of an object is the row with the highest id for a
 * given obj_id. No DELETE ever happens — the log is append-only.
 */

'use strict';

var path    = require('path');
var sqlite3 = require('sqlite3').verbose();

var DB_PATH = path.join(
  process.env.WORKSPACE_LK || process.cwd(),
  'identity',
  'objects.db'
);

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
        'CREATE TABLE IF NOT EXISTS objects (' +
        '  id         INTEGER PRIMARY KEY AUTOINCREMENT,' +
        '  obj_id     TEXT NOT NULL,' +
        '  did        TEXT NOT NULL,' +
        '  cid        TEXT NOT NULL,' +
        '  prev_cid   TEXT,' +
        '  type       TEXT NOT NULL,' +
        '  visibility TEXT NOT NULL,' +
        '  envelope   TEXT NOT NULL,' +
        '  created_at TEXT NOT NULL' +
        ')'
      );
      db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_obj_cid ON objects(obj_id, cid)');
      db.run('CREATE INDEX IF NOT EXISTS idx_obj_id ON objects(obj_id)');
      db.run('CREATE INDEX IF NOT EXISTS idx_did ON objects(did)', function(err) {
        thenDo(err, db);
      });
    });
  });
}

// Append a new envelope version for an object.
// envelope must be a parsed JS object with at minimum:
//   { objId, did, type, visibility, record: { cid, prevCid } }
// Calls thenDo(err, { id, objId, cid }).
function put(envelope, thenDo) {
  if (!envelope || !envelope.objId || !envelope.record || !envelope.record.cid) {
    return thenDo(new Error('ObjectRepository.put: invalid envelope — missing objId or record.cid'));
  }
  withDB(function(err, db) {
    if (err) return thenDo(err);
    var now = new Date().toISOString();
    db.run(
      'INSERT INTO objects (obj_id, did, cid, prev_cid, type, visibility, envelope, created_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        envelope.objId,
        envelope.did,
        envelope.record.cid,
        envelope.record.prevCid || null,
        envelope.type || 'world',
        envelope.visibility || 'public',
        JSON.stringify(envelope),
        now
      ],
      function(err) {
        if (err) {
          // UNIQUE constraint on (obj_id, cid) — this version already stored, not an error
          if (err.message && err.message.indexOf('UNIQUE constraint') !== -1) {
            return thenDo(null, { objId: envelope.objId, cid: envelope.record.cid, duplicate: true });
          }
          return thenDo(err);
        }
        thenDo(null, { id: this.lastID, objId: envelope.objId, cid: envelope.record.cid });
      }
    );
  });
}

// Get the latest envelope version for an objId.
// Calls thenDo(null, envelope) or thenDo(null, null) if not found.
function get(objId, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT envelope FROM objects WHERE obj_id = ? ORDER BY id DESC LIMIT 1',
      [objId],
      function(err, row) {
        if (err) return thenDo(err);
        if (!row) return thenDo(null, null);
        try { thenDo(null, JSON.parse(row.envelope)); }
        catch (e) { thenDo(new Error('ObjectRepository.get: corrupt envelope JSON for ' + objId)); }
      }
    );
  });
}

// Get a specific version of an object by its CID.
// Calls thenDo(null, envelope) or thenDo(null, null).
function getVersion(objId, cid, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT envelope FROM objects WHERE obj_id = ? AND cid = ?',
      [objId, cid],
      function(err, row) {
        if (err) return thenDo(err);
        if (!row) return thenDo(null, null);
        try { thenDo(null, JSON.parse(row.envelope)); }
        catch (e) { thenDo(new Error('ObjectRepository.getVersion: corrupt envelope JSON')); }
      }
    );
  });
}

// Get all envelope versions for an objId newer than a given prevCid
// (exclusive of the version at prevCid itself).
// If prevCid is null, returns ALL versions from genesis.
// Used by the sync protocol: client sends localCid, server returns delta.
// Calls thenDo(null, envelope[]) in ascending version order.
function getVersionsSince(objId, prevCid, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);

    if (!prevCid) {
      // Return all versions
      db.all(
        'SELECT envelope FROM objects WHERE obj_id = ? ORDER BY id ASC',
        [objId],
        function(err, rows) {
          if (err) return thenDo(err);
          try {
            thenDo(null, rows.map(function(r) { return JSON.parse(r.envelope); }));
          } catch (e) { thenDo(e); }
        }
      );
      return;
    }

    // Find the id of the row at prevCid, then return everything after it
    db.get(
      'SELECT id FROM objects WHERE obj_id = ? AND cid = ?',
      [objId, prevCid],
      function(err, pivotRow) {
        if (err) return thenDo(err);
        if (!pivotRow) {
          // Client's prevCid not found — return all versions so client can
          // reconcile (may happen after data loss or first sync)
          return getVersionsSince(objId, null, thenDo);
        }
        db.all(
          'SELECT envelope FROM objects WHERE obj_id = ? AND id > ? ORDER BY id ASC',
          [objId, pivotRow.id],
          function(err, rows) {
            if (err) return thenDo(err);
            try {
              thenDo(null, rows.map(function(r) { return JSON.parse(r.envelope); }));
            } catch (e) { thenDo(e); }
          }
        );
      }
    );
  });
}

// List the latest envelope (head version) for every object owned by a DID.
// Calls thenDo(null, envelope[]).
function listForUser(did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    // Self-join to get only the latest row per obj_id for this DID
    db.all(
      'SELECT o.envelope FROM objects o' +
      ' INNER JOIN (' +
      '   SELECT obj_id, MAX(id) AS max_id FROM objects WHERE did = ? GROUP BY obj_id' +
      ' ) latest ON o.id = latest.max_id',
      [did],
      function(err, rows) {
        if (err) return thenDo(err);
        try {
          thenDo(null, rows.map(function(r) { return JSON.parse(r.envelope); }));
        } catch (e) { thenDo(e); }
      }
    );
  });
}

// List the full version history (all CIDs) for an objId, ascending.
// Calls thenDo(null, [{ cid, prevCid, createdAt }]).
function listVersions(objId, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all(
      'SELECT cid, prev_cid, created_at FROM objects WHERE obj_id = ? ORDER BY id ASC',
      [objId],
      function(err, rows) {
        if (err) return thenDo(err);
        thenDo(null, rows.map(function(r) {
          return { cid: r.cid, prevCid: r.prev_cid, createdAt: r.created_at };
        }));
      }
    );
  });
}

module.exports = {
  withDB:          withDB,
  put:             put,
  get:             get,
  getVersion:      getVersion,
  getVersionsSince: getVersionsSince,
  listForUser:     listForUser,
  listVersions:    listVersions
};
