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
 *
 * §14.2/§14.5: nodeIdA/nodeIdB are now two *instances* (roots), not "the"
 * tree's single root — combine() does the roots bookkeeping (§14.2's
 * removeRoot x2 + addRoot) and no longer talks to a worker itself: under
 * the multi-instance model each instance owns its own `SceneSync`
 * (§14.5), so `Assembly.combineSelected` is what tears down the two
 * superseded SceneSyncs and constructs a fresh one for the combined
 * result (whose own constructor does the actual rebuild). This makes
 * combine() a synchronous, tree-only mutation — a narrower role than the
 * original single-root version, which owned a shared sceneSync and
 * rebuilt through it directly.
 */

module('lively.jenga3d.tools.CombineTool')
  .requires('lively.jenga3d.FeatureTree')
  .toRun(function () {

    var BOOLEAN_OPS = ['booleanUnion', 'booleanCut', 'booleanIntersect'];

    Object.subclass('lively.jenga3d.tools.CombineTool',

    'initializing', {
      initialize: function (featureTree) {
        this.featureTree = featureTree;
      },
    },

    'combining', {
      // op: 'booleanUnion' | 'booleanCut' | 'booleanIntersect' (§7.2).
      // nodeIdA/nodeIdB: two existing instances (roots) to combine —
      // booleanCut is `a minus b`, so order matters for that op
      // specifically. Returns the new node's id, already the tree's
      // newest root in place of A and B.
      combine: function (op, nodeIdA, nodeIdB) {
        if (BOOLEAN_OPS.indexOf(op) === -1) {
          throw new Error('lively.jenga3d.tools.CombineTool: unknown boolean op: ' + op);
        }
        if (!this.featureTree.getNode(nodeIdA) || !this.featureTree.getNode(nodeIdB)) {
          throw new Error('lively.jenga3d.tools.CombineTool: unknown operand nodeId');
        }
        this.featureTree.checkpoint(); // §6.2/§13 step 14
        var newId = this.featureTree.addNode(op, { a: nodeIdA, b: nodeIdB });
        this.featureTree.removeRoot(nodeIdA);
        this.featureTree.removeRoot(nodeIdB);
        this.featureTree.addRoot(newId);
        return newId;
      },
    });

  });
