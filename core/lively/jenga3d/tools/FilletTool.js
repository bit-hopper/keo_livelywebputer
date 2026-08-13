/**
 * lively.jenga3d.tools.FilletTool
 *
 * "Minimal UI" (matching `CombineTool`'s framing, §13 step 9) to apply a
 * fillet or chamfer to one or more edges of a chosen instance, given edge
 * indices already resolved via `Viewport.pickEdgeAt` (§13 step 10, §7.3).
 * One method wrapping the selected edges into a new fillet/chamfer node
 * and replacing that instance's root in place — no toolbar exists yet to
 * hang a real edge-selection mode/button on.
 *
 * §14.2/§14.5: `ofId` (which instance is being filleted/chamfered) is now
 * an explicit argument rather than implicitly "the tree's one root" — a
 * multi-instance tree has no such thing. Like `CombineTool` (see its own
 * file doc), `apply()` is now a synchronous, tree-only mutation (checkpoint
 * + addNode + replaceRoot); `Assembly.filletSelected` owns constructing
 * the replacement instance's `SceneSync`, whose own constructor performs
 * the actual rebuild.
 */

module('lively.jenga3d.tools.FilletTool')
  .requires('lively.jenga3d.FeatureTree')
  .toRun(function () {

    Object.subclass('lively.jenga3d.tools.FilletTool',

    'initializing', {
      initialize: function (featureTree) {
        this.featureTree = featureTree;
      },
    },

    'applying', {
      // op: 'fillet' | 'chamfer'. ofId: the instance (root) being
      // filleted/chamfered. edgeIndices: occtEdgeIndex values (as
      // returned by Viewport.pickEdgeAt) on that instance — §7.3's
      // selector shape ({operandNodeId, kind, index}) is built here.
      // amount: radius (fillet) or distance (chamfer). Returns the new
      // node's id, already spliced into `roots` in ofId's place.
      apply: function (op, ofId, edgeIndices, amount) {
        if (op !== 'fillet' && op !== 'chamfer') {
          throw new Error('lively.jenga3d.tools.FilletTool: unknown op: ' + op);
        }
        var selectors = edgeIndices.map(function (index) {
          return { operandNodeId: ofId, kind: 'edge', index: index };
        });
        var params = { of: ofId, edges: selectors };
        params[op === 'fillet' ? 'radius' : 'distance'] = amount;

        this.featureTree.checkpoint(); // §6.2/§13 step 14
        var newId = this.featureTree.addNode(op, params);
        this.featureTree.replaceRoot(ofId, newId);
        return newId;
      },
    });

  });
