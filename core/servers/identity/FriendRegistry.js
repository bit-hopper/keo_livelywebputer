/**
 * core/servers/identity/FriendRegistry.js
 *
 * SQLite-backed friend requests + friendships, shared by IdentityServer.js's
 * HTTP routes. Deliberately NOT modeled as postcard/object envelopes —
 * mirrors ConstellationRegistry.js's join_requests table instead (its own
 * dedicated table, queried directly by the recipient), the same pattern
 * that keeps constellation join requests out of the postcard feed. A
 * generic-envelope approach was considered and rejected: comment-thread
 * replies once leaked into the postcard feed by reusing the same envelope
 * shape/listing queries as top-level postcards (fixed in 142a07d) — a new
 * purpose sharing that pipeline is only as safe as every listing query's
 * filtering, and friend requests have no natural fit in it anyway (postcard
 * delivery, POST /@:handle/inbox, requires the sender to already own/have
 * access to a real object envelope).
 *
 * Schema:
 *   friend_requests table: one row per (requester_did, target_did) — a
 *     re-request after a decline overwrites the old row back to pending,
 *     same overwrite-on-re-request shape as join_requests.
 *     requester_did  TEXT NOT NULL
 *     target_did     TEXT NOT NULL
 *     requested_at   TEXT NOT NULL
 *     status         TEXT NOT NULL DEFAULT 'pending'  -- pending|accepted|declined
 *     PRIMARY KEY (requester_did, target_did)
 *
 *   friendships table: one row per confirmed friend pair, undirected —
 *     stored once under a canonical (did_a, did_b) ordering (lexicographic)
 *     so "are X and Y friends" and "list X's friends" each need only query
 *     one table without worrying about which side originally requested.
 *     did_a       TEXT NOT NULL
 *     did_b       TEXT NOT NULL  -- did_a < did_b
 *     created_at  TEXT NOT NULL
 *     PRIMARY KEY (did_a, did_b)
 *
 * The DB file is stored at <WORKSPACE_LK>/identity/friends.db. Created
 * automatically on first use.
 */

'use strict';

var path    = require('path');
var sqlite3 = require('sqlite3').verbose();

var DB_PATH = path.join(
  process.env.WORKSPACE_LK || process.cwd(),
  'identity',
  'friends.db'
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
      'CREATE TABLE IF NOT EXISTS friend_requests (' +
      '  requester_did  TEXT NOT NULL,' +
      '  target_did     TEXT NOT NULL,' +
      '  requested_at   TEXT NOT NULL,' +
      '  status         TEXT NOT NULL DEFAULT \'pending\',' +
      '  PRIMARY KEY (requester_did, target_did)' +
      ')',
      function(err) {
        if (err) return thenDo(err);
        db.run(
          'CREATE TABLE IF NOT EXISTS friendships (' +
          '  did_a       TEXT NOT NULL,' +
          '  did_b       TEXT NOT NULL,' +
          '  created_at  TEXT NOT NULL,' +
          '  PRIMARY KEY (did_a, did_b)' +
          ')',
          function(err) { thenDo(err || null, db); }
        );
      }
    );
  });
}

// Canonical (low, high) ordering for the undirected friendships table.
function _pair(didA, didB) {
  return didA < didB ? [didA, didB] : [didB, didA];
}

// ─── friendships ────────────────────────────────────────────────────────────

// Calls thenDo(null, true|false).
function areFriends(didA, didB, thenDo) {
  var pair = _pair(didA, didB);
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get('SELECT 1 FROM friendships WHERE did_a = ? AND did_b = ?', pair, function(err, row) {
      thenDo(err || null, !!row);
    });
  });
}

// Calls thenDo(null, [{ did, since }, ...]), newest first.
function listFriends(did, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all(
      'SELECT did_a, did_b, created_at FROM friendships WHERE did_a = ? OR did_b = ? ORDER BY created_at DESC',
      [did, did],
      function(err, rows) {
        if (err) return thenDo(err);
        thenDo(null, (rows || []).map(function(r) {
          return { did: r.did_a === did ? r.did_b : r.did_a, since: r.created_at };
        }));
      }
    );
  });
}

// Idempotent. Calls thenDo(err).
function _createFriendship(didA, didB, thenDo) {
  var pair = _pair(didA, didB);
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'INSERT OR IGNORE INTO friendships (did_a, did_b, created_at) VALUES (?, ?, ?)',
      [pair[0], pair[1], new Date().toISOString()],
      function(err) { thenDo(err || null); }
    );
  });
}

// Calls thenDo(err).
function removeFriendship(didA, didB, thenDo) {
  var pair = _pair(didA, didB);
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run('DELETE FROM friendships WHERE did_a = ? AND did_b = ?', pair, function(err) {
      thenDo(err || null);
    });
  });
}

// ─── friend requests ────────────────────────────────────────────────────────

// Calls thenDo(null, 'pending'|'accepted'|'declined'|null) — null means no
// request on file in this direction.
function getRequestStatus(requesterDid, targetDid, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.get(
      'SELECT status FROM friend_requests WHERE requester_did = ? AND target_did = ?',
      [requesterDid, targetDid],
      function(err, row) {
        if (err) return thenDo(err);
        thenDo(null, row ? row.status : null);
      }
    );
  });
}

// Sends a friend request from requesterDid to targetDid. Three cases:
//   - already friends: no-op, resolves as 'accepted' (idempotent for a
//     stale client that doesn't yet know the request was accepted).
//   - targetDid already has a PENDING request in flight to requesterDid
//     (crossed in the mail — both sent a request to each other): treated
//     as a mutual accept rather than leaving two dangling pending rows.
//   - otherwise: upsert requester->target as pending (a re-request after a
//     decline resets to pending, same overwrite semantics as join_requests).
// Calls thenDo(err, { status: 'pending'|'accepted' }).
function sendRequest(requesterDid, targetDid, thenDo) {
  areFriends(requesterDid, targetDid, function(err, already) {
    if (err) return thenDo(err);
    if (already) return thenDo(null, { status: 'accepted' });

    getRequestStatus(targetDid, requesterDid, function(err, reverseStatus) {
      if (err) return thenDo(err);

      if (reverseStatus === 'pending') {
        return _createFriendship(requesterDid, targetDid, function(err) {
          if (err) return thenDo(err);
          withDB(function(err, db) {
            if (err) return thenDo(err);
            db.run(
              'UPDATE friend_requests SET status = \'accepted\' WHERE requester_did = ? AND target_did = ?',
              [targetDid, requesterDid],
              function(err) {
                if (err) return thenDo(err);
                db.run(
                  'INSERT INTO friend_requests (requester_did, target_did, requested_at, status)' +
                  ' VALUES (?, ?, ?, \'accepted\')' +
                  ' ON CONFLICT(requester_did, target_did) DO UPDATE SET status = \'accepted\'',
                  [requesterDid, targetDid, new Date().toISOString()],
                  function(err) { thenDo(err || null, { status: 'accepted' }); }
                );
              }
            );
          });
        });
      }

      withDB(function(err, db) {
        if (err) return thenDo(err);
        db.run(
          'INSERT INTO friend_requests (requester_did, target_did, requested_at, status) VALUES (?, ?, ?, \'pending\')' +
          ' ON CONFLICT(requester_did, target_did) DO UPDATE SET requested_at = excluded.requested_at, status = \'pending\'',
          [requesterDid, targetDid, new Date().toISOString()],
          function(err) { thenDo(err || null, { status: 'pending' }); }
        );
      });
    });
  });
}

// Calls thenDo(null, [{ did, requestedAt }, ...]), oldest first.
function listIncomingPending(targetDid, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all(
      'SELECT requester_did, requested_at FROM friend_requests WHERE target_did = ? AND status = \'pending\' ORDER BY requested_at ASC',
      [targetDid],
      function(err, rows) {
        if (err) return thenDo(err);
        thenDo(null, (rows || []).map(function(r) { return { did: r.requester_did, requestedAt: r.requested_at }; }));
      }
    );
  });
}

// Approving creates the friendship AND marks the request accepted, in that
// order — a crash between the two leaves a stray 'accepted' row with no
// friendship rather than a silent friendship with no record, the safer
// failure mode to notice and retry (same reasoning as approveJoinRequest).
// Calls thenDo(err).
function approveRequest(requesterDid, targetDid, thenDo) {
  _createFriendship(requesterDid, targetDid, function(err) {
    if (err) return thenDo(err);
    withDB(function(err, db) {
      if (err) return thenDo(err);
      db.run(
        'UPDATE friend_requests SET status = \'accepted\' WHERE requester_did = ? AND target_did = ?',
        [requesterDid, targetDid],
        function(err) { thenDo(err || null); }
      );
    });
  });
}

// Calls thenDo(err).
function declineRequest(requesterDid, targetDid, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'UPDATE friend_requests SET status = \'declined\' WHERE requester_did = ? AND target_did = ?',
      [requesterDid, targetDid],
      function(err) { thenDo(err || null); }
    );
  });
}

// Withdraws a request the caller themselves sent (as opposed to
// declineRequest, which is the RECIPIENT rejecting it) — a distinct status
// so it reads correctly in either party's history rather than looking like
// a rejection. Calls thenDo(err).
function cancelRequest(requesterDid, targetDid, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.run(
      'UPDATE friend_requests SET status = \'cancelled\' WHERE requester_did = ? AND target_did = ?',
      [requesterDid, targetDid],
      function(err) { thenDo(err || null); }
    );
  });
}

// Calls thenDo(null, [{ did, requestedAt }, ...]), oldest first. Mirrors
// listIncomingPending but for the caller's own outstanding sent requests —
// backs the mailbox's Friends tab "Sent" section and the Cancel action.
function listOutgoingPending(requesterDid, thenDo) {
  withDB(function(err, db) {
    if (err) return thenDo(err);
    db.all(
      'SELECT target_did, requested_at FROM friend_requests WHERE requester_did = ? AND status = \'pending\' ORDER BY requested_at ASC',
      [requesterDid],
      function(err, rows) {
        if (err) return thenDo(err);
        thenDo(null, (rows || []).map(function(r) { return { did: r.target_did, requestedAt: r.requested_at }; }));
      }
    );
  });
}

module.exports = {
  areFriends: areFriends,
  listFriends: listFriends,
  removeFriendship: removeFriendship,
  getRequestStatus: getRequestStatus,
  sendRequest: sendRequest,
  listIncomingPending: listIncomingPending,
  listOutgoingPending: listOutgoingPending,
  approveRequest: approveRequest,
  declineRequest: declineRequest,
  cancelRequest: cancelRequest,
};
