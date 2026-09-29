// Redis-backed transient message relay for ephemeral rooms (room.ephemeral
// === true, see ConstellationRegistry.js) -- same opt-in Redis idiom as
// room-presence-redis.js, and deliberately built alongside it rather than
// folded into ObjectRepository.js: these messages never become postcards.
// A persistent room's messages are signed objects, durably stored, and
// searchable (IdentityServer.js's rooms/:roomId/messages routes,
// ObjectRepository.listMessagesForRoom). An ephemeral room's messages are
// plain {did, handle, text, created} records, trusted via the same
// authenticated-session model room presence already uses (auth.requireAuth
// + req.identity.did) -- never signed, never written to Postgres.
//
// Shape: one Redis LIST per room, `lk:room:{roomId}:ephemeral-messages`,
// each element a JSON-encoded message. Capped to MAX_MESSAGES via LTRIM on
// every append (pure memory safety valve, not a user-facing history depth --
// a joining client only ever sees messages after its own joinedAt, see
// room-presence-redis.js's joinedAt tracking). The whole key carries a
// short EXPIRE, refreshed on every append, so a room nobody's posted in
// recently -- in practice, a room everyone's left -- has its buffer vanish
// on its own; no separate cleanup job.
'use strict';

var redisClient = require('./redis-client');

var MAX_MESSAGES = 500;
var KEY_TTL_S = 300; // same window room-presence-redis.js uses for its own GC

function messagesKey(roomId) { return 'lk:room:{' + roomId + '}:ephemeral-messages'; }

// message: {did, handle, text, created}. Resolves once Redis has accepted
// the write.
exports.append = function (roomId, message) {
  var key = messagesKey(roomId);
  return redisClient.getClient().pipeline()
    .rpush(key, JSON.stringify(message))
    .ltrim(key, -MAX_MESSAGES, -1)
    .expire(key, KEY_TTL_S)
    .exec()
    .then(function (results) {
      for (var i = 0; i < results.length; i++) if (results[i][0]) throw results[i][0];
    });
};

// [{did, handle, text, created}, ...], newest-first, created > sinceTs
// (epoch ms), capped at `limit`. sinceTs is the viewer's own joinedAt (see
// room-presence-redis.js's getEntry) -- this is what makes a fresh join see
// nothing from before it, rather than "the room's last N messages".
exports.listSince = function (roomId, sinceTs, limit) {
  var key = messagesKey(roomId);
  return redisClient.getClient().lrange(key, 0, -1).then(function (raw) {
    var parsed = [];
    (raw || []).forEach(function (json) {
      var m;
      try { m = JSON.parse(json); } catch (e) { m = null; }
      if (m && m.created > sinceTs) parsed.push(m);
    });
    parsed.sort(function (a, b) { return b.created - a.created; }); // newest-first
    return parsed.slice(0, limit);
  });
};
