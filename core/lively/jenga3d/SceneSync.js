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
        if (!this.featureTree.root) {
          // §13 step 14: reachable now that undo can walk a tree back to
          // empty — nothing to mesh, but the viewport's last mesh is
          // stale and needs explicit teardown rather than being left on
          // screen.
          this.viewport.clearMesh();
          if (thenDo) thenDo(null, null);
          return;
        }
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
      // targets — a param change that isn't part of a drag stream. Also
      // exactly the "FeatureTree node's params are committed" point §5.2
      // names as the undo boundary (§6.2/§13 step 14) — the throttled
      // complex-drag path (§5.3) deliberately calls featureTree.updateParams
      // + rebuild directly instead of through here, so its intermediate
      // frames don't pile up undo entries; only endDrag's final commit
      // goes through updateParam.
      updateParam: function (nodeId, params, thenDo) {
        this.featureTree.checkpoint();
        this.featureTree.updateParams(nodeId, params);
        this.rebuild(nodeId, thenDo);
      },
    },

    'undo/redo (§6.2, §13 step 14)', {
      // thenDo(err, didChange, mesh) — didChange is false when the
      // respective stack was empty (nothing to do, no rebuild fired).
      undo: function (thenDo) {
        if (!this.featureTree.undo()) { if (thenDo) thenDo(null, false); return false; }
        this.rebuild(this.featureTree.root, function (err, mesh) { if (thenDo) thenDo(err, true, mesh); });
        return true;
      },

      redo: function (thenDo) {
        if (!this.featureTree.redo()) { if (thenDo) thenDo(null, false); return false; }
        this.rebuild(this.featureTree.root, function (err, mesh) { if (thenDo) thenDo(err, true, mesh); });
        return true;
      },
    });

  });
