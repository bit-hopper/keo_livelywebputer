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
 * §14.2/§14.5: since a tree can now hold several independently-visible
 * instances (`roots`, plural), a `SceneSync` is scoped to exactly one
 * `rootId` — the constructor takes `(featureTree, viewport, rootId,
 * thenDo)` instead of `(featureTree, viewport)`. `lively.jenga3d.Assembly`
 * owns one `SceneSync` per currently-visible instance; `rootId` is also
 * the generation-tracking key `Worker.request` uses (the same role
 * `dirtyNodeId` played in the single-root model), since each `SceneSync`
 * only ever rebuilds its own instance.
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
      initialize: function (featureTree, viewport, rootId, thenDo) {
        this.featureTree = featureTree;
        this.viewport = viewport;
        this.rootId = rootId;
        this.rebuild(thenDo);
      },
    },

    'syncing', {
      // Always meshes this.rootId — §4.5: the worker replays the whole
      // tree bottom-up from whatever `root` a request names and meshes
      // that node, so a SceneSync scoped to one instance always sends
      // the same rootId as both the request's `root` and its staleness-
      // tracking generation key (§5.3, §14.5).
      rebuild: function (thenDo) {
        if (!this.featureTree.getNode(this.rootId)) {
          // §13 step 14 / §14.5: reachable once undo/removeInstance can
          // make this SceneSync's own rootId stop existing — nothing to
          // mesh, but this instance's last mesh is stale and needs
          // explicit teardown rather than being left on screen.
          this.viewport.clearMesh(this.rootId);
          if (thenDo) thenDo(null, null);
          return;
        }
        var self = this;
        lively.jenga3d.Worker.request(this.rootId, 'evaluate', {
          featureTree: this.featureTree.toJSONForRoot(this.rootId),
          dirtyNodeId: this.rootId,
          deflection: lively.jenga3d.Worker.DEFLECTION.interactive,
        }, function (err, mesh) {
          if (err) {
            console.error('[lively.jenga3d.SceneSync] evaluate failed:', err);
            if (thenDo) thenDo(err);
            return;
          }
          self.viewport.setMesh(self.rootId, mesh);
          if (thenDo) thenDo(null, mesh);
        });
      },

      // Convenience: update one node's params (§7.2), then rebuild this
      // instance. This is the whole "non-interactive path" this step
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
        this.rebuild(thenDo);
      },
    });

  });
