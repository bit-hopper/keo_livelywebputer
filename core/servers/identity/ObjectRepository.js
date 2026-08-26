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
 *   blob_refs table — which file envelope(s) a BlobStore cid belongs to
 *   (Encryption.md §5.3), so the blob GET route can find the gating envelope
 *   without being able to decrypt it:
 *     blob_cid TEXT NOT NULL
 *     obj_id   TEXT NOT NULL
 *     PRIMARY KEY (blob_cid, obj_id)
 *
 *   postcard_reactions table — one reaction per (obj_id, did), replacing on
 *   re-react (PostcardDesignSpec-v2.md §5.1). Lives outside the envelope so
 *   it can still be written on an immutable, already-sent postcard:
 *     obj_id     TEXT NOT NULL
 *     did        TEXT NOT NULL
 *     emoji      TEXT NOT NULL
 *     created_at TEXT NOT NULL
 *     PRIMARY KEY (obj_id, did)
 *
 *   part_aliases table — human-readable name -> current objId, per author
 *   (Roadmap.md §3, "Phase 2 — Parts Name Aliasing"). One name per (did,
 *   alias_name); republishing a part under the same name repoints it. Kept
 *   up to date by put() itself (see below) rather than a separate write
 *   path, so nothing client-side needs to know this table exists:
 *     did         TEXT NOT NULL
 *     alias_name  TEXT NOT NULL
 *     obj_id      TEXT NOT NULL
 *     updated_at  TEXT NOT NULL
 *     PRIMARY KEY (did, alias_name)
 *
 * The latest version of an object is the row with the highest id for a
 * given obj_id. No DELETE ever happens on `objects` — that log is
 * append-only (postcard_reactions rows are deleted freely on un-react).
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
      db.run('CREATE INDEX IF NOT EXISTS idx_did ON objects(did)');
      // blob_refs (Encryption.md §5.3): which file envelope(s) a blob's cid
      // belongs to, so GET /@:handle/blobs/:cid can find the gating envelope
      // to run _canReadEnvelope against without being able to decrypt it.
      db.run(
        'CREATE TABLE IF NOT EXISTS blob_refs (' +
        '  blob_cid TEXT NOT NULL,' +
        '  obj_id   TEXT NOT NULL,' +
        '  PRIMARY KEY (blob_cid, obj_id)' +
        ')'
      );
      // postcard_reactions (PostcardDesignSpec-v2.md §5.1): one reaction per
      // (obj_id, did) — PRIMARY KEY on the pair, not including emoji, is what
      // makes reacting again a REPLACE rather than a second row, matching
      // Misskey's "picking a new emoji replaces your old one" semantics. A
      // side table rather than an envelope field because reactions must work
      // on immutable, already-frozen sent cards (§2.5).
      db.run(
        'CREATE TABLE IF NOT EXISTS postcard_reactions (' +
        '  obj_id     TEXT NOT NULL,' +
        '  did        TEXT NOT NULL,' +
        '  emoji      TEXT NOT NULL,' +
        '  created_at TEXT NOT NULL,' +
        '  PRIMARY KEY (obj_id, did)' +
        ')'
      );
      // postcard_mailbox_hidden (PostcardDesignSpec-v2.md §6.3, "Layer 1"):
      // a per-viewer hide, independent of the envelope entirely — used for
      // delivered cards (inbox/deliveries), where a global tombstone would
      // wrongly remove the card from every other party's view too. Whose
      // mailbox a hide applies to is `did`, not necessarily the card's
      // author or any recipient in particular.
      db.run(
        'CREATE TABLE IF NOT EXISTS postcard_mailbox_hidden (' +
        '  did       TEXT NOT NULL,' +
        '  obj_id    TEXT NOT NULL,' +
        '  hidden_at TEXT NOT NULL,' +
        '  PRIMARY KEY (did, obj_id)' +
        ')'
      );
      // part_aliases (Roadmap.md §3): human-readable part name -> objId,
      // scoped per author. Written by put() itself whenever a type:'part'
      // envelope carries a state.partName (see put() below).
      db.run(
        'CREATE TABLE IF NOT EXISTS part_aliases (' +
        '  did        TEXT NOT NULL,' +
        '  alias_name TEXT NOT NULL,' +
        '  obj_id     TEXT NOT NULL,' +
        '  updated_at TEXT NOT NULL,' +
        '  PRIMARY KEY (did, alias_name)' +
        ')', function(err) {
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

  // Keep part_aliases in sync with every successful put() of a named part,
  // regardless of which path below handled it (new version, in-place
  // metadata update, or true no-op duplicate) — upserting is idempotent, so
  // it's simplest and safest to always run it here rather than duplicate
  // this at each call site. A failure here logs but never fails the put()
  // itself; the alias is a resolution convenience, not the object record.
  var callerThenDo = thenDo;
  thenDo = function(err, result) {
    if (err || envelope.type !== 'part' || !envelope.state || !envelope.state.partName) {
      return callerThenDo(err, result);
    }
    upsertPartAlias(envelope.did, envelope.state.partName, envelope.objId, function(aliasErr) {
      if (aliasErr) console.warn('[ObjectRepository] Failed to upsert part_aliases for', envelope.objId, ':', aliasErr.message);
      callerThenDo(err, result);
    });
  };

  get(envelope.objId, function(err, existing) {
    if (err) return thenDo(err);

    if (existing && existing.record.cid === envelope.record.cid) {
      var metadataChanged =
        existing.visibility !== envelope.visibility ||
        existing.constellation !== envelope.constellation ||
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
          _addBlobRefIfFile(db, envelope, function() {
            thenDo(null, { id: this.lastID, objId: envelope.objId, cid: envelope.record.cid, changed: 'content' });
          }.bind(this));
        }
      );
    });
  });
}

// File envelopes carry a top-level (plaintext, server-consumed) `blobCid`
// field — for private files the server can't read blobCid out of the
// ciphertext payload, so the client duplicates it outside `record` (the
// encrypted copy inside the payload is the one the client trusts; see
// Encryption.md §5.3). Indexes it in blob_refs so the blob GET route can find
// the gating envelope. Errors are logged, not fatal — worst case a blob
// lookup 404s and the client retries the envelope PUT.
function _addBlobRefIfFile(db, envelope, thenDo) {
  if (envelope.type !== 'file' || !envelope.blobCid) return thenDo();
  db.run(
    'INSERT OR IGNORE INTO blob_refs (blob_cid, obj_id) VALUES (?, ?)',
    [envelope.blobCid, envelope.objId],
    function(err) {
      if (err) console.warn('[ObjectRepository] Failed to index blob_refs for', envelope.objId, ':', err.message);
      thenDo();
    }
  );
}

// Which obj_ids reference a given blob cid (a blob may be referenced by more
// than one envelope only in edge cases like a duplicate upload — normally
// exactly one). Calls thenDo(null, objId[]).
function getObjIdsForBlob(blobCid, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all('SELECT obj_id FROM blob_refs WHERE blob_cid = ?', [blobCid], function(err, rows) {
      if (err) return thenDo(err);
      thenDo(null, rows.map(function(r) { return r.obj_id; }));
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

// List the latest version of every public part, newest first, optionally
// filtered by a partName substring or exact objId match. Same "latest per
// obj_id" join pattern as listForUser/listPostcardsNearby, but scoped to
// type='part' AND visibility='public' across ALL authors instead of one
// did — the cross-user index type/part never had (unlike constellations'
// listPublic or postcards' listPostcardsNearby, which this mirrors).
// Metadata only (no payload/htmlLogo) — callers fetch the full envelope
// via the existing GET /@:handle/:objId route when actually opening a
// result, same lazy-load split every other listing here already uses.
// opts: { limit, cursor, q }
// Calls thenDo(null, { parts: envelopeMetadata[], cursor: String|null }).
function listPublicParts(opts, thenDo) {
  var limit = (opts && opts.limit) || 20;
  var cursor = (opts && opts.cursor) || null;
  var q = (opts && opts.q) || null;

  withDB(function (err, db) {
    if (err) return thenDo(err);

    function withPivot(cb) {
      if (!cursor) return cb(null, null);
      db.get(
        'SELECT MAX(id) AS pivot FROM objects WHERE obj_id = ? AND type = \'part\'',
        [cursor],
        function (err, row) { cb(err, row ? row.pivot : null); }
      );
    }

    withPivot(function (err, pivotId) {
      if (err) return thenDo(err);
      var conditions = [];
      var params = [];
      if (q) {
        conditions.push('(json_extract(o.envelope, \'$.state.partName\') LIKE ? ESCAPE \'\\\' OR o.obj_id = ?)');
        params.push('%' + _escapeLikePrefix(q) + '%', q);
      }
      if (pivotId) {
        conditions.push('o.id < ?');
        params.push(pivotId);
      }
      var whereExtra = conditions.length ? ' AND ' + conditions.join(' AND ') : '';
      var sql =
        'SELECT o.envelope, o.obj_id, o.id FROM objects o' +
        ' INNER JOIN (' +
        '   SELECT obj_id, MAX(id) AS max_id FROM objects' +
        '   WHERE type = \'part\' AND visibility = \'public\'' +
        '   GROUP BY obj_id' +
        ' ) latest ON o.id = latest.max_id' +
        ' WHERE 1=1' + whereExtra +
        ' ORDER BY o.id DESC LIMIT ?';
      params.push(limit + 1);

      db.all(sql, params, function (err, rows) {
        if (err) return thenDo(err);
        var hasMore = rows.length > limit;
        if (hasMore) rows = rows.slice(0, limit);
        var parts = rows.map(function (r) {
          try {
            var env = JSON.parse(r.envelope);
            var state = env.state || {};
            return {
              objId: env.objId,
              did: env.did,
              // htmlLogo deliberately omitted — unlike a postcard's state,
              // a part's state.htmlLogo is a full rendered-HTML snapshot
              // (multiple KB per row), which would make a 20-40 row
              // listing response heavy for no reason. Full envelope
              // (htmlLogo included) is one GET /@:handle/:objId away once
              // a specific result is actually opened.
              state: { partName: state.partName, comment: state.comment, tags: state.tags },
              record: { cid: env.record && env.record.cid },
              created: env.created,
              visibility: env.visibility || 'public'
            };
          } catch (e) { return null; }
        }).filter(Boolean);
        var nextCursor = hasMore ? rows[rows.length - 1].obj_id : null;
        thenDo(null, { parts: parts, cursor: nextCursor });
      });
    });
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
// opts: { limit: Number, cursor: String|null, q: String|null }
//   cursor is the obj_id of the last item from the previous page (opaque to callers).
//   q — optional title substring filter (§8.1); metadata search only, never
//   record.payload (private/shared payload is ciphertext the server can't
//   search anyway; public payload content-indexing is a standing non-goal).
// Calls thenDo(null, { postcards: [envelope...], cursor: String|null }).
function listPostcardsForUser(did, opts, thenDo) {
  var limit = (opts && opts.limit) || 20;
  var cursor = (opts && opts.cursor) || null;
  var q = (opts && opts.q) || null;
  var qLike = q ? '%' + _escapeLikePrefix(q) + '%' : null;

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
      '        OR json_extract(o.envelope, \'$.state.deleted\') != 1)' +
      // Replies (postcards carrying a replyTo, posted from a comment
      // thread) are not top-level postcards — they belong only in
      // listRepliesForPostcard's own listing, never mixed into a
      // did/constellation's main feed alongside genuine top-level cards.
      '        AND json_extract(o.envelope, \'$.replyTo.objId\') IS NULL' +
      (qLike ? ' AND json_extract(o.envelope, \'$.state.title\') LIKE ? ESCAPE \'\\\'' : '');

    var params, sql;
    if (cursor) {
      // Pagination: find the id of the cursor row, then take rows with id < that
      db.get(
        'SELECT MAX(id) AS pivot FROM objects WHERE obj_id = ? AND did = ?',
        [cursor, did],
        function(err, pivotRow) {
          if (err) return thenDo(err);
          var pivotId = pivotRow ? pivotRow.pivot : null;
          var qParams = qLike ? [qLike] : [];
          if (pivotId) {
            sql = baseSql + ' AND o.id < ? ORDER BY o.id DESC LIMIT ?';
            params = [did].concat(qParams, [pivotId, limit + 1]);
          } else {
            sql = baseSql + ' ORDER BY o.id DESC LIMIT ?';
            params = [did].concat(qParams, [limit + 1]);
          }
          _runPostcardQuery(db, sql, params, limit, thenDo);
        }
      );
    } else {
      sql = baseSql + ' ORDER BY o.id DESC LIMIT ?';
      params = qLike ? [did, qLike, limit + 1] : [did, limit + 1];
      _runPostcardQuery(db, sql, params, limit, thenDo);
    }
  });
}

// List the latest postcard envelopes for a constellation, newest first.
// opts: { limit, cursor, q } — same pagination/search shape as
// listPostcardsForUser (q filters on state.title, LIKE-style).
// Calls thenDo(null, { postcards: [envelopeMetadata...], cursor: String|null }).
function listPostcardsForConstellation(constellation, opts, thenDo) {
  var limit = (opts && opts.limit) || 20;
  var cursor = (opts && opts.cursor) || null;
  var q = (opts && opts.q) || null;
  var qLike = q ? '%' + _escapeLikePrefix(q) + '%' : null;

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
      '        OR json_extract(o.envelope, \'$.state.deleted\') != 1)' +
      // System-generated cards (join requests riding the same postal rail
      // as everything else, ConstellationDesignSpec.md §4.2) belong in
      // controllers' inboxes, not the public constellation feed. Room-level
      // join requests (state.kind:'room-join-request', see
      // ConstellationLounge.js's _requestRoomAccess) ride the same rail and
      // were missing from this exclusion, so they rendered as ordinary
      // postcards in the feed. Room chat messages (state.kind:'room-message',
      // RoomView.js, see listMessagesForRoom below) ride it too — same
      // exclusion, or every chat line would flood the constellation's
      // public postcard reel.
      '        AND (json_extract(o.envelope, \'$.state.kind\') IS NULL' +
      '             OR json_extract(o.envelope, \'$.state.kind\') NOT IN' +
      '                 (\'constellation-join-request\', \'room-join-request\', \'room-message\'))' +
      // Replies (comment-thread postcards carrying a replyTo) are not
      // top-level postcards either — confirmed live via objects.db that
      // every reply also carries this constellation's name, so without
      // this filter every comment-thread reply doubled as its own entry
      // in the postcard turnover reel (ConstellationLounge.js's _fetchFeed).
      // listRepliesForPostcard below is the only listing that should ever
      // surface them.
      '        AND json_extract(o.envelope, \'$.replyTo.objId\') IS NULL' +
      (qLike ? ' AND json_extract(o.envelope, \'$.state.title\') LIKE ? ESCAPE \'\\\'' : '');

    var params, sql;
    if (cursor) {
      db.get(
        'SELECT MAX(id) AS pivot FROM objects WHERE obj_id = ?' +
        '  AND type = \'postcard\'',
        [cursor],
        function(err, pivotRow) {
          if (err) return thenDo(err);
          var pivotId = pivotRow ? pivotRow.pivot : null;
          var qParams = qLike ? [qLike] : [];
          if (pivotId) {
            sql = baseSql + ' AND o.id < ? ORDER BY o.id DESC LIMIT ?';
            params = [constellation].concat(qParams, [pivotId, limit + 1]);
          } else {
            sql = baseSql + ' ORDER BY o.id DESC LIMIT ?';
            params = [constellation].concat(qParams, [limit + 1]);
          }
          _runPostcardQuery(db, sql, params, limit, thenDo);
        }
      );
    } else {
      sql = baseSql + ' ORDER BY o.id DESC LIMIT ?';
      params = qLike ? [constellation, qLike, limit + 1] : [constellation, limit + 1];
      _runPostcardQuery(db, sql, params, limit, thenDo);
    }
  });
}

// List the latest room-message postcard envelopes for a room, newest first
// — same "latest version per obj_id" join shape as listPostcardsForConstellation
// (RoomView.js's chat rides the same objects-table/postal rail every other
// postcard uses: state.kind:'room-message', state.roomId:<roomId>, rather
// than a dedicated messages table), scoped to a roomId instead of a
// constellation. Metadata only (state.title, the auto-extracted first-block
// text — plenty for a short chat line, capped at 200 chars same as any
// other postcard's title extraction) — no separate payload fetch needed per
// message, keeping a chat page's listing call as cheap as any other feed
// listing here.
// opts: { limit, cursor } — same pagination shape as listPostcardsForConstellation.
// Calls thenDo(null, { postcards: [envelopeMetadata...], cursor: String|null }).
function listMessagesForRoom(roomId, opts, thenDo) {
  var limit = (opts && opts.limit) || 50;
  var cursor = (opts && opts.cursor) || null;

  withDB(function(err, db) {
    if (err) return thenDo(err);

    var baseSql =
      'SELECT o.envelope, o.obj_id, o.id FROM objects o' +
      ' INNER JOIN (' +
      '   SELECT obj_id, MAX(id) AS max_id FROM objects' +
      '   WHERE type = \'postcard\'' +
      '         AND json_extract(envelope, \'$.state.kind\') = \'room-message\'' +
      '         AND json_extract(envelope, \'$.state.roomId\') = ?' +
      '   GROUP BY obj_id' +
      ' ) latest ON o.id = latest.max_id' +
      ' WHERE (json_extract(o.envelope, \'$.state.deleted\') IS NULL' +
      '        OR json_extract(o.envelope, \'$.state.deleted\') != 1)';

    var params, sql;
    if (cursor) {
      db.get(
        'SELECT MAX(id) AS pivot FROM objects WHERE obj_id = ? AND type = \'postcard\'',
        [cursor],
        function(err, pivotRow) {
          if (err) return thenDo(err);
          var pivotId = pivotRow ? pivotRow.pivot : null;
          if (pivotId) {
            sql = baseSql + ' AND o.id < ? ORDER BY o.id DESC LIMIT ?';
            params = [roomId, pivotId, limit + 1];
          } else {
            sql = baseSql + ' ORDER BY o.id DESC LIMIT ?';
            params = [roomId, limit + 1];
          }
          _runPostcardQuery(db, sql, params, limit, thenDo);
        }
      );
    } else {
      sql = baseSql + ' ORDER BY o.id DESC LIMIT ?';
      params = [roomId, limit + 1];
      _runPostcardQuery(db, sql, params, limit, thenDo);
    }
  });
}

// Looks up a wiki page's objId by name within a constellation (a wiki page
// is a type: 'wikipage' envelope, addressed by state.wikiName). Used by
// GET /c/:name/wiki/:pageName to resolve a human-friendly page name to the
// objId every other read/write route already operates on — wiki pages
// remain addressable both ways (by name here, or directly via
// /@handle/objId or /c/:name/objId), per the original ontology. Callers
// still need a follow-up get(objId, ...) for the full envelope — this only
// resolves the name, same division of labor as every other lookup-then-get
// pattern in this module.
// Calls thenDo(null, objId | null).
function getWikiPageObjId(constellation, wikiName, thenDo) {
  withDB(function (err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT o.obj_id FROM objects o' +
      ' INNER JOIN (' +
      '   SELECT obj_id, MAX(id) AS max_id FROM objects' +
      '   WHERE type = \'wikipage\'' +
      '         AND json_extract(envelope, \'$.constellation\') = ?' +
      '         AND json_extract(envelope, \'$.state.wikiName\') = ?' +
      '   GROUP BY obj_id' +
      ' ) latest ON o.id = latest.max_id' +
      ' WHERE (json_extract(o.envelope, \'$.state.deleted\') IS NULL' +
      '        OR json_extract(o.envelope, \'$.state.deleted\') != 1)' +
      ' ORDER BY o.id DESC LIMIT 1',
      [constellation, wikiName],
      function (err, row) {
        if (err) return thenDo(err);
        thenDo(null, row ? row.obj_id : null);
      }
    );
  });
}

// Lists the latest version of every wiki page in a constellation, for the
// wiki index (GET /c/:name/wiki). Same "latest version per obj_id" join
// shape as listPostcardsForConstellation, filtered on type = 'wikipage'
// instead. No pagination — wiki-page counts per constellation are small;
// add it if that stops being true.
// updatedAt is the latest version row's created_at (an edit is a new row,
// see WikiSerializer.js); createdAt is a second join on the same obj_id
// grouping by MIN(created_at) instead of MAX(id) — the genesis row's own
// timestamp, which the "latest version" join above discards. Both are
// needed so the wiki index's sort-by dropdown (WikiIndex.js) can offer
// "last modified" and "last created" as genuinely different orderings —
// for a page that's never been edited the two are equal anyway.
// category/tags are pulled the same way listWikiPagesForUser's version
// below does — WikiIndex.js's right-hand categories/tags panel needs them
// for constellation-scoped wikis too, not just personal ones.
// Calls thenDo(null, [{ objId, wikiName, category, tags, updatedAt, createdAt }, ...]).
function listWikiPages(constellation, thenDo) {
  withDB(function (err, db) {
    if (err) return thenDo(err);
    db.all(
      'SELECT o.obj_id, o.created_at AS updated_at, genesis.created_at AS created_at,' +
      '       json_extract(o.envelope, \'$.state.wikiName\') AS wiki_name,' +
      '       json_extract(o.envelope, \'$.state.category\') AS category,' +
      '       json_extract(o.envelope, \'$.state.tags\') AS tags_json' +
      ' FROM objects o' +
      ' INNER JOIN (' +
      '   SELECT obj_id, MAX(id) AS max_id FROM objects' +
      '   WHERE type = \'wikipage\'' +
      '         AND json_extract(envelope, \'$.constellation\') = ?' +
      '   GROUP BY obj_id' +
      ' ) latest ON o.id = latest.max_id' +
      ' INNER JOIN (' +
      '   SELECT obj_id, MIN(created_at) AS created_at FROM objects' +
      '   WHERE type = \'wikipage\'' +
      '         AND json_extract(envelope, \'$.constellation\') = ?' +
      '   GROUP BY obj_id' +
      ' ) genesis ON genesis.obj_id = o.obj_id' +
      ' WHERE (json_extract(o.envelope, \'$.state.deleted\') IS NULL' +
      '        OR json_extract(o.envelope, \'$.state.deleted\') != 1)' +
      ' ORDER BY wiki_name ASC',
      [constellation, constellation],
      function (err, rows) {
        if (err) return thenDo(err);
        thenDo(null, (rows || []).map(function (r) {
          var tags = [];
          if (r.tags_json) {
            try { tags = JSON.parse(r.tags_json) || []; } catch (e) { tags = []; }
          }
          return {
            objId: r.obj_id, wikiName: r.wiki_name, category: r.category || null, tags: tags,
            updatedAt: r.updated_at, createdAt: r.created_at,
          };
        }));
      }
    );
  });
}

// Personal (home-world) counterpart to getWikiPageObjId — resolves a wiki
// page by human-friendly name under a user's own did, instead of within a
// constellation. Same "latest version per obj_id" shape, keyed on the did
// column directly (no json_extract needed for it, unlike constellation
// which only lives inside the envelope JSON) instead of
// json_extract(envelope,'$.constellation').
//
// constellation IS NULL is a real, load-bearing filter here, not a no-op:
// this did may also own constellation-scoped wikipage envelopes (authored
// as a member with write access, or in a constellation they control) —
// those belong to the constellation, not to this user's personal wiki, and
// must not resolve/list here. Confirmed live: without this filter,
// getWikiPageObjIdForUser/listWikiPagesForUser below returned every
// wikipage envelope this did ever authored regardless of constellation,
// which put a constellation's test pages in the personal index. constella-
// tion is fixed at genesis and never changes across a page's versions (see
// WikiSerializer.js), so filtering it in this subquery (rather than only
// in the outer WHERE) is equivalent and cheaper.
function getWikiPageObjIdForUser(did, wikiName, thenDo) {
  withDB(function (err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT o.obj_id FROM objects o' +
      ' INNER JOIN (' +
      '   SELECT obj_id, MAX(id) AS max_id FROM objects' +
      '   WHERE type = \'wikipage\'' +
      '         AND did = ?' +
      '         AND json_extract(envelope, \'$.constellation\') IS NULL' +
      '         AND json_extract(envelope, \'$.state.wikiName\') = ?' +
      '   GROUP BY obj_id' +
      ' ) latest ON o.id = latest.max_id' +
      ' WHERE (json_extract(o.envelope, \'$.state.deleted\') IS NULL' +
      '        OR json_extract(o.envelope, \'$.state.deleted\') != 1)' +
      ' ORDER BY o.id DESC LIMIT 1',
      [did, wikiName],
      function (err, row) {
        if (err) return thenDo(err);
        thenDo(null, row ? row.obj_id : null);
      }
    );
  });
}

// Personal (home-world) counterpart to listWikiPages — every wiki page
// owned by a user's own did, not tied to any constellation, for the
// personal wiki index (GET /@:handle/wiki). Same no-pagination precedent as
// listWikiPages (small per-scope counts). Also surfaces category/tags for
// the index cards — listWikiPages doesn't need these today but there's no
// reason the personal listing shouldn't carry them. Same updatedAt/createdAt
// two-join shape as listWikiPages above — see that function's comment.
// Calls thenDo(null, [{ objId, wikiName, category, tags, updatedAt, createdAt }, ...]).
function listWikiPagesForUser(did, thenDo) {
  withDB(function (err, db) {
    if (err) return thenDo(err);
    db.all(
      'SELECT o.obj_id, o.created_at AS updated_at, genesis.created_at AS created_at,' +
      '       json_extract(o.envelope, \'$.state.wikiName\') AS wiki_name,' +
      '       json_extract(o.envelope, \'$.state.category\') AS category,' +
      '       json_extract(o.envelope, \'$.state.tags\') AS tags_json' +
      ' FROM objects o' +
      ' INNER JOIN (' +
      '   SELECT obj_id, MAX(id) AS max_id FROM objects' +
      '   WHERE type = \'wikipage\'' +
      '         AND did = ?' +
      '         AND json_extract(envelope, \'$.constellation\') IS NULL' +
      '   GROUP BY obj_id' +
      ' ) latest ON o.id = latest.max_id' +
      ' INNER JOIN (' +
      '   SELECT obj_id, MIN(created_at) AS created_at FROM objects' +
      '   WHERE type = \'wikipage\'' +
      '         AND did = ?' +
      '         AND json_extract(envelope, \'$.constellation\') IS NULL' +
      '   GROUP BY obj_id' +
      ' ) genesis ON genesis.obj_id = o.obj_id' +
      ' WHERE (json_extract(o.envelope, \'$.state.deleted\') IS NULL' +
      '        OR json_extract(o.envelope, \'$.state.deleted\') != 1)' +
      ' ORDER BY wiki_name ASC',
      [did, did],
      function (err, rows) {
        if (err) return thenDo(err);
        thenDo(null, (rows || []).map(function (r) {
          var tags = [];
          if (r.tags_json) {
            try { tags = JSON.parse(r.tags_json) || []; } catch (e) { tags = []; }
          }
          return {
            objId: r.obj_id, wikiName: r.wiki_name, category: r.category || null,
            tags: tags, updatedAt: r.updated_at, createdAt: r.created_at,
          };
        }));
      }
    );
  });
}

// Escapes SQL LIKE wildcards (% and _) in a string that's about to be used
// as a LIKE prefix — Plus Codes' own alphabet ('23456789CFGHJMPQRVWX' plus
// '+'/'0') never contains either character, but a caller-supplied query
// param shouldn't be trusted to actually be a well-formed Plus Code by the
// time it reaches SQL, so escape defensively rather than relying on that
// implicitly.
function _escapeLikePrefix(s) {
  return String(s).replace(/[%_]/g, '\\$&');
}

// List latest public postcard envelopes whose state.location Plus Code
// starts with the given (already-floored) prefix — Plus Codes are
// naturally prefix-friendly: a longer shared prefix means a smaller shared
// grid cell, so this needs no lat/lng bounding-box math. Only
// visibility:'public' postcards are eligible (there is no "list all
// private/shared postcards near X" — that would defeat the point of
// marking them private).
// opts: { limit, cursor } — same pagination shape as listPostcardsForUser.
// Calls thenDo(null, { postcards: [envelopeMetadata...], cursor }).
function listPostcardsNearby(codePrefix, opts, thenDo) {
  var limit = (opts && opts.limit) || 20;
  var cursor = (opts && opts.cursor) || null;
  var likePrefix = _escapeLikePrefix(codePrefix) + '%';

  withDB(function(err, db) {
    if (err) return thenDo(err);

    var baseSql =
      'SELECT o.envelope, o.obj_id, o.id FROM objects o' +
      ' INNER JOIN (' +
      '   SELECT obj_id, MAX(id) AS max_id FROM objects' +
      '   WHERE type = \'postcard\' AND visibility = \'public\'' +
      '         AND json_extract(envelope, \'$.state.location\') LIKE ? ESCAPE \'\\\'' +
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
            params = [likePrefix, pivotId, limit + 1];
          } else {
            sql = baseSql + ' ORDER BY o.id DESC LIMIT ?';
            params = [likePrefix, limit + 1];
          }
          _runPostcardQuery(db, sql, params, limit, thenDo);
        }
      );
    } else {
      sql = baseSql + ' ORDER BY o.id DESC LIMIT ?';
      params = [likePrefix, limit + 1];
      _runPostcardQuery(db, sql, params, limit, thenDo);
    }
  });
}

// List reply envelopes for a parent objId (postcards whose replyTo.objId matches).
// Returns metadata-only (no payload) for the listing; caller fetches full envelope on open.
// Visibility filtering is the caller's responsibility (done in the route handler).
// opts: { limit, cursor, q, sort }
//   q — optional title substring filter (§8.1), same LIKE approach as
//   listPostcardsForUser.
//   sort — 'new' (default, unchanged: newest first, cursor-paginated) or
//   'top' (§8.2: ordered by reaction count via a LEFT JOIN against
//   postcard_reactions). 'top' deliberately doesn't support cursor
//   pagination — reply threads aren't expected to be long enough to need
//   it yet, and a stable cursor over a COUNT-ordered result would need a
//   compound (count, id) cursor instead of the simple id-based one every
//   other listing here uses; always returns cursor: null.
// Calls thenDo(null, { postcards: [envelopeMetadata...], cursor: String|null })
// — same shape key as every other listing here (despite the function name);
// the /replies route reads result.postcards, not result.replies.
function listRepliesForPostcard(parentObjId, opts, thenDo) {
  var limit = (opts && opts.limit) || 20;
  var cursor = (opts && opts.cursor) || null;
  var q = (opts && opts.q) || null;
  var qLike = q ? '%' + _escapeLikePrefix(q) + '%' : null;
  var sort = (opts && opts.sort) === 'top' ? 'top' : 'new';

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
      '        OR json_extract(o.envelope, \'$.state.deleted\') != 1)' +
      (qLike ? ' AND json_extract(o.envelope, \'$.state.title\') LIKE ? ESCAPE \'\\\'' : '');

    if (sort === 'top') {
      var topParams = qLike ? [parentObjId, qLike] : [parentObjId];
      var topSql =
        'SELECT o.envelope, o.obj_id, o.id, COUNT(pr.obj_id) AS reaction_count' +
        ' FROM objects o' +
        ' INNER JOIN (' +
        '   SELECT obj_id, MAX(id) AS max_id FROM objects' +
        '   WHERE type = \'postcard\'' +
        '         AND json_extract(envelope, \'$.replyTo.objId\') = ?' +
        '   GROUP BY obj_id' +
        ' ) latest ON o.id = latest.max_id' +
        ' LEFT JOIN postcard_reactions pr ON pr.obj_id = o.obj_id' +
        ' WHERE (json_extract(o.envelope, \'$.state.deleted\') IS NULL' +
        '        OR json_extract(o.envelope, \'$.state.deleted\') != 1)' +
        (qLike ? ' AND json_extract(o.envelope, \'$.state.title\') LIKE ? ESCAPE \'\\\'' : '') +
        ' GROUP BY o.obj_id' +
        ' ORDER BY reaction_count DESC, o.id DESC' +
        ' LIMIT ?';
      // Fetches exactly `limit` rows (not the limit+1 every other branch
      // here uses) — _runPostcardQuery's hasMore check (rows.length >
      // limit) is then always false, so cursor naturally comes out null,
      // matching this branch's "no pagination" contract without needing a
      // different result shape. Passes thenDo straight through, same as
      // every other branch — the caller (IdentityServer.js's /replies
      // route) reads result.postcards regardless of sort.
      return _runPostcardQuery(db, topSql, topParams.concat([limit]), limit, thenDo);
    }

    var params = [parentObjId, limit + 1];
    if (cursor) {
      db.get(
        'SELECT MAX(id) AS pivot FROM objects WHERE obj_id = ? AND type = \'postcard\'',
        [cursor],
        function(err, pivotRow) {
          if (err) return thenDo(err);
          var pivotId = pivotRow ? pivotRow.pivot : null;
          var qParams = qLike ? [qLike] : [];
          if (pivotId) {
            _runPostcardQuery(db,
              baseSql + ' AND o.id < ? ORDER BY o.id DESC LIMIT ?',
              [parentObjId].concat(qParams, [pivotId, limit + 1]), limit, thenDo);
          } else {
            _runPostcardQuery(db, baseSql + ' ORDER BY o.id DESC LIMIT ?',
              [parentObjId].concat(qParams, [limit + 1]), limit, thenDo);
          }
        }
      );
    } else {
      var noCursorParams = qLike ? [parentObjId, qLike, limit + 1] : params;
      _runPostcardQuery(db, baseSql + ' ORDER BY o.id DESC LIMIT ?', noCursorParams, limit, thenDo);
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

// ─── part aliases (Roadmap.md §3, "Phase 2 — Parts Name Aliasing") ────────────

// Point (did, aliasName) at objId, overwriting whatever it pointed to
// before — REPLACE INTO, not INSERT, since PRIMARY KEY (did, alias_name)
// means an author can only have one part named e.g. "MyButton" at a time,
// and republishing under that name should repoint the alias rather than
// error. Called by put() itself (see above) whenever a type:'part' envelope
// carries a state.partName, so no client code needs to know this table
// exists — the alias table stays a purely server-side resolution
// convenience, per Roadmap.md §3.
// Calls thenDo(err).
function upsertPartAlias(did, aliasName, objId, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'REPLACE INTO part_aliases (did, alias_name, obj_id, updated_at) VALUES (?, ?, ?, ?)',
      [did, aliasName, objId, new Date().toISOString()],
      function(err) { thenDo(err || null); }
    );
  });
}

// Resolve a human-readable part name to its current objId for a given
// author DID. Calls thenDo(null, objId | null).
function resolvePartAlias(did, aliasName, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT obj_id FROM part_aliases WHERE did = ? AND alias_name = ?',
      [did, aliasName],
      function(err, row) {
        if (err) return thenDo(err);
        thenDo(null, row ? row.obj_id : null);
      }
    );
  });
}

// ─── postcard reactions (PostcardDesignSpec-v2.md §5.1) ────────────────────────

// Upsert (replace) the caller's own reaction on a postcard. PRIMARY KEY
// (obj_id, did) means a second reaction from the same did overwrites the
// first rather than stacking — REPLACE INTO, not INSERT.
// Calls thenDo(err).
function upsertReaction(objId, did, emoji, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'REPLACE INTO postcard_reactions (obj_id, did, emoji, created_at) VALUES (?, ?, ?, ?)',
      [objId, did, emoji, new Date().toISOString()],
      function(err) { thenDo(err || null); }
    );
  });
}

// Remove the caller's own reaction, if any. Idempotent.
// Calls thenDo(err).
function deleteReaction(objId, did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'DELETE FROM postcard_reactions WHERE obj_id = ? AND did = ?',
      [objId, did],
      function(err) { thenDo(err || null); }
    );
  });
}

// All reactions on a postcard. Calls thenDo(null, [{ did, emoji }]).
function getReactionsForObjId(objId, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all(
      'SELECT did, emoji FROM postcard_reactions WHERE obj_id = ?',
      [objId],
      function(err, rows) { thenDo(err, rows || []); }
    );
  });
}

// ─── postcard send-freeze (PostcardDesignSpec-v2.md §2.5) ─────────────────────

// Stamps state.sentAt on an objId's latest version, server-side, the first
// time it's delivered to a DID other than its own author's — a one-way
// flag that's never cleared and never reset once set (a no-op if already
// present, so a later self-send after a real send can't look like it
// "un-freezes" anything). Reuses put()'s existing same-cid/metadata-changed
// path (record.payload is untouched, only state differs) rather than a
// bespoke UPDATE, so this goes through the same in-place-update code every
// other state-only change already does.
// Calls thenDo(err, envelope) — envelope is the (possibly already-frozen)
// current version either way.
function setSentAtIfUnset(objId, thenDo) {
  get(objId, function (err, envelope) {
    if (err) return thenDo(err);
    if (!envelope) return thenDo(new Error('setSentAtIfUnset: object not found: ' + objId));
    if (envelope.state && envelope.state.sentAt) return thenDo(null, envelope);

    envelope.state = Object.assign({}, envelope.state, { sentAt: new Date().toISOString() });
    put(envelope, function (err) {
      if (err) return thenDo(err);
      thenDo(null, envelope);
    });
  });
}

// ─── postcard mailbox hide (PostcardDesignSpec-v2.md §6.3, Layer 1) ───────────

// Hide an objId from `did`'s own mailbox views — idempotent (INSERT OR
// IGNORE: a second hide of an already-hidden card is a no-op, keeping the
// original hidden_at rather than refreshing it). Never touches the
// envelope itself; this is what makes it safe to call for a card `did`
// didn't author (a received card, say) — no ownership check happens here,
// callers gate on "is this DID's own mailbox" instead (§6.3: "you can only
// hide something from your own mailbox").
// Calls thenDo(err).
function hidePostcardForDid(did, objId, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'INSERT OR IGNORE INTO postcard_mailbox_hidden (did, obj_id, hidden_at) VALUES (?, ?, ?)',
      [did, objId, new Date().toISOString()],
      function(err) { thenDo(err || null); }
    );
  });
}

// Every objId `did` has hidden from their own mailbox. Calls thenDo(null, objId[]).
function getHiddenObjIdsForDid(did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all(
      'SELECT obj_id FROM postcard_mailbox_hidden WHERE did = ?',
      [did],
      function(err, rows) {
        if (err) return thenDo(err);
        thenDo(null, rows.map(function(r) { return r.obj_id; }));
      }
    );
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

// §8.1 title search for inbox/deliveries records — unlike the SQL-backed
// listings above, a JSONL delivery record ({objId, senderDid, sentAt, ...})
// doesn't carry the postcard's title itself, so there's no LIKE clause to
// add to a query that doesn't exist. Instead, for each candidate record,
// look up its objId's current title from objects.db and keep only the
// matches — one get() per record, run in parallel. Called with the full
// (already hidden/status-filtered) record list, before pagination, so a
// page never comes back short just because some of its rows didn't match.
// Only invoked when q is actually set — no extra DB round trips on the
// unfiltered path.
// Calls thenDo(null, records) in the same order as the input.
function _filterRecordsByTitle(records, q, thenDo) {
  if (!q) return thenDo(null, records);
  if (!records.length) return thenDo(null, []);
  var qLower = q.toLowerCase();
  var remaining = records.length;
  var firstErr = null;
  var matched = new Array(records.length);
  records.forEach(function (rec, i) {
    get(rec.objId, function (err, envelope) {
      if (err) firstErr = firstErr || err;
      var title = (envelope && envelope.state && envelope.state.title) || '';
      matched[i] = title.toLowerCase().indexOf(qLower) !== -1 ? rec : undefined;
      if (--remaining === 0) {
        if (firstErr) return thenDo(firstErr);
        thenDo(null, matched.filter(function (r) { return r !== undefined; }));
      }
    });
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
// opts: { limit, offset, hiddenObjIds, q }
//   hiddenObjIds — objId[] to exclude (§6.3 Layer 1) — filtered before
//   pagination (not after), same as every SQL-backed listing's WHERE
//   clause does for state.deleted, so a page never comes back short just
//   because some of its rows were hidden.
//   q — optional title substring filter (§8.1) — see _filterRecordsByTitle.
// Calls thenDo(null, { records: [...], cursor: Number|null }).
function listInboxForHandle(handle, opts, thenDo) {
  var fs = require('fs');
  var limit = (opts && opts.limit) || 20;
  var offset = (opts && opts.offset) || 0;
  var hiddenObjIds = (opts && opts.hiddenObjIds) || null;
  var q = (opts && opts.q) || null;
  var file = path.join(_getInboxDir(), handle + '.jsonl');
  if (!fs.existsSync(file)) return thenDo(null, { records: [], cursor: null });
  fs.readFile(file, 'utf8', function(err, text) {
    if (err) return thenDo(err);
    var lines = text.split('\n').filter(Boolean);
    lines.reverse(); // newest first
    var records = lines.map(function(l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
    if (hiddenObjIds && hiddenObjIds.length) {
      records = records.filter(function(r) { return hiddenObjIds.indexOf(r.objId) === -1; });
    }
    _filterRecordsByTitle(records, q, function (err, filtered) {
      if (err) return thenDo(err);
      var page = filtered.slice(offset, offset + limit);
      var nextOffset = offset + limit < filtered.length ? offset + limit : null;
      _enrichWithConstellationTag(page, function (err, enriched) {
        if (err) return thenDo(err);
        thenDo(null, { records: enriched, cursor: nextOffset });
      });
    });
  });
}

// Merges envelope.constellation/envelope.state.kind onto each record on the
// *returned page only* (bounded to `limit`, never the full inbox log) — so
// PostCardMailbox.js can show a "c/<name>" badge distinguishing e.g. a
// constellation-join-request card from a regular postcard without a
// separate per-row fetch when the list first renders. Same bounded-cost
// per-page envelope lookup _filterRecordsByTitle above already does for
// search; this just always runs, not only when q is set.
function _enrichWithConstellationTag(page, thenDo) {
  if (!page.length) return thenDo(null, page);
  var remaining = page.length;
  var firstErr = null;
  page.forEach(function (rec) {
    get(rec.objId, function (err, envelope) {
      if (err) firstErr = firstErr || err;
      if (envelope) {
        rec.constellation = envelope.constellation || null;
        rec.kind = (envelope.state && envelope.state.kind) || null;
      }
      if (--remaining === 0) thenDo(firstErr, page);
    });
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
// opts: { limit, offset, status, hiddenObjIds }
//   status — filters to 'delivered' or 'returned' when set.
//   hiddenObjIds — objId[] to exclude (§6.3 Layer 1), filtered before
//   pagination, same reasoning as listInboxForHandle above.
// Calls thenDo(null, { records: [...], cursor: Number|null }).
function listDeliveriesForHandle(senderHandle, opts, thenDo) {
  var fs     = require('fs');
  var limit  = (opts && opts.limit)  || 20;
  var offset = (opts && opts.offset) || 0;
  var status = (opts && opts.status) || null;
  var hiddenObjIds = (opts && opts.hiddenObjIds) || null;
  var q      = (opts && opts.q) || null;
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
    if (hiddenObjIds && hiddenObjIds.length) {
      records = records.filter(function (r) { return hiddenObjIds.indexOf(r.objId) === -1; });
    }
    _filterRecordsByTitle(records, q, function (err, filtered) {
      if (err) return thenDo(err);
      var page       = filtered.slice(offset, offset + limit);
      var nextOffset = offset + limit < filtered.length ? offset + limit : null;
      thenDo(null, { records: page, cursor: nextOffset });
    });
  });
}

module.exports = {
  withDB:                        withDB,
  put:                           put,
  get:                           get,
  getVersion:                    getVersion,
  getVersionsSince:              getVersionsSince,
  listForUser:                   listForUser,
  listPublicParts:               listPublicParts,
  getProfileForDid:              getProfileForDid,
  getRecoveryWorldForDid:        getRecoveryWorldForDid,
  getSettingsForDid:             getSettingsForDid,
  listVersions:                  listVersions,
  deleteVersionsAfter:           deleteVersionsAfter,
  getObjIdsForBlob:              getObjIdsForBlob,
  addRecipient:                  addRecipient,
  upsertPartAlias:               upsertPartAlias,
  resolvePartAlias:              resolvePartAlias,
  listPostcardsForUser:          listPostcardsForUser,
  listPostcardsForConstellation: listPostcardsForConstellation,
  listMessagesForRoom:           listMessagesForRoom,
  getWikiPageObjId:              getWikiPageObjId,
  listWikiPages:                 listWikiPages,
  getWikiPageObjIdForUser:       getWikiPageObjIdForUser,
  listWikiPagesForUser:          listWikiPagesForUser,
  listPostcardsNearby:           listPostcardsNearby,
  listRepliesForPostcard:        listRepliesForPostcard,
  upsertReaction:                upsertReaction,
  deleteReaction:                deleteReaction,
  getReactionsForObjId:          getReactionsForObjId,
  hidePostcardForDid:            hidePostcardForDid,
  getHiddenObjIdsForDid:         getHiddenObjIdsForDid,
  setSentAtIfUnset:              setSentAtIfUnset,
  putInboxRecord:                putInboxRecord,
  listInboxForHandle:            listInboxForHandle,
  putDeliveryRecord:             putDeliveryRecord,
  listDeliveriesForHandle:       listDeliveriesForHandle,
};
