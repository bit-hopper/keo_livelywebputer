/**
 * core/servers/identity/RoomPresence.js
 *
 * Tracker for "who's currently in a room right now" (ConstellationLounge.js's
 * Spaces panel, and lively.identity.RoomView's member list) -- deliberately NOT
 * SQLite-backed like ConstellationRegistry.js's `rooms`/`room_join_requests`
 * tables. Presence is inherently ephemeral (it should reflect who's actually
 * connected right now, not survive a restart), so it lives either in this
 * module's own memory or, when REDIS_URL is set, in Redis.
 *
 * Two backings, one API, chosen once at module load (same opt-in convention as
 * RoomSignalingServer.js's registry):
 *   - REDIS_URL set: support/room-presence-redis.js. Required as soon as the
 *     server runs more than one process (--workers N, several instances):
 *     per-process memory means a join handled by one worker is invisible to
 *     a roster read handled by another.
 *   - otherwise: the in-memory object below (single process only).
 * Every function returns a Promise either way, so callers never branch on
 * which is active.
 *
 * Clients join a room via POST /c/:name/rooms/:roomId/presence and then
 * re-send the same request as a heartbeat every ~25s while the room stays
 * "joined" (ConstellationLounge.js's _startHeartbeat / RoomView.js's
 * _startHeartbeat). An explicit DELETE removes a participant immediately; a
 * client that disappears without calling DELETE (tab crash, network loss) is
 * pruned once its last heartbeat is older than HEARTBEAT_TIMEOUT_MS -- by the
 * periodic sweep() in memory mode, on read in Redis mode.
 */

'use strict';

var HEARTBEAT_TIMEOUT_MS = 75 * 1000;   // prune if no heartbeat in 75s
var SWEEP_INTERVAL_MS = 30 * 1000;

var USE_REDIS = !!process.env.REDIS_URL;
var redisStore = USE_REDIS ? require('../support/room-presence-redis') : null;

// -- in-memory backing -------------------------------------------------------

// roomId -> { did -> { handle, lastSeen, joinedAt } }
var _rooms = {};

// joinedAt is set once per session: kept from the existing entry as long as
// it's still fresh (an ongoing heartbeat), reset to now() on a genuine first
// join or a reconnect after going stale -- same rule room-presence-redis.js's
// touch() applies, so ephemeral-room "zero scrollback" behaves the same in
// both backings.
function touchLocal(roomId, did, handle) {
  if (!_rooms[roomId]) _rooms[roomId] = {};
  var existing = _rooms[roomId][did];
  var now = Date.now();
  var joinedAt = (existing && now - existing.lastSeen <= HEARTBEAT_TIMEOUT_MS) ? existing.joinedAt : now;
  _rooms[roomId][did] = { handle: handle || null, lastSeen: now, joinedAt: joinedAt };
}

function leaveLocal(roomId, did) {
  if (_rooms[roomId]) delete _rooms[roomId][did];
}

function getEntryLocal(roomId, did) {
  var entry = (_rooms[roomId] || {})[did];
  if (!entry || Date.now() - entry.lastSeen > HEARTBEAT_TIMEOUT_MS) return null;
  return entry;
}

// [{did, handle}, ...], insertion order.
function rosterLocal(roomId) {
  var byDid = _rooms[roomId] || {};
  return Object.keys(byDid).map(function (did) {
    return { did: did, handle: byDid[did].handle };
  });
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

// -- public API (always Promise-returning) -----------------------------------

// Join-or-heartbeat -- calling this again for the same (roomId, did) just
// refreshes lastSeen. Resolves once the write is visible to roster().
function touch(roomId, did, handle) {
  if (USE_REDIS) return redisStore.touch(roomId, did, handle);
  touchLocal(roomId, did, handle);
  return Promise.resolve();
}

function leave(roomId, did) {
  if (USE_REDIS) return redisStore.leave(roomId, did);
  leaveLocal(roomId, did);
  return Promise.resolve();
}

// Everyone currently present, uncapped -- the room's member list needs the
// full roster, and callers derive the rest from it: a headcount is
// `.length`, "am I in it" is `.some(p => p.did === myDid)`, and a room
// card's stacked-avatar preview is the first few DIDs.
function roster(roomId) {
  if (USE_REDIS) return redisStore.roster(roomId);
  return Promise.resolve(rosterLocal(roomId));
}

// {handle, lastSeen, joinedAt} for one DID's current session, or null if
// they're not present. Used by IdentityServer.js's ephemeral-room messages
// GET route to know how far back a viewer's own "since I joined" window
// starts -- see RoomEphemeralMessages.js.
function getEntry(roomId, did) {
  if (USE_REDIS) return redisStore.getEntry(roomId, did);
  return Promise.resolve(getEntryLocal(roomId, did));
}

// Only meaningful in memory mode: Redis mode prunes on read instead.
function startSweeping() {
  if (USE_REDIS) return;
  setInterval(sweep, SWEEP_INTERVAL_MS);
}

module.exports = {
  touch: touch,
  leave: leave,
  roster: roster,
  getEntry: getEntry,
  sweep: sweep,
  startSweeping: startSweeping
};
