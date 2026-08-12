/**
 * lively.jenga3d.SceneSync
 *
 * Wires a `FeatureTree` to a `Worker` and a `Viewport` for the
 * non-interactive path (Jenga3Dspec_v0.md §13 step 5): change a node's
 * params, request an `evaluate`, swap the resulting mesh into the
 * viewport. One `SceneSync` per solid being edited (unlike
 * `lively.jenga3d.Worker`, which is one per session, §4.4) — it just
 * holds a reference to one tree and one viewport and rebuilds on demand.
 *
 * Not the drag path: §5.2's Proxy Mode mutates the viewport's mesh
 * directly without a worker round-trip, and §5.3's throttled Complex-drag
 * mode has its own rAF-gated request stream. Both of those (§13 step 7)
 * will still end up calling into `lively.jenga3d.Worker` the same way
 * `rebuild` does here — this class is the "just resync everything"
 * primitive they build on top of, not a replacement for them.
 */

module('lively.jenga3d.SceneSync')
  .requires('lively.jenga3d.FeatureTree', 'lively.jenga3d.Worker', 'lively.jenga3d.Viewport')
  .toRun(function () {

    Object.subclass('lively.jenga3d.SceneSync',

    'initializing', {
      initialize: function (featureTree, viewport) {
        this.featureTree = featureTree;
        this.viewport = viewport;
        if (this.featureTree.root) this.rebuild(this.featureTree.root);
      },
    },

    'syncing', {
      // dirtyNodeId: which node changed — the staleness-tracking key
      // lively.jenga3d.Worker.request keys generations on (§5.3).
      // Defaults to the tree's root for a full/initial rebuild. Always
      // meshes the tree's current root regardless of which node is
      // named here (§4.5: the worker replays the whole tree bottom-up
      // and meshes the root) — dirtyNodeId only decides which in-flight
      // request a newer one is allowed to supersede.
      rebuild: function (dirtyNodeId, thenDo) {
        if (!this.featureTree.root) return;
        var nodeId = dirtyNodeId || this.featureTree.root;
        var self = this;
        lively.jenga3d.Worker.request(nodeId, 'evaluate', {
          featureTree: this.featureTree.toJSON(),
          dirtyNodeId: nodeId,
          deflection: lively.jenga3d.Worker.DEFLECTION.interactive,
        }, function (err, mesh) {
          if (err) {
            console.error('[lively.jenga3d.SceneSync] evaluate failed:', err);
            if (thenDo) thenDo(err);
            return;
          }
          self.viewport.setMesh(mesh);
          if (thenDo) thenDo(null, mesh);
        });
      },

      // Convenience: update one node's params (§7.2), then rebuild keyed
      // on that node. This is the whole "non-interactive path" this step
      // targets — a param change that isn't part of a drag stream.
      updateParam: function (nodeId, params, thenDo) {
        this.featureTree.updateParams(nodeId, params);
        this.rebuild(nodeId, thenDo);
      },
    });

  });
