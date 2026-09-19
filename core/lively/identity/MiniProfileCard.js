/**
 * lively.identity.MiniProfileCard
 *
 * A small anchored popover (avatar, display name, @handle, short bio
 * snippet, "View full profile" button) shown when a handle rendered
 * elsewhere in the app (e.g. ConstellationLounge.js's co-creator handle)
 * is clicked. Not a lively.BuildSpec window like ProfileCard.js — this is
 * a transient scrim+box popover, dismissed on outside click, following the
 * same shape as CalendarApp.js's _showEventPopover/_hidePopover.
 *
 * Open: lively.identity.MiniProfileCard.open(handle, did, anchorMorph)
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
    var CARD_W = 260, CARD_H = 116;

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

    lively.identity.MiniProfileCard = {
      _scrim: null,
      _card: null,

      close: function () {
        if (this._card)  { this._card.remove();  this._card = null; }
        if (this._scrim) { this._scrim.remove(); this._scrim = null; }
      },

      open: function (handle, did, anchorMorph) {
        var self = this;
        this.close(); // only one popover open at a time

        var W = window.innerWidth, H = window.innerHeight;

        var scrim = new lively.morphic.Box(lively.rect(0, 0, W, H));
        scrim.applyStyle({ fill: Color.rgba(0, 0, 0, 0), borderWidth: 0 });
        noDrag(scrim);
        scrim.onMouseUp = function (evt) { self.close(); evt.stop(); return true; };
        $world.addMorph(scrim);
        this._scrim = scrim;

        // anchorMorph lives directly in $world (same coordinate space, no
        // owner transform to account for) in every current call site, so
        // its worldPoint() is usable as-is for the card's own position.
        var anchorPos = anchorMorph.worldPoint(lively.pt(0, anchorMorph.getExtent().y));
        var px = Math.min(Math.max(8, anchorPos.x), W - CARD_W - 8);
        var py = Math.min(Math.max(8, anchorPos.y + 4), H - CARD_H - 8);

        var card = new lively.morphic.Box(lively.rect(px, py, CARD_W, CARD_H));
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

        var nameT = label(lively.rect(64, 16, CARD_W - 78, 18), handle, { px: 13, bold: true });
        card.addMorph(nameT);

        var handleT = label(lively.rect(64, 34, CARD_W - 78, 16), "@" + handle, { px: 11, color: TEXT_MUTED });
        card.addMorph(handleT);

        var bioT = label(lively.rect(14, 62, CARD_W - 28, 32), "Loading…", { px: 11, color: Color.rgb(90, 90, 90), wrap: true });
        card.addMorph(bioT);

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

        var viewBtn = new lively.morphic.Box(lively.rect(14, CARD_H - 34, btnW, 24));
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

        fetch("/@" + handle + "/profile", { credentials: "include" })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (env) {
            if (!env || self._card !== card) return; // popover closed/replaced before this resolved
            var payload = (env.record && env.record.payload) || {};
            nameT.setTextString(payload.displayName || handle);
            var bio = (payload.bio || "").trim();
            bioT.setTextString(bio ? (bio.length > 90 ? bio.slice(0, 90) + "…" : bio) : "No bio yet.");
            if (payload.avatarUrl) avatar.setImageURL(payload.avatarUrl);
          })
          .catch(function () {
            if (self._card === card) bioT.setTextString("Could not load profile.");
          });
      },
    };

  }); // end module('lively.identity.MiniProfileCard')
