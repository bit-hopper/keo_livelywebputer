/**
 * lively.identity.ConstellationLounge
 *
 * The fixed-layout landing page at /c/:name (ConstellationDesignSpec.md's
 * "space", reframed as a lounge/main-feed UI rather than the freeform
 * drag/place world — that world now lives at /c/:name/canvas,
 * ConstellationCanvas.js). A visitor to /c/:name sees:
 *
 *   - a search field (top, styled after PartsBin/iPadWidgets/SearchField.json
 *     — white rounded pill, magnifying-glass icon, blue "Go" button, same
 *     embedded icon asset), searching this constellation's postcard titles
 *     (server-side, via GET /c/:name/feed?q=) and wiki page names
 *     (client-side, against the already-loaded index)
 *   - a quick-info panel (name, visibility, member count, created date,
 *     co-creator) to the right of the search field, capped to the
 *     postcard's height
 *   - a postcard "turnover" reel: newest-first, one card visible at a
 *     time, turned via a literal 3D flip-away (CSS perspective/rotateY,
 *     same technique PostCardView.js's own front/back flip uses, applied
 *     here to stack navigation instead) — prev/next buttons, and arrow
 *     keys turn it. Reply-driven activity never reorders the stack.
 *   - below the active card: a Reddit-style recursively nested, lazily
 *     expanded reply tree (GET /@:handle/:objId/replies is objId-generic —
 *     the :handle path segment is unused server-side, confirmed by reading
 *     IdentityServer.js, so the same route recurses to any depth). Clicking
 *     a reply focuses it into the active slot; a breadcrumb steps back out
 *     without disturbing the top-level stack position.
 *   - an embedded wiki panel (most-recently-updated page, with a
 *     page-switcher menu and "+ New wiki page" for members) extending to
 *     the page bottom, right of the reel
 *   - a Discord-style member list on the far right: co-creator (green
 *     badge, constellation.createdBy) — moderator (yellow badge, every
 *     other DID in constellation.controllers, per the owner's "every
 *     added controller is also a moderator" framing — no separate
 *     moderator role in the schema) — active members (live Yjs
 *     awareness/presence, ConstellationCanvas.js's own mechanism, connected
 *     here read/write-for-presence-only, no layout rendering)
 *
 * Boot: server-rendered skeleton (buildConstellationLoungePage,
 * IdentityServer.js) pre-fills the quick-info panel from data the route
 * handler already has; everything else needs extra queries this
 * controller makes once $world exists.
 *
 * Rendering convention: every visible element is a real Lively morph
 * (Box/Text/Button/Image), added to $world, not raw DOM on document.body.
 * This isn't just style — it's load-bearing. A first pass built the chrome
 * as raw `position:fixed` DOM appended to document.body, and that produced
 * two real bugs: (1) keyboard focus on a plain `<input>` was being stolen
 * every keystroke, because Events.js's world-focus failsafe
 * (`if (!world.focusedMorph()) world.focus()`, fired on a delay after any
 * blur) only recognizes *morphs* as focus-holders — a raw input outside
 * any morph's DOM subtree never registers, so the world silently reclaimed
 * focus after every character; (2) later-opened morphic windows (e.g. the
 * mailbox) rendered *underneath* the raw DOM chrome, because that chrome
 * sat outside Lively's own z-order/bringToFront management entirely. Real
 * morphs (added via addMorph, same as ConstellationCanvas.js's placements)
 * fix both by construction, and — the actual reason this matters per the
 * project owner — keep every element halo-selectable and Object-Editor
 * inspectable, the way everything else in this codebase is. The postcard/
 * wiki embed slots were already lively.morphic.Box morphs; this revision
 * brings the rest of the chrome (search, quick-info, nav, reply thread,
 * wiki header, member list) in line with that, and only the front card
 * slot's own CSS 3D transform (applied to its own shapeNode, the same
 * technique PostCardView.js's internal flip already uses) remains a direct
 * style manipulation — that's an animation detail on a real morph, not a
 * substitute for one.
 *
 * Open: lively.identity.ConstellationLounge.open(name) — called from
 * buildConstellationLoungePage's onStartWorld hook once $world exists.
 */

module("lively.identity.ConstellationLounge")
  .requires(
    "lively.identity.DID",
    "lively.identity.PostCardView",
    "lively.identity.WikiView",
    "lively.identity.WikiEditor",
    "lively.identity.PostCardUtils",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    // Same embedded icon asset as PartsBin/iPadWidgets/SearchField.json's
    // magnifying-glass image morph, reused verbatim so the rebuilt search
    // field is visually identical, not just similar.
    var SEARCH_ICON_DATA_URL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAACxMAAAsTAQCanBgAAAPbSURBVEhLrVVdTxtXED13d/0RB+zFFCp4KkI1ThBCAgGVIhHUP8D/5SXqI1F5AFUVJHwEEihfsTFQY+/X7Zm5XpP0Ode68mrv3JkzZ87MmvPrr3b0RQWVchl+gOGyFkgzC88zMAbIbKZnnvFg+dNnGFgx5DJixJWmKXzfh1cLX6JQNPB8iyTJkLn76ix3ml8cOqHDfIlDeZ/xouzh+8Sm1vCF53mMJgh99Hp9tFotXN/c4O7uTs+q1SomJiYwNjaGSqWs9+3g3nOez08ms7F18T3drdYdjo6OcHh4iKvra8RxrKkFQYB6vY7Z2Vk0XzUQ1kJkTFuWnOfZ5NmZOO1ZnzyCWfT6Kd6//xMHBwfK2U9EODk5qZduiP7q6grFYhFzc3NYWFhAdfSlUie0DShWOiRDIo6I2Gj0k09f8O7dH4iiCMvLy/hlZkYpEMNOp4PT01Nsb28rwo2NDTTnGq6wdE4T1ijRzDR/A6ahnHtKwe3tLX5tNPB6fh5hGKJcLhJlgFqtpkgXFxfVRoIkaTbQR17w56IyjsjH7fPzf5SCGSIdGamoQ1GKFFWeR5n69PQ0SqWSOg4C3qPaBG0UJZpJvqRiDjpPHx8fSYpPdGOu6rxkqFuRXb7Gx8fVQbfb1aBChdhJ4G+XJ/IWtGIR1uoa4OHhgSj/XxQRv1UahEuRne87XEni1CGFy9UxRCw0T/w8iThNsL+/j/v7BzVWRFIg7qcoxt8HH5Qu0bQsCeYHPrv0e57VcWakCBbNZgNTU1M4OTnB3t4ezs4umHKfMkxwcXGJnZ0dPZOiNpvNAYWu5YVnyTbvPsrN2oSyEBRplNLhX9jd3VXJSbriRNBKJ7bbba3DNDPb3NzkWXVAgfBsEfiGXdujksqiY2vTfKgw5273CcfHn9h5H7QLW50WkThFVKshLi8vdND8trKKpaUl1W2h4LsZQ0/aHARpUptZo9V/nlS9fozOfRtf2x0i6LJIBRRKASVYpeNLbZL+Uw+rq6tYW1tDgRxz5Eib0VYUpJ1ndVZYsm8GVdaikB5JzzKgG5UMzt0hFV/OPmNra0vVsbKygt/frrvK0T5JImZQ0snDNBKHmM7T2G1jPQScdIHoWG1UlKiNjGC++Qrrb9YRjobwaMfrSFXTBEHaVE1RltoCL3/Xmy6+A+GAOMTyL9JLGIRNdvjxmIOqzmEU6kzPZ4Y6/jeO7QsWQIaQR1RGdJO3kwxwYUy1JIJ2fLBGkoM6cpzKePsGjchPqqoFZSsbmUySrwqT//KJCQY3xJt+hpiy2rBQnBXkQp3mszl3b1gg99H6wWvY0j/YL/4DF1XopJQ13lsAAAAASUVORK5CYII=";

    var CARD_W = 420, CARD_H = 300;
    var REEL_W = 480;
    var MEMBERS_W = 220;       // outer slot width
    var MEMBERS_MARGIN = 12;   // right margin left inside that slot
    var GUTTER = 20;           // column gutter, also the gap before the members column
    var TOP = 56;              // top margin below the menu bar
    var SEARCH_W = 490, SEARCH_H = 45;
    var NAV_H = 40;
    var ROW_GAP = 16;

    Object.subclass("lively.identity.ConstellationLoungeController",

    "initializing", {
      initialize: function () {
        this._name = null;
        this._quickInfo = null;
        this._canWrite = false;
        this._isController = false;
        this._joinRequestStatus = null;
        this.yDoc = null;
        this.wsProvider = null;

        this._feedCards = [];      // top-level stack, newest-first
        this._feedCursor = null;
        this._activeIndex = -1;
        this._focusStack = [];     // [rootObjId, ...focusedReplyObjIds]

        this._wikiPages = [];
        this._wikiPagesFiltered = null;
        this._activeWikiObjId = null;

        this._threadReplies = [];
        this._threadChildrenCache = {};
        this._threadExpanded = {};

        this._frontCardBox = null;
        this._backCardBox = null;
        this._wikiBox = null;

        this._presenceByDid = {};  // did -> true while online
      },
    },

    // ─── boot ─────────────────────────────────────────────────────────────────

    "boot", {
      open: function (name) {
        this._name = name;
        this._loadQuickInfo();
      },

      _loadQuickInfo: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/space-token", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError("Failed to load c/" + self._name + " (" + xhr.status + ")");
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return self._showError("Bad space-token response"); }
          self._genesisObjId = data.genesisObjId;
          self._canWrite = !!data.canWrite;
          self._isController = !!data.isController;
          self._joinRequestStatus = data.joinRequestStatus || null;
          self._quickInfo = data.quickInfo || {};
          self._start();
        };
        xhr.onerror = function () { self._showError("Network error loading c/" + self._name); };
        xhr.send();
      },

      _start: function () {
        document.title = "c/" + this._name;
        this._buildChrome();
        this._renderQuickInfo();
        this._renderMemberList();
        this._fetchFeed(null);
        this._fetchWikiIndex();
        this._connectPresence();
        this._installMenuBarEntry();
        window.addEventListener("resize", this._layout.bind(this));
      },
    },

    // ─── layout ──────────────────────────────────────────────────────────────

    "layout", {
      // Recomputes fixed pixel geometry for the current viewport and
      // repositions every morph. Purely geometric — content rebuilds
      // happen where the underlying data changes, not here.
      _layout: function () {
        var W = window.innerWidth, H = window.innerHeight;
        var wikiColX = REEL_W + GUTTER;
        var membersX = W - MEMBERS_W;
        // Wiki column stops GUTTER short of the members slot, instead of
        // touching it flush.
        var wikiColW = Math.max(280, (membersX - GUTTER) - wikiColX);
        var reelY = TOP + SEARCH_H + ROW_GAP;
        var threadY = reelY + CARD_H + NAV_H;

        var g = this._geom = {
          searchX: wikiColX - SEARCH_W, searchY: TOP,
          // Quick-info's bottom edge lines up with the postcard's bottom
          // edge — "does not drop below the post card."
          quickInfoX: wikiColX, quickInfoY: TOP, quickInfoW: wikiColW, quickInfoH: (reelY + CARD_H) - TOP,
          reelX: GUTTER, reelY: reelY,
          navX: GUTTER, navY: reelY + CARD_H + 6,
          threadX: GUTTER, threadY: threadY, threadW: CARD_W, threadH: Math.max(120, H - threadY - 16),
          wikiHeaderX: wikiColX, wikiHeaderY: threadY, wikiHeaderW: wikiColW, wikiHeaderH: 32,
          wikiX: wikiColX, wikiY: threadY + 40, wikiW: wikiColW, wikiH: Math.max(160, H - (threadY + 40) - 16),
          membersX: membersX, membersY: TOP, membersW: Math.max(140, MEMBERS_W - MEMBERS_MARGIN), membersH: Math.max(120, H - TOP),
        };

        if (this._searchBox) this._searchBox.setPosition(lively.pt(g.searchX, g.searchY));
        if (this._quickInfoBox) {
          this._quickInfoBox.setPosition(lively.pt(g.quickInfoX, g.quickInfoY));
          this._quickInfoBox.setExtent(lively.pt(g.quickInfoW, g.quickInfoH));
        }
        if (this._frontCardBox) {
          this._frontCardBox.setPosition(lively.pt(g.reelX, g.reelY));
          this._frontCardBox.setExtent(lively.pt(CARD_W, CARD_H));
        }
        if (this._backCardBox) {
          this._backCardBox.setPosition(lively.pt(g.reelX + 8, g.reelY + 8));
          this._backCardBox.setExtent(lively.pt(CARD_W, CARD_H));
        }
        if (this._navBox) this._navBox.setPosition(lively.pt(g.navX, g.navY));
        if (this._threadContainer) {
          this._threadContainer.setPosition(lively.pt(g.threadX, g.threadY));
          this._threadContainer.setExtent(lively.pt(g.threadW, g.threadH));
        }
        if (this._wikiHeaderBox) {
          this._wikiHeaderBox.setPosition(lively.pt(g.wikiHeaderX, g.wikiHeaderY));
          this._wikiHeaderBox.setExtent(lively.pt(g.wikiHeaderW, g.wikiHeaderH));
        }
        if (this._wikiBox) {
          this._wikiBox.setPosition(lively.pt(g.wikiX, g.wikiY));
          this._wikiBox.setExtent(lively.pt(g.wikiW, g.wikiH));
        }
        if (this._membersBox) {
          this._membersBox.setPosition(lively.pt(g.membersX, g.membersY));
          this._membersBox.setExtent(lively.pt(g.membersW, g.membersH));
        }
      },
    },

    // ─── chrome ──────────────────────────────────────────────────────────────

    "chrome", {
      _buildChrome: function () {
        var self = this;

        var loader = document.getElementById("lounge-loader");
        if (loader) loader.remove();
        var staticEl = document.getElementById("lounge-static");
        if (staticEl) staticEl.remove();

        this._searchBox = this._buildSearchField();
        $world.addMorph(this._searchBox);
        this._styleSearchGoButton();

        this._quickInfoBox = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        this._quickInfoBox.setFill(Color.white);
        this._quickInfoBox.applyStyle({ borderWidth: 1, borderColor: Color.rgb(238, 238, 238), borderRadius: 8 });
        $world.addMorph(this._quickInfoBox);

        // Back card slot first (rendered below the front card) — a plain
        // styled rectangle, not a second live PostCardView: showing a
        // "peek of the next card's edge" doesn't need its content
        // pre-fetched and pre-rendered every turn, just a stack-of-cards
        // impression.
        this._backCardBox = new lively.morphic.Box(lively.rect(0, 0, CARD_W, CARD_H));
        this._backCardBox.setFill(Color.rgb(245, 245, 247));
        this._backCardBox.applyStyle({ borderWidth: 0, borderRadius: 10 });
        $world.addMorph(this._backCardBox);

        this._frontCardBox = new lively.morphic.Box(lively.rect(0, 0, CARD_W, CARD_H));
        $world.addMorph(this._frontCardBox);
        var frontNode = this._frontCardBox.renderContext().shapeNode;
        frontNode.style.transformStyle = "preserve-3d";
        frontNode.style.transformOrigin = "0% 50%";
        frontNode.style.transition = "transform 420ms ease, opacity 420ms ease";
        frontNode.parentNode && (frontNode.parentNode.style.perspective = "1400px");

        this._navBox = new lively.morphic.Box(lively.rect(0, 0, 120, 32));
        this._navBox.applyStyle({ fill: null, borderWidth: 0 });
        $world.addMorph(this._navBox);

        var prevBtn = new lively.morphic.Button(lively.rect(0, 0, 32, 32));
        prevBtn.setLabel("←");
        prevBtn.onMouseDown = function () { self._turn(-1); };
        this._navBox.addMorph(prevBtn);
        prevBtn.renderContext().shapeNode.style.borderRadius = "16px";

        this._navLabel = lively.morphic.Text.makeLabel("", { fontSize: 13 });
        this._navLabel.setPosition(lively.pt(40, 8));
        this._navLabel.setExtent(lively.pt(40, 18));
        this._navBox.addMorph(this._navLabel);

        var nextBtn = new lively.morphic.Button(lively.rect(88, 0, 32, 32));
        nextBtn.setLabel("→");
        nextBtn.onMouseDown = function () { self._turn(1); };
        this._navBox.addMorph(nextBtn);
        nextBtn.renderContext().shapeNode.style.borderRadius = "16px";

        this._threadContainer = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        this._threadContainer.setFill(Color.white);
        this._threadContainer.applyStyle({ borderWidth: 1, borderColor: Color.rgb(238, 238, 238), borderRadius: 8 });
        this._threadContainer.renderContext().shapeNode.style.overflowY = "auto";
        this._threadContainer.renderContext().shapeNode.style.padding = "10px 12px";
        $world.addMorph(this._threadContainer);

        this._wikiHeaderBox = new lively.morphic.Box(lively.rect(0, 0, 10, 32));
        this._wikiHeaderBox.applyStyle({ fill: null, borderWidth: 0 });
        $world.addMorph(this._wikiHeaderBox);

        this._wikiPageLabel = lively.morphic.Text.makeLabel("", { fontSize: 13 });
        this._wikiPageLabel.setPosition(lively.pt(0, 7));
        this._wikiPageLabel.setExtent(lively.pt(180, 18));
        this._wikiPageLabel.onMouseDown = function () { self._openWikiPageMenu(); };
        this._wikiHeaderBox.addMorph(this._wikiPageLabel);

        this._wikiNewBtn = new lively.morphic.Button(lively.rect(190, 4, 100, 24));
        this._wikiNewBtn.setLabel("+ New page");
        this._wikiNewBtn.onMouseDown = function () { self._promptNewWikiPage(); };
        this._wikiHeaderBox.addMorph(this._wikiNewBtn);

        this._wikiBox = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        this._wikiBox.setFill(Color.white);
        this._wikiBox.applyStyle({ borderWidth: 1, borderColor: Color.rgb(238, 238, 238), borderRadius: 8 });
        this._wikiBox.renderContext().shapeNode.style.overflow = "auto";
        $world.addMorph(this._wikiBox);

        this._membersBox = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        this._membersBox.setFill(Color.white);
        this._membersBox.applyStyle({ borderWidth: 0 });
        this._membersBox.renderContext().shapeNode.style.borderLeft = "1px solid #eee";
        this._membersBox.renderContext().shapeNode.style.overflowY = "auto";
        this._membersBox.renderContext().shapeNode.style.padding = "14px 10px";
        this._membersBox.renderContext().shapeNode.style.boxSizing = "border-box";
        $world.addMorph(this._membersBox);

        // Only turns the stack when no Lively text field currently has
        // input focus (activeInstance covers the search field and any
        // other Text morph, not just this one) — a global handler, not
        // scoped to a DOM tag check, since none of these fields are raw
        // <input>s anymore.
        document.addEventListener("keydown", function (evt) {
          if (lively.morphic.Text.activeInstance && lively.morphic.Text.activeInstance()) return;
          if (evt.key === "ArrowLeft") self._turn(-1);
          else if (evt.key === "ArrowRight") self._turn(1);
        });

        // This is fixed-layout chrome, not a freeform space (that's the
        // canvas, ConstellationCanvas.js) — nothing here should be
        // draggable. Recurses into submorphs since dragging is a
        // per-morph flag, not inherited from a container.
        [
          this._searchBox, this._quickInfoBox, this._backCardBox, this._frontCardBox,
          this._navBox, this._threadContainer, this._wikiHeaderBox, this._wikiBox, this._membersBox,
        ].forEach(this._disableDragging, this);

        this._layout();
      },

      _disableDragging: function (morph) {
        if (!morph) return;
        morph.disableDragging();
        morph.disableGrabbing();
        (morph.submorphs || []).forEach(this._disableDragging, this);
      },
    },

    // ─── search — rebuild of PartsBin/iPadWidgets/SearchField.json as real morphs ──

    "search", {
      _buildSearchField: function () {
        var self = this;
        var box = new lively.morphic.Box(lively.rect(0, 0, SEARCH_W, SEARCH_H));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(112, 112, 112), borderRadius: 22 });

        var icon = new lively.morphic.Image(lively.rect(11, 12, 22, 20));
        icon.setImageURL(SEARCH_ICON_DATA_URL);
        icon.applyStyle({ borderWidth: 0 });
        box.addMorph(icon);

        var fieldRect = lively.rect(42, 6, SEARCH_W - 42 - 74, SEARCH_H - 12);

        // Plain Text morphs have no native placeholder — a second, purely
        // decorative label sits behind the real field (added first, so the
        // field's own node renders after it in the same stacking context)
        // and is hidden the moment there's real text.
        var placeholder = lively.morphic.Text.makeLabel("Search c/" + this._name + "…", {
          fontSize: 14, textColor: Color.rgb(170, 170, 170),
        });
        placeholder.setPosition(fieldRect.topLeft());
        placeholder.setExtent(fieldRect.extent());
        placeholder.eventsAreIgnored = true;
        box.addMorph(placeholder);
        this._searchPlaceholder = placeholder;

        var field = new lively.morphic.Text(fieldRect, "");
        field.applyStyle({ allowInput: true, fontSize: 14, fill: null, borderWidth: 0 });
        field.beInputLine();
        // Enter fires the search without losing the $super keydown chain
        // (undo/redo, selection, etc. all still work as they do on any
        // other Lively input-line field).
        var superKeyDown = field.onKeyDown;
        field.onKeyDown = function (evt) {
          if (evt.getKeyCode && evt.getKeyCode() === 13) {
            self.search(field.textString);
            evt.stop();
            return true;
          }
          var result = superKeyDown.call(this, evt);
          self._updateSearchPlaceholder();
          return result;
        };
        box.addMorph(field);
        this._searchField = field;

        var go = new lively.morphic.Button(lively.rect(SEARCH_W - 64, 3, 60, SEARCH_H - 6));
        go.setLabel("Go");
        if (go.label && go.label.setTextColor) go.label.setTextColor(Color.rgb(230, 230, 230));
        go.onMouseDown = function () { self.search(field.textString); };
        box.addMorph(go);
        this._searchGoBtn = go;

        return box;
      },

      // Button's fill/borderRadius only take effect once the morph has a
      // live render context (setFill/setBorderRadius silently no-op on a
      // still-detached Button, confirmed by testing — applyStyle({fill:...})
      // hits the exact same setFill path per Core.js and no-ops the same
      // way), so this runs after $world.addMorph, not at construction time.
      _styleSearchGoButton: function () {
        var node = this._searchGoBtn && this._searchGoBtn.renderContext().shapeNode;
        if (!node) return;
        node.style.background = "rgb(53,83,255)";
        node.style.borderRadius = "19px";
      },

      _updateSearchPlaceholder: function () {
        if (this._searchPlaceholder) this._searchPlaceholder.setVisible(!this._searchField.textString);
      },

      // The original PartsBin part's own convention — firing Go calls a
      // "search(queryString)" method on whatever contains the field —
      // just wired directly to this controller.
      search: function (queryString) {
        var q = (queryString || "").trim();
        this._fetchFeed(q || null);
        this._renderWikiHeader(q || null);
      },
    },

    // ─── quick info ──────────────────────────────────────────────────────────

    "quick info", {
      _renderQuickInfo: function () {
        var self = this;
        (this._quickInfoBox.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var qi = this._quickInfo || {};
        var w = this._quickInfoBox.getExtent().x;

        var title = lively.morphic.Text.makeLabel("c/" + this._name, { fontSize: 16, fontWeight: "bold" });
        title.setPosition(lively.pt(14, 12));
        title.setExtent(lively.pt(w - 28, 22));
        this._quickInfoBox.addMorph(title);

        var creatorHandle = qi.memberHandles && qi.createdBy ? qi.memberHandles[qi.createdBy] : null;
        var lines = [
          (qi.visibility || "public") + " · " + (qi.memberCount || 0) +
            " member" + (qi.memberCount === 1 ? "" : "s"),
          "Created " + this._formatDate(qi.createdAt) + (creatorHandle ? (" by @" + creatorHandle) : ""),
        ];
        lines.forEach(function (str, i) {
          var t = lively.morphic.Text.makeLabel(str, { fontSize: 12, textColor: Color.rgb(102, 102, 102) });
          t.setPosition(lively.pt(14, 40 + i * 20));
          t.setExtent(lively.pt(w - 28, 18));
          self._quickInfoBox.addMorph(t);
        });
        this._disableDragging(this._quickInfoBox);
      },

      _formatDate: function (iso) {
        if (!iso) return "—";
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleDateString();
      },
    },

    // ─── postcard turnover reel ────────────────────────────────────────────

    "reel", {
      _fetchFeed: function (q) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = base + "/c/" + encodeURIComponent(this._name) + "/feed?limit=20";
        if (q) url += "&q=" + encodeURIComponent(q);
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError("Failed to load feed (" + xhr.status + ")");
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          self._feedCards = data.postcards || [];
          self._feedCursor = data.cursor || null;
          self._activeIndex = self._feedCards.length ? 0 : -1;
          self._showActiveCard();
        };
        xhr.onerror = function () { self._showError("Network error loading feed"); };
        xhr.send();
      },

      _maybeLoadMore: function (thenDo) {
        if (!this._feedCursor) return thenDo(false);
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = base + "/c/" + encodeURIComponent(this._name) + "/feed?limit=20&cursor=" + encodeURIComponent(this._feedCursor);
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(false);
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return thenDo(false); }
          self._feedCards = self._feedCards.concat(data.postcards || []);
          self._feedCursor = data.cursor || null;
          thenDo((data.postcards || []).length > 0);
        };
        xhr.onerror = function () { thenDo(false); };
        xhr.send();
      },

      // direction: -1 (older) or 1 (newer). Strictly moves the top-level
      // stack position — reply-thread focus never affects this (confirmed
      // requirement: replies don't reorder or otherwise move the stack).
      _turn: function (direction) {
        var self = this;
        var nextIndex = this._activeIndex + direction;
        if (nextIndex < 0) return;
        if (nextIndex >= this._feedCards.length) {
          return this._maybeLoadMore(function (loaded) {
            if (loaded) self._turn(direction);
          });
        }

        var frontNode = this._frontCardBox.renderContext().shapeNode;
        frontNode.style.transform = "rotateY(" + (direction > 0 ? "-100deg" : "100deg") + ")";
        frontNode.style.opacity = "0";

        setTimeout(function () {
          self._activeIndex = nextIndex;
          self._showActiveCard();
          frontNode.style.transition = "none";
          frontNode.style.transform = "rotateY(90deg)";
          frontNode.style.opacity = "0";
          // Force layout before re-enabling the transition, so the
          // turn-in animates rather than snapping.
          frontNode.offsetHeight;
          frontNode.style.transition = "transform 420ms ease, opacity 420ms ease";
          frontNode.style.transform = "rotateY(0deg)";
          frontNode.style.opacity = "1";
        }, 420);
      },

      _showActiveCard: function () {
        var card = this._feedCards[this._activeIndex];
        if (!card) return;
        this._focusStack = [card.objId];
        this._renderNavPosition();
        this._renderCardInto(this._frontCardBox, card.objId);
        this._loadThread(card.objId);
      },

      _renderNavPosition: function () {
        this._navLabel.textString = (this._activeIndex + 1) + " / " + this._feedCards.length + (this._feedCursor ? "+" : "");
      },

      // Fetches the full envelope via the constellation-scoped, handle-free
      // GET /c/:name/:objId route (validates constellation membership
      // itself), resolves the author's handle (PostCardView/WikiView both
      // assume a real handle — avatar loading and, on PostCardView, the
      // approve/decline join-request URLs are built from it — so passing
      // null would silently break more than just the "@" label), and
      // embeds it, clearing any previous occupant first.
      _renderCardInto: function (box, objId) {
        var self = this;
        (box.submorphs || []).slice().forEach(function (m) { m.remove(); });
        this._fetchEnvelope(objId, function (err, envelope) {
          if (err || !envelope) return;
          self._resolveHandle(envelope.did, function (handle) {
            var opts = { target: box, envelope: envelope, bounds: lively.rect(0, 0, box.getExtent().x, box.getExtent().y) };
            if (envelope.type === "wikipage") lively.identity.WikiView.open(handle, objId, opts);
            else lively.identity.PostCardView.open(handle, objId, opts);
          });
        });
      },

      _fetchEnvelope: function (objId, thenDo) {
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/" + encodeURIComponent(objId), true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(new Error("status " + xhr.status));
          try { thenDo(null, JSON.parse(xhr.responseText)); } catch (e) { thenDo(e); }
        };
        xhr.onerror = function () { thenDo(new Error("network error")); };
        xhr.send();
      },

      // Single-DID convenience over the same GET /dids/handles batch route
      // WikiView.js's own _resolveHandles and IdentityServer.js's
      // _resolveHandlesForDids use. Calls thenDo(handle|null) — never
      // thenDo(err, ...), since a lookup failure just means the caller
      // falls back to whatever null-handle behavior it already has.
      _resolveHandle: function (did, thenDo) {
        if (!did) return thenDo(null);
        var qi = this._quickInfo || {};
        if (qi.memberHandles && qi.memberHandles[did]) return thenDo(qi.memberHandles[did]);
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/dids/handles?dids=" + encodeURIComponent(did), true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(null);
          try {
            var data = JSON.parse(xhr.responseText);
            thenDo((data.handles && data.handles[did]) || null);
          } catch (e) { thenDo(null); }
        };
        xhr.onerror = function () { thenDo(null); };
        xhr.send();
      },
    },

    // ─── reply thread — recursive, collapsible, click-to-focus ────────────────

    "thread", {
      _loadThread: function (rootObjId) {
        var self = this;
        this._threadChildrenCache = {};
        this._threadExpanded = {};
        (this._threadContainer.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var loading = lively.morphic.Text.makeLabel("Loading replies…", { fontSize: 12, textColor: Color.gray });
        loading.setPosition(lively.pt(0, 0));
        this._threadContainer.addMorph(loading);

        this._fetchReplies(rootObjId, function (err, replies) {
          self._threadReplies = err ? [] : replies;
          self._renderThreadTree();
        });
      },

      // objId's owning handle is irrelevant to this route (confirmed by
      // reading IdentityServer.js — only req.params.objId is read), so a
      // placeholder handle segment is used rather than resolving a real one.
      _fetchReplies: function (objId, thenDo) {
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/@_/" + encodeURIComponent(objId) + "/replies?limit=50", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(new Error("status " + xhr.status));
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return thenDo(e); }
          thenDo(null, data.postcards || []);
        };
        xhr.onerror = function () { thenDo(new Error("network error")); };
        xhr.send();
      },

      // Rebuilds the whole visible tree from this._threadReplies +
      // this._threadExpanded + this._threadChildrenCache — simplest
      // correct way to keep an expand/collapse-anywhere tree in the right
      // visual order without hand-patching morph insertion points.
      _renderThreadTree: function () {
        var self = this;
        var container = this._threadContainer;
        (container.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var w = container.getExtent().x;

        var breadcrumb = this._buildBreadcrumbRow(w);
        container.addMorph(breadcrumb);
        breadcrumb.setPosition(lively.pt(0, 0));
        var y = breadcrumb.getExtent().y + 8;

        if (!this._threadReplies.length) {
          var empty = lively.morphic.Text.makeLabel("No replies yet.", { fontSize: 12, textColor: Color.gray });
          empty.setPosition(lively.pt(0, y));
          container.addMorph(empty);
        } else {
          this._layoutReplyLevel(container, this._threadReplies, 0, y, w);
        }
        this._disableDragging(container);
      },

      _layoutReplyLevel: function (container, replies, depth, y, w) {
        var self = this;
        replies.forEach(function (reply) {
          var row = self._buildReplyRow(reply, depth, w);
          container.addMorph(row);
          row.setPosition(lively.pt(0, y));
          y += row.getExtent().y + 4;
          if (self._threadExpanded[reply.objId]) {
            var children = self._threadChildrenCache[reply.objId];
            if (children) {
              y = self._layoutReplyLevel(container, children, depth + 1, y, w);
            } else {
              var loading = lively.morphic.Text.makeLabel("Loading…", { fontSize: 11, textColor: Color.gray });
              loading.setPosition(lively.pt((depth + 1) * 16, y));
              loading.setExtent(lively.pt(w - (depth + 1) * 16, 16));
              container.addMorph(loading);
              y += 20;
            }
          }
        });
        return y;
      },

      _buildBreadcrumbRow: function (w) {
        var self = this;
        var row = new lively.morphic.Box(lively.rect(0, 0, w, 18));
        row.applyStyle({ fill: null, borderWidth: 0 });
        var x = 0;
        this._focusStack.forEach(function (objId, i) {
          if (i > 0) {
            var sep = lively.morphic.Text.makeLabel(" › ", { fontSize: 11, textColor: Color.gray });
            sep.setPosition(lively.pt(x, 2));
            sep.setExtent(lively.pt(16, 14));
            row.addMorph(sep);
            x += 16;
          }
          var label = i === 0 ? "top" : "reply";
          var isLast = i === self._focusStack.length - 1;
          var link = lively.morphic.Text.makeLabel(label, {
            fontSize: 11,
            textColor: isLast ? Color.rgb(51, 51, 51) : Color.rgb(51, 102, 204),
          });
          link.setPosition(lively.pt(x, 2));
          link.setExtent(lively.pt(36, 14));
          link.onMouseDown = function () {
            self._focusStack = self._focusStack.slice(0, i + 1);
            self._renderCardInto(self._frontCardBox, objId);
            self._loadThread(objId);
          };
          row.addMorph(link);
          x += 36;
        });
        return row;
      },

      _buildReplyRow: function (reply, depth, w) {
        var self = this;
        var row = new lively.morphic.Box(lively.rect(0, 0, w, 22));
        row.applyStyle({ fill: null, borderWidth: 0 });
        var indent = depth * 16;

        var twisty = lively.morphic.Text.makeLabel(this._threadExpanded[reply.objId] ? "▾" : "▸", {
          fontSize: 11, textColor: Color.gray,
        });
        twisty.setPosition(lively.pt(indent, 4));
        twisty.setExtent(lively.pt(14, 14));
        twisty.onMouseDown = function () {
          self._threadExpanded[reply.objId] = !self._threadExpanded[reply.objId];
          if (self._threadExpanded[reply.objId] && !self._threadChildrenCache[reply.objId]) {
            self._fetchReplies(reply.objId, function (err, children) {
              self._threadChildrenCache[reply.objId] = err ? [] : children;
              self._renderThreadTree();
            });
          }
          self._renderThreadTree();
        };
        row.addMorph(twisty);

        var title = lively.morphic.Text.makeLabel((reply.state && reply.state.title) || "(untitled reply)", {
          fontSize: 12, textColor: Color.rgb(30, 30, 30),
        });
        title.setPosition(lively.pt(indent + 16, 3));
        title.setExtent(lively.pt(Math.max(30, w - indent - 20), 16));
        title.onMouseDown = function () {
          self._focusStack.push(reply.objId);
          self._renderCardInto(self._frontCardBox, reply.objId);
          self._loadThread(reply.objId);
        };
        row.addMorph(title);

        return row;
      },
    },

    // ─── wiki panel ─────────────────────────────────────────────────────────

    "wiki", {
      _fetchWikiIndex: function (thenDo) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/wiki", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo && thenDo();
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return thenDo && thenDo(); }
          self._wikiPages = data.pages || [];
          self._renderWikiHeader(null);
          if (self._wikiPages.length) {
            // listWikiPages sorts by name — pick most-recently-updated
            // client-side for the default page shown.
            var sorted = self._wikiPages.slice().sort(function (a, b) {
              return new Date(b.updatedAt) - new Date(a.updatedAt);
            });
            self._openWikiPage(sorted[0].objId);
          } else {
            self._renderWikiEmpty();
          }
          if (thenDo) thenDo();
        };
        xhr.onerror = function () { if (thenDo) thenDo(); };
        xhr.send();
      },

      _renderWikiEmpty: function () {
        (this._wikiBox.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var empty = lively.morphic.Text.makeLabel("No wiki pages yet.", { fontSize: 13, textColor: Color.gray });
        empty.setPosition(lively.pt(16, 16));
        this._wikiBox.addMorph(empty);
      },

      _renderWikiHeader: function (filterQuery) {
        var pages = this._wikiPages;
        if (filterQuery) {
          var q = filterQuery.toLowerCase();
          pages = pages.filter(function (p) { return (p.wikiName || "").toLowerCase().indexOf(q) !== -1; });
        }
        this._wikiPagesFiltered = pages;

        var current = pages.filter(function (p) { return p.objId === this._activeWikiObjId; }, this)[0];
        this._wikiPageLabel.textString = current ? current.wikiName : (pages[0] ? pages[0].wikiName + " ▾" : "(no pages)");
        this._wikiNewBtn.setVisible(!!this._canWrite);
      },

      _openWikiPageMenu: function () {
        var self = this;
        var pages = this._wikiPagesFiltered || this._wikiPages;
        if (!pages.length) return;
        var items = pages.map(function (p) {
          return [p.wikiName, function () { self._openWikiPage(p.objId); }];
        });
        var pos = this._wikiPageLabel.worldPoint(lively.pt(0, this._wikiPageLabel.getExtent().y));
        lively.morphic.Menu.openAt(pos, "Wiki pages", items);
      },

      // Same handle-free-fetch-then-resolve path as _renderCardInto, for
      // the same reason (a real handle, not null, avoids relying on
      // /@null/:objId happening to work).
      _openWikiPage: function (objId) {
        var self = this;
        this._activeWikiObjId = objId;
        this._renderWikiHeader(null);
        (this._wikiBox.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var extent = this._wikiBox.getExtent();
        this._fetchEnvelope(objId, function (err, envelope) {
          if (err || !envelope) return;
          self._resolveHandle(envelope.did, function (handle) {
            lively.identity.WikiView.open(handle, objId, { target: self._wikiBox, envelope: envelope, bounds: lively.rect(0, 0, extent.x, extent.y) });
          });
        });
      },

      // Mirrors ConstellationCanvas.js's _promptNewWikiPage exactly (same
      // page-name charset, same WikiEditor.newCard entry point) — this is
      // the same "create a wiki page" affordance, just relocated to the
      // lounge's wiki panel instead of the canvas toolbar.
      _promptNewWikiPage: function () {
        var pageName = window.prompt("New wiki page name (letters, numbers, hyphens):");
        if (!pageName) return;
        pageName = pageName.trim();
        if (!/^[a-zA-Z0-9-]{1,64}$/.test(pageName)) {
          return this._showError("Wiki page names may only contain letters, numbers, and hyphens (max 64 chars).");
        }
        var user = lively.identity.did.currentUser();
        if (!user) return this._showError("Not signed in.");
        var self = this;
        var constellationName = this._name;
        lively.require("lively.identity.WikiEditor").toRun(function () {
          lively.identity.WikiEditor.newCard(user.handle, {
            constellation: constellationName,
            wikiName: pageName,
          });
        });
        // newCard opens its own editor window and saves asynchronously as
        // the user types (WikiEditor.js's own debounced autosave) — there's
        // no "saved" callback exposed to hook, so the index is polled for
        // the new page name for a bit instead of just going stale until the
        // next full reload.
        this._pollForWikiPage(pageName, 0);
      },

      _pollForWikiPage: function (pageName, attempt) {
        var self = this;
        if (attempt >= 10) return;
        setTimeout(function () {
          self._fetchWikiIndex(function () {
            var found = self._wikiPages.some(function (p) { return p.wikiName === pageName; });
            if (!found) self._pollForWikiPage(pageName, attempt + 1);
          });
        }, 3000);
      },
    },

    // ─── member list — Discord-style: co-creator / moderators / active ───────

    "members", {
      _renderMemberList: function () {
        (this._membersBox.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var qi = this._quickInfo || {};
        var handles = qi.memberHandles || {};
        var controllers = qi.controllers || [];
        var members = qi.members || [];
        var coCreator = qi.createdBy;
        var moderators = controllers.filter(function (did) { return did !== coCreator; });
        var plainMembers = members.filter(function (did) { return controllers.indexOf(did) === -1; });
        var w = this._membersBox.getExtent().x;

        var y = 4;
        y = this._renderMemberSection(w, y, "CO-CREATOR", [coCreator].filter(Boolean), handles,
          Color.rgb(46, 125, 50), Color.rgb(232, 245, 233), "co-creator");
        y = this._renderMemberSection(w, y, "MODERATORS", moderators, handles,
          Color.rgb(138, 109, 0), Color.rgb(255, 248, 225), "moderator");
        this._renderMemberSection(w, y, "ACTIVE MEMBERS", plainMembers.filter(this._isOnline.bind(this)), handles, null, null, null);
        this._disableDragging(this._membersBox);
      },

      _isOnline: function (did) { return !!this._presenceByDid[did]; },

      _renderMemberSection: function (w, y, label, dids, handles, badgeColor, badgeBg, badgeText) {
        if (!dids.length) return y;
        var self = this;
        var header = lively.morphic.Text.makeLabel(label, { fontSize: 10, textColor: Color.rgb(153, 153, 153) });
        header.setPosition(lively.pt(0, y));
        header.setExtent(lively.pt(w, 14));
        this._membersBox.addMorph(header);
        y += 20;

        dids.forEach(function (did) {
          var handle = handles[did] || (did.slice(0, 10) + "…");
          var row = new lively.morphic.Box(lively.rect(0, y, w, 26));
          row.applyStyle({ fill: null, borderWidth: 0 });

          var avatar = new lively.morphic.Image(lively.rect(0, 1, 22, 22));
          avatar.setImageURL(lively.identity.postCardUtils.identiconDataUrl(did, 22));
          avatar.applyStyle({ borderRadius: 11, borderWidth: 0, clipMode: "hidden" });
          row.addMorph(avatar);

          var nameW = badgeColor ? (w - 30 - 70) : (self._isOnline(did) ? (w - 30 - 12) : (w - 30));
          var nameT = lively.morphic.Text.makeLabel("@" + handle, { fontSize: 12 });
          nameT.setPosition(lively.pt(28, 4));
          nameT.setExtent(lively.pt(Math.max(30, nameW), 16));
          row.addMorph(nameT);

          if (badgeColor) {
            var badge = new lively.morphic.Box(lively.rect(w - 66, 3, 62, 18));
            badge.setFill(badgeBg);
            badge.applyStyle({ borderWidth: 0, borderRadius: 9 });
            var badgeT = lively.morphic.Text.makeLabel(badgeText, { fontSize: 9, textColor: badgeColor });
            badgeT.setPosition(lively.pt(6, 3));
            badgeT.setExtent(lively.pt(52, 12));
            badge.addMorph(badgeT);
            row.addMorph(badge);
          } else if (self._isOnline(did)) {
            var dot = new lively.morphic.Box(lively.rect(w - 14, 8, 8, 8));
            dot.setFill(Color.rgb(67, 160, 71));
            dot.applyStyle({ borderWidth: 0, borderRadius: 4 });
            row.addMorph(dot);
          }

          self._membersBox.addMorph(row);
          y += 30;
        });
        return y + 6;
      },
    },

    // ─── live presence (awareness-only — no layout map observation) ─────────

    "presence", {
      _connectPresence: function () {
        var self = this;
        var Y = this._Y();
        var WebsocketProvider = this._WebsocketProvider();
        if (!Y || !WebsocketProvider || !this._genesisObjId) return;

        var base = lively.identity.did.baseUrl();
        var tokenXhr = new XMLHttpRequest();
        tokenXhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/space-token", true);
        tokenXhr.withCredentials = true;
        tokenXhr.setRequestHeader("Accept", "application/json");
        tokenXhr.onload = function () {
          if (tokenXhr.status !== 200) return;
          var data;
          try { data = JSON.parse(tokenXhr.responseText); } catch (e) { return; }

          self.yDoc = new Y.Doc({ gc: false });
          var syncPort = (typeof window !== "undefined" && window.POSTCARD_SYNC_PORT) || 1234;
          var wsScheme = (typeof location !== "undefined" && location.protocol === "https:") ? "wss:" : "ws:";
          var wsUrl = wsScheme + "//" + location.hostname + ":" + syncPort;
          self.wsProvider = new WebsocketProvider(wsUrl, self._genesisObjId, self.yDoc, {
            connect: true,
            params: { token: data.token },
          });

          var user = lively.identity.did.currentUser();
          var awareness = self.wsProvider.awareness;
          awareness.setLocalStateField("presence", {
            did: user && user.did,
            handle: (user && user.handle) || "anonymous",
          });
          awareness.on("change", function () { self._onAwarenessChange(); });
        };
        tokenXhr.onerror = function () {};
        tokenXhr.send();
      },

      _onAwarenessChange: function () {
        if (!this.wsProvider) return;
        var states = this.wsProvider.awareness.getStates();
        var byDid = {};
        states.forEach(function (state) {
          var presence = state && state.presence;
          if (presence && presence.did) byDid[presence.did] = true;
        });
        this._presenceByDid = byDid;
        this._renderMemberList();
      },
    },

    // ─── membership — menu bar entry (§1.3 pattern, ConstellationCanvas.js) ────
    // Replaces the generic per-world menu bar entry's rename affordance with
    // a constellation-aware dropdown, exactly as ConstellationCanvas.js
    // already does for the canvas — the lounge boots its own separate
    // Lively world (buildConstellationLoungePage), so it gets its own
    // un-patched WorldNameMenuBarEntry instance and needs this too.

    "membership", {
      _installMenuBarEntry: function () {
        var self = this;
        var attempts = 0;
        (function tryInstall() {
          var entry = null;
          var menuBar = typeof $world !== "undefined" && $world && $world.get(/^MenuBar/);
          if (menuBar) {
            entry = (menuBar.submorphs || []).find(function (m) { return m.name === "WorldNameMenuBarEntry"; });
          }
          if (entry) return self._patchMenuBarEntry(entry);
          if (++attempts > 25) return;
          setTimeout(tryInstall, 200);
        })();
      },

      _patchMenuBarEntry: function (entry) {
        var self = this;
        this._menuBarEntry = entry;
        var label = "c/" + this._name;
        entry.currentWorldDisplayName = function () { return label; };
        entry.toolTip = "Constellation " + this._name + " — click for options";
        entry.onMouseUp = function (evt) {
          self._openMembershipMenu(entry);
          evt.stop();
          return true;
        };
        entry.update();
      },

      _openMembershipMenu: function (entry) {
        var self = this;
        var items = [];

        if (this._canWrite) {
          items.push(["✓ Member", function () {}]);
        } else if (this._joinRequestStatus === "pending") {
          items.push(["Request pending…", function () {}]);
        } else {
          items.push(["Join…", function () { self._requestJoin(); }]);
        }

        items.push(["Open canvas", function () {
          window.location.href = "/c/" + encodeURIComponent(self._name) + "/canvas";
        }]);

        var pos = entry.worldPoint(lively.pt(0, entry.getExtent().y));
        lively.morphic.Menu.openAt(pos, "c/" + this._name, items);
      },

      // Identical flow to ConstellationCanvas.js's _requestJoin — a real,
      // client-signed postcard riding the same postal rail, never
      // server-fabricated.
      _requestJoin: function () {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return this._showError("Not signed in.");

        lively.require("lively.identity.PostCardSerializer").toRun(function () {
          var doc = {
            type: "doc",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: "@" + user.handle + " wants to join c/" + self._name + "." }],
            }],
          };
          lively.identity.postCardSerializer.serializePlainToEnvelope({
            doc: doc,
            title: "Join request for c/" + self._name,
            titleExplicit: true,
            constellation: self._name,
            visibility: "public",
            stateMeta: { kind: "constellation-join-request" },
          }, function (err, envelope) {
            if (err) return self._showError("Could not create join request: " + err.message);

            var base = lively.identity.did.baseUrl();
            var putXhr = new XMLHttpRequest();
            putXhr.open("PUT", base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(envelope.objId), true);
            putXhr.withCredentials = true;
            putXhr.setRequestHeader("Content-Type", "application/json");
            putXhr.onload = function () {
              if (putXhr.status !== 200) return self._showError("Could not save join request card (" + putXhr.status + ")");

              var postXhr = new XMLHttpRequest();
              postXhr.open("POST", base + "/c/" + encodeURIComponent(self._name) + "/join-requests", true);
              postXhr.withCredentials = true;
              postXhr.setRequestHeader("Content-Type", "application/json");
              postXhr.onload = function () {
                if (postXhr.status !== 201) {
                  var msg = "Join request failed (" + postXhr.status + ")";
                  try { var body = JSON.parse(postXhr.responseText); if (body.error) msg = body.error; } catch (e) {}
                  return self._showError(msg);
                }
                self._joinRequestStatus = "pending";
                $world.alert("Join request sent — the constellation's controller(s) will see it in their mailbox.");
              };
              postXhr.onerror = function () { self._showError("Network error sending join request"); };
              postXhr.send(JSON.stringify({ objId: envelope.objId }));
            };
            putXhr.onerror = function () { self._showError("Network error saving join request card"); };
            putXhr.send(JSON.stringify(envelope));
          });
        });
      },
    },

    // ─── runtime lookup + errors ──────────────────────────────────────────────

    "runtime", {
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
        console.error("[ConstellationLounge]", msg);
      },
    });

    // Static open helper — constructs a fresh controller bound to $world.
    // Callers (buildConstellationLoungePage's onStartWorld hook) are
    // expected to only call this once $world already exists.
    lively.identity.ConstellationLounge = {
      open: function (name) {
        var controller = new lively.identity.ConstellationLoungeController();
        controller.open(name);
        return controller;
      },
    };

  });
