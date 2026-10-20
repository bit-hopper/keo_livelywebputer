/**
 * lively.ide.tools.SearchPalette
 *
 * The floating search palette (search.md): a glass panel under the menu bar
 * over a lightly dimmed world, with a field, scope pills and a hint footer.
 *
 * Plain imperative morphic construction (handlers are ordinary closures, none
 * is reconstructed from source text, so the BuildSpec/addScript closure-loss
 * gotcha does not apply). Result items come from lively.ide.tools.Search.
 */

module("lively.ide.tools.SearchPalette")
  .requires("lively.morphic.Complete", "lively.identity.HomestarUI", "lively.ide.tools.Search")
  .toRun(function () {

    var ACCENT = Color.rgb(240, 26, 105);
    var ACCENT_TEXT = Color.rgb(200, 15, 85);
    var INK = Color.rgb(42, 36, 56);
    var MUTED = Color.rgb(122, 115, 144);
    var HAIRLINE = Color.rgba(30, 24, 44, 0.08);

    var MAX_W = 940;
    var TOP = 52;               // below the menu bar
    var MAX_H = 560;
    var FIELD_H = 56;
    var PILLS_H = 44;
    var FOOTER_H = 36;
    var PILL_H = 28;
    var SIDE = 20;

    var FONT = "'Atkinson Hyperlegible', Helvetica, Arial, sans-serif";

    // The input's editable div gets the browser's focus ring (a black box inside
    // the field); the field has its own look, so drop it.
    function ensureStyle() {
      if (document.getElementById("search-palette-style")) return;
      var st = document.createElement("style");
      st.id = "search-palette-style";
      st.textContent = ".search-palette-input, .search-palette-input * { outline: none !important; }";
      document.head.appendChild(st);
    }

    var SCOPES = [
      { id: "all", label: "All" },
      { id: "morphs", label: "Morphs" },
      { id: "worlds", label: "Worlds" },
      { id: "code", label: "Code" },
      { id: "files", label: "Files" },
    ];

    function noDrag(m) { return lively.identity.HomestarUI.noDrag(m); }

    function box(rect, fill) {
      var b = new lively.morphic.Box(rect);
      b.applyStyle({ fill: fill || null, borderWidth: 0 });
      return noDrag(b);
    }

    // A one-line label. Decorative unless opts.clickable.
    function label(rect, text, opts) {
      opts = opts || {};
      var t = new lively.morphic.Text(rect);
      t.textString = text;
      t.applyStyle({
        fontSize: (opts.px || 13) * 0.75,
        fontWeight: opts.bold ? "bold" : "normal",
        textColor: opts.color || INK,
        fontFamily: opts.family || FONT,
        fill: null, borderWidth: 0, borderColor: null,
        align: opts.align || "left",
        allowInput: false, selectable: false,
        clipMode: "hidden",
        whiteSpaceHandling: "pre",
      });
      noDrag(t);
      t.eventsAreIgnored = true;
      return t;
    }

    function icon(rect, glyph, px, color) {
      return label(rect, glyph, { px: px, color: color, family: "'Material Symbols Rounded'", align: "center" });
    }

    lively.ide.tools.SearchPalette = {

      current: null,

      isOpen: function () { return !!lively.ide.tools.SearchPalette.current; },

      toggle: function () {
        var P = lively.ide.tools.SearchPalette;
        if (P.isOpen()) P.close(); else P.open();
      },

      close: function () {
        var P = lively.ide.tools.SearchPalette, s = P.current;
        if (!s) return;
        P.current = null;
        s.closed = true;
        lively.identity.HomestarUI.closeScrim(s.scrim);
      },

      open: function () {
        var P = lively.ide.tools.SearchPalette,
          UI = lively.identity.HomestarUI,
          Search = lively.ide.tools.Search;
        if (P.current) return P.current;

        var s = (P.current = {
          scopeIndex: 0,
          query: "",
          items: Search.worldItems(),   // live morphs; saved-world items join later
          closed: false,
        });

        function geometry() {
          var vw = document.documentElement.clientWidth - 1;
          var w = Math.min(MAX_W, vw - 24);
          var h = Math.min(MAX_H, window.innerHeight - TOP - 24);
          return { w: w, h: h, x: Math.round((vw - w) / 2), y: TOP };
        }
        var g = geometry();

        var scrim = (s.scrim = UI.viewportScrim(function () { layout(); }));
        scrim.applyStyle({ fill: Color.rgba(30, 24, 44, 0.22) });
        // Judge "on the panel" on the real node; the panel itself has no mouse
        // handler, so a click on a row/pill reaches that child (capture-first
        // dispatch -- CLAUDE.md "A modal scrim must not claim clicks...").
        scrim.onMouseUp = function (evt) {
          if (UI.pointOnPanel(panel, evt)) return false;
          evt.stop();
          P.close();
          return true;
        };

        var panel = (s.panel = box(lively.rect(g.x, g.y, g.w, g.h), Color.rgba(255, 255, 255, 0.8)));
        panel.applyStyle({ borderRadius: 22, clipMode: "hidden" });
        scrim.addMorph(panel);
        var pn = panel.renderContext().shapeNode;
        pn.style.backdropFilter = pn.style.webkitBackdropFilter = "blur(24px) saturate(180%)";
        pn.style.boxShadow =
          "inset 0 0 0 1px rgba(30,24,44,0.08), 0 24px 60px rgba(240,26,105,0.14), 0 8px 24px rgba(30,24,44,0.12)";

        // ---- field row
        s.searchGlyph = icon(lively.rect(SIDE, 14, 28, 28), "search", 22, ACCENT);
        panel.addMorph(s.searchGlyph);

        var input = (s.input = new lively.morphic.Text(lively.rect(SIDE + 36, 14, g.w - SIDE * 2 - 36 - 56, 28)));
        input.applyStyle({
          fontFamily: FONT, fontSize: 17 * 0.75, textColor: INK, fill: null, borderWidth: 0, borderColor: null,
          fixedWidth: true, fixedHeight: true, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        input.textString = "";
        input.beInputLine();
        noDrag(input);
        panel.addMorph(input);
        ensureStyle();
        input.renderContext().shapeNode.classList.add("search-palette-input");
        input.renderContext().shapeNode.style.caretColor = ACCENT.toString();

        s.placeholder = label(lively.rect(SIDE + 36 + 4, 14, 400, 28), "Search morphs, worlds, code, files", {
          px: 17, color: Color.rgba(122, 115, 144, 0.75),
        });
        panel.addMorph(s.placeholder);
        // eventsAreIgnored is only Lively-level; a covering label must also let the
        // browser's own click-to-focus through to the input beneath.
        s.placeholder.renderContext().shapeNode.style.pointerEvents = "none";

        s.escTag = box(lively.rect(g.w - SIDE - 36, 16, 36, 24), Color.rgba(30, 24, 44, 0.06));
        s.escTag.applyStyle({ borderRadius: 8 });
        s.escTag.addMorph(label(lively.rect(0, 3, 36, 18), "esc", { px: 11, color: MUTED, align: "center" }));
        panel.addMorph(s.escTag);

        // ---- scope pills
        s.pills = SCOPES.map(function (scope, i) {
          var pill = box(lively.rect(0, FIELD_H + (PILLS_H - PILL_H) / 2, 60, PILL_H));
          pill.applyStyle({ borderRadius: PILL_H / 2 });
          pill.eventsAreIgnored = false;
          pill.handStyle = "pointer";
          pill._label = label(lively.rect(0, 5, 60, 18), scope.label, { px: 12, align: "center", bold: true });
          pill.addMorph(pill._label);
          pill.onMouseDown = function (evt) { evt.stop(); return true; };   // keep focus in the field
          pill.onMouseUp = function (evt) {
            P.setScope(i);
            evt.stop();
            return true;
          };
          panel.addMorph(pill);
          var pnode = pill.renderContext().shapeNode;
          pnode.setAttribute("role", "button");
          pnode.setAttribute("aria-label", "Search scope: " + scope.label);
          return pill;
        });

        // ---- dividers, body, footer
        s.divTop = box(lively.rect(0, FIELD_H, g.w, 1), HAIRLINE);
        s.divPills = box(lively.rect(0, FIELD_H + PILLS_H, g.w, 1), HAIRLINE);
        s.divFooter = box(lively.rect(0, g.h - FOOTER_H, g.w, 1), HAIRLINE);
        panel.addMorph(s.divTop);
        panel.addMorph(s.divPills);
        panel.addMorph(s.divFooter);

        // Texts that layout() moves are built at (0,0): a Text built at rect(x,y) and
        // later moved with setPosition ends up offset twice (shape node + wrapper).
        s.bodyTitle = label(lively.rect(0, 0, 400, 18), "", { px: 11, bold: true, color: MUTED });
        s.bodyHint = label(lively.rect(0, 0, 400, 18), "", { px: 13, color: MUTED });
        panel.addMorph(s.bodyTitle);
        panel.addMorph(s.bodyHint);

        s.footer = label(lively.rect(0, 0, 500, 18), "↑↓ navigate      ↵ show halo      tab scope      esc close", {
          px: 11, color: MUTED,
        });
        panel.addMorph(s.footer);

        // ---- keys. Plain DOM listeners, not the Text morph's own onKeyDown/onKeyUp:
        // Lively routes key events to its "focused morph", which can lag behind real
        // DOM focus right after opening, so keys typed at once were dropped (the text
        // landed in the field but the palette never saw it). The DOM's own `input`
        // event fires whenever the field's text changes, however it changed.
        var inputNode = input.renderContext().shapeNode;
        inputNode.addEventListener("input", function () { P.setQuery(inputNode.textContent); });
        panel.renderContext().shapeNode.addEventListener("keydown", function (evt) {
          if (evt.key === "Escape") {
            evt.preventDefault(); evt.stopPropagation();
            P.close();
          } else if (evt.key === "Tab") {
            evt.preventDefault(); evt.stopPropagation();
            P.setScope((s.scopeIndex + (evt.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length);
          }
        }, true);

        function layout() {
          if (s.closed) return;
          var g = geometry();
          panel.setExtent(lively.pt(g.w, g.h));
          panel.setPosition(lively.pt(g.x, g.y));
          input.setExtent(lively.pt(g.w - SIDE * 2 - 36 - 56, 28));
          s.escTag.setPosition(lively.pt(g.w - SIDE - 36, 16));
          s.divTop.setExtent(lively.pt(g.w, 1));
          s.divPills.setExtent(lively.pt(g.w, 1));
          s.divFooter.setExtent(lively.pt(g.w, 1));
          s.divFooter.setPosition(lively.pt(0, g.h - FOOTER_H));
          s.footer.setPosition(lively.pt(SIDE, g.h - FOOTER_H + 9));
          s.bodyTitle.setPosition(lively.pt(SIDE, FIELD_H + PILLS_H + 14));
          s.bodyHint.setPosition(lively.pt(SIDE, FIELD_H + PILLS_H + 40));
        }
        s.layout = layout;
        layout();

        // Early keystrokes must not be lost: take focus right away.
        input.focus();
        P.refresh();

        // Saved-world rows join when the listing returns.
        Search.savedWorldItems(function (saved) {
          if (s.closed || !saved.length) return;
          s.items = s.items.concat(saved);
          P.refresh();
        });
        return s;
      },

      setScope: function (i) {
        var s = lively.ide.tools.SearchPalette.current;
        if (!s) return;
        s.scopeIndex = i;
        lively.ide.tools.SearchPalette.refresh();
      },

      setQuery: function (q) {
        var s = lively.ide.tools.SearchPalette.current;
        if (!s || s.query === q) return;
        s.query = q;
        lively.ide.tools.SearchPalette.refresh();
      },

      // Items matching a query, ranked: name prefix > name contains > text
      // contains > world contains (search.md §3.3). Case-insensitive substring.
      match: function (items, query) {
        var q = String(query || "").trim().toLowerCase();
        if (!q) return [];
        var ranked = [];
        items.forEach(function (it) {
          var name = (it.name || "").toLowerCase(),
            rank = name.indexOf(q) === 0 ? 0
              : name.indexOf(q) > 0 ? 1
              : (it.text || "").toLowerCase().indexOf(q) >= 0 ? 2
              : (it.world || it.path || "").toLowerCase().indexOf(q) >= 0 ? 3 : -1;
          if (rank >= 0) ranked.push({ rank: rank, item: it });
        });
        ranked.sort(function (a, b) { return a.rank - b.rank; });
        return ranked.map(function (r) { return r.item; });
      },

      // Items per scope tab, for the current query.
      countsFor: function (matches) {
        var morphs = matches.filter(function (i) { return i.group === "world" || i.group === "saved"; }).length;
        return { all: matches.length, morphs: morphs, worlds: 0, code: 0, files: 0 };
      },

      // Re-render everything that depends on scope/query/items.
      refresh: function () {
        var P = lively.ide.tools.SearchPalette, s = P.current;
        if (!s || s.closed) return;
        var matches = P.match(s.items, s.query);
        s.matches = matches;
        var counts = P.countsFor(matches);

        s.placeholder.setVisible(!s.query);
        s.placeholder.renderContext().shapeNode.style.display = s.query ? "none" : "";

        var x = SIDE;
        s.pills.forEach(function (pill, i) {
          var scope = SCOPES[i], selected = i === s.scopeIndex,
            text = scope.label + (s.query ? "  " + counts[scope.id] : ""),
            w = lively.identity.HomestarUI.textW(text, 12, true) + 28;
          pill.setExtent(lively.pt(w, PILL_H));
          pill.setPosition(lively.pt(x, FIELD_H + (PILLS_H - PILL_H) / 2));
          pill._label.setExtent(lively.pt(w, 18));
          pill._label.textString = text;
          pill._label.applyStyle({ textColor: selected ? Color.white : MUTED });
          pill.applyStyle({ fill: selected ? ACCENT : null });
          var pn = pill.renderContext().shapeNode;
          pn.style.background = selected ? ACCENT.toString() : "transparent";
          pn.style.boxShadow = selected ? "none" : "inset 0 0 0 1px rgba(30,24,44,0.14)";
          pill._label.renderContext().shapeNode.style.color = selected ? "#fff" : MUTED.toString();
          x += w + 8;
        });

        // Body. Rows come with the next step; the shell shows the state.
        var shown = s.scopeIndex === 0 ? matches : matches.filter(function (i) {
          return SCOPES[s.scopeIndex].id === "morphs" && (i.group === "world" || i.group === "saved");
        });
        if (!s.query) {
          s.bodyTitle.textString = "RECENT";
          s.bodyHint.textString = "Nothing yet. Type a morph name, text inside a morph, or a saved world.";
        } else if (!shown.length) {
          s.bodyTitle.textString = "";
          s.bodyHint.textString = "No matches for \"" + s.query + "\"";
        } else {
          s.bodyTitle.textString = shown.length + (shown.length === 1 ? " MATCH" : " MATCHES");
          s.bodyHint.textString = shown.slice(0, 4).map(function (i) { return i.name || "(unnamed)"; }).join(", ");
        }
      },
    };

  }); // end module('lively.ide.tools.SearchPalette')
