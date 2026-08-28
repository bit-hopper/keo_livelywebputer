/**
 * core/servers/LiveDocSyncServer.js
 *
 * Yjs sync server for live collaborative Y.Docs: wiki-mode post cards (rich
 * text, via WikiEditor.js/PostCardEditor.js's wiki mode) and constellation
 * spaces (canvas placement layout, via ConstellationSpace.js). NOT used by
 * plain post cards — a plain card never has a Yjs doc in the first place
 * (PostCardEditor.js's _connectSync is gated on _isWikiMode).
 *
 * Renamed 2026-08-27 from PostCardSyncServer.js. That name (and this file's
 * "Plain post card room" comment below) dated from when the design's
 * ambition was broader — live multi-user editing *and* version-history
 * playback for every post card, not just wiki-mode ones. See
 * WikiPlayback.js's own header for the matching client-side history: it
 * used to be PostCardPlayback.js before that scope narrowed to wiki-only
 * per PostcardDesignSpec-v2.md §15. The client file got renamed to match
 * at the time; this one never did.
 *
 * Architecture:
 *   Runs a y-websocket server as a standalone process on its own port
 *   (POSTCARD_SYNC_PORT env var, default 1234 — kept as-is despite the file
 *   rename, to avoid silently breaking anyone who already has it set in a
 *   deploy config), not attached to life_star's shared http.Server. A
 *   shared-port migration was attempted and reverted: this app already
 *   funnels all 'upgrade' traffic on the shared server through a singleton
 *   (core/servers/support/websockets.js's WebSocketListener, used by
 *   WarpDropSignalingServer.js) built on the `websocket` npm package with a
 *   hard-coded 'lively-json' subprotocol — incompatible with y-websocket's
 *   binary Yjs sync protocol without a nontrivial connection-API adapter.
 *   A standalone port avoids that entirely; it just needs to be reachable
 *   over TLS wherever this app is deployed (the main port already is — this
 *   one additionally needs the same treatment, e.g. tunnel/reverse-proxy
 *   config exposing it too). Whether to actually do that migration, or
 *   model this after L2L's (SessionTracker.js) multi-tracker routing
 *   instead, is deliberately left open — see DeployCheckList.md, revisit
 *   once the Redis backplane work below has landed.
 *   Room/document IDs: post card objIds (12-char base64url) for wiki-mode
 *   post cards, or a constellation's genesisObjId for constellation spaces.
 *
 *   Cluster-aware (added alongside bin/lk-server.js's --workers support):
 *   Node's cluster module silently round-robin-distributes ANY .listen()
 *   call made from worker code across workers, not just life_star's main
 *   server — discovered live 2026-08-27 testing --workers 2 (see
 *   DeployCheckList.md's "Clustering" section) applying to this file's own
 *   standalone http.Server too, which would otherwise fragment the live
 *   `docs` Map across workers exactly like the state DeployCheckList.md
 *   already flags LiveDocSyncServer/SessionTracker/RoomSignalingServer
 *   for. Fixed here by only ever starting the real listener in the cluster
 *   primary (or a non-clustered single process) — see the cluster.isWorker
 *   check just above the startSyncServer() call at the bottom. That leaves
 *   a worker with no local Yjs state at all, which would otherwise break
 *   the one server-side (non-WebSocket) write path that touches it —
 *   ConstellationSpace.js's addPlacementToSpace — so that call is forwarded
 *   to the primary via cluster IPC instead; see wireClusterPrimary /
 *   forwardAddPlacementToPrimary below (same IPC-bridge pattern as
 *   support/room-token-store.js). This fixes fragmentation *within one
 *   process's own cluster workers* — it does not yet solve real horizontal
 *   scaling across separate machines/instances, which needs the shared
 *   Redis-backed backplane DeployCheckList.md's to-do list already tracks.
 *
 * life_star discovery:
 *   This file is in core/servers/ so life_star auto-discovers it. However,
 *   it is NOT an Express subserver — it returns an empty route function and
 *   starts the y-websocket process out-of-band as a side-effect of require().
 *   This is the documented life_star pattern for servers that manage their own
 *   HTTP upgrade outside Express.
 *
 * Dependencies (must be installed):
 *   npm install yjs y-websocket ws
 */

'use strict';

var http = require('http');
var querystring = require('querystring');
var cluster = require('cluster');
var SYNC_PORT = parseInt(process.env.POSTCARD_SYNC_PORT, 10) || 1234;

var objectRepo = require('./identity/ObjectRepository');
var constellationRegistry = require('./identity/ConstellationRegistry');
var constellationSpace = require('./identity/ConstellationSpace');

// Hoisted to module scope (rather than local to startSyncServer) so
// getOrHydrateRoom/attachPersistence below — and other server modules that
// lazily require() this file, e.g. ConstellationSpace.js's
// addPlacementToSpace — can reach the same live docs Map that
// setupWSConnection itself uses. null until startSyncServer() succeeds.
var setupWSConnection = null, getYDoc = null, docs = null, Y = null;

// Gets a room's live Y.Doc, creating and hydrating it from the last
// persisted version if this is the first time it's been touched this
// process lifetime (either a WS connection or a server-side write via
// ConstellationSpace.js's addPlacementToSpace can be the first touch).
// Calls thenDo(err, doc, isNewRoom).
function getOrHydrateRoom(objId, thenDo) {
  if (!getYDoc) return thenDo(new Error('Yjs sync not available (y-websocket/ws not installed)'));
  var isNewRoom = !docs.has(objId);
  var doc = getYDoc(objId, false);
  if (!isNewRoom) return thenDo(null, doc, false);

  objectRepo.get(objId, function (err, envelope) {
    if (err) return thenDo(err);
    var payload = envelope && envelope.record && envelope.record.payload;
    if (payload && payload.format === 'yjs-update-v1' && payload.update) {
      try {
        Y.applyUpdate(doc, Buffer.from(payload.update, 'base64url'));
      } catch (e) {
        return thenDo(e);
      }
    }
    thenDo(null, doc, true);
  });
}

// Debounced persistence: ~2.5s after a room's Y.Doc last changed (from any
// source — a connected client's edit or a server-side write), save a new
// envelope version. Attach exactly once per room, not once per connection.
function attachPersistence(objId, constellation, doc) {
  var saveTimer = null;
  doc.on('update', function () {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      constellationSpace.saveSpaceSnapshot(constellation, objectRepo, doc, function (err) {
        if (err) console.error('[LiveDocSync] failed to persist constellation space ' + objId + ':', err.message);
      });
    }, 2500);
  });
}

// Lazy-load y-websocket to avoid hard failing if the package isn't installed yet.
// The sync server is optional: post cards degrade to read-only if it's absent.
function startSyncServer() {
  var WebSocketServer;
  try {
    var ywsUtils = require('y-websocket/bin/utils');
    setupWSConnection = ywsUtils.setupWSConnection;
    getYDoc = ywsUtils.getYDoc;
    docs = ywsUtils.docs;
    WebSocketServer = require('ws').WebSocketServer;
    Y = require('yjs');
  } catch (e) {
    console.warn(
      '[LiveDocSync] y-websocket or ws not installed — live collaboration disabled. ' +
      'Run: npm install yjs y-websocket ws'
    );
    return;
  }

  // y-websocket maintains its own internal docs Map and creates each Y.Doc
  // with gc: false when that option is passed to setupWSConnection.
  // We do NOT maintain a separate docs map here — setupWSConnection is
  // the single source of truth for in-memory Y.Doc instances.

  var server = http.createServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Lively LiveDoc Sync Server');
  });

  var wss = new WebSocketServer({ server: server });

  wss.on('connection', function (ws, req) {
    // Extract objId and query params from URL: ws://host:port/<objId>?token=...
    var urlParts = req.url ? req.url.replace(/^\//, '').split('?') : [''];
    var objId = urlParts[0];
    var query = querystring.parse(urlParts[1] || '');

    // Auth: check identity-did session cookie.
    // Full session-store auth (spec §5 step 2 caveat) is deferred until the
    // custom provider migration. For now: accept any connection (same as
    // the reference y-websocket behaviour) and rely on GET route auth to
    // gate access to the envelope itself. WebSocket-level auth is the Phase 3.5 work.
    // (Constellation space rooms below are the one exception — they DO check
    // a token, see the TODO(constellation-write-gate) note.)
    console.log('[LiveDocSync] connection for objId=' + objId +
                ' from ' + (req.socket && req.socket.remoteAddress));

    if (!objId || !/^[A-Za-z0-9\-_]{12}$/.test(objId)) {
      console.warn('[LiveDocSync] Invalid objId in WebSocket URL:', objId);
      ws.close(1008, 'Invalid objId');
      return;
    }

    // setupWSConnection() is only ever reached after at least one async DB
    // round trip (constellation lookup below, plus a second one for a
    // constellation-space room). The client sends its first sync message
    // (SyncStep1) immediately on WS open, well before that resolves, and
    // Node's EventEmitter doesn't buffer events emitted before a listener
    // exists — so without this, that first message is silently dropped and
    // the Yjs sync handshake never completes (wsconnected stays true,
    // synced never flips to true). Buffer raw messages from the moment the
    // connection is accepted, then replay them once setupWSConnection has
    // attached its real listener.
    var pendingMessages = [];
    function bufferMessage(data) { pendingMessages.push(data); }
    ws.on('message', bufferMessage);
    function finishSetupWSConnection(opts) {
      ws.removeListener('message', bufferMessage);
      setupWSConnection(ws, req, opts);
      pendingMessages.forEach(function (data) { ws.emit('message', data, true); });
      pendingMessages = null;
    }

    constellationRegistry.getByGenesisObjId(objId, function (err, constellation) {
      if (err) {
        console.error('[LiveDocSync] constellation lookup failed for ' + objId + ':', err.message);
        ws.removeListener('message', bufferMessage);
        ws.close(1011, 'Internal error');
        return;
      }

      if (!constellation) {
        // Wiki-mode post card room — the only kind of "plain post card"
        // room this ever actually serves (see this file's header).
        // gc: false is passed here so y-websocket creates all new Y.Doc
        // instances with gc disabled — required for playback support.
        finishSetupWSConnection({ docName: objId, gc: false });
        return;
      }

      // Constellation space room.
      //
      // TODO(constellation-write-gate): this is a COARSE gate only — it
      // decides whether the connection is accepted at all (private ->
      // members only, public -> anyone), matching ConstellationRegistry's
      // canRead. Once a connection is accepted there is no per-message
      // filtering: any connected client, including a non-member visitor on
      // a public room, can send doc-mutating Yjs sync messages and the
      // server will apply and broadcast them exactly like a member's edit.
      // The real UI only shows editing affordances to members (client-side
      // only, not a security boundary). Closing this gap for real means not
      // using setupWSConnection for these rooms at all, and instead
      // hand-assembling the connection handler from y-websocket's lower-level
      // pieces (getYDoc, y-protocols syncProtocol/awarenessProtocol) so a
      // canWrite(constellation, did) check can run on every incoming sync
      // update message, not just once at connect time.
      var verified = constellationSpace.verifySpaceToken(query.token, objId);
      var viewerDid = verified ? verified.did : null;
      if (!verified || !constellationRegistry.canRead(constellation, viewerDid)) {
        console.warn('[LiveDocSync] Rejected constellation room connection for ' + objId);
        ws.removeListener('message', bufferMessage);
        ws.close(1008, 'Unauthorized');
        return;
      }

      // Hydrate BEFORE setupWSConnection, not after — the connecting
      // client's first sync handshake reads whatever state the doc has at
      // that moment, so hydration must land before setupWSConnection ever
      // touches the doc, not moments later.
      getOrHydrateRoom(objId, function (err, doc, isNewRoom) {
        if (err) {
          console.error('[LiveDocSync] failed to hydrate constellation room ' + objId + ':', err.message);
          ws.removeListener('message', bufferMessage);
          ws.close(1011, 'Internal error');
          return;
        }
        if (isNewRoom) attachPersistence(objId, constellation, doc);
        finishSetupWSConnection({ docName: objId, gc: false });
      });
    });
  });

  server.listen(SYNC_PORT, function () {
    console.log('[LiveDocSync] y-websocket server listening on port ' + SYNC_PORT);
  });

  server.on('error', function (err) {
    console.error('[LiveDocSync] Server error:', err.message);
  });
}

// Only the cluster primary (or a non-clustered single process) starts the
// real listener — a worker doing this too would silently fragment the live
// `docs` Map across workers (see this file's header). cluster.isWorker is
// false for both the primary and a non-clustered process, so this is a
// no-op behavior change outside of --workers clustering.
if (!cluster.isWorker) startSyncServer();

// -- Cluster IPC bridge for the one server-side (non-WebSocket) write path
// that touches live room state: ConstellationSpace.js's addPlacementToSpace
// directly mutates a live Y.Doc it gets back from getOrHydrateRoom, which a
// worker (no local Yjs state, see above) can't do locally. Forwards the
// whole operation to the primary, which runs it against the real doc via
// this same file's own addPlacementToSpace call, then replies. Same
// request/reply-by-id pattern as support/room-token-store.js.
var _pendingAddPlacementReplies = {};
var _addPlacementRequestSeq = 0;

function forwardAddPlacementToPrimary(constellation, placement, thenDo) {
  var requestId = process.pid + '-' + (_addPlacementRequestSeq++);
  var timer = setTimeout(function () {
    delete _pendingAddPlacementReplies[requestId];
    thenDo(new Error('LiveDocSyncServer: primary did not reply in time for addPlacementToSpace'));
  }, 5000);
  _pendingAddPlacementReplies[requestId] = function (err, result) {
    clearTimeout(timer);
    thenDo(err, result);
  };
  process.send({
    channel: 'live-doc-sync',
    type: 'add-placement',
    requestId: requestId,
    payload: { constellation: constellation, placement: placement },
  });
}

if (cluster.isWorker) {
  process.on('message', function (msg) {
    if (!msg || msg.channel !== 'live-doc-sync' || msg.type !== 'reply') return;
    var pending = _pendingAddPlacementReplies[msg.requestId];
    if (!pending) return;
    delete _pendingAddPlacementReplies[msg.requestId];
    pending(msg.error ? new Error(msg.error) : null, msg.result);
  });
}

// Wires up the primary side of the IPC bridge above. Call once from the
// cluster primary (bin/lk-server.js), before forking workers.
function wireClusterPrimary() {
  cluster.on('fork', function (worker) {
    worker.on('message', function (msg) {
      if (!msg || msg.channel !== 'live-doc-sync' || msg.type !== 'add-placement') return;
      constellationSpace.addPlacementToSpace(msg.payload.constellation, msg.payload.placement, function (err, result) {
        worker.send({
          channel: 'live-doc-sync',
          type: 'reply',
          requestId: msg.requestId,
          error: err ? err.message : null,
          result: result,
        });
      });
    });
  });
}

// life_star subserver export — empty route function (this module manages its
// own HTTP server, not an Express route). Also exposes getOrHydrateRoom/
// attachPersistence so other server modules can reach the same in-process
// room state without a WebSocket round-trip — see
// ConstellationSpace.js's addPlacementToSpace, which lazily require()s this
// file (not at module top-level: this file requires ConstellationSpace.js
// itself, and a top-level require here would create a load-order cycle).
module.exports = function (route, app) {
  // No-op Express registration. The WebSocket server is started above.
};
module.exports.getOrHydrateRoom = getOrHydrateRoom;
module.exports.attachPersistence = attachPersistence;
module.exports.forwardAddPlacementToPrimary = forwardAddPlacementToPrimary;
module.exports.wireClusterPrimary = wireClusterPrimary;
