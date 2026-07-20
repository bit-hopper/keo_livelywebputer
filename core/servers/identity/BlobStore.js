/**
 * core/servers/identity/BlobStore.js
 *
 * Content-addressed storage for encrypted (or, for public files, plaintext)
 * blob bytes — the file-bytes half of the "file" envelope type (Encryption.md
 * §4/§5). The envelope itself (small encrypted metadata JSON) lives in
 * ObjectRepository/objects.db as usual; only the actual file bytes live here.
 *
 * Plain Node CommonJS, no Lively deps — same style as HandleRegistry.js /
 * ObjectRepository.js.
 *
 * Layout: <WORKSPACE_LK>/identity/blobs/<cid.slice(0,2)>/<cid>
 * (fan-out directory so a single dir never accumulates every blob).
 *
 * cid = base64url(SHA-256(ciphertext bytes)) — always 43 chars, charset
 * [A-Za-z0-9_-]. The filename IS the hash, so put() gets dedup and integrity
 * for free: verify while streaming to a tmp file, then rename into place.
 *
 * Explicitly not a MinIO/S3 client (see Encryption.md §4 design note) — if a
 * second implementation is ever needed (federation, terabytes of video),
 * write a second module with this same four-method interface; nothing above
 * it changes.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var BASE_DIR = path.join(
  process.env.WORKSPACE_LK || process.cwd(),
  'identity',
  'blobs'
);
var TMP_DIR = path.join(BASE_DIR, 'tmp');

var MAX_BLOB_SIZE = parseInt(process.env.IDENTITY_MAX_BLOB_SIZE, 10) || (100 * 1024 * 1024); // 100 MB

var CID_RE = /^[A-Za-z0-9_-]{43}$/;

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// base64url, no padding — matches Crypto.js's base64urlEncode on the client.
function _base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function _pathFor(cid) {
  return path.join(BASE_DIR, cid.slice(0, 2), cid);
}

// Store a blob, verifying its bytes hash to `cid`.
// readableStreamOrBuffer: a Node Readable stream (e.g. the raw request body)
//   or a Buffer.
// Calls thenDo(err, { cid, size }). Mismatch -> error, tmp file discarded.
// Idempotent: if the final path already exists, the incoming bytes are
// discarded (without re-verifying) and success is reported — content-
// addressed dedup, same as a normal write since the name IS the hash.
function put(cid, readableStreamOrBuffer, thenDo) {
  if (typeof cid !== 'string' || !CID_RE.test(cid)) {
    return thenDo(new Error('BlobStore.put: invalid cid'));
  }

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

  function onDone() {
    if (failed) return;
    var actualCid = _base64url(hash.digest());
    if (actualCid !== cid) {
      return finish(new Error(
        'BlobStore.put: hash mismatch — expected ' + cid + ' but bytes hash to ' + actualCid
      ));
    }
    var finalPath = _pathFor(cid);
    if (fs.existsSync(finalPath)) {
      cleanupTmp();
      return thenDo(null, { cid: cid, size: size });
    }
    _ensureDir(path.dirname(finalPath));
    fs.rename(tmpPath, finalPath, function (err) {
      if (err) return finish(err);
      failed = true; // tmp already moved — nothing left for cleanupTmp to do
      thenDo(null, { cid: cid, size: size });
    });
  }

  if (Buffer.isBuffer(readableStreamOrBuffer)) {
    var buf = readableStreamOrBuffer;
    size = buf.length;
    if (size > MAX_BLOB_SIZE) return finish(new Error('BlobStore.put: blob exceeds max size (' + MAX_BLOB_SIZE + ' bytes)'));
    hash.update(buf);
    out.end(buf, function () { onDone(); });
    return;
  }

  var stream = readableStreamOrBuffer;
  stream.on('data', function (chunk) {
    size += chunk.length;
    if (size > MAX_BLOB_SIZE) {
      stream.destroy();
      out.destroy();
      return finish(new Error('BlobStore.put: blob exceeds max size (' + MAX_BLOB_SIZE + ' bytes)'));
    }
    hash.update(chunk);
    out.write(chunk);
  });
  stream.on('end', function () { out.end(function () { onDone(); }); });
  stream.on('error', function (err) { out.destroy(); finish(err); });
}

// Calls thenDo(err, ReadStream | null) — null if the blob doesn't exist.
function get(cid, thenDo) {
  if (typeof cid !== 'string' || !CID_RE.test(cid)) {
    return thenDo(new Error('BlobStore.get: invalid cid'));
  }
  var full = _pathFor(cid);
  fs.stat(full, function (err, stat) {
    if (err || !stat.isFile()) return thenDo(null, null);
    thenDo(null, fs.createReadStream(full));
  });
}

// Calls thenDo(err, { size, mtime } | null).
function stat(cid, thenDo) {
  if (typeof cid !== 'string' || !CID_RE.test(cid)) {
    return thenDo(new Error('BlobStore.stat: invalid cid'));
  }
  fs.stat(_pathFor(cid), function (err, s) {
    if (err || !s.isFile()) return thenDo(null, null);
    thenDo(null, { size: s.size, mtime: s.mtime });
  });
}

// Calls thenDo(err, { ok: true }). Idempotent — deleting a non-existent
// blob is not an error.
function del(cid, thenDo) {
  if (typeof cid !== 'string' || !CID_RE.test(cid)) {
    return thenDo(new Error('BlobStore.delete: invalid cid'));
  }
  fs.unlink(_pathFor(cid), function (err) {
    if (err && err.code !== 'ENOENT') return thenDo(err);
    thenDo(null, { ok: true });
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
