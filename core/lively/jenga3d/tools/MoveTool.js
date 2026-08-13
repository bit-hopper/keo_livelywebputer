/**
 * lively.jenga3d.tools.MoveTool
 *
 * Dragging an already-placed instance's whole body (object-select mode,
 * not a resize handle) to a new position (Jenga3Dspec_v0.md §14.7, §13
 * step 18) — translates the instance's own wrapping `transform` node's
 * `translate` as a whole, from a ground-plane drag delta (same raycasting
 * `CreateBoxTool`/`_screenToGroundPoint` uses), rather than one scalar
 * param field the way `EditHandleTool`'s resize handles do.
 *
 * Reuses `lively.jenga3d.tools.EditHandleTool.prototype._findWrappingTransform`
 * unchanged (by prototype borrowing — that helper only reads
 * `this.featureTree.nodes`, so it works identically called from this
 * class) to locate the transform node to mutate.
 *
 * **A genuine simplification over EditHandleTool's own Primitive-proxy-
 * vs-Complex-throttled split, found while building this**: EditHandleTool
 * needs that split because a resize handle changes *geometry* — a
 * Complex (boolean/fillet) shape's exact new form can only come from a
 * real OCCT re-evaluation, so a Complex resize can't be cheaply previewed
 * without the worker. Moving is different: it's a rigid translation, so
 * the shape itself never changes, only its placement — the already-
 * rendered `THREE.Mesh` can be nudged directly via `.position` for a
 * live, zero-IPC preview regardless of whether the instance is Primitive
 * or Complex, with exactly one worker call on `endDrag` to commit the
 * final `translate` and get a mesh whose baked-in vertex positions match
 * it exactly (matching `positions`, the world-space form the worker
 * always returns — a small object-space offset during the drag, reset to
 * zero once the committed mesh replaces it).
 *
 * **v1 scope gap (named, not solved — matching this project's own
 * convention, §12)**: only instances whose root IS a wrapping `transform`
 * node directly over one primitive can be moved this way — every
 * instance `CreateBoxTool`/`CreateCylinderTool`/`CreateSphereTool` ever
 * produces has exactly this shape. A Complex (boolean/fillet) root has no
 * such single wrapping transform — no existing tool ever creates one
 * around a combined result — so there is no one `translate` field that
 * represents "the whole combined body's position" yet. `startDrag` no-ops
 * for those (mirroring `EditHandleTool`'s own `_proxySupported = false`
 * graceful-degradation pattern) rather than moving one ancestor
 * primitive's transform and silently distorting the union. Revisit by
 * having `startDrag` insert a fresh identity wrapping transform around a
 * Complex root (`replaceRoot`) the first time it's moved, if this proves
 * to matter in practice.
 */

module('lively.jenga3d.tools.MoveTool')
  .requires('lively.jenga3d.FeatureTree', 'lively.jenga3d.SceneSync', 'lively.jenga3d.Viewport',
    'lively.jenga3d.tools.EditHandleTool')
  .toRun(function () {

    Object.subclass('lively.jenga3d.tools.MoveTool',

    'initializing', {
      // sceneSync: the ONE instance being moved — same per-instance-
      // SceneSync convention EditHandleTool uses (§14.5).
      initialize: function (viewport, featureTree, sceneSync) {
        this.viewport = viewport;
        this.featureTree = featureTree;
        this.sceneSync = sceneSync;
        this._dragging = null;
      },
    },

    'drag lifecycle', {
      // groundPoint: a ground-plane hit point (CreateBoxTool's own
      // _screenToGroundPoint shape) where the drag started.
      startDrag: function (groundPoint) {
        var rootId = this.sceneSync.rootId;
        var node = this.featureTree.getNode(rootId);
        // Reused unchanged (file doc) — locates the wrapping transform
        // over rootId's own underlying primitive. For every instance this
        // tool can actually move, rootId IS already that transform node,
        // so params.of resolves straight back to it.
        var wrapping = (node && node.op === 'transform')
          ? lively.jenga3d.tools.EditHandleTool.prototype._findWrappingTransform.call(this, node.params.of)
          : null;
        if (!wrapping) { this._dragging = null; return; } // Complex root — v1 scope gap, see file doc
        this._dragging = { startPoint: groundPoint, startTranslate: wrapping.translate.slice() };
      },

      updateDrag: function (groundPoint) {
        var d = this._dragging;
        if (!d) return;
        var mesh = this.viewport.getMesh(this.sceneSync.rootId);
        if (!mesh) return;
        var dx = groundPoint.x - d.startPoint.x;
        var dz = groundPoint.z - d.startPoint.z;
        // Zero-IPC rigid-motion preview (file doc) — the worker's mesh
        // positions are already baked into world space at startTranslate,
        // so only the INCREMENTAL delta belongs on the THREE object's own
        // .position, not the absolute translate.
        mesh.position.set(dx, 0, dz);
        this.viewport._render();
      },

      // §6.2/§5.2's undo boundary: exactly one worker call, committing
      // the drag's final translate — via SceneSync.updateParam, same
      // "one commit at drag end" shape EditHandleTool.endDrag uses.
      endDrag: function (groundPoint, thenDo) {
        var d = this._dragging;
        if (!d) return;
        this._dragging = null;
        var dx = groundPoint.x - d.startPoint.x;
        var dz = groundPoint.z - d.startPoint.z;
        var finalTranslate = [d.startTranslate[0] + dx, d.startTranslate[1], d.startTranslate[2] + dz];
        var rootId = this.sceneSync.rootId;
        this.sceneSync.updateParam(rootId, { translate: finalTranslate }, thenDo);
      },
    });

  });
