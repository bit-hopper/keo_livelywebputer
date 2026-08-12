/**
 * lively.jenga3d.Viewport
 *
 * Morph embedding a Three.js WebGL canvas (Jenga3Dspec_v0.md §2, §13 step
 * 4). Follows `lively.morphic.CodeEditorShape`'s established pattern
 * (core/lively/ide/CodeEditor.js) for a Morph owning a non-Morphic
 * rendering surface: a `lively.morphic.Shapes.External` subclass wraps a
 * raw `<div>`, and once that div is actually attached to the document
 * (`whenOpenedInWorld`, same hook CodeEditor uses to size Ace correctly),
 * a canvas-based library takes over managing its contents directly — Ace
 * there, Three.js's `WebGLRenderer` here.
 *
 * This step renders a static `BufferGeometry` handed to it via `setMesh`
 * — no worker calls, no drag interaction (§13 steps 5-7 wire those up).
 * `MeshNormalMaterial` is the default (no lighting setup needed, and
 * doubles as a visual check that step 2's winding/normal-flip fix
 * produced sane normals) — swap for something else once real UI exists.
 *
 * §13 step 8 adds face picking + highlight (§10): `setMesh` now carries
 * the worker's per-face `groups` (`{start, count, occtFaceIndex}`, §4.3)
 * onto the built `BufferGeometry.groups`, and the mesh's material becomes
 * a `[normal, highlight]` array so a picked face's group can flip its
 * `materialIndex` to render highlighted without touching any other face.
 * A `click` listener (not `pointerdown`/move/up — those are the drag
 * tools' gesture, §13 steps 6-7; `click` only fires for a genuine
 * no-movement click) resolves the hit via `lively.jenga3d.PickIndex` and
 * highlights the picked face automatically.
 *
 * §13 step 10 adds the same treatment for edges (§7.3's edge selectors):
 * `setMesh` also builds a `THREE.LineSegments` overlay from the worker's
 * `edges` (straight-line approximations, one 2-vertex group per edge,
 * same `[normal, highlight]`-material-array approach as faces).
 * `pickEdgeAt`/`highlightEdge`/`clearEdgeHighlight` are exposed as
 * methods, not wired into the existing `click` listener — a single click
 * shouldn't have to disambiguate "pick a face" from "pick an edge for a
 * fillet," so which one applies is left to whatever calls these
 * explicitly (a future edge-selection mode), matching
 * `CreateBoxTool`/`EditHandleTool`/`CombineTool`'s existing pattern of
 * being driven directly rather than through an as-yet-nonexistent
 * toolbar/mode UI.
 */

module('lively.jenga3d.Viewport')
  .requires('lively.morphic', 'lively.jenga3d.PickIndex')
  .toRun(function () {

    lively.morphic.Shapes.External.subclass('lively.jenga3d.ViewportShape',

    'initializing', {
      initialize: function ($super) {
        var node = document.createElement('div');
        $super(node);
      },
    },

    'HTML rendering', {
      getExtentHTML: function ($super, ctx) {
        if (!ctx.shapeNode) return this.extent || $super(ctx);
        return pt(ctx.shapeNode.clientWidth, ctx.shapeNode.clientHeight);
      },

      setExtentHTML: function (ctx, value) {
        if (!ctx.shapeNode) return undefined;
        var borderWidth = Math.floor(this.getBorderWidth()),
          realExtent = value.subXY(borderWidth, borderWidth).maxPt(pt(0, 0));
        ctx.domInterface.setExtent(ctx.shapeNode, realExtent);
        // §2: this shape's only job is DOM sizing; the owning Viewport
        // morph is the one that knows about the THREE renderer/camera —
        // it listens for extent changes itself (see 'sizing' below)
        // rather than this shape reaching back into morph internals.
        if (this.onResized) this.onResized(realExtent);
        return realExtent;
      },
    });

    lively.morphic.Morph.subclass('lively.jenga3d.Viewport',

    'settings', {
      doNotSerialize: ['_three', '_mesh', '_edgeLines'],
      style: { enableGrabbing: false, enableDropping: false },
    },

    'initializing', {
      initialize: function ($super, bounds) {
        $super(this.defaultShape());
        this.setBounds(bounds || lively.rect(0, 0, 400, 300));
        this._three = null; // { THREE, scene, camera, renderer } once set up
        this._mesh = null;  // current THREE.Mesh, if any

        var self = this;
        this.getShape().onResized = function (extent) { self._onResized(extent); };
        this.whenOpenedInWorld(function () { self._ensureThreeRuntime(function () { self._setupThree(); }); });
      },

      defaultShape: function () {
        return new lively.jenga3d.ViewportShape();
      },
    },

    'three.js runtime', {
      // Lazy-loads core/lib/jenga3d/jenga3d-deps.js (window.jenga3dDeps.THREE).
      // Same guard/poll shape as LocalMap.js's _ensureGeoRuntime and
      // PostCardEditor.js's _ensureRuntime — intentionally duplicated
      // rather than shared, matching this codebase's existing tolerance
      // for small per-module copies of this pattern.
      _ensureThreeRuntime: function (callback) {
        if (window.jenga3dDeps && window.jenga3dDeps.THREE) return callback();
        if (window._jenga3dDepsLoading) {
          var poll = setInterval(function () {
            if (window.jenga3dDeps && window.jenga3dDeps.THREE) { clearInterval(poll); callback(); }
          }, 80);
          return;
        }
        window._jenga3dDepsLoading = true;
        var s = document.createElement('script');
        s.src = '/core/lib/jenga3d/jenga3d-deps.js';
        s.onload = function () { window._jenga3dDepsLoading = false; callback(); };
        s.onerror = function () {
          window._jenga3dDepsLoading = false;
          console.error('[lively.jenga3d.Viewport] failed to load jenga3d-deps.js');
        };
        document.head.appendChild(s);
      },
    },

    'three.js setup', {
      _setupThree: function () {
        if (this._three) return; // already set up (e.g. re-entered world)
        var THREE = window.jenga3dDeps.THREE;
        var node = this.getShape().shapeNode;
        var extent = this.getExtent();
        var width = Math.max(1, extent.x), height = Math.max(1, extent.y);

        var scene = new THREE.Scene();
        var camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100000);
        camera.position.set(100, 100, 100);
        camera.lookAt(0, 0, 0);

        var renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        node.appendChild(renderer.domElement);

        this._three = { THREE: THREE, scene: scene, camera: camera, renderer: renderer };
        this._attachPicking();

        if (this._pendingMesh) {
          var pending = this._pendingMesh;
          this._pendingMesh = null;
          this.setMesh(pending); // also renders
        } else {
          this._render();
        }
      },

      _onResized: function (extent) {
        if (!this._three) return; // not set up yet, initial size handled in _setupThree
        var width = Math.max(1, extent.x), height = Math.max(1, extent.y);
        this._three.camera.aspect = width / height;
        this._three.camera.updateProjectionMatrix();
        this._three.renderer.setSize(width, height);
        this._render();
      },

      _render: function () {
        if (!this._three) return;
        this._three.renderer.render(this._three.scene, this._three.camera);
      },
    },

    'mesh', {
      // mesh: { positions: Float32Array, normals: Float32Array, indices: Uint32Array,
      //         groups: [{start, count, occtFaceIndex}] } — the exact shape
      // lively.jenga3d.Worker's "evaluate" response carries (§4.3).
      setMesh: function (mesh) {
        if (!this._three) { this._pendingMesh = mesh; return; } // apply once three.js is ready
        var THREE = this._three.THREE;

        if (this._mesh) {
          this._three.scene.remove(this._mesh);
          this._mesh.geometry.dispose();
          this._mesh.material.forEach(function (m) { m.dispose(); });
        }
        this._highlightedGroupIndex = null;
        if (this._edgeLines) {
          this._three.scene.remove(this._edgeLines);
          this._edgeLines.geometry.dispose();
          this._edgeLines.material.forEach(function (m) { m.dispose(); });
          this._edgeLines = null;
        }
        this._highlightedEdgeGroupIndex = null;

        var geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
        geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));

        // §10/§13 step 8: preserve the worker's per-face ranges as real
        // BufferGeometry groups (materialIndex 0 = normal to start) so a
        // raycaster hit can be resolved back to an occtFaceIndex
        // (PickIndex) and a picked face highlighted via materialIndex 1,
        // without touching any other face's geometry or material.
        if (mesh.groups && mesh.groups.length > 0) {
          mesh.groups.forEach(function (g) {
            geometry.addGroup(g.start, g.count, 0);
            geometry.groups[geometry.groups.length - 1].occtFaceIndex = g.occtFaceIndex;
          });
        } else {
          geometry.addGroup(0, mesh.indices.length, 0);
        }

        var material = new THREE.MeshNormalMaterial();
        var highlightMaterial = new THREE.MeshBasicMaterial({ color: 0xffee00 });
        this._mesh = new THREE.Mesh(geometry, [material, highlightMaterial]);
        this._three.scene.add(this._mesh);

        // §13 step 10, §7.3: straight-line edge overlay for edge
        // selection (fillet/chamfer). Same per-group materialIndex
        // highlight approach as faces, just 2 vertices per group instead
        // of a variable-length triangle run.
        if (mesh.edges && mesh.edges.length > 0) {
          var edgePositions = [];
          mesh.edges.forEach(function (e) {
            edgePositions.push(e.a[0], e.a[1], e.a[2], e.b[0], e.b[1], e.b[2]);
          });
          var edgeGeometry = new THREE.BufferGeometry();
          edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
          mesh.edges.forEach(function (e, i) {
            edgeGeometry.addGroup(i * 2, 2, 0);
            edgeGeometry.groups[edgeGeometry.groups.length - 1].occtEdgeIndex = e.index;
          });
          var edgeMaterial = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
          var edgeHighlightMaterial = new THREE.LineBasicMaterial({ color: 0xff2222 });
          this._edgeLines = new THREE.LineSegments(edgeGeometry, [edgeMaterial, edgeHighlightMaterial]);
          this._three.scene.add(this._edgeLines);
        }

        this._frameMesh(geometry);
        this._render();
      },

      // Points the camera at the mesh's bounding sphere so whatever gets
      // handed to setMesh is actually visible regardless of its scale —
      // real parts built via CreateBoxTool (§13 step 6) will be a handful
      // of mm (§9.1), not the 100-unit defaults _setupThree starts with.
      _frameMesh: function (geometry) {
        geometry.computeBoundingSphere();
        var sphere = geometry.boundingSphere;
        if (!sphere || sphere.radius === 0) return;
        var THREE = this._three.THREE, camera = this._three.camera;
        var dir = new THREE.Vector3(1, 1, 1).normalize();
        var distance = Math.max(sphere.radius * 2.5, 0.01);
        camera.position.copy(sphere.center).addScaledVector(dir, distance);
        camera.near = Math.max(distance / 100, 0.001);
        camera.far = distance * 100;
        camera.updateProjectionMatrix();
        camera.lookAt(sphere.center);
      },
    },

    'picking (§10)', {
      _attachPicking: function () {
        var self = this;
        this._three.renderer.domElement.addEventListener('click', function (evt) {
          var pick = self.pickFaceAt(evt.clientX, evt.clientY);
          self.highlightGroup(pick ? pick.groupIndex : null);
        });
      },

      // Returns { occtFaceIndex, groupIndex } for the face under
      // (clientX, clientY), or null if nothing was hit.
      pickFaceAt: function (clientX, clientY) {
        if (!this._three || !this._mesh) return null;
        var THREE = this._three.THREE;
        var canvas = this._three.renderer.domElement;
        var rect = canvas.getBoundingClientRect();
        var ndc = new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1
        );
        var raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, this._three.camera);
        var hits = raycaster.intersectObject(this._mesh);
        if (hits.length === 0) return null;
        return lively.jenga3d.PickIndex.resolve(this._mesh.geometry, hits[0].faceIndex);
      },

      // groupIndex: a BufferGeometry group index (as returned by
      // pickFaceAt), or null/undefined to clear any current highlight.
      highlightGroup: function (groupIndex) {
        if (!this._mesh) return;
        var groups = this._mesh.geometry.groups;
        if (this._highlightedGroupIndex != null && groups[this._highlightedGroupIndex]) {
          groups[this._highlightedGroupIndex].materialIndex = 0;
        }
        this._highlightedGroupIndex = (groupIndex == null) ? null : groupIndex;
        if (this._highlightedGroupIndex != null && groups[this._highlightedGroupIndex]) {
          groups[this._highlightedGroupIndex].materialIndex = 1;
        }
        this._render();
      },

      clearHighlight: function () {
        this.highlightGroup(null);
      },
    },

    'edge picking (§7.3, §13 step 10)', {
      // Returns { occtEdgeIndex, groupIndex } for the edge under
      // (clientX, clientY), or null if nothing was hit within the
      // pick threshold. Not wired to the `click` listener — see file doc.
      pickEdgeAt: function (clientX, clientY) {
        if (!this._three || !this._edgeLines) return null;
        var THREE = this._three.THREE;
        var canvas = this._three.renderer.domElement;
        var rect = canvas.getBoundingClientRect();
        var ndc = new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1
        );
        var raycaster = new THREE.Raycaster();
        raycaster.params.Line = raycaster.params.Line || {};
        raycaster.params.Line.threshold = this._edgePickThreshold || 0.5;
        raycaster.setFromCamera(ndc, this._three.camera);
        var hits = raycaster.intersectObject(this._edgeLines);
        if (hits.length === 0) return null;
        var found = lively.jenga3d.PickIndex.resolveOffset(
          this._edgeLines.geometry, hits[0].index, 'occtEdgeIndex'
        );
        return found ? { occtEdgeIndex: found.value, groupIndex: found.groupIndex } : null;
      },

      highlightEdge: function (groupIndex) {
        if (!this._edgeLines) return;
        var groups = this._edgeLines.geometry.groups;
        if (this._highlightedEdgeGroupIndex != null && groups[this._highlightedEdgeGroupIndex]) {
          groups[this._highlightedEdgeGroupIndex].materialIndex = 0;
        }
        this._highlightedEdgeGroupIndex = (groupIndex == null) ? null : groupIndex;
        if (this._highlightedEdgeGroupIndex != null && groups[this._highlightedEdgeGroupIndex]) {
          groups[this._highlightedEdgeGroupIndex].materialIndex = 1;
        }
        this._render();
      },

      clearEdgeHighlight: function () {
        this.highlightEdge(null);
      },
    });

  });
