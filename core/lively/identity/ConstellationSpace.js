/**
 * lively.identity.ConstellationSpace
 *
 * Live multi-user view of a constellation's space: a full Lively world (same
 * category as a user's home world at /@handle, just shared/synced instead of
 * private) whose content is a Yjs-synced layout of placed post cards and
 * parts, with live presence. Reuses the same Yjs runtime (postcard-runtime.js
 * bundle) and sync server (PostCardSyncServer) post cards already use — the
 * room name is the constellation's genesisObjId.
 *
 * Placements render as top-level morphs directly on $world — not inside a
 * window. Each visiting browser boots its own independent $world (there is
 * no mechanism in this codebase for literally syncing one morph graph across
 * multiple live worlds, and building one is out of scope here); what makes
 * it feel shared is that every such $world renders the same Yjs-synced
 * placement + presence data. The data model stays a bounded layout map, not
 * an arbitrary morph-graph CRDT.
 *
 * Auth: PostCardSyncServer's WS layer has no access to the Express session,
 * so room access rides a short-lived signed token minted by
 * GET /c/:name/space-token (see ConstellationSpace.js server-side and
 * PostCardSyncServer.js's TODO(constellation-write-gate) for the current
 * scope of what that token does and doesn't protect).
 *
 * Open: lively.identity.ConstellationSpace.open(name) — called from
 * buildConstellationSpacePage's onStartWorld hook once $world exists (see
 * IdentityServer.js), or from anywhere $world is already available.
 */

module("lively.identity.ConstellationSpace")
  .requires(
    "lively.identity.DID",
    "lively.identity.IdentityPartsSpace",
    "lively.identity.PostCardView",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    Object.subclass("lively.identity.ConstellationSpaceController",

    'initializing', {
      initialize: function () {
        this._name            = null;
        this._genesisObjId    = null;
        this._canWrite         = false;
        this.yDoc               = null;
        this.wsProvider         = null;
        this._placementMorphs  = {};
        this._presenceMorphs   = {};
      },
    },

    // ─── boot ─────────────────────────────────────────────────────────────────

    'boot', {

      open: function (name) {
        this._name = name;
        this._loadTokenAndConnect();
      },

      _loadTokenAndConnect: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/space-token", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) {
            return self._showError("Failed to load space (" + xhr.status + ")");
          }
          var data;
          try { data = JSON.parse(xhr.responseText); }
          catch (e) { return self._showError("Bad space-token response"); }
          self._genesisObjId = data.genesisObjId;
          self._canWrite      = !!data.canWrite;
          self._connect(data.token);
        };
        xhr.onerror = function () { self._showError("Network error loading space"); };
        xhr.send();
      },

      _connect: function (token) {
        var Y = this._Y();
        if (!Y) return this._showError("Yjs not loaded — cannot open space");
        var WebsocketProvider = this._WebsocketProvider();
        if (!WebsocketProvider) return this._showError("WebsocketProvider not loaded — cannot open space");

        this.yDoc = new Y.Doc({ gc: false });
        // PostCardSyncServer runs on its own standalone port (must be
        // separately reachable over TLS wherever this app is deployed).
        // wss: required whenever the page itself is https: — browsers
        // block insecure ws: connections from a secure page.
        var syncPort = (typeof window !== "undefined" && window.POSTCARD_SYNC_PORT) || 1234;
        var wsScheme = (typeof location !== "undefined" && location.protocol === "https:") ? "wss:" : "ws:";
        var wsUrl = wsScheme + "//" + location.hostname + ":" + syncPort;
        this.wsProvider = new WebsocketProvider(wsUrl, this._genesisObjId, this.yDoc, {
          connect: true,
          params: { token: token },
        });
        this.wsProvider.on("status", function (event) {
          console.log("[ConstellationSpace] sync status:", event.status);
        });

        var layoutMap = this.yDoc.getMap("layout");
        this._renderAllPlacements(layoutMap);
        layoutMap.observe(this._onLayoutChange.bind(this));

        this._setupAwareness();
      },

    },

    // ─── placements ─────────────────────────────────────────────────────────
    // Keyed add/move/resize: only the changed placement's morph is touched
    // on a Yjs update — existing morphs are repositioned in place rather
    // than torn down and rebuilt, to avoid drag-jank on remote edits.
    // Placements are top-level $world morphs, not children of a window pane.

    'placements', {

      _onLayoutChange: function () {
        var layoutMap = this.yDoc.getMap("layout");
        var self = this;
        Object.keys(this._placementMorphs).forEach(function (id) {
          if (!layoutMap.has(id)) self._removePlacementMorph(id);
        });
        layoutMap.forEach(function (value, id) { self._renderPlacement(id, value); });
      },

      _renderAllPlacements: function (layoutMap) {
        var self = this;
        layoutMap.forEach(function (value, id) { self._renderPlacement(id, value); });
      },

      _removePlacementMorph: function (id) {
        var m = this._placementMorphs[id];
        if (m) { m.remove(); delete this._placementMorphs[id]; }
      },

      _renderPlacement: function (id, data) {
        var existing = this._placementMorphs[id];
        if (existing) {
          existing.setPosition(lively.pt(data.x || 0, data.y || 0));
          existing.setExtent(lively.pt(data.w || 220, data.h || 140));
          return;
        }

        var self = this;
        var wrapper = new lively.morphic.Box(
          lively.rect(data.x || 0, data.y || 0, data.w || 220, data.h || 140));
        wrapper._placementId = id;
        wrapper.setFill(Color.rgb(255, 255, 255));
        wrapper.setBorderWidth(1);
        wrapper.setBorderColor(Color.rgb(220, 220, 220));
        this._placementMorphs[id] = wrapper;
        $world.addMorph(wrapper);

        if (this._canWrite) {
          wrapper.draggingEnabled = true;
          Trait("lively.morphic.DragMoveTrait").applyTo(wrapper, {
            override: ["onDragStart", "onDrag", "onDragEnd"],
          });
          var traitDragEnd = wrapper.onDragEnd;
          wrapper.onDragEnd = function (evt) {
            var result = traitDragEnd.call(this, evt);
            self._commitPlacementPosition(id);
            return result;
          };
          this._addResizeHandle(wrapper, id);
          this._addRemoveButton(wrapper, id);
        }

        this._renderPlacementContent(wrapper, data.kind, data.ref || {}, id);
      },

      _commitPlacementPosition: function (id) {
        var layoutMap = this.yDoc && this.yDoc.getMap("layout");
        var m = this._placementMorphs[id];
        var data = layoutMap && layoutMap.get(id);
        if (!m || !layoutMap || !data) return;
        var pos = m.getPosition();
        layoutMap.set(id, Object.assign({}, data, { x: pos.x, y: pos.y }));
      },

      _commitPlacementSize: function (id) {
        var layoutMap = this.yDoc && this.yDoc.getMap("layout");
        var m = this._placementMorphs[id];
        var data = layoutMap && layoutMap.get(id);
        if (!m || !layoutMap || !data) return;
        var ext = m.getExtent();
        layoutMap.set(id, Object.assign({}, data, { w: ext.x, h: ext.y }));
      },

      _addResizeHandle: function (wrapper, id) {
        var self = this;
        var handle = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        handle.setFill(Color.rgb(160, 160, 160));
        handle.draggingEnabled = true;
        function reposition() {
          var ext = wrapper.getExtent();
          handle.setPosition(lively.pt(ext.x - 10, ext.y - 10));
        }
        reposition();
        handle.onDragStart = function (evt) {
          this._startExtent = wrapper.getExtent();
          this._startPos = evt.getPosition();
          evt.stop(); return true;
        };
        handle.onDrag = function (evt) {
          var delta = evt.getPosition().subPt(this._startPos);
          var newExtent = this._startExtent.addPt(delta);
          newExtent.x = Math.max(60, newExtent.x);
          newExtent.y = Math.max(40, newExtent.y);
          wrapper.setExtent(newExtent);
          reposition();
          evt.stop(); return true;
        };
        handle.onDragEnd = function (evt) {
          self._commitPlacementSize(id);
          evt.stop(); return true;
        };
        wrapper.addMorph(handle);
      },

      _addRemoveButton: function (wrapper, id) {
        var self = this;
        var btn = new lively.morphic.Text(lively.rect(0, 0, 16, 16), "×");
        btn.setPosition(lively.pt(wrapper.getExtent().x - 18, 2));
        btn.onMouseUp = function (evt) {
          if (self.yDoc) self.yDoc.getMap("layout").delete(id);
          evt.stop();
        };
        wrapper.addMorph(btn);
      },

      // "postcard"/"part" content — read-only excerpt fetch, same envelope
      // resolution path PostCardEditor.js uses for embedded parts, just
      // rendered into a placement wrapper instead of a ProseMirror NodeView.
      _renderPlacementContent: function (wrapper, kind, ref, id) {
        if (!ref.handle || !ref.objId) return;
        if (kind === "part") this._renderPartPlacement(wrapper, ref, id);
        else this._renderPostcardPlacement(wrapper, ref);
      },

      // Embeds a real, interactive PostCardView morph — click-to-flip and
      // all — instead of a static HTML excerpt, so a placed postcard
      // actually persists as a living card in the space rather than a
      // snapshot (see file header). Position/size stay driven entirely by
      // the wrapper's own Yjs-synced layout (_commitPlacementPosition/
      // _commitPlacementSize) — the view just fills it, same as
      // _renderPartPlacement's embedded part morph does.
      _renderPostcardPlacement: function (wrapper, ref) {
        var extent = wrapper.getExtent();
        lively.identity.PostCardView.open(ref.handle, ref.objId, {
          target: wrapper,
          cid: ref.cid || null,
          bounds: lively.rect(0, 0, extent.x, extent.y),
        });
      },

      _renderPartPlacement: function (wrapper, ref, id) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = base + "/@" + encodeURIComponent(ref.handle) + "/" + encodeURIComponent(ref.objId);
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) { return; }
          var space = new lively.identity.IdentityPartsSpace(ref.handle, null);
          var item = space.createPartItemFromEnvelope(envelope);
          if (!item) return;
          item.loadPart(false, false, envelope.record && envelope.record.cid, function (err, part) {
            if (err || !part) return;
            part.setPosition(lively.pt(0, 0));
            wrapper.addMorph(part);
            if (typeof part.onPostCardEmbed === "function") {
              part.onPostCardEmbed(self._placementStateApi(id));
            }
          });
        };
        xhr.send();
      },

      // Same lazy-create + get/set/observe facade PostCardEditor.js's
      // _embedStateApi uses for embedded parts, keyed by placement id
      // instead of embedId — a bare part placed directly in the space
      // gets collaborative state exactly as one embedded in a post card does.
      _placementStateApi: function (id) {
        var Y = this._Y();
        if (!Y || !this.yDoc || !id) return null;
        var partStateMap = this.yDoc.getMap("partState");
        var stateMap = partStateMap.get(id);
        if (!(stateMap instanceof Y.Map)) {
          stateMap = new Y.Map();
          partStateMap.set(id, stateMap);
        }
        return {
          get: function (key) { return stateMap.get(key); },
          set: function (key, value) { stateMap.set(key, value); },
          observe: function (fn) { stateMap.observe(fn); return function () { stateMap.unobserve(fn); }; },
        };
      },

    },

    // ─── presence ───────────────────────────────────────────────────────────

    'presence', {

      _setupAwareness: function () {
        var self = this;
        var user = lively.identity.did.currentUser();
        var awareness = this.wsProvider.awareness;
        awareness.setLocalStateField("presence", {
          did: user && user.did,
          handle: (user && user.handle) || "anonymous",
          x: 0, y: 0,
          color: this._randomPresenceColor(),
        });
        awareness.on("change", function () { self._renderPresence(); });

        $world.onMouseMove = function (evt) {
          var pos = evt.getPositionIn($world);
          var state = awareness.getLocalState() || {};
          var presence = state.presence || {};
          awareness.setLocalStateField("presence", Object.assign({}, presence, { x: pos.x, y: pos.y }));
        };
      },

      _renderPresence: function () {
        if (!this.wsProvider) return;
        var self = this;
        var states = this.wsProvider.awareness.getStates();
        var myClientId = this.wsProvider.awareness.clientID;
        var seen = {};

        states.forEach(function (state, clientId) {
          if (clientId === myClientId) return;
          var presence = state && state.presence;
          if (!presence) return;
          seen[clientId] = true;

          var dot = self._presenceMorphs[clientId];
          if (!dot) {
            dot = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
            $world.addMorph(dot);
            self._presenceMorphs[clientId] = dot;
          }
          var c = presence.color || [153, 153, 153];
          dot.setFill(Color.rgb(c[0], c[1], c[2]));
          dot.setPosition(lively.pt((presence.x || 0) - 5, (presence.y || 0) - 5));
        });

        Object.keys(this._presenceMorphs).forEach(function (clientId) {
          if (!seen[clientId]) {
            self._presenceMorphs[clientId].remove();
            delete self._presenceMorphs[clientId];
          }
        });
      },

      _randomPresenceColor: function () {
        var palette = [[229,115,115],[100,181,246],[129,199,132],[255,213,79],[186,104,200]];
        return palette[Math.floor(Math.random() * palette.length)];
      },

    },

    // ─── runtime lookup + errors ──────────────────────────────────────────────

    'runtime', {

      _Y: function () {
        return (typeof Y !== "undefined" && Y) ||
               (typeof window !== "undefined" && window.Y) ||
               null;
      },

      _WebsocketProvider: function () {
        return (typeof WebsocketProvider !== "undefined" && WebsocketProvider) ||
               (typeof window !== "undefined" && window.WebsocketProvider) ||
               null;
      },

      _showError: function (msg) {
        console.error("[ConstellationSpace]", msg);
      },

    });

    // Static open helper — constructs a fresh controller bound to $world.
    // Callers (buildConstellationSpacePage's onStartWorld hook) are expected
    // to only call this once $world already exists.
    lively.identity.ConstellationSpace = {
      open: function (name) {
        var controller = new lively.identity.ConstellationSpaceController();
        controller.open(name);
        return controller;
      },
    };

  });
