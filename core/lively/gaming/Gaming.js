/**
 * lively.gaming.Gaming
 *
 * The root of the Gaming world template: a game library you fill by hand, rate and
 * review, and choose per game who can see. This morph is a thin full-viewport Box. It
 * owns the library's DATA (state.entries) and every WRITE to it, and hands the drawing
 * to lively.gaming.LibraryView (the screen) and lively.gaming.GameDialogs (the add,
 * detail and visibility dialogs). Entries are stored by lively.gaming.GameLog, one
 * signed envelope per game, sealed to their owner unless made public.
 *
 * THE LIBRARY IS ACCOUNT DATA, NOT WORLD DATA. The world only remembers that it IS a
 * Gaming world; the games live in the owner's account, so several Gaming worlds show
 * the same library and a world saved with 3,000 games is still tiny.
 *
 * SAVING AND LOADING THE WORLD. The tree of tiles and dialogs must never be written into
 * the saved world: it is large, it is derived from the account's data, and a loaded
 * world rebuilds it anyway. So `submorphs` is in doNotSerialize (the saved root is a
 * few hundred bytes), and a restored root has NO `submorphs` property at all (not an
 * empty array), which is why onrestore sets it before anything else runs. The screen is
 * then rebuilt by _setup(), which runs whenever the morph gets a render context. Checked
 * with a real save and reload (tests/e2e/gaming-template.spec.js).
 *
 * Entry points:
 *   lively.gaming.Gaming.open(optPos)    open the template in the current world
 */

module("lively.gaming.Gaming")
  .requires("lively.morphic.Complete", "lively.gaming.GamingUI", "lively.gaming.GameLog", "lively.gaming.LibraryView")
  .toRun(function () {

    var GameLog = function () { return lively.gaming.GameLog; };

    lively.morphic.Box.subclass("lively.gaming.Gaming",

      "serialization",
      {
        // submorphs: see the header. The rest is runtime-only state: the loaded entries, the
        // screen controller, listeners and timers.
        doNotSerialize: ["submorphs", "state", "_view", "_unsubTheme", "_identityConnection", "_saveQueues", "_loadSeq", "_resizeTimer"],

        // A restored morph has no `submorphs` property (it was not serialized). Nothing may
        // touch it before it is an array again.
        onrestore: function ($super) {
          this.submorphs = [];
          $super();
        },
      },

      "initialization",
      {
        initialize: function ($super, optExtent) {
          $super(optExtent || lively.rect(0, 0, 1280, 820));
          // NOTE: $super already created the render context, and with it ran _setup() through
          // prepareForNewRenderContext. Anything done here AFTER $super (a setFill(null), say)
          // overwrites what _setup painted, which is why the page background is set again by
          // _paintBackground at the end of every build and layout.
          this.setBorderWidth(0);
          // A plain Box is draggable, droppable and grabbable; this one is the whole page.
          this.disableDragging();
          this.disableDropping();
          this.disableGrabbing();
          this._paintBackground();
        },

        // Runs for a fresh morph and for a restored one, whenever it is given a render context.
        prepareForNewRenderContext: function ($super, renderCtx) {
          if (!this.submorphs) this.submorphs = [];
          $super(renderCtx);
          this._setup();
        },

        // (Re)creates all runtime state and the screen. Safe to run more than once.
        _setup: function () {
          this._teardown();
          var UI = lively.gaming.GamingUI, self = this;
          UI.ensureFonts();
          this.state = { entries: [], hidden: 0, loaded: false, loading: false, error: null, ownerHandle: null };
          this._saveQueues = {};
          this._loadSeq = 0;
          this._unsubTheme = UI.onThemeChange(function () { self.rebuild(); });
          this._fitToWorld();
          this._build();
          this._bindIdentity();
          this._load();
        },

        // Drops listeners, timers and the screen controller. Every exit path (a rebuild, a
        // new render context, removal) goes through here so nothing is left running.
        _teardown: function () {
          if (this._unsubTheme) { this._unsubTheme(); this._unsubTheme = null; }
          this._unbindIdentity();
          if (this._view) { this._view.dispose(); this._view = null; }
          clearTimeout(this._resizeTimer);
          lively.gaming.GamingUI.closeModal();
        },

        remove: function ($super) {
          this._teardown();
          $super();
        },
      },

      "screen",
      {
        // Empties the template and draws it again from the current theme. A theme switch calls
        // this instead of recolouring morphs in place (see GamingUI's header for why).
        rebuild: function () {
          lively.gaming.GamingUI.closeModal();
          this._build();
          if (this._view) this._view.refresh();
        },

        _build: function () {
          var UI = lively.gaming.GamingUI, th = UI.theme();
          (this.submorphs || []).slice().forEach(function (m) { m.remove(); });
          if (this._view) this._view.dispose();
          this._paintBackground();
          this._view = new lively.gaming.LibraryView(this);
          this._view.build();
          this._layout();
        },

        // The page colour, from the current theme. Written to the model AND the real node:
        // applyStyle / setFill on an already-rendered morph can update the model while the DOM
        // keeps the old paint (CLAUDE.md), and the colour may also be reset by a later render.
        // Idempotent, so it is called after every build and every layout.
        _paintBackground: function () {
          var th = lively.gaming.GamingUI.theme();
          this.setFill(th.bg);
          var node = this.renderContext() && this.renderContext().shapeNode;
          if (node) node.style.background = th.bg.toString();
        },

        _layout: function () {
          this._paintBackground();
          var e = this.getExtent();
          if (this._view) this._view.layout(e.x, e.y);
        },

        // Fills the visible part of the world (the same idiom the other full-page templates use:
        // MenuBar / MobileInterface). Called after the morph has an owner, and on world resize.
        _fitToWorld: function () {
          if (typeof $world === "undefined" || !$world) return;
          var vb = $world.visibleBounds();
          // The world's menu bar floats over the top 42px (10px margin + 32px bar): start below it.
          var top = lively.gaming.Gaming.MENU_BAR_INSET;
          this.setPosition(vb.topLeft().addXY(0, top));
          this.setExtent(vb.extent().addXY(0, -top));
        },

        onWorldResize: function () {
          var self = this;
          clearTimeout(this._resizeTimer);
          this._resizeTimer = setTimeout(function () { self._fitToWorld(); self._layout(); }, 150);
        },

        // The name shown in the header: the world's own name, or a default. $world.name is NOT kept
        // in sync with the assigned name; document.title is (the server sets it from the world's
        // record), so read that (CLAUDE.md, same as Books and Gallery).
        worldName: function () {
          var t = document.title;
          var generic = !t || t === "world" || t === "Lively" || t === "untitled world" || t === "blank";
          return generic ? "My Games" : t;
        },
      },

      "identity and data",
      {
        _currentUser: function () {
          if (typeof lively === "undefined" || !lively.identity || !lively.identity.did) return null;
          return lively.identity.did.currentUser();
        },

        // Whose library this is: the handle in the world's own URL (/@handle/<world>), or, on a
        // page with no such URL, whoever is signed in. null when neither is known.
        ownerHandle: function () {
          try {
            var parsed = lively.identity.webKey.parseObjectUrl(window.location.href);
            if (parsed && parsed.handle) return parsed.handle;
          } catch (e) { /* not an object URL */ }
          var u = this._currentUser();
          return u ? u.handle : null;
        },

        // Can the person looking at this edit it? Only the account whose library it is.
        isOwner: function () {
          var u = this._currentUser(), h = this.ownerHandle();
          return !!(u && h && u.handle === h);
        },

        _bindIdentity: function () {
          if (typeof lively === "undefined" || !lively.bindings || !lively.identity || !lively.identity.did) return;
          var self = this;
          this._identityConnection = lively.bindings.connect(lively.identity.did, "identityChanged", self, "_onIdentityChanged");
          if (lively.identity.did.restoreSession) lively.identity.did.restoreSession(function () { self._onIdentityChanged(); });
        },

        _unbindIdentity: function () {
          if (this._identityConnection && this._identityConnection.disconnect) this._identityConnection.disconnect();
          this._identityConnection = null;
        },

        // Sign-in state changed (the session restored, the person signed in or out). The owner
        // may have changed, so the library is read again.
        _onIdentityChanged: function () {
          if (!this.state) return;
          var h = this.ownerHandle();
          if (!this.state.loaded || h !== this.state.ownerHandle || this.isOwner() !== this._wasOwner) this._load();
        },

        reload: function () { this._load(); },

        // Reads the whole library, page by page. Entries appear as pages arrive. A later call
        // supersedes an earlier one still in flight (a stale answer must not overwrite it).
        _load: function () {
          var self = this, st = this.state, seq = ++this._loadSeq;
          var handle = this.ownerHandle();
          st.ownerHandle = handle;
          this._wasOwner = this.isOwner();
          st.error = null;
          if (!handle) { st.error = "signin"; st.loaded = true; st.entries = []; if (this._view) this._view.refresh(); return; }
          st.loading = true;
          st.loaded = false;
          if (this._view) this._view.refresh();
          GameLog().list(handle, {
            onPage: function (entries) { if (seq === self._loadSeq) { st.entries = entries; st.loaded = true; if (self._view) self._view.refresh(); } },
          }, function (err, result) {
            if (seq !== self._loadSeq) return;
            st.loading = false;
            if (err) { st.error = err.message || String(err); st.loaded = true; }
            else { st.entries = result.entries; st.hidden = result.hidden; st.loaded = true; }
            if (self._view) self._view.refresh();
          });
        },

        // ─── writes (owner only; every one goes through GameLog) ─────────────

        // Adds a game. `fields` are payload fields (title required); `visibility` defaults to
        // private. Calls thenDo(err, entry). A game is never added Public by default: imports
        // and hand-added games both start private.
        addGame: function (fields, visibility, thenDo) {
          var self = this;
          if (!this.isOwner()) return thenDo && thenDo(new Error("Only the owner can add games"));
          GameLog().create(fields, visibility || "private", function (err, entry) {
            if (err) { self.toast("Couldn't add the game: " + err.message); return thenDo && thenDo(err); }
            self.state.entries.unshift(entry);
            if (self._view) self._view.refresh();
            if (thenDo) thenDo(null, entry);
          });
        },

        // Saves `changes` to an entry (payload fields, and/or { visibility }). Saves for the
        // SAME game are queued: each new version chains on the previous one's cid, so two
        // overlapping saves would fork the history and the second would be refused. Changes made
        // while a save is running are merged and sent as one follow-up save. Calls
        // thenDo(err, entry) when this call's changes have been stored.
        saveEntry: function (entry, changes, thenDo) {
          var self = this, q = this._saveQueues[entry.objId] || (this._saveQueues[entry.objId] = { running: false, pending: null, waiters: [] });
          q.pending = Object.assign(q.pending || {}, changes);
          q.waiters.push(thenDo || function () {});
          // The screen shows the change at once; the stored entry catches up when the save lands.
          this._applyLocal(entry.objId, changes);
          if (q.running) return;
          (function run(current) {
            var batch = q.pending, waiters = q.waiters;
            q.pending = null; q.waiters = []; q.running = true;
            GameLog().save(current, batch, function (err, saved) {
              q.running = false;
              if (err) {
                self.toast("Couldn't save: " + err.message);
                waiters.forEach(function (w) { w(err); });
                // the stored copy is the truth again: put it back on screen
                self._load();
                return;
              }
              self._replaceEntry(saved);
              waiters.forEach(function (w) { w(null, saved); });
              if (q.pending) { q.running = true; run(saved); }
            });
          })(this.entryById(entry.objId) || entry);
        },

        // Soft-deletes a game. Calls thenDo(err).
        removeEntry: function (entry, thenDo) {
          var self = this;
          GameLog().remove(this.entryById(entry.objId) || entry, function (err) {
            if (err) { self.toast("Couldn't remove it: " + err.message); return thenDo && thenDo(err); }
            self.state.entries = self.state.entries.filter(function (e) { return e.objId !== entry.objId; });
            if (self._view) self._view.refresh();
            if (thenDo) thenDo(null);
          });
        },

        entryById: function (objId) {
          return this.state.entries.filter(function (e) { return e.objId === objId; })[0] || null;
        },

        // Optimistic local update: shows a change before the server has confirmed it.
        _applyLocal: function (objId, changes) {
          var e = this.entryById(objId);
          if (!e) return;
          var c = Object.assign({}, changes);
          if (c.visibility) { e.visibility = c.visibility; delete c.visibility; }
          e.payload = Object.assign({}, e.payload, c);
          if (this._view) this._view.entryChanged(e);
        },

        // Swaps in the entry as the server stored it (new envelope, so the next save chains on it).
        // The payload shown on screen is kept if newer local changes are still queued.
        _replaceEntry: function (saved) {
          var list = this.state.entries;
          for (var i = 0; i < list.length; i++) {
            if (list[i].objId === saved.objId) {
              var q = this._saveQueues[saved.objId];
              var local = list[i];
              list[i] = (q && q.pending) ? { objId: saved.objId, did: saved.did, visibility: local.visibility, envelope: saved.envelope, payload: local.payload } : saved;
              break;
            }
          }
          if (this._view) this._view.entryChanged(saved);
        },

        toast: function (text) { lively.gaming.GamingUI.toast(text, null, this); },
      },

      "dialogs",
      {
        // The dialogs live in their own module, loaded the first time one is needed.
        _dialogs: function (thenDo) {
          lively.require("lively.gaming.GameDialogs").toRun(function () { thenDo(lively.gaming.GameDialogs); });
        },
        openAdd: function () { var self = this; this._dialogs(function (D) { D.openAdd(self); }); },
        openDetail: function (entry) { var self = this; this._dialogs(function (D) { D.openDetail(self, entry); }); },
        openVisibility: function (entry) { var self = this; this._dialogs(function (D) { D.openVisibility(self, entry); }); },
      }
    );

    // Height of the strip the world's floating menu bar occupies at the top of the page.
    lively.gaming.Gaming.MENU_BAR_INSET = 48;

    // Opens the template in the current world, filling the visible area.
    lively.gaming.Gaming.open = function (optPos) {
      var m = new lively.gaming.Gaming(lively.rect(0, 0, 1280, 820));
      m.setName("Gaming");
      m.openInWorld(optPos || lively.morphic.World.current().visibleBounds().topLeft());
      // _setup ran from prepareForNewRenderContext as part of openInWorld, BEFORE the morph had an
      // owner chain, and openInWorld then re-positions it. Fit and lay out again now it is attached.
      m._fitToWorld();
      m._layout();
      return m;
    };
  }); // end module('lively.gaming.Gaming')
