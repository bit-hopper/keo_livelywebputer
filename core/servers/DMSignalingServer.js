// WebRTC signaling relay for lively.identity.DMChat's 1:1 live data-channel
// path (p2pchat.md §5/§5a). Point-to-point, not room-based: connections are
// grouped by DID, not roomId -- there's no roster or peer-list concept here,
// just two on-demand operations, "is this DID online" and "relay this
// signal to that DID," both gated by an already-accepted friendship
// (FriendRegistry.areFriends) checked server-side on every presence-check
// and every offer -- the same rigor RoomSignalingServer.js already applies
// for room membership, just re-derived against a friendship instead.
//
// Unlike RoomSignalingServer.js, this file is Redis-aware from its first
// version (see dm-presence-registry.js) rather than shipping local-only and
// adding Redis in a follow-up -- avoids re-hitting the identical
// cross-worker-process bug (two friends' WS connections landing on
// different `--workers` processes, silently breaking presence-check/signal
// even though both are genuinely online) that feature needed a whole
// separate pass to fix.
//
// A peer connection to a given friend is only ever established lazily, on
// an actual send attempt or an incoming offer -- unlike Room's mesh, this
// server never tells anyone who else is online; presence-check is strictly
// on-demand, per-target, and only the caller of presence-check ever learns
// its answer.
//
// The server never inspects `signal` payloads (offer/answer/ICE SDP) --
// same posture as every other signaling relay in this codebase.

'use strict';

var WebSocketServer = require('./support/websockets').WebSocketServer;
var friendRegistry = require('./identity/FriendRegistry');
var tokenStore = require('./support/dm-signaling-token-store');

module.exports = function (route, app, subserver) {
  // Local-only fallback registry -- same branch-once-at-module-load idiom
  // RoomSignalingServer.js already uses. No roster to maintain here (unlike
  // Room's rooms/peers maps): just did -> connection. leave() guards against
  // a stale connection's close handler clobbering a newer connection
  // registered for the same DID in the meantime (e.g. two tabs signed into
  // the same account, sequentially) -- see dm-presence-registry.js's own
  // leave() for the identical reasoning, needed in both registries since
  // both key by DID rather than by a fresh per-connection id.
  var localPeers = {}; // did -> connection

  var localRegistry = {
    join: function (did, connection, thenDo) {
      localPeers[did] = connection;
      thenDo(null);
    },
    presenceCheck: function (did, thenDo) {
      thenDo(null, !!localPeers[did]);
    },
    signal: function (fromDid, toDid, signal) {
      var target = localPeers[toDid];
      if (!target) return; // offline / unknown -- drop silently
      target.send({ action: 'signal', data: { from: fromDid, signal: signal } });
    },
    leave: function (did, connection) {
      if (localPeers[did] !== connection) return;
      delete localPeers[did];
    },
  };

  var registry = process.env.REDIS_URL ? require('./support/dm-presence-registry') : localRegistry;

  var webSocketHandler = new WebSocketServer();

  webSocketHandler.on('lively-message', function (msg, connection) {

    if (msg.action === 'join') {
      tokenStore.consumeToken(msg.data && msg.data.token).then(function (tokenData) {
        if (!tokenData) {
          connection.send({ action: 'join-rejected' });
          return;
        }
        connection.did = tokenData.did;
        // Registered before registry.join's callback returns (rather than
        // nested inside it) so a peer is always cleaned up even if join
        // itself fails partway through (e.g. a Redis error) -- leave() is a
        // safe no-op if this connection never actually got registered.
        connection.on('close', function () { registry.leave(tokenData.did, connection); });
        registry.join(tokenData.did, connection, function (err) {
          if (err) {
            connection.send({ action: 'join-rejected' });
            return;
          }
          connection.send({ action: 'joined', data: { did: tokenData.did } });
        });
      }).catch(function (err) {
        console.error('[DMSignalingServer] token consume failed:', err.message);
        connection.send({ action: 'join-rejected' });
      });
      return;
    }

    // every other action requires an already-established, joined connection
    var myDid = connection.did;
    if (!myDid) return;

    if (msg.action === 'presence-check') {
      var targetDid = msg.data && msg.data.targetDid;
      if (!targetDid) return;
      friendRegistry.areFriends(myDid, targetDid, function (err, friends) {
        if (err || !friends) {
          connection.send({ action: 'presence-reply', data: { targetDid: targetDid, online: false } });
          return;
        }
        registry.presenceCheck(targetDid, function (err, online) {
          connection.send({ action: 'presence-reply', data: { targetDid: targetDid, online: !err && !!online } });
        });
      });
      return;
    }

    if (msg.action === 'signal') {
      var to = msg.data && msg.data.to;
      var signal = msg.data && msg.data.signal;
      if (!to || !signal) return;
      if (signal.type === 'offer') {
        // Fresh pairing (or a renegotiation-shaped offer, though this
        // feature never sends one -- see DMChat.js's own webrtc category)
        // -- re-check the friend gate before relaying, matching
        // p2pchat.md §5's "presence-check and offer-dm both check"
        // requirement. A later answer/ice for an already-permitted
        // exchange doesn't re-check.
        friendRegistry.areFriends(myDid, to, function (err, friends) {
          if (err || !friends) return; // drop silently -- same posture as an offline/unknown target
          registry.signal(myDid, to, signal);
        });
        return;
      }
      registry.signal(myDid, to, signal);
      return;
    }
  });

  webSocketHandler.listen({ route: route + 'connect', subserver: subserver });

  app.get(route, function (req, res) {
    res.end('DMSignalingServer is running!');
  });

  // The token-mint route (POST /@:handle/dm/signaling-token) lives in
  // IdentityServer.js, not here -- see the comment on that route for why:
  // a real, confirmed-live routing-order bug where IdentityServer.js's own
  // `/@:handle/*` catch-all shadows any same-shaped route registered in a
  // different, earlier-loaded subserver file. tokenStore (required above)
  // is shared between both files -- IdentityServer.js mints, this file's
  // WS 'join' handler (above) consumes.
};
