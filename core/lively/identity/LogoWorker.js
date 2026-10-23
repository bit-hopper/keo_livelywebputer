/**
 * lively.identity.LogoWorker
 *
 * Client-side controller for the wiki's Logo and TPN code cells (LOGO.md 7.2).
 * A copy of lively.identity.SchemeWorker and MLWorker (the third same-shaped
 * controller; LOGO.md Q9 decides at Phase 2 whether the three become one
 * factory). See core/lib/logo/logo-worker.js for the protocol. Both the `logo`
 * and the `tpn` registry rows name this one controller, so a procedure defined
 * in a tpn cell is callable from a logo cell. Owns one raw
 * `new Worker('/core/lib/logo/logo-worker.js')` per wiki page, created
 * lazily on the first Logo Run click (never on page load). Same plain
 * singleton shape as lively.identity.PyodideWorker: every Logo cell on the
 * page shares the one interpreter, notebook-style.
 *
 * Unlike MLWorker, runs can pause for a line of input (READLIST and friends),
 * so this keeps SchemeWorker's onNeedInput / provideInput pair. The worker
 * does not post `needInput` yet: the engine has no READ* primitives.
 *
 * Differences from the Python controller:
 *  - Output streams: a run reports ordered segments {kind, text} as they are
 *    produced.
 *  - Stop is two-tier. interrupt() asks the interpreter to stop at its next
 *    time-slice boundary, so the global environment survives. Only if no
 *    answer arrives within STOP_GRACE_MS (a runaway native primitive) is the
 *    worker terminated, which loses the environment.
 *  - No wall-clock run timeout; Stop is the escape hatch.
 *  - One run at a time per page; a second run() while one is active is
 *    refused with an error rather than queued behind a possibly endless one.
 */

module('lively.identity.LogoWorker')
  .requires()
  .toRun(function () {

    lively.identity.LogoWorker = {

      STOP_GRACE_MS: 3000,

      _worker: null,
      _readyState: 'idle',    // 'idle' | 'loading' | 'ready' | 'failed'
      _readyCallbacks: [],
      _active: null,          // { id, handlers, stopTimer } for the run in flight
      _resetCallbacks: [],
      _nextId: 1,
      buildId: null,

      // thenDo(err) once the engine is loaded in the worker.
      ensureReady: function (thenDo) {
        if (this._readyState === 'ready') return thenDo(null);
        if (this._readyState === 'failed') return thenDo(new Error('The Logo engine failed to load earlier — reload the page to retry.'));
        this._readyCallbacks.push(thenDo);
        if (this._readyState === 'loading') return;
        this._readyState = 'loading';
        var self = this;
        this._ensureWorker().postMessage({ op: 'init' });
        this._initTimer = setTimeout(function () {
          if (self._readyState !== 'loading') return;
          self._onInitDone(new Error('The Logo engine timed out while loading.'));
        }, 20000);
      },

      _onInitDone: function (err) {
        if (this._initTimer) { clearTimeout(this._initTimer); this._initTimer = null; }
        this._readyState = err ? 'failed' : 'ready';
        var callbacks = this._readyCallbacks;
        this._readyCallbacks = [];
        callbacks.forEach(function (cb) { cb(err || null); });
      },

      // handlers: {
      //   onSegments(segments)   new output, in order; kinds: stdout | warning | error | status
      //                          (no `value`: a Logo cell does not echo expressions, LOGO.md decision 7)
      //   onDraw(ops, turtle)    the turtle's drawing since the last call: the engine's draw operations (see
      //                          core/lib/logo/src/turtle.js) and the turtle's state when it changed (else null). Always
      //                          delivered before the same slice's onSegments.
      //   onNeedInput()          the cell asked for a line; answer with provideInput(text)
      //   onDone(err, result)    result = {state: done | error | stopped}; err only for
      //                          failures of the run machinery itself (worker lost, busy, ...)
      // }
      // Call ensureReady() first.
      run: function (source, handlers) {
        handlers = handlers || {};
        if (this._active) {
          if (handlers.onDone) handlers.onDone(new Error('Another Logo cell is still running on this page. Stop it first.'), null);
          return;
        }
        var id = this._nextId++;
        this._active = { id: id, handlers: handlers, stopTimer: null };
        this._ensureWorker().postMessage({ id: id, op: 'run', source: source });
      },

      isRunning: function () { return !!this._active; },

      // Answers a pending onNeedInput. text === null means end of input.
      provideInput: function (text) {
        if (!this._active || !this._worker) return;
        this._worker.postMessage({ op: 'input', id: this._active.id, text: text });
      },

      // Tier 1: cooperative interrupt, environment survives. Tier 2 (no
      // answer within STOP_GRACE_MS): kill the worker, environment lost.
      // The active run's onDone always fires afterwards.
      interrupt: function () {
        var active = this._active;
        if (!active || !this._worker) return;
        this._worker.postMessage({ op: 'interrupt' });
        if (active.stopTimer) return;
        var self = this;
        active.stopTimer = setTimeout(function () {
          if (self._active !== active) return;
          self.terminate('The cell did not respond to Stop, so the Logo runtime was restarted — definitions from earlier cells are gone.');
        }, this.STOP_GRACE_MS);
      },

      // Fresh interpreter (core library only). The worker stays alive. thenDo(err).
      reset: function (thenDo) {
        thenDo = thenDo || function () {};
        if (!this._worker || this._readyState !== 'ready') { return thenDo(null); }  // nothing to reset yet
        var active = this._active;
        if (active) this._finishActive(null, { state: 'stopped' });
        this._resetCallbacks.push(thenDo);
        this._worker.postMessage({ op: 'reset' });
      },

      // A real worker.terminate(): drops the interpreter and all definitions.
      // The next ensureReady()/run() creates a fresh worker.
      terminate: function (reason) {
        if (this._worker) { this._worker.terminate(); this._worker = null; }
        this._readyState = 'idle';
        if (this._initTimer) { clearTimeout(this._initTimer); this._initTimer = null; }
        var resets = this._resetCallbacks;
        this._resetCallbacks = [];
        resets.forEach(function (cb) { cb(null); });
        var waiting = this._readyCallbacks;
        this._readyCallbacks = [];
        waiting.forEach(function (cb) { cb(new Error('Cell stopped.')); });
        if (this._active) this._finishActive(new Error(reason || 'Cell stopped.'), null);
      },

      _finishActive: function (err, result) {
        var active = this._active;
        if (!active) return;
        this._active = null;
        if (active.stopTimer) clearTimeout(active.stopTimer);
        if (active.handlers.onDone) active.handlers.onDone(err, result);
      },

      _ensureWorker: function () {
        if (this._worker) return this._worker;
        var self = this;
        var worker = new Worker('/core/lib/logo/logo-worker.js');
        this._worker = worker;
        worker.onmessage = function (evt) { if (self._worker === worker) self._onMessage(evt.data); };
        worker.onerror = function (evt) {
          console.error('[lively.identity.LogoWorker] worker error:', evt.message || evt);
          if (self._worker !== worker) return;
          if (self._readyState === 'loading') self._onInitDone(new Error('The Logo engine failed to load.'));
        };
        return worker;
      },

      _onMessage: function (data) {
        if (data.op === 'init') {
          if (data.ok) this.buildId = data.buildId;
          this._onInitDone(data.ok ? null : new Error(data.error));
          return;
        }
        if (data.op === 'reset') {
          var resets = this._resetCallbacks;
          this._resetCallbacks = [];
          resets.forEach(function (cb) { cb(null); });
          return;
        }
        var active = this._active;
        if (!active || data.id !== active.id) return;   // stale: stopped / reset / terminated
        var handlers = active.handlers;
        if (data.op === 'segments') {
          if (handlers.onSegments) handlers.onSegments(data.segments);
        } else if (data.op === 'draw') {
          if (handlers.onDraw) handlers.onDraw(data.ops, data.turtle);
        } else if (data.op === 'needInput') {
          if (handlers.onNeedInput) handlers.onNeedInput();
          else this.provideInput(null);
        } else if (data.op === 'done') {
          if (data.segments && data.segments.length && handlers.onSegments) handlers.onSegments(data.segments);
          this._finishActive(null, { state: data.state });
        }
      },

    };

  });
