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
 *
 * §13 step 7 adds the other half of §5.3's queue-depth-of-1 plumbing:
 * "if a previous request... is still running, it is NOT interrupted...
 * the new request replaces (not appends to) any older still-queued one."
 * Implemented here, client-side, rather than inside the worker script —
 * there's exactly one WASM heap (§4.4), so at most one request can ever
 * actually be in flight regardless of which nodeId it's for; withholding
 * excess `request()` calls here has the identical observable effect to a
 * worker-side queue, without needing the worker to track busy/queued
 * state itself. Only a single global "next" slot is kept (not one per
 * nodeId) for the same one-WASM-heap reason — §12 item 4 already flags
 * multiple simultaneous solids contending for one worker as unresolved,
 * so this doesn't try to solve fairness across nodeIds, just guarantee
 * the worker never falls more than one job behind.
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
      _busy: false,           // is a request currently in flight to the worker?
      _queuedNext: null,      // at most one not-yet-sent envelope, superseded on each new request while busy

      // lively.jenga3d.Worker.request(nodeId, op, params, thenDo)
      // thenDo(err, mesh) where mesh = { positions, normals, indices, groups,
      // edges } (op: "evaluate"; edges added §13 step 10) or { fileBytes, mime }
      // (op: "exportStep"/"exportIges", not implemented by occt-worker-src.js
      // until §13 step 12).
      //
      // If the worker is currently busy with an earlier request, this one
      // is held rather than sent immediately (§5.3) — superseding whatever
      // was already held, so at most one stale job is ever waiting. A
      // superseded envelope's thenDo is simply never called; it was never
      // sent, so no response (stale or otherwise) will ever arrive for it.
      request: function (nodeId, op, params, thenDo) {
        var generation = (this._generationByNode[nodeId] || 0) + 1;
        this._generationByNode[nodeId] = generation;
        var envelope = { nodeId: nodeId, op: op, params: params, generation: generation, thenDo: thenDo };
        if (this._busy) { this._queuedNext = envelope; return; }
        this._sendNow(envelope);
      },

      _sendNow: function (envelope) {
        this._busy = true;
        var id = this._nextId++;
        this._pending[id] = { nodeId: envelope.nodeId, generation: envelope.generation, thenDo: envelope.thenDo };
        this._ensureWorker().postMessage({
          id: id, nodeId: envelope.nodeId, generation: envelope.generation,
          op: envelope.op, params: envelope.params
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
        this._busy = false;
        var entry = this._pending[data.id];
        delete this._pending[data.id];
        if (entry) {
          // §5.3: discard if a newer request for this nodeId has since been sent.
          if (data.generation === this._generationByNode[data.nodeId]) {
            if (!data.ok) entry.thenDo(new Error(data.error));
            else entry.thenDo(null, {
              positions: data.positions,
              normals:   data.normals,
              indices:   data.indices,
              groups:    data.groups,
              edges:     data.edges,
            });
          }
        }
        if (this._queuedNext) {
          var next = this._queuedNext;
          this._queuedNext = null;
          this._sendNow(next);
        }
      },

    };

  });
