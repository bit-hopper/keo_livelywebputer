// Shared safety guard for the migrate-*-to-postgres.js and
// smoke-test-registries.js scripts, all of which TRUNCATE their target
// tables -- this exists to stop one of them being pointed at a real/shared
// database by mistake, not to validate DATABASE_URL's general syntax.
//
// Deliberately parses with pg's OWN connection-string parser
// (pg-connection-string, a direct dependency of `pg`) rather than the
// WHATWG `URL` -- confirmed live: `new URL('postgres://user@/db?host=/var/run/postgresql')`
// throws "Invalid URL" outright (a bare "postgres://user@" authority with
// no host, host supplied instead via a `?host=` query param, is not a
// valid URL authority under the WHATWG spec even though it's a completely
// normal libpq/pg unix-socket connection string), while
// pg-connection-string parses it fine and resolves `host` to
// '/var/run/postgresql'. A missing host, or a host that's actually a
// filesystem path, means a unix socket -- inherently local, since a socket
// only ever exists on this machine, so there is no "wrong host" to guard
// against the way there is for a TCP host.
'use strict';

var parseConnectionString = require('pg-connection-string').parse;

// Exits the process with an explanatory message if databaseUrl is missing,
// unparseable, or resolves to a non-local TCP host -- unless `force` is
// true. Returns (does nothing) on success.
module.exports = function requireLocalDatabaseUrl(databaseUrl, force) {
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  if (force) return;

  var parsed;
  try {
    parsed = parseConnectionString(databaseUrl);
  } catch (e) {
    console.error('DATABASE_URL could not be parsed:', e.message);
    process.exit(1);
  }

  var host = parsed.host;
  var isSocket = !host || host.indexOf('/') === 0;
  var isLocalTcp = host === 'localhost' || host === '127.0.0.1';
  if (!isSocket && !isLocalTcp) {
    console.error(
      'Refusing to run: DATABASE_URL host is "' + host + '", not localhost/127.0.0.1 or a unix socket. ' +
      'This script truncates its target tables -- pass --force if you really mean to target a non-local database.'
    );
    process.exit(1);
  }
};
