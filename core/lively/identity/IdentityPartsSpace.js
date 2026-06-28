module("lively.identity.IdentityPartsSpace")
  .requires(
    "lively.PartsBin",
    "lively.identity.ObjectStore",
    "lively.identity.DID",
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
          var envelope = this.envelope;

          if (!envelope || !envelope.record || !envelope.record.payload) {
            var err = new Error("[IdentityPartItem] No envelope payload for: " + this.name);
            console.warn(err.message);
            if (cb) cb(err);
            return this;
          }

          var payload = envelope.record.payload;
          // deserializePart expects a JSON string, not a JSO
          var json = typeof payload === "string" ? payload : JSON.stringify(payload);
          var metaInfo = this.loadedMetaInfo;
          var cid = envelope.record.cid;

          try {
            // setPartFromJSON(json, metaInfo, rev) requires metaInfo to have
            // lastModifiedDate set — our createPartItemFromEnvelope ensures this.
            this.setPartFromJSON(json, metaInfo, cid);
          } catch (e) {
            console.error("[IdentityPartItem] loadPart failed for " + this.name + ":", e);
            if (cb) cb(e);
            return this;
          }

          if (cb) cb(null, this.part);
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
