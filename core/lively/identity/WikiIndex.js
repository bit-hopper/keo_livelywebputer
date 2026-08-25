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
    var SORT_W = 150, SORT_H = SEARCH_H;   // same row/height as the search box, sits to its left
    var SORT_GAP = 10;          // gap between the sort-by button and the search box
    var SORT_ITEM_H = 30;
    var SORT_OPTIONS = [
      { key: "modified", label: "last modified" },
      { key: "created",  label: "last created" },
      { key: "alpha",    label: "alphabetical" },
    ];
    var CARD_W = 260, CARD_H = 96; // CARD_H is a floor — _fitCard grows a card taller if its title wraps
    var GRID_GAP = 16;
    var SIDEBAR_W = 260;       // reserved gutter to the left of the wiki view for a future sidebar panel
    var SIDEBAR_GAP = 24;      // gap between that gutter and the wiki view
    var SIDEBAR_PAD = 12;      // left/top inset for the home button + search row
    var SIDEBAR_TOOLROW_H = 28; // shared height of the home button and search field
    var SIDEBAR_HEADER_TOP = SIDEBAR_PAD + SIDEBAR_TOOLROW_H + 10; // "ON THIS PAGE" label y
    var SIDEBAR_ITEMS_TOP = SIDEBAR_HEADER_TOP + 26;               // first outline item y

    // Reserved gutter to the right of the wiki view — categories/tags
    // browse panel, always visible (unlike SIDEBAR_W's left gutter, which
    // only shows once a page is open). Same fixed order as
    // NewWikiPageDialog.js's own CATEGORIES list (duplicated here rather
    // than imported — that list is a closure-local var in a BuildSpec
    // module, not something exported for another file to depend on) so
    // categories appear in a stable, expected order instead of whatever
    // order pages happen to be fetched in.
    var CATEGORY_ORDER = ["Biography", "Place", "Event", "Concept", "Organization", "How-To"];
    var RIGHT_PANEL_W = 260;
    var RIGHT_PANEL_GAP = 24;
    var PANEL_PAD = 14;
    var PANEL_HEADER_TOP = 14;
    var PANEL_ITEMS_TOP = PANEL_HEADER_TOP + 26;
    var CATEGORY_LABEL_H = 20;
    var CATEGORY_BLOCK_GAP = 16;   // vertical gap after a category's tag pills, before the next category
    var PILL_H = 24;
    var PILL_PAD_X = 10;
    var PILL_GAP_X = 6;
    var PILL_GAP_Y = 8;

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
        this._sidebarMode = "outline"; // "outline" (current page's headings) | "list" (all wiki pages)
        this._sidebarOutline = [];     // cached getOutline() result for the active page
        this._sidebarListQuery = "";
        this._sortBy = "modified";     // "modified" | "created" | "alpha" — see SORT_OPTIONS
        this._sortByDropdown = null;
        this._categoriesPanel = null;
        this._categoryFilter = null;   // selected category string, or null
        this._tagFilter = null;        // selected tag string (only meaningful alongside _categoryFilter), or null
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
        this._renderCategoriesPanel();
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

        this._sortByBox = this._buildSortByButton();
        $world.addMorph(this._sortByBox);

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
        // built hidden and only shown once a page is actually open
        // (_setActiveContentMorph), same as before; it now defaults to
        // that page's outline but its home button switches it to a
        // filtered list of every wiki page without leaving the open page.
        this._sidebarBox = this._buildSidebar();
        $world.addMorph(this._sidebarBox);
        this._sidebarBox.setVisible(false);

        // Right-hand categories/tags browse panel — unlike _sidebarBox,
        // visible from the start (it's a way to find a page, not a
        // per-open-page outline), see _renderCategoriesPanel.
        this._categoriesPanel = this._buildCategoriesPanel();
        $world.addMorph(this._categoriesPanel);

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

      // Sits immediately left of the search box, same row/height — shows
      // the current sort selection and toggles _sortByDropdown (see the
      // "sort by" category below) on click. Same rounded-pill styling as
      // _buildSearchField above rather than ConstellationLounge.js's
      // pink-accented placeholder version of this button, since this one
      // actually re-sorts the grid instead of just remembering a label.
      _buildSortByButton: function () {
        var self = this;
        var box = new lively.morphic.Box(lively.rect(0, 0, SORT_W, SORT_H));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(200, 200, 200), borderRadius: 17 });

        var label = lively.morphic.Text.makeLabel(this._sortOptionLabel(), {
          fontSize: 12, textColor: Color.rgb(70, 70, 70), fixedWidth: true, fixedHeight: true,
        });
        label.setPosition(lively.pt(14, 0));
        label.setExtent(lively.pt(SORT_W - 36, SORT_H));
        label.applyStyle({ borderWidth: 0 });
        label.eventsAreIgnored = true;
        box.addMorph(label);
        this._sortByLabel = label;

        // fixedWidth/fixedHeight: true — required here, not decorative; see
        // ConstellationLounge.js's _buildSortByButton comment for why an
        // icon-font ligature label without them gets its box silently
        // blown out by Text's own deferred re-layout once it's in the world.
        var chevron = lively.morphic.Text.makeLabel("expand_more", {
          fontFamily: "'Material Symbols Rounded'", fontSize: 13.5, textColor: Color.rgb(120, 120, 120),
          fixedWidth: true, fixedHeight: true,
        });
        chevron.setPosition(lively.pt(SORT_W - 24, 0));
        chevron.setExtent(lively.pt(18, SORT_H));
        chevron.applyStyle({ borderWidth: 0 });
        chevron.eventsAreIgnored = true;
        box.addMorph(chevron);

        box.renderContext().shapeNode.style.cursor = "pointer";
        box.onMouseDown = function () { self._toggleSortByDropdown(); };

        return box;
      },

      // Left-hand sidebar panel — a "home" icon button + search field
      // pinned along its top edge (this method), and below that either the
      // current page's heading outline or a filtered list of every wiki
      // page (_renderSidebarOutline/_renderSidebarPageList, switched via
      // _sidebarMode). _repositionWikiView keeps the whole box pinned
      // alongside the open wiki view.
      _buildSidebar: function () {
        var box = new lively.morphic.Box(lively.rect(0, 0, SIDEBAR_W, 80));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(230, 230, 230), borderRadius: 8 });

        var homeBtn = this._buildSidebarHomeButton();
        homeBtn.setPosition(lively.pt(SIDEBAR_PAD, SIDEBAR_PAD));
        box.addMorph(homeBtn);
        this._sidebarHomeBtn = homeBtn;

        var searchBox = this._buildSidebarSearchField();
        searchBox.setPosition(lively.pt(SIDEBAR_PAD + SIDEBAR_TOOLROW_H + 8, SIDEBAR_PAD));
        box.addMorph(searchBox);
        this._sidebarSearchBox = searchBox;

        var header = lively.morphic.Text.makeLabel("ON THIS PAGE", {
          fontSize: 11, fontWeight: "700", textColor: Color.rgb(150, 150, 150),
        });
        header.setPosition(lively.pt(16, SIDEBAR_HEADER_TOP));
        header.eventsAreIgnored = true;
        box.addMorph(header);
        this._sidebarHeader = header;

        box._itemMorphs = [];
        return box;
      },

      // Small round icon button matching the Material-Symbols-glyph-as-Text
      // idiom (CLAUDE.md "Icons" section) — a single Text morph, ligature
      // name as its content, centered by fixed rect + align:center rather
      // than measure-and-position (fine here since the glyph is always the
      // same single "home" character, unlike the variable-length labels
      // CLAUDE.md's Text-centering gotchas are about).
      _buildSidebarHomeButton: function () {
        var self = this;
        var size = SIDEBAR_TOOLROW_H;
        var btn = new lively.morphic.Text(lively.rect(0, 0, size, size), "home");
        btn.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          fontSize: 13.5, // 13.5pt ≈ 18px, see CLAUDE.md's fontSize-is-points note
          textColor: Color.rgb(90, 90, 90),
          fill: Color.rgb(245, 245, 245),
          borderWidth: 0,
          borderRadius: size / 2,
          align: "center",
          padding: lively.Rectangle.inset(0, Math.round((size - 18) / 2), 0, 0),
          allowInput: false,
          selectable: false,
          clipMode: "hidden",
          whiteSpaceHandling: "pre",
        });
        btn.renderContext().shapeNode.style.cursor = "pointer";
        btn.toolTip = "All wiki pages";
        btn.onMouseOver = function () { btn.applyStyle({ fill: Color.rgb(230, 230, 230) }); };
        btn.onMouseOut = function () { btn.applyStyle({ fill: Color.rgb(245, 245, 245) }); };
        btn.onMouseDown = function () { self._showSidebarPageList(""); };
        return btn;
      },

      // Deliberately separate from the top-of-page _searchField/_buildSearchField
      // above — that one filters the topic grid; this one searches for a
      // page to jump to from inside the sidebar while a page is already
      // open (where the grid + its own search box may be scrolled out of
      // view). Same beInputLine()-based technique, see _buildSearchField.
      _buildSidebarSearchField: function () {
        var self = this;
        var w = SIDEBAR_W - SIDEBAR_PAD * 2 - SIDEBAR_TOOLROW_H - 8;
        var h = SIDEBAR_TOOLROW_H;
        var box = new lively.morphic.Box(lively.rect(0, 0, w, h));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(200, 200, 200), borderRadius: h / 2 });

        var fieldRect = lively.rect(10, 4, w - 20, h - 8);

        var placeholder = lively.morphic.Text.makeLabel("Find a page…", {
          fontSize: 11, textColor: Color.rgb(170, 170, 170),
        });
        placeholder.setPosition(fieldRect.topLeft());
        placeholder.setExtent(fieldRect.extent());
        placeholder.eventsAreIgnored = true;
        box.addMorph(placeholder);

        var field = new lively.morphic.Text(fieldRect, "");
        field.applyStyle({ allowInput: true, fontSize: 11, fill: null, borderWidth: 0 });
        field.beInputLine();
        var superKeyDown = field.onKeyDown;
        field.onKeyDown = function (evt) {
          var result = superKeyDown.call(this, evt);
          // Same one-tick defer as _buildSearchField above — reading
          // field.textString synchronously here lags a character behind.
          setTimeout(function () {
            placeholder.setVisible(!field.textString);
            self._showSidebarPageList(field.textString || "");
          }, 0);
          return result;
        };
        box.addMorph(field);
        this._sidebarSearchField = field;
        this._sidebarSearchPlaceholder = placeholder;

        return box;
      },

      // Right-hand browse panel — content built/rebuilt by
      // _renderCategoriesPanel (see the "categories" category below); this
      // just sets up the box + its static "CATEGORIES" header, same shape
      // as _buildSidebar's own header.
      _buildCategoriesPanel: function () {
        var box = new lively.morphic.Box(lively.rect(0, 0, RIGHT_PANEL_W, 80));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(230, 230, 230), borderRadius: 8 });

        var header = lively.morphic.Text.makeLabel("CATEGORIES", {
          fontSize: 11, fontWeight: "700", textColor: Color.rgb(150, 150, 150),
        });
        header.setPosition(lively.pt(PANEL_PAD, PANEL_HEADER_TOP));
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

        var searchX = W - SIDE_MARGIN - NEW_BTN_W - 12 - SEARCH_W;
        this._searchBox.setPosition(lively.pt(searchX, TOP));
        this._newBtn.setPosition(lively.pt(W - SIDE_MARGIN - NEW_BTN_W, TOP + (SEARCH_H - NEW_BTN_H) / 2));

        var sortX = searchX - SORT_GAP - SORT_W;
        this._sortByBox.setPosition(lively.pt(sortX, TOP));
        if (this._sortByDropdown) this._sortByDropdown.setPosition(lively.pt(sortX, TOP + SORT_H + 4));

        var gridY = TOP + HEADER_H + GRID_TOP_GAP;
        this._gridY = gridY;
        var gridW = Math.max(CARD_W, W - SIDE_MARGIN * 2);
        this._gridW = gridW;
        this._gridBox.setPosition(lively.pt(SIDE_MARGIN, gridY));
        // Height is provisional here — _layoutGrid (below) corrects it to
        // the single shelf row's real (possibly wrapped-title-grown)
        // height once cards exist; this only matters before the first
        // _renderPages call.
        this._gridBox.setExtent(lively.pt(gridW, CARD_H));

        this._layoutGrid();
      },

      // One shelf row, not a wrapping multi-row grid — this used to pack
      // cards into as many rows as the page count needed, which could push
      // the open wiki view (positioned right below the grid, see
      // _repositionWikiView) far down the page. Now every card sits in a
      // single row and the row scrolls horizontally (native overflow, via
      // clipMode) once there are more cards than fit, so the grid's own
      // height is always just one row tall regardless of how many wiki
      // pages exist — freeing the rest of the viewport for the actual page
      // content. Cards can still be taller than the CARD_H floor if
      // _fitCard hugs a wrapped title, so the row's height is still the
      // tallest card actually present, not a hardcoded constant.
      _layoutGrid: function () {
        var self = this;
        var rowH = 0;
        var x = 0;
        this._cardMorphs.forEach(function (card) {
          card.setPosition(lively.pt(x, 0));
          x += CARD_W + GRID_GAP;
          rowH = Math.max(rowH, card._cardH || CARD_H);
        });
        var contentW = this._cardMorphs.length ? (x - GRID_GAP) : 0;
        var overflowing = contentW > this._gridW;

        // +16: room for the native horizontal scrollbar so it doesn't clip
        // the cards' own bottom edge (clipMode's overflow-y is 'hidden').
        var boxH = this._cardMorphs.length ? rowH + (overflowing ? 16 : 0) : rowH;
        this._gridBox.setExtent(lively.pt(this._gridW, boxH));
        this._gridBox.applyStyle({ clipMode: overflowing ? { x: "auto", y: "hidden" } : "visible" });

        this._gridContentHeight = this._cardMorphs.length ? rowH : 0;
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
        if (this._categoriesPanel && this._categoriesPanel.world()) {
          var rightX = window.innerWidth - SIDE_MARGIN - RIGHT_PANEL_W;
          this._categoriesPanel.setPosition(lively.pt(rightX, y));
        }
      },

      // Shared by _openPage/_createNewPage — available width for the open
      // wiki view/editor between the left sidebar gutter and the right
      // categories panel gutter, capped at WikiView's own 1180px default.
      _contentWidth: function () {
        var leftEdge = SIDE_MARGIN + SIDEBAR_W + SIDEBAR_GAP;
        var rightGutter = RIGHT_PANEL_W + RIGHT_PANEL_GAP;
        return Math.min(1180, window.innerWidth - leftEdge - rightGutter - SIDE_MARGIN);
      },
    },

    // ─── sort by ────────────────────────────────────────────────────────────────

    "sort by", {
      _sortOptionLabel: function () {
        var self = this;
        var opt = SORT_OPTIONS.find(function (o) { return o.key === self._sortBy; });
        return (opt || SORT_OPTIONS[0]).label;
      },

      _toggleSortByDropdown: function () {
        if (this._sortByDropdown) return this._closeSortByDropdown();

        var self = this;
        var itemsH = SORT_OPTIONS.length * SORT_ITEM_H;
        var dropdown = new lively.morphic.Box(lively.rect(0, 0, SORT_W, itemsH + 8));
        dropdown.setFill(Color.white);
        dropdown.applyStyle({ borderWidth: 1, borderColor: Color.rgb(200, 200, 200), borderRadius: 8 });

        SORT_OPTIONS.forEach(function (opt, i) {
          var isSelected = opt.key === self._sortBy;
          var row = new lively.morphic.Text(
            lively.rect(0, 4 + i * SORT_ITEM_H, SORT_W, SORT_ITEM_H),
            (isSelected ? "✓ " : "   ") + opt.label,
          );
          row.applyStyle({
            fontSize: 12,
            fontWeight: isSelected ? "600" : "400",
            textColor: isSelected ? Color.rgb(20, 20, 20) : Color.rgb(90, 90, 90),
            fill: null, borderWidth: 0, borderColor: null, align: "left",
          });
          row.renderContext().shapeNode.style.cursor = "pointer";
          row.onMouseDown = function () { self._selectSortOption(opt.key); };
          row.onMouseOver = function () { row.applyStyle({ fill: Color.rgb(245, 245, 245) }); };
          row.onMouseOut = function () { row.applyStyle({ fill: null }); };
          dropdown.addMorph(row);
        });

        $world.addMorph(dropdown);
        this._sortByDropdown = dropdown;
        this._layout();
      },

      _closeSortByDropdown: function () {
        if (!this._sortByDropdown) return;
        this._sortByDropdown.remove();
        this._sortByDropdown = null;
      },

      _selectSortOption: function (key) {
        this._sortBy = key;
        if (this._sortByLabel) this._sortByLabel.setTextString(this._sortOptionLabel());
        this._closeSortByDropdown();
        this._renderPages();
      },

      // Applied after search-filtering, before the grid is built
      // (_renderPages) — "modified"/"created" both fall back to wikiName
      // ordering when two pages tie exactly on a timestamp, so the grid
      // order stays deterministic instead of flapping between renders.
      _sortPages: function (pages) {
        var sortBy = this._sortBy;
        var sorted = pages.slice();
        if (sortBy === "alpha") {
          sorted.sort(function (a, b) {
            return (a.wikiName || "").toLowerCase().localeCompare((b.wikiName || "").toLowerCase());
          });
        } else {
          var field = sortBy === "created" ? "createdAt" : "updatedAt";
          sorted.sort(function (a, b) {
            var diff = new Date(b[field] || 0).getTime() - new Date(a[field] || 0).getTime();
            if (diff) return diff;
            return (a.wikiName || "").toLowerCase().localeCompare((b.wikiName || "").toLowerCase());
          });
        }
        return sorted;
      },
    },

    // ─── categories & tags ──────────────────────────────────────────────────────

    "categories", {
      // { category -> { count, tagSet } } from every page's own
      // category/tags fields (both null/empty for a page created before
      // this existed, or via any path that skips NewWikiPageDialog —
      // those pages just don't contribute to the panel), then sorted into
      // [{ category, count, tags }, ...] — known categories in
      // CATEGORY_ORDER's fixed order first, any others alphabetically
      // after (defensive: covers legacy/manually-set category strings
      // outside that list rather than silently dropping them).
      _categoryTagMap: function () {
        var map = {};
        this._pages.forEach(function (p) {
          if (!p.category) return;
          if (!map[p.category]) map[p.category] = { count: 0, tagSet: {} };
          map[p.category].count++;
          (p.tags || []).forEach(function (t) { if (t) map[p.category].tagSet[t] = true; });
        });
        var categories = Object.keys(map);
        categories.sort(function (a, b) {
          var ia = CATEGORY_ORDER.indexOf(a); if (ia === -1) ia = CATEGORY_ORDER.length;
          var ib = CATEGORY_ORDER.indexOf(b); if (ib === -1) ib = CATEGORY_ORDER.length;
          return ia !== ib ? ia - ib : a.localeCompare(b);
        });
        return categories.map(function (cat) {
          var tags = Object.keys(map[cat].tagSet).sort(function (a, b) { return a.localeCompare(b); });
          return { category: cat, count: map[cat].count, tags: tags };
        });
      },

      // Rebuilds the whole right-hand panel from scratch — cheap enough
      // (a handful of categories/tags) to just do on every data change or
      // filter-selection change, same rebuild-heavy approach the sidebar's
      // outline/page-list rendering already uses. Category labels are
      // clickable rows; tags render as flow-wrapped pill morphs
      // (_buildTagPill/_fitPill) beneath their own category, wrapping to a
      // new line once a row would overflow the panel's content width.
      _renderCategoriesPanel: function () {
        var self = this;
        var box = this._categoriesPanel;
        (box._itemMorphs || []).forEach(function (m) { m.remove(); });
        box._itemMorphs = [];

        var groups = this._categoryTagMap();
        var y = PANEL_ITEMS_TOP;

        if (!groups.length) {
          var empty = lively.morphic.Text.makeLabel("No categories yet.", {
            fontSize: 12, textColor: Color.rgb(170, 170, 170),
          });
          empty.setPosition(lively.pt(PANEL_PAD, y));
          box.addMorph(empty);
          box._itemMorphs.push(empty);
          y += 22;
        } else {
          groups.forEach(function (g) {
            var isSelectedCat = self._categoryFilter === g.category;
            var label = new lively.morphic.Text(
              lively.rect(PANEL_PAD, y, RIGHT_PANEL_W - PANEL_PAD * 2, CATEGORY_LABEL_H),
              g.category + " (" + g.count + ")",
            );
            label.applyStyle({
              fontSize: 13, fontWeight: isSelectedCat ? "700" : "600",
              textColor: isSelectedCat ? Color.rgb(20, 20, 20) : Color.rgb(60, 60, 60),
              fill: null, borderWidth: 0, borderColor: null,
            });
            label.renderContext().shapeNode.style.cursor = "pointer";
            label.onMouseDown = function () { self._selectCategory(g.category); };
            box.addMorph(label);
            box._itemMorphs.push(label);
            y += CATEGORY_LABEL_H + 6;

            var x = PANEL_PAD;
            g.tags.forEach(function (tag) {
              var isSelectedTag = isSelectedCat && self._tagFilter === tag;
              // Pill built empty and added to `box` (already in $world)
              // *before* its label exists — see _fitPill's comment for why
              // that order matters.
              var pill = self._buildTagPill(g.category, tag, isSelectedTag);
              box.addMorph(pill);
              var pillW = self._fitPill(pill, g.category, tag, isSelectedTag);
              if (x + pillW > RIGHT_PANEL_W - PANEL_PAD && x > PANEL_PAD) {
                x = PANEL_PAD;
                y += PILL_H + PILL_GAP_Y;
              }
              pill.setPosition(lively.pt(x, y));
              x += pillW + PILL_GAP_X;
              box._itemMorphs.push(pill);
            });
            if (g.tags.length) y += PILL_H;
            y += CATEGORY_BLOCK_GAP;
          });
        }

        box.setExtent(lively.pt(RIGHT_PANEL_W, y + 8));
      },

      // Builds only the pill's outer Box, with no label child yet — see
      // _fitPill for why the label has to be added later instead of here.
      _buildTagPill: function (category, tag, isSelected) {
        var self = this;
        var pill = new lively.morphic.Box(lively.rect(0, 0, 10, PILL_H));
        pill.applyStyle({
          fill: isSelected ? Color.rgb(55, 55, 55) : Color.rgb(235, 235, 240),
          borderWidth: 0, borderRadius: PILL_H / 2,
        });
        pill.renderContext().shapeNode.style.cursor = "pointer";
        pill.onMouseDown = function () { self._selectTag(category, tag); };
        return pill;
      },

      // Creates the pill's tag-text label and sizes both it and the pill
      // to hug it. Deliberately split out from _buildTagPill and called
      // only *after* the caller has already added the (still-empty) pill
      // to `box` — confirmed live: adding the label as a child of `pill`
      // while `pill` itself was still a detached morph (not yet in
      // $world) rendered the label off-document, and its text metrics
      // came back wrapped ("claude" → "claud"/"e") and stayed wrapped
      // even after later resizing, despite offsetWidth/style.width
      // otherwise looking correct — a stricter version of the "must
      // already be in $world to measure" rule CLAUDE.md documents for
      // _fitCard, since here even indirect (grandparent-only) world
      // membership at creation time wasn't enough.
      //
      // Mirrors _fitCard's idioms: the label starts at 1px height so
      // offsetHeight isn't floored by the shapeNode's own min-height, and
      // the measured height gets +4 added back (2px top + 2px bottom) to
      // compensate for setExtentHTML subtracting the shapeNode's internal
      // padding. Width compensation is +10, not the +8 (4px each side)
      // _buildPageCard/_fitCard's own header comment uses — confirmed
      // live: +8 (exactly canceling the padding subtraction, zero extra
      // slack) still wrapped "claude" about half the time depending on
      // the word, because offsetWidth rounds to a whole CSS px while the
      // real layout width can be a fraction above that (more visible at
      // this window's 1.5 devicePixelRatio), and a pill's fit is snug
      // enough that even a sub-pixel shortfall triggers wrap. +2px of
      // real slack on top of the padding compensation reliably avoided it
      // across every word tested ("claude", "verification", "test",
      // "save-test", a single "a"). _fitCard's own case tolerates the
      // same rounding fine because its card width has much more slack
      // than a hug-fit pill does.
      _fitPill: function (pill, category, tag, isSelected) {
        var label = new lively.morphic.Text(lively.rect(PILL_PAD_X, 0, 160, 1), tag);
        label.applyStyle({
          fontSize: 11, fontWeight: isSelected ? "700" : "500",
          textColor: isSelected ? Color.white : Color.rgb(70, 70, 70),
          fill: null, borderWidth: 0, borderColor: null,
        });
        label.eventsAreIgnored = true;
        pill.addMorph(label);

        var innerDiv = label.renderContext().shapeNode.querySelector("div");
        var span = innerDiv ? innerDiv.querySelector("span") : null;
        var textW = span ? span.offsetWidth : 30;
        var textH = innerDiv ? innerDiv.offsetHeight : 14;
        label.setExtent(lively.pt(textW + 10, textH + 4));
        label.setPosition(lively.pt(PILL_PAD_X, Math.round((PILL_H - (textH + 4)) / 2)));
        var pillW = textW + PILL_PAD_X * 2;
        pill.setExtent(lively.pt(pillW, PILL_H));
        return pillW;
      },

      // Clicking a category toggles it as the active filter and clears
      // any tag filter (a tag only makes sense scoped to the category row
      // it's rendered under — see _selectTag).
      _selectCategory: function (category) {
        if (this._categoryFilter === category) {
          this._categoryFilter = null;
          this._tagFilter = null;
        } else {
          this._categoryFilter = category;
          this._tagFilter = null;
        }
        this._renderCategoriesPanel();
        this._renderPages();
      },

      // Clicking a tag pill selects both its category and the tag
      // together (that pair is exactly what's shown grouped under the
      // category label), or clears just the tag if that exact pair is
      // already active.
      _selectTag: function (category, tag) {
        if (this._categoryFilter === category && this._tagFilter === tag) {
          this._tagFilter = null;
        } else {
          this._categoryFilter = category;
          this._tagFilter = tag;
        }
        this._renderCategoriesPanel();
        this._renderPages();
      },
    },

    // ─── page grid ──────────────────────────────────────────────────────────────

    "pages", {
      _renderPages: function () {
        var self = this;
        (this._cardMorphs || []).forEach(function (m) { m.remove(); });
        this._cardMorphs = [];

        var q = (this._filterQuery || "").toLowerCase();
        var pages = this._pages;
        if (this._categoryFilter) {
          pages = pages.filter(function (p) { return p.category === self._categoryFilter; });
        }
        if (this._tagFilter) {
          pages = pages.filter(function (p) { return (p.tags || []).indexOf(self._tagFilter) !== -1; });
        }
        if (q) {
          pages = pages.filter(function (p) { return (p.wikiName || "").toLowerCase().indexOf(q) !== -1; });
        }
        pages = this._sortPages(pages);
        this._pagesFiltered = pages;

        if (!pages.length) {
          var emptyMsg = "No wiki pages yet.";
          if (this._pages.length) {
            if (q) emptyMsg = "No wiki pages match “" + this._filterQuery + "”.";
            else if (this._tagFilter) emptyMsg = "No wiki pages tagged “" + this._tagFilter + "”.";
            else if (this._categoryFilter) emptyMsg = "No wiki pages in “" + this._categoryFilter + "”.";
          }
          var empty = lively.morphic.Text.makeLabel(emptyMsg, { fontSize: 13, textColor: Color.gray });
          empty.setPosition(lively.pt(0, 0));
          this._gridBox.addMorph(empty);
          this._cardMorphs.push(empty);
          // Reset back to a plain single-row slot — a previous non-empty
          // render may have left this box taller/scrollable (_layoutGrid's
          // +16 scrollbar allowance and clipMode:{x:'auto'}), which would
          // otherwise linger through a search that temporarily matches
          // nothing.
          this._gridBox.setExtent(lively.pt(this._gridW || CARD_W, CARD_H));
          this._gridBox.applyStyle({ clipMode: "visible" });
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
          var w = self._contentWidth();
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
        // Opening/re-opening a page always lands the sidebar back on that
        // page's own outline — the home button (_showSidebarPageList) is
        // the only way to switch it into "all pages" mode from here.
        this._sidebarMode = "outline";
        if (this._sidebarSearchField) this._sidebarSearchField.textString = "";
        if (this._sidebarSearchPlaceholder) this._sidebarSearchPlaceholder.setVisible(true);
        this._renderSidebarOutline(morph);
        this._repositionWikiView();
      },

      // Populates the "On this page" sidebar from the page's real rendered
      // headings (WikiView#getOutline) — clicking an entry scrolls that
      // exact heading element into view inside the WikiView's own
      // (overflow-y:auto) content area.
      _renderSidebarOutline: function (view) {
        this._sidebarOutline = (view && view.getOutline) ? view.getOutline() : [];
        if (this._sidebarHeader) this._sidebarHeader.setTextString("ON THIS PAGE");

        var box = this._sidebarBox;
        var outline = this._sidebarOutline;
        (box._itemMorphs || []).forEach(function (m) { m.remove(); });
        box._itemMorphs = [];
        var y = SIDEBAR_ITEMS_TOP;

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

      // Home button handler — switches the sidebar out of "this page's
      // outline" mode into a flat, searchable list of every wiki page in
      // this scope, filtered by `query` (also called live as the sidebar
      // search field is typed into). Reuses the same wikiName substring
      // match _renderPages uses for the top-of-page grid search.
      _showSidebarPageList: function (query) {
        this._sidebarMode = "list";
        this._renderSidebarPageList(query || "");
      },

      _renderSidebarPageList: function (query) {
        var self = this;
        this._sidebarListQuery = query || "";
        if (this._sidebarHeader) this._sidebarHeader.setTextString("ALL WIKI PAGES");

        var box = this._sidebarBox;
        (box._itemMorphs || []).forEach(function (m) { m.remove(); });
        box._itemMorphs = [];
        var y = SIDEBAR_ITEMS_TOP;

        var q = this._sidebarListQuery.toLowerCase();
        var pages = q
          ? this._pages.filter(function (p) { return (p.wikiName || "").toLowerCase().indexOf(q) !== -1; })
          : this._pages;

        if (!pages.length) {
          var empty = lively.morphic.Text.makeLabel(
            this._pages.length ? "No pages match “" + this._sidebarListQuery + "”." : "No wiki pages yet.",
            { fontSize: 12, textColor: Color.rgb(170, 170, 170) },
          );
          empty.setPosition(lively.pt(16, y));
          box.addMorph(empty);
          box._itemMorphs.push(empty);
          y += 22;
        } else {
          pages.forEach(function (page) {
            var item = new lively.morphic.Text(
              lively.rect(16, y, SIDEBAR_W - 32, 18),
              page.wikiName,
            );
            item.applyStyle({
              fontSize: 13, fontWeight: "500", textColor: Color.rgb(50, 50, 50),
              fill: null, borderWidth: 0, borderColor: null,
            });
            box.addMorph(item);
            var itemNode = item.renderContext().shapeNode;
            itemNode.style.cursor = "pointer";
            var itemDiv = itemNode.querySelector("div");
            if (itemDiv) {
              itemDiv.style.whiteSpace = "nowrap";
              itemDiv.style.overflow = "hidden";
              itemDiv.style.textOverflow = "ellipsis";
            }
            item.onMouseDown = function () { self._openPage(page); };
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
          var w = self._contentWidth();
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
              if (found) {
                self._renderCategoriesPanel();
                self._renderPages();
              }
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
