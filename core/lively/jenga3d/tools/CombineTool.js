/**
 * lively.jenga3d.tools.CombineTool
 *
 * "Minimal UI to combine two solids" (Jenga3Dspec_v0.md §13 step 9) —
 * one method wrapping two existing top-level nodes in a new boolean node
 * and rebuilding. No toolbar/menu chrome exists anywhere in the app yet
 * (that's part of world/PartsBin integration, §13 step 13) — consistent
 * with `CreateBoxTool`/`EditHandleTool` (§13 steps 6-7), which are also
 * driven directly rather than through polished UI at this stage, "minimal
 * UI" here means the single programmatic entry point a real combine
 * button would call, not a rendered button itself.
 */

module('lively.jenga3d.tools.CombineTool')
  .requires('lively.jenga3d.FeatureTree', 'lively.jenga3d.SceneSync')
  .toRun(function () {

    var BOOLEAN_OPS = ['booleanUnion', 'booleanCut', 'booleanIntersect'];

    Object.subclass('lively.jenga3d.tools.CombineTool',

    'initializing', {
      initialize: function (featureTree, sceneSync) {
        this.featureTree = featureTree;
        this.sceneSync = sceneSync;
      },
    },

    'combining', {
      // op: 'booleanUnion' | 'booleanCut' | 'booleanIntersect' (§7.2).
      // nodeIdA/nodeIdB: two existing nodes (typically each solid's
      // current root) to combine — booleanCut is `a minus b`, so order
      // matters for that op specifically. Returns the new node's id.
      combine: function (op, nodeIdA, nodeIdB, thenDo) {
        if (BOOLEAN_OPS.indexOf(op) === -1) {
          throw new Error('lively.jenga3d.tools.CombineTool: unknown boolean op: ' + op);
        }
        if (!this.featureTree.getNode(nodeIdA) || !this.featureTree.getNode(nodeIdB)) {
          throw new Error('lively.jenga3d.tools.CombineTool: unknown operand nodeId');
        }
        var newId = this.featureTree.addNode(op, { a: nodeIdA, b: nodeIdB });
        this.featureTree.setRoot(newId);
        this.sceneSync.rebuild(newId, thenDo);
        return newId;
      },
    });

  });
