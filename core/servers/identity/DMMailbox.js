/**
 * core/servers/identity/DMMailbox.js
 *
 * Postgres-backed store-and-forward mailbox for P2P E2EE direct messages
 * (see p2pchat.md at the repo root — the design doc this implements).
 * A row here is a transient delivery, not a permanent record: the
 * recipient deletes it once they've decrypted it and saved it into their
 * own local IndexedDB (p2pchat.md §7) — this table should stay small and
 * roughly empty in steady state, unlike `objects` (worlds/postcards/parts),
 * which persists every version forever by design.
 *
 * Deliberately NOT modeled as a postcard/object envelope (no objId/cid/
 * prevCid chain) — same reasoning FriendRegistry.js's own header comment
 * gives for friend requests: a chat message isn't a signed, versioned
 * object a user owns and can revisit later, it's a one-shot delivery.
 * Mirrors FriendRegistry.js's schema/idiom exactly (same shared
 * postgres-client.js pool, one-shot-bootstrapped DDL) rather than the
 * older file-based `identity/inbox/<handle>.jsonl` pattern
 * ObjectRepository.js uses for postcard delivery notices — that pattern
 * is an append-only log with no real per-row delete story, which this
 * table needs (a recipient acks by deleting their own row by msg_id).
 *
 * Schema (Postgres, via DATABASE_URL — see ../support/postgres-client.js):
 *
 *   dm_mailbox table — one row per undelivered (not yet ack'd) message.
 *     msg_id             TEXT PRIMARY KEY  -- client-generated, dedupe key
 *     thread_id          TEXT NOT NULL     -- "dm:" + sorted [didA, didB]
 *     sender_did         TEXT NOT NULL
 *     recipient_did      TEXT NOT NULL
 *     sender_device_pub  TEXT NOT NULL     -- which device X25519 key sealed this (Encryption.md §9)
 *     ciphertext         TEXT NOT NULL     -- base64url crypto_box_seal output (Crypto.js#sealForRecipient)
 *     sig                TEXT NOT NULL     -- JWS over {msgId,threadId,senderDid,recipientDid,ciphertext,sentAt}
 *     sent_at            TEXT NOT NULL
 *
 * No `nonce` column — crypto_box_seal (an anonymous libsodium sealed box,
 * confirmed by reading Crypto.js's sealForRecipient/openSealedBox) bakes
 * its own ephemeral keypair/nonce into the ciphertext; unlike the
 * secretbox-based DEK-wrapping scheme elsewhere in this codebase, there's
 * no separate nonce to carry alongside it.
 */

'use strict';

var postgresClient = require('../support/postgres-client');

var DDL =
  'CREATE TABLE IF NOT EXISTS dm_mailbox (' +
  '  msg_id             TEXT PRIMARY KEY,' +
  '  thread_id          TEXT NOT NULL,' +
  '  sender_did         TEXT NOT NULL,' +
  '  recipient_did      TEXT NOT NULL,' +
  '  sender_device_pub  TEXT NOT NULL,' +
  '  ciphertext         TEXT NOT NULL,' +
  '  sig                TEXT NOT NULL,' +
  '  sent_at            TEXT NOT NULL' +
  ');\n' +
  'CREATE INDEX IF NOT EXISTS dm_mailbox_recipient_idx ON dm_mailbox (recipient_did);';

var _bootstrapped = false;

// Returns the shared pg.Pool, bootstrapping the schema exactly once per
// process first — same idiom as FriendRegistry.js/ObjectRepository.js.
function withDB(thenDo) {
  var pool = postgresClient.getPool();
  if (_bootstrapped) return thenDo(null, pool);
  pool.query(DDL, function (err) {
    if (err) return thenDo(err);
    _bootstrapped = true;
    thenDo(null, pool);
  });
}

// row: {msgId, threadId, senderDid, recipientDid, senderDevicePub, ciphertext, sig, sentAt}
// Idempotent on msgId (a client retry after a dropped response re-sends
// the identical row rather than double-delivering). Calls thenDo(err).
function putMessage(row, thenDo) {
  withDB(function (err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'INSERT INTO dm_mailbox' +
      ' (msg_id, thread_id, sender_did, recipient_did, sender_device_pub, ciphertext, sig, sent_at)' +
      ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8)' +
      ' ON CONFLICT (msg_id) DO NOTHING',
      [row.msgId, row.threadId, row.senderDid, row.recipientDid,
       row.senderDevicePub, row.ciphertext, row.sig, row.sentAt],
      function (err) { thenDo(err || null); }
    );
  });
}

// Calls thenDo(null, [{msgId,threadId,senderDid,recipientDid,senderDevicePub,ciphertext,sig,sentAt}, ...]), oldest first.
function listForRecipient(recipientDid, thenDo) {
  withDB(function (err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'SELECT msg_id, thread_id, sender_did, recipient_did, sender_device_pub, ciphertext, sig, sent_at' +
      ' FROM dm_mailbox WHERE recipient_did = $1 ORDER BY sent_at ASC',
      [recipientDid],
      function (err, result) {
        if (err) return thenDo(err);
        thenDo(null, (result.rows || []).map(function (r) {
          return {
            msgId: r.msg_id, threadId: r.thread_id, senderDid: r.sender_did,
            recipientDid: r.recipient_did, senderDevicePub: r.sender_device_pub,
            ciphertext: r.ciphertext, sig: r.sig, sentAt: r.sent_at,
          };
        }));
      }
    );
  });
}

// Deletes a message only if ownerDid is its recipient — an ack must come
// from the actual recipient, never an arbitrary caller (in particular,
// not the sender — a sender has no business deleting a message out of
// someone else's mailbox before they've read it).
// Calls thenDo(err, deleted:boolean).
function deleteMessage(msgId, ownerDid, thenDo) {
  withDB(function (err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'DELETE FROM dm_mailbox WHERE msg_id = $1 AND recipient_did = $2',
      [msgId, ownerDid],
      function (err, result) {
        if (err) return thenDo(err);
        thenDo(null, result.rowCount > 0);
      }
    );
  });
}

module.exports = {
  withDB: withDB,
  putMessage: putMessage,
  listForRecipient: listForRecipient,
  deleteMessage: deleteMessage,
};
