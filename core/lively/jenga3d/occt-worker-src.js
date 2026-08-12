/**
 * core/lively/jenga3d/occt-worker-src.js
 *
 * Source for Jenga3D's dedicated OCCT worker (Jenga3Dspec_v0.md §4, §13
 * step 2) — esbuilt by scripts/build-jenga3d-libs.js into
 * core/lib/jenga3d/occt-worker.js, the actual file `new Worker(...)` loads.
 * Deliberately NOT a Lively module (§4.1): does not bootstrap
 * LivelyLoader, has no `module()`/`toRun()` wrapper, and is never loaded
 * through anything but the raw Worker constructor.
 *
 * This build gets its own dedicated esbuild bundle rather than reusing
 * core/lib/jenga3d/jenga3d-deps.js (the three+OCCT-glue combo §3
 * describes) — the worker never touches `three` (it returns raw typed
 * arrays per the protocol below; only the main-thread Viewport renders
 * with THREE), and jenga3d-deps.js is built as `window.jenga3dDeps`,
 * which doesn't exist in a worker's global scope (`self`, not `window`) —
 * loading it here via importScripts would throw. Shipping three's ~600KB
 * into a worker that never uses it would also cut against §4.1's whole
 * reason for a dedicated lean worker. Documented as a deviation from §3's
 * literal wording in Jenga3Dspec_v0.md itself, same pattern the doc uses
 * for its own acknowledged reinterpretations.
 *
 * Step 2 scope: only createBox/createCylinder/createSphere/transform
 * nodes (§7.2) and the "evaluate" op (§4.3) are implemented. Booleans,
 * fillet/chamfer, and exportStep/exportIges arrive in later steps (§13
 * steps 9, 10, 12) — an unsupported op or node op returns an error
 * response rather than throwing uncaught.
 *
 * Feature tree JSON envelope (not pinned elsewhere in the spec before
 * this): { root: nodeId, nodes: { [nodeId]: { op, params } } } — operand
 * references live inside params using the exact field names §7.2's table
 * already gives them (transform's `of`, booleanUnion's `a`/`b`, etc.), so
 * no separate operand list is needed.
 */

import initOpenCascade from 'opencascade.js/dist/opencascade.full.js';

// ─── Disposer (§6.1) ────────────────────────────────────────────────────

function Disposer() {
  this._tracked = [];
}
Disposer.prototype.track = function (occtObject) {
  this._tracked.push(occtObject);
  return occtObject;
};
Disposer.prototype.disposeAll = function () {
  for (var i = this._tracked.length - 1; i >= 0; i--) {
    try { this._tracked[i]['delete'](); } catch (e) { /* not disposable / already gone */ }
  }
  this._tracked.length = 0;
};

// ─── OCCT init, once per worker lifetime (§4.4) ────────────────────────

var occtReady = null;
function ensureOcct() {
  if (!occtReady) {
    occtReady = initOpenCascade({
      locateFile: function (path) {
        if (path.endsWith('.wasm')) return './occt.wasm';
        return path;
      }
    });
  }
  return occtReady;
}

// ─── Feature-tree evaluation, bottom-up (§4.5) ─────────────────────────
// Step 2: primitive + transform nodes only.

function buildNode(oc, disposer, nodeId, tree, cache) {
  if (cache[nodeId]) return cache[nodeId];
  var node = tree.nodes[nodeId];
  if (!node) throw new Error('unknown nodeId: ' + nodeId);

  var shape;
  switch (node.op) {
    case 'createBox': {
      var p = node.params;
      var mk = disposer.track(new oc.BRepPrimAPI_MakeBox_2(p.width, p.height, p.depth));
      shape = disposer.track(mk.Shape());
      break;
    }
    case 'createCylinder': {
      var p = node.params;
      var mk = disposer.track(new oc.BRepPrimAPI_MakeCylinder_1(p.radius, p.height));
      shape = disposer.track(mk.Shape());
      break;
    }
    case 'createSphere': {
      var p = node.params;
      var mk = disposer.track(new oc.BRepPrimAPI_MakeSphere_1(p.radius));
      shape = disposer.track(mk.Shape());
      break;
    }
    case 'transform': {
      var p = node.params;
      var operandShape = buildNode(oc, disposer, p.of, tree, cache);
      shape = applyTransform(oc, disposer, operandShape, p);
      break;
    }
    default:
      throw new Error('op not supported yet: ' + node.op);
  }

  cache[nodeId] = shape;
  return shape;
}

// Scale/rotate about the local origin, then translate — standard TRS
// order. Only uniform scale is meaningful here (§7.2 doesn't specify
// non-uniform scale semantics); rotate is XYZ Euler radians, applied as
// three sequential axis rotations rather than composed via quaternion —
// simple and sufficient for v1's primitive/transform scope.
function applyTransform(oc, disposer, shape, p) {
  var scale = p.scale || [1, 1, 1];
  var rotate = p.rotate || [0, 0, 0];
  var translate = p.translate || [0, 0, 0];
  var current = shape;

  if (scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1) {
    var scaleTrsf = disposer.track(new oc.gp_Trsf_1());
    scaleTrsf.SetScale(new oc.gp_Pnt_3(0, 0, 0), scale[0]);
    var scaled = disposer.track(new oc.BRepBuilderAPI_Transform_2(current, scaleTrsf, true));
    current = disposer.track(scaled.Shape());
  }

  if (rotate[0] !== 0) current = rotateAboutAxis(oc, disposer, current, [1, 0, 0], rotate[0]);
  if (rotate[1] !== 0) current = rotateAboutAxis(oc, disposer, current, [0, 1, 0], rotate[1]);
  if (rotate[2] !== 0) current = rotateAboutAxis(oc, disposer, current, [0, 0, 1], rotate[2]);

  if (translate[0] !== 0 || translate[1] !== 0 || translate[2] !== 0) {
    var transTrsf = disposer.track(new oc.gp_Trsf_1());
    transTrsf.SetTranslation_1(new oc.gp_Vec_4(translate[0], translate[1], translate[2]));
    var translated = disposer.track(new oc.BRepBuilderAPI_Transform_2(current, transTrsf, true));
    current = disposer.track(translated.Shape());
  }

  return current;
}

function rotateAboutAxis(oc, disposer, shape, axisVec, angleRad) {
  var trsf = disposer.track(new oc.gp_Trsf_1());
  var axis = disposer.track(new oc.gp_Ax1_2(
    new oc.gp_Pnt_3(0, 0, 0),
    new oc.gp_Dir_4(axisVec[0], axisVec[1], axisVec[2])
  ));
  trsf.SetRotation_1(axis, angleRad);
  var rotated = disposer.track(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true));
  return disposer.track(rotated.Shape());
}

// ─── Meshing + triangulation extraction (§9.2, §9.3, §10) ──────────────

function extractMesh(oc, disposer, shape, deflection) {
  var meshOp = disposer.track(new oc.BRepMesh_IncrementalMesh_2(
    shape, deflection.linear, false, deflection.angular, true
  ));
  if (!meshOp.IsDone()) throw new Error('BRepMesh_IncrementalMesh did not complete');

  var positions = [];
  var normals = [];
  var indices = [];
  var groups = [];

  var explorer = disposer.track(new oc.TopExp_Explorer_2(
    shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  ));
  var occtFaceIndex = 0;
  for (; explorer.More(); explorer.Next()) {
    occtFaceIndex++;
    var face = oc.TopoDS.Face_1(explorer.Current());
    var location = disposer.track(new oc.TopLoc_Location_1());
    var triHandle = oc.BRep_Tool.Triangulation(face, location, 0);
    if (triHandle.IsNull()) continue; // §9.3: skip faces with no triangulation

    var tri = triHandle.get();
    if (!tri.HasNormals()) tri.ComputeNormals();

    // §9.2: OCCT's own orientation flag on the face, not the underlying
    // triangulation, tells us whether to flip winding. Empirically
    // confirmed (not assumed) that ComputeNormals()'s output does NOT
    // already account for this — a reversed face's computed normals point
    // inward, so they need negating along with the index flip below.
    var isReversed = face.Orientation_1().value === oc.TopAbs_Orientation.TopAbs_REVERSED.value;
    var trsf = location.Transformation();

    var nbNodes = tri.NbNodes();
    var vertexOffset = positions.length / 3;
    for (var i = 1; i <= nbNodes; i++) {
      var pnt = tri.Node(i).Transformed(trsf);
      positions.push(pnt.X(), pnt.Y(), pnt.Z());
      var nrm = tri.Normal_1(i);
      var sign = isReversed ? -1 : 1;
      normals.push(sign * nrm.X(), sign * nrm.Y(), sign * nrm.Z());
    }

    var groupStart = indices.length;
    var nbTriangles = tri.NbTriangles();
    for (var t = 1; t <= nbTriangles; t++) {
      var triangle = tri.Triangle(t);
      var i1 = triangle.Value(1) - 1 + vertexOffset;
      var i2 = triangle.Value(2) - 1 + vertexOffset;
      var i3 = triangle.Value(3) - 1 + vertexOffset;
      if (isReversed) indices.push(i1, i3, i2);
      else indices.push(i1, i2, i3);
    }
    groups.push({ start: groupStart, count: indices.length - groupStart, occtFaceIndex: occtFaceIndex });
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    groups: groups
  };
}

// ─── Protocol (§4.3) ────────────────────────────────────────────────────

function handleEvaluate(oc, msg) {
  var disposer = new Disposer();
  try {
    var cache = {};
    var rootShape = buildNode(oc, disposer, msg.params.featureTree.root, msg.params.featureTree, cache);
    var mesh = extractMesh(oc, disposer, rootShape, msg.params.deflection);
    disposer.disposeAll();
    return {
      id: msg.id, nodeId: msg.nodeId, generation: msg.generation, ok: true,
      positions: mesh.positions, normals: mesh.normals, indices: mesh.indices,
      groups: mesh.groups
    };
  } catch (e) {
    disposer.disposeAll();
    return {
      id: msg.id, nodeId: msg.nodeId, generation: msg.generation, ok: false,
      error: e && e.message || String(e)
    };
  }
}

self.onmessage = function (evt) {
  var msg = evt.data;
  ensureOcct().then(function (oc) {
    var response;
    if (msg.op === 'evaluate') {
      response = handleEvaluate(oc, msg);
    } else {
      response = {
        id: msg.id, nodeId: msg.nodeId, generation: msg.generation, ok: false,
        error: 'op not supported yet: ' + msg.op
      };
    }
    var transferables = response.ok
      ? [response.positions.buffer, response.normals.buffer, response.indices.buffer]
      : [];
    self.postMessage(response, transferables);
  });
};
