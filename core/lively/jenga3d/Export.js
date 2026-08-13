/**
 * lively.jenga3d.Export
 *
 * STL/OBJ export (Jenga3Dspec_v0.md §11.1, §13 step 11). Per the spec:
 * "Export requests one more evaluate call at the Export deflection tier
 * (§9.1) rather than the Interactive tier... the only difference from a
 * normal display refresh. The resulting buffers are assembled into a
 * throwaway THREE.Mesh on the main thread and handed to Three.js's own
 * STLExporter/OBJExporter... No new worker code needed beyond what §4.5
 * already provides." That's exactly what this does — no worker changes
 * in this step.
 *
 * §13 step 12 adds `toSTEP`/`downloadStep` — unlike STL/OBJ, this is a
 * real worker op (`exportStep`, §11.2, §6.4): the exact B-Rep, not a
 * mesh conversion, so there's no throwaway-mesh step here at all — the
 * worker hands back file bytes directly. `exportIges` is intentionally
 * not exposed here: the spec names it in the protocol but says build it
 * only once something downstream needs it, and occt-worker-src.js's own
 * "exportIges" handler always errors for the same reason.
 *
 * §14.2/§14.9 (multi-instance): every export function now takes an
 * explicit `rootId` — "the tree's one root" no longer exists once a tree
 * can hold several independently-visible instances (§14.9: "per-instance
 * export (one FeatureTree root in, one file out) — accurate as
 * originally built and still exactly how a single-instance export
 * works"). `toSTLAssembly`/`toOBJAssembly`/`toSTEPAssembly` are the new
 * whole-assembly counterparts, merging every current instance into one
 * file (§14.9) — confirmed empirically (not assumed) that three's
 * `STLExporter`/`OBJExporter` both call `object.traverse(...)` internally
 * and so accept a `THREE.Group` of several meshes directly; no
 * `BufferGeometryUtils.mergeGeometries` fallback is needed.
 *
 * A plain utility object, not a class — matches `lively.jenga3d.Worker`/
 * `lively.jenga3d.PickIndex`'s "capitalized, used directly" shape, since
 * export has no per-instance state of its own.
 *
 * `toSTL`/`toOBJ`/`toSTEP` produce content only (easy to verify without
 * touching the DOM); `downloadSTL`/`downloadOBJ`/`downloadStep` are the
 * convenience wrappers that also trigger a real browser download, kept
 * as a thin separate layer so the actual export logic is testable on
 * its own.
 */

module('lively.jenga3d.Export')
  .requires('lively.jenga3d.FeatureTree', 'lively.jenga3d.Worker')
  .toRun(function () {

    lively.jenga3d.Export = {

      // featureTree: a lively.jenga3d.FeatureTree instance. rootId: the
      // instance to export. thenDo(err, text).
      toSTL: function (featureTree, rootId, thenDo) {
        this._buildExportMesh(featureTree, rootId, function (err, mesh) {
          if (err) return thenDo(err);
          var exporter = new window.jenga3dDeps.STLExporter();
          var text = exporter.parse(mesh, { binary: false });
          mesh.geometry.dispose();
          mesh.material.dispose();
          thenDo(null, text);
        });
      },

      toOBJ: function (featureTree, rootId, thenDo) {
        this._buildExportMesh(featureTree, rootId, function (err, mesh) {
          if (err) return thenDo(err);
          var exporter = new window.jenga3dDeps.OBJExporter();
          var text = exporter.parse(mesh);
          mesh.geometry.dispose();
          mesh.material.dispose();
          thenDo(null, text);
        });
      },

      downloadSTL: function (featureTree, rootId, filename, thenDo) {
        this.toSTL(featureTree, rootId, function (err, text) {
          if (err) { if (thenDo) thenDo(err); return; }
          lively.jenga3d.Export._triggerDownload(filename || 'model.stl', text, 'model/stl');
          if (thenDo) thenDo(null, text);
        });
      },

      downloadOBJ: function (featureTree, rootId, filename, thenDo) {
        this.toOBJ(featureTree, rootId, function (err, text) {
          if (err) { if (thenDo) thenDo(err); return; }
          lively.jenga3d.Export._triggerDownload(filename || 'model.obj', text, 'model/obj');
          if (thenDo) thenDo(null, text);
        });
      },

      // §11.2, §13 step 12: real worker op, real B-Rep — no throwaway
      // THREE.Mesh involved at all, unlike toSTL/toOBJ. thenDo(err, bytes)
      // where bytes is a Uint8Array of the STEP file's ASCII/UTF-8 text.
      toSTEP: function (featureTree, rootId, thenDo) {
        if (!featureTree.getNode(rootId)) { thenDo(new Error('lively.jenga3d.Export: unknown rootId: ' + rootId)); return; }
        lively.jenga3d.Worker.request(rootId, 'exportStep', {
          featureTree: featureTree.toJSONForRoot(rootId),
          dirtyNodeId: rootId,
        }, function (err, result) {
          if (err) return thenDo(err);
          thenDo(null, result.fileBytes);
        });
      },

      downloadStep: function (featureTree, rootId, filename, thenDo) {
        this.toSTEP(featureTree, rootId, function (err, bytes) {
          if (err) { if (thenDo) thenDo(err); return; }
          lively.jenga3d.Export._triggerDownload(filename || 'model.step', bytes, 'model/step');
          if (thenDo) thenDo(null, bytes);
        });
      },

      // One more worker "evaluate" at the Export deflection tier (§9.1) —
      // not whatever a Viewport happens to currently display, since a
      // fresh export should reflect the tree's current state exactly and
      // use the tighter export-quality deflection, matching §11.1.
      _buildExportMesh: function (featureTree, rootId, thenDo) {
        if (!featureTree.getNode(rootId)) { thenDo(new Error('lively.jenga3d.Export: unknown rootId: ' + rootId)); return; }
        this._ensureThreeRuntime(function () {
          lively.jenga3d.Worker.request(rootId, 'evaluate', {
            featureTree: featureTree.toJSONForRoot(rootId),
            dirtyNodeId: rootId,
            deflection: lively.jenga3d.Worker.DEFLECTION.export,
          }, function (err, meshData) {
            if (err) return thenDo(err);
            var THREE = window.jenga3dDeps.THREE;
            var geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
            geometry.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
            geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
            var mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
            thenDo(null, mesh);
          });
        });
      },

      // ─── Whole-assembly export (§14.9, §13 step 21) ──────────────────
      // Merges every current instance's export-tier mesh into one
      // THREE.Group before handing it to STLExporter/OBJExporter — both
      // confirmed (see file doc) to traverse an arbitrary Object3D, so no
      // separate geometry-merge step is needed.
      toSTLAssembly: function (featureTree, thenDo) {
        this._buildExportGroup(featureTree, function (err, group) {
          if (err) return thenDo(err);
          var exporter = new window.jenga3dDeps.STLExporter();
          var text = exporter.parse(group, { binary: false });
          lively.jenga3d.Export._disposeGroup(group);
          thenDo(null, text);
        });
      },

      toOBJAssembly: function (featureTree, thenDo) {
        this._buildExportGroup(featureTree, function (err, group) {
          if (err) return thenDo(err);
          var exporter = new window.jenga3dDeps.OBJExporter();
          var text = exporter.parse(group);
          lively.jenga3d.Export._disposeGroup(group);
          thenDo(null, text);
        });
      },

      downloadSTLAssembly: function (featureTree, filename, thenDo) {
        this.toSTLAssembly(featureTree, function (err, text) {
          if (err) { if (thenDo) thenDo(err); return; }
          lively.jenga3d.Export._triggerDownload(filename || 'assembly.stl', text, 'model/stl');
          if (thenDo) thenDo(null, text);
        });
      },

      downloadOBJAssembly: function (featureTree, filename, thenDo) {
        this.toOBJAssembly(featureTree, function (err, text) {
          if (err) { if (thenDo) thenDo(err); return; }
          lively.jenga3d.Export._triggerDownload(filename || 'assembly.obj', text, 'model/obj');
          if (thenDo) thenDo(null, text);
        });
      },

      // §14.3/§14.9: the one op whose params.featureTree genuinely
      // carries `roots` (plural) — the worker evaluates every root's
      // final shape within one request-scoped Disposer and combines them
      // into a single TopoDS_Compound before writing STEP (occt-worker-
      // src.js's exportStepAssembly).
      toSTEPAssembly: function (featureTree, thenDo) {
        var roots = featureTree.getRoots();
        if (roots.length === 0) { thenDo(new Error('lively.jenga3d.Export: feature tree has no instances')); return; }
        lively.jenga3d.Worker.request('__assembly__', 'exportStepAssembly', {
          featureTree: featureTree.toJSON(),
        }, function (err, result) {
          if (err) return thenDo(err);
          thenDo(null, result.fileBytes);
        });
      },

      downloadStepAssembly: function (featureTree, filename, thenDo) {
        this.toSTEPAssembly(featureTree, function (err, bytes) {
          if (err) { if (thenDo) thenDo(err); return; }
          lively.jenga3d.Export._triggerDownload(filename || 'assembly.step', bytes, 'model/step');
          if (thenDo) thenDo(null, bytes);
        });
      },

      _buildExportGroup: function (featureTree, thenDo) {
        var roots = featureTree.getRoots();
        if (roots.length === 0) { thenDo(new Error('lively.jenga3d.Export: feature tree has no instances')); return; }
        this._ensureThreeRuntime(function () {
          var THREE = window.jenga3dDeps.THREE;
          var group = new THREE.Group();
          var remaining = roots.length;
          var failed = null;
          roots.forEach(function (rootId) {
            lively.jenga3d.Export._buildExportMesh(featureTree, rootId, function (err, mesh) {
              if (failed) return; // an earlier root already failed this batch
              if (err) { failed = err; thenDo(err); return; }
              group.add(mesh);
              remaining--;
              if (remaining === 0) thenDo(null, group);
            });
          });
        });
      },

      _disposeGroup: function (group) {
        group.children.forEach(function (mesh) {
          mesh.geometry.dispose();
          mesh.material.dispose();
        });
      },

      // Lazy-loads core/lib/jenga3d/jenga3d-deps.js — export can be
      // called with no Viewport ever having been opened (e.g. exporting
      // straight from a headless-ish flow), so this can't assume some
      // other module already triggered the load. Same guard/poll shape
      // as Viewport.js's own _ensureThreeRuntime (and LocalMap.js's
      // _ensureGeoRuntime before it) — intentionally duplicated rather
      // than shared, matching this codebase's existing tolerance for
      // small per-module copies of this pattern.
      _ensureThreeRuntime: function (callback) {
        if (window.jenga3dDeps && window.jenga3dDeps.STLExporter) return callback();
        if (window._jenga3dDepsLoading) {
          var poll = setInterval(function () {
            if (window.jenga3dDeps && window.jenga3dDeps.STLExporter) { clearInterval(poll); callback(); }
          }, 80);
          return;
        }
        window._jenga3dDepsLoading = true;
        var s = document.createElement('script');
        s.src = '/core/lib/jenga3d/jenga3d-deps.js';
        s.onload = function () { window._jenga3dDepsLoading = false; callback(); };
        s.onerror = function () {
          window._jenga3dDepsLoading = false;
          console.error('[lively.jenga3d.Export] failed to load jenga3d-deps.js');
        };
        document.head.appendChild(s);
      },

      _triggerDownload: function (filename, content, mimeType) {
        var blob = new Blob([content], { type: mimeType });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      },

    };

  });
