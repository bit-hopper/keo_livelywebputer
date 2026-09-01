// Thin ioredis wrapper shared by any server module that opts into a
// Redis-backed cross-process/cross-instance backplane (see
// room-peer-registry-redis.js for the first user). Only ever require()'d by
// a module that has already decided -- once, at its own module-load time --
// that Redis mode is active; this file doesn't decide that itself.
'use strict';

var Redis = require('ioredis');

var REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

var _client = null;
var _subscriber = null;

function makeClient() {
  var r = new Redis(REDIS_URL, {
    // Default retryStrategy already backs off and keeps retrying forever;
    // capping the delay at 5s keeps reconnects from going quiet for long
    // stretches during an extended outage. The background reconnect loop
    // itself is unaffected by maxRetriesPerRequest below and keeps trying
    // forever, so this doesn't weaken auto-recovery once Redis comes back.
    retryStrategy: function (times) { return Math.min(times * 200, 5000); },
    // ioredis's own default (20) queues a command issued while disconnected
    // and waits through up to 20 reconnect cycles before finally rejecting
    // it -- confirmed live during the 2026-08-31 Redis-outage test: a
    // single room-join's registry.join() call took 60-90+ seconds to fail,
    // not the few seconds a caller/user would reasonably wait for. None of
    // this app's Redis-dependent call sites need more than a couple of
    // quick attempts before falling back to "Redis is down right now" --
    // every caller already has its own error handling for a rejected
    // command (see room-peer-registry-redis.js/session-registry-redis.js/
    // live-doc-registry-redis.js's .catch() blocks), so failing fast here
    // just makes that error handling kick in promptly instead of after a
    // long silent hang.
    maxRetriesPerRequest: 3
  });
  r.on('error', function (err) {
    console.error('[redis-client] connection error:', err.message);
  });
  return r;
}

// The regular command connection (HSET/HGETALL/EXISTS/PUBLISH/etc.).
exports.getClient = function () {
  if (!_client) _client = makeClient();
  return _client;
};

// A second, dedicated connection for SUBSCRIBE/pub-sub message events --
// Redis clients can't issue regular commands on a connection that's in
// subscribe mode. duplicate() (rather than constructing a second `new
// Redis(REDIS_URL)` independently) inherits the primary connection's auth/
// TLS/retry config automatically, so the two connections can't drift apart
// if that config ever changes.
exports.getSubscriber = function () {
  if (!_subscriber) {
    _subscriber = exports.getClient().duplicate();
    // duplicate() copies connection options but not event listeners -- an
    // unhandled 'error' event on an EventEmitter throws, so this needs its
    // own handler same as the primary client got inside makeClient().
    _subscriber.on('error', function (err) {
      console.error('[redis-client] subscriber connection error:', err.message);
    });
  }
  return _subscriber;
};
