/**
 * core/servers/identity/RoomPresence.js
 *
 * In-memory, per-process tracker for "who's currently in a room right now"
 * (ConstellationLounge.js's Spaces panel) — deliberately NOT SQLite-backed
 * like ConstellationRegistry.js's `rooms`/`room_join_requests` tables.
 * Presence is inherently ephemeral (it should reflect who's actually
 * connected right now, not survive a restart), so this stays a plain
 * module-local object rather than a registry table.
 *
 * Clients join a room via POST /c/:name/rooms/:roomId/presence and then
 * re-send the same request as a heartbeat every ~25s while the room stays
 * "joined" client-side (ConstellationLounge.js's _startHeartbeat). An
 * explicit DELETE removes a participant immediately; the periodic sweep()
 * below covers the case where a client disappears without calling DELETE
 * (tab crash, network loss) by pruning anyone whose last heartbeat is
 * older than HEARTBEAT_TIMEOUT_MS.
 */

'use strict';

var HEARTBEAT_TIMEOUT_MS = 75 * 1000;   // prune if no heartbeat in 75s
var SWEEP_INTERVAL_MS = 30 * 1000;

// roomId -> { did -> { handle, lastSeen } }
var _rooms = {};

// Join-or-heartbeat — calling this again for the same (roomId, did) just
// refreshes lastSeen.
function touch(roomId, did, handle) {
  if (!_rooms[roomId]) _rooms[roomId] = {};
  _rooms[roomId][did] = { handle: handle || null, lastSeen: Date.now() };
}

function leave(roomId, did) {
  if (_rooms[roomId]) delete _rooms[roomId][did];
}

// maxSeed caps the DID list returned for avatar rendering — the client's
// _renderRoomCard (ConstellationLounge.js) only ever shows the first 4
// participants anyway (MAX_SHOWN), so there's no reason to send more.
function summary(roomId, maxSeed) {
  var byDid = _rooms[roomId] || {};
  var dids = Object.keys(byDid);
  return { count: dids.length, seedDids: dids.slice(0, maxSeed || 4) };
}

function isPresent(roomId, did) {
  return !!(_rooms[roomId] && _rooms[roomId][did]);
}

function sweep() {
  var now = Date.now();
  Object.keys(_rooms).forEach(function (roomId) {
    var byDid = _rooms[roomId];
    Object.keys(byDid).forEach(function (did) {
      if (now - byDid[did].lastSeen > HEARTBEAT_TIMEOUT_MS) delete byDid[did];
    });
    if (!Object.keys(byDid).length) delete _rooms[roomId];
  });
}

function startSweeping() {
  setInterval(sweep, SWEEP_INTERVAL_MS);
}

module.exports = {
  touch: touch,
  leave: leave,
  summary: summary,
  isPresent: isPresent,
  sweep: sweep,
  startSweeping: startSweeping
};
