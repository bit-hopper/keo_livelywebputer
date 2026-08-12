/**
 * lively.jenga3d.tools.FilletTool
 *
 * "Minimal UI" (matching `CombineTool`'s framing, §13 step 9) to apply a
 * fillet or chamfer to one or more edges of the tree's current root,
 * given edge indices already resolved via `Viewport.pickEdgeAt` (§13
 * step 10, §7.3). One method wrapping the selected edges into a new
 * fillet/chamfer node and rebuilding — no toolbar exists yet to hang a
 * real edge-selection mode/button on.
 */

module('lively.jenga3d.tools.FilletTool')
  .requires('lively.jenga3d.FeatureTree', 'lively.jenga3d.SceneSync')
  .toRun(function () {

    Object.subclass('lively.jenga3d.tools.FilletTool',

    'initializing', {
      initialize: function (featureTree, sceneSync) {
        this.featureTree = featureTree;
        this.sceneSync = sceneSync;
      },
    },

    'applying', {
      // op: 'fillet' | 'chamfer'. edgeIndices: occtEdgeIndex values (as
      // returned by Viewport.pickEdgeAt) on the tree's CURRENT root —
      // §7.3's selector shape ({operandNodeId, kind, index}) is built
      // here, operandNodeId always being the root being filleted/
      // chamfered. amount: radius (fillet) or distance (chamfer).
      apply: function (op, edgeIndices, amount, thenDo) {
        if (op !== 'fillet' && op !== 'chamfer') {
          throw new Error('lively.jenga3d.tools.FilletTool: unknown op: ' + op);
        }
        var ofId = this.featureTree.root;
        var selectors = edgeIndices.map(function (index) {
          return { operandNodeId: ofId, kind: 'edge', index: index };
        });
        var params = { of: ofId, edges: selectors };
        params[op === 'fillet' ? 'radius' : 'distance'] = amount;

        this.featureTree.checkpoint(); // §6.2/§13 step 14
        var newId = this.featureTree.addNode(op, params);
        this.featureTree.setRoot(newId);
        this.sceneSync.rebuild(newId, thenDo);
        return newId;
      },
    });

  });
