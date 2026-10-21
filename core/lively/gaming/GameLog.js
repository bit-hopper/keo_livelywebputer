/**
 * lively.gaming.GameLog
 *
 * The data layer of the Gaming world template: one signed envelope per game in a
 * person's library (type 'gamelog'). No morphs in here, so everything can be driven
 * and tested without a world. The template's views (LibraryView, GameDialogs) talk
 * only to this module and never build an envelope themselves.
 *
 * An ENTRY, as handed to callers, is a plain object:
 *   { objId, did, visibility, envelope, payload }
 * where `payload` is the decrypted game record (see defaults()), `envelope` is the
 * latest stored version (kept so the next save can chain on its cid) and
 * `visibility` is 'private' | 'public'.
 *
 * How an entry is stored:
 *   - PRIVATE: the payload is encrypted with a fresh one-time key (DEK); the DEK is
 *     wrapped under the account's KEK (record.wrappedDek). The server stores
 *     ciphertext and can read nothing about the game, not even its title.
 *   - PUBLIC: the payload is stored as plain JSON, readable by anyone.
 *   Friends / lists / specific people (recipients sealed per person) are not built
 *   yet: opening an entry that is sealed to someone else needs the account's X25519
 *   key and the audience machinery, which is a later step. Until then such entries
 *   are counted as `hidden` in list() and skipped.
 * `state` (the part of an envelope the server can read) carries only
 * { kind: 'gamelog' } and, once removed, { deleted: true }. NEVER put a title or any
 * other game detail in `state`: that is exactly what the encryption is there to hide.
 *
 * `updated_at` is bumped on EVERY write, including deletes and visibility changes.
 * This is not cosmetic: the server de-duplicates a version by (objId, cid), and the
 * cid is a hash of the payload, so a save that happens to reproduce an earlier
 * payload (toggle a rating up and back down) would be silently dropped as "already
 * stored" while still reporting success. A timestamp makes every payload unique.
 * (Private writes also differ by their fresh DEK and nonce, but do not rely on that
 * for public ones.)
 *
 * Public entry points (all asynchronous, callback style thenDo(err, result)):
 *   create(fields, visibility, thenDo)   -> entry
 *   save(entry, changes, thenDo)         -> entry   (changes: payload fields, plus
 *                                           optionally { visibility })
 *   remove(entry, thenDo)                -> entry   (soft delete)
 *   list(handle, opts, thenDo)           -> { entries, hidden }   (all pages)
 *   open(envelope, thenDo)               -> entry or null (null: cannot be opened here)
 */

module("lively.gaming.GameLog")
  .requires(
    "lively.identity.Crypto",
    "lively.identity.DID",
    "lively.identity.WebAuthn",
    "lively.identity.WebKey",
    "lively.identity.EnvelopeSigning",
  )
  .toRun(function () {

    // The five shelves a game can sit on. Order is the display order everywhere.
    var STATUSES = ["playing", "backlog", "completed", "dropped", "wishlist"];

    // Entries per request when reading a library. The server caps a page at 200.
    var PAGE_SIZE = 100;

    Object.extend(lively.gaming.GameLog, {

      STATUSES: STATUSES,

      // A complete payload with every field present, so views never test for
      // undefined. `fields` overrides the defaults. Field names are snake_case on
      // purpose (they follow the library's own spec, not the camelCase the older
      // templates use). `playtime_minutes` is the number an import supplied;
      // `manual_playtime_minutes` is what the person typed. They are separate so an
      // import never overwrites a value typed by hand and vice versa.
      defaults: function (fields) {
        return Object.assign({
          title: "", year: null, genre: null, studio: null,
          cover_url: null, cover_source: null,       // 'igdb' | 'steam' | 'itch' | null
          igdb_id: null,
          external_ids: {},                          // e.g. { steam: "570" }, the import de-dupe keys
          platforms: [],
          status: "backlog",                         // one of STATUSES
          rating: 0,                                 // 0 = not rated, else 1 to 5
          review: "",
          playtime_minutes: null, playtime_source: null,   // 'steam' | 'manual' | null
          manual_playtime_minutes: null,
          last_synced_at: null, last_played_at: null,
          share_playtime: false,
          last_activity: { kind: "added", at: new Date().toISOString() },
          updated_at: new Date().toISOString(),
        }, fields || {});
      },

      // The playtime to SHOW for an entry, and where it came from. A value an import
      // supplied wins; otherwise the typed one. Returns { minutes, source } with
      // minutes null when there is nothing to show. Playtime is never shown without
      // its source, which is why this returns both.
      playtimeOf: function (payload) {
        if (payload.playtime_minutes != null) return { minutes: payload.playtime_minutes, source: payload.playtime_source || "steam" };
        if (payload.manual_playtime_minutes != null) return { minutes: payload.manual_playtime_minutes, source: "manual" };
        return { minutes: null, source: null };
      },

      // ─── reading ───────────────────────────────────────────────────────────

      // Turns a stored envelope into an entry, decrypting a private one with the
      // account's key. Calls thenDo(null, entry), or thenDo(null, null) when the
      // envelope is valid but cannot be opened HERE (sealed to other people, or a
      // private entry belonging to someone else), or thenDo(err) when it is broken
      // (the stored cid does not match the stored payload, or decryption fails).
      open: function (envelope, thenDo) {
        var self = this, c = lively.identity.crypto;
        if (!envelope || !envelope.record || !envelope.objId) return thenDo(new Error("GameLog.open: not an envelope"));
        var rec = envelope.record;
        var vis = envelope.visibility || "public";
        function done(payload) {
          thenDo(null, { objId: envelope.objId, did: envelope.did, visibility: vis, envelope: envelope, payload: self.defaults(payload) });
        }
        if (!rec.wrappedDek) {                              // public: the payload is the plain record
          if (!rec.payload || typeof rec.payload !== "object") return thenDo(new Error("GameLog.open: empty payload"));
          return done(rec.payload);
        }
        var user = lively.identity.did.currentUser();
        if (!user || user.did !== envelope.did) return thenDo(null, null);   // sealed to someone else's key
        // The cid is a hash of the ciphertext: check it before trusting anything inside.
        c.computeCid(rec.payload, function (err, cid) {
          if (err) return thenDo(err);
          if (cid !== rec.cid) return thenDo(new Error("GameLog.open: cid mismatch for " + envelope.objId));
          self._kek(user, function (err, kek) {
            if (err) return thenDo(err);
            c.unwrapDek(rec.wrappedDek, kek, function (err, dek) {
              if (err) return thenDo(err);
              c.decryptPayload(rec.payload, rec.nonce, dek, function (err, payload) {
                if (err) return thenDo(err);
                done(payload);
              });
            });
          });
        });
      },

      // Every entry of `handle`'s library that the signed-in person (or an
      // anonymous visitor) may read, fetched page by page. The server decides what is
      // visible (owner: everything not deleted; others: public entries and ones sealed
      // to them), so this simply opens what comes back.
      //   opts.onPage(entriesSoFar)  optional, called after each page so a large
      //                              library can start painting before it is all in
      // Calls thenDo(null, { entries, hidden }); `hidden` counts envelopes that were
      // returned but cannot be opened here (see the header). Entries are newest first.
      list: function (handle, opts, thenDo) {
        var self = this;
        opts = opts || {};
        var entries = [], hidden = 0;
        (function page(cursor) {
          var url = "/@" + handle + "/games?limit=" + PAGE_SIZE + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
          fetch(url, { credentials: "include", headers: { Accept: "application/json" } })
            .then(function (res) {
              if (!res.ok) throw new Error("GameLog.list: HTTP " + res.status);
              return res.json();
            })
            .then(function (body) {
              var envs = body.games || [], i = 0;
              (function next() {
                if (i >= envs.length) {
                  if (opts.onPage) opts.onPage(entries.slice());
                  return body.cursor ? page(body.cursor) : thenDo(null, { entries: entries, hidden: hidden });
                }
                self.open(envs[i++], function (err, entry) {
                  if (err) { hidden++; console.warn("[GameLog] skipped an unreadable entry:", err.message); }
                  else if (entry) entries.push(entry);
                  else hidden++;
                  next();
                });
              })();
            })
            .catch(function (err) { thenDo(err); });
        })(null);
      },

      // ─── writing ───────────────────────────────────────────────────────────

      // Adds a game to the signed-in person's library.
      //   fields      payload fields (merged over defaults(); title is required)
      //   visibility  'private' (the default) or 'public'
      // Calls thenDo(null, entry).
      create: function (fields, visibility, thenDo) {
        var self = this, user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error("GameLog.create: nobody is signed in"));
        if (!fields || !String(fields.title || "").trim()) return thenDo(new Error("GameLog.create: a game needs a title"));
        var payload = this.defaults(fields);
        payload.updated_at = new Date().toISOString();
        lively.identity.webKey.generateGenesisObjId(user.did, function (err, gen) {
          if (err) return thenDo(err);
          self._write(user, { objId: gen.objId, genesisNonce: gen.genesisNonce, created: new Date().toISOString(),
            prevCid: null, payload: payload, visibility: visibility || "private", deleted: false }, thenDo);
        });
      },

      // Applies `changes` to an entry and stores a new version. `changes` is a patch
      // over the payload; the special key `visibility` (not a payload field) moves
      // the entry between private and public, re-sealing or un-sealing it. Only the
      // owner can save. Calls thenDo(null, entry) with the entry as now stored; the
      // caller's old entry object is left untouched.
      save: function (entry, changes, thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user || user.did !== entry.did) return thenDo(new Error("GameLog.save: only the owner can change an entry"));
        changes = Object.assign({}, changes);
        var visibility = changes.visibility || entry.visibility;
        delete changes.visibility;
        var payload = Object.assign({}, entry.payload, changes, { updated_at: new Date().toISOString() });
        this._write(user, { objId: entry.objId, created: entry.envelope.created,
          prevCid: entry.envelope.record.cid, payload: payload, visibility: visibility, deleted: false }, thenDo);
      },

      // Soft delete: the store is append-only, so a removal is a new version flagged
      // state.deleted, which the listing then leaves out. The payload is kept in that
      // last version (a library cannot truly forget a game it has stored; say so
      // honestly if a "delete" button ever promises otherwise). Calls thenDo(null, entry).
      remove: function (entry, thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user || user.did !== entry.did) return thenDo(new Error("GameLog.remove: only the owner can remove an entry"));
        var payload = Object.assign({}, entry.payload, { updated_at: new Date().toISOString() });
        this._write(user, { objId: entry.objId, created: entry.envelope.created,
          prevCid: entry.envelope.record.cid, payload: payload, visibility: entry.visibility, deleted: true }, thenDo);
      },

      // ─── internals ─────────────────────────────────────────────────────────

      // The account's key-encryption key. deriveKek answers from its per-session cache
      // when it can (one passkey prompt per session, not one per write). The rpId must
      // be passed explicitly: left out, it falls back to the configured production
      // domain and the ceremony fails on any other host (CLAUDE.md, Playwright notes).
      _kek: function (user, thenDo) {
        var ch = new Uint8Array(32);
        crypto.getRandomValues(ch);
        lively.identity.webAuthn.deriveKek({ credentialId: user.credentialId, rpId: user.rpId || window.location.hostname, challenge: ch }, thenDo);
      },

      // Builds, signs and stores one version.
      //   p: { objId, genesisNonce?, created, prevCid, payload, visibility, deleted }
      // Calls thenDo(null, entry) once the server has accepted it.
      _write: function (user, p, thenDo) {
        var self = this, c = lively.identity.crypto;
        var visibility = p.visibility === "public" ? "public" : "private";
        var state = p.deleted ? { kind: "gamelog", deleted: true } : { kind: "gamelog" };

        function finish(record) {
          var envelope = { objId: p.objId, did: user.did, type: "gamelog", visibility: visibility, created: p.created, record: record, state: state };
          if (p.genesisNonce) envelope.genesisNonce = p.genesisNonce;
          lively.identity.envelopeSigning.signEnvelopeIfPossible(envelope, user, c, function (err, signed) {
            if (err) return thenDo(err);
            var toSend = signed || envelope;
            self._put(user.handle, toSend, function (err) {
              if (err) return thenDo(err);
              thenDo(null, { objId: toSend.objId, did: user.did, visibility: visibility, envelope: toSend, payload: self.defaults(p.payload) });
            });
          });
        }

        if (visibility === "public") {
          c.computeCid(p.payload, function (err, cid) {
            if (err) return thenDo(err);
            finish({ cid: cid, prevCid: p.prevCid, payload: p.payload, nonce: null, wrappedDek: null, recipients: [] });
          });
          return;
        }
        this._kek(user, function (err, kek) {
          if (err) return thenDo(err);
          c.wrapDek(kek, function (err, dekResult) {
            if (err) return thenDo(err);
            c.encryptPayload(p.payload, dekResult.dek, function (err, enc) {
              if (err) return thenDo(err);
              c.computeCid(enc.ciphertext, function (err, cid) {
                if (err) return thenDo(err);
                finish({ cid: cid, prevCid: p.prevCid, payload: enc.ciphertext, nonce: enc.nonce, wrappedDek: dekResult.wrappedDek, recipients: [] });
              });
            });
          });
        });
      },

      // PUT an envelope. A non-2xx answer becomes an Error carrying the status and
      // whatever message the server gave (never the envelope, which holds ciphertext).
      _put: function (handle, envelope, thenDo) {
        fetch("/@" + handle + "/" + envelope.objId, {
          method: "PUT", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(envelope),
        }).then(function (res) {
          if (res.ok) return thenDo(null);
          return res.text().then(function (t) {
            var e = new Error("GameLog: the server refused the save (HTTP " + res.status + ") " + String(t).slice(0, 160));
            e.status = res.status;
            thenDo(e);
          });
        }).catch(function (err) { thenDo(err); });
      },
    });
  }); // end module('lively.gaming.GameLog')
