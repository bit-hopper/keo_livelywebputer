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
var crypto = require('crypto');

var TOKEN_TTL_MS = 30 * 1000;

function uuid() { // helper, duplicated from support/websockets.js / WarpDropSignalingServer.js
    var id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8); return v.toString(16); }).toUpperCase();
    return id;
}

// token -> {did, handle, constellation, roomId, expiresAt}
var _tokens = {};

function mintToken(did, handle, constellation, roomId) {
    var token = crypto.randomBytes(24).toString('base64url');
    _tokens[token] = { did: did, handle: handle, constellation: constellation, roomId: roomId, expiresAt: Date.now() + TOKEN_TTL_MS };
    return token;
}

// Single-use: deletes on read regardless of outcome.
function consumeToken(token) {
    var t = _tokens[token];
    delete _tokens[token];
    if (!t || Date.now() > t.expiresAt) return null;
    return t;
}

setInterval(function() {
    var now = Date.now();
    Object.keys(_tokens).forEach(function(t) { if (now > _tokens[t].expiresAt) delete _tokens[t]; });
}, 30 * 1000);

module.exports = function(route, app, subserver) {
    var rooms = {}; // roomId -> {peerId: true}
    var peers = {}; // peerId -> {connection, did, handle, roomId}

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

    var webSocketHandler = new WebSocketServer();

    webSocketHandler.on('lively-message', function(msg, connection) {

        if (msg.action === 'join') {
            var tokenData = consumeToken(msg.data && msg.data.token);
            if (!tokenData) {
                connection.send({action: 'join-rejected'});
                return;
            }
            var peerId = connection.id = uuid();
            peers[peerId] = {
                connection: connection, did: tokenData.did, handle: tokenData.handle, roomId: tokenData.roomId
            };
            (rooms[tokenData.roomId] || (rooms[tokenData.roomId] = {}))[peerId] = true;

            connection.send({
                action: 'joined',
                data: {peerId: peerId, peers: peerListFor(peerId)}
            });
            broadcastToRoom(tokenData.roomId, peerId, {
                action: 'peer-joined', data: {peerId: peerId, did: tokenData.did, handle: tokenData.handle}
            });

            connection.on('close', function() {
                var p = peers[peerId];
                if (!p) return;
                delete peers[peerId];
                if (rooms[p.roomId]) {
                    delete rooms[p.roomId][peerId];
                    if (!Object.keys(rooms[p.roomId]).length) delete rooms[p.roomId];
                }
                broadcastToRoom(p.roomId, peerId, {action: 'peer-left', data: {peerId: peerId}});
            });
            return;
        }

        // every other action requires an already-established peer
        var peerId = connection.id;
        var self = peers[peerId];
        if (!self) return;

        if (msg.action === 'signal') {
            var target = msg.data && peers[msg.data.to];
            if (!target || target.roomId !== self.roomId) return; // wrong room / unknown peer, drop silently
            target.connection.send({
                action: 'signal',
                data: {from: peerId, signal: msg.data.signal}
            });
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
                    var token = mintToken(req.identity.did, req.identity.handle, name, roomId);
                    res.json({token: token, wsPath: 'RoomSignalingServer/connect'});
                });
            });
        });
    });
};
