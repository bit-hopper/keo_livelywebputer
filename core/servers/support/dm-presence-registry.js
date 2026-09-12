// Redis-backed presence + signal-relay registry for DMSignalingServer.js --
// used only when that file has decided, once at its own module-load time
// (REDIS_URL set), to run in Redis-backplane mode. Much simpler than
// room-peer-registry-redis.js: DM signaling has no roster/room concept at
// all, just two point-to-point operations -- "is this DID online" and
// "relay this signal to that DID" -- so there's no membership HASH to
// maintain, no per-room subscription refcounting, and no roster listing.
//
// Presence is a single per-DID Redis TTL key, heartbeat-refreshed while a
// local connection for that DID is open; presenceCheck just asks Redis
// whether that key currently exists. This also self-heals the crash case an
// explicit leave() can't catch (a worker dying without a clean connection
// 'close') -- the TTL simply lapses on its own.
//
// Signal relay goes over ONE shared pub/sub channel for all DM traffic
// (rather than one channel per DID or per conversation, the way Room scopes
// subscriptions to room membership) -- there's no membership-scoped
// subscription to maintain here, and this app's scale doesn't need
// finer-grained fan-out. Every process subscribes once at load time;
// delivery only ever happens against this process's own `localPeers`, same
// "one delivery path, always" principle room-peer-registry-redis.js
// documents for its own room channels.
'use strict';

var redisClient = require('./redis-client');

var HEARTBEAT_INTERVAL_MS = 15 * 1000;
var HEARTBEAT_TTL_S = 45;
var SIGNAL_CHANNEL = 'lk:dm:signal';

// did -> connection. The only place a real WebSocket connection object
// lives -- Redis only ever holds a TTL marker, never a connection.
var localPeers = {};

var heartbeatTimerHandle = null;

function onlineKey(did) { return 'lk:dm:online:' + did; }

function refreshHeartbeat(did) {
  return redisClient.getClient().set(onlineKey(did), '1', 'EX', HEARTBEAT_TTL_S);
}

function ensureHeartbeatTimerRunning() {
  if (heartbeatTimerHandle) return;
  heartbeatTimerHandle = setInterval(function () {
    Object.keys(localPeers).forEach(function (did) {
      refreshHeartbeat(did).catch(function (e) {
        console.error('[dm-presence-registry] heartbeat refresh failed:', e.message);
      });
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimerHandle.unref();
}

// Set up once at module load: one shared subscriber connection carries all
// DM signal traffic, filtered locally by whether this process actually
// holds the `to` DID's connection.
redisClient.getSubscriber().subscribe(SIGNAL_CHANNEL).catch(function (e) {
  console.error('[dm-presence-registry] subscribe failed:', e.message);
});

redisClient.getSubscriber().on('message', function (channel, raw) {
  if (channel !== SIGNAL_CHANNEL) return;
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  var target = localPeers[msg.to];
  if (target) target.send({ action: 'signal', data: { from: msg.from, signal: msg.signal } });
});

// -- Public API --------------------------------------------------------
// Same uniform join/presenceCheck/signal/leave shape DMSignalingServer.js's
// own local fallback registry implements, so its WS handler doesn't need to
// know or care which one is active.

exports.join = function (did, connection, thenDo) {
  localPeers[did] = connection;
  refreshHeartbeat(did).then(function () {
    ensureHeartbeatTimerRunning();
    thenDo(null);
  }).catch(function (err) {
    console.error('[dm-presence-registry] join failed for ' + did + ':', err.message);
    delete localPeers[did];
    thenDo(err);
  });
};

exports.presenceCheck = function (did, thenDo) {
  redisClient.getClient().exists(onlineKey(did)).then(function (exists) {
    thenDo(null, exists === 1);
  }).catch(function (err) {
    console.error('[dm-presence-registry] presenceCheck failed for ' + did + ':', err.message);
    thenDo(err, false);
  });
};

// Fire-and-forget: relays a signal to whichever process (maybe this one)
// currently holds `toDid` locally.
exports.signal = function (fromDid, toDid, signalPayload) {
  redisClient.getClient().publish(SIGNAL_CHANNEL, JSON.stringify({
    to: toDid, from: fromDid, signal: signalPayload,
  })).catch(function (e) {
    console.error('[dm-presence-registry] signal publish failed:', e.message);
  });
};

// Guards against a stale/superseded connection's close handler clobbering a
// newer connection later registered for the same DID (e.g. two tabs signed
// into the same account, sequentially, or a reconnect racing its own old
// socket's close event) -- localPeers is a last-one-wins map keyed by DID,
// not by a per-connection id the way Room's peerId-keyed map is, so this
// identity check is required for correctness, not defensive extra caution.
exports.leave = function (did, connection) {
  if (localPeers[did] !== connection) return;
  delete localPeers[did];
  redisClient.getClient().del(onlineKey(did)).catch(function (e) {
    console.error('[dm-presence-registry] del failed:', e.message);
  });
};
