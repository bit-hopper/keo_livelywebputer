module("lively.identity.AmbientPresencePanel")
  .requires(
    "lively.identity.DID",
    "lively.identity.PostCardUtils",
    "lively.persistence.BuildSpec",
  )
  .toRun(function () {

    // NOTE: lively.BuildSpec methods (and anything installed via
    // Morph#addScript) get reconstructed from their own source text at
    // runtime (BuildSpec's evalJS path / addScript's Function.fromString),
    // which throws away the closure over this toRun(function(){...})
    // wrapper's own `var`s — confirmed empirically (a var referenced from
    // an addScript'd function throws "ReferenceError: ... is not defined"
    // even though the file loads fine). So every constant/helper those
    // methods need lives on the lively.identity.AmbientPresencePanel namespace
    // object itself instead of a closure var — a dotted global path still
    // resolves fine after reconstruction, only closures are lost.
    Object.extend(lively.identity.AmbientPresencePanel, {
      PANEL_W: 340,
      PANEL_H: 52,
      PANEL_BG:       Color.black,
      TEXT_PRIMARY:   Color.rgb(242, 243, 245),
      TEXT_SECONDARY: Color.rgb(148, 155, 164),
      ICON_DEFAULT:   Color.rgb(181, 186, 193),
      ICON_DANGER:    Color.rgb(242, 63, 66),
      ICON_INACTIVE:  Color.rgb(80, 84, 91),
      HOVER_BG:      Color.rgba(255, 255, 255, 0.08),
      STATUS_ONLINE:  Color.rgb(35, 165, 89),
      STATUS_IDLE:    Color.rgb(240, 178, 50),

      makeEllipse: function (rect, fill, borderWidth, borderColor) {
        var m = new lively.morphic.Morph();
        m.setShape(new lively.morphic.Shapes.Ellipse(rect));
        m.applyStyle({ fill: fill, borderWidth: borderWidth || 0,
          borderColor: borderColor || null });
        return m;
      },

      // Icon glyphs render through the vendored Material Symbols Rounded
      // font (core/styles/material-symbols.css, loaded once per world) by
      // setting a Text morph's content to the icon's ligature name — same
      // glyphs as the SVGs under core/media/material-icons/, just as inline
      // text so textColor drives the on/off (gray/red) recoloring instead
      // of image tinting.
      makeIconButton: function (rect, glyph, actionName) {
        var NS = lively.identity.AmbientPresencePanel;
        var btn = new lively.morphic.Text(rect);
        btn.textString = glyph;
        btn.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          // fontSize renders as `${size}pt`, not px (core/lively/morphic/HTML.js
          // setFontSizeHTML) — 15pt = 20px, the actual target glyph size. Padding
          // below still uses the real 20px target since padding is genuine px.
          fontSize: 15,
          textColor: NS.ICON_DEFAULT,
          fill: null,
          borderRadius: rect.width / 2,
          borderWidth: 1,
          borderColor: NS.PANEL_BG,
          align: "center",
          padding: lively.Rectangle.inset(0, Math.round((rect.height - 20) / 2), 0, 0),
          allowInput: false,
          selectable: false,
          clipMode: "hidden",
          whiteSpaceHandling: "pre",
          handStyle: "pointer",
        });
        btn._actionName = actionName;
        btn.addScript(function onMouseOver() {
          this.applyStyle({ fill: lively.identity.AmbientPresencePanel.HOVER_BG });
        });
        btn.addScript(function onMouseOut() {
          this.applyStyle({ fill: null });
        });
        btn.addScript(function onMouseUp(evt) {
          this.owner[this._actionName]();
          evt.stop();
          return true;
        });
        return btn;
      },
    });

    lively.BuildSpec("lively.identity.AmbientPresencePanel", {
      isEpiMorph: true,
      className: "lively.morphic.Box",
      name: "AmbientPresencePanel",
      draggingEnabled: false,
      droppingEnabled: false,
      grabbingEnabled: false,
      style: {
        extent: lively.pt(340, 52),
        fill: Color.black,
        borderRadius: 12,
        borderWidth: 3,
        borderColor: Color.rgb(232, 73, 126),   // #e8497e
      },

      micMuted: false,
      deafened: false,
      cameraOff: false,

      alignInWorld: function alignInWorld() {
        var wBounds = $world.visibleBounds();
        this.setPosition(lively.pt(
          wBounds.right() - this.getExtent().x - 12,
          wBounds.bottom() - this.getExtent().y - 12,
        ));
      },

      onWorldResize: function onWorldResize() {
        lively.lang.fun.debounceNamed(this.id + "-vcp-world-resize", 100,
          this.alignInWorld.bind(this))();
      },

      _render: function _render() {
        var NS = lively.identity.AmbientPresencePanel;
        this.removeAllMorphs();

        this._avatarMorph = new lively.morphic.Image(lively.rect(10, 10, 32, 32));
        this._avatarMorph.applyStyle({ borderRadius: 16, borderWidth: 0, clipMode: "hidden" });
        this.addMorph(this._avatarMorph);

        this._badgeBase = NS.makeEllipse(lively.rect(30, 30, 14, 14), NS.STATUS_ONLINE, 2, NS.PANEL_BG);
        this.addMorph(this._badgeBase);
        this._badgeBite = NS.makeEllipse(lively.rect(27, 27, 9, 9), NS.PANEL_BG, 0, null);
        this._badgeBite.setVisible(false);
        this.addMorph(this._badgeBite);

        // fontSize is in pt, not px (see makeIconButton's comment) — 9pt/8.25pt
        // render at the actual-target 12px/11px, with box heights generous
        // enough (18/16) that clipMode:hidden has real margin to spare.
        this._nameMorph = new lively.morphic.Text(lively.rect(50, 8, 140, 18));
        this._nameMorph.applyStyle({ fontSize: 9, fontWeight: "bold",
          textColor: NS.TEXT_PRIMARY, fill: null, borderWidth: 0, allowInput: false,
          selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre" });
        this.addMorph(this._nameMorph);

        this._statusMorph = new lively.morphic.Text(lively.rect(50, 27, 140, 16));
        this._statusMorph.applyStyle({ fontSize: 8.25, fontWeight: "600", textColor: NS.TEXT_SECONDARY,
          fill: null, borderWidth: 0, allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre" });
        this.addMorph(this._statusMorph);

        this._camBtn = NS.makeIconButton(lively.rect(200, 12, 28, 28), "videocam", "toggleCamera");
        this.addMorph(this._camBtn);

        this._micBtn = NS.makeIconButton(lively.rect(234, 12, 28, 28), "mic", "toggleMic");
        this.addMorph(this._micBtn);

        this._headsetBtn = NS.makeIconButton(lively.rect(268, 12, 28, 28), "headset_mic", "toggleDeafen");
        this.addMorph(this._headsetBtn);

        this._gearBtn = NS.makeIconButton(lively.rect(302, 12, 28, 28), "settings", "openSettings");
        this.addMorph(this._gearBtn);
      },

      toggleMic: function toggleMic() {
        if (!lively.identity.AmbientPresencePanel.controlEnabled("mic")) return;
        if (this.deafened) {
          this.deafened = false;
          this.micMuted = false;
        } else {
          this.micMuted = !this.micMuted;
        }
        this._updateControls();
        this._savePersistedPrefs();
        lively.identity.AmbientPresencePanel._applyTrackState();
      },

      toggleDeafen: function toggleDeafen() {
        if (!lively.identity.AmbientPresencePanel.controlEnabled("deafen")) return;
        this.deafened = !this.deafened;
        this.micMuted = this.deafened;
        this._updateControls();
        this._savePersistedPrefs();
        lively.identity.AmbientPresencePanel._applyTrackState();
      },

      toggleCamera: function toggleCamera() {
        if (!lively.identity.AmbientPresencePanel.controlEnabled("camera")) return;
        this.cameraOff = !this.cameraOff;
        this._updateControls();
        this._savePersistedPrefs();
        lively.identity.AmbientPresencePanel._applyTrackState();
      },

      // localStorage persistence for mic/deafen/camera prefs — same
      // try/catch-swallow idiom ConstellationsBrowser.js's _loadKnown/
      // _saveKnown already use elsewhere in this directory. Loaded once in
      // onLoad, before the first _updateControls() paints the icons, so a
      // reload doesn't silently reset to unmuted.
      _loadPersistedPrefs: function _loadPersistedPrefs() {
        try {
          var raw = localStorage.getItem("lively.identity.presenceState");
          if (!raw) return;
          var prefs = JSON.parse(raw);
          this.micMuted = !!prefs.micMuted;
          this.deafened = !!prefs.deafened;
          this.cameraOff = !!prefs.cameraOff;
        } catch (e) {}
      },

      _savePersistedPrefs: function _savePersistedPrefs() {
        try {
          localStorage.setItem("lively.identity.presenceState", JSON.stringify({
            micMuted: this.micMuted, deafened: this.deafened, cameraOff: this.cameraOff,
          }));
        } catch (e) {}
      },

      // Grows the panel with a second strip showing which room you're in
      // plus a "leave" glyph — onLeaveRequested / onShowRequested are supplied
      // by the caller (RoomView.js's enterRoom call) so the actual
      // leave-presence and window semantics stay owned by the room session,
      // not duplicated here; this panel only shows status and relays clicks.
      _showInRoomRow: function _showInRoomRow(room) {
        var NS = lively.identity.AmbientPresencePanel;
        this._hideInRoomRow();
        var ROW_H = 26;
        this.setExtent(lively.pt(NS.PANEL_W, NS.PANEL_H + ROW_H));

        var row = new lively.morphic.Box(lively.rect(0, NS.PANEL_H, NS.PANEL_W, ROW_H));
        row.applyStyle({ fill: Color.rgba(255, 255, 255, 0.05), borderWidth: 0 });
        this.addMorph(row);
        this._roomRow = row;

        var label = new lively.morphic.Text(lively.rect(12, 5, NS.PANEL_W - 56, 16));
        label.textString = "In room: " + (room.roomName || "");
        label.applyStyle({
          fontSize: 9, fontWeight: "600", textColor: NS.TEXT_SECONDARY,
          fill: null, borderWidth: 0, allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre", handStyle: "pointer",
        });
        // Clicking the room name brings the room window forward (expanding it if
        // minimized, rebuilding it if it was closed) — the window is only a view
        // over the call, which keeps running either way.
        label.toolTip = "Show room window";
        label.onMouseDown = function (evt) {
          if (typeof room.onShowRequested === "function") room.onShowRequested();
          evt.stop();
          return true;
        };
        row.addMorph(label);

        var leaveBtn = new lively.morphic.Text(lively.rect(NS.PANEL_W - 40, 2, 28, 22));
        leaveBtn.textString = "call_end";
        leaveBtn.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: 10, textColor: NS.ICON_DANGER,
          fill: null, borderWidth: 0, align: "center", allowInput: false, selectable: false,
          clipMode: "hidden", handStyle: "pointer",
        });
        // onMouseUp, not onMouseDown: leaving hides this very row, and the panel
        // is bottom-anchored, so it re-aligns downward — on mouse-down that slid
        // the settings gear under the still-held pointer, whose mouse-up then
        // opened the Settings window (confirmed live). Finishing the click first
        // means nothing moves until the gesture is over.
        leaveBtn.onMouseUp = function (evt) {
          if (typeof room.onLeaveRequested === "function") room.onLeaveRequested();
          evt.stop();
          return true;
        };
        row.addMorph(leaveBtn);

        this.alignInWorld();
      },

      _hideInRoomRow: function _hideInRoomRow() {
        var NS = lively.identity.AmbientPresencePanel;
        if (this._roomRow) { this._roomRow.remove(); this._roomRow = null; }
        this.setExtent(lively.pt(NS.PANEL_W, NS.PANEL_H));
        this.alignInWorld();
      },

      _updateControls: function _updateControls() {
        var NS = lively.identity.AmbientPresencePanel;
        // A control with nothing to act on (only in a text room, or a camera in
        // an audio-only call) shows greyed with its plain glyph, ignoring the prefs.
        var camOn = NS.controlEnabled("camera"), micOn = NS.controlEnabled("mic"), deafOn = NS.controlEnabled("deafen");
        this._camBtn.textString = camOn && this.cameraOff ? "videocam_off" : "videocam";
        this._camBtn.applyStyle({ textColor: !camOn ? NS.ICON_INACTIVE : (this.cameraOff ? NS.ICON_DANGER : NS.STATUS_ONLINE) });
        this._micBtn.textString = micOn && this.micMuted ? "mic_off" : "mic";
        this._micBtn.applyStyle({ textColor: !micOn ? NS.ICON_INACTIVE : (this.micMuted ? NS.ICON_DANGER : NS.STATUS_ONLINE) });
        this._headsetBtn.textString = deafOn && this.deafened ? "headset_off" : "headset_mic";
        this._headsetBtn.applyStyle({ textColor: !deafOn ? NS.ICON_INACTIVE : (this.deafened ? NS.ICON_DANGER : NS.STATUS_ONLINE) });
      },

      openSettings: function openSettings() {
        var box = new lively.morphic.Box(lively.rect(0, 0, 400, 300));
        box.openInWindow({
          title: "Settings",
          pos: lively.morphic.World.current().visibleBounds().center(),
        });
      },

      _updateStatus: function _updateStatus() {
        var NS = lively.identity.AmbientPresencePanel;
        var idle = typeof document !== "undefined" && document.hidden;
        this._statusMorph.textString = idle ? "Idle" : "Online";
        this._badgeBase.applyStyle({ fill: idle ? NS.STATUS_IDLE : NS.STATUS_ONLINE });
        this._badgeBite.setVisible(!!idle);
      },

      update: function update() {
        if (!lively.identity.did || !lively.identity.did.isLoggedIn()) return;
        var handle = lively.identity.did.currentUser().handle;
        this._nameMorph.textString = "@" + handle;
        this._updateControls();
        this._updateStatus();

        if (this._avatarHandle !== handle) {
          this._avatarHandle = handle;
          this._avatarMorph.setImageURL(
            lively.identity.postCardUtils.identiconDataUrl(handle, 32));
          var self = this;
          fetch("/@" + handle + "/profile", { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (env) {
              if (!env || self._avatarHandle !== handle) return;
              var payload = (env.record && env.record.payload) || {};
              if (payload.avatarUrl) self._avatarMorph.setImageURL(payload.avatarUrl);
            })
            .catch(function () {});
        }
      },

      onLoad: function onLoad() {
        this._loadPersistedPrefs();
        this._render();
        this._visibilityHandler = this._updateStatus.bind(this);
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", this._visibilityHandler);
        }
        this.update();
      },

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this.onLoad();
      },
    });

    // Plain vanilla JS object extension (not a BuildSpec/addScript path),
    // so normal closures over `self` etc. are safe here.
    Object.extend(lively.identity.AmbientPresencePanel, {
      _panel: null,
      _localStream: null,
      _activeRoom: null,   // {constellation, roomId, roomName, onLeaveRequested, onShowRequested} | null

      // Called by RoomView.js once it's actually joined a room's presence.
      // Grows the panel with an "in room" row and (re)acquires local media
      // matching the current mic/cam prefs — real getUserMedia, since a
      // room is now genuinely active. The room lives in this world for as
      // long as the session does (window open, minimized or closed), so this
      // stream is the one call-wide mic/camera source, not tied to any window
      // (see this file's own header on the general BuildSpec/closure caveats,
      // which don't apply to this plain-extension block).
      enterRoom: function enterRoom(room) {
        this._activeRoom = room;
        // Which devices this room's call uses: audio-only rooms never capture
        // the camera. Default (both) keeps callers that don't say working.
        this._mediaKinds = { audio: room.audio !== false, video: room.video !== false };
        this._acquireLocalMedia();
        // MenuBarEntry.js's own init() call (which normally creates _panel
        // in response to identityChanged/sync()) races this — a room-boot
        // page can call enterRoom before that's had a chance to run. open()
        // is idempotent (returns the existing panel if one's already up),
        // so calling it here guarantees a panel exists to show the row on,
        // regardless of which finished loading first.
        this.open()._showInRoomRow(room);
        this.refreshControls();
      },

      leaveRoom: function leaveRoom() {
        this._activeRoom = null;
        this._releaseLocalMedia();
        if (this._panel) this._panel._hideInRoomRow();
        this.refreshControls();
      },

      _mediaKinds: { audio: true, video: true },

      // Whether a control does anything right now. Mic/deafen need a call;
      // the camera needs a call that carries video. With no room at all the
      // controls stay live so the prefs can be set ahead of joining; when the
      // only thing open is a text room there is no call, so they go inactive.
      controlEnabled: function controlEnabled(which) {
        if (this._activeRoom) return which === "camera" ? !!this._mediaKinds.video : true;
        var RV = lively.identity.RoomView;
        return !(RV && RV.hasTextSession && RV.hasTextSession());
      },

      refreshControls: function refreshControls() {
        var p = this._panel;
        if (p && p._camBtn && p._micBtn && p._headsetBtn) p._updateControls();
      },

      getLocalStream: function getLocalStream() {
        return this._localStream;
      },

      _acquiring: false,        // an initial audio+video getUserMedia is in flight
      _reapplyAfterAcquire: false,
      _pendingKinds: { audio: false, video: false },   // a single-kind (re)acquire is in flight

      _acquireLocalMedia: function _acquireLocalMedia() {
        var self = this;
        var p = this._panel;
        var wantAudio = this._mediaKinds.audio && !(p && p.micMuted);
        var wantVideo = this._mediaKinds.video && !(p && p.cameraOff);
        if (!wantAudio && !wantVideo) return;
        if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
        // A toggle while this is still resolving used to start a second
        // getUserMedia whose stream then replaced (and orphaned, still live)
        // the first. Remember to re-apply the prefs once this one lands instead.
        if (this._acquiring) { this._reapplyAfterAcquire = true; return; }
        this._acquiring = true;
        navigator.mediaDevices.getUserMedia({ audio: wantAudio, video: wantVideo })
          .then(function (stream) {
            self._acquiring = false;
            // A leaveRoom() could have raced this promise — don't attach a
            // stream for a room we're no longer in.
            if (!self._activeRoom) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
            self._localStream = stream;
            if (self._reapplyAfterAcquire) { self._reapplyAfterAcquire = false; self._applyTrackState(); }
          })
          .catch(function (err) {
            self._acquiring = false;
            self._reapplyAfterAcquire = false;
            console.warn("[AmbientPresencePanel] getUserMedia failed:", err && err.message);
          });
      },

      _releaseLocalMedia: function _releaseLocalMedia() {
        if (this._localStream) {
          this._localStream.getTracks().forEach(function (t) { t.stop(); });
          this._localStream = null;
        }
      },

      // Lets the room session push the change to its peer connections (and its
      // own self-view). RoomView owns those, this panel only owns the stream.
      _afterLocalTracksChanged: function _afterLocalTracksChanged() {
        try {
          var RV = lively.identity.RoomView;
          if (RV && RV.localTracksChanged) RV.localTracksChanged();
        } catch (e) { console.error("[AmbientPresencePanel] localTracksChanged failed:", e); }
      },

      // Captures one kind of track on demand and adds it to the live stream:
      // the camera when it's turned back on (turning it off really releases
      // the device, see _applyTrackState), or the mic when the room was
      // entered muted (audio was never requested then, so nothing existed to
      // un-mute). Discarded if the pref flipped again or the room was left
      // while it was resolving.
      _ensureTrack: function _ensureTrack(kind) {
        var self = this;
        if (this._pendingKinds[kind]) return;
        if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
        this._pendingKinds[kind] = true;
        navigator.mediaDevices.getUserMedia(kind === "audio" ? { audio: true } : { video: true })
          .then(function (s) {
            self._pendingKinds[kind] = false;
            var p = self._panel;
            var stillWanted = self._activeRoom && self._localStream &&
              (kind === "audio" ? (self._mediaKinds.audio && !(p && p.micMuted))
                                : (self._mediaKinds.video && !(p && p.cameraOff)));
            if (!stillWanted) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
            var stream = self._localStream;
            stream.getTracks().filter(function (t) { return t.kind === kind; })
              .forEach(function (t) { t.stop(); stream.removeTrack(t); });
            s.getTracks().forEach(function (t) { stream.addTrack(t); });
            self._afterLocalTracksChanged();
          })
          .catch(function (err) {
            self._pendingKinds[kind] = false;
            console.warn("[AmbientPresencePanel] could not (re)acquire " + kind + ":", err && err.message);
          });
      },

      // Called after every mic/deafen/camera toggle.
      //  - Mic: just enabled/disabled (a muted mic sends silence; keeping the
      //    device open is the normal behavior for a mic).
      //  - Camera: OFF really stops the video track — merely disabling it
      //    leaves the webcam captured and its light on (confirmed live: track
      //    enabled=false but readyState 'live') — and detaches it from every
      //    peer; ON captures a fresh track. The peer session is told via
      //    _afterLocalTracksChanged either way.
      //  - No stream yet (entered with both muted/off) or a wanted kind that
      //    was never captured: acquire it now that it's actually wanted.
      _applyTrackState: function _applyTrackState() {
        // Deafen also silences incoming voices (owned by the room session, not
        // this panel) — tell it before anything below can return early.
        try {
          var RV = lively.identity.RoomView;
          if (RV && RV.applyDeafened) RV.applyDeafened();
        } catch (e) { console.error("[AmbientPresencePanel] applyDeafened failed:", e); }
        if (!this._activeRoom) return;
        if (!this._localStream) { this._acquireLocalMedia(); return; }
        var p = this._panel;
        var stream = this._localStream;
        var wantAudio = this._mediaKinds.audio && !(p && p.micMuted);
        var wantVideo = this._mediaKinds.video && !(p && p.cameraOff);
        var audio = stream.getAudioTracks().filter(function (t) { return t.readyState === "live"; });
        var video = stream.getVideoTracks().filter(function (t) { return t.readyState === "live"; });

        audio.forEach(function (t) { t.enabled = wantAudio; });
        if (wantAudio && !audio.length) this._ensureTrack("audio");

        if (!wantVideo) {
          if (stream.getVideoTracks().length) {
            stream.getVideoTracks().forEach(function (t) { t.stop(); stream.removeTrack(t); });
            this._afterLocalTracksChanged();
          }
        } else if (!video.length) {
          this._ensureTrack("video");
        } else {
          video.forEach(function (t) { t.enabled = true; });
        }
      },

      init: function init() {
        var self = this;
        function connectAndSync() {
          self.sync();
          lively.bindings.connect(lively.identity.did, "identityChanged", self, "sync");
        }
        if (lively.identity && lively.identity.did) connectAndSync();
        else lively.require("lively.identity.DID").toRun(connectAndSync);
      },

      sync: function sync() {
        var loggedIn = lively.identity.did && lively.identity.did.isLoggedIn();
        if (loggedIn) this.open(); else this.close();
      },

      open: function open() {
        if (this._panel && this._panel.world()) {
          this._panel.update();
          return this._panel;
        }
        var p = lively.BuildSpec("lively.identity.AmbientPresencePanel").createMorph();
        p.openInWorld();
        p.enableFixedPositioning();
        p.alignInWorld();
        this._panel = p;
        return p;
      },

      close: function close() {
        if (!this._panel) return;
        if (this._panel._visibilityHandler && typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", this._panel._visibilityHandler);
        }
        this._panel.remove();
        this._panel = null;
      },
    });

  }); // end module('lively.identity.AmbientPresencePanel')
