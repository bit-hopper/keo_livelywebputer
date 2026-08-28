/**
 * core/servers/identity/ConstellationRegistry.js
 *
 * SQLite-backed registry of constellations: identity (did:web),
 * registration, and membership checks shared by both the HTTP routes
 * (IdentityServer.js) and the Yjs sync socket (LiveDocSyncServer.js).
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
 *     bots           TEXT NOT NULL DEFAULT '[]'  — JSON array of did:jwk strings, bot
 *                                       accounts to surface in the members list under
 *                                       their own section — a labeling list, independent
 *                                       of controllers/members (like those, no mutation
 *                                       route exists yet; populated directly for now)
 *
 *   constellation_events table: one row per scheduled event, backing the
 *     quick-info panel's event card — id, constellation, title, starts_at
 *     (ISO string with UTC offset), location, attendees (JSON array of
 *     did:jwk strings), attendee_count, created_by, created_at. See
 *     getNextEvent()/createEvent() below.
 *
 *   rooms table: one row per Spaces-panel room (ConstellationLounge.js) —
 *     id, constellation, name, is_video/is_voice (creator-set type labels,
 *     not live call state), access ('open'|'request'), created_by,
 *     created_at. Only a constellation controller may create one. Live
 *     "who's currently in the room" presence is NOT stored here — it's
 *     ephemeral, kept in-memory by RoomPresence.js, and intentionally does
 *     not survive a server restart.
 *
 *   room_join_requests table: one row per (room_id, did), same
 *     overwrite-on-re-request shape as join_requests below. Only relevant
 *     for access:'request' rooms — status='approved' IS the permanent
 *     room-membership grant, there is no separate room-members list.
 *
 *   constellation_invites table: the "Invites" door (§4.2's counterpart to
 *     join_requests below, reversed direction — a controller sends, the
 *     target accepts/declines). One row per (constellation, did); a
 *     re-invite after a decline overwrites the old row back to pending,
 *     same semantics as join_requests. obj_id is the postal-rail postcard
 *     (state.kind:'constellation-invite') the invite was delivered as —
 *     kept for symmetry with join_requests' own audit trail even though no
 *     current route re-reads it. Accepting adds the target to members, via
 *     the same addMember() join_requests' approve path uses.
 *

 * The DB file is stored at <WORKSPACE_LK>/identity/constellations.db.
 * Created automatically on first use. withDB() migrates existing DBs that
 * predate the `bots` column via ALTER TABLE, guarded by a PRAGMA
 * table_info check (SQLite has no ADD COLUMN IF NOT EXISTS).
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
      '  visibility     TEXT NOT NULL DEFAULT \'public\',' +
      '  bots           TEXT NOT NULL DEFAULT \'[]\'' +
      ')',
      function(err) {
        if (err) return thenDo(err);

        function createEvents() {
          // Backs the quick-info panel's event card (ConstellationLounge.js
          // _renderQuickInfo) — one row per scheduled event; the panel shows
          // whichever has the soonest future `starts_at` (getNextEvent()).
          // `attendees` is a small JSON array of did:jwk strings (enough to
          // render a handful of avatars); `attendee_count` is the displayed
          // headcount and may exceed attendees.length — the card's "+N
          // People" badge is attendee_count - attendees.length, not a claim
          // that every attendee's DID is known.
          db.run(
            'CREATE TABLE IF NOT EXISTS constellation_events (' +
            '  id             INTEGER PRIMARY KEY AUTOINCREMENT,' +
            '  constellation  TEXT NOT NULL,' +
            '  title          TEXT NOT NULL,' +
            '  starts_at      TEXT NOT NULL,' +
            '  location       TEXT NOT NULL DEFAULT \'\',' +
            '  attendees      TEXT NOT NULL DEFAULT \'[]\',' +
            '  attendee_count INTEGER NOT NULL DEFAULT 0,' +
            '  created_by     TEXT NOT NULL,' +
            '  created_at     TEXT NOT NULL' +
            ')',
            function(err) { if (err) return thenDo(err); createRooms(); }
          );
        }

        function createRooms() {
          // A room belongs to a constellation, created by a controller only
          // (POST /c/:name/rooms). is_video/is_voice are creator-set type
          // labels shown on the room card, not live call state — no
          // audio/video call infra exists, "joining" is presence/roster
          // only (see RoomPresence.js). access: 'open' (any signed-in
          // constellation member can join by clicking) or 'request' (needs
          // a controller-approved room_join_requests row first, see below).
          db.run(
            'CREATE TABLE IF NOT EXISTS rooms (' +
            '  id             INTEGER PRIMARY KEY AUTOINCREMENT,' +
            '  constellation  TEXT NOT NULL,' +
            '  name           TEXT NOT NULL,' +
            '  is_video       INTEGER NOT NULL DEFAULT 0,' +
            '  is_voice       INTEGER NOT NULL DEFAULT 0,' +
            '  access         TEXT NOT NULL DEFAULT \'open\',' +
            '  activity       TEXT DEFAULT NULL,' +
            '  created_by     TEXT NOT NULL,' +
            '  created_at     TEXT NOT NULL' +
            ')',
            function(err) { if (err) return thenDo(err); migrateRoomsActivity(); }
          );
        }

        // Migration for DBs created before the `activity` column existed —
        // same PRAGMA-check idiom as the `bots` migration above (SQLite has
        // no "ADD COLUMN IF NOT EXISTS").
        function migrateRoomsActivity() {
          db.all('PRAGMA table_info(rooms)', function(err, cols) {
            if (err) return thenDo(err);
            var hasActivity = (cols || []).some(function(c) { return c.name === 'activity'; });
            if (hasActivity) return createRoomJoinRequests();
            db.run('ALTER TABLE rooms ADD COLUMN activity TEXT DEFAULT NULL', function(err) {
              if (err) return thenDo(err);
              createRoomJoinRequests();
            });
          });
        }

        function createRoomJoinRequests() {
          // Mirrors join_requests' exact shape/overwrite-on-re-request
          // semantics (one row per (room_id, did), a re-request resets to
          // pending). Unlike the constellation level, there is no separate
          // "room members" table — a room has no other consumer of
          // membership besides the join gate itself, so
          // status = 'approved' IS the permanent grant; canJoinRoom()
          // reads this table directly.
          db.run(
            'CREATE TABLE IF NOT EXISTS room_join_requests (' +
            '  room_id       INTEGER NOT NULL,' +
            '  did           TEXT NOT NULL,' +
            '  requested_at  TEXT NOT NULL,' +
            '  status        TEXT NOT NULL DEFAULT \'pending\',' +
            '  PRIMARY KEY (room_id, did)' +
            ')',
            function(err) { if (err) return thenDo(err); createInvites(); }
          );
        }

        function createInvites() {
          // See this file's own header comment for the "Invites door"
          // shape — a controller-issued counterpart to join_requests.
          db.run(
            'CREATE TABLE IF NOT EXISTS constellation_invites (' +
            '  constellation TEXT NOT NULL,' +
            '  did           TEXT NOT NULL,' +
            '  invited_by    TEXT NOT NULL,' +
            '  obj_id        TEXT NOT NULL,' +
            '  status        TEXT NOT NULL DEFAULT \'pending\',' +
            '  created_at    TEXT NOT NULL,' +
            '  responded_at  TEXT DEFAULT NULL,' +
            '  PRIMARY KEY (constellation, did)' +
            ')',
            function(err) { thenDo(err || null, db); }
          );
        }

        function createJoinRequests() {
          // ConstellationDesignSpec.md §4.2/§7 — request-to-join flow. One row
          // per (constellation, did): a re-request after a decline overwrites
          // the old row rather than accumulating history, since only the
          // current status is ever consulted (join-request-status is a
          // display concern for the requester's own dropdown, not an audit
          // log — unlike the space doc's moderation log, §4.4, which is
          // deliberately transparent/replayable).
          db.run(
            'CREATE TABLE IF NOT EXISTS join_requests (' +
            '  constellation TEXT NOT NULL,' +
            '  did           TEXT NOT NULL,' +
            '  requested_at  TEXT NOT NULL,' +
            '  status        TEXT NOT NULL DEFAULT \'pending\',' +
            '  PRIMARY KEY (constellation, did)' +
            ')',
            function(err) {
              if (err) return thenDo(err);
              createEvents();
            }
          );
        }

        // Migration for DBs created before the `bots` column existed —
        // CREATE TABLE IF NOT EXISTS above is a no-op against an existing
        // table, so a fresh column has to be added by hand. SQLite has no
        // "ADD COLUMN IF NOT EXISTS", so check PRAGMA table_info first
        // rather than racing ALTER TABLE against a "duplicate column" error.
        db.all('PRAGMA table_info(constellations)', function(err, cols) {
          if (err) return thenDo(err);
          var hasBots = (cols || []).some(function(c) { return c.name === 'bots'; });
          if (hasBots) return createJoinRequests();
          db.run('ALTER TABLE constellations ADD COLUMN bots TEXT NOT NULL DEFAULT \'[]\'', function(err) {
            if (err) return thenDo(err);
            createJoinRequests();
          });
        });
      }
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
  'canvas': true, 'admin': true, 'api': true, 'www': true, 'events': true,
  'rooms': true
};

function isValidName(name) {
  return typeof name === 'string' &&
    NAME_RE.test(name) &&
    !RESERVED_NAMES.hasOwnProperty(name);
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

// fields: { name, did, genesisObjId, genesisNonce, controllers: [did,...],
//           threshold, members: [did,...], createdBy, createdAt, creationSig,
//           visibility, bots: [did,...] }
// Calls thenDo(err).
function create(fields, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'INSERT INTO constellations ' +
      '(name, did, genesis_obj_id, genesis_nonce, controllers, threshold, members, created_by, created_at, creation_sig, visibility, bots)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        fields.visibility || 'public',
        JSON.stringify(fields.bots || [])
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

// Lists public constellations, newest first — backs the "browse public
// constellations" affordance ConstellationsBrowser.js otherwise has no way
// to fill (it previously only ever showed a localStorage-cached list of
// constellations the current device had created or opened, so any public
// constellation created elsewhere/by someone else never showed up there).
// Calls thenDo(null, [{ name, did, createdAt, memberCount }, ...]).
function listPublic(opts, thenDo) {
  var limit = Math.min((opts && opts.limit) || 50, 200);
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all(
      'SELECT name, did, created_at, members FROM constellations' +
      ' WHERE visibility = \'public\' ORDER BY created_at DESC LIMIT ?',
      [limit],
      function(err, rows) {
        if (err) return thenDo(err);
        try {
          thenDo(null, (rows || []).map(function(row) {
            var members;
            try { members = JSON.parse(row.members); } catch (e) { members = []; }
            return {
              name: row.name,
              did: row.did,
              createdAt: row.created_at,
              memberCount: members.length
            };
          }));
        } catch (e) {
          thenDo(e);
        }
      }
    );
  });
}

function _rowToConstellation(row, name) {
  var controllers, members, bots;
  try {
    controllers = JSON.parse(row.controllers);
    members = JSON.parse(row.members);
    bots = JSON.parse(row.bots || '[]');
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
    visibility: row.visibility,
    bots: bots
  };
}

// Calls thenDo(null, constellation) or thenDo(null, null) if not found.
// constellation: { name, did, genesisObjId, genesisNonce, controllers: [...],
//                   threshold, members: [...], createdBy, createdAt,
//                   creationSig, visibility, bots: [...] }
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
// Shared by IdentityServer.js's HTTP routes and LiveDocSyncServer.js's Yjs
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
// (see LiveDocSyncServer.js's TODO(constellation-write-gate)) — a connected
// visitor on a public room is not currently blocked from sending doc-mutating
// sync messages once the connection itself is accepted.
function canWrite(constellation, did) {
  if (!did) return false;
  return constellation.members.indexOf(did) !== -1;
}

// True if `did` is on the controller list — governs settings, invites,
// join-request approval/decline (§4.1).
function isController(constellation, did) {
  if (!did) return false;
  return constellation.controllers.indexOf(did) !== -1;
}

// ─── membership — join requests ─────────────────────────────────────────────
// §4.2 "Requests" door: any authenticated user may ask to join; a controller
// approves or declines. (The "Invites" door — a controller-issued,
// delivery-rail invite card — is a separate, not-yet-built mechanism; this
// only covers the request half.)

// Adds `did` to a constellation's members if not already present.
// Read-modify-write on the JSON column — fine at this table's write volume
// (membership changes are rare, human-paced events, not a hot path).
// Calls thenDo(err).
function addMember(name, did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    get(name, function(err, constellation) {
      if (err) return thenDo(err);
      if (!constellation) return thenDo(new Error('Constellation not found: ' + name));
      if (constellation.members.indexOf(did) !== -1) return thenDo(null);
      var members = constellation.members.concat([did]);
      db.run('UPDATE constellations SET members = ? WHERE name = ?',
        [JSON.stringify(members), name],
        function(err) { thenDo(err || null); });
    });
  });
}

// Upserts a pending request — a re-request after a decline resets status to
// pending rather than leaving the old decline in place. Calls thenDo(err).
function requestJoin(name, did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'INSERT INTO join_requests (constellation, did, requested_at, status) VALUES (?, ?, ?, \'pending\')' +
      ' ON CONFLICT(constellation, did) DO UPDATE SET requested_at = excluded.requested_at, status = \'pending\'',
      [name, did, new Date().toISOString()],
      function(err) { thenDo(err || null); }
    );
  });
}

// Calls thenDo(null, 'pending'|'declined'|null) — null means no request on file.
function getJoinRequestStatus(name, did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get('SELECT status FROM join_requests WHERE constellation = ? AND did = ?', [name, did], function(err, row) {
      if (err) return thenDo(err);
      thenDo(null, row ? row.status : null);
    });
  });
}

// Calls thenDo(null, [{ did, requestedAt }, ...]), oldest first.
function listPendingJoinRequests(name, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all(
      'SELECT did, requested_at FROM join_requests WHERE constellation = ? AND status = \'pending\' ORDER BY requested_at ASC',
      [name],
      function(err, rows) {
        if (err) return thenDo(err);
        thenDo(null, (rows || []).map(function(r) { return { did: r.did, requestedAt: r.requested_at }; }));
      }
    );
  });
}

// Approving adds the requester to members AND marks the request approved,
// in that order — a crash between the two leaves a stray 'approved' row
// with no membership rather than silently-approved membership with no
// record, which is the safer failure mode to leave for a controller to
// notice and retry. Calls thenDo(err).
function approveJoinRequest(name, did, thenDo) {
  addMember(name, did, function(err) {
    if (err) return thenDo(err);
    withDB(function(err, db) {
      if (err) return thenDo(err);
      db.run('UPDATE join_requests SET status = \'approved\' WHERE constellation = ? AND did = ?',
        [name, did],
        function(err) { thenDo(err || null); });
    });
  });
}

// Calls thenDo(err).
function declineJoinRequest(name, did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run('UPDATE join_requests SET status = \'declined\' WHERE constellation = ? AND did = ?',
      [name, did],
      function(err) { thenDo(err || null); });
  });
}

// ─── invites — the "Invites" door (controller sends, target responds) ──────
// Mirrors join_requests above with the direction reversed: a controller
// creates the row and delivers the postcard, the target (not a controller)
// approves/declines it.

// Used to build a "which constellation do you control" picker (e.g.
// ProfileCard.js's friend nameplate menu) — there's no dedicated members
// table to query, so this scans `controllers` (a JSON-array TEXT column)
// with a LIKE prefilter, then confirms real membership by parsing each
// candidate row's JSON rather than trusting the substring match (a LIKE hit
// on a truncated/adjacent did:jwk string is possible in principle).
// Calls thenDo(null, [{ name, visibility, memberCount }, ...]).
function listByController(did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all('SELECT name, controllers, members, visibility FROM constellations WHERE controllers LIKE ?',
      ['%' + did + '%'],
      function(err, rows) {
        if (err) return thenDo(err);
        try {
          var out = (rows || []).filter(function(row) {
            var controllers;
            try { controllers = JSON.parse(row.controllers); } catch (e) { return false; }
            return controllers.indexOf(did) !== -1;
          }).map(function(row) {
            var members;
            try { members = JSON.parse(row.members); } catch (e) { members = []; }
            return { name: row.name, visibility: row.visibility, memberCount: members.length };
          });
          thenDo(null, out);
        } catch (e) {
          thenDo(e);
        }
      }
    );
  });
}

// Upserts a pending invite — a re-invite after a decline resets status to
// pending, same overwrite semantics as requestJoin(). Calls thenDo(err).
function createInvite(name, did, invitedBy, objId, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'INSERT INTO constellation_invites (constellation, did, invited_by, obj_id, created_at, status)' +
      ' VALUES (?, ?, ?, ?, ?, \'pending\')' +
      ' ON CONFLICT(constellation, did) DO UPDATE SET' +
      '   invited_by = excluded.invited_by, obj_id = excluded.obj_id,' +
      '   created_at = excluded.created_at, status = \'pending\', responded_at = NULL',
      [name, did, invitedBy, objId, new Date().toISOString()],
      function(err) { thenDo(err || null); }
    );
  });
}

// Calls thenDo(null, 'pending'|'accepted'|'declined'|null) — null means no invite on file.
function getInviteStatus(name, did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get('SELECT status FROM constellation_invites WHERE constellation = ? AND did = ?', [name, did], function(err, row) {
      if (err) return thenDo(err);
      thenDo(null, row ? row.status : null);
    });
  });
}

// Same crash-safety ordering as approveJoinRequest: membership first, then
// the invite row, so a crash between the two leaves a stray 'accepted' row
// with no membership rather than the reverse. Calls thenDo(err).
function approveInvite(name, did, thenDo) {
  addMember(name, did, function(err) {
    if (err) return thenDo(err);
    withDB(function(err, db) {
      if (err) return thenDo(err);
      db.run('UPDATE constellation_invites SET status = \'accepted\', responded_at = ? WHERE constellation = ? AND did = ?',
        [new Date().toISOString(), name, did],
        function(err) { thenDo(err || null); });
    });
  });
}

// Calls thenDo(err).
function declineInvite(name, did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run('UPDATE constellation_invites SET status = \'declined\', responded_at = ? WHERE constellation = ? AND did = ?',
      [new Date().toISOString(), name, did],
      function(err) { thenDo(err || null); });
  });
}

// ─── events — quick-info panel's event card ─────────────────────────────────
// No creation UI exists yet (same gap as bots/moderators) — createEvent is a
// real write path for whenever one gets built, but rows can also be inserted
// directly for now.

// fields: { constellation, title, startsAt (ISO string with offset),
//           location, attendees: [did,...], attendeeCount, createdBy }
// Calls thenDo(err).
function createEvent(fields, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'INSERT INTO constellation_events ' +
      '(constellation, title, starts_at, location, attendees, attendee_count, created_by, created_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        fields.constellation,
        fields.title,
        fields.startsAt,
        fields.location || '',
        JSON.stringify(fields.attendees || []),
        fields.attendeeCount || 0,
        fields.createdBy,
        new Date().toISOString()
      ],
      function(err) { thenDo(err || null); }
    );
  });
}

// Whichever of this constellation's events has the soonest future
// `starts_at` — fetches all of them and compares as real Date objects
// (rather than a SQL string-range query) since starts_at strings carry
// arbitrary UTC offsets that don't sort correctly as plain text. Fine at
// this table's expected size (a handful of upcoming events per
// constellation, not a hot path). Calls thenDo(null, event|null), where
// event: { id, title, startsAt, location, attendees: [did,...],
//          attendeeCount, createdBy, createdAt }.
function getNextEvent(name, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all('SELECT * FROM constellation_events WHERE constellation = ?', [name], function(err, rows) {
      if (err) return thenDo(err);
      var now = Date.now();
      var upcoming = (rows || [])
        .map(function(row) {
          var attendees;
          try { attendees = JSON.parse(row.attendees || '[]'); } catch (e) { attendees = []; }
          return {
            id: row.id,
            title: row.title,
            startsAt: row.starts_at,
            location: row.location,
            attendees: attendees,
            attendeeCount: row.attendee_count,
            createdBy: row.created_by,
            createdAt: row.created_at,
            _ts: new Date(row.starts_at).getTime()
          };
        })
        .filter(function(ev) { return !isNaN(ev._ts) && ev._ts >= now; })
        .sort(function(a, b) { return a._ts - b._ts; });
      if (!upcoming.length) return thenDo(null, null);
      var next = upcoming[0];
      delete next._ts;
      thenDo(null, next);
    });
  });
}

// ─── rooms — Spaces panel ───────────────────────────────────────────────────
// See the header comment for the rooms/room_join_requests schema. Only a
// controller may createRoom (enforced at the HTTP route, IdentityServer.js,
// not here — same division of responsibility as every other permission
// check in this file). Live presence (who's currently in a room) is NOT
// tracked here — see RoomPresence.js.

// fields: { constellation, name, isVideo, isVoice, access, activity, createdBy }
// access: 'open' | 'request'. activity: an optional short creator-picked
// label (e.g. "Jamming", "Reading" — see NewRoomDialog.js's activity chips)
// describing what active participants are doing, shown on the room card
// (ConstellationLounge.js's _renderRoomCard, "· <activity>"). Calls
// thenDo(err, roomId).
function createRoom(fields, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'INSERT INTO rooms (constellation, name, is_video, is_voice, access, activity, created_by, created_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        fields.constellation,
        fields.name,
        fields.isVideo ? 1 : 0,
        fields.isVoice ? 1 : 0,
        fields.access === 'request' ? 'request' : 'open',
        fields.activity || null,
        fields.createdBy,
        new Date().toISOString()
      ],
      function(err) { thenDo(err || null, this && this.lastID); }
    );
  });
}

function _rowToRoom(row) {
  return {
    id: row.id,
    constellation: row.constellation,
    name: row.name,
    isVideo: !!row.is_video,
    isVoice: !!row.is_voice,
    access: row.access,
    activity: row.activity || null,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

// Calls thenDo(null, [room, ...]), creation order (oldest first).
function listRooms(constellationName, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all('SELECT * FROM rooms WHERE constellation = ? ORDER BY id ASC', [constellationName], function(err, rows) {
      if (err) return thenDo(err);
      thenDo(null, (rows || []).map(_rowToRoom));
    });
  });
}

// Calls thenDo(null, room|null).
function getRoom(roomId, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get('SELECT * FROM rooms WHERE id = ?', [roomId], function(err, row) {
      if (err) return thenDo(err);
      thenDo(null, row ? _rowToRoom(row) : null);
    });
  });
}

// Same upsert-to-pending idiom as requestJoin. Calls thenDo(err).
function requestRoomJoin(roomId, did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'INSERT INTO room_join_requests (room_id, did, requested_at, status) VALUES (?, ?, ?, \'pending\')' +
      ' ON CONFLICT(room_id, did) DO UPDATE SET requested_at = excluded.requested_at, status = \'pending\'',
      [roomId, did, new Date().toISOString()],
      function(err) { thenDo(err || null); }
    );
  });
}

// Calls thenDo(null, 'pending'|'approved'|'declined'|null) — null means no
// request on file (only meaningful for access:'request' rooms).
function getRoomJoinRequestStatus(roomId, did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get('SELECT status FROM room_join_requests WHERE room_id = ? AND did = ?', [roomId, did], function(err, row) {
      if (err) return thenDo(err);
      thenDo(null, row ? row.status : null);
    });
  });
}

// Calls thenDo(null, [{ did, requestedAt }, ...]), oldest first.
function listPendingRoomJoinRequests(roomId, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all(
      'SELECT did, requested_at FROM room_join_requests WHERE room_id = ? AND status = \'pending\' ORDER BY requested_at ASC',
      [roomId],
      function(err, rows) {
        if (err) return thenDo(err);
        thenDo(null, (rows || []).map(function(r) { return { did: r.did, requestedAt: r.requested_at }; }));
      }
    );
  });
}

// No addMember-equivalent — unlike constellation-level approval, a room
// has no membership list beyond this table, so approving is just the
// status flip. Calls thenDo(err).
function approveRoomJoinRequest(roomId, did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run('UPDATE room_join_requests SET status = \'approved\' WHERE room_id = ? AND did = ?',
      [roomId, did],
      function(err) { thenDo(err || null); });
  });
}

// Calls thenDo(err).
function declineRoomJoinRequest(roomId, did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run('UPDATE room_join_requests SET status = \'declined\' WHERE room_id = ? AND did = ?',
      [roomId, did],
      function(err) { thenDo(err || null); });
  });
}

// True if `did` may join this room right now: a real constellation member
// (canWrite — being able to just read a public constellation isn't
// enough), and, for access:'request' rooms, a controller-approved
// room_join_requests row. Calls thenDo(err, bool).
function canJoinRoom(constellation, room, did, thenDo) {
  if (!canWrite(constellation, did)) return thenDo(null, false);
  if (room.access !== 'request') return thenDo(null, true);
  getRoomJoinRequestStatus(room.id, did, function(err, status) {
    if (err) return thenDo(err);
    thenDo(null, status === 'approved');
  });
}

module.exports = {
  withDB: withDB,
  isValidName: isValidName,
  RESERVED_NAMES: RESERVED_NAMES,
  create: create,
  exists: exists,
  listPublic: listPublic,
  get: get,
  getByGenesisObjId: getByGenesisObjId,
  canRead: canRead,
  canWrite: canWrite,
  isController: isController,
  addMember: addMember,
  requestJoin: requestJoin,
  getJoinRequestStatus: getJoinRequestStatus,
  listPendingJoinRequests: listPendingJoinRequests,
  approveJoinRequest: approveJoinRequest,
  declineJoinRequest: declineJoinRequest,
  listByController: listByController,
  createInvite: createInvite,
  getInviteStatus: getInviteStatus,
  approveInvite: approveInvite,
  declineInvite: declineInvite,
  createEvent: createEvent,
  getNextEvent: getNextEvent,
  createRoom: createRoom,
  listRooms: listRooms,
  getRoom: getRoom,
  requestRoomJoin: requestRoomJoin,
  getRoomJoinRequestStatus: getRoomJoinRequestStatus,
  listPendingRoomJoinRequests: listPendingRoomJoinRequests,
  approveRoomJoinRequest: approveRoomJoinRequest,
  declineRoomJoinRequest: declineRoomJoinRequest,
  canJoinRoom: canJoinRoom
};
