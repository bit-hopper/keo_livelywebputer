module("lively.identity.FaceEffects")
  .requires()
  .toRun(function () {

    // Face overlays (glasses, party hat, mustache, blush) for the outgoing camera
    // picture, opened from the Ambient Presence Panel's room block. Face tracking
    // is MediaPipe's Face Landmarker, vendored in core/lib/mediapipe/ (ESM bundle,
    // SIMD WASM engine and the float16 model; Apache-2.0) and loaded on first use.
    //
    // Video path (same shape as the soundboard's audio path): while at least one
    // effect is on, the raw camera track is played into a hidden <video>, each new
    // frame is run through the landmarker and drawn, with the overlays, onto a
    // canvas, and that canvas's captureStream track is what the room session sends
    // (it asks getOutgoingTrack() for which video track to send) and what the
    // self-view shows (getViewStream()). With no effect on, nothing here is in the
    // path and calls keep sending the raw camera track.
    //
    // Detection and drawing both use the UNMIRRORED frame, so the track peers get
    // has the right orientation. The self-view's mirror is display-only CSS on its
    // <video> (RoomView._fillWithLocalStream), which works unchanged on the canvas
    // stream. The pipeline belongs to the call session, not to the room window:
    // it has its own hidden <video> and survives the window closing.
    //
    // The raw camera track stays owned by AmbientPresencePanel (camera-off still
    // stops it and releases the device); rewire() follows it — the panel calls it
    // from _afterLocalTracksChanged — so turning the camera off pauses the loop
    // and turning it back on re-attaches the fresh track.
    //
    // Plain object with normal closures: nothing here is a BuildSpec or an
    // addScript'd handler.
    lively.identity.FaceEffects = {
      BASE: "/core/lib/mediapipe/",
      EFFECTS: [
        { id: "glasses",  label: "glasses" },
        { id: "hat",      label: "party hat" },
        { id: "mustache", label: "mustache" },
        { id: "blush",    label: "blush" },
      ],
      // Auto-disable when the average detect+draw time per frame stays above this
      // (ms), measured once BUDGET_FRAMES frames past the warm-up have been seen.
      BUDGET_MS: 55,
      BUDGET_FRAMES: 45,
      WARMUP_FRAMES: 5,

      _selected: {},          // effect id -> true
      _state: "idle",         // idle | loading | ready | error
      _notice: "",            // shown in the popover header (errors, auto-disable)
      _landmarker: null,
      _landmarkerPromise: null,

      _rawTrackId: null,
      _video: null,           // hidden <video> playing the raw camera track
      _canvas: null,
      _ctx: null,
      _canvasTrack: null,
      _viewStream: null,
      _timer: null,
      _lastVideoTime: -1,
      _lastTs: 0,
      _outputting: false,     // at least one frame has been drawn to the canvas
      _avgMs: 0,
      _frames: 0,

      _popover: null,
      _panelRef: null,
      _head: null,
      _chips: {},
      _closeHandlers: null,

      // ── queries used by the panel and the room session ──

      isActive: function () {
        return Object.keys(this._selected).length > 0;
      },

      // The video track the room session should send: the effect canvas once it is
      // producing frames, otherwise null (the caller falls back to the raw camera).
      getOutgoingTrack: function () {
        return this._outputting && this._canvasTrack && this._canvasTrack.readyState === "live"
          ? this._canvasTrack : null;
      },

      // The stream the self-view should show while effects are on, else null.
      getViewStream: function () {
        return this.getOutgoingTrack() ? this._viewStream : null;
      },

      // ── landmarker loading ──

      _ensureLandmarker: function () {
        var self = this;
        if (this._landmarker) return Promise.resolve(this._landmarker);
        if (this._landmarkerPromise) return this._landmarkerPromise;
        // Dynamic import via Function: this file goes through Lively's own JS
        // tooling, which predates import() syntax.
        var importer = new Function("u", "return import(u)");
        // MediaPipe's loader reads a global named Module as its Emscripten config
        // object and then overwrites it with undefined. Lively defines its own
        // Module class there, so hide it while the engine loads and put it back.
        var savedModule = window.Module;
        window.Module = undefined;
        function restoreModule() { window.Module = savedModule; }
        this._landmarkerPromise = importer(this.BASE + "vision_bundle.esm.js")
          .then(function (mp) {
            return mp.FilesetResolver.forVisionTasks(self.BASE + "wasm").then(function (fileset) {
              function create(delegate) {
                return mp.FaceLandmarker.createFromOptions(fileset, {
                  baseOptions: { modelAssetPath: self.BASE + "face_landmarker.task", delegate: delegate },
                  runningMode: "VIDEO",
                  numFaces: 1,
                });
              }
              return create("GPU").catch(function (err) {
                console.warn("[FaceEffects] GPU delegate unavailable, using CPU:", err && err.message);
                return create("CPU");
              });
            });
          })
          .then(function (lm) { restoreModule(); self._landmarker = lm; return lm; })
          .catch(function (err) { restoreModule(); self._landmarkerPromise = null; throw err; });
        return this._landmarkerPromise;
      },

      // ── effect selection ──

      toggleEffect: function (id) {
        if (this._selected[id]) delete this._selected[id]; else this._selected[id] = true;
        this._notice = "";
        if (!this.isActive()) {
          this._stop(true);
          this._state = this._landmarker ? "ready" : "idle";
        } else if (!this._timer && this._state !== "loading") {
          this._start();
        }
        this._refreshUI();
      },

      _start: function () {
        var self = this;
        this._state = "loading";
        this._refreshUI();
        this._ensureLandmarker().then(function () {
          self._state = "ready";
          if (!self.isActive() || !self._room()) { self._refreshUI(); return; }
          self._attach();
          self._refreshUI();
        }).catch(function (err) {
          console.warn("[FaceEffects] could not load face tracking:", err && err.message);
          self._selected = {};
          self._state = "error";
          self._notice = "couldn't load face tracking";
          self._refreshUI();
        });
      },

      _room: function () {
        return lively.identity.AmbientPresencePanel._activeRoom;
      },

      _rawVideoTrack: function () {
        var stream = lively.identity.AmbientPresencePanel.getLocalStream();
        return stream ? (stream.getVideoTracks().filter(function (t) { return t.readyState === "live"; })[0] || null) : null;
      },

      // Points the pipeline at the current raw camera track (building the video and
      // canvas on first use). With no camera track it just idles until rewire().
      _attach: function () {
        var self = this;
        var raw = this._rawVideoTrack();
        if (!raw) { this._detachSource(); return; }
        if (this._timer && raw.id === this._rawTrackId) return;
        this._detachSource();
        this._rawTrackId = raw.id;
        var v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.autoplay = true;
        // Not display:none — a hidden video can stop decoding frames.
        v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
        v.srcObject = new MediaStream([raw]);
        document.body.appendChild(v);
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
        this._video = v;
        this._lastVideoTime = -1;
        if (!this._canvas) {
          this._canvas = document.createElement("canvas");
          this._canvas.width = 640; this._canvas.height = 480;
          this._ctx = this._canvas.getContext("2d");
          this._canvasTrack = this._canvas.captureStream(30).getVideoTracks()[0];
          this._viewStream = new MediaStream([this._canvasTrack]);
        }
        this._avgMs = 0; this._frames = 0;
        this._timer = setInterval(function () { self._frame(); }, 1000 / 30);
      },

      _detachSource: function () {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._video) {
          try { this._video.pause(); this._video.srcObject = null; this._video.remove(); } catch (e) {}
          this._video = null;
        }
        this._rawTrackId = null;
        // The canvas track stays (a stable object across camera off/on), but it
        // must not be sent while there is no live source behind it.
        this._outputting = false;
      },

      // Full stop: drop the whole pipeline. notify = tell the room session so it
      // switches peers and the self-view back to the raw camera.
      _stop: function (notify) {
        var wasOutputting = this._outputting;
        this._detachSource();
        if (this._canvasTrack) { try { this._canvasTrack.stop(); } catch (e) {} }
        this._canvasTrack = null; this._viewStream = null; this._canvas = null; this._ctx = null;
        if (notify && wasOutputting) this._notifyRoom();
      },

      _notifyRoom: function () {
        try {
          var RV = lively.identity.RoomView;
          if (RV && RV.localTracksChanged) RV.localTracksChanged();
        } catch (e) { console.error("[FaceEffects] localTracksChanged failed:", e); }
      },

      // Called by the panel whenever a local track was added or removed (camera
      // toggled, device re-acquired): follow the raw camera track.
      rewire: function () {
        if (!this.isActive() || !this._landmarker) return;
        var had = this._outputting;
        this._attach();
        // Camera went away while effects were sending: the room session must
        // swap to its black track, so it needs the same nudge as any track change.
        if (had && !this._outputting) this._notifyRoom();
      },

      // ── per-frame work ──

      _frame: function () {
        var v = this._video, lm = this._landmarker, ctx = this._ctx;
        if (!v || !lm || !ctx || v.readyState < 2 || !v.videoWidth) return;
        if (v.currentTime === this._lastVideoTime) return;
        this._lastVideoTime = v.currentTime;
        var t0 = performance.now();
        var w = v.videoWidth, h = v.videoHeight;
        if (this._canvas.width !== w || this._canvas.height !== h) {
          this._canvas.width = w; this._canvas.height = h;
        }
        ctx.drawImage(v, 0, 0, w, h);
        // detectForVideo needs strictly increasing timestamps.
        var ts = Math.max(t0, this._lastTs + 1);
        this._lastTs = ts;
        var result = null;
        try { result = lm.detectForVideo(v, ts); } catch (e) { console.warn("[FaceEffects] detect failed:", e && e.message); }
        var face = result && result.faceLandmarks && result.faceLandmarks[0];
        if (face) this._draw(ctx, face, w, h);

        if (!this._outputting) { this._outputting = true; this._notifyRoom(); this._refreshUI(); }

        // Adaptive fallback: revert to the plain camera if this can't keep up.
        // The first frames include one-off engine warm-up (shader/graph setup can
        // take seconds), so they are left out of the average.
        var ms = performance.now() - t0;
        this._frames++;
        if (this._frames <= this.WARMUP_FRAMES) return;
        var measured = this._frames - this.WARMUP_FRAMES;
        this._avgMs = measured === 1 ? ms : this._avgMs * 0.9 + ms * 0.1;
        if (measured >= this.BUDGET_FRAMES && this._avgMs > this.BUDGET_MS) {
          console.warn("[FaceEffects] too slow (" + Math.round(this._avgMs) + " ms/frame); turning effects off");
          this._selected = {};
          this._notice = "too slow on this device — turned off";
          this._stop(true);
          this._state = "ready";
          this._refreshUI();
        }
      },

      _draw: function (ctx, lm, w, h) {
        var S = this._selected;
        function P(i) { return { x: lm[i].x * w, y: lm[i].y * h }; }
        function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
        function dist(a, b) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)); }

        // Eye centres, image-left and image-right of the unmirrored frame.
        var eA = mid(P(33), P(133)), eB = mid(P(362), P(263));
        var d = dist(eA, eB);
        var roll = Math.atan2(eB.y - eA.y, eB.x - eA.x);
        var eyeMid = mid(eA, eB);

        if (S.blush) {
          [P(205), P(425)].forEach(function (c) {
            var r = d * 0.34;
            var g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
            g.addColorStop(0, "rgba(255,80,130,0.55)");
            g.addColorStop(1, "rgba(255,80,130,0)");
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill();
          });
        }

        if (S.mustache) {
          var c = mid(P(164), P(0));
          var mw = dist(P(61), P(291));
          ctx.save();
          ctx.translate(c.x, c.y); ctx.rotate(roll);
          var s = mw * 0.62;
          ctx.fillStyle = "#3a2417";
          [-1, 1].forEach(function (side) {
            ctx.beginPath();
            ctx.moveTo(0, -0.05 * s);
            ctx.bezierCurveTo(side * 0.35 * s, -0.30 * s, side * 0.85 * s, -0.22 * s, side * 1.05 * s, 0.12 * s);
            ctx.bezierCurveTo(side * 0.80 * s, 0.02 * s, side * 0.45 * s, 0.10 * s, 0, 0.16 * s);
            ctx.closePath();
            ctx.fill();
          });
          ctx.restore();
        }

        if (S.glasses) {
          ctx.save();
          ctx.translate(eyeMid.x, eyeMid.y); ctx.rotate(roll);
          var lw = d * 0.66, lh = d * 0.52, lr = d * 0.16;
          ctx.lineWidth = d * 0.07;
          ctx.strokeStyle = "#141414";
          ctx.fillStyle = "rgba(232,73,126,0.28)";
          [-d / 2, d / 2].forEach(function (cx) {
            ctx.beginPath();
            ctx.moveTo(cx - lw / 2 + lr, -lh / 2);
            ctx.arcTo(cx + lw / 2, -lh / 2, cx + lw / 2, lh / 2, lr);
            ctx.arcTo(cx + lw / 2, lh / 2, cx - lw / 2, lh / 2, lr);
            ctx.arcTo(cx - lw / 2, lh / 2, cx - lw / 2, -lh / 2, lr);
            ctx.arcTo(cx - lw / 2, -lh / 2, cx + lw / 2, -lh / 2, lr);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
          });
          ctx.beginPath();
          ctx.moveTo(-d / 2 + lw / 2, -lh * 0.1);
          ctx.quadraticCurveTo(0, -lh * 0.35, d / 2 - lw / 2, -lh * 0.1);
          ctx.stroke();
          ctx.restore();
        }

        if (S.hat) {
          var top = P(10), chin = P(152);
          var faceH = dist(top, chin), fw = dist(P(234), P(454));
          var ux = (top.x - chin.x) / faceH, uy = (top.y - chin.y) / faceH;
          var base = { x: top.x - ux * faceH * 0.06, y: top.y - uy * faceH * 0.06 };
          ctx.save();
          ctx.translate(base.x, base.y);
          ctx.rotate(Math.atan2(ux, -uy));
          var bw = fw * 0.34, hh = fw * 1.0;
          var g = ctx.createLinearGradient(-bw, 0, bw, 0);
          g.addColorStop(0, "#e8497e"); g.addColorStop(0.5, "#ff7fa8"); g.addColorStop(1, "#c93468");
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.moveTo(-bw, 0); ctx.lineTo(0, -hh); ctx.lineTo(bw, 0); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = fw * 0.03;
          [0.3, 0.55, 0.78].forEach(function (f) {
            var half = bw * (1 - f);
            ctx.beginPath(); ctx.moveTo(-half, -hh * f); ctx.lineTo(half, -hh * f); ctx.stroke();
          });
          ctx.fillStyle = "#fff";
          ctx.beginPath(); ctx.arc(0, -hh, fw * 0.065, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      },

      // Call ended: drop the pipeline and the selection. The loaded landmarker
      // stays cached for the next call.
      teardown: function () {
        this.close();
        this._selected = {};
        this._notice = "";
        this._stop(false);
        this._state = this._landmarker ? "ready" : "idle";
      },

      // ── popover ──

      toggle: function (panel) {
        if (this._popover) this.close(); else this.open(panel);
      },

      _headText: function () {
        if (this._notice) return this._notice;
        if (this._state === "loading") return "Loading face tracking…";
        return "Face effects";
      },

      _refreshUI: function () {
        var NS = lively.identity.AmbientPresencePanel;
        var self = this;
        if (this._head) this._head.textString = this._headText();
        Object.keys(this._chips).forEach(function (id) {
          try { self._chips[id].applyStyle({ fill: self._chipFill(id) }); } catch (e) {}
        });
        if (NS && NS.refreshControls) NS.refreshControls();
      },

      _chipFill: function (id) {
        return this._selected[id] ? Color.rgba(232, 73, 126, 0.45) : Color.rgba(255, 255, 255, 0.06);
      },

      open: function (panel) {
        var self = this;
        var NS = lively.identity.AmbientPresencePanel;
        if (this._popover || !panel || !panel.world()) return;

        var PAD = 12, GAP = 8, COLS = 2, BTN_H = 36, HEAD_H = 26;
        var W = NS.PANEL_W;
        var BTN_W = (W - 2 * PAD - (COLS - 1) * GAP) / COLS;
        var rows = Math.ceil(this.EFFECTS.length / COLS);
        var H = PAD + HEAD_H + rows * BTN_H + (rows - 1) * GAP + PAD;

        var pos = panel.getPosition();
        var box = new lively.morphic.Box(lively.rect(pos.x, pos.y - H - 8, W, H));
        box.isEpiMorph = true;
        box.applyStyle({ fill: Color.black, borderRadius: 12, borderWidth: 3, borderColor: Color.rgb(232, 73, 126) });
        box.draggingEnabled = false; box.droppingEnabled = false; box.grabbingEnabled = false;
        box.name = "FaceEffectsPopover";

        var head = new lively.morphic.Text(lively.rect(PAD, 8, W - 2 * PAD, 18));
        head.textString = this._headText();
        head.applyStyle({
          fontSize: 9, fontWeight: "bold", textColor: NS.TEXT_SECONDARY, fill: null, borderWidth: 0,
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        head.eventsAreIgnored = true;
        box.addMorph(head);
        this._head = head;
        this._chips = {};

        this.EFFECTS.forEach(function (e, i) {
          var col = i % COLS, row = Math.floor(i / COLS);
          var b = new lively.morphic.Text(lively.rect(
            PAD + col * (BTN_W + GAP), PAD + HEAD_H + row * (BTN_H + GAP), BTN_W, BTN_H));
          b.textString = e.label;
          b.applyStyle({
            fontSize: 9, fontWeight: "600", textColor: NS.TEXT_PRIMARY,
            fill: self._chipFill(e.id), borderRadius: 8, borderWidth: 0, align: "center",
            padding: lively.Rectangle.inset(0, 10, 0, 0),
            allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
            handStyle: "pointer",
          });
          b.draggingEnabled = false; b.droppingEnabled = false; b.grabbingEnabled = false;
          b.onMouseOver = function () { b.applyStyle({ fill: NS.HOVER_BG }); };
          b.onMouseOut = function () { b.applyStyle({ fill: self._chipFill(e.id) }); };
          b.onMouseUp = function (evt) {
            self.toggleEffect(e.id);
            evt.stop();
            return true;
          };
          self._chips[e.id] = b;
          box.addMorph(b);
        });

        $world.addMorph(box);
        box.enableFixedPositioning();
        this._popover = box;
        this._panelRef = panel;

        // Click outside or Escape closes it. The panel's own button is excluded so
        // its click toggles instead of close-then-reopen.
        var onDown = function (e) {
          var node = box.renderContext().shapeNode;
          var btn = panel._faceBtn && panel._faceBtn.renderContext().shapeNode;
          if (node.contains(e.target) || (btn && btn.contains(e.target))) return;
          self.close();
        };
        var onKey = function (e) { if (e.key === "Escape") self.close(); };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        this._closeHandlers = { onDown: onDown, onKey: onKey };
      },

      close: function () {
        if (this._closeHandlers) {
          document.removeEventListener("mousedown", this._closeHandlers.onDown, true);
          document.removeEventListener("keydown", this._closeHandlers.onKey, true);
          this._closeHandlers = null;
        }
        if (this._popover) { try { this._popover.remove(); } catch (e) {} this._popover = null; }
        this._head = null; this._chips = {}; this._panelRef = null;
      },
    };

  }); // end module('lively.identity.FaceEffects')
