/**
 * lively.jenga3d.tools.CreateBoxTool
 *
 * Drag-to-create tool for a Viewport (Jenga3Dspec_v0.md §13 step 6). Proxy
 * Mode only (§5.2) — every shape created this way starts Primitive, since
 * it's just a `createBox` node wrapped in a `transform`, nothing boolean
 * or fillet/chamfer touches it.
 *
 * No existing base class to extend here (§2: `core/lively/morphic/tools/`
 * only has menu-bar/dialog tools, not canvas creation tools) — this is a
 * new pattern, listening directly on the Viewport's THREE canvas element
 * with native `pointerdown`/`pointermove`/`pointerup`, not Lively's
 * morphic event system. `pointermove`/`pointerup` listen on `window`
 * rather than the canvas so a drag started inside the canvas keeps
 * tracking even if the pointer leaves it mid-drag, a standard pattern for
 * canvas-based drag tools.
 *
 * Interaction model (pinned here, not specified elsewhere in the spec):
 * drag on the Y=0 ground plane sets the box's XZ footprint (from drag
 * start to drag end, footprint centered under the two points); height is
 * a fixed default (§7's params are all still editable later — Complex
 * drag-handle editing is §13 step 7, not this step). During the drag, a
 * `THREE.BoxGeometry` proxy mesh is scaled/repositioned directly every
 * `pointermove` with zero worker calls (§5.2: "60fps, zero IPC"); on
 * `pointerup`, the proxy is discarded and the real feature-tree node is
 * committed through `SceneSync`, which is what actually calls the worker
 * and swaps in the real OCCT-built mesh.
 */

module('lively.jenga3d.tools.CreateBoxTool')
  .requires('lively.jenga3d.FeatureTree', 'lively.jenga3d.SceneSync', 'lively.jenga3d.Viewport')
  .toRun(function () {

    Object.subclass('lively.jenga3d.tools.CreateBoxTool',

    'settings', {
      DEFAULT_HEIGHT: 10, // mm (§9.1: 1 unit = 1mm)
      MIN_DRAG: 1,        // mm — drags shorter than this in either axis are discarded, not committed
    },

    'initializing', {
      // featureTree/sceneSync are optional — omit them to have the tool
      // manage its own fresh tree for this viewport (the common case
      // before SolidMorph exists to own one, §13 step 13).
      initialize: function (viewport, featureTree, sceneSync) {
        this.viewport = viewport;
        this.featureTree = featureTree || new lively.jenga3d.FeatureTree();
        this.sceneSync = sceneSync || new lively.jenga3d.SceneSync(this.featureTree, this.viewport);
        this._dragProxy = null;
        this._dragStartPoint = null;
        this._dragActive = false;
        this._attached = false;
        this._attachWhenReady();
      },
    },

    'attaching', {
      _attachWhenReady: function () {
        if (this.viewport._three) { this._attach(); return; }
        // Viewport's three.js setup runs lazily on whenOpenedInWorld
        // (Viewport.js) — poll briefly rather than duplicating that
        // readiness logic here.
        var self = this;
        var poll = setInterval(function () {
          if (self.viewport._three) { clearInterval(poll); self._attach(); }
        }, 80);
      },

      _attach: function () {
        if (this._attached) return;
        this._attached = true;
        var self = this;
        this._onPointerDown = function (evt) { self._handlePointerDown(evt); };
        this._onPointerMove = function (evt) { self._handlePointerMove(evt); };
        this._onPointerUp = function (evt) { self._handlePointerUp(evt); };
        this.viewport._three.renderer.domElement.addEventListener('pointerdown', this._onPointerDown);
        window.addEventListener('pointermove', this._onPointerMove);
        window.addEventListener('pointerup', this._onPointerUp);
      },

      detach: function () {
        if (!this._attached) return;
        this.viewport._three.renderer.domElement.removeEventListener('pointerdown', this._onPointerDown);
        window.removeEventListener('pointermove', this._onPointerMove);
        window.removeEventListener('pointerup', this._onPointerUp);
        this._attached = false;
      },
    },

    'interaction', {
      _handlePointerDown: function (evt) {
        var point = this._screenToGroundPoint(evt.clientX, evt.clientY);
        if (!point) return;
        evt.preventDefault();
        evt.stopPropagation(); // don't let morphic's own event dispatch also react to this gesture
        this._dragStartPoint = point;
        this._dragActive = true;
      },

      _handlePointerMove: function (evt) {
        if (!this._dragActive) return;
        var point = this._screenToGroundPoint(evt.clientX, evt.clientY);
        if (!point) return;
        this._updateProxy(this._dragStartPoint, point);
      },

      _handlePointerUp: function (evt) {
        if (!this._dragActive) return;
        this._dragActive = false;
        var start = this._dragStartPoint;
        this._dragStartPoint = null;
        this._clearProxy();
        var point = this._screenToGroundPoint(evt.clientX, evt.clientY);
        if (point) this._commit(start, point);
      },
    },

    'proxy mesh (§5.2, zero IPC)', {
      _updateProxy: function (start, end) {
        var THREE = this.viewport._three.THREE;
        var width = Math.max(0.001, Math.abs(end.x - start.x));
        var depth = Math.max(0.001, Math.abs(end.z - start.z));
        var cx = (start.x + end.x) / 2, cz = (start.z + end.z) / 2;

        if (!this._dragProxy) {
          var geometry = new THREE.BoxGeometry(1, 1, 1);
          var material = new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.5 });
          this._dragProxy = new THREE.Mesh(geometry, material);
          this.viewport._three.scene.add(this._dragProxy);
        }
        this._dragProxy.scale.set(width, this.DEFAULT_HEIGHT, depth);
        this._dragProxy.position.set(cx, this.DEFAULT_HEIGHT / 2, cz);
        this.viewport._render();
      },

      _clearProxy: function () {
        if (!this._dragProxy) return;
        this.viewport._three.scene.remove(this._dragProxy);
        this._dragProxy.geometry.dispose();
        this._dragProxy.material.dispose();
        this._dragProxy = null;
        this.viewport._render();
      },
    },

    'commit (§5.2 pointerup — real OCCT box, one worker call)', {
      _commit: function (start, end) {
        var width = Math.abs(end.x - start.x);
        var depth = Math.abs(end.z - start.z);
        if (width < this.MIN_DRAG || depth < this.MIN_DRAG) return; // discard near-zero/stray-click drags
        this.featureTree.checkpoint(); // §6.2/§13 step 14 — one undo entry per completed drag-to-create
        var cx = (start.x + end.x) / 2, cz = (start.z + end.z) / 2;

        // createBox always builds from its own local origin outward
        // (OCCT convention) — the transform's translate is what actually
        // places the footprint where the user dragged it, corner-first
        // to (cx - width/2, 0, cz - depth/2) so it spans the same box the
        // proxy mesh (centered at (cx, height/2, cz)) already showed.
        var boxId = this.featureTree.addNode('createBox', {
          width: width, height: this.DEFAULT_HEIGHT, depth: depth,
        });
        var xfId = this.featureTree.addNode('transform', {
          of: boxId,
          translate: [cx - width / 2, 0, cz - depth / 2],
          rotate: [0, 0, 0],
          scale: [1, 1, 1],
        });
        this.featureTree.setRoot(xfId);
        this.sceneSync.rebuild(xfId);
      },
    },

    'ground plane raycasting', {
      _screenToGroundPoint: function (clientX, clientY) {
        var three = this.viewport._three;
        if (!three) return null;
        var THREE = three.THREE;
        var canvas = three.renderer.domElement;
        var rect = canvas.getBoundingClientRect();
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
          // still resolve off-canvas points during an active drag (window
          // listeners can fire outside the canvas) — only reject if the
          // canvas has zero size (not yet laid out).
          if (rect.width === 0 || rect.height === 0) return null;
        }
        var ndc = new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1
        );
        var raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, three.camera);
        var groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        var hit = new THREE.Vector3();
        var didHit = raycaster.ray.intersectPlane(groundPlane, hit);
        return didHit ? hit : null;
      },
    });

  });
