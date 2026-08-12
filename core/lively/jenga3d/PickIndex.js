/**
 * lively.jenga3d.PickIndex
 *
 * Resolves a `THREE.Raycaster` hit's `faceIndex` (a generic triangle
 * index — Three.js has no notion of "this is OCCT Face 3") back to the
 * `occtFaceIndex` the worker recorded for that triangle's face, via the
 * `BufferGeometry.groups` ranges `Viewport.setMesh` builds from the
 * worker's per-face `groups` (§4.3, §9.3, §10, §13 step 8).
 *
 * A plain utility object, not a class — this is a pure function over a
 * geometry + a triangle index, with no state of its own, matching
 * `lively.jenga3d.Worker`'s own "capitalized, used directly" shape
 * (core/lively/jenga3d/Worker.js) rather than an Object.subclass.
 */

module('lively.jenga3d.PickIndex')
  .requires()
  .toRun(function () {

    lively.jenga3d.PickIndex = {

      // geometry: a THREE.BufferGeometry with .groups populated as
      // { start, count, materialIndex, occtFaceIndex } per group.
      // faceIndex: a raycaster hit's .faceIndex (triangle index, 0-based).
      // Returns { occtFaceIndex, groupIndex } or null if unresolved
      // (no groups, or faceIndex outside every group's range).
      resolve: function (geometry, faceIndex) {
        if (faceIndex == null || !geometry || !geometry.groups) return null;
        // §10: a raycaster faceIndex counts triangles, not raw index-array
        // entries — 3 entries (one per vertex) per triangle.
        var triangleOffset = faceIndex * 3;
        var groups = geometry.groups;
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i];
          if (triangleOffset >= g.start && triangleOffset < g.start + g.count) {
            return { occtFaceIndex: g.occtFaceIndex, groupIndex: i };
          }
        }
        return null;
      },

    };

  });
