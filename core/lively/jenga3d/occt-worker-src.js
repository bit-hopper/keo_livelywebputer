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
 * Node ops implemented so far: createBox/createCylinder/createSphere/
 * transform (§13 step 2), booleanUnion/booleanCut/booleanIntersect (§13
 * step 9), and fillet/chamfer (§13 step 10). Any unrecognized node op
 * returns an error response rather than throwing uncaught.
 *
 * Protocol ops: "evaluate" (§4.3) and, since §13 step 12, "exportStep"
 * — the real B-Rep path (§11.2, §6.4): replay the tree the same way
 * evaluate does, but instead of meshing, feed the final shape straight
 * to STEPControl_Writer and return the written file's bytes.
 * "exportIges" is named in the protocol (§4.3) and in §11.2 but
 * deliberately not implemented — the spec itself says to build it only
 * once something downstream actually needs it, not speculatively; it
 * returns a clear "not implemented" error rather than pretending to
 * work. Same reasoning NAMESPACE.md already applies to /files/ and
 * /settings.
 *
 * §14.3/§14.9, §13 step 21: "exportStepAssembly" — the one op whose
 * `params.featureTree` genuinely carries `roots` (plural) instead of a
 * single `root`, for combined multi-instance STEP export. Evaluates every
 * root's final shape within one request-scoped Disposer, combines them
 * into a single `TopoDS_Compound` (`BRep_Builder.MakeCompound` + `.Add`
 * per shape — confirmed empirically that no `BRepBuilderAPI_MakeCompound`
 * class exists, unlike what an unverified reading of the spec's own
 * wording would suggest), then writes STEP exactly as "exportStep" does
 * for one shape.
 *
 * §13 step 10 also adds `edges` to the evaluate response — straight-line
 * (start/end vertex only) approximations of every edge in the root
 * shape, 1-based indexed the same way occtFaceIndex is, for the
 * edge-selection UI's picking overlay (§7.3, §10). v1 scope, matching
 * CreateBoxTool/EditHandleTool's box-only precedent elsewhere in this
 * project: only edges with exactly two distinct endpoint vertices are
 * included — closed/circular edges (a cylinder's rim, a fillet's own new
 * rounded edges) have no meaningful two-point line approximation and are
 * silently omitted from the overlay, not just approximated as a chord.
 * Revisit if picking a curved edge turns out to matter in practice.
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
    case 'booleanUnion':
      shape = buildBoolean(oc, disposer, node.params, tree, cache, 'BRepAlgoAPI_Fuse_3');
      break;
    case 'booleanCut':
      shape = buildBoolean(oc, disposer, node.params, tree, cache, 'BRepAlgoAPI_Cut_3');
      break;
    case 'booleanIntersect':
      shape = buildBoolean(oc, disposer, node.params, tree, cache, 'BRepAlgoAPI_Common_3');
      break;
    case 'fillet':
    case 'chamfer':
      shape = buildFilletOrChamfer(oc, disposer, node.op, node.params, tree, cache);
      break;
    default:
      throw new Error('op not supported yet: ' + node.op);
  }

  cache[nodeId] = shape;
  return shape;
}

// §13 step 9: booleanUnion/Cut/Intersect (§7.2) each consume two already-
// built operand shapes per §4.5's bottom-up walk. The two-shape
// convenience constructors (BRepAlgoAPI_Fuse/Cut/Common's "_3" overload)
// compute the result immediately — confirmed empirically (IsDone() true
// right after construction, no separate .Build() call needed) rather
// than assumed from the .d.ts, same discipline as every other OCCT call
// in this file. Message_ProgressRange_1() is OCCT's "no progress
// reporting needed" default, required by the constructor signature but
// otherwise unused here.
function buildBoolean(oc, disposer, params, tree, cache, ctorName) {
  var shapeA = buildNode(oc, disposer, params.a, tree, cache);
  var shapeB = buildNode(oc, disposer, params.b, tree, cache);
  var range = disposer.track(new oc.Message_ProgressRange_1());
  var op = disposer.track(new oc[ctorName](shapeA, shapeB, range));
  if (!op.IsDone()) throw new Error(ctorName + ' did not complete');
  return disposer.track(op.Shape());
}

// §13 step 10, §7.3: `edges` is a list of index-based selectors
// { operandNodeId, kind: 'edge', index } — operandNodeId is unused here
// (it's always `of`, kept in the selector for the general shape §7.3
// describes); `index` is validated against `of`'s own edge explorer at
// evaluation time and the whole node fails loudly if it's out of range,
// rather than silently filleting whatever now sits at that index.
// BRepFilletAPI_MakeFillet/MakeChamfer both need an explicit .Build()
// after .Add()-ing edges — confirmed empirically, unlike the boolean
// ops' two-shape constructor, which computes immediately.
function buildFilletOrChamfer(oc, disposer, op, params, tree, cache) {
  var ofShape = buildNode(oc, disposer, params.of, tree, cache);

  var edgeExplorer = disposer.track(new oc.TopExp_Explorer_2(
    ofShape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  ));
  var edgesByIndex = {};
  var edgeCount = 0;
  for (; edgeExplorer.More(); edgeExplorer.Next()) {
    edgeCount++;
    edgesByIndex[edgeCount] = oc.TopoDS.Edge_1(edgeExplorer.Current());
  }

  var isFillet = op === 'fillet';
  var mk = isFillet
    ? disposer.track(new oc.BRepFilletAPI_MakeFillet(ofShape, oc.ChFi3d_FilletShape.ChFi3d_Rational))
    : disposer.track(new oc.BRepFilletAPI_MakeChamfer(ofShape));
  var amount = isFillet ? params.radius : params.distance;

  params.edges.forEach(function (selector) {
    if (selector.index < 1 || selector.index > edgeCount) {
      throw new Error(
        'edge selector index ' + selector.index + ' out of range (of has ' +
        edgeCount + ' edges) — an upstream edit changed the operand; re-selection needed'
      );
    }
    mk.Add_2(amount, edgesByIndex[selector.index]);
  });

  var range = disposer.track(new oc.Message_ProgressRange_1());
  mk.Build(range);
  if (!mk.IsDone()) throw new Error((isFillet ? 'fillet' : 'chamfer') + ' did not complete');
  return disposer.track(mk.Shape());
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

// ─── Edge extraction (§7.3, §10, §13 step 10) ──────────────────────────

function extractEdges(oc, disposer, shape) {
  var edges = [];
  var explorer = disposer.track(new oc.TopExp_Explorer_2(
    shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  ));
  var index = 0;
  for (; explorer.More(); explorer.Next()) {
    index++;
    var edge = oc.TopoDS.Edge_1(explorer.Current());
    var vertexExplorer = disposer.track(new oc.TopExp_Explorer_2(
      edge, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE
    ));
    var points = [];
    for (; vertexExplorer.More(); vertexExplorer.Next()) {
      var v = oc.TopoDS.Vertex_1(vertexExplorer.Current());
      var p = oc.BRep_Tool.Pnt(v);
      points.push([p.X(), p.Y(), p.Z()]);
    }
    // v1 scope (see file doc): only straight edges with two distinct
    // endpoints are picked up; closed/circular edges are skipped.
    if (points.length === 2) edges.push({ index: index, a: points[0], b: points[1] });
  }
  return edges;
}

// ─── Protocol (§4.3) ────────────────────────────────────────────────────

function handleEvaluate(oc, msg) {
  var disposer = new Disposer();
  try {
    var cache = {};
    var rootShape = buildNode(oc, disposer, msg.params.featureTree.root, msg.params.featureTree, cache);
    var mesh = extractMesh(oc, disposer, rootShape, msg.params.deflection);
    var edges = extractEdges(oc, disposer, rootShape);
    disposer.disposeAll();
    return {
      id: msg.id, nodeId: msg.nodeId, generation: msg.generation, ok: true,
      positions: mesh.positions, normals: mesh.normals, indices: mesh.indices,
      groups: mesh.groups, edges: edges
    };
  } catch (e) {
    disposer.disposeAll();
    return {
      id: msg.id, nodeId: msg.nodeId, generation: msg.generation, ok: false,
      error: e && e.message || String(e)
    };
  }
}

// §11.2, §6.4: same full-tree replay as evaluate, but instead of meshing,
// feed the final shape straight to STEPControl_Writer. The writer needs a
// real filename on OCCT's virtual (Emscripten MEMFS) filesystem — write,
// read the bytes back, then remove it; nothing about this weakens §6.1's
// "nothing survives past the evaluation that produced it", it just
// extends that evaluation's natural endpoint to include the write step
// (§6.4), same as the Disposer already does for the shape itself.
function handleExportStep(oc, msg) {
  var disposer = new Disposer();
  try {
    var cache = {};
    var rootShape = buildNode(oc, disposer, msg.params.featureTree.root, msg.params.featureTree, cache);

    var writer = disposer.track(new oc.STEPControl_Writer_1());
    var range = disposer.track(new oc.Message_ProgressRange_1());
    var transferStatus = writer.Transfer(
      rootShape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, range
    );
    if (transferStatus.value !== oc.IFSelect_ReturnStatus.IFSelect_RetDone.value) {
      throw new Error('STEP transfer did not complete');
    }

    var path = '/jenga3d-export-' + msg.id + '.step';
    var writeStatus = writer.Write(path);
    if (writeStatus.value !== oc.IFSelect_ReturnStatus.IFSelect_RetDone.value) {
      throw new Error('STEP write did not complete');
    }
    var fileBytes = oc.FS.readFile(path);
    try { oc.FS.unlink(path); } catch (e) { /* best-effort cleanup of the scratch file */ }

    disposer.disposeAll();
    return {
      id: msg.id, nodeId: msg.nodeId, generation: msg.generation, ok: true,
      fileBytes: fileBytes, mime: 'model/step'
    };
  } catch (e) {
    disposer.disposeAll();
    return {
      id: msg.id, nodeId: msg.nodeId, generation: msg.generation, ok: false,
      error: e && e.message || String(e)
    };
  }
}

// §14.9, §13 step 21: the one op whose params.featureTree genuinely
// carries `roots` (plural, §14.3) — evaluates every root's final shape
// within one request-scoped Disposer, combines them into a single
// TopoDS_Compound, then feeds that to STEPControl_Writer exactly as
// handleExportStep already does for one shape. No `BRepBuilderAPI_
// MakeCompound` class exists (confirmed empirically, not assumed from
// the .d.ts, same discipline as every other OCCT call in this file — it
// doesn't even appear in opencascade.full.d.ts); the real API is
// `BRep_Builder` (a `TopoDS_Builder` subclass)'s `MakeCompound(compound)`
// + `Add(compound, shape)`.
function handleExportStepAssembly(oc, msg) {
  var disposer = new Disposer();
  try {
    var tree = msg.params.featureTree;
    var roots = tree.roots || [];
    if (roots.length === 0) throw new Error('exportStepAssembly: feature tree has no instances');

    var cache = {};
    var builder = disposer.track(new oc.BRep_Builder());
    var compound = disposer.track(new oc.TopoDS_Compound());
    builder.MakeCompound(compound);
    roots.forEach(function (rootId) {
      var shape = buildNode(oc, disposer, rootId, tree, cache);
      builder.Add(compound, shape);
    });

    var writer = disposer.track(new oc.STEPControl_Writer_1());
    var range = disposer.track(new oc.Message_ProgressRange_1());
    var transferStatus = writer.Transfer(
      compound, oc.STEPControl_StepModelType.STEPControl_AsIs, true, range
    );
    if (transferStatus.value !== oc.IFSelect_ReturnStatus.IFSelect_RetDone.value) {
      throw new Error('STEP transfer did not complete');
    }

    var path = '/jenga3d-export-assembly-' + msg.id + '.step';
    var writeStatus = writer.Write(path);
    if (writeStatus.value !== oc.IFSelect_ReturnStatus.IFSelect_RetDone.value) {
      throw new Error('STEP write did not complete');
    }
    var fileBytes = oc.FS.readFile(path);
    try { oc.FS.unlink(path); } catch (e) { /* best-effort cleanup of the scratch file */ }

    disposer.disposeAll();
    return {
      id: msg.id, nodeId: msg.nodeId, generation: msg.generation, ok: true,
      fileBytes: fileBytes, mime: 'model/step'
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
    } else if (msg.op === 'exportStep') {
      response = handleExportStep(oc, msg);
    } else if (msg.op === 'exportStepAssembly') {
      response = handleExportStepAssembly(oc, msg);
    } else if (msg.op === 'exportIges') {
      response = {
        id: msg.id, nodeId: msg.nodeId, generation: msg.generation, ok: false,
        error: 'exportIges not implemented — named in the spec (§11.2) but deliberately not built until something downstream needs it'
      };
    } else {
      response = {
        id: msg.id, nodeId: msg.nodeId, generation: msg.generation, ok: false,
        error: 'op not supported yet: ' + msg.op
      };
    }
    var transferables = [];
    if (response.ok) {
      if (response.positions) transferables = [response.positions.buffer, response.normals.buffer, response.indices.buffer];
      else if (response.fileBytes) transferables = [response.fileBytes.buffer];
    }
    self.postMessage(response, transferables);
  });
};
