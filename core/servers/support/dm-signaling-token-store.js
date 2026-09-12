// Shared single-use signaling-token store for DMSignalingServer.js -- same
// cluster-IPC-to-primary shape as room-token-store.js (see that file's own
// header for the full rationale: an HTTP mint and a later WS consume can
// land on different cluster worker processes, so only the cluster primary
// holds the canonical store and every worker routes mint/consume through it
// via IPC instead of keeping its own).
//
// Deliberately a separate, near-identical file rather than generalizing
// room-token-store.js to take an arbitrary payload -- matches this
// codebase's existing preference for duplicating small self-contained
// helpers (e.g. uuid() is already independently duplicated in
// RoomSignalingServer.js and WarpDropSignalingServer.js) over premature
// shared abstractions.
'use strict';

var cluster = require('cluster');
var crypto = require('crypto');

var TOKEN_TTL_MS = 30 * 1000;
var IPC_TIMEOUT_MS = 5000;
var CHANNEL = 'dm-signaling-token-store';

// Canonical store. In a clustered worker this object is never actually
// touched by that worker's own mint/consume calls (they route to the
// primary instead, see below) -- it only becomes "the" store when this
// module is loaded by the primary (via wireClusterPrimary) or by a
// non-clustered process.
var _tokens = {}; // token -> {did, handle, expiresAt}

function mintTokenLocal(did, handle) {
  var token = crypto.randomBytes(24).toString('base64url');
  _tokens[token] = { did: did, handle: handle, expiresAt: Date.now() + TOKEN_TTL_MS };
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
      reject(new Error('dm-signaling-token-store: primary did not reply in time'));
    }, IPC_TIMEOUT_MS);
    _pendingReplies[requestId] = { resolve: resolve, timer: timer };
    process.send({ channel: CHANNEL, type: type, requestId: requestId, payload: payload });
  });
}

if (cluster.isWorker) {
  process.on('message', function (msg) {
    if (!msg || msg.channel !== CHANNEL || msg.type !== 'reply') return;
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
      if (!msg || msg.channel !== CHANNEL || msg.type === 'reply') return;
      var result = msg.type === 'mint'
        ? mintTokenLocal(msg.payload.did, msg.payload.handle)
        : consumeTokenLocal(msg.payload.token);
      worker.send({ channel: CHANNEL, type: 'reply', requestId: msg.requestId, result: result });
    });
  });
}

// -- Public API --------------------------------------------------------
// Always returns a Promise, whether or not clustering is active, so call
// sites don't need to know or care which mode they're in.

exports.mintToken = function (did, handle) {
  if (cluster.isWorker) return callPrimary('mint', { did: did, handle: handle });
  return Promise.resolve(mintTokenLocal(did, handle));
};

exports.consumeToken = function (token) {
  if (cluster.isWorker) return callPrimary('consume', { token: token });
  return Promise.resolve(consumeTokenLocal(token));
};

exports.wireClusterPrimary = wireClusterPrimary;
