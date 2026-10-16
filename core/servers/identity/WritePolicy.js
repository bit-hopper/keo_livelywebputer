/**
 * core/servers/identity/WritePolicy.js
 *
 * Pure rules for who may change a stored object and which parts of an object
 * a "metadata-only" update may not touch. No database, no Express: the routes in
 * IdentityServer.js call these with the stored envelope and the incoming one, so
 * the rules can be unit-tested on their own (tests/server/write-policy.test.js).
 *
 * Why these exist (Encryption.md §18.2):
 *
 *   - ownsExisting: PUT /@:handle/:objId used to check that the INCOMING envelope's
 *     did matched the session, but only postcards and wiki pages also checked the
 *     STORED object's owner. Every other type (world, part, file, folder, settings,
 *     profile, ...) could therefore be appended to by any signed-in account that
 *     knew the objId and the current tip cid. The version-rollback DELETE had the
 *     same gap: it only checked that the handle in the URL was the caller's own.
 *
 *   - metadataOnlyViolation / pinImmutable: an update whose record.cid equals the
 *     stored tip's is applied in place (ObjectRepository.put -> _updateInPlaceTx),
 *     storing the WHOLE submitted envelope. That path skips the signature check and
 *     the cid-versus-payload check, so a caller holding only a session cookie could
 *     send the same cid with a different payload and have it stored. A metadata-only
 *     update is by definition one that leaves the payload (and the keys that open it)
 *     alone, so those fields must match the stored ones.
 */

'use strict';

var cryptoVerify = require('./CryptoVerify');

// Fields of `record` that the cid, the signature or the DEK are bound to. A same-cid
// update may not change them.
var PINNED_RECORD_FIELDS = ['payload', 'nonce', 'wrappedDek'];

function _same(a, b) {
  if (a === b) return true;
  if (typeof a === 'string' || typeof b === 'string') return false;
  if (a === undefined || b === undefined) return false;
  return cryptoVerify.canonicalJson(a) === cryptoVerify.canonicalJson(b);
}

// True iff `identity` (req.identity, { did, handle }) owns the stored envelope.
function ownsExisting(existing, identity) {
  return !!(existing && identity && existing.did && existing.did === identity.did);
}

// null when `incoming` (an update carrying the same record.cid as `existing`) leaves
// the pinned fields alone; otherwise a message naming the first one that differs.
// A field the client omitted is fine: pinImmutable fills it from the stored envelope.
function metadataOnlyViolation(existing, incoming) {
  var er = (existing && existing.record) || {};
  var ir = (incoming && incoming.record) || {};
  for (var i = 0; i < PINNED_RECORD_FIELDS.length; i++) {
    var f = PINNED_RECORD_FIELDS[i];
    if (ir[f] === undefined) continue;
    if (!_same(ir[f], er[f])) {
      return 'record.' + f + ' differs from the stored version with the same cid; ' +
        'a metadata-only update cannot change it (save a new version instead)';
    }
  }
  return null;
}

// A copy of `incoming` whose pinned record fields are exactly the stored ones.
function pinImmutable(existing, incoming) {
  var er = (existing && existing.record) || {};
  var record = Object.assign({}, incoming.record);
  PINNED_RECORD_FIELDS.forEach(function (f) {
    if (er[f] !== undefined) record[f] = er[f];
  });
  return Object.assign({}, incoming, { record: record });
}

// PUT /@:handle/did-document replaces the stored document with whatever the session's
// owner sends, on the strength of the session cookie alone. Every signed write is
// verified against the delegation certs in that document (CryptoVerify.verifySignedPayload),
// so a cookie-only caller could strip the certs and make all of the account's later
// signed writes fail. It cannot forge a cert (that needs a passkey assertion), so the
// rule is: a delegated device method that is stored must still be there with a
// delegation cert, and the cert may only change to one that itself verifies for this
// DID (that is what UserSpace.enableEncryption's rotation produces). While the cert is
// unchanged, the wrapped signing key that goes with it must be unchanged too.
// Additions of new methods are not restricted. Returns null, or a message.
function didDocumentRegression(stored, incoming) {
  var storedMethods = (stored && stored.verificationMethod) || [];
  var incomingMethods = (incoming && incoming.verificationMethod) || [];
  var did = (stored && stored.id) || (incoming && incoming.id);
  for (var i = 0; i < storedMethods.length; i++) {
    var sm = storedMethods[i];
    var oldCert = sm.lively && sm.lively.delegationCert;
    if (!oldCert) continue;
    var nm = null;
    for (var j = 0; j < incomingMethods.length; j++) {
      if (incomingMethods[j].id === sm.id) { nm = incomingMethods[j]; break; }
    }
    if (!nm) return 'the delegated device key ' + sm.id + ' cannot be removed by a plain update';
    var newCert = nm.lively && nm.lively.delegationCert;
    if (!newCert) return 'the delegation certificate of ' + sm.id + ' cannot be removed by a plain update';
    if (_same(newCert, oldCert)) {
      if (!_same(nm.lively.softSigningKeyWrapped, sm.lively.softSigningKeyWrapped)) {
        return 'the wrapped signing key of ' + sm.id + ' cannot change without a new delegation certificate';
      }
    } else if (!cryptoVerify.verifyDelegationCert(newCert, did)) {
      return 'the replacement delegation certificate for ' + sm.id + ' does not verify for ' + did;
    }
  }
  return null;
}

module.exports = {
  PINNED_RECORD_FIELDS: PINNED_RECORD_FIELDS,
  ownsExisting: ownsExisting,
  metadataOnlyViolation: metadataOnlyViolation,
  pinImmutable: pinImmutable,
  didDocumentRegression: didDocumentRegression
};
