/**
 * lively.identity.ConstellationSettingsDialog
 *
 * Avatar/banner/domain settings for a constellation, opened from the
 * settings gear on ConstellationLounge.js's Quick Info panel (rendered only
 * for a controller — this dialog is only ever reached by one, but every
 * write route it calls re-checks isController server-side regardless).
 *
 * Avatar/banner use the same crop-then-upload flow as ProfileCard.js
 * (lively.identity.imageCropper, extracted from there so both dialogs share
 * one copy of the canvas cropping UI).
 *
 * Domain verification only offers the DNS TXT method (a
 * "_lively-did.<domain>" TXT record equal to "did=<constellation DID>") —
 * unlike a personal identity's ProfileCard.js Domain tab, which also offers
 * a signed-file method via the device's own signing key. A constellation's
 * DID isn't backed by any single device's key (multi-controller/threshold
 * governance — see ConstellationRegistry.js), so there's no key available
 * client-side to produce that signature; DNS control needs no signature at
 * all (DomainVerifier.js's verifyDomainClaimDns), so it's the only method
 * that makes sense here.
 *
 * Open: lively.identity.ConstellationSettingsDialog.open(name, quickInfo, onSaved)
 */

module("lively.identity.ConstellationSettingsDialog")
  .requires(
    "lively.identity.DID",
    "lively.identity.ImageCropper",
    "lively.persistence.BuildSpec",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    lively.BuildSpec("lively.identity.ConstellationSettingsDialog", {
      _BorderRadius: 7,
      _Extent: lively.pt(580, 560),
      _Fill: Color.rgb(251, 86, 213),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      droppingEnabled: false,
      layout: { adjustForNewBounds: true },
      name: "ConstellationSettingsDialog",
      titleBar: "Constellation Settings",
      submorphs: [
        {
          _BorderColor: Color.rgb(95, 94, 95),
          _BorderRadius: 4,
          _BorderWidth: 1,
          _Extent: lively.pt(574, 535),
          _Fill: Color.rgb(243, 243, 243),
          _Position: lively.pt(3, 22),
          className: "lively.morphic.Box",
          clipMode: "auto",
          // resizeWidth/resizeHeight (missing originally — adjustForNewBounds
          // alone does nothing without them, confirmed live: growing the
          // window by 200x200 left this box's own extent completely
          // unchanged, so the magenta window fill showed through as a bare
          // gap on the right/bottom instead of the content box filling it)
          // make this box track the window's own resize handle. This is
          // independent of _render()'s own setExtent calls, which still
          // drive the window's size *up* to fit newly-added content
          // (e.g. after adding a controller) — that direction is untouched;
          // this only fixes the reverse direction, a user manually
          // resizing the window bigger/smaller than its content needs.
          layout: { adjustForNewBounds: true, resizeWidth: true, resizeHeight: true },
          name: "settingsContent",
          submorphs: [],
        },
      ],

      connectionRebuilder: function connectionRebuilder() {
        lively.bindings.connect(this, "remove", this, "onRemove", {});
      },

      // ─── lifecycle ────────────────────────────────────────────────────────

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        $super();
        this._constellationName = null;
        this._avatarUrl = "";
        this._bannerUrl = "";
        this._description = "";
        this._domains = [];
        this._onSaved = null;
      },

      onRemove: function onRemove() {},

      // Called by the static open() below. Fetches the current domain list
      // (avatarUrl/bannerUrl are already known from the quickInfo the caller
      // already had) before the first render, so the domain section isn't
      // stuck on "no domains yet" for a moment on every open.
      load: function load(name, quickInfo, onSaved) {
        this._constellationName = name;
        this._avatarUrl = (quickInfo && quickInfo.avatarUrl) || "";
        this._description = (quickInfo && quickInfo.description) || "";
        this._bannerUrl = (quickInfo && quickInfo.bannerUrl) || "";
        this._constellationDid = (quickInfo && quickInfo.did) || "";
        this._createdBy = (quickInfo && quickInfo.createdBy) || null;
        this._controllers = (quickInfo && quickInfo.controllers) || [];
        this._memberHandles = (quickInfo && quickInfo.memberHandles) || {};
        var me = lively.identity.did.currentUser();
        this._isCreator = !!(me && me.did && me.did === this._createdBy);
        this._onSaved = onSaved || function () {};
        this.setTitle("Settings — c/" + name);
        this._render();
        this._reloadDomains();
      },

      _reloadDomains: function _reloadDomains() {
        var self = this;
        var base = lively.identity.did.baseUrl();
        fetch(base + "/c/" + encodeURIComponent(this._constellationName) + "/domains", { credentials: "include" })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            self._domains = (body && body.domains) || [];
            self._render();
          })
          .catch(function () { /* leave whatever list was already shown */ });
      },

      // Re-fetches controllers/memberHandles after an add/remove — the
      // dialog only ever gets a one-time snapshot of quickInfo from its
      // opener (ConstellationLounge.js), so this is the only way its own
      // controllers list picks up a change made inside itself.
      _reloadControllers: function _reloadControllers() {
        var self = this;
        var base = lively.identity.did.baseUrl();
        fetch(base + "/c/" + encodeURIComponent(this._constellationName) + "/space-token", { credentials: "include" })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            var qi = (body && body.quickInfo) || {};
            self._createdBy = qi.createdBy || self._createdBy;
            self._controllers = qi.controllers || [];
            self._memberHandles = qi.memberHandles || {};
            self._render();
          })
          .catch(function () { /* leave whatever list was already shown */ });
      },

      // ─── render ─────────────────────────────────────────────────────────────

      _render: function _render() {
        var self = this;
        var content = this.get("settingsContent");
        content.removeAllMorphs();
        var MARGIN = 18;
        var ew = 538;
        var BTN_W = 96;
        var GAP = 10;
        var inputW = ew - BTN_W - GAP;
        var y = 18;
        var DESCRIPTION_MAX = 300; // matches IdentityServer.js's PUT /c/:name/settings cap

        function sectionLabel(str) {
          var lbl = new lively.morphic.Text(lively.rect(MARGIN, y, ew, 16), str);
          lbl.applyStyle({ allowInput: false, fontSize: 12, fontWeight: "bold",
            textColor: Color.rgb(80, 80, 80),
            fill: null, borderWidth: 0 });
          content.addMorph(lbl);
          y += 22;
        }

        function fieldLabel(str) {
          var lbl = new lively.morphic.Text(lively.rect(MARGIN, y, ew, 14), str);
          lbl.applyStyle({ allowInput: false, fontSize: 10,
            textColor: Color.rgb(140, 140, 140),
            fill: null, borderWidth: 0 });
          content.addMorph(lbl);
          y += 17;
        }

        // variant: "default" (neutral gray), "success" (Save), "danger"
        // (Remove) — softer, more rounded look than the original flat-gray
        // sharp-cornered buttons: bigger borderRadius, lighter tinted
        // borders instead of flat gray, and a gentle hover fill (direct
        // onMouseOver/onMouseOut assignment, same idiom the settings gear
        // icon on the Quick Info panel already uses — not addScript, so it
        // keeps its closure over `palette` normally).
        function styledButton(rect, label, variant) {
          var palette = {
            "default": { fill: Color.rgb(247, 247, 250), hoverFill: Color.rgb(236, 236, 243),
              border: Color.rgb(223, 223, 233), text: Color.rgb(70, 70, 80) },
            "success": { fill: Color.rgb(233, 250, 237), hoverFill: Color.rgb(217, 245, 223),
              border: Color.rgb(179, 224, 191), text: Color.rgb(20, 120, 60) },
            "danger": { fill: Color.rgb(253, 238, 240), hoverFill: Color.rgb(250, 223, 227),
              border: Color.rgb(240, 200, 206), text: Color.rgb(180, 40, 60) },
          }[variant || "default"];
          var btn = new lively.morphic.Button(rect, label);
          btn.applyStyle({ fill: palette.fill,
            borderColor: palette.border, borderRadius: 8,
            fontSize: 11, textColor: palette.text, borderWidth: 1 });
          btn.setAppearanceStylingMode(false);
          btn.setBorderStylingMode(false);
          btn.onMouseOver = function () { btn.applyStyle({ fill: palette.hoverFill }); };
          btn.onMouseOut = function () { btn.applyStyle({ fill: palette.fill }); };
          return btn;
        }

        // Single-line editable field, clipped so a long pasted URL/DID stays
        // inside its own box (like a real <input>) instead of spilling past
        // it. Two separate things were needed here, confirmed live: (1)
        // clipMode:"hidden" alone was not enough — beInputLine() (or Text's
        // default hug-content behavior, since fixedWidth/fixedHeight default
        // false) silently grew the box's real rendered width past whatever
        // rect it was constructed with to fit a long pasted URL (measured
        // 561px live vs the 432px it was given), so clipMode had nothing
        // left to clip against; fixedWidth/fixedHeight:true stops that
        // auto-grow. (2) beInputLine() runs AFTER applyStyle below and can
        // reset style properties it cares about, so applyStyle is called
        // AFTER beInputLine() here, and the extent is re-asserted
        // immediately after both, rather than trusting the constructor rect
        // to still hold.
        function textField(name, value) {
          var inp = new lively.morphic.Text(lively.rect(MARGIN, y, inputW, 28), value || "");
          inp.name = name;
          inp.beInputLine();
          inp.applyStyle({ allowInput: true, fontSize: 12, clipMode: "hidden",
            fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre",
            fill: Color.rgb(252, 252, 252),
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 4 });
          inp.setExtent(lively.pt(inputW, 28));
          content.addMorph(inp);
          return inp;
        }

        // Multi-line editable field (Description) — full content width (no
        // side-by-side button), fixedWidth:true for the same overflow
        // reason as textField above, but whiteSpaceHandling:"normal" (wrap)
        // instead of "pre" since prose is meant to wrap across lines, not
        // clip to one. fixedHeight:true + clipMode:"auto" caps it at the
        // given height with an internal scrollbar rather than growing
        // unboundedly or silently clipping content with no way to see it.
        function textAreaField(name, value, height) {
          var inp = new lively.morphic.Text(lively.rect(MARGIN, y, ew, height), value || "");
          inp.name = name;
          inp.beInputLine();
          inp.applyStyle({ allowInput: true, fontSize: 12, clipMode: "auto",
            fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "normal",
            fill: Color.rgb(252, 252, 252),
            borderColor: Color.rgb(200, 200, 200), borderWidth: 1, borderRadius: 4 });
          inp.setExtent(lively.pt(ew, height));
          content.addMorph(inp);
          return inp;
        }

        function divider() {
          y += 8;
          var line = new lively.morphic.Box(lively.rect(MARGIN, y, ew, 1));
          line.applyStyle({ fill: Color.rgb(228, 228, 228), borderWidth: 0 });
          content.addMorph(line);
          y += 20;
        }

        function truncateMiddle(str, head, tail) {
          if (!str) return "";
          if (str.length <= head + tail + 1) return str;
          return str.slice(0, head) + "…" + str.slice(-tail);
        }

        // ── Avatar ──────────────────────────────────────────────────────────
        sectionLabel("Avatar");
        textField("csdAvatarUrl", this._avatarUrl);
        var avBtn = styledButton(lively.rect(MARGIN + inputW + GAP, y, BTN_W, 28), "Upload…");
        avBtn._fieldName = "csdAvatarUrl";
        avBtn._basename = "avatar";
        avBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (!win) return;
          var fieldName = this._fieldName, basename = this._basename;
          var input = document.createElement("input");
          input.type = "file";
          input.accept = "image/*";
          input.style.display = "none";
          document.body.appendChild(input);
          input.addEventListener("change", function () {
            var file = input.files && input.files[0];
            document.body.removeChild(input);
            if (!file) return;
            lively.identity.imageCropper.open(file, function (url) {
              var pane = win.get("settingsContent");
              var inp = pane && pane.get(fieldName);
              if (inp) inp.textString = url;
            }, { shape: "circle", width: 200, height: 200, title: "Crop Avatar", basename: basename });
          });
          input.click();
        });
        lively.bindings.connect(avBtn, "fire", avBtn, "doAction");
        content.addMorph(avBtn);
        y += 28;
        divider();

        // ── Banner ──────────────────────────────────────────────────────────
        sectionLabel("Banner");
        textField("csdBannerUrl", this._bannerUrl);
        var bnBtn = styledButton(lively.rect(MARGIN + inputW + GAP, y, BTN_W, 28), "Upload…");
        bnBtn._fieldName = "csdBannerUrl";
        bnBtn._basename = "banner";
        bnBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (!win) return;
          var fieldName = this._fieldName, basename = this._basename;
          var input = document.createElement("input");
          input.type = "file";
          input.accept = "image/*";
          input.style.display = "none";
          document.body.appendChild(input);
          input.addEventListener("change", function () {
            var file = input.files && input.files[0];
            document.body.removeChild(input);
            if (!file) return;
            lively.identity.imageCropper.open(file, function (url) {
              var pane = win.get("settingsContent");
              var inp = pane && pane.get(fieldName);
              if (inp) inp.textString = url;
            }, { shape: "rect", width: 834, height: 160, title: "Crop Banner", basename: basename });
          });
          input.click();
        });
        lively.bindings.connect(bnBtn, "fire", bnBtn, "doAction");
        content.addMorph(bnBtn);
        y += 28;
        divider();

        // ── Description ──────────────────────────────────────────────────────
        // Shown on the Quick Info panel below the "Created <date> by
        // @handle" line (ConstellationLounge.js's _renderQuickInfo) — no
        // panel UI existed for this before this field was added there.
        sectionLabel("Description");
        fieldLabel("A short line shown on the Quick Info panel (optional, max " + DESCRIPTION_MAX + " chars)");
        textAreaField("csdDescription", this._description, 56);
        y += 56 + 8;
        divider();

        // ── Domain ──────────────────────────────────────────────────────────
        sectionLabel("Custom domain (optional)");

        if (this._domains.length === 0) {
          var noneM = new lively.morphic.Text(lively.rect(MARGIN, y, ew, 16), "No domain set.");
          noneM.applyStyle({ allowInput: false, fontSize: 11,
            textColor: Color.rgb(160, 160, 160),
            fill: null, borderWidth: 0 });
          content.addMorph(noneM);
          y += 22;
        } else {
          this._domains.forEach(function (d) {
            var isVerified = d.status === "verified";
            var rowM = new lively.morphic.Text(lively.rect(MARGIN, y, ew - BTN_W - GAP, 20),
              d.domain + "  —  " + (isVerified ? "Verified" : "Invalid"));
            rowM.applyStyle({ allowInput: false, fontSize: 12, clipMode: "hidden",
              textColor: isVerified ? Color.rgb(34, 139, 34) : Color.rgb(190, 140, 20),
              fill: null, borderWidth: 0 });
            content.addMorph(rowM);
            var rmBtn = styledButton(lively.rect(MARGIN + ew - BTN_W, y - 2, BTN_W, 24), "Remove", "danger");
            rmBtn._domain = d.domain;
            rmBtn.addScript(function doAction() {
              var win = this.owner && this.owner.owner;
              if (!win) return;
              var domainName = this._domain;
              this.setLabel("…");
              this.setActive(false);
              win._removeDomain(domainName);
            });
            lively.bindings.connect(rmBtn, "fire", rmBtn, "doAction");
            content.addMorph(rmBtn);
            y += 24;
          });
        }

        y += 8;
        if (this._domains.length >= 1) {
          // One domain per constellation at a time (also enforced server-side).
          var oneNote = new lively.morphic.Text(lively.rect(MARGIN, y, ew, 32),
            "Only one domain at a time. Remove this one to add a different domain.");
          oneNote.applyStyle({ allowInput: false, fontSize: 10,
            textColor: Color.rgb(140, 140, 148), fill: null, borderWidth: 0 });
          content.addMorph(oneNote);
          y += 36;
        } else {
        fieldLabel("Add a domain (e.g. mycommunity.com)");
        textField("csdNewDomain", "");
        var addDomBtn = styledButton(lively.rect(MARGIN + inputW + GAP, y, BTN_W, 28), "Verify");
        addDomBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (!win) return;
          var pane = win.get("settingsContent");
          var inp = pane && pane.get("csdNewDomain");
          var domain = inp && inp.textString &&
            inp.textString.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
          if (!domain) { alert("Enter a domain first."); return; }
          this.setLabel("…");
          this.setActive(false);
          win._addDomain(domain, this);
        });
        lively.bindings.connect(addDomBtn, "fire", addDomBtn, "doAction");
        content.addMorph(addDomBtn);
        y += 36;

        // Verification instructions — a compact card with a truncated,
        // monospace DID + Copy button, instead of one giant unbroken
        // did:jwk string. A DID has no whitespace for the old
        // whiteSpaceHandling:'normal' wrap to break on, so it just
        // overflowed straight past the dialog's right edge (confirmed
        // live) — same class of problem Wallet.js solves for its own
        // address displays, just via a Copy button here rather than CSS
        // word-break, since a did:jwk is long enough that a mid-string
        // break is still unreadable even once it no longer overflows.
        var cardY = y;
        var cardH = 92;
        var card = new lively.morphic.Box(lively.rect(MARGIN, cardY, ew, cardH));
        card.applyStyle({ fill: Color.rgb(248, 248, 248),
          borderColor: Color.rgb(226, 226, 226), borderWidth: 1, borderRadius: 6 });
        content.addMorph(card);
        y += 12;
        var cardLbl = new lively.morphic.Text(lively.rect(MARGIN + 14, y, ew - 28, 14),
          "Before clicking Verify, add this DNS TXT record:");
        cardLbl.applyStyle({ allowInput: false, fontSize: 10, fontWeight: "bold",
          textColor: Color.rgb(110, 110, 110), fill: null, borderWidth: 0 });
        content.addMorph(cardLbl);
        y += 20;
        var recordLine = new lively.morphic.Text(lively.rect(MARGIN + 14, y, ew - 28, 16),
          "Host:  _lively-did.<your domain>");
        recordLine.applyStyle({ allowInput: false, fontSize: 11, clipMode: "hidden",
          fontFamily: "SFMono-Regular, Consolas, monospace",
          textColor: Color.rgb(70, 70, 70), fill: null, borderWidth: 0 });
        content.addMorph(recordLine);
        y += 22;
        var didRowW = ew - 28 - BTN_W - GAP;
        var didLine = new lively.morphic.Text(lively.rect(MARGIN + 14, y, didRowW, 16),
          "Value:  did=" + truncateMiddle(this._constellationDid, 20, 12));
        didLine.applyStyle({ allowInput: false, fontSize: 11, clipMode: "hidden",
          fontFamily: "SFMono-Regular, Consolas, monospace",
          textColor: Color.rgb(70, 70, 70), fill: null, borderWidth: 0 });
        content.addMorph(didLine);
        var copyBtn = styledButton(lively.rect(MARGIN + 14 + didRowW + GAP, y - 4, BTN_W, 24), "Copy DID");
        copyBtn._fullDid = this._constellationDid;
        copyBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (win) win._copyToClipboard(this._fullDid, this);
        });
        lively.bindings.connect(copyBtn, "fire", copyBtn, "doAction");
        content.addMorph(copyBtn);
        y = cardY + cardH;
        }
        divider();

        // ── Controllers (moderators) ─────────────────────────────────────────
        // Creator-only to add/remove — a moderator being able to promote
        // further moderators isn't the model this codebase uses (createdBy
        // is the sole co-creator, ConstellationDesignSpec.md §4.1). Every
        // other controller still SEES this list (read-only) when they open
        // settings, same as they can see avatar/banner/domain state even
        // though only they-as-controller can edit those.
        sectionLabel("Controllers");
        this._controllers.forEach(function (did) {
          var isCreator = did === self._createdBy;
          var handle = self._memberHandles[did];
          var label = (handle ? "@" + handle : truncateMiddle(did, 14, 8)) +
            "  —  " + (isCreator ? "Creator" : "Moderator");
          var rowM = new lively.morphic.Text(lively.rect(MARGIN, y, ew - BTN_W - GAP, 20), label);
          rowM.applyStyle({ allowInput: false, fontSize: 12, clipMode: "hidden",
            textColor: isCreator ? Color.rgb(20, 110, 20) : Color.rgb(60, 60, 60),
            fill: null, borderWidth: 0 });
          content.addMorph(rowM);
          if (self._isCreator && !isCreator) {
            var rmCtrlBtn = styledButton(lively.rect(MARGIN + ew - BTN_W, y - 2, BTN_W, 24), "Remove", "danger");
            rmCtrlBtn._did = did;
            rmCtrlBtn.addScript(function doAction() {
              var win = this.owner && this.owner.owner;
              if (!win) return;
              this.setLabel("…");
              this.setActive(false);
              win._removeController(this._did);
            });
            lively.bindings.connect(rmCtrlBtn, "fire", rmCtrlBtn, "doAction");
            content.addMorph(rmCtrlBtn);
          }
          y += 24;
        });

        if (this._isCreator) {
          y += 8;
          fieldLabel("Add a controller (handle, e.g. @friend)");
          textField("csdNewController", "");
          var addCtrlBtn = styledButton(lively.rect(MARGIN + inputW + GAP, y, BTN_W, 28), "Add");
          addCtrlBtn.addScript(function doAction() {
            var win = this.owner && this.owner.owner;
            if (!win) return;
            var pane = win.get("settingsContent");
            var inp = pane && pane.get("csdNewController");
            var handle = inp && inp.textString && inp.textString.trim().replace(/^@/, "");
            if (!handle) { alert("Enter a handle first."); return; }
            this.setLabel("…");
            this.setActive(false);
            win._addController(handle, this);
          });
          lively.bindings.connect(addCtrlBtn, "fire", addCtrlBtn, "doAction");
          content.addMorph(addCtrlBtn);
          y += 36;
        } else {
          var onlyCreatorM = new lively.morphic.Text(lively.rect(MARGIN, y, ew, 16),
            "Only the creator can add or remove controllers.");
          onlyCreatorM.applyStyle({ allowInput: false, fontSize: 10,
            textColor: Color.rgb(160, 160, 160),
            fill: null, borderWidth: 0 });
          content.addMorph(onlyCreatorM);
          y += 22;
        }
        divider();

        // ── Save ─────────────────────────────────────────────────────────────
        // No separate Cancel button — the window's own title-bar close (X)
        // already discards unsaved changes, same as closing any other
        // dialog in this codebase without saving.
        var saveBtn = styledButton(lively.rect(MARGIN + ew - BTN_W, y, BTN_W, 30), "Save", "success");
        saveBtn.addScript(function doAction() {
          var win = this.owner && this.owner.owner;
          if (!win) return;
          win._save(this);
        });
        lively.bindings.connect(saveBtn, "fire", saveBtn, "doAction");
        content.addMorph(saveBtn);
        y += 30 + 18;

        // Grow the window (never shrink it) if the just-rendered content
        // needs more room than it currently has — e.g. after adding a
        // controller/domain row. Content itself is no longer resized here
        // directly: settingsContent's own layout (resizeWidth/resizeHeight,
        // set on the BuildSpec above) already keeps it tracking the
        // window's real extent whenever the window resizes, including a
        // resize the USER does by dragging the window's own resize handle.
        // A plain, unconditional "shrink window to fit content" here (the
        // original code) fought that: _render() re-runs on its own after
        // any async reload (_reloadDomains/_reloadControllers), and that
        // later call would silently snap a user's manual resize straight
        // back down to content-fit size the moment any such reload
        // completed — confirmed live, a window enlarged by 200x200 reverted
        // to its tight-fit size like the resize had never happened, well
        // before the user did anything else.
        var neededHeight = y + (this.contentOffset ? this.contentOffset.y : 22) + 6;
        if (neededHeight > this.getExtent().y) {
          this.setExtent(lively.pt(this.getExtent().x, neededHeight));
        }
      },

      // ─── actions ────────────────────────────────────────────────────────────

      _addDomain: function _addDomain(domain, btn) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        fetch(base + "/c/" + encodeURIComponent(this._constellationName) + "/domains", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain: domain }),
        })
          .then(function (res) {
            return res.json().then(function (body) {
              if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
              self._reloadDomains();
            });
          })
          .catch(function (err) {
            alert("Could not verify domain: " + err.message);
            btn.setLabel("Verify");
            btn.setActive(true);
          });
      },

      _removeDomain: function _removeDomain(domain) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        fetch(base + "/c/" + encodeURIComponent(this._constellationName) + "/domains/" + encodeURIComponent(domain), {
          method: "DELETE",
          credentials: "include",
        })
          .then(function () { self._reloadDomains(); })
          .catch(function (err) { alert("Could not remove domain: " + err.message); self._reloadDomains(); });
      },

      _addController: function _addController(handle, btn) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        fetch(base + "/c/" + encodeURIComponent(this._constellationName) + "/controllers", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ handle: handle }),
        })
          .then(function (res) {
            return res.json().then(function (body) {
              if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
              self._reloadControllers();
            });
          })
          .catch(function (err) {
            alert("Could not add controller: " + err.message);
            btn.setLabel("Add");
            btn.setActive(true);
          });
      },

      // Same clipboard approach as Wallet.js's own _copyToClipboard, adapted
      // for a lively.morphic.Button (setLabel/setActive) instead of a raw
      // DOM button's textContent.
      _copyToClipboard: function _copyToClipboard(text, btn) {
        var original = "Copy DID";
        function copied() {
          btn.setLabel("Copied!");
          setTimeout(function () { btn.setLabel(original); btn.setActive(true); }, 1200);
        }
        btn.setActive(false);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text || "").then(copied).catch(function () { btn.setActive(true); });
        } else {
          var ta = document.createElement("textarea");
          ta.value = text || "";
          ta.style.cssText = "position:fixed;opacity:0;";
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); copied(); } catch (e) { btn.setActive(true); }
          document.body.removeChild(ta);
        }
      },

      _removeController: function _removeController(did) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        fetch(base + "/c/" + encodeURIComponent(this._constellationName) + "/controllers/" + encodeURIComponent(did), {
          method: "DELETE",
          credentials: "include",
        })
          .then(function (res) {
            return res.json().then(function (body) {
              if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
              self._reloadControllers();
            });
          })
          .catch(function (err) { alert("Could not remove controller: " + err.message); self._reloadControllers(); });
      },

      _save: function _save(btn) {
        var self = this;
        var content = this.get("settingsContent");
        var avatarUrl = (content.get("csdAvatarUrl") && content.get("csdAvatarUrl").textString) || "";
        var bannerUrl = (content.get("csdBannerUrl") && content.get("csdBannerUrl").textString) || "";
        var description = (content.get("csdDescription") && content.get("csdDescription").textString) || "";
        btn.setLabel("Saving…");
        btn.setActive(false);
        var base = lively.identity.did.baseUrl();
        fetch(base + "/c/" + encodeURIComponent(this._constellationName) + "/settings", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ avatarUrl: avatarUrl, bannerUrl: bannerUrl, description: description }),
        })
          .then(function (res) {
            return res.json().then(function (body) {
              if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
              self._onSaved();
              self.remove();
            });
          })
          .catch(function (err) {
            alert("Could not save settings: " + err.message);
            btn.setLabel("Save");
            btn.setActive(true);
          });
      },
    });

    lively.identity.ConstellationSettingsDialog = {
      open: function (name, quickInfo, onSaved) {
        var win = lively.BuildSpec("lively.identity.ConstellationSettingsDialog").createMorph();
        win.openInWorldCenter();
        win.load(name, quickInfo, onSaved);
        return win;
      },
    };

  });
