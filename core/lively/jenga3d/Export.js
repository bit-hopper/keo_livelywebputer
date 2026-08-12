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

      // featureTree: a lively.jenga3d.FeatureTree instance. thenDo(err, text).
      toSTL: function (featureTree, thenDo) {
        this._buildExportMesh(featureTree, function (err, mesh) {
          if (err) return thenDo(err);
          var exporter = new window.jenga3dDeps.STLExporter();
          var text = exporter.parse(mesh, { binary: false });
          mesh.geometry.dispose();
          mesh.material.dispose();
          thenDo(null, text);
        });
      },

      toOBJ: function (featureTree, thenDo) {
        this._buildExportMesh(featureTree, function (err, mesh) {
          if (err) return thenDo(err);
          var exporter = new window.jenga3dDeps.OBJExporter();
          var text = exporter.parse(mesh);
          mesh.geometry.dispose();
          mesh.material.dispose();
          thenDo(null, text);
        });
      },

      downloadSTL: function (featureTree, filename, thenDo) {
        this.toSTL(featureTree, function (err, text) {
          if (err) { if (thenDo) thenDo(err); return; }
          lively.jenga3d.Export._triggerDownload(filename || 'model.stl', text, 'model/stl');
          if (thenDo) thenDo(null, text);
        });
      },

      downloadOBJ: function (featureTree, filename, thenDo) {
        this.toOBJ(featureTree, function (err, text) {
          if (err) { if (thenDo) thenDo(err); return; }
          lively.jenga3d.Export._triggerDownload(filename || 'model.obj', text, 'model/obj');
          if (thenDo) thenDo(null, text);
        });
      },

      // §11.2, §13 step 12: real worker op, real B-Rep — no throwaway
      // THREE.Mesh involved at all, unlike toSTL/toOBJ. thenDo(err, bytes)
      // where bytes is a Uint8Array of the STEP file's ASCII/UTF-8 text.
      toSTEP: function (featureTree, thenDo) {
        if (!featureTree.root) { thenDo(new Error('lively.jenga3d.Export: feature tree has no root')); return; }
        lively.jenga3d.Worker.request(featureTree.root, 'exportStep', {
          featureTree: featureTree.toJSON(),
          dirtyNodeId: featureTree.root,
        }, function (err, result) {
          if (err) return thenDo(err);
          thenDo(null, result.fileBytes);
        });
      },

      downloadStep: function (featureTree, filename, thenDo) {
        this.toSTEP(featureTree, function (err, bytes) {
          if (err) { if (thenDo) thenDo(err); return; }
          lively.jenga3d.Export._triggerDownload(filename || 'model.step', bytes, 'model/step');
          if (thenDo) thenDo(null, bytes);
        });
      },

      // One more worker "evaluate" at the Export deflection tier (§9.1) —
      // not whatever a Viewport happens to currently display, since a
      // fresh export should reflect the tree's current state exactly and
      // use the tighter export-quality deflection, matching §11.1.
      _buildExportMesh: function (featureTree, thenDo) {
        if (!featureTree.root) { thenDo(new Error('lively.jenga3d.Export: feature tree has no root')); return; }
        this._ensureThreeRuntime(function () {
          lively.jenga3d.Worker.request(featureTree.root, 'evaluate', {
            featureTree: featureTree.toJSON(),
            dirtyNodeId: featureTree.root,
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
