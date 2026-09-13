/**
 * lively.identity.WorldsBrowser
 *
 * Floating window listing all worlds saved under the current user's identity.
 * Each row shows the world's human-readable name, its web key (objId), and an
 * "open →" link that navigates to /@handle/objId.
 * The search input filters by name (Enter to apply).
 * A "history" link drills into version history with per-version restore.
 *
 * Dependencies:
 *   lively.identity.DID — isLoggedIn, currentUser
 */

module("lively.identity.WorldsBrowser")
  .requires(
    "lively.identity.DID",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {
    lively.BuildSpec("lively.identity.WorldsBrowser", {
      _Extent: lively.pt(460, 400),
      _BorderRadius: 8,
      // Fill-frame/mat technique (see NewWikiPageDialog.js/ProfileCard.js):
      // the window's own fill shows through as a colored margin around the
      // gray content pane below and behind the title bar.
      _Fill: Color.rgb(0, 150, 136),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "WorldsBrowser",
      submorphs: [
        {
          _Extent: lively.pt(454, 375),
          _BorderColor: Color.rgb(95, 94, 95),
          _BorderRadius: 4,
          _Fill: Color.rgb(243, 243, 243),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          layout: {
            adjustForNewBounds: true,
            resizeHeight: true,
            resizeWidth: true,
          },
          name: "worldsBrowserContent",
          submorphs: [],
        },
      ],

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this.targetMorph = this.get("worldsBrowserContent");
        var titleBar = this.makeTitleBar("My worlds", this.getExtent().x);
        this.titleBar = this.addMorph(titleBar);
        this.buildUI();
        this.loadWorlds();
      },

      buildUI: function buildUI() {
        var self = this;
        var content = this.get("worldsBrowserContent");
        if (!content) return;
        content.removeAllMorphs();

        var pad = 12;
        var w = content.getExtent().x - pad * 2;
        var y = pad;

        var searchInput = new lively.morphic.Text(lively.rect(pad, y, w, 26), "");
        searchInput.name = "searchInput";
        searchInput.applyStyle({
          allowInput: true,
          fontSize: 12,
          fill: Color.white,
          borderWidth: 1,
          borderColor: Color.rgb(190, 190, 190),
          borderRadius: 4,
          padding: lively.rect(26, 5, 0, 0),
        });
        searchInput.beInputLine();
        content.addMorph(searchInput);

        var searchIcon = new lively.morphic.Text(lively.rect(pad + 6, y + 5, 16, 16), "search");
        searchIcon.applyStyle({
          allowInput: false,
          fontFamily: "'Material Symbols Rounded'",
          fontSize: 12,
          textColor: Color.rgb(150, 150, 150),
          fill: null,
          borderWidth: 0,
          borderColor: null,
        });
        searchIcon.eventsAreIgnored = true;
        searchIcon.draggingEnabled = false;
        searchIcon.droppingEnabled = false;
        searchIcon.grabbingEnabled = false;
        content.addMorph(searchIcon);
        searchIcon.renderContext().shapeNode.style.pointerEvents = "none";
        y += 34;

        var listH = content.getExtent().y - y - pad;
        var listBox = new lively.morphic.Box(lively.rect(pad, y, w, listH));
        listBox.name = "worldsList";
        listBox.applyStyle({
          fill: Color.white,
          clipMode: "auto",
          borderWidth: 1,
          borderColor: Color.rgb(220, 220, 220),
          borderRadius: 3,
        });
        content.addMorph(listBox);
        listBox.renderContext().shapeNode.style.overflowX = "hidden";

        lively.bindings.connect(searchInput, "savedTextString", self, "filterWorlds");
      },

      loadWorlds: function loadWorlds() {
        var self = this;
        var did = lively.identity.did;
        if (!did || !did.isLoggedIn()) {
          return self.showMessage("Sign in to view your worlds.");
        }
        var handle = did.currentUser().handle;
        self._handle = handle;
        self.showMessage("Loading...");

        fetch("/@" + handle, { credentials: "include", headers: { "Accept": "application/json" } })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            var worlds = (body.objects || []).filter(function (e) {
              return e.type === "world";
            });
            self._worlds = worlds;
            self.renderWorlds(worlds);
          })
          .catch(function (err) {
            self.showMessage("Could not load worlds: " + err.message);
          });
      },

      filterWorlds: function filterWorlds(query) {
        var worlds = this._worlds || [];
        if (!query || !query.trim()) return this.renderWorlds(worlds);
        var q = query.trim().toLowerCase();
        this.renderWorlds(worlds.filter(function (e) {
          var name = ((e.state && e.state.name) || e.objId).toLowerCase();
          return name.indexOf(q) !== -1;
        }));
      },

      showMessage: function showMessage(msg) {
        var listBox = this.get("worldsList");
        if (!listBox) return;
        listBox.removeAllMorphs();
        var w = listBox.getExtent().x;
        var t = new lively.morphic.Text(lively.rect(10, 10, w - 20, 20), msg);
        t.applyStyle({
          allowInput: false,
          fontSize: 11,
          textColor: Color.rgb(130, 130, 130),
          fill: null,
          borderWidth: 0,
          borderColor: null,
        });
        listBox.addMorph(t);
      },

      renderWorlds: function renderWorlds(worlds) {
        var self = this;
        var listBox = this.get("worldsList");
        if (!listBox) return;
        listBox.removeAllMorphs();

        if (!worlds || worlds.length === 0) {
          return self.showMessage("No worlds found.");
        }

        var handle = this._handle;
        var w = listBox.getExtent().x;
        var rowH = 52;
        var y = 4;
        var PINK       = Color.rgb(240, 26, 105);
        var PINK_HOVER = Color.rgb(190, 15, 82);
        var GRAY       = Color.rgb(150, 150, 150);
        var GRAY_HOVER = Color.rgb(90, 90, 90);
        var ROW_HOVER  = Color.rgb(224, 247, 244);

        worlds.forEach(function (envelope) {
          var name = (envelope.state && envelope.state.name) || envelope.objId;
          var url  = "/@" + handle + "/" + envelope.objId;

          var row = new lively.morphic.Box(lively.rect(0, y, w, rowH));
          row.applyStyle({ fill: null, borderWidth: 0 });
          row.draggingEnabled = false;
          row.droppingEnabled = false;
          row.grabbingEnabled = false;
          row.onMouseOver = function () { row.setFill(ROW_HOVER); };
          row.onMouseOut  = function () { row.setFill(null); };

          var nameText = new lively.morphic.Text(lively.rect(10, 7, w - 130, 20), name);
          nameText.applyStyle({
            allowInput: false,
            fontSize: 13,
            fontWeight: "bold",
            textColor: Color.rgb(40, 40, 40),
            fill: null,
            borderWidth: 0,
            borderColor: null,
          });
          nameText.eventsAreIgnored = true;
          nameText.draggingEnabled = false;
          nameText.droppingEnabled = false;
          nameText.grabbingEnabled = false;
          row.addMorph(nameText);

          var keyText = new lively.morphic.Text(lively.rect(10, 29, w - 130, 14), envelope.objId);
          keyText.applyStyle({
            allowInput: false,
            fontSize: 10,
            textColor: Color.rgb(170, 170, 170),
            fill: null,
            borderWidth: 0,
            borderColor: null,
          });
          keyText.eventsAreIgnored = true;
          keyText.draggingEnabled = false;
          keyText.droppingEnabled = false;
          keyText.grabbingEnabled = false;
          row.addMorph(keyText);

          var historyLink = new lively.morphic.Text(lively.rect(w - 118, 16, 52, 18), "history");
          historyLink.applyStyle({
            allowInput: false,
            fontSize: 12,
            textColor: GRAY,
            fill: null,
            borderWidth: 0,
            borderColor: null,
          });
          historyLink.draggingEnabled = false;
          historyLink.droppingEnabled = false;
          historyLink.grabbingEnabled = false;
          historyLink.renderContext().shapeNode.style.cursor = "pointer";
          historyLink._objId      = envelope.objId;
          historyLink._worldName  = name;
          historyLink.onMouseOver = function () { historyLink.setTextColor(GRAY_HOVER); };
          historyLink.onMouseOut  = function () { historyLink.setTextColor(GRAY); };
          historyLink.onMouseDown = function () {
            var win = lively.morphic.World.current().get("WorldsBrowser");
            if (win) win.showHistory(this._objId, this._worldName);
          };
          row.addMorph(historyLink);

          var openLink = new lively.morphic.Text(lively.rect(w - 58, 16, 50, 18), "open →");
          openLink.applyStyle({
            allowInput: false,
            fontSize: 12,
            textColor: PINK,
            fill: null,
            borderWidth: 0,
            borderColor: null,
          });
          openLink.draggingEnabled = false;
          openLink.droppingEnabled = false;
          openLink.grabbingEnabled = false;
          openLink.renderContext().shapeNode.style.cursor = "pointer";
          openLink._url = url;
          openLink.onMouseOver = function () { openLink.setTextColor(PINK_HOVER); };
          openLink.onMouseOut  = function () { openLink.setTextColor(PINK); };
          openLink.onMouseDown = function () { window.location.href = this._url; };
          row.addMorph(openLink);

          var sep = new lively.morphic.Box(lively.rect(10, rowH - 1, w - 20, 1));
          sep.applyStyle({ fill: Color.rgb(225, 225, 225), borderWidth: 0 });
          row.addMorph(sep);

          listBox.addMorph(row);
          y += rowH + 2;
        });
      },

      // ── history view ──────────────────────────────────────────────────────────

      showHistory: function showHistory(objId, worldName) {
        var self   = this;
        var handle = this._handle;
        self._renderHistoryUI(objId, worldName, null); // show loading state
        fetch("/@" + handle + "/" + objId + "/versions", { credentials: "include", headers: { "Accept": "application/json" } })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            self._renderHistoryUI(objId, worldName, body.versions || []);
          })
          .catch(function (err) {
            self._renderHistoryUI(objId, worldName, null, "Could not load versions: " + err.message);
          });
      },

      _renderHistoryUI: function _renderHistoryUI(objId, worldName, versions, errorMsg) {
        var content = this.get("worldsBrowserContent");
        if (!content) return;
        content.removeAllMorphs();

        var pad  = 12;
        var cw   = content.getExtent().x;
        var w    = cw - pad * 2;
        var y    = pad;
        var PINK = Color.rgb(240, 26, 105);
        var GRAY = Color.rgb(140, 140, 140);

        var PINK_HOVER = Color.rgb(190, 15, 82);

        // back link
        var backLink = new lively.morphic.Text(lively.rect(pad, y, 110, 18), "← My worlds");
        backLink.applyStyle({ allowInput: false, fontSize: 12, textColor: PINK, fill: null, borderWidth: 0, borderColor: null });
        backLink.draggingEnabled = false;
        backLink.droppingEnabled = false;
        backLink.grabbingEnabled = false;
        backLink.renderContext().shapeNode.style.cursor = "pointer";
        backLink.onMouseOver = function () { backLink.setTextColor(PINK_HOVER); };
        backLink.onMouseOut  = function () { backLink.setTextColor(PINK); };
        backLink.onMouseDown = function () {
          var win = lively.morphic.World.current().get("WorldsBrowser");
          if (win) win.showWorlds();
        };
        content.addMorph(backLink);

        // world name header
        var header = new lively.morphic.Text(lively.rect(pad + 118, y, w - 118, 18), worldName || objId);
        header.applyStyle({ allowInput: false, fontSize: 13, fontWeight: "bold",
          textColor: Color.rgb(40, 40, 40), fill: null, borderWidth: 0, borderColor: null });
        content.addMorph(header);
        y += 28;

        // divider
        var div = new lively.morphic.Box(lively.rect(pad, y, w, 1));
        div.applyStyle({ fill: Color.rgb(220, 220, 220), borderWidth: 0 });
        content.addMorph(div);
        y += 10;

        if (errorMsg) {
          var errT = new lively.morphic.Text(lively.rect(pad, y, w, 20), errorMsg);
          errT.applyStyle({ allowInput: false, fontSize: 11, textColor: GRAY, fill: null, borderWidth: 0, borderColor: null });
          content.addMorph(errT);
          return;
        }

        if (!versions) {
          var loading = new lively.morphic.Text(lively.rect(pad, y, w, 20), "Loading...");
          loading.applyStyle({ allowInput: false, fontSize: 11, textColor: GRAY, fill: null, borderWidth: 0, borderColor: null });
          content.addMorph(loading);
          return;
        }

        if (versions.length === 0) {
          var none = new lively.morphic.Text(lively.rect(pad, y, w, 20), "No version history found.");
          none.applyStyle({ allowInput: false, fontSize: 11, textColor: GRAY, fill: null, borderWidth: 0, borderColor: null });
          content.addMorph(none);
          return;
        }

        // versions newest-first; index 0 = current
        var ordered = versions.slice().reverse();
        var handle  = this._handle;

        var listBox = new lively.morphic.Box(lively.rect(pad, y, w, content.getExtent().y - y - pad));
        listBox.applyStyle({ fill: Color.white, clipMode: "auto",
          borderWidth: 1, borderColor: Color.rgb(220, 220, 220), borderRadius: 3 });
        content.addMorph(listBox);
        listBox.renderContext().shapeNode.style.overflowX = "hidden";

        var rowH = 46;
        var ry   = 4;

        ordered.forEach(function (v, idx) {
          var isCurrent = idx === 0;

          var date = "—";
          try {
            var d = new Date(v.createdAt);
            date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
              + "  " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
          } catch (e) { date = v.createdAt || "—"; }

          var cidShort = v.cid ? v.cid.slice(0, 10) + "…" : "—";

          var row = new lively.morphic.Box(lively.rect(0, ry, w, rowH));
          row.applyStyle({ fill: null, borderWidth: 0 });
          row.draggingEnabled = false;
          row.droppingEnabled = false;
          row.grabbingEnabled = false;
          row.onMouseOver = function () { row.setFill(Color.rgb(224, 247, 244)); };
          row.onMouseOut  = function () { row.setFill(null); };

          var dateT = new lively.morphic.Text(lively.rect(10, 6, w - 160, 18), date);
          dateT.applyStyle({ allowInput: false, fontSize: 12,
            fontWeight: isCurrent ? "bold" : "normal",
            textColor: Color.rgb(40, 40, 40), fill: null, borderWidth: 0, borderColor: null });
          dateT.eventsAreIgnored = true;
          dateT.draggingEnabled = false;
          dateT.droppingEnabled = false;
          dateT.grabbingEnabled = false;
          row.addMorph(dateT);

          var cidT = new lively.morphic.Text(lively.rect(10, 26, w - 160, 14), cidShort);
          cidT.applyStyle({ allowInput: false, fontSize: 10, textColor: GRAY, fill: null, borderWidth: 0, borderColor: null });
          cidT.eventsAreIgnored = true;
          cidT.draggingEnabled = false;
          cidT.droppingEnabled = false;
          cidT.grabbingEnabled = false;
          row.addMorph(cidT);

          if (isCurrent) {
            var curLabel = new lively.morphic.Text(lively.rect(w - 148, 13, 60, 18), "current");
            curLabel.applyStyle({ allowInput: false, fontSize: 11, textColor: GRAY, fill: null, borderWidth: 0, borderColor: null });
            curLabel.eventsAreIgnored = true;
            curLabel.draggingEnabled = false;
            curLabel.droppingEnabled = false;
            curLabel.grabbingEnabled = false;
            row.addMorph(curLabel);
          } else {
            // view — non-destructive, opens the snapshot and lets you navigate back
            var viewLink = new lively.morphic.Text(lively.rect(w - 70, 13, 60, 18), "view →");
            viewLink.applyStyle({ allowInput: false, fontSize: 12, textColor: PINK, fill: null, borderWidth: 0, borderColor: null });
            viewLink.draggingEnabled = false;
            viewLink.droppingEnabled = false;
            viewLink.grabbingEnabled = false;
            viewLink.renderContext().shapeNode.style.cursor = "pointer";
            viewLink._vUrl = "/@" + handle + "/" + objId + "/at/" + encodeURIComponent(v.cid);
            viewLink.onMouseOver = function () { viewLink.setTextColor(PINK_HOVER); };
            viewLink.onMouseOut  = function () { viewLink.setTextColor(PINK); };
            viewLink.onMouseDown = function () { window.location.href = this._vUrl; };
            row.addMorph(viewLink);
          }

          var sep = new lively.morphic.Box(lively.rect(10, rowH - 1, w - 20, 1));
          sep.applyStyle({ fill: Color.rgb(225, 225, 225), borderWidth: 0 });
          row.addMorph(sep);

          listBox.addMorph(row);
          ry += rowH + 2;
        });
      },

      showWorlds: function showWorlds() {
        this.buildUI();
        this.loadWorlds();
      },
    });
  }); // end module('lively.identity.WorldsBrowser')
