// Unit tests for the stored-object write rules (core/servers/identity/WritePolicy.js).
// No database or server needed: `node --test tests/server/write-policy.test.js`.
const test = require("node:test");
const assert = require("node:assert/strict");
const wp = require("../../core/servers/identity/WritePolicy");

const stored = (extra) => Object.assign({
  objId: "abc123def456", did: "did:jwk:owner", type: "file", visibility: "public",
  record: { cid: "CID1", prevCid: null, payload: { name: "owned.txt", size: 11, mime: "text/plain" }, nonce: "N1", wrappedDek: "W1", recipients: [] },
  state: {},
}, extra);

test("ownsExisting: only the stored object's own did", () => {
  assert.equal(wp.ownsExisting(stored(), { did: "did:jwk:owner", handle: "a" }), true);
  assert.equal(wp.ownsExisting(stored(), { did: "did:jwk:other", handle: "b" }), false);
  assert.equal(wp.ownsExisting(stored(), null), false);
  assert.equal(wp.ownsExisting(null, { did: "did:jwk:owner" }), false);
  assert.equal(wp.ownsExisting(stored({ did: undefined }), { did: undefined }), false);
});

test("metadataOnlyViolation: unchanged payload passes, whatever the key order", () => {
  const inc = stored();
  inc.record = Object.assign({}, inc.record, { payload: { mime: "text/plain", size: 11, name: "owned.txt" } });
  assert.equal(wp.metadataOnlyViolation(stored(), inc), null);
});

test("metadataOnlyViolation: a different payload under the same cid is refused", () => {
  const inc = stored();
  inc.record = Object.assign({}, inc.record, { payload: { name: "SWAPPED.txt", size: 11, mime: "text/plain" } });
  assert.match(wp.metadataOnlyViolation(stored(), inc), /record\.payload differs/);
});

test("metadataOnlyViolation: ciphertext string payloads compare exactly", () => {
  const s = stored(); s.record.payload = "ciphertext-A";
  const same = stored(); same.record.payload = "ciphertext-A";
  const other = stored(); other.record.payload = "ciphertext-B";
  assert.equal(wp.metadataOnlyViolation(s, same), null);
  assert.match(wp.metadataOnlyViolation(s, other), /record\.payload differs/);
});

test("metadataOnlyViolation: nonce and wrappedDek are pinned too", () => {
  const a = stored(); a.record = Object.assign({}, a.record, { nonce: "N2" });
  const b = stored(); b.record = Object.assign({}, b.record, { wrappedDek: "W2" });
  assert.match(wp.metadataOnlyViolation(stored(), a), /record\.nonce differs/);
  assert.match(wp.metadataOnlyViolation(stored(), b), /record\.wrappedDek differs/);
});

test("metadataOnlyViolation: visibility, state and recipients may change", () => {
  const inc = stored({ visibility: "shared", state: { name: "renamed" } });
  inc.record = Object.assign({}, inc.record, { recipients: [{ did: "did:jwk:friend", sealedDek: "S" }] });
  assert.equal(wp.metadataOnlyViolation(stored(), inc), null);
});

test("metadataOnlyViolation: an omitted payload is allowed and pinImmutable restores it", () => {
  const inc = stored({ visibility: "private" });
  delete inc.record.payload;
  assert.equal(wp.metadataOnlyViolation(stored(), inc), null);
  const pinned = wp.pinImmutable(stored(), inc);
  assert.deepEqual(pinned.record.payload, stored().record.payload);
  assert.equal(pinned.visibility, "private");
});

// ── DID document rule ──────────────────────────────────────────────────────
const crypto = require("node:crypto");
const cv = require("../../core/servers/identity/CryptoVerify");

// A real delegation cert: the "passkey" (a fresh P-256 key) signs an authenticator-style assertion whose
// challenge is the hash of the delegation payload, exactly as CryptoVerify.verifyDelegationCert expects.
function makePasskey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const did = "did:jwk:" + cv.base64urlEncode(Buffer.from(cv.canonicalizeJwk(jwk), "utf8"));
  const certFor = (devicePubKeyJwk, credentialId) => {
    const issuedAt = new Date().toISOString() + Math.random();
    const challenge = cv.base64urlEncode(cv.sha256(cv.canonicalJson({ devicePubKeyJwk, credentialId, issuedAt })));
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: "http://localhost" }), "utf8");
    const authData = crypto.randomBytes(37);
    const signature = crypto.sign("sha256", Buffer.concat([authData, cv.sha256(clientData)]), { key: privateKey, dsaEncoding: "der" });
    return { devicePubKeyJwk, credentialId, issuedAt, authenticatorData: cv.base64urlEncode(authData),
      clientDataJSON: cv.base64urlEncode(clientData), signature: cv.base64urlEncode(signature) };
  };
  return { did, jwk, certFor };
}
const deviceJwk = () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
const docWith = (did, jwk, lively) => ({ id: did, verificationMethod: [{ id: did + "#m1", type: "JsonWebKey2020", controller: did, publicKeyJwk: jwk, lively }] });

test("didDocumentRegression: the helper's cert really verifies (so the other cases mean something)", () => {
  const p = makePasskey();
  assert.equal(cv.verifyDelegationCert(p.certFor(deviceJwk(), "cred1"), p.did), true);
});

test("didDocumentRegression: unchanged and additive updates pass", () => {
  const p = makePasskey();
  const cert = p.certFor(deviceJwk(), "cred1");
  const stored = docWith(p.did, p.jwk, { credentialId: "cred1", delegationCert: cert, softSigningKeyWrapped: "WRAP1" });
  assert.equal(wp.didDocumentRegression(stored, JSON.parse(JSON.stringify(stored))), null);
  const withMore = JSON.parse(JSON.stringify(stored));
  withMore.verificationMethod.push({ id: p.did + "#m2", type: "JsonWebKey2020", controller: p.did, publicKeyJwk: deviceJwk(), lively: {} });
  withMore.updated = "later";
  assert.equal(wp.didDocumentRegression(stored, withMore), null);
});

test("didDocumentRegression: removing the method, the cert, or changing the wrapped key is refused", () => {
  const p = makePasskey();
  const cert = p.certFor(deviceJwk(), "cred1");
  const stored = docWith(p.did, p.jwk, { credentialId: "cred1", delegationCert: cert, softSigningKeyWrapped: "WRAP1" });
  const noMethod = { id: p.did, verificationMethod: [] };
  const noCert = docWith(p.did, p.jwk, { credentialId: "cred1", softSigningKeyWrapped: "WRAP1" });
  const newWrap = docWith(p.did, p.jwk, { credentialId: "cred1", delegationCert: cert, softSigningKeyWrapped: "GARBAGE" });
  assert.match(wp.didDocumentRegression(stored, noMethod), /cannot be removed/);
  assert.match(wp.didDocumentRegression(stored, noCert), /delegation certificate .* cannot be removed/);
  assert.match(wp.didDocumentRegression(stored, newWrap), /wrapped signing key .* cannot change/);
});

test("didDocumentRegression: a rotated cert passes only if it verifies for this DID", () => {
  const p = makePasskey();
  const stored = docWith(p.did, p.jwk, { credentialId: "cred1", delegationCert: p.certFor(deviceJwk(), "cred1"), softSigningKeyWrapped: "WRAP1" });
  const rotated = docWith(p.did, p.jwk, { credentialId: "cred1", delegationCert: p.certFor(deviceJwk(), "cred1"), softSigningKeyWrapped: "WRAP2" });
  assert.equal(wp.didDocumentRegression(stored, rotated), null);
  const stranger = makePasskey(); // a cert signed by some other passkey
  const forged = docWith(p.did, p.jwk, { credentialId: "cred1", delegationCert: stranger.certFor(deviceJwk(), "cred1"), softSigningKeyWrapped: "WRAP2" });
  assert.match(wp.didDocumentRegression(stored, forged), /does not verify/);
});

test("didDocumentRegression: an account with no delegated method yet is unrestricted", () => {
  const p = makePasskey();
  const stored = docWith(p.did, p.jwk, { credentialId: "cred1" });
  const next = docWith(p.did, p.jwk, { credentialId: "cred1", delegationCert: p.certFor(deviceJwk(), "cred1"), softSigningKeyWrapped: "W" });
  assert.equal(wp.didDocumentRegression(stored, next), null);
  assert.equal(wp.didDocumentRegression(null, next), null);
});

test("pinImmutable: does not mutate its inputs and keeps changeable fields", () => {
  const ex = stored();
  const inc = stored({ visibility: "shared" });
  inc.record = Object.assign({}, inc.record, { recipients: [{ did: "d", sealedDek: "s" }] });
  const before = JSON.stringify(inc);
  const pinned = wp.pinImmutable(ex, inc);
  assert.equal(JSON.stringify(inc), before);
  assert.deepEqual(pinned.record.recipients, [{ did: "d", sealedDek: "s" }]);
  assert.equal(pinned.record.cid, "CID1");
});
