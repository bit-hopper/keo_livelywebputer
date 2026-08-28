// Redis-backed cross-instance replication for LiveDocSyncServer.js's Yjs
// Y.Docs -- used only when that file has decided, once at its own
// module-load time, to run in Redis-backplane mode (REDIS_URL set). Fixes
// the last of the three realtime subsystems DeployCheckList.md tracks:
// unlike RoomSignalingServer's `rooms`/`peers` and SessionTracker's session
// registry (both plain relayed state), a Y.Doc is never reloaded once a
// process has it in memory (y-websocket's own docs Map entry lives for the
// process's lifetime whenever no `persistence` adapter is configured, which
// this app never does -- confirmed by reading node_modules/y-websocket/bin/
// utils.js's closeConn). So two instances that each load the same room
// don't just drift briefly out of sync, they permanently diverge -- this
// needs real CRDT-aware replication, not a plain relay.
//
// Design in one paragraph: every instance publishes its own local Y.Doc
// updates (and awareness/cursor updates) to a per-room Redis Pub/Sub
// channel; every other instance that has the same room loaded applies them
// via Y.applyUpdate(doc, update, REMOTE_ORIGIN) / applyAwarenessUpdate(...,
// REMOTE_ORIGIN) and skips re-publishing anything tagged with that sentinel
// origin (the standard Yjs multi-provider loop-prevention idiom). Because
// Yjs updates are commutative, wireDoc() subscribes and requests a catch-up
// diff (see requestCatchUp below) synchronously at doc-creation time, before
// LiveDocSyncServer.js's own async objectRepo hydration resolves -- it does
// not matter which lands first, both converge to the same state, so there's
// no hydrate-then-subscribe ordering race to get right here.
//
// The one gap pub/sub alone can't close: a room that's been continuously
// edited on instance A (so its 2.5s-debounced snapshot save keeps getting
// reset) is live-ahead of whatever's in objectRepo. An instance B touching
// that room for the first time would only get the stale persisted snapshot
// plus whatever's edited *after* it subscribes, permanently missing A's
// backlog (pub/sub has no replay). Closed with a small request/reply
// handshake over the same per-room channel: on first wire, B publishes its
// own Y.encodeStateVector(doc) as a 'sync-request'; any instance that
// already holds the doc replies with a real diff
// (Y.encodeStateAsUpdate(doc, thatVector)), which B applies. More than one
// instance may reply -- applying every reply that arrives before the
// timeout (instead of just the first) is strictly safe since Yjs applyUpdate
// is idempotent/commutative, so this deliberately does not stop listening
// after the first reply. If nobody replies before the timeout, B just keeps
// the persisted-snapshot baseline it already hydrated from, same as today.
//
// Deliberately NOT using a separate control channel for sync-request/reply
// -- one channel per room, multiplexed by a `type` field, same as
// room-peer-registry-redis.js's `events` channel.
//
// Deliberately NOT refcounted subscribe/unsubscribe per room (unlike
// room-peer-registry-redis.js) -- since a wired doc is never unloaded for
// this process's lifetime anyway (see above), there is no local-refcount-
// hits-zero moment to release a subscription for; wireDoc's per-objId
// idempotency guard is the only lifecycle this needs.
'use strict';

var crypto = require('crypto');
var redisClient = require('./redis-client');
var Y = require('yjs');
var awarenessProtocol = require('y-protocols/dist/awareness.cjs');

// Identifies this process's own published messages so it can ignore them on
// the shared subscriber (belt-and-suspenders alongside the REMOTE_ORIGIN
// tagging below -- also what lets a sync-request's own broadcast-to-self not
// be mistaken for a reply).
var INSTANCE_ID = crypto.randomBytes(6).toString('hex');

// Sentinel passed as the transactionOrigin/awareness-origin for every
// Redis-driven apply, so this module's own 'update'/'awareness' listeners
// (registered in wireDoc below) can tell a Redis-driven change from a
// locally-made one and never re-publish it back to Redis -- without this
// every remote update would echo forever between instances.
var REMOTE_ORIGIN = { remoteLiveDocSync: true };

var SYNC_REQUEST_TIMEOUT_MS = 800;

// objId -> Y.Doc, only for docs this process has wired. The shared
// subscriber 'message' handler below looks up the target doc here by the
// objId embedded in the message payload, same dispatch-by-payload-field
// idiom room-peer-registry-redis.js uses (simpler and less error-prone than
// parsing the channel name back apart).
var docsByObjId = {};

// requestId -> {doc, timer}, while a sync-request this process sent is
// still within its timeout window and can still accept replies.
var pendingSyncRequests = {};
var _requestSeq = 0;

function docChannel(objId) { return 'lk:doc:{' + objId + '}:events'; }

function publish(objId, msg) {
  redisClient.getClient().publish(docChannel(objId), JSON.stringify(msg)).catch(function (e) {
    console.error('[live-doc-registry-redis] publish failed for ' + objId + ':', e.message);
  });
}

function toBase64(uint8arr) { return Buffer.from(uint8arr).toString('base64'); }
function fromBase64(str) { return new Uint8Array(Buffer.from(str, 'base64')); }

// Asks any other instance that already holds this doc locally for whatever
// this instance doesn't have yet. See this file's header for why more than
// one reply may arrive and why that's fine.
function requestCatchUp(objId, doc) {
  var requestId = INSTANCE_ID + '-' + (_requestSeq++);
  var timer = setTimeout(function () {
    delete pendingSyncRequests[requestId];
  }, SYNC_REQUEST_TIMEOUT_MS);
  timer.unref();
  pendingSyncRequests[requestId] = { doc: doc, timer: timer };
  publish(objId, {
    type: 'sync-request',
    objId: objId,
    from: INSTANCE_ID,
    requestId: requestId,
    stateVector: toBase64(Y.encodeStateVector(doc))
  });
}

// Set up once at module load: one shared subscriber connection dispatching
// every wired room's traffic by the objId/type embedded in the message.
redisClient.getSubscriber().on('message', function (channel, raw) {
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.from === INSTANCE_ID) return; // never process our own broadcast

  if (msg.type === 'sync-reply') {
    var pending = pendingSyncRequests[msg.requestId];
    if (!pending) return; // not waiting on this one (unknown, or already timed out)
    try {
      Y.applyUpdate(pending.doc, fromBase64(msg.update), REMOTE_ORIGIN);
    } catch (e) {
      console.error('[live-doc-registry-redis] applying sync-reply failed for ' + msg.objId + ':', e.message);
    }
    // Deliberately not deleted/cleared here -- see header: more than one
    // instance may reply, and every reply before the timeout gets applied.
    return;
  }

  var doc = docsByObjId[msg.objId];
  if (!doc) return; // we're not holding this room locally (and, for a sync-request, that means we have nothing to offer -- correctly don't reply)

  if (msg.type === 'update') {
    try {
      Y.applyUpdate(doc, fromBase64(msg.update), REMOTE_ORIGIN);
    } catch (e) {
      console.error('[live-doc-registry-redis] applyUpdate failed for ' + msg.objId + ':', e.message);
    }
  } else if (msg.type === 'awareness') {
    try {
      awarenessProtocol.applyAwarenessUpdate(doc.awareness, fromBase64(msg.update), REMOTE_ORIGIN);
    } catch (e) {
      console.error('[live-doc-registry-redis] applyAwarenessUpdate failed for ' + msg.objId + ':', e.message);
    }
  } else if (msg.type === 'sync-request') {
    publish(msg.objId, {
      type: 'sync-reply',
      objId: msg.objId,
      from: INSTANCE_ID,
      requestId: msg.requestId,
      update: toBase64(Y.encodeStateAsUpdate(doc, fromBase64(msg.stateVector)))
    });
  }
});

// -- Public API --------------------------------------------------------

// Wires a just-created (or already-locally-existing, in which case this is
// a no-op) Y.Doc into the cross-instance replication backplane. Idempotent
// per objId -- safe to call from every code path that can produce a fresh
// doc (LiveDocSyncServer.js's getOrHydrateRoom for constellation-space
// rooms, and its WS handler's wiki-mode branch, which creates a doc via
// y-websocket's own setupWSConnection -- a separate call site because that
// path's doc creation happens inside a closure internal to y-websocket's
// own file, unreachable by patching the exported getYDoc).
exports.wireDoc = function (objId, doc) {
  if (docsByObjId[objId]) return;
  docsByObjId[objId] = doc;

  redisClient.getSubscriber().subscribe(docChannel(objId)).catch(function (e) {
    console.error('[live-doc-registry-redis] subscribe failed for ' + objId + ':', e.message);
  });

  doc.on('update', function (update, origin) {
    if (origin === REMOTE_ORIGIN) return;
    publish(objId, { type: 'update', objId: objId, from: INSTANCE_ID, update: toBase64(update) });
  });

  doc.awareness.on('update', function (changes, origin) {
    if (origin === REMOTE_ORIGIN) return;
    var changedIds = changes.added.concat(changes.updated, changes.removed);
    var update = awarenessProtocol.encodeAwarenessUpdate(doc.awareness, changedIds);
    publish(objId, { type: 'awareness', objId: objId, from: INSTANCE_ID, update: toBase64(update) });
  });

  requestCatchUp(objId, doc);
};
