/**
 * core/servers/identity/AccountDeletion.js
 *
 * Permanently deletes an account (settings.md §5). Lives apart from the HTTP
 * route so it can be exercised directly. What "the account's data" is comes
 * from AccountData.js (the one shared list); this file only decides the order
 * and the transaction around it.
 *
 * One Postgres transaction:
 *   1. lock on the DID (two concurrent deletes of one account serialise)
 *   2. refuse if the account created a constellation (§4.1 — err.code
 *      'BLOCKED', err.constellations = names) or no longer exists
 *      (err.code 'NOT_FOUND' — a second delete of the same account)
 *   3. capture the obj_ids, blob cids, handles and constellation roles —
 *      none of them can be re-derived once the rows are gone
 *   4. reserve every handle the account held (§4.4)
 *   5. delete rows hanging off the account's objects, then the objects, then
 *      every DID-keyed row; rewrite the constellations' member/controller/bot
 *      arrays; null/sentinel the columns that must survive (see AccountData)
 *   6. re-count everything in step 5 inside the same transaction and ROLLBACK
 *      if any of it is still there (err.code 'VERIFY_FAILED', err.remaining)
 *   7. COMMIT
 * Then, best-effort (failures are logged and reported, never fatal — the
 * account is already gone): delete blob bytes no other object still
 * references, remove the account's directories/files, and flag e2ee rooms of
 * its former constellations for key rotation.
 *
 * Live presence (RoomPresence) is not touched: entries are timestamped and
 * swept, so a deleted account falls out of a roster on its own.
 */

'use strict';

var fs = require('fs');
var handleRegistry = require('./HandleRegistry');
var linkedAccounts = require('./LinkedAccounts');
var AccountData = require('./AccountData');

function _fail(code, message, extra) {
  var err = new Error(message);
  err.code = code;
  if (extra) Object.keys(extra).forEach(function (k) { err[k] = extra[k]; });
  return err;
}

function _quote(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('AccountDeletion: unsafe identifier ' + name);
  return '"' + name + '"';
}

// opts: { did, handle, blobStore, constellationRegistry }
// Calls thenDo(err, report). On success report is
//   { handles, objects, versions, blobsDeleted, blobsKept, filesRemoved,
//     constellationsLeft, rotationsFlagged, warnings: [string] }
function deleteAccount(opts, thenDo) {
  var did = opts.did;
  var handle = opts.handle;
  if (!did || !handle) return thenDo(_fail('BAD_REQUEST', 'deleteAccount: did and handle are required'));

  // Make sure reserved_handles (created by HandleRegistry's own bootstrap) exists
  // before the transaction starts using it.
  // Same for linked_accounts, which AccountData.DID_REFS lists and which is created by
  // its own module's bootstrap.
  handleRegistry.withDB(function (err, pool) {
    if (err) return thenDo(err);
    linkedAccounts.withDB(function (err) {
    if (err) return thenDo(err);
    pool.connect(function (err, client, release) {
      if (err) return thenDo(err);

      var done = false;
      function abort(e) {
        if (done) return;
        done = true;
        client.query('ROLLBACK', function () { release(); thenDo(e); });
      }

      var ctx = { objIds: [], cids: [], handles: [], roles: [], versions: 0 };

      client.query('BEGIN', function (err) {
        if (err) { done = true; release(); return thenDo(err); }

        // 1. serialise concurrent deletes of this account
        client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['account.delete:' + did], function (err) {
          if (err) return abort(err);

          // 2a. does the account still exist?
          client.query('SELECT 1 FROM credentials WHERE did = $1 UNION ALL SELECT 1 FROM handles WHERE did = $1', [did], function (err, r) {
            if (err) return abort(err);
            if (!r.rows.length) return abort(_fail('NOT_FOUND', 'No such account'));

            // 2b. constellations it created block deletion
            AccountData.blockers(client, did, function (err, blocking) {
              if (err) return abort(err);
              if (blocking.length) {
                return abort(_fail('BLOCKED',
                  'This account created ' + blocking.length + ' constellation' + (blocking.length === 1 ? '' : 's') +
                  ' and cannot be deleted while it exists',
                  { constellations: blocking.map(function (b) { return b.name; }) }));
              }

              // 3. capture what can't be re-derived afterwards
              AccountData.objectIds(client, did, function (err, objIds) {
                if (err) return abort(err);
                ctx.objIds = objIds;
                client.query('SELECT count(*)::int AS n FROM objects WHERE did = $1', [did], function (err, r) {
                  if (err) return abort(err);
                  ctx.versions = r.rows[0].n;
                  // every blob any version references, not just the current tips
                  AccountData.blobCids(client, did, function (err, cids) {
                    if (err) return abort(err);
                    ctx.cids = cids;
                    AccountData.handlesFor(client, did, function (err, handles) {
                      if (err) return abort(err);
                      ctx.handles = handles.map(function (h) { return h.handle; });
                      // the handle the session carries, even if its row is somehow gone
                      if (ctx.handles.indexOf(handle) === -1) ctx.handles.push(handle);
                      AccountData.constellationRoles(client, did, function (err, roles) {
                        if (err) return abort(err);
                        ctx.roles = roles;
                        reserveHandles();
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });

      // 4.
      function reserveHandles() {
        var now = new Date().toISOString();
        AccountData.series(ctx.handles, function (h, next) {
          client.query(
            'INSERT INTO reserved_handles (handle, reason, created_at) VALUES ($1, $2, $3) ON CONFLICT (handle) DO NOTHING',
            [h, 'account-deleted', now],
            function (err) { next(err || null); }
          );
        }, function (err) {
          if (err) return abort(err);
          deleteRows();
        });
      }

      // 5.
      function deleteRows() {
        var jobs = [];
        if (ctx.objIds.length) {
          AccountData.OBJECT_REFS.forEach(function (ref) {
            jobs.push({ sql: 'DELETE FROM ' + _quote(ref.table) + ' WHERE ' + _quote(ref.column) + ' = ANY($1::text[])', params: [ctx.objIds] });
          });
        }
        AccountData.DID_REFS.forEach(function (ref) {
          var t = _quote(ref.table), c = _quote(ref.column);
          if (ref.mode === 'delete') jobs.push({ sql: 'DELETE FROM ' + t + ' WHERE ' + c + ' = $1', params: [did] });
          else if (ref.mode === 'nullify') jobs.push({ sql: 'UPDATE ' + t + ' SET ' + c + ' = NULL WHERE ' + c + ' = $1', params: [did] });
          else if (ref.mode === 'sentinel') jobs.push({ sql: 'UPDATE ' + t + ' SET ' + c + ' = $2 WHERE ' + c + ' = $1', params: [did, AccountData.ANON_DID] });
          // 'blocker' rows were refused above; nothing to do, verify catches any that remain
        });

        AccountData.series(jobs, function (job, next) {
          client.query(job.sql, job.params, function (err) { next(err || null); });
        }, function (err) {
          if (err) return abort(err);
          rewriteArrays();
        });
      }

      function rewriteArrays() {
        var needle = AccountData.jsonNeedle(did);
        client.query(
          'SELECT name, members, controllers, bots FROM constellations' +
          ' WHERE strpos(members, $1) > 0 OR strpos(controllers, $1) > 0 OR strpos(bots, $1) > 0 FOR UPDATE',
          [needle],
          function (err, r) {
            if (err) return abort(err);
            AccountData.series(r.rows, function (row, next) {
              var out = {};
              try {
                ['members', 'controllers', 'bots'].forEach(function (col) {
                  out[col] = JSON.stringify(JSON.parse(row[col] || '[]').filter(function (d) { return d !== did; }));
                });
              } catch (e) {
                return next(new Error('AccountDeletion: corrupt member list in constellation ' + row.name));
              }
              client.query(
                'UPDATE constellations SET members = $1, controllers = $2, bots = $3 WHERE name = $4',
                [out.members, out.controllers, out.bots, row.name],
                function (err) { next(err || null); }
              );
            }, function (err) {
              if (err) return abort(err);
              verify();
            });
          }
        );
      }

      // 6.
      function verify() {
        AccountData.countRemaining(client, did, ctx.objIds, function (err, left) {
          if (err) return abort(err);
          if (Object.keys(left).length) {
            return abort(_fail('VERIFY_FAILED', 'Account data still present after deletion; rolled back', { remaining: left }));
          }
          // 7.
          client.query('COMMIT', function (err) {
            if (err) return abort(err);
            done = true;
            release();
            afterCommit();
          });
        });
      }

      // After the commit: best-effort, never fails the deletion.
      function afterCommit() {
        var report = {
          handles: ctx.handles.slice(),
          objects: ctx.objIds.length,
          versions: ctx.versions,
          blobsDeleted: 0,
          blobsKept: 0,
          filesRemoved: 0,
          constellationsLeft: ctx.roles.map(function (r) { return r.name; }),
          rotationsFlagged: 0,
          warnings: [],
        };
        function warn(msg) { report.warnings.push(msg); console.warn('[AccountDeletion] ' + msg); }

        // Blobs: only bytes no remaining object references (cids are shared by content).
        AccountData.series(ctx.cids, function (cid, next) {
          pool.query('SELECT 1 FROM blob_refs WHERE blob_cid = $1 LIMIT 1', [cid], function (err, r) {
            if (err) { warn('blob ref check failed for ' + cid + ': ' + err.message); return next(null); }
            if (r.rows.length) { report.blobsKept++; return next(null); }
            if (!opts.blobStore) return next(null);
            opts.blobStore.delete(cid, function (err) {
              if (err) warn('blob delete failed for ' + cid + ': ' + err.message);
              else report.blobsDeleted++;
              next(null);
            });
          });
        }, function () {
          // Files on disk, for every handle the account held.
          var paths = [];
          ctx.handles.forEach(function (h) {
            AccountData.fileLocations(h).forEach(function (loc) { if (loc.path) paths.push(loc.path); });
          });
          AccountData.series(paths, function (p, next) {
            fs.stat(p, function (err) {
              if (err) return next(null); // nothing there
              fs.rm(p, { recursive: true, force: true }, function (err) {
                if (err) warn('could not remove ' + p + ': ' + err.message);
                else report.filesRemoved++;
                next(null);
              });
            });
          }, function () {
            // The departed account still holds the old e2ee room keys: flag rotation.
            var reg = opts.constellationRegistry;
            if (!reg) return thenDo(null, report);
            AccountData.series(ctx.roles.filter(function (r) { return r.member; }), function (r, next) {
              reg.markRoomsRotationPending(r.name, did, function (err) {
                if (err) warn('could not flag room key rotation in ' + r.name + ': ' + err.message);
                else report.rotationsFlagged++;
                next(null);
              });
            }, function () { thenDo(null, report); });
          });
        });
      }
    });
    });
  });
}

module.exports = { deleteAccount: deleteAccount };
