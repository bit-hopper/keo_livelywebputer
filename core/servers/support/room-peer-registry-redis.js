// Redis-backed replacement for RoomSignalingServer.js's in-memory
// `rooms`/`peers` maps -- used only when that file has decided, once at its
// own module-load time, to run in Redis-backplane mode (see its own header
// for the opt-in condition). Same "uniform API, callers don't need to know
// the internals" idiom room-token-store.js already established in this
// codebase, but this problem needs more than IPC-to-a-single-primary can
// give: cluster IPC only bridges workers of *one* process via its primary,
// and this needs to bridge separate machine instances too, so it goes
// through Redis pub/sub instead.
//
// Design in one paragraph: every join/signal/leave event is PUBLISHed to a
// per-room Redis channel; the *only* place a message ever reaches a local
// WebSocket is this module's own subscriber 'message' handler, filtered
// against this process's own `localPeers` map. That's true even for two
// peers who happen to be on the *same* process -- one delivery path, always,
// rather than a local-broadcast path and a cross-process path that could
// double-deliver or drift apart. Room membership itself lives in a Redis
// HASH (`lk:room:{id}:peers`) so a newly-joining peer -- wherever it lands --
// can learn the full roster, not just whoever's local.
//
// The one problem pub/sub can't solve for free: an entire worker process
// can crash mid-call, and no `connection.on('close', ...)` ever fires for
// the peers it was holding, so without help they'd sit in the Redis HASH as
// permanent "ghosts" -- visible to new joiners, unreachable, forever. Fixed
// with a lightweight per-peer heartbeat (a Redis STRING with a TTL, refreshed
// every HEARTBEAT_INTERVAL_MS by whichever process actually holds that
// peer's live connection) plus a periodic sweep, folded into that same timer,
// that HDELs any roster entry whose heartbeat has expired and announces its
// departure. The sweep runs on a fixed interval for every room this process
// currently cares about (not just at join time) -- a small, stable mesh call
// where nobody else ever joins or leaves would otherwise carry a ghost for
// its entire remaining duration if the sweep only ran at join time.
'use strict';

var redisClient = require('./redis-client');

var HEARTBEAT_INTERVAL_MS = 15 * 1000;
var HEARTBEAT_TTL_S = 45;
var UNSUBSCRIBE_GRACE_MS = 5 * 1000;

// peerId -> {connection, did, handle, roomId}. The only place actual
// WebSocket connection objects live -- Redis only ever holds
// did/handle/roomId, never a connection.
var localPeers = {};

// roomId -> count of local peers currently in that room. Drives refcounted
// subscribe/unsubscribe to that room's Redis channel (below).
var roomRefcounts = {};
// roomId -> pending unsubscribe Timeout, while a room's local refcount has
// hit 0 but the grace period (see releaseSubscription) hasn't elapsed yet.
var roomUnsubscribeTimers = {};

var heartbeatTimerHandle = null;

// Hash-tagged (the `{...}` around roomId) so all three key patterns for one
// room land on the same shard if this ever moves to Redis Cluster -- not
// needed today (no multi-key atomicity across them), but free to do now.
function peersKey(roomId) { return 'lk:room:{' + roomId + '}:peers'; }
function hbKey(roomId, peerId) { return 'lk:room:{' + roomId + '}:hb:' + peerId; }
function eventsChannel(roomId) { return 'lk:room:{' + roomId + '}:events'; }

// A per-field Hash TTL (Redis 7.4+'s HEXPIRE) would let the roster HASH and
// the heartbeat live in one structure -- deliberately not used here so this
// works against older Redis versions too, which many managed providers
// still run. Don't "simplify" this into HEXPIRE without checking the
// deployment target's Redis version first.
function refreshHeartbeat(roomId, peerId) {
  return redisClient.getClient().set(hbKey(roomId, peerId), '1', 'EX', HEARTBEAT_TTL_S);
}

function broadcastLocal(roomId, exceptPeerId, wireMsg) {
  Object.keys(localPeers).forEach(function (id) {
    var p = localPeers[id];
    if (p.roomId === roomId && id !== exceptPeerId) p.connection.send(wireMsg);
  });
}

// HDELs each stale id from the roster and announces its departure so
// already-connected peers in the room learn the ghost is gone too.
function removeStalePeers(roomId, staleIds) {
  var client = redisClient.getClient();
  var pipeline = client.pipeline();
  staleIds.forEach(function (id) { pipeline.hdel(peersKey(roomId), id); });
  return pipeline.exec().then(function () {
    return Promise.all(staleIds.map(function (id) {
      return client.publish(eventsChannel(roomId), JSON.stringify({ type: 'peer-left', roomId: roomId, peerId: id }));
    }));
  });
}

// Builds the peer list to hand back to a newly-joined peer, dropping (and
// cleaning up) any roster entry whose heartbeat has already expired.
function sweepAndListRoom(roomId, roster, joiningPeerId) {
  var client = redisClient.getClient();
  var otherIds = Object.keys(roster).filter(function (id) { return id !== joiningPeerId; });
  if (!otherIds.length) return Promise.resolve([]);

  var pipeline = client.pipeline();
  otherIds.forEach(function (id) { pipeline.exists(hbKey(roomId, id)); });
  return pipeline.exec().then(function (results) {
    var aliveIds = [], staleIds = [];
    otherIds.forEach(function (id, i) {
      if (results[i][1]) aliveIds.push(id); else staleIds.push(id);
    });
    var cleanup = staleIds.length ? removeStalePeers(roomId, staleIds) : Promise.resolve();
    return cleanup.then(function () {
      return aliveIds.map(function (id) {
        var meta;
        try { meta = JSON.parse(roster[id]); } catch (e) { meta = {}; }
        return { peerId: id, did: meta.did, handle: meta.handle };
      });
    });
  });
}

function ensureSubscribed(roomId) {
  var count = roomRefcounts[roomId] || 0;
  roomRefcounts[roomId] = count + 1;
  if (roomUnsubscribeTimers[roomId]) {
    clearTimeout(roomUnsubscribeTimers[roomId]);
    delete roomUnsubscribeTimers[roomId];
  }
  if (count === 0) return redisClient.getSubscriber().subscribe(eventsChannel(roomId));
  return Promise.resolve();
}

// Doesn't unsubscribe immediately when a room's local refcount hits 0 --
// Redis pub/sub has no replay, so an immediate unsubscribe followed shortly
// by a rejoin (same process) would open a real message-loss window between
// the UNSUBSCRIBE and the next SUBSCRIBE. Waits out a short grace period
// instead; ensureSubscribed cancels the pending timer if a new local peer
// joins that room before it fires.
function releaseSubscription(roomId) {
  var count = (roomRefcounts[roomId] || 1) - 1;
  roomRefcounts[roomId] = count;
  if (count > 0) return;
  roomUnsubscribeTimers[roomId] = setTimeout(function () {
    delete roomUnsubscribeTimers[roomId];
    delete roomRefcounts[roomId];
    redisClient.getSubscriber().unsubscribe(eventsChannel(roomId));
  }, UNSUBSCRIBE_GRACE_MS);
  roomUnsubscribeTimers[roomId].unref();
}

function ensureHeartbeatTimerRunning() {
  if (heartbeatTimerHandle) return;
  heartbeatTimerHandle = setInterval(runHeartbeatSweep, HEARTBEAT_INTERVAL_MS);
  heartbeatTimerHandle.unref();
}

// Runs on every tick for every room this process currently holds >=1 local
// peer in: (a) refreshes this process's own peers' heartbeats, (b)
// re-announces them (a cheap, idempotent self-heal for the rare case where
// an earlier HSET succeeded but the PUBLISH that should have told the rest
// of the room about it was lost to a Redis blip -- RoomView.js's
// peer-joined handler is a confirmed no-op for a peer it already has a
// connection for, so a duplicate announcement is harmless), and (c) prunes
// any *other* roster entry whose heartbeat has expired (the crash-recovery
// case described in this file's header).
function runHeartbeatSweep() {
  var client = redisClient.getClient();
  // Keyed by the *stringified* roomId (plain-object keys are always
  // strings) but the value keeps the original type -- roomId is a numeric
  // DB id, and localPeers[id].roomId === roomId below needs the original
  // type or every comparison silently fails (number !== its own string form
  // under ===).
  var roomIdsByKey = {};
  Object.keys(localPeers).forEach(function (id) {
    var roomId = localPeers[id].roomId;
    roomIdsByKey[roomId] = roomId;
  });

  Object.keys(roomIdsByKey).forEach(function (key) {
    var roomId = roomIdsByKey[key];
    var localIdsInRoom = Object.keys(localPeers).filter(function (id) { return localPeers[id].roomId === roomId; });

    localIdsInRoom.forEach(function (id) {
      var p = localPeers[id];
      refreshHeartbeat(roomId, id).catch(function (e) {
        console.error('[room-peer-registry-redis] heartbeat refresh failed:', e.message);
      });
      client.publish(eventsChannel(roomId), JSON.stringify({
        type: 'peer-joined', roomId: roomId, peerId: id, did: p.did, handle: p.handle
      })).catch(function (e) {
        console.error('[room-peer-registry-redis] re-announce failed:', e.message);
      });
    });

    client.hgetall(peersKey(roomId)).then(function (roster) {
      var otherIds = Object.keys(roster).filter(function (id) { return localIdsInRoom.indexOf(id) === -1; });
      if (!otherIds.length) return;
      var pipeline = client.pipeline();
      otherIds.forEach(function (id) { pipeline.exists(hbKey(roomId, id)); });
      return pipeline.exec().then(function (results) {
        var staleIds = otherIds.filter(function (id, i) { return !results[i][1]; });
        if (staleIds.length) return removeStalePeers(roomId, staleIds);
      });
    }).catch(function (e) {
      console.error('[room-peer-registry-redis] heartbeat sweep failed for room ' + roomId + ':', e.message);
    });
  });
}

// Set up once at module load: one shared subscriber connection, one
// listener dispatching every room's traffic by the `roomId`/`type` embedded
// in the message payload (simpler and less error-prone than parsing the
// channel name back apart).
redisClient.getSubscriber().on('message', function (channel, raw) {
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }

  if (msg.type === 'peer-joined') {
    broadcastLocal(msg.roomId, msg.peerId, { action: 'peer-joined', data: { peerId: msg.peerId, did: msg.did, handle: msg.handle } });
  } else if (msg.type === 'peer-left') {
    broadcastLocal(msg.roomId, msg.peerId, { action: 'peer-left', data: { peerId: msg.peerId } });
  } else if (msg.type === 'signal') {
    var target = localPeers[msg.to];
    if (target && target.roomId === msg.roomId) {
      target.connection.send({ action: 'signal', data: { from: msg.from, signal: msg.signal } });
    }
  }
});

// -- Public API --------------------------------------------------------

// Registers a newly-joined peer and calls thenDo(err, peerList) with the
// room's current roster (excluding the joiner itself). Also announces the
// join to the rest of the room via Redis once thenDo has been called.
exports.join = function (peerId, roomId, did, handle, connection, thenDo) {
  localPeers[peerId] = { connection: connection, did: did, handle: handle, roomId: roomId };
  var client = redisClient.getClient();

  Promise.resolve(ensureSubscribed(roomId))
    .then(function () { return client.hset(peersKey(roomId), peerId, JSON.stringify({ did: did, handle: handle })); })
    .then(function () { return refreshHeartbeat(roomId, peerId); })
    .then(function () {
      ensureHeartbeatTimerRunning();
      return client.hgetall(peersKey(roomId));
    })
    .then(function (roster) { return sweepAndListRoom(roomId, roster, peerId); })
    .then(function (peerList) {
      thenDo(null, peerList);
      return client.publish(eventsChannel(roomId), JSON.stringify({
        type: 'peer-joined', roomId: roomId, peerId: peerId, did: did, handle: handle
      }));
    })
    .catch(function (err) {
      console.error('[room-peer-registry-redis] join failed for ' + peerId + ':', err.message);
      delete localPeers[peerId];
      thenDo(err);
    });
};

// Fire-and-forget: relays a signaling payload to whichever process (maybe
// this one) currently holds `toPeerId` locally.
exports.signal = function (fromPeerId, toPeerId, signalPayload) {
  var self = localPeers[fromPeerId];
  if (!self) return;
  redisClient.getClient().publish(eventsChannel(self.roomId), JSON.stringify({
    type: 'signal', roomId: self.roomId, to: toPeerId, from: fromPeerId, signal: signalPayload
  })).catch(function (e) { console.error('[room-peer-registry-redis] signal publish failed:', e.message); });
};

// Fire-and-forget: unregisters a peer (normal connection close) and
// announces its departure.
exports.leave = function (peerId) {
  var p = localPeers[peerId];
  if (!p) return;
  delete localPeers[peerId];
  var client = redisClient.getClient();
  client.hdel(peersKey(p.roomId), peerId).catch(function (e) {
    console.error('[room-peer-registry-redis] hdel failed:', e.message);
  });
  client.del(hbKey(p.roomId, peerId)).catch(function (e) {
    console.error('[room-peer-registry-redis] heartbeat del failed:', e.message);
  });
  client.publish(eventsChannel(p.roomId), JSON.stringify({ type: 'peer-left', roomId: p.roomId, peerId: peerId }))
    .catch(function (e) { console.error('[room-peer-registry-redis] peer-left publish failed:', e.message); });
  releaseSubscription(p.roomId);
};
