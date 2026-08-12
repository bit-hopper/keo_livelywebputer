/**
 * lively.jenga3d.tools.EditHandleTool
 *
 * Drag-handle editing of an existing solid's already-committed param
 * (Jenga3Dspec_v0.md §13 step 7) — §5.2's Primitive Proxy Mode and §5.3's
 * Complex Throttled Worker Mode, as a reusable drag *state machine*
 * (`startDrag`/`updateDrag`/`endDrag`) rather than mouse-event handling
 * tied to a specific handle. Real handles need face/edge picking to know
 * which node+param a drag on the rendered surface even targets, and
 * picking is §13 step 8 — not built yet. This step is the mechanics
 * (proxy-vs-worker branching, throttling, staleness/queue plumbing)
 * verified by calling the state machine directly; step 8 wires real
 * pointer events on real handles into `startDrag`/`updateDrag`/`endDrag`.
 *
 * §5.1 classification decides the branch: `featureTree.isPrimitiveEditable`
 * on the dragged node.
 *
 * §5.2 Primitive: `updateDrag` mutates a THREE proxy mesh directly, zero
 * worker calls; `endDrag` sends the final value through
 * `SceneSync.updateParam` exactly once (worker rebuild, mesh swap, param
 * committed to the tree — the point §6.2 marks as the undo boundary).
 * Proxy support is v1-scoped to `createBox` nodes wrapped by at most one
 * axis-aligned (`rotate: [0,0,0]`) transform — the only shape a rotation
 * -free chain like `CreateBoxTool` actually produces. A rotated ancestor
 * would misalign world-axis scaling with the box's own local width/
 * height/depth axes; handling that generally needs the real geometry
 * (still just a box, but oriented) rather than a raw `THREE.BoxGeometry`
 * scale hack, and isn't needed until picking (§13 step 8) can actually
 * hand this tool a rotated target to drag.
 *
 * §5.3 Complex: `updateDrag` throttles to one `SceneSync.rebuild` call per
 * ~30ms via a self-rescheduling `requestAnimationFrame` loop while the
 * drag is active (stops rescheduling once `endDrag` clears `_dragging`);
 * `lively.jenga3d.Worker`'s own queue-depth-of-1 handles the case where
 * even that throttle outpaces the worker. `endDrag` still sends one more
 * request unconditionally, guaranteeing the committed state matches the
 * final pointer position even though the throttled stream alone doesn't
 * (§5.3: "the last move event may have been dropped by the throttle").
 */

module('lively.jenga3d.tools.EditHandleTool')
  .requires('lively.jenga3d.FeatureTree', 'lively.jenga3d.SceneSync', 'lively.jenga3d.Viewport')
  .toRun(function () {

    var THROTTLE_MS = 30;

    Object.subclass('lively.jenga3d.tools.EditHandleTool',

    'initializing', {
      initialize: function (viewport, featureTree, sceneSync) {
        this.viewport = viewport;
        this.featureTree = featureTree;
        this.sceneSync = sceneSync || new lively.jenga3d.SceneSync(featureTree, viewport);
        this._dragging = null;
      },
    },

    'drag lifecycle', {
      // nodeId: the primitive node whose param is being dragged (§5.1 —
      // even a handle on a Complex node's composite surface still
      // targets one specific ancestor primitive's param).
      //
      // Complex-vs-Primitive branching is decided by the TREE'S ROOT, not
      // by `nodeId` itself — a bare createBox/etc. node is *always*
      // individually Primitive by definition (§5.1: classification walks
      // a node's own operand chain), even when it's an operand deep
      // inside a boolean elsewhere in the tree. What decides whether a
      // proxy mesh can approximate the drag is whether the *displayed*
      // shape (the root) is Primitive or Complex — found only once a
      // real Complex node existed to drag against (§13 step 9); every
      // step 7 test happened to use a tree where the dragged node and
      // the root were classified the same way, which is why this didn't
      // surface until real booleans made it observable.
      startDrag: function (nodeId, paramField, initialValue) {
        var isComplex = !this.featureTree.isPrimitiveEditable(this.featureTree.root);
        this._dragging = {
          nodeId: nodeId, paramField: paramField,
          isComplex: isComplex, lastSendTime: 0, pendingValue: null,
        };
        if (!isComplex) this._createProxy(nodeId);
      },

      updateDrag: function (value) {
        var d = this._dragging;
        if (!d) return;
        if (d.isComplex) this._throttledComplexUpdate(value);
        else this._updateProxy(value);
      },

      // §5.2/§5.3: exactly one more commit, guaranteed to reflect the
      // final value regardless of what the throttle did or didn't send.
      endDrag: function (finalValue, thenDo) {
        var d = this._dragging;
        if (!d) return;
        this._dragging = null;
        if (!d.isComplex) this._clearProxy();
        var params = {};
        params[d.paramField] = finalValue;
        this.sceneSync.updateParam(d.nodeId, params, thenDo);
      },
    },

    'complex throttling (§5.3)', {
      _throttledComplexUpdate: function (value) {
        var d = this._dragging;
        d.pendingValue = value;
        if (!d.rafRunning) {
          d.rafRunning = true;
          this._rafTick();
        }
      },

      _rafTick: function () {
        var d = this._dragging;
        if (!d || !d.isComplex) return; // drag ended (or was never complex) — stop rescheduling
        var now = Date.now();
        if (d.pendingValue !== null && (now - d.lastSendTime) >= THROTTLE_MS) {
          d.lastSendTime = now;
          var value = d.pendingValue;
          d.pendingValue = null;
          var params = {};
          params[d.paramField] = value;
          this.featureTree.updateParams(d.nodeId, params);
          this.sceneSync.rebuild(d.nodeId);
        }
        requestAnimationFrame(this._rafTick.bind(this));
      },
    },

    'primitive proxy (§5.2, box-only + axis-aligned, see file doc)', {
      _createProxy: function (nodeId) {
        var node = this.featureTree.getNode(nodeId);
        var xf = this._findWrappingTransform(nodeId);
        this._proxySupported = node.op === 'createBox' && (!xf || !(xf.rotate[0] || xf.rotate[1] || xf.rotate[2]));
        if (!this._proxySupported) return; // out of v1 scope — updateDrag/endDrag still work, just no live preview

        var THREE = this.viewport._three.THREE;
        var geometry = new THREE.BoxGeometry(1, 1, 1);
        var material = new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.5 });
        this._proxyMesh = new THREE.Mesh(geometry, material);
        this._proxyBase = node.params;
        this._proxyTranslate = xf ? xf.translate : [0, 0, 0];
        this._proxyScale = xf ? xf.scale : [1, 1, 1];
        this.viewport._three.scene.add(this._proxyMesh);
        if (this.viewport._mesh) this.viewport._mesh.visible = false;
        this._applyProxyGeometry(this._dragging.paramField, node.params[this._dragging.paramField]);
      },

      _updateProxy: function (value) {
        if (!this._proxySupported) return;
        this._applyProxyGeometry(this._dragging.paramField, value);
        this.viewport._render();
      },

      _applyProxyGeometry: function (paramField, value) {
        var dims = {
          width:  this._proxyBase.width,
          height: this._proxyBase.height,
          depth:  this._proxyBase.depth,
        };
        dims[paramField] = value;
        var s = this._proxyScale;
        this._proxyMesh.scale.set(dims.width * s[0], dims.height * s[1], dims.depth * s[2]);
        // createBox extrudes from its own local origin (§7.2/OCCT
        // convention), so the box's footprint corner sits at the
        // wrapping transform's translate — center it the same way
        // CreateBoxTool positions its own drag-create proxy.
        var t = this._proxyTranslate;
        this._proxyMesh.position.set(
          t[0] + dims.width * s[0] / 2,
          t[1] + dims.height * s[1] / 2,
          t[2] + dims.depth * s[2] / 2
        );
      },

      _clearProxy: function () {
        if (this._proxyMesh) {
          this.viewport._three.scene.remove(this._proxyMesh);
          this._proxyMesh.geometry.dispose();
          this._proxyMesh.material.dispose();
          this._proxyMesh = null;
        }
        if (this.viewport._mesh) this.viewport._mesh.visible = true;
        this._proxySupported = false;
      },

      // Simple upward walk, not a general DAG search — correct for a
      // pure primitive/transform chain (single-operand nodes only, which
      // is exactly what §5.1 classifies as Primitive in the first place).
      _findWrappingTransform: function (nodeId) {
        var nodes = this.featureTree.nodes;
        for (var id in nodes) {
          var n = nodes[id];
          if (n.op === 'transform' && n.params.of === nodeId) return n.params;
        }
        return null;
      },
    });

  });
