/**
 * core/servers/identity/S3BlobStore.js
 *
 * Second BlobStore implementation (BlobStore.js's own header comment
 * anticipated this) — same four-method interface (put/get/stat/delete) as
 * BlobStore.js, backed by a real S3-compatible object store (MinIO, DO
 * Spaces, AWS S3) instead of local disk, so blob bytes are reachable from
 * every instance in a horizontally-scaled deployment. IdentityServer.js
 * requires this module instead of BlobStore.js whenever BLOB_S3_BUCKET is
 * set — an opt-in swap, not a mandatory cutover like the Postgres
 * migration, since local disk on a single persistent-volume instance is
 * still a legitimate deployment shape (see DeployCheckList.md's
 * "recommended near-term deployment shape").
 *
 * Config (all via env):
 *   BLOB_S3_BUCKET      - required to select this backend at all (see
 *                          IdentityServer.js's require site).
 *   BLOB_S3_ENDPOINT    - host[:port], e.g. "nyc3.digitaloceanspaces.com" or
 *                          "localhost:9000" for a local MinIO. Defaults to
 *                          "s3.amazonaws.com" (real AWS S3) if unset.
 *   BLOB_S3_REGION      - defaults to "us-east-1".
 *   BLOB_S3_ACCESS_KEY / BLOB_S3_SECRET_KEY - required.
 *   BLOB_S3_USE_SSL     - defaults to true; set to the literal string
 *                          "false" for a local non-TLS MinIO instance.
 *
 * Verification: unlike local disk's write-tmp-then-rename trick, S3 has no
 * atomic rename, and an object becomes visible to GET the moment its PUT
 * completes — so a hash-mismatched upload must never be allowed to complete
 * as a PUT to the real key at all. Incoming bytes are streamed to a local
 * scratch tmp file while hashing (same as BlobStore.js), and only then
 * uploaded to the object store once the digest is confirmed to match the
 * claimed cid, giving the same "bad bytes are never visible under the
 * cid's key" guarantee the disk implementation has.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var Minio = require('minio');
var common = require('./blob-common');

var CID_RE = common.CID_RE;
var MAX_BLOB_SIZE = common.MAX_BLOB_SIZE;

var BUCKET = process.env.BLOB_S3_BUCKET;
var REGION = process.env.BLOB_S3_REGION || 'us-east-1';

// Local scratch space only — never permanent storage. Kept alongside
// BlobStore.js's own tmp dir precedent, under a distinct name so both
// implementations could in principle run side by side without colliding.
var TMP_DIR = path.join(
  process.env.WORKSPACE_LK || process.cwd(),
  'identity',
  's3-blob-tmp'
);

// "host:port" -> {host, port}. Guards against treating a bare hostname
// (no port) as having one.
function _parseEndpoint(raw) {
  var idx = raw.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(raw.slice(idx + 1))) {
    return { host: raw.slice(0, idx), port: parseInt(raw.slice(idx + 1), 10) };
  }
  return { host: raw, port: undefined };
}

var _endpoint = _parseEndpoint(process.env.BLOB_S3_ENDPOINT || 's3.amazonaws.com');

var client = new Minio.Client({
  endPoint: _endpoint.host,
  port: _endpoint.port,
  useSSL: process.env.BLOB_S3_USE_SSL !== 'false',
  region: REGION,
  accessKey: process.env.BLOB_S3_ACCESS_KEY,
  secretKey: process.env.BLOB_S3_SECRET_KEY,
});

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Cached bucket-exists-or-create promise — same one-shot-bootstrap idiom
// postgres-client.js's callers use for schema DDL, applied here to bucket
// creation instead.
var _bucketReady = null;
function _ensureBucket() {
  if (!_bucketReady) {
    _bucketReady = client.bucketExists(BUCKET).then(function (exists) {
      if (!exists) return client.makeBucket(BUCKET, REGION);
    }).catch(function (err) {
      _bucketReady = null; // don't stay wedged on a transient failure — next call retries
      throw err;
    });
  }
  return _bucketReady;
}

function _isNotFound(err) {
  return !!err && (err.code === 'NoSuchKey' || err.code === 'NotFound');
}

// Store a blob, verifying its bytes hash to `cid`.
// readableStreamOrBuffer: a Node Readable stream (e.g. the raw request body)
//   or a Buffer.
// Calls thenDo(err, { cid, size }). Mismatch -> error, tmp file discarded,
// nothing ever uploaded.
// Idempotent: if the object already exists under this cid's key, the
// incoming bytes are discarded (without re-verifying) and success is
// reported — content-addressed dedup, same as BlobStore.js.
function put(cid, readableStreamOrBuffer, thenDo) {
  if (typeof cid !== 'string' || !CID_RE.test(cid)) {
    return thenDo(new Error('S3BlobStore.put: invalid cid'));
  }

  // Stream/buffer handling below must attach its listeners (or consume the
  // buffer) synchronously, in this same call — readableStreamOrBuffer is
  // frequently a live Node HTTP request object whose bytes can already be
  // in flight. Gating this behind _ensureBucket() (a real network call)
  // used to run first was a real bug, same shape as this codebase's other
  // "listener attached too late" races: the request stream's data arrived
  // and drained before .on('data') ever got attached, so every upload
  // silently hashed to the empty string. _ensureBucket() is only awaited
  // later, right before the actual S3 upload — by then the bytes are
  // already safely staged in the local tmp file.
  _ensureDir(TMP_DIR);
  var tmpPath = path.join(TMP_DIR, crypto.randomBytes(16).toString('hex') + '.tmp');
  var hash = crypto.createHash('sha256');
  var size = 0;
  var failed = false;

  function cleanupTmp() {
    fs.unlink(tmpPath, function () {}); // best-effort
  }

  function finish(err, result) {
    if (failed) return;
    failed = true;
    if (err) { cleanupTmp(); return thenDo(err); }
    thenDo(null, result);
  }

  var out = fs.createWriteStream(tmpPath);
  out.on('error', function (err) { finish(err); });

  function onWritten() {
    if (failed) return;
    var actualCid = common.base64url(hash.digest());
    if (actualCid !== cid) {
      return finish(new Error(
        'S3BlobStore.put: hash mismatch — expected ' + cid + ' but bytes hash to ' + actualCid
      ));
    }
    _ensureBucket().then(function () {
      var key = common.keyFor(cid);
      client.statObject(BUCKET, key).then(function () {
        cleanupTmp();
        thenDo(null, { cid: cid, size: size });
      }).catch(function (statErr) {
        if (!_isNotFound(statErr)) return finish(statErr);
        client.putObject(BUCKET, key, fs.createReadStream(tmpPath), size).then(function () {
          cleanupTmp();
          thenDo(null, { cid: cid, size: size });
        }).catch(function (putErr) { finish(putErr); });
      });
    }).catch(function (err) { finish(err); });
  }

  if (Buffer.isBuffer(readableStreamOrBuffer)) {
    var buf = readableStreamOrBuffer;
    size = buf.length;
    if (size > MAX_BLOB_SIZE) return finish(new Error('S3BlobStore.put: blob exceeds max size (' + MAX_BLOB_SIZE + ' bytes)'));
    hash.update(buf);
    out.end(buf, function () { onWritten(); });
    return;
  }

  var stream = readableStreamOrBuffer;
  stream.on('data', function (chunk) {
    size += chunk.length;
    if (size > MAX_BLOB_SIZE) {
      stream.destroy();
      out.destroy();
      return finish(new Error('S3BlobStore.put: blob exceeds max size (' + MAX_BLOB_SIZE + ' bytes)'));
    }
    hash.update(chunk);
    out.write(chunk);
  });
  stream.on('end', function () { out.end(function () { onWritten(); }); });
  stream.on('error', function (err) { out.destroy(); finish(err); });
}

// Calls thenDo(err, ReadStream | null) — null if the blob doesn't exist.
function get(cid, thenDo) {
  if (typeof cid !== 'string' || !CID_RE.test(cid)) {
    return thenDo(new Error('S3BlobStore.get: invalid cid'));
  }
  client.getObject(BUCKET, common.keyFor(cid)).then(function (stream) {
    thenDo(null, stream);
  }).catch(function (err) {
    if (_isNotFound(err)) return thenDo(null, null);
    thenDo(err);
  });
}

// Calls thenDo(err, { size, mtime } | null).
function stat(cid, thenDo) {
  if (typeof cid !== 'string' || !CID_RE.test(cid)) {
    return thenDo(new Error('S3BlobStore.stat: invalid cid'));
  }
  client.statObject(BUCKET, common.keyFor(cid)).then(function (s) {
    thenDo(null, { size: s.size, mtime: s.lastModified });
  }).catch(function (err) {
    if (_isNotFound(err)) return thenDo(null, null);
    thenDo(err);
  });
}

// Calls thenDo(err, { ok: true }). Idempotent — deleting a non-existent
// blob is not an error (matches S3 DELETE semantics, which return success
// either way).
function del(cid, thenDo) {
  if (typeof cid !== 'string' || !CID_RE.test(cid)) {
    return thenDo(new Error('S3BlobStore.delete: invalid cid'));
  }
  client.removeObject(BUCKET, common.keyFor(cid)).then(function () {
    thenDo(null, { ok: true });
  }).catch(function (err) {
    if (_isNotFound(err)) return thenDo(null, { ok: true });
    thenDo(err);
  });
}

module.exports = {
  CID_RE: CID_RE,
  MAX_BLOB_SIZE: MAX_BLOB_SIZE,
  put: put,
  get: get,
  stat: stat,
  delete: del,
};
