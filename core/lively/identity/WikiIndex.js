/**
 * lively.identity.WikiIndex
 *
 * Boots as a full standalone Lively world at /c/:name/wiki — every wiki
 * page in a constellation, laid out as a grid of real morphs (search field,
 * "+ New wiki page" button, one card per page), rather than the plain
 * server-rendered <ul> the route used to fall back to for an HTML request.
 * Same two-mode shape as ConstellationLounge/ConstellationCanvas: a static
 * skeleton for fast first paint (buildWikiIndexPage, IdentityServer.js),
 * then this controller takes over once $world exists.
 *
 * Every visible element is a real morph added via $world.addMorph/
 * box.addMorph — same rationale as ConstellationLounge.js's file header
 * (halo-select/Object-Editor inspectability, and avoiding the raw-DOM
 * focus-stealing/z-order bugs that file documents from its own first pass).
 * The search field reuses ConstellationLounge.js's exact technique (a
 * lively.morphic.Text with beInputLine(), not a native <input>) rather than
 * re-deriving the native-input-in-a-morph gotchas CLAUDE.md documents.
 *
 * Clicking a page card opens it via lively.identity.WikiView.open(handle,
 * objId) with no target, which centers it standalone in $world — the same
 * entry point ConstellationLounge.js's own wiki panel uses (just without a
 * target/bounds override), so the page reuses that class's fetch/render/
 * verify logic outright instead of duplicating it here.
 *
 * Open: lively.identity.WikiIndex.open(name) — called from
 * buildWikiIndexPage's onStartWorld hook once $world exists.
 */

module("lively.identity.WikiIndex")
  .requires(
    "lively.identity.DID",
    "lively.identity.WikiView",
    "lively.identity.WikiEditor",
    "lively.identity.NewWikiPageDialog",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    var TOP = 64;              // top margin below the menu bar
    var SIDE_MARGIN = 40;
    var HEADER_H = 52;         // bumped along with the breadcrumb/title font sizes below
    var GRID_TOP_GAP = 24;     // gap between the header row and the card grid
    var SEARCH_W = 280, SEARCH_H = 34;
    var NEW_BTN_W = 150, NEW_BTN_H = 34;
    var CARD_W = 260, CARD_H = 96; // CARD_H is a floor — _fitCard grows a card taller if its title wraps
    var GRID_GAP = 16;
    var SIDEBAR_W = 260;       // reserved gutter to the left of the wiki view for a future sidebar panel
    var SIDEBAR_GAP = 24;      // gap between that gutter and the wiki view

    Object.subclass("lively.identity.WikiIndexController",

    "initializing", {
      initialize: function () {
        // scope: { kind: 'constellation', name } | { kind: 'personal', handle }
        // — everything below that used to assume a constellation name
        // branches on scope.kind instead. See open()/openPersonal() below.
        this._scope = null;
        this._pages = [];
        this._pagesFiltered = [];
        this._filterQuery = "";
        this._canWrite = false;
        this._quickInfo = null;
        this._cardMorphs = [];
        this._didHandleCache = {};
        this._activeContentMorph = null; // a read-only WikiView or an editable WikiEditor
        this._sidebarBox = null;
      },
    },

    // ─── boot ─────────────────────────────────────────────────────────────────

    "boot", {
      // Back-compat entry point — every existing caller (buildWikiIndexPage's
      // onStartWorld hook, ConstellationLounge.js's "Open wiki" link target)
      // passes a bare constellation name string.
      open: function (name) {
        this._openScope({ kind: "constellation", name: name });
      },

      openPersonal: function (handle) {
        this._openScope({ kind: "personal", handle: handle });
      },

      _openScope: function (scope) {
        this._scope = scope;
        if (scope.kind === "personal") return this._startPersonal();
        this._loadSpaceToken();
      },

      // Constellation scope: canWrite/quickInfo come from a space-token
      // round trip (membership isn't known client-side).
      _loadSpaceToken: function () {
        var self = this;
        var name = this._scope.name;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(name) + "/space-token", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError("Failed to load c/" + name + " (" + xhr.status + ")");
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return self._showError("Bad space-token response"); }
          self._canWrite = !!data.canWrite;
          self._quickInfo = data.quickInfo || {};
          self._fetchWikiIndex();
        };
        xhr.onerror = function () { self._showError("Network error loading c/" + name); };
        xhr.send();
      },

      // Personal scope: canWrite is just "is this session's own handle" —
      // no membership concept, no round trip needed (confirmed server-side:
      // GET /@:handle/wiki and the wikipage PUT owner check both key off
      // the session did directly).
      _startPersonal: function () {
        var user = lively.identity.did.currentUser();
        this._canWrite = !!(user && user.handle === this._scope.handle);
        this._quickInfo = {};
        this._fetchWikiIndex();
      },

      _fetchWikiIndex: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = this._scope.kind === "personal"
          ? base + "/@" + encodeURIComponent(this._scope.handle) + "/wiki"
          : base + "/c/" + encodeURIComponent(this._scope.name) + "/wiki";
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError("Failed to load wiki index (" + xhr.status + ")");
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return self._showError("Bad wiki index response"); }
          self._pages = data.pages || [];
          self._start();
        };
        xhr.onerror = function () { self._showError("Network error loading wiki index"); };
        xhr.send();
      },

      _start: function () {
        document.title = this._scope.kind === "personal"
          ? "@" + this._scope.handle + " wiki"
          : "c/" + this._scope.name + " wiki";
        this._buildChrome();
        this._renderPages();
        this._installMenuBarEntry();
        var self = this;
        window.addEventListener("resize", function () { self._layout(); });
      },
    },

    // ─── chrome ─────────────────────────────────────────────────────────────────

    "chrome", {
      _buildChrome: function () {
        var loader = document.getElementById("wiki-index-loader");
        if (loader) loader.remove();
        var staticEl = document.getElementById("wiki-index-static");
        if (staticEl) staticEl.remove();

        this._backBtn = this._buildBackButton();
        $world.addMorph(this._backBtn);

        var titleText = this._scope.kind === "personal"
          ? "@" + this._scope.handle + " wiki"
          : "c/" + this._scope.name + " wiki";
        this._titleLabel = lively.morphic.Text.makeLabel(titleText, {
          fontSize: 22, fontWeight: "bold", textColor: Color.rgb(20, 20, 20),
        });
        $world.addMorph(this._titleLabel);

        this._searchBox = this._buildSearchField();
        $world.addMorph(this._searchBox);

        this._newBtn = new lively.morphic.Button(lively.rect(0, 0, NEW_BTN_W, NEW_BTN_H));
        this._newBtn.setLabel("+ New wiki page");
        var self = this;
        this._newBtn.onMouseDown = function () { self._promptNewWikiPage(); };
        $world.addMorph(this._newBtn);
        this._newBtn.setVisible(this._canWrite);

        this._gridBox = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        this._gridBox.applyStyle({ fill: null, borderWidth: 0 });
        $world.addMorph(this._gridBox);

        // Reserved gutter to the left of the wiki view (see SIDEBAR_W) —
        // built hidden and only shown/populated once a page is actually
        // open (_renderSidebar), since there's nothing to show before that.
        this._sidebarBox = this._buildSidebar();
        $world.addMorph(this._sidebarBox);
        this._sidebarBox.setVisible(false);

        this._layout();
      },

      // makeLabel hugs its own content (no fixedWidth/fixedHeight), unlike a
      // plain `new lively.morphic.Text(rect)` with a hardcoded width — a
      // fixed-width box here wrapped onto a second line for constellation
      // names anywhere near that width, overlapping whatever sits below it
      // (confirmed live with "wikitest": "← c/wikitest" wrapped and its
      // second line overlapped the grid's empty-filter-result message).
      _buildBackButton: function () {
        var self = this;
        var isPersonal = this._scope.kind === "personal";
        var label = isPersonal ? "← @" + this._scope.handle : "← c/" + this._scope.name;
        var href = isPersonal
          ? "/@" + encodeURIComponent(this._scope.handle)
          : "/c/" + encodeURIComponent(this._scope.name);
        var btn = lively.morphic.Text.makeLabel(label, {
          fontSize: 14, fontWeight: "500", textColor: Color.rgb(70, 70, 70),
        });
        btn.onMouseDown = function () { window.location.href = href; };
        return btn;
      },

      _buildSearchField: function () {
        var self = this;
        var box = new lively.morphic.Box(lively.rect(0, 0, SEARCH_W, SEARCH_H));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(200, 200, 200), borderRadius: 17 });

        var fieldRect = lively.rect(14, 6, SEARCH_W - 28, SEARCH_H - 12);

        var placeholder = lively.morphic.Text.makeLabel("Search wiki pages…", {
          fontSize: 12, textColor: Color.rgb(170, 170, 170),
        });
        placeholder.setPosition(fieldRect.topLeft());
        placeholder.setExtent(fieldRect.extent());
        placeholder.eventsAreIgnored = true;
        box.addMorph(placeholder);
        this._searchPlaceholder = placeholder;

        var field = new lively.morphic.Text(fieldRect, "");
        field.applyStyle({ allowInput: true, fontSize: 12, fill: null, borderWidth: 0 });
        field.beInputLine();
        var superKeyDown = field.onKeyDown;
        field.onKeyDown = function (evt) {
          var result = superKeyDown.call(this, evt);
          // The keystroke that produced this event hasn't necessarily landed
          // in field.textString yet at this point (confirmed live: reading
          // it synchronously here always lagged one character behind, e.g.
          // typing "zzz-no-match" filtered/rendered as "zzz-no-matc") — defer
          // to the next tick so the character insertion has actually landed.
          setTimeout(function () {
            self._searchPlaceholder.setVisible(!field.textString);
            self._filterQuery = field.textString || "";
            self._renderPages();
          }, 0);
          return result;
        };
        box.addMorph(field);
        this._searchField = field;

        return box;
      },

      // Left-hand "On this page" panel — see _renderSidebar for how it's
      // populated once a topic is open, and _repositionWikiView for how
      // it's kept pinned alongside the wiki view.
      _buildSidebar: function () {
        var box = new lively.morphic.Box(lively.rect(0, 0, SIDEBAR_W, 80));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(230, 230, 230), borderRadius: 8 });

        var header = lively.morphic.Text.makeLabel("ON THIS PAGE", {
          fontSize: 11, fontWeight: "700", textColor: Color.rgb(150, 150, 150),
        });
        header.setPosition(lively.pt(16, 14));
        header.eventsAreIgnored = true;
        box.addMorph(header);

        box._itemMorphs = [];
        return box;
      },
    },

    // ─── layout ─────────────────────────────────────────────────────────────────

    "layout", {
      _layout: function () {
        var W = window.innerWidth;

        this._backBtn.setPosition(lively.pt(SIDE_MARGIN, TOP));
        this._titleLabel.setPosition(lively.pt(SIDE_MARGIN, TOP + 28));

        this._searchBox.setPosition(lively.pt(W - SIDE_MARGIN - NEW_BTN_W - 12 - SEARCH_W, TOP));
        this._newBtn.setPosition(lively.pt(W - SIDE_MARGIN - NEW_BTN_W, TOP + (SEARCH_H - NEW_BTN_H) / 2));

        var gridY = TOP + HEADER_H + GRID_TOP_GAP;
        this._gridY = gridY;
        var gridW = Math.max(CARD_W, W - SIDE_MARGIN * 2);
        this._gridBox.setPosition(lively.pt(SIDE_MARGIN, gridY));
        this._gridBox.setExtent(lively.pt(gridW, Math.max(200, window.innerHeight - gridY - 20)));

        this._layoutGrid();
      },

      // Cards can be taller than the CARD_H floor once _fitCard hugs a
      // wrapped title, so rows are packed shelf-style (each row's height is
      // its tallest card) instead of assuming a uniform CARD_H — a uniform
      // assumption would let a wrapped card's second line overlap the row
      // below it. Tracks the grid's real total content height (not the
      // _gridBox's own fill-to-bottom-of-window extent, which is generous
      // padding, not content) so an open WikiView can be placed right below
      // the actual last row instead of overlapping it.
      _layoutGrid: function () {
        var gridW = this._gridBox.getExtent().x || CARD_W;
        var columns = Math.max(1, Math.floor((gridW + GRID_GAP) / (CARD_W + GRID_GAP)));

        var rowHeights = [];
        this._cardMorphs.forEach(function (card, i) {
          var row = Math.floor(i / columns);
          rowHeights[row] = Math.max(rowHeights[row] || 0, card._cardH || CARD_H);
        });
        var rowTops = [];
        var y = 0;
        rowHeights.forEach(function (h, row) {
          rowTops[row] = y;
          y += h + GRID_GAP;
        });
        this._cardMorphs.forEach(function (card, i) {
          var col = i % columns;
          var row = Math.floor(i / columns);
          card.setPosition(lively.pt(col * (CARD_W + GRID_GAP), rowTops[row]));
        });

        this._gridContentHeight = rowHeights.length ? (y - GRID_GAP) : 0;
        this._repositionWikiView();
      },

      // Keeps the currently-open topic WikiView (see _openPage) and its
      // "On this page" sidebar pinned just below the grid's real content,
      // not the world-centered position WikiView.open's own _openInWorld
      // would otherwise give the view — called after every grid reflow
      // (search filtering, window resize) since the grid's content height
      // can change under it. The view is held off SIDE_MARGIN by
      // SIDEBAR_W + SIDEBAR_GAP so the sidebar has room alongside it.
      _repositionWikiView: function () {
        var y = (this._gridY || 0) + (this._gridContentHeight || 0) + GRID_TOP_GAP;
        if (this._activeContentMorph && this._activeContentMorph.world()) {
          this._activeContentMorph.setPosition(lively.pt(SIDE_MARGIN + SIDEBAR_W + SIDEBAR_GAP, y));
        }
        if (this._sidebarBox && this._sidebarBox.world() && this._sidebarBox.isVisible()) {
          this._sidebarBox.setPosition(lively.pt(SIDE_MARGIN, y));
        }
      },
    },

    // ─── page grid ──────────────────────────────────────────────────────────────

    "pages", {
      _renderPages: function () {
        var self = this;
        (this._cardMorphs || []).forEach(function (m) { m.remove(); });
        this._cardMorphs = [];

        var q = (this._filterQuery || "").toLowerCase();
        var pages = q
          ? this._pages.filter(function (p) { return (p.wikiName || "").toLowerCase().indexOf(q) !== -1; })
          : this._pages;
        this._pagesFiltered = pages;

        if (!pages.length) {
          var empty = lively.morphic.Text.makeLabel(
            this._pages.length ? "No wiki pages match “" + this._filterQuery + "”." : "No wiki pages yet.",
            { fontSize: 13, textColor: Color.gray },
          );
          empty.setPosition(lively.pt(0, 0));
          this._gridBox.addMorph(empty);
          this._cardMorphs.push(empty);
          this._gridContentHeight = 0;
          this._repositionWikiView();
          return;
        }

        pages.forEach(function (p) {
          var card = self._buildPageCard(p);
          self._gridBox.addMorph(card);
          self._fitCard(card);
          self._cardMorphs.push(card);
        });
        this._layoutGrid();
      },

      _buildPageCard: function (page) {
        var self = this;
        var card = new lively.morphic.Box(lively.rect(0, 0, CARD_W, CARD_H));
        card.setFill(Color.white);
        card.applyStyle({ borderWidth: 1, borderColor: Color.rgb(230, 230, 230), borderRadius: 8 });
        card.renderContext().shapeNode.style.cursor = "pointer";

        // Fixed width, left to wrap naturally (wiki page names are
        // letters/numbers/hyphens only, no spaces — see
        // _promptNewWikiPage's charset — so wrapping happens at hyphen
        // boundaries) instead of the old nowrap+ellipsis truncation.
        // _fitCard below measures the real (possibly wrapped) height once
        // this card is actually live in the world and hugs the card/date
        // position to it.
        var nameLabel = new lively.morphic.Text(lively.rect(14, 14, CARD_W - 28, 1), page.wikiName);
        nameLabel.applyStyle({
          fontSize: 15, fontWeight: "600", textColor: Color.rgb(30, 30, 30),
          fill: null, borderWidth: 0, borderColor: null,
        });
        nameLabel.eventsAreIgnored = true;
        card.addMorph(nameLabel);

        var dateLabel = lively.morphic.Text.makeLabel("Updated " + this._formatDate(page.updatedAt), {
          fontSize: 12, textColor: Color.rgb(150, 150, 150),
        });
        dateLabel.eventsAreIgnored = true;
        card.addMorph(dateLabel);

        card._nameLabel = nameLabel;
        card._dateLabel = dateLabel;
        card._cardH = CARD_H;
        card.onMouseDown = function () { self._openPage(page); };
        return card;
      },

      // Only safe to call once `card` is actually in the world (added to
      // _gridBox, itself already in $world) — a Text morph's rendered
      // height reads back as garbage before that. The box's own height was
      // set to 1px (not a generous guess) when the label was created: the
      // rendered content div's CSS is `min-height: calc(100% - 4px)` of the
      // box's *own* height, so a generous throwaway height becomes a floor
      // a short title's true content height can never measure below — see
      // CLAUDE.md's Text-morph sizing notes. A 1px box makes that floor
      // negligible, so offsetHeight reflects the real (possibly
      // multi-line) wrapped content.
      _fitCard: function (card) {
        var nameLabel = card._nameLabel, dateLabel = card._dateLabel;
        var innerDiv = nameLabel.renderContext().shapeNode.querySelector("div");
        var titleH = innerDiv ? innerDiv.offsetHeight : 20;
        // +4: shapeNode's own top/bottom padding that setExtent subtracts
        // back out, see CLAUDE.md.
        nameLabel.setExtent(lively.pt(CARD_W - 28, titleH + 4));

        var dateY = 14 + titleH + 4 + 8;
        dateLabel.setPosition(lively.pt(14, dateY));

        var cardH = Math.max(CARD_H, dateY + 18 + 14);
        card.setExtent(lively.pt(CARD_W, cardH));
        card._cardH = cardH;
      },

      // WikiView.open's own _openInWorld centers a standalone view on the
      // visible viewport, which overlaps this page's topic grid — pin it
      // below the grid's real content instead (_repositionWikiView), and
      // cap its width to the available space rather than WikiView's
      // fixed 1180px default. Passes the envelope _resolveHandle already
      // fetched straight through as opts.envelope: WikiView.open renders it
      // synchronously in that case (see WikiView.js's _setup), which both
      // saves a redundant fetch and means getOutline() below already has
      // real content to read the instant open() returns.
      _openPage: function (page) {
        var self = this;
        this._resolveHandle(page.objId, function (handle, envelope) {
          var leftEdge = SIDE_MARGIN + SIDEBAR_W + SIDEBAR_GAP;
          var w = Math.min(1180, window.innerWidth - leftEdge - SIDE_MARGIN);
          var opts = { bounds: lively.rect(0, 0, w, 780) };
          if (envelope) opts.envelope = envelope;
          self._setActiveContentMorph(lively.identity.WikiView.open(handle, page.objId, opts));
        });
      },

      // Both the read-only WikiView (existing page) and the editable
      // WikiEditor (newly-created page, see _createNewPage) end up pinned
      // in this same slot and expose getOutline() — this is the one place
      // that swap happens, so _openPage/_createNewPage don't need to know
      // about each other's shape.
      _setActiveContentMorph: function (morph) {
        if (this._activeContentMorph && this._activeContentMorph !== morph) {
          this._activeContentMorph.remove();
        }
        this._activeContentMorph = morph;
        morph.bringToFront();
        this._renderSidebar(morph);
        this._repositionWikiView();
      },

      // Populates the "On this page" sidebar from the page's real rendered
      // headings (WikiView#getOutline) — clicking an entry scrolls that
      // exact heading element into view inside the WikiView's own
      // (overflow-y:auto) content area.
      _renderSidebar: function (view) {
        var box = this._sidebarBox;
        (box._itemMorphs || []).forEach(function (m) { m.remove(); });
        box._itemMorphs = [];

        var outline = (view && view.getOutline) ? view.getOutline() : [];
        var y = 40;

        if (!outline.length) {
          var empty = lively.morphic.Text.makeLabel("No headings in this page.", {
            fontSize: 12, textColor: Color.rgb(170, 170, 170),
          });
          empty.setPosition(lively.pt(16, y));
          box.addMorph(empty);
          box._itemMorphs.push(empty);
          y += 22;
        } else {
          var minLevel = Math.min.apply(null, outline.map(function (h) { return h.level; }));
          outline.forEach(function (h) {
            var indent = Math.min(3, h.level - minLevel) * 14;
            var item = new lively.morphic.Text(
              lively.rect(16 + indent, y, SIDEBAR_W - 32 - indent, 18),
              h.text || "(untitled heading)",
            );
            item.applyStyle({
              fontSize: h.level === minLevel ? 13 : 12,
              fontWeight: h.level === minLevel ? "600" : "400",
              textColor: Color.rgb(50, 50, 50), fill: null, borderWidth: 0, borderColor: null,
            });
            box.addMorph(item);
            // A TOC entry is meant to read as one line per heading (unlike
            // the topic-card titles above, which wrap on purpose) — force
            // single-line ellipsis truncation the same way those used to.
            var itemNode = item.renderContext().shapeNode;
            itemNode.style.cursor = "pointer";
            var itemDiv = itemNode.querySelector("div");
            if (itemDiv) {
              itemDiv.style.whiteSpace = "nowrap";
              itemDiv.style.overflow = "hidden";
              itemDiv.style.textOverflow = "ellipsis";
            }
            item.onMouseDown = function () {
              if (h.el && h.el.scrollIntoView) h.el.scrollIntoView({ behavior: "smooth", block: "start" });
            };
            box._itemMorphs.push(item);
            y += 22;
          });
        }

        box.setExtent(lively.pt(SIDEBAR_W, y + 14));
        box.setVisible(true);
      },

      // Wiki pages carry their author's DID only inside the envelope, not
      // in listWikiPages' summary rows — fetch the envelope once (reusing
      // the same read path every other constellation-scoped object uses),
      // then resolve that DID to a handle the same way WikiView.js's own
      // top-bar avatar does. Hands the already-fetched envelope back too
      // (thenDo(handle, envelope)) so _openPage can pass it straight to
      // WikiView.open as opts.envelope instead of making WikiView re-fetch
      // the exact same thing a moment later.
      // Personal scope already knows the owning handle (there's only ever
      // one — the scope's own handle), so this skips straight to the plain
      // /@handle/:objId read instead of the constellation path's DID
      // resolution dance.
      _resolveHandle: function (objId, thenDo) {
        if (this._scope.kind === "personal") return this._resolveHandlePersonal(objId, thenDo);
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._scope.name) + "/" + encodeURIComponent(objId), true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(null, null);
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) { return thenDo(null, null); }
          var did = envelope.did;
          if (!did) return thenDo(null, envelope);
          var qi = self._quickInfo || {};
          if (qi.memberHandles && qi.memberHandles[did]) return thenDo(qi.memberHandles[did], envelope);
          if (self._didHandleCache[did]) return thenDo(self._didHandleCache[did], envelope);
          var hxhr = new XMLHttpRequest();
          hxhr.open("GET", base + "/dids/handles?dids=" + encodeURIComponent(did), true);
          hxhr.withCredentials = true;
          hxhr.setRequestHeader("Accept", "application/json");
          hxhr.onload = function () {
            if (hxhr.status !== 200) return thenDo(null, envelope);
            try {
              var handle = (JSON.parse(hxhr.responseText).handles || {})[did] || null;
              if (handle) self._didHandleCache[did] = handle;
              thenDo(handle, envelope);
            } catch (e) { thenDo(null, envelope); }
          };
          hxhr.onerror = function () { thenDo(null, envelope); };
          hxhr.send();
        };
        xhr.onerror = function () { thenDo(null, null); };
        xhr.send();
      },

      _resolveHandlePersonal: function (objId, thenDo) {
        var handle = this._scope.handle;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/@" + encodeURIComponent(handle) + "/" + encodeURIComponent(objId), true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(null, null);
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) { return thenDo(null, null); }
          thenDo(handle, envelope);
        };
        xhr.onerror = function () { thenDo(null, null); };
        xhr.send();
      },

      _formatDate: function (iso) {
        if (!iso) return "—";
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleDateString();
      },

      // Opens the Title/Category/Tags dialog (replacing the old
      // window.prompt-only flow) and, on Create, embeds a brand-new
      // WikiEditor directly in-page — the same pinned-below-grid slot
      // _openPage's read-only WikiView uses (_setActiveContentMorph) —
      // instead of the old floating-window-plus-polling-for-completion
      // hack (_pollForWikiPage/_fetchWikiIndexSilently, both removed: the
      // editor is embedded synchronously now, so there's nothing to poll
      // for).
      _promptNewWikiPage: function () {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return this._showError("Not signed in.");
        var scope = this._scope.kind === "personal"
          ? { handle: this._scope.handle }
          : { constellation: this._scope.name };
        lively.require("lively.identity.NewWikiPageDialog").toRun(function () {
          lively.identity.NewWikiPageDialog.open({
            scope: scope,
            onCreate: function (fields) { self._createNewPage(user.handle, fields); },
          });
        });
      },

      _createNewPage: function (handle, fields) {
        var self = this;
        lively.require("lively.identity.WikiEditor").toRun(function () {
          var leftEdge = SIDE_MARGIN + SIDEBAR_W + SIDEBAR_GAP;
          var w = Math.min(1180, window.innerWidth - leftEdge - SIDE_MARGIN);
          var newCardOpts = {
            wikiName: fields.wikiName,
            category: fields.category,
            tags: fields.tags,
            bounds: lively.rect(0, 0, w, 780),
            // Added directly to $world (not a floating window) — the same
            // top-level-morph shape _openPage's read-only WikiView already
            // has, so _setActiveContentMorph/_repositionWikiView can
            // position either one identically via plain setPosition.
            target: $world,
            // Clicking Save (not autosave — see WikiEditor.js's _buildFooter)
            // swaps the editor for the same read-only WikiView _openPage
            // already uses to display an existing page, so a freshly-created
            // page ends up presented exactly like any other once you're done
            // with it, rather than staying in edit mode indefinitely.
            onSaved: function (savedHandle, objId) {
              var opts2 = { bounds: lively.rect(0, 0, w, 780) };
              self._setActiveContentMorph(lively.identity.WikiView.open(savedHandle, objId, opts2));
            },
          };
          if (self._scope.kind === "constellation") newCardOpts.constellation = self._scope.name;

          var editor = lively.identity.WikiEditor.newCard(handle, newCardOpts);
          self._setActiveContentMorph(editor);
          // this._pages is refreshed (silently, not re-rendering the grid
          // mid-edit) once the genesis autosave lands, so the new card
          // appears in the grid without a manual reload — independent of
          // onSaved above, which only fires on an explicit Save click and
          // handles swapping the open view, not the grid card.
          self._pollForFirstSave(editor, fields.wikiName, 0);
        });
      },

      _pollForFirstSave: function (editor, wikiName, attempt) {
        var self = this;
        if (attempt >= 20) return;
        setTimeout(function () {
          if (editor._objId) {
            self._fetchWikiIndexSilently(function () {
              var found = self._pages.some(function (p) { return p.wikiName === wikiName; });
              if (found) self._renderPages();
            });
            return;
          }
          self._pollForFirstSave(editor, wikiName, attempt + 1);
        }, 500);
      },

      _fetchWikiIndexSilently: function (thenDo) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = this._scope.kind === "personal"
          ? base + "/@" + encodeURIComponent(this._scope.handle) + "/wiki"
          : base + "/c/" + encodeURIComponent(this._scope.name) + "/wiki";
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status === 200) {
            try { self._pages = JSON.parse(xhr.responseText).pages || self._pages; } catch (e) {}
          }
          thenDo();
        };
        xhr.onerror = function () { thenDo(); };
        xhr.send();
      },
    },

    // ─── menu bar ───────────────────────────────────────────────────────────────

    "menu bar", {
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
        var isPersonal = this._scope.kind === "personal";
        var label = isPersonal ? "@" + this._scope.handle + " wiki" : "c/" + this._scope.name + " wiki";
        var backHref = isPersonal
          ? "/@" + encodeURIComponent(this._scope.handle)
          : "/c/" + encodeURIComponent(this._scope.name);
        var tooltip = isPersonal
          ? "@" + this._scope.handle + " — back to your home world"
          : "Constellation " + this._scope.name + " — back to c/" + this._scope.name;
        entry.currentWorldDisplayName = function () { return label; };
        entry.toolTip = tooltip;
        entry.onMouseUp = function (evt) {
          window.location.href = backHref;
          evt.stop();
          return true;
        };
        entry.update();
      },

      _showError: function (msg) {
        console.error("[WikiIndex]", msg);
      },
    });

    // Static open helpers — construct a fresh controller bound to $world.
    // Callers (buildWikiIndexPage's/buildPersonalWikiIndexPage's
    // onStartWorld hooks) are expected to only call these once $world
    // already exists.
    lively.identity.WikiIndex = {
      open: function (name) {
        var controller = new lively.identity.WikiIndexController();
        controller.open(name);
        return controller;
      },
      openPersonal: function (handle) {
        var controller = new lively.identity.WikiIndexController();
        controller.openPersonal(handle);
        return controller;
      },
    };

  });
