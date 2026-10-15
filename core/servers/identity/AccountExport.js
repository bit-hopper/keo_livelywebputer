/**
 * core/servers/identity/AccountExport.js
 *
 * The .keo account export (settings.md §5a): everything the server holds for
 * an account, un-decrypted, as one streamed plain-tar archive.
 *
 * Delivery is two steps because a browser download link can carry the session
 * cookie but not a passkey assertion: the client posts a fresh assertion to
 * POST /@:handle/account/export-token, gets a token that is single-use,
 * short-lived and bound to the account's DID, and navigates to
 * GET /@:handle/account/export?token=… . Tokens live in Postgres rather than
 * process memory so a mint on one cluster worker can be redeemed on another,
 * and redemption is one atomic DELETE … RETURNING, so a token can never be used
 * twice even by two concurrent requests.
 *
 * Archive layout, in order (every entry is recorded in manifest.json, last):
 *   format.json                    {"format":"keo-account-export","version":1}
 *   README.txt
 *   did-document.json
 *   objects/<objId>/<nnnnnn>.json  every stored version of every object, oldest
 *                                  first, envelope verbatim (settings.md §4.9)
 *   blobs/<cid>                    every blob any version references
 *   files/<kind>/<handle>/…        legacy per-handle trees (users, uploads);
 *   files/<kind>/<handle>.jsonl    inbox / deliveries logs
 *   data/<table>.json              the account's rows in every other table
 *                                  (data/objects.json = per-version metadata)
 *   data/constellations.json       which constellations the account touches
 *   manifest.json                  counts + size and sha256 of every entry above
 */

'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var handleRegistry = require('./HandleRegistry');
var AccountData = require('./AccountData');
var TarWriter = require('./TarWriter').TarWriter;

var FORMAT = 'keo-account-export';
var VERSION = 1;
var TOKEN_TTL_MS = 60 * 1000;

// ─── single-use export tokens ─────────────────────────────────────────────────

var TOKEN_DDL =
  'CREATE TABLE IF NOT EXISTS account_export_tokens (' +
  '  token_hash TEXT PRIMARY KEY,' +
  '  did        TEXT NOT NULL,' +
  '  expires_at BIGINT NOT NULL' +
  ');';
var _tokenTable = false;

function _withTokenDB(thenDo) {
  handleRegistry.withDB(function (err, pool) {
    if (err) return thenDo(err);
    if (_tokenTable) return thenDo(null, pool);
    pool.query(TOKEN_DDL, function (err) {
      if (err) return thenDo(err);
      _tokenTable = true;
      thenDo(null, pool);
    });
  });
}

function _hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Calls thenDo(err, token). One outstanding token per account: minting
// replaces any earlier one.
function mintToken(did, thenDo) {
  _withTokenDB(function (err, pool) {
    if (err) return thenDo(err);
    var token = crypto.randomBytes(32).toString('base64url');
    var now = Date.now();
    // expired tokens are swept on every mint — no separate job
    pool.query('DELETE FROM account_export_tokens WHERE expires_at < $1 OR did = $2', [now, did], function (err) {
      if (err) return thenDo(err);
      pool.query(
        'INSERT INTO account_export_tokens (token_hash, did, expires_at) VALUES ($1, $2, $3)',
        [_hashToken(token), did, now + TOKEN_TTL_MS],
        function (err) { thenDo(err || null, err ? null : token); }
      );
    });
  });
}

// Atomically redeems a token for `did`. Calls thenDo(err, boolean); true at most
// once per token.
function consumeToken(token, did, thenDo) {
  if (!token || typeof token !== 'string') return thenDo(null, false);
  _withTokenDB(function (err, pool) {
    if (err) return thenDo(err);
    pool.query(
      'DELETE FROM account_export_tokens WHERE token_hash = $1 AND did = $2 AND expires_at > $3 RETURNING token_hash',
      [_hashToken(token), did, Date.now()],
      function (err, r) { thenDo(err || null, !err && r.rows.length === 1); }
    );
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function _seg(s) {
  // a path segment that can never contain "/" or be "." / ".."
  var out = String(s).replace(/[^A-Za-z0-9._-]/g, function (c) { return encodeURIComponent(c).replace(/%/g, '_'); });
  return /^\.+$/.test(out) ? '_' + out : out;
}

function _json(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function _jsonPretty(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

var README =
  'KEO ACCOUNT EXPORT\n' +
  '==================\n\n' +
  'This file is a plain, uncompressed tar archive. Open it with any tar tool:\n\n' +
  '    tar -xf <name>.keo\n\n' +
  'Contents (see manifest.json, the last entry, for a size and SHA-256 for every file):\n\n' +
  '  format.json         identifies this as a keo-account-export, version 1\n' +
  '  did-document.json   your DID document, including each device\'s wrapped key material\n' +
  '  objects/<id>/NNNNNN.json  every stored version of every object you own, oldest first,\n' +
  '                      exactly as the server holds it. Private and shared content is CIPHERTEXT.\n' +
  '                      (Postgres stores envelopes as JSONB, which reorders keys, so the bytes can\n' +
  '                      differ from what your browser originally sent; compare content hashes\n' +
  '                      with canonical JSON, not these raw bytes.)\n' +
  '  blobs/<cid>         file bytes your objects reference (ciphertext for private files)\n' +
  '  files/              legacy per-handle files, inbox and delivery logs\n' +
  '  data/               your rows in the server\'s other tables (friends, memberships, ...)\n\n' +
  'WHAT THIS FILE CANNOT CONTAIN\n' +
  '  * Your passkey and every private key. The keys that decrypt your private content are derived from\n' +
  '    your passkey when you use it and never exist on the server.\n' +
  '  * Direct-message history. It is stored only in the browsers you chatted from, not on the server.\n\n' +
  'READING PRIVATE CONTENT\n' +
  '  The ciphertext is only readable with the passkey that registered the account. Keep that passkey\n' +
  '  if you may want this data again; removing it makes the ciphertext permanently unreadable.\n';

function _walkFiles(root, thenDo) {
  // Regular files only (symlinks and specials are skipped). Returns [{abs, rel, size}] sorted by rel.
  var out = [];
  (function walk(dir, rel, done) {
    fs.readdir(dir, { withFileTypes: true }, function (err, entries) {
      if (err) return done();
      AccountData.series(entries.sort(function (a, b) { return a.name < b.name ? -1 : 1; }), function (e, next) {
        var abs = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) return walk(abs, r, function () { next(null); });
        if (!e.isFile()) return next(null);
        fs.stat(abs, function (err, st) {
          if (!err) out.push({ abs: abs, rel: r, size: st.size });
          next(null);
        });
      }, function () { done(); });
    });
  })(root, '', function () { thenDo(null, out); });
}

// ─── the export ───────────────────────────────────────────────────────────────

// opts: { did, handle, blobStore }; out: a Writable (the HTTP response).
// Calls thenDo(err, manifest). On error the archive is incomplete (it has no
// manifest.json) — the caller should destroy the output so the download fails.
function writeExport(opts, out, thenDo) {
  var did = opts.did, handle = opts.handle, blobStore = opts.blobStore;
  var tar = new TarWriter(out);
  var entries = [];
  var warnings = [];
  var counts = { objects: 0, versions: 0, blobs: 0, files: 0, tables: {} };

  // A path written twice would extract as only the last copy while the manifest
  // lists both hashes, so the archive would fail its own verification. Refuse.
  var usedPaths = {};
  function claim(name) {
    if (usedPaths[name]) return new Error('AccountExport: duplicate entry path ' + name);
    usedPaths[name] = true;
    return null;
  }

  function add(name, buf, cb) {
    var dup = claim(name);
    if (dup) return cb(dup);
    tar.addBuffer(name, buf, function (err, info) {
      if (err) return cb(err);
      entries.push({ path: name, size: info.size, sha256: info.sha256 });
      cb(null);
    });
  }
  function addStream(name, size, stream, cb) {
    var dup = claim(name);
    if (dup) { stream.destroy && stream.destroy(); return cb(dup); }
    tar.addStream(name, size, stream, function (err, info) {
      if (err) return cb(err);
      entries.push({ path: name, size: info.size, sha256: info.sha256 });
      cb(null);
    });
  }

  handleRegistry.withDB(function (err, pool) {
    if (err) return thenDo(err);

    var steps = [
      function formatAndReadme(next) {
        add('format.json', _json({ format: FORMAT, version: VERSION }), function (err) {
          if (err) return next(err);
          add('README.txt', Buffer.from(README, 'utf8'), next);
        });
      },

      function didDocument(next) {
        pool.query('SELECT document FROM did_documents WHERE did = $1', [did], function (err, r) {
          if (err) return next(err);
          var doc = null;
          try { doc = r.rows[0] ? JSON.parse(r.rows[0].document) : null; } catch (e) { warnings.push('did document was not valid JSON'); }
          if (!doc) { warnings.push('no DID document stored'); return next(null); }
          add('did-document.json', _jsonPretty(doc), next);
        });
      },

      // Every version of every object, in id order, in pages so a big account is never all in memory.
      function objects(next) {
        var perObj = {};
        var meta = [];
        (function page(afterId) {
          pool.query(
            'SELECT id, obj_id, cid, prev_cid, type, visibility, created_at, envelope FROM objects' +
            ' WHERE did = $1 AND id > $2 ORDER BY id LIMIT 50',
            [did, afterId],
            function (err, r) {
              if (err) return next(err);
              if (!r.rows.length) {
                counts.objects = Object.keys(perObj).length;
                counts.versions = meta.length;
                counts.tables.objects = meta.length;
                return add('data/objects.json', _jsonPretty(meta), next);
              }
              AccountData.series(r.rows, function (row, cb) {
                var n = (perObj[row.obj_id] = (perObj[row.obj_id] || 0) + 1);
                var name = 'objects/' + _seg(row.obj_id) + '/' + String(n).padStart(6, '0') + '.json';
                meta.push({ id: row.id, obj_id: row.obj_id, cid: row.cid, prev_cid: row.prev_cid, type: row.type,
                  visibility: row.visibility, created_at: row.created_at, path: name });
                add(name, _json(row.envelope), cb);
              }, function (err) {
                if (err) return next(err);
                page(r.rows[r.rows.length - 1].id);
              });
            }
          );
        })(0);
      },

      function blobs(next) {
        AccountData.blobCids(pool, did, function (err, cids) {
          if (err) return next(err);
          AccountData.series(cids, function (cid, cb) {
            blobStore.stat(cid, function (err, st) {
              if (err || !st) { warnings.push('blob ' + cid + ' is referenced but missing from the blob store'); return cb(null); }
              blobStore.get(cid, function (err, stream) {
                if (err || !stream) { warnings.push('blob ' + cid + ' could not be read'); return cb(null); }
                counts.blobs++;
                addStream('blobs/' + cid, st.size, stream, cb);
              });
            });
          }, next);
        });
      },

      function files(next) {
        AccountData.handlesFor(pool, did, function (err, handles) {
          if (err) return next(err);
          var names = handles.map(function (h) { return h.handle; });
          if (names.indexOf(handle) === -1) names.push(handle);
          AccountData.series(names, function (h, cb) {
            AccountData.series(AccountData.fileLocations(h), function (loc, cb2) {
              if (!loc.path) return cb2(null);
              function addFile(f, entryName, done) {
                fs.stat(f.abs, function (err, st) {
                  if (err || st.size !== f.size) { warnings.push('file ' + entryName + ' changed while exporting; skipped'); return done(null); }
                  counts.files++;
                  addStream(entryName, f.size, fs.createReadStream(f.abs), done);
                });
              }
              if (!loc.isDir) {
                return fs.stat(loc.path, function (err, st) {
                  if (err || !st.isFile()) return cb2(null);
                  addFile({ abs: loc.path, size: st.size }, 'files/' + loc.kind + '/' + _seg(h) + '.jsonl', cb2);
                });
              }
              _walkFiles(loc.path, function (e, list) {
                AccountData.series(list, function (f, cb3) {
                  addFile(f, 'files/' + loc.kind + '/' + _seg(h) + '/' + f.rel.split('/').map(_seg).join('/'), cb3);
                }, cb2);
              });
            }, cb);
          }, next);
        });
      },

      // The account's rows in every other table: DID-keyed rows plus the rows
      // hanging off its objects, deduplicated.
      function tables(next) {
        AccountData.objectIds(pool, did, function (err, objIds) {
          if (err) return next(err);
          var byTable = {};
          AccountData.DID_REFS.forEach(function (ref) {
            // objects has its own step (every version); constellations its own
            // (data/constellations.json is the account's relationship to them,
            // not whole rows with other people's member lists).
            if (ref.table === 'objects' || ref.table === 'constellations') return;
            (byTable[ref.table] = byTable[ref.table] || []).push({ column: ref.column, ids: [did], scalar: true });
          });
          AccountData.OBJECT_REFS.forEach(function (ref) {
            (byTable[ref.table] = byTable[ref.table] || []).push({ column: ref.column, ids: objIds, scalar: false });
          });
          var tableNames = Object.keys(byTable).sort();
          AccountData.series(tableNames, function (table, cb) {
            var seen = {}, rows = [];
            AccountData.series(byTable[table], function (ref, cb2) {
              if (!ref.scalar && !ref.ids.length) return cb2(null);
              var sql = ref.scalar
                ? 'SELECT * FROM "' + table + '" WHERE "' + ref.column + '" = $1'
                : 'SELECT * FROM "' + table + '" WHERE "' + ref.column + '" = ANY($1::text[])';
              pool.query(sql, [ref.scalar ? did : ref.ids], function (err, r) {
                if (err) return cb2(err);
                r.rows.forEach(function (row) {
                  var k = JSON.stringify(row);
                  if (!seen[k]) { seen[k] = true; rows.push(row); }
                });
                cb2(null);
              });
            }, function (err) {
              if (err) return cb(err);
              if (!rows.length) return cb(null);
              counts.tables[table] = rows.length;
              add('data/' + table + '.json', _jsonPretty(rows), cb);
            });
          }, next);
        });
      },

      function constellations(next) {
        pool.query(
          'SELECT name, did, created_by, created_at, visibility, strpos(members, $1) > 0 AS member,' +
          '  strpos(controllers, $1) > 0 AS controller, strpos(bots, $1) > 0 AS bot FROM constellations' +
          ' WHERE created_by = $2 OR strpos(members, $1) > 0 OR strpos(controllers, $1) > 0 OR strpos(bots, $1) > 0 ORDER BY name',
          [AccountData.jsonNeedle(did), did],
          function (err, r) {
            if (err) return next(err);
            var list = r.rows.map(function (c) {
              return { name: c.name, did: c.did, createdAt: c.created_at, visibility: c.visibility, createdByYou: c.created_by === did,
                member: !!c.member, controller: !!c.controller, bot: !!c.bot };
            });
            counts.tables.constellations = list.length;
            add('data/constellations.json', _jsonPretty(list), next);
          }
        );
      },
    ];

    AccountData.series(steps, function (step, next) { step(next); }, function (err) {
      if (err) return thenDo(err);
      var manifest = {
        format: FORMAT,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        handle: handle,
        did: did,
        counts: counts,
        warnings: warnings,
        entries: entries,
      };
      // manifest.json is last and not listed in its own `entries` (it can't contain its own hash)
      tar.addBuffer('manifest.json', _jsonPretty(manifest), function (err) {
        if (err) return thenDo(err);
        tar.finish(function (err) { thenDo(err || null, manifest); });
      });
    });
  });
}

function fileName(handle, date) {
  var d = (date || new Date()).toISOString().slice(0, 10);
  return handle + '-' + d + '.keo';
}

module.exports = {
  FORMAT: FORMAT,
  VERSION: VERSION,
  mintToken: mintToken,
  consumeToken: consumeToken,
  writeExport: writeExport,
  fileName: fileName,
};
