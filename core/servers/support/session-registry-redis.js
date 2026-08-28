// Redis-backed replacement for SessionTracker.js's in-process
// `trackerData`/`findConnection` cross-worker gap -- used only when
// SessionTracker.js has decided, once at its own module-load time, to run
// in Redis-backplane mode (see its own header for the opt-in condition).
// Same idea as room-peer-registry-redis.js (Hash + per-entry heartbeat TTL
// + lazy sweep), but scoped PER TRACKER ROUTE via forRoute(), not a flat
// module-level singleton -- SessionTracker.createServer can create more
// than one tracker in the same process on different routes ("One Lively
// server can host multiple session trackers under different routes", per
// that file's own comment), and each needs its own isolated Redis
// namespace so two unrelated trackers can't cross-talk.
//
// Two things this module deliberately does NOT do, both because there's no
// equivalent of a room-registry "room" to hang them off of here:
// - No refcounted subscribe/unsubscribe. A single relay channel is
//   subscribed for the registry's whole lifetime -- any session could need
//   a message at any time, and this traffic (chat, OAuth callbacks) is
//   nowhere near WebRTC-signaling volume.
// - No periodic push-reannounce of live sessions. Session listing here is a
//   pull-based read (chat's online-users list, a session inspector), not a
//   long-lived push-driven UI the way an open room's peer list was, so a
//   lazy sweep at read time (in listSessions) is sufficient -- and
//   findConnection's delivery path already checks a session's own
//   heartbeat directly at delivery time regardless of Hash staleness.
//
// The one thing this module DOES add beyond the room registry: a generic,
// bounded request/reply relay (deliverTo's callback + deliver-reply
// handling below). routeMessage's existing local-only behavior always
// echoes a reply back to the sender over the same connection object one of
// this file's own callers (SessionTracker.js's proxy connection) is
// standing in for -- e.g. Lively2LivelyChat's sender-side "you: ..." bubble
// only appears inside that reply callback, so treating this as one-way
// fire-and-forget (like room-peer-registry-redis.js's signal relay) would
// leave a real, confusing UX bug whenever the two chat participants land on
// different workers. This relay round-trips that reply through the same
// shared channel instead.
'use strict';

var redisClient = require('./redis-client');

var HEARTBEAT_INTERVAL_MS = 20 * 1000;
var REPLY_TIMEOUT_MS = 8 * 1000;
var DEFAULT_INACTIVE_REMOVAL_MS = 60 * 1000;

function sessionsKey(route) { return 'lk:l2l:{' + route + '}:sessions'; }
function hbKey(route, sessionId) { return 'lk:l2l:{' + route + '}:hb:' + sessionId; }
function relayChannel(route) { return 'lk:l2l:{' + route + '}:relay'; }

exports.forRoute = function (route, options) {
  options = options || {};
  var localLookupFn = options.localLookupFn || function () { return null; };
  // Sized off the tracker's own grace period (not copied from the room
  // registry's constants) -- see this file's caller (SessionTracker.js)
  // for why: the grace-period timeout that used to directly delete session
  // state has been changed to only stop refreshing it, relying on this TTL
  // to eventually reap a truly-dead session. If the TTL were shorter than
  // the grace period, a session could vanish from listings/delivery before
  // its own local grace-period logic would even have declared it dead.
  var heartbeatTtlS = Math.ceil((options.inactiveSessionRemovalTime || DEFAULT_INACTIVE_REMOVAL_MS) / 1000)
                     + Math.ceil(HEARTBEAT_INTERVAL_MS / 1000) + 20;

  var client = redisClient.getClient();
  var subscriber = redisClient.getSubscriber();
  var channel = relayChannel(route);

  // This process's own currently-registered sessions -- drives which
  // heartbeats get refreshed on each tick. Not the source of truth for
  // "is this session alive" (the Redis heartbeat key is); just this
  // process's opinion of which sessions it's currently responsible for.
  var activeSessionIds = {};
  // messageId -> {callback, timer}, for deliverTo() calls made BY this
  // process that are still waiting on a reply relayed back from wherever
  // the target actually lives.
  var pendingReplies = {};
  var refreshTimer = null;

  function refreshHeartbeat(sessionId) {
    return client.set(hbKey(route, sessionId), '1', 'EX', heartbeatTtlS);
  }

  function runRefreshSweep() {
    Object.keys(activeSessionIds).forEach(function (sessionId) {
      refreshHeartbeat(sessionId).catch(function (e) {
        console.error('[session-registry-redis] heartbeat refresh failed for ' + sessionId + ':', e.message);
      });
    });
  }

  function ensureRefreshTimerRunning() {
    if (refreshTimer) return;
    refreshTimer = setInterval(runRefreshSweep, HEARTBEAT_INTERVAL_MS);
    refreshTimer.unref();
  }

  function registerSession(sessionId, data) {
    activeSessionIds[sessionId] = true;
    ensureRefreshTimerRunning();
    return client.hset(sessionsKey(route), sessionId, JSON.stringify(data))
      .then(function () { return refreshHeartbeat(sessionId); });
  }

  function touchSession(sessionId, data) {
    if (!activeSessionIds[sessionId]) return Promise.resolve();
    return client.hget(sessionsKey(route), sessionId).then(function (existingRaw) {
      var existing = {};
      try { existing = existingRaw ? JSON.parse(existingRaw) : {}; } catch (e) {}
      Object.assign(existing, data);
      return client.hset(sessionsKey(route), sessionId, JSON.stringify(existing));
    });
  }

  function unregisterSession(sessionId) {
    delete activeSessionIds[sessionId];
    return Promise.all([
      client.hdel(sessionsKey(route), sessionId),
      client.del(hbKey(route, sessionId))
    ]);
  }

  // The grace-period-timeout path (a GUESS that a session is gone, not a
  // certainty -- see SessionTracker.js's own comment at the call site):
  // stop this process's heartbeat refresh for it, but never delete the
  // shared registry entry directly. If the session reconnected on a
  // different worker within the grace window, that worker's own
  // registerSession call already has (or will have) its own independent
  // heartbeat refresh running -- deleting here would clobber that. If it's
  // genuinely gone everywhere, the TTL lapses on its own.
  function stopRefreshing(sessionId) {
    delete activeSessionIds[sessionId];
  }

  function existsRemotely(sessionId, thenDo) {
    client.exists(hbKey(route, sessionId)).then(function (exists) {
      thenDo(exists ? null : 'not found', !!exists);
    }).catch(function (err) { thenDo(err, false); });
  }

  function deliverTo(sessionId, message, callback) {
    if (callback) {
      var timer = setTimeout(function () { delete pendingReplies[message.messageId]; }, REPLY_TIMEOUT_MS);
      timer.unref();
      pendingReplies[message.messageId] = { callback: callback, timer: timer };
    }
    client.publish(channel, JSON.stringify({
      type: 'deliver', target: sessionId, message: message, replyWanted: !!callback
    })).catch(function (e) { console.error('[session-registry-redis] deliver publish failed:', e.message); });
  }

  function proxyConnectionFor(sessionId) {
    return { send: function (msg, callback) { deliverTo(sessionId, msg, callback); } };
  }

  function listSessions() {
    return client.hgetall(sessionsKey(route)).then(function (roster) {
      var ids = Object.keys(roster);
      if (!ids.length) return {};
      var pipeline = client.pipeline();
      ids.forEach(function (id) { pipeline.exists(hbKey(route, id)); });
      return pipeline.exec().then(function (results) {
        var result = {}, staleIds = [];
        ids.forEach(function (id, i) {
          if (results[i][1]) {
            try { result[id] = JSON.parse(roster[id]); } catch (e) {}
          } else {
            staleIds.push(id);
          }
        });
        if (staleIds.length) {
          var cleanup = client.pipeline();
          staleIds.forEach(function (id) { cleanup.hdel(sessionsKey(route), id); });
          cleanup.exec().catch(function (e) {
            console.error('[session-registry-redis] stale-entry cleanup failed:', e.message);
          });
        }
        return result;
      });
    });
  }

  function onMessage(ch, raw) {
    if (ch !== channel) return;
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'deliver') {
      // Strictly local-only lookup -- must never re-enter findConnection/
      // Redis here, or every process would redundantly hit Redis on every
      // relayed message instead of a cheap local no-op when it's not the
      // owner.
      var conn = localLookupFn(msg.target);
      if (!conn) return;
      if (msg.replyWanted) {
        conn.send(msg.message, function (replyMsg) {
          client.publish(channel, JSON.stringify({
            type: 'deliver-reply',
            messageId: msg.message.messageId,
            response: { data: replyMsg.data, messageId: replyMsg.messageId, expectMoreResponses: replyMsg.expectMoreResponses }
          })).catch(function (e) { console.error('[session-registry-redis] reply publish failed:', e.message); });
        });
      } else {
        conn.send(msg.message);
      }
    } else if (msg.type === 'deliver-reply') {
      var pending = pendingReplies[msg.messageId];
      if (!pending) return;
      pending.callback({ data: msg.response.data, messageId: msg.response.messageId, expectMoreResponses: msg.response.expectMoreResponses });
      clearTimeout(pending.timer);
      if (msg.response.expectMoreResponses) {
        // Streamed responses (mirroring support/websockets.js's own
        // triggerCallbacks, which only clears a callback once
        // !expectMoreResponses) -- keep the entry alive, just push its
        // timeout back out.
        pending.timer = setTimeout(function () { delete pendingReplies[msg.messageId]; }, REPLY_TIMEOUT_MS);
        pending.timer.unref();
      } else {
        delete pendingReplies[msg.messageId];
      }
    }
  }

  subscriber.subscribe(channel).catch(function (e) {
    console.error('[session-registry-redis] subscribe failed for ' + channel + ':', e.message);
  });
  subscriber.on('message', onMessage);

  return {
    registerSession: registerSession,
    touchSession: touchSession,
    unregisterSession: unregisterSession,
    stopRefreshing: stopRefreshing,
    existsRemotely: existsRemotely,
    deliverTo: deliverTo,
    proxyConnectionFor: proxyConnectionFor,
    listSessions: listSessions,
    shutdown: function () {
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      subscriber.removeListener('message', onMessage);
      subscriber.unsubscribe(channel).catch(function () {});
      Object.keys(pendingReplies).forEach(function (id) { clearTimeout(pendingReplies[id].timer); });
      pendingReplies = {};
    }
  };
};
