/**
 * lively.identity.RoomView
 *
 * A single room's Discord-like live view: chat, a real-presence member
 * list, and voice/video controls — the "enter a room" destination that
 * ConstellationLounge.js's Spaces panel cards previously had no real place
 * to send you (joining there only ever touched an in-memory heartbeat/
 * headcount and left you on the lounge page).
 *
 * Boots at /c/:name/rooms/:roomId (IdentityServer.js's buildRoomViewPage +
 * GET /c/:constellation/rooms/:roomId route), same manuallyCreateWorld/
 * onStartWorld boot shape as ConstellationCanvas.js/ConstellationLounge.js —
 * see those files' own header comments for why (no per-user home-world
 * config to fall back on for a bare boot page).
 *
 * Scope this session (see the rooms-UI planning doc): chat is mock/local-
 * only (no persistence — a future session rides the same objects-envelope
 * rail postcards/wiki pages already use, `state.kind:'room-message'`, see
 * the design note at the bottom of this file); the member list and
 * presence join/heartbeat are real (RoomPresence.js); your own video
 * circle streams a real getUserMedia camera preview (via
 * lively.identity.AmbientPresencePanel.enterRoom/getLocalStream — no
 * duplicate media acquisition here), other participants render as static
 * identicon-avatar circles until real peer WebRTC signaling exists.
 *
 * Rendering convention: every visible element is a real Lively morph
 * (Box/Text/Image), added to $world — same "no raw DOM overlay" discipline
 * ConstellationLounge.js's own header comment documents and justifies
 * (halo-selectable, Object-Editor inspectable, correct focus/z-order).
 *
 * Open: lively.identity.RoomView.open(constellationName, roomId) — called
 * from buildRoomViewPage's onStartWorld hook once $world exists.
 */

module("lively.identity.RoomView")
  .requires(
    "lively.identity.DID",
    "lively.identity.PostCardUtils",
    "lively.identity.AmbientPresencePanel",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    var BG_MAIN    = Color.rgb(0x36, 0x05, 0x38);     // #360538 — chat area
    var BG_SIDEBAR = Color.rgb(0x63, 0x09, 0x67);     // #630967 — header + members panel
    var BG_INPUT   = Color.rgb(0x63, 0x09, 0x67);     // #630967 — message input pill
    var BG_ROW_HOVER = Color.rgba(255, 255, 255, 0.04);
    var TEXT_PRIMARY = Color.rgb(242, 243, 245);
    var TEXT_MUTED   = Color.rgb(148, 155, 164);
    var TEXT_FAINT   = Color.rgb(114, 118, 125);
    var ACCENT = Color.rgb(79, 11, 67);       // #4F0B43 — matches ConstellationLounge's ROOM_ACCENT
    var DANGER = Color.rgb(242, 63, 66);
    var ONLINE = Color.rgb(35, 165, 89);

    var HEADER_H = 48;
    var MEMBERS_W = 240;
    var ROOMS_PANEL_W = 220;
    var CHAT_W = 760;
    var BODY_H = 620;
    // Gap between adjoining boxes (rooms panel/chat/members panel) -- each
    // is a separate box rather than directly abutting the next, same
    // "distinct card, own margin" treatment ConstellationLounge.js's
    // right-hand co-creator/members sidebar uses.
    var PANEL_GAP = 20;
    // x-offset from the view's own origin to where the chat box starts --
    // the rooms panel (this constellation's other rooms, similar intent to
    // WikiIndex.js's left sidebar page list) occupies the space before it.
    var CHAT_X_OFFSET = ROOMS_PANEL_W + PANEL_GAP;
    var TOTAL_W = CHAT_X_OFFSET + CHAT_W + PANEL_GAP + MEMBERS_W;
    var TOTAL_H = HEADER_H + BODY_H;
    var INPUT_H = 52;
    var AVATAR_MSG = 28, AVATAR_MEMBER = 28;
    var VIDEO_CIRCLE = 96;

    // Plain Box/Text/Image morphs default to draggable/droppable/grabbable —
    // fine for the video circles (draggable by design), wrong for every
    // other piece of chrome here, where it means a click that so much as
    // twitches the mouse between down and up gets eaten as a drag instead
    // of firing its own click handler (real bug hit live, see project
    // memory). draggingEnabled alone is NOT enough to stop this: Events.js's
    // drag-start check is `targetMorph.draggingEnabled || targetMorph.isGrabbable()`,
    // and isGrabbable() (MorphAddons.js) defaults to *true* whenever
    // grabbingEnabled was never explicitly set (`this.grabbingEnabled ||
    // this.grabbingEnabled === undefined`) — so leaving grabbingEnabled
    // untouched keeps a morph pick-up-able via the OR even after
    // draggingEnabled is turned off (confirmed live: setting only
    // draggingEnabled/droppingEnabled false did not actually stop dragging).
    // Not a closure-loss risk to pull out as a plain module-level helper
    // here — RoomViewController is a normal Object.subclass instance method
    // set, never reconstructed from source text the way a BuildSpec/
    // addScript function is (see AmbientPresencePanel.js's header comment
    // for that distinct gotcha, which doesn't apply to this file at all).
    function noDrag(m) {
      m.draggingEnabled = false;
      m.droppingEnabled = false;
      m.grabbingEnabled = false;
      return m;
    }

    Object.subclass("lively.identity.RoomViewController",

    "initializing", {
      initialize: function () {
        this._name = null;
        this._roomId = null;
        this._room = null;
        this._isController = false;
        this._participants = [];  // [{did, handle}]
        this._messages = [];      // mock/local-only this session, see file header
        this._heartbeatTimer = null;
        this._videoCircles = {};  // did -> morph
        this._boundLeaveBestEffort = null;
        this._originX = 0;        // set for real by _computeOrigin before anything renders
        this._originY = 0;
      },
    },

    // ─── boot ─────────────────────────────────────────────────────────────────

    "boot", {

      open: function (name, roomId) {
        this._name = name;
        this._roomId = roomId;
        // DID.js's restoreSession() is a multi-step async chain kicked off at
        // module-load time — reading currentUser() synchronously at a fixed
        // boot point (as everything below this does: seeding "you" into mock
        // chat, matching yourself in the member list/video circles) races it
        // with no ordering guarantee. restoreSession is idempotent, so
        // calling it again here just gets a definitive answer either way
        // before proceeding — same fix idiom as Shop.js/ConstellationLounge.js's
        // own boot-time identity reads.
        var self = this;
        lively.identity.did.restoreSession(function () { self._fetchRoomDetail(); });
      },

      _fetchRoomDetail: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) {
            return self._showFatalError(
              xhr.status === 404
                ? "This room doesn't exist, or you don't have access to it."
                : "Failed to load room (" + xhr.status + ")"
            );
          }
          var data;
          try { data = JSON.parse(xhr.responseText); }
          catch (e) { return self._showFatalError("Bad room response"); }
          self._room = data.room;
          self._isController = !!data.isController;
          self._participants = data.participants || [];
          self._start();
        };
        xhr.onerror = function () { self._showFatalError("Network error loading room"); };
        xhr.send();
      },

      // Computed once at boot (not re-centered on later resize, same fixed-
      // pixel-panel convention ConstellationLounge.js's own header comment
      // documents) — without this, every top-level box below is positioned
      // from a literal (0,0), which renders pinned to the browser's actual
      // top-left corner rather than centered in the visible world, exactly
      // the "renders at the top left of the page" bug reported live.
      _computeOrigin: function () {
        var bounds = $world.visibleBounds();
        this._originX = Math.max(0, Math.round((bounds.width - TOTAL_W) / 2));
        this._originY = Math.max(0, Math.round((bounds.height - TOTAL_H) / 2));
      },

      _start: function () {
        this._computeOrigin();
        this._seedMockMessages();
        this._buildHeader();
        this._buildRoomsPanel();
        this._buildChatPanel();
        this._buildMembersPanel();
        this._buildVideoLayer();
        this._renderMessages();
        this._renderMembers();
        this._renderVideoCircles();
        this._joinPresence();
        this._startHeartbeat();

        this._boundLeaveBestEffort = this._leaveBestEffort.bind(this);
        window.addEventListener("pagehide", this._boundLeaveBestEffort);
        window.addEventListener("beforeunload", this._boundLeaveBestEffort);

        var self = this;
        lively.require("lively.identity.AmbientPresencePanel").toRun(function () {
          lively.identity.AmbientPresencePanel.enterRoom({
            constellation: self._name, roomId: self._roomId, roomName: self._room.name,
            onLeaveRequested: function () { self._leaveRoomAndReturn(); },
          });
          // getUserMedia resolves asynchronously (real permission prompt) —
          // the self video circle already exists (blank) from
          // _renderVideoCircles above, so poll briefly for the stream and
          // fill it in once ready rather than re-creating the circle.
          self._waitForLocalStreamThenFill(20);
        });
      },

      _waitForLocalStreamThenFill: function (attemptsLeft) {
        var user = lively.identity.did.currentUser();
        var myDid = user ? user.did : null;
        var circle = myDid && this._videoCircles[myDid];
        if (circle && !circle._hasLocalVideo && this._fillWithLocalStream(circle)) return;
        if (attemptsLeft <= 0) return;
        var self = this;
        setTimeout(function () { self._waitForLocalStreamThenFill(attemptsLeft - 1); }, 300);
      },

      _showFatalError: function (msg) {
        console.error("[RoomView]", msg);
        var label = noDrag(lively.morphic.Text.makeLabel(msg, {
          fontSize: 14, textColor: Color.rgb(220, 220, 220), fixedWidth: true, fixedHeight: true,
        }));
        label.setExtent(lively.pt(420, 80));
        label.setPosition($world.visibleBounds().center().subPt(lively.pt(210, 40)));
        label.applyStyle({ align: "center" });
        $world.addMorph(label);
      },

    },

    // ─── presence — join/heartbeat/leave ───────────────────────────────────────
    // Same POST/DELETE .../presence + 25s-heartbeat idiom ConstellationLounge.js's
    // _joinRoom/_startHeartbeat/_leaveAllRoomsBestEffort already use — this page
    // is always allowed to join (canJoinRoom already gated booting the world at
    // all, server-side), so failures here are logged, not surfaced as a denial.

    "presence", {

      _joinPresence: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("POST", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId + "/presence", true);
        xhr.withCredentials = true;
        // The room-detail fetch that seeded this._participants ran *before*
        // this join, so it never included yourself — refresh right away
        // rather than leaving the member list/your own video circle missing
        // until the next 25s heartbeat tick.
        xhr.onload = function () { if (xhr.status === 200) self._refreshRoster(); };
        xhr.onerror = function () { console.error("[RoomView] Network error joining room presence"); };
        xhr.send();
      },

      _startHeartbeat: function () {
        var self = this;
        this._heartbeatTimer = setInterval(function () {
          self._sendHeartbeat();
          self._refreshRoster();
        }, 25000);
      },

      _sendHeartbeat: function () {
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("POST", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId + "/presence", true);
        xhr.withCredentials = true;
        xhr.send();
      },

      // Re-fetches the room detail JSON to pick up roster/participant-count
      // changes (other people joining/leaving) — reuses the same GET this
      // page's own boot already made, rather than a second bespoke route.
      _refreshRoster: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          self._participants = data.participants || [];
          self._renderMembers();
          self._renderVideoCircles();
          self._updateParticipantCount();
          self._fetchRoomsList(); // keeps the left rail's "N here" counts fresh too
        };
        xhr.send();
      },

      _leaveRoomAndReturn: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("DELETE", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId + "/presence", true);
        xhr.withCredentials = true;
        xhr.onload = function () { self._returnToLounge(); };
        xhr.onerror = function () { self._returnToLounge(); };
        xhr.send();
        lively.identity.AmbientPresencePanel.leaveRoom();
      },

      _returnToLounge: function () {
        location.href = lively.identity.did.baseUrl() + "/c/" + encodeURIComponent(this._name);
      },

      // Synchronous XHR + no navigation — same reasoning as ConstellationLounge.js's
      // own _leaveAllRoomsBestEffort (pagehide/beforeunload need something that's
      // actually guaranteed to send before the page tears down).
      _leaveBestEffort: function () {
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("DELETE", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId + "/presence", false);
        xhr.withCredentials = true;
        try { xhr.send(); } catch (e) {}
        try { lively.identity.AmbientPresencePanel.leaveRoom(); } catch (e) {}
      },

    },

    // ─── chrome — header ────────────────────────────────────────────────────────

    "chrome", {

      _buildHeader: function () {
        var self = this;
        var header = noDrag(new lively.morphic.Box(lively.rect(this._originX, this._originY, TOTAL_W, HEADER_H)));
        header.applyStyle({ fill: BG_SIDEBAR, borderWidth: 0 });
        $world.addMorph(header);
        this._headerBox = header;

        var nameM = noDrag(lively.morphic.Text.makeLabel(this._room.name || "", {
          fontSize: 15, fontWeight: "700", textColor: TEXT_PRIMARY, fixedWidth: true, fixedHeight: true,
        }));
        nameM.eventsAreIgnored = true;
        nameM.setPosition(lively.pt(16, 14));
        nameM.setExtent(lively.pt(300, 20));
        header.addMorph(nameM);

        var ICON = 18, ICON_GAP = 6;
        var icons = [];
        if (this._room.isVideo) icons.push("videocam");
        if (this._room.isVoice) icons.push("headset");
        var ix = 16;
        var textW = nameM.renderContext().shapeNode.querySelector("span");
        ix += (textW ? textW.offsetWidth : 100) + 12;
        icons.forEach(function (glyph) {
          var g = noDrag(lively.morphic.Text.makeLabel(glyph, { fontSize: 11, textColor: TEXT_MUTED }));
          g.applyStyle({ fontFamily: "'Material Symbols Rounded'", borderWidth: 0 });
          g.eventsAreIgnored = true;
          g.setExtent(lively.pt(ICON, ICON));
          g.setPosition(lively.pt(ix, 15));
          header.addMorph(g);
          ix += ICON + ICON_GAP;
        });

        this._countM = noDrag(lively.morphic.Text.makeLabel("", {
          fontSize: 12, textColor: TEXT_MUTED, fixedWidth: true, fixedHeight: true,
        }));
        this._countM.eventsAreIgnored = true;
        this._countM.setExtent(lively.pt(160, 18));
        this._countM.setPosition(lively.pt(ix + 8, 15));
        header.addMorph(this._countM);
        this._updateParticipantCount();

        var leaveBtn = noDrag(new lively.morphic.Box(lively.rect(TOTAL_W - 16 - 110, 9, 110, 30)));
        leaveBtn.applyStyle({ fill: DANGER, borderWidth: 0, borderRadius: 15 });
        header.addMorph(leaveBtn);
        var leaveLabel = lively.morphic.Text.makeLabel("Leave Room", {
          fontSize: 12.5, fontWeight: "700", textColor: Color.white, fixedWidth: true, fixedHeight: true,
        });
        leaveLabel.setExtent(lively.pt(110, 18));
        leaveLabel.setPosition(lively.pt(0, 6));
        leaveLabel.applyStyle({ align: "center", borderWidth: 0 });
        leaveLabel.eventsAreIgnored = true;
        leaveBtn.addMorph(leaveLabel);
        leaveBtn.onMouseDown = function () { self._leaveRoomAndReturn(); };
      },

      _updateParticipantCount: function () {
        if (!this._countM) return;
        var n = this._participants.length;
        this._countM.textString = n === 1 ? "1 here" : (n + " here");
      },

    },

    // ─── rooms panel ────────────────────────────────────────────────────────────
    // Left-hand rail listing every room in this constellation (name + live
    // participant count) — similar intent to WikiIndex.js's left sidebar
    // page list: a standing way to jump between rooms without first going
    // back to the Lounge. Fetches the same GET /c/:name/rooms
    // ConstellationLounge.js's Spaces panel already uses. Clicking a room
    // (other than the one you're already in) navigates straight into it,
    // same as clicking a room card in the Lounge.

    "rooms panel", {

      _buildRoomsPanel: function () {
        var panel = noDrag(new lively.morphic.Box(lively.rect(
          this._originX, this._originY + HEADER_H, ROOMS_PANEL_W, BODY_H)));
        panel.applyStyle({ fill: BG_SIDEBAR, borderWidth: 0, clipMode: "auto" });
        $world.addMorph(panel);
        this._roomsPanelBox = panel;

        var heading = noDrag(lively.morphic.Text.makeLabel("ROOMS", {
          fontSize: 11, fontWeight: "700", textColor: TEXT_MUTED,
        }));
        heading.eventsAreIgnored = true;
        heading.setPosition(lively.pt(16, 16));
        heading.setExtent(lively.pt(ROOMS_PANEL_W - 32, 16));
        panel.addMorph(heading);

        this._fetchRoomsList();
      },

      _fetchRoomsList: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/rooms", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          self._renderRoomsList(data.rooms || []);
        };
        xhr.send();
      },

      _renderRoomsList: function (rooms) {
        var self = this;
        var panel = this._roomsPanelBox;
        if (!panel) return;
        (panel._roomItemMorphs || []).forEach(function (m) { m.remove(); });
        panel._roomItemMorphs = [];

        var y = 44;
        rooms.forEach(function (room) {
          var isCurrent = room.id === self._roomId;
          var row = noDrag(new lively.morphic.Box(lively.rect(8, y, ROOMS_PANEL_W - 16, 40)));
          row.applyStyle({ fill: isCurrent ? ACCENT : null, borderWidth: 0, borderRadius: 6 });
          panel.addMorph(row);
          panel._roomItemMorphs.push(row);

          var nameM = noDrag(lively.morphic.Text.makeLabel(room.name || "", {
            fontSize: 13, fontWeight: isCurrent ? "700" : "500",
            textColor: isCurrent ? Color.white : TEXT_PRIMARY, fixedWidth: true, fixedHeight: true,
          }));
          nameM.eventsAreIgnored = true;
          nameM.setPosition(lively.pt(10, 6));
          nameM.setExtent(lively.pt(ROOMS_PANEL_W - 16 - 20, 16));
          row.addMorph(nameM);

          var count = room.participantCount || 0;
          var countM = noDrag(lively.morphic.Text.makeLabel(
            count === 1 ? "1 here" : (count + " here"),
            {
              fontSize: 11, textColor: isCurrent ? Color.rgba(255, 255, 255, 0.75) : TEXT_FAINT,
              fixedWidth: true, fixedHeight: true,
            }
          ));
          countM.eventsAreIgnored = true;
          countM.setPosition(lively.pt(10, 22));
          countM.setExtent(lively.pt(ROOMS_PANEL_W - 16 - 20, 14));
          row.addMorph(countM);

          if (!isCurrent) {
            row.renderContext().shapeNode.style.cursor = "pointer";
            row.onMouseOver = function () { row.applyStyle({ fill: BG_ROW_HOVER }); };
            row.onMouseOut = function () { row.applyStyle({ fill: null }); };
            row.onMouseDown = function () {
              location.href = lively.identity.did.baseUrl() + "/c/" + encodeURIComponent(self._name) + "/rooms/" + room.id;
            };
          }

          y += 44;
        });
      },

    },

    // ─── chat panel ─────────────────────────────────────────────────────────────
    // Mock/local-only this session (see file header) — messages live only in
    // this._messages and vanish on reload. Sending appends locally; there is
    // no server round-trip yet.

    "chat", {

      _seedMockMessages: function () {
        var user = lively.identity.did.currentUser();
        var me = user ? user.handle : "you";
        this._messages = [
          { handle: "sable",  text: "hey, anyone want to hop in?", ts: Date.now() - 9 * 60000 },
          { handle: "quartz", text: "just got here, mic's a little echoey today", ts: Date.now() - 6 * 60000 },
          { handle: me,       text: "joining now 👋", ts: Date.now() - 30000 },
        ];
      },

      _buildChatPanel: function () {
        var self = this;
        var chat = noDrag(new lively.morphic.Box(lively.rect(this._originX + CHAT_X_OFFSET, this._originY + HEADER_H, CHAT_W, BODY_H)));
        chat.applyStyle({ fill: BG_MAIN, borderWidth: 0 });
        $world.addMorph(chat);
        this._chatBox = chat;

        var listH = BODY_H - INPUT_H;
        var list = noDrag(new lively.morphic.Box(lively.rect(0, 0, CHAT_W, listH)));
        list.applyStyle({ fill: null, borderWidth: 0, clipMode: "auto" });
        chat.addMorph(list);
        this._msgListBox = list;

        var inputRow = noDrag(new lively.morphic.Box(lively.rect(0, listH, CHAT_W, INPUT_H)));
        inputRow.applyStyle({ fill: BG_MAIN, borderWidth: 0 });
        chat.addMorph(inputRow);

        var pill = noDrag(new lively.morphic.Box(lively.rect(16, 8, CHAT_W - 32, 36)));
        pill.applyStyle({ fill: BG_INPUT, borderWidth: 0, borderRadius: 8 });
        inputRow.addMorph(pill);

        var input = noDrag(new lively.morphic.Text(lively.rect(12, 8, CHAT_W - 32 - 60, 20)));
        input.beInputLine({
          fontSize: 13, fontFamily: "Helvetica", textColor: TEXT_PRIMARY,
          fill: null, borderWidth: 0, whiteSpaceHandling: "pre",
        });
        pill.addMorph(input);
        this._inputM = input;

        var placeholder = lively.morphic.Text.makeLabel("Message #" + (this._room.name || "room"), {
          fontSize: 13, textColor: TEXT_FAINT,
        });
        placeholder.setExtent(lively.pt(CHAT_W - 32 - 60, 20));
        placeholder.setPosition(lively.pt(12, 8));
        placeholder.eventsAreIgnored = true;
        pill.addMorph(placeholder);
        this._placeholderM = placeholder;

        // Plain property assignment (not addScript) — this controller isn't
        // a lively.BuildSpec, so a normal closure over `self` here is safe
        // (only addScript'd/BuildSpec-reconstructed functions lose theirs;
        // see ConstellationLounge.js's own search-field onKeyDown for the
        // same idiom).
        var superKeyDown = input.onKeyDown;
        input.onKeyDown = function (evt) {
          if (evt.getKeyCode && evt.getKeyCode() === 13) {
            self._onSendMessage();
            evt.stop();
            return true;
          }
          var result = superKeyDown ? superKeyDown.call(this, evt) : undefined;
          self._placeholderM.setVisible(!this.textString);
          return result;
        };
      },

      _onSendMessage: function () {
        var text = (this._inputM.textString || "").trim();
        if (!text) return;
        var user = lively.identity.did.currentUser();
        this._messages.push({ handle: user ? user.handle : "you", text: text, ts: Date.now() });
        this._inputM.textString = "";
        this._placeholderM.setVisible(true);
        this._renderMessages();
      },

      _formatTime: function (ts) {
        var d = new Date(ts);
        var h = d.getHours(), m = d.getMinutes();
        var ampm = h >= 12 ? "PM" : "AM";
        h = h % 12; if (h === 0) h = 12;
        return h + ":" + (m < 10 ? "0" : "") + m + " " + ampm;
      },

      _renderMessages: function () {
        var self = this;
        (this._msgListBox.submorphs || []).slice().forEach(function (m) { m.remove(); });

        var PAD = 16, ROW_GAP = 14;
        var y = 12;
        this._messages.forEach(function (msg) {
          var av = noDrag(new lively.morphic.Image(lively.rect(PAD, y, AVATAR_MSG, AVATAR_MSG)));
          av.applyStyle({ borderRadius: AVATAR_MSG / 2, borderWidth: 0, clipMode: "hidden" });
          av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(msg.handle, AVATAR_MSG));
          av.eventsAreIgnored = true;
          self._msgListBox.addMorph(av);

          var headM = noDrag(lively.morphic.Text.makeLabel("@" + msg.handle + "   " + self._formatTime(msg.ts), {
            fontSize: 12, fontWeight: "700", textColor: TEXT_PRIMARY, fixedWidth: true, fixedHeight: true,
          }));
          headM.eventsAreIgnored = true;
          headM.setExtent(lively.pt(CHAT_W - PAD * 2 - AVATAR_MSG - 8, 16));
          headM.setPosition(lively.pt(PAD + AVATAR_MSG + 8, y));
          self._msgListBox.addMorph(headM);

          var bodyM = noDrag(lively.morphic.Text.makeLabel(msg.text, {
            fontSize: 13, textColor: Color.rgb(219, 222, 225), fixedWidth: true, fixedHeight: true,
          }));
          bodyM.eventsAreIgnored = true;
          var bw = CHAT_W - PAD * 2 - AVATAR_MSG - 8;
          bodyM.setExtent(lively.pt(bw, 1));
          self._msgListBox.addMorph(bodyM);
          var inner = bodyM.renderContext().shapeNode.querySelector("div");
          var bh = inner ? inner.offsetHeight : 18;
          bodyM.setExtent(lively.pt(bw, bh + 4));
          bodyM.setPosition(lively.pt(PAD + AVATAR_MSG + 8, y + 18));

          y += 18 + bh + 4 + ROW_GAP;
        });

        var scrollNode = this._msgListBox.renderContext().shapeNode;
        scrollNode.scrollTop = scrollNode.scrollHeight;
      },

    },

    // ─── members panel ───────────────────────────────────────────────────────────
    // Real data (RoomPresence's live roster) — not mocked, unlike chat.

    "members", {

      _buildMembersPanel: function () {
        var panel = noDrag(new lively.morphic.Box(lively.rect(
          this._originX + CHAT_X_OFFSET + CHAT_W + PANEL_GAP, this._originY + HEADER_H, MEMBERS_W, BODY_H)));
        panel.applyStyle({ fill: BG_SIDEBAR, borderWidth: 0, clipMode: "auto" });
        $world.addMorph(panel);
        this._membersBox = panel;

        var heading = noDrag(lively.morphic.Text.makeLabel("MEMBERS", {
          fontSize: 11, fontWeight: "700", textColor: TEXT_FAINT,
        }));
        heading.eventsAreIgnored = true;
        heading.setExtent(lively.pt(MEMBERS_W - 32, 16));
        heading.setPosition(lively.pt(16, 16));
        panel.addMorph(heading);
        this._membersHeading = heading;
      },

      _renderMembers: function () {
        var self = this;
        (this._membersBox.submorphs || []).slice().forEach(function (m) {
          if (m !== self._membersHeading) m.remove();
        });

        this._membersHeading.textString = "MEMBERS — " + this._participants.length;

        var user = lively.identity.did.currentUser();
        var myDid = user ? user.did : null;
        var y = 44;
        this._participants.forEach(function (p) {
          var row = noDrag(new lively.morphic.Box(lively.rect(8, y, MEMBERS_W - 16, 40)));
          row.applyStyle({ fill: null, borderWidth: 0, borderRadius: 6 });
          row.onMouseOver = function () { row.applyStyle({ fill: BG_ROW_HOVER }); };
          row.onMouseOut = function () { row.applyStyle({ fill: null }); };
          self._membersBox.addMorph(row);

          var handle = p.handle || "unknown";
          var av = noDrag(new lively.morphic.Image(lively.rect(8, 6, AVATAR_MEMBER, AVATAR_MEMBER)));
          av.applyStyle({ borderRadius: AVATAR_MEMBER / 2, borderWidth: 0, clipMode: "hidden" });
          av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(handle, AVATAR_MEMBER));
          av.eventsAreIgnored = true;
          row.addMorph(av);

          var dot = noDrag(new lively.morphic.Morph());
          dot.setShape(new lively.morphic.Shapes.Ellipse(lively.rect(8 + AVATAR_MEMBER - 8, 6 + AVATAR_MEMBER - 8, 10, 10)));
          dot.applyStyle({ fill: ONLINE, borderWidth: 2, borderColor: BG_SIDEBAR });
          dot.eventsAreIgnored = true;
          row.addMorph(dot);

          var nameM = noDrag(lively.morphic.Text.makeLabel(
            "@" + handle + (p.did === myDid ? " (you)" : ""),
            { fontSize: 13, fontWeight: "600", textColor: TEXT_PRIMARY, fixedWidth: true, fixedHeight: true }
          ));
          nameM.eventsAreIgnored = true;
          nameM.setExtent(lively.pt(MEMBERS_W - 16 - AVATAR_MEMBER - 16, 18));
          nameM.setPosition(lively.pt(8 + AVATAR_MEMBER + 8, 11));
          row.addMorph(nameM);

          y += 44;
        });

        if (!this._participants.length) {
          var empty = noDrag(lively.morphic.Text.makeLabel("No one's here yet.", { fontSize: 12, textColor: TEXT_FAINT }));
          empty.eventsAreIgnored = true;
          empty.setExtent(lively.pt(MEMBERS_W - 32, 18));
          empty.setPosition(lively.pt(16, 44));
          this._membersBox.addMorph(empty);
        }
      },

    },

    // ─── video circles ───────────────────────────────────────────────────────────
    // Floating, draggable, loom-style circles — one per present participant.
    // Your own circle streams a real getUserMedia camera preview (obtained via
    // AmbientPresencePanel.enterRoom/getLocalStream, not acquired separately
    // here); everyone else's is a static identicon placeholder until real
    // peer WebRTC signaling exists (see the design note at the bottom of this
    // file). Added directly to $world (not clipped inside the chat box) so
    // they can be dragged anywhere across the page — plain morphic dragging,
    // no custom drag code needed.

    "video", {

      _buildVideoLayer: function () {
        // Nothing to pre-build — circles are created/destroyed per participant
        // by _renderVideoCircles as the roster changes.
      },

      _renderVideoCircles: function () {
        var self = this;
        var user = lively.identity.did.currentUser();
        var myDid = user ? user.did : null;
        var stillPresent = {};

        var x = this._originX + CHAT_X_OFFSET + 24, y = this._originY + HEADER_H + 24;
        this._participants.forEach(function (p, i) {
          stillPresent[p.did] = true;
          if (self._videoCircles[p.did]) return; // already showing, leave its dragged position alone

          var circle = new lively.morphic.Box(lively.rect(x + i * (VIDEO_CIRCLE + 16), y, VIDEO_CIRCLE, VIDEO_CIRCLE));
          circle.applyStyle({
            fill: Color.rgb(30, 31, 34), borderWidth: 3, borderColor: ACCENT,
            borderRadius: VIDEO_CIRCLE / 2, clipMode: "hidden",
          });
          // Draggable by design (loom-style circles) — only dropping is
          // disabled, so nothing else in this UI can get dropped into one.
          circle.draggingEnabled = true;
          circle.droppingEnabled = false;
          $world.addMorph(circle);
          self._videoCircles[p.did] = circle;

          if (p.did === myDid) {
            self._fillWithLocalStream(circle);
          } else {
            var av = new lively.morphic.Image(lively.rect(0, 0, VIDEO_CIRCLE, VIDEO_CIRCLE));
            av.applyStyle({ borderWidth: 0 });
            av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(p.handle || p.did, VIDEO_CIRCLE));
            // eventsAreIgnored (not just noDrag) — a mousedown here must
            // bubble up to the circle itself so the whole circle drags as
            // one piece, rather than this avatar image capturing the drag.
            av.eventsAreIgnored = true;
            circle.addMorph(av);
          }

          var label = lively.morphic.Text.makeLabel(p.did === myDid ? "you" : ("@" + (p.handle || "?")), {
            fontSize: 10, fontWeight: "700", textColor: Color.white,
          });
          label.applyStyle({ fill: Color.rgba(0, 0, 0, 0.55), borderWidth: 0 });
          label.setExtent(lively.pt(VIDEO_CIRCLE, 14));
          label.setPosition(lively.pt(0, VIDEO_CIRCLE - 14));
          label.eventsAreIgnored = true;
          circle.addMorph(label);
        });

        // Anyone no longer present loses their circle.
        Object.keys(this._videoCircles).forEach(function (did) {
          if (!stillPresent[did]) {
            self._videoCircles[did].remove();
            delete self._videoCircles[did];
          }
        });
      },

      // Renders the real local camera stream (from AmbientPresencePanel,
      // which owns the actual getUserMedia acquisition) into a plain <video>
      // element nested directly in this circle morph's own shapeNode — safe
      // here per CLAUDE.md's native-DOM-in-a-morph section, since this is the
      // morph's own always-visible content, not a dialog overlay.
      // Returns true once the circle actually got a live stream attached
      // (false if the stream isn't ready yet — camera off, permission still
      // pending, or denied — so the caller knows whether to keep polling).
      _fillWithLocalStream: function (circle) {
        var stream = lively.identity.AmbientPresencePanel.getLocalStream();
        if (!stream) return false;
        var videoEl = document.createElement("video");
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.muted = true; // never hear yourself
        videoEl.style.cssText = "width:100%;height:100%;object-fit:cover;transform:scaleX(-1);";
        videoEl.srcObject = stream;
        circle.renderContext().shapeNode.appendChild(videoEl);
        circle._hasLocalVideo = true;
        return true;
      },

    });

    // Static open helper — constructs a fresh controller bound to $world.
    // Callers (buildRoomViewPage's onStartWorld hook) are expected to only
    // call this once $world already exists.
    lively.identity.RoomView = {
      open: function (name, roomId) {
        var controller = new lively.identity.RoomViewController();
        controller.open(name, roomId);
        return controller;
      },
    };

  }); // end module('lively.identity.RoomView')

/**
 * Design notes for future sessions (documented, not implemented):
 *
 * Chat persistence — a plain-postcard-shaped envelope via
 * PostCardSerializer.serializePlainToEnvelope, state.kind:'room-message',
 * constellation + state.roomId fields, plus a new
 * ObjectRepository.listMessagesForRoom(roomId, opts, thenDo) modeled
 * directly on listPostcardsForConstellation's "latest-version join +
 * json_extract filter + cursor-by-internal-id" pattern.
 *
 * Real peer WebRTC — a RoomSignalingServer.js modeled on
 * WarpDropSignalingServer.js's WebSocketServer-based offer/answer/ICE relay
 * (server never inspects signal payloads), grouped by roomId + gated by
 * canJoinRoom instead of by observed IP; client-side wiring modeled on
 * WarpDrop.js's RTCPeerConnection setup, extended from 1:1 to a mesh (or
 * SFU, undecided) for N participants.
 */
