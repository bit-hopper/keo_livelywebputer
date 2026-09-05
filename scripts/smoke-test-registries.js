// One-off smoke test for the Postgres-migrated HandleRegistry.js,
// FriendRegistry.js, and ConstellationRegistry.js (core/servers/identity/).
// Exercises every exported function against a real Postgres instance and
// asserts the results are shaped/typed the way the SQLite originals were —
// this is NOT a unit test suite (no test framework, no mocking); it is a
// disposable script meant to be run once by hand after the migration, the
// same role the migration scripts' own truncate-then-verify pattern plays.
//
// SAFETY: truncates handles/domains/credentials/did_documents,
// friend_requests/friendships, and constellations/constellation_events/
// rooms/room_join_requests/constellation_invites/join_requests before
// running. Refuses to run unless DATABASE_URL points at localhost/127.0.0.1
// (pass --force to override) -- same guard as the migrate-*-to-postgres.js
// scripts. Do NOT point this at a database with real data you care about.
//
// Usage:
//   DATABASE_URL=postgres://user:pass@localhost:5432/dbname node scripts/smoke-test-registries.js [--force]
//
// A scratch database is safest, e.g.:
//   sudo -u postgres createdb lk_smoketest
//   DATABASE_URL=postgres://postgres@localhost:5432/lk_smoketest node scripts/smoke-test-registries.js
//
// Exits 0 with "ALL PASSED" printed last if every assertion holds, exits 1
// with the failing assertion's message otherwise.

'use strict';

var args = process.argv.slice(2);
var force = args.indexOf('--force') !== -1;

require('./lib/require-local-database-url')(process.env.DATABASE_URL, force);

var postgresClient = require('../core/servers/support/postgres-client');
var handleRegistry = require('../core/servers/identity/HandleRegistry');
var friendRegistry = require('../core/servers/identity/FriendRegistry');
var constellationRegistry = require('../core/servers/identity/ConstellationRegistry');

var pool = postgresClient.getPool();

var failures = [];
function check(label, cond, detail) {
  if (cond) {
    console.log('  ok   - ' + label);
  } else {
    console.error('  FAIL - ' + label + (detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''));
    failures.push(label);
  }
}
function fatal(step, err) {
  console.error('Smoke test crashed at ' + step + ':', err && err.stack || err);
  process.exit(1);
}

// ─── run in sequence: truncate -> HandleRegistry -> FriendRegistry -> ConstellationRegistry ──

truncateAll(function (err) {
  if (err) return fatal('truncateAll', err);
  runHandleRegistry(function (err) {
    if (err) return fatal('runHandleRegistry', err);
    runFriendRegistry(function (err) {
      if (err) return fatal('runFriendRegistry', err);
      runConstellationRegistry(function (err) {
        if (err) return fatal('runConstellationRegistry', err);
        console.log('');
        if (failures.length) {
          console.error(failures.length + ' assertion(s) FAILED:');
          failures.forEach(function (f) { console.error('  - ' + f); });
          process.exit(1);
        }
        console.log('ALL PASSED');
        process.exit(0);
      });
    });
  });
});

function truncateAll(thenDo) {
  handleRegistry.withDB(function (err) {
    if (err) return thenDo(err);
    friendRegistry.withDB(function (err) {
      if (err) return thenDo(err);
      constellationRegistry.withDB(function (err) {
        if (err) return thenDo(err);
        pool.query(
          'TRUNCATE TABLE handles, domains, credentials, did_documents,' +
          ' friend_requests, friendships,' +
          ' constellations, constellation_events, rooms, room_join_requests,' +
          ' constellation_invites, join_requests RESTART IDENTITY',
          function (err) { thenDo(err || null); }
        );
      });
    });
  });
}

// ─── HandleRegistry ─────────────────────────────────────────────────────────

function runHandleRegistry(done) {
  console.log('\n== HandleRegistry ==');
  var did = 'did:jwk:smoketest-alice';
  var did2 = 'did:jwk:smoketest-bob';

  handleRegistry.register('alice', did, function (err) {
    if (err) return done(err);
    handleRegistry.resolve('alice', function (err, resolved) {
      if (err) return done(err);
      check('register+resolve round-trips', resolved === did, resolved);

      handleRegistry.resolveHandleForDid(did, function (err, handle) {
        if (err) return done(err);
        check('resolveHandleForDid returns primary handle', handle === 'alice', handle);

        handleRegistry.createAlias('alice', did, function (err, alias) {
          if (err) return done(err);
          check('createAlias returns an 8-char alias', typeof alias === 'string' && alias.length === 8, alias);

          handleRegistry.resolveForDelivery(alias, function (err, delivery) {
            if (err) return done(err);
            check('resolveForDelivery(alias) resolves to owner did + primary handle',
              !!delivery && delivery.did === did && delivery.primaryHandle === 'alice', delivery);

            handleRegistry.listAliasesForHandle('alice', function (err, aliases) {
              if (err) return done(err);
              check('listAliasesForHandle sees the new alias', aliases.length === 1 && aliases[0].handle === alias, aliases);

              handleRegistry.revokeAlias(alias, 'alice', function (err, changed) {
                if (err) return done(err);
                check('revokeAlias reports changed=true (rowCount-based boolean)', changed === true, changed);

                handleRegistry.revokeAlias(alias, 'alice', function (err, changedAgain) {
                  if (err) return done(err);
                  check('revokeAlias is idempotent (changed=false on 2nd call)', changedAgain === false, changedAgain);

                  handleRegistry.resolveForDelivery(alias, function (err, afterRevoke) {
                    if (err) return done(err);
                    check('a revoked alias resolves to null', afterRevoke === null, afterRevoke);

                    handleRegistry.register('bob', did2, function (err) {
                      if (err) return done(err);
                      handleRegistry.listAll(function (err, all) {
                        if (err) return done(err);
                        // 3, not 2: listAll() is intentionally unfiltered by
                        // is_alias (same query as the original SQLite
                        // version) -- it includes the revoked alias row
                        // from createAlias/revokeAlias above alongside
                        // alice and bob's own primary handles.
                        check('listAll sees both primary handles plus the earlier revoked alias row',
                          all.length === 3 && all.filter(function(r) { return r.handle === 'alice' || r.handle === 'bob'; }).length === 2,
                          all);

                        handleRegistry.registerDomain('alice.example', did, function (err) {
                          if (err) return done(err);
                          handleRegistry.resolveDomain('alice.example', function (err, domainDid) {
                            if (err) return done(err);
                            check('registerDomain+resolveDomain round-trips', domainDid === did, domainDid);

                            handleRegistry.resolve('alice.example', function (err, viaFallback) {
                              if (err) return done(err);
                              check('resolve() falls back to domains table for a dotted name', viaFallback === did, viaFallback);

                              handleRegistry.listDomainsForDid(did, function (err, domains) {
                                if (err) return done(err);
                                check('listDomainsForDid sees the domain', domains.length === 1 && domains[0].status === 'verified', domains);

                                handleRegistry.updateDomainStatus('alice.example', 'invalid', function (err) {
                                  if (err) return done(err);
                                  handleRegistry.listAllDomains(function (err, allDomains) {
                                    if (err) return done(err);
                                    check('updateDomainStatus persists', allDomains[0].status === 'invalid', allDomains);

                                    handleRegistry.removeDomain('alice.example', did, function (err, removed) {
                                      if (err) return done(err);
                                      check('removeDomain reports removed=true', removed === true, removed);

                                      var fakeKey = Buffer.from([1, 2, 3, 4]);
                                      handleRegistry.saveCredential('cred-1', did, fakeKey, 0, function (err) {
                                        if (err) return done(err);
                                        handleRegistry.getCredential('cred-1', function (err, cred) {
                                          if (err) return done(err);
                                          check('saveCredential+getCredential round-trips public key bytes',
                                            !!cred && Buffer.from(cred.publicKey).equals(fakeKey) && cred.counter === 0, cred);

                                          handleRegistry.updateCounter('cred-1', 7, function (err) {
                                            if (err) return done(err);
                                            handleRegistry.getCredential('cred-1', function (err, cred2) {
                                              if (err) return done(err);
                                              check('updateCounter persists', cred2.counter === 7, cred2);

                                              var doc = { id: did, verificationMethod: [{ id: '#key-1' }] };
                                              handleRegistry.saveDIDDocument(did, doc, function (err) {
                                                if (err) return done(err);
                                                handleRegistry.getDIDDocument(did, function (err, gotDoc) {
                                                  if (err) return done(err);
                                                  check('saveDIDDocument+getDIDDocument round-trips JSON',
                                                    JSON.stringify(gotDoc) === JSON.stringify(doc), gotDoc);

                                                  handleRegistry.remove('bob', function (err) {
                                                    if (err) return done(err);
                                                    handleRegistry.resolve('bob', function (err, goneDid) {
                                                      if (err) return done(err);
                                                      check('remove() actually removes the handle', goneDid === null, goneDid);
                                                      done(null);
                                                    });
                                                  });
                                                });
                                              });
                                            });
                                          });
                                        });
                                      });
                                    });
                                  });
                                });
                              });
                            });
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

// ─── FriendRegistry ─────────────────────────────────────────────────────────

function runFriendRegistry(done) {
  console.log('\n== FriendRegistry ==');
  var alice = 'did:jwk:smoketest-alice';
  var bob = 'did:jwk:smoketest-bob';
  var carol = 'did:jwk:smoketest-carol';

  friendRegistry.sendRequest(alice, bob, function (err, result) {
    if (err) return done(err);
    check('sendRequest (fresh) returns pending', result.status === 'pending', result);

    friendRegistry.getRequestStatus(alice, bob, function (err, status) {
      if (err) return done(err);
      check('getRequestStatus sees the pending request', status === 'pending', status);

      friendRegistry.listIncomingPending(bob, function (err, incoming) {
        if (err) return done(err);
        check('listIncomingPending sees it from bob\'s side', incoming.length === 1 && incoming[0].did === alice, incoming);

        friendRegistry.listOutgoingPending(alice, function (err, outgoing) {
          if (err) return done(err);
          check('listOutgoingPending sees it from alice\'s side', outgoing.length === 1 && outgoing[0].did === bob, outgoing);

          friendRegistry.approveRequest(alice, bob, function (err) {
            if (err) return done(err);
            friendRegistry.areFriends(alice, bob, function (err, friends) {
              if (err) return done(err);
              check('approveRequest makes them friends (order-independent pair)', friends === true, friends);

              friendRegistry.areFriends(bob, alice, function (err, friendsReversed) {
                if (err) return done(err);
                check('areFriends is symmetric regardless of argument order', friendsReversed === true, friendsReversed);

                friendRegistry.listFriends(bob, function (err, bobFriends) {
                  if (err) return done(err);
                  check('listFriends(bob) sees alice', bobFriends.length === 1 && bobFriends[0].did === alice, bobFriends);

                  // Crossed-in-the-mail case: carol requests alice while alice
                  // independently requests carol -- should collapse to an
                  // immediate mutual accept rather than two pending rows.
                  friendRegistry.sendRequest(carol, alice, function (err) {
                    if (err) return done(err);
                    friendRegistry.sendRequest(alice, carol, function (err, crossedResult) {
                      if (err) return done(err);
                      check('crossed-in-the-mail requests resolve to accepted', crossedResult.status === 'accepted', crossedResult);

                      friendRegistry.areFriends(alice, carol, function (err, aliceCarolFriends) {
                        if (err) return done(err);
                        check('crossed request actually created the friendship', aliceCarolFriends === true, aliceCarolFriends);

                        friendRegistry.removeFriendship(alice, bob, function (err) {
                          if (err) return done(err);
                          friendRegistry.areFriends(alice, bob, function (err, stillFriends) {
                            if (err) return done(err);
                            check('removeFriendship actually removes it', stillFriends === false, stillFriends);

                            friendRegistry.sendRequest(bob, carol, function (err) {
                              if (err) return done(err);
                              friendRegistry.declineRequest(bob, carol, function (err) {
                                if (err) return done(err);
                                friendRegistry.getRequestStatus(bob, carol, function (err, declinedStatus) {
                                  if (err) return done(err);
                                  check('declineRequest sets status to declined', declinedStatus === 'declined', declinedStatus);

                                  friendRegistry.sendRequest(bob, carol, function (err) {
                                    if (err) return done(err);
                                    friendRegistry.cancelRequest(bob, carol, function (err) {
                                      if (err) return done(err);
                                      friendRegistry.getRequestStatus(bob, carol, function (err, cancelledStatus) {
                                        if (err) return done(err);
                                        check('a re-request after decline then cancelRequest sets status to cancelled',
                                          cancelledStatus === 'cancelled', cancelledStatus);
                                        done(null);
                                      });
                                    });
                                  });
                                });
                              });
                            });
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

// ─── ConstellationRegistry ──────────────────────────────────────────────────

function runConstellationRegistry(done) {
  console.log('\n== ConstellationRegistry ==');
  var alice = 'did:jwk:smoketest-alice';
  var bob = 'did:jwk:smoketest-bob';
  var carol = 'did:jwk:smoketest-carol';
  var name = 'smoketestville';

  check('isValidName accepts a normal name', constellationRegistry.isValidName(name) === true);
  check('isValidName rejects a reserved name', constellationRegistry.isValidName('wiki') === false);

  constellationRegistry.create({
    name: name, did: 'did:web:example.com:c:' + name,
    genesisObjId: 'obj-genesis-1', genesisNonce: 'nonce-1',
    controllers: [alice], threshold: 1, members: [alice],
    createdBy: alice, createdAt: new Date().toISOString(),
    creationSig: 'sig-1', visibility: 'public', bots: []
  }, function (err) {
    if (err) return done(err);

    constellationRegistry.exists(name, function (err, ex) {
      if (err) return done(err);
      check('exists() sees the new constellation', ex === true, ex);

      constellationRegistry.get(name, function (err, c) {
        if (err) return done(err);
        check('get() round-trips JSON array columns as real arrays',
          Array.isArray(c.controllers) && c.controllers[0] === alice &&
          Array.isArray(c.members) && c.members[0] === alice, c);

        constellationRegistry.getByGenesisObjId('obj-genesis-1', function (err, c2) {
          if (err) return done(err);
          check('getByGenesisObjId finds the same row', !!c2 && c2.name === name, c2);

          check('canRead: public constellation readable by anyone (even null did)',
            constellationRegistry.canRead(c, null) === true);
          check('canWrite: non-member cannot write', constellationRegistry.canWrite(c, bob) === false);
          check('isController: creator is a controller', constellationRegistry.isController(c, alice) === true);

          constellationRegistry.listPublic({}, function (err, pubs) {
            if (err) return done(err);
            check('listPublic sees it with correct memberCount', pubs.length === 1 && pubs[0].memberCount === 1, pubs);

            constellationRegistry.requestJoin(name, bob, function (err) {
              if (err) return done(err);
              constellationRegistry.getJoinRequestStatus(name, bob, function (err, status) {
                if (err) return done(err);
                check('requestJoin creates a pending request', status === 'pending', status);

                constellationRegistry.listPendingJoinRequests(name, function (err, pending) {
                  if (err) return done(err);
                  check('listPendingJoinRequests sees bob', pending.length === 1 && pending[0].did === bob, pending);

                  constellationRegistry.approveJoinRequest(name, bob, function (err) {
                    if (err) return done(err);
                    constellationRegistry.get(name, function (err, c3) {
                      if (err) return done(err);
                      check('approveJoinRequest adds bob to members', c3.members.indexOf(bob) !== -1, c3.members);
                      check('canWrite: bob can now write as a member', constellationRegistry.canWrite(c3, bob) === true);

                      constellationRegistry.requestJoin(name, carol, function (err) {
                        if (err) return done(err);
                        constellationRegistry.declineJoinRequest(name, carol, function (err) {
                          if (err) return done(err);
                          constellationRegistry.getJoinRequestStatus(name, carol, function (err, carolStatus) {
                            if (err) return done(err);
                            check('declineJoinRequest sets status to declined', carolStatus === 'declined', carolStatus);

                            constellationRegistry.listByController(alice, function (err, controlled) {
                              if (err) return done(err);
                              check('listByController finds it via the controllers LIKE scan', controlled.length === 1 && controlled[0].name === name, controlled);

                              constellationRegistry.createInvite(name, carol, alice, 'obj-invite-1', function (err) {
                                if (err) return done(err);
                                constellationRegistry.getInviteStatus(name, carol, function (err, inviteStatus) {
                                  if (err) return done(err);
                                  check('createInvite creates a pending invite', inviteStatus === 'pending', inviteStatus);

                                  constellationRegistry.approveInvite(name, carol, function (err) {
                                    if (err) return done(err);
                                    constellationRegistry.get(name, function (err, c4) {
                                      if (err) return done(err);
                                      check('approveInvite adds carol to members too', c4.members.indexOf(carol) !== -1, c4.members);

                                      var futureIso = new Date(Date.now() + 86400000).toISOString();
                                      constellationRegistry.createEvent({
                                        constellation: name, title: 'Smoke Test Meetup', startsAt: futureIso,
                                        location: 'Somewhere', attendees: [alice, bob], attendeeCount: 5, createdBy: alice
                                      }, function (err) {
                                        if (err) return done(err);
                                        constellationRegistry.getNextEvent(name, function (err, ev) {
                                          if (err) return done(err);
                                          check('createEvent+getNextEvent round-trips, attendees stays an array',
                                            !!ev && ev.title === 'Smoke Test Meetup' && Array.isArray(ev.attendees) && ev.attendees.length === 2, ev);

                                          constellationRegistry.createRoom({
                                            constellation: name, name: 'Lounge', isVideo: true, isVoice: false,
                                            access: 'request', activity: 'Chatting', createdBy: alice
                                          }, function (err, roomId) {
                                            if (err) return done(err);
                                            check('createRoom returns a real JS number id (not a bigint string)',
                                              typeof roomId === 'number' && roomId > 0, roomId);

                                            constellationRegistry.getRoom(roomId, function (err, room) {
                                              if (err) return done(err);
                                              check('getRoom round-trips booleans correctly (is_video true, is_voice false)',
                                                !!room && room.isVideo === true && room.isVoice === false, room);
                                              check('getRoom.id is also a real JS number', typeof room.id === 'number', room && room.id);

                                              constellationRegistry.listRooms(name, function (err, rooms) {
                                                if (err) return done(err);
                                                check('listRooms sees the new room', rooms.length === 1 && rooms[0].id === roomId, rooms);

                                                constellationRegistry.requestRoomJoin(roomId, carol, function (err) {
                                                  if (err) return done(err);
                                                  constellationRegistry.getRoomJoinRequestStatus(roomId, carol, function (err, rjStatus) {
                                                    if (err) return done(err);
                                                    check('requestRoomJoin creates a pending request', rjStatus === 'pending', rjStatus);

                                                    constellationRegistry.canJoinRoom(c4, room, carol, function (err, canJoinBefore) {
                                                      if (err) return done(err);
                                                      check('canJoinRoom is false before approval on a request-access room', canJoinBefore === false, canJoinBefore);

                                                      constellationRegistry.listPendingRoomJoinRequests(roomId, function (err, roomPending) {
                                                        if (err) return done(err);
                                                        check('listPendingRoomJoinRequests sees carol', roomPending.length === 1 && roomPending[0].did === carol, roomPending);

                                                        constellationRegistry.approveRoomJoinRequest(roomId, carol, function (err) {
                                                          if (err) return done(err);
                                                          constellationRegistry.canJoinRoom(c4, room, carol, function (err, canJoinAfter) {
                                                            if (err) return done(err);
                                                            check('canJoinRoom is true after approval', canJoinAfter === true, canJoinAfter);

                                                            constellationRegistry.declineRoomJoinRequest(roomId, bob, function (err) {
                                                              if (err) return done(err);
                                                              // bob never actually requested -- declining a
                                                              // nonexistent row should be a harmless no-op,
                                                              // not an error (same as SQLite's UPDATE-affecting-
                                                              // zero-rows behavior).
                                                              done(null);
                                                            });
                                                          });
                                                        });
                                                      });
                                                    });
                                                  });
                                                });
                                              });
                                            });
                                          });
                                        });
                                      });
                                    });
                                  });
                                });
                              });
                            });
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}
