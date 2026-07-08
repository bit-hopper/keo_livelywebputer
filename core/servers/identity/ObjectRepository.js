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
 *     type        TEXT NOT NULL      — world|part|file|settings|home|profile
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

// Overwrite the stored envelope+visibility for an existing (obj_id, cid)
// row in place. Used when metadata (visibility / state / record.recipients)
// changes without the payload changing — cid only covers record.payload
// (see SignedSerializer.js / Crypto.computeCid), so such changes can never
// be represented as a new content-addressed version.
// Calls thenDo(err, envelope).
function _updateInPlace(envelope, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'UPDATE objects SET envelope = ?, visibility = ? WHERE obj_id = ? AND cid = ?',
      [
        JSON.stringify(envelope),
        envelope.visibility || 'public',
        envelope.objId,
        envelope.record.cid
      ],
      function(err) {
        if (err) return thenDo(err);
        thenDo(null, envelope);
      }
    );
  });
}

// Append a new envelope version for an object, or — if the incoming cid
// matches the latest stored version's cid (i.e. the payload is unchanged)
// but visibility/state/recipients differ — apply that metadata change in
// place instead of silently dropping it. A same-cid INSERT would otherwise
// collide with idx_obj_cid and be swallowed by put()'s old duplicate
// handling, which is exactly how visibility changes used to go missing.
// envelope must be a parsed JS object with at minimum:
//   { objId, did, type, visibility, record: { cid, prevCid } }
// Calls thenDo(err, { id, objId, cid, duplicate, changed }) where
// changed is 'content' | 'metadata' | 'none'.
function put(envelope, thenDo) {
  if (!envelope || !envelope.objId || !envelope.record || !envelope.record.cid) {
    return thenDo(new Error('ObjectRepository.put: invalid envelope — missing objId or record.cid'));
  }

  get(envelope.objId, function(err, existing) {
    if (err) return thenDo(err);

    if (existing && existing.record.cid === envelope.record.cid) {
      var metadataChanged =
        existing.visibility !== envelope.visibility ||
        JSON.stringify(existing.state || {}) !== JSON.stringify(envelope.state || {}) ||
        JSON.stringify(existing.record.recipients || []) !== JSON.stringify(envelope.record.recipients || []);

      if (!metadataChanged) {
        return thenDo(null, { objId: envelope.objId, cid: envelope.record.cid, duplicate: true, changed: 'none' });
      }

      return _updateInPlace(envelope, function(err) {
        if (err) return thenDo(err);
        thenDo(null, { objId: envelope.objId, cid: envelope.record.cid, duplicate: true, changed: 'metadata' });
      });
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
            // UNIQUE constraint on (obj_id, cid) — raced with another insert
            // of this exact cid (or it's an older, non-latest version being
            // resubmitted). Either way, the content is already stored.
            if (err.message && err.message.indexOf('UNIQUE constraint') !== -1) {
              return thenDo(null, { objId: envelope.objId, cid: envelope.record.cid, duplicate: true, changed: 'none' });
            }
            return thenDo(err);
          }
          thenDo(null, { id: this.lastID, objId: envelope.objId, cid: envelope.record.cid, changed: 'content' });
        }
      );
    });
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
// Excludes type='recovery' (internal system world, never shown in UI).
// Calls thenDo(null, envelope[]).
function listForUser(did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    // Self-join to get only the latest row per obj_id for this DID
    db.all(
      'SELECT o.envelope FROM objects o' +
      ' INNER JOIN (' +
      '   SELECT obj_id, MAX(id) AS max_id FROM objects WHERE did = ? AND type != \'recovery\' GROUP BY obj_id' +
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

// Get the latest profile envelope for a DID.
// Profiles are type:'profile' singletons — one per user.
// Calls thenDo(null, envelope | null).
function getProfileForDid(did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT envelope FROM objects WHERE did = ? AND type = \'profile\' ORDER BY id DESC LIMIT 1',
      [did],
      function(err, row) {
        if (err) return thenDo(err);
        if (!row) return thenDo(null, null);
        try { thenDo(null, JSON.parse(row.envelope)); }
        catch (e) { thenDo(new Error('ObjectRepository.getProfileForDid: corrupt envelope JSON')); }
      }
    );
  });
}

// Get the recovery world envelope for a DID.
// Recovery worlds are type:'recovery' singletons created at registration.
// Calls thenDo(null, envelope | null).
function getRecoveryWorldForDid(did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT envelope FROM objects WHERE did = ? AND type = \'recovery\' ORDER BY id DESC LIMIT 1',
      [did],
      function(err, row) {
        if (err) return thenDo(err);
        if (!row) return thenDo(null, null);
        try { thenDo(null, JSON.parse(row.envelope)); }
        catch (e) { thenDo(new Error('ObjectRepository.getRecoveryWorldForDid: corrupt envelope JSON')); }
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
      'SELECT cid, prev_cid, created_at, json_extract(envelope, \'$.state.name\') AS name ' +
      'FROM objects WHERE obj_id = ? ORDER BY id ASC',
      [objId],
      function(err, rows) {
        if (err) return thenDo(err);
        thenDo(null, rows.map(function(r) {
          return { cid: r.cid, prevCid: r.prev_cid, createdAt: r.created_at, name: r.name };
        }));
      }
    );
  });
}

// Grant read access to an additional recipient DID on the latest version of
// an object, by appending to record.recipients in place.
//
// Recipients here are an access-control concept only — they gate the
// GET /@:handle/:objId visibility check in IdentityServer.js. They are NOT
// part of the cid hash domain (cid = hash(record.payload) only — see
// SignedSerializer.js / Crypto.computeCid), so granting access cannot be
// represented as a new content-addressed version: the cid would be
// unchanged and collide with idx_obj_cid (obj_id, cid). This updates the
// latest row in place instead of inserting a new version.
//
// For encrypted ('private'/'shared') objects, this only grants the
// recipient permission to fetch the envelope over HTTP — it does not wrap
// a decryption key for them. Actually decrypting requires the owner's
// client to seal a key copy (Crypto.sealForRecipient) and PUT a new
// envelope version; that is out of scope for this ACL-only helper.
//
// Calls thenDo(err, envelope) with the updated envelope.
function addRecipient(objId, recipientDid, thenDo) {
  get(objId, function(err, envelope) {
    if (err) return thenDo(err);
    if (!envelope) return thenDo(new Error('addRecipient: object not found: ' + objId));

    if (!envelope.record.recipients) envelope.record.recipients = [];
    var already = envelope.record.recipients.some(function(r) {
      return (r.did || r) === recipientDid;
    });
    if (already) return thenDo(null, envelope);

    envelope.record.recipients.push({ did: recipientDid });
    if (envelope.visibility === 'private') envelope.visibility = 'shared';

    _updateInPlace(envelope, thenDo);
  });
}

// Delete all versions of an object that were written after the given cid.
// Used by the revert UI to roll back to a known-good snapshot.
// Calls thenDo(err, { deleted }) where deleted is the row count removed.
function deleteVersionsAfter(objId, cid, thenDo) {
  withDB(function (err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT id FROM objects WHERE obj_id = ? AND cid = ?',
      [objId, cid],
      function (err, row) {
        if (err)  return thenDo(err);
        if (!row) return thenDo(new Error('deleteVersionsAfter: version not found: ' + cid));
        db.run(
          'DELETE FROM objects WHERE obj_id = ? AND id > ?',
          [objId, row.id],
          function (err) {
            if (err) return thenDo(err);
            thenDo(null, { deleted: this.changes });
          }
        );
      }
    );
  });
}

// ─── post card queries ────────────────────────────────────────────────────────

// List the latest postcard envelope per objId for a given DID, newest first.
// Excludes deleted cards (state.deleted = true) from the listing.
// opts: { limit: Number, cursor: String|null }
//   cursor is the obj_id of the last item from the previous page (opaque to callers).
// Calls thenDo(null, { postcards: [envelope...], cursor: String|null }).
function listPostcardsForUser(did, opts, thenDo) {
  var limit = (opts && opts.limit) || 20;
  var cursor = (opts && opts.cursor) || null;

  withDB(function(err, db) {
    if (err) return thenDo(err);

    // Base query: latest row per obj_id for this DID, type=postcard, not deleted
    var baseSql =
      'SELECT o.envelope, o.obj_id, o.id FROM objects o' +
      ' INNER JOIN (' +
      '   SELECT obj_id, MAX(id) AS max_id FROM objects' +
      '   WHERE did = ? AND type = \'postcard\'' +
      '   GROUP BY obj_id' +
      ' ) latest ON o.id = latest.max_id' +
      ' WHERE (json_extract(o.envelope, \'$.state.deleted\') IS NULL' +
      '        OR json_extract(o.envelope, \'$.state.deleted\') != 1)';

    var params, sql;
    if (cursor) {
      // Pagination: find the id of the cursor row, then take rows with id < that
      db.get(
        'SELECT MAX(id) AS pivot FROM objects WHERE obj_id = ? AND did = ?',
        [cursor, did],
        function(err, pivotRow) {
          if (err) return thenDo(err);
          var pivotId = pivotRow ? pivotRow.pivot : null;
          if (pivotId) {
            sql = baseSql + ' AND o.id < ? ORDER BY o.id DESC LIMIT ?';
            params = [did, pivotId, limit + 1];
          } else {
            sql = baseSql + ' ORDER BY o.id DESC LIMIT ?';
            params = [did, limit + 1];
          }
          _runPostcardQuery(db, sql, params, limit, thenDo);
        }
      );
    } else {
      sql = baseSql + ' ORDER BY o.id DESC LIMIT ?';
      params = [did, limit + 1];
      _runPostcardQuery(db, sql, params, limit, thenDo);
    }
  });
}

// List the latest postcard envelopes for a constellation, newest first.
// opts: { limit, cursor } — same pagination shape as listPostcardsForUser.
// Calls thenDo(null, { postcards: [envelopeMetadata...], cursor: String|null }).
function listPostcardsForConstellation(constellation, opts, thenDo) {
  var limit = (opts && opts.limit) || 20;
  var cursor = (opts && opts.cursor) || null;

  withDB(function(err, db) {
    if (err) return thenDo(err);

    var baseSql =
      'SELECT o.envelope, o.obj_id, o.id FROM objects o' +
      ' INNER JOIN (' +
      '   SELECT obj_id, MAX(id) AS max_id FROM objects' +
      '   WHERE type = \'postcard\'' +
      '         AND json_extract(envelope, \'$.constellation\') = ?' +
      '   GROUP BY obj_id' +
      ' ) latest ON o.id = latest.max_id' +
      ' WHERE (json_extract(o.envelope, \'$.state.deleted\') IS NULL' +
      '        OR json_extract(o.envelope, \'$.state.deleted\') != 1)';

    var params, sql;
    if (cursor) {
      db.get(
        'SELECT MAX(id) AS pivot FROM objects WHERE obj_id = ?' +
        '  AND type = \'postcard\'',
        [cursor],
        function(err, pivotRow) {
          if (err) return thenDo(err);
          var pivotId = pivotRow ? pivotRow.pivot : null;
          if (pivotId) {
            sql = baseSql + ' AND o.id < ? ORDER BY o.id DESC LIMIT ?';
            params = [constellation, pivotId, limit + 1];
          } else {
            sql = baseSql + ' ORDER BY o.id DESC LIMIT ?';
            params = [constellation, limit + 1];
          }
          _runPostcardQuery(db, sql, params, limit, thenDo);
        }
      );
    } else {
      sql = baseSql + ' ORDER BY o.id DESC LIMIT ?';
      params = [constellation, limit + 1];
      _runPostcardQuery(db, sql, params, limit, thenDo);
    }
  });
}

// List reply envelopes for a parent objId (postcards whose replyTo.objId matches).
// Returns metadata-only (no payload) for the listing; caller fetches full envelope on open.
// Visibility filtering is the caller's responsibility (done in the route handler).
// Calls thenDo(null, { replies: [envelopeMetadata...], cursor: String|null }).
function listRepliesForPostcard(parentObjId, opts, thenDo) {
  var limit = (opts && opts.limit) || 20;
  var cursor = (opts && opts.cursor) || null;

  withDB(function(err, db) {
    if (err) return thenDo(err);

    var baseSql =
      'SELECT o.envelope, o.obj_id, o.id FROM objects o' +
      ' INNER JOIN (' +
      '   SELECT obj_id, MAX(id) AS max_id FROM objects' +
      '   WHERE type = \'postcard\'' +
      '         AND json_extract(envelope, \'$.replyTo.objId\') = ?' +
      '   GROUP BY obj_id' +
      ' ) latest ON o.id = latest.max_id' +
      ' WHERE (json_extract(o.envelope, \'$.state.deleted\') IS NULL' +
      '        OR json_extract(o.envelope, \'$.state.deleted\') != 1)';

    var params = [parentObjId, limit + 1];
    if (cursor) {
      db.get(
        'SELECT MAX(id) AS pivot FROM objects WHERE obj_id = ? AND type = \'postcard\'',
        [cursor],
        function(err, pivotRow) {
          if (err) return thenDo(err);
          var pivotId = pivotRow ? pivotRow.pivot : null;
          if (pivotId) {
            _runPostcardQuery(db,
              baseSql + ' AND o.id < ? ORDER BY o.id DESC LIMIT ?',
              [parentObjId, pivotId, limit + 1], limit, thenDo);
          } else {
            _runPostcardQuery(db, baseSql + ' ORDER BY o.id DESC LIMIT ?', params, limit, thenDo);
          }
        }
      );
    } else {
      _runPostcardQuery(db, baseSql + ' ORDER BY o.id DESC LIMIT ?', params, limit, thenDo);
    }
  });
}

// Shared helper: runs a postcard listing SQL query and shapes the result into
// { postcards: [metadataOnly...], cursor } (spec §7.1 feed shape).
function _runPostcardQuery(db, sql, params, limit, thenDo) {
  db.all(sql, params, function(err, rows) {
    if (err) return thenDo(err);
    var hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    var postcards = rows.map(function(r) {
      try {
        var env = JSON.parse(r.envelope);
        // Return metadata only — not the full payload (spec §7.1)
        return {
          objId:   env.objId,
          did:     env.did,
          state:   env.state || {},
          record:  { cid: env.record && env.record.cid },
          created: env.created,
          constellation: env.constellation || null,
          replyTo: env.replyTo || null,
          visibility: env.visibility || 'public',
          recipients: (env.record && env.record.recipients) || []
        };
      } catch (e) { return null; }
    }).filter(Boolean);
    var nextCursor = hasMore ? rows[rows.length - 1].obj_id : null;
    thenDo(null, { postcards: postcards, cursor: nextCursor });
  });
}

// ─── settings ─────────────────────────────────────────────────────────────────

// Get the settings envelope for a DID. Returns null if none exists yet.
// The caller should create a default settings envelope if null is returned.
// Calls thenDo(null, envelope | null).
function getSettingsForDid(did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT envelope FROM objects WHERE did = ? AND type = \'settings\' ORDER BY id DESC LIMIT 1',
      [did],
      function(err, row) {
        if (err) return thenDo(err);
        if (!row) return thenDo(null, null);
        try { thenDo(null, JSON.parse(row.envelope)); }
        catch (e) { thenDo(new Error('ObjectRepository.getSettingsForDid: corrupt JSON')); }
      }
    );
  });
}

// ─── inbox ────────────────────────────────────────────────────────────────────

// Inbox records are stored as a per-handle newline-delimited JSON log
// (not in objects.db — delivery references, not versioned envelopes).
// Location: <WORKSPACE_LK>/identity/inbox/<handle>.jsonl

var _inboxDir = null;
function _getInboxDir() {
  if (_inboxDir) return _inboxDir;
  _inboxDir = path.join(
    process.env.WORKSPACE_LK || process.cwd(),
    'identity', 'inbox'
  );
  return _inboxDir;
}

// Append a delivery record to a recipient's inbox.
// record: { objId, senderDid, sentAt }
// Calls thenDo(err).
function putInboxRecord(recipientHandle, record, thenDo) {
  var fs = require('fs');
  var dir = _getInboxDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  var file = path.join(dir, recipientHandle + '.jsonl');
  var line = JSON.stringify(record) + '\n';
  fs.appendFile(file, line, function(err) { thenDo(err || null); });
}

// List delivery records for a handle, newest first, paginated.
// opts: { limit, offset }
// Calls thenDo(null, { records: [...], cursor: Number|null }).
function listInboxForHandle(handle, opts, thenDo) {
  var fs = require('fs');
  var limit = (opts && opts.limit) || 20;
  var offset = (opts && opts.offset) || 0;
  var file = path.join(_getInboxDir(), handle + '.jsonl');
  if (!fs.existsSync(file)) return thenDo(null, { records: [], cursor: null });
  fs.readFile(file, 'utf8', function(err, text) {
    if (err) return thenDo(err);
    var lines = text.split('\n').filter(Boolean);
    lines.reverse(); // newest first
    var page = lines.slice(offset, offset + limit);
    var records = page.map(function(l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
    var nextOffset = offset + limit < lines.length ? offset + limit : null;
    thenDo(null, { records: records, cursor: nextOffset });
  });
}

// ─── deliveries (sender-side outbound log) ────────────────────────────────────
//
// Mirrors the inbox pattern: a per-sender newline-delimited JSON log.
// Location: <WORKSPACE_LK>/identity/deliveries/<senderHandle>.jsonl
// Each record: { objId, recipientHandle, sentAt, status: 'delivered'|'returned' }
//
// The status field matches the postal model in PostcardDesignSpec.md §2.3:
//   'delivered' — POST /@:handle/inbox succeeded (recipient accepted the card)
//   'returned'  — server returned the postal rejection (blocked/unknown handle)
//
// The reason for a 'returned' delivery is never stored — per the spec's
// anti-leak invariant the sender already knows the postal response text and
// recording a richer reason here would not add information they don't have.

var _deliveriesDir = null;
function _getDeliveriesDir() {
  if (_deliveriesDir) return _deliveriesDir;
  _deliveriesDir = path.join(
    process.env.WORKSPACE_LK || process.cwd(),
    'identity', 'deliveries'
  );
  return _deliveriesDir;
}

// Append an outbound delivery record to the sender's deliveries log.
// record: { objId, recipientHandle, sentAt, status: 'delivered'|'returned' }
// Calls thenDo(err). Fire-and-forget safe — never blocks the HTTP response.
function putDeliveryRecord(senderHandle, record, thenDo) {
  var fs  = require('fs');
  var dir = _getDeliveriesDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  var file = path.join(dir, senderHandle + '.jsonl');
  var line = JSON.stringify(record) + '\n';
  fs.appendFile(file, line, function (err) { thenDo(err || null); });
}

// List outbound delivery records for a sender, newest first, paginated.
// opts: { limit, offset, status }  — status filters to 'delivered' or 'returned' when set.
// Calls thenDo(null, { records: [...], cursor: Number|null }).
function listDeliveriesForHandle(senderHandle, opts, thenDo) {
  var fs     = require('fs');
  var limit  = (opts && opts.limit)  || 20;
  var offset = (opts && opts.offset) || 0;
  var status = (opts && opts.status) || null;
  var file   = path.join(_getDeliveriesDir(), senderHandle + '.jsonl');
  if (!fs.existsSync(file)) return thenDo(null, { records: [], cursor: null });
  fs.readFile(file, 'utf8', function (err, text) {
    if (err) return thenDo(err);
    var lines = text.split('\n').filter(Boolean);
    lines.reverse(); // newest first
    var records = lines.map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
    if (status) records = records.filter(function (r) { return r.status === status; });
    var page       = records.slice(offset, offset + limit);
    var nextOffset = offset + limit < records.length ? offset + limit : null;
    thenDo(null, { records: page, cursor: nextOffset });
  });
}

module.exports = {
  withDB:                        withDB,
  put:                           put,
  get:                           get,
  getVersion:                    getVersion,
  getVersionsSince:              getVersionsSince,
  listForUser:                   listForUser,
  getProfileForDid:              getProfileForDid,
  getRecoveryWorldForDid:        getRecoveryWorldForDid,
  getSettingsForDid:             getSettingsForDid,
  listVersions:                  listVersions,
  deleteVersionsAfter:           deleteVersionsAfter,
  addRecipient:                  addRecipient,
  listPostcardsForUser:          listPostcardsForUser,
  listPostcardsForConstellation: listPostcardsForConstellation,
  listRepliesForPostcard:        listRepliesForPostcard,
  putInboxRecord:                putInboxRecord,
  listInboxForHandle:            listInboxForHandle,
  putDeliveryRecord:             putDeliveryRecord,
  listDeliveriesForHandle:       listDeliveriesForHandle,
};
