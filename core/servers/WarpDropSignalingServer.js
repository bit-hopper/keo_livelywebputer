// WebRTC signaling relay for lively.identity.WarpDrop (see WarpDrop.md).
// Groups connections by observed IP so peers on the same local network
// discover each other automatically; the server never inspects `signal`
// payloads, it only relays them within a group. Peer identity here is
// intentionally disconnected from Lively identity/@handle logins.
//
// IPv4/IPv6 dual-stack limitation, confirmed via testing (not just
// speculative): two devices on the very same WiFi can present entirely
// different address families to the server (e.g. a phone going out over
// IPv6 while a desktop uses IPv4) and never land in the same IP group,
// with no way for the server to correlate them from the addresses alone.
// Manual room codes (below) are the fallback for exactly this case, and
// for any other case where two peers simply aren't IP-groupable (VPNs,
// CGNAT, different networks entirely).
//
// Known limitation, not addressed: if this server ever runs behind a
// reverse proxy that does NOT pass through the real client IP, every
// connection would share the proxy's observed IP and grouping breaks.
// Confirmed dev.tinylil.world's Cloudflare Tunnel does pass through the
// real client IP, so this doesn't currently apply, but is worth keeping
// in mind if the proxy setup ever changes.

var WebSocketServer = require('./support/websockets').WebSocketServer;

function uuid() { // helper, duplicated from support/websockets.js / SessionTracker.js
    var id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8); return v.toString(16); }).toUpperCase();
    return id;
}

// International foods/dishes/fruits, deliberately not the generic
// tech-demo "banana/mango" set — used as peer display names so discovery
// stays disconnected from Lively identity/@handle.
var NAMES = [
    'Plantain', 'Empanada', 'Yam', 'Squash', 'Coconut', 'Injera',
    'Dumpling', 'Mango', 'Papaya', 'Taro', 'Cassava', 'Lentil',
    'Saffron', 'Tamarind', 'Guava', 'Lychee', 'Biryani', 'Hummus',
    'Falafel', 'Ceviche', 'Kimchi', 'Baklava', 'Churro', 'Tostada',
    'Jackfruit', 'Durian', 'Persimmon', 'Pomegranate', 'Okra', 'Plum',
];

function normalizeIp(ip) {
    return String(ip || '').replace(/^::ffff:/, '');
}

function normalizeRoomCode(code) {
    return String(code || '').trim().toLowerCase().slice(0, 40);
}

function pickName(namesInUse) {
    var available = NAMES.filter(function(n) { return namesInUse.indexOf(n) === -1; });
    if (available.length) return available[Math.floor(Math.random() * available.length)];
    // group somehow exceeds the word list length -- fall back to a
    // reused word with a short unique suffix
    var base = NAMES[Math.floor(Math.random() * NAMES.length)];
    return base + ' ' + uuid().slice(0, 4);
}

module.exports = function(route, app, subserver) {
    var groups = {}; // normalized ip -> {peerId: true}
    var rooms  = {}; // normalized room code -> {peerId: true}
    var peers  = {}; // peerId -> {connection, name, ip, room}

    // a peer's visible peers = their IP-group-mates union their
    // room-mates (if any), minus themselves -- room membership is
    // additive on top of automatic IP grouping, never a replacement
    function visiblePeerIdsFor(peerId) {
        var p = peers[peerId];
        if (!p) return [];
        var ids = {};
        Object.keys(groups[p.ip] || {}).forEach(function(id) { ids[id] = true; });
        if (p.room) Object.keys(rooms[p.room] || {}).forEach(function(id) { ids[id] = true; });
        delete ids[peerId];
        return Object.keys(ids);
    }

    function peerListFor(peerId) {
        return visiblePeerIdsFor(peerId).map(function(id) {
            return {peerId: id, name: peers[id].name};
        });
    }

    function broadcastToVisible(peerId, msg) {
        visiblePeerIdsFor(peerId).forEach(function(id) {
            peers[id].connection.send(msg);
        });
    }

    function namesInGroup(ip) {
        return Object.keys(groups[ip] || {}).map(function(id) { return peers[id].name; });
    }

    var webSocketHandler = new WebSocketServer();

    webSocketHandler.on('lively-message', function(msg, connection) {

        if (msg.action === 'join') {
            var ip = normalizeIp(connection.remoteAddress);
            var peerId = connection.id = uuid();
            var name = pickName(namesInGroup(ip));
            peers[peerId] = {connection: connection, name: name, ip: ip, room: null};
            (groups[ip] || (groups[ip] = {}))[peerId] = true;

            connection.send({
                action: 'joined',
                data: {peerId: peerId, name: name, peers: peerListFor(peerId)}
            });
            broadcastToVisible(peerId, {action: 'peer-joined', data: {peerId: peerId, name: name}});

            connection.on('close', function() {
                var p = peers[peerId];
                if (!p) return;
                var wasVisible = visiblePeerIdsFor(peerId);
                delete peers[peerId];
                if (groups[p.ip]) {
                    delete groups[p.ip][peerId];
                    if (!Object.keys(groups[p.ip]).length) delete groups[p.ip];
                }
                if (p.room && rooms[p.room]) {
                    delete rooms[p.room][peerId];
                    if (!Object.keys(rooms[p.room]).length) delete rooms[p.room];
                }
                wasVisible.forEach(function(id) {
                    var other = peers[id];
                    if (other) other.connection.send({action: 'peer-left', data: {peerId: peerId}});
                });
            });
            return;
        }

        // every other action requires an already-established peer
        var peerId = connection.id;
        var self = peers[peerId];
        if (!self) return;

        if (msg.action === 'join-room') {
            var code = normalizeRoomCode(msg.data && msg.data.code);
            if (!code || self.room === code) return;
            if (self.room && rooms[self.room]) {
                delete rooms[self.room][peerId];
                if (!Object.keys(rooms[self.room]).length) delete rooms[self.room];
            }
            self.room = code;
            (rooms[code] || (rooms[code] = {}))[peerId] = true;

            connection.send({
                action: 'room-joined',
                data: {code: code, peers: peerListFor(peerId)}
            });
            broadcastToVisible(peerId, {action: 'peer-joined', data: {peerId: peerId, name: self.name}});
            return;
        }

        if (msg.action === 'signal') {
            var target = msg.data && peers[msg.data.to];
            if (!target) return; // target already left / unknown, drop silently
            target.connection.send({
                action: 'signal',
                data: {from: peerId, signal: msg.data.signal}
            });
            return;
        }
    });

    webSocketHandler.listen({route: route + 'connect', subserver: subserver});

    app.get(route, function(req, res) {
        res.end('WarpDropSignalingServer is running!');
    });
};
