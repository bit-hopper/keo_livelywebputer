// WebRTC signaling relay for lively.identity.RoomView's in-room audio/video
// mesh call. Unlike WarpDropSignalingServer.js (grouped by observed IP,
// peer identity deliberately disconnected from Lively identity/@handle
// logins), this one groups peers by roomId and requires each connection to
// present a real, short-lived, single-use token before it's let into a
// room's group.
//
// The token exists because a plain WebSocket upgrade has no access to the
// cookie-based session AuthMiddleware.js's requireAuth relies on -- rather
// than teaching this file to parse/verify the session cookie itself, the
// client first calls an authenticated HTTP route (POST
// /c/:name/rooms/:roomId/signaling-token, gated by the same canJoinRoom
// check every other room route uses) to mint a token, then presents it in
// the WS 'join' message. The token is the bridge between "you already
// proved to the HTTP API you can join this room" and "you get to receive
// its signaling traffic" -- single-use (consumeToken deletes on read
// whether or not it was still valid) so a captured token can never be
// replayed even within its short TTL.
//
// The server never inspects `signal` payloads (offer/answer/ICE SDP) --
// same posture as WarpDropSignalingServer.js -- it only relays them, and
// only ever between two peers it has independently placed in the same
// roomId group (a stale/forged `to` pointing at a peer from a different
// room is silently dropped).
//
// Mesh, not SFU: every participant opens a direct RTCPeerConnection to
// every other participant (client-side, RoomView.js). Fine for the small
// room sizes this app targets; would need revisiting (a real SFU) if rooms
// ever need to scale past a handful of simultaneous video participants --
// deliberately not attempted here.

'use strict';

var WebSocketServer = require('./support/websockets').WebSocketServer;
var constellationRegistry = require('./identity/ConstellationRegistry');
var auth = require('./identity/AuthMiddleware');
var tokenStore = require('./support/room-token-store');

function uuid() { // helper, duplicated from support/websockets.js / WarpDropSignalingServer.js
    var id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8); return v.toString(16); }).toUpperCase();
    return id;
}

module.exports = function(route, app, subserver) {
    // Two interchangeable registries behind the same join/signal/leave shape
    // (join(peerId, roomId, did, handle, connection, thenDo(err, peerList)),
    // signal(fromPeerId, toPeerId, signal), leave(peerId)) so the WS handler
    // below doesn't need to know or care which one is active.
    //
    // Plain in-process rooms/peers maps only let two peers signal each other
    // when they land on the very same process -- fine for a single,
    // non-clustered server, but under `--workers` (or multiple machine
    // instances) two peers in the same room routinely land on different
    // processes and would otherwise never see or hear each other. The
    // Redis-backed registry (support/room-peer-registry-redis.js) fixes
    // that, but Redis is real operational infrastructure this app doesn't
    // otherwise require -- so it's opt-in, activated only when REDIS_URL is
    // explicitly set, decided once here at module load (one process = one
    // mode for its whole lifetime), never branched on per-message.
    var rooms = {}; // roomId -> {peerId: true} -- local mode only
    var peers = {}; // peerId -> {connection, did, handle, roomId} -- local mode only

    function peerListFor(peerId) {
        var p = peers[peerId];
        if (!p) return [];
        return Object.keys(rooms[p.roomId] || {})
            .filter(function(id) { return id !== peerId; })
            .map(function(id) { return {peerId: id, did: peers[id].did, handle: peers[id].handle}; });
    }

    function broadcastToRoom(roomId, exceptPeerId, msg) {
        Object.keys(rooms[roomId] || {}).forEach(function(id) {
            if (id !== exceptPeerId && peers[id]) peers[id].connection.send(msg);
        });
    }

    var localRegistry = {
        join: function (peerId, roomId, did, handle, connection, thenDo) {
            peers[peerId] = {connection: connection, did: did, handle: handle, roomId: roomId};
            (rooms[roomId] || (rooms[roomId] = {}))[peerId] = true;
            thenDo(null, peerListFor(peerId));
            broadcastToRoom(roomId, peerId, {action: 'peer-joined', data: {peerId: peerId, did: did, handle: handle}});
        },
        signal: function (fromPeerId, toPeerId, signal) {
            var self = peers[fromPeerId];
            if (!self) return;
            var target = peers[toPeerId];
            if (!target || target.roomId !== self.roomId) return; // wrong room / unknown peer, drop silently
            target.connection.send({action: 'signal', data: {from: fromPeerId, signal: signal}});
        },
        leave: function (peerId) {
            var p = peers[peerId];
            if (!p) return;
            delete peers[peerId];
            if (rooms[p.roomId]) {
                delete rooms[p.roomId][peerId];
                if (!Object.keys(rooms[p.roomId]).length) delete rooms[p.roomId];
            }
            broadcastToRoom(p.roomId, peerId, {action: 'peer-left', data: {peerId: peerId}});
        }
    };

    var registry = process.env.REDIS_URL ? require('./support/room-peer-registry-redis') : localRegistry;

    var webSocketHandler = new WebSocketServer();

    webSocketHandler.on('lively-message', function(msg, connection) {

        if (msg.action === 'join') {
            tokenStore.consumeToken(msg.data && msg.data.token).then(function (tokenData) {
                if (!tokenData) {
                    connection.send({action: 'join-rejected'});
                    return;
                }
                var peerId = connection.id = uuid();
                // Registered before registry.join's callback returns (rather
                // than nested inside it) so a peer is always cleaned up even
                // if join itself fails partway through (e.g. a Redis error) --
                // leave() is a safe no-op if the peer was never fully
                // registered.
                connection.on('close', function() { registry.leave(peerId); });
                registry.join(peerId, tokenData.roomId, tokenData.did, tokenData.handle, connection, function (err, peerList) {
                    if (err) {
                        connection.send({action: 'join-rejected'});
                        return;
                    }
                    connection.send({action: 'joined', data: {peerId: peerId, peers: peerList}});
                });
            }).catch(function (err) {
                console.error('[RoomSignalingServer] token consume failed:', err.message);
                connection.send({action: 'join-rejected'});
            });
            return;
        }

        // every other action requires an already-established peer
        var peerId = connection.id;
        if (!peerId) return;

        if (msg.action === 'signal') {
            registry.signal(peerId, msg.data && msg.data.to, msg.data && msg.data.signal);
            return;
        }
    });

    webSocketHandler.listen({route: route + 'connect', subserver: subserver});

    app.get(route, function(req, res) {
        res.end('RoomSignalingServer is running!');
    });

    // Mints a one-time signaling token for the caller, gated by the same
    // canJoinRoom check every other room route uses -- registered here
    // (rather than IdentityServer.js) so this file owns its own auth
    // surface end-to-end, same as it owns the WS relay above.
    app.post('/c/:name/rooms/:roomId/signaling-token', auth.requireAuth, function(req, res) {
        var name = req.params.name;
        var roomId = parseInt(req.params.roomId, 10);
        constellationRegistry.get(name, function(err, constellation) {
            if (err) return res.status(500).json({error: String(err)});
            if (!constellation) return res.status(404).json({error: 'Constellation not found: ' + name});
            constellationRegistry.getRoom(roomId, function(err, room) {
                if (err) return res.status(500).json({error: String(err)});
                if (!room || room.constellation !== name) return res.status(404).json({error: 'Room not found'});
                constellationRegistry.canJoinRoom(constellation, room, req.identity.did, function(err, allowed) {
                    if (err) return res.status(500).json({error: String(err)});
                    if (!allowed) return res.status(403).json({error: 'Forbidden: join not permitted for this room'});
                    tokenStore.mintToken(req.identity.did, req.identity.handle, name, roomId).then(function (token) {
                        res.json({token: token, wsPath: 'RoomSignalingServer/connect'});
                    }).catch(function (err) {
                        res.status(500).json({error: String(err)});
                    });
                });
            });
        });
    });
};
