/**
 * core/servers/identity/blob-common.js
 *
 * Constants and pure helpers shared by every BlobStore-shaped implementation
 * (BlobStore.js — local disk, S3BlobStore.js — S3-compatible object store),
 * so the cid format/hash-encoding/size-cap can't silently drift between them
 * the way two independently-copied definitions could.
 */

'use strict';

// cid = base64url(SHA-256(ciphertext bytes)) — always 43 chars.
var CID_RE = /^[A-Za-z0-9_-]{43}$/;

var MAX_BLOB_SIZE = parseInt(process.env.IDENTITY_MAX_BLOB_SIZE, 10) || (100 * 1024 * 1024); // 100 MB

// base64url, no padding — matches Crypto.js's base64urlEncode on the client.
function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Fan-out key/path segment so a single directory/prefix never accumulates
// every blob: <cid.slice(0,2)>/<cid>.
function keyFor(cid) {
  return cid.slice(0, 2) + '/' + cid;
}

module.exports = {
  CID_RE: CID_RE,
  MAX_BLOB_SIZE: MAX_BLOB_SIZE,
  base64url: base64url,
  keyFor: keyFor,
};
