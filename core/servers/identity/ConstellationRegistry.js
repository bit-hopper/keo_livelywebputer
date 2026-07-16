/**
 * core/servers/identity/ConstellationRegistry.js
 *
 * SQLite-backed registry of constellations: identity (did:web),
 * registration, and membership checks shared by both the HTTP routes
 * (IdentityServer.js) and the Yjs sync socket (PostCardSyncServer.js).
 *
 * Schema:
 *   constellations table:
 *     name           TEXT PRIMARY KEY  — e.g. "sanfrancisco"
 *     did            TEXT NOT NULL     — "did:web:<domain>:c:<name>"
 *     genesis_obj_id TEXT NOT NULL
 *     genesis_nonce  TEXT NOT NULL     — base64url
 *     controllers    TEXT NOT NULL     — JSON array of did:jwk strings
 *     threshold      INTEGER NOT NULL DEFAULT 1
 *     members        TEXT NOT NULL DEFAULT '[]'  — JSON array of did:jwk strings
 *     created_by     TEXT NOT NULL
 *     created_at     TEXT NOT NULL
 *     creation_sig   TEXT NOT NULL     — JWS, verified at creation time (CryptoVerify)
 *     visibility     TEXT NOT NULL DEFAULT 'public'
 *
 * The DB file is stored at <WORKSPACE_LK>/identity/constellations.db.
 * Created automatically on first use.
 */

'use strict';

var path    = require('path');
var sqlite3 = require('sqlite3').verbose();

var DB_PATH = path.join(
  process.env.WORKSPACE_LK || process.cwd(),
  'identity',
  'constellations.db'
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
    db.run(
      'CREATE TABLE IF NOT EXISTS constellations (' +
      '  name           TEXT PRIMARY KEY,' +
      '  did            TEXT NOT NULL,' +
      '  genesis_obj_id TEXT NOT NULL,' +
      '  genesis_nonce  TEXT NOT NULL,' +
      '  controllers    TEXT NOT NULL,' +
      '  threshold      INTEGER NOT NULL DEFAULT 1,' +
      '  members        TEXT NOT NULL DEFAULT \'[]\',' +
      '  created_by     TEXT NOT NULL,' +
      '  created_at     TEXT NOT NULL,' +
      '  creation_sig   TEXT NOT NULL,' +
      '  visibility     TEXT NOT NULL DEFAULT \'public\'' +
      ')',
      function(err) { thenDo(err || null, db); }
    );
  });
}

// ─── name validation ────────────────────────────────────────────────────────
// First precedent for name validation in this codebase — see
// ConstellationDesignSpec.md §1.3. Not applied to handle registration
// (a separate, pre-existing gap, out of scope here).

var NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

var RESERVED_NAMES = {
  'feed': true, 'wiki': true, 'members': true, 'invites': true,
  'join-requests': true, 'settings': true, 'did.json': true, 'space': true,
  'admin': true, 'api': true, 'www': true
};

function isValidName(name) {
  return typeof name === 'string' &&
    NAME_RE.test(name) &&
    !RESERVED_NAMES.hasOwnProperty(name);
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

// fields: { name, did, genesisObjId, genesisNonce, controllers: [did,...],
//           threshold, members: [did,...], createdBy, createdAt, creationSig,
//           visibility }
// Calls thenDo(err).
function create(fields, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'INSERT INTO constellations ' +
      '(name, did, genesis_obj_id, genesis_nonce, controllers, threshold, members, created_by, created_at, creation_sig, visibility)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        fields.name,
        fields.did,
        fields.genesisObjId,
        fields.genesisNonce,
        JSON.stringify(fields.controllers || []),
        fields.threshold || 1,
        JSON.stringify(fields.members || []),
        fields.createdBy,
        fields.createdAt,
        fields.creationSig,
        fields.visibility || 'public'
      ],
      function(err) { thenDo(err || null); }
    );
  });
}

// Calls thenDo(null, true|false).
function exists(name, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get('SELECT 1 FROM constellations WHERE name = ?', [name], function(err, row) {
      thenDo(err || null, !!row);
    });
  });
}

function _rowToConstellation(row, name) {
  var controllers, members;
  try {
    controllers = JSON.parse(row.controllers);
    members = JSON.parse(row.members);
  } catch (e) {
    throw new Error('ConstellationRegistry: corrupt row for ' + name);
  }
  return {
    name: row.name,
    did: row.did,
    genesisObjId: row.genesis_obj_id,
    genesisNonce: row.genesis_nonce,
    controllers: controllers,
    threshold: row.threshold,
    members: members,
    createdBy: row.created_by,
    createdAt: row.created_at,
    creationSig: row.creation_sig,
    visibility: row.visibility
  };
}

// Calls thenDo(null, constellation) or thenDo(null, null) if not found.
// constellation: { name, did, genesisObjId, genesisNonce, controllers: [...],
//                   threshold, members: [...], createdBy, createdAt,
//                   creationSig, visibility }
function get(name, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get('SELECT * FROM constellations WHERE name = ?', [name], function(err, row) {
      if (err) return thenDo(err);
      if (!row) return thenDo(null, null);
      try {
        thenDo(null, _rowToConstellation(row, name));
      } catch (e) {
        thenDo(e);
      }
    });
  });
}

// Maps a Yjs sync room name (the constellation's genesisObjId) back to its
// constellation row. Used by the sync socket's room-join auth check, since
// the room only knows the objId, not the constellation's name.
// Calls thenDo(null, constellation) or thenDo(null, null) if not found.
function getByGenesisObjId(genesisObjId, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get('SELECT * FROM constellations WHERE genesis_obj_id = ?', [genesisObjId], function(err, row) {
      if (err) return thenDo(err);
      if (!row) return thenDo(null, null);
      try {
        thenDo(null, _rowToConstellation(row, row.name));
      } catch (e) {
        thenDo(e);
      }
    });
  });
}

// ─── membership checks ──────────────────────────────────────────────────────
// Shared by IdentityServer.js's HTTP routes and PostCardSyncServer.js's Yjs
// room-join check, so there is exactly one place that decides who can read
// or write a constellation's contents.

// True if `did` (or an anonymous visitor, did === null) may read this
// constellation's contents: public constellations are readable by anyone,
// private ones only by members.
function canRead(constellation, did) {
  if (constellation.visibility === 'public') return true;
  if (!did) return false;
  return constellation.members.indexOf(did) !== -1;
}

// True if `did` may write to this constellation's space (place/move/remove
// placements): members only, regardless of visibility. Note this is only
// enforced at HTTP-route granularity and at Yjs-room-connection granularity
// (see PostCardSyncServer.js's TODO(constellation-write-gate)) — a connected
// visitor on a public room is not currently blocked from sending doc-mutating
// sync messages once the connection itself is accepted.
function canWrite(constellation, did) {
  if (!did) return false;
  return constellation.members.indexOf(did) !== -1;
}

module.exports = {
  withDB: withDB,
  isValidName: isValidName,
  RESERVED_NAMES: RESERVED_NAMES,
  create: create,
  exists: exists,
  get: get,
  getByGenesisObjId: getByGenesisObjId,
  canRead: canRead,
  canWrite: canWrite
};
