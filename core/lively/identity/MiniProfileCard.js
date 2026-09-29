/**
 * lively.identity.MiniProfileCard
 *
 * A small anchored popover (avatar, display name, @handle, sun sign when
 * set, host, short bio snippet, "View full profile" button) shown when a
 * handle rendered elsewhere in the app (e.g. ConstellationLounge.js's
 * co-creator handle) is clicked. Not a lively.BuildSpec window like
 * ProfileCard.js — this is a transient scrim+box popover, dismissed on
 * outside click, following the same shape as CalendarApp.js's
 * _showEventPopover/_hidePopover.
 *
 * Open: lively.identity.MiniProfileCard.open(handle, did, anchor)
 *
 * anchor is either a morph (its worldPoint()/getExtent() position the
 * popover just below it, as every morph-based call site does) or a plain
 * lively.pt(x, y) already in world coordinates, for callers with no morph
 * to point at — e.g. WikiView.js's raw-DOM avatar/handle chips, which
 * compute the world position themselves via their own owner morph's
 * worldPoint().
 *
 * The host row is the member's home instance, read from the "#home" service
 * entry the server records in their DID document (see DidHome.js). It is
 * left out when the document has none — never guessed.
 */

module("lively.identity.MiniProfileCard")
  .requires(
    "lively.identity.PostCardUtils",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    var PINK = Color.rgb(0xCC, 0x00, 0x57); // ProfileCard.js's own window-frame color
    var TEXT_MUTED = Color.rgb(140, 140, 140);
    var CLOSE_HOVER_RED = Color.rgb(224, 66, 66); // base_theme.css's .Button.WindowControl.close:hover
    var CARD_W = 260;
    var LOADING_H = 92; // provisional height until the profile has loaded
    var HEAD_W = CARD_W - 64 - 34; // name/handle column: right of the avatar, left of the close button
    var NAME_MAX = 20, HANDLE_MAX = 24, HOST_MAX = 30, BIO_MAX = 100;
    var ROW_H = 20, ROW_GAP = 2, ICON_NUDGE = 2, BIO_LINE_H = 17, BIO_CHARS_PER_LINE = 34, BIO_MAX_LINES = 3;

    // Same sign order / glyphs / element colors as ProfileCard.js's own sign
    // display (SIGNS/GLYPHS in its profile pane, ELEMENT_RGB indexed i % 4) —
    // duplicated so this popover doesn't have to load all of ProfileCard.js
    // just for a color table.
    var SIGNS  = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
                  "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
    var GLYPHS = ["♈︎", "♉︎", "♊︎", "♋︎", "♌︎", "♍︎", "♎︎", "♏︎", "♐︎", "♑︎", "♒︎", "♓︎"];
    var ELEMENT_RGB = [[196, 56, 24], [38, 120, 66], [0, 118, 148], [95, 74, 196]];

    // Every child morph a popover is built from needs this, not just the
    // card itself — a click landing on any decorative child (avatar, name,
    // bio) would otherwise still be eaten as a drag. See CLAUDE.md's
    // "disabling drag/drop/grab needs three flags, and every visible child
    // individually".
    function noDrag(m) {
      m.draggingEnabled = false;
      m.droppingEnabled = false;
      m.grabbingEnabled = false;
      return m;
    }

    function trunc(s, max) {
      s = String(s == null ? "" : s);
      return s.length > max ? s.slice(0, max - 1).replace(/\s+$/, "") + "…" : s;
    }

    function label(rect, text, opts) {
      opts = opts || {};
      var t = new lively.morphic.Text(rect);
      t.textString = text;
      t.applyStyle({
        fontSize: (opts.px || 12) * 0.75,
        fontWeight: opts.bold ? "bold" : "normal",
        textColor: opts.color || Color.rgb(40, 40, 40),
        fill: null,
        borderWidth: 0,
        align: "left",
        allowInput: false, selectable: false,
        clipMode: "hidden",
        whiteSpaceHandling: opts.wrap ? "normal" : "pre",
      });
      noDrag(t);
      t.eventsAreIgnored = true;
      return t;
    }

    // Material Symbols glyph (see CLAUDE.md's icon note); box sized from the
    // glyph's designed px size, not measured.
    function icon(rect, ligature, px, color) {
      var t = new lively.morphic.Text(rect, ligature);
      t.applyStyle({
        fontFamily: "'Material Symbols Rounded'", fontSize: px * 0.75,
        textColor: color, fill: null, borderWidth: 0, align: "center",
        allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
      });
      noDrag(t);
      t.eventsAreIgnored = true;
      return t;
    }

    lively.identity.MiniProfileCard = {
      _scrim: null,
      _card: null,

      close: function () {
        if (this._card)  { this._card.remove();  this._card = null; }
        if (this._scrim) { this._scrim.remove(); this._scrim = null; }
      },

      // Home host (e.g. "tinylil.world") from a DID document's "#home"
      // service entry, or null.
      _homeHostOf: function (doc) {
        var services = (doc && Array.isArray(doc.service)) ? doc.service : [];
        for (var i = 0; i < services.length; i++) {
          var s = services[i];
          if (s && s.id === doc.id + "#home" && typeof s.serviceEndpoint === "string") {
            return s.serviceEndpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "") || null;
          }
        }
        return null;
      },

      // anchor is either a morph (worldPoint()/getExtent(), as every
      // existing call site passes) or a plain lively.pt(x, y) already in
      // world coordinates (WikiView.js's DOM-anchored chips: there's no
      // morph to point at, so the caller computes the world position
      // itself via its own worldPoint()).
      open: function (handle, did, anchor) {
        var self = this;
        this.close(); // only one popover open at a time

        var W = window.innerWidth, H = window.innerHeight;
        // World coordinates equal page/document coordinates (Core.js's
        // worldPoint composes the owner-chain transform, independent of
        // scroll) — but the viewport clamp bounds below are naturally
        // viewport-relative, so they need the current scroll offset added
        // to stay correct when the world is taller than the viewport and
        // the page has scrolled (see WikiView.js's _growWorldToFit). Zero
        // for every existing non-scrolling call site, so this is a no-op
        // there.
        var scrollX = (document.scrollingElement && document.scrollingElement.scrollLeft) || 0;
        var scrollY = (document.scrollingElement && document.scrollingElement.scrollTop) || 0;

        var scrim = new lively.morphic.Box(lively.rect(scrollX, scrollY, W, H));
        scrim.applyStyle({ fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
        noDrag(scrim);
        scrim.onMouseUp = function (evt) { self.close(); evt.stop(); return true; };
        $world.addMorph(scrim);
        this._scrim = scrim;

        // anchorMorph lives directly in $world (same coordinate space, no
        // owner transform to account for) in every current call site, so
        // its worldPoint() is usable as-is for the card's own position.
        var anchorPos = (typeof anchor.worldPoint === "function")
          ? anchor.worldPoint(lively.pt(0, anchor.getExtent().y))
          : anchor;
        var px = Math.min(Math.max(8 + scrollX, anchorPos.x), scrollX + W - CARD_W - 8);
        var wantY = Math.max(8 + scrollY, anchorPos.y + 4);
        var py = Math.min(wantY, scrollY + H - LOADING_H - 8);

        var card = new lively.morphic.Box(lively.rect(px, py, CARD_W, LOADING_H));
        card.applyStyle({ fill: Color.white, borderRadius: 10, borderWidth: 1, borderColor: PINK, clipMode: "visible" });
        noDrag(card);
        // card intentionally has no onMouseUp of its own — added to $world
        // AFTER the scrim, so sibling paint/hit-test order alone keeps
        // clicks on it from reaching the scrim underneath (mirrors
        // CalendarApp.js's popover; see CLAUDE.md's capture-first mouse
        // dispatch note: an ancestor with no onMouseUp never blocks a
        // nested child's, and there's no ancestor/descendant relationship
        // between scrim and card here anyway — plain siblings).

        var avatar = new lively.morphic.Image(lively.rect(14, 14, 40, 40));
        avatar.setImageURL(lively.identity.postCardUtils.identiconDataUrl(did || handle, 40));
        avatar.applyStyle({ borderRadius: 20, borderWidth: 0, clipMode: "hidden" });
        noDrag(avatar);
        avatar.eventsAreIgnored = true;
        card.addMorph(avatar);

        var nameT = label(lively.rect(64, 16, HEAD_W, 18), trunc(handle, NAME_MAX), { px: 13, bold: true });
        card.addMorph(nameT);

        var handleT = label(lively.rect(64, 34, HEAD_W, 16), "@" + trunc(handle, HANDLE_MAX), { px: 11, color: TEXT_MUTED });
        card.addMorph(handleT);

        var loadingT = label(lively.rect(14, 62, CARD_W - 28, 20), "Loading…", { px: 11, color: Color.rgb(90, 90, 90) });
        card.addMorph(loadingT);

        // Modeled after the window chrome's own close button (base_theme.css's
        // .Button.WindowControl.close: circle backdrop, "close" glyph, red
        // circle + white glyph on hover) — same fontSize*0.75/padding-inset
        // icon-button idiom as ConstellationLounge.js's editBtn.
        var CLOSE = 22, CLOSE_GLYPH_PX = 13;
        var CLOSE_FILL = Color.rgb(240, 240, 240);
        var closeX = new lively.morphic.Text(lively.rect(CARD_W - 8 - CLOSE, 8, CLOSE, CLOSE), "close");
        closeX.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          fontSize: CLOSE_GLYPH_PX * 0.75,
          textColor: TEXT_MUTED,
          fill: CLOSE_FILL,
          borderRadius: CLOSE / 2,
          borderWidth: 0,
          align: "center",
          // 3px, not (CLOSE - CLOSE_GLYPH_PX)/2: the glyph's text box sits ~2px low
          // inside its circle at this size, measured live, so this centers the X.
          padding: lively.Rectangle.inset(0, 3, 0, 0),
          allowInput: false, selectable: false, clipMode: "hidden",
          whiteSpaceHandling: "pre", handStyle: "pointer",
        });
        noDrag(closeX);
        closeX.onMouseOver = function () { closeX.applyStyle({ fill: CLOSE_HOVER_RED, textColor: Color.white }); };
        closeX.onMouseOut  = function () { closeX.applyStyle({ fill: CLOSE_FILL, textColor: TEXT_MUTED }); };
        closeX.onMouseUp = function (evt) { self.close(); evt.stop(); return true; };
        card.addMorph(closeX);

        $world.addMorph(card);
        // Soft drop shadow, same idiom/values as the other floating panels
        // (FilePreview, WikiEditor): written straight to the shape node.
        card.renderContext().shapeNode.style.boxShadow = "0 4px 12px rgba(0,0,0,0.18)";
        this._card = card;

        var profileP = fetch("/@" + handle + "/profile", { credentials: "include" })
          .then(function (res) { return res.ok ? res.json() : null; });
        var hostP = fetch("/@" + handle + "/did-document", { credentials: "include" })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (doc) { return self._homeHostOf(doc); });

        Promise.all([profileP, hostP.catch(function () { return null; })])
          .then(function (r) { return { env: r[0], host: r[1], failed: false }; },
                function ()  { return { env: null, host: null, failed: true }; })
          .then(function (res) {
            if (self._card !== card) return; // popover closed/replaced before this resolved
            var payload = (res.env && res.env.record && res.env.record.payload) || {};
            if (res.env && payload.avatarUrl) avatar.setImageURL(payload.avatarUrl);
            if (res.env) {
              nameT.setTextString(trunc(payload.displayName || handle, NAME_MAX));
            }
            loadingT.remove();
            self._buildBody(card, {
              handle: handle,
              sunSign: res.env ? payload.sunSign : null,
              host: res.env ? res.host : null,
              bio: res.env ? (payload.bio || "").trim() : null,
              bioFallback: res.env ? "No bio yet." : "Could not load profile.",
              wantY: wantY,
              scrollY: scrollY,
            });
          });
      },

      // Meta rows + bio + "View full profile" button, laid out top to bottom
      // with each morph's final position baked into its constructor rect
      // (CLAUDE.md: don't setPosition a child right after addMorph), then the
      // card itself is resized to fit. Sun sign and host rows are only built
      // when there's a value for them, so an unset sign leaves no gap.
      _buildBody: function (card, d) {
        var self = this;
        var y = 62;
        var contentW = CARD_W - 28;

        var signIdx = SIGNS.indexOf(d.sunSign);
        if (signIdx >= 0) {
          var rgb = ELEMENT_RGB[signIdx % 4];
          // icons at y - ICON_NUDGE: measured live, an icon glyph's center sits
          // ~2.3px below the center of the adjacent Helvetica label at this size
          card.addMorph(icon(lively.rect(14, y - ICON_NUDGE, 18, ROW_H), "wb_sunny", 14, PINK));
          card.addMorph(label(lively.rect(36, y, contentW - 22, ROW_H), GLYPHS[signIdx] + " " + SIGNS[signIdx],
            { px: 11, bold: true, color: Color.rgb(rgb[0], rgb[1], rgb[2]) }));
          y += ROW_H + ROW_GAP;
        }

        if (d.host) {
          card.addMorph(icon(lively.rect(14, y - ICON_NUDGE, 18, ROW_H), "dns", 14, TEXT_MUTED));
          card.addMorph(label(lively.rect(36, y, contentW - 22, ROW_H), trunc(d.host, HOST_MAX),
            { px: 11, color: TEXT_MUTED }));
          y += ROW_H + ROW_GAP;
        }

        var bioText = d.bio ? trunc(d.bio, BIO_MAX) : d.bioFallback;
        var bioLines = Math.min(BIO_MAX_LINES, Math.max(1, Math.ceil(bioText.length / BIO_CHARS_PER_LINE)));
        var bioH = bioLines * BIO_LINE_H + 4;
        card.addMorph(label(lively.rect(14, y + 2, contentW, bioH), bioText,
          { px: 11, color: d.bio ? Color.rgb(90, 90, 90) : TEXT_MUTED, wrap: true }));
        y += 2 + bioH + 8;

        var cardH = self._addViewButton(card, d.handle, y) + 10;
        card.setExtent(lively.pt(CARD_W, cardH));

        // The taller card may no longer fit below the anchor: pull it up.
        var H = window.innerHeight;
        var scrollY = d.scrollY || 0;
        var pos = card.getPosition();
        var newY = Math.min(d.wantY, scrollY + H - cardH - 8);
        if (newY !== pos.y) card.setPosition(lively.pt(pos.x, Math.max(8 + scrollY, newY)));
      },

      // Returns the y of the button's bottom edge.
      _addViewButton: function (card, handle, y) {
        var self = this;

        // Label + trailing "arrow_outward" glyph, positioned as a tight
        // pair centered in the button rather than each independently
        // centered in its own half (which would leave an uneven gap
        // between them) — VIEW_LABEL_W is this exact string's real
        // rendered width at this fontSize, measured live once via a
        // throwaway probe morph and hardcoded here, same idiom as
        // WorldsBrowser.js's back-link width (CLAUDE.md: safe for a
        // short, static label that never changes).
        var VIEW_LABEL_W = 81, ICON_PX = 13, GAP = 4;
        var btnW = CARD_W - 28;
        var pairW = VIEW_LABEL_W + GAP + ICON_PX;
        var pairX = Math.round((btnW - pairW) / 2);

        var viewBtn = new lively.morphic.Box(lively.rect(14, y, btnW, 24));
        viewBtn.applyStyle({ fill: Color.white, borderRadius: 12, borderWidth: 1, borderColor: PINK, clipMode: "hidden" });
        noDrag(viewBtn);
        viewBtn.onMouseOver = function () { viewBtn.applyStyle({ fill: Color.rgb(253, 235, 243) }); };
        viewBtn.onMouseOut  = function () { viewBtn.applyStyle({ fill: Color.white }); };
        viewBtn.onMouseUp = function (evt) {
          self.close();
          lively.require("lively.identity.ProfileCard").toRun(function () {
            lively.identity.ProfileCard.open(handle);
          });
          evt.stop();
          return true;
        };
        card.addMorph(viewBtn);

        var viewLabel = new lively.morphic.Text(lively.rect(pairX - 4, 0, VIEW_LABEL_W + 8, 24), "View full profile");
        viewLabel.applyStyle({
          fontSize: 11 * 0.75, fontWeight: "600", textColor: PINK, fill: null, borderWidth: 0,
          align: "left", padding: lively.Rectangle.inset(0, 5, 0, 0),
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        noDrag(viewLabel);
        viewLabel.eventsAreIgnored = true;
        viewBtn.addMorph(viewLabel);

        // x/padding-top both nudged from their naive computed values by an
        // empirical correction (measured live via getBoundingClientRect on
        // both glyphs: real gap came out ~12px against an intended ~4px,
        // and the icon's glyph center sat ~2.7px below the label's) —
        // same "measure, don't trust the naive box math" discipline as
        // the rest of this codebase's text-sizing gotchas.
        var viewIcon = new lively.morphic.Text(lively.rect(pairX + VIEW_LABEL_W + GAP - 8, 0, ICON_PX + 8, 24), "arrow_outward");
        viewIcon.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: ICON_PX * 0.75,
          textColor: PINK, fill: null, borderWidth: 0,
          align: "center", padding: lively.Rectangle.inset(0, Math.round((24 - ICON_PX) / 2) - 3, 0, 0),
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        noDrag(viewIcon);
        viewIcon.eventsAreIgnored = true;
        viewBtn.addMorph(viewIcon);

        return y + 24;
      },
    };

  }); // end module('lively.identity.MiniProfileCard')
