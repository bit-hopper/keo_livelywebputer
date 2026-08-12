/**
 * lively.jenga3d.FeatureTree
 *
 * Client-side model for a CAD solid's feature tree (Jenga3Dspec_v0.md §7.1
 * "Application State", §13 step 3). Plain JSON underneath — `{ root,
 * nodes }`, the exact envelope §7.2 pins for the worker protocol (§4.5),
 * so `toJSON()`'s output can be handed straight to
 * `lively.jenga3d.Worker.request`'s `params.featureTree` with no
 * translation step, and is exactly what gets persisted through the
 * identity system (§8) and snapshotted for undo/redo (§6.2).
 *
 * No rendering, no worker calls — this step is the data structure only.
 */

module('lively.jenga3d.FeatureTree')
  .requires()
  .toRun(function () {

    var PRIMITIVE_OPS = ['createBox', 'createCylinder', 'createSphere'];

    Object.subclass('lively.jenga3d.FeatureTree',

    'settings', {
      // §13 step 13: a cache, not real data — excluded so a deserialized
      // tree always recomputes fresh rather than trusting a serialized
      // snapshot of it. See onrestore below for why this alone isn't
      // enough (initialize doesn't run again on restore).
      // §13 step 14: the undo/redo stacks are session-only editing
      // history, not part of either Two Truths row (§7.1's table has no
      // "undo history" row) — excluded from persistence the same way, so
      // a reload/restore always starts with empty history rather than
      // resurrecting stale snapshots from a previous session.
      doNotSerialize: ['_classification', '_undoStack', '_redoStack'],
    },

    'initializing', {
      // json: optional { root, nodes } to restore from (undo/redo, load
      // from an envelope's payload, §6.2/§8). Omit for a fresh empty tree.
      initialize: function (json) {
        this.root = json ? json.root : null;
        this.nodes = json ? json.nodes : {};
        this._classification = {}; // nodeId -> isPrimitiveEditable, cached per §5.1
        this._undoStack = []; // §6.2: stack of prior toJSON() snapshots
        this._redoStack = [];
      },
    },

    'serialization', {
      // Without this, a restored tree would have no _classification
      // property at all (doNotSerialize excludes it, and initialize
      // doesn't run again on restore) — isPrimitiveEditable's `nodeId in
      // this._classification` check would throw on `undefined` rather
      // than just miss the cache. Same reasoning extends _undoStack/
      // _redoStack to plain arrays rather than leaving them undefined.
      onrestore: function () {
        this._classification = {};
        this._undoStack = [];
        this._redoStack = [];
      },
    },

    'nodes', {
      // Returns the new node's id. Does not touch `root` — callers set
      // that explicitly via setRoot once they know which node is the
      // tree's current output (e.g. after wrapping a primitive in a
      // transform), rather than this guessing at tree shape.
      addNode: function (op, params) {
        var nodeId = Strings.newUUID();
        this.nodes[nodeId] = { op: op, params: params };
        this._invalidateClassification();
        return nodeId;
      },

      removeNode: function (nodeId) {
        if (nodeId === this.root) {
          throw new Error('lively.jenga3d.FeatureTree: cannot remove the root node — call setRoot to point elsewhere first');
        }
        delete this.nodes[nodeId];
        this._invalidateClassification();
      },

      getNode: function (nodeId) {
        return this.nodes[nodeId];
      },

      setRoot: function (nodeId) {
        if (!this.nodes[nodeId]) throw new Error('lively.jenga3d.FeatureTree: unknown nodeId: ' + nodeId);
        this.root = nodeId;
      },

      // Param-only edits (e.g. every throttled frame of a drag, §5.2/§5.3)
      // never change tree structure, so this deliberately does NOT
      // invalidate isPrimitiveEditable classification — §5.1 requires it
      // stay cached across drag frames, recomputed only on structural
      // change (addNode/removeNode/reparenting via updateParams changing
      // an operand reference — see updateOperand).
      updateParams: function (nodeId, params) {
        var node = this.nodes[nodeId];
        if (!node) throw new Error('lively.jenga3d.FeatureTree: unknown nodeId: ' + nodeId);
        Object.assign(node.params, params);
      },

      // Unlike updateParams, changing which node an operand field points
      // at (reparenting) IS a structural change and must invalidate
      // classification.
      updateOperand: function (nodeId, operandField, newOperandNodeId) {
        var node = this.nodes[nodeId];
        if (!node) throw new Error('lively.jenga3d.FeatureTree: unknown nodeId: ' + nodeId);
        node.params[operandField] = newOperandNodeId;
        this._invalidateClassification();
      },
    },

    'classification', { // §5.1 — Primitive vs. Complex

      isPrimitiveEditable: function (nodeId) {
        if (!(nodeId in this._classification)) this._recomputeClassification();
        return this._classification[nodeId];
      },

      _invalidateClassification: function () {
        this._classification = {};
      },

      _recomputeClassification: function () {
        this._classification = {};
        var self = this;
        Object.keys(this.nodes).forEach(function (nodeId) {
          self._classifyNode(nodeId, {});
        });
      },

      // Bottom-up: a node is Primitive iff its own op is create-primitive,
      // or it's a transform whose operand is Primitive. Any boolean or
      // fillet/chamfer node is Complex by definition — and because
      // anything built on top of a Complex node necessarily has a Complex
      // operand, that complexity propagates forward with no separate
      // downstream walk needed (§5.1: "Any boolean or fillet/chamfer
      // node, or anything built on top of one, is Complex").
      _classifyNode: function (nodeId, visiting) {
        if (nodeId in this._classification) return this._classification[nodeId];
        if (visiting[nodeId]) throw new Error('lively.jenga3d.FeatureTree: cycle detected at ' + nodeId);
        visiting[nodeId] = true;

        var node = this.nodes[nodeId];
        if (!node) throw new Error('lively.jenga3d.FeatureTree: unknown nodeId: ' + nodeId);

        var result;
        if (PRIMITIVE_OPS.indexOf(node.op) !== -1) {
          result = true;
        } else if (node.op === 'transform') {
          result = this._classifyNode(node.params.of, visiting);
        } else {
          result = false; // booleanUnion/Cut/Intersect, fillet, chamfer, or unknown
        }

        delete visiting[nodeId];
        this._classification[nodeId] = result;
        return result;
      },
    },

    'persistence', { // §6.2, §6.3, §8 — plain JSON, no OCCT/render state
      toJSON: function () {
        return { root: this.root, nodes: JSON.parse(JSON.stringify(this.nodes)) };
      },
    },

    'undo/redo (§6.2)', {
      // Captures the tree's current state as a point a caller can later
      // undo back to. Deliberately NOT called from addNode/updateParams/
      // etc. themselves — those also run during throttled complex-drag
      // preview frames (§5.3), which are explicitly not undo points (only
      // the drag's final commit is, per §5.2's own wording: "FeatureTree
      // node's params are committed — this is the point an undo entry is
      // created"). Callers that represent one completed, user-visible
      // commit (SceneSync.updateParam; CreateBoxTool/CombineTool/
      // FilletTool's own commit methods) call this themselves, right
      // before mutating.
      checkpoint: function () {
        this._undoStack.push(this.toJSON());
        this._redoStack = []; // a new commit invalidates whatever redo history existed
      },

      canUndo: function () { return this._undoStack.length > 0; },
      canRedo: function () { return this._redoStack.length > 0; },

      // Returns true if a step was actually undone/redone (false if the
      // respective stack was empty). Callers that also drive a worker
      // rebuild (e.g. lively.jenga3d.SceneSync) check this return value
      // to decide whether a rebuild is even needed.
      undo: function () {
        if (!this.canUndo()) return false;
        this._redoStack.push(this.toJSON());
        this._restore(this._undoStack.pop());
        return true;
      },

      redo: function () {
        if (!this.canRedo()) return false;
        this._undoStack.push(this.toJSON());
        this._restore(this._redoStack.pop());
        return true;
      },

      _restore: function (json) {
        this.root = json.root;
        this.nodes = json.nodes;
        this._invalidateClassification();
      },
    });

    lively.jenga3d.FeatureTree.fromJSON = function (json) {
      return new lively.jenga3d.FeatureTree(json);
    };

  });
