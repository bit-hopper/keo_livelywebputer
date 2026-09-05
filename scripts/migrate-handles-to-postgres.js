// One-off data migration: copies a SQLite identity/handles.db file's
// contents into the Postgres schema core/servers/identity/HandleRegistry.js
// now uses. Reads the SQLite file directly (via sqlite3, not through
// HandleRegistry.js -- that module no longer has a SQLite code path at all
// after the migration) and writes through the shared postgres-client.js
// pool, same connection-setup idiom every other Postgres-backed module uses.
// Mirrors scripts/migrate-objects-to-postgres.js's structure/safety guard.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrate-handles-to-postgres.js <path-to-sqlite-copy> [--force]
//
// SAFETY: this pass is scoped to local/dev verification only -- run it
// against a COPY of a real handles.db (never the live file a running server
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
  console.error('Usage: DATABASE_URL=postgres://... node scripts/migrate-handles-to-postgres.js <path-to-sqlite-copy> [--force]');
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

// handles/domains/credentials/did_documents have no auto-generated id column
// and no cross-table id references, so every one of them is a plain
// straight copy (SELECT * -> INSERT per row) -- no equivalent of
// migrateObjects' id-preservation/sequence-reset dance is needed here.
var TABLES = [
  { name: 'handles', columns: ['handle', 'did', 'created_at', 'updated_at', 'is_alias', 'primary_handle', 'revoked_at'],
    // is_alias is SQLite's INTEGER 0/1 -- coerce to a real boolean for the
    // Postgres BOOLEAN column HandleRegistry.js's new schema declares.
    transform: function (row) { row.is_alias = !!row.is_alias; return row; } },
  { name: 'domains', columns: ['domain', 'did', 'verified_at', 'status', 'last_checked_at'] },
  { name: 'credentials', columns: ['credential_id', 'did', 'public_key', 'counter', 'created_at'] },
  { name: 'did_documents', columns: ['did', 'document', 'updated_at'] }
];

function main() {
  truncateTargetTables(function (err) {
    if (err) fail('truncateTargetTables', err);
    migrateTables(0, function (err) {
      if (err) fail('migrateTables', err);
      console.log('Migration complete.');
      process.exit(0);
    });
  });
}

function fail(step, err) {
  console.error('Migration failed at ' + step + ':', err && err.message || err);
  process.exit(1);
}

// Bootstraps the schema (via the module's own withDB, same DDL the real app
// uses) then wipes the 4 target tables so re-running this script during
// development starts clean. Gated by the same localhost/--force guard as
// the rest of this script -- only ever reached after that check passed.
function truncateTargetTables(thenDo) {
  var handleRegistry = require('../core/servers/identity/HandleRegistry');
  handleRegistry.withDB(function (err) {
    if (err) return thenDo(err);
    pool.query(
      'TRUNCATE TABLE handles, domains, credentials, did_documents',
      function (err) { thenDo(err || null); }
    );
  });
}

function migrateTables(i, thenDo) {
  if (i >= TABLES.length) return thenDo(null);
  var table = TABLES[i];
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
        return migrateTables(i + 1, thenDo);
      }
      var row = table.transform ? table.transform(rows[j++]) : rows[j++];
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
