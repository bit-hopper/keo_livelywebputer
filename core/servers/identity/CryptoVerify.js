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
  sha256: sha256,
  jwkFromDid: jwkFromDid,
  verifyJws: verifyJws,
  decodeJwsPayload: decodeJwsPayload,
  verifyDelegationCert: verifyDelegationCert,
  verifySignedPayload: verifySignedPayload
};
