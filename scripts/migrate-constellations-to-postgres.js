// One-off data migration: copies a SQLite identity/constellations.db file's
// contents into the Postgres schema
// core/servers/identity/ConstellationRegistry.js now uses. Mirrors
// scripts/migrate-objects-to-postgres.js's structure and safety guard -- see
// that file for the full rationale.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrate-constellations-to-postgres.js <path-to-sqlite-copy> [--force]
//
// SAFETY: scoped to local/dev verification only -- run against a COPY of a
// real constellations.db, never the live file a running server still has
// open, and only against a scratch Postgres. Refuses to run unless
// DATABASE_URL points at localhost/127.0.0.1, unless --force is passed.
// Truncates the target tables first (gated behind the same guard) so
// re-running during development is safe/idempotent.

'use strict';

var sqlite3 = require('sqlite3').verbose();
var postgresClient = require('../core/servers/support/postgres-client');

var args = process.argv.slice(2);
var force = args.indexOf('--force') !== -1;
var sqlitePath = args.filter(function (a) { return a !== '--force'; })[0];

if (!sqlitePath) {
  console.error('Usage: DATABASE_URL=postgres://... node scripts/migrate-constellations-to-postgres.js <path-to-sqlite-copy> [--force]');
  process.exit(1);
}

require('./lib/require-local-database-url')(process.env.DATABASE_URL, force);

var pool = postgresClient.getPool();
var sqliteDb = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY, function (err) {
  if (err) {
    console.error('Failed to open SQLite file (read-only):', sqlitePath, err.message);
    process.exit(1);
  }
  main();
});

// Plain straight-copy tables: no auto-generated id column of their own, and
// (room_join_requests aside) no reference to another table's generated id
// either, so a bare SELECT * -> INSERT per row is enough -- same treatment
// as migrate-friends-to-postgres.js's tables. room_join_requests DOES
// reference rooms.id by value, but that's a plain copied INTEGER column
// value, not something this script generates -- as long as `rooms` is
// migrated (preserving its original ids, see migrateIdTable below) before
// room_join_requests copies its room_id column, the reference stays valid.
var SIMPLE_TABLES = [
  { name: 'constellations', columns: ['name', 'did', 'genesis_obj_id', 'genesis_nonce', 'controllers', 'threshold', 'members', 'created_by', 'created_at', 'creation_sig', 'visibility', 'bots'] },
  { name: 'room_join_requests', columns: ['room_id', 'did', 'requested_at', 'status'] },
  { name: 'constellation_invites', columns: ['constellation', 'did', 'invited_by', 'obj_id', 'status', 'created_at', 'responded_at'] },
  { name: 'join_requests', columns: ['constellation', 'did', 'requested_at', 'status'] }
];

// Tables with an auto-generated `id` PRIMARY KEY that must be preserved
// exactly -- room_join_requests.room_id above points at rooms.id by value,
// so a fresh auto-generated id per row here would silently corrupt that
// reference (same reasoning as migrate-objects-to-postgres.js's own
// migrateObjects/resetObjectsSequence pair, applied to two tables instead
// of one). is_video/is_voice are SQLite's INTEGER 0/1 -- coerced to real
// booleans for the Postgres BOOLEAN columns ConstellationRegistry.js's new
// schema declares.
var ID_TABLES = [
  { name: 'constellation_events', columns: ['id', 'constellation', 'title', 'starts_at', 'location', 'attendees', 'attendee_count', 'created_by', 'created_at'] },
  { name: 'rooms', columns: ['id', 'constellation', 'name', 'is_video', 'is_voice', 'access', 'activity', 'created_by', 'created_at'],
    transform: function (row) { row.is_video = !!row.is_video; row.is_voice = !!row.is_voice; return row; } }
];

function main() {
  truncateTargetTables(function (err) {
    if (err) fail('truncateTargetTables', err);
    migrateIdTables(0, function (err) {
      if (err) fail('migrateIdTables', err);
      migrateSimpleTables(0, function (err) {
        if (err) fail('migrateSimpleTables', err);
        console.log('Migration complete.');
        process.exit(0);
      });
    });
  });
}

function fail(step, err) {
  console.error('Migration failed at ' + step + ':', err && err.message || err);
  process.exit(1);
}

// Bootstraps the schema (via the module's own withDB, same DDL the real app
// uses) then wipes all 6 target tables so re-running this script during
// development starts clean. Gated by the same localhost/--force guard as
// the rest of this script -- only ever reached after that check passed.
function truncateTargetTables(thenDo) {
  var constellationRegistry = require('../core/servers/identity/ConstellationRegistry');
  constellationRegistry.withDB(function (err) {
    if (err) return thenDo(err);
    pool.query(
      'TRUNCATE TABLE constellations, constellation_events, rooms, room_join_requests,' +
      ' constellation_invites, join_requests RESTART IDENTITY',
      function (err) { thenDo(err || null); }
    );
  });
}

// Copies an ID_TABLES entry preserving original id values, then points its
// identity sequence past the highest migrated id so the next real insert
// doesn't collide -- same two-step pattern as migrate-objects-to-postgres.js's
// migrateObjects/resetObjectsSequence. Skips the sequence reset entirely on
// an empty table (setval(..., NULL) would error).
function migrateIdTables(i, thenDo) {
  if (i >= ID_TABLES.length) return thenDo(null);
  var table = ID_TABLES[i];
  sqliteDb.all('SELECT * FROM ' + table.name + ' ORDER BY id ASC', function (err, rows) {
    if (err) return thenDo(err);
    var placeholders = table.columns.map(function (_, idx) { return '$' + (idx + 1); }).join(', ');
    var sql = 'INSERT INTO ' + table.name + ' (' + table.columns.join(', ') + ') VALUES (' + placeholders + ')';
    var j = 0;
    var migrated = 0;
    next();
    function next() {
      if (j >= rows.length) {
        console.log(table.name + ': migrated ' + migrated + ' rows');
        return resetSequence(table.name, function (err) {
          if (err) return thenDo(err);
          migrateIdTables(i + 1, thenDo);
        });
      }
      var row = table.transform ? table.transform(rows[j++]) : rows[j++];
      var values = table.columns.map(function (col) { return row[col]; });
      pool.query(sql, values, function (err) {
        if (err) return thenDo(new Error('Insert failed into ' + table.name + ' at id=' + row.id + ': ' + err.message));
        migrated++;
        if (migrated % 500 === 0) console.log(table.name + ': ' + migrated + '/' + rows.length + '...');
        next();
      });
    }
  });
}

function resetSequence(tableName, thenDo) {
  pool.query('SELECT MAX(id) AS max_id FROM ' + tableName, function (err, result) {
    if (err) return thenDo(err);
    var maxId = result.rows[0] && result.rows[0].max_id;
    if (maxId == null) return thenDo(); // empty table, nothing to reset
    pool.query(
      "SELECT setval(pg_get_serial_sequence('" + tableName + "', 'id'), $1, true)",
      [maxId],
      function (err) { thenDo(err || null); }
    );
  });
}

function migrateSimpleTables(i, thenDo) {
  if (i >= SIMPLE_TABLES.length) return thenDo(null);
  var table = SIMPLE_TABLES[i];
  sqliteDb.all('SELECT * FROM ' + table.name, function (err, rows) {
    if (err) return thenDo(err);
    var placeholders = table.columns.map(function (_, idx) { return '$' + (idx + 1); }).join(', ');
    var sql = 'INSERT INTO ' + table.name + ' (' + table.columns.join(', ') + ') VALUES (' + placeholders + ')';
    var j = 0;
    var migrated = 0;
    next();
    function next() {
      if (j >= rows.length) {
        console.log(table.name + ': migrated ' + migrated + ' rows');
        return migrateSimpleTables(i + 1, thenDo);
      }
      var row = rows[j++];
      var values = table.columns.map(function (col) { return row[col]; });
      pool.query(sql, values, function (err) {
        if (err) return thenDo(new Error('Insert failed into ' + table.name + ': ' + err.message));
        migrated++;
        if (migrated % 500 === 0) console.log(table.name + ': ' + migrated + '/' + rows.length + '...');
        next();
      });
    }
  });
}
