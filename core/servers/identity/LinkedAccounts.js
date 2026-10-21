/**
 * core/servers/identity/LinkedAccounts.js
 *
 * Postgres-backed table of game-store accounts a user has linked to their DID. Same
 * shape as FriendRegistry.js: the shared postgres-client pool and a one-shot,
 * bootstrapped CREATE TABLE IF NOT EXISTS.
 *
 * What a row holds, and what it must never hold:
 *   - for a provider that signs the user in without issuing a token (steam) the row is
 *     only the public account id; credential_ct is NULL;
 *   - for a provider that issues an access token (itch) the token is stored SEALED by
 *     CredentialVault.js (AES-256-GCM, bound to did|platform|external_id). This module
 *     never sees plaintext: callers pass in the already-sealed { ct, nonce, keyVersion }
 *     and get the same shape back from getLink(). Opening it is the caller's job.
 *   - the library itself (game titles, playtime) is NEVER stored here or anywhere on the
 *     server; sync is a pass-through to the browser.
 *
 * Schema:
 *
 *   linked_accounts table: one row per (did, platform).
 *     did               TEXT NOT NULL
 *     platform          TEXT NOT NULL            -- 'steam' | 'itch' | later 'xbox'
 *     external_id       TEXT NOT NULL            -- the provider's account id
 *     display_name      TEXT
 *     credential_ct     BYTEA                    -- sealed token (+ GCM tag), NULL for steam
 *     credential_nonce  BYTEA
 *     key_version       INTEGER
 *     scopes            TEXT
 *     status            TEXT NOT NULL DEFAULT 'active'   -- active | needs_reconnect | error
 *     linked_at         TEXT NOT NULL            -- ISO time, like friendships.created_at
 *     last_synced_at    TEXT
 *     last_error        TEXT
 *     PRIMARY KEY (did, platform)
 *     UNIQUE (platform, external_id)             -- one external account, one profile
 *
 * The UNIQUE constraint is the anti-hijack rule: a second DID cannot attach an
 * external account that is already linked elsewhere. A violation (Postgres 23505) comes
 * back as an error with code 'ALREADY_LINKED' and a deliberately neutral message that
 * does not say WHICH profile holds it.
 *
 * Account deletion: this table is listed in AccountData.DID_REFS (mode 'delete'), and
 * AccountDeletion / AccountExport call withDB() first so the table exists even on a
 * server that has not served a link request yet. Exports leave the credential columns
 * out (AccountData.DID_REFS entry `omitColumns`).
 */

'use strict';

var postgresClient = require('../support/postgres-client');

var DDL =
  'CREATE TABLE IF NOT EXISTS linked_accounts (' +
  '  did               TEXT NOT NULL,' +
  '  platform          TEXT NOT NULL,' +
  '  external_id       TEXT NOT NULL,' +
  '  display_name      TEXT,' +
  '  credential_ct     BYTEA,' +
  '  credential_nonce  BYTEA,' +
  '  key_version       INTEGER,' +
  '  scopes            TEXT,' +
  '  status            TEXT NOT NULL DEFAULT \'active\',' +
  '  linked_at         TEXT NOT NULL,' +
  '  last_synced_at    TEXT,' +
  '  last_error        TEXT,' +
  '  PRIMARY KEY (did, platform),' +
  '  UNIQUE (platform, external_id)' +
  ');';

var PLATFORMS = ['steam', 'itch'];

var _bootstrapped = false;

// Returns the shared pg.Pool, bootstrapping the table exactly once per process first.
function withDB(thenDo) {
  var pool = postgresClient.getPool();
  if (_bootstrapped) return thenDo(null, pool);
  pool.query(DDL, function (err) {
    if (err) return thenDo(err);
    _bootstrapped = true;
    thenDo(null, pool);
  });
}

function _fail(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

// The row as the browser may see it: never any credential column.
function _publicRow(r) {
  return {
    platform: r.platform,
    external_id: r.external_id,
    display_name: r.display_name,
    status: r.status,
    scopes: r.scopes,
    linked_at: r.linked_at,
    last_synced_at: r.last_synced_at,
    last_error: r.last_error,
  };
}

// Linked accounts for one DID, without credentials. thenDo(err, [row]).
function listForDid(did, thenDo) {
  withDB(function (err, pool) {
    if (err) return thenDo(err);
    pool.query('SELECT * FROM linked_accounts WHERE did = $1 ORDER BY platform', [did], function (err, r) {
      if (err) return thenDo(err);
      thenDo(null, r.rows.map(_publicRow));
    });
  });
}

// One row INCLUDING the sealed credential, for server-side use only (sync, revoke).
// thenDo(err, null | { ...publicRow, sealed: { ct, nonce, keyVersion } | null }).
function getLink(did, platform, thenDo) {
  withDB(function (err, pool) {
    if (err) return thenDo(err);
    pool.query('SELECT * FROM linked_accounts WHERE did = $1 AND platform = $2', [did, platform], function (err, r) {
      if (err) return thenDo(err);
      if (!r.rows.length) return thenDo(null, null);
      var row = r.rows[0];
      var out = _publicRow(row);
      out.sealed = row.credential_ct
        ? { ct: row.credential_ct, nonce: row.credential_nonce, keyVersion: row.key_version }
        : null;
      thenDo(null, out);
    });
  });
}

// Creates or replaces the (did, platform) link. `link` is
//   { externalId, displayName, scopes, sealed: { ct, nonce, keyVersion } | null }
// Re-linking the SAME account refreshes the row (new token, status back to active);
// linking a different account of the same platform replaces it; an external account
// already held by another DID fails with code 'ALREADY_LINKED'. thenDo(err).
function upsertLink(did, platform, link, thenDo) {
  if (PLATFORMS.indexOf(platform) === -1) return thenDo(_fail('BAD_PLATFORM', 'unknown platform'));
  if (!did || !link || !link.externalId) return thenDo(_fail('BAD_INPUT', 'did and externalId are required'));
  var sealed = link.sealed || null;
  withDB(function (err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'INSERT INTO linked_accounts' +
      ' (did, platform, external_id, display_name, credential_ct, credential_nonce, key_version, scopes, status, linked_at)' +
      ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, \'active\', $9)' +
      ' ON CONFLICT (did, platform) DO UPDATE SET' +
      '   external_id = EXCLUDED.external_id, display_name = EXCLUDED.display_name,' +
      '   credential_ct = EXCLUDED.credential_ct, credential_nonce = EXCLUDED.credential_nonce,' +
      '   key_version = EXCLUDED.key_version, scopes = EXCLUDED.scopes,' +
      '   status = \'active\', last_error = NULL,' +
      // a different external account is a new link: its sync history does not carry over
      '   linked_at = CASE WHEN linked_accounts.external_id = EXCLUDED.external_id THEN linked_accounts.linked_at ELSE EXCLUDED.linked_at END,' +
      '   last_synced_at = CASE WHEN linked_accounts.external_id = EXCLUDED.external_id THEN linked_accounts.last_synced_at ELSE NULL END',
      [
        did, platform, String(link.externalId), link.displayName || null,
        sealed ? sealed.ct : null, sealed ? sealed.nonce : null, sealed ? sealed.keyVersion : null,
        link.scopes || null, new Date().toISOString(),
      ],
      function (err) {
        if (err && err.code === '23505') {
          return thenDo(_fail('ALREADY_LINKED', 'That account is already linked to another profile'));
        }
        thenDo(err || null);
      }
    );
  });
}

// Hard delete. thenDo(err, deletedRow|null) where deletedRow is getLink()'s shape, so
// the caller can still revoke the token upstream after the row is gone.
function removeLink(did, platform, thenDo) {
  getLink(did, platform, function (err, row) {
    if (err) return thenDo(err);
    if (!row) return thenDo(null, null);
    withDB(function (err, pool) {
      if (err) return thenDo(err);
      pool.query('DELETE FROM linked_accounts WHERE did = $1 AND platform = $2', [did, platform], function (err) {
        thenDo(err || null, err ? null : row);
      });
    });
  });
}

// Records the outcome of a sync attempt. Never creates a row. thenDo(err, stillLinked).
// `error` null clears last_error and (re)activates the row unless status says otherwise.
function recordSync(did, platform, outcome, thenDo) {
  outcome = outcome || {};
  withDB(function (err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'UPDATE linked_accounts SET last_synced_at = CASE WHEN $3::text IS NULL THEN $4 ELSE last_synced_at END,' +
      ' last_error = $3, status = $5 WHERE did = $1 AND platform = $2',
      [did, platform, outcome.error || null, new Date().toISOString(), outcome.status || 'active'],
      function (err, r) { thenDo(err || null, !err && r.rowCount > 0); }
    );
  });
}

module.exports = {
  PLATFORMS: PLATFORMS,
  withDB: withDB,
  listForDid: listForDid,
  getLink: getLink,
  upsertLink: upsertLink,
  removeLink: removeLink,
  recordSync: recordSync,
};
