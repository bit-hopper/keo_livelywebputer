/**
 * lively.jenga3d.Assembly
 *
 * Per-editor coordinator for a multi-instance scene (Jenga3Dspec_v0.md
 * §14.5, §13 step 17) — replaces the single `SceneSync` a `SolidMorph`
 * used to hold directly (§13 step 5/13) now that a `FeatureTree` can hold
 * several independently-visible instances (`roots`, §14.2). Owns:
 *
 *   - the shared `FeatureTree`,
 *   - a `sceneSyncs` map from rootId to that instance's own `SceneSync`
 *     (one per currently-visible instance, constructed with an explicit
 *     rootId per §14.2's `SceneSync` constructor change),
 *   - `selectedRootIds` (0, 1, or 2 entries — §14.1 decision 5: combine is
 *     pairwise).
 *
 * `createInstance` is what the primitive-creation tools (`CreateBoxTool`
 * et al, §14.7) call instead of reaching for a `SceneSync` directly.
 * `combineSelected`/`filletSelected` wrap `CombineTool`/`FilletTool` (now
 * synchronous, tree-only mutations per their own file docs) and own the
 * SceneSync teardown/construction their tree mutation implies.
 * `undo`/`redo` do a full resync — simplest-correct for v1 (§14.5) rather
 * than diffing old-vs-new roots, since undo/redo isn't a hot path and
 * every instance gets fully re-evaluated by the worker on any structural
 * change anyway (§4.5).
 */

module('lively.jenga3d.Assembly')
  .requires('lively.jenga3d.FeatureTree', 'lively.jenga3d.SceneSync',
    'lively.jenga3d.tools.CombineTool', 'lively.jenga3d.tools.FilletTool')
  .toRun(function () {

    Object.subclass('lively.jenga3d.Assembly',

    'initializing', {
      initialize: function (featureTree, viewport) {
        this.featureTree = featureTree;
        this.viewport = viewport;
        this.sceneSyncs = {}; // rootId -> SceneSync
        this.selectedRootIds = [];
        this.combineTool = new lively.jenga3d.tools.CombineTool(featureTree);
        this.filletTool = new lively.jenga3d.tools.FilletTool(featureTree);

        // Resync any roots already present (e.g. a FeatureTree restored
        // from persistence, §8, handed to a fresh Assembly on restore).
        var self = this;
        this.featureTree.getRoots().forEach(function (rootId) {
          self.sceneSyncs[rootId] = new lively.jenga3d.SceneSync(self.featureTree, self.viewport, rootId);
        });
      },
    },

    'instances (§14.7 primitive-creation entry point)', {
      // op: 'createBox' | 'createCylinder' | 'createSphere'. params: that
      // op's own params (§7.2). placement: { translate, rotate, scale }
      // for the wrapping transform node. Returns the new instance's
      // rootId (the wrapping transform's nodeId) synchronously; thenDo
      // fires once the worker has actually meshed it.
      createInstance: function (op, params, placement, thenDo) {
        this.featureTree.checkpoint(); // §6.2/§13 step 14 — one undo entry per completed create
        var nodeId = this.featureTree.addNode(op, params);
        var xfId = this.featureTree.addNode('transform', {
          of: nodeId,
          translate: placement.translate || [0, 0, 0],
          rotate: placement.rotate || [0, 0, 0],
          scale: placement.scale || [1, 1, 1],
        });
        this.featureTree.addRoot(xfId);
        var self = this;
        this.sceneSyncs[xfId] = new lively.jenga3d.SceneSync(this.featureTree, this.viewport, xfId, function (err, mesh) {
          if (thenDo) thenDo(err, xfId, mesh);
        });
        return xfId;
      },

      removeInstance: function (rootId) {
        this.featureTree.checkpoint();
        this.featureTree.removeRoot(rootId);
        delete this.sceneSyncs[rootId];
        this.viewport.clearMesh(rootId);
        this._deselect(rootId);
        this.viewport._frameAllMeshes();
      },
    },

    'combine / fillet (§14.5, §14.6)', {
      // Requires exactly two selected instances (§14.1 decision 5).
      // Returns the new combined instance's rootId.
      combineSelected: function (op, thenDo) {
        if (this.selectedRootIds.length !== 2) {
          throw new Error('lively.jenga3d.Assembly: combineSelected requires exactly two selected instances');
        }
        var a = this.selectedRootIds[0], b = this.selectedRootIds[1];
        var newId = this.combineTool.combine(op, a, b);
        this._teardownInstance(a);
        this._teardownInstance(b);
        this.selectedRootIds = [];
        var self = this;
        this.sceneSyncs[newId] = new lively.jenga3d.SceneSync(this.featureTree, this.viewport, newId, function (err, mesh) {
          self.viewport._frameAllMeshes();
          if (thenDo) thenDo(err, newId, mesh);
        });
        return newId;
      },

      // Requires exactly one selected instance.
      filletSelected: function (op, edgeIndices, amount, thenDo) {
        if (this.selectedRootIds.length !== 1) {
          throw new Error('lively.jenga3d.Assembly: filletSelected requires exactly one selected instance');
        }
        var rootId = this.selectedRootIds[0];
        var newId = this.filletTool.apply(op, rootId, edgeIndices, amount);
        this._teardownInstance(rootId);
        this.selectedRootIds = [];
        var self = this;
        this.sceneSyncs[newId] = new lively.jenga3d.SceneSync(this.featureTree, this.viewport, newId, function (err, mesh) {
          self.viewport._frameAllMeshes();
          if (thenDo) thenDo(err, newId, mesh);
        });
        return newId;
      },

      // Tears down a superseded instance's SceneSync/mesh without
      // touching the tree (combine/fillet already did their own
      // removeRoot/replaceRoot) — the shared "instance is gone from the
      // viewport" half of removeInstance, factored out since combine
      // removes two and fillet replaces one.
      _teardownInstance: function (rootId) {
        delete this.sceneSyncs[rootId];
        this.viewport.clearMesh(rootId);
      },
    },

    'selection (§14.1 decision 4, §14.5, §14.6)', {
      // additive: false (plain click) replaces the selection with just
      // rootId; true (modifier-key click) adds it, capped at 2 — a third
      // additive click replaces the oldest of the two rather than being
      // silently ignored.
      selectInstance: function (rootId, additive) {
        if (!additive) {
          this._clearSelectionHighlights();
          this.selectedRootIds = [rootId];
        } else if (this.selectedRootIds.indexOf(rootId) === -1) {
          this.selectedRootIds.push(rootId);
          if (this.selectedRootIds.length > 2) {
            var dropped = this.selectedRootIds.shift();
            this.viewport.setSelected(dropped, false);
          }
        }
        this._applySelectionHighlights();
      },

      clearSelection: function () {
        this._clearSelectionHighlights();
        this.selectedRootIds = [];
      },

      _applySelectionHighlights: function () {
        var self = this;
        this.selectedRootIds.forEach(function (rootId) { self.viewport.setSelected(rootId, true); });
      },

      _clearSelectionHighlights: function () {
        var self = this;
        this.selectedRootIds.forEach(function (rootId) { self.viewport.setSelected(rootId, false); });
      },

      _deselect: function (rootId) {
        var idx = this.selectedRootIds.indexOf(rootId);
        if (idx === -1) return;
        this.viewport.setSelected(rootId, false);
        this.selectedRootIds.splice(idx, 1);
      },
    },

    'undo/redo (§6.2, §13 step 14, §14.5)', {
      // thenDo(err, didChange) — didChange is false when the respective
      // stack was empty (nothing to do, no resync fired).
      undo: function (thenDo) {
        if (!this.featureTree.undo()) { if (thenDo) thenDo(null, false); return false; }
        this._resync(thenDo);
        return true;
      },

      redo: function (thenDo) {
        if (!this.featureTree.redo()) { if (thenDo) thenDo(null, false); return false; }
        this._resync(thenDo);
        return true;
      },

      // Tears down every current SceneSync, then creates one fresh
      // SceneSync per entry in featureTree.roots and rebuilds each —
      // simplest-correct for v1 (file doc) since either undo or redo can
      // change which roots exist at all.
      _resync: function (thenDo) {
        var self = this;
        this._clearSelectionHighlights();
        Object.keys(this.sceneSyncs).forEach(function (rootId) { self.viewport.clearMesh(rootId); });
        this.sceneSyncs = {};
        this.selectedRootIds = [];

        var roots = this.featureTree.getRoots();
        if (roots.length === 0) {
          this.viewport._frameAllMeshes();
          if (thenDo) thenDo(null, true);
          return;
        }
        var remaining = roots.length;
        roots.forEach(function (rootId) {
          self.sceneSyncs[rootId] = new lively.jenga3d.SceneSync(self.featureTree, self.viewport, rootId, function () {
            remaining--;
            if (remaining === 0) {
              self.viewport._frameAllMeshes();
              if (thenDo) thenDo(null, true);
            }
          });
        });
      },
    });

  });
