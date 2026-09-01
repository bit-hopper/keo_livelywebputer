/**
 * core/servers/identity/ConstellationSpace.js
 *
 * Server-side support for a constellation's live shared Yjs room: short-
 * lived access tokens for the sync socket (LiveDocSyncServer.js has no
 * access to the Express session store, so room-join auth rides a signed
 * token instead of a session cookie). Originally also persisted a
 * drag-place canvas layout as a versioned envelope; the canvas feature was
 * removed (no clear product goal, extra infra/perf cost), but the token
 * machinery stays — ConstellationLounge.js's live "who's online" presence
 * feature connects to the same token-gated Yjs room, just for
 * awareness/cursor state, never a layout map.
 */

'use strict';

var crypto = require('crypto');
var cluster = require('cluster');

// In-memory secret for space-access tokens. Under Node's cluster module,
// both minting (mintSpaceToken, from a normal Express route) AND verifying
// (verifySpaceToken, from LiveDocSyncServer.js's WS handler) can now run in
// ANY worker -- confirmed live 2026-08-27 as a permanent (not probabilistic)
// WS reconnect-loop under --workers when this was still generated
// per-process (mint and verify were never the same process). Fixed the same
// way as support/room-token-store.js: the primary generates and holds the
// one canonical secret; each worker fetches it once via IPC at startup and
// caches it forever after, rather than generating its own. Still
// regenerated on every process restart, same as before -- tokens only need
// to survive a single WS handshake.
//
// verifySpaceToken used to be able to assume TOKEN_SECRET was always
// already set, back when LiveDocSyncServer.js ran its own standalone port
// and only the cluster primary ever handled WS connections. Now that
// LiveDocSyncServer.js rides the shared per-worker listener (see its own
// header), a worker's very first LiveDoc connection could plausibly be a
// verify for a token some OTHER worker minted, before this worker has ever
// locally minted one itself -- so verifySpaceToken needs the same
// ensureSecret gate mintSpaceToken already has, not just a defensive null
// check. See verifySpaceToken below.
var TOKEN_SECRET = cluster.isWorker ? null : crypto.randomBytes(32);
var TOKEN_TTL_MS = 60 * 1000; // 1 minute — long enough for the WS handshake

var _secretReadyPromise = null;
function ensureSecret(thenDo) {
  if (TOKEN_SECRET) return thenDo(null, TOKEN_SECRET);
  if (!_secretReadyPromise) {
    _secretReadyPromise = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        process.removeListener('message', onMessage);
        reject(new Error('ConstellationSpace: primary did not reply with TOKEN_SECRET in time'));
      }, 5000);
      function onMessage(msg) {
        if (!msg || msg.channel !== 'space-token-secret' || msg.type !== 'reply') return;
        clearTimeout(timer);
        process.removeListener('message', onMessage);
        TOKEN_SECRET = Buffer.from(msg.secret, 'base64');
        resolve(TOKEN_SECRET);
      }
      process.on('message', onMessage);
      process.send({ channel: 'space-token-secret', type: 'request' });
    });
  }
  _secretReadyPromise.then(
    function (secret) { thenDo(null, secret); },
    function (err) { thenDo(err); }
  );
}

// Wires up the primary side of the IPC bridge above: replies to any
// worker's secret request with this process's own canonical TOKEN_SECRET.
// Call once from the cluster primary (bin/lk-server.js), before forking
// workers.
function wireClusterPrimary() {
  cluster.on('fork', function (worker) {
    worker.on('message', function (msg) {
      if (!msg || msg.channel !== 'space-token-secret' || msg.type !== 'request') return;
      worker.send({ channel: 'space-token-secret', type: 'reply', secret: TOKEN_SECRET.toString('base64') });
    });
  });
}

function _b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function _b64urlDecode(str) { return Buffer.from(str, 'base64url'); }

// ─── access tokens ──────────────────────────────────────────────────────────

// identity: { did } for an authenticated caller, or null for an anonymous
// visitor (only valid on a public constellation — the caller must have
// already checked ConstellationRegistry.canRead before minting).
// Calls thenDo(err, token) -- async because a worker's very first call may
// need one IPC round trip to the primary for the shared secret (see
// ensureSecret above); cached forever after, so every later call resolves
// immediately.
function mintSpaceToken(constellation, identity, thenDo) {
  ensureSecret(function (err, secret) {
    if (err) return thenDo(err);
    var payload = {
      did: identity ? identity.did : null,
      genesisObjId: constellation.genesisObjId,
      exp: Date.now() + TOKEN_TTL_MS
    };
    var payloadB64 = _b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    var sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
    thenDo(null, payloadB64 + '.' + _b64url(sig));
  });
}

// Calls thenDo(err, result) where result is { did, genesisObjId } on
// success, or null if the token is missing/malformed/expired/forged/for
// the wrong room. Async for the same reason mintSpaceToken is: a worker's
// first call (mint OR verify, whichever happens first) may need one IPC
// round trip to the primary for the shared secret; cached forever after.
function verifySpaceToken(token, expectedGenesisObjId, thenDo) {
  ensureSecret(function (err) {
    if (err) return thenDo(err, null);
    thenDo(null, _verifySpaceTokenSync(token, expectedGenesisObjId));
  });
}

// TOKEN_SECRET is guaranteed set by the time this runs -- only called from
// verifySpaceToken above, after ensureSecret's callback fires.
function _verifySpaceTokenSync(token, expectedGenesisObjId) {
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

module.exports = {
  mintSpaceToken: mintSpaceToken,
  verifySpaceToken: verifySpaceToken,
  wireClusterPrimary: wireClusterPrimary
};
