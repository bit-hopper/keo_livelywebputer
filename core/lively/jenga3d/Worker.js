/**
 * lively.jenga3d.Worker
 *
 * Client-side controller for Jenga3D's OCCT worker (Jenga3Dspec_v0.md §4.2,
 * §13 step 2). Owns one raw `new Worker('/core/lib/jenga3d/occt-worker.js')`
 * — that file is core/lively/jenga3d/occt-worker-src.js, esbuilt by
 * scripts/build-jenga3d-libs.js. Deliberately a plain singleton object, not
 * an Object.subclass instance — there is exactly one worker per editing
 * session (§4.4), and this mirrors core/lively/lang/Worker.js's own
 * `lively.Worker.create(...)` shape (capitalized, used directly) rather
 * than this codebase's more common Object.subclass + lowercase-singleton
 * pattern, which assumes multiple instances.
 *
 * Tracks in-flight jobs by (nodeId, generation) and only invokes a
 * request's callback if its generation is still the latest one issued for
 * that nodeId — staleness rejection per §5.3, not true cancellation (a
 * synchronous WASM call in the worker can't be interrupted mid-computation
 * once started; see occt-worker-src.js).
 */

module('lively.jenga3d.Worker')
  .requires()
  .toRun(function () {

    lively.jenga3d.Worker = {

      // §9.1 — deflection tiers, defined once here per the spec.
      DEFLECTION: {
        interactive: { linear: 0.1, angular: 0.5 },
        export:      { linear: 0.01, angular: 0.1 },
      },

      _worker: null,
      _pending: {},           // id -> { nodeId, generation, thenDo }
      _generationByNode: {},  // nodeId -> latest generation issued
      _nextId: 1,

      // lively.jenga3d.Worker.request(nodeId, op, params, thenDo)
      // thenDo(err, mesh) where mesh = { positions, normals, indices, groups }
      // (op: "evaluate") or { fileBytes, mime } (op: "exportStep"/"exportIges",
      // not implemented by occt-worker-src.js until §13 step 12).
      request: function (nodeId, op, params, thenDo) {
        var generation = (this._generationByNode[nodeId] || 0) + 1;
        this._generationByNode[nodeId] = generation;
        var id = this._nextId++;
        this._pending[id] = { nodeId: nodeId, generation: generation, thenDo: thenDo };
        this._ensureWorker().postMessage({
          id: id, nodeId: nodeId, generation: generation, op: op, params: params
        });
      },

      _ensureWorker: function () {
        if (this._worker) return this._worker;
        var self = this;
        this._worker = new Worker('/core/lib/jenga3d/occt-worker.js');
        this._worker.onmessage = function (evt) { self._onMessage(evt.data); };
        this._worker.onerror = function (evt) {
          console.error('[lively.jenga3d.Worker] worker error:', evt.message || evt);
        };
        return this._worker;
      },

      _onMessage: function (data) {
        var entry = this._pending[data.id];
        delete this._pending[data.id];
        if (!entry) return; // unknown/already-handled id
        // §5.3: discard if a newer request for this nodeId has since been sent.
        if (data.generation !== this._generationByNode[data.nodeId]) return;
        if (!data.ok) { entry.thenDo(new Error(data.error)); return; }
        entry.thenDo(null, {
          positions: data.positions,
          normals:   data.normals,
          indices:   data.indices,
          groups:    data.groups,
        });
      },

    };

  });
