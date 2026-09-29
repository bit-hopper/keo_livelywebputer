/**
 * core/servers/identity/RoomEphemeralMessages.js
 *
 * Transient message relay for ephemeral rooms (room.ephemeral === true, see
 * ConstellationRegistry.js) -- same two-backing, one-API split as
 * RoomPresence.js, chosen once at module load:
 *   - REDIS_URL set: support/room-ephemeral-messages-redis.js.
 *   - otherwise: the in-memory object below (single process only).
 *
 * Deliberately separate from ObjectRepository.js: a persistent room's
 * messages are signed postcards, durably stored and searchable
 * (IdentityServer.js's rooms/:roomId/messages routes,
 * ObjectRepository.listMessagesForRoom). An ephemeral room's messages here
 * are plain {did, handle, text, created} records, trusted via the same
 * authenticated-session model room presence already uses -- never signed,
 * never written to Postgres, gone shortly after the room empties out.
 */

'use strict';

var MAX_MESSAGES = 500;
var KEY_TTL_MS = 300 * 1000; // matches support/room-ephemeral-messages-redis.js's KEY_TTL_S
var SWEEP_INTERVAL_MS = 30 * 1000;

var USE_REDIS = !!process.env.REDIS_URL;
var redisStore = USE_REDIS ? require('../support/room-ephemeral-messages-redis') : null;

// -- in-memory backing -------------------------------------------------------

// roomId -> { messages: [{did, handle, text, created}, ...], lastAppend }
var _rooms = {};

function appendLocal(roomId, message) {
  var room = _rooms[roomId];
  if (!room) room = _rooms[roomId] = { messages: [], lastAppend: 0 };
  room.messages.push(message);
  if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
  room.lastAppend = Date.now();
}

function listSinceLocal(roomId, sinceTs, limit) {
  var room = _rooms[roomId];
  if (!room) return [];
  var matched = room.messages.filter(function (m) { return m.created > sinceTs; });
  matched.sort(function (a, b) { return b.created - a.created; }); // newest-first
  return matched.slice(0, limit);
}

// No presence hook here (that would couple this module to RoomPresence.js) --
// a room's buffer just goes quiet along with the room and ages out on its
// own once nothing's been appended in KEY_TTL_MS, same as the Redis key's
// own EXPIRE-refreshed-on-write behavior.
function sweep() {
  var now = Date.now();
  Object.keys(_rooms).forEach(function (roomId) {
    if (now - _rooms[roomId].lastAppend > KEY_TTL_MS) delete _rooms[roomId];
  });
}

// -- public API (always Promise-returning) -----------------------------------

function append(roomId, message) {
  if (USE_REDIS) return redisStore.append(roomId, message);
  appendLocal(roomId, message);
  return Promise.resolve();
}

// [{did, handle, text, created}, ...], newest-first, created > sinceTs.
function listSince(roomId, sinceTs, limit) {
  if (USE_REDIS) return redisStore.listSince(roomId, sinceTs, limit);
  return Promise.resolve(listSinceLocal(roomId, sinceTs, limit));
}

// Only meaningful in memory mode: the Redis key's own EXPIRE handles it there.
function startSweeping() {
  if (USE_REDIS) return;
  setInterval(sweep, SWEEP_INTERVAL_MS);
}

module.exports = {
  append: append,
  listSince: listSince,
  sweep: sweep,
  startSweeping: startSweeping
};
