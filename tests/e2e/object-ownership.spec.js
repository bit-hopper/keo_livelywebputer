// @ts-check
// Who may rewrite a stored object, end to end (Encryption.md §18.2, "cookie-only server surface").
//
// Three questions about PUT /@:handle/:objId and PUT /@:handle/did-document, each asked the way a
// hostile party would:
//
//   1. Can account B, with its OWN valid session and its OWN valid delegation, append a version to
//      an object that account A created? (The route never compares the stored object's owner with
//      the session; only postcards and wiki pages get that check.)
//   2. Can script running in A's page, holding only A's session cookie and no signing key, change
//      what is stored under an unchanged cid by sending a "metadata-only" update? (That path skips
//      the signature check and the cid-versus-payload check, then replaces the whole stored envelope.)
//   3. Can the same cookie-only script remove A's delegation certs from A's DID document, so that
//      every later signed write by A is refused?
//
// Each test asserts the SECURE outcome. A test that fails here means the hole is real; the observed
// status codes and values are attached to the test as annotations either way.
//
// Status 2026-10-16: before the server fix, step 1 got HTTP 200 (steps 2 and 3 had not been run).
// After the fix (core/servers/identity/WritePolicy.js wired into IdentityServer.js, server restarted)
// all three steps pass: 403 NOT_OWNER, 400 IMMUTABLE_FIELD, 403 on the DID document update. This file is
// now the regression test for those rules. Tests run serially, so one failure skips the rest; if you
// want all three to always report, restructure into one test with expect.soft (not done).
//
// Registers throwaway `hometest_*` accounts through the real RegisterDialog ceremony with a CDP virtual
// passkey and removes them through the deletion feature. Needs the dev server at baseURL. Each run leaves
// reserved handles behind; prune with: DELETE FROM reserved_handles WHERE handle LIKE 'hometest\_%';
const { test, expect } = require("@playwright/test");
const { newAccount, deleteAccount } = require("./wikiHelpers");

test.describe.configure({ mode: "serial" });
test.setTimeout(240 * 1000);

/** @type {any} */ let A = null;
/** @type {any} */ let B = null;
/** @type {string} */ let objId = "";

const note = (/** @type {string} */ k, /** @type {any} */ v) =>
  test.info().annotations.push({ type: k, description: typeof v === "string" ? v : JSON.stringify(v) });

// A public file envelope (plaintext payload: name, mime, size, blobCid) is the simplest non-postcard,
// non-wikipage object a signed-in account can create.
async function uploadPublicFile(page, name) {
  return page.evaluate(async (n) => {
    await new Promise((r) => lively.require("lively.identity.FileCrypto").toRun(r));
    const f = new File(["hello " + n], n, { type: "text/plain" });
    return new Promise((res, rej) => lively.identity.fileCrypto.encryptAndUpload(f, { visibility: "public", name: n }, (e, v) => (e ? rej(e) : res(v.objId))));
  }, name);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300 * 1000); // two real registration ceremonies; the file-level timeout does not cover hooks
  const R = Math.random().toString(36).slice(2, 6);
  A = await newAccount(browser, "hometest_oa" + R);
  B = await newAccount(browser, "hometest_ob" + R);
  objId = await uploadPublicFile(A.page, "owned.txt");
});

test.afterAll(async () => {
  test.setTimeout(120 * 1000);
  if (A) await deleteAccount(A);
  if (B) await deleteAccount(B);
  if (A) await A.context.close();
  if (B) await B.context.close();
});

test("another account cannot append a version to an object it does not own", async ({ request }) => {
  const before = await (await request.get("/@" + A.handle + "/" + objId, { headers: { Accept: "application/json" } })).json();
  expect(before.record.payload.name).toBe("owned.txt");

  // B signs a well-formed, chained, correctly hashed envelope with ITS OWN delegation and PUTs it
  // through ITS OWN handle, naming A's objId.
  const res = await B.page.evaluate(async ([hA, id]) => {
    await new Promise((r) => lively.require("lively.identity.EnvelopeSigning").toRun(r));
    const c = lively.identity.crypto, user = lively.identity.did.currentUser();
    const env = await (await fetch("/@" + hA + "/" + id, { headers: { Accept: "application/json" } })).json();
    const payload = Object.assign({}, env.record.payload, { name: "HIJACKED-BY-B.txt" });
    const cid = await new Promise((res, rej) => c.computeCid(payload, (e, v) => (e ? rej(e) : res(v))));
    const forged = Object.assign({}, env, { did: user.did, record: Object.assign({}, env.record, { payload, cid, prevCid: env.record.cid }) });
    delete forged.sig;
    const signed = await new Promise((res, rej) => lively.identity.envelopeSigning.signEnvelopeIfPossible(forged, user, c, (e, v) => (e ? rej(e) : res(v))));
    const r = await fetch("/@" + user.handle + "/" + id, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signed) });
    return { status: r.status, body: await r.json().catch(() => ({})), signed: !!signed.sig };
  }, [A.handle, objId]);
  note("B's PUT", res);
  expect(res.signed).toBe(true); // the attack envelope was genuinely signed, so a refusal must come from an ownership check

  const after = await (await request.get("/@" + A.handle + "/" + objId, { headers: { Accept: "application/json" } })).json();
  note("stored after", { did: after.did, name: after.record.payload.name, cid: after.record.cid });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(after.did).toBe(A.did);
  expect(after.record.payload.name).toBe("owned.txt");
});

test("a cookie-only metadata update cannot change the stored payload under an unchanged cid", async ({ request }) => {
  const res = await A.page.evaluate(async ([hA, id]) => {
    const c = lively.identity.crypto;
    const get = async () => (await fetch("/@" + hA + "/" + id, { headers: { Accept: "application/json" }, credentials: "include" })).json();
    const env = await get();
    const before = { cid: env.record.cid, name: env.record.payload.name };
    // No signing key involved: the old sig is simply carried along, and the payload is edited.
    const forged = JSON.parse(JSON.stringify(env));
    forged.record.payload.name = "SWAPPED-WITHOUT-SIGNING.txt";
    forged.state = Object.assign({}, forged.state, { probe: "meta-" + Date.now() }); // makes metadataChanged true
    const r = await fetch("/@" + hA + "/" + id, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(forged) });
    const putBody = await r.json().catch(() => ({}));
    const after = await get();
    const recomputed = await new Promise((res, rej) => c.computeCid(after.record.payload, (e, v) => (e ? rej(e) : res(v))));
    return { putStatus: r.status, putBody, before, after: { cid: after.record.cid, name: after.record.payload.name }, cidMatchesPayload: recomputed === after.record.cid };
  }, [A.handle, objId]);
  note("cookie-only PUT", res);
  const seen = await (await request.get("/@" + A.handle + "/" + objId, { headers: { Accept: "application/json" } })).json();
  note("anonymous reader now sees", { name: seen.record.payload.name, cid: seen.record.cid });
  // Secure outcomes: refused, or applied without touching the payload. Never a stored payload that no longer hashes to its cid.
  expect(res.after.name).toBe("owned.txt");
  expect(res.cidMatchesPayload).toBe(true);
});

test("a cookie-only DID document update cannot strip the account's delegation certs", async () => {
  const res = await A.page.evaluate(async ([hA]) => {
    const doc = await (await fetch("/@" + hA + "/did-document", { credentials: "include" })).json();
    const stripped = JSON.parse(JSON.stringify(doc));
    let removed = 0;
    (stripped.verificationMethod || []).forEach((m) => { if (m.lively && m.lively.delegationCert) { delete m.lively.delegationCert; removed++; } });
    const put = await fetch("/@" + hA + "/did-document", { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(stripped) });
    const after = await (await fetch("/@" + hA + "/did-document", { credentials: "include" })).json();
    const certsLeft = (after.verificationMethod || []).filter((m) => m.lively && m.lively.delegationCert).length;
    return { removed, putStatus: put.status, certsLeft };
  }, [A.handle]);
  note("did-document PUT", res);
  expect(res.removed).toBeGreaterThan(0); // the account really had a cert to strip
  // Secure outcome: the update is refused, or the certs survive it.
  expect(res.certsLeft).toBeGreaterThan(0);
});
