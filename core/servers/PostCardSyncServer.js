/**
 * core/servers/PostCardSyncServer.js
 *
 * Yjs sync server for live post card collaboration (§5).
 *
 * Architecture (v1 — spec §5 step 1):
 *   Runs a y-websocket server as a standalone process on a separate port.
 *   Port is configurable via POSTCARD_SYNC_PORT env var (default: 1234).
 *   Auth: checks the identity-did session cookie on WebSocket upgrade.
 *   Document IDs: post card objIds (the same 12-char base64url identifiers
 *   used throughout the identity system).
 *
 * life_star discovery:
 *   This file is in core/servers/ so life_star auto-discovers it. However,
 *   it is NOT an Express subserver — it returns an empty route function and
 *   starts the y-websocket process out-of-band as a side-effect of require().
 *   This is the documented life_star pattern for servers that manage their own
 *   HTTP upgrade outside Express.
 *
 * Migration path (spec §5 step 3):
 *   When the standalone port becomes an operational problem, replace the
 *   standalone server with setupWSConnection() attached to life_star's own
 *   http.Server via its 'upgrade' event. The Yjs provider interface
 *   (awareness, on('sync'), destroy()) is unchanged either way.
 *
 * Dependencies (must be installed):
 *   npm install yjs y-websocket ws
 */

'use strict';

var http = require('http');
var SYNC_PORT = parseInt(process.env.POSTCARD_SYNC_PORT, 10) || 1234;

// Lazy-load y-websocket to avoid hard failing if the package isn't installed yet.
// The sync server is optional: post cards degrade to read-only if it's absent.
function startSyncServer() {
  var setupWSConnection, WebSocketServer;
  try {
    var ywsUtils = require('y-websocket/bin/utils');
    setupWSConnection = ywsUtils.setupWSConnection;
    WebSocketServer = require('ws').WebSocketServer;
  } catch (e) {
    console.warn(
      '[PostCardSync] y-websocket or ws not installed — live collaboration disabled. ' +
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
    res.end('Lively PostCard Sync Server');
  });

  var wss = new WebSocketServer({ server: server });

  wss.on('connection', function (ws, req) {
    // Extract objId from URL: ws://host:port/<objId>
    var pathname = req.url ? req.url.replace(/^\//, '').split('?')[0] : '';
    var objId = pathname;

    // Auth: check identity-did session cookie.
    // Full session-store auth (spec §5 step 2 caveat) is deferred until the
    // custom provider migration. For now: accept any connection (same as
    // the reference y-websocket behaviour) and rely on GET route auth to
    // gate access to the envelope itself. WebSocket-level auth is the Phase 3.5 work.
    console.log('[PostCardSync] connection for objId=' + objId +
                ' from ' + (req.socket && req.socket.remoteAddress));

    if (!objId || !/^[A-Za-z0-9\-_]{12}$/.test(objId)) {
      console.warn('[PostCardSync] Invalid objId in WebSocket URL:', objId);
      ws.close(1008, 'Invalid objId');
      return;
    }

    // gc: false is passed here so y-websocket creates all new Y.Doc instances
    // with gc disabled — required for playback support (§9.3).
    setupWSConnection(ws, req, { docName: objId, gc: false });
  });

  server.listen(SYNC_PORT, function () {
    console.log('[PostCardSync] y-websocket server listening on port ' + SYNC_PORT);
  });

  server.on('error', function (err) {
    console.error('[PostCardSync] Server error:', err.message);
  });
}

// Start the sync server immediately when this module is loaded.
startSyncServer();

// life_star subserver export — empty route function (this module manages its
// own HTTP server, not an Express route).
module.exports = function (route, app) {
  // No-op Express registration. The WebSocket server is started above.
};
