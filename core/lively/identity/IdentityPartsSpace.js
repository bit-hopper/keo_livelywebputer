module("lively.identity.IdentityPartsSpace")
  .requires(
    "lively.PartsBin",
    "lively.identity.ObjectStore",
    "lively.identity.DID",
    "lively.identity.PartSerializer",
  )
  .toRun(function () {

    // ─── IdentityPartItem ─────────────────────────────────────────────────────
    //
    // PartItem subclass whose loadPart reads from a pre-cached envelope
    // (set by IdentityPartsSpace.createPartItemFromEnvelope) instead of
    // issuing WebDAV HEAD/GET requests.
    //
    // The PartsBin UI calls loadPart(isAsync, optCached, rev, cb). We ignore
    // all those flags — the envelope payload is always available synchronously.

    lively.PartsBin.PartItem.subclass("lively.identity.IdentityPartItem",
      "loading",
      {
        loadPart: function (isAsync, optCached, rev, cb) {
          var self = this;
          var envelope = this.envelope;

          if (!envelope || !envelope.record || !envelope.record.payload) {
            var err = new Error("[IdentityPartItem] No envelope payload for: " + this.name);
            console.warn(err.message);
            if (cb) cb(err);
            return this;
          }

          function _apply(err, json) {
            if (err) {
              console.error("[IdentityPartItem] loadPart failed for " + self.name + ":", err);
              if (cb) cb(err);
              return;
            }
            var metaInfo = self.loadedMetaInfo;
            var cid = envelope.record.cid;
            try {
              // setPartFromJSON(json, metaInfo, rev) requires metaInfo to have
              // lastModifiedDate set — our createPartItemFromEnvelope ensures this.
              self.setPartFromJSON(json, metaInfo, cid);
            } catch (e) {
              console.error("[IdentityPartItem] loadPart failed for " + self.name + ":", e);
              if (cb) cb(e);
              return;
            }
            if (cb) cb(null, self.part);
          }

          if (envelope.visibility === "public") {
            // Historically record.payload was stringified/re-stringified
            // inline here rather than through PartSerializer — kept
            // equivalent so already-published public parts need no migration.
            var payload = envelope.record.payload;
            var json = typeof payload === "string" ? payload : JSON.stringify(payload);
            _apply(null, json);
          } else {
            lively.identity.partSerializer.deserializeEncrypted(envelope, function (err, json) {
              _apply(err, json);
            });
          }

          return this;
        },
      },

      "versioning",
      {
        // Override of PartItem.loadPartVersions (core/lively/PartsBin.js) —
        // the base implementation queries lively.store.ObjectRepository,
        // a WebDAV-backed version log identity parts were never written
        // through, so it can only ever come back empty for one of these.
        // Real version history lives in the identity ObjectRepository
        // (server-side, SQLite) and is already exposed at
        // GET /@:handle/:objId/versions — this fetches that and reshapes
        // it into the {date, author, version} entries the PartsBinBrowser's
        // formatVersionEntry/setSelectedPartVersions already expect, so the
        // existing "partVersions" binding (wired in setSelectedPartItem
        // before this is called) needs no changes on the browser side.
        loadPartVersions: function (isAsync) {
          var self = this;
          var envelope = this.envelope;
          var space = this.getPartsSpace();
          var handle = space && space.handle;
          if (!envelope || !envelope.objId || !handle ||
              typeof lively === "undefined" || !lively.identity || !lively.identity.did) {
            this.partVersions = [];
            return this;
          }

          var base = lively.identity.did.baseUrl();
          var url = base + "/@" + encodeURIComponent(handle) + "/" +
            encodeURIComponent(envelope.objId) + "/versions";
          var xhr = new XMLHttpRequest();
          xhr.open("GET", url, true);
          xhr.setRequestHeader("Accept", "application/json");
          xhr.withCredentials = true;
          xhr.onload = function () {
            if (xhr.status !== 200) { self.partVersions = []; return; }
            var data;
            try { data = JSON.parse(xhr.responseText); }
            catch (e) { self.partVersions = []; return; }
            self.partVersions = (data.versions || []).map(function (v) {
              return { date: v.createdAt, author: "@" + handle, version: v.cid.slice(0, 8) };
            });
          };
          xhr.onerror = function () { self.partVersions = []; };
          xhr.send();
          return this;
        },

        // Override of PartItem.loadPartMetaInfo — metaInfo (comment, tags,
        // partName, etc.) was already populated synchronously from the
        // envelope by IdentityPartsSpace.createPartItemFromEnvelope, so
        // there is nothing to fetch here. Without this override, the base
        // implementation would still fire a WebDAV ObjectRepository query
        // for a path identity parts were never written through (guarded
        // against crashing, per the existing "IDENTITY: pre-existing bug"
        // comment in PartsBin.js, but a wasted round-trip on every select).
        //
        // Re-firing the (unchanged) value below is not a no-op, despite
        // looking like one: PartsBinBrowser.setSelectedItem wires up
        // Global.connect(item, 'loadedMetaInfo', ...) *after* this item was
        // already constructed with loadedMetaInfo set, so the connection's
        // listener (setMetaInfoOfSelectedItem, which populates the comment
        // panel) has never seen a value yet — the underlying lively.bindings
        // connection setter fires on every assignment regardless of whether
        // the value actually changed (no equality check), so a same-value
        // reassignment here is exactly what the base class's real network
        // round-trip was standing in for.
        loadPartMetaInfo: function (isAsync, rev) {
          var self = this;
          if (this.loadedMetaInfo) {
            (function () { self.loadedMetaInfo = self.loadedMetaInfo; }).delay(0);
          }
          return this;
        },
      },
    );

    // ─── IdentityPartsSpace ───────────────────────────────────────────────────
    //
    // PartsSpace subclass backed by the identity ObjectStore (IndexedDB)
    // rather than WebDAV. The PartsBin UI calls getURL(), load(),
    // getPartItems(), getPartItemNamed(), and setPartItem(); this subclass
    // satisfies that contract while routing reads through ObjectStore.listAll().
    //
    // Migration path: once parts are fully stored as envelopes, the WebDAV
    // PartsBin directory can be retired.

    lively.PartsBin.PartsSpace.subclass("lively.identity.IdentityPartsSpace",

      "initializing",
      {
        initialize: function ($super, handle, did) {
          this.handle = handle;
          this.did = did;
          $super("/@" + handle + "/parts/");
        },

        // Return IdentityPartItem instances so loadPart uses the envelope cache.
        createPartItemNamed: function (name) {
          return new lively.identity.IdentityPartItem(name, this.name);
        },
      },

      "accessing",
      {
        getURL: function () {
          return URL.root.withFilename("@" + this.handle + "/");
        },
      },

      "loading",
      {
        // Async replacement for the parent's sync WebResource-based load().
        // Populates this.partItems from ObjectStore envelopes of type 'part'.
        // thenDo(err, this) — may be undefined for legacy callers.
        load: function (thenDo) {
          var self = this;
          lively.identity.objectStore.listAll(function (err, envelopes) {
            if (err) return thenDo && thenDo(err);
            envelopes
              .filter(function (e) { return e.type === "part"; })
              .forEach(function (envelope) {
                var item = self.createPartItemFromEnvelope(envelope);
                if (item) self.setPartItem(item);
              });
            thenDo && thenDo(null, self);
          });
        },

        createPartItemFromEnvelope: function (envelope) {
          var state = envelope.state || {};
          var partName = state.partName;
          if (!partName) return null;

          var item = new lively.identity.IdentityPartItem(partName, this.name);
          item.envelope = envelope;
          // Set directly rather than resolved later via item.getPartsSpace().handle
          // — that goes through the shared, mutable lively.PartsBin.partSpaces
          // registry (keyed by partsSpaceName), which can be reset out from under
          // us (e.g. PartsBinBrowser.setPartsBinURL does
          // `lively.PartsBin.partSpaces = {}`) between when this item was built
          // and when something reads its handle. A registry miss falls back to
          // constructing a plain lively.PartsBin.PartsSpace (partsSpaceNamed's
          // fallback), which has no .handle — that's what was silently sending
          // Share Link down the WebDAV url branch instead of the intermittent
          // symptom looked like a real bug in the URL logic itself.
          item.handle = this.handle;

          var metaInfo = new lively.PartsBin.PartsBinMetaInfo();
          metaInfo.partName         = partName;
          metaInfo.comment          = state.comment          || "";
          metaInfo.tags             = state.tags             || [];
          metaInfo.requiredModules  = state.requiredModules  || [];
          metaInfo.migrationLevel   = state.migrationLevel   || 9;
          metaInfo.partsSpaceName   = this.name;
          // setPartFromJSON accesses metaInfo.lastModifiedDate — must be a Date.
          metaInfo.lastModifiedDate = envelope.created
            ? new Date(envelope.created)
            : new Date();

          item.loadedMetaInfo = metaInfo;
          return item;
        },
      },
    );

  }); // end module("lively.identity.IdentityPartsSpace")
