/**
 * core/servers/LiveDocSyncServer.js
 *
 * Yjs sync server for live collaborative Y.Docs: wiki-mode post cards (rich
 * text, via WikiEditor.js/PostCardEditor.js's wiki mode), and constellation
 * rooms (keyed by a constellation's genesisObjId) used purely for
 * ConstellationLounge.js's live "who's online" presence/awareness feature.
 * NOT used by plain post cards — a plain card never has a Yjs doc in the
 * first place (PostCardEditor.js's _connectSync is gated on _isWikiMode).
 * Constellation rooms previously also carried a drag-place canvas layout
 * map (ConstellationSpace.js's addPlacementToSpace/saveSpaceSnapshot); that
 * feature was removed, but the room/token machinery stays since Lounge
 * presence rides the same token-gated room.
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
 *   config exposing it too). Whether to actually do that migration is being
 *   scoped separately in DeployCheckList.md, now that the canvas feature
 *   (this file's main source of extra complexity) is gone.
 *   Room/document IDs: post card objIds (12-char base64url) for wiki-mode
 *   post cards, or a constellation's genesisObjId for a Lounge presence
 *   room.
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
 *   check just above the startSyncServer() call at the bottom. A worker
 *   still requires this module for that side effect alone (see
 *   bin/lk-server.js) even though it now has nothing to call on it.
 *
 *   Cross-instance (separate machines/deployments, not just this process's
 *   own cluster workers): fixed via support/live-doc-registry-redis.js, the
 *   last of the three realtime-backplane subsystems DeployCheckList.md
 *   tracked. Opt-in via REDIS_URL (see liveDocRegistry below) — unset means
 *   exactly the per-process/per-cluster-primary-only behavior described
 *   above, untouched. A wired doc replicates its updates (and awareness/
 *   cursor state) to every other instance holding the same room via Redis
 *   pub/sub. See that file's own header for the full design.
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

var constellationRegistry = require('./identity/ConstellationRegistry');
var constellationSpace = require('./identity/ConstellationSpace');

// Cross-instance Yjs replication (separate machines/deployments, not this
// process's own cluster workers -- those already share one doc via the
// cluster.isWorker/primary-only listener setup below). Opt-in via REDIS_URL,
// same idiom as RoomSignalingServer.js/SessionTracker.js's own backplanes:
// decided once here at module load, unset means today's exact
// per-process-only behavior, untouched. See
// support/live-doc-registry-redis.js's header for the full design.
var liveDocRegistry = process.env.REDIS_URL ? require('./support/live-doc-registry-redis') : null;

// Hoisted to module scope (rather than local to startSyncServer) so the
// WS connection handler below can reach the same live docs Map that
// setupWSConnection itself uses. null until startSyncServer() succeeds.
var setupWSConnection = null, getYDoc = null, docs = null;

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
    // (Constellation rooms below are the one exception — they DO check a
    // token, since ConstellationLounge.js's presence feature exposes an
    // awareness API a public visitor could otherwise spoof.)
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
        // setupWSConnection creates the doc via its own internal getYDoc
        // closure (not the exported one this file holds), so it can't be
        // intercepted from outside -- wire it here instead, right after it's
        // guaranteed to exist. wireDoc is idempotent per objId, so this is
        // safe to call on every connection to the same room, not just the
        // first.
        if (liveDocRegistry) liveDocRegistry.wireDoc(objId, docs.get(objId));
        return;
      }

      // Constellation room — used only for ConstellationLounge.js's live
      // presence/awareness feature (who's online); there's no layout map to
      // hydrate from a persisted snapshot any more (the canvas feature that
      // used to carry one here was removed), so just open the doc directly,
      // same as the wiki-mode branch above.
      var verified = constellationSpace.verifySpaceToken(query.token, objId);
      var viewerDid = verified ? verified.did : null;
      if (!verified || !constellationRegistry.canRead(constellation, viewerDid)) {
        console.warn('[LiveDocSync] Rejected constellation room connection for ' + objId);
        ws.removeListener('message', bufferMessage);
        ws.close(1008, 'Unauthorized');
        return;
      }

      var isNewRoom = !docs.has(objId);
      var doc = getYDoc(objId, false);
      if (liveDocRegistry && isNewRoom) liveDocRegistry.wireDoc(objId, doc);
      finishSetupWSConnection({ docName: objId, gc: false });
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

// life_star subserver export — empty route function (this module manages its
// own HTTP server, not an Express route).
module.exports = function (route, app) {
  // No-op Express registration. The WebSocket server is started above.
};
// The actual port this process's sync server is listening on (or would be,
// if y-websocket/ws weren't installed) -- so page-template code
// (IdentityServer.js) can tell connecting clients where to find it instead
// of every client-side call site guessing a hardcoded default. See
// IdentityServer.js's own window.LIVEDOC_SYNC_PORT injection.
module.exports.SYNC_PORT = SYNC_PORT;
