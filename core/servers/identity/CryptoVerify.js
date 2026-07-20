/**
 * core/servers/identity/CryptoVerify.js
 *
 * Server-side (plain Node, no Lively/browser deps) verification of the
 * delegation chain used to sign envelopes client-side:
 *
 *   envelope sig -> devicePubKeyJwk -> delegation cert sig -> passkey -> did:jwk
 *
 * Ports the specific primitives needed from core/lively/identity/Crypto.js
 * (canonicalJson, verifyJws) and core/lively/identity/DID.js (jwkFromDid,
 * verifyDelegationCert), swapping Web Crypto (async, browser-only) for
 * Node's synchronous `crypto` module. No new npm dependency.
 *
 * All functions here are synchronous — Node's crypto.verify has a
 * synchronous overload (no callback), unlike the browser's crypto.subtle.
 */

'use strict';

var crypto = require('crypto');

// ─── base64url & canonical JSON ────────────────────────────────────────────

function base64urlDecode(str) {
  return Buffer.from(str, 'base64url');
}

function base64urlEncode(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

// Direct port of Crypto.js canonicalJson: recursively sorted-key JSON
// serialization so signing/verification don't depend on key order.
function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  var keys = Object.keys(obj).sort();
  return '{' + keys.map(function (k) {
    return JSON.stringify(k) + ':' + canonicalJson(obj[k]);
  }).join(',') + '}';
}

function sha256(bufferOrString) {
  return crypto.createHash('sha256').update(bufferOrString).digest();
}

// Direct port of Crypto.js canonicalizeJwk (RFC 7638 §3.2): only the
// required members for the key type, lexicographically sorted, so the
// thumbprint is stable regardless of what produced the JWK.
function canonicalizeJwk(jwk) {
  var required;
  if (jwk.kty === 'EC') {
    required = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  } else if (jwk.kty === 'OKP') {
    required = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  } else {
    required = { kty: jwk.kty };
  }
  return canonicalJson(required);
}

// ─── COSE_Key (CBOR) → did:jwk ──────────────────────────────────────────────
// Sync port of WebAuthn.js's _decodeCborMap/_cborReadLength/coseKeyToJwk
// (browser) combined with DID.js's didFromJwk, for server-side verification
// that a registering client's submitted `did` actually matches the passkey
// it just attested (Encryption.md §10). Handles only what a COSE_Key needs:
// unsigned/negative ints, byte strings, maps — same coverage as the client
// (EC2 P-256/ES256 and OKP Ed25519/EdDSA; RSA rejected).

function _cborReadLength(bytes, offset, additionalInfo) {
  if (additionalInfo < 24) return { value: additionalInfo, nextOffset: offset };
  if (additionalInfo === 24) return { value: bytes[offset], nextOffset: offset + 1 };
  if (additionalInfo === 25) {
    return { value: (bytes[offset] << 8) | bytes[offset + 1], nextOffset: offset + 2 };
  }
  if (additionalInfo === 26) {
    return {
      value: ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0,
      nextOffset: offset + 4
    };
  }
  throw new Error('CBOR length encoding not supported: additionalInfo=' + additionalInfo);
}

function _decodeCbor(bytes, offset) {
  var initialByte = bytes[offset++];
  var majorType = (initialByte >> 5) & 0x07;
  var additionalInfo = initialByte & 0x1f;
  var length = _cborReadLength(bytes, offset, additionalInfo);
  offset = length.nextOffset;
  var n = length.value;

  if (majorType === 0) return { value: n, nextOffset: offset }; // unsigned int
  if (majorType === 1) return { value: -1 - n, nextOffset: offset }; // negative int
  if (majorType === 2) return { value: bytes.slice(offset, offset + n), nextOffset: offset + n }; // byte string
  if (majorType === 3) return { value: bytes.slice(offset, offset + n).toString('utf8'), nextOffset: offset + n }; // text string
  if (majorType === 4) {
    var arr = [];
    for (var i = 0; i < n; i++) {
      var item = _decodeCbor(bytes, offset);
      arr.push(item.value);
      offset = item.nextOffset;
    }
    return { value: arr, nextOffset: offset };
  }
  if (majorType === 5) {
    var map = {};
    for (var i = 0; i < n; i++) {
      var key = _decodeCbor(bytes, offset); offset = key.nextOffset;
      var val = _decodeCbor(bytes, offset); offset = val.nextOffset;
      map[key.value] = val.value;
    }
    return { value: map, nextOffset: offset };
  }
  throw new Error('Unsupported CBOR major type: ' + majorType);
}

// coseBytes: Buffer/Uint8Array — the COSE_Key CBOR bytes as delivered in
// @simplewebauthn/server's registrationInfo.credential.publicKey.
// Returns a did:jwk string. Throws on an unsupported/malformed key.
function didFromCose(coseBytes) {
  var bytes = coseBytes instanceof Uint8Array ? coseBytes : new Uint8Array(coseBytes);
  var decoded = _decodeCbor(bytes, 0);
  var map = decoded.value;
  var kty = map[1];  // COSE key type: 2 = EC2, 1 = OKP
  var alg = map[3];  // COSE algorithm: -7 = ES256, -8 = EdDSA

  var jwk;
  if (kty === 2 && alg === -7) {
    jwk = { kty: 'EC', crv: 'P-256', x: base64urlEncode(map[-2]), y: base64urlEncode(map[-3]) };
  } else if (kty === 1 && alg === -8) {
    jwk = { kty: 'OKP', crv: 'Ed25519', x: base64urlEncode(map[-2]) };
  } else {
    throw new Error(
      'didFromCose: unsupported COSE key type/algorithm: kty=' + kty + ' alg=' + alg +
      '. Only EC P-256 (ES256/-7) and OKP Ed25519 (EdDSA/-8) are supported.'
    );
  }

  var canonical = canonicalizeJwk(jwk);
  return 'did:jwk:' + base64urlEncode(Buffer.from(canonical, 'utf8'));
}

// ─── did:jwk decode ─────────────────────────────────────────────────────────

// Sync port of DID.js jwkFromDid — decodes a did:jwk string back to a JWK.
function jwkFromDid(did) {
  if (typeof did !== 'string' || did.indexOf('did:jwk:') !== 0) {
    throw new Error('jwkFromDid: not a did:jwk string: ' + did);
  }
  var encoded = did.slice('did:jwk:'.length);
  var bytes = base64urlDecode(encoded);
  return JSON.parse(bytes.toString('utf8'));
}

// ─── ECDSA P-256 verify ─────────────────────────────────────────────────────

// Two different ECDSA signature encodings show up in this system:
//   - Web Crypto (crypto.subtle.sign, used by Crypto.js signJws for the
//     envelope/creationSig JWS) produces raw r||s (IEEE P1363).
//   - A real WebAuthn assertion signature (navigator.credentials.get(),
//     used for the delegation cert's passkey signature) is DER-encoded
//     per the WebAuthn/CTAP2 spec — WebAuthn.js's authenticate() passes
//     response.signature through unmodified, so it stays DER.
// Node's crypto.verify defaults to DER; dsaEncoding: 'ieee-p1363' must be
// passed explicitly for the Web-Crypto-produced signatures.
function verifyEcdsaP256(publicKeyJwk, signingInput, signature, encoding) {
  var keyObject = crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' });
  try {
    return crypto.verify(
      'sha256',
      signingInput,
      { key: keyObject, dsaEncoding: encoding || 'der' },
      signature
    );
  } catch (e) {
    return false;
  }
}

// ─── JWS (compact) ──────────────────────────────────────────────────────────

// Verify a JWS Compact string (header.payload.signature) against a public
// key JWK. Mirrors Crypto.js verifyJws.
function verifyJws(jws, publicKeyJwk) {
  if (typeof jws !== 'string') return false;
  var parts = jws.split('.');
  if (parts.length !== 3) return false;
  var signingInput = Buffer.from(parts[0] + '.' + parts[1], 'utf8');
  var signature = base64urlDecode(parts[2]);
  return verifyEcdsaP256(publicKeyJwk, signingInput, signature, 'ieee-p1363');
}

// Decode the payload embedded in a JWS Compact string without verifying it.
// Callers must still verify the signature separately.
function decodeJwsPayload(jws) {
  var parts = jws.split('.');
  if (parts.length !== 3) throw new Error('decodeJwsPayload: invalid JWS compact string');
  return JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
}

// ─── delegation cert ────────────────────────────────────────────────────────

// Sync port of DID.js verifyDelegationCert. Confirms:
//   (1) clientDataJSON.challenge === H(canonicalJson({devicePubKeyJwk, credentialId, issuedAt}))
//   (2) the WebAuthn assertion signature is valid for the passkey in `did`.
function verifyDelegationCert(cert, did) {
  if (!cert || !cert.devicePubKeyJwk || !cert.credentialId || !cert.issuedAt ||
      !cert.authenticatorData || !cert.clientDataJSON || !cert.signature) {
    return false;
  }

  var delegationPayload = {
    devicePubKeyJwk: cert.devicePubKeyJwk,
    credentialId: cert.credentialId,
    issuedAt: cert.issuedAt
  };
  var expectedDigestB64 = base64urlEncode(sha256(canonicalJson(delegationPayload)));

  var clientDataBytes;
  var clientData;
  try {
    clientDataBytes = base64urlDecode(cert.clientDataJSON);
    clientData = JSON.parse(clientDataBytes.toString('utf8'));
  } catch (e) {
    return false;
  }

  if (clientData.challenge !== expectedDigestB64) return false;

  var passkeyJwk;
  try {
    passkeyJwk = jwkFromDid(did);
  } catch (e) {
    return false;
  }

  var authDataBytes = base64urlDecode(cert.authenticatorData);
  var clientDataHash = sha256(clientDataBytes);
  var signingInput = Buffer.concat([authDataBytes, clientDataHash]);
  var sigBytes = base64urlDecode(cert.signature);

  return verifyEcdsaP256(passkeyJwk, signingInput, sigBytes, 'der');
}

// ─── entry point: verify a signed payload against a DID document ──────────

// expectedPayload: the object the server reconstructs from the request it
//   received (e.g. the constellation genesis fields) — must canonically
//   match the payload actually embedded in the JWS, so a caller can't sign
//   one thing and submit different fields for storage.
// jws: the JWS compact string (e.g. creationSig).
// didDocument: the signer's DID document (verificationMethod[].lively.delegationCert).
//
// Returns { valid: true } or { valid: false, reason: String }.
function verifySignedPayload(expectedPayload, jws, didDocument) {
  var signedPayload;
  try {
    signedPayload = decodeJwsPayload(jws);
  } catch (e) {
    return { valid: false, reason: 'malformed JWS: ' + e.message };
  }

  if (canonicalJson(signedPayload) !== canonicalJson(expectedPayload)) {
    return { valid: false, reason: 'signed payload does not match submitted fields' };
  }

  var methods = (didDocument && didDocument.verificationMethod) || [];
  for (var i = 0; i < methods.length; i++) {
    var cert = methods[i].lively && methods[i].lively.delegationCert;
    if (!cert) continue;
    if (!verifyJws(jws, cert.devicePubKeyJwk)) continue;
    if (!verifyDelegationCert(cert, didDocument.id)) continue;
    return { valid: true };
  }

  return { valid: false, reason: 'no verification method validated the signature' };
}

module.exports = {
  base64urlDecode: base64urlDecode,
  base64urlEncode: base64urlEncode,
  canonicalJson: canonicalJson,
  canonicalizeJwk: canonicalizeJwk,
  sha256: sha256,
  jwkFromDid: jwkFromDid,
  didFromCose: didFromCose,
  verifyJws: verifyJws,
  decodeJwsPayload: decodeJwsPayload,
  verifyDelegationCert: verifyDelegationCert,
  verifySignedPayload: verifySignedPayload
};
