module('lively.identity.Inventory').requires('lively.persistence.BuildSpec', 'lively.PartsBin', 'lively.identity.IdentityPartsSpace').toRun(function() {

// Standalone window for browsing every publicly "Published to Inventory"
// item across ALL users, at feature/layout parity with the classic WebDAV
// browser (lively.morphic.tools.PartsBin, core/lively/morphic/tools/PartsBin.js
// — titleBar "Inventory"). That browser already treats a *signed-in user's
// own* identity-published parts as first-class (its "*myparts*"/"#tag"
// categories and WebDAV-backed Search can't see anyone else's public items —
// see the /parts/public route's own doc comment in IdentityServer.js), but
// has no notion of *other users'* items at all. This is the cross-user
// counterpart: same region layout (instance chooser + category sidebar,
// thumbnail grid, collapsible info panel with Share Link/Inspect/identity
// metadata/version history), reusing the same shared widget classes
// (lively.morphic.PartsBinItem, lively.identity.IdentityPartItem) the
// classic browser's own "*myparts*" category already relies on.
//
// Naming convention: this module/window is "Inventory" (not "PartsBin"),
// and its own UI/identifiers say "Item(s)" (not "Part(s)") — the shared
// classes it reuses (PartsBinItem, IdentityPartItem, the classic PartsBin.js
// browser itself) keep their existing names; renaming those is out of scope.
lively.BuildSpec('lively.identity.Inventory', {
    _BorderColor: Color.rgb(204,0,0),
    // Setting _BorderColor without a paired _BorderRadius silently zeroes
    // the window's corner radius at construction (setBorderColor rewrites
    // the whole inline border shorthand, radius included) — see CLAUDE.md's
    // "lively.BuildSpec / Morph#addScript methods lose their closure" doc's
    // sibling border-radius-reset gotcha. Explicit here so the window keeps
    // the classic rounded corner instead of rendering hard square ones.
    _BorderRadius: 3,
    // Widened for the 3-column Phase D layout (220px rail + 840px flexible
    // main + 360px right panel + 2 dividers + the HorizontalLayout's own
    // borderSize/spacing below) -- see inventory.md §13 Phase D plan.
    _Extent: lively.pt(1460.0,760.0),
    _Position: lively.pt(140.0,80.0),
    _StyleClassNames: ["Morph","Window"],
    cameForward: false,
    className: "lively.morphic.Window",
    contentOffset: lively.pt(4.0,22.0),
    draggingEnabled: true,
    layout: { adjustForNewBounds: true },
    minExtent: lively.pt(900.0,560.0),
    name: "Inventory",
    sourceModule: "lively.identity.Inventory",
    submorphs: [{
        _BorderColor: Color.rgb(95,94,95),
        // same border-radius-reset gotcha as the outer window above.
        _BorderRadius: 3,
        _Extent: lively.pt(1452.0,734.0),
        _Fill: Color.rgba(245,245,245,0),
        _Position: lively.pt(4.0,22.0),
        _StyleClassNames: ["Morph","Box"],
        borderWidth: 1,
        className: "lively.morphic.Box",
        droppingEnabled: false,
        layout: {
            adjustForNewBounds: true,
            borderSize: 6,
            resizeHeight: true,
            resizeWidth: true,
            spacing: 3,
            type: "lively.morphic.Layout.HorizontalLayout"
        },
        minExtent: lively.pt(780.0,480.0),
        name: "InventoryBrowser",
        selectedItem: null,
        cursor: null,
        searchQuery: "",
        // scope: which data path _loadItemsPage hits -- 'public' (fan-out
        // across checkedInstances' /parts/public), 'mine'/'shared' (self-
        // only, always same-origin/credentialed, see inventory.md §13).
        scope: "public",
        // category: curated Inventory category filter (inventory.md §7) --
        // the sidebar's freeform "#tag" list (categoryName) was replaced
        // outright by this curated filter in Phase D, not layered alongside
        // it (inventory.md §13.1's own framing of what Phase D replaces).
        category: null,
        sort: "recent",
        // instances: the real federation directory (GET /instances,
        // inventory.md §3.2), loaded once via loadInstances(). checkedInstances
        // is the fan-out selection -- a baseUrl -> bool map, replacing the
        // old single-string instanceBaseUrl model so more than one instance
        // can be active at once. Defaults to "local origin only" (today's
        // pre-federation behavior) until loadInstances() populates it.
        instances: [],
        checkedInstances: {},
        // categoryCounts/categoryTotal: GET /parts/public/categories results
        // (inventory.md §13 Phase D), backing the curated Categories
        // sidebar's per-row counts. Public scope only.
        categoryCounts: {},
        categoryTotal: 0,
        // popularItems/popularStart: the "Popular this week" strip's own
        // independent top-8-by-stars fetch (loadPopularStrip) -- separate
        // from _loadItemsPage's cursor-paginated main grid. popularStart
        // steps by 4 (the visible window size) and is clamped in
        // popularPrev/popularNext.
        popularItems: [],
        popularStart: 0,
        // versionsExpanded: right-panel version-badge disclosure state.
        versionsExpanded: false,
        // selectedTileMorph: tracks whichever tile (in ItemsGrid OR the
        // Popular strip) is currently shown selected, so selectTile can
        // deselect it regardless of which container it lives in -- see
        // selectTile below.
        selectedTileMorph: null,
        sourceModule: "lively.morphic.Core",

        // ─── left sidebar (inventory.md §13 Phase D) ─────────────────────
        // Only ScopeTabsRow is static BuildSpec content -- the Categories
        // and Instances blocks below it are entirely data-driven (curated-
        // category counts, the federation directory) and are hand-
        // constructed/torn down at runtime by _renderSidebarExtras, the
        // same "build fresh each time" idiom _buildItemTile/ItemsGrid
        // already use for the item grid. All of LeftSideContainer's direct
        // children just hug their own natural content height (no child
        // declares resizeHeight:true) and the container itself scrolls as
        // one region via _ClipMode -- sidesteps the VerticalLayout fixed-
        // vs-flex-sibling trap entirely rather than juggling it, matching
        // this file's own MainContainer/ItemInfoPanel explicit-positioning
        // precedent in spirit (no shared flex/fixed conflict to resolve).

        submorphs: [{
            _BorderWidth: 0.7,
            _ClipMode: "auto",
            _Extent: lively.pt(220.0,601.0),
            _Fill: Color.rgba(255,255,255,0),
            _Position: lively.pt(6.0,6.0),
            className: "lively.morphic.Box",
            droppingEnabled: false,
            layout: {
                borderSize: 0,
                resizeHeight: true,
                resizeWidth: false,
                spacing: 14,
                type: "lively.morphic.Layout.VerticalLayout"
            },
            name: "LeftSideContainer",
            sourceModule: "lively.morphic.Core",
            submorphs: [{
                _Extent: lively.pt(220.0,26.0),
                _Fill: Color.rgb(236,236,236),
                className: "lively.morphic.Box",
                droppingEnabled: false,
                layout: { borderSize: 2, resizeWidth: true, spacing: 2, type: "lively.morphic.Layout.HorizontalLayout" },
                name: "ScopeTabsRow",
                sourceModule: "lively.morphic.Core",
                style: { borderRadius: 8 },
                submorphs: [{
                    _Extent: lively.pt(70.0,22.0),
                    _Fill: Color.white,
                    _Position: lively.pt(2.0,2.0),
                    _StyleClassNames: ["Morph","Button"],
                    className: "lively.morphic.Button",
                    isPressed: false,
                    label: "Public",
                    layout: { resizeWidth: true },
                    name: "scopePublicButton",
                    sourceModule: "lively.morphic.Widgets",
                    style: { borderRadius: 6 },
                    value: false,
                    withoutLayers: [],
                    connectionRebuilder: function connectionRebuilder() {
                        lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "setScope", { converter: function() { return "public"; } });
                    }
                },{
                    _Extent: lively.pt(70.0,22.0),
                    _Fill: Color.rgba(255,255,255,0),
                    _Position: lively.pt(74.0,2.0),
                    _StyleClassNames: ["Morph","Button"],
                    className: "lively.morphic.Button",
                    isPressed: false,
                    label: "My Items",
                    layout: { resizeWidth: true },
                    name: "scopeMineButton",
                    sourceModule: "lively.morphic.Widgets",
                    style: { borderRadius: 6 },
                    value: false,
                    withoutLayers: [],
                    connectionRebuilder: function connectionRebuilder() {
                        lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "setScope", { converter: function() { return "mine"; } });
                    }
                },{
                    _Extent: lively.pt(70.0,22.0),
                    _Fill: Color.rgba(255,255,255,0),
                    _Position: lively.pt(146.0,2.0),
                    _StyleClassNames: ["Morph","Button"],
                    className: "lively.morphic.Button",
                    isPressed: false,
                    label: "Shared",
                    layout: { resizeWidth: true },
                    name: "scopeSharedButton",
                    sourceModule: "lively.morphic.Widgets",
                    style: { borderRadius: 6 },
                    value: false,
                    withoutLayers: [],
                    connectionRebuilder: function connectionRebuilder() {
                        lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "setScope", { converter: function() { return "shared"; } });
                    }
                }],
                withoutLayers: []
            }],
            withoutLayers: []
        },{
            _BorderColor: null,
            _Extent: lively.pt(2.0,601.0),
            _Fill: Color.rgb(204,204,204),
            _Position: lively.pt(230.0,6.0),
            className: "lively.morphic.VerticalDivider",
            draggingEnabled: true,
            droppingEnabled: true,
            fixed: [],
            layout: { resizeHeight: true },
            minWidth: 150,
            name: "LeftRightDivider",
            pointerConnection: null,
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            withoutLayers: []
        },

        // ─── main content (inventory.md §13 Phase D) ──────────────────────
        // MainContainer's own children (TopBar, PopularCard, AllItemsCard)
        // ARE under a shared VerticalLayout, unlike the old MainContentContainer/
        // ItemInfoPanel split above this comment used to warn against --
        // safe here because the flexible child (AllItemsCard, resizeHeight:
        // true) is LAST, mirroring LeftSideContainer's own proven-working
        // InstanceChooser(fixed)+CategoryListContainer(flexible-last) shape
        // from before this rewrite. PopularCard is only added for
        // scope==='public' (removed entirely otherwise, not just hidden),
        // so AllItemsCard stays the last child either way.

        {
            _Extent: lively.pt(840.0,601.0),
            _Fill: Color.rgba(255,255,255,0),
            _Position: lively.pt(235.0,6.0),
            _ClipMode: "hidden",
            className: "lively.morphic.Box",
            droppingEnabled: false,
            layout: {
                adjustForNewBounds: true, resizeHeight: true, resizeWidth: true,
                borderSize: 0, spacing: 14, type: "lively.morphic.Layout.VerticalLayout"
            },
            name: "MainContainer",
            sourceModule: "lively.morphic.Core",
            submorphs: [{
                // ─── search + sort bar ─────────────────────────────────
                _Extent: lively.pt(840.0,36.0),
                _Fill: Color.rgba(255,255,255,0),
                className: "lively.morphic.Box",
                droppingEnabled: false,
                layout: {},
                name: "TopBar",
                sourceModule: "lively.morphic.Core",
                submorphs: [
                    lively.BuildSpec('lively.ide.tools.CommandLine').customize({
                        name: "searchText",
                        _Position: lively.pt(0,2),
                        _Extent: lively.pt(520,32),
                        labelString: "  ",
                        clearOnInput: false,
                        connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "savedTextString", this.get("InventoryBrowser"), "search", {});
                        }
                    }),
                    {
                        _Position: lively.pt(530,2),
                        _Extent: lively.pt(78,32),
                        _Fill: Color.white,
                        _StyleClassNames: ["Morph","Button"],
                        className: "lively.morphic.Button",
                        isPressed: false,
                        label: "Popular",
                        name: "sortPopularButton",
                        sourceModule: "lively.morphic.Widgets",
                        style: { borderRadius: 6 },
                        value: false,
                        withoutLayers: [],
                        connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "setSort", { converter: function() { return "popular"; } });
                        }
                    },{
                        _Position: lively.pt(614,2),
                        _Extent: lively.pt(78,32),
                        _Fill: Color.white,
                        _StyleClassNames: ["Morph","Button"],
                        className: "lively.morphic.Button",
                        isPressed: false,
                        label: "Recent",
                        name: "sortRecentButton",
                        sourceModule: "lively.morphic.Widgets",
                        style: { borderRadius: 6 },
                        value: false,
                        withoutLayers: [],
                        connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "setSort", { converter: function() { return "recent"; } });
                        }
                    },{
                        _Position: lively.pt(700,2),
                        _Extent: lively.pt(64,32),
                        _Fill: Color.white,
                        _StyleClassNames: ["Morph","Button"],
                        className: "lively.morphic.Button",
                        isPressed: false,
                        // Plain text rather than a Material Symbols glyph --
                        // a BuildSpec Button auto-generates its own internal
                        // label Text from this string at creation time (the
                        // safe case), whereas swapping to an icon font would
                        // need the runtime label-recoloring workaround
                        // CLAUDE.md documents for WindowControl buttons; not
                        // worth it for one static "more sort options" button.
                        label: "More ▾",
                        name: "sortMenuButton",
                        sourceModule: "lively.morphic.Widgets",
                        style: { borderRadius: 6 },
                        value: false,
                        withoutLayers: [],
                        connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "openSortMenu", {});
                        }
                    }
                ],
                withoutLayers: []
            },{
                // ─── all items card (Popular strip inserted before this,
                // at index 1, only for scope==='public') ─────────────────
                _Extent: lively.pt(840.0,540.0),
                _Fill: Color.white,
                _BorderColor: Color.rgb(230,230,230),
                _BorderWidth: 1,
                _ClipMode: "hidden",
                className: "lively.morphic.Box",
                droppingEnabled: false,
                layout: { resizeHeight: true, resizeWidth: true },
                style: { borderRadius: 12 },
                name: "AllItemsCard",
                sourceModule: "lively.morphic.Core",
                submorphs: [{
                    _Position: lively.pt(16,12),
                    _Extent: lively.pt(200,14),
                    _FontFamily: "Helvetica",
                    _FontSize: 7.5,
                    _InputAllowed: false,
                    allowInput: false,
                    className: "lively.morphic.Text",
                    droppingEnabled: false,
                    eventsAreIgnored: true,
                    fixedWidth: true,
                    fixedHeight: true,
                    grabbingEnabled: false,
                    name: "AllItemsHeader",
                    sourceModule: "lively.morphic.TextCore",
                    submorphs: [],
                    textColor: Color.rgb(153,153,153),
                    textString: "ALL ITEMS",
                    withoutLayers: []
                },{
                    // items grid — same async tile-population mechanics as
                    // the classic browser's partsBinContents box
                    // (addPartItemAsync/startAddingPartItems/adjustForNewBounds),
                    // populated with lively.identity.IdentityPartItem
                    // instances built by hand from /parts/public rows
                    // (there's no owning IdentityPartsSpace for another
                    // user's items — same approach the old
                    // PublicPartsBrowser.js's _openEnvelope already used).
                    _Position: lively.pt(16,34),
                    _ClipMode: "auto",
                    _Extent: lively.pt(808.0,462.0),
                    _Fill: Color.rgba(255,255,255,0),
                    className: "lively.morphic.Box",
                    droppingEnabled: false,
                    layout: {},
                    name: "ItemsGrid",
                    sourceModule: "lively.morphic.Core",
                    submorphs: [],
                    withoutLayers: [],
                    addItemAsync: function addItemAsync() {
                        if (!this.itemsToBeAdded || this.itemsToBeAdded.length === 0) {
                            this.stopAddingItemsAsync();
                            return;
                        }
                        var item = this.itemsToBeAdded.shift();
                        var morph = this.get('InventoryBrowser')._buildItemTile(item);
                        this.addMorph(morph);
                        this.adjustForNewBounds();
                    },
                    adjustForNewBounds: function adjustForNewBounds() {
                        $super();
                        var bounds = this.innerBounds(),
                            delta = 8,
                            left = bounds.x + delta,
                            top = bounds.y + delta,
                            x = left, y = top,
                            width = bounds.width;
                        this.submorphs.forEach(function(morph) {
                            var extent = morph.getExtent();
                            if (extent.x + x + delta > width) {
                                x = left;
                                y += extent.y + delta;
                            }
                            morph.setPosition(pt(x,y));
                            x += extent.x + delta;
                        });
                    },
                    setExtent: function setExtent(point) {
                        $super(point);
                        this.adjustForNewBounds();
                    },
                    startAddingItems: function startAddingItems(items) {
                        this.itemsToBeAdded = items.clone();
                        this.startStepping(0, 'addItemAsync');
                    },
                    stopAddingItemsAsync: function stopAddingItemsAsync() {
                        this.stopStepping();
                        delete this.itemsToBeAdded;
                    },
                    removeAllItems: function removeAllItems() {
                        this.submorphs.clone().invoke('remove');
                    }
                },{
                    // pagination — new relative to the classic browser
                    // (whose WebDAV categories load everything at once):
                    // cross-user public inventory can be large, and
                    // /parts/public already returns a cursor for exactly
                    // this purpose.
                    _Position: lively.pt(16,504),
                    _Extent: lively.pt(808.0,24.0),
                    _Fill: Color.rgba(255,255,255,0),
                    className: "lively.morphic.Box",
                    droppingEnabled: false,
                    layout: {},
                    name: "LoadMoreContainer",
                    sourceModule: "lively.morphic.Core",
                    submorphs: [{
                        _BorderColor: Color.rgb(214,214,214),
                        _Extent: lively.pt(100.0,22.0),
                        _Fill: Color.rgb(230,230,230),
                        _StyleClassNames: ["Morph","Button"],
                        className: "lively.morphic.Button",
                        isPressed: false,
                        label: "Load more",
                        name: "loadMoreButton",
                        sourceModule: "lively.morphic.Widgets",
                        style: { borderRadius: 4 },
                        value: false,
                        withoutLayers: [],
                        connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "loadMoreItems", {});
                        }
                    },{
                        _Extent: lively.pt(400.0,16.0),
                        _FontFamily: "Arial, sans-serif",
                        _FontSize: 10,
                        _Position: lively.pt(108.0,4.0),
                        _InputAllowed: false,
                        allowInput: false,
                        className: "lively.morphic.Text",
                        droppingEnabled: false,
                        eventsAreIgnored: true,
                        fixedWidth: true,
                        grabbingEnabled: false,
                        name: "statusText",
                        sourceModule: "lively.morphic.TextCore",
                        submorphs: [],
                        textColor: Color.rgb(120,120,120),
                        textString: ""
                    }],
                    withoutLayers: []
                }],
                withoutLayers: [],
                // AllItemsCard is the flexible LAST child of MainContainer's
                // VerticalLayout -- when the layout resizes it, reflow its
                // own header/grid/load-more children explicitly rather than
                // via a nested layout (same custom-setExtent-override idiom
                // ItemsGrid itself already uses one level down).
                setExtent: function setExtent(point) {
                    $super(point);
                    var headerH = 34, loadMoreH = 30, pad = 16;
                    var grid = this.get('ItemsGrid');
                    var loadMore = this.get('LoadMoreContainer');
                    if (grid) {
                        grid.setPosition(pt(pad, headerH));
                        grid.setExtent(pt(Math.max(100, point.x - 2 * pad), Math.max(60, point.y - headerH - loadMoreH - pad)));
                    }
                    if (loadMore) {
                        loadMore.setPosition(pt(pad, point.y - loadMoreH - 4));
                        loadMore.setExtent(pt(Math.max(100, point.x - 2 * pad), loadMoreH));
                    }
                }
            }],
            withoutLayers: []
        },{
            _BorderColor: null,
            _Extent: lively.pt(2.0,601.0),
            _Fill: Color.rgb(204,204,204),
            _Position: lively.pt(1078.0,6.0),
            className: "lively.morphic.VerticalDivider",
            draggingEnabled: true,
            droppingEnabled: true,
            fixed: [],
            layout: { resizeHeight: true },
            minWidth: 260,
            name: "RightDivider",
            pointerConnection: null,
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            withoutLayers: []
        },{
            // ─── right panel (inventory.md §13 Phase D) ───────────────────
            // Entirely dynamic content, rebuilt fresh on every selection/
            // star/comment/version change by InventoryBrowser.renderRightPanel
            // -- same "hand-construct fresh, don't patch named morphs in
            // place" idiom as the sidebar's Categories/Instances blocks and
            // _buildItemTile. No static submorphs here at all; the whole
            // panel scrolls as one region via _ClipMode, sidestepping any
            // fixed-vs-flex-sibling layout question entirely (every row
            // just hugs its own content).
            _Extent: lively.pt(360.0,601.0),
            _Fill: Color.white,
            _Position: lively.pt(1083.0,6.0),
            _ClipMode: "auto",
            className: "lively.morphic.Box",
            droppingEnabled: false,
            layout: { resizeHeight: true, resizeWidth: false },
            name: "RightPanel",
            sourceModule: "lively.morphic.Core",
            submorphs: [],
            withoutLayers: []
        }],
        withoutLayers: [],

        // ─── loading ────────────────────────────────────────────────────────

    onLoad: function onLoad() {
        this.get('searchText').setTextString('');
        this.renderRightPanel();
        var self = this;
        // checkedInstances must be populated before the first real load, or
        // _activeInstanceBaseUrls() would fall back to "local origin only"
        // for one extra round trip -- harmless, but loadInstances' own
        // callback sequencing avoids that flash-of-wrong-scope entirely.
        this.loadInstances(function() { self.reloadEverything(); });
    },

    onWindowGetsFocus: function onWindowGetsFocus() {
        this.get('searchText').focus();
    },

    reloadEverything: function reloadEverything() {
        this.cursor = null;
        this.get('ItemsGrid').removeAllItems();
        this.setSelectedItem(null);
        this._renderSidebarExtras();
        this._renderMainColumnForScope();
        this._loadItemsPage(false);
        if (this.scope === 'public') {
            this.loadCategoryCounts();
            this.loadPopularStrip();
        } else {
            this.categoryCounts = {};
            this.categoryTotal = 0;
            this.popularItems = [];
            this.popularStart = 0;
        }
    },

    // ─── scope / category / sort (inventory.md §13) ────────────────────────
    // Mechanical setters -- each resets pagination and reloads. Real UI for
    // these (scope segmented control, category sidebar rows, sort pills)
    // is Phase D's job; these are exercised directly for now (devtools /
    // future UI wiring), same "data layer before layout" split the rest of
    // this pass follows.

    setScope: function setScope(scope) {
        this.scope = scope;
        this.reloadEverything();
    },

    setCategory: function setCategory(category) {
        this.category = category || null;
        this.cursor = null;
        this._renderSidebarExtras();
        this._loadItemsPage(false);
    },

    setSort: function setSort(sort) {
        this.sort = sort || 'recent';
        this.cursor = null;
        this._repaintSortControls();
        this._loadItemsPage(false);
    },

    // ─── instances / federation directory (inventory.md §3.2) ─────────────

    // Flips one instance's fan-out membership (the Instances checkbox
    // panel, inventory.md §13 Phase D) -- replaces the old single-select
    // InstanceChooser dropdown/setInstanceBaseUrl entirely, now that real
    // multi-select fan-out has a real checkbox-per-row UI to drive it.
    toggleInstanceChecked: function toggleInstanceChecked(baseUrl) {
        var checked = Object.assign({}, this.checkedInstances);
        checked[baseUrl] = !checked[baseUrl];
        this.checkedInstances = checked;
        this.reloadEverything();
    },

    // GET /instances (the real directory), populating checkedInstances with
    // every known instance checked by default (matching §13's mockup
    // default: "browsing N of M instances", all pinned). One-time seeds the
    // directory from the legacy instanceURLs config if the directory comes
    // back empty and config has entries -- config is a migration seed, not
    // a permanent parallel source (inventory.md §13's own scoping decision:
    // otherwise a config-seeded instance could never be removed via the
    // real directory's own UI, since it would just reappear next load).
    // Calls cb() once ready (instances/checkedInstances populated), always
    // -- even on fetch failure, so callers aren't left waiting forever.
    loadInstances: function loadInstances(cb) {
        var self = this;
        cb = cb || function() {};
        this._fetchJson(window.location.origin + '/instances', function(err, body) {
            if (err || !body) { self._applyLocalOnlyInstances(); cb(); return; }
            var instances = body.instances || [];
            if (!instances.length) {
                var configured = (typeof lively !== 'undefined' && lively.Config &&
                    lively.Config.get('instanceURLs', true)) || [];
                if (configured.length) {
                    self._seedInstancesFromConfig(configured, function() {
                        self._fetchJson(window.location.origin + '/instances', function(err2, body2) {
                            self._applyInstancesResult(err2 ? null : body2);
                            cb();
                        });
                    });
                    return;
                }
            }
            self._applyInstancesResult(body);
            cb();
        });
    },

    _applyLocalOnlyInstances: function _applyLocalOnlyInstances() {
        this.instances = [];
        var checked = {};
        checked[window.location.origin] = true;
        this.checkedInstances = checked;
    },

    _applyInstancesResult: function _applyInstancesResult(body) {
        var instances = (body && body.instances) || [];
        var checked = {};
        instances.forEach(function(inst) { checked[inst.baseUrl] = true; });
        checked[window.location.origin] = true; // local instance always available
        this.instances = instances;
        this.checkedInstances = checked;
    },

    // Best-effort, silently ignored on failure (e.g. no signed-in session --
    // POST /instances requires auth) since this is only a one-time
    // convenience migration, not something the browsing UI depends on.
    _seedInstancesFromConfig: function _seedInstancesFromConfig(baseUrls, cb) {
        var remaining = baseUrls.length;
        if (!remaining) { cb(); return; }
        baseUrls.forEach(function(baseUrl) {
            this._postJson(window.location.origin + '/instances', {
                baseUrl: baseUrl, displayName: baseUrl.replace(/^https?:\/\//, '')
            }, function() { if (--remaining === 0) cb(); });
        }, this);
    },

    // The checked subset of known instances, always including local origin
    // as a safe default before loadInstances() has ever resolved.
    _activeInstanceBaseUrls: function _activeInstanceBaseUrls() {
        var self = this;
        var checked = Object.keys(this.checkedInstances || {}).filter(function(u) { return self.checkedInstances[u]; });
        return checked.length ? checked : [window.location.origin];
    },

    // ─── sidebar rendering (inventory.md §13 Phase D) ──────────────────────
    // Direct-DOM-write restyle helpers for anything recolored AFTER a morph
    // is already rendered (scope tabs, category rows) -- applyStyle({fill/
    // textColor:...}) is confirmed (this session's research + CLAUDE.md) to
    // silently no-op on an already-rendered morph for exactly these two
    // properties, so selection-driven restyling writes renderContext()
    // .shapeNode.style directly, same idiom as WalletSetupDialog.js's
    // _paintToggleButton. Border-related properties (width/color) DO reach
    // the DOM via the model layer in this codebase's own confirmed case, so
    // those still go through the normal setBorderColor/setBorderWidth calls.

    _paintScopeTab: function _paintScopeTab(btn, active) {
        var node = btn.renderContext().shapeNode;
        node.style.background = active ? '#fff' : 'transparent';
        node.style.boxShadow = active ? '0 1px 2px rgba(0,0,0,0.12)' : 'none';
        if (btn.label) {
            var labelNode = btn.label.renderContext().shapeNode;
            labelNode.style.color = active ? '#222' : '#666';
            labelNode.style.fontWeight = active ? '600' : 'normal';
        }
    },

    // Rebuilds ScopeTabsRow's active-tab styling (always present) and tears
    // down + reconstructs the Categories/Instances blocks (only present for
    // scope==='public') -- called on every scope change and whenever
    // categoryCounts/instances data resolves. Categories/Instances blocks
    // are hand-constructed fresh each call, same "build fresh, don't try to
    // patch in place" idiom ItemsGrid/_buildItemTile already use for the
    // item grid, tagged with _isSidebarExtra so this method can find and
    // remove its own previous output without disturbing ScopeTabsRow.
    _renderSidebarExtras: function _renderSidebarExtras() {
        var self = this;
        this._paintScopeTab(this.get('scopePublicButton'), this.scope === 'public');
        this._paintScopeTab(this.get('scopeMineButton'), this.scope === 'mine');
        this._paintScopeTab(this.get('scopeSharedButton'), this.scope === 'shared');

        var rail = this.get('LeftSideContainer');
        rail.submorphs.filter(function(m) { return m._isSidebarExtra; }).forEach(function(m) { m.remove(); });
        if (this.scope !== 'public') return;

        var categoriesBlock = this._buildCategoriesBlock();
        categoriesBlock._isSidebarExtra = true;
        rail.addMorph(categoriesBlock);

        var instancesBlock = this._buildInstancesBlock();
        instancesBlock._isSidebarExtra = true;
        rail.addMorph(instancesBlock);
    },

    _buildCategoriesBlock: function _buildCategoriesBlock() {
        var self = this;
        var W = 220;
        var block = new lively.morphic.Box(lively.rect(0, 0, W, 10));
        block.applyStyle({ fill: null, borderWidth: 0 });
        block.draggingEnabled = false; block.droppingEnabled = false; block.grabbingEnabled = false;

        var header = new lively.morphic.Text(lively.rect(0, 0, W, 14), 'CATEGORIES');
        header.applyStyle({ fontFamily: 'Helvetica', fontSize: 7.5, textColor: Color.rgb(153,153,153), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
        header.eventsAreIgnored = true; header.draggingEnabled = false; header.droppingEnabled = false; header.grabbingEnabled = false;
        block.addMorph(header);

        var names = ['All'].concat(lively.identity.PartSerializer.CATEGORY_NAMES);
        var y = 18;
        names.forEach(function(name) {
            var meta = name === 'All' ? { icon: 'apps' } : lively.identity.PartSerializer.CATEGORY_META[name];
            var count = name === 'All' ? self.categoryTotal : (self.categoryCounts[name] || 0);
            var active = (self.category || 'All') === name;

            var row = new lively.morphic.Box(lively.rect(0, y, W, 24));
            row.applyStyle({ fill: active ? Color.rgba(147,51,234,0.12) : null, borderWidth: 0, borderRadius: 6 });
            row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
            row._categoryValue = name === 'All' ? null : name;

            // Box sized 22x22, not the glyph's own ~16x16 model extent -- a
            // Material Symbols glyph at fontSize 12 actually RENDERS at
            // 16x18.67px (fontSize is points, not px, and the glyph's real
            // line-height overshoots its own advance width -- CLAUDE.md's
            // fontSize-in-points gotcha), so a same-size 16x16 box clips it
            // under clipMode:'hidden'. Confirmed live via getBoundingClientRect
            // on the rendered span vs. its shapeNode before this fix.
            var icon = new lively.morphic.Text(lively.rect(8, 1, 22, 22), meta.icon);
            icon.applyStyle({ fontFamily: "'Material Symbols Rounded'", fontSize: 12, textColor: active ? Color.rgbHex('#9333ea') : Color.rgb(51,51,51),
                fill: null, borderWidth: 0, allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
            icon.eventsAreIgnored = true; icon.draggingEnabled = false; icon.droppingEnabled = false; icon.grabbingEnabled = false;
            row.addMorph(icon);

            var label = new lively.morphic.Text(lively.rect(34, 4, W - 74, 16), name);
            label.applyStyle({ fontFamily: 'Helvetica', fontSize: 9, textColor: active ? Color.rgbHex('#9333ea') : Color.rgb(51,51,51),
                fontWeight: active ? 'bold' : 'normal', fill: null, borderWidth: 0, allowInput: false, selectable: false,
                fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
            label.eventsAreIgnored = true; label.draggingEnabled = false; label.droppingEnabled = false; label.grabbingEnabled = false;
            row.addMorph(label);

            var countLabel = new lively.morphic.Text(lively.rect(W - 38, 4, 30, 16), String(count));
            countLabel.applyStyle({ fontFamily: 'Helvetica', fontSize: 8, textColor: Color.rgb(153,153,153), fill: null, borderWidth: 0,
                allowInput: false, selectable: false, align: 'right', fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
            countLabel.eventsAreIgnored = true; countLabel.draggingEnabled = false; countLabel.droppingEnabled = false; countLabel.grabbingEnabled = false;
            row.addMorph(countLabel);

            row.onMouseUp = function() { self.setCategory(row._categoryValue); return true; };
            block.addMorph(row);
            y += 26;
        });
        block.setExtent(lively.pt(W, y));
        return block;
    },

    _buildInstancesBlock: function _buildInstancesBlock() {
        var self = this;
        var W = 220;
        var block = new lively.morphic.Box(lively.rect(0, 0, W, 10));
        block.applyStyle({ fill: null, borderWidth: 0 });
        block.draggingEnabled = false; block.droppingEnabled = false; block.grabbingEnabled = false;

        var header = new lively.morphic.Text(lively.rect(0, 0, W, 14), 'INSTANCES');
        header.applyStyle({ fontFamily: 'Helvetica', fontSize: 7.5, textColor: Color.rgb(153,153,153), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
        header.eventsAreIgnored = true; header.draggingEnabled = false; header.droppingEnabled = false; header.grabbingEnabled = false;
        block.addMorph(header);

        var activeCount = this._activeInstanceBaseUrls().length;
        var totalCount = Math.max(this.instances.length, 1);
        var summary = new lively.morphic.Text(lively.rect(0, 16, W, 14), 'Browsing ' + activeCount + ' of ' + totalCount + ' instances');
        summary.applyStyle({ fontFamily: 'Helvetica', fontSize: 8.5, textColor: Color.rgb(119,119,119), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
        summary.eventsAreIgnored = true; summary.draggingEnabled = false; summary.droppingEnabled = false; summary.grabbingEnabled = false;
        block.addMorph(summary);

        var rows = this.instances.length ? this.instances : [{ baseUrl: window.location.origin, displayName: 'This instance' }];
        var y = 34;
        rows.forEach(function(inst) {
            var checked = !!self.checkedInstances[inst.baseUrl];
            var row = new lively.morphic.Box(lively.rect(0, y, W, 22));
            row.applyStyle({ fill: null, borderWidth: 0 });
            row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;

            // CheckBox's own constructor takes an initial checked bool, not
            // a rect (a plain Morph.subclass wrapping a native <input>) --
            // position it before adding to the world, matching the "bake
            // the final position in before addMorph, avoid a later
            // setPosition call" precedent (CLAUDE.md). Its own onClick
            // already self-toggles via setChecked; overriding it here to
            // call toggleInstanceChecked instead is safe because that
            // triggers a full rebuild of this whole block afterward
            // (reloadEverything -> _renderSidebarExtras), which reconstructs
            // this checkbox with the correct final checked state regardless.
            var checkbox = new lively.morphic.CheckBox(checked);
            checkbox.setPosition(pt(2, 5));
            checkbox.onClick = function() { self.toggleInstanceChecked(inst.baseUrl); return true; };
            row.addMorph(checkbox);

            // "storage" glyph (a server/rack icon) tinted per-instance,
            // replacing the old plain colored dot -- same _instanceColor
            // hash so a given instance keeps its color. Box sized 22x22 for
            // the same reason as the category-sidebar icon above (a 16x16
            // box clips a fontSize:12 Material Symbols glyph).
            var icon = new lively.morphic.Text(lively.rect(19, 0, 22, 22), 'storage');
            icon.applyStyle({ fontFamily: "'Material Symbols Rounded'", fontSize: 12, textColor: Color.rgbHex(self._instanceColor(inst.baseUrl)),
                fill: null, borderWidth: 0, allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
            icon.eventsAreIgnored = true; icon.draggingEnabled = false; icon.droppingEnabled = false; icon.grabbingEnabled = false;
            row.addMorph(icon);

            var label = new lively.morphic.Text(lively.rect(45, 3, W - 51, 16),
                inst.displayName || inst.baseUrl.replace(/^https?:\/\//, ''));
            label.applyStyle({ fontFamily: 'Helvetica', fontSize: 8.5, textColor: Color.rgb(51,51,51), fill: null, borderWidth: 0,
                allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
            label.eventsAreIgnored = true; label.draggingEnabled = false; label.droppingEnabled = false; label.grabbingEnabled = false;
            row.addMorph(label);

            block.addMorph(row);
            y += 24;
        });
        block.setExtent(lively.pt(W, y));
        return block;
    },

    // Deterministic color per instance baseUrl (no server-side color
    // assignment exists) -- a small fixed palette keyed by a cheap hash, so
    // the same instance always gets the same dot color across reloads.
    _instanceColor: function _instanceColor(baseUrl) {
        var palette = ['#9333ea', '#0d9488', '#ea580c', '#2563eb', '#db2777', '#16a34a'];
        var hash = 0;
        for (var i = 0; i < baseUrl.length; i++) hash = (hash * 31 + baseUrl.charCodeAt(i)) >>> 0;
        return palette[hash % palette.length];
    },

    // ─── curated categories (inventory.md §7/§13 Phase D) ─────────────────
    // Counts for the sidebar's All/Media/Games/Templates/Apps/Tools rows --
    // always against the local instance; fan-out category-count aggregation
    // across multiple instances is out of scope, same reasoning the old
    // freeform-tag aggregation this replaces already had.

    loadCategoryCounts: function loadCategoryCounts() {
        var self = this;
        this._fetchJson(window.location.origin + '/parts/public/categories', function(err, body) {
            if (err || !body || !body.categories) return;
            var counts = {};
            body.categories.forEach(function(c) { if (c.category) counts[c.category] = c.count; });
            self.categoryCounts = counts;
            self.categoryTotal = body.total || 0;
            self._renderSidebarExtras();
        });
    },

    // ─── loading items ──────────────────────────────────────────────────

    search: function search(text) {
        this.searchQuery = (text || '').trim();
        this.cursor = null;
        this._loadItemsPage(false);
    },

    loadMoreItems: function loadMoreItems() {
        if (!this.cursor) return;
        this._loadItemsPage(true);
    },

    _loadItemsPage: function _loadItemsPage(append) {
        if (this.scope === 'mine') return this._loadOwnedItemsPage(append, '/parts/mine');
        if (this.scope === 'shared') return this._loadOwnedItemsPage(append, '/parts/shared-with-me');
        this._loadPublicItemsPage(append);
    },

    // scope === 'public': fan out across every checked instance
    // (inventory.md §3.2). True cursor pagination only makes sense against
    // a single source -- juggling N independent opaque cursors across a
    // merged multi-instance feed is real added complexity this pass
    // deliberately skips (nothing in inventory.md §3.2 requires it either).
    // Checking more than one instance switches to one larger capped fetch
    // per instance instead, merged and re-sorted client-side, with "load
    // more" disabled -- the same "capped, no pagination" trade-off
    // ObjectRepository.listPublicParts already makes server-side for its
    // non-recent sorts (see IdentityServer.js/ObjectRepository.js).
    _loadPublicItemsPage: function _loadPublicItemsPage(append) {
        var self = this;
        var instances = this._activeInstanceBaseUrls();
        var fanningOut = instances.length > 1;
        var limit = fanningOut ? 48 : 24;

        var paramsFor = function(baseUrl) {
            var params = ['limit=' + limit];
            if (!fanningOut && self.cursor && append) params.push('cursor=' + encodeURIComponent(self.cursor));
            if (self.searchQuery) params.push('q=' + encodeURIComponent(self.searchQuery));
            if (self.category) params.push('category=' + encodeURIComponent(self.category));
            if (self.sort && self.sort !== 'recent') params.push('sort=' + encodeURIComponent(self.sort));
            return baseUrl + '/parts/public?' + params.join('&');
        };

        this.setStatus('Loading…');
        var remaining = instances.length;
        var allItems = [];
        var lastErr = null;
        var singleCursor = null;
        instances.forEach(function(baseUrl) {
            self._fetchJson(paramsFor(baseUrl), function(err, body) {
                if (err || !body || !body.parts) {
                    lastErr = lastErr || err || new Error('bad response from ' + baseUrl);
                } else {
                    body.parts.forEach(function(row) { allItems.push(self._buildItemFromListingRow(row, baseUrl)); });
                    if (!fanningOut) singleCursor = body.cursor;
                }
                if (--remaining === 0) finish();
            });
        });

        function finish() {
            if (!allItems.length && lastErr) { self.setStatus('Load failed', true); return; }
            if (!append) self.get('ItemsGrid').removeAllItems();
            if (fanningOut) allItems = self._sortMergedItems(allItems);
            self.get('ItemsGrid').startAddingItems(allItems);
            self.cursor = fanningOut ? null : singleCursor;
            var canLoadMore = !fanningOut && !!self.cursor;
            self.get('loadMoreButton').setVisible(canLoadMore);
            self.setStatus((append ? 'Loaded ' : '') + allItems.length + ' item' + (allItems.length === 1 ? '' : 's') +
                (canLoadMore ? ' (more available)' : ''));
        }
    },

    // scope === 'mine' | 'shared': always same-origin, always credentialed
    // (self-only routes, auth.requireAuth) -- no fan-out, no instance
    // concept at all. path is '/parts/mine' or '/parts/shared-with-me'.
    _loadOwnedItemsPage: function _loadOwnedItemsPage(append, path) {
        var self = this;
        var user = (typeof lively !== 'undefined' && lively.identity && lively.identity.did &&
            lively.identity.did.currentUser && lively.identity.did.currentUser());
        if (!user) {
            this.get('ItemsGrid').removeAllItems();
            this.setStatus('Sign in to see this.', true);
            this.get('loadMoreButton').setVisible(false);
            return;
        }
        var params = ['limit=24'];
        if (this.cursor && append) params.push('cursor=' + encodeURIComponent(this.cursor));
        this.setStatus('Loading…');
        var url = window.location.origin + '/@' + encodeURIComponent(user.handle) + path + '?' + params.join('&');
        this._fetchJson(url, function(err, body) {
            if (err || !body || !body.parts) { self.setStatus('Load failed', true); return; }
            if (!append) self.get('ItemsGrid').removeAllItems();
            var items = body.parts.map(function(row) { return self._buildItemFromListingRow(row, window.location.origin); });
            self.get('ItemsGrid').startAddingItems(items);
            self.cursor = body.cursor;
            self.get('loadMoreButton').setVisible(!!self.cursor);
            self.setStatus((append ? 'Loaded ' : '') + body.parts.length + ' item' + (body.parts.length === 1 ? '' : 's') +
                (self.cursor ? ' (more available)' : ''));
        });
    },

    // Best-effort re-sort of a fan-out-merged item list -- each source
    // instance's own SQL ordering doesn't compose once rows from several
    // instances are interleaved. Mirrors the same sort keys
    // ObjectRepository.listPublicParts supports server-side for a single
    // instance; 'recent' falls back to each item's own `created` timestamp
    // (fan-out mode never uses the id-based cursor ordering, since ids
    // aren't comparable across separate databases).
    _sortMergedItems: function _sortMergedItems(items) {
        var sort = this.sort || 'recent';
        var byCreatedDesc = function(a, b) {
            var ca = (a.envelope && a.envelope.created) || '';
            var cb = (b.envelope && b.envelope.created) || '';
            return ca < cb ? 1 : ca > cb ? -1 : 0;
        };
        if (sort === 'az') {
            return items.slice().sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
        }
        if (sort === 'popular') {
            return items.slice().sort(function(a, b) { return (b.starCount || 0) - (a.starCount || 0); });
        }
        // 'mostCommented' has no per-item comment count on listing rows
        // (deliberately not fetched for every row, same reasoning as
        // htmlLogo -- see _withStarCounts' own comment in IdentityServer.js)
        // -- falls back to recency, same as 'recentlyPublished'/'recent'.
        return items.slice().sort(byCreatedDesc);
    },

    // ─── popular strip (inventory.md §13 Phase D) ──────────────────────────
    // Independent top-8-by-stars fetch for the "Popular this week" strip --
    // deliberately NOT reusing _loadItemsPage/_sortMergedItems (those are
    // driven by this.sort, the main grid's own sort choice; the strip is
    // always popular-sorted regardless). Same fan-out-but-capped trade-off
    // as _loadPublicItemsPage: one bounded fetch per checked instance,
    // merged and re-sorted client-side, no pagination cursor -- chevron
    // paging below just re-slices the already-fetched top 8.
    loadPopularStrip: function loadPopularStrip() {
        var self = this;
        var instances = this._activeInstanceBaseUrls();
        var remaining = instances.length;
        var allItems = [];
        instances.forEach(function(baseUrl) {
            self._fetchJson(baseUrl + '/parts/public?limit=8&sort=popular', function(err, body) {
                if (!err && body && body.parts) {
                    body.parts.forEach(function(row) { allItems.push(self._buildItemFromListingRow(row, baseUrl)); });
                }
                if (--remaining === 0) finish();
            });
        });
        function finish() {
            allItems.sort(function(a, b) { return (b.starCount || 0) - (a.starCount || 0); });
            self.popularItems = allItems.slice(0, 8);
            self.popularStart = 0;
            self._renderPopularTiles();
        }
    },

    popularPrev: function popularPrev() {
        this.popularStart = Math.max(0, this.popularStart - 4);
        this._renderPopularTiles();
    },

    popularNext: function popularNext() {
        var maxStart = Math.max(0, this.popularItems.length - 4);
        this.popularStart = Math.min(maxStart, this.popularStart + 4);
        this._renderPopularTiles();
    },

    // Adds/removes the whole PopularCard block and shows/hides TopBar's
    // sort controls based on scope (public-only, per plan) -- called from
    // reloadEverything on every scope switch. PopularCard is inserted
    // before AllItemsCard (MainContainer.addMorph's 2-arg "insert before"
    // form) so AllItemsCard stays MainContainer's flexible LAST child
    // either way, matching the fixed-then-flexible-last VerticalLayout
    // shape this file already relies on elsewhere.
    _renderMainColumnForScope: function _renderMainColumnForScope() {
        var mainContainer = this.get('MainContainer');
        var topBar = this.get('TopBar');
        var showSort = this.scope === 'public';
        ['sortPopularButton', 'sortRecentButton', 'sortMenuButton'].forEach(function(name) {
            var m = topBar.get(name);
            if (m) m.setVisible(showSort);
        });
        var existingPopular = this.get('PopularCard');
        if (showSort && !existingPopular) {
            mainContainer.addMorph(this._buildPopularCard(), mainContainer.get('AllItemsCard'));
            this._renderPopularTiles();
        } else if (!showSort && existingPopular) {
            existingPopular.remove();
        }
        this._repaintSortControls();
    },

    _repaintSortControls: function _repaintSortControls() {
        if (this.scope !== 'public') return;
        var topBar = this.get('TopBar');
        this._paintSortPill(topBar.get('sortPopularButton'), this.sort === 'popular');
        this._paintSortPill(topBar.get('sortRecentButton'), this.sort === 'recent');
        var extraActive = ['az', 'mostCommented', 'recentlyPublished'].indexOf(this.sort) !== -1;
        this._paintSortMenuButton(topBar.get('sortMenuButton'), extraActive);
    },

    _paintSortPill: function _paintSortPill(btn, active) {
        if (!btn) return;
        var node = btn.renderContext().shapeNode;
        node.style.background = active ? '#9333ea' : '#fff';
        node.style.border = active ? 'none' : '1px solid rgb(214,214,214)';
        if (btn.label) btn.label.renderContext().shapeNode.style.color = active ? '#fff' : '#333';
    },

    _paintSortMenuButton: function _paintSortMenuButton(btn, active) {
        if (!btn) return;
        var node = btn.renderContext().shapeNode;
        node.style.background = active ? '#9333ea' : '#fff';
        node.style.border = active ? 'none' : '1px solid rgb(214,214,214)';
        if (btn.label) btn.label.renderContext().shapeNode.style.color = active ? '#fff' : '#333';
    },

    // Popup for the 3 extra sort keys (A-Z / Most Commented / Recently
    // Published) -- exact same lively.morphic.Menu.openAt mechanism as
    // openInspectorMenu below, so it doesn't need its own show/hide state.
    openSortMenu: function openSortMenu() {
        var btn = this.get('TopBar').get('sortMenuButton');
        var pos = btn.worldPoint(lively.pt(0, btn.getExtent().y));
        var self = this;
        var items = [
            ['Alphabetical (A–Z)' + (self.sort === 'az' ? '  ✓' : ''), function() { self.setSort('az'); }],
            ['Most Commented' + (self.sort === 'mostCommented' ? '  ✓' : ''), function() { self.setSort('mostCommented'); }],
            ['Recently Published' + (self.sort === 'recentlyPublished' ? '  ✓' : ''), function() { self.setSort('recentlyPublished'); }]
        ];
        lively.morphic.Menu.openAt(pos, 'Sort by', items);
    },

    // ─── popular strip rendering (inventory.md §13 Phase D) ────────────────

    _buildPopularCard: function _buildPopularCard() {
        var card = new lively.morphic.Box(lively.rect(0, 0, 840, 232));
        card.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(230,230,230), borderRadius: 12 });
        card.name = 'PopularCard';
        card.draggingEnabled = false; card.droppingEnabled = false; card.grabbingEnabled = false;

        var header = new lively.morphic.Text(lively.rect(16, 12, 300, 14), 'POPULAR THIS WEEK');
        header.applyStyle({ fontFamily: 'Helvetica', fontSize: 7.5, textColor: Color.rgb(153,153,153), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
        header.eventsAreIgnored = true; header.draggingEnabled = false; header.droppingEnabled = false; header.grabbingEnabled = false;
        card.addMorph(header);

        // Empty content placeholder -- _renderPopularTiles fills this in
        // (tagged _isPopularContent so it can clear+rebuild without
        // touching the header above).
        return card;
    },

    _renderPopularTiles: function _renderPopularTiles() {
        var self = this;
        var card = this.get('PopularCard');
        if (!card) return;
        card.submorphs.filter(function(m) { return m._isPopularContent; }).forEach(function(m) { m.remove(); });

        var TILE_W = 168, GAP = 16, VISIBLE = 4;
        var visible = this.popularItems.slice(this.popularStart, this.popularStart + VISIBLE);
        var leftDisabled = this.popularStart <= 0;
        var rightDisabled = this.popularStart >= Math.max(0, this.popularItems.length - VISIBLE);

        function iconButton(x, glyph, disabled, onClick) {
            var btn = new lively.morphic.Box(lively.rect(x, 40, 32, 32));
            btn.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: disabled ? Color.rgb(238,238,238) : Color.rgb(214,214,214), borderRadius: 16 });
            btn._isPopularContent = true;
            btn.draggingEnabled = false; btn.droppingEnabled = false; btn.grabbingEnabled = false;
            // 24x24, not 24x16 -- a fontSize:13 glyph renders ~17x21px tall,
            // taller than a 16px-tall box (same clipping gotcha as the
            // sidebar category icons above).
            var icon = new lively.morphic.Text(lively.rect(4, 4, 24, 24), glyph);
            icon.applyStyle({ fontFamily: "'Material Symbols Rounded'", fontSize: 13, textColor: disabled ? Color.rgb(204,204,204) : Color.rgb(51,51,51),
                fill: null, borderWidth: 0, allowInput: false, selectable: false, align: 'center', fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
            icon.eventsAreIgnored = true; icon.draggingEnabled = false; icon.droppingEnabled = false; icon.grabbingEnabled = false;
            btn.addMorph(icon);
            if (!disabled) btn.onMouseUp = function() { onClick(); return true; };
            return btn;
        }

        card.addMorph(iconButton(16, 'chevron_left', leftDisabled, function() { self.popularPrev(); }));
        card.addMorph(iconButton(792, 'chevron_right', rightDisabled, function() { self.popularNext(); }));

        visible.forEach(function(item, i) {
            var tile = self._buildItemTile(item);
            tile._isPopularContent = true;
            tile.setPosition(pt(56 + i * (TILE_W + GAP), 40));
            card.addMorph(tile);
        });
    },

    // POST helper (parallel to _fetchJson's GET) -- same-origin only
    // (federation directory writes are always local, per inventory.md
    // §3.2), credentialed.
    _postJson: function _postJson(url, body, cb) {
        fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
            .then(function(res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function(json) { cb(null, json); })
            .catch(function(err) { cb(err); });
    },

    setStatus: function setStatus(text, isError) {
        var t = this.get('statusText');
        t.textString = text || '';
        t.setTextColor(isError ? Color.rgb(204,51,51) : Color.rgb(120,120,120));
    },

    // ─── item construction ──────────────────────────────────────────────

    // Builds an IdentityPartItem from a /parts/public listing row — no
    // owning IdentityPartsSpace exists for another user's items, so this is
    // constructed by hand the same way the old PublicPartsBrowser.js's
    // _openEnvelope already did, just eagerly (once per grid item, not only
    // on open). fetchHtmlLogo is read by PartsBinItem.setupLogo
    // (core/lively/morphic/ScriptingSupport.js) to lazily fetch the full
    // envelope (and therefore the real htmlLogo snapshot) once this tile
    // actually mounts, mirroring setupHTMLLogo's own fetch-then-paint
    // pattern for WebDAV parts.
    _buildItemFromListingRow: function _buildItemFromListingRow(row, baseUrl) {
        var self = this;
        var state = row.state || {};
        var partName = state.partName || row.objId;
        var item = new lively.identity.IdentityPartItem(partName, '*public*');
        item.envelope = row;
        item.handle = row.handle;
        item._instanceBaseUrl = baseUrl;
        // Enrichment fields the row already carries but IdentityPartItem
        // itself has no slot for -- read directly by the item-tile morph
        // (inventory.md §13 Phase D) rather than round-tripping through
        // the envelope again.
        item.category = state.category || null;
        item.starCount = row.starCount || 0;

        var metaInfo = new lively.PartsBin.PartsBinMetaInfo();
        metaInfo.partName = partName;
        metaInfo.comment = state.comment || '';
        metaInfo.tags = state.tags || [];
        metaInfo.partsSpaceName = '*public*';
        metaInfo.lastModifiedDate = row.created ? new Date(row.created) : new Date();
        item.loadedMetaInfo = metaInfo;

        item.fetchHtmlLogo = function(cb) {
            self._fetchFullEnvelope(item, function(err, fullEnv) {
                if (err) { cb(err); return; }
                cb(null, fullEnv.state && fullEnv.state.htmlLogo);
            });
        };
        return item;
    },

    // ─── item tile (inventory.md §13 Phase D) ───────────────────────────
    // Display + select only, for the grid and (later) the popular-strip —
    // a category-tinted icon square (not a live rendered preview, matching
    // the §13 mockup's own design) with an instance badge and star-count
    // badge overlaid, plus title/author below. Deliberately NOT
    // lively.morphic.PartsBinItem/PartItem: no drag-to-load here (a real,
    // documented scope cut — see the module comment at the top of this
    // file's "Naming convention" block and inventory.md §13). Open Item /
    // View Source / Inspect in the right panel remain the only load path
    // from this grid, already trust-gated (inventory.md §11) via
    // IdentityPartItem.loadPart -> PartItem.setPartFromJSON regardless of
    // how the tile itself looks.
    //
    // Every decorative child sets draggingEnabled/droppingEnabled/
    // grabbingEnabled to false AND eventsAreIgnored:true (CLAUDE.md's
    // "three flags, every visual child individually" gotcha) so a click
    // anywhere on the tile reaches the tile's own onMouseUp instead of
    // being intermittently swallowed by whichever child happens to be
    // under the cursor. Category color/icon lookup goes through
    // lively.identity.PartSerializer's namespace-object properties (never
    // a closure var), matching CLAUDE.md's BuildSpec-closure-loss fix --
    // not strictly required here (tiles are hand-constructed each reload,
    // never serialized/reconstructed), but costs nothing and matches this
    // codebase's established idiom for the same lookup.
    _buildItemTile: function _buildItemTile(item) {
        var meta = (item.category && lively.identity.PartSerializer.CATEGORY_META[item.category]) ||
            lively.identity.PartSerializer.UNCATEGORIZED_META;
        var instanceLabel = (item._instanceBaseUrl || window.location.origin)
            .replace(/^https?:\/\//, '').replace(/\/$/, '');

        var W = 168, H = 180, ICON_H = 140;
        var tile = new lively.morphic.Box(lively.rect(0, 0, W, H));
        tile.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(230,230,230), borderRadius: 10 });
        tile.partItem = item;
        tile.draggingEnabled = false;
        tile.droppingEnabled = false;
        tile.grabbingEnabled = false;
        tile.isSelected = false;

        function noDrag(m) {
            m.draggingEnabled = false; m.droppingEnabled = false; m.grabbingEnabled = false;
            m.eventsAreIgnored = true;
        }

        var iconArea = new lively.morphic.Box(lively.rect(0, 0, W, ICON_H));
        iconArea.applyStyle({ fill: Color.rgbHex(meta.tint), borderWidth: 0, borderRadius: 9 });
        noDrag(iconArea);
        tile.addMorph(iconArea);

        var icon = new lively.morphic.Text(lively.rect((W - 60) / 2, (ICON_H - 60) / 2, 60, 60), meta.icon);
        icon.applyStyle({
            fontFamily: "'Material Symbols Rounded'", fontSize: 33, textColor: Color.rgbHex(meta.accent),
            fill: null, borderWidth: 0, allowInput: false, selectable: false, align: 'center',
            fixedWidth: true, fixedHeight: true, clipMode: 'hidden'
        });
        noDrag(icon);
        iconArea.addMorph(icon);

        var badge = new lively.morphic.Box(lively.rect(6, 6, 74, 16));
        badge.applyStyle({ fill: Color.rgba(255,255,255,0.88), borderWidth: 0, borderRadius: 8 });
        noDrag(badge);
        iconArea.addMorph(badge);
        var badgeLabel = new lively.morphic.Text(lively.rect(5, 1, 64, 14), instanceLabel);
        badgeLabel.applyStyle({
            fontSize: 7, textColor: Color.rgb(68,68,68), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden'
        });
        noDrag(badgeLabel);
        badge.addMorph(badgeLabel);

        // Badge grown from 16 to 20px tall (bottom edge held at ICON_H-6, same
        // as before) so a fontSize:9 star glyph (renders ~12x14.67px) has
        // room -- a 14x14 icon box was clipping it, same gotcha as the
        // sidebar category icons.
        var starBadge = new lively.morphic.Box(lively.rect(W - 6 - 44, ICON_H - 6 - 20, 44, 20));
        starBadge.applyStyle({ fill: Color.rgba(255,255,255,0.9), borderWidth: 0, borderRadius: 10 });
        noDrag(starBadge);
        iconArea.addMorph(starBadge);
        var starIcon = new lively.morphic.Text(lively.rect(4, 1, 17, 18), 'star');
        starIcon.applyStyle({
            fontFamily: "'Material Symbols Rounded'", fontSize: 9, textColor: Color.rgbHex('#d97706'),
            fill: null, borderWidth: 0, allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden'
        });
        noDrag(starIcon);
        var starText = new lively.morphic.Text(lively.rect(23, 3, 17, 14), String(item.starCount || 0));
        starText.applyStyle({
            fontFamily: "Helvetica", fontSize: 8, textColor: Color.rgb(68,68,68), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden'
        });
        noDrag(starText);
        starBadge.addMorph(starText);
        starBadge.addMorph(starIcon);

        var title = new lively.morphic.Text(lively.rect(4, ICON_H + 4, W - 8, 16), item.name || '');
        title.applyStyle({
            fontFamily: "Helvetica", fontSize: 9, textColor: Color.rgb(34,34,34), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden'
        });
        noDrag(title);
        tile.addMorph(title);

        var author = new lively.morphic.Text(lively.rect(4, ICON_H + 20, W - 8, 14), item.handle ? ('@' + item.handle) : '');
        author.applyStyle({
            fontFamily: "Helvetica", fontSize: 7.5, textColor: Color.rgb(136,136,136), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden'
        });
        noDrag(author);
        tile.addMorph(author);

        tile.showAsSelected = function() {
            this.isSelected = true;
            this.applyStyle({ borderColor: Color.rgbHex('#9333ea'), borderWidth: 2 });
        };
        tile.showAsNotSelected = function() {
            this.isSelected = false;
            this.applyStyle({ borderColor: Color.rgb(230,230,230), borderWidth: 1 });
        };
        tile.onMouseUp = function(evt) {
            var browser = this.get('InventoryBrowser');
            if (browser) browser.selectTile(this);
            return true;
        };

        return tile;
    },

    // Fetches the full envelope for `item` (record.payload + htmlLogo
    // included) and upgrades item.envelope in place — shared by
    // fetchHtmlLogo (thumbnail) and openSelectedItem (actual open), so a
    // tile whose thumbnail already loaded needs no second round-trip to
    // open.
    _fetchFullEnvelope: function _fetchFullEnvelope(item, cb) {
        if (item.envelope && item.envelope.record && item.envelope.record.payload) {
            cb(null, item.envelope);
            return;
        }
        var base = item._instanceBaseUrl || window.location.origin;
        var url = base + '/@' + encodeURIComponent(item.handle || '_') + '/' + encodeURIComponent(item.envelope.objId);
        this._fetchJson(url, function(err, envelope) {
            if (err) { cb(err); return; }
            item.envelope = envelope;
            cb(null, envelope);
        });
    },

    // Anonymous for a different instance (a wildcard Access-Control-Allow-Origin
    // response can't be combined with credentialed requests — see the
    // matching comment on IdentityPartItem.loadPartVersions), credentialed
    // for the local instance so a signed-in viewer's own richer optionalAuth
    // responses still apply exactly as before this feature existed.
    _fetchJson: function _fetchJson(url, cb) {
        var base = url.split('/').slice(0, 3).join('/');
        var isCrossOrigin = base !== window.location.origin;
        fetch(url, isCrossOrigin ? {} : { credentials: 'include' })
            .then(function(res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function(body) { cb(null, body); })
            .catch(function(err) { cb(err); });
    },

    // ─── selection / info panel (inventory.md §13 Phase D) ────────────────
    // selectTile is the one entry point every tile's onMouseUp calls now
    // (both the All-items grid and the Popular strip share it) -- replaces
    // the old ItemsGrid-local selectPartItem/connectionRebuilder binding,
    // since a tile can now live in either container and selecting one must
    // deselect the other regardless of which one currently holds it.

    selectTile: function selectTile(tileMorph) {
        if (this.selectedTileMorph && this.selectedTileMorph !== tileMorph && this.selectedTileMorph.showAsNotSelected) {
            this.selectedTileMorph.showAsNotSelected();
        }
        this.selectedTileMorph = tileMorph;
        if (tileMorph && tileMorph.showAsSelected) tileMorph.showAsSelected();
        this.setSelectedItem(tileMorph && tileMorph.partItem);
    },

    setSelectedItem: function setSelectedItem(item) {
        this.selectedItem = item;
        if (!item) {
            this.selectedItemStarInfo = null;
            this.selectedItemComments = [];
            this.versionsExpanded = false;
            this.renderRightPanel();
            return;
        }
        this.versionsExpanded = false;
        this.renderRightPanel();

        var self = this;
        item.loadPartVersions();
        // loadPartVersions is a plain synchronous-looking call whose XHR
        // resolves later and just assigns item.partVersions once (no
        // incremental streaming the way the classic browser's WebDAV
        // metaInfo connect had to handle) — poll briefly rather than wiring
        // a lively.bindings connect for a single one-shot value.
        var waited = 0;
        (function poll() {
            if (self.selectedItem !== item) return; // selection moved on
            if (item.partVersions) { self.renderRightPanel(); return; }
            waited += 150;
            if (waited > 4000) return;
            setTimeout(poll, 150);
        })();

        this.loadStarInfoForSelectedItem();
        this.loadCommentsForSelectedItem();
    },

    // ─── stars (inventory.md §13) ───────────────────────────────────────
    // State lives on the browser (selectedItemStarInfo) rather than a
    // dedicated widget for now -- Phase D's right-panel star button reads
    // this the same way selectedItemVersions' poll above feeds a not-yet-
    // built version-badge UI. _itemUrl is shared with the comment methods
    // below.

    _itemUrl: function _itemUrl(item, suffix) {
        var base = item._instanceBaseUrl || window.location.origin;
        return base + '/@' + encodeURIComponent(item.handle || '_') + '/' + encodeURIComponent(item.envelope.objId) + suffix;
    },

    loadStarInfoForSelectedItem: function loadStarInfoForSelectedItem() {
        var self = this, item = this.selectedItem;
        this.selectedItemStarInfo = null;
        if (!item) return;
        this._fetchJson(this._itemUrl(item, '/stars'), function(err, info) {
            if (self.selectedItem !== item) return; // selection moved on
            if (err || !info) return;
            self.selectedItemStarInfo = info;
            self.renderRightPanel();
        });
    },

    toggleStarOnSelectedItem: function toggleStarOnSelectedItem() {
        var self = this, item = this.selectedItem;
        if (!item) return;
        var info = this.selectedItemStarInfo;
        var wantStar = !(info && info.mine);
        var base = item._instanceBaseUrl || window.location.origin;
        var url = base + '/@' + encodeURIComponent(item.handle || '_') + '/' + encodeURIComponent(item.envelope.objId) + '/stars' + (wantStar ? '' : '/self');
        this._postOrDeleteJson(wantStar ? 'PUT' : 'DELETE', url, function(err) {
            if (err) { self.setStatus('Could not update star: ' + (err.message || err), true); return; }
            self.loadStarInfoForSelectedItem();
        });
    },

    // ─── comments (inventory.md §13) ────────────────────────────────────

    loadCommentsForSelectedItem: function loadCommentsForSelectedItem() {
        var self = this, item = this.selectedItem;
        this.selectedItemComments = [];
        if (!item) return;
        this._fetchJson(this._itemUrl(item, '/comments?limit=50'), function(err, body) {
            if (self.selectedItem !== item) return;
            if (err || !body || !body.comments) return;
            self.selectedItemComments = body.comments;
            self.renderRightPanel();
        });
    },

    postCommentOnSelectedItem: function postCommentOnSelectedItem(body) {
        var self = this, item = this.selectedItem;
        var text = (body || '').trim();
        if (!item || !text) return;
        this._postJson(this._itemUrl(item, '/comments'), { body: text }, function(err) {
            if (err) { self.setStatus('Could not post comment: ' + (err.message || err), true); return; }
            self.loadCommentsForSelectedItem();
        });
    },

    // PUT/DELETE helper (parallel to _fetchJson/_postJson) -- used by the
    // star toggle, which needs both verbs against the same URL shape.
    _postOrDeleteJson: function _postOrDeleteJson(method, url, cb) {
        fetch(url, { method: method, credentials: 'include' })
            .then(function(res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function(json) { cb(null, json); })
            .catch(function(err) { cb(err); });
    },

    // Object ID and Author DID each get their own line (previously crammed
    // onto one "Object ID: X   Author DID: Y" line) -- objIdLineIndex/
    // didLineIndex are the zero-based line numbers within `text` that
    // renderRightPanel uses to position a copy-icon button next to each,
    // rather than encoding a clickable character range into the text
    // itself (the old single-line version only made the DID copiable, via
    // an emphasize()'d icon glyph baked into the text -- replaced below by
    // real copy buttons, one per field, following ProfileCard.js's own
    // established copy-button idiom).
    describeItemMeta: function describeItemMeta(item) {
        if (!item || !item.envelope) return null;
        var env = item.envelope;
        var created = env.created ? new Date(env.created).format('yyyy-mm-dd HH:MM') : 'unknown';
        var did = env.did || null;
        var didShort = did && did.length > 30 ? (did.slice(0, 20) + '…' + did.slice(-6)) : (did || 'unknown');
        var objId = env.objId || null;
        var hostingUrl = item._instanceBaseUrl || window.location.origin;
        var hostingHost = hostingUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'unknown';
        var tags = (item.loadedMetaInfo && item.loadedMetaInfo.tags) || [];
        var lines = [
            'Published by: @' + (item.handle || '?'),
            'Created: ' + created,
            'Object ID: ' + (objId || 'unknown'),
            'Author DID: ' + didShort,
            'Hosting: ' + hostingHost,
            'Tags: ' + (tags.length ? tags.join(', ') : 'none')
        ];
        return { text: lines.join('\n'), objId: objId, did: did, objIdLineIndex: 2, didLineIndex: 3 };
    },

    toggleVersionsExpanded: function toggleVersionsExpanded() {
        this.versionsExpanded = !this.versionsExpanded;
        this.renderRightPanel();
    },

    // Rebuilds the entire right panel from scratch on every selection/
    // star/comment/version change -- same "hand-construct fresh" idiom as
    // the sidebar's Categories/Instances blocks and _buildItemTile, chosen
    // over patching named morphs in place because so much of this content
    // (version rows, comment rows) varies in COUNT, not just text.
    renderRightPanel: function renderRightPanel() {
        var self = this;
        var panel = this.get('RightPanel');
        panel.submorphs.clone().invoke('remove');
        var item = this.selectedItem;
        var PAD = 18, W = 360 - 2 * PAD;

        function noDrag(m) { m.draggingEnabled = false; m.droppingEnabled = false; m.grabbingEnabled = false; }
        function textRow(rect, text, style) {
            var t = new lively.morphic.Text(rect, text);
            t.applyStyle(Object.assign({ fill: null, borderWidth: 0, allowInput: false, selectable: false,
                fixedWidth: true, fixedHeight: true, clipMode: 'hidden', fontFamily: 'Helvetica' }, style));
            t.eventsAreIgnored = true;
            noDrag(t);
            return t;
        }

        if (!item) {
            panel.addMorph(textRow(lively.rect(PAD, 60, W, 60),
                'Select an item to see its details.',
                { fontSize: 10.5, textColor: Color.rgb(153,153,153), align: 'center' }));
            return;
        }

        var y = 18;
        function place(m, h) { m.setPosition(pt(PAD, y)); panel.addMorph(m); y += h; }

        place(textRow(lively.rect(0,0,W,20), item.name || '',
            { fontSize: 10.5, fontWeight: 'bold', textColor: Color.rgb(34,34,34) }), 26);

        // Meta block (Published by / Created / Object ID / Author DID /
        // Hosting / Tags -- Object ID and Author DID each on their own line)
        var meta = this.describeItemMeta(item);
        var lineCount = meta ? meta.text.split('\n').length : 1;
        // 18px/line, not the naive fontSize-derived guess -- live-measured
        // (getComputedStyle/scrollHeight) at ~17.6px/line for this 8.5pt
        // text, confirmed by a real clipped-last-line bug this replaced.
        var metaH = lineCount * 18 + 8;
        var metaMorph = textRow(lively.rect(0,0,W,metaH), meta ? meta.text : '',
            { fontSize: 8.5, textColor: Color.rgb(85,85,85) });
        var metaY = y;
        place(metaMorph, metaH + 12);

        // Copy-icon buttons for Object ID / Author DID, one per field --
        // a real Text morph rendering a Material Symbols glyph, styled and
        // wired exactly like ProfileCard.js's own copy-DID/copy-address
        // buttons (see that file's comment on why this is a plain Text
        // morph, not a lively.morphic.Button: Button's internal label Text
        // silently ignores a fontFamily change, so the icon glyph never
        // actually swaps to the icon font). addScript's handler references
        // only this.* (never a closure var), matching CLAUDE.md's
        // BuildSpec/addScript-closure-loss fix.
        function makeCopyButton(text, lineIndex, tooltip) {
            // Height 28, not ProfileCard's own 22 -- confirmed live
            // (getBoundingClientRect) that this button's `padding` style
            // makes the icon render a few px taller than a same-sized icon
            // box with no padding, clipping it at 22; 28 leaves a positive
            // margin.
            var btn = new lively.morphic.Text(lively.rect(PAD + W - 26, metaY + lineIndex * 18 - 4, 26, 28), 'content_copy');
            btn.applyStyle({ fill: Color.rgb(240,240,240), borderColor: Color.rgb(200,200,200),
                borderRadius: 4, borderWidth: 1, fontFamily: "'Material Symbols Rounded'", fontSize: 12,
                textColor: Color.rgb(80,80,80), align: 'center', padding: lively.Rectangle.inset(0,5,0,0),
                allowInput: false, selectable: false, clipMode: 'hidden', whiteSpaceHandling: 'pre', handStyle: 'pointer' });
            btn._copyText = text;
            btn.addScript(function onMouseUp(evt) {
                var theText = this._copyText;
                var m = this;
                if (theText && navigator.clipboard) {
                    navigator.clipboard.writeText(theText).then(function() {
                        m.setTextString('check');
                        setTimeout(function() { m.setTextString('content_copy'); }, 1500);
                    });
                }
                evt.stop();
                return true;
            });
            noDrag(btn);
            panel.addMorph(btn);
            btn.renderContext().morphNode.title = tooltip;
        }
        if (meta && meta.objId) makeCopyButton(meta.objId, meta.objIdLineIndex, 'Copy Object ID');
        if (meta && meta.did) makeCopyButton(meta.did, meta.didLineIndex, 'Copy Author DID');

        // Version badge + (conditionally) expandable version list. Built
        // from item.partVersions -- {date, author, version(shortCid)} rows,
        // ascending -- exactly as loadPartVersions already produces; no
        // real per-version signer exists yet (inventory.md §1.4/§9), so
        // every row shows the owning handle, matching today's actual data.
        if (!item.partVersions) {
            place(textRow(lively.rect(0,0,W,18), 'Loading versions…',
                { fontSize: 9, textColor: Color.rgb(153,153,153) }), 24);
        } else {
            var versions = item.partVersions.length ? item.partVersions : null;
            var latest = versions ? versions[versions.length - 1] : null;
            var badgeText = versions ?
                ('v' + versions.length + ' · updated ' + new Date(latest.date).format('yyyy-mm-dd') + ' · ' + latest.author) :
                'No version history';

            var badge = new lively.morphic.Box(lively.rect(0, 0, W, 30));
            badge.applyStyle({ fill: Color.rgb(250,250,250), borderWidth: 1, borderColor: Color.rgb(226,226,226), borderRadius: 8 });
            noDrag(badge);
            // Icon boxes grown past their glyphs' own 16x16 model extent --
            // a fontSize:12/14 Material Symbols glyph renders taller than
            // 16px (fontSize is points, not px) and clips under
            // clipMode:'hidden' otherwise; same gotcha as the sidebar
            // category icons above.
            badge.addMorph(textRow(lively.rect(8,4,22,22), 'history',
                { fontFamily: "'Material Symbols Rounded'", fontSize: 12, textColor: Color.rgb(136,136,136) }));
            badge.addMorph(textRow(lively.rect(34,8,W-62,14), badgeText,
                { fontSize: 8.5, textColor: Color.rgb(51,51,51) }));
            badge.addMorph(textRow(lively.rect(W-32,2,24,26), this.versionsExpanded ? 'expand_less' : 'expand_more',
                { fontFamily: "'Material Symbols Rounded'", fontSize: 14, textColor: Color.rgb(136,136,136) }));
            if (versions) badge.onMouseUp = function() { self.toggleVersionsExpanded(); return true; };
            place(badge, 36);

            if (this.versionsExpanded && versions) {
                var listBox = new lively.morphic.Box(lively.rect(0, 0, W, versions.length * 22));
                listBox.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(238,238,238), borderRadius: 8 });
                noDrag(listBox);
                versions.slice().reverse().forEach(function(v, i) {
                    listBox.addMorph(textRow(lively.rect(8, i * 22 + 3, W - 16, 16),
                        'v' + (versions.length - i) + ' · ' + new Date(v.date).format('yyyy-mm-dd') + ' · ' + v.version + ' · ' + v.author,
                        { fontSize: 7.5, textColor: Color.rgb(85,85,85) }));
                });
                place(listBox, versions.length * 22 + 10);
            }
        }

        // Star button
        var info = this.selectedItemStarInfo;
        var starCount = info ? info.count : (item.starCount || 0);
        var starred = !!(info && info.mine);
        var starBtn = new lively.morphic.Box(lively.rect(0, 0, 78, 28));
        starBtn.applyStyle({ fill: starred ? Color.rgbHex('#9333ea') : Color.white,
            borderWidth: 1, borderColor: starred ? Color.rgbHex('#9333ea') : Color.rgb(214,214,214), borderRadius: 6 });
        noDrag(starBtn);
        // 22x24, not 16x16 -- a fontSize:13 glyph renders ~17x21px tall
        // (fontSize is points, not px), clipping in a same-size box under
        // clipMode:'hidden'; same gotcha as the sidebar category icons.
        starBtn.addMorph(textRow(lively.rect(8,2,22,24), starred ? 'star' : 'star_border',
            { fontFamily: "'Material Symbols Rounded'", fontSize: 13, textColor: starred ? Color.white : Color.rgb(51,51,51) }));
        starBtn.addMorph(textRow(lively.rect(32,8,38,14), String(starCount),
            { fontSize: 9, textColor: starred ? Color.white : Color.rgb(51,51,51) }));
        starBtn.onMouseUp = function() { self.toggleStarOnSelectedItem(); return true; };
        place(starBtn, 38);

        // Open Item / View Source / Inspect
        var buttonsRow = new lively.morphic.Box(lively.rect(0, 0, W, 26));
        buttonsRow.applyStyle({ fill: null, borderWidth: 0 });
        noDrag(buttonsRow);
        var btnW = (W - 12) / 3;
        [['Open Item', function() { self.openSelectedItem(); }],
         ['View Source', function() { self.viewSourceOfSelectedItem(); }],
         ['Inspect', function() { self.openInspectorMenu(); }]].forEach(function(pair, i) {
            var b = new lively.morphic.Box(lively.rect(i * (btnW + 6), 0, btnW, 26));
            b.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(214,214,214), borderRadius: 6 });
            noDrag(b);
            b.addMorph(textRow(lively.rect(0,5,btnW,16), pair[0], { fontSize: 8, textColor: Color.rgb(51,51,51), align: 'center' }));
            b.onMouseUp = function() { pair[1](); return true; };
            if (pair[0] === 'Inspect') self._inspectButtonMorph = b;
            buttonsRow.addMorph(b);
        });
        place(buttonsRow, 40);

        // Comments
        place(textRow(lively.rect(0,4,W,16), 'COMMENTS', { fontSize: 7.5, textColor: Color.rgb(153,153,153) }), 24);

        var comments = (this.selectedItemComments || []).slice().reverse();
        if (!comments.length) {
            place(textRow(lively.rect(0,0,W,16), 'No comments yet.', { fontSize: 9, textColor: Color.rgb(153,153,153) }), 22);
        } else {
            comments.forEach(function(c) {
                // Wrapped-line-count estimate, not a live measurement (see
                // inventory.md Phase D plan's own flagged risk for this) --
                // clipMode stays 'auto' below rather than 'hidden' so an
                // undershoot scrolls instead of silently clipping.
                var estLines = Math.max(1, Math.ceil((c.body || '').length * 6.2 / (W - 34)));
                var bodyH = estLines * 18 + 4;
                var rowH = 16 + bodyH + 8;
                var row = new lively.morphic.Box(lively.rect(0, 0, W, rowH));
                row.applyStyle({ fill: null, borderWidth: 0 });
                noDrag(row);
                var avatar = new lively.morphic.Box(lively.rect(0, 2, 20, 20));
                avatar.applyStyle({ fill: Color.rgbHex(self._instanceColor(c.handle || c.did || '')), borderWidth: 0, borderRadius: 10 });
                noDrag(avatar);
                row.addMorph(avatar);
                row.addMorph(textRow(lively.rect(28,0,W-28,14),
                    (c.handle ? '@' + c.handle : '@?') + ' · ' + (c.created_at ? new Date(c.created_at).format('yyyy-mm-dd') : ''),
                    { fontSize: 7.5, textColor: Color.rgb(120,120,120) }));
                var body = textRow(lively.rect(28,16,W-28,bodyH), c.body || '', { fontSize: 9, textColor: Color.rgb(26,26,27) });
                body.applyStyle({ clipMode: 'auto' });
                row.addMorph(body);
                place(row, rowH + 4);
            });
        }

        // Comment input row -- a morphic Text#beInputLine() input (native
        // framework mechanism, not a raw DOM <input>), matching this file's
        // existing searchText precedent rather than a native-DOM-mount.
        var inputRow = new lively.morphic.Box(lively.rect(0, 0, W, 32));
        inputRow.applyStyle({ fill: null, borderWidth: 0 });
        noDrag(inputRow);
        var input = new lively.morphic.Text(lively.rect(0, 4, W - 66, 24), '');
        input.applyStyle({ fixedWidth: true, fixedHeight: true, clipMode: 'hidden', allowInput: true, fontSize: 8.5,
            borderWidth: 1, borderColor: Color.rgb(214,214,214), borderRadius: 6, fill: Color.white });
        inputRow.addMorph(input);
        var postBtn = new lively.morphic.Box(lively.rect(W - 58, 4, 58, 24));
        postBtn.applyStyle({ fill: Color.rgbHex('#e8497e'), borderWidth: 0, borderRadius: 6 });
        noDrag(postBtn);
        postBtn.addMorph(textRow(lively.rect(0,5,58,14), 'Post', { fontSize: 8.5, textColor: Color.white, align: 'center' }));
        postBtn.onMouseUp = function() {
            var text = input.textString;
            input.setTextString('');
            self.postCommentOnSelectedItem(text);
            return true;
        };
        inputRow.addMorph(postBtn);
        place(inputRow, 40);
        input.beInputLine({ fixedWidth: true });
    },

    // ─── inspect ─────────────────────────────────────────────────────────

    // PartInspector is a local WebDAV debugging tool and loads fine
    // regardless of which instance the browsed item's data came from -- it
    // just needs the item's raw JSON, fetched via the same _fetchFullEnvelope
    // every other item action already shares. Unlike the classic browser's
    // own openPartInspectorForSelection (which drives PartInspector's
    // PartsBinCategoryChooser/PartsBinPartItemChooser dropdowns against a
    // real WebDAV PartsSpace), an Inventory item has no such WebDAV path --
    // its partsSpaceName is either '*public*' or another user's identity
    // space, neither of which PartInspector's chooser can ever resolve. So
    // this calls PartInspector's loadFromJSON(json, label, tabName) entry
    // point instead, which skips the chooser entirely and feeds the JSON
    // straight to updateJSON -- see inventory.md §12 for the full writeup of
    // why the old .loadPart(...) call here was dead-on-arrival.
    //
    // A single "Inspect" button (openInspectorMenu, below) fans out to this
    // for all three of PartInspector's non-Overview tabs -- JSON,
    // Serialization Info, Object Graph -- rather than one physical button
    // per tab, which measured live (chrome-devtools MCP) to overflow the
    // right panel's fixed-width button row (originally ItemInfoPanel's
    // MetaContainer column, before the Phase D right-panel rewrite).
    openPartInspectorForSelection: function openPartInspectorForSelection(tabName) {
        tabName = tabName || 'Overview';
        var item = this.selectedItem;
        if (!item) { $world.inform('No item selected.'); return; }
        var self = this;
        this.setStatus('Loading ' + tabName + ' for ' + item.name + '…');
        this._fetchFullEnvelope(item, function(err, envelope) {
            if (err) { self.setStatus('Failed to load item: ' + (err.message || err), true); return; }
            // record.payload is ciphertext for private/shared items -- feeding
            // that into PartInspector's JSON.parse would just fail or produce
            // garbage. Scoped to public items only for now (see inventory.md
            // §12's open question); private/shared is a deliberate follow-up,
            // not an oversight.
            if (envelope.visibility && envelope.visibility !== 'public') {
                self.setStatus('Inspector view only supports public items right now.', true);
                return;
            }
            var payload = envelope.record && envelope.record.payload;
            var json = typeof payload === 'string' ? payload : JSON.stringify(payload);
            var indicatorClose, indicator;
            lively.lang.fun.composeAsync(
                function(n) { Global.require('lively.morphic.tools.LoadingIndicator').toRun(function() { n(); }); },
                function(n) { indicator = lively.morphic.tools.LoadingIndicator.open('loading...', function(close) { indicatorClose = close; n(); }); },
                function(n) { lively.PartsBin.getPart('PartInspector', 'PartsBin/Debugging/', function(err2, inspector) { n(err2, inspector); }); },
                function(inspector, n) {
                    inspector.openInWorldCenter();
                    indicator.bringToFront();
                    inspector.targetMorph.loadFromJSON(json, item.name, tabName);
                    n();
                }
            )(function(err3) {
                indicatorClose && indicatorClose();
                if (err3) { self.setStatus('Failed to open inspector: ' + (err3.message || err3), true); return; }
                self.setStatus('Opened ' + tabName + ' for "' + item.name + '"');
            });
        });
    },

    // Popup menu behind the single "Inspect" button -- keeps the right
    // panel's button row at its existing 3-button width (Open Item / View
    // Source / Inspect) instead of growing to 5 buttons, which measured
    // live to overflow the fixed column width (confirmed via chrome-devtools
    // MCP before choosing this design over more buttons).
    openInspectorMenu: function openInspectorMenu() {
        var item = this.selectedItem;
        if (!item) { $world.inform('No item selected.'); return; }
        var btn = this._inspectButtonMorph;
        var pos = btn ? btn.worldPoint(lively.pt(0, btn.getExtent().y)) : $world.visibleBounds().center();
        var self = this;
        var items = [
            ['JSON', function() { self.openPartInspectorForSelection('JSON'); }],
            ['Serialization Info', function() { self.openPartInspectorForSelection('Serialization Info'); }],
            ['Object Graph', function() { self.openPartInspectorForSelection('Object Graph'); }]
        ];
        lively.morphic.Menu.openAt(pos, 'Inspect "' + item.name + '"', items);
    },

    // ─── opening an item ─────────────────────────────────────────────────

    openSelectedItem: function openSelectedItem() {
        var item = this.selectedItem;
        if (!item) { $world.alert('No item selected'); return; }
        var self = this;
        this.setStatus('Opening ' + item.name + '…');
        this._fetchFullEnvelope(item, function(err, envelope) {
            if (err) { self.setStatus('Failed to load item: ' + (err.message || err), true); return; }
            self._openEnvelope(envelope, item.handle);
        });
    },

    // Extracts and displays the item's embedded addScript/BuildSpec source
    // WITHOUT deserializing/evaling it (lively.persistence.Serializer
    // .scriptSourcesIn walks the raw parsed JSON only) -- lets a part's code
    // be read before it's ever run. Reuses _fetchFullEnvelope, which is a
    // no-op if the thumbnail fetch already pulled the full envelope in.
    viewSourceOfSelectedItem: function viewSourceOfSelectedItem() {
        var item = this.selectedItem;
        if (!item) { $world.alert('No item selected'); return; }
        var self = this;
        this.setStatus('Loading source for ' + item.name + '…');
        this._fetchFullEnvelope(item, function(err, envelope) {
            if (err) { self.setStatus('Failed to load source: ' + (err.message || err), true); return; }
            var payload = envelope.record && envelope.record.payload;
            var json = typeof payload === 'string' ? payload : JSON.stringify(payload);
            lively.require('lively.morphic.tools.ItemSourceViewer').toRun(function() {
                lively.morphic.tools.ItemSourceViewer.open(item.name, json);
                self.setStatus('Opened source for "' + item.name + '"');
            });
        });
    },

    // Pre-loads the item's own class module via lively.require(...) BEFORE
    // deserializing, then polls each named module's actual global namespace
    // value directly rather than trusting lively.module(name).isLoaded() or
    // the toRun callback alone — both were confirmed live (building the old
    // PublicPartsBrowser.js) to sometimes fire/report "loaded" before a
    // class-shaped module has actually finished loading, which produced a
    // broken non-morph "part" (later TypeError on part.comeForward).
    _openEnvelope: function _openEnvelope(envelope, handle) {
        var self = this;
        var state = envelope.state || {};
        var partName = state.partName || envelope.objId;
        var payload = envelope.record && envelope.record.payload;
        var json = typeof payload === 'string' ? payload : JSON.stringify(payload);

        var modules;
        try { modules = lively.persistence.Serializer.sourceModulesIn(JSON.parse(json)); }
        catch (e) { modules = []; }

        lively.require(modules).toRun(function() {
            self._waitForModules(modules, 0, function(err) {
                if (err) { self.setStatus('Failed to load item: ' + err.message, true); return; }

                var item = new lively.identity.IdentityPartItem(partName, '*public*');
                item.envelope = envelope;
                item.handle = handle;

                var metaInfo = new lively.PartsBin.PartsBinMetaInfo();
                metaInfo.partName = partName;
                metaInfo.comment = state.comment || '';
                metaInfo.tags = state.tags || [];
                metaInfo.requiredModules = state.requiredModules || [];
                metaInfo.migrationLevel = state.migrationLevel || 9;
                metaInfo.partsSpaceName = '*public*';
                metaInfo.lastModifiedDate = envelope.created ? new Date(envelope.created) : new Date();
                item.loadedMetaInfo = metaInfo;

                item.loadPart(false, false, null, function(err2, part) {
                    if (err2) { self.setStatus('Failed to load item: ' + (err2.message || err2), true); return; }
                    if (!part || typeof part.openInWorld !== 'function') {
                        self.setStatus('Failed to load item: deserialized object is not a morph', true);
                        return;
                    }
                    var world = self.world();
                    part.openInWorld(world.visibleBounds().center().subPt(part.getExtent().scaleBy(0.5)));
                    if (typeof part.comeForward === 'function') part.comeForward();
                    self.setStatus('Opened "' + partName + '"');
                });
            });
        });
    },

    _waitForModules: function _waitForModules(modules, elapsedMs, cb) {
        var self = this;
        function resolveGlobal(name) {
            var path = name.replace(/^Global\./, '');
            var obj = window;
            var parts = path.split('.');
            for (var i = 0; i < parts.length && obj; i++) obj = obj[parts[i]];
            return obj;
        }
        var pending = modules.filter(function(name) { return !resolveGlobal(name); });
        if (!pending.length) { cb(null); return; }
        if (elapsedMs >= 4000) { cb(new Error('module(s) never finished loading: ' + pending.join(', '))); return; }
        setTimeout(function() { self._waitForModules(modules, elapsedMs + 100, cb); }, 100);
    },

    // ─── collapsible panel toggle (kept simple relative to the classic
    // browser's draggable MoreDivider — this panel is always shown, since
    // an item's info is the primary point of this browser rather than an
    // optional "more" extra) ──────────────────────────────────────────────

    reset: function reset() {}
    }],
    titleBar: "Public Inventory",
    withLayers: "[GrabbingLayer]"
});

// Assign onto the module's own namespace object rather than replacing it —
// module(...) already sets lively.identity.Inventory to point at internal
// bookkeeping BuildSpec's createMorph() reads via
// lively.module(sourceModule).isLoaded(); clobbering it with a plain object
// broke createMorph with "sourceMod.isLoaded is not a function" (same
// gotcha the old PublicPartsBrowser.js already documented).
//
// Wires up the dividers and calls onLoad() explicitly on the named content
// box after creation, rather than relying on Window's own `targetMorph`
// convention the classic PartsBin.js BuildSpec uses (this.targetMorph.onLoad()
// inside onFromBuildSpecCreated) — that convention is populated by the real
// `new lively.morphic.Window(targetMorph, ...)` constructor path, which
// isn't what created this BuildSpec-authored window, so targetMorph isn't
// guaranteed to resolve correctly here. win.get('InventoryBrowser') is the
// same "look the content box up by name" approach the old
// PublicPartsBrowser.js's own .open() already used successfully.
lively.identity.Inventory.open = function(optPos) {
    if ($world.inventoryBrowser) $world.inventoryBrowser.remove();
    var win = lively.BuildSpec('lively.identity.Inventory').createMorph();
    win.openInWorld(optPos || $world.visibleBounds().center().subPt(lively.pt(730, 380)));
    win.comeForward();
    $world.inventoryBrowser = win;
    var browser = win.get('InventoryBrowser');
    win.get('LeftRightDivider').scalingLeft = [win.get('LeftSideContainer')];
    win.get('LeftRightDivider').scalingRight = [win.get('MainContainer')];
    win.get('LeftRightDivider').fixed = [];
    win.get('RightDivider').scalingLeft = [win.get('MainContainer')];
    win.get('RightDivider').scalingRight = [win.get('RightPanel')];
    win.get('RightDivider').fixed = [];
    browser.onLoad();
    return win;
};

}); // end module('lively.identity.Inventory')
