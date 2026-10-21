/**
 * core/servers/identity/AccountData.js
 *
 * The single definition of "what an account is" on the server (settings.md §3,
 * with the 2026-10-14 corrections). Account deletion, the .keo export and the
 * post-delete verification all read this one list, so they cannot disagree
 * about what counts as the account's data.
 *
 * Three kinds of database reference, each a table below:
 *   DID_REFS     — a column holding the account's DID (including both sides of
 *                  the two-DID tables)
 *   OBJECT_REFS  — a column holding the obj_id of one of the account's own
 *                  objects (other people's comments/reactions/stars on them,
 *                  blob_refs, ...). These have no DID column for the account.
 *   JSON_ARRAYS  — constellations.members/controllers/bots, text columns that
 *                  hold a JSON array of DIDs: rewritten, never row-deleted.
 * plus the on-disk files (fileLocations).
 *
 * `mode` on a DID_REFS entry is what deletion does with the matching rows:
 *   'delete'    — remove the row
 *   'nullify'   — set the column NULL (instances.added_by; the row isn't theirs)
 *   'sentinel'  — set the column to ANON_DID (NOT NULL "created_by" columns on
 *                 things other people keep using: rooms, events)
 *   'blocker'   — never touched by deletion: its presence blocks deletion
 *                 (constellations.created_by — settings.md §4.1)
 *
 * Every function that reads the database takes `db`, which is a pg Pool or a
 * pg Client (inside a transaction) — both expose query(sql, params, cb).
 */

'use strict';

var path = require('path');
var fs = require('fs');
var objectRepo = require('./ObjectRepository');

var ANON_DID = 'deleted';

var DID_REFS = [
  { table: 'objects',                 column: 'did',            mode: 'delete' },
  { table: 'credentials',             column: 'did',            mode: 'delete' },
  { table: 'did_documents',           column: 'did',            mode: 'delete' },
  { table: 'handles',                 column: 'did',            mode: 'delete' },
  { table: 'domains',                 column: 'did',            mode: 'delete' },
  { table: 'part_aliases',            column: 'did',            mode: 'delete' },
  { table: 'user_status',             column: 'did',            mode: 'delete' },
  { table: 'item_comments',           column: 'did',            mode: 'delete' },
  { table: 'item_stars',              column: 'did',            mode: 'delete' },
  { table: 'postcard_reactions',      column: 'did',            mode: 'delete' },
  { table: 'postcard_collections',    column: 'did',            mode: 'delete' },
  { table: 'postcard_mailbox_hidden', column: 'did',            mode: 'delete' },
  { table: 'inbox_thread_state',      column: 'did',            mode: 'delete' },
  { table: 'event_rsvps',             column: 'did',            mode: 'delete' },
  { table: 'join_requests',           column: 'did',            mode: 'delete' },
  { table: 'room_join_requests',      column: 'did',            mode: 'delete' },
  { table: 'constellation_invites',   column: 'did',            mode: 'delete' },
  { table: 'constellation_invites',   column: 'invited_by',     mode: 'delete' },
  { table: 'friendships',             column: 'did_a',          mode: 'delete' },
  { table: 'friendships',             column: 'did_b',          mode: 'delete' },
  { table: 'friend_requests',         column: 'requester_did',  mode: 'delete' },
  { table: 'friend_requests',         column: 'target_did',     mode: 'delete' },
  { table: 'dm_mailbox',              column: 'sender_did',     mode: 'delete' },
  { table: 'dm_mailbox',              column: 'recipient_did',  mode: 'delete' },
  // omitColumns: left out of the .keo export. The sealed provider credential is not the
  // user's to carry away (it only opens with the server's key) and must not travel.
  { table: 'linked_accounts',         column: 'did',            mode: 'delete',
    omitColumns: ['credential_ct', 'credential_nonce', 'key_version'] },
  { table: 'instances',              column: 'added_by',       mode: 'nullify' },
  { table: 'rooms',                   column: 'created_by',     mode: 'sentinel' },
  { table: 'constellation_events',    column: 'created_by',     mode: 'sentinel' },
  { table: 'constellations',          column: 'created_by',     mode: 'blocker' },
];

// Rows that hang off the account's own objects. `objectId` is the column
// holding an obj_id. Deleted with the objects themselves.
var OBJECT_REFS = [
  { table: 'blob_refs',               column: 'obj_id' },
  { table: 'postcard_reactions',      column: 'obj_id' },
  { table: 'postcard_mailbox_hidden', column: 'obj_id' },
  { table: 'postcard_collections',    column: 'obj_id' },
  { table: 'item_stars',              column: 'obj_id' },
  { table: 'item_comments',           column: 'obj_id' },
  { table: 'part_aliases',            column: 'obj_id' },
  { table: 'inbox_thread_state',      column: 'root_obj_id' },
  { table: 'constellation_invites',   column: 'obj_id' },
];

var JSON_ARRAYS = [
  { table: 'constellations', column: 'members' },
  { table: 'constellations', column: 'controllers' },
  { table: 'constellations', column: 'bots' },
];

// Handles are validated before ever being joined onto a path. Registered
// handles are ^[a-z0-9_]{1,32}$; alias handles are server-generated and
// slightly looser, so this accepts the union and still forbids separators.
var HANDLE_RE = /^[a-z0-9_.-]{1,64}$/;

// ─── small helpers ────────────────────────────────────────────────────────────

// Runs step(item, cb) over items one at a time, then thenDo(err). Loop-based,
// not recursive: a step that calls back synchronously (common for in-memory
// work) must not add a stack frame per item, or a few thousand rows overflow
// the stack.
function series(items, step, thenDo) {
  var i = 0, done = false;
  function loop() {
    while (!done) {
      if (i >= items.length) { done = true; return thenDo(null); }
      var item = items[i++];
      var sync = true, again = false;
      step(item, function (err) {
        if (done) return;
        if (err) { done = true; return thenDo(err); }
        if (sync) again = true; else loop();
      });
      sync = false;
      if (!again) return;
    }
  }
  loop();
}

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('AccountData: unsafe identifier ' + name);
  return '"' + name + '"';
}

// "did" as it appears inside a stored JSON array of DIDs.
function jsonNeedle(did) {
  return JSON.stringify(did);
}

// ─── queries ──────────────────────────────────────────────────────────────────

// Every obj_id the account owns (all types, including 'recovery', which
// ObjectRepository.listForUser deliberately hides). Calls thenDo(err, string[]).
function objectIds(db, did, thenDo) {
  db.query('SELECT DISTINCT obj_id FROM objects WHERE did = $1', [did], function (err, result) {
    if (err) return thenDo(err);
    thenDo(null, result.rows.map(function (r) { return r.obj_id; }));
  });
}

// Every handle row of the account — its primary handle, forwarding aliases,
// and any rows that were ever revoked. Calls thenDo(err, [{handle, isAlias}]).
function handlesFor(db, did, thenDo) {
  db.query('SELECT handle, is_alias FROM handles WHERE did = $1 ORDER BY is_alias, handle', [did], function (err, result) {
    if (err) return thenDo(err);
    thenDo(null, result.rows.map(function (r) { return { handle: r.handle, isAlias: !!r.is_alias }; }));
  });
}

// The constellations that block deletion (settings.md §4.1): ones the account
// created. Calls thenDo(err, [{name}]).
function blockers(db, did, thenDo) {
  db.query('SELECT name FROM constellations WHERE created_by = $1 ORDER BY name', [did], function (err, result) {
    if (err) return thenDo(err);
    thenDo(null, result.rows.map(function (r) { return { name: r.name }; }));
  });
}

// Every blob cid the account's objects reference, across ALL versions: the
// union of blob_refs (which only indexes each object's current tip) and what
// every stored version's envelope names (ObjectRepository.blobCidsOf — the one
// definition of which envelope types carry blobs). A blob only an older
// version points at has no blob_refs row but is still the account's data, so
// export and deletion both need it. Scans objects in pages of 100 by id to
// bound memory. Calls thenDo(err, string[]).
function blobCids(db, did, thenDo) {
  var cids = {};
  db.query(
    'SELECT DISTINCT blob_cid FROM blob_refs WHERE obj_id IN (SELECT obj_id FROM objects WHERE did = $1)',
    [did],
    function (err, r) {
      if (err) return thenDo(err);
      r.rows.forEach(function (x) { cids[x.blob_cid] = true; });
      (function page(afterId) {
        db.query(
          'SELECT id, envelope FROM objects WHERE did = $1 AND id > $2 ORDER BY id LIMIT 100',
          [did, afterId],
          function (err, r) {
            if (err) return thenDo(err);
            if (!r.rows.length) return thenDo(null, Object.keys(cids).sort());
            r.rows.forEach(function (row) {
              objectRepo.blobCidsOf(row.envelope).forEach(function (c) { if (c) cids[c] = true; });
            });
            page(r.rows[r.rows.length - 1].id);
          }
        );
      })(0);
    }
  );
}

// Constellations whose members/controllers/bots arrays mention the DID.
// Calls thenDo(err, [{name, member, controller, bot}]).
function constellationRoles(db, did, thenDo) {
  var needle = jsonNeedle(did);
  db.query(
    'SELECT name,' +
    '  strpos(members, $1) > 0     AS member,' +
    '  strpos(controllers, $1) > 0 AS controller,' +
    '  strpos(bots, $1) > 0        AS bot' +
    ' FROM constellations' +
    ' WHERE strpos(members, $1) > 0 OR strpos(controllers, $1) > 0 OR strpos(bots, $1) > 0' +
    ' ORDER BY name',
    [needle],
    function (err, result) {
      if (err) return thenDo(err);
      thenDo(null, result.rows.map(function (r) {
        return { name: r.name, member: !!r.member, controller: !!r.controller, bot: !!r.bot };
      }));
    }
  );
}

// Re-counts everything deletion is supposed to have removed or rewritten.
// Returns the non-zero ones, so an empty object means "clean". Run inside the
// deletion transaction with the obj_ids captured BEFORE the objects went
// (they can't be re-derived afterwards). Keys are "table.column".
// Calls thenDo(err, { 'table.column': count, ... }).
function countRemaining(db, did, objIds, thenDo) {
  var left = {};
  var jobs = [];

  DID_REFS.forEach(function (ref) {
    // 'blocker' rows are not something deletion removes; they are refused up
    // front, so any still present at verify time is also a failure.
    jobs.push({
      key: ref.table + '.' + ref.column,
      sql: 'SELECT count(*)::int AS n FROM ' + quoteIdent(ref.table) + ' WHERE ' + quoteIdent(ref.column) + ' = $1',
      params: [did],
    });
  });

  if (objIds.length) {
    OBJECT_REFS.forEach(function (ref) {
      jobs.push({
        key: ref.table + '.' + ref.column,
        sql: 'SELECT count(*)::int AS n FROM ' + quoteIdent(ref.table) + ' WHERE ' + quoteIdent(ref.column) + ' = ANY($1::text[])',
        params: [objIds],
      });
    });
  }

  JSON_ARRAYS.forEach(function (ref) {
    jobs.push({
      key: ref.table + '.' + ref.column + '[]',
      sql: 'SELECT count(*)::int AS n FROM ' + quoteIdent(ref.table) + ' WHERE strpos(' + quoteIdent(ref.column) + ', $1) > 0',
      params: [jsonNeedle(did)],
    });
  });

  series(jobs, function (job, next) {
    db.query(job.sql, job.params, function (err, result) {
      if (err) return next(err);
      var n = result.rows[0].n;
      if (n) left[job.key] = (left[job.key] || 0) + n;
      next(null);
    });
  }, function (err) {
    if (err) return thenDo(err);
    thenDo(null, left);
  });
}

// ─── files on disk ────────────────────────────────────────────────────────────

function _workspace() {
  return process.env.WORKSPACE_LK || process.cwd();
}

// Resolves <base>/<name> and refuses anything that isn't a direct child of
// base. Returns the absolute path, or null.
function _childOf(base, name) {
  if (typeof name !== 'string' || !HANDLE_RE.test(name)) return null;
  var root = path.resolve(base);
  var full = path.resolve(root, name);
  if (path.dirname(full) !== root) return null;
  return full;
}

// Where an account's files live, for one handle. Each entry is
// { kind, path, isDir }. A path is null if the handle fails validation.
function fileLocations(handle) {
  var ws = _workspace();
  return [
    { kind: 'users',      isDir: true,  path: _childOf(path.join(ws, 'users'), handle) },
    { kind: 'uploads',    isDir: true,  path: _childOf(path.join(ws, 'identity', 'uploads'), handle) },
    { kind: 'inbox',      isDir: false, path: _childOf(path.join(ws, 'identity', 'inbox'), handle + '.jsonl') },
    { kind: 'deliveries', isDir: false, path: _childOf(path.join(ws, 'identity', 'deliveries'), handle + '.jsonl') },
  ];
}

// Total size and file count under a file or directory (0/0 if absent).
function _measure(p, thenDo) {
  fs.stat(p, function (err, st) {
    if (err) return thenDo(null, { files: 0, bytes: 0 });
    if (st.isFile()) return thenDo(null, { files: 1, bytes: st.size });
    if (!st.isDirectory()) return thenDo(null, { files: 0, bytes: 0 });
    fs.readdir(p, function (err, names) {
      if (err) return thenDo(null, { files: 0, bytes: 0 });
      var total = { files: 0, bytes: 0 };
      series(names, function (name, next) {
        _measure(path.join(p, name), function (e, m) {
          total.files += m.files;
          total.bytes += m.bytes;
          next(null);
        });
      }, function () { thenDo(null, total); });
    });
  });
}

// ─── summary (GET /@:handle/account/summary, and the delete-flow screen) ─────

// What the account holds, for the confirmation screen. `blobBytes` is only
// measured when a blobStore with stat() is passed. Calls thenDo(err, summary).
function summary(db, did, handle, opts, thenDo) {
  opts = opts || {};
  var out = { handle: handle, did: did };
  objectIds(db, did, function (err, objIds) {
    if (err) return thenDo(err);
    out.objects = objIds.length;

    db.query('SELECT count(*)::int AS n FROM objects WHERE did = $1', [did], function (err, r) {
      if (err) return thenDo(err);
      out.versions = r.rows[0].n;

      blobCids(db, did, function (err, cids) {
          if (err) return thenDo(err);
          out.blobs = cids.length;

          constellationRoles(db, did, function (err, roles) {
            if (err) return thenDo(err);
            out.constellations = roles.length;
            blockers(db, did, function (err, blocking) {
              if (err) return thenDo(err);
              out.blockedBy = blocking.map(function (b) { return b.name; });

              db.query(
                'SELECT (SELECT count(*) FROM friendships WHERE did_a = $1 OR did_b = $1)::int AS friends,' +
                '       (SELECT count(*) FROM rooms WHERE created_by = $1)::int AS rooms,' +
                '       (SELECT count(*) FROM constellation_events WHERE created_by = $1)::int AS events,' +
                '       (SELECT count(*) FROM dm_mailbox WHERE sender_did = $1 OR recipient_did = $1)::int AS dms,' +
                '       (SELECT count(*) FROM domains WHERE did = $1)::int AS domains',
                [did],
                function (err, r) {
                  if (err) return thenDo(err);
                  Object.keys(r.rows[0]).forEach(function (k) { out[k] = r.rows[0][k]; });

                  handlesFor(db, did, function (err, handles) {
                    if (err) return thenDo(err);
                    out.handles = handles.map(function (h) { return h.handle; });
                    var files = { files: 0, bytes: 0 };
                    series(handles, function (h, next) {
                      series(fileLocations(h.handle), function (loc, next2) {
                        if (!loc.path) return next2(null);
                        _measure(loc.path, function (e, m) { files.files += m.files; files.bytes += m.bytes; next2(null); });
                      }, next);
                    }, function () {
                      out.files = files.files;
                      out.fileBytes = files.bytes;
                      thenDo(null, out);
                    });
                  });
                }
              );
            });
          });
        }
      );
    });
  });
}

module.exports = {
  ANON_DID: ANON_DID,
  DID_REFS: DID_REFS,
  OBJECT_REFS: OBJECT_REFS,
  JSON_ARRAYS: JSON_ARRAYS,
  HANDLE_RE: HANDLE_RE,
  series: series,
  jsonNeedle: jsonNeedle,
  objectIds: objectIds,
  handlesFor: handlesFor,
  blockers: blockers,
  blobCids: blobCids,
  constellationRoles: constellationRoles,
  countRemaining: countRemaining,
  fileLocations: fileLocations,
  summary: summary,
};
