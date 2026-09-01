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
 *   Rides life_star's shared http.Server (the same one SessionTracker.js/
 *   RoomSignalingServer.js/WarpDropSignalingServer.js use) rather than
 *   running its own standalone listener on a separate port — a genuine
 *   binary-protocol Yjs sync server sharing a TCP socket with a JSON-
 *   envelope 'lively-json' protocol server, without adapting to that
 *   protocol at all. The two coexist via a *raw pre-handshake* dispatch
 *   layer in core/servers/support/websockets.js
 *   (registerRawUpgradeHandler/unregisterRawUpgradeHandler,
 *   WebSocketListener#_dispatchUpgrade) that inspects the incoming
 *   upgrade request's URL path *before* either protocol's own handshake
 *   logic runs, and routes to exactly one of them — never both (two
 *   independent 'upgrade' listeners on the same server is unsafe: Node
 *   calls every listener for an event, so a second, uncoordinated
 *   listener would still fire even after a first one already upgraded the
 *   socket). This file registers a `ws` package WebSocketServer in
 *   `{noServer: true}` mode and hands it raw upgrades whose path starts
 *   with `/livedoc-sync/`; the `websocket` npm package handles everything
 *   else exactly as before, unchanged. A prior shared-port attempt (before
 *   this raw-dispatch layer existed) tried adapting to the 'lively-json'
 *   protocol wrapper directly and was reverted — `websockets.js`'s own
 *   WebSocketServer.accept unconditionally calls
 *   `request.accept('lively-json', ...)`, which throws for a client that
 *   never requested that subprotocol (a stock Yjs client never does), and
 *   separately JSON.parse()s every message, incompatible with binary Yjs
 *   frames. This design sidesteps that protocol entirely instead of
 *   adapting to it.
 *
 *   No separate port to reverse-proxy/TLS-terminate in production any
 *   more — the client connects to the same origin the page itself was
 *   served from, just a different path (see the client-side WebsocketProvider
 *   call sites in ConstellationLounge.js/PostCardEditor.js/WikiEditor.js).
 *
 *   Room/document IDs: post card objIds (12-char base64url) for wiki-mode
 *   post cards, or a constellation's genesisObjId for a Lounge presence
 *   room.
 *
 *   Cluster-aware, but no longer specially so: since this now registers
 *   itself the same way as every other subserver (inside the exported
 *   route function, called once per worker by SubserverHandler), each
 *   cluster worker independently runs its own `ws` WebSocketServer against
 *   its own per-worker share of the round-robin-distributed shared port —
 *   exactly the same pattern SessionTracker.js/RoomSignalingServer.js
 *   already use, no cluster-primary special case needed. (Previously, this
 *   file ran its own standalone http.Server, which Node's cluster module
 *   round-robins across workers just like any other .listen() call — that
 *   required a cluster-primary-only gate plus an IPC bridge to forward
 *   server-side writes to the primary; both are gone now, the IPC bridge
 *   along with the addPlacementToSpace feature it existed for.) Two Yjs
 *   clients on the same room landing on different workers of the same
 *   instance now needs the same cross-process replication as two clients
 *   on separate machines — already covered transparently by
 *   support/live-doc-registry-redis.js below, which is fully
 *   process-symmetric (a random per-process INSTANCE_ID, nothing
 *   machine-keyed) and needed zero changes for this.
 *
 *   Cross-instance (separate machines/deployments) *and* cross-worker
 *   (same machine, different cluster workers): fixed via
 *   support/live-doc-registry-redis.js, the last of the three
 *   realtime-backplane subsystems DeployCheckList.md tracked. Opt-in via
 *   REDIS_URL (see liveDocRegistry below) — unset means each worker's
 *   `docs` Map is genuinely isolated (same as running without clustering
 *   at all). A wired doc replicates its updates (and awareness/cursor
 *   state) to every other process holding the same room via Redis
 *   pub/sub. See that file's own header for the full design.
 *
 * life_star discovery:
 *   This file is in core/servers/ so life_star auto-discovers it and calls
 *   its exported route function once per worker, same as any other
 *   subserver — it happens to also do the WebSocket raw-upgrade
 *   registration there rather than register an Express route.
 *
 * Dependencies (must be installed):
 *   npm install yjs y-websocket ws
 */

'use strict';

var querystring = require('querystring');
var websockets = require('./support/websockets');

var constellationRegistry = require('./identity/ConstellationRegistry');
var constellationSpace = require('./identity/ConstellationSpace');

// Cross-instance AND cross-worker Yjs replication. Opt-in via REDIS_URL,
// same idiom as RoomSignalingServer.js/SessionTracker.js's own backplanes:
// decided once here at module load, unset means each process's `docs` Map
// is genuinely isolated. See support/live-doc-registry-redis.js's header
// for the full design.
var liveDocRegistry = process.env.REDIS_URL ? require('./support/live-doc-registry-redis') : null;

var LIVEDOC_PATH_PREFIX = '/livedoc-sync/';

// Hoisted to module scope (rather than local to the route function) so the
// WS connection handler below can reach the same live docs Map that
// setupWSConnection itself uses. null until setup below succeeds.
var setupWSConnection = null, getYDoc = null, docs = null;

function isLiveDocPath(pathname) {
  return pathname.indexOf(LIVEDOC_PATH_PREFIX) === 0;
}

// life_star subserver export — no Express route; registers a raw
// pre-handshake upgrade handler on the shared WebSocket listener instead.
// Called once per worker (or once, non-clustered) by SubserverHandler.
module.exports = function (route, app) {
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
  var wss = new WebSocketServer({ noServer: true });

  wss.on('connection', function (ws, req) {
    // Extract objId and query params from URL: ws://host/livedoc-sync/<objId>?token=...
    var pathAndQuery = req.url ? req.url.split('?') : [''];
    var objId = pathAndQuery[0].slice(LIVEDOC_PATH_PREFIX.length);
    var query = querystring.parse(pathAndQuery[1] || '');

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
    // round trip (constellation lookup below). The client sends its first
    // sync message (SyncStep1) immediately on WS open, well before that
    // resolves, and Node's EventEmitter doesn't buffer events emitted
    // before a listener exists — so without this, that first message is
    // silently dropped and the Yjs sync handshake never completes
    // (wsconnected stays true, synced never flips to true). Buffer raw
    // messages from the moment the connection is accepted, then replay
    // them once setupWSConnection has attached its real listener.
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
      //
      // verifySpaceToken is async (it may need one IPC round trip to the
      // cluster primary for the shared token secret, same as mintSpaceToken
      // already needed -- see ConstellationSpace.js's own header for why
      // this now applies to verify too, not just mint, since this file
      // stopped being cluster-primary-only).
      constellationSpace.verifySpaceToken(query.token, objId, function (err, verified) {
        var viewerDid = verified ? verified.did : null;
        if (err || !verified || !constellationRegistry.canRead(constellation, viewerDid)) {
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
  });

  function handleRawUpgrade(req, socket, head) {
    wss.handleUpgrade(req, socket, head, function (ws) {
      wss.emit('connection', ws, req);
    });
  }

  websockets.registerRawUpgradeHandler({ match: isLiveDocPath, handler: handleRawUpgrade });
};
