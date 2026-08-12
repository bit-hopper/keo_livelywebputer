/**
 * lively.jenga3d.PickIndex
 *
 * Resolves a `THREE.Raycaster` hit back to the OCCT topology index the
 * worker recorded for it, via the `BufferGeometry.groups` ranges
 * `Viewport.setMesh` builds from the worker's per-face `groups` (§4.3,
 * §9.3, §10, §13 step 8) — and, since §13 step 10, the same mechanism
 * reused for per-edge groups on the edge-overlay `LineSegments` geometry
 * (§7.3's edge selectors).
 *
 * A plain utility object, not a class — this is a pure function over a
 * geometry + an index-buffer offset, with no state of its own, matching
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
        if (faceIndex == null) return null;
        // §10: a raycaster faceIndex counts triangles, not raw index-array
        // entries — 3 entries (one per vertex) per triangle.
        var found = this.resolveOffset(geometry, faceIndex * 3);
        return found ? { occtFaceIndex: found.value, groupIndex: found.groupIndex } : null;
      },

      // §13 step 10: same range-search as resolve, generalized to any
      // per-group index-buffer offset and any group payload field name —
      // resolve() is the faceIndex*3/occtFaceIndex special case of this,
      // Viewport.pickEdgeAt's occtEdgeIndex lookup is the other.
      // Returns { value, groupIndex } or null.
      resolveOffset: function (geometry, offset, valueField) {
        if (offset == null || !geometry || !geometry.groups) return null;
        valueField = valueField || 'occtFaceIndex';
        var groups = geometry.groups;
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i];
          if (offset >= g.start && offset < g.start + g.count) {
            return { value: g[valueField], groupIndex: i };
          }
        }
        return null;
      },

    };

  });
