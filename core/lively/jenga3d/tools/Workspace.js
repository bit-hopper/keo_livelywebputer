/**
 * lively.jenga3d.tools.Workspace
 *
 * The toolbar window (Jenga3Dspec_v0.md §14.8, §13 step 19) — `SolidMorph`
 * stays exactly what §8 designed it to be: "just a Morph," minimal enough
 * to publish/share with no toolbar chrome riding along with it. This is
 * the separate wrapping window: a toolbar strip (primitive picker,
 * boolean-op buttons, fillet/chamfer controls, delete, undo/redo, export)
 * above a `lively.jenga3d.SolidMorph` submorph that owns the `FeatureTree`
 * and `Assembly` (§14.5) every button calls into.
 *
 * Built the way this codebase's newer (identity-system-era) dialogs are —
 * `RegisterDialog.js`/`LoginDialog.js`: a minimal `lively.BuildSpec` shell
 * (just a `Window` + one empty content `Box`), with the actual toolbar
 * constructed programmatically in `onFromBuildSpecCreated`/`buildToolbar`
 * — rather than a hand-authored pixel-coordinate `BuildSpec` JSON tree
 * (the older, visual-tool-authored style `PublishToInventoryDialog.js`
 * uses). Colors/radii/spacing match that established dialog baseline
 * (`_BorderRadius: 7` outer chrome, buttons sized to hug their own label,
 * 8px gaps) even though the construction method differs.
 *
 * §14.1 decision 4 / §14.6: two mutually exclusive interaction modes on
 * the embedded `Viewport`'s canvas:
 *   - **select** (default): a plain click picks and selects a whole
 *     instance (`Assembly.selectInstance`); a real drag on an instance's
 *     body moves it (`MoveTool`) — click-vs-drag is disambiguated by a
 *     small movement threshold, the same "click only fires with no
 *     movement" distinction `Viewport`'s own face-pick listener already
 *     relies on (§10/§13 step 8), which is why no separate "Move" button
 *     exists in §14.8's own toolbar enumeration.
 *   - **edge** (entered via Fillet/Chamfer): active only while exactly
 *     one instance is selected; clicks toggle edges via `pickEdgeAt`/
 *     `highlightEdge` on that one instance until Apply.
 * Radio-style Box/Cylinder/Sphere buttons arm/disarm the matching
 * create tool — armed create-tool gestures own the canvas's
 * pointerdown/move/up the same way `CreateBoxTool` et al already do, and
 * take priority over select/edge mode while armed.
 */

module('lively.jenga3d.tools.Workspace')
  .requires('lively.persistence.BuildSpec', 'lively.jenga3d.SolidMorph', 'lively.jenga3d.Export',
    'lively.jenga3d.tools.CreateBoxTool', 'lively.jenga3d.tools.CreateCylinderTool',
    'lively.jenga3d.tools.CreateSphereTool', 'lively.jenga3d.tools.MoveTool')
  .toRun(function () {

    lively.BuildSpec('lively.jenga3d.tools.Workspace', {
      // §14.8: constants live as spec properties, not module-scoped
      // closure `var`s — found live (not assumed) that `lively.BuildSpec`
      // methods get individually re-`eval`'d when a spec's morph is
      // created (see Window.createMorph's evalJS path), which strips the
      // surrounding module closure; a plain `var TOOLBAR_HEIGHT` above
      // this spec threw "TOOLBAR_HEIGHT is not defined" the moment
      // `buildToolbar` actually ran, even though the file loaded and
      // `module(...).toRun()` completed with no error.
      TOOLBAR_HEIGHT: 40,
      MOVE_THRESHOLD: 2, // mm on the ground plane — below this, a pointerdown/up is a click, not a drag

      _BorderRadius: 7,
      // §14.8: wide enough for the full toolbar row (~1130px of buttons,
      // measured live) plus room for the status text — found live that a
      // too-narrow default window makes the status text's computed rect
      // go negative-width and collapse to (0,0), overlapping the first
      // toolbar button, before this was widened.
      _Extent: lively.pt(1250, 650),
      className: 'lively.morphic.Window',
      name: 'Jenga3DWorkspace',
      titleBar: 'Jenga3D',
      contentOffset: lively.pt(3, 22),
      draggingEnabled: true,
      layout: { adjustForNewBounds: true },
      minExtent: lively.pt(900, 360),
      submorphs: [{
        _BorderColor: Color.rgb(95, 94, 95),
        _BorderRadius: 4,
        _Extent: lively.pt(1244, 625),
        _Fill: Color.rgb(243, 243, 243),
        _Position: lively.pt(3, 23),
        className: 'lively.morphic.Box',
        layout: { adjustForNewBounds: true, resizeWidth: true, resizeHeight: true },
        name: 'workspaceContent',
        submorphs: [],
      }],

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this.mode = 'select'; // 'select' | 'edge'
        this._armedCreateToolName = null;
        this._armedCreateTool = null;
        this._moveTool = null;
        this._moveDrag = null; // { rootId, startPoint, isRealDrag }
        this.buildToolbar();
        this.buildSolid();
        this._attachCanvasHandlers();
        this._refreshToolbarState();
      },

      // ─── toolbar construction ───────────────────────────────────────

      buildToolbar: function buildToolbar() {
        var content = this.get('workspaceContent');
        var self = this;
        var bar = new lively.morphic.Box(lively.rect(0, 0, content.getExtent().x, this.TOOLBAR_HEIGHT));
        bar.setFill(Color.rgb(230, 230, 230));
        bar.name = 'toolbar';
        bar.layout = { resizeWidth: true };
        content.addMorph(bar);
        this._toolbarButtons = {};
        this._x = 8;

        function addButton(name, label, handler) {
          var w = 16 + label.length * 7;
          var btn = new lively.morphic.Button(lively.rect(self._x, 8, w, 24), label);
          btn.name = name;
          btn.applyStyle({ _BorderRadius: 5, _BorderColor: Color.rgb(180, 180, 180) });
          lively.bindings.connect(btn, 'fire', self, handler);
          bar.addMorph(btn);
          self._toolbarButtons[name] = btn;
          self._x += w + 8;
          return btn;
        }

        function addSeparator() { self._x += 6; }

        addButton('boxBtn', 'Box', 'onArmBox');
        addButton('cylinderBtn', 'Cylinder', 'onArmCylinder');
        addButton('sphereBtn', 'Sphere', 'onArmSphere');
        addSeparator();
        addButton('unionBtn', 'Union', 'onUnion');
        addButton('cutBtn', 'Cut', 'onCut');
        addButton('intersectBtn', 'Intersect', 'onIntersect');
        addSeparator();
        addButton('filletBtn', 'Fillet', 'onEnterFilletMode');
        addButton('chamferBtn', 'Chamfer', 'onEnterChamferMode');

        var amountField = new lively.morphic.Text(lively.rect(this._x, 8, 46, 24), '2');
        amountField.name = 'amountField';
        amountField.beInputLine();
        amountField.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(203, 203, 203), borderRadius: 3.75 });
        bar.addMorph(amountField);
        this._toolbarButtons.amountField = amountField;
        this._x += 54;

        addButton('applyFilletBtn', 'Apply', 'onApplyFillet');
        addSeparator();
        addButton('deleteBtn', 'Delete', 'onDelete');
        addSeparator();
        addButton('undoBtn', 'Undo', 'onUndo');
        addButton('redoBtn', 'Redo', 'onRedo');
        addSeparator();
        addButton('exportStlBtn', 'Export STL', 'onExportSTL');
        addButton('exportObjBtn', 'Export OBJ', 'onExportOBJ');
        addButton('exportStepBtn', 'Export STEP', 'onExportSTEP');

        // Defensive floor (see this file's _Extent comment on the outer
        // spec) — never let a too-narrow window collapse this to a
        // negative/zero-width rect again, even if the window is resized
        // smaller than the toolbar's natural width later.
        var statusWidth = Math.max(80, content.getExtent().x - this._x - 10);
        var statusText = new lively.morphic.Text(lively.rect(this._x, 12, statusWidth, 16), '');
        statusText.name = 'statusText';
        statusText.applyStyle({ allowInput: false, fontSize: 11, fill: null, textColor: Color.rgb(90, 90, 90) });
        bar.addMorph(statusText);
        this._toolbarButtons.statusText = statusText;
      },

      buildSolid: function buildSolid() {
        var content = this.get('workspaceContent');
        var extent = content.getExtent();
        var solid = new lively.jenga3d.SolidMorph(
          lively.rect(0, this.TOOLBAR_HEIGHT, extent.x, extent.y - this.TOOLBAR_HEIGHT)
        );
        solid.name = 'solid';
        solid.layout = { resizeWidth: true, resizeHeight: true };
        content.addMorph(solid);
        this.solid = solid;
      },

      setStatus: function setStatus(text) {
        var t = this._toolbarButtons.statusText;
        if (t) t.textString = text || '';
      },

      // ─── canvas gesture wiring (§14.6) ──────────────────────────────

      // Waits for the Viewport's own three.js canvas to exist (same
      // poll-based readiness pattern CreateBoxTool._attachWhenReady
      // already uses), then wires: object-select-mode click-vs-drag
      // (this file doc) and the object-pick hook Viewport._attachPicking
      // already exposes for object-select mode (§14.6 decision 4).
      _attachCanvasHandlers: function _attachCanvasHandlers() {
        var self = this;
        var solid = this.solid;
        if (!solid._three) { setTimeout(function () { self._attachCanvasHandlers(); }, 80); return; }

        solid.onPickFace = function (pick) {
          if (self.mode !== 'select' || self._armedCreateToolName) return;
          self.assembly().selectInstance(pick ? pick.rootId : null, self._shiftHeld);
          self._refreshToolbarState();
        };

        var canvas = solid._three.renderer.domElement;
        canvas.addEventListener('pointerdown', function (evt) { self._onCanvasPointerDown(evt); });
        window.addEventListener('pointermove', function (evt) { self._onCanvasPointerMove(evt); });
        window.addEventListener('pointerup', function (evt) { self._onCanvasPointerUp(evt); });
      },

      assembly: function assembly() { return this.solid.assembly; },

      _onCanvasPointerDown: function (evt) {
        this._shiftHeld = evt.shiftKey;
        if (this.mode === 'edge') { this._handleEdgePick(evt); return; }
        if (this.mode !== 'select' || this._armedCreateToolName) return; // armed create tools own the gesture themselves
        var pick = this.solid.pickFaceAt(evt.clientX, evt.clientY);
        if (!pick) { this._moveDrag = null; return; }
        this._moveDrag = { rootId: pick.rootId, startPoint: this._groundPoint(evt), isRealDrag: false };
      },

      _onCanvasPointerMove: function (evt) {
        var d = this._moveDrag;
        if (!d) return;
        var point = this._groundPoint(evt);
        if (!point) return;
        if (!d.isRealDrag) {
          var dx = point.x - d.startPoint.x, dz = point.z - d.startPoint.z;
          if (Math.hypot(dx, dz) < this.MOVE_THRESHOLD) return;
          d.isRealDrag = true;
          var sceneSync = this.assembly().sceneSyncs[d.rootId];
          if (!sceneSync) { this._moveDrag = null; return; }
          this._moveTool = new lively.jenga3d.tools.MoveTool(this.solid, this.solid.featureTree, sceneSync);
          this._moveTool.startDrag(d.startPoint);
        }
        if (this._moveTool) this._moveTool.updateDrag(point);
      },

      _onCanvasPointerUp: function (evt) {
        var d = this._moveDrag;
        this._moveDrag = null;
        if (!d) return;
        if (d.isRealDrag && this._moveTool) {
          var point = this._groundPoint(evt) || d.startPoint;
          var self = this;
          this._moveTool.endDrag(point, function () { self.solid._frameAllMeshes(); });
          this._moveTool = null;
        } else {
          // A plain click, no real movement — object-select (§14.6),
          // matching the same click-only-on-no-movement contract
          // Viewport's own face-pick `click` listener relies on.
          this.assembly().selectInstance(d.rootId, this._shiftHeld);
          this._refreshToolbarState();
        }
      },

      _handleEdgePick: function (evt) {
        var selected = this.assembly().selectedRootIds;
        if (selected.length !== 1) return;
        var pick = this.solid.pickEdgeAt(selected[0], evt.clientX, evt.clientY);
        if (!pick) return;
        this.solid.highlightEdge(pick.rootId, pick.groupIndex, true);
      },

      _groundPoint: function (evt) {
        var three = this.solid._three;
        if (!three) return null;
        var THREE = three.THREE;
        var canvas = three.renderer.domElement;
        var rect = canvas.getBoundingClientRect();
        var ndc = new THREE.Vector2(
          ((evt.clientX - rect.left) / rect.width) * 2 - 1,
          -((evt.clientY - rect.top) / rect.height) * 2 + 1
        );
        var raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, three.camera);
        var groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        var hit = new THREE.Vector3();
        return raycaster.ray.intersectPlane(groundPlane, hit) ? hit : null;
      },

      // ─── create-tool arming (§14.7, radio-style) ────────────────────

      onArmBox: function onArmBox() { this._armCreateTool('box', lively.jenga3d.tools.CreateBoxTool); },
      onArmCylinder: function onArmCylinder() { this._armCreateTool('cylinder', lively.jenga3d.tools.CreateCylinderTool); },
      onArmSphere: function onArmSphere() { this._armCreateTool('sphere', lively.jenga3d.tools.CreateSphereTool); },

      _armCreateTool: function (name, ToolClass) {
        if (this._armedCreateToolName === name) { this._disarmCreateTool(); return; } // clicking the armed one again disarms it
        this._disarmCreateTool();
        this._armedCreateToolName = name;
        this._armedCreateTool = new ToolClass(this.solid, this.assembly());
        this._refreshToolbarState();
      },

      _disarmCreateTool: function () {
        if (this._armedCreateTool && this._armedCreateTool.detach) this._armedCreateTool.detach();
        this._armedCreateTool = null;
        this._armedCreateToolName = null;
        this._refreshToolbarState();
      },

      // ─── combine (§14.6) ─────────────────────────────────────────────

      onUnion: function onUnion() { this._combine('booleanUnion'); },
      onCut: function onCut() { this._combine('booleanCut'); },
      onIntersect: function onIntersect() { this._combine('booleanIntersect'); },

      _combine: function (op) {
        if (this.assembly().selectedRootIds.length !== 2) return;
        var self = this;
        this.assembly().combineSelected(op, function (err) {
          if (err) { self.setStatus('Combine failed: ' + err.message); return; }
          self.setStatus('');
          self._refreshToolbarState();
        });
      },

      // ─── fillet/chamfer (§14.6 edge-select mode) ────────────────────

      onEnterFilletMode: function onEnterFilletMode() { this._enterEdgeMode('fillet'); },
      onEnterChamferMode: function onEnterChamferMode() { this._enterEdgeMode('chamfer'); },

      _enterEdgeMode: function (op) {
        if (this.assembly().selectedRootIds.length !== 1) { this.setStatus('Select exactly one instance first.'); return; }
        this.mode = 'edge';
        this._edgeOp = op;
        this.setStatus((op === 'fillet' ? 'Fillet' : 'Chamfer') + ' mode — click edges, then Apply.');
        this._refreshToolbarState();
      },

      onApplyFillet: function onApplyFillet() {
        if (this.mode !== 'edge') return;
        var rootId = this.assembly().selectedRootIds[0];
        var entry = this.solid._meshes[rootId];
        var edgeIndices = entry ? Object.keys(entry.highlightedEdgeGroupIndices).map(function (groupIdx) {
          return entry.edgeLines.geometry.groups[groupIdx].occtEdgeIndex;
        }) : [];
        if (edgeIndices.length === 0) { this.setStatus('Pick at least one edge first.'); return; }
        var amount = parseFloat(this._toolbarButtons.amountField.textString) || 2;
        var self = this;
        this.assembly().filletSelected(this._edgeOp, edgeIndices, amount, function (err) {
          if (err) { self.setStatus('Fillet/chamfer failed: ' + err.message); }
          else self.setStatus('');
          self.mode = 'select';
          self._refreshToolbarState();
        });
      },

      // ─── delete / undo / redo ────────────────────────────────────────

      onDelete: function onDelete() {
        var self = this;
        this.assembly().selectedRootIds.slice().forEach(function (rootId) { self.assembly().removeInstance(rootId); });
        this._refreshToolbarState();
      },

      onUndo: function onUndo() { var self = this; this.assembly().undo(function () { self._refreshToolbarState(); }); },
      onRedo: function onRedo() { var self = this; this.assembly().redo(function () { self._refreshToolbarState(); }); },

      // ─── export (§14.9) ──────────────────────────────────────────────

      onExportSTL: function onExportSTL() {
        var self = this;
        lively.jenga3d.Export.downloadSTLAssembly(this.solid.featureTree, 'jenga3d-model.stl',
          function (err) { if (err) self.setStatus('Export failed: ' + err.message); });
      },
      onExportOBJ: function onExportOBJ() {
        var self = this;
        lively.jenga3d.Export.downloadOBJAssembly(this.solid.featureTree, 'jenga3d-model.obj',
          function (err) { if (err) self.setStatus('Export failed: ' + err.message); });
      },
      onExportSTEP: function onExportSTEP() {
        var self = this;
        lively.jenga3d.Export.downloadStepAssembly(this.solid.featureTree, 'jenga3d-model.step',
          function (err) { if (err) self.setStatus('Export failed: ' + err.message); });
      },

      // ─── toolbar enable/disable + radio highlight ───────────────────

      _refreshToolbarState: function () {
        var btns = this._toolbarButtons;
        var selectedCount = this.assembly().selectedRootIds.length;

        ['boxBtn', 'cylinderBtn', 'sphereBtn'].forEach(function (name) {
          var isArmed = { boxBtn: 'box', cylinderBtn: 'cylinder', sphereBtn: 'sphere' }[name] === this._armedCreateToolName;
          btns[name].setFill(isArmed ? Color.rgb(204, 229, 255) : Color.rgb(243, 243, 243));
        }, this);

        var canCombine = selectedCount === 2;
        ['unionBtn', 'cutBtn', 'intersectBtn'].forEach(function (name) {
          if (canCombine) { btns[name].enable && btns[name].enable(); } else { btns[name].disable && btns[name].disable(); }
        });

        var canFillet = selectedCount === 1 && this.mode !== 'edge';
        ['filletBtn', 'chamferBtn'].forEach(function (name) {
          if (canFillet) { btns[name].enable && btns[name].enable(); } else { btns[name].disable && btns[name].disable(); }
        });
        var inEdgeMode = this.mode === 'edge';
        if (inEdgeMode) { btns.applyFilletBtn.enable && btns.applyFilletBtn.enable(); }
        else { btns.applyFilletBtn.disable && btns.applyFilletBtn.disable(); }

        if (selectedCount >= 1) { btns.deleteBtn.enable && btns.deleteBtn.enable(); }
        else { btns.deleteBtn.disable && btns.deleteBtn.disable(); }

        var ft = this.solid.featureTree;
        if (ft.canUndo()) { btns.undoBtn.enable && btns.undoBtn.enable(); } else { btns.undoBtn.disable && btns.undoBtn.disable(); }
        if (ft.canRedo()) { btns.redoBtn.enable && btns.redoBtn.enable(); } else { btns.redoBtn.disable && btns.redoBtn.disable(); }
      },

      onRemove: function onRemove() {
        if (this._armedCreateTool && this._armedCreateTool.detach) this._armedCreateTool.detach();
      },
    });

  });
