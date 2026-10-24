/**
 * lively.morphic.tools.ProcessCatMenuBarEntry
 *
 * A little running cat in the menu bar. It runs faster the busier the machine
 * and this page are, and clicking it lists what the browser reports and the
 * background processes Lively itself is running.
 *
 * Where the numbers come from (a browser has no "CPU percent"):
 *  - machine-wide: the Compute Pressure API (PressureObserver, source "cpu"). It
 *    reports one of four states (nominal / fair / serious / critical), sampled
 *    about once a second, and only in browsers that ship it (Chromium; checked in
 *    Chrome 155) and on a secure context. Elsewhere this signal is simply absent.
 *  - this page: how much of the last few seconds the main thread spent in long
 *    animation frames (or, where that is missing, long tasks). This is the page's
 *    own load, and includes Lively's stepping scripts.
 *  Neither is a percentage of the machine's CPU, and the menu says what each one is.
 *
 * "Background processes" means the stepping scripts (Morph#startStepping) running
 * on morphs in the world: that is what Lively schedules behind the scenes. Web
 * workers and in-flight requests are not listed (they are not registered anywhere
 * central).
 *
 * The cat is made of real Image morphs (one per animation frame) inside an
 * ordinary menu bar entry, so it can be halo-selected and inspected like any
 * morph. The frames are generated SVG, drawn here, not an imported asset.
 *
 * Everything the BuildSpec's methods need lives on lively.morphic.tools.ProcessCat:
 * BuildSpec methods are rebuilt from their source text and lose the closure over
 * this module's variables (CLAUDE.md, "BuildSpec / addScript methods lose their
 * closure"), so a bare module-level helper would throw at the first call.
 */

module('lively.morphic.tools.ProcessCatMenuBarEntry').requires('lively.morphic.tools.MenuBar').toRun(function() {

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// Helpers. Use these rather than re-deriving the numbers in the entry's methods:
//   frameUrl(i, hot)   data: URL of animation frame i, grey or accent coloured
//   frameMs(level)     how long one frame stays on screen at a load level (0..1)
//   Monitor            the load signals; one shared instance, started on first use
//   processes()        the stepping scripts running in the world, most frequent first
//   describePressure() / describeBusy()   the text the menu shows for each signal
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

lively.morphic.tools.ProcessCat = {

  FRAMES: 6,                       // frames in one stride
  CAT_W: 32, CAT_H: 20,            // drawing size in px (the Image morphs' extent)
  COLOR: "#555555",                // calm cat: the menu bar's own text grey
  HOT_COLOR: "rgb(240,26,105)",    // the cat turns the page's pink when the load is high
  HOT_LEVEL: 0.7,                  // from this load level on, the hot colour is used
  SLOWEST_MS: 240,                 // frame time at no load
  FASTEST_MS: 45,                  // frame time at full load
  BUSY_WINDOW_MS: 4000,            // how far back "this page is busy" looks
  BUSY_GAIN: 3,                    // a page busy 33% of the time already counts as full load
  PRESSURE_LEVEL: { nominal: 0.08, fair: 0.4, serious: 0.75, critical: 1 },
  MAX_PROCESSES_SHOWN: 14,

  // One animation frame of a cat running to the right, as an SVG string. The
  // drawing is a few primitives so it stays crisp at any pixel density: the body
  // bobs, the tail swings and each leg's paw follows its own phase of the stride
  // (front pair a little apart, back pair half a stride behind). Nothing here
  // touches the DOM; callers wrap it in a data: URL (frameUrl).
  frameSvg: function (i, color) {
    var R = lively.morphic.tools.ProcessCat, N = R.FRAMES, a = 2 * Math.PI * i / N;
    var bob = -1.1 * Math.abs(Math.sin(a));            // the body rises mid-stride
    function r(v) { return Math.round(v * 100) / 100; }
    function leg(ax, ay, phase) {
      var t = a + phase;
      var px = ax + 4.4 * Math.sin(t);                 // paw swings fore and aft
      var py = 16.2 - 2.6 * Math.max(0, Math.cos(t));  // and lifts on the way forward
      return '<line x1="' + r(ax) + '" y1="' + r(ay) + '" x2="' + r(px) + '" y2="' + r(py) + '"/>';
    }
    var tailLift = 3.2 + 2.2 * Math.sin(a + 1.2);
    // The drawing is shifted down 1.2 units: the ear tips (and the bob) reach the
    // top edge of the 32x20 frame, where the Image morph's clip cut them flat. The
    // paws' lowest point (16.2 + 1.2 + half the 2.4 stroke) then stays inside the
    // bottom edge; check both edges again if the shift or the paw line changes.
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 20" width="32" height="20">' +
      '<g transform="translate(0 1.2)">' +
      '<g fill="' + color + '" stroke="' + color + '" stroke-linecap="round" stroke-linejoin="round">' +
        // tail
        '<path d="M7.4 ' + r(10 + bob) + ' Q2.4 ' + r(6.2 + bob) + ' 3.6 ' + r(tailLift + bob) + '" fill="none" stroke-width="2.1"/>' +
        // legs (behind the body)
        '<g stroke-width="2.4">' +
          leg(20.6, 13.2 + bob, 0) + leg(18.4, 13.2 + bob, 0.55) +
          leg(10.4, 13.2 + bob, Math.PI) + leg(8.2, 13.2 + bob, Math.PI + 0.55) +
        '</g>' +
        // body, head, ears
        '<ellipse cx="15" cy="' + r(10.6 + bob) + '" rx="8.6" ry="4.3" stroke="none"/>' +
        '<circle cx="24.4" cy="' + r(7.6 + bob) + '" r="4" stroke="none"/>' +
        '<polygon points="21.9,' + r(5.2 + bob) + ' 22.7,' + r(1.1 + bob) + ' 25.4,' + r(4 + bob) + '" stroke-width="0.6"/>' +
        '<polygon points="25.2,' + r(3.9 + bob) + ' 28.1,' + r(1.3 + bob) + ' 28.4,' + r(6.2 + bob) + '" stroke-width="0.6"/>' +
      '</g>' +
      '<circle cx="26.1" cy="' + r(7 + bob) + '" r="0.8" fill="#ffffff"/>' +
      '</g></svg>';
  },

  // Frame i as a data: URL, in the calm or the hot colour. Cached: the same twelve
  // strings are asked for every time an entry is built.
  frameUrl: function (i, hot) {
    var R = lively.morphic.tools.ProcessCat, key = (hot ? "h" : "c") + i;
    R._urls = R._urls || {};
    return R._urls[key] || (R._urls[key] = "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(R.frameSvg(i, hot ? R.HOT_COLOR : R.COLOR)));
  },

  // How long one frame stays up at load `level` (0..1): slow at rest, quick at full
  // load, like the original desktop runner.
  frameMs: function (level) {
    var R = lively.morphic.tools.ProcessCat;
    return Math.round(R.SLOWEST_MS - (R.SLOWEST_MS - R.FASTEST_MS) * Math.max(0, Math.min(1, level)));
  },

  // The stepping scripts running on morphs in the world, most frequent first.
  // Each is {label, ms, morph}. This is the only enumeration of "background
  // processes" Lively has: scripts live on the morph that owns them (morph.scripts).
  // Stopped scripts are skipped. Walks every morph, so call it when the menu opens,
  // never on a timer.
  processes: function () {
    var out = [];
    if (typeof $world === "undefined" || !$world) return out;
    $world.withAllSubmorphsDo(function (m) {
      (m.scripts || []).forEach(function (s) {
        if (!s || s.stopped) return;
        var owner = m.name || (m.constructor && m.constructor.type) || "morph";
        out.push({ label: owner + "." + (s.selector || "script"), ms: s.tickTime || 0, morph: m });
      });
    });
    out.sort(function (x, y) { return (x.ms || 1e9) - (y.ms || 1e9); });
    return out;
  },

  describePressure: function () {
    var M = lively.morphic.tools.ProcessCat.Monitor;
    if (!M.pressureSupported) return "machine CPU: not reported by this browser";
    return "machine CPU pressure: " + (M.pressure || "waiting for first sample");
  },

  describeBusy: function () {
    var M = lively.morphic.tools.ProcessCat.Monitor;
    return "this page busy: " + Math.round(M.busyFraction() * 100) + "% (last " +
      Math.round(lively.morphic.tools.ProcessCat.BUSY_WINDOW_MS / 1000) + " s)";
  }
};

// The load signals. One shared instance (the bar can hold at most one cat, but a
// world may build the entry again), started the first time anything asks.
lively.morphic.tools.ProcessCat.Monitor = {

  started: false,
  pressure: null,            // last Compute Pressure state, or null
  pressureSupported: false,  // false until an observer is really observing
  longEntries: [],           // {t, d}: when a long frame/task ended and how long it was
  smoothed: 0,
  lastSmoothAt: 0,

  // Starts both observers. Safe to call many times. Every step is wrapped: a
  // browser without PressureObserver, or one where the permissions policy blocks
  // it, must leave the cat running on the page signal alone, not break the menu bar.
  start: function () {
    var M = lively.morphic.tools.ProcessCat.Monitor;
    if (M.started) return M;
    M.started = true;
    try {
      if (typeof PressureObserver !== "undefined") {
        var po = new PressureObserver(function (records) {
          var last = records[records.length - 1];
          if (last) M.pressure = last.state;
        });
        var p = po.observe("cpu", { sampleInterval: 1000 });
        M.pressureSupported = true;
        if (p && p.catch) p.catch(function () { M.pressureSupported = false; M.pressure = null; });
        M._pressureObserver = po;
      }
    } catch (e) { M.pressureSupported = false; }
    try {
      var types = PerformanceObserver.supportedEntryTypes || [];
      var type = types.indexOf("long-animation-frame") >= 0 ? "long-animation-frame"
               : types.indexOf("longtask") >= 0 ? "longtask" : null;
      if (type) {
        M._perfObserver = new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (e) {
            M.longEntries.push({ t: e.startTime + e.duration, d: e.duration });
          });
          M._trim();
        });
        M._perfObserver.observe({ type: type, buffered: false });
      }
    } catch (e) {}
    return M;
  },

  _trim: function () {
    var M = lively.morphic.tools.ProcessCat.Monitor,
        from = performance.now() - lively.morphic.tools.ProcessCat.BUSY_WINDOW_MS;
    while (M.longEntries.length && M.longEntries[0].t < from) M.longEntries.shift();
  },

  // Share (0..1) of the recent window the main thread spent in long frames/tasks.
  busyFraction: function () {
    var M = lively.morphic.tools.ProcessCat.Monitor;
    M._trim();
    var sum = 0;
    M.longEntries.forEach(function (e) { sum += e.d; });
    return Math.min(1, sum / lively.morphic.tools.ProcessCat.BUSY_WINDOW_MS);
  },

  // The load level the cat reacts to (0..1): the larger of the machine's pressure
  // and the page's own load, eased over ~1.5 s so one short spike does not make
  // the cat jerk between speeds.
  level: function () {
    var R = lively.morphic.tools.ProcessCat, M = R.Monitor;
    M.start();
    var target = Math.max(
      M.pressure ? (R.PRESSURE_LEVEL[M.pressure] || 0) : 0,
      Math.min(1, M.busyFraction() * R.BUSY_GAIN));
    var now = performance.now(), dt = M.lastSmoothAt ? now - M.lastSmoothAt : 0;
    M.lastSmoothAt = now;
    M.smoothed += (target - M.smoothed) * (1 - Math.exp(-dt / 1500));
    return M.smoothed;
  }
};

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

lively.BuildSpec('lively.morphic.tools.ProcessCatMenuBarEntry', lively.BuildSpec("lively.morphic.tools.MenuBarEntry").customize({

  name: "ProcessCatMenuBarEntry",
  menuBarAlign: "right",
  textString: "",
  // The base entry fills pink while its menu is open. The cat itself turns that
  // same pink under load, so it would vanish into the fill exactly when it matters.
  changeColorForMenu: false,

  style: lively.lang.obj.merge(lively.BuildSpec("lively.morphic.tools.MenuBarEntry").attributeStore.style, {
    extent: lively.pt(40, 24),
    padding: lively.rect(0, 0, 0, 0),
    toolTip: "Runs faster the busier this machine and this page are. Click for details."
  }),

  // The menu: what each signal says right now, then the stepping scripts. Built
  // when the menu opens, so the numbers are current.
  morphMenuItems: function morphMenuItems() {
    var R = lively.morphic.tools.ProcessCat, procs = R.processes();
    var items = [
      [R.describePressure(), function () {}],
      [R.describeBusy(), function () {}]
    ];
    var shown = procs.slice(0, R.MAX_PROCESSES_SHOWN).map(function (p) {
      var every = p.ms >= 1000 ? (Math.round(p.ms / 100) / 10) + " s" : p.ms + " ms";
      return [p.label + "  (every " + every + ")", function () { p.morph.show && p.morph.show(); }];
    });
    if (procs.length > shown.length) shown.push(["... and " + (procs.length - shown.length) + " more", function () {}]);
    if (!shown.length) shown.push(["none running", function () {}]);
    items.push(["background processes (" + procs.length + ")", shown]);
    return items;
  },

  update: function update() {},

  // One image per frame and colour, stacked at the same spot; only one is visible.
  // Built once. Images get no mouse handling of their own, so a click lands on
  // the entry (its menu), and no drag/grab flags (CLAUDE.md, "Disabling
  // drag/drop/grab on a morph needs three flags").
  buildCat: function buildCat() {
    var R = lively.morphic.tools.ProcessCat, self = this;
    this._frames = [];
    var x = Math.round((this.getExtent().x - R.CAT_W) / 2), y = Math.round((this.getExtent().y - R.CAT_H) / 2);
    [false, true].forEach(function (hot) {
      for (var i = 0; i < R.FRAMES; i++) {
        var img = new lively.morphic.Image(lively.rect(x, y, R.CAT_W, R.CAT_H), R.frameUrl(i, hot), false);
        img.eventsAreIgnored = true;
        img.draggingEnabled = false; img.droppingEnabled = false; img.grabbingEnabled = false;
        img.setVisible(false);
        self.addMorph(img);
        self._frames.push(img);
      }
    });
    this._frame = 0; this._hot = false; this._ms = R.SLOWEST_MS; this._shown = null;
  },

  // One step of the run: show the next frame, then re-time the stepping script if
  // the load moved enough to matter (restarting it every tick would be wasteful).
  tickCat: function tickCat() {
    var R = lively.morphic.tools.ProcessCat;
    if (!this._frames || !this._frames.length) return;
    var level = R.Monitor.level();
    this._hot = level >= R.HOT_LEVEL;
    this._frame = (this._frame + 1) % R.FRAMES;
    var next = this._frames[(this._hot ? R.FRAMES : 0) + this._frame];
    if (this._shown !== next) {
      this._shown && this._shown.setVisible(false);
      next.setVisible(true);
      this._shown = next;
    }
    var ms = R.frameMs(level);
    if (Math.abs(ms - this._ms) > this._ms * 0.15) {
      this._ms = ms;
      this.startStepping(ms, "tickCat");
    }
  },

  onLoad: function onLoad() {
    lively.morphic.tools.ProcessCat.Monitor.start();
    if (!this._frames) this.buildCat();
    this.startStepping(this._ms, "tickCat");
  },

  onFromBuildSpecCreated: function onFromBuildSpecCreated() {
    this.onLoad();
  }

}));

Object.extend(lively.morphic.tools.ProcessCatMenuBarEntry, {

  getMenuBarEntries: function() {
    return [lively.BuildSpec('lively.morphic.tools.ProcessCatMenuBarEntry').createMorph()];
  }
});

}); // end of module
