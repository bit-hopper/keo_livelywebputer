// Shared single-use signaling-token store for RoomSignalingServer.js.
//
// Under Node's cluster module, an HTTP POST that mints a token and the
// WebSocket connection that later consumes it can land on *different*
// worker processes (cluster round-robins both the main HTTP port and any
// other .listen() called from worker code -- see DeployCheckList.md's
// "Clustering" section). A plain per-worker in-memory token object breaks
// this handshake outright whenever that happens: consumeToken() on the
// wrong worker finds nothing and the join is rejected, not just desynced.
//
// Fix: the cluster primary (which never loads life_star/RoomSignalingServer
// itself -- see bin/lk-server.js) holds the one canonical token store, and
// every worker routes mint/consume through it via cluster IPC instead of
// keeping its own. Outside of clustering (--workers 1, the default, or this
// module required directly by a non-forked process) there is no primary to
// route through, so it just uses its own local store directly -- same
// public API either way, always Promise-returning, so call sites don't need
// to know or care which mode they're in.
'use strict';

var cluster = require('cluster');
var crypto = require('crypto');

var TOKEN_TTL_MS = 30 * 1000;
var IPC_TIMEOUT_MS = 5000;

// Canonical store. In a clustered worker this object is never actually
// touched by that worker's own mint/consume calls (they route to the
// primary instead, see below) -- it only becomes "the" store when this
// module is loaded by the primary (via wireClusterPrimary) or by a
// non-clustered process.
var _tokens = {}; // token -> {did, handle, constellation, roomId, expiresAt}

function mintTokenLocal(did, handle, constellation, roomId) {
  var token = crypto.randomBytes(24).toString('base64url');
  _tokens[token] = { did: did, handle: handle, constellation: constellation, roomId: roomId, expiresAt: Date.now() + TOKEN_TTL_MS };
  return token;
}

// Single-use: deletes on read regardless of outcome.
function consumeTokenLocal(token) {
  var t = _tokens[token];
  delete _tokens[token];
  if (!t || Date.now() > t.expiresAt) return null;
  return t;
}

setInterval(function () {
  var now = Date.now();
  Object.keys(_tokens).forEach(function (t) { if (now > _tokens[t].expiresAt) delete _tokens[t]; });
}, 30 * 1000).unref();

// -- Worker side of the IPC bridge -----------------------------------------

var _pendingReplies = {}; // requestId -> {resolve, timer}
var _requestSeq = 0;

function callPrimary(type, payload) {
  return new Promise(function (resolve, reject) {
    var requestId = process.pid + '-' + (_requestSeq++);
    var timer = setTimeout(function () {
      delete _pendingReplies[requestId];
      reject(new Error('room-token-store: primary did not reply in time'));
    }, IPC_TIMEOUT_MS);
    _pendingReplies[requestId] = { resolve: resolve, timer: timer };
    process.send({ channel: 'room-token-store', type: type, requestId: requestId, payload: payload });
  });
}

if (cluster.isWorker) {
  process.on('message', function (msg) {
    if (!msg || msg.channel !== 'room-token-store' || msg.type !== 'reply') return;
    var pending = _pendingReplies[msg.requestId];
    if (!pending) return;
    clearTimeout(pending.timer);
    delete _pendingReplies[msg.requestId];
    pending.resolve(msg.result);
  });
}

// -- Primary side of the IPC bridge ----------------------------------------
// Call once from the cluster primary, before forking workers, so every
// worker's mint/consume calls resolve against this one canonical store.
function wireClusterPrimary() {
  cluster.on('fork', function (worker) {
    worker.on('message', function (msg) {
      if (!msg || msg.channel !== 'room-token-store' || msg.type === 'reply') return;
      var result = msg.type === 'mint'
        ? mintTokenLocal(msg.payload.did, msg.payload.handle, msg.payload.constellation, msg.payload.roomId)
        : consumeTokenLocal(msg.payload.token);
      worker.send({ channel: 'room-token-store', type: 'reply', requestId: msg.requestId, result: result });
    });
  });
}

// -- Public API --------------------------------------------------------
// Always returns a Promise, whether or not clustering is active, so call
// sites don't need to branch on it.

exports.mintToken = function (did, handle, constellation, roomId) {
  if (cluster.isWorker) return callPrimary('mint', { did: did, handle: handle, constellation: constellation, roomId: roomId });
  return Promise.resolve(mintTokenLocal(did, handle, constellation, roomId));
};

exports.consumeToken = function (token) {
  if (cluster.isWorker) return callPrimary('consume', { token: token });
  return Promise.resolve(consumeTokenLocal(token));
};

exports.wireClusterPrimary = wireClusterPrimary;
