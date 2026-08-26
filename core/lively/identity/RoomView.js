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
 * Chat and video are both real as of the 2026-08-25 session: chat messages
 * ride the same objects-envelope/postal rail every other postcard uses
 * (`state.kind:'room-message'`, ObjectRepository.listMessagesForRoom) —
 * sent via PostCardSerializer.serializePlainToEnvelope + PUT to your own
 * /@handle/objId, then POSTed to /c/:name/rooms/:roomId/messages for
 * server-side validation, exactly like a room-join-request postcard.
 * Other participants' messages arrive via short-interval polling (no
 * persistent chat channel — see the "chat" category below). Video/voice is
 * a real mesh WebRTC call (RoomSignalingServer.js relays offer/answer/ICE,
 * grouped by roomId and gated by canJoinRoom via a short-lived token) —
 * your own video circle streams a real getUserMedia camera preview (via
 * lively.identity.AmbientPresencePanel.enterRoom/getLocalStream — no
 * duplicate media acquisition here) and so does every other participant's,
 * via a direct RTCPeerConnection to each of them (see the "webrtc"
 * category below).
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
    "lively.identity.PostCardSerializer",
    "lively.identity.AmbientPresencePanel",
    "lively.Network",
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
    var MESSAGE_POLL_MS = 4000;
    var ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

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
        this._roomLeft = false;   // stops _waitForLocalStreamThenFill's indefinite poll once the room is actually left
        this._participants = [];  // [{did, handle}]
        this._messages = [];      // [{objId, did, handle, text, created}], real (see "chat" category)
        this._messagePollTimer = null;
        this._sendingMessage = false;
        this._heartbeatTimer = null;
        this._videoCircles = {};  // did -> morph
        this._boundLeaveBestEffort = null;
        this._originX = 0;        // set for real by _computeOrigin before anything renders
        this._originY = 0;

        // WebRTC mesh state (see "webrtc" category)
        this._signalingWs = null;
        this._signalingIntentionallyClosed = false;
        this._pendingSignalingToken = null;
        this._mySignalingPeerId = null;
        this._peerMeta = {};        // signaling peerId -> {did, handle}, known as soon as a peer is announced
        this._signalingPeers = {};  // signaling peerId -> {pc, did, handle, pendingIce}, only once a pc exists
        this._didToPeerId = {};     // did -> signaling peerId, for looking up a peer by roster identity
        this._remoteStreams = {};   // did -> MediaStream, latest known remote stream per participant
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
        this._buildHeader();
        this._buildRoomsPanel();
        this._buildChatPanel();
        this._buildMembersPanel();
        this._buildVideoLayer();
        this._renderMembers();
        this._renderVideoCircles();
        this._joinPresence();
        this._startHeartbeat();
        this._loadMessages();
        this._startMessagePolling();
        this._connectSignaling();

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
          // fill it in once ready rather than re-creating the circle. Also
          // pushes the now-ready local tracks onto any peer connections
          // that were already established before the stream resolved (see
          // _waitForLocalStreamThenFill below).
          self._waitForLocalStreamThenFill(20);
        });
      },

      // attemptsLeft drives a fast ~6s burst (20 x 300ms) for the common
      // case — getUserMedia resolving quickly, or mic/cam permission
      // already granted in an earlier session — but never actually gives
      // up: once attemptsLeft reaches 0 this keeps polling indefinitely,
      // just at a slower 3s cadence, until the room is left (_roomLeft) or
      // the stream shows up. Confirmed live with a real human tester: an
      // actual person reliably takes longer than 6s to respond to the
      // browser's camera/mic permission prompt (unlike every account
      // tested so far, which had permissions pre-granted on the
      // automation profile) — any peer connection already established
      // before that point got stuck permanently recvonly for that
      // person's outbound audio/video once the old bounded loop gave up,
      // since nothing else ever calls _applyLocalTracksToAllPeers again.
      // The WebRTC renegotiation logic itself was never the problem here
      // (see _applyLocalTracksToPeer/_onNegotiationNeeded) — it just never
      // got a chance to run.
      _waitForLocalStreamThenFill: function (attemptsLeft) {
        if (this._roomLeft) return;
        var user = lively.identity.did.currentUser();
        var myDid = user ? user.did : null;
        var circle = myDid && this._videoCircles[myDid];
        var filledOwnCircle = circle && !circle._hasLocalVideo && this._fillWithLocalStream(circle);
        // Any peer connection already established (webrtc category, below)
        // before getUserMedia resolved was created with recvonly-capable
        // transceivers and no local tracks yet — push them in now that the
        // stream is ready, same one-time "fill in once ready" idea as the
        // self circle above.
        var pushedToPeers = this._applyLocalTracksToAllPeers();
        if (filledOwnCircle && pushedToPeers) return;
        var self = this;
        var remaining = attemptsLeft > 0 ? attemptsLeft - 1 : 0;
        var delay = attemptsLeft > 0 ? 300 : 3000;
        setTimeout(function () { self._waitForLocalStreamThenFill(remaining); }, delay);
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
        this._roomLeft = true;
        if (this._messagePollTimer) { clearInterval(this._messagePollTimer); this._messagePollTimer = null; }
        this._teardownSignaling();
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
        this._roomLeft = true;
        if (this._messagePollTimer) { clearInterval(this._messagePollTimer); this._messagePollTimer = null; }
        try { this._teardownSignaling(); } catch (e) {}
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
    // Real, persisted messages (see file header) — a message is a plain
    // postcard (state.kind:'room-message') riding the same postal rail
    // every other postcard in this app uses. There is no live push
    // channel; other participants' messages arrive via short-interval
    // polling (_startMessagePolling), same tradeoff RoomPresence's own
    // heartbeat/roster-refresh already makes for membership.

    "chat", {

      // Initial load (boot) and every poll tick both call this — always
      // refetches the latest MESSAGE page rather than tracking an
      // incremental "since" cursor, simplest correct thing for the small
      // per-room message volumes this app targets. Merges into
      // this._messages by objId (new ones only) so a poll tick doesn't
      // clobber whatever the user is mid-scrolling.
      _loadMessages: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId + "/messages?limit=50", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          var fetched = (data.messages || []).slice().reverse(); // server returns newest-first; display oldest-first
          var known = {};
          self._messages.forEach(function (m) { known[m.objId] = true; });
          var changed = false;
          fetched.forEach(function (m) {
            if (known[m.objId]) return;
            self._messages.push(m);
            changed = true;
          });
          if (changed) {
            self._messages.sort(function (a, b) { return new Date(a.created) - new Date(b.created); });
            self._renderMessages();
          }
        };
        xhr.send();
      },

      _startMessagePolling: function () {
        var self = this;
        this._messagePollTimer = setInterval(function () {
          if (self._sendingMessage) return; // avoid racing an in-flight send's own refresh
          self._loadMessages();
        }, MESSAGE_POLL_MS);
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
        // eventsAreIgnored only makes a morph transparent to LIVELY's own
        // morphic mouse dispatch (Events.js) — it is not a CSS property
        // and does nothing for the browser's own native hit-testing
        // (elementFromPoint, native click-to-focus). Confirmed live: the
        // placeholder renders on top of `input` (added to `pill` after
        // it) at the exact same position, and a real click there focused
        // nothing — document.elementFromPoint() at the input's own
        // center resolved to the placeholder's DOM node, not the
        // contenteditable input underneath, so the chat box never
        // actually received focus/keystrokes despite looking clickable.
        // Real CSS pointer-events: none is the actual fix.
        placeholder.renderContext().shapeNode.style.pointerEvents = "none";

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

      // Same build-envelope -> PUT to own /@handle/objId -> POST {objId} to
      // the validating route sequence ConstellationLounge.js's
      // _requestRoomAccess/_submitReply already use for every other
      // client-authored postcard. Clears the input immediately (so the box
      // doesn't feel stuck) but only appends the message to this._messages
      // once the round trip actually succeeds — a real signing+two-XHR
      // trip has enough latency (WebAuthn/crypto involved) that showing an
      // optimistic local echo and later reconciling it against the real
      // objId isn't worth the complexity for a first real implementation;
      // _sendingMessage just blocks the next poll tick from racing this one.
      _onSendMessage: function () {
        var text = (this._inputM.textString || "").trim();
        if (!text || this._sendingMessage) return;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        this._sendingMessage = true;
        this._inputM.textString = "";
        this._placeholderM.setVisible(true);

        var self = this;
        var doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: text }] }] };
        lively.identity.postCardSerializer.serializePlainToEnvelope({
          doc: doc,
          constellation: self._name,
          visibility: "public",
          stateMeta: { kind: "room-message", roomId: self._roomId },
        }, function (err, envelope) {
          if (err) return self._onSendMessageFailed(text, err);
          var base = lively.identity.did.baseUrl();
          var xhr = new XMLHttpRequest();
          xhr.open("PUT", base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(envelope.objId), true);
          xhr.withCredentials = true;
          xhr.setRequestHeader("Content-Type", "application/json");
          xhr.onload = function () {
            if (xhr.status !== 200) return self._onSendMessageFailed(text, new Error("save failed (" + xhr.status + ")"));
            var xhr2 = new XMLHttpRequest();
            xhr2.open("POST", base + "/c/" + encodeURIComponent(self._name) + "/rooms/" + self._roomId + "/messages", true);
            xhr2.withCredentials = true;
            xhr2.setRequestHeader("Content-Type", "application/json");
            xhr2.onload = function () {
              self._sendingMessage = false;
              if (xhr2.status !== 201) return self._onSendMessageFailed(text, new Error("send failed (" + xhr2.status + ")"));
              self._loadMessages();
            };
            xhr2.onerror = function () { self._onSendMessageFailed(text, new Error("network error")); };
            xhr2.send(JSON.stringify({ objId: envelope.objId }));
          };
          xhr.onerror = function () { self._onSendMessageFailed(text, new Error("network error")); };
          xhr.send(JSON.stringify(envelope));
        });
      },

      // Restores the typed text into the input on failure — losing a
      // half-typed message to a transient network/signing error would be a
      // worse experience than the recipient list waiting a moment longer.
      _onSendMessageFailed: function (text, err) {
        console.error("[RoomView] Failed to send message:", err);
        this._sendingMessage = false;
        this._inputM.textString = text;
        this._placeholderM.setVisible(!text);
      },

      _formatTime: function (isoOrTs) {
        var d = new Date(isoOrTs);
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
          av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(msg.handle || msg.did || "unknown", AVATAR_MSG));
          av.eventsAreIgnored = true;
          self._msgListBox.addMorph(av);

          var headM = noDrag(lively.morphic.Text.makeLabel("@" + (msg.handle || "unknown") + "   " + self._formatTime(msg.created), {
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
    // here); everyone else's streams a real remote MediaStream over a direct
    // RTCPeerConnection (see the "webrtc" category below) once that peer's
    // signaling handshake completes — until then (or if it never completes:
    // camera/mic both off on their end, connection still negotiating, ICE
    // failed) the circle shows a static identicon placeholder instead. Added
    // directly to $world (not clipped inside the chat box) so they can be
    // dragged anywhere across the page — plain morphic dragging, no custom
    // drag code needed.

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
          var existingCircle = self._videoCircles[p.did];
          if (existingCircle) {
            // Already showing — leave its dragged position alone, but still
            // worth re-checking for a remote stream that arrived since this
            // circle was created: ontrack (webrtc category) fires whenever
            // ICE/DTLS negotiation happens to finish, which is NOT
            // guaranteed to be before presence/roster created this circle
            // (confirmed live: the more common ordering is actually the
            // other way around — presence resolves faster than a full
            // WebRTC handshake) — ontrack's own direct attach only covers
            // the case where the circle already existed at that moment, so
            // this is the other half of that same catch-up logic. Idempotent
            // no-op if already attached to this exact stream (see
            // _attachRemoteStream's own early-return guard).
            if (p.did !== myDid && self._remoteStreams[p.did]) {
              self._attachRemoteStream(existingCircle, self._remoteStreams[p.did]);
            }
            return;
          }

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
            self._showAvatarPlaceholder(circle, p.handle || p.did);
            // A peer connection to this did may already have produced a
            // remote stream before this roster refresh got around to
            // creating their circle (e.g. signaling raced presence) —
            // attach it immediately instead of waiting for another ontrack.
            if (self._remoteStreams[p.did]) self._attachRemoteStream(circle, self._remoteStreams[p.did]);
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

      // Static identicon placeholder for a non-self circle — used both at
      // initial creation and when reverting a circle that had a real remote
      // stream after that peer connection drops (_teardownPeerConnection,
      // webrtc category). insertBefore (not addMorph's default append)
      // keeps the circle's own name label on top regardless of when this
      // runs, same reasoning as _attachRemoteStream's insertBefore below.
      _showAvatarPlaceholder: function (circle, handleOrDid) {
        if (circle._avatarMorph) return;
        var av = new lively.morphic.Image(lively.rect(0, 0, VIDEO_CIRCLE, VIDEO_CIRCLE));
        av.applyStyle({ borderWidth: 0 });
        av.setImageURL(lively.identity.postCardUtils.identiconDataUrl(handleOrDid, VIDEO_CIRCLE));
        // eventsAreIgnored (not just noDrag) — a mousedown here must bubble
        // up to the circle itself so the whole circle drags as one piece,
        // rather than this avatar image capturing the drag.
        av.eventsAreIgnored = true;
        circle.addMorph(av);
        circle._avatarMorph = av;
        var shapeNode = circle.renderContext().shapeNode;
        shapeNode.insertBefore(av.renderContext().shapeNode, shapeNode.firstChild);
      },

      // Attaches a remote participant's real MediaStream (from the webrtc
      // category's ontrack handler) into their circle, replacing the static
      // identicon placeholder. Same plain-<video>-in-a-morph's-own-shapeNode
      // idiom as _fillWithLocalStream — not muted (we want to hear them),
      // no mirror transform (that's only correct for your own reflected
      // self-view). Idempotent no-op if this exact stream is already
      // attached (ontrack can fire more than once for the same stream on
      // renegotiation).
      _attachRemoteStream: function (circle, stream) {
        if (circle._remoteStream === stream) return;
        circle._remoteStream = stream;
        if (circle._avatarMorph) { circle._avatarMorph.remove(); circle._avatarMorph = null; }
        var shapeNode = circle.renderContext().shapeNode;
        // Defensive DOM-level cleanup, not just the JS reference above —
        // confirmed live that a stray identicon <img> can still be present
        // in the DOM here (circle._avatarMorph.remove() alone didn't
        // reliably clear it across a renegotiation cycle, e.g. ontrack
        // firing more than once as local media attaches asynchronously
        // after the initial answer already went out — see
        // _applyLocalTracksToPeer's own comment for that whole story).
        // A leftover identicon rendered on top of real video is exactly
        // the "still shows the placeholder" symptom this method exists to
        // prevent, so belt-and-suspenders here is worth it.
        var strayAvatars = shapeNode.querySelectorAll(".Morph.Image");
        for (var i = 0; i < strayAvatars.length; i++) strayAvatars[i].remove();
        var existingVideo = shapeNode.querySelector("video");
        if (existingVideo) existingVideo.remove();
        var videoEl = document.createElement("video");
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.style.cssText = "width:100%;height:100%;object-fit:cover;";
        videoEl.srcObject = stream;
        // insertBefore (not appendChild) — this can run well after the
        // circle's label submorph DOM node already exists (a late-arriving
        // ontrack, not the initial render), and the label must stay on top
        // of the video rather than getting covered by it.
        shapeNode.insertBefore(videoEl, shapeNode.firstChild);
      },

    },

    // ─── webrtc — real peer mesh call ──────────────────────────────────────────
    // Every participant opens a direct RTCPeerConnection to every other
    // participant (mesh, not an SFU — see RoomSignalingServer.js's own
    // header for why that's an acceptable tradeoff at this app's room
    // sizes). Signaling (offer/answer/ICE) is relayed over a WebSocket to
    // RoomSignalingServer.js, grouped server-side by roomId and gated by a
    // short-lived one-time token (see _connectSignaling) — the server never
    // inspects the SDP/ICE payloads it relays.
    //
    // Exactly one side of each pair initiates the offer: whichever peer has
    // the lexicographically smaller server-assigned signaling peerId (see
    // _maybeInitiateTo) — a deterministic rule both sides apply
    // independently, so there's never a glare/collision to resolve (unlike
    // WarpDrop.js's file-transfer peers, where either side can spontaneously
    // start a NEW transfer at any time; here every pairing is decided once,
    // right when the two peers become mutually visible).
    //
    // The signaling WebSocket itself reconnects automatically if it drops
    // (see _onSignalingClosed) and re-establishes peer connections with
    // whoever's still in the room. What's NOT handled: an individual
    // peer's RTCPeerConnection failing ICE while the signaling connection
    // to everyone else stays healthy — that one connection just tears down
    // and reverts to the static identicon placeholder until a fresh
    // negotiation happens to get triggered some other way (e.g. that peer
    // leaving and rejoining).

    "webrtc", {

      _connectSignaling: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("POST", base + "/c/" + encodeURIComponent(this._name) + "/rooms/" + this._roomId + "/signaling-token", true);
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) { console.warn("[RoomView] Could not get signaling token (" + xhr.status + ")"); return; }
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          self._openSignalingSocket(data.token, data.wsPath);
        };
        xhr.onerror = function () { console.warn("[RoomView] Network error requesting signaling token"); };
        xhr.send();
      },

      _openSignalingSocket: function (token, wsPath) {
        var self = this;
        this._signalingIntentionallyClosed = false;
        this._pendingSignalingToken = token;
        var url = URL.nodejsBase.withFilename(wsPath).toString();
        var ws = new lively.net.WebSocket(url, { protocol: "lively-json" });
        this._signalingWs = ws;
        lively.bindings.connect(ws, "opened", self, "_onSignalingOpened");
        lively.bindings.connect(ws, "closed", self, "_onSignalingClosed");
        lively.bindings.connect(ws, "lively-message", self, "_onSignalingMessage");
        ws.connect();
      },

      _onSignalingOpened: function () {
        if (!this._signalingWs || !this._pendingSignalingToken) return;
        this._signalingWs.send({ action: "join", data: { token: this._pendingSignalingToken } });
        this._pendingSignalingToken = null;
      },

      // Confirmed live (chrome-devtools-mcp, a real two-account test call)
      // that this connection can drop on its own — dev-machine networking
      // with several simultaneous interfaces (WSL/VPN/host-only adapters,
      // visible as multiple ICE candidates in the same session) is the
      // likely cause, not anything specific to this code — and with no
      // reconnect handler at all, a drop here silently and permanently cut
      // off all of this room's peer video/audio for the rest of the page's
      // life. Same unconditional-retry idiom as WarpDrop.js's own
      // onWsClosed: every existing RTCPeerConnection is torn down (their
      // peerIds are gone the moment the signaling connection that assigned
      // them drops — nothing to salvage) and a full fresh
      // token+socket+rejoin cycle starts, which naturally re-establishes
      // peer connections with whoever's still in the room via the normal
      // 'joined'/peer-joined flow.
      _onSignalingClosed: function () {
        if (this._signalingIntentionallyClosed) return;
        var self = this;
        Object.keys(this._signalingPeers).forEach(function (peerId) { self._teardownPeerConnection(peerId); });
        this._signalingWs = null;
        this._mySignalingPeerId = null;
        setTimeout(function () {
          if (self._signalingIntentionallyClosed) return;
          self._connectSignaling();
        }, 1500);
      },

      _onSignalingMessage: function (msg) {
        switch (msg.action) {
          case "joined":      this._onSignalingJoined(msg.data); break;
          case "peer-joined": this._onSignalingPeerJoined(msg.data); break;
          case "peer-left":   this._onSignalingPeerLeft(msg.data); break;
          case "signal":      this._onSignalingSignal(msg.data); break;
          case "join-rejected":
            // Token expired/invalid (e.g. this socket sat mid-handshake too
            // long) — mint a fresh one and reconnect from scratch.
            console.warn("[RoomView] Signaling token rejected — retrying");
            try { this._signalingWs.close(); } catch (e) {}
            this._signalingWs = null;
            var self = this;
            setTimeout(function () { self._connectSignaling(); }, 1000);
            break;
        }
      },

      _onSignalingJoined: function (data) {
        this._mySignalingPeerId = data.peerId;
        var self = this;
        (data.peers || []).forEach(function (p) {
          self._peerMeta[p.peerId] = { did: p.did, handle: p.handle };
          self._didToPeerId[p.did] = p.peerId;
          self._maybeInitiateTo(p.peerId);
        });
      },

      _onSignalingPeerJoined: function (data) {
        this._peerMeta[data.peerId] = { did: data.did, handle: data.handle };
        this._didToPeerId[data.did] = data.peerId;
        this._maybeInitiateTo(data.peerId);
      },

      _onSignalingPeerLeft: function (data) {
        this._teardownPeerConnection(data.peerId);
      },

      // Deterministic offerer choice — see this category's own header
      // comment. No-op if we already have a pc for this peer (a duplicate
      // peer-joined, or we're already mid-handshake).
      _maybeInitiateTo: function (peerId) {
        if (!this._mySignalingPeerId || this._signalingPeers[peerId]) return;
        if (this._mySignalingPeerId < peerId) this._createPeerConnection(peerId, true);
      },

      _createPeerConnection: function (peerId, amInitiator) {
        var self = this;
        var meta = this._peerMeta[peerId] || {};
        var pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        var peer = { pc: pc, did: meta.did, handle: meta.handle, pendingIce: [] };
        this._signalingPeers[peerId] = peer;

        pc.onicecandidate = function (e) {
          if (e.candidate) self._sendSignalTo(peerId, { type: "ice", candidate: e.candidate });
        };
        pc.ontrack = function (e) {
          if (!peer.did) return;
          // e.streams[0] should always be populated now that
          // _applyLocalTracksToPeer calls sender.setStreams() on the
          // sending side (see that method's own comment for why this
          // wasn't previously true) — this fallback is a safety net, not
          // the primary path: build/reuse a synthetic stream from the raw
          // track rather than ever storing undefined again.
          var stream = e.streams[0];
          if (!stream) {
            stream = self._remoteStreams[peer.did] instanceof MediaStream ? self._remoteStreams[peer.did] : new MediaStream();
            if (!stream.getTracks().some(function (t) { return t.id === e.track.id; })) stream.addTrack(e.track);
          }
          self._remoteStreams[peer.did] = stream;
          var circle = self._videoCircles[peer.did];
          if (circle) self._attachRemoteStream(circle, stream);
        };
        pc.oniceconnectionstatechange = function () {
          var state = pc.iceConnectionState;
          if (state === "failed" || state === "closed") self._teardownPeerConnection(peerId);
        };
        // Fires whenever THIS side's own local state changes in a way that
        // needs a new SDP round — the case that actually matters here is
        // _applyLocalTracksToPeer upgrading a transceiver's direction from
        // "recvonly" to "sendrecv" once local media becomes available
        // *after* this pc's initial offer/answer already went out without
        // it (confirmed live: this genuinely happens — local getUserMedia
        // and the signaling handshake race each other, and the handshake
        // sometimes wins). Fires for either role, not just the original
        // offerer — WebRTC renegotiation isn't tied to who offered first.
        pc.onnegotiationneeded = function () { self._onNegotiationNeeded(peerId, peer); };

        if (amInitiator) {
          // sendrecv up front regardless of whether our own local tracks
          // are ready yet (getUserMedia is async — see
          // _waitForLocalStreamThenFill) so we still receive the other
          // side's media even before ours resolves; _applyLocalTracksToPeer
          // fills in real tracks whenever they're available, now or later.
          //
          // Only the OFFERER pre-creates transceivers this way — confirmed
          // live (chrome-devtools-mcp, inspecting real getTransceivers()/SDP
          // on both sides of an actual two-account test call) that doing
          // the same on the ANSWERER side does NOT get reused by
          // setRemoteDescription(offer) the way the usual "pre-create
          // before receiving an offer" idiom assumes: it silently created
          // 4 transceivers instead of 2 (the 2 pre-created ones stayed
          // stuck at mid:null, unused; 2 new auto-created ones appeared to
          // match the offer's m-lines, defaulted to recvonly since they
          // had no track) — so the answer always negotiated recvonly on
          // both m-lines regardless of local media being ready. See
          // _onOffer below for the answerer's own (working) path instead.
          pc.addTransceiver("audio", { direction: "sendrecv" });
          pc.addTransceiver("video", { direction: "sendrecv" });
          this._applyLocalTracksToPeer(peer);

          pc.createOffer().then(function (offer) {
            return pc.setLocalDescription(offer);
          }).then(function () {
            self._sendSignalTo(peerId, { type: "offer", sdp: pc.localDescription });
          }).catch(function (e) {
            console.error("[RoomView] createOffer failed", e);
            self._teardownPeerConnection(peerId);
          });
        }
        // amInitiator===false: deliberately no addTransceiver call here —
        // _onOffer's setRemoteDescription(offer) auto-creates the matching
        // transceivers (recvonly by default, no track), and upgrades them
        // to sendrecv + attaches local tracks itself right before
        // createAnswer(), once they actually exist.

        return peer;
      },

      // Pushes whatever local audio/video tracks are currently available
      // onto one peer's already-existing transceivers via replaceTrack —
      // safe to call before OR after local media is ready (a no-op if the
      // stream isn't there yet). Matches transceivers by their receiver's
      // track kind, which (per spec) is set from the transceiver's own
      // media kind immediately at creation — whether that transceiver was
      // explicitly pre-created (the offerer's own addTransceiver call) or
      // auto-created by setRemoteDescription(offer) (the answerer's case,
      // see _onOffer) — not only after negotiation completes.
      //
      // Also upgrades .direction to "sendrecv" for any transceiver getting
      // a real track — load-bearing for the answerer's auto-created
      // transceivers, which default to "recvonly" (no track = nothing to
      // send), and would otherwise negotiate recvonly forever even once a
      // track becomes available. Harmless no-op for the offerer's own
      // transceivers, which are already "sendrecv" from creation.
      //
      // ALSO calls sender.setStreams(stream) — confirmed live (chrome-
      // devtools-mcp, wrapping RTCPeerConnection to log every real ontrack
      // event on both sides of an actual two-account call) that
      // replaceTrack() alone never associates the track with a
      // MediaStream/msid the way addTrack(track, stream) does. Without
      // this, the RECEIVING side's ontrack fires with a genuinely EMPTY
      // e.streams array every time (not flaky — 100% reproducible), so
      // self._remoteStreams[peer.did] silently got set to
      // e.streams[0]===undefined instead of a real stream, and every video
      // circle stayed on its identicon placeholder forever despite the
      // underlying RTCPeerConnection reporting "connected" with live send/
      // receive tracks. setStreams() is the API specifically added to
      // Unified Plan for this gap (replaceTrack was never meant to carry
      // stream association) — feature-detected since it's newer than
      // addTransceiver/replaceTrack themselves.
      _applyLocalTracksToPeer: function (peer) {
        var stream = lively.identity.AmbientPresencePanel.getLocalStream();
        if (!stream || !peer.pc) return false;
        peer.pc.getTransceivers().forEach(function (t) {
          var kind = t.receiver && t.receiver.track && t.receiver.track.kind;
          if (!kind) return;
          var track = kind === "audio" ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
          if (!track) return;
          if (t.direction !== "sendrecv") t.direction = "sendrecv";
          if (t.sender.track !== track) t.sender.replaceTrack(track);
          if (t.sender.setStreams) t.sender.setStreams(stream);
        });
        return true;
      },

      // Returns true once local media is available (regardless of whether
      // there were any peers yet to push it to) — the return value is only
      // used by _waitForLocalStreamThenFill to know whether to keep
      // polling, same contract as _fillWithLocalStream's own return value.
      _applyLocalTracksToAllPeers: function () {
        var stream = lively.identity.AmbientPresencePanel.getLocalStream();
        if (!stream) return false;
        var self = this;
        Object.keys(this._signalingPeers).forEach(function (peerId) {
          self._applyLocalTracksToPeer(self._signalingPeers[peerId]);
        });
        return true;
      },

      _sendSignalTo: function (peerId, signal) {
        if (!this._signalingWs) return;
        this._signalingWs.send({ action: "signal", data: { to: peerId, signal: signal } });
      },

      _onSignalingSignal: function (data) {
        var peerId = data.from;
        var signal = data.signal;
        if (signal.type === "offer") return this._onOffer(peerId, signal);
        var peer = this._signalingPeers[peerId];
        if (!peer) return; // for a peer we no longer have a pc for -- drop
        if (signal.type === "answer") return this._onAnswer(peer, signal);
        if (signal.type === "ice") return this._onIce(peer, signal);
      },

      // Fires either for a brand-new pairing (no peer yet) or a follow-up
      // renegotiation on an already-stable pc (see _onNegotiationNeeded) --
      // and, rarely, glare: both sides' onnegotiationneeded firing close
      // together, each already mid-way through sending their OWN offer
      // when the other's arrives. Simplified "perfect negotiation" (per
      // the WebRTC spec's own recommended pattern): the "polite" side
      // (larger signaling peerId — same tie-break _maybeInitiateTo already
      // uses, just inverted) rolls back its own in-flight offer and
      // accepts theirs; the "impolite" side ignores the incoming offer and
      // trusts its own to be answered. Both sides reach this decision
      // independently from the same deterministic rule, so it can't
      // deadlock.
      _onOffer: function (peerId, signal) {
        var self = this;
        var peer = this._signalingPeers[peerId];
        var isPolite = this._mySignalingPeerId > peerId;

        if (peer && peer.pc.signalingState === "have-local-offer") {
          if (!isPolite) return; // impolite: ignore theirs, ours will win
          peer.pc.setLocalDescription({ type: "rollback" }).then(function () {
            self._answerOffer(peerId, peer, signal);
          }).catch(function (e) { console.error("[RoomView] Glare rollback failed", e); });
          return;
        }

        if (!peer) peer = this._createPeerConnection(peerId, false);
        self._answerOffer(peerId, peer, signal);
      },

      _answerOffer: function (peerId, peer, signal) {
        var self = this;
        peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(function () {
          self._flushPendingIce(peer);
          // Transceivers now exist (auto-created to match the offer's
          // m-lines on a fresh pairing, or already there on a
          // renegotiation) — upgrade to sendrecv + attach local tracks
          // before answering, see _applyLocalTracksToPeer's own comment
          // for why this can't happen earlier on the answerer's side of a
          // fresh pairing.
          self._applyLocalTracksToPeer(peer);
          return peer.pc.createAnswer();
        }).then(function (answer) {
          return peer.pc.setLocalDescription(answer);
        }).then(function () {
          self._sendSignalTo(peerId, { type: "answer", sdp: peer.pc.localDescription });
        }).catch(function (e) {
          console.error("[RoomView] Failed to answer offer", e);
          self._teardownPeerConnection(peerId);
        });
      },

      // Triggered by RTCPeerConnection's own onnegotiationneeded (see
      // _createPeerConnection) — a fresh pairing's very first
      // negotiation is driven by _maybeInitiateTo/createOffer instead, not
      // this; this fires for later renegotiations only (signalingState is
      // "stable" for those, guarded below so a negotiationneeded firing
      // mid-handshake — e.g. right after the initial createOffer — is a
      // no-op rather than an interfering second offer).
      _onNegotiationNeeded: function (peerId, peer) {
        var self = this;
        var pc = peer.pc;
        if (pc.signalingState !== "stable") return;
        pc.createOffer().then(function (offer) {
          return pc.setLocalDescription(offer);
        }).then(function () {
          self._sendSignalTo(peerId, { type: "offer", sdp: pc.localDescription });
        }).catch(function (e) {
          // Observed live once, non-fatal: Chrome's own "order of m-lines
          // in subsequent offer doesn't match order from previous offer/
          // answer" InvalidAccessError, on a renegotiation triggered close
          // together with other negotiation activity on the same pc (a
          // heavy multi-reload debugging session, not a normal single
          // fresh call). The failed attempt here is just abandoned —
          // whatever the pc's last successfully negotiated state was
          // stands — and in the one case this fired, the call still ended
          // up fully connected afterward. Not chased further since it's a
          // narrow edge case and the call itself is unaffected; if this
          // starts happening on ordinary (non-debugging) connections it'd
          // be worth a proper fix.
          console.error("[RoomView] Renegotiation offer failed", e);
        });
      },

      _onAnswer: function (peer, signal) {
        var self = this;
        peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(function () {
          self._flushPendingIce(peer);
        }).catch(function (e) { console.error("[RoomView] setRemoteDescription (answer) failed", e); });
      },

      _onIce: function (peer, signal) {
        if (peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
          peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(function (e) {
            console.warn("[RoomView] addIceCandidate failed", e);
          });
        } else {
          peer.pendingIce.push(signal.candidate);
        }
      },

      _flushPendingIce: function (peer) {
        var candidates = peer.pendingIce;
        peer.pendingIce = [];
        candidates.forEach(function (c) {
          peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(function (e) {
            console.warn("[RoomView] addIceCandidate (flush) failed", e);
          });
        });
      },

      // Closes one peer's RTCPeerConnection and, if their video circle is
      // currently showing real remote video, reverts it to the static
      // identicon placeholder — presence and signaling are independent, so
      // a dropped peer connection doesn't necessarily mean they've left the
      // room (roster-driven circle removal is handled separately by
      // _renderVideoCircles).
      _teardownPeerConnection: function (peerId) {
        var peer = this._signalingPeers[peerId];
        if (!peer) return;
        delete this._signalingPeers[peerId];
        delete this._peerMeta[peerId];

        if (peer.did) {
          delete this._remoteStreams[peer.did];
          if (this._didToPeerId[peer.did] === peerId) delete this._didToPeerId[peer.did];
          var circle = this._videoCircles[peer.did];
          if (circle && circle._remoteStream) {
            var v = circle.renderContext().shapeNode.querySelector("video");
            if (v) v.remove();
            circle._remoteStream = null;
            this._showAvatarPlaceholder(circle, peer.handle || peer.did);
          }
        }

        if (peer.pc) {
          peer.pc.onicecandidate = null;
          peer.pc.ontrack = null;
          peer.pc.oniceconnectionstatechange = null;
          peer.pc.onnegotiationneeded = null;
          try { peer.pc.close(); } catch (e) {}
        }
      },

      _teardownSignaling: function () {
        var self = this;
        this._signalingIntentionallyClosed = true; // stop _onSignalingClosed from reconnecting
        Object.keys(this._signalingPeers).forEach(function (peerId) { self._teardownPeerConnection(peerId); });
        if (this._signalingWs) {
          try { this._signalingWs.close(); } catch (e) {}
          this._signalingWs = null;
        }
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
 * The controller-facing approve/decline UI for room-join-request postcards
 * (deferred in an earlier session — PostCardView.js's
 * _renderMembershipActions only special-cases
 * state.kind==='constellation-join-request') is still unaddressed.
 *
 * Chat message length is capped at 200 chars — listMessagesForRoom reads
 * state.title (the same auto-extracted-first-block-text every postcard
 * gets), not the full payload, to keep the room's message listing as cheap
 * as any other feed listing here. Fine for a chat line; would need a real
 * payload fetch per message (or a dedicated text field) if longer messages
 * ever matter.
 *
 * No message edit/delete UI. No read receipts/typing indicators. No
 * automatic WebRTC reconnect after an ICE failure (see the "webrtc"
 * category's own header comment) — a dropped peer connection just reverts
 * that participant's circle to a static placeholder until they leave/
 * rejoin the room.
 */
