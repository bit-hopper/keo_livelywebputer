/**
 * core/servers/identity/CredentialVault.js
 *
 * The one place the server seals and opens a linked-account credential (today: the
 * access token for a game-store account). Pure: no database, no Express, no I/O beyond
 * reading environment variables, so it is unit-tested on its own
 * (tests/server/credential-vault.test.js).
 *
 * Why it exists: unlike everything else an account owns, a linked-account token has to
 * be usable BY THE SERVER (it calls the provider on the user's behalf when they press
 * Sync), so it cannot be end-to-end encrypted to the user. The next best thing is that
 * the database alone is not enough to read it: each row is AES-256-GCM sealed under a
 * key that lives only in the process environment, never in the repository, a
 * core/apis/*.json file, or the database.
 *
 * Call shape:
 *   var vault = require('./CredentialVault');
 *   if (!vault.isConfigured()) { ... answer 503 "not configured" ... }
 *   var sealed = vault.seal(plaintextToken, { did, platform, externalId });
 *       -> { ct: Buffer, nonce: Buffer, keyVersion: Number }   // store all three
 *   var token  = vault.open(sealed, { did, platform, externalId });
 *       -> the plaintext string; THROWS a VaultError if the row was moved, edited, or
 *          sealed under a key this process does not have
 *   vault.needsReseal(sealed) -> true when the row was sealed under an older key version
 *       (re-seal it on the next write so old keys can eventually be retired)
 *
 * Configuration (environment):
 *   LINKED_ACCOUNTS_KEYS         JSON object  {"1":"<base64 of 32 bytes>","2":"..."}
 *   LINKED_ACCOUNTS_KEY_CURRENT  the version used for NEW seals, e.g. "2"
 * Old versions stay in LINKED_ACCOUNTS_KEYS so rows sealed under them still open.
 * A missing or malformed setting makes the vault "unconfigured": isConfigured() is
 * false and seal()/open() throw a VaultError with code 'UNCONFIGURED'. There is NO
 * plaintext fallback, on purpose.
 *
 * Binding: the additional authenticated data (AAD) is `did|platform|externalId`, so a
 * ciphertext copied onto another row or another account fails to open. Do not pass
 * anything else as context, and do not build the AAD anywhere else; both ends go
 * through this file so they cannot drift apart.
 *
 * What NOT to do: never log a plaintext token, the key material, or an Authorization
 * header built from one; never put a VaultError's `cause` into a response body (it is
 * kept off the error's message deliberately); never store the plaintext "for later".
 */

'use strict';

var crypto = require('crypto');

var KEY_BYTES = 32;      // AES-256
var NONCE_BYTES = 12;    // the size GCM is designed around
var TAG_BYTES = 16;

// An error that is safe to log and to branch on. `code` is one of:
//   UNCONFIGURED  no usable key set (isConfigured() is false)
//   BAD_KEY       a key in the environment is the wrong length / not base64
//   UNKNOWN_KEY   the row was sealed under a key version this process does not have
//   BAD_INPUT     missing context, empty plaintext, or a malformed sealed record
//   DECRYPT       authentication failed: tampered, moved to another row, or wrong key
function VaultError(code, message) {
  var e = new Error(message);
  e.name = 'VaultError';
  e.code = code;
  return e;
}

// Parses the environment into { keys: {version: Buffer}, current: Number } or
// { error: VaultError }. Re-read on every call so a test (or an operator changing the
// process environment before restart) never sees a stale cache; the parse is cheap.
function _load(env) {
  env = env || process.env;
  var rawKeys = env.LINKED_ACCOUNTS_KEYS;
  var rawCurrent = env.LINKED_ACCOUNTS_KEY_CURRENT;
  if (!rawKeys || !rawCurrent) return { error: VaultError('UNCONFIGURED', 'linked-account credential vault is not configured') };
  var parsed;
  try { parsed = JSON.parse(rawKeys); } catch (e) { return { error: VaultError('BAD_KEY', 'LINKED_ACCOUNTS_KEYS is not valid JSON') }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: VaultError('BAD_KEY', 'LINKED_ACCOUNTS_KEYS must be a JSON object of version -> base64 key') };
  }
  var keys = {};
  var versions = Object.keys(parsed);
  for (var i = 0; i < versions.length; i++) {
    var v = versions[i];
    if (!/^[1-9][0-9]{0,8}$/.test(v)) return { error: VaultError('BAD_KEY', 'key versions must be positive integers') };
    var b64 = parsed[v];
    // Buffer.from(..., 'base64') silently drops bad characters, so check the shape
    // ourselves: standard or url-safe base64, nothing else.
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) {
      return { error: VaultError('BAD_KEY', 'key ' + v + ' is not base64') };
    }
    var buf = Buffer.from(b64, 'base64');
    if (buf.length !== KEY_BYTES) return { error: VaultError('BAD_KEY', 'key ' + v + ' must decode to exactly ' + KEY_BYTES + ' bytes') };
    keys[v] = buf;
  }
  if (!/^[1-9][0-9]{0,8}$/.test(String(rawCurrent)) || !keys[String(rawCurrent)]) {
    return { error: VaultError('BAD_KEY', 'LINKED_ACCOUNTS_KEY_CURRENT does not name a key in LINKED_ACCOUNTS_KEYS') };
  }
  return { keys: keys, current: Number(rawCurrent) };
}

// True when a usable key set is present. The link routes call this first and answer
// 503 when it is false; the Settings tab shows the provider as unavailable.
function isConfigured(env) {
  return !_load(env).error;
}

// The additional authenticated data for a row. All three parts are required: a blank
// part would let two different rows share an AAD.
function _aad(ctx) {
  if (!ctx || !ctx.did || !ctx.platform || !ctx.externalId) {
    throw VaultError('BAD_INPUT', 'did, platform and externalId are all required');
  }
  var parts = [String(ctx.did), String(ctx.platform), String(ctx.externalId)];
  // The separator must not appear inside a part, or ("a|b","c") and ("a","b|c") would
  // collide. DIDs contain ":" but never "|".
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].indexOf('|') !== -1) throw VaultError('BAD_INPUT', 'context parts must not contain "|"');
  }
  return Buffer.from(parts.join('|'), 'utf8');
}

// Seals `plaintext` for the row identified by `ctx`. `env` is for tests only.
function seal(plaintext, ctx, env) {
  var loaded = _load(env);
  if (loaded.error) throw loaded.error;
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw VaultError('BAD_INPUT', 'nothing to seal');
  var aad = _aad(ctx);
  var nonce = crypto.randomBytes(NONCE_BYTES);
  var cipher = crypto.createCipheriv('aes-256-gcm', loaded.keys[String(loaded.current)], nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  var body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  // The GCM tag rides at the end of `ct`, so the table needs one column for it, not two.
  return { ct: Buffer.concat([body, cipher.getAuthTag()]), nonce: nonce, keyVersion: loaded.current };
}

// Opens a record produced by seal(). Throws VaultError; the message never contains
// plaintext, key bytes or the underlying library's text.
function open(sealed, ctx, env) {
  var loaded = _load(env);
  if (loaded.error) throw loaded.error;
  if (!sealed || !Buffer.isBuffer(sealed.ct) || !Buffer.isBuffer(sealed.nonce) ||
      sealed.nonce.length !== NONCE_BYTES || sealed.ct.length <= TAG_BYTES) {
    throw VaultError('BAD_INPUT', 'malformed sealed credential');
  }
  var key = loaded.keys[String(sealed.keyVersion)];
  if (!key) throw VaultError('UNKNOWN_KEY', 'credential was sealed under key version ' + sealed.keyVersion + ', which is not configured');
  var aad = _aad(ctx);
  var tag = sealed.ct.slice(sealed.ct.length - TAG_BYTES);
  var body = sealed.ct.slice(0, sealed.ct.length - TAG_BYTES);
  try {
    var decipher = crypto.createDecipheriv('aes-256-gcm', key, sealed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch (e) {
    throw VaultError('DECRYPT', 'credential could not be opened (tampered, moved, or wrong key)');
  }
}

// True when `sealed` was made under a version other than the current one.
function needsReseal(sealed, env) {
  var loaded = _load(env);
  if (loaded.error) return false;
  return !!sealed && Number(sealed.keyVersion) !== loaded.current;
}

module.exports = {
  VaultError: VaultError,
  isConfigured: isConfigured,
  seal: seal,
  open: open,
  needsReseal: needsReseal,
  KEY_BYTES: KEY_BYTES,
  NONCE_BYTES: NONCE_BYTES,
};
