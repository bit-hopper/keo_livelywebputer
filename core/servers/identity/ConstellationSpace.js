/**
 * core/servers/identity/ConstellationSpace.js
 *
 * Server-side support for a constellation's live shared space: short-lived
 * access tokens for the Yjs sync socket (PostCardSyncServer.js has no
 * access to the Express session store, so room-join auth rides a signed
 * token instead of a session cookie), and persisting the live Y.Doc as a
 * versioned envelope (reusing ObjectRepository's existing version-chain
 * logic, the same mechanism post cards use).
 */

'use strict';

var crypto = require('crypto');
var Y = require('yjs');

// In-memory secret for space-access tokens — regenerated on every process
// restart. Fine: tokens only need to survive a single WS handshake, and
// every open WS connection is dropped on restart anyway.
var TOKEN_SECRET = crypto.randomBytes(32);
var TOKEN_TTL_MS = 60 * 1000; // 1 minute — long enough for the WS handshake

function _b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function _b64urlDecode(str) { return Buffer.from(str, 'base64url'); }

// ─── access tokens ──────────────────────────────────────────────────────────

// identity: { did } for an authenticated caller, or null for an anonymous
// visitor (only valid on a public constellation — the caller must have
// already checked ConstellationRegistry.canRead before minting).
function mintSpaceToken(constellation, identity) {
  var payload = {
    did: identity ? identity.did : null,
    genesisObjId: constellation.genesisObjId,
    exp: Date.now() + TOKEN_TTL_MS
  };
  var payloadB64 = _b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  var sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest();
  return payloadB64 + '.' + _b64url(sig);
}

// Returns { did, genesisObjId } on success, or null if the token is
// missing/malformed/expired/forged/for the wrong room.
function verifySpaceToken(token, expectedGenesisObjId) {
  if (typeof token !== 'string') return null;
  var parts = token.split('.');
  if (parts.length !== 2) return null;

  var expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(parts[0]).digest();
  var gotSig;
  try {
    gotSig = _b64urlDecode(parts[1]);
  } catch (e) {
    return null;
  }
  if (expectedSig.length !== gotSig.length || !crypto.timingSafeEqual(expectedSig, gotSig)) {
    return null;
  }

  var payload;
  try {
    payload = JSON.parse(_b64urlDecode(parts[0]).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  if (payload.genesisObjId !== expectedGenesisObjId) return null;

  return { did: payload.did || null, genesisObjId: payload.genesisObjId };
}

// ─── snapshot + persistence ─────────────────────────────────────────────────

// Plain-JSON snapshot of a live space Y.Doc, for static rendering and
// (eventually) playback — mirrors how post cards extract a ProseMirror JSON
// snapshot alongside the raw Yjs update, just over layout/meta maps instead.
function buildLayoutSnapshot(yDoc) {
  return {
    layout: yDoc.getMap('layout').toJSON(),
    meta: yDoc.getMap('meta').toJSON()
  };
}

// Persists the current state of a constellation's live space Y.Doc as a new
// envelope version — creating the genesis version on first save. Called from
// PostCardSyncServer.js's debounced update handler.
//
// Server-authored: no human signer. The constellation's own did:web is the
// envelope's nominal owner and there is no `sig`, consistent with other
// unsigned envelope classes already in this system (e.g. DID documents).
// This intentionally sidesteps needing a multi-writer signed-PUT model for
// collaboratively-edited space state — attribution for individual edits
// lives in the Yjs update history itself (each update is tagged with its
// originating client), not in envelope-level signatures.
//
// Calls thenDo(err, { objId, cid, unchanged? }).
function saveSpaceSnapshot(constellation, objectRepo, yDoc, thenDo) {
  var update = Y.encodeStateAsUpdate(yDoc);
  var payload = {
    format: 'yjs-update-v1',
    update: _b64url(update),
    snapshot: buildLayoutSnapshot(yDoc)
  };
  var cid = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('base64url');

  objectRepo.get(constellation.genesisObjId, function (err, existing) {
    if (err) return thenDo(err);

    if (existing && existing.record.cid === cid) {
      return thenDo(null, { objId: constellation.genesisObjId, cid: cid, unchanged: true });
    }

    var envelope = {
      objId: constellation.genesisObjId,
      did: constellation.did,
      type: 'constellation-space',
      visibility: constellation.visibility,
      created: existing ? existing.created : new Date().toISOString(),
      record: {
        cid: cid,
        prevCid: existing ? existing.record.cid : null,
        payload: payload
      },
      state: {}
    };

    objectRepo.put(envelope, function (err) {
      if (err) return thenDo(err);
      thenDo(null, { objId: constellation.genesisObjId, cid: cid });
    });
  });
}

// Adds a placement (a posted post card) to a constellation's live layout
// map, server-side — no WebSocket round-trip needed. Reuses
// PostCardSyncServer's in-process room state: if the room is currently
// live (someone connected), the mutation broadcasts to them immediately via
// Yjs's normal update event and the room's already-attached debounced
// persistence handles saving; if the room isn't live, this hydrates it
// fresh, attaches persistence itself, and the same debounced save picks up
// the change a couple seconds later either way.
//
// PostCardSyncServer.js is require()'d lazily (inside the function, not at
// module top-level) because that file itself requires this one — a
// top-level require here would create a load-order cycle and see an
// incomplete module.exports.
//
// placement: { ref: {handle, objId, cid}, kind: "postcard" }
// Calls thenDo(err, { id }).
function addPlacementToSpace(constellation, placement, thenDo) {
  var sync = require('../PostCardSyncServer');
  sync.getOrHydrateRoom(constellation.genesisObjId, function (err, doc, isNewRoom) {
    if (err) return thenDo(err);
    if (isNewRoom) sync.attachPersistence(constellation.genesisObjId, constellation, doc);

    var layoutMap = doc.getMap('layout');
    var id = 'p-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    // Simple cascading default position so successive posts don't all land
    // exactly on top of each other — not a real layout algorithm.
    var n = layoutMap.size % 8;
    layoutMap.set(id, {
      ref: placement.ref,
      kind: placement.kind,
      x: 20 + n * 30,
      y: 20 + n * 30,
      w: 220,
      h: 140,
      z: 0
    });

    thenDo(null, { id: id });
  });
}

module.exports = {
  mintSpaceToken: mintSpaceToken,
  verifySpaceToken: verifySpaceToken,
  buildLayoutSnapshot: buildLayoutSnapshot,
  saveSpaceSnapshot: saveSpaceSnapshot,
  addPlacementToSpace: addPlacementToSpace
};
