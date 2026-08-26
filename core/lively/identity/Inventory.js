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
    _Extent: lively.pt(820.0,640.0),
    _Position: lively.pt(260.0,140.0),
    _StyleClassNames: ["Morph","Window"],
    cameForward: false,
    className: "lively.morphic.Window",
    contentOffset: lively.pt(4.0,22.0),
    draggingEnabled: true,
    layout: { adjustForNewBounds: true },
    minExtent: lively.pt(560.0,420.0),
    name: "Inventory",
    sourceModule: "lively.identity.Inventory",
    submorphs: [{
        _BorderColor: Color.rgb(95,94,95),
        _Extent: lively.pt(812.0,614.0),
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
        minExtent: lively.pt(460.0,300.0),
        name: "InventoryBrowser",
        selectedItem: null,
        instanceBaseUrl: "",
        categoryName: null,
        cursor: null,
        searchQuery: "",
        sourceModule: "lively.morphic.Core",

        // ─── left sidebar ───────────────────────────────────────────────

        submorphs: [{
            _BorderWidth: 0.7,
            _Extent: lively.pt(150.0,601.0),
            _Fill: Color.rgba(255,255,255,0),
            _Position: lively.pt(6.0,6.0),
            className: "lively.morphic.Box",
            droppingEnabled: false,
            layout: {
                borderSize: 0,
                resizeHeight: true,
                resizeWidth: false,
                spacing: 9,
                type: "lively.morphic.Layout.VerticalLayout"
            },
            name: "LeftSideContainer",
            sourceModule: "lively.morphic.Core",
            submorphs: [{
                // instance chooser — parity with the classic browser's
                // PartsBinURLChooser, but choosing between identity-server
                // instances (config: lively.identity.Inventory.instanceURLs)
                // instead of WebDAV PartsBin roots.
                _ClipMode: "auto",
                _Extent: lively.pt(150.0,17.0),
                _Fill: Color.rgba(243,243,243,0),
                _FontFamily: "Helvetica",
                _FontSize: 10,
                _Position: lively.pt(0.5,5.0),
                _StyleClassNames: ["Morph","Box","OldList","DropDownList"],
                changeTriggered: false,
                className: "lively.morphic.DropDownList",
                droppingEnabled: false,
                layout: {
                    centeredHorizontal: true,
                    centeredVertical: true,
                    moveHorizontal: false,
                    resizeWidth: true
                },
                name: "InstanceChooser",
                selectedLineNo: -1,
                sourceModule: "lively.morphic.Lists",
                submorphs: [],
                withoutLayers: [],
                connectionRebuilder: function connectionRebuilder() {
                    lively.bindings.connect(this, "selection", this.get("InventoryBrowser"), "setInstanceBaseUrl", {});
                }
            },{
                _BorderWidth: 0.15,
                _Extent: lively.pt(150.0,445.0),
                _Fill: Color.rgba(255,255,255,0),
                _Position: lively.pt(0.0,36.0),
                className: "lively.morphic.Box",
                droppingEnabled: false,
                layout: {
                    borderSize: 0,
                    resizeHeight: true,
                    resizeWidth: true,
                    spacing: 0,
                    type: "lively.morphic.Layout.VerticalLayout"
                },
                name: "CategoryListContainer",
                sourceModule: "lively.morphic.Core",
                submorphs: [{
                    // no +/- buttons here (unlike the classic browser's
                    // categoryList row) — "#tag" categories here are
                    // aggregated across every user's public items via
                    // GET /parts/public/tags, not user-creatable from this
                    // read-only cross-user view. Reload is still useful
                    // (picks up newly-published items/tags).
                    _BorderColor: Color.rgb(210,210,210),
                    _Extent: lively.pt(150.0,27.0),
                    _Fill: Color.rgba(255,255,255,0),
                    className: "lively.morphic.Morph",
                    droppingEnabled: false,
                    layout: { adjustForNewBounds: true, resizeWidth: true },
                    sourceModule: "lively.morphic.Core",
                    submorphs: [{
                        _BorderColor: Color.rgb(210,210,210),
                        _Extent: lively.pt(28.0,28.0),
                        _Fill: Color.rgb(204,204,204),
                        _Position: lively.pt(122.0,0.0),
                        _StyleClassNames: ["Morph","Button"],
                        className: "lively.morphic.Button",
                        isPressed: false,
                        label: "⟳",
                        name: "reloadButton",
                        sourceModule: "lively.morphic.Widgets",
                        style: { borderRadius: 0, padding: lively.rect(4,3,0,0) },
                        value: false,
                        withoutLayers: [],
                        connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "reloadEverything", {});
                        }
                    }],
                    withoutLayers: []
                },{
                    _BorderColor: Color.rgb(210,210,210),
                    _ClipMode: { x: "hidden", y: "scroll" },
                    _Extent: lively.pt(150.0,418.0),
                    _Fill: Color.rgb(255,255,255),
                    _Position: lively.pt(0.0,27.0),
                    _StyleClassNames: ["Morph","Box","List"],
                    _StyleSheet: ".List {\n\
                	border-width: 1px;\n\
                }",
                    className: "lively.morphic.List",
                    layout: {
                        adjustForNewBounds: true,
                        extent: lively.pt(150.0,418.0),
                        listItemHeight: 19,
                        maxExtent: lively.pt(150.0,418.0),
                        maxListItems: 22,
                        noOfCandidatesShown: 1,
                        padding: 0,
                        resizeHeight: true,
                        resizeWidth: true
                    },
                    name: "categoryList",
                    sourceModule: "lively.morphic.Lists",
                    submorphs: [],
                    withoutLayers: [],
                    connectionRebuilder: function connectionRebuilder() {
                        lively.bindings.connect(this, "selection", this.get("InventoryBrowser"), "categoryName", {});
                    }
                }],
                withoutLayers: []
            }],
            withoutLayers: []
        },{
            _BorderColor: null,
            _Extent: lively.pt(2.0,601.0),
            _Fill: Color.rgb(204,204,204),
            _Position: lively.pt(160.0,6.0),
            className: "lively.morphic.VerticalDivider",
            draggingEnabled: true,
            droppingEnabled: true,
            fixed: [],
            layout: { resizeHeight: true },
            minWidth: 92,
            name: "LeftRightDivider",
            pointerConnection: null,
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            withoutLayers: []
        },

        // ─── main content ───────────────────────────────────────────────

        {
            // NOTE: deliberately no `type: VerticalLayout` here for
            // arranging MainContentContainer/ItemInfoPanel — a nested
            // VerticalLayout's resizeHeight:true on MainContentContainer
            // was confirmed live to greedily fill this box's ENTIRE height
            // regardless of ItemInfoPanel's own fixed height, pushing the
            // info panel below MainContainer's own (clipMode:hidden)
            // bounds and off-screen entirely. The classic browser
            // (PartsBin.js's CategorieContainer) avoids this exact trap
            // the same way: its two children (CategoryContentContainer,
            // MoreContainer) are explicitly positioned/sized rather than
            // auto-flexed by a shared layout, connected only loosely by a
            // draggable divider. Following that precedent here (minus the
            // drag-to-collapse behavior, which this browser doesn't need
            // since the info panel is always shown): MainContentContainer
            // and ItemInfoPanel below both get explicit _Position/_Extent
            // instead of relying on layout auto-fill for the split.
            _Extent: lively.pt(640.0,601.0),
            _Fill: Color.rgba(255,255,255,0),
            _Position: lively.pt(165.0,6.0),
            _ClipMode: "hidden",
            className: "lively.morphic.Box",
            droppingEnabled: false,
            layout: { adjustForNewBounds: true, resizeHeight: true, resizeWidth: true },
            name: "MainContainer",
            sourceModule: "lively.morphic.Core",
            submorphs: [{
                _Extent: lively.pt(640.0,344.0),
                _Fill: Color.rgba(255,255,255,0),
                className: "lively.morphic.Box",
                droppingEnabled: false,
                layout: {
                    borderSize: 0,
                    resizeWidth: true,
                    spacing: 7,
                    type: "lively.morphic.Layout.VerticalLayout"
                },
                name: "MainContentContainer",
                sourceModule: "lively.morphic.Core",
                submorphs: [
                    lively.BuildSpec('lively.ide.tools.CommandLine').customize({
                        name: "searchText",
                        layout: { adjustForNewBounds: true, resizeHeight: false, resizeWidth: true },
                        _Extent: lively.pt(640,18),
                        labelString: "  ",
                        clearOnInput: false,
                        connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "savedTextString", this.get("InventoryBrowser"), "search", {});
                        }
                    }),
                    {
                    // items grid — same async tile-population mechanics as
                    // the classic browser's partsBinContents box
                    // (addPartItemAsync/startAddingPartItems/adjustForNewBounds),
                    // populated with lively.identity.IdentityPartItem
                    // instances built by hand from /parts/public rows
                    // (there's no owning IdentityPartsSpace for another
                    // user's items — same approach the old
                    // PublicPartsBrowser.js's _openEnvelope already used).
                    _BorderColor: Color.rgb(210,210,210),
                    _ClipMode: "auto",
                    _Extent: lively.pt(640.0,410.0),
                    _Fill: Color.rgb(255,255,255),
                    className: "lively.morphic.Box",
                    droppingEnabled: false,
                    layout: { resizeHeight: true, resizeWidth: true },
                    name: "ItemsGrid",
                    selectedItem: null,
                    sourceModule: "lively.morphic.Core",
                    submorphs: [],
                    withoutLayers: [],
                    addItemAsync: function addItemAsync() {
                        if (!this.itemsToBeAdded || this.itemsToBeAdded.length === 0) {
                            this.stopAddingItemsAsync();
                            return;
                        }
                        var item = this.itemsToBeAdded.shift();
                        var morph = item.asPartsBinItem();
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
                    connectionRebuilder: function connectionRebuilder() {
                        lively.bindings.connect(this, "selectedItem", this.get("InventoryBrowser"), "setSelectedItem", {});
                    },
                    selectPartItem: function selectPartItem(itemMorph) {
                        this.selectedItem = itemMorph && itemMorph.partItem;
                        this.submorphs.without(itemMorph).invoke('showAsNotSelected');
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
                    _Extent: lively.pt(640.0,24.0),
                    _Fill: Color.rgba(255,255,255,0),
                    className: "lively.morphic.Box",
                    droppingEnabled: false,
                    layout: { adjustForNewBounds: true, resizeWidth: true },
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
                        _Extent: lively.pt(300.0,16.0),
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
                withoutLayers: []
            },

            // ─── collapsible info panel ───────────────────────────────

            {
                _BorderColor: Color.rgb(204,204,204),
                _ClipMode: "hidden",
                _Extent: lively.pt(640.0,250.0),
                _Fill: Color.rgba(204,204,204,0),
                _Position: lively.pt(0.0,351.0),
                _StyleClassNames: ["Morph","Box"],
                _StyleSheet: " {\n\
            	border-width: 9px;\n\
            }",
                _Visible: true,
                className: "lively.morphic.Box",
                droppingEnabled: false,
                layout: {
                    borderSize: 0,
                    resizeWidth: true,
                    spacing: 7,
                    type: "lively.morphic.Layout.VerticalLayout"
                },
                name: "ItemInfoPanel",
                sourceModule: "lively.morphic.Core",
                submorphs: [{
                    _Extent: lively.pt(640.0,27.0),
                    _Fill: Color.rgba(255,255,255,0),
                    className: "lively.morphic.Box",
                    droppingEnabled: false,
                    layout: {
                        adjustForNewBounds: true,
                        borderSize: 0,
                        resizeHeight: false,
                        resizeWidth: true,
                        spacing: 6,
                        type: "lively.morphic.Layout.HorizontalLayout"
                    },
                    name: "ItemInfoTitleContainer",
                    sourceModule: "lively.morphic.Core",
                    submorphs: [{
                        _ClipMode: "hidden",
                        _Extent: lively.pt(320.0,27.0),
                        _FontFamily: "Arial, sans-serif",
                        _FontSize: 14,
                        _InputAllowed: false,
                        _Position: lively.pt(9.0,0.0),
                        _TextColor: Color.rgb(64,64,64),
                        allowInput: false,
                        className: "lively.morphic.Text",
                        eventsAreIgnored: true,
                        fixedHeight: true,
                        fixedWidth: true,
                        layout: { centeredVertical: true, resizeHeight: true, resizeWidth: true },
                        name: "selectedItemName",
                        sourceModule: "lively.morphic.TextCore",
                        submorphs: [],
                        withoutLayers: []
                    },{
                        _Extent: lively.pt(70.0,15.0),
                        _FontFamily: "Arial, sans-serif",
                        _FontSize: 9,
                        _Position: lively.pt(340.0,6.0),
                        _TextColor: Color.rgb(64,64,64),
                        className: "lively.morphic.Text",
                        fixedWidth: true,
                        layout: { centeredVertical: true, moveHorizontal: true, resizeHeight: false },
                        name: "shareLink",
                        sourceModule: "lively.morphic.TextCore",
                        submorphs: [],
                        textString: "",
                        withoutLayers: []
                    },{
                        _Position: lively.pt(415.0,6.0),
                        _Extent: lively.pt(50.0,15.0),
                        _InputAllowed: false,
                        _FontFamily: "Arial, sans-serif",
                        _FontSize: 9,
                        className: "lively.morphic.Text",
                        fixedWidth: true,
                        grabbingEnabled: false,
                        layout: { centeredVertical: true, moveHorizontal: true, resizeHeight: false },
                        name: "inspectLabel",
                        textString: ""
                    }],
                    withoutLayers: []
                },{
                    _Extent: lively.pt(640.0,190.0),
                    _Fill: Color.rgba(255,255,255,0),
                    className: "lively.morphic.Box",
                    droppingEnabled: false,
                    layout: {
                        borderSize: 0,
                        resizeHeight: true,
                        resizeWidth: true,
                        spacing: 0,
                        type: "lively.morphic.Layout.HorizontalLayout"
                    },
                    name: "ItemInfoContentContainer",
                    sourceModule: "lively.morphic.Core",
                    submorphs: [{
                        _Extent: lively.pt(320.0,190.0),
                        _Fill: Color.rgba(255,255,255,0),
                        className: "lively.morphic.Box",
                        droppingEnabled: false,
                        layout: {
                            borderSize: 0,
                            resizeHeight: true,
                            resizeWidth: true,
                            spacing: 4,
                            type: "lively.morphic.Layout.VerticalLayout"
                        },
                        name: "MetaContainer",
                        sourceModule: "lively.morphic.Core",
                        submorphs: [{
                            _BorderColor: Color.rgba(255,255,255,0),
                            _BorderWidth: 8,
                            _ClipMode: "auto",
                            _Extent: lively.pt(320.0,80.0),
                            _Fill: Color.rgba(255,255,255,0),
                            _FontFamily: "Arial, sans-serif",
                            _FontSize: 9,
                            _InputAllowed: false,
                            _TextColor: Color.rgb(120,120,120),
                            allowInput: false,
                            className: "lively.morphic.Text",
                            eventsAreIgnored: true,
                            fixedHeight: true,
                            fixedWidth: true,
                            layout: { resizeHeight: true, resizeWidth: true },
                            // Published by / Created / Object ID+DID / Hosting —
                            // see InventoryBrowser.describeItemMeta below. Hosting
                            // reflects whichever instance is currently selected
                            // in InstanceChooser, unlike the classic browser's
                            // always-local Hosting line.
                            name: "selectedItemMeta",
                            sourceModule: "lively.morphic.TextCore",
                            submorphs: [],
                            withoutLayers: []
                        },{
                            // read-only — unlike the classic browser's editable
                            // comment field, this isn't the viewer's own item.
                            _BorderColor: Color.rgba(255,255,255,0),
                            _BorderWidth: 8,
                            _ClipMode: "auto",
                            _Extent: lively.pt(320.0,60.0),
                            _Fill: Color.rgb(255,255,255),
                            _FontFamily: "Arial, sans-serif",
                            _InputAllowed: false,
                            _TextColor: Color.rgb(64,64,64),
                            allowInput: false,
                            className: "lively.morphic.Text",
                            eventsAreIgnored: true,
                            fixedHeight: true,
                            fixedWidth: true,
                            layout: { resizeHeight: true, resizeWidth: true },
                            name: "selectedItemComment",
                            sourceModule: "lively.morphic.TextCore",
                            submorphs: [],
                            withoutLayers: []
                        },{
                            _Extent: lively.pt(320.0,28.0),
                            _Fill: Color.rgba(255,255,255,0),
                            className: "lively.morphic.Box",
                            droppingEnabled: false,
                            layout: { borderSize: 0, resizeHeight: false, resizeWidth: true, spacing: 4, type: "lively.morphic.Layout.HorizontalLayout" },
                            name: "ButtonLineMorph",
                            sourceModule: "lively.morphic.Core",
                            submorphs: [{
                                _BorderColor: Color.rgb(255,255,255),
                                _Extent: lively.pt(90.0,28.0),
                                _Fill: Color.rgb(204,204,204),
                                _StyleClassNames: ["Morph","Button","disabled"],
                                className: "lively.morphic.Button",
                                isActive: false,
                                isPressed: false,
                                label: "Open Item",
                                name: "openItemButton",
                                padding: lively.rect(5,0,0,0),
                                sourceModule: "lively.morphic.Widgets",
                                style: { borderRadius: 0 },
                                withoutLayers: [],
                                connectionRebuilder: function connectionRebuilder() {
                                    lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "openSelectedItem", {});
                                }
                            }],
                            withoutLayers: [],
                            activateButtons: function activateButtons(bool) {
                                this.submorphs.invoke('setActive', !!bool)
                            }
                        }],
                        withoutLayers: []
                    },{
                        _BorderColor: null,
                        _Extent: lively.pt(2.0,190.0),
                        _Fill: Color.rgb(204,204,204),
                        className: "lively.morphic.VerticalDivider",
                        draggingEnabled: true,
                        droppingEnabled: true,
                        fixed: [],
                        layout: { resizeHeight: true },
                        minWidth: 59,
                        name: "VersionDivider",
                        pointerConnection: null,
                        sourceModule: "lively.morphic.Widgets",
                        submorphs: [],
                        withoutLayers: []
                    },{
                        _Extent: lively.pt(310.0,190.0),
                        _Fill: Color.rgba(255,255,255,0),
                        className: "lively.morphic.Box",
                        droppingEnabled: false,
                        layout: { borderSize: 0, resizeHeight: true, resizeWidth: false, spacing: 4, type: "lively.morphic.Layout.VerticalLayout" },
                        name: "VersionsContainer",
                        sourceModule: "lively.morphic.Core",
                        submorphs: [{
                            _Extent: lively.pt(300.0,20.0),
                            _FontFamily: "Arial, sans-serif",
                            _FontSize: 10,
                            _InputAllowed: false,
                            className: "lively.morphic.Text",
                            eventsAreIgnored: true,
                            fixedWidth: true,
                            name: "versionsLabel",
                            sourceModule: "lively.morphic.TextCore",
                            submorphs: [],
                            textColor: Color.rgb(120,120,120),
                            textString: "Version history"
                        },{
                            _BorderColor: Color.rgb(203,203,203),
                            _BorderWidth: 1,
                            _ClipMode: { x: "hidden", y: "scroll" },
                            _Extent: lively.pt(300.0,160.0),
                            _Fill: Color.rgb(255,255,255),
                            className: "lively.morphic.List",
                            droppingEnabled: false,
                            itemList: [],
                            layout: { resizeWidth: true, resizeHeight: true },
                            name: "selectedItemVersions",
                            sourceModule: "lively.morphic.Lists",
                            submorphs: []
                        }],
                        withoutLayers: []
                    }],
                    withoutLayers: []
                }],
                withoutLayers: []
            }],
            withoutLayers: []
        }],
        withoutLayers: [],

        // ─── loading ────────────────────────────────────────────────────────

    onLoad: function onLoad() {
        this.get('InstanceChooser').setList(this.getKnownInstanceLabels());
        this.get('InstanceChooser').selectAt(0);
        this.get('searchText').setTextString('');
        this.reloadEverything();
    },

    onWindowGetsFocus: function onWindowGetsFocus() {
        this.get('searchText').focus();
    },

    reloadEverything: function reloadEverything() {
        this.cursor = null;
        this.get('ItemsGrid').removeAllItems();
        this.setSelectedItem(null);
        this.loadCategories();
    },

    // ─── instances ──────────────────────────────────────────────────────

    getKnownInstanceLabels: function getKnownInstanceLabels() {
        var extra = (typeof lively !== 'undefined' && lively.Config &&
            lively.Config.get('instanceURLs', true)) || [];
        return ['This instance'].concat(extra);
    },

    setInstanceBaseUrl: function setInstanceBaseUrl(label) {
        var isLocal = !label || label === 'This instance';
        this.instanceBaseUrl = isLocal ? (window.location.origin) : label.replace(/\/$/, '');
        this.reloadEverything();
    },

    isCrossOrigin: function isCrossOrigin() {
        return !!this.instanceBaseUrl && this.instanceBaseUrl !== window.location.origin;
    },

    // ─── categories (tags aggregated across every user's public items) ────

    loadCategories: function loadCategories() {
        var self = this;
        var list = this.get('categoryList');
        var base = this.instanceBaseUrl || window.location.origin;
        list.updateList([{ isListItem: true, string: 'Recent', value: 'recent' }]);
        list.setSelection('recent');
        this._fetchJson(base + '/parts/public/tags', function(err, body) {
            if (err || !body || !body.tags) return;
            // Stale-instance guard: if the user switched InstanceChooser
            // again while this was in flight, don't clobber the newer
            // selection's categories with a late response from the old one.
            if (self.instanceBaseUrl !== base && base !== (window.location.origin)) return;
            var items = [{ isListItem: true, string: 'Recent', value: 'recent' }].concat(
                body.tags.map(function(t) {
                    return { isListItem: true, string: '#' + t.tag + ' (' + t.count + ')', value: '#' + t.tag };
                })
            );
            var currentSelection = self.categoryName;
            list.updateList(items);
            list.setSelection(currentSelection || 'recent');
        });
    },

    // ─── loading items ──────────────────────────────────────────────────

    connectionRebuilder: function connectionRebuilder() {
        lively.bindings.connect(this, "categoryName", this, "loadItemsForCurrentCategory", {});
    },

    loadItemsForCurrentCategory: function loadItemsForCurrentCategory() {
        this.cursor = null;
        this.searchQuery = '';
        this.get('searchText').setTextString('');
        this._loadItemsPage(false);
    },

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
        var self = this;
        var base = this.instanceBaseUrl || window.location.origin;
        var params = ['limit=24'];
        if (this.cursor && append) params.push('cursor=' + encodeURIComponent(this.cursor));
        if (this.searchQuery) params.push('q=' + encodeURIComponent(this.searchQuery));
        else if (this.categoryName && this.categoryName.charAt(0) === '#') {
            params.push('tag=' + encodeURIComponent(this.categoryName.slice(1)));
        }
        this.setStatus('Loading…');
        this._fetchJson(base + '/parts/public?' + params.join('&'), function(err, body) {
            if (err || !body || !body.parts) { self.setStatus('Load failed', true); return; }
            if (!append) self.get('ItemsGrid').removeAllItems();
            var items = body.parts.map(function(row) { return self._buildItemFromListingRow(row, base); });
            self.get('ItemsGrid').startAddingItems(items);
            self.cursor = body.cursor;
            self.get('loadMoreButton').setVisible(!!self.cursor);
            self.setStatus((append ? 'Loaded ' : '') + body.parts.length + ' item' + (body.parts.length === 1 ? '' : 's') +
                (self.cursor ? ' (more available)' : ''));
        });
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

    // ─── selection / info panel ─────────────────────────────────────────

    setSelectedItem: function setSelectedItem(item) {
        this.selectedItem = item;
        this.get('openItemButton').setActive(!!item);
        if (!item) {
            this.get('selectedItemName').textString = '';
            this.get('selectedItemMeta').textString = '';
            this.get('selectedItemComment').textString = '';
            this.get('selectedItemVersions').updateList([]);
            this.setShareLink(null);
            return;
        }
        this.get('selectedItemName').textString = item.name;
        this.get('selectedItemComment').textString =
            (item.loadedMetaInfo && item.loadedMetaInfo.comment) || 'No comment';
        this.renderItemMeta(item);
        this.setShareLink(item);

        var self = this;
        this.get('selectedItemVersions').updateList([{ isListItem: true, string: 'Loading versions…', value: null }]);
        item.loadPartVersions();
        // loadPartVersions is a plain synchronous-looking call whose XHR
        // resolves later and just assigns item.partVersions once (no
        // incremental streaming the way the classic browser's WebDAV
        // metaInfo connect had to handle) — poll briefly rather than wiring
        // a lively.bindings connect for a single one-shot value.
        var waited = 0;
        (function poll() {
            if (self.selectedItem !== item) return; // selection moved on
            if (item.partVersions) {
                self.get('selectedItemVersions').updateList(
                    (item.partVersions.length ? item.partVersions : [{ date: null, author: null }]).map(function(v) {
                        if (!v.date) return { isListItem: true, string: 'No version history', value: null };
                        var formattedDate = new Date(v.date).format('yyyy-mm-dd HH:MM');
                        return { isListItem: true, string: formattedDate + ' ' + v.author, value: v };
                    })
                );
                return;
            }
            waited += 150;
            if (waited > 4000) { self.get('selectedItemVersions').updateList([]); return; }
            setTimeout(poll, 150);
        })();
    },

    describeItemMeta: function describeItemMeta(item) {
        if (!item || !item.envelope) return null;
        var env = item.envelope;
        var created = env.created ? new Date(env.created).format('yyyy-mm-dd HH:MM') : 'unknown';
        var did = env.did || 'unknown';
        var didShort = did.length > 30 ? (did.slice(0, 20) + '…' + did.slice(-6)) : did;
        var iconGlyph = '⧉';
        var line1 = 'Published by: @' + (item.handle || '?');
        var line2 = 'Created: ' + created;
        var didLinePrefix = 'Object ID: ' + (env.objId || 'unknown') + '   Author DID: ' + didShort + ' ';
        var didLine = didLinePrefix + iconGlyph;
        var hostingUrl = item._instanceBaseUrl || window.location.origin;
        var hostingHost = hostingUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'unknown';
        var line4 = 'Hosting: ' + hostingHost;
        var text = [line1, line2, didLine, line4].join('\n');
        var iconStart = line1.length + 1 + line2.length + 1 + didLinePrefix.length;
        var iconEnd = iconStart + iconGlyph.length;
        return { text: text, did: env.did || null, iconStart: iconStart, iconEnd: iconEnd };
    },

    renderItemMeta: function renderItemMeta(item) {
        var metaMorph = this.get('selectedItemMeta');
        var meta = this.describeItemMeta(item);
        metaMorph.textString = meta ? meta.text : '';
        metaMorph._copyAuthorDid = meta ? meta.did : null;
        if (!meta) return;
        metaMorph.emphasize({
            color: Color.blue,
            doit: {
                code: "var m = evt.getTargetMorph();" +
                    "if (!m._copyAuthorDid || !navigator.clipboard) return;" +
                    "navigator.clipboard.writeText(m._copyAuthorDid);",
                context: null
            }
        }, meta.iconStart, meta.iconEnd);
    },

    setShareLink: function setShareLink(item) {
        var linkText = this.get('shareLink');
        if (!item || !item.envelope || !item.envelope.objId) {
            linkText.setTextString('');
            return;
        }
        linkText.setTextString('Share Link');
        var base = item._instanceBaseUrl || window.location.origin;
        var url = base + '/@' + (item.handle || '_') + '/parts/' + item.envelope.objId;
        linkText._shareUrl = url;
        linkText.emphasizeAll({
            color: Color.blue,
            doit: {
                code: "var m = evt.getTargetMorph();" +
                    "if (!m._shareUrl || !navigator.clipboard) return;" +
                    "navigator.clipboard.writeText(m._shareUrl);" +
                    "m.setTextString('Copied!');" +
                    "var ib = m.get('InventoryBrowser');" +
                    "setTimeout(function() { ib ? ib.setShareLink(ib.selectedItem) : m.setTextString('Share Link'); }, 1200);",
                context: null
            }
        });
    },

    // ─── inspect ─────────────────────────────────────────────────────────

    // Same pattern as the classic browser's openPartInspectorForSelection —
    // PartInspector is a local WebDAV debugging tool and loads fine
    // regardless of which instance the browsed item's data came from.
    openPartInspectorForSelection: function openPartInspectorForSelection() {
        var item = this.get('InventoryBrowser').selectedItem;
        if (!item) { $world.inform('No item selected.'); return; }
        var indicatorClose, indicator;
        lively.lang.fun.composeAsync(
            function(n) { Global.require('lively.morphic.tools.LoadingIndicator').toRun(function() { n(); }); },
            function(n) { indicator = lively.morphic.tools.LoadingIndicator.open('loading...', function(close) { indicatorClose = close; n(); }); },
            function(n) { lively.PartsBin.getPart('PartInspector', 'PartsBin/Debugging/', function(err, inspector) { n(err, inspector); }); },
            function(inspector, n) {
                inspector.openInWorldCenter();
                indicator.bringToFront();
                inspector.targetMorph.loadPart(item.name, item.partsSpaceName, n);
            }
        )(function(err) { indicatorClose && indicatorClose(); });
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
    win.openInWorld(optPos || $world.visibleBounds().center().subPt(lively.pt(410, 260)));
    win.comeForward();
    $world.inventoryBrowser = win;
    var browser = win.get('InventoryBrowser');
    win.get('LeftRightDivider').scalingLeft = [win.get('LeftSideContainer')];
    win.get('LeftRightDivider').scalingRight = [win.get('MainContainer')];
    win.get('LeftRightDivider').fixed = [];
    win.get('VersionDivider').scalingLeft = [win.get('MetaContainer')];
    win.get('VersionDivider').scalingRight = [win.get('VersionsContainer')];
    browser.onLoad();
    return win;
};

}); // end module('lively.identity.Inventory')
