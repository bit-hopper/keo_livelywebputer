/**
 * lively.jenga3d.tools.RotateTool
 *
 * CAD-viewer-style rotation-ring dragging for an already-placed instance
 * (Jenga3Dspec_v0.md §14.7 addendum, added during a live debug session
 * that found no rotation gesture existed anywhere in the app — only the
 * non-interactive corner orientation indicator). Reuses
 * `EditHandleTool.prototype._findWrappingTransform` the same way
 * `MoveTool` does, and mirrors `MoveTool`'s exact
 * `startDrag`/`updateDrag`/`endDrag` + single-commit-on-release shape.
 * Same v1 scope gap as `MoveTool` (`MoveTool.js` file doc): only
 * instances whose root IS a wrapping `transform` node directly over one
 * primitive can be rotated this way — a Complex (boolean/fillet) root has
 * no such single `transform` to mutate. `Viewport.showRotationGizmo`'s
 * caller is expected to only show rings for eligible instances in the
 * first place; `startDrag` still no-ops defensively if handed one anyway.
 *
 * **The pivot problem, and why this isn't just "write a new rotate
 * array":** `occt-worker-src.js`'s `applyTransform` rotates a primitive
 * about its own LOCAL ORIGIN (before `translate`), and that local origin
 * is not the primitive's visual center — a box's is one of its corners
 * (`CreateBoxTool._commit`'s own comment: "createBox always builds from
 * its own local origin outward"). Writing a new `rotate` while holding
 * `translate` fixed would make a placed box swing around a corner instead
 * of spinning in place. Fixed by computing a compensating `translate`
 * alongside every `rotate` update so the shape's own world-space bounding-
 * box center stays fixed — verified empirically against a live worker
 * `evaluate` call (not just derived on paper) that
 * `new THREE.Euler(rx, ry, rz, 'XYZ')` applied to a primitive's local
 * center-offset exactly reproduces OCCT's fixed sequential X-then-Y-then-Z
 * rotation composition (`rotateAboutAxis`, `occt-worker-src.js:249-258`).
 *
 * Ring axes are fixed WORLD axes (matching the corner indicator's own
 * red=X/green=Y/blue=Z convention), so composing a new drag with whatever
 * rotation the instance already has is done via quaternions (which compose
 * correctly regardless of order) rather than naively adding into one
 * `rotate[axis]` slot — the stored `rotate` triple is decoded to a
 * quaternion at drag start and re-encoded back to an XYZ-order Euler
 * triple on commit, both via THREE's own Euler/Quaternion conversion,
 * matching the OCCT composition confirmed above.
 */

module('lively.jenga3d.tools.RotateTool')
  .requires('lively.jenga3d.FeatureTree', 'lively.jenga3d.SceneSync', 'lively.jenga3d.Viewport',
    'lively.jenga3d.tools.EditHandleTool')
  .toRun(function () {

    Object.subclass('lively.jenga3d.tools.RotateTool',

    'initializing', {
      // sceneSync: the ONE instance being rotated — same per-instance-
      // SceneSync convention EditHandleTool/MoveTool use (§14.5).
      initialize: function (viewport, featureTree, sceneSync) {
        this.viewport = viewport;
        this.featureTree = featureTree;
        this.sceneSync = sceneSync;
        this._dragging = null;
      },
    },

    'primitive local-center offsets (pristine, pre-rotate OCCT construction frame)', {
      // Verified live against real worker `evaluate` output before being
      // hardcoded here (not assumed from a doc comment): createBox builds
      // corner-at-origin (width/height/depth outward); createSphere is
      // already center-origin (matching CreateSphereTool's own
      // translate.y = radius convention); createCylinder builds base-
      // circle-at-origin extending along local Z by `height` (confirmed:
      // a radius=3/height=8 cylinder's raw, untransformed mesh spans
      // Z:[0,8], X/Y:[-3,3]).
      _primitiveCenterLocal: function (primNode) {
        var p = primNode.params;
        if (primNode.op === 'createBox') return [p.width / 2, p.height / 2, p.depth / 2];
        if (primNode.op === 'createCylinder') return [0, 0, p.height / 2];
        if (primNode.op === 'createSphere') return [0, 0, 0];
        return [0, 0, 0]; // not reachable — RotateTool only ever targets a primitive-wrapping transform
      },
    },

    'drag lifecycle', {
      // axis: 'x'|'y'|'z' (the ring the pointerdown hit). pivot: the
      // gizmo's current world-space center (Viewport.getRotationGizmoCenter,
      // captured once at drag start so it doesn't drift if something else
      // re-renders mid-drag).
      startDrag: function (axis, pivot, clientX, clientY) {
        var rootId = this.sceneSync.rootId;
        var node = this.featureTree.getNode(rootId);
        var wrapping = (node && node.op === 'transform')
          ? lively.jenga3d.tools.EditHandleTool.prototype._findWrappingTransform.call(this, node.params.of)
          : null;
        if (!wrapping) { this._dragging = null; return; } // Complex root — v1 scope gap, see file doc
        var primNode = this.featureTree.getNode(node.params.of);
        var THREE = this.viewport._three.THREE;

        var qOld = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(wrapping.rotate[0], wrapping.rotate[1], wrapping.rotate[2], 'XYZ')
        );
        var centerLocal = new THREE.Vector3().fromArray(this._primitiveCenterLocal(primNode));
        var worldCenterFixed = centerLocal.clone().applyQuaternion(qOld)
          .add(new THREE.Vector3().fromArray(wrapping.translate));

        var axisVec = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[axis];
        var startAngle = this._angleOnPlane(pivot, axisVec, clientX, clientY);
        if (startAngle == null) { this._dragging = null; return; }

        this._dragging = {
          rootId: rootId, axis: axis, axisVec: axisVec, pivot: pivot.clone(),
          qOld: qOld, centerLocal: centerLocal, worldCenterFixed: worldCenterFixed,
          startAngle: startAngle, startScale: wrapping.scale.slice(),
        };
      },

      updateDrag: function (clientX, clientY) {
        var d = this._dragging;
        if (!d) return;
        var angle = this._angleOnPlane(d.pivot, d.axisVec, clientX, clientY);
        if (angle == null) return;
        var deltaAngle = angle - d.startAngle;
        var mesh = this.viewport.getMesh(d.rootId);
        if (!mesh) return;

        var THREE = this.viewport._three.THREE;
        var deltaQ = new THREE.Quaternion().setFromAxisAngle(d.axisVec, deltaAngle);
        // Rotate the already-baked (world-space) mesh geometry by deltaQ
        // around the external pivot d.pivot — zero IPC live preview, same
        // "nudge the mesh directly" technique MoveTool.updateDrag uses,
        // extended to include rotation: mesh.position/.quaternion overlay
        // the baked-in vertex data, reset to identity once the committed
        // mesh replaces it.
        var pivotRotated = d.pivot.clone().applyQuaternion(deltaQ);
        mesh.position.copy(d.pivot).sub(pivotRotated);
        mesh.quaternion.copy(deltaQ);
        this.viewport._render();
      },

      // §6.2's undo boundary: exactly one worker call, committing the
      // drag's final rotate+translate — via SceneSync.updateParam, same
      // "one commit at drag end" shape MoveTool.endDrag/EditHandleTool.
      // endDrag use.
      endDrag: function (clientX, clientY, thenDo) {
        var d = this._dragging;
        if (!d) return;
        this._dragging = null;
        var angle = this._angleOnPlane(d.pivot, d.axisVec, clientX, clientY);
        var deltaAngle = angle == null ? 0 : angle - d.startAngle;

        var THREE = this.viewport._three.THREE;
        var deltaQ = new THREE.Quaternion().setFromAxisAngle(d.axisVec, deltaAngle);
        var qNew = deltaQ.clone().multiply(d.qOld);
        var rotateNew = new THREE.Euler().setFromQuaternion(qNew, 'XYZ');
        var translateNew = d.worldCenterFixed.clone().sub(d.centerLocal.clone().applyQuaternion(qNew));

        var mesh = this.viewport.getMesh(d.rootId);
        if (mesh) { mesh.position.set(0, 0, 0); mesh.quaternion.identity(); } // clear the live-preview overlay before the real rebuild lands

        this.sceneSync.updateParam(d.rootId, {
          rotate: [rotateNew.x, rotateNew.y, rotateNew.z],
          translate: translateNew.toArray(),
        }, thenDo);
      },
    },

    'ring-plane angle measurement', {
      // Angle (radians) of the ray-vs-plane hit point around `pivot`,
      // measured in the plane perpendicular to `axisVec` through `pivot`
      // — the same "project screen point onto a plane, read an angle
      // around a center" idea CreateBoxTool's _screenToGroundPoint uses
      // for the ground plane, generalized to an arbitrary axis-aligned
      // plane through a moving pivot instead of always Y=0 through the
      // world origin. Returns null if the ray is (near-)parallel to the
      // plane.
      _angleOnPlane: function (pivot, axisVec, clientX, clientY) {
        var three = this.viewport._three;
        if (!three) return null;
        var THREE = three.THREE;
        var canvas = three.renderer.domElement;
        var rect = canvas.getBoundingClientRect();
        var ndc = new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1
        );
        var raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, three.camera);
        var plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axisVec, pivot);
        var hit = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(plane, hit)) return null;

        // Any two vectors orthogonal to axisVec (and to each other) work
        // as the plane's basis — only consistency between calls matters,
        // not a particular orientation.
        var u = new THREE.Vector3(0, 1, 0);
        if (Math.abs(u.dot(axisVec)) > 0.99) u.set(1, 0, 0);
        u.crossVectors(axisVec, u).normalize();
        var v = new THREE.Vector3().crossVectors(axisVec, u).normalize();

        var offset = hit.clone().sub(pivot);
        return Math.atan2(offset.dot(v), offset.dot(u));
      },
    });

  });
