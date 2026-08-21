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
 *   - an embedded wiki panel (most-recently-updated page, with an inline
 *     list of every published page as click-to-open pills and "+ New wiki
 *     page" for members) extending to the page bottom, right of the reel
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

    // Comment thread (Reddit-style, no votes) geometry/palette.
    var COMMENT_INDENT = 30;   // px per nesting depth
    var COMMENT_AVATAR = 22;   // px, square
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

        this._wikiPages = [];
        this._wikiPagesFiltered = null;
        this._activeWikiObjId = null;

        this._threadRootObjId = null;
        this._threadReplies = [];
        this._threadChildrenCache = {};
        this._threadExpanded = {};
        this._replyBoxOpenFor = null;   // objId of the comment whose inline reply box is open, "ROOT" for the top composer, or null
        this._draftText = {};           // same keys as above -> in-progress composer text, kept across re-renders
        this._draftAttachment = {};     // same keys -> {uploading:true} while in flight, else {kind, url, name, entry}
        this._didHandleCache = {};      // did -> handle, for authors not already in quickInfo.memberHandles

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

        this._ensureCommentBodyStyle();

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

        this._wikiPagesRow = new lively.morphic.Box(lively.rect(0, 4, 10, 24));
        this._wikiPagesRow.applyStyle({ fill: null, borderWidth: 0 });
        this._wikiPagesRow.renderContext().shapeNode.style.overflowX = "auto";
        this._wikiPagesRow.renderContext().shapeNode.style.whiteSpace = "nowrap";
        this._wikiHeaderBox.addMorph(this._wikiPagesRow);

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
          ".lounge-comment-body p:last-child{margin-bottom:0;}";
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
        (container.submorphs || []).slice().forEach(function (m) { m.remove(); });
        var w = container.getExtent().x || CARD_W;

        var y = this._renderComposerIfSignedIn(
          container, "ROOT", this._threadRootObjId, 0, 0, w, "Start conversation");
        y += 10;

        if (!this._threadReplies.length) {
          var empty = lively.morphic.Text.makeLabel("No comments yet — be the first to reply.", { fontSize: 12, textColor: Color.gray });
          empty.setPosition(lively.pt(0, y));
          empty.setExtent(lively.pt(w, 16));
          container.addMorph(empty);
        } else {
          this._renderCommentLevel(container, this._threadReplies, 0, y, w);
        }
        this._disableDragging(container);
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
        var x = depth * COMMENT_INDENT;
        var rowW = w - x;
        var topY = y;

        var avatar = new lively.morphic.Image(lively.rect(0, 0, COMMENT_AVATAR, COMMENT_AVATAR));
        avatar.setImageURL(lively.identity.postCardUtils.identiconDataUrl(reply.did, COMMENT_AVATAR));
        avatar.applyStyle({ borderRadius: COMMENT_AVATAR / 2, borderWidth: 0, clipMode: "hidden" });
        container.addMorph(avatar);
        avatar.setPosition(lively.pt(x, y));

        var textX = x + COMMENT_AVATAR + 8;
        var textW = Math.max(60, rowW - COMMENT_AVATAR - 8);

        var header = lively.morphic.Text.makeLabel(
          "@" + (reply._handle || (reply.did || "").slice(0, 10) + "…") + "  ·  " + self._formatRelativeTime(reply.created),
          { fontSize: 10.5, textColor: COMMENT_META_COLOR });
        container.addMorph(header);
        header.setPosition(lively.pt(textX, y + 2));
        header.setExtent(lively.pt(textW, 14));

        var bodyBox = new lively.morphic.Box(lively.rect(0, 0, textW, 10));
        bodyBox.applyStyle({ fill: null, borderWidth: 0 });
        container.addMorph(bodyBox);
        bodyBox.setPosition(lively.pt(textX, y + 20));
        var bodyNode = bodyBox.renderContext().shapeNode;
        bodyNode.className = (bodyNode.className ? bodyNode.className + " " : "") + "lounge-comment-body";
        bodyNode.innerHTML = reply._bodyHtml || "";
        // Measure-the-real-DOM, same technique as this file's own text-
        // sizing convention elsewhere — the body's height genuinely depends
        // on its (rich, possibly multi-paragraph) content, not a guessed
        // constant, so it's read back off the live node after the HTML and
        // width are both already set.
        var bodyH = Math.max(14, bodyNode.scrollHeight);
        bodyBox.setExtent(lively.pt(textW, bodyH));
        lively.identity.postCardUtils.hydrateEmbeddedParts(bodyNode);

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
          rowBottom = self._renderComposerIfSignedIn(
            container, reply.objId, reply.objId, textX, rowBottom, w - textX,
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
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(224, 224, 224), borderRadius: 16 });
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
        var content = [];
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
        if (text) content.push({ type: "paragraph", content: [{ type: "text", text: text }] });
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

      // Renders every matching page as a click-to-open pill in a horizontally
      // scrolling row, left of "+ New page" — the full list is always
      // visible (no menu to open first), and the active page's pill is
      // highlighted.
      _renderWikiHeader: function (filterQuery) {
        var self = this;
        var pages = this._wikiPages;
        if (filterQuery) {
          var q = filterQuery.toLowerCase();
          pages = pages.filter(function (p) { return (p.wikiName || "").toLowerCase().indexOf(q) !== -1; });
        }
        this._wikiPagesFiltered = pages;

        var row = this._wikiPagesRow;
        (row.submorphs || []).slice().forEach(function (m) { m.remove(); });

        var headerW = this._wikiHeaderBox.getExtent().x || 200;
        var newBtnW = this._wikiNewBtn.getExtent().x || 100;
        var rowW = Math.max(40, headerW - newBtnW - 10);
        row.setExtent(lively.pt(rowW, 24));
        this._wikiNewBtn.setPosition(lively.pt(rowW + 10, 4));

        if (!pages.length) {
          var empty = lively.morphic.Text.makeLabel("(no pages)", { fontSize: 12, textColor: Color.gray });
          empty.setPosition(lively.pt(0, 3));
          row.addMorph(empty);
        } else {
          var x = 0;
          pages.forEach(function (p) {
            var isActive = p.objId === self._activeWikiObjId;
            var w = Math.max(30, p.wikiName.length * 7 + 16);
            var pillBox = new lively.morphic.Box(lively.rect(x, 0, w, 22));
            pillBox.setFill(isActive ? Color.rgb(53, 83, 255) : Color.rgb(240, 240, 240));
            pillBox.applyStyle({ borderWidth: 0, borderRadius: 11 });
            pillBox.onMouseDown = function () { self._openWikiPage(p.objId); };
            var pillLabel = lively.morphic.Text.makeLabel(p.wikiName, {
              fontSize: 12, textColor: isActive ? Color.white : Color.rgb(51, 51, 51),
            });
            pillLabel.setPosition(lively.pt(8, 3));
            pillLabel.setExtent(lively.pt(w - 8, 16));
            pillLabel.eventsAreIgnored = true;
            pillBox.addMorph(pillLabel);
            row.addMorph(pillBox);
            x += w + 6;
          });
        }
        this._wikiNewBtn.setVisible(!!this._canWrite);
        this._disableDragging(this._wikiHeaderBox);
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
