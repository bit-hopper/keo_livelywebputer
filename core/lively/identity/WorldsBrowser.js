/**
 * lively.identity.WorldsBrowser
 *
 * Floating window listing all worlds saved under the current user's identity.
 * Each row shows the world's human-readable name, its web key (objId), and an
 * "open →" link that navigates to /@handle/objId.
 * The search input filters by name (Enter to apply).
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
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "WorldsBrowser",
      submorphs: [
        {
          _Extent: lively.pt(454, 375),
          _Fill: Color.rgb(250, 250, 250),
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
          borderRadius: 3,
          padding: lively.rect(6, 5, 0, 0),
        });
        searchInput.beInputLine();
        content.addMorph(searchInput);
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

        fetch("/@" + handle, { credentials: "include" })
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

        worlds.forEach(function (envelope) {
          var name = (envelope.state && envelope.state.name) || envelope.objId;
          var url = "/@" + handle + "/" + envelope.objId;

          var row = new lively.morphic.Box(lively.rect(0, y, w, rowH));
          row.applyStyle({ fill: null, borderWidth: 0 });

          var nameText = new lively.morphic.Text(lively.rect(10, 7, w - 80, 20), name);
          nameText.applyStyle({
            allowInput: false,
            fontSize: 13,
            fontWeight: "bold",
            textColor: Color.rgb(40, 40, 40),
            fill: null,
          });
          row.addMorph(nameText);

          var keyText = new lively.morphic.Text(lively.rect(10, 29, w - 80, 14), envelope.objId);
          keyText.applyStyle({
            allowInput: false,
            fontSize: 10,
            textColor: Color.rgb(170, 170, 170),
            fill: null,
          });
          row.addMorph(keyText);

          var openLink = new lively.morphic.Text(lively.rect(w - 58, 16, 50, 18), "open →");
          openLink.applyStyle({
            allowInput: false,
            fontSize: 12,
            textColor: Color.rgb(240, 26, 105),
            fill: null,
          });
          openLink._url = url;
          openLink.onMouseDown = function () { window.location.href = this._url; };
          row.addMorph(openLink);

          var sep = new lively.morphic.Box(lively.rect(10, rowH - 1, w - 20, 1));
          sep.applyStyle({ fill: Color.rgb(235, 235, 235), borderWidth: 0 });
          row.addMorph(sep);

          listBox.addMorph(row);
          y += rowH + 2;
        });
      },
    });
  }); // end module('lively.identity.WorldsBrowser')
