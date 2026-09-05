// One-off data migration: copies a SQLite identity/objects.db file's
// contents into the Postgres schema core/servers/identity/ObjectRepository.js
// now uses. Reads the SQLite file directly (via sqlite3, not through
// ObjectRepository.js -- that module no longer has a SQLite code path at
// all after the migration) and writes through the shared postgres-client.js
// pool, same connection-setup idiom every other Postgres-backed module uses.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrate-objects-to-postgres.js <path-to-sqlite-copy> [--force]
//
// SAFETY: this pass is scoped to local/dev verification only -- run it
// against a COPY of a real objects.db (never the live file a running server
// still has open), and only against a scratch Postgres. Refuses to run
// unless DATABASE_URL points at localhost/127.0.0.1, unless --force is
// passed. Truncates the target tables first (gated behind the same guard)
// so re-running during development is safe/idempotent.

'use strict';

var sqlite3 = require('sqlite3').verbose();
var postgresClient = require('../core/servers/support/postgres-client');

var args = process.argv.slice(2);
var force = args.indexOf('--force') !== -1;
var sqlitePath = args.filter(function (a) { return a !== '--force'; })[0];

if (!sqlitePath) {
  console.error('Usage: DATABASE_URL=postgres://... node scripts/migrate-objects-to-postgres.js <path-to-sqlite-copy> [--force]');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

var dbUrlHost = null;
try { dbUrlHost = new URL(process.env.DATABASE_URL).hostname; } catch (e) {
  console.error('DATABASE_URL is not a valid URL:', e.message);
  process.exit(1);
}
if (dbUrlHost !== 'localhost' && dbUrlHost !== '127.0.0.1' && !force) {
  console.error(
    'Refusing to run: DATABASE_URL host is "' + dbUrlHost + '", not localhost/127.0.0.1. ' +
    'This script truncates its target tables and this pass is scoped to local/dev verification ' +
    'only -- pass --force if you really mean to target a non-local database.'
  );
  process.exit(1);
}

var pool = postgresClient.getPool();
var sqliteDb = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY, function (err) {
  if (err) {
    console.error('Failed to open SQLite file (read-only):', sqlitePath, err.message);
    process.exit(1);
  }
  main();
});

function main() {
  truncateTargetTables(function (err) {
    if (err) fail('truncateTargetTables', err);
    migrateObjects(function (err, count) {
      if (err) fail('migrateObjects', err);
      console.log('objects: migrated', count, 'rows');
      resetObjectsSequence(function (err) {
        if (err) fail('resetObjectsSequence', err);
        migrateSimpleTable('blob_refs', ['blob_cid', 'obj_id'], function (err, count) {
          if (err) fail('migrateSimpleTable(blob_refs)', err);
          console.log('blob_refs: migrated', count, 'rows');
          migrateSimpleTable('postcard_reactions', ['obj_id', 'did', 'emoji', 'created_at'], function (err, count) {
            if (err) fail('migrateSimpleTable(postcard_reactions)', err);
            console.log('postcard_reactions: migrated', count, 'rows');
            migrateSimpleTable('postcard_mailbox_hidden', ['did', 'obj_id', 'hidden_at'], function (err, count) {
              if (err) fail('migrateSimpleTable(postcard_mailbox_hidden)', err);
              console.log('postcard_mailbox_hidden: migrated', count, 'rows');
              migrateSimpleTable('part_aliases', ['did', 'alias_name', 'obj_id', 'updated_at'], function (err, count) {
                if (err) fail('migrateSimpleTable(part_aliases)', err);
                console.log('part_aliases: migrated', count, 'rows');
                console.log('Migration complete.');
                process.exit(0);
              });
            });
          });
        });
      });
    });
  });
}

function fail(step, err) {
  console.error('Migration failed at ' + step + ':', err && err.message || err);
  process.exit(1);
}

// Bootstraps the schema (via the module's own withDB, same DDL the real app
// uses) then wipes the 5 target tables so re-running this script during
// development starts clean. Gated by the same localhost/--force guard as
// the rest of this script -- only ever reached after that check passed.
function truncateTargetTables(thenDo) {
  var objectRepository = require('../core/servers/identity/ObjectRepository');
  objectRepository.withDB(function (err) {
    if (err) return thenDo(err);
    pool.query(
      'TRUNCATE TABLE objects, blob_refs, postcard_reactions, postcard_mailbox_hidden, part_aliases RESTART IDENTITY',
      function (err) { thenDo(err || null); }
    );
  });
}

// Copies the objects table preserving original id values exactly -- get()'s
// "latest version" semantics depend on ORDER BY id DESC / MAX(id) matching
// the original insertion order, so a fresh auto-generated id per row would
// silently corrupt version history.
function migrateObjects(thenDo) {
  sqliteDb.all(
    'SELECT id, obj_id, did, cid, prev_cid, type, visibility, envelope, created_at FROM objects ORDER BY id ASC',
    function (err, rows) {
      if (err) return thenDo(err);
      var i = 0;
      var migrated = 0;
      next();
      function next() {
        if (i >= rows.length) return thenDo(null, migrated);
        var row = rows[i++];
        var envelope;
        try {
          envelope = JSON.parse(row.envelope);
        } catch (e) {
          return thenDo(new Error('Corrupt envelope JSON at objects.id=' + row.id + ': ' + e.message));
        }
        pool.query(
          'INSERT INTO objects (id, obj_id, did, cid, prev_cid, type, visibility, envelope, created_at)' +
          ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [row.id, row.obj_id, row.did, row.cid, row.prev_cid, row.type, row.visibility, envelope, row.created_at],
          function (err) {
            if (err) return thenDo(new Error('Insert failed at objects.id=' + row.id + ': ' + err.message));
            migrated++;
            if (migrated % 500 === 0) console.log('objects: ' + migrated + '/' + rows.length + '...');
            next();
          }
        );
      }
    }
  );
}

// After migrateObjects, the identity column's backing sequence still starts
// at 1 -- point it past the highest migrated id so the next real put()
// insert doesn't collide with migrated rows. Skipped entirely on an empty
// table (setval(..., NULL) would error).
function resetObjectsSequence(thenDo) {
  pool.query('SELECT MAX(id) AS max_id FROM objects', function (err, result) {
    if (err) return thenDo(err);
    var maxId = result.rows[0] && result.rows[0].max_id;
    if (maxId == null) return thenDo(); // empty table, nothing to reset
    pool.query(
      "SELECT setval(pg_get_serial_sequence('objects', 'id'), $1, true)",
      [maxId],
      function (err) { thenDo(err || null); }
    );
  });
}

// Generic straight copy for the four tables with no JSON columns and no id
// column to preserve -- SELECT * -> INSERT per row, same manual sequential
// iteration and progress logging as migrateObjects above.
function migrateSimpleTable(name, columns, thenDo) {
  sqliteDb.all('SELECT * FROM ' + name, function (err, rows) {
    if (err) return thenDo(err);
    var i = 0;
    var migrated = 0;
    var placeholders = columns.map(function (_, idx) { return '$' + (idx + 1); }).join(', ');
    var sql = 'INSERT INTO ' + name + ' (' + columns.join(', ') + ') VALUES (' + placeholders + ')';
    next();
    function next() {
      if (i >= rows.length) return thenDo(null, migrated);
      var row = rows[i++];
      var values = columns.map(function (col) { return row[col]; });
      pool.query(sql, values, function (err) {
        if (err) return thenDo(new Error('Insert failed into ' + name + ': ' + err.message));
        migrated++;
        if (migrated % 500 === 0) console.log(name + ': ' + migrated + '/' + rows.length + '...');
        next();
      });
    }
  });
}
