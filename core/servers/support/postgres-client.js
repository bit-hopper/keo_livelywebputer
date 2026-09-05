// Thin node-postgres wrapper shared by any server module backed by
// Postgres (see ../identity/ObjectRepository.js for the first user).
// Unlike redis-client.js, there is no fallback mode: DATABASE_URL is
// required, not optional-with-a-default, because there is no working
// non-Postgres code path left in a module once it's been migrated onto
// this file -- a dual SQLite/Postgres path would be real, permanent
// complexity for a migration that's meant to be a clean cutover.
'use strict';

var Pool = require('pg').Pool;

var DATABASE_URL = process.env.DATABASE_URL;

var _pool = null;

// A pg.Pool is fully worker-symmetric (like ioredis) -- each cluster
// worker that require()s this module lazily gets its own pool the same
// way each worker gets its own Redis connections. No primary-vs-worker
// special-casing needed in bin/lk-server.js.
exports.getPool = function () {
  if (!_pool) {
    if (!DATABASE_URL) {
      throw new Error('[postgres-client] DATABASE_URL is not set -- required, no SQLite fallback exists for a module that requires this file.');
    }
    _pool = new Pool({ connectionString: DATABASE_URL });
    _pool.on('error', function (err) {
      // Fired for an idle client that errors out in the background (e.g.
      // the server restarted) -- without this handler an unhandled
      // 'error' event on the pool would crash the process.
      console.error('[postgres-client] idle client error:', err.message);
    });
  }
  return _pool;
};
