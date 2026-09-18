// Redis-backed store for RoomPresence.js's "who's in this room right now" --
// used only when that file has decided, once at its own module-load time
// (REDIS_URL set), to run in Redis mode. Same opt-in idiom as
// room-peer-registry-redis.js / dm-presence-registry.js.
//
// Why it exists: presence used to be a plain per-process object, which is
// wrong the moment the server runs more than one process (--workers N, or
// several instances): a join (POST .../presence) handled by one worker was
// invisible to a roster read (GET .../rooms/:id, GET .../rooms) handled by
// another, so a room you'd just joined intermittently listed nobody, and
// iJoined flipped between true and false from request to request. Sharing
// it through Redis makes every worker see the same room.
//
// Shape: one Redis HASH per room, `lk:room:{roomId}:presence`, field = DID,
// value = JSON {handle, lastSeen}. There is deliberately no separate
// per-entry Redis TTL: freshness is judged on read against `lastSeen`
// (HEARTBEAT_TIMEOUT_MS, same 75s the in-memory version used), and any stale
// entry a read trips over is HDEL'd on the spot. The whole key also carries
// a longer EXPIRE (refreshed on every touch) purely so an abandoned room's
// hash can't sit in Redis forever. Together those cover the crash case a
// missing DELETE can't: a tab that just vanished simply stops touching, and
// falls out of the roster ~75s later -- no sweep timer needed, so this
// module has no background work at all.
//
// Clock: `lastSeen` is written and compared with each process's own
// Date.now(). Workers on one machine share a clock; across machines a skew
// of a few seconds is small against the 75s window.
'use strict';

var redisClient = require('./redis-client');

var HEARTBEAT_TIMEOUT_MS = 75 * 1000;   // same as the in-memory implementation
var KEY_TTL_S = 300;                    // GC for a room nobody has touched in 5 minutes

// Hash-tagged, matching the room-peer-registry-redis.js key convention.
function presenceKey(roomId) { return 'lk:room:{' + roomId + '}:presence'; }

// Join-or-heartbeat. Resolves once Redis has accepted the write, so a caller
// that reads the roster right after it (the join POST's own response, a
// client's immediate refresh) is guaranteed to see the entry.
exports.touch = function (roomId, did, handle) {
  var key = presenceKey(roomId);
  return redisClient.getClient().pipeline()
    .hset(key, did, JSON.stringify({ handle: handle || null, lastSeen: Date.now() }))
    .expire(key, KEY_TTL_S)
    .exec()
    .then(function (results) {
      for (var i = 0; i < results.length; i++) if (results[i][0]) throw results[i][0];
    });
};

exports.leave = function (roomId, did) {
  return redisClient.getClient().hdel(presenceKey(roomId), did).then(function () {});
};

// [{did, handle}, ...] for everyone with a fresh heartbeat. Sorted (by
// handle, then DID) so the order is stable from one request to the next --
// HGETALL's own field order isn't something callers should depend on, and
// the client lays video circles out by roster position.
exports.roster = function (roomId) {
  var key = presenceKey(roomId);
  var client = redisClient.getClient();
  return client.hgetall(key).then(function (byDid) {
    var now = Date.now();
    var fresh = [], staleDids = [];
    Object.keys(byDid || {}).forEach(function (did) {
      var entry;
      try { entry = JSON.parse(byDid[did]); } catch (e) { entry = null; }
      if (entry && now - entry.lastSeen <= HEARTBEAT_TIMEOUT_MS) fresh.push({ did: did, handle: entry.handle });
      else staleDids.push(did);
    });
    if (staleDids.length) {
      // Fire-and-forget cleanup: the caller's answer doesn't depend on it.
      client.hdel.apply(client, [key].concat(staleDids)).catch(function (e) {
        console.error('[room-presence-redis] stale cleanup failed:', e.message);
      });
    }
    fresh.sort(function (a, b) {
      var ha = a.handle || '', hb = b.handle || '';
      return ha < hb ? -1 : ha > hb ? 1 : (a.did < b.did ? -1 : a.did > b.did ? 1 : 0);
    });
    return fresh;
  });
};
