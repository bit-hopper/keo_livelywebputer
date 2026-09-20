module("lively.identity.FaceEffects")
  .requires()
  .toRun(function () {

    // Face overlays (glasses, party hat, mustache, blush) for the outgoing camera
    // picture, opened from the Ambient Presence Panel's room block. Face tracking
    // is MediaPipe's Face Landmarker, vendored in core/lib/mediapipe/ (ESM bundle,
    // SIMD WASM engine and the float16 model; Apache-2.0) and loaded on first use.
    //
    // Video path (same shape as the soundboard's audio path): while at least one
    // effect is on, the raw camera track is played into a hidden <video>, each new
    // frame is run through the landmarker and drawn, with the overlays, onto a
    // canvas, and that canvas's captureStream track is what the room session sends
    // (it asks getOutgoingTrack() for which video track to send) and what the
    // self-view shows (getViewStream()). With no effect on, nothing here is in the
    // path and calls keep sending the raw camera track.
    //
    // Detection and drawing both use the UNMIRRORED frame, so the track peers get
    // has the right orientation. The self-view's mirror is display-only CSS on its
    // <video> (RoomView._fillWithLocalStream), which works unchanged on the canvas
    // stream. The pipeline belongs to the call session, not to the room window:
    // it has its own hidden <video> and survives the window closing.
    //
    // The raw camera track stays owned by AmbientPresencePanel (camera-off still
    // stops it and releases the device); rewire() follows it — the panel calls it
    // from _afterLocalTracksChanged — so turning the camera off pauses the loop
    // and turning it back on re-attaches the fresh track.
    //
    // Plain object with normal closures: nothing here is a BuildSpec or an
    // addScript'd handler.
    lively.identity.FaceEffects = {
      BASE: "/core/lib/mediapipe/",
      MASK_BASE: "/core/media/face-masks/",
      // Masks are PNGs with transparent eye holes, so the wearer's own eyes show
      // through. eyeMid/eyeDist are the eye-hole midpoint and spacing in the image's
      // own pixels; the mask is placed by lining those up with the real eyes.
      MASKS: {
        keomask: { file: "keo.png", eyeMid: { x: 74.05, y: 251.5 }, eyeDist: 64.3 },
      },
      // The solid 3D version: face/hood shell with thickness and a relief map, plus two
      // real 3D horns (positions/radii in mask pixels, measured off the artwork).
      SOLID: {
        shell: "keo_shell.png", normal: "keo_normal.png",
        layers: 7, layerStep: 1.0, layerColor: 0x6a3a30, normalScale: 1.4,
        horns: [
          { u0: -47, v0: -79.5, u1: -48, v1: -251, r0: 17, r1: 6, sweepBack: 46, outward: -1 },
          { u0: 41,  v0: -79.5, u1: 33,  v1: -251, r0: 18, r1: 6, sweepBack: 46, outward: 1 },
        ],
      },
      _solid: null,
      _solidPromise: null,
      EFFECTS: [
        { id: "keomask3d", label: "keo mask 3D" },
        { id: "keomask", label: "keo mask" },
        { id: "glasses",  label: "glasses" },
        { id: "hat",      label: "party hat" },
        { id: "mustache", label: "mustache" },
        { id: "blush",    label: "blush" },
      ],
      // Auto-disable when the average detect+draw time per frame stays above this
      // (ms), measured once BUDGET_FRAMES frames past the warm-up have been seen.
      BUDGET_MS: 55,
      BUDGET_FRAMES: 45,
      WARMUP_FRAMES: 5,

      _maskImages: {},        // effect id -> HTMLImageElement, once requested
      THREE_SRC: "/core/lib/jenga3d/jenga3d-deps.js",   // window.jenga3dDeps.THREE (shared with Jenga3D)
      // Shape of the 3D mask, in the mask image's own pixels. Over the face the
      // surface conforms to the wearer's real face: each mask point takes its depth
      // from the nearby face landmarks (inverse-distance weighting, softened by
      // depthSoft), then floats `margin` in front of the skin. Above the face (the
      // horns and hood) and past the chin there are no landmarks, so the depth of the
      // nearest face point carries on and curls away (vCurl over vCurlRange).
      // `conform` blends a smooth quadratic fit of the whole face's depth (0) with the
      // per-point landmark depth (1): the fit keeps the mask a clean shell, the landmark
      // part follows the nose and cheeks but amplifies MediaPipe's depth noise, which
      // is worst on strongly turned heads.
      MASK_SURFACE: { canonical: true, canonMargin: 5, skullR: 95, skullSpan: 45, margin: 7, depthSoft: 11, conform: 0.15, symmetric: true, eyeLock: true, eyeSigma: 20, eyeMargin: 1.5, hornFlatten: 0.85, hornStart: 90, hornRange: 110, vCurl: 14, vCurlRange: 130, faceTop: -95, faceBottom: 108 },
      // Landmarks are smoothed over time for the 3D mask (fraction of the new frame
      // kept per update); a jump larger than resetJump (fraction of the eye distance)
      // is a new face or a fast move and restarts the smoothing.
      MASK_SMOOTH: { alpha: 0.55, resetJump: 0.6 },
      // MediaPipe's canonical face mesh (Apache-2.0): the rigid reference shape the
      // landmark topology is defined on. Fitting it to the tracked landmarks gives a
      // much steadier head pose than a few landmark axes, and rasterising it gives the
      // mask a real face-shaped surface (nose, cheeks, brow) with no per-frame noise.
      CANON_URL: "/core/lib/mediapipe/canonical_face_model.obj",
      _canon: null,
      _canonPromise: null,
      _three: null,           // { THREE, renderer, scene, camera, mesh, geo, mw, mh, w, h } once built
      _threePromise: null,
      _selected: {},          // effect id -> true
      _state: "idle",         // idle | loading | ready | error
      _notice: "",            // shown in the popover header (errors, auto-disable)
      _landmarker: null,
      _landmarkerPromise: null,

      _rawTrackId: null,
      _video: null,           // hidden <video> playing the raw camera track
      _canvas: null,
      _ctx: null,
      _canvasTrack: null,
      _viewStream: null,
      _timer: null,
      _lastVideoTime: -1,
      _lastTs: 0,
      _outputting: false,     // at least one frame has been drawn to the canvas
      _avgMs: 0,
      _frames: 0,

      _popover: null,
      _panelRef: null,
      _head: null,
      _chips: {},
      _closeHandlers: null,

      // ── queries used by the panel and the room session ──

      isActive: function () {
        return Object.keys(this._selected).length > 0;
      },

      // The video track the room session should send: the effect canvas once it is
      // producing frames, otherwise null (the caller falls back to the raw camera).
      getOutgoingTrack: function () {
        return this._outputting && this._canvasTrack && this._canvasTrack.readyState === "live"
          ? this._canvasTrack : null;
      },

      // The stream the self-view should show while effects are on, else null.
      getViewStream: function () {
        return this.getOutgoingTrack() ? this._viewStream : null;
      },

      // ── landmarker loading ──

      _ensureLandmarker: function () {
        var self = this;
        if (this._landmarker) return Promise.resolve(this._landmarker);
        if (this._landmarkerPromise) return this._landmarkerPromise;
        // Dynamic import via Function: this file goes through Lively's own JS
        // tooling, which predates import() syntax.
        var importer = new Function("u", "return import(u)");
        // MediaPipe's loader reads a global named Module as its Emscripten config
        // object and then overwrites it with undefined. Lively defines its own
        // Module class there, so hide it while the engine loads and put it back.
        var savedModule = window.Module;
        window.Module = undefined;
        function restoreModule() { window.Module = savedModule; }
        this._landmarkerPromise = importer(this.BASE + "vision_bundle.esm.js")
          .then(function (mp) {
            return mp.FilesetResolver.forVisionTasks(self.BASE + "wasm").then(function (fileset) {
              function create(delegate) {
                return mp.FaceLandmarker.createFromOptions(fileset, {
                  baseOptions: { modelAssetPath: self.BASE + "face_landmarker.task", delegate: delegate },
                  runningMode: "VIDEO",
                  numFaces: 1,
                });
              }
              return create("GPU").catch(function (err) {
                console.warn("[FaceEffects] GPU delegate unavailable, using CPU:", err && err.message);
                return create("CPU");
              });
            });
          })
          .then(function (lm) { restoreModule(); self._landmarker = lm; return lm; })
          .catch(function (err) { restoreModule(); self._landmarkerPromise = null; throw err; });
        return this._landmarkerPromise;
      },

      // ── canonical face model ──

      _ensureCanonical: function () {
        var self = this;
        if (this._canon) return Promise.resolve(this._canon);
        if (this._canonPromise) return this._canonPromise;
        this._canonPromise = fetch(this.CANON_URL)
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
          .then(function (txt) { self._canon = self._buildCanonical(txt); return self._canon; })
          .catch(function (err) {
            console.warn("[FaceEffects] canonical face model unavailable, using the fitted surface:", err && err.message);
            self._canonPromise = null;
            return null;
          });
        return this._canonPromise;
      },

      // Parses the OBJ and precomputes what the mask needs: the vertices in the image
      // frame (x right, y down, z away, centimetres), the rigid subset used to fit the
      // pose, and a 1 mask-pixel depth grid of the face surface in mask units.
      _buildCanonical: function (txt) {
        var mk = this.MASKS.keomask, V = [], T = [];
        txt.split("\n").forEach(function (l) {
          var p = l.trim().split(/\s+/);
          if (p[0] === "v") V.push([+p[1], +p[2], +p[3]]);
          else if (p[0] === "f") T.push([1, 2, 3].map(function (i) { return parseInt(p[i].split("/")[0], 10) - 1; }));
        });
        var n = V.length, i;
        var C = new Float32Array(n * 3);
        for (i = 0; i < n; i++) { C[i * 3] = V[i][0]; C[i * 3 + 1] = -V[i][1]; C[i * 3 + 2] = -V[i][2]; }
        function avg(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; }
        var eA = avg(V[33], V[133]), eB = avg(V[362], V[263]), mid = avg(eA, eB);
        var dC = Math.hypot(eA[0] - eB[0], eA[1] - eB[1], eA[2] - eB[2]);
        var kc = mk.eyeDist / dC;       // mask pixels per centimetre
        // Rigid part of the face for the pose fit: everything above the upper lip, so
        // opening the mouth or jaw doesn't drag the pose.
        var rigid = [];
        for (i = 0; i < n; i++) if (V[i][1] > -3) rigid.push(i);
        // Depth grid: face surface in mask units. u right, v down (from the eye midpoint),
        // value = how far toward the viewer.
        var U0 = -100, U1 = 100, V0 = -80, V1 = 150, gw = U1 - U0 + 1, gh = V1 - V0 + 1;
        var z = new Float32Array(gw * gh), cov = new Uint8Array(gw * gh);
        var pu = new Float32Array(n), pv = new Float32Array(n), pz = new Float32Array(n), top = 1e9, bottom = -1e9;
        for (i = 0; i < n; i++) {
          pu[i] = (V[i][0] - mid[0]) * kc; pv[i] = -(V[i][1] - mid[1]) * kc; pz[i] = (V[i][2] - mid[2]) * kc;
          top = Math.min(top, pv[i]); bottom = Math.max(bottom, pv[i]);
        }
        T.forEach(function (tr) {
          var a = tr[0], b = tr[1], c = tr[2];
          var x0 = Math.max(U0, Math.floor(Math.min(pu[a], pu[b], pu[c]))), x1 = Math.min(U1, Math.ceil(Math.max(pu[a], pu[b], pu[c])));
          var y0 = Math.max(V0, Math.floor(Math.min(pv[a], pv[b], pv[c]))), y1 = Math.min(V1, Math.ceil(Math.max(pv[a], pv[b], pv[c])));
          var den = (pv[b] - pv[c]) * (pu[a] - pu[c]) + (pu[c] - pu[b]) * (pv[a] - pv[c]);
          if (Math.abs(den) < 1e-9) return;
          for (var gy = y0; gy <= y1; gy++) for (var gx = x0; gx <= x1; gx++) {
            var l1 = ((pv[b] - pv[c]) * (gx - pu[c]) + (pu[c] - pu[b]) * (gy - pv[c])) / den;
            var l2 = ((pv[c] - pv[a]) * (gx - pu[c]) + (pu[a] - pu[c]) * (gy - pv[c])) / den;
            var l3 = 1 - l1 - l2;
            if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) continue;
            var zz = l1 * pz[a] + l2 * pz[b] + l3 * pz[c], gi = (gy - V0) * gw + (gx - U0);
            if (!cov[gi] || zz > z[gi]) { z[gi] = zz; cov[gi] = 1; }
          }
        });
        // Fill the holes and the surroundings by repeated neighbour averaging, so the
        // grid is defined everywhere (edges continue flat, then curl in _drawMask3D).
        for (var it = 0; it < 120; it++) {
          var changed = false, nz = new Float32Array(z), nc = new Uint8Array(cov);
          for (var yy = 0; yy < gh; yy++) for (var xx = 0; xx < gw; xx++) {
            var gi2 = yy * gw + xx; if (cov[gi2]) continue;
            var sum = 0, cnt = 0;
            if (xx > 0 && cov[gi2 - 1]) { sum += z[gi2 - 1]; cnt++; }
            if (xx < gw - 1 && cov[gi2 + 1]) { sum += z[gi2 + 1]; cnt++; }
            if (yy > 0 && cov[gi2 - gw]) { sum += z[gi2 - gw]; cnt++; }
            if (yy < gh - 1 && cov[gi2 + gw]) { sum += z[gi2 + gw]; cnt++; }
            if (cnt) { nz[gi2] = sum / cnt; nc[gi2] = 1; changed = true; }
          }
          z = nz; cov = nc;
          if (!changed) break;
        }
        // Soften the face relief: a mask is a stylised shell, not lips and nostrils.
        for (var pass = 0; pass < 3; pass++) {
          var bz = new Float32Array(z), R2 = 4;
          for (var by = 0; by < gh; by++) for (var bx = 0; bx < gw; bx++) {
            var acc = 0, cn2 = 0;
            for (var dx = -R2; dx <= R2; dx++) { var qx = bx + dx; if (qx < 0 || qx >= gw) continue; acc += z[by * gw + qx]; cn2++; }
            bz[by * gw + bx] = acc / cn2;
          }
          var bz2 = new Float32Array(bz);
          for (var by2 = 0; by2 < gh; by2++) for (var bx2 = 0; bx2 < gw; bx2++) {
            var acc2 = 0, cn3 = 0;
            for (var dy = -R2; dy <= R2; dy++) { var qy = by2 + dy; if (qy < 0 || qy >= gh) continue; acc2 += bz[qy * gw + bx2]; cn3++; }
            bz2[by2 * gw + bx2] = acc2 / cn3;
          }
          z = bz2;
        }
        function depth(u, v) {
          var fx = Math.max(0, Math.min(gw - 1.001, u - U0)), fy = Math.max(0, Math.min(gh - 1.001, v - V0));
          var ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, o = iy * gw + ix;
          return (1 - ty) * ((1 - tx) * z[o] + tx * z[o + 1]) + ty * ((1 - tx) * z[o + gw] + tx * z[o + gw + 1]);
        }
        return { C: C, rigid: rigid, kc: kc, eyeMidC: [mid[0], -mid[1], -mid[2]], depth: depth, top: top, bottom: bottom };
      },

      // Least-squares similarity fit (Horn's quaternion method) of the canonical
      // face's rigid part to the tracked landmarks: rotation R (row-major 3x3), a
      // uniform scale (pixels per centimetre) and a translation, all in the image frame.
      _fitPose: function (prev, canon) {
        var C = canon.C, idx = canon.rigid, m = idx.length, i, j, a, b;
        var ca = [0, 0, 0], cb = [0, 0, 0];
        for (i = 0; i < m; i++) { j = idx[i] * 3; for (a = 0; a < 3; a++) { ca[a] += C[j + a]; cb[a] += prev[j + a]; } }
        for (a = 0; a < 3; a++) { ca[a] /= m; cb[a] /= m; }
        var S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], sa = 0;
        for (i = 0; i < m; i++) {
          j = idx[i] * 3;
          var pa = [C[j] - ca[0], C[j + 1] - ca[1], C[j + 2] - ca[2]], pb = [prev[j] - cb[0], prev[j + 1] - cb[1], prev[j + 2] - cb[2]];
          for (a = 0; a < 3; a++) for (b = 0; b < 3; b++) S[a][b] += pa[a] * pb[b];
          sa += pa[0] * pa[0] + pa[1] * pa[1] + pa[2] * pa[2];
        }
        var Sxx = S[0][0], Sxy = S[0][1], Sxz = S[0][2], Syx = S[1][0], Syy = S[1][1], Syz = S[1][2], Szx = S[2][0], Szy = S[2][1], Szz = S[2][2];
        var N = [
          [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
          [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
          [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
          [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]];
        // Jacobi eigen-decomposition of the symmetric 4x4; the top eigenvector is the rotation.
        var Q = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], sweep, p, q, k;
        for (sweep = 0; sweep < 40; sweep++) {
          var off = 0;
          for (p = 0; p < 3; p++) for (q = p + 1; q < 4; q++) off += N[p][q] * N[p][q];
          if (off < 1e-20) break;
          for (p = 0; p < 3; p++) for (q = p + 1; q < 4; q++) {
            if (Math.abs(N[p][q]) < 1e-30) continue;
            var th = (N[q][q] - N[p][p]) / (2 * N[p][q]);
            var tt = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
            var c = 1 / Math.sqrt(tt * tt + 1), sn = tt * c;
            for (k = 0; k < 4; k++) { var akp = N[k][p], akq = N[k][q]; N[k][p] = c * akp - sn * akq; N[k][q] = sn * akp + c * akq; }
            for (k = 0; k < 4; k++) { var apk = N[p][k], aqk = N[q][k]; N[p][k] = c * apk - sn * aqk; N[q][k] = sn * apk + c * aqk; }
            for (k = 0; k < 4; k++) { var vkp = Q[k][p], vkq = Q[k][q]; Q[k][p] = c * vkp - sn * vkq; Q[k][q] = sn * vkp + c * vkq; }
          }
        }
        var best = 0;
        for (k = 1; k < 4; k++) if (N[k][k] > N[best][best]) best = k;
        var qw = Q[0][best], qx = Q[1][best], qy = Q[2][best], qz = Q[3][best];
        var ql = Math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz) || 1; qw /= ql; qx /= ql; qy /= ql; qz /= ql;
        var R = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
                 2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
                 2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)];
        var num = 0;
        for (i = 0; i < m; i++) {
          j = idx[i] * 3;
          var ax = C[j] - ca[0], ay = C[j + 1] - ca[1], az = C[j + 2] - ca[2];
          num += (R[0] * ax + R[1] * ay + R[2] * az) * (prev[j] - cb[0]) + (R[3] * ax + R[4] * ay + R[5] * az) * (prev[j + 1] - cb[1]) +
                 (R[6] * ax + R[7] * ay + R[8] * az) * (prev[j + 2] - cb[2]);
        }
        var sc = num / sa;
        var tr = [cb[0] - sc * (R[0] * ca[0] + R[1] * ca[1] + R[2] * ca[2]),
                  cb[1] - sc * (R[3] * ca[0] + R[4] * ca[1] + R[5] * ca[2]),
                  cb[2] - sc * (R[6] * ca[0] + R[7] * ca[1] + R[8] * ca[2])];
        return { R: R, s: sc, t: tr };
      },

      // ── 3D mask (Three.js) ──

      _ensureThree: function () {
        var self = this;
        if (this._three) return Promise.resolve(this._three);
        if (this._threePromise) return this._threePromise;
        this._threePromise = new Promise(function (resolve, reject) {
          if (window.jenga3dDeps && window.jenga3dDeps.THREE) return resolve(window.jenga3dDeps.THREE);
          var sc = document.createElement("script");
          sc.src = self.THREE_SRC;
          sc.onload = function () {
            if (window.jenga3dDeps && window.jenga3dDeps.THREE) resolve(window.jenga3dDeps.THREE);
            else reject(new Error("three.js missing from " + self.THREE_SRC));
          };
          sc.onerror = function () { reject(new Error("could not load " + self.THREE_SRC)); };
          document.head.appendChild(sc);
        }).then(function (THREE) {
          var img = self._maskImage("keomask");
          return (img.complete ? Promise.resolve() : img.decode()).then(function () {
            var geo = new THREE.PlaneGeometry(1, 1, 24, 56);
            var tex = new THREE.Texture(img);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = 4;
            // Transparent pixels are black in the PNG; premultiplying keeps that black
            // from bleeding into the edges when the texture is filtered.
            tex.premultiplyAlpha = true;
            tex.needsUpdate = true;
            var mat = new THREE.MeshLambertMaterial({
              map: tex, side: THREE.DoubleSide, transparent: true, premultipliedAlpha: true, alphaTest: 0.02,
            });
            var mesh = new THREE.Mesh(geo, mat);
            mesh.frustumCulled = false;
            var scene = new THREE.Scene();
            scene.add(mesh);
            // Lights are physical in this three.js: ambient near PI leaves a facing
            // surface close to its texture colour; the directional light adds relief
            // when the surface turns.
            scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.72));
            var sun = new THREE.DirectionalLight(0xffffff, Math.PI * 0.5);
            sun.position.set(-0.4, 0.6, 1);
            scene.add(sun);
            var renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: true });
            renderer.setClearColor(0x000000, 0);
            var camera = new THREE.OrthographicCamera(0, 1, 1, 0, -6000, 6000);
            camera.position.z = 3000;
            self._three = {
              THREE: THREE, renderer: renderer, scene: scene, mesh: mesh, geo: geo, camera: camera,
              mw: img.naturalWidth, mh: img.naturalHeight, w: 0, h: 0,
            };
            return self._ensureCanonical().then(function () { return self._three; });
          });
        }).catch(function (err) {
          console.warn("[FaceEffects] 3D mask unavailable, using the flat mask:", err && err.message);
          self._threePromise = null;
          return null;
        });
        return this._threePromise;
      },

      _ensureSolid: function () {
        var self = this;
        if (this._solid) return Promise.resolve(this._solid);
        if (this._solidPromise) return this._solidPromise;
        this._solidPromise = this._ensureThree().then(function (t) {
          if (!t) return null;
          var THREE = t.THREE, SO = self.SOLID;
          function load(url) { var im = new Image(); im.src = url; return im.decode().then(function () { return im; }); }
          return Promise.all([load(self.MASK_BASE + SO.shell), load(self.MASK_BASE + SO.normal)]).then(function (imgs) {
            var texC = new THREE.Texture(imgs[0]);
            texC.colorSpace = THREE.SRGBColorSpace; texC.anisotropy = 4; texC.premultiplyAlpha = true; texC.needsUpdate = true;
            var texN = new THREE.Texture(imgs[1]);      // linear data, not colour
            texN.anisotropy = 4; texN.needsUpdate = true;
            var scene = new THREE.Scene();
            var geo = new THREE.PlaneGeometry(1, 1, 24, 56);
            var shell = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
              map: texC, normalMap: texN, normalScale: new THREE.Vector2(SO.normalScale, SO.normalScale),
              side: THREE.DoubleSide, transparent: true, premultipliedAlpha: true, alphaTest: 0.02 }));
            shell.frustumCulled = false; shell.renderOrder = 20;
            scene.add(shell);
            // Thickness: darker copies of the shell stepped back into the head; seen from
            // an angle they read as the carved edge of the mask.
            var layers = [];
            for (var i = 0; i < SO.layers; i++) {
              var lg = geo.clone();
              var lm = new THREE.Mesh(lg, new THREE.MeshLambertMaterial({
                map: texC, color: SO.layerColor, side: THREE.DoubleSide, transparent: true, premultipliedAlpha: true, alphaTest: 0.02 }));
              lm.frustumCulled = false; lm.renderOrder = 10 + i;
              scene.add(lm); layers.push(lm);
            }
            var horns = SO.horns.map(function (spec) {
              var m = new THREE.Mesh(self._hornGeometry(THREE, spec),
                new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 28, specular: 0x2a2a2a }));
              m.frustumCulled = false; m.matrixAutoUpdate = false;
              scene.add(m); return m;
            });
            // Lights are physical: ambient near PI keeps facing surfaces close to their
            // texture colour; the key light from the upper left and a cool rim from the
            // right give the relief and the horns their shading as the head turns.
            scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.62));
            var key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.62); key.position.set(-0.55, 0.65, 0.75); scene.add(key);
            var rim = new THREE.DirectionalLight(0xbcd0ff, Math.PI * 0.22); rim.position.set(0.8, 0.2, 0.3); scene.add(rim);
            self._solid = { scene: scene, shell: shell, geo: geo, layers: layers, horns: horns };
            return self._solid;
          });
        }).catch(function (err) {
          console.warn("[FaceEffects] solid 3D mask unavailable:", err && err.message);
          self._solidPromise = null;
          return null;
        });
        return this._solidPromise;
      },

      // A tapered, rounded-tip horn as a swept circle, in head-local mask units (u right,
      // v down, tw toward the viewer, with tw = 0 at its base). Vertex colours make the
      // outer side light grey and the inner side black, like the artwork.
      _hornGeometry: function (THREE, sp) {
        var K = 32, M = 14, pos = [], col = [], idx = [], i, j;
        function lin(c) { return Math.pow(c / 255, 2.2); }
        var grey = lin(124), black = lin(12);
        function C(s) { return [sp.u0 + (sp.u1 - sp.u0) * s, sp.v0 + (sp.v1 - sp.v0) * s, -sp.sweepBack * s * s]; }
        for (i = 0; i <= K; i++) {
          var s0 = i / K, c0 = C(s0), c1 = C(Math.min(1, s0 + 0.01)), c2 = C(Math.max(0, s0 - 0.01));
          var T = [c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]], tl = Math.hypot(T[0], T[1], T[2]); T = [T[0] / tl, T[1] / tl, T[2] / tl];
          var ax = [1, 0, 0], d0 = ax[0] * T[0] + ax[1] * T[1] + ax[2] * T[2];
          var N1 = [ax[0] - d0 * T[0], ax[1] - d0 * T[1], ax[2] - d0 * T[2]], nl = Math.hypot(N1[0], N1[1], N1[2]); N1 = [N1[0] / nl, N1[1] / nl, N1[2] / nl];
          var N2 = [T[1] * N1[2] - T[2] * N1[1], T[2] * N1[0] - T[0] * N1[2], T[0] * N1[1] - T[1] * N1[0]];
          var r = sp.r0 + (sp.r1 - sp.r0) * Math.pow(s0, 0.9), capStart = 0.9;
          if (s0 > capStart) r *= Math.sqrt(Math.max(0, 1 - Math.pow((s0 - capStart) / (1 - capStart), 2)));
          for (j = 0; j < M; j++) {
            var th = j / M * Math.PI * 2, ct = Math.cos(th), st = Math.sin(th);
            pos.push(c0[0] + r * (ct * N1[0] + st * N2[0]), c0[1] + r * (ct * N1[1] + st * N2[1]), c0[2] + r * (ct * N1[2] + st * N2[2]));
            var f = Math.max(0, Math.min(1, (sp.outward * ct + 0.3) / 0.7)); f = f * f * (3 - 2 * f);
            var g = black + (grey - black) * f; col.push(g, g, g);
          }
        }
        for (i = 0; i < K; i++) for (j = 0; j < M; j++) {
          var a = i * M + j, b = i * M + (j + 1) % M, c = (i + 1) * M + j, d = (i + 1) * M + (j + 1) % M;
          idx.push(a, c, b, b, c, d);
        }
        var g2 = new THREE.BufferGeometry();
        g2.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g2.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        g2.setIndex(idx); g2.computeVertexNormals();
        return g2;
      },

      // Renders the mask as a curved surface turned with the head, onto ctx.
      // Returns false when three.js isn't ready (the caller draws the flat mask).
      //
      // The head frame comes straight from the landmarks' own 3D positions (x, y in
      // pixels; z, which MediaPipe scales like x, times the width): x axis across
      // the cheeks and eyes, y axis forehead to chin, z = x cross y, all in the
      // image's y-down frame (z away from the camera). Three's camera is
      // orthographic in pixel space and the surface is mapped with (x, h-y, -z),
      // a proper rotation, so triangle winding and lighting stay correct.
      _drawMask3D: function (ctx, lm, w, h) {
        var t = this._three;
        if (!t) return false;
        var mk = this.MASKS.keomask, SF = this.MASK_SURFACE;
        var solid = (this._selected.keomask3d && this._solid && this._canon && SF.canonical) ? this._solid : null;
        // Smooth the landmarks over time (MediaPipe's depth jitters frame to frame).
        var nAll = lm.length, sm = this.MASK_SMOOTH;
        if (!t.prev || t.prev.length !== nAll * 3 || t.prevW !== w || t.prevH !== h) { t.prev = new Float32Array(nAll * 3); t.havePrev = false; t.prevW = w; t.prevH = h; }
        var eyeSpan = Math.hypot((lm[362].x - lm[133].x) * w, (lm[362].y - lm[133].y) * h) || 1;
        var jump = 0;
        if (t.havePrev) {
          jump = Math.hypot((lm[1].x * w - t.prev[3]), (lm[1].y * h - t.prev[4])) / eyeSpan;
        }
        var keep = (t.havePrev && jump < sm.resetJump) ? (1 - sm.alpha) : 0;
        for (var q0 = 0; q0 < nAll; q0++) {
          t.prev[q0 * 3]     = t.prev[q0 * 3]     * keep + lm[q0].x * w * (1 - keep);
          t.prev[q0 * 3 + 1] = t.prev[q0 * 3 + 1] * keep + lm[q0].y * h * (1 - keep);
          t.prev[q0 * 3 + 2] = t.prev[q0 * 3 + 2] * keep + lm[q0].z * w * (1 - keep);
        }
        t.havePrev = true;
        var prev = t.prev;
        function P(i) { return [prev[i * 3], prev[i * 3 + 1], prev[i * 3 + 2]]; }
        function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
        function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
        function mul(a, q) { return [a[0] * q, a[1] * q, a[2] * q]; }
        function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
        function len(a) { return Math.sqrt(dot(a, a)); }
        function norm(a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
        function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

        var canon = (SF.canonical && this._canon) ? this._canon : null;
        var eyeMid, xAxis, yAxis, zAxis, k;
        if (canon) {
          // Head frame from fitting the canonical face to the landmarks: the columns of
          // the rotation are the head's right, down and away axes in the image frame.
          var pose = this._fitPose(prev, canon), R = pose.R, mc = canon.eyeMidC;
          xAxis = [R[0], R[3], R[6]]; yAxis = [R[1], R[4], R[7]]; zAxis = [R[2], R[5], R[8]];
          k = pose.s / canon.kc;
          eyeMid = [pose.s * (R[0] * mc[0] + R[1] * mc[1] + R[2] * mc[2]) + pose.t[0],
                    pose.s * (R[3] * mc[0] + R[4] * mc[1] + R[5] * mc[2]) + pose.t[1],
                    pose.s * (R[6] * mc[0] + R[7] * mc[1] + R[8] * mc[2]) + pose.t[2]];
        } else {
          var eA = mul(add(P(33), P(133)), 0.5), eB = mul(add(P(362), P(263)), 0.5);
          eyeMid = mul(add(eA, eB), 0.5);
          var d3 = len(sub(eB, eA));
          xAxis = norm(add(norm(sub(P(454), P(234))), norm(sub(eB, eA))));
          var yv = sub(P(152), P(10));
          yAxis = norm(sub(yv, mul(xAxis, dot(yv, xAxis))));
          zAxis = cross(xAxis, yAxis);
          k = d3 / mk.eyeDist;
        }

        if (t.w !== w || t.h !== h) {
          t.w = w; t.h = h;
          t.renderer.setSize(w, h, false);
          t.camera.right = w; t.camera.top = h;
          t.camera.updateProjectionMatrix();
        }
        // Landmarks in head-local mask units: x right, y down, z into the head (mask
        // pixels, so they compare directly with mask vertex positions).
        var nLm = lm.length, lx = t.lx || (t.lx = new Float32Array(nLm)),
            ly = t.ly || (t.ly = new Float32Array(nLm)), lz = t.lz || (t.lz = new Float32Array(nLm));
        for (var j = 0; j < nLm; j++) {
          var rel = sub(P(j), eyeMid);
          lx[j] = dot(rel, xAxis) / k; ly[j] = dot(rel, yAxis) / k; lz[j] = dot(rel, zAxis) / k;
        }
        var baseToward;
        if (canon) {
          baseToward = function (u, v) { return canon.depth(u, v); };
        } else {
        var soft2 = SF.depthSoft * SF.depthSoft;
        // Least-squares quadratic fit  z = c0 + c1 u + c2 v + c3 u^2 + c4 v^2 + c5 u v  over the landmarks.
        var A = [], bv = [], r0, r1;
        for (r0 = 0; r0 < 6; r0++) { A.push([0, 0, 0, 0, 0, 0]); bv.push(0); }
        for (var m = 0; m < nLm; m++) {
          var mu = lx[m] / 60, mv = ly[m] / 100;
          var basis = [1, mu, mv, mu * mu, mv * mv, mu * mv];
          for (r0 = 0; r0 < 6; r0++) {
            bv[r0] += basis[r0] * lz[m];
            for (r1 = 0; r1 < 6; r1++) A[r0][r1] += basis[r0] * basis[r1];
          }
        }
        for (r0 = 0; r0 < 6; r0++) A[r0][r0] += 1e-3;
        // Gauss-Jordan
        for (var col = 0; col < 6; col++) {
          var piv = col;
          for (r0 = col + 1; r0 < 6; r0++) if (Math.abs(A[r0][col]) > Math.abs(A[piv][col])) piv = r0;
          var tmpRow = A[col]; A[col] = A[piv]; A[piv] = tmpRow;
          var tmpB = bv[col]; bv[col] = bv[piv]; bv[piv] = tmpB;
          for (r0 = 0; r0 < 6; r0++) {
            if (r0 === col) continue;
            var fct = A[r0][col] / A[col][col];
            for (r1 = col; r1 < 6; r1++) A[r0][r1] -= fct * A[col][r1];
            bv[r0] -= fct * bv[col];
          }
        }
        var cf = [];
        for (r0 = 0; r0 < 6; r0++) cf.push(bv[r0] / A[r0][r0]);
        // A face is left-right symmetric in its own frame, so a slope across the
        // width is only error in the head-frame estimate; keeping it would tilt the
        // whole mask surface (the far horn went edge-on) and grow at the horns.
        if (SF.symmetric) { cf[1] = 0; cf[5] = 0; }
        // Depth (toward the viewer, mask px, before the margin) of the smooth shell at
        // head-local (u, v): the quadratic fit blended with per-point landmark depth.
        baseToward = function (u, v) {
          var sw = 0, sz = 0;
          for (var n = 0; n < nLm; n++) {
            var ddx = u - lx[n], ddy = v - ly[n];
            var q = ddx * ddx + ddy * ddy + soft2;
            var wgt = 1 / (q * q);
            sw += wgt; sz += wgt * lz[n];
          }
          var qu = u / 60, qv = Math.max(SF.faceTop, Math.min(SF.faceBottom, v)) / 100;
          // The mask wraps round the sides of the head like a shell, but the horns stick
          // up and away from it: above hornStart the width-wise curve fades toward
          // hornFlatten of the way to flat, so the far horn doesn't turn edge-on.
          var hf = 1 - SF.hornFlatten * Math.max(0, Math.min(1, (-v - SF.hornStart) / SF.hornRange));
          var quad = cf[0] + cf[1] * qu + cf[2] * qv + cf[3] * hf * qu * qu + cf[4] * qv * qv + cf[5] * qu * qv;
          return -(quad + SF.conform * (sz / sw - quad));
        };
        }
        // Eye lock: the shell sits in front of the (recessed) eyes, so when the head
        // turns the holes slide off them. Near each hole, pull the surface to the real
        // eye's depth and shift the mask in-plane so the hole centre sits on the eye.
        var locks = [];
        if (SF.eyeLock) {
          [[[33, 133], -mk.eyeDist / 2, -0.5], [[362, 263], mk.eyeDist / 2, 0.5]].forEach(function (e) {
            var ex = (lx[e[0][0]] + lx[e[0][1]]) / 2, ey = (ly[e[0][0]] + ly[e[0][1]]) / 2, ez = (lz[e[0][0]] + lz[e[0][1]]) / 2;
            locks.push({ hx: e[1], hy: e[2], dx: ex - e[1], dy: ey - e[2], res: -ez - baseToward(ex, ey) });
          });
        }
        var sig2 = 2 * SF.eyeSigma * SF.eyeSigma;
        // The skull rounds off over the hood; past skullSpan the curl continues only gently.
        function skullCurl(over) {
          var Lc = SF.skullSpan;
          return over <= Lc ? over * over / (2 * SF.skullR) : Lc * Lc / (2 * SF.skullR) + (over - Lc) * (Lc / SF.skullR) * 0.25;
        }
        var shellGeo = solid ? solid.geo : t.geo;
        var pos = shellGeo.attributes.position, uv = shellGeo.attributes.uv;
        for (var i = 0; i < pos.count; i++) {
          var u = uv.getX(i) * t.mw - mk.eyeMid.x, v = (1 - uv.getY(i)) * t.mh - mk.eyeMid.y;
          var gsum = 0, du = 0, dv = 0, dres = 0;
          for (var e2 = 0; e2 < locks.length; e2++) {
            var L2 = locks[e2], g = Math.exp(-((u - L2.hx) * (u - L2.hx) + (v - L2.hy) * (v - L2.hy)) / sig2);
            gsum = Math.max(gsum, g); du += g * L2.dx; dv += g * L2.dy; dres += g * L2.res;
          }
          var uu = u + du, vv = v + dv;
          var mg = canon ? SF.canonMargin : SF.margin;
          var toward = baseToward(uu, vv) + dres + mg - (mg - SF.eyeMargin) * gsum;
          // Beyond the face (horns and hood above it, the point below the chin) curl away:
          // over the canonical face the skull rounds off away from the forehead, else the
          // legacy gentle curl.
          var fTop = canon ? canon.top : SF.faceTop, fBot = canon ? canon.bottom : SF.faceBottom;
          var over = v < fTop ? fTop - v : (v > fBot ? v - fBot : 0);
          if (canon) toward -= skullCurl(over);
          else { var oc = over / SF.vCurlRange; toward -= SF.vCurl * oc * oc; }
          // toward the viewer = smaller z in the image frame
          var wp = add(eyeMid, add(mul(xAxis, uu * k), add(mul(yAxis, vv * k), mul(zAxis, -toward * k))));
          pos.setXYZ(i, wp[0], h - wp[1], -wp[2]);
        }
        pos.needsUpdate = true;
        shellGeo.computeVertexNormals();
        if (solid) {
          var SO = this.SOLID;
          // Thickness layers: the shell stepped back into the head along the head's z.
          var into = [zAxis[0] * k, -zAxis[1] * k, -zAxis[2] * k];
          var nrm = shellGeo.attributes.normal;
          for (var li = 0; li < solid.layers.length; li++) {
            var lp = solid.layers[li].geometry.attributes.position, off = (li + 1) * SO.layerStep;
            for (var pi = 0; pi < lp.count; pi++) lp.setXYZ(pi, pos.getX(pi) + into[0] * off, pos.getY(pi) + into[1] * off, pos.getZ(pi) + into[2] * off);
            lp.needsUpdate = true;
            solid.layers[li].geometry.attributes.normal.copyArray(nrm.array); solid.layers[li].geometry.attributes.normal.needsUpdate = true;
          }
          // Horns: rigid; each is placed on the hood at the surface depth under its base.
          var cu = [xAxis[0] * k, -xAxis[1] * k, -xAxis[2] * k], cv = [yAxis[0] * k, -yAxis[1] * k, -yAxis[2] * k], ct2 = [-zAxis[0] * k, zAxis[1] * k, zAxis[2] * k];
          for (var hi = 0; hi < solid.horns.length; hi++) {
            var hs = SO.horns[hi], hm = solid.horns[hi];
            var mgH = SF.canonMargin, oh = Math.max(0, (canon.top - hs.v0));
            var tw0 = baseToward(hs.u0, hs.v0) + mgH - skullCurl(oh) - 3;
            var T0 = [eyeMid[0] + ct2[0] * tw0, h - eyeMid[1] + ct2[1] * tw0, -eyeMid[2] + ct2[2] * tw0];
            // column-major basis (u, v, tw) plus translation; local origin is the eye midpoint
            hm.matrix.set(cu[0], cv[0], ct2[0], T0[0],
                          cu[1], cv[1], ct2[1], T0[1],
                          cu[2], cv[2], ct2[2], T0[2],
                          0, 0, 0, 1);
            hm.matrixWorldNeedsUpdate = true;
          }
        }
        t.renderer.render(solid ? solid.scene : t.scene, t.camera);
        ctx.drawImage(t.renderer.domElement, 0, 0, w, h);
        return true;
      },

      // ── effect selection ──

      toggleEffect: function (id) {
        if (this._selected[id]) delete this._selected[id]; else this._selected[id] = true;
        this._notice = "";
        if (id === "keomask" && this._selected[id]) this._ensureThree();
        if (id === "keomask3d" && this._selected[id]) this._ensureSolid();
        if (!this.isActive()) {
          this._stop(true);
          this._state = this._landmarker ? "ready" : "idle";
        } else if (!this._timer && this._state !== "loading") {
          this._start();
        }
        this._refreshUI();
      },

      _start: function () {
        var self = this;
        this._state = "loading";
        this._refreshUI();
        this._ensureLandmarker().then(function () {
          self._state = "ready";
          if (!self.isActive() || !self._room()) { self._refreshUI(); return; }
          self._attach();
          self._refreshUI();
        }).catch(function (err) {
          console.warn("[FaceEffects] could not load face tracking:", err && err.message);
          self._selected = {};
          self._state = "error";
          self._notice = "couldn't load face tracking";
          self._refreshUI();
        });
      },

      _room: function () {
        return lively.identity.AmbientPresencePanel._activeRoom;
      },

      _rawVideoTrack: function () {
        var stream = lively.identity.AmbientPresencePanel.getLocalStream();
        return stream ? (stream.getVideoTracks().filter(function (t) { return t.readyState === "live"; })[0] || null) : null;
      },

      // Points the pipeline at the current raw camera track (building the video and
      // canvas on first use). With no camera track it just idles until rewire().
      _attach: function () {
        var self = this;
        var raw = this._rawVideoTrack();
        if (!raw) { this._detachSource(); return; }
        if (this._timer && raw.id === this._rawTrackId) return;
        this._detachSource();
        this._rawTrackId = raw.id;
        var v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.autoplay = true;
        // Not display:none — a hidden video can stop decoding frames.
        v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
        v.srcObject = new MediaStream([raw]);
        document.body.appendChild(v);
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
        this._video = v;
        this._lastVideoTime = -1;
        if (!this._canvas) {
          this._canvas = document.createElement("canvas");
          this._canvas.width = 640; this._canvas.height = 480;
          this._ctx = this._canvas.getContext("2d");
          this._canvasTrack = this._canvas.captureStream(30).getVideoTracks()[0];
          this._viewStream = new MediaStream([this._canvasTrack]);
        }
        this._avgMs = 0; this._frames = 0;
        this._timer = setInterval(function () { self._frame(); }, 1000 / 30);
      },

      _detachSource: function () {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._video) {
          try { this._video.pause(); this._video.srcObject = null; this._video.remove(); } catch (e) {}
          this._video = null;
        }
        this._rawTrackId = null;
        // The canvas track stays (a stable object across camera off/on), but it
        // must not be sent while there is no live source behind it.
        this._outputting = false;
      },

      // Full stop: drop the whole pipeline. notify = tell the room session so it
      // switches peers and the self-view back to the raw camera.
      _stop: function (notify) {
        var wasOutputting = this._outputting;
        this._detachSource();
        if (this._canvasTrack) { try { this._canvasTrack.stop(); } catch (e) {} }
        this._canvasTrack = null; this._viewStream = null; this._canvas = null; this._ctx = null;
        if (notify && wasOutputting) this._notifyRoom();
      },

      _notifyRoom: function () {
        try {
          var RV = lively.identity.RoomView;
          if (RV && RV.localTracksChanged) RV.localTracksChanged();
        } catch (e) { console.error("[FaceEffects] localTracksChanged failed:", e); }
      },

      // Called by the panel whenever a local track was added or removed (camera
      // toggled, device re-acquired): follow the raw camera track.
      rewire: function () {
        if (!this.isActive() || !this._landmarker) return;
        var had = this._outputting;
        this._attach();
        // Camera went away while effects were sending: the room session must
        // swap to its black track, so it needs the same nudge as any track change.
        if (had && !this._outputting) this._notifyRoom();
      },

      // ── per-frame work ──

      _frame: function () {
        var v = this._video, lm = this._landmarker, ctx = this._ctx;
        if (!v || !lm || !ctx || v.readyState < 2 || !v.videoWidth) return;
        if (v.currentTime === this._lastVideoTime) return;
        this._lastVideoTime = v.currentTime;
        var t0 = performance.now();
        var w = v.videoWidth, h = v.videoHeight;
        if (this._canvas.width !== w || this._canvas.height !== h) {
          this._canvas.width = w; this._canvas.height = h;
        }
        ctx.drawImage(v, 0, 0, w, h);
        // detectForVideo needs strictly increasing timestamps.
        var ts = Math.max(t0, this._lastTs + 1);
        this._lastTs = ts;
        var result = null;
        try { result = lm.detectForVideo(v, ts); } catch (e) { console.warn("[FaceEffects] detect failed:", e && e.message); }
        var face = result && result.faceLandmarks && result.faceLandmarks[0];
        if (face) this._draw(ctx, face, w, h);

        if (!this._outputting) { this._outputting = true; this._notifyRoom(); this._refreshUI(); }

        // Adaptive fallback: revert to the plain camera if this can't keep up.
        // The first frames include one-off engine warm-up (shader/graph setup can
        // take seconds), so they are left out of the average.
        var ms = performance.now() - t0;
        this._frames++;
        if (this._frames <= this.WARMUP_FRAMES) return;
        var measured = this._frames - this.WARMUP_FRAMES;
        this._avgMs = measured === 1 ? ms : this._avgMs * 0.9 + ms * 0.1;
        if (measured >= this.BUDGET_FRAMES && this._avgMs > this.BUDGET_MS) {
          console.warn("[FaceEffects] too slow (" + Math.round(this._avgMs) + " ms/frame); turning effects off");
          this._selected = {};
          this._notice = "too slow on this device — turned off";
          this._stop(true);
          this._state = "ready";
          this._refreshUI();
        }
      },

      _maskImage: function (id) {
        if (!this._maskImages[id]) {
          var img = new Image();
          img.src = this.MASK_BASE + this.MASKS[id].file;
          this._maskImages[id] = img;
        }
        return this._maskImages[id];
      },

      _draw: function (ctx, lm, w, h) {
        var S = this._selected;
        function P(i) { return { x: lm[i].x * w, y: lm[i].y * h }; }
        function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
        function dist(a, b) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)); }

        // Eye centres, image-left and image-right of the unmirrored frame.
        var eA = mid(P(33), P(133)), eB = mid(P(362), P(263));
        var d = dist(eA, eB);
        var roll = Math.atan2(eB.y - eA.y, eB.x - eA.x);
        var eyeMid = mid(eA, eB);

        if (S.blush) {
          [P(205), P(425)].forEach(function (c) {
            var r = d * 0.34;
            var g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
            g.addColorStop(0, "rgba(255,80,130,0.55)");
            g.addColorStop(1, "rgba(255,80,130,0)");
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill();
          });
        }

        if ((S.keomask || S.keomask3d) && !this._drawMask3D(ctx, lm, w, h)) {
          // Flat fallback (three.js still loading or unavailable).
          var mk = this.MASKS.keomask, img = this._maskImage("keomask");
          if (img && img.complete && img.naturalWidth) {
            // Head turn: the nose slides along the eye axis as the head yaws, so use
            // its offset to narrow the mask (a flat mask can't rotate, only squash).
            var nose = P(1), ax = Math.cos(roll), ay = Math.sin(roll);
            var off = ((nose.x - eyeMid.x) * ax + (nose.y - eyeMid.y) * ay) / d;
            var sinYaw = Math.max(-0.85, Math.min(0.85, off / 0.55));
            var sx = Math.sqrt(1 - sinYaw * sinYaw);
            var k = d / mk.eyeDist;
            ctx.save();
            ctx.translate(eyeMid.x, eyeMid.y); ctx.rotate(roll);
            ctx.scale(k * sx, k);
            ctx.drawImage(img, -mk.eyeMid.x, -mk.eyeMid.y);
            ctx.restore();
          }
        }

        if (S.mustache) {
          var c = mid(P(164), P(0));
          var mw = dist(P(61), P(291));
          ctx.save();
          ctx.translate(c.x, c.y); ctx.rotate(roll);
          var s = mw * 0.62;
          ctx.fillStyle = "#3a2417";
          [-1, 1].forEach(function (side) {
            ctx.beginPath();
            ctx.moveTo(0, -0.05 * s);
            ctx.bezierCurveTo(side * 0.35 * s, -0.30 * s, side * 0.85 * s, -0.22 * s, side * 1.05 * s, 0.12 * s);
            ctx.bezierCurveTo(side * 0.80 * s, 0.02 * s, side * 0.45 * s, 0.10 * s, 0, 0.16 * s);
            ctx.closePath();
            ctx.fill();
          });
          ctx.restore();
        }

        if (S.glasses) {
          ctx.save();
          ctx.translate(eyeMid.x, eyeMid.y); ctx.rotate(roll);
          var lw = d * 0.66, lh = d * 0.52, lr = d * 0.16;
          ctx.lineWidth = d * 0.07;
          ctx.strokeStyle = "#141414";
          ctx.fillStyle = "rgba(232,73,126,0.28)";
          [-d / 2, d / 2].forEach(function (cx) {
            ctx.beginPath();
            ctx.moveTo(cx - lw / 2 + lr, -lh / 2);
            ctx.arcTo(cx + lw / 2, -lh / 2, cx + lw / 2, lh / 2, lr);
            ctx.arcTo(cx + lw / 2, lh / 2, cx - lw / 2, lh / 2, lr);
            ctx.arcTo(cx - lw / 2, lh / 2, cx - lw / 2, -lh / 2, lr);
            ctx.arcTo(cx - lw / 2, -lh / 2, cx + lw / 2, -lh / 2, lr);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
          });
          ctx.beginPath();
          ctx.moveTo(-d / 2 + lw / 2, -lh * 0.1);
          ctx.quadraticCurveTo(0, -lh * 0.35, d / 2 - lw / 2, -lh * 0.1);
          ctx.stroke();
          ctx.restore();
        }

        if (S.hat) {
          var top = P(10), chin = P(152);
          var faceH = dist(top, chin), fw = dist(P(234), P(454));
          var ux = (top.x - chin.x) / faceH, uy = (top.y - chin.y) / faceH;
          var base = { x: top.x - ux * faceH * 0.06, y: top.y - uy * faceH * 0.06 };
          ctx.save();
          ctx.translate(base.x, base.y);
          ctx.rotate(Math.atan2(ux, -uy));
          var bw = fw * 0.34, hh = fw * 1.0;
          var g = ctx.createLinearGradient(-bw, 0, bw, 0);
          g.addColorStop(0, "#e8497e"); g.addColorStop(0.5, "#ff7fa8"); g.addColorStop(1, "#c93468");
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.moveTo(-bw, 0); ctx.lineTo(0, -hh); ctx.lineTo(bw, 0); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = fw * 0.03;
          [0.3, 0.55, 0.78].forEach(function (f) {
            var half = bw * (1 - f);
            ctx.beginPath(); ctx.moveTo(-half, -hh * f); ctx.lineTo(half, -hh * f); ctx.stroke();
          });
          ctx.fillStyle = "#fff";
          ctx.beginPath(); ctx.arc(0, -hh, fw * 0.065, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      },

      // Call ended: drop the pipeline and the selection. The loaded landmarker
      // stays cached for the next call.
      teardown: function () {
        this.close();
        this._selected = {};
        this._notice = "";
        this._stop(false);
        this._state = this._landmarker ? "ready" : "idle";
      },

      // ── popover ──

      toggle: function (panel) {
        if (this._popover) this.close(); else this.open(panel);
      },

      _headText: function () {
        if (this._notice) return this._notice;
        if (this._state === "loading") return "Loading face tracking…";
        return "Face effects";
      },

      _refreshUI: function () {
        var NS = lively.identity.AmbientPresencePanel;
        var self = this;
        if (this._head) this._head.textString = this._headText();
        Object.keys(this._chips).forEach(function (id) {
          try { self._chips[id].applyStyle({ fill: self._chipFill(id) }); } catch (e) {}
        });
        if (NS && NS.refreshControls) NS.refreshControls();
      },

      _chipFill: function (id) {
        return this._selected[id] ? Color.rgba(232, 73, 126, 0.45) : Color.rgba(255, 255, 255, 0.06);
      },

      open: function (panel) {
        var self = this;
        var NS = lively.identity.AmbientPresencePanel;
        if (this._popover || !panel || !panel.world()) return;

        var PAD = 12, GAP = 8, COLS = 2, BTN_H = 36, HEAD_H = 26;
        var W = NS.PANEL_W;
        var BTN_W = (W - 2 * PAD - (COLS - 1) * GAP) / COLS;
        var rows = Math.ceil(this.EFFECTS.length / COLS);
        var H = PAD + HEAD_H + rows * BTN_H + (rows - 1) * GAP + PAD;

        var pos = panel.getPosition();
        var box = new lively.morphic.Box(lively.rect(pos.x, pos.y - H - 8, W, H));
        box.isEpiMorph = true;
        box.applyStyle({ fill: Color.black, borderRadius: 12, borderWidth: 3, borderColor: Color.rgb(232, 73, 126) });
        box.draggingEnabled = false; box.droppingEnabled = false; box.grabbingEnabled = false;
        box.name = "FaceEffectsPopover";

        var head = new lively.morphic.Text(lively.rect(PAD, 8, W - 2 * PAD, 18));
        head.textString = this._headText();
        head.applyStyle({
          fontSize: 9, fontWeight: "bold", textColor: NS.TEXT_SECONDARY, fill: null, borderWidth: 0,
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        head.eventsAreIgnored = true;
        box.addMorph(head);
        this._head = head;
        this._chips = {};

        this.EFFECTS.forEach(function (e, i) {
          var col = i % COLS, row = Math.floor(i / COLS);
          var b = new lively.morphic.Text(lively.rect(
            PAD + col * (BTN_W + GAP), PAD + HEAD_H + row * (BTN_H + GAP), BTN_W, BTN_H));
          b.textString = e.label;
          b.applyStyle({
            fontSize: 9, fontWeight: "600", textColor: NS.TEXT_PRIMARY,
            fill: self._chipFill(e.id), borderRadius: 8, borderWidth: 0, align: "center",
            padding: lively.Rectangle.inset(0, 10, 0, 0),
            allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
            handStyle: "pointer",
          });
          b.draggingEnabled = false; b.droppingEnabled = false; b.grabbingEnabled = false;
          b.onMouseOver = function () { b.applyStyle({ fill: NS.HOVER_BG }); };
          b.onMouseOut = function () { b.applyStyle({ fill: self._chipFill(e.id) }); };
          b.onMouseUp = function (evt) {
            self.toggleEffect(e.id);
            evt.stop();
            return true;
          };
          self._chips[e.id] = b;
          box.addMorph(b);
        });

        $world.addMorph(box);
        box.enableFixedPositioning();
        this._popover = box;
        this._panelRef = panel;

        // Click outside or Escape closes it. The panel's own button is excluded so
        // its click toggles instead of close-then-reopen.
        var onDown = function (e) {
          var node = box.renderContext().shapeNode;
          var btn = panel._faceBtn && panel._faceBtn.renderContext().shapeNode;
          if (node.contains(e.target) || (btn && btn.contains(e.target))) return;
          self.close();
        };
        var onKey = function (e) { if (e.key === "Escape") self.close(); };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        this._closeHandlers = { onDown: onDown, onKey: onKey };
      },

      close: function () {
        if (this._closeHandlers) {
          document.removeEventListener("mousedown", this._closeHandlers.onDown, true);
          document.removeEventListener("keydown", this._closeHandlers.onKey, true);
          this._closeHandlers = null;
        }
        if (this._popover) { try { this._popover.remove(); } catch (e) {} this._popover = null; }
        this._head = null; this._chips = {}; this._panelRef = null;
      },
    };

  }); // end module('lively.identity.FaceEffects')
