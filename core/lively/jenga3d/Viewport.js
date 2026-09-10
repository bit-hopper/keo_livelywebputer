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
 *
 * §14.4 (multi-instance): `_mesh`/`_edgeLines` (singular) become
 * `_meshes`, a Map from rootId to `{ mesh, edgeLines }`. `setMesh(rootId,
 * meshData)`/`clearMesh(rootId)` touch only that instance. Framing moves
 * from "every setMesh call" to "structural changes only" —
 * `_frameAllMeshes()` is called explicitly by `Assembly` after add/
 * remove/combine/fillet-commit, not from inside setMesh, so a different
 * instance's throttled Complex-drag rebuild (§5.3) never yanks the
 * camera; an instance's *first* setMesh still frames on its own so a
 * freshly-dropped shape is immediately visible. Picking raycasts every
 * current mesh and resolves `{ rootId, occtFaceIndex, groupIndex }` via
 * `mesh.userData.rootId`; `highlightGroup`/multi-edge highlight are
 * tracked per instance. Whole-instance "selected for combine/fillet"
 * (§14.5's `selectInstance`) is a distinct visual — a wireframe
 * `THREE.BoxHelper` outline per selected instance via `setSelected`, not
 * a face-group highlight — since a materialIndex flip only lights up one
 * triangle group, not "this whole object is selected"; spec'd in §14.5 as
 * reusing `highlightGroup`'s "per-instance tracking" but a literal reuse
 * of the per-face mechanism doesn't fit "select the whole object," so
 * this is a deliberate, narrow deviation from that wording, recorded here
 * per this doc's own convention for reinterpretations (§0).
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
      doNotSerialize: ['_three', '_meshes', '_selectionOutlines', '_gizmo', '_rotationGizmo'],
      style: { enableGrabbing: false, enableDropping: false },
    },

    'initializing', {
      initialize: function ($super, bounds) {
        $super(this.defaultShape());
        this.setBounds(bounds || lively.rect(0, 0, 400, 300));
        this._three = null; // { THREE, scene, camera, renderer } once set up
        this._meshes = {};  // rootId -> { mesh, edgeLines, highlightedGroupIndex, highlightedEdgeGroupIndices: Set }
        this._selectionOutlines = {}; // rootId -> THREE.BoxHelper (§14.4/§14.5 "selected instance" tint)
        this._rotationGizmo = null; // { rootId, rings: {x,y,z}, center, radius } — RotateTool's drag rings

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
        // A light workplane background rather than the original black-void
        // one (added along with the ground grid/corner gizmo, §13 step 22)
        // — a session later found the black background was one of the
        // biggest visual mismatches against a reference CAD-viewer look,
        // addressed here alongside real lighting.
        scene.background = new THREE.Color(0xf4f6f8);
        var camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100000);
        camera.position.set(100, 100, 100);
        camera.lookAt(0, 0, 0);

        var renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        node.appendChild(renderer.domElement);

        this._three = { THREE: THREE, scene: scene, camera: camera, renderer: renderer };
        this._addGroundGrid();
        this._addLights();
        this._setupGizmo();
        this._attachPicking();

        var self = this;
        if (this._pendingMeshes) {
          var pending = this._pendingMeshes;
          this._pendingMeshes = null;
          Object.keys(pending).forEach(function (rootId) { self.setMesh(rootId, pending[rootId]); });
        } else {
          this._render();
        }
      },

      // A CAD-viewer-style orientation reference — a static ground grid on
      // the Y=0 plane (§9.1: 1 unit = 1mm; 1000mm/100 divisions = 10mm
      // cells, matching CreateBoxTool's own 10mm default height) so a
      // freshly-opened viewport reads as "an empty workspace," not a
      // black void. Purely a visual reference, not part of the tree/mesh
      // data — never touched by picking (its own geometry has no
      // .groups, so PickIndex.resolve never matches it) or export.
      _addGroundGrid: function () {
        var THREE = this._three.THREE;
        // Colors tuned for the light workplane background (see
        // scene.background above) — the original 0x666666/0x333333 pair
        // was tuned for a black background and reads as barely-visible
        // dark-on-dark against the light one.
        var grid = new THREE.GridHelper(1000, 100, 0xb8bec4, 0xdde2e6);
        this._three.scene.add(grid);
      },

      // A soft-shaded, CAD-viewer-style look for the display material
      // (Export is mesh-data-based, not material-based — confirmed by
      // reading Export.js before this change, so this doesn't touch
      // STL/OBJ/STEP correctness) needs an actual light or two; the
      // original MeshNormalMaterial needed none, chosen specifically to
      // double as a normals sanity-check with no lighting setup required.
      _addLights: function () {
        var THREE = this._three.THREE;
        var ambient = new THREE.AmbientLight(0xffffff, 0.55);
        var key = new THREE.DirectionalLight(0xffffff, 0.85);
        key.position.set(60, 120, 80);
        var fill = new THREE.DirectionalLight(0xffffff, 0.25);
        fill.position.set(-80, 40, -60);
        this._three.scene.add(ambient, key, fill);
      },

      // A labeled navigation cube in the canvas's bottom-left corner
      // (TOP/BOTTOM/LEFT/RIGHT/FRONT/BACK face labels, plus a small
      // colored X/Y/Z axis triad poking out of one corner) — modeled
      // directly on a labeled reference view-cube image rather than the
      // original bare RGB arrow triad, per a live comparison against
      // supplied reference images.
      // Deliberately a SEPARATE scene+orthographic-camera pair rendered
      // into its own viewport/scissor rect each frame (unchanged from the
      // original arrow-triad version's own reasoning): an in-scene gizmo
      // would zoom/shrink with the model instead of staying a constant
      // on-screen size, and would need picking/highlight/export to all
      // know to ignore it. Purely a visual orientation reference — no
      // click-to-snap-view interaction (yet; the reference images didn't
      // show any, so none was built).
      _setupGizmo: function () {
        var THREE = this._three.THREE;
        var scene = new THREE.Scene();
        // Matches the main scene's light background — this is a SEPARATE
        // scene/camera pair (file doc above), so it needs its own
        // background set; otherwise its scissored corner renders as a
        // black square regardless of the main viewport's own background.
        scene.background = new THREE.Color(0xf4f6f8);
        // Frustum tightened to just fit the cube + its axis-label
        // overhang (found live: the original ±2.2 left the cube filling
        // only ~35% of the real ~90px on-screen square, which combined
        // with the face labels' original size/contrast made them
        // effectively unreadable at actual size — verified by cropping
        // the real rendered corner pixels, not a re-render at a larger
        // size, which had been hiding this).
        var camera = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 10);

        var cubeSize = 1.6;
        var cube = new THREE.Mesh(
          new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize),
          this._buildGizmoCubeMaterials(THREE)
        );
        scene.add(cube);
        scene.add(new THREE.LineSegments(
          new THREE.EdgesGeometry(cube.geometry),
          new THREE.LineBasicMaterial({ color: 0xafb5bb })
        ));

        // Short colored axis lines + letter labels poking out past the
        // cube's own +X/+Y/+Z corner (second reference image) — same
        // red=X/green=Y/blue=Z convention the old arrow triad already
        // used, just now alongside the labeled cube rather than instead
        // of it.
        this._addGizmoAxis(scene, THREE, new THREE.Vector3(1, 0, 0), 0xff4444, 'X', cubeSize);
        this._addGizmoAxis(scene, THREE, new THREE.Vector3(0, 1, 0), 0x2fb62f, 'Y', cubeSize);
        this._addGizmoAxis(scene, THREE, new THREE.Vector3(0, 0, 1), 0x3f7fd9, 'Z', cubeSize);

        this._gizmo = { scene: scene, camera: camera, sizeCss: 108, marginCss: 8 };
      },

      // Builds the cube's 6 face materials as canvas-texture labels, in
      // THREE.BoxGeometry's own face order ([+X, -X, +Y, -Y, +Z, -Z]).
      // +Y=TOP/-Y=BOTTOM/+X=RIGHT/-X=LEFT/+Z=FRONT/-Z=BACK — matches the
      // same world-axis convention (Y up) this file's own §9.1 comment
      // elsewhere already uses, and lines FRONT up with the +Z axis label
      // added by _addGizmoAxis below (both point the same direction in
      // the second reference image).
      _buildGizmoCubeMaterials: function (THREE) {
        // 256px source + a much larger, darker, higher-contrast label
        // than the original 128px/19px/#82898f attempt — found live
        // (cropping the real rendered ~30px-per-face-on-screen corner
        // pixels, see _setupGizmo's own comment) that the original sizing
        // anti-aliased the label down to an illegible smudge at actual
        // on-screen size, even though a separately-rendered larger copy
        // of the same scene looked fine and gave false confidence.
        function faceMaterial(label) {
          var canvas = document.createElement('canvas');
          canvas.width = canvas.height = 256;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fafbfc';
          ctx.fillRect(0, 0, 256, 256);
          ctx.strokeStyle = '#b7bdc3';
          ctx.lineWidth = 10;
          ctx.strokeRect(5, 5, 246, 246);
          ctx.fillStyle = '#454b51';
          ctx.font = 'bold 46px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, 128, 128);
          var texture = new THREE.CanvasTexture(canvas);
          return new THREE.MeshBasicMaterial({ map: texture });
        }
        return [
          faceMaterial('RIGHT'), faceMaterial('LEFT'),
          faceMaterial('TOP'), faceMaterial('BOTTOM'),
          faceMaterial('FRONT'), faceMaterial('BACK'),
        ];
      },

      // One short colored line + a small text-sprite letter label, from
      // just past the cube's surface outward along `dir`.
      _addGizmoAxis: function (scene, THREE, dir, color, letter, cubeSize) {
        var start = dir.clone().multiplyScalar(cubeSize / 2);
        var end = dir.clone().multiplyScalar(cubeSize / 2 + 0.55);
        var line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([start, end]),
          new THREE.LineBasicMaterial({ color: color })
        );
        scene.add(line);

        var canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
        ctx.font = 'bold 46px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, 32, 34);
        var texture = new THREE.CanvasTexture(canvas);
        var sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
        sprite.scale.set(0.42, 0.42, 1);
        sprite.position.copy(end).addScaledVector(dir, 0.18);
        scene.add(sprite);
      },

      // Mirrors the main camera's current orientation (not its position/
      // zoom, which don't apply to a fixed-distance orthographic gizmo):
      // the gizmo camera is placed at a constant distance along the same
      // "backward" direction the main camera currently has, so the arrows
      // always show the world axes exactly as they're oriented in the
      // main viewport right now.
      _renderGizmo: function () {
        var gizmo = this._gizmo;
        if (!gizmo) return;
        var THREE = this._three.THREE;
        var renderer = this._three.renderer;
        var mainCamera = this._three.camera;

        gizmo.camera.quaternion.copy(mainCamera.quaternion);
        gizmo.camera.position.copy(
          new THREE.Vector3(0, 0, 1).applyQuaternion(gizmo.camera.quaternion).multiplyScalar(3)
        );
        gizmo.camera.lookAt(0, 0, 0);

        var pixelRatio = renderer.getPixelRatio();
        var s = Math.round(gizmo.sizeCss * pixelRatio);
        var m = Math.round(gizmo.marginCss * pixelRatio);
        renderer.setViewport(m, m, s, s);
        renderer.setScissor(m, m, s, s);
        renderer.setScissorTest(true);
        renderer.render(gizmo.scene, gizmo.camera);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, renderer.domElement.width, renderer.domElement.height);
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
        this._renderGizmo();
      },
    },

    'mesh (§14.4 — multi-instance)', {
      // Public accessor for a rootId's live THREE.Mesh — used by
      // MoveTool (§14.7) to preview a rigid-translation drag by nudging
      // the mesh's own .position directly (zero IPC — moving doesn't
      // change geometry, only placement, so no worker round-trip is
      // needed until the drag commits). Returns null if rootId isn't
      // currently rendered.
      getMesh: function (rootId) {
        var entry = this._meshes[rootId];
        return entry ? entry.mesh : null;
      },

      // A small fixed palette (pastel-ish solid colors), picked
      // deterministically from rootId so the same instance keeps its
      // color across rebuilds (drag updates, undo/redo resync) without
      // needing to track per-instance color state separately.
      _SHAPE_COLORS: [0x5b9bd5, 0xed7d31, 0x70ad47, 0xffc000, 0x9e6ac2, 0xe06666, 0x4fc3c1, 0xd68fb0],
      _colorForRootId: function (rootId) {
        var hash = 0;
        for (var i = 0; i < rootId.length; i++) hash = (hash * 31 + rootId.charCodeAt(i)) | 0;
        var idx = Math.abs(hash) % this._SHAPE_COLORS.length;
        return this._SHAPE_COLORS[idx];
      },

      // rootId: which instance this mesh belongs to. mesh: { positions:
      // Float32Array, normals: Float32Array, indices: Uint32Array,
      // groups: [{start, count, occtFaceIndex}] } — the exact shape
      // lively.jenga3d.Worker's "evaluate" response carries (§4.3).
      // Creates or replaces only rootId's own mesh, without touching any
      // other instance. An instance's first setMesh call frames the
      // camera on its own bounding sphere so a freshly-dropped shape is
      // immediately visible; subsequent calls (e.g. mid-drag rebuilds)
      // deliberately do NOT re-frame — Assembly calls _frameAllMeshes()
      // explicitly at structural-change points instead (file doc).
      setMesh: function (rootId, mesh) {
        if (!this._three) {
          this._pendingMeshes = this._pendingMeshes || {};
          this._pendingMeshes[rootId] = mesh;
          return;
        }
        var THREE = this._three.THREE;
        var isFirstMesh = !this._meshes[rootId];
        this._disposeInstance(rootId);

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

        // A soft-shaded solid color (needs the lights added in
        // _addLights) rather than the original MeshNormalMaterial, which
        // rendered winding/normal direction as color — useful while
        // debugging the kernel, not for an end-user-facing shape. A small
        // fixed palette cycled by a hash of rootId gives each instance a
        // stable, distinct color across rebuilds without needing extra
        // per-viewport state.
        var material = new THREE.MeshStandardMaterial({ color: this._colorForRootId(rootId), roughness: 0.55, metalness: 0.05 });
        var highlightMaterial = new THREE.MeshBasicMaterial({ color: 0xffee00 });
        var threeMesh = new THREE.Mesh(geometry, [material, highlightMaterial]);
        threeMesh.userData.rootId = rootId; // §14.4: traces a raycaster hit back to its instance
        this._three.scene.add(threeMesh);

        var entry = { mesh: threeMesh, edgeLines: null, highlightedGroupIndex: null, highlightedEdgeGroupIndices: {} };
        this._meshes[rootId] = entry;

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
          var edgeLines = new THREE.LineSegments(edgeGeometry, [edgeMaterial, edgeHighlightMaterial]);
          edgeLines.userData.rootId = rootId;
          this._three.scene.add(edgeLines);
          entry.edgeLines = edgeLines;
        }

        this._refreshSelectionOutline(rootId);
        if (isFirstMesh) this._frameAllMeshes();
        this._render();
      },

      // §13 step 14 / §14.5: reachable once undo/removeInstance/combine
      // makes rootId stop being a visible instance — tears down just that
      // instance rather than leaving it showing stale geometry.
      clearMesh: function (rootId) {
        if (!this._three) {
          if (this._pendingMeshes) delete this._pendingMeshes[rootId];
          return;
        }
        this._disposeInstance(rootId);
        this._render();
      },

      _disposeInstance: function (rootId) {
        var entry = this._meshes[rootId];
        if (!entry) return;
        this._three.scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        entry.mesh.material.forEach(function (m) { m.dispose(); });
        if (entry.edgeLines) {
          this._three.scene.remove(entry.edgeLines);
          entry.edgeLines.geometry.dispose();
          entry.edgeLines.material.forEach(function (m) { m.dispose(); });
        }
        delete this._meshes[rootId];
        this._clearSelectionOutline(rootId);
        if (this._rotationGizmo && this._rotationGizmo.rootId === rootId) this.hideRotationGizmo();
      },

      // Points the camera at the union of every current instance's
      // bounding sphere so the whole scene stays visible regardless of
      // how many instances exist or their individual scale (§9.1: real
      // parts are a handful of mm, not the 100-unit defaults _setupThree
      // starts with). Called explicitly by Assembly after structural
      // changes (add/remove/combine/fillet-commit) — never from inside a
      // per-instance setMesh, so one instance's throttled Complex-drag
      // rebuild (§5.3) never jerks the camera around while someone drags it.
      _frameAllMeshes: function () {
        var THREE = this._three.THREE, camera = this._three.camera;
        var box = new THREE.Box3();
        var any = false;
        var self = this;
        Object.keys(this._meshes).forEach(function (rootId) {
          box.expandByObject(self._meshes[rootId].mesh);
          any = true;
        });
        if (!any) return;
        var sphere = new THREE.Sphere();
        box.getBoundingSphere(sphere);
        if (!sphere || sphere.radius === 0) return;
        var dir = new THREE.Vector3(1, 1, 1).normalize();
        var distance = Math.max(sphere.radius * 2.5, 0.01);
        camera.position.copy(sphere.center).addScaledVector(dir, distance);
        camera.near = Math.max(distance / 100, 0.001);
        camera.far = distance * 100;
        camera.updateProjectionMatrix();
        camera.lookAt(sphere.center);
      },
    },

    'picking (§10, §14.4 — multi-instance)', {
      _attachPicking: function () {
        var self = this;
        this._three.renderer.domElement.addEventListener('click', function (evt) {
          if (self._pickMode === 'edge') return; // §14.6: edge-select mode uses pickEdgeAt explicitly, not this listener
          var pick = self.pickFaceAt(evt.clientX, evt.clientY);
          if (self.onPickFace) self.onPickFace(pick); // §14.6: object-select mode hook (Assembly.selectInstance)
          self.highlightGroup(pick ? pick.rootId : null, pick ? pick.groupIndex : null);
        });
      },

      // Returns { rootId, occtFaceIndex, groupIndex } for the face under
      // (clientX, clientY) across every current instance (closest hit
      // wins), or null if nothing was hit.
      pickFaceAt: function (clientX, clientY) {
        if (!this._three) return null;
        var meshes = this._allMeshes();
        if (meshes.length === 0) return null;
        var THREE = this._three.THREE;
        var canvas = this._three.renderer.domElement;
        var rect = canvas.getBoundingClientRect();
        var ndc = new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1
        );
        var raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, this._three.camera);
        var hits = raycaster.intersectObjects(meshes);
        if (hits.length === 0) return null;
        var hit = hits[0];
        var found = lively.jenga3d.PickIndex.resolve(hit.object.geometry, hit.faceIndex);
        if (!found) return null;
        return { rootId: hit.object.userData.rootId, occtFaceIndex: found.occtFaceIndex, groupIndex: found.groupIndex };
      },

      _allMeshes: function () {
        var self = this;
        return Object.keys(this._meshes).map(function (rootId) { return self._meshes[rootId].mesh; });
      },

      // rootId/groupIndex: as returned by pickFaceAt, or null/undefined
      // to clear whichever instance was previously highlighted this way.
      highlightGroup: function (rootId, groupIndex) {
        if (this._highlightedFace) {
          var prev = this._meshes[this._highlightedFace.rootId];
          if (prev) {
            var prevGroups = prev.mesh.geometry.groups;
            if (prevGroups[this._highlightedFace.groupIndex]) prevGroups[this._highlightedFace.groupIndex].materialIndex = 0;
          }
          this._highlightedFace = null;
        }
        if (rootId != null && groupIndex != null && this._meshes[rootId]) {
          this._meshes[rootId].mesh.geometry.groups[groupIndex].materialIndex = 1;
          this._highlightedFace = { rootId: rootId, groupIndex: groupIndex };
        }
        this._render();
      },

      clearHighlight: function () {
        this.highlightGroup(null, null);
      },
    },

    'edge picking (§7.3, §13 step 10, §14.4 — per instance)', {
      // Returns { rootId, occtEdgeIndex, groupIndex } for the edge under
      // (clientX, clientY) *within instanceRootId's own edge overlay only*
      // (§14.6: edge-select mode is only active against one selected
      // instance at a time) — or null if nothing was hit within the pick
      // threshold. Not wired to the `click` listener — see file doc.
      pickEdgeAt: function (instanceRootId, clientX, clientY) {
        var entry = this._meshes[instanceRootId];
        if (!this._three || !entry || !entry.edgeLines) return null;
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
        var hits = raycaster.intersectObject(entry.edgeLines);
        if (hits.length === 0) return null;
        var found = lively.jenga3d.PickIndex.resolveOffset(
          entry.edgeLines.geometry, hits[0].index, 'occtEdgeIndex'
        );
        return found ? { rootId: instanceRootId, occtEdgeIndex: found.value, groupIndex: found.groupIndex } : null;
      },

      // §14.4/§14.6: multi-edge highlight — FilletTool.apply already takes
      // an edgeIndices array, so the toolbar's edge-pick mode can toggle
      // several edges on/off before Apply. toggle: true flips groupIndex's
      // membership in the set; toggle: false (default) sets it exclusively
      // (matches the old single-highlight call shape for callers that
      // don't need multi-select, e.g. tests).
      highlightEdge: function (rootId, groupIndex, toggle) {
        var entry = this._meshes[rootId];
        if (!entry) return;
        var groups = entry.edgeLines.geometry.groups;
        if (groupIndex == null) {
          Object.keys(entry.highlightedEdgeGroupIndices).forEach(function (idx) { groups[idx].materialIndex = 0; });
          entry.highlightedEdgeGroupIndices = {};
          this._render();
          return;
        }
        if (toggle) {
          if (entry.highlightedEdgeGroupIndices[groupIndex]) {
            delete entry.highlightedEdgeGroupIndices[groupIndex];
            groups[groupIndex].materialIndex = 0;
          } else {
            entry.highlightedEdgeGroupIndices[groupIndex] = true;
            groups[groupIndex].materialIndex = 1;
          }
        } else {
          Object.keys(entry.highlightedEdgeGroupIndices).forEach(function (idx) { groups[idx].materialIndex = 0; });
          entry.highlightedEdgeGroupIndices = {};
          entry.highlightedEdgeGroupIndices[groupIndex] = true;
          groups[groupIndex].materialIndex = 1;
        }
        this._render();
      },

      clearEdgeHighlight: function (rootId) {
        this.highlightEdge(rootId, null);
      },
    },

    'instance selection tint (§14.5 selectInstance — distinct from face-pick highlight)', {
      // Applies/clears a wireframe outline around rootId's mesh — the
      // "selected for combine/fillet" visual, kept deliberately distinct
      // from highlightGroup's per-face pick highlight (file doc).
      setSelected: function (rootId, selected) {
        if (selected) this._addSelectionOutline(rootId);
        else this._clearSelectionOutline(rootId);
        this._render();
      },

      _addSelectionOutline: function (rootId) {
        var entry = this._meshes[rootId];
        if (!entry) return;
        this._clearSelectionOutline(rootId);
        var THREE = this._three.THREE;
        var outline = new THREE.BoxHelper(entry.mesh, 0x00e5ff);
        this._three.scene.add(outline);
        this._selectionOutlines[rootId] = outline;
      },

      _clearSelectionOutline: function (rootId) {
        var outline = this._selectionOutlines[rootId];
        if (!outline) return;
        this._three.scene.remove(outline);
        outline.geometry.dispose();
        outline.material.dispose();
        delete this._selectionOutlines[rootId];
      },

      // Re-applies an existing selection outline after setMesh replaces
      // rootId's underlying THREE.Mesh (a BoxHelper tracks the object it
      // was constructed with, not a rootId, so it must be rebuilt).
      _refreshSelectionOutline: function (rootId) {
        if (this._selectionOutlines[rootId]) this._addSelectionOutline(rootId);
      },
    },

    'rotation gizmo (RotateTool — draggable rotation rings, distinct from the corner orientation indicator)', {
      // Three draggable THREE.TorusGeometry rings (red=X, green=Y, blue=Z,
      // matching the corner-indicator's own color convention) sized to
      // rootId's current world bounding sphere and centered on it — shown
      // while exactly one rotatable instance is selected (Workspace/
      // Assembly decide eligibility; this just renders/hit-tests whatever
      // rootId it's told to). Deliberately drawn in the MAIN scene (unlike
      // the fixed-size corner gizmo) so the rings scale and move with the
      // actual selected shape.
      showRotationGizmo: function (rootId) {
        this.hideRotationGizmo();
        var entry = this._meshes[rootId];
        if (!entry || !this._three) return;
        var THREE = this._three.THREE;
        var sphere = new THREE.Box3().setFromObject(entry.mesh).getBoundingSphere(new THREE.Sphere());
        if (!sphere || sphere.radius === 0) return;
        var radius = sphere.radius * 1.3;
        var tube = Math.max(radius * 0.035, 0.05);

        function makeRing(color, axis) {
          var geometry = new THREE.TorusGeometry(radius, tube, 8, 64);
          var material = new THREE.MeshBasicMaterial({ color: color, depthTest: false, transparent: true, opacity: 0.9 });
          var ring = new THREE.Mesh(geometry, material);
          ring.renderOrder = 999;
          ring.userData.rotateAxis = axis;
          return ring;
        }

        // TorusGeometry lies flat in its own local XY plane (hole along
        // local Z) — rotate each ring so its plane is perpendicular to the
        // axis it represents (i.e. its hole points along that world axis).
        var ringX = makeRing(0xff4444, 'x'); ringX.rotation.y = Math.PI / 2;
        var ringY = makeRing(0x44dd44, 'y'); ringY.rotation.x = Math.PI / 2;
        var ringZ = makeRing(0x4488ff, 'z'); // default orientation already faces Z

        [ringX, ringY, ringZ].forEach(function (ring) { ring.position.copy(sphere.center); });

        this._three.scene.add(ringX, ringY, ringZ);
        this._rotationGizmo = { rootId: rootId, rings: { x: ringX, y: ringY, z: ringZ }, center: sphere.center.clone(), radius: radius };
        this._render();
      },

      hideRotationGizmo: function () {
        if (!this._rotationGizmo) return;
        var self = this;
        Object.keys(this._rotationGizmo.rings).forEach(function (axis) {
          var ring = self._rotationGizmo.rings[axis];
          self._three.scene.remove(ring);
          ring.geometry.dispose();
          ring.material.dispose();
        });
        this._rotationGizmo = null;
        this._render();
      },

      // The world-space point the rings are currently centered on (the
      // pivot RotateTool rotates around) — null if no gizmo is shown.
      getRotationGizmoCenter: function () {
        return this._rotationGizmo ? this._rotationGizmo.center.clone() : null;
      },

      // Returns 'x'|'y'|'z' for whichever ring is under (clientX, clientY),
      // or null. Only raycasts the three ring meshes, never the shape
      // itself — a click that also happens to pass through the shape
      // shouldn't be mistaken for a ring grab.
      pickRotationRing: function (clientX, clientY) {
        if (!this._three || !this._rotationGizmo) return null;
        var THREE = this._three.THREE;
        var canvas = this._three.renderer.domElement;
        var rect = canvas.getBoundingClientRect();
        var ndc = new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1
        );
        var raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, this._three.camera);
        var rings = this._rotationGizmo.rings;
        var objects = [rings.x, rings.y, rings.z];
        var hits = raycaster.intersectObjects(objects);
        if (hits.length === 0) return null;
        return hits[0].object.userData.rotateAxis;
      },
    });

  });
