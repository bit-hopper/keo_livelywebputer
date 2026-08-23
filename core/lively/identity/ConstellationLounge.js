/**
 * lively.identity.ConstellationLounge
 *
 * The fixed-layout landing page at /c/:name (ConstellationDesignSpec.md's
 * "space", reframed as a lounge/main-feed UI rather than the freeform
 * drag/place world — that world now lives at /c/:name/canvas,
 * ConstellationCanvas.js). A visitor to /c/:name sees:
 *
 *   - a search field (top, horizontally centered across the full page width
 *     as its own row, styled after PartsBin/iPadWidgets/SearchField.json
 *     — white rounded pill, magnifying-glass icon, blue "Go" button, same
 *     embedded icon asset), searching this constellation's postcard titles
 *     (server-side, via GET /c/:name/feed?q=)
 *   - a quick-info panel (name, visibility, member count, created date,
 *     co-creator) beside the postcard reel, below the search row, at a
 *     fixed size (not derived from the viewport)
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
 *   - the wiki no longer embeds here — it's its own real Lively world at
 *     /c/:name/wiki (WikiIndex.js), reached via the "Open wiki" entry in
 *     this controller's own membership dropdown (_openMembershipMenu)
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
 * inspectable, the way everything else in this codebase is. The postcard
 * embed slots were already lively.morphic.Box morphs; this revision
 * brings the rest of the chrome (search, quick-info, nav, reply thread,
 * member list) in line with that, and only the front card
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
    "lively.identity.PostCardUtils",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    // Same embedded icon asset as PartsBin/iPadWidgets/SearchField.json's
    // magnifying-glass image morph, reused verbatim so the rebuilt search
    // field is visually identical, not just similar.
    var SEARCH_ICON_DATA_URL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAACxMAAAsTAQCanBgAAAPbSURBVEhLrVVdTxtXED13d/0RB+zFFCp4KkI1ThBCAgGVIhHUP8D/5SXqI1F5AFUVJHwEEihfsTFQY+/X7Zm5XpP0Ode68mrv3JkzZ87MmvPrr3b0RQWVchl+gOGyFkgzC88zMAbIbKZnnvFg+dNnGFgx5DJixJWmKXzfh1cLX6JQNPB8iyTJkLn76ix3ml8cOqHDfIlDeZ/xouzh+8Sm1vCF53mMJgh99Hp9tFotXN/c4O7uTs+q1SomJiYwNjaGSqWs9+3g3nOez08ms7F18T3drdYdjo6OcHh4iKvra8RxrKkFQYB6vY7Z2Vk0XzUQ1kJkTFuWnOfZ5NmZOO1ZnzyCWfT6Kd6//xMHBwfK2U9EODk5qZduiP7q6grFYhFzc3NYWFhAdfSlUie0DShWOiRDIo6I2Gj0k09f8O7dH4iiCMvLy/hlZkYpEMNOp4PT01Nsb28rwo2NDTTnGq6wdE4T1ijRzDR/A6ahnHtKwe3tLX5tNPB6fh5hGKJcLhJlgFqtpkgXFxfVRoIkaTbQR17w56IyjsjH7fPzf5SCGSIdGamoQ1GKFFWeR5n69PQ0SqWSOg4C3qPaBG0UJZpJvqRiDjpPHx8fSYpPdGOu6rxkqFuRXb7Gx8fVQbfb1aBChdhJ4G+XJ/IWtGIR1uoa4OHhgSj/XxQRv1UahEuRne87XEni1CGFy9UxRCw0T/w8iThNsL+/j/v7BzVWRFIg7qcoxt8HH5Qu0bQsCeYHPrv0e57VcWakCBbNZgNTU1M4OTnB3t4ezs4umHKfMkxwcXGJnZ0dPZOiNpvNAYWu5YVnyTbvPsrN2oSyEBRplNLhX9jd3VXJSbriRNBKJ7bbba3DNDPb3NzkWXVAgfBsEfiGXdujksqiY2vTfKgw5273CcfHn9h5H7QLW50WkThFVKshLi8vdND8trKKpaUl1W2h4LsZQ0/aHARpUptZo9V/nlS9fozOfRtf2x0i6LJIBRRKASVYpeNLbZL+Uw+rq6tYW1tDgRxz5Eib0VYUpJ1ndVZYsm8GVdaikB5JzzKgG5UMzt0hFV/OPmNra0vVsbKygt/frrvK0T5JImZQ0snDNBKHmM7T2G1jPQScdIHoWG1UlKiNjGC++Qrrb9YRjobwaMfrSFXTBEHaVE1RltoCL3/Xmy6+A+GAOMTyL9JLGIRNdvjxmIOqzmEU6kzPZ4Y6/jeO7QsWQIaQR1RGdJO3kwxwYUy1JIJ2fLBGkoM6cpzKePsGjchPqqoFZSsbmUySrwqT//KJCQY3xJt+hpiy2rBQnBXkQp3mszl3b1gg99H6wWvY0j/YL/4DF1XopJQ13lsAAAAASUVORK5CYII=";

    // Every panel below is a fixed pixel size (not derived from
    // window.innerWidth/innerHeight) per the reference layout — sized off
    // live-inspected morph extents (postcard pt(604.7, 367.3), comment
    // section pt(580.7, 574.0), about panel pt(973.7, 306.0), rounded here),
    // not computed to fill whatever room happens to be left.
    var CARD_W = 650, CARD_H = 395;
    // Comment section's outer box is set to CARD_W minus its own left/right
    // CSS padding (THREAD_PAD_Y_X below) so the *rendered* box — padding is
    // real box-model padding on a content-box element, so it adds to the
    // visible width on top of whatever extent is set — ends up exactly
    // CARD_W wide, same left edge (both start at GUTTER), matching the
    // postcard above it. Confirmed live: without this adjustment the
    // rendered box measured ~23px wider than the postcard.
    var THREAD_PAD_X = 12, THREAD_PAD_Y = 10;   // must match the "10px 12px" set on the container below
    var THREAD_W = CARD_W - THREAD_PAD_X * 2;   // comment section
    // THREAD_H_MAX/MIN are *rendered* (visible, padding-included) height
    // targets — _layout derives the actual extent to set by subtracting
    // THREAD_PAD_Y*2 from whichever of these applies, same padding
    // compensation as THREAD_W above.
    var THREAD_H_MAX = 574;
    var THREAD_H_MIN = 200;    // floor so a very short viewport still gets a usable (internally-scrolling) thread box
    // QUICK_INFO_H has 60px more headroom than the about panel's own
    // content strictly needs, reserved for the event card below — a long
    // event title wrapped onto a second line needs that extra vertical
    // room to avoid the avatar row/"+N Others" label getting pushed past
    // the card's own bottom edge and clipped there (confirmed live with a
    // real 45-character title: without this, height ~131px needed but
    // only ~98px was available).
    var QUICK_INFO_W = 974, QUICK_INFO_H = 366;   // about panel
    var MEMBERS_W = 220;       // outer slot width
    var GUTTER = 20;           // column gutter, also the gap before the members column and the page's right edge
    var BOTTOM_MARGIN = 20;    // space left below the comment thread before the viewport's bottom edge
    var TOP = 56;              // top margin below the menu bar
    var SEARCH_W = 490, SEARCH_H = 45;
    var NAV_H = 40;
    var ROW_GAP = 16;

    // "Sort by" placeholder dropdown, sitting in the gap between the
    // postcard's top-right corner and the search box's left edge.
    var SORT_W = 110, SORT_H = SEARCH_H;   // same height as the search box, same row
    var SORT_ITEM_H = 32;
    var SORT_OPTIONS = ["Best", "Hot", "New", "Top", "Rising"];

    // "+ Postcard" — opens a new PostCardEditor compose window, preset to
    // post into this constellation. Sits left of the members list, top
    // edge aligned with the search box's top edge, but shorter than the
    // search box itself — height hugs the label the same way width does.
    var CREATE_BTN_W = 150, CREATE_BTN_H = 34;

    // Comment thread (Reddit-style, no votes) geometry/palette.
    var COMMENT_INDENT = 30;   // px per nesting depth
    var COMMENT_AVATAR = 22;   // px, square
    // Left/right inset for the whole thread's content — same fix as the
    // members panel: the container's CSS padding doesn't actually offset
    // Lively's absolutely-positioned submorphs (confirmed live), so the
    // margin has to be baked into every x/width passed to the render
    // functions below instead.
    var COMMENT_PAD_X = 10;
    var COMMENT_TOP_MARGIN = 12;   // small gap above the top ("Start conversation") composer, which otherwise sits flush against the container's top edge
    var THREAD_LINE_COLOR = Color.rgb(224, 227, 230);
    var COMMENT_META_COLOR = Color.rgb(120, 120, 120);
    var COMMENT_ACCENT = "#e8497e";  // same pink accent as lively.commerce.Shop's --color-accent

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

        this._threadRootObjId = null;
        this._threadReplies = [];
        this._threadChildrenCache = {};
        this._threadExpanded = {};
        this._replyBoxOpenFor = null;   // objId of the comment whose inline reply box is open, "ROOT" for the top composer, or null
        this._draftText = {};           // same keys as above -> in-progress composer text, kept across re-renders
        this._draftAttachment = {};     // same keys -> {uploading:true} while in flight, else {kind, url, name, entry}
        this._didHandleCache = {};      // did -> handle, for authors not already in quickInfo.memberHandles
        this._bodyBoxCache = {};        // reply.objId -> {box, html, width, height} — see _renderCommentNode
        this._threadRerenderTimer = null;

        this._frontCardBox = null;
        this._backCardBox = null;

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
        // Right column (the about panel) starts one gutter past the
        // postcard's fixed right edge, not a separate "outer slot" constant
        // — the postcard's own width is now the thing that determines it.
        var rightColX = GUTTER + CARD_W + GUTTER;
        // GUTTER-width margin on the right too, matching every other
        // column gap instead of running the members list flush to the edge.
        var membersX = W - MEMBERS_W - GUTTER;
        // Postcard's top edge lines up with the search box's top edge —
        // both start at TOP — rather than sitting a row below it.
        var reelY = TOP;
        // About panel stays below the search row (its own row, not sharing
        // reelY any more) — otherwise it'd sit in the same band as the now
        // top-aligned postcard and cover the search box entirely, since
        // its column overlaps the search box's centered position.
        var quickInfoY = TOP + SEARCH_H + ROW_GAP;
        var threadY = reelY + CARD_H + NAV_H;
        // Rendered (visible) height comes from whatever room is actually
        // left in the viewport below the thread's top edge (minus
        // BOTTOM_MARGIN), capped at THREAD_H_MAX rather than always
        // claiming it — the container's own overflowY:auto (see
        // _buildChrome) scrolls whatever content doesn't fit, so shrinking
        // the box on a short viewport is safe.
        var threadRenderedH = Math.min(THREAD_H_MAX, Math.max(THREAD_H_MIN, H - threadY - BOTTOM_MARGIN));
        // The extent actually passed to setExtent has to be smaller than
        // that by the container's own vertical CSS padding (THREAD_PAD_Y
        // top+bottom) — same box-model correction as THREAD_W, confirmed
        // live: without it the rendered box came out 20px taller than
        // requested and swallowed the whole bottom margin.
        var threadH = threadRenderedH - THREAD_PAD_Y * 2;

        // Nudged right of dead-center, as its own hero row across the full
        // page width, above the reel/quick-info columns rather than
        // tucked beside them.
        var searchX = (W - SEARCH_W) / 2 + 100;
        // "+ Postcard" sits centered in the horizontal gap between the
        // search box's right edge and the members column's left edge,
        // rather than pinned to either one — width comes from
        // _fitCreatePostcardButton once known, not the guessed constant.
        var createBtnW = this._createBtnW || CREATE_BTN_W;
        var createGapStart = searchX + SEARCH_W;
        var createGapEnd = membersX;
        var createBtnX = createGapStart + (createGapEnd - createGapStart - createBtnW) / 2;

        var g = this._geom = {
          searchX: searchX, searchY: TOP,
          // Sits in the gap between the postcard's top-right corner and the
          // search box's left edge, same row.
          sortByX: searchX - GUTTER - SORT_W, sortByY: TOP,
          // Sits beside the postcard, below the search row.
          quickInfoX: rightColX, quickInfoY: quickInfoY, quickInfoW: QUICK_INFO_W, quickInfoH: QUICK_INFO_H,
          reelX: GUTTER, reelY: reelY,
          navX: GUTTER, navY: reelY + CARD_H + 6,
          threadX: GUTTER, threadY: threadY, threadW: THREAD_W, threadH: threadH,
          membersX: membersX, membersY: TOP, membersW: MEMBERS_W, membersH: Math.max(120, H - TOP),
          createBtnX: createBtnX, createBtnY: TOP,
        };

        if (this._searchBox) this._searchBox.setPosition(lively.pt(g.searchX, g.searchY));
        if (this._sortByBox) this._sortByBox.setPosition(lively.pt(g.sortByX, g.sortByY));
        if (this._createPostcardBtn) this._createPostcardBtn.setPosition(lively.pt(g.createBtnX, g.createBtnY));
        if (this._sortByDropdown) {
          this._sortByDropdown.setPosition(lively.pt(g.sortByX, g.sortByY + SORT_H + 4));
        }
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

        this._ensureCommentBodyStyle();

        this._searchBox = this._buildSearchField();
        $world.addMorph(this._searchBox);
        this._styleSearchGoButton();

        this._sortSelection = SORT_OPTIONS[0];
        this._sortByBox = this._buildSortByButton();
        $world.addMorph(this._sortByBox);

        this._createPostcardBtn = this._buildCreatePostcardButton();
        $world.addMorph(this._createPostcardBtn);
        this._createPostcardBtn.setVisible(!!this._canWrite);
        this._fitCreatePostcardButton();

        this._quickInfoBox = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        this._quickInfoBox.setFill(Color.white);
        // clipMode hidden so the banner/avatar section _renderQuickInfo adds
        // (a full-width banner flush against the box's top edge) gets
        // clipped to this box's own rounded corners automatically, instead
        // of needing separate per-corner radii on the banner morph itself.
        this._quickInfoBox.applyStyle({ borderWidth: 1, borderColor: Color.rgb(238, 238, 238), borderRadius: 8, clipMode: "hidden" });
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
        this._threadContainer.renderContext().shapeNode.style.padding = "10px " + THREAD_PAD_X + "px";
        this._threadContainer.renderContext().shapeNode.classList.add("lounge-comment-thread");
        $world.addMorph(this._threadContainer);

        this._membersBox = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        this._membersBox.setFill(Color.white);
        // Same panel treatment as the about/comment boxes (border,
        // radius) instead of the plain left-border-only strip it had before.
        this._membersBox.applyStyle({ borderWidth: 1, borderColor: Color.rgb(238, 238, 238), borderRadius: 8 });
        this._membersBox.renderContext().shapeNode.style.overflowY = "auto";
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
          this._searchBox, this._sortByBox, this._createPostcardBtn, this._quickInfoBox,
          this._backCardBox, this._frontCardBox,
          this._navBox, this._threadContainer, this._membersBox,
        ].forEach(this._disableDragging, this);

        this._layout();
      },

      _disableDragging: function (morph) {
        if (!morph) return;
        morph.disableDragging();
        morph.disableGrabbing();
        (morph.submorphs || []).forEach(this._disableDragging, this);
      },

      // Comment bodies are rendered as raw HTML (reusing postCardUtils.
      // snapshotToHtml, same as PostCardView.js's own content area — see
      // the "thread" section below) inside a Box morph's shapeNode, so they
      // need the same kind of one-time stylesheet PostCardUtils.js's own
      // _ensureMediaStyle already injects for postcard media — just scoped
      // to tightening <p> margins for a compact comment list instead.
      _ensureCommentBodyStyle: function () {
        if (document.getElementById("lounge-comment-body-style")) return;
        var styleEl = document.createElement("style");
        styleEl.id = "lounge-comment-body-style";
        styleEl.textContent =
          ".lounge-comment-body{font-size:12.5px;line-height:1.45;color:#1a1a1b;}" +
          ".lounge-comment-body p{margin:0 0 6px;}" +
          ".lounge-comment-body p:last-child{margin-bottom:0;}" +
          // Same pill-thumb scrollbar treatment as lively.commerce.Shop's
          // .lk-shop-root, recolored for this panel's white (not pink-tinted)
          // background. A straight COMMENT_ACCENT (#e8497e) thumb read as
          // too bright/saturated against white — deepened to a warmer,
          // muted rose (#a52c58, darker still on hover) instead of the
          // bright accent used for borders/buttons elsewhere in this file.
          ".lounge-comment-thread{scrollbar-width:thin;scrollbar-color:#a52c58 #f2f2f3;}" +
          ".lounge-comment-thread::-webkit-scrollbar{width:10px;}" +
          ".lounge-comment-thread::-webkit-scrollbar-track{background:#f2f2f3;}" +
          ".lounge-comment-thread::-webkit-scrollbar-thumb{background:#a52c58;border-radius:999px;border:2px solid #f2f2f3;}" +
          ".lounge-comment-thread::-webkit-scrollbar-thumb:hover{background:#742040;}";
        document.head.appendChild(styleEl);
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
        node.style.background = COMMENT_ACCENT;   // pink accent, matching the Comment/+ Postcard buttons
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
      },
    },

    // ─── sort by (placeholder — Reddit-style dropdown, not wired to any
    // actual re-sorting yet) ─────────────────────────────────────────────────

    "sort by", {
      _buildSortByButton: function () {
        var self = this;
        var box = new lively.morphic.Box(lively.rect(0, 0, SORT_W, SORT_H));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(232, 73, 126), borderRadius: 10 });   // COMMENT_ACCENT (#e8497e)

        var label = lively.morphic.Text.makeLabel(this._sortSelection, {
          fontSize: 12, fontWeight: "bold", textColor: Color.rgb(30, 30, 30), fixedWidth: true, fixedHeight: true,
        });
        label.setPosition(lively.pt(12, 0));
        label.setExtent(lively.pt(SORT_W - 34, SORT_H));
        label.applyStyle({ borderWidth: 0 });
        box.addMorph(label);
        this._sortByLabel = label;

        // fixedWidth/fixedHeight: true — left off here, this box's own
        // explicit 20px width got silently blown out to ~102-110px
        // (confirmed live) the same way the event card's labels did
        // earlier in this file: makeLabel defaults both to false, so
        // Lively's own deferred re-layout (Text#onRenderFinishedHTML's
        // `setPadding` call, fired once the morph is actually opened in
        // the world) recomputes the box size from `getTextExtent()` and
        // overwrites the explicit setExtent below. For an icon-font
        // ligature specifically that recompute is worse than the
        // already-bad general case: "expand_more" is 12 literal
        // characters, and if that recompute's DOM measurement gets pulled
        // before the ligature font substitution settles, it locks in a
        // ~12-character-wide box forever, spilling ~85-90px past the
        // button's own 110px width.
        var chevron = lively.morphic.Text.makeLabel("expand_more", {
          fontFamily: "'Material Symbols Rounded'", fontSize: 14, textColor: Color.rgb(90, 90, 90),
          fixedWidth: true, fixedHeight: true,
        });
        chevron.setPosition(lively.pt(SORT_W - 26, 0));
        chevron.setExtent(lively.pt(20, SORT_H));
        chevron.applyStyle({ borderWidth: 0 });
        chevron.eventsAreIgnored = true;
        box.addMorph(chevron);

        box.onMouseDown = function () { self._toggleSortByDropdown(); };

        return box;
      },

      _toggleSortByDropdown: function () {
        if (this._sortByDropdown) return this._closeSortByDropdown();

        var self = this;
        var itemsH = SORT_OPTIONS.length * SORT_ITEM_H;
        var headerH = 26;
        // +4: bottom breathing room — the last row's own bottom edge landed
        // 1px past the dropdown box's bottom otherwise (confirmed live),
        // since headerH + itemsH alone accounts for exactly the rows'
        // stacked height with nothing left over for the box's own border.
        var dropdown = new lively.morphic.Box(lively.rect(0, 0, SORT_W, headerH + itemsH + 4));
        dropdown.setFill(Color.white);
        dropdown.applyStyle({ borderWidth: 1, borderColor: Color.rgb(232, 73, 126), borderRadius: 8 });   // COMMENT_ACCENT (#e8497e)

        var header = lively.morphic.Text.makeLabel("Sort by", {
          fontSize: 10, textColor: Color.rgb(140, 140, 140), fixedWidth: true, fixedHeight: true,
        });
        header.setPosition(lively.pt(12, 6));
        header.setExtent(lively.pt(SORT_W - 24, 16));
        header.applyStyle({ borderWidth: 0 });
        header.eventsAreIgnored = true;
        dropdown.addMorph(header);

        SORT_OPTIONS.forEach(function (option, i) {
          var isSelected = option === self._sortSelection;
          var row = lively.morphic.Text.makeLabel(option, {
            fontSize: 12,
            fontWeight: isSelected ? "bold" : "normal",
            textColor: isSelected ? Color.rgb(20, 20, 20) : Color.rgb(90, 90, 90),
            fixedWidth: true, fixedHeight: true,
          });
          row.setPosition(lively.pt(12, headerH + i * SORT_ITEM_H));
          row.setExtent(lively.pt(SORT_W - 24, SORT_ITEM_H));
          row.applyStyle({ borderWidth: 0 });
          row.onMouseDown = function () { self._selectSortOption(option); };
          dropdown.addMorph(row);
        });

        this._disableDragging(dropdown);
        $world.addMorph(dropdown);
        this._sortByDropdown = dropdown;
        this._layout();
      },

      _closeSortByDropdown: function () {
        if (!this._sortByDropdown) return;
        this._sortByDropdown.remove();
        this._sortByDropdown = null;
      },

      // Placeholder only — updates the button label and closes the
      // dropdown, doesn't actually re-sort the feed yet.
      _selectSortOption: function (option) {
        this._sortSelection = option;
        if (this._sortByLabel) this._sortByLabel.setTextString(option);
        this._closeSortByDropdown();
      },
    },

    // ─── create postcard ────────────────────────────────────────────────────

    "create postcard", {
      // Built oversized, then _fitCreatePostcardButton (called once the box
      // is actually in the world) shrinks it to hug its real content —
      // same "measure the live-rendered text, don't guess" idiom as
      // ProfileCard.js's fitTextHeight, since a guessed padding number
      // reliably either clips or leaves slack (per CLAUDE.md's Text-morph
      // sizing gotcha).
      _buildCreatePostcardButton: function () {
        var self = this;
        var box = new lively.morphic.Box(lively.rect(0, 0, CREATE_BTN_W, CREATE_BTN_H));
        box.setFill(Color.rgb(232, 73, 126));   // COMMENT_ACCENT (#e8497e), matching the Comment button
        box.applyStyle({ borderWidth: 0, borderRadius: CREATE_BTN_H / 2 });

        // A single label ("+ Postcard", plain "+" character) rather than a
        // separate icon-font glyph next to a text label — two different
        // fonts (Material Symbols vs the label's own) don't share the same
        // baseline/vertical metrics, which read as misaligned next to each
        // other. One Text morph guarantees the "+" and "Postcard" sit on
        // exactly the same baseline, matching the reference image.
        var label = lively.morphic.Text.makeLabel("+ Postcard", {
          fontSize: 14, fontWeight: "700", textColor: Color.rgb(255, 255, 255),
        });
        label.setExtent(lively.pt(160, 20));
        label.applyStyle({ borderWidth: 0 });
        label.eventsAreIgnored = true;
        box.addMorph(label);
        this._createBtnLabel = label;

        box.onMouseDown = function () { self._openCreatePostcard(); };

        return box;
      },

      // Shrinks the button to hug its icon+label, both horizontally
      // (rounded pill matches the content instead of guessed padding) and
      // vertically (icon/label centered on the button's own height). Must
      // run after the box is in the world — reading the real rendered
      // glyph width needs a live render context.
      //
      // getTextExtent() turned out to just echo back whatever extent was
      // already set on the morph (the generous throwaway width from
      // _buildCreatePostcardButton), not the actual glyph width — same
      // "read the live DOM span, don't trust the model value" gotcha
      // CLAUDE.md documents for fontSize. Read the real leaf <span>'s
      // offsetWidth instead.
      _realTextWidth: function (textMorph) {
        var shapeNode = textMorph.renderContext().shapeNode;
        var span = shapeNode && shapeNode.querySelector("span");
        return span ? span.offsetWidth : textMorph.getTextExtent().x;
      },

      _fitCreatePostcardButton: function () {
        var box = this._createPostcardBtn, label = this._createBtnLabel;
        if (!box || !label) return;
        var PAD = 12, LINE_H = 20;
        // A Text morph's own shapeNode carries a fixed 4px padding on each
        // side (confirmed via computed style) that isn't part of the glyph
        // itself — setting extent to exactly the measured glyph width
        // clips it by 8px. TEXT_PAD compensates: the morph's box is grown
        // by 8 and shifted left by 4 so the visible glyph still starts
        // exactly at the intended x, with nothing clipped.
        var TEXT_PAD = 4;
        var labelW = this._realTextWidth(label);
        var boxW = Math.ceil(labelW + PAD * 2);

        label.setExtent(lively.pt(labelW + TEXT_PAD * 2, LINE_H));
        label.setPosition(lively.pt(PAD - TEXT_PAD, (CREATE_BTN_H - LINE_H) / 2));
        box.setExtent(lively.pt(boxW, CREATE_BTN_H));

        // Vertical centering correction: the shapeNode also carries its own
        // fixed top/bottom padding (separate from the horizontal one above)
        // that the position formula above doesn't account for — confirmed
        // live, the label rendered visibly high in the box even though the
        // math looked centered (9px above the glyph vs 4px below it).
        // Read the actual rendered gap above/below the glyph and nudge
        // until they match, rather than hardcoding a padding guess that'd
        // only hold for this exact font/size.
        var boxNode = box.renderContext().shapeNode;
        var labelSpan = label.renderContext().shapeNode.querySelector("span");
        if (boxNode && labelSpan) {
          var boxRect = boxNode.getBoundingClientRect();
          var spanRect = labelSpan.getBoundingClientRect();
          var topGap = spanRect.top - boxRect.top;
          var bottomGap = boxRect.bottom - spanRect.bottom;
          var correction = (topGap - bottomGap) / 2;
          if (Math.abs(correction) > 0.25) {
            label.setPosition(lively.pt(PAD - TEXT_PAD, label.getPosition().y - correction));
          }
        }

        this._createBtnW = boxW;   // read by _layout to keep the button's right edge anchored to the members column
        this._layout();
      },

      // Opens a new PostCardEditor compose window preset to post into this
      // constellation — same lazy-require + newCard(handle, opts) idiom
      // MenuBarEntry.js's "New postcard" entry and PostCardView.js's own
      // reply flow already use, with opts.constellation carrying the
      // target over (mirrors PostCardView.js's _openReply).
      _openCreatePostcard: function () {
        var currentUser = lively.identity.did.currentUser();
        if (!currentUser) return;
        var opts = { constellation: this._name };
        lively.require("lively.identity.PostCardEditor").toRun(function () {
          lively.identity.PostCardEditor.newCard(currentUser.handle, opts);
        });
      },
    },

    // ─── quick info ──────────────────────────────────────────────────────────

    "quick info", {
      _renderQuickInfo: function () {
        var self = this;
        (this._quickInfoBox.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var qi = this._quickInfo || {};
        var w = this._quickInfoBox.getExtent().x;
        var h = this._quickInfoBox.getExtent().y;

        // Banner + avatar, same layout idiom as ProfileCard.js's read view
        // (a full-width banner strip, a circular avatar straddling its
        // bottom-left corner in a white "ring") scaled down for this much
        // shorter panel. Neither constellations have an uploadable
        // banner/avatar yet (no bannerUrl/avatarUrl field exists — same gap
        // as the bots section's missing settings UI), so both render their
        // permanent fallback for now: a flat placeholder banner (identical
        // color to ProfileCard's own "no bannerUrl" fallback) and a
        // deterministic identicon avatar seeded off this constellation's
        // own name, exactly like every member/comment avatar elsewhere in
        // this file already is off a DID.
        var BANNER_H = 130, AVATAR = 64, RING = 3;
        var banner = new lively.morphic.Box(lively.rect(0, 0, w, BANNER_H));
        banner.applyStyle({ fill: Color.rgb(225, 222, 232), borderWidth: 0 });
        this._quickInfoBox.addMorph(banner);

        var avX = 20, avY = BANNER_H - Math.floor(AVATAR / 2);
        var RS = AVATAR + RING * 2;
        var avRing = new lively.morphic.Box(lively.rect(avX - RING, avY - RING, RS, RS));
        avRing.applyStyle({ fill: Color.white, borderRadius: RS / 2, borderWidth: 0 });
        this._quickInfoBox.addMorph(avRing);

        var avatar = new lively.morphic.Image(lively.rect(avX, avY, AVATAR, AVATAR));
        avatar.setImageURL(lively.identity.postCardUtils.identiconDataUrl("c/" + this._name, AVATAR));
        avatar.applyStyle({ borderRadius: AVATAR / 2, borderWidth: 0, clipMode: "hidden" });
        this._quickInfoBox.addMorph(avatar);

        // Same measure-then-hug treatment as every other label in this
        // panel (event card title/date/location, "+N Others", the detail
        // lines below) — previously left at a fixed 22px height and a
        // fixed w - avX*2 (~934px) width regardless of the actual text,
        // which is the exact box-exceeds-visible-bounds pattern already
        // fixed elsewhere in this file (confirmed live via halo-select:
        // the title's own box ran most of the way across the panel no
        // matter how short the constellation name was) and the exact
        // fixed-height-clips-descenders pattern too (a constellation name
        // with a "y"/"g"/"p"/"q" would clip the same way "People" did).
        // Height is measured with the box at 1px first — a generous
        // throwaway height would hit the min-height-floor trap the event
        // title already ran into (CLAUDE.md's Text-morph note) — then
        // padded back by 4 for the shapeNode's own top/bottom padding.
        var title = lively.morphic.Text.makeLabel("c/" + this._name,
          { fontSize: 16, fontWeight: "bold", fixedWidth: true, fixedHeight: true });
        var titleY = avY + AVATAR + 10;
        title.setPosition(lively.pt(avX, titleY));
        title.setExtent(lively.pt(w - avX * 2, 1));
        this._quickInfoBox.addMorph(title);
        var titleInner = title.renderContext().shapeNode.querySelector("div");
        var titleSpan = title.renderContext().shapeNode.querySelector("span");
        var titleH = (titleInner ? titleInner.offsetHeight : 20) + 4;
        var titleTextW = titleSpan ? titleSpan.offsetWidth : 120;
        title.setExtent(lively.pt(titleTextW + 8, titleH));

        // cardX derived from the *widest* of the title and the two detail
        // lines below it (visibility/members, created/creator) — all real
        // measured DOM widths, not any of these labels' own nominal box
        // extent, which spans nearly the panel's full width regardless of
        // actual text — plus a gutter, rather than a flat fraction of
        // visibleW. A flat 42% split was tried first and reliably cleared
        // the title, but left too little room on the card's side for the
        // date/time line to avoid clipping (confirmed live: the full
        // "Weekday, Month D, YYYY at H AM/PM +NN" format needs ~307px,
        // more than a 42% split ever left available at a typical
        // 1440px-wide viewport). Using only the *title's* width (an
        // earlier version of this) was a second live-corrected mistake:
        // the title is often shorter than "Created 8/4/2026 by @handle"
        // below it, so the card started too close and forced the detail
        // lines to wrap even at a wide 1920px browser window, not just a
        // narrow one — measuring all three left-column lines up front
        // avoids that regardless of which one happens to be longest.
        // Falls back to a fixed floor if measurement fails for any reason.
        var titleRight = avX + titleTextW;

        // QUICK_INFO_W is wider than what's actually visible before the
        // members column starts, at typical viewport widths — harmless
        // while that space stayed blank, but an opaque card there would
        // render partly hidden underneath the members panel (confirmed
        // live: the card's right portion disappeared behind it). Use the
        // real gap from this._geom instead of the panel's nominal width
        // for the card's bounds specifically. Computed here (rather than
        // down by the event card call, where it used to live) because
        // EVENT_CARD_X's own clamp just below needs it too.
        var visibleW = (this._geom && typeof this._geom.membersX === "number")
          ? Math.max(200, this._geom.membersX - GUTTER - this._geom.quickInfoX)
          : w;

        var creatorHandle = qi.memberHandles && qi.createdBy ? qi.memberHandles[qi.createdBy] : null;
        var lines = [
          (qi.visibility || "public") + " · " + (qi.memberCount || 0) +
            " member" + (qi.memberCount === 1 ? "" : "s"),
          "Created " + this._formatDate(qi.createdAt) + (creatorHandle ? (" by @" + creatorHandle) : ""),
        ];
        // Throwaway single-line probes (removed immediately after
        // measuring, same idiom as the "+N Others" label's own width
        // probe in _renderEventCard) just to learn each detail line's
        // natural width before EVENT_CARD_X is finalized.
        var detailRight = titleRight;
        lines.forEach(function (str) {
          var probe = lively.morphic.Text.makeLabel(str, { fontSize: 12 });
          probe.setPosition(lively.pt(-9999, -9999));
          probe.setExtent(lively.pt(600, 18));
          self._quickInfoBox.addMorph(probe);
          var probeSpan = probe.renderContext().shapeNode.querySelector("span");
          if (probeSpan) detailRight = Math.max(detailRight, avX + probeSpan.offsetWidth);
          probe.remove();
        });
        // Clamped at the high end so a long "Created ... by @handle" line
        // can't push EVENT_CARD_X so far right that the event card has no
        // room left at all — confirmed live at a 1280px browser width: an
        // unclamped EVENT_CARD_X of 276 left only 26px of visibleW for the
        // card, under its own 160px legibility floor, so it silently
        // didn't render at all (neither the populated nor the empty-state
        // card). MIN_CARD_W/CARD_RIGHT_MARGIN mirror _renderEventCard's
        // own floor/margin so this clamp lines up with what that function
        // will actually do with the X it's handed. Below this width the
        // detail lines fall back to wrapping (already handled below)
        // rather than the event card losing its slot entirely.
        //
        // The high-end cap is itself clamped back up to a titleClearX floor
        // (avatar clearance *and* the title's own real width — a second
        // live-corrected mistake in this same pass: the outer Math.max
        // originally only had avX+AVATAR+24, which clears the avatar circle
        // but says nothing about the title text itself, which is often
        // wider than the avatar; at a narrow enough visibleW the cap fell
        // below titleRight too, pulling the card's left edge over the
        // title's own text — confirmed live, "c/wikitest" partially hidden
        // under the card's left border). Below titleClearX the card is
        // never allowed to start, even if that leaves it a tight (but
        // valid, >= 160px) width rather than the full MIN_CARD_W.
        var MIN_CARD_W = 220, CARD_RIGHT_MARGIN = 28;
        var titleClearX = Math.max(avX + AVATAR + 24, titleRight + 24);
        var EVENT_CARD_X = Math.max(
          titleClearX,
          Math.min(detailRight + 24, visibleW - CARD_RIGHT_MARGIN - MIN_CARD_W)
        );

        // Stacked directly under the constellation name, same left edge as
        // the avatar/title (avX) — previously anchored to the panel's own
        // bottom-left corner instead, which orphaned these details far
        // from the title they actually describe and left this whole left
        // column empty below the title. Width capped at EVENT_CARD_X (now
        // guaranteed wide enough for these exact lines, per the probe
        // above) so a long visibility/member-count line can't run
        // underneath the event card sitting to its right. Wrapping is kept
        // as a fallback regardless (whiteSpaceHandling:"normal" +
        // measure-real-height, same idiom as the event title) for the
        // rare case a member count or handle changes between this probe
        // and render — cheap insurance, not the primary mechanism.
        var DETAIL_GAP = 8;
        var detailY = titleY + titleH + DETAIL_GAP;
        var detailW = Math.max(80, EVENT_CARD_X - avX - 16);
        lines.forEach(function (str) {
          var t = lively.morphic.Text.makeLabel(str,
            { fontSize: 12, textColor: Color.rgb(102, 102, 102), whiteSpaceHandling: "normal", fixedWidth: true, fixedHeight: true });
          t.setPosition(lively.pt(avX, detailY));
          t.setExtent(lively.pt(detailW, 1));
          self._quickInfoBox.addMorph(t);
          var inner = t.renderContext().shapeNode.querySelector("div");
          var lineH = (inner ? inner.offsetHeight : 14) + 4; // +4: shapeNode's own 2px-top/2px-bottom padding, see CLAUDE.md
          t.setExtent(lively.pt(detailW, lineH));
          detailY += lineH + 2;
        });

        // Event card — pinned to the top-right corner of the space right
        // of the avatar/title column and below the banner, now that the
        // visibility/members/created details above no longer reserve room
        // at the bottom. Only the constellation's single next-upcoming
        // event is shown (getNextEvent server-side); nothing renders if
        // there isn't one. (visibleW/EVENT_CARD_X were both computed
        // earlier, above the detail lines — visibleW because
        // EVENT_CARD_X's own clamp needs it too.) BANNER_H itself (not
        // BANNER_H + 14) is passed as the region's top edge — both
        // _renderEventCard and _renderEmptyEventCard apply their own
        // top margin internally now, so it lines up with the margin they
        // leave on the right instead of a separately-guessed constant.
        var PANEL_BOTTOM_PAD = 14;
        var cardBottomMax = h - PANEL_BOTTOM_PAD;
        if (qi.nextEvent) {
          this._renderEventCard(qi.nextEvent, EVENT_CARD_X, BANNER_H, visibleW, cardBottomMax);
        } else {
          this._renderEmptyEventCard(EVENT_CARD_X, BANNER_H, visibleW, cardBottomMax);
        }

        this._disableDragging(this._quickInfoBox);
      },

      // Same bordered slot as _renderEventCard, shown instead of it when
      // there's no upcoming event — a calendar glyph (Material Symbols
      // Rounded, per CLAUDE.md's icon convention) over "No events
      // scheduled", both centered in the card rather than left-aligned
      // like the populated card's content, since there's no date/title/
      // location to anchor a left margin against.
      _renderEmptyEventCard: function (cardX, cardY, panelW, cardBottomMax) {
        // Same RIGHT_MARGIN, applied symmetrically top and right, as
        // _renderEventCard — this card fills its whole region rather than
        // hugging content, so unlike the populated card there's no
        // separate "shrink then position" step; the margin is just baked
        // straight into where the box starts and how big it is.
        var RIGHT_MARGIN = 28;
        var cardW = panelW - cardX - RIGHT_MARGIN;
        var cardH = (cardBottomMax - cardY) - RIGHT_MARGIN;
        if (cardW < 160 || cardH < 70) return;

        var card = new lively.morphic.Box(lively.rect(cardX, cardY + RIGHT_MARGIN, cardW, cardH));
        card.setFill(Color.white);
        card.applyStyle({ borderWidth: 2, borderColor: Color.rgb(232, 73, 126), borderRadius: 12, clipMode: "hidden" });   // COMMENT_ACCENT (#e8497e)
        this._quickInfoBox.addMorph(card);

        // 28px real glyph size -> fontSize 21 (28*0.75), same pt-not-px
        // conversion as every other icon in this file.
        var ICON_PX = 28, ICON_FONT = ICON_PX * 0.75, ICON_BOX_H = 34;
        var icon = new lively.morphic.Text(lively.rect(0, Math.round(cardH / 2) - 34, cardW, ICON_BOX_H), "calendar_month");
        icon.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: ICON_FONT, textColor: Color.rgb(190, 190, 190),
          fill: null, borderWidth: 0, allowInput: false, selectable: false, align: "center",
          fixedWidth: true, fixedHeight: true,
          clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        card.addMorph(icon);

        // Left at makeLabel's default fixedWidth:false so the box hugs the
        // text itself (a small centered pill, not a label stretched across
        // the whole card) — align:"center" can't do the centering here
        // since a box that auto-shrinks to its content has no extra room
        // left to center within (confirmed live: with align alone the text
        // sat flush-left instead). Generous throwaway width first so it
        // doesn't wrap, then measure the real rendered span and reposition
        // — same measure-after-render idiom _fitCreatePostcardButton
        // already uses in this file for the same reason.
        var label = lively.morphic.Text.makeLabel("No events scheduled",
          { fontSize: 12.5, textColor: Color.rgb(150, 150, 150) });
        var labelY = Math.round(cardH / 2) + 4;
        label.setPosition(lively.pt(0, labelY));
        label.setExtent(lively.pt(cardW, 18));
        card.addMorph(label);
        var labelSpan = label.renderContext().shapeNode.querySelector("span");
        var labelW = labelSpan ? labelSpan.offsetWidth : Math.ceil("No events scheduled".length * 7);
        // setExtent back down to the real measured width, not just
        // setPosition — the box itself was still the full cardW-wide
        // throwaway extent from above (fixedWidth:false only auto-fits at
        // initial creation, not on every subsequent change), so repositioning
        // alone just slid that still-full-width box rightward, overflowing
        // past the card's own right edge. Shrinking the extent too is what
        // actually makes it hug the text.
        //
        // +8/-4: the shapeNode's own small fixed internal padding (CLAUDE.md's
        // Text-morph sizing gotcha) eats into the content box, so setting
        // width to exactly labelW clips the last couple px (confirmed live:
        // the trailing "d" in "scheduled" was cut off) — pad the extent and
        // shift position back by half that so the visible glyph still lands
        // centered with nothing clipped.
        var SIZE_PAD = 8;
        label.setExtent(lively.pt(labelW + SIZE_PAD, 18));
        label.setPosition(lively.pt(Math.max(0, Math.round((cardW - labelW) / 2) - SIZE_PAD / 2), labelY));
      },

      // cardRight/cardBottomMax: the panel's own right/bottom bounds are an
      // upper limit the card must stay within, not a size to stretch to
      // fill — the card is built at that generous throwaway size first
      // (so nothing wraps while measuring), then shrunk down to hug its
      // actual content on both axes, same measure-then-shrink idiom as the
      // empty-state "No events scheduled" label. Confirmed live: the
      // stretched version left a large dead gap to the right of "+N
      // Others" and zero bottom margin below the avatar row.
      _renderEventCard: function (ev, cardX, cardY, panelW, cardBottomMax) {
        // RIGHT_MARGIN (rather than the flat 20 GUTTER used elsewhere in
        // this file) so the card visibly clears the panel's right edge
        // even when it hugs all the way out to maxCardW, instead of
        // stopping just short of it. Reused as the *top* margin too (see
        // the final positioning below) so the card sits pinned to the
        // available region's top-right corner with equal margins on both
        // sides, rather than centered in the region — cardY here is this
        // region's own top edge (banner bottom), not yet offset by any
        // margin, so that margin has to come out of maxCardH the same way
        // RIGHT_MARGIN already comes out of maxCardW.
        var RIGHT_MARGIN = 28;
        var maxCardW = panelW - cardX - RIGHT_MARGIN;
        var maxCardH = (cardBottomMax - cardY) - RIGHT_MARGIN;
        if (maxCardW < 160 || maxCardH < 70) return; // not enough room to render legibly

        var card = new lively.morphic.Box(lively.rect(cardX, cardY, maxCardW, maxCardH));
        card.setFill(Color.white);
        // clipMode hidden so a long title/location (this panel's available
        // width is fairly narrow once the members column eats into it, see
        // visibleW above) clips cleanly at the card's own edge instead of
        // visually overflowing past it — confirmed live with a real
        // 45-character title before adding this.
        card.applyStyle({ borderWidth: 2, borderColor: Color.rgb(232, 73, 126), borderRadius: 12, clipMode: "hidden" });   // COMMENT_ACCENT (#e8497e)
        this._quickInfoBox.addMorph(card);

        var PAD = 16, GAP = 4;
        var contentW = maxCardW - PAD * 2;
        // Widest content edge seen so far (card-relative x) — drives the
        // final shrunk width below, capped at contentW per-line so a
        // wrapped title (see below) can't itself push the card wider than
        // the room actually available.
        var maxRight = 0;
        function trackRight(right) { if (right > maxRight) maxRight = right; }

        // Every label below that sizes itself from a *measured* content
        // height (as opposed to a hardcoded guess) has to add HEIGHT_PAD
        // back on top of that measurement before calling setExtent — the
        // vertical sibling of the shapeNode's own fixed internal padding
        // CLAUDE.md already documents for width (the "+8/-4" pattern used
        // elsewhere in this file): `setExtentHTML` treats the extent it's
        // given as the box's *total* size and subtracts the shapeNode's
        // own 2px-top/2px-bottom padding from it to get the actual CSS
        // content-box height. Passing the measured *content* height
        // straight through therefore ends up 4px short of what's actually
        // needed — confirmed live: measuring the "+N People" label's real
        // content height as 19px and calling setExtent(w, 19) produced a
        // box only 15px tall, clipping the descender of the "p" in
        // "People" against the box's own overflow:hidden. fixedWidth/
        // fixedHeight are also set true on these labels (unlike makeLabel's
        // hug-content default of false for both) so nothing later
        // silently re-fits them back to a different size.
        var HEIGHT_PAD = 4;
        var dt = lively.morphic.Text.makeLabel(this._formatEventDateTime(ev.startsAt),
          { fontSize: 12, fontWeight: "700", textColor: Color.rgb(230, 126, 34), fixedWidth: true, fixedHeight: true });
        dt.setPosition(lively.pt(PAD, 8));
        // contentW is a generous throwaway width here — only so the "pre"
        // (no-wrap) text has room to measure at its natural size, never
        // the box's final width. Left un-hugged, this and the other two
        // labels below stayed at the full contentW forever (their own
        // invisible box always as wide as the card's *widest possible*
        // content), which sat visibly wider than the card itself once the
        // card hugged down to a narrower finalW below — confirmed live via
        // halo-select, an empty-space overhang past the card's own right
        // border on every line shorter than whichever line drove finalW.
        dt.setExtent(lively.pt(contentW, 14));
        card.addMorph(dt);
        // Measure the real content height rather than trust the hardcoded
        // 14 above (see HEIGHT_PAD comment) — a fixed guess is a coin flip
        // on whether a descender like the "y" in "Thursday" clips.
        var dtInner = dt.renderContext().shapeNode.querySelector("div");
        var dtH = dtInner ? dtInner.offsetHeight + HEIGHT_PAD : 14;
        var dtSpan = dt.renderContext().shapeNode.querySelector("span");
        // Hug width to the real measured text (+8 shapeNode-padding
        // compensation, same idiom as the "+N Others" label below), capped
        // at contentW so an overlong date still clips at the card's edge
        // rather than overflow past it — same trade-off already made for
        // trackRight just below.
        var dtW = dtSpan ? Math.min(dtSpan.offsetWidth + 8, contentW) : contentW;
        dt.setExtent(lively.pt(dtW, dtH));
        if (dtSpan) trackRight(PAD + Math.min(dtSpan.offsetWidth, contentW));

        // Title is allowed to wrap onto a second line — unlike every other
        // label in this file (all single-line "pre") — instead of clipping
        // mid-word at the card's own edge, which is what a real ~45-char
        // event title did before this (confirmed live: cut off after ~30
        // characters, mid-word, with the rest of the title simply gone).
        // The box starts at a generous throwaway height (its real wrapped
        // height isn't knowable until after render — same measure-after-
        // render idiom used elsewhere in this file) and is then shrunk to
        // the actual measured height, so nothing below it in the card
        // overlaps or leaves an oversized gap.
        var titleM = lively.morphic.Text.makeLabel(ev.title || "",
          { fontSize: 15, fontWeight: "bold", textColor: Color.rgb(20, 20, 20), whiteSpaceHandling: "normal", fixedWidth: true, fixedHeight: true });
        var titleY = 24;
        titleM.setPosition(lively.pt(PAD, titleY));
        // Single-line height first (a throwaway 2000px-wide box guarantees
        // no wrap regardless of content) — this is the per-line height used
        // below to cap wrapping at 2 lines. The box's own height is set to
        // 1px (not something generous) for every measurement in this
        // function: the rendered content div's CSS is
        // `min-height: calc(100% - 4px)` of the *box's own* height, so a
        // generous throwaway height (e.g. 60) becomes a floor that a short
        // single line's true ~23-27px content can never measure below —
        // confirmed live, every measurement came back pinned at exactly
        // (thrown-away height - 4) regardless of actual content. A 1px box
        // makes that floor negligible, so offsetHeight reflects real
        // content height instead.
        titleM.setExtent(lively.pt(2000, 1));
        card.addMorph(titleM);
        var titleInner = titleM.renderContext().shapeNode.querySelector("div");
        var singleLineH = titleInner ? titleInner.offsetHeight : 20;
        titleM.setExtent(lively.pt(contentW, 1));
        var titleH = titleInner ? titleInner.offsetHeight : singleLineH;
        // A narrow card (this panel's available width shrinks a lot below
        // ~1600px browser width, see visibleW above) can wrap a long title
        // onto 4-5 lines, which blows past the card's own fixed vertical
        // budget and pushes the avatar row/"+N Others" label past the
        // card's bottom edge to be clipped there — confirmed live at a
        // 1280px browser width with this same 45-character title. Capped
        // at 2 lines with a trailing "…" instead: trims one word at a time
        // off the end (titles are short, a handful of words, so this is a
        // handful of reflows at most) until the wrapped height fits back
        // within 2 lines.
        var maxTitleH = singleLineH * 2 + 4;
        if (titleH > maxTitleH) {
          var words = (ev.title || "").split(/\s+/);
          while (words.length > 1 && titleH > maxTitleH) {
            words.pop();
            titleM.setTextString(words.join(" ") + "…");
            titleH = titleInner.offsetHeight;
          }
        }
        var titleSpan = titleM.renderContext().shapeNode.querySelector("span");
        // Only hug width when the title stayed on one line — a wrapped
        // title's own width *is* contentW (that's what forced it to
        // wrap), so there's no narrower "natural" width to hug to; the
        // span's own offsetWidth for wrapped content is just the widest
        // individual line anyway (see the trackRight cap below), not a
        // sizing target. "Stayed one line" is titleH landing back at
        // singleLineH — allow a couple px of font-rounding slack.
        var titleIsSingleLine = titleH <= singleLineH + 2;
        var titleW = (titleIsSingleLine && titleSpan)
          ? Math.min(titleSpan.offsetWidth + 8, contentW)
          : contentW;
        titleM.setExtent(lively.pt(titleW, titleH + HEIGHT_PAD));
        if (titleSpan) trackRight(PAD + Math.min(titleSpan.offsetWidth, contentW));
        var afterTitleY = titleY + titleH + HEIGHT_PAD;

        // Location's y (and, below, the avatar row's rowY) is derived from
        // the title's *real* measured bottom rather than a fixed offset —
        // a wrapped two-line title is taller than the original fixed
        // offsets assumed, and without this the location line and avatar
        // row would sit on top of the title's second line instead of below
        // it.
        var contentBottomY = afterTitleY;
        if (ev.location) {
          var locM = lively.morphic.Text.makeLabel(ev.location, { fontSize: 12, textColor: Color.rgb(110, 110, 110), fixedWidth: true, fixedHeight: true });
          var locY = afterTitleY + GAP;
          locM.setPosition(lively.pt(PAD, locY));
          locM.setExtent(lively.pt(contentW, 14));
          card.addMorph(locM);
          var locInner = locM.renderContext().shapeNode.querySelector("div");
          var locH = locInner ? locInner.offsetHeight : 14;
          var locSpan = locM.renderContext().shapeNode.querySelector("span");
          var locW = locSpan ? Math.min(locSpan.offsetWidth + 8, contentW) : contentW;
          locM.setExtent(lively.pt(locW, locH + HEIGHT_PAD));
          if (locSpan) trackRight(PAD + Math.min(locSpan.offsetWidth, contentW));
          contentBottomY = locY + locH + HEIGHT_PAD;
        }

        // Overlapping attendee avatars — same white-ring cutout technique
        // as the main avatar above, one ring+image pair per attendee, each
        // added after (so rendered on top of) the previous one to get the
        // "stacked" look. Deterministic identicons off each attendee's DID,
        // same as every other avatar in this file — no real photos, this
        // app has no such upload path for anyone, member or attendee.
        var AV = 26, OVERLAP = 8, RING = 2, MAX_SHOWN = 4;
        var allAttendees = ev.attendees || [];
        var totalAttendeeCount = ev.attendeeCount || allAttendees.length;
        // A narrow card (contentW shrinks a lot below ~1600px browser
        // width, see visibleW above) can't always fit 4 overlapping
        // avatars plus a "+N Others" label on one row — confirmed live at
        // a 1280px browser width, where the label's own right edge landed
        // ~30px past the card's right border and was clipped there. Rather
        // than let the row overflow, shrink how many avatar circles are
        // shown (never the label itself, which is what actually carries
        // the count) until the whole row fits within contentW. The
        // label's width barely changes with the exact "+N" digit count, so
        // one throwaway measurement at the MAX_SHOWN guess is close enough
        // to size against.
        var guessShown = Math.min(allAttendees.length, MAX_SHOWN);
        var guessExtra = Math.max(0, totalAttendeeCount - guessShown);
        var lblW = 0;
        if (guessExtra > 0) {
          var lblProbe = lively.morphic.Text.makeLabel("+" + guessExtra + " Others",
            { fontSize: 12.5, fontWeight: "700", textColor: Color.rgb(40, 40, 40) });
          lblProbe.setPosition(lively.pt(-9999, -9999));
          lblProbe.setExtent(lively.pt(200, 18));
          card.addMorph(lblProbe);
          var lblProbeSpan = lblProbe.renderContext().shapeNode.querySelector("span");
          lblW = lblProbeSpan ? lblProbeSpan.offsetWidth : Math.ceil(("+" + guessExtra + " Others").length * 8);
          lblProbe.remove();
        }
        var avatarsBudget = contentW - (guessExtra > 0 ? (lblW + 8 + 8) : 0);
        var shownCount = guessShown;
        while (shownCount > 0 && (AV + (shownCount - 1) * (AV - OVERLAP)) > avatarsBudget) shownCount--;
        var shown = allAttendees.slice(0, shownCount);
        var rowY = contentBottomY + GAP;
        var x = PAD;
        shown.forEach(function (did) {
          var rs = AV + RING * 2;
          var ring = new lively.morphic.Box(lively.rect(x - RING, rowY - RING, rs, rs));
          ring.applyStyle({ fill: Color.white, borderRadius: rs / 2, borderWidth: 0 });
          card.addMorph(ring);
          var av = new lively.morphic.Image(lively.rect(x, rowY, AV, AV));
          av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(did, AV));
          av.applyStyle({ borderRadius: AV / 2, borderWidth: 0, clipMode: "hidden" });
          card.addMorph(av);
          x += AV - OVERLAP;
        });
        if (shown.length) x += OVERLAP;
        trackRight(x);

        var extra = Math.max(0, totalAttendeeCount - shown.length);
        if (extra > 0) {
          var lblX = x + (shown.length ? 8 : 0);
          var lbl = lively.morphic.Text.makeLabel("+" + extra + " Others",
            { fontSize: 12.5, fontWeight: "700", textColor: Color.rgb(40, 40, 40), fixedWidth: true, fixedHeight: true });
          lbl.setPosition(lively.pt(lblX, rowY + 5));
          lbl.setExtent(lively.pt(Math.max(30, contentW - lblX), 18)); // generous throwaway so it doesn't wrap
          card.addMorph(lbl);
          // Shrink to the real measured width — same +8 shapeNode-padding
          // compensation as the empty-state label, so the box hugs the
          // text (no dead space trailing it) without clipping its own
          // last character. Height is likewise measured rather than a
          // guessed 18: that guess was ~1px short of this text's real
          // rendered height, which clipped the descender of the "p" in
          // "People" against the box's own overflow:hidden (confirmed
          // live) — see the HEIGHT_PAD comment above for why.
          var lblInner = lbl.renderContext().shapeNode.querySelector("div");
          var lblSpan = lbl.renderContext().shapeNode.querySelector("span");
          var lblW = lblSpan ? lblSpan.offsetWidth : Math.ceil(("+" + extra + " Others").length * 8);
          var lblH = lblInner ? lblInner.offsetHeight : 18;
          lbl.setExtent(lively.pt(lblW + 8, lblH + HEIGHT_PAD));
          trackRight(lblX + lblW + 8);
        }

        // Shrink the card down to hug its content on both axes (capped at
        // the original available maxCardW/maxCardH so it never grows back
        // past the visible bounds established by the caller) — MIN floors
        // keep a short title/no-attendees card from collapsing too tight.
        var finalW = Math.min(maxCardW, Math.max(220, maxRight + PAD));
        var finalH = Math.min(maxCardH, Math.max(70, rowY + AV + 14));
        card.setExtent(lively.pt(finalW, finalH));
        // Pinned to the top-right corner of the region handed to this
        // function, with equal margins on both sides: RIGHT_MARGIN from
        // the panel's right edge (finalX — since maxCardW already reserved
        // RIGHT_MARGIN, sitting flush against maxCardW's own right edge
        // lands exactly there) and that same RIGHT_MARGIN below cardY,
        // this region's own top edge (finalY — maxCardH above already
        // reserved room for it too). Never left of cardX regardless of
        // how narrow the card ends up, since finalW <= maxCardW by
        // construction — that's what keeps it clear of the avatar/title/
        // detail-lines column to its left.
        var finalX = cardX + maxCardW - finalW;
        var finalY = cardY + RIGHT_MARGIN;
        card.setPosition(lively.pt(finalX, finalY));
      },

      _formatDate: function (iso) {
        if (!iso) return "—";
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleDateString();
      },

      // Renders an ISO 8601 datetime string (e.g. "2025-12-03T14:00:00+06:00")
      // as "Wednesday, December 3, 2025 at 2 PM +06" — always in the
      // event's own stored UTC offset, not the viewer's local timezone
      // (an event's wall-clock time shouldn't shift per-viewer), so this
      // parses the string's numeric fields directly rather than going
      // through `new Date(iso)` + toLocale*, which would silently convert
      // to the browser's local zone instead.
      _formatEventDateTime: function (iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso || "");
        if (!m) return iso || "";
        var year = +m[1], month = +m[2], day = +m[3], hour = +m[4], minute = +m[5];
        var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        var MONTHS = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"];
        var weekday = DAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
        var ampm = hour >= 12 ? "PM" : "AM";
        var hour12 = hour % 12 || 12;
        var timeStr = hour12 + (minute ? (":" + (minute < 10 ? "0" : "") + minute) : "") + " " + ampm;
        var offsetStr = "";
        var offRaw = m[7];
        if (offRaw && offRaw !== "Z") {
          var om = /^([+-])(\d{2}):?(\d{2})$/.exec(offRaw);
          if (om) offsetStr = " " + om[1] + om[2] + (om[3] !== "00" ? (":" + om[3]) : "");
        }
        return weekday + ", " + MONTHS[month - 1] + " " + day + ", " + year + " at " + timeStr + offsetStr;
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

    // ─── comment thread — Reddit-style, inline, no votes ───────────────────────
    // Every comment renders inline (avatar, handle, relative time, full body,
    // Reply/collapse actions) — there's no "click to focus into the main card
    // slot" anymore; the twisty only shows/hides a comment's own children.
    // The /replies list endpoint deliberately returns metadata only (no
    // record.payload — see ObjectRepository.js's _runPostcardQuery), so a
    // level's replies get a full-envelope fetch per row before they're ever
    // rendered (_hydrateReplies) — the same fetch-then-render sequence
    // _renderCardInto already uses for the big card, just batched for a
    // whole list. Composing a reply reuses the same lively.morphic.Text +
    // allowInput technique the search field above already established in
    // this file (not a raw <textarea> in the shapeNode) — real Lively text
    // editing has none of the native-input focus-stealing gotchas documented
    // in CLAUDE.md, since those only ever affected genuine DOM <input>/
    // <textarea> elements.

    "thread", {
      _loadThread: function (rootObjId) {
        var self = this;
        this._threadRootObjId = rootObjId;
        this._threadChildrenCache = {};
        this._threadExpanded = {};
        this._replyBoxOpenFor = null;
        this._bodyBoxCache = {};
        if (this._threadRerenderTimer) { clearTimeout(this._threadRerenderTimer); this._threadRerenderTimer = null; }
        (this._threadContainer.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var loading = lively.morphic.Text.makeLabel("Loading comments…", { fontSize: 12, textColor: Color.gray });
        loading.setPosition(lively.pt(0, 0));
        this._threadContainer.addMorph(loading);

        this._loadReplyLevel(rootObjId, function (err, replies) {
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

      // Fetches one level's reply metadata, then hydrates every reply with
      // its real body HTML + author handle before handing back — a caller
      // never renders a row that isn't already fully loaded.
      _loadReplyLevel: function (parentObjId, thenDo) {
        var self = this;
        this._fetchReplies(parentObjId, function (err, replies) {
          if (err || !replies.length) return thenDo(err, replies || []);
          self._hydrateReplies(replies, function () { thenDo(null, replies); });
        });
      },

      _hydrateReplies: function (replies, thenDo) {
        var self = this;
        var dids = [];
        replies.forEach(function (r) { if (dids.indexOf(r.did) === -1) dids.push(r.did); });
        this._resolveHandlesBatch(dids, function (handleMap) {
          var pending = replies.length;
          replies.forEach(function (r) {
            r._handle = handleMap[r.did] || null;
            self._fetchEnvelope(r.objId, function (err, envelope) {
              r._bodyHtml = self._extractReplyBodyHtml(envelope, err);
              if (--pending === 0) thenDo();
            });
          });
        });
      },

      // Same visibility handling as PostCardView.js's _renderContentArea
      // public branch (plain doc-or-snapshot, hydrateEmbeddedParts) —
      // decrypting an encrypted reply inline isn't attempted here, matching
      // this being a lightweight comment list rather than a second full
      // card renderer; an encrypted reply just shows a locked placeholder.
      _extractReplyBodyHtml: function (envelope, err) {
        if (err || !envelope) return '<span style="color:#999;font-style:italic;">(could not load)</span>';
        if (envelope.visibility !== "public") {
          return '<span style="color:#999;font-style:italic;">🔒 Encrypted reply</span>';
        }
        var payload = envelope.record && envelope.record.payload;
        var snapshot = payload &&
          (payload.format === "prosemirror-doc-v1" ? payload.doc : payload.snapshot);
        return snapshot ? lively.identity.postCardUtils.snapshotToHtml(snapshot) : "";
      },

      // Same batch endpoint _resolveHandle already uses, generalized to
      // resolve several dids in one request — quickInfo.memberHandles and
      // this._didHandleCache (dids resolved by an earlier batch) are both
      // checked first, so a level where every author is already a known
      // constellation member (the common case) needs no request at all.
      _resolveHandlesBatch: function (dids, thenDo) {
        var self = this;
        var qi = this._quickInfo || {};
        var known = {};
        var unknown = [];
        dids.forEach(function (did) {
          if (qi.memberHandles && qi.memberHandles[did]) known[did] = qi.memberHandles[did];
          else if (self._didHandleCache[did]) known[did] = self._didHandleCache[did];
          else unknown.push(did);
        });
        if (!unknown.length) return thenDo(known);

        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/dids/handles?dids=" + encodeURIComponent(unknown.join(",")), true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status === 200) {
            try {
              var data = JSON.parse(xhr.responseText);
              Object.keys(data.handles || {}).forEach(function (did) {
                known[did] = data.handles[did];
                self._didHandleCache[did] = data.handles[did];
              });
            } catch (e) {}
          }
          thenDo(known);
        };
        xhr.onerror = function () { thenDo(known); };
        xhr.send();
      },

      // Rebuilds the whole visible tree from this._threadReplies +
      // this._threadExpanded + this._threadChildrenCache — simplest correct
      // way to keep an expand/collapse-anywhere tree in the right visual
      // order without hand-patching morph insertion points. A "join the
      // conversation" composer always sits first, same as a real Reddit
      // thread's top-level comment box.
      _renderThreadTree: function () {
        var container = this._threadContainer;
        var containerNode = container.renderContext().shapeNode;
        // BUG FIX: clicking "Replies" to expand a nested reply rebuilds the
        // whole tree (same full-rebuild-from-state idiom as everywhere else
        // in this file) — removing every submorph below drops the
        // container's scrollHeight to ~0 for an instant, which clamps its
        // native scrollTop to 0, and nothing restored it afterward. So
        // expanding a reply anywhere but the very top of the thread threw
        // the reader back to the first comment, even though the newly
        // expanded content made the thread *taller*, not shorter (confirmed
        // live: scrollTop went 200 -> 0 while scrollHeight actually grew
        // 965 -> 1108). Saving/restoring scrollTop around the rebuild keeps
        // the reader's position stable.
        var savedScrollTop = containerNode.scrollTop;
        (container.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var w = (container.getExtent().x || THREAD_W) - COMMENT_PAD_X * 2;

        var y = this._renderComposerIfSignedIn(
          container, "ROOT", this._threadRootObjId, COMMENT_PAD_X, COMMENT_TOP_MARGIN, w, "Start conversation");
        y += 10;

        if (!this._threadReplies.length) {
          var empty = lively.morphic.Text.makeLabel("No comments yet — be the first to reply.", { fontSize: 12, textColor: Color.gray });
          empty.setPosition(lively.pt(COMMENT_PAD_X, y));
          empty.setExtent(lively.pt(w, 16));
          container.addMorph(empty);
        } else {
          this._renderCommentLevel(container, this._threadReplies, 0, y, w);
        }
        this._disableDragging(container);
        containerNode.scrollTop = savedScrollTop;
      },

      _renderCommentLevel: function (container, replies, depth, y, w) {
        var self = this;
        replies.forEach(function (reply) {
          y = self._renderCommentNode(container, reply, depth, y, w);
        });
        return y;
      },

      // Lays out one comment (avatar/header/body/actions), its own inline
      // reply composer if open, its children if expanded, and — if it has
      // any visible children — a single vertical guideline box connecting
      // its avatar down to its last child, the same continuous-thread-line
      // idiom a real Reddit comment tree uses. Returns the y position just
      // below everything this node (and its subtree) occupied.
      _renderCommentNode: function (container, reply, depth, y, w) {
        var self = this;
        var x = COMMENT_PAD_X + depth * COMMENT_INDENT;
        // Width shrinks with nesting depth only — not with the constant
        // left inset baked into x above — so the right edge lands at the
        // same COMMENT_PAD_X margin regardless of depth, matching the
        // composer box's own right edge exactly.
        var rowW = w - depth * COMMENT_INDENT;
        var topY = y;

        var avatar = new lively.morphic.Image(lively.rect(0, 0, COMMENT_AVATAR, COMMENT_AVATAR));
        avatar.setImageURL(lively.identity.postCardUtils.identiconDataUrl(reply.did, COMMENT_AVATAR));
        avatar.applyStyle({ borderRadius: COMMENT_AVATAR / 2, borderWidth: 0, clipMode: "hidden" });
        container.addMorph(avatar);
        avatar.setPosition(lively.pt(x, y));

        var textX = x + COMMENT_AVATAR + 4;
        var textW = Math.max(60, rowW - COMMENT_AVATAR - 4);

        var header = lively.morphic.Text.makeLabel(
          "@" + (reply._handle || (reply.did || "").slice(0, 10) + "…") + "  ·  " + self._formatRelativeTime(reply.created),
          { fontSize: 10.5, textColor: COMMENT_META_COLOR });
        container.addMorph(header);
        header.setPosition(lively.pt(textX, y + 2));
        // 14 clipped the glyph's bottom ~3px (measured live: the rendered
        // span was 15.33px tall against a 14px, overflow:hidden box) — 18
        // gives real headroom instead of matching the fontSize-in-pt
        // number too tightly.
        header.setExtent(lively.pt(textW, 18));

        // BUG FIX: an earlier version always built a fresh Box + innerHTML
        // here, every single call — fine for text, but an <img>/<video>
        // inside reply._bodyHtml has no intrinsic size until the browser
        // actually finishes loading it, and _renderThreadTree rebuilds the
        // whole tree (including this box) any time anything below the top
        // composer changes. Recreating the DOM node threw away an
        // already-loaded (or still-loading) media element's real progress
        // every time, and confirmed live via chrome-devtools that a fresh
        // <video> element takes ~140-150ms to reach loadedmetadata even
        // against an already browser-cached URL (caching speeds up the
        // network fetch, not the element's own decode/metadata pipeline) —
        // so a naive "just re-measure after load" fix still measured a
        // *different*, still-loading element on the settling re-render and
        // landed on the wrong height anyway. Reusing the same Box/DOM node
        // across rebuilds whenever this reply's HTML+width haven't changed
        // keeps whatever media it contains genuinely loaded (or genuinely
        // still loading, still being watched) instead of restarting it.
        var cacheKey = reply.objId;
        var cached = self._bodyBoxCache[cacheKey];
        var bodyBox, bodyNode, bodyH;
        if (cached && cached.html === (reply._bodyHtml || "") && cached.width === textW) {
          bodyBox = cached.box;
          bodyNode = bodyBox.renderContext().shapeNode;
          bodyH = cached.height;
          container.addMorph(bodyBox);
        } else {
          bodyBox = new lively.morphic.Box(lively.rect(0, 0, textW, 10));
          bodyBox.applyStyle({ fill: null, borderWidth: 0 });
          container.addMorph(bodyBox);
          bodyNode = bodyBox.renderContext().shapeNode;
          bodyNode.className = (bodyNode.className ? bodyNode.className + " " : "") + "lounge-comment-body";
          bodyNode.innerHTML = reply._bodyHtml || "";
          // Measure-the-real-DOM, same technique as this file's own text-
          // sizing convention elsewhere — the body's height genuinely
          // depends on its (rich, possibly multi-paragraph) content, not a
          // guessed constant, so it's read back off the live node after
          // the HTML and width are both already set. Wrong the moment any
          // embedded media hasn't loaded yet — _watchMediaLoad corrects
          // cached.height (and reflows) once it has.
          bodyH = Math.max(14, bodyNode.scrollHeight);
          lively.identity.postCardUtils.hydrateEmbeddedParts(bodyNode);
          cached = self._bodyBoxCache[cacheKey] = { box: bodyBox, html: reply._bodyHtml || "", width: textW, height: bodyH };
          self._watchMediaLoad(bodyNode, cached);
        }
        bodyBox.setPosition(lively.pt(textX, y + 20));
        bodyBox.setExtent(lively.pt(textW, bodyH));

        var actionsY = y + 20 + bodyH + 4;
        var actionsX = textX;
        if (lively.identity.did.currentUser()) {
          var replyBtn = self._buildIconLabel("reply", "Reply", COMMENT_META_COLOR, function () {
            self._replyBoxOpenFor = (self._replyBoxOpenFor === reply.objId) ? null : reply.objId;
            self._renderThreadTree();
          });
          container.addMorph(replyBtn);
          replyBtn.setPosition(lively.pt(actionsX, actionsY));
          actionsX += replyBtn.getExtent().x + 10;
        }

        var expanded = !!self._threadExpanded[reply.objId];
        var toggleBtn = self._buildIconLabel(
          expanded ? "expand_more" : "chevron_right",
          expanded ? "Hide replies" : "Replies",
          COMMENT_META_COLOR,
          function () {
            self._threadExpanded[reply.objId] = !self._threadExpanded[reply.objId];
            if (self._threadExpanded[reply.objId] && !self._threadChildrenCache[reply.objId]) {
              self._loadReplyLevel(reply.objId, function (err, children) {
                self._threadChildrenCache[reply.objId] = err ? [] : children;
                self._renderThreadTree();
              });
            }
            self._renderThreadTree();
          });
        container.addMorph(toggleBtn);
        toggleBtn.setPosition(lively.pt(actionsX, actionsY));

        var rowBottom = actionsY + 20;

        if (self._replyBoxOpenFor === reply.objId) {
          // +COMMENT_PAD_X: w's right boundary already sits COMMENT_PAD_X
          // short of the container's true right edge (see the rowW comment
          // above) — add it back so this composer's right edge lines up
          // with the top-level one instead of landing PAD_X short of it.
          rowBottom = self._renderComposerIfSignedIn(
            container, reply.objId, reply.objId, textX, rowBottom, w - textX + COMMENT_PAD_X,
            "Replying to @" + (reply._handle || "…"));
        }

        var childrenBottom = rowBottom;
        if (expanded) {
          var children = self._threadChildrenCache[reply.objId];
          if (children) {
            if (children.length) {
              childrenBottom = self._renderCommentLevel(container, children, depth + 1, rowBottom + 6, w);
            }
          } else {
            var loading = lively.morphic.Text.makeLabel("Loading…", { fontSize: 11, textColor: Color.gray });
            container.addMorph(loading);
            loading.setPosition(lively.pt(x + COMMENT_INDENT, rowBottom + 6));
            loading.setExtent(lively.pt(Math.max(30, w - x - COMMENT_INDENT), 16));
            childrenBottom = rowBottom + 26;
          }
        }

        if (childrenBottom > rowBottom + 2) {
          var lineTop = topY + COMMENT_AVATAR + 2;
          var line = new lively.morphic.Box(lively.rect(0, 0, 2, Math.max(0, (childrenBottom - 6) - lineTop)));
          line.setFill(THREAD_LINE_COLOR);
          line.applyStyle({ borderWidth: 0 });
          container.addMorph(line);
          line.setPosition(lively.pt(x + COMMENT_AVATAR / 2 - 1, lineTop));
        }

        return childrenBottom + 10;
      },

      // A comment's body height is measured synchronously via
      // bodyNode.scrollHeight right after its HTML is set — but an <img>/
      // <video> inside it (pmNodeToHtml emits a real src= directly for a
      // public attachment, no placeholder step) has no intrinsic size until
      // the browser actually finishes loading it. Without this, every later
      // comment/reply in the tree stayed positioned off that (too-small)
      // measurement forever, so a reply with an image next to one with a
      // video — each resolving its real size at a different moment — went
      // from a smooth scroll to rows permanently overlapping, mistaken for
      // the panel "trying to fit everything together."
      //
      // Attaches a one-time load/error listener to any not-yet-loaded media
      // in this specific (freshly built, per _renderCommentNode's cache-miss
      // branch) bodyNode. `cached` is that reply's _bodyBoxCache entry —
      // updating cached.height in place, then scheduling a debounced
      // rebuild, means the *next* rebuild's cache-hit path (reusing this
      // same Box/DOM node rather than rebuilding it — see
      // _renderCommentNode) picks up the corrected height without ever
      // touching the media element again. That reuse is what makes this
      // safe to call only once per genuine content build: recreating a
      // <video> element restarts its whole load cycle from scratch even
      // against an already browser-cached URL (confirmed live via
      // chrome-devtools — three fresh <video>s against the same cached URL
      // each still took ~140-150ms to reach loadedmetadata), so an earlier
      // version of this fix that rebuilt indiscriminately on every load
      // event re-triggered itself forever instead of settling.
      _watchMediaLoad: function (bodyNode, cached) {
        var self = this;
        var media = bodyNode.querySelectorAll("img, video");
        Array.prototype.forEach.call(media, function (el) {
          var isLoaded = el.tagName === "IMG" ? el.complete : el.readyState >= 1;
          if (isLoaded) return;
          var settle = function () {
            cached.height = Math.max(14, bodyNode.scrollHeight);
            self._scheduleThreadRerender();
          };
          var readyEvt = el.tagName === "IMG" ? "load" : "loadedmetadata";
          el.addEventListener(readyEvt, settle, { once: true });
          el.addEventListener("error", settle, { once: true });
        });
      },

      _scheduleThreadRerender: function () {
        var self = this;
        if (this._threadRerenderTimer) return;
        this._threadRerenderTimer = setTimeout(function () {
          self._threadRerenderTimer = null;
          self._renderThreadTree();
        }, 60);
      },

      // A small icon(Material Symbols)+label affordance — the "Reply" and
      // "Replies"/"Hide replies" actions under each comment. Constructed at
      // (0,0) and positioned by the caller, matching this file's own
      // construct-then-addMorph-then-setPosition convention throughout.
      _buildIconLabel: function (glyph, label, color, onClick) {
        var w = Math.max(50, label.length * 6.2 + 26);
        var row = new lively.morphic.Box(lively.rect(0, 0, w, 16));
        row.applyStyle({ fill: null, borderWidth: 0 });

        var icon = new lively.morphic.Text(lively.rect(0, 0, 14, 14), glyph);
        icon.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: 10.5, textColor: color,
          fill: null, borderWidth: 0, allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        row.addMorph(icon);

        var text = lively.morphic.Text.makeLabel(label, { fontSize: 10.5, textColor: color, fontWeight: "600" });
        row.addMorph(text);
        text.setPosition(lively.pt(17, 1));
        text.setExtent(lively.pt(w - 17, 14));

        if (onClick) {
          row.onMouseDown = onClick;
          row.handStyle = "pointer";
          icon.eventsAreIgnored = true;
          text.eventsAreIgnored = true;
        }
        return row;
      },

      // Renders a "join the conversation" (key "ROOT") or per-comment reply
      // composer — a bordered, generously-rounded box with a multi-line
      // Lively Text input (the same allowInput technique the search field
      // above uses, not a raw <textarea>), a toolbar row (image/video are
      // wired to a real upload; GIF/text-format stay decorative — see this
      // file's own project memory), an attachment preview strip when
      // something is staged, and pill-shaped Cancel/Comment(Reply) buttons
      // on the right. Renders nothing (and returns y unchanged) for a
      // signed-out visitor, mirroring PostCardView.js's own reply-button
      // visibility gating. Draft text/attachment are kept in
      // this._draftText[key]/this._draftAttachment[key] across re-renders
      // so expanding an unrelated comment elsewhere in the tree doesn't
      // erase what's being composed here.
      _renderComposerIfSignedIn: function (container, key, parentObjId, x, y, w, placeholderText) {
        if (!lively.identity.did.currentUser() || !parentObjId) return y;
        var self = this;
        var isRoot = key === "ROOT";
        var PAD = 14, TOOLBAR_H = 30, BOTTOM_PAD = 12, PREVIEW_H = 48;
        var staged = this._draftAttachment[key];
        var H = (isRoot ? 112 : 100) + (staged ? PREVIEW_H : 0);
        var fieldH = H - PAD - TOOLBAR_H - BOTTOM_PAD - 6 - (staged ? PREVIEW_H : 0);
        var toolbarY = H - BOTTOM_PAD - TOOLBAR_H;

        var box = new lively.morphic.Box(lively.rect(0, 0, w, H));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(232, 73, 126), borderRadius: 16 });   // COMMENT_ACCENT (#e8497e)
        container.addMorph(box);
        box.setPosition(lively.pt(x, y));

        var placeholder = lively.morphic.Text.makeLabel(placeholderText, { fontSize: 12, textColor: Color.rgb(170, 170, 170) });
        placeholder.eventsAreIgnored = true;
        box.addMorph(placeholder);
        placeholder.setPosition(lively.pt(PAD, PAD - 2));
        placeholder.setExtent(lively.pt(w - PAD * 2, fieldH));

        var field = new lively.morphic.Text(lively.rect(PAD, PAD - 2, w - PAD * 2, fieldH), this._draftText[key] || "");
        field.applyStyle({ allowInput: true, fixedWidth: true, fixedHeight: true, fontSize: 12, fill: null, borderWidth: 0 });
        placeholder.setVisible(!field.textString);
        var superKeyDown = field.onKeyDown;
        field.onKeyDown = function (evt) {
          var result = superKeyDown.call(this, evt);
          self._draftText[key] = field.textString;
          placeholder.setVisible(!field.textString);
          return result;
        };
        box.addMorph(field);

        if (staged) this._renderAttachmentPreview(box, key, staged, PAD, PAD + fieldH + 4, w - PAD * 2, PREVIEW_H - 8);

        // Toolbar — image/video icons open a real file picker and upload
        // (see _promptFileUpload/_stageAttachmentUpload below); text-format
        // and GIF stay decorative for now. text_fields is the vendored
        // Material Symbols ligature for the reference composer's "Aa"
        // text-formatting glyph (renders as a stylized "Tt").
        //
        // Icon box sized generously taller than the target glyph, not
        // tight to it — same fontSize-is-pt-not-px clipping gotcha
        // AmbientPresencePanel.js's makeIconButton hit and fixed the same
        // way (CLAUDE.md's "fontSize on Text morphs is in points, not
        // pixels" section): a 16px real glyph needs fontSize 12
        // (16*0.75), and even then a box tightly sized to 16px clips the
        // bottom — GLYPH_BOX_H stays a few px taller with top padding to
        // compensate, instead of matching the target size 1:1.
        var GLYPH_PX = 16, GLYPH_FONT = GLYPH_PX * 0.75, GLYPH_BOX_H = 22;
        var toolbarX = PAD;
        // Text, Image, Video, GIF — explicit order per request, not the
        // order these happen to be easiest to group by type in, so icon
        // and label items are interleaved from one list instead of drawn
        // in two separate icons-then-labels passes.
        [
          { icon: "text_fields", w: 20 },
          { icon: "image", w: 20, upload: "image" },
          { icon: "play_circle", w: 20, upload: "video" },
          { label: "GIF", w: 28 },
        ].forEach(function (item) {
          if (item.icon) {
            var g = new lively.morphic.Text(lively.rect(0, 0, item.w, GLYPH_BOX_H), item.icon);
            g.applyStyle({
              fontFamily: "'Material Symbols Rounded'", fontSize: GLYPH_FONT, textColor: Color.rgb(150, 150, 150),
              fill: null, borderWidth: 0, allowInput: false, selectable: false, align: "center",
              padding: lively.Rectangle.inset(0, Math.round((GLYPH_BOX_H - GLYPH_PX) / 2), 0, 0),
              clipMode: "hidden", whiteSpaceHandling: "pre",
            });
            box.addMorph(g);
            g.setPosition(lively.pt(toolbarX, toolbarY + Math.round((TOOLBAR_H - GLYPH_BOX_H) / 2)));
            toolbarX += item.w + 8;
            if (item.upload) {
              g.handStyle = "pointer";
              g.onMouseDown = function () {
                if (self._draftAttachment[key]) return; // one attachment at a time
                self._promptFileUpload(item.upload, function (file) {
                  if (file) self._stageAttachmentUpload(key, file, item.upload);
                });
              };
            }
          } else {
            var lbl = lively.morphic.Text.makeLabel(item.label, { fontSize: 11.5, fontWeight: "700", textColor: Color.rgb(150, 150, 150) });
            box.addMorph(lbl);
            lbl.setPosition(lively.pt(toolbarX, toolbarY + 7));
            lbl.setExtent(lively.pt(item.w, 16));
            toolbarX += item.w + 6;
          }
        });

        var postLabel = isRoot ? "Comment" : "Reply";
        var postW = Math.max(56, postLabel.length * 7.5 + 32);
        var postBtn = new lively.morphic.Button(lively.rect(0, 0, postW, TOOLBAR_H));
        box.addMorph(postBtn);
        postBtn.setPosition(lively.pt(w - PAD - postW, toolbarY));
        this._paintPillButton(postBtn, {
          label: postLabel, fillCss: COMMENT_ACCENT, textColor: Color.rgb(255, 255, 255), radius: TOOLBAR_H / 2,
        });

        var sending = false;
        postBtn.onMouseDown = function () {
          if (sending) return;
          var text = (field.textString || "").trim();
          var attachment = self._draftAttachment[key];
          if (attachment && attachment.uploading) return; // wait for the upload to finish
          if (!text && !attachment) return;
          sending = true;
          self._paintPillButton(postBtn, { label: "Sending…", fillCss: COMMENT_ACCENT, textColor: Color.rgb(255, 255, 255), radius: TOOLBAR_H / 2 });
          self._submitReply(parentObjId, text, attachment, function (err) {
            sending = false;
            if (err) {
              self._paintPillButton(postBtn, { label: postLabel, fillCss: COMMENT_ACCENT, textColor: Color.rgb(255, 255, 255), radius: TOOLBAR_H / 2 });
              return self._showError("Could not send reply: " + err.message);
            }
            delete self._draftText[key];
            delete self._draftAttachment[key];
            if (!isRoot) self._replyBoxOpenFor = null;
            self._reloadAfterReply(parentObjId);
          });
        };

        if (!isRoot) {
          var cancelW = 64;
          var cancelBtn = new lively.morphic.Button(lively.rect(0, 0, cancelW, TOOLBAR_H));
          box.addMorph(cancelBtn);
          cancelBtn.setPosition(lively.pt(w - PAD - postW - 8 - cancelW, toolbarY));
          this._paintPillButton(cancelBtn, {
            label: "Cancel", fillCss: "rgb(244,244,245)", textColor: Color.rgb(80, 80, 80), radius: TOOLBAR_H / 2,
            borderCss: "1px solid rgb(224,224,224)",
          });
          cancelBtn.onMouseDown = function () {
            self._replyBoxOpenFor = null;
            self._renderThreadTree();
          };
        }

        return y + H;
      },

      // Button.setFill/setBorderColor/applyStyle({fill:...}) silently don't
      // reach the DOM for a Button created procedurally (`new
      // lively.morphic.Button(...)` + addMorph, as opposed to one declared
      // in a BuildSpec's static submorphs array) — confirmed in
      // feedback_morph_dialog_baseline_polish's PublishToInventoryDialog.js
      // finding. That finding's own verified-working fix (style the
      // shapeNode's DOM directly for background/border, but use the
      // label's own normal setTextColor for text color — an ordinary Text
      // morph setter, unaffected by the Button-specific bug) is reused here
      // rather than the untested guess of letting a color style cascade
      // down from the outer node. WalletSetupDialog.js's _paintToggleButton
      // is the reference implementation this mirrors. Re-callable any time
      // a button's label text changes (e.g. "Sending…"), since setLabel
      // rebuilds the label morph and drops any earlier color set on it.
      _paintPillButton: function (btn, opts) {
        btn.setLabel(opts.label);
        var node = btn.renderContext && btn.renderContext().shapeNode;
        if (node) {
          node.style.background = opts.fillCss;
          node.style.border = opts.borderCss || "none";
          node.style.borderRadius = opts.radius + "px";
        }
        if (btn.label) {
          if (btn.label.setTextColor) btn.label.setTextColor(opts.textColor);
          if (btn.label.applyStyle) btn.label.applyStyle({ fontWeight: "600" });
        }
      },

      // A hidden native <input type=file>, appended to document.body and
      // removed right after use — same construction PostCardEditor.js's own
      // _promptAttachment uses for its 📎 toolbar button (confirmed via
      // project research before writing this). A file picker doesn't need
      // real keyboard focus the way a text field does, but appending to
      // document.body rather than nesting in a morph's shapeNode still
      // matches this file's own "dialog overlay -> document.body" CLAUDE.md
      // convention regardless. kind is "image" or "video", used only to
      // set the file input's accept filter.
      _promptFileUpload: function (kind, thenDo) {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = kind === "video" ? "video/*" : "image/*";
        input.style.display = "none";
        document.body.appendChild(input);
        input.addEventListener("change", function () {
          var file = input.files && input.files[0];
          if (input.parentNode) input.parentNode.removeChild(input);
          thenDo(file || null);
        });
        input.click();
      },

      // Uploads a file the same way ProfileCard.js's avatar upload and
      // PostCardEditor.js's _uploadAttachment do for a PUBLIC attachment —
      // fileCrypto.encryptAndUpload skips the KEK/passkey ceremony entirely
      // for visibility:"public" (dek/blobNonce come back null), and the
      // resulting blob is fetchable at a plain, permanent URL
      // (baseUrl()+"/@handle/blobs/"+blobCid — same _publicBlobUrl formula
      // PostCardEditor.js uses), so the ProseMirror node can carry a real
      // `src` immediately instead of the objId+placeholder scheme
      // encrypted/private attachments need (see PostCardUtils.js's
      // pmNodeToHtml image/video cases — src-present skips the placeholder
      // path entirely).
      _uploadPublicAttachment: function (file, kind, thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error("Not signed in."));
        lively.require("lively.identity.FileCrypto").toRun(function () {
          lively.identity.fileCrypto.encryptAndUpload(file, { visibility: "public", name: file.name }, function (err, result) {
            if (err) return thenDo(err);
            var base = lively.identity.did.baseUrl();
            var url = base + "/@" + encodeURIComponent(user.handle) + "/blobs/" + encodeURIComponent(result.blobCid);
            thenDo(null, {
              kind: kind, url: url, name: file.name,
              entry: {
                objId: result.objId, dek: null, blobCid: result.blobCid, blobNonce: null,
                name: file.name, mime: file.type || "application/octet-stream",
              },
            });
          });
        });
      },

      // Marks the composer as "uploading" immediately (re-rendering so the
      // preview strip shows a spin-ish status line right away), then swaps
      // in the real staged attachment once the upload resolves — or clears
      // it and surfaces the error if it fails. One attachment at a time per
      // composer (the icon handlers already guard against a second pick
      // while one is in flight).
      _stageAttachmentUpload: function (key, file, kind) {
        var self = this;
        this._draftAttachment[key] = { uploading: true, kind: kind, name: file.name };
        this._renderThreadTree();
        this._uploadPublicAttachment(file, kind, function (err, staged) {
          if (err) {
            delete self._draftAttachment[key];
            self._showError("Could not upload " + kind + ": " + err.message);
            self._renderThreadTree();
            return;
          }
          self._draftAttachment[key] = staged;
          self._renderThreadTree();
        });
      },

      // A small strip between the text field and the toolbar: an image
      // thumbnail (a real lively.morphic.Image, since the src is already a
      // plain fetchable URL) or a video filename chip, plus a "✕" to drop
      // it before sending. Shows an "Uploading…" status label instead
      // while staged.uploading is true.
      _renderAttachmentPreview: function (box, key, staged, x, y, w, h) {
        var self = this;
        var strip = new lively.morphic.Box(lively.rect(0, 0, w, h));
        strip.applyStyle({ fill: Color.rgb(245, 245, 247), borderWidth: 0, borderRadius: 8 });
        box.addMorph(strip);
        strip.setPosition(lively.pt(x, y));

        if (staged.uploading) {
          var uploading = lively.morphic.Text.makeLabel(
            "Uploading " + staged.kind + "…", { fontSize: 11.5, textColor: Color.rgb(130, 130, 130) });
          strip.addMorph(uploading);
          uploading.setPosition(lively.pt(10, Math.round((h - 16) / 2)));
          uploading.setExtent(lively.pt(w - 20, 16));
          return;
        }

        if (staged.kind === "image") {
          var thumb = new lively.morphic.Image(lively.rect(0, 0, h - 12, h - 12));
          thumb.setImageURL(staged.url);
          thumb.applyStyle({ borderRadius: 4, borderWidth: 0, clipMode: "hidden" });
          strip.addMorph(thumb);
          thumb.setPosition(lively.pt(6, 6));
        } else {
          var vicon = new lively.morphic.Text(lively.rect(0, 0, h - 12, h - 12), "movie");
          vicon.applyStyle({
            fontFamily: "'Material Symbols Rounded'", fontSize: (h - 12) * 0.75 * 0.7, textColor: Color.rgb(130, 130, 130),
            fill: null, borderWidth: 0, allowInput: false, selectable: false, align: "center",
            clipMode: "hidden", whiteSpaceHandling: "pre",
          });
          strip.addMorph(vicon);
          vicon.setPosition(lively.pt(6, 6));
        }

        var name = lively.morphic.Text.makeLabel(staged.name || "", {
          fontSize: 11.5, textColor: Color.rgb(80, 80, 80),
        });
        strip.addMorph(name);
        name.setPosition(lively.pt(h + 4, Math.round((h - 16) / 2)));
        name.setExtent(lively.pt(w - h - 34, 16));

        var remove = lively.morphic.Text.makeLabel("✕", { fontSize: 12, textColor: Color.rgb(150, 150, 150) });
        strip.addMorph(remove);
        remove.setPosition(lively.pt(w - 24, Math.round((h - 16) / 2)));
        remove.setExtent(lively.pt(16, 16));
        remove.handStyle = "pointer";
        remove.onMouseDown = function () {
          delete self._draftAttachment[key];
          self._renderThreadTree();
        };
      },

      // Builds a minimal one- or two-node plain postcard (no title prompt,
      // no rich formatting — the point of the inline box, vs. the full
      // PostCardEditor reply flow every other "Reply" affordance in the app
      // uses) threaded under parentObjId via the same replyTo field every
      // reply already rides on. attachment is the staged {kind, url, name,
      // entry} from _uploadPublicAttachment, or null for a text-only
      // comment — when present, its ProseMirror node goes first (image or
      // video, matching PostCardEditor.js's _insertAttachmentImage/-Video
      // node shape) and its entry is carried in payload.attachments so a
      // future edit/re-render has the full metadata, not just the URL.
      // Same serialize-then-PUT sequence as _sendWelcomeCard/_requestJoin
      // above.
      _submitReply: function (parentObjId, text, attachment, thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error("Not signed in."));
        var self = this;
        // Text goes first — a reply's caption belongs above whatever it's
        // captioning, not buried under an image/video/gif.
        var content = [];
        if (text) content.push({ type: "paragraph", content: [{ type: "text", text: text }] });
        if (attachment) {
          // Schema note (PostCardEditor.js's ProseMirror schema,
          // confirmed by reading it): image is `group:'inline'`, so it
          // must sit inside a paragraph's content array like any other
          // inline node — a bare image can't be a direct doc.content
          // child. video is `group:'block'`, atom:true, so it's the
          // opposite: a direct doc.content sibling, never paragraph-wrapped.
          if (attachment.kind === "image") {
            content.push({
              type: "paragraph",
              content: [{ type: "image", attrs: { src: attachment.url, alt: attachment.name, title: attachment.name, objId: attachment.entry.objId } }],
            });
          } else {
            content.push({ type: "video", attrs: { src: attachment.url, objId: attachment.entry.objId } });
          }
        }
        if (!content.length) return thenDo(new Error("Nothing to post"));
        var doc = { type: "doc", content: content };
        lively.require("lively.identity.PostCardSerializer").toRun(function () {
          lively.identity.postCardSerializer.serializePlainToEnvelope({
            doc: doc,
            constellation: self._name,
            visibility: "public",
            attachments: attachment ? [attachment.entry] : [],
            replyTo: { objId: parentObjId, anchor: null },
          }, function (err, envelope) {
            if (err) return thenDo(err);
            var base = lively.identity.did.baseUrl();
            var xhr = new XMLHttpRequest();
            xhr.open("PUT", base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(envelope.objId), true);
            xhr.withCredentials = true;
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.onload = function () {
              if (xhr.status !== 200) return thenDo(new Error("save failed (" + xhr.status + ")"));
              thenDo(null);
            };
            xhr.onerror = function () { thenDo(new Error("network error")); };
            xhr.send(JSON.stringify(envelope));
          });
        });
      },

      // Refreshes just the level a new reply landed in — the root thread if
      // it was posted from the top composer, or a specific comment's
      // (auto-expanded, so the new reply is immediately visible) children
      // otherwise — rather than reloading the whole tree.
      _reloadAfterReply: function (parentObjId) {
        var self = this;
        if (parentObjId === this._threadRootObjId) {
          this._loadReplyLevel(parentObjId, function (err, replies) {
            self._threadReplies = err ? [] : replies;
            self._renderThreadTree();
          });
        } else {
          this._threadExpanded[parentObjId] = true;
          this._loadReplyLevel(parentObjId, function (err, children) {
            self._threadChildrenCache[parentObjId] = err ? [] : children;
            self._renderThreadTree();
          });
        }
      },

      _formatRelativeTime: function (iso) {
        if (!iso) return "";
        var d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        var diffSec = Math.max(0, (Date.now() - d.getTime()) / 1000);
        var mins = diffSec / 60, hours = mins / 60, days = hours / 24;
        if (diffSec < 60) return "just now";
        if (mins < 60) return Math.floor(mins) + "m";
        if (hours < 24) return Math.floor(hours) + "h";
        if (days < 30) return Math.floor(days) + "d";
        if (days < 365) return Math.floor(days / 30) + "mo";
        return Math.floor(days / 365) + "y";
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
        var bots = qi.bots || [];
        var coCreator = qi.createdBy;
        var moderators = controllers.filter(function (did) { return did !== coCreator; });
        var plainMembers = members.filter(function (did) {
          return controllers.indexOf(did) === -1 && bots.indexOf(did) === -1;
        });
        var w = this._membersBox.getExtent().x;

        var y = 4;
        y = this._renderMemberSection(w, y, "CO-CREATOR", [coCreator].filter(Boolean), handles,
          Color.rgb(46, 125, 50), Color.rgb(232, 245, 233), "co-creator");
        y = this._renderMemberSection(w, y, "BOTS", bots, handles,
          Color.rgb(69, 90, 100), Color.rgb(236, 239, 241), "bot");
        y = this._renderMemberSection(w, y, "MODERATORS", moderators, handles,
          Color.rgb(138, 109, 0), Color.rgb(255, 248, 225), "moderator");
        this._renderMemberSection(w, y, "ACTIVE MEMBERS", plainMembers.filter(this._isOnline.bind(this)), handles, null, null, null);
        this._disableDragging(this._membersBox);
      },

      _isOnline: function (did) { return !!this._presenceByDid[did]; },

      _renderMemberSection: function (w, y, label, dids, handles, badgeColor, badgeBg, badgeText) {
        if (!dids.length) return y;
        var self = this;
        // The box's CSS padding (set in _buildChrome) doesn't actually
        // offset these morphs — Lively positions submorphs as plain pixel
        // coordinates from the box's own origin, not its CSS padding box
        // (confirmed live: the avatar rendered flush against the panel's
        // border with zero gap despite the padding style being set). Bake
        // the inset into the geometry here instead.
        var PAD_X = 10;
        var w2 = w - PAD_X * 2;

        var header = lively.morphic.Text.makeLabel(label, { fontSize: 10, textColor: Color.rgb(153, 153, 153) });
        header.setPosition(lively.pt(PAD_X, y));
        header.setExtent(lively.pt(w2, 14));
        this._membersBox.addMorph(header);
        y += 20;

        dids.forEach(function (did) {
          var handle = handles[did] || (did.slice(0, 10) + "…");
          var row = new lively.morphic.Box(lively.rect(PAD_X, y, w2, 26));
          row.applyStyle({ fill: null, borderWidth: 0 });

          // Text morphs don't render their glyph vertically centered in
          // their own box (same gotcha as the "+ Postcard" pill's label) —
          // confirmed live, the name's actual glyph center sat ~3px below
          // the avatar's geometric center even though both boxes were
          // set to the same nominal middle. Nudging the avatar down those
          // 3px, rather than fighting the text's rendering, is what
          // actually lines the two up.
          var avatar = new lively.morphic.Image(lively.rect(0, 4, 22, 22));
          avatar.setImageURL(lively.identity.postCardUtils.identiconDataUrl(did, 22));
          avatar.applyStyle({ borderRadius: 11, borderWidth: 0, clipMode: "hidden" });
          row.addMorph(avatar);

          var nameW = badgeColor ? (w2 - 30 - 70) : (self._isOnline(did) ? (w2 - 30 - 12) : (w2 - 30));
          var nameT = lively.morphic.Text.makeLabel("@" + handle, { fontSize: 12 });
          nameT.setPosition(lively.pt(28, 4));
          nameT.setExtent(lively.pt(Math.max(30, nameW), 16));
          row.addMorph(nameT);

          if (badgeColor) {
            var badge = new lively.morphic.Box(lively.rect(w2 - 66, 3, 62, 18));
            badge.setFill(badgeBg);
            badge.applyStyle({ borderWidth: 0, borderRadius: 9 });
            var badgeT = lively.morphic.Text.makeLabel(badgeText, { fontSize: 9, textColor: badgeColor });
            badgeT.setPosition(lively.pt(6, 3));
            badgeT.setExtent(lively.pt(52, 12));
            badge.addMorph(badgeT);
            row.addMorph(badge);
          } else if (self._isOnline(did)) {
            var dot = new lively.morphic.Box(lively.rect(w2 - 14, 8, 8, 8));
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

          self._publishPresence();
          // BUG FIX: DID.js's own boot-time restoreSession() (an async
          // fetch chain — loadMeta, loadDocument, then a server round trip)
          // can still be in flight when this runs — this route's own
          // space-token fetch and restoreSession's chain finish at
          // comparable times with no ordering guarantee between them
          // (confirmed live: with restoreSession's server round trip
          // artificially slowed, this handler ran with currentUser() still
          // null and published presence as {did:null,handle:"anonymous"}).
          // Since _onAwarenessChange's `if (presence && presence.did)`
          // guard then silently drops that entry, and nothing here ever
          // republished it afterward, a signed-in visitor who merely lost
          // this race never showed up in anyone's Active Members list for
          // their whole visit. Same race Shop.js's _bindIdentity documents
          // and fixes the same way: listen for identityChanged in case it
          // fires later, AND re-call restoreSession (idempotent) to get a
          // definitive answer regardless of whether the signal already
          // fired before this connected.
          self._identityConnection = lively.bindings.connect(
            lively.identity.did, "identityChanged", self, "_publishPresence");
          lively.identity.did.restoreSession(function () { self._publishPresence(); });

          var awareness = self.wsProvider.awareness;
          awareness.on("change", function () { self._onAwarenessChange(); });
        };
        tokenXhr.onerror = function () {};
        tokenXhr.send();
      },

      _publishPresence: function () {
        if (!this.wsProvider) return;
        var user = lively.identity.did.currentUser();
        this.wsProvider.awareness.setLocalStateField("presence", {
          did: user && user.did,
          handle: (user && user.handle) || "anonymous",
        });
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
        items.push(["Open wiki", function () {
          window.location.href = "/c/" + encodeURIComponent(self._name) + "/wiki";
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
