/**
 * lively.jenga3d.tools.CreateCylinderTool
 *
 * Drag-to-create tool for a cylinder (Jenga3Dspec_v0.md §14.7, §13 step
 * 18) — the same ground-plane drag interaction `CreateBoxTool` already
 * implements (`_screenToGroundPoint`, a live zero-IPC THREE proxy mesh,
 * one worker call via `Assembly.createInstance` on `pointerup`), just
 * producing a `createCylinder` node instead of `createBox`. `createCylinder`
 * is already implemented and verified worker-side (§13 step 2) — this is
 * new client-side interaction code only, no worker/OCCT change.
 *
 * Interaction model (mirrors CreateBoxTool's own, pinned there): pointerdown
 * sets the cylinder's center on the Y=0 ground plane; the live drag
 * distance from that center to the current point (in the XZ plane) is the
 * radius; height is a fixed default, matching CreateBoxTool's own
 * DEFAULT_HEIGHT treatment.
 *
 * §9.1/OCCT convention, confirmed empirically in a Node harness before
 * writing this (not assumed from a `.d.ts`): `BRepPrimAPI_MakeCylinder`
 * builds along the LOCAL Z AXIS from the origin (base circle in the local
 * XY plane, extending +Z by `height`) — unlike `createBox`, whose second
 * param already maps to world-up Y. To stand the cylinder upright on the
 * ground plane the way a box already sits (§9.1: Y is up), the wrapping
 * transform applies `rotate: [-Math.PI/2, 0, 0]`, which empirically maps
 * local Z (the cylinder's height axis) onto world Y (confirmed: a
 * radius=5/height=20 cylinder's bounding box goes from Y:[0,20], X/Z:[-5,5]
 * after this exact rotation, in a standalone Node harness against the real
 * wasm module).
 */

module('lively.jenga3d.tools.CreateCylinderTool')
  .requires('lively.jenga3d.Assembly', 'lively.jenga3d.Viewport')
  .toRun(function () {

    Object.subclass('lively.jenga3d.tools.CreateCylinderTool',

    'settings', {
      DEFAULT_HEIGHT: 10, // mm (§9.1: 1 unit = 1mm) — matches CreateBoxTool's own default
      MIN_DRAG: 1,        // mm — drags shorter than this radius are discarded, not committed
    },

    'initializing', {
      initialize: function (viewport, assembly) {
        this.viewport = viewport;
        this.assembly = assembly;
        this._dragProxy = null;
        this._dragCenter = null;
        this._dragActive = false;
        this._attached = false;
        this._attachWhenReady();
      },
    },

    'attaching', {
      _attachWhenReady: function () {
        if (this.viewport._three) { this._attach(); return; }
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
        evt.stopPropagation();
        this._dragCenter = point;
        this._dragActive = true;
      },

      _handlePointerMove: function (evt) {
        if (!this._dragActive) return;
        var point = this._screenToGroundPoint(evt.clientX, evt.clientY);
        if (!point) return;
        this._updateProxy(this._dragCenter, point);
      },

      _handlePointerUp: function (evt) {
        if (!this._dragActive) return;
        this._dragActive = false;
        var center = this._dragCenter;
        this._dragCenter = null;
        this._clearProxy();
        var point = this._screenToGroundPoint(evt.clientX, evt.clientY);
        if (point) this._commit(center, point);
      },
    },

    'proxy mesh (§5.2, zero IPC)', {
      _updateProxy: function (center, edge) {
        var THREE = this.viewport._three.THREE;
        var radius = Math.max(0.001, Math.hypot(edge.x - center.x, edge.z - center.z));

        if (!this._dragProxy) {
          // THREE.CylinderGeometry's own axis is already Y (matching
          // world-up) by default, so the *proxy* needs no extra rotation
          // — only the real OCCT-built result (local Z axis, see file
          // doc) does, applied via the committed node's own transform.
          var geometry = new THREE.CylinderGeometry(1, 1, 1, 24);
          var material = new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.5 });
          this._dragProxy = new THREE.Mesh(geometry, material);
          this.viewport._three.scene.add(this._dragProxy);
        }
        this._dragProxy.scale.set(radius, this.DEFAULT_HEIGHT, radius);
        this._dragProxy.position.set(center.x, this.DEFAULT_HEIGHT / 2, center.z);
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

    'commit (§5.2 pointerup — real OCCT cylinder, one worker call)', {
      _commit: function (center, edge) {
        var radius = Math.hypot(edge.x - center.x, edge.z - center.z);
        if (radius < this.MIN_DRAG) return; // discard near-zero/stray-click drags
        this.assembly.createInstance('createCylinder',
          { radius: radius, height: this.DEFAULT_HEIGHT },
          { translate: [center.x, 0, center.z], rotate: [-Math.PI / 2, 0, 0], scale: [1, 1, 1] });
      },
    },

    'ground plane raycasting (identical to CreateBoxTool\'s own)', {
      _screenToGroundPoint: function (clientX, clientY) {
        var three = this.viewport._three;
        if (!three) return null;
        var THREE = three.THREE;
        var canvas = three.renderer.domElement;
        var rect = canvas.getBoundingClientRect();
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
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
