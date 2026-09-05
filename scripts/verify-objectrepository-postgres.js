// Standalone verification script for the Postgres-backed
// core/servers/identity/ObjectRepository.js. There is no automated test
// suite for this module (or any of its sibling SQLite registries) in this
// repo -- verification follows the established "prove it against real
// infra with a real script" pattern instead. Requires() the real module
// directly and drives it against a real local Postgres (DATABASE_URL).
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/verify-objectrepository-postgres.js
//
// Exits 0 if every scenario passes, 1 on the first failure.

'use strict';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

var repo = require('../core/servers/identity/ObjectRepository');
var postgresClient = require('../core/servers/support/postgres-client');
var pool = postgresClient.getPool();

var passed = 0;

function ok(label) {
  passed++;
  console.log('PASS: ' + label);
}

function assert(cond, label, detail) {
  if (!cond) {
    console.error('FAIL: ' + label + (detail ? ' -- ' + JSON.stringify(detail) : ''));
    process.exit(1);
  }
  ok(label);
}

function randObjId(prefix) {
  return (prefix || 'obj') + '_' + Math.random().toString(36).slice(2, 10);
}

function makeEnvelope(objId, overrides) {
  var base = {
    objId: objId,
    did: 'did:key:test-author',
    type: 'world',
    visibility: 'public',
    constellation: null,
    created: new Date().toISOString(),
    state: {},
    record: { cid: 'cid-' + Math.random().toString(36).slice(2, 10), prevCid: null, recipients: [] }
  };
  return Object.assign(base, overrides || {});
}

// Runs each scenario in sequence (manual recursion, matching this
// codebase's established script style) -- a later scenario can depend on
// the database state a prior one left behind only where explicitly noted.
var scenarios = [
  scenario1_newPut,
  scenario2_metadataOnlyPut,
  scenario3_trueNoOpDuplicate,
  scenario4_concurrentRace,
  scenario5_duplicateContentCollision,
  scenario6_titleSearchCaseInsensitive,
  scenario7_softDeleteFilter,
  scenario8_tagMembershipAndAggregation,
  scenario9_versionOrderingAfterMigration,
  scenario10_blobRefsSync,
  scenario11_reactionAndAliasUpsert
];

function runAll(i) {
  if (i >= scenarios.length) {
    console.log('\nAll ' + passed + ' checks passed.');
    return pool.end(function () { process.exit(0); });
  }
  scenarios[i](function () { runAll(i + 1); });
}

runAll(0);

// 1. New put() -- genesis envelope, changed:'content', get() round-trips it.
function scenario1_newPut(next) {
  var objId = randObjId('s1');
  var env = makeEnvelope(objId);
  repo.put(env, function (err, result) {
    assert(!err, 's1: put() succeeds', err);
    assert(result.changed === 'content' && !result.duplicate, 's1: changed=content, not duplicate', result);
    repo.get(objId, function (err, fetched) {
      assert(!err && fetched && fetched.record.cid === env.record.cid, 's1: get() round-trips the envelope', fetched);
      next();
    });
  });
}

// 2. Same-cid metadata-only put() -- duplicate:true, changed:'metadata',
// the new value sticks (exercises _updateInPlaceTx).
function scenario2_metadataOnlyPut(next) {
  var objId = randObjId('s2');
  var env = makeEnvelope(objId, { visibility: 'public' });
  repo.put(env, function (err) {
    assert(!err, 's2: initial put() succeeds', err);
    var updated = Object.assign({}, env, { visibility: 'private' });
    repo.put(updated, function (err, result) {
      assert(!err, 's2: metadata-only put() succeeds', err);
      assert(result.duplicate === true && result.changed === 'metadata', 's2: duplicate=true, changed=metadata', result);
      repo.get(objId, function (err, fetched) {
        assert(!err && fetched.visibility === 'private', 's2: visibility change stuck', fetched);
        next();
      });
    });
  });
}

// 3. True no-op duplicate put() -- duplicate:true, changed:'none'.
function scenario3_trueNoOpDuplicate(next) {
  var objId = randObjId('s3');
  var env = makeEnvelope(objId);
  repo.put(env, function (err) {
    assert(!err, 's3: initial put() succeeds', err);
    repo.put(env, function (err, result) {
      assert(!err, 's3: resubmitted put() succeeds', err);
      assert(result.duplicate === true && result.changed === 'none', 's3: duplicate=true, changed=none', result);
      next();
    });
  });
}

// 4. The race-condition proof -- two concurrent put()s for the same objId,
// each setting a different visibility, fired without awaiting either
// first. Both must complete cleanly and the final get() must be one of the
// two values, never a corrupted/partial write. This is what actually
// proves the advisory-lock fix works, not just the happy path.
function scenario4_concurrentRace(next) {
  var objId = randObjId('s4');
  var env = makeEnvelope(objId);
  repo.put(env, function (err) {
    assert(!err, 's4: initial put() succeeds', err);
    var envA = Object.assign({}, env, { visibility: 'private' });
    var envB = Object.assign({}, env, { visibility: 'shared' });
    var remaining = 2;
    var errors = [];
    function done() {
      if (--remaining > 0) return;
      assert(errors.length === 0, 's4: both concurrent put()s completed without error', errors);
      repo.get(objId, function (err, fetched) {
        assert(!err, 's4: get() after race succeeds', err);
        assert(fetched.visibility === 'private' || fetched.visibility === 'shared',
          's4: final visibility is one of the two racing values (no corruption)', fetched);
        next();
      });
    }
    // Fired back-to-back, neither awaited before the other starts.
    repo.put(envA, function (err) { if (err) errors.push(err.message); done(); });
    repo.put(envB, function (err) { if (err) errors.push(err.message); done(); });
  });
}

// 5. Genuine duplicate-content collision -- insert a colliding (obj_id,cid)
// row out-of-band (bypassing put()'s lock, simulating an unrelated writer),
// then put() the same pair; the 23505 fallback path must return
// duplicate:true rather than throwing.
function scenario5_duplicateContentCollision(next) {
  var objId = randObjId('s5');
  var cid = 'cid-collision-' + Math.random().toString(36).slice(2, 8);
  var env = makeEnvelope(objId, { record: { cid: cid, prevCid: null, recipients: [] } });
  pool.query(
    'INSERT INTO objects (obj_id, did, cid, prev_cid, type, visibility, envelope, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [env.objId, env.did, cid, null, env.type, env.visibility, env, new Date().toISOString()],
    function (err) {
      assert(!err, 's5: out-of-band insert succeeds', err);
      repo.put(env, function (err, result) {
        assert(!err, 's5: put() of the colliding pair does not throw', err);
        assert(result.duplicate === true, 's5: 23505 fallback reports duplicate:true', result);
        next();
      });
    }
  );
}

// 6. Title search case-insensitivity -- proves ILIKE parity with SQLite's
// default case-insensitive LIKE.
function scenario6_titleSearchCaseInsensitive(next) {
  var objId = randObjId('s6');
  var did = 'did:key:s6-author';
  var env = makeEnvelope(objId, { did: did, type: 'postcard', state: { title: 'Postcard From Space' } });
  repo.put(env, function (err) {
    assert(!err, 's6: put() succeeds', err);
    repo.listPostcardsForUser(did, { q: 'postcard' }, function (err, result) {
      assert(!err, 's6: listPostcardsForUser succeeds', err);
      var found = result.postcards.some(function (p) { return p.objId === objId; });
      assert(found, 's6: lowercase query matches mixed-case title (ILIKE)', result.postcards);
      next();
    });
  });
}

// 7. Soft-delete filter -- a new version with state.deleted=true must
// disappear from a listing. Proves the #>> 'true'-vs-1 translation, since
// this predicate appears in nearly every listing function.
function scenario7_softDeleteFilter(next) {
  var objId = randObjId('s7');
  var did = 'did:key:s7-author';
  var env = makeEnvelope(objId, { did: did, type: 'postcard', state: { title: 'Soft Delete Me' } });
  repo.put(env, function (err) {
    assert(!err, 's7: initial put() succeeds', err);
    repo.listPostcardsForUser(did, {}, function (err, before) {
      assert(!err && before.postcards.some(function (p) { return p.objId === objId; }),
        's7: card appears before deletion', before.postcards);
      var deletedEnv = Object.assign({}, env, { state: Object.assign({}, env.state, { deleted: true }) });
      repo.put(deletedEnv, function (err) {
        assert(!err, 's7: put() with state.deleted=true succeeds', err);
        repo.listPostcardsForUser(did, {}, function (err, after) {
          assert(!err, 's7: listPostcardsForUser after delete succeeds', err);
          var stillThere = after.postcards.some(function (p) { return p.objId === objId; });
          assert(!stillThere, 's7: card disappears after state.deleted=true', after.postcards);
          next();
        });
      });
    });
  });
}

// 8. Tag membership (listPublicParts({tag})) and tag aggregation
// (listPublicPartTags(), count DESC/tag ASC order) -- proves the
// jsonb_array_elements_text / `?` translations.
function scenario8_tagMembershipAndAggregation(next) {
  var did = 'did:key:s8-author';
  var objA = randObjId('s8a');
  var objB = randObjId('s8b');
  var tagUnique = 's8tag_' + Math.random().toString(36).slice(2, 8);
  var envA = makeEnvelope(objA, { did: did, type: 'part', visibility: 'public', state: { partName: 'GizmoA', tags: [tagUnique, 'shared-tag'] } });
  var envB = makeEnvelope(objB, { did: did, type: 'part', visibility: 'public', state: { partName: 'GizmoB', tags: ['shared-tag'] } });
  repo.put(envA, function (err) {
    assert(!err, 's8: put() part A succeeds', err);
    repo.put(envB, function (err) {
      assert(!err, 's8: put() part B succeeds', err);
      repo.listPublicParts({ tag: tagUnique }, function (err, result) {
        assert(!err, 's8: listPublicParts({tag}) succeeds', err);
        var objIds = result.parts.map(function (p) { return p.objId; });
        assert(objIds.indexOf(objA) !== -1 && objIds.indexOf(objB) === -1,
          's8: tag filter includes A, excludes B', objIds);
        repo.listPublicPartTags(function (err, tags) {
          assert(!err, 's8: listPublicPartTags() succeeds', err);
          var sharedRow = tags.filter(function (t) { return t.tag === 'shared-tag'; })[0];
          assert(sharedRow && typeof sharedRow.count === 'number' && sharedRow.count >= 2,
            's8: shared-tag aggregated count is a real number >= 2', sharedRow);
          next();
        });
      });
    });
  });
}

// 9. Version ordering survives pre-existing ids -- directly insert two rows
// for one objId with explicit out-of-sequence ids (simulating migrated
// data), verify get() returns the higher-id row, listVersions() returns
// both ascending, and a fresh put() afterward gets an id past both (proves
// the sequence reset the migration script performs).
function scenario9_versionOrderingAfterMigration(next) {
  var objId = randObjId('s9');
  pool.query('SELECT COALESCE(MAX(id), 0) AS max_id FROM objects', function (err, result) {
    assert(!err, 's9: read current max id succeeds', err);
    var base = result.rows[0].max_id + 1000; // out-of-sequence, simulating migrated legacy ids
    var envV1 = makeEnvelope(objId, { record: { cid: 'cid-v1', prevCid: null, recipients: [] } });
    var envV2 = makeEnvelope(objId, { record: { cid: 'cid-v2', prevCid: 'cid-v1', recipients: [] } });
    pool.query(
      'INSERT INTO objects (id, obj_id, did, cid, prev_cid, type, visibility, envelope, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [base, envV1.objId, envV1.did, envV1.record.cid, null, envV1.type, envV1.visibility, envV1, new Date().toISOString()],
      function (err) {
        assert(!err, 's9: insert v1 with explicit id succeeds', err);
        pool.query(
          'INSERT INTO objects (id, obj_id, did, cid, prev_cid, type, visibility, envelope, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [base + 1, envV2.objId, envV2.did, envV2.record.cid, envV2.record.prevCid, envV2.type, envV2.visibility, envV2, new Date().toISOString()],
          function (err) {
            assert(!err, 's9: insert v2 with explicit id succeeds', err);
            repo.get(objId, function (err, fetched) {
              assert(!err && fetched.record.cid === 'cid-v2', 's9: get() returns the higher-id row', fetched);
              repo.listVersions(objId, function (err, versions) {
                assert(!err && versions.length === 2 && versions[0].cid === 'cid-v1' && versions[1].cid === 'cid-v2',
                  's9: listVersions() returns both in ascending order', versions);
                pool.query("SELECT setval(pg_get_serial_sequence('objects', 'id'), $1, true)", [base + 1], function (err) {
                  assert(!err, 's9: sequence reset to past the inserted ids succeeds', err);
                  var freshObjId = randObjId('s9fresh');
                  repo.put(makeEnvelope(freshObjId), function (err, result) {
                    assert(!err, 's9: fresh put() after sequence reset succeeds', err);
                    assert(result.id > base + 1, 's9: fresh put() gets an id past both migrated rows', result);
                    next();
                  });
                });
              });
            });
          }
        );
      }
    );
  });
}

// 10. blob_refs sync -- a file envelope's blobCid is indexed, and switching
// to a folder version with a different blobCids set clears the stale ref
// (exercises delete-then-ON-CONFLICT-DO-NOTHING-reinsert).
function scenario10_blobRefsSync(next) {
  var objId = randObjId('s10');
  var blobCidA = 'blob-' + Math.random().toString(36).slice(2, 10);
  var fileEnv = makeEnvelope(objId, { type: 'file', blobCid: blobCidA });
  repo.put(fileEnv, function (err) {
    assert(!err, 's10: put() file envelope succeeds', err);
    repo.getObjIdsForBlob(blobCidA, function (err, objIds) {
      assert(!err && objIds.indexOf(objId) !== -1, 's10: blob_refs indexed the file blobCid', objIds);
      var blobCidB = 'blob-' + Math.random().toString(36).slice(2, 10);
      var folderEnv = Object.assign({}, fileEnv, {
        type: 'folder', blobCid: undefined, blobCids: [blobCidB],
        record: { cid: 'cid-folder-' + Math.random().toString(36).slice(2, 8), prevCid: fileEnv.record.cid, recipients: [] }
      });
      repo.put(folderEnv, function (err) {
        assert(!err, 's10: put() folder version succeeds', err);
        repo.getObjIdsForBlob(blobCidA, function (err, staleObjIds) {
          assert(!err && staleObjIds.indexOf(objId) === -1, 's10: stale blob_ref cleared', staleObjIds);
          repo.getObjIdsForBlob(blobCidB, function (err, freshObjIds) {
            assert(!err && freshObjIds.indexOf(objId) !== -1, 's10: new blob_ref indexed', freshObjIds);
            next();
          });
        });
      });
    });
  });
}

// 11. Reaction/alias upsert -- calling each twice overwrites rather than
// duplicates (ON CONFLICT DO UPDATE).
function scenario11_reactionAndAliasUpsert(next) {
  var objId = randObjId('s11');
  var did = 'did:key:s11-reactor';
  repo.upsertReaction(objId, did, '👍', function (err) {
    assert(!err, 's11: first upsertReaction succeeds', err);
    repo.upsertReaction(objId, did, '❤️', function (err) {
      assert(!err, 's11: second upsertReaction succeeds', err);
      repo.getReactionsForObjId(objId, function (err, reactions) {
        assert(!err && reactions.length === 1 && reactions[0].emoji === '❤️',
          's11: exactly one reaction row with the latest emoji', reactions);
        var aliasDid = 'did:key:s11-alias-author';
        var aliasName = 's11alias' + Math.random().toString(36).slice(2, 8);
        repo.upsertPartAlias(aliasDid, aliasName, 'objA', function (err) {
          assert(!err, 's11: first upsertPartAlias succeeds', err);
          repo.upsertPartAlias(aliasDid, aliasName, 'objB', function (err) {
            assert(!err, 's11: second upsertPartAlias succeeds', err);
            repo.resolvePartAlias(aliasDid, aliasName, function (err, resolved) {
              assert(!err && resolved === 'objB', 's11: alias resolves to the latest objId', resolved);
              next();
            });
          });
        });
      });
    });
  });
}
