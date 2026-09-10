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
    'lively.jenga3d.tools.CreateSphereTool', 'lively.jenga3d.tools.MoveTool', 'lively.jenga3d.tools.RotateTool')
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
        this._rotateTool = null;
        this._rotateDrag = null; // { rootId, axis } — set on a ring-hit pointerdown
        this.buildToolbar();
        this.buildSolid();
        this._attachCanvasHandlers();
        this._refreshToolbarState();
      },

      // ─── toolbar construction ───────────────────────────────────────

      // Icon-button toolbar (a CAD-viewer-style restyle) — square Material
      // Symbols glyph buttons grouped into tinted clusters (select/create,
      // booleans, edge-ops, history, export) instead of the original flat
      // row of same-color text-label buttons. Ligature names verified
      // against the vendored core/media/material-icons/ set before use,
      // not assumed from memory (several plausible names, e.g. "cylinder"/
      // "cube"/"smooth", don't actually exist in this icon set). fontSize
      // is in POINTS, not px (Text morphs render fontSize+'pt' — the
      // AmbientPresencePanel.js icon-button precedent already established
      // this project's fontSize*0.75 conversion for a target px glyph
      // size); 22 here targets a ~29px glyph in a 32px button.
      buildToolbar: function buildToolbar() {
        var content = this.get('workspaceContent');
        var self = this;
        var bar = new lively.morphic.Box(lively.rect(0, 0, content.getExtent().x, this.TOOLBAR_HEIGHT));
        bar.setFill(Color.rgb(238, 240, 242));
        bar.name = 'toolbar';
        bar.layout = { resizeWidth: true };
        content.addMorph(bar);
        this._toolbarButtons = {};
        this._x = 8;

        var ICON_W = 32, ICON_H = 30;

        // A bare Text morph rendering a Material Symbols ligature directly
        // (`AmbientPresencePanel.js`'s `makeIconButton` recipe), not a
        // `lively.morphic.Button` — found live that `Button.ensureLabel`'s
        // `this.label.setTextStylingMode(true)` puts the label into a rich-
        // text mode where a flat `applyStyle({fontFamily})` on the button's
        // own `.label` submorph silently doesn't reach the rendered glyph
        // (confirmed: computed style stayed Helvetica/12px even after a
        // direct live `applyStyle` call), unlike a plain Text morph, which
        // this project's own precedent already uses for icon buttons.
        // `enable`/`disable`/`setFill` are hand-rolled here to match the
        // subset `_refreshToolbarState` actually calls on every button.
        function addIconButton(name, icon, handler, tint) {
          var rect = lively.rect(self._x, 5, ICON_W, ICON_H);
          var btn = new lively.morphic.Text(rect);
          btn.textString = icon;
          btn.applyStyle({
            fontFamily: "'Material Symbols Rounded'",
            fontSize: 16.5, // pt — targets a ~22px glyph (fontSize renders as pt, not px)
            textColor: Color.rgb(60, 64, 68),
            fill: tint || Color.white,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: Color.rgb(190, 195, 200),
            align: 'center',
            padding: lively.Rectangle.inset(0, Math.round((ICON_H - 22) / 2), 0, 0),
            allowInput: false,
            selectable: false,
            clipMode: 'hidden',
            whiteSpaceHandling: 'pre',
            handStyle: 'pointer',
          });
          btn.name = name;
          btn.draggingEnabled = false; btn.droppingEnabled = false; btn.grabbingEnabled = false;
          btn._enabled = true;
          btn._tint = tint || Color.white;
          btn.onMouseUp = function () { if (btn._enabled) self[handler](); };
          btn.enable = function () { btn._enabled = true; btn.applyStyle({ textColor: Color.rgb(60, 64, 68) }); };
          btn.disable = function () { btn._enabled = false; btn.applyStyle({ textColor: Color.rgb(190, 193, 196) }); };
          bar.addMorph(btn);
          self._toolbarButtons[name] = btn;
          self._x += ICON_W + 6;
          return btn;
        }

        function addSeparator() { self._x += 10; }

        var CREATE_TINT = Color.rgb(232, 240, 250), BOOL_TINT = Color.rgb(253, 240, 227),
          EDGE_TINT = Color.rgb(232, 247, 233), HISTORY_TINT = Color.rgb(240, 240, 240),
          EXPORT_TINT = Color.rgb(245, 235, 250);

        addIconButton('selectBtn', 'near_me', 'onSelectMode', CREATE_TINT);
        addSeparator();
        addIconButton('boxBtn', 'crop_square', 'onArmBox', CREATE_TINT);
        addIconButton('cylinderBtn', 'database', 'onArmCylinder', CREATE_TINT);
        addIconButton('sphereBtn', 'circle', 'onArmSphere', CREATE_TINT);
        addSeparator();
        addIconButton('unionBtn', 'join_full', 'onUnion', BOOL_TINT);
        addIconButton('cutBtn', 'content_cut', 'onCut', BOOL_TINT);
        addIconButton('intersectBtn', 'join_inner', 'onIntersect', BOOL_TINT);
        addSeparator();
        addIconButton('filletBtn', 'rounded_corner', 'onEnterFilletMode', EDGE_TINT);
        addIconButton('chamferBtn', 'crop', 'onEnterChamferMode', EDGE_TINT);

        var amountField = new lively.morphic.Text(lively.rect(this._x, 8, 46, 24), '2');
        amountField.name = 'amountField';
        amountField.beInputLine();
        amountField.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(203, 203, 203), borderRadius: 3.75 });
        bar.addMorph(amountField);
        this._toolbarButtons.amountField = amountField;
        this._x += 54;

        addIconButton('applyFilletBtn', 'check', 'onApplyFillet', EDGE_TINT);
        addSeparator();
        addIconButton('deleteBtn', 'delete', 'onDelete', HISTORY_TINT);
        addSeparator();
        addIconButton('undoBtn', 'undo', 'onUndo', HISTORY_TINT);
        addIconButton('redoBtn', 'redo', 'onRedo', HISTORY_TINT);
        addSeparator();
        addIconButton('exportStlBtn', 'download', 'onExportSTL', EXPORT_TINT);
        addIconButton('exportObjBtn', 'download', 'onExportOBJ', EXPORT_TINT);
        addIconButton('exportStepBtn', 'download', 'onExportSTEP', EXPORT_TINT);

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

        // Rotation rings sit in front of (and can be larger than) the
        // shape they belong to — check them before falling through to
        // face-pick/move, same priority a resize handle would get.
        var ringAxis = this.solid.pickRotationRing(evt.clientX, evt.clientY);
        if (ringAxis) {
          var rootId = this.solid.assembly.selectedRootIds[0];
          var sceneSync = this.assembly().sceneSyncs[rootId];
          var pivot = this.solid.getRotationGizmoCenter();
          if (sceneSync && pivot) {
            this._rotateTool = new lively.jenga3d.tools.RotateTool(this.solid, this.solid.featureTree, sceneSync);
            this._rotateTool.startDrag(ringAxis, pivot, evt.clientX, evt.clientY);
            this._rotateDrag = { rootId: rootId, axis: ringAxis };
            return;
          }
        }

        var pick = this.solid.pickFaceAt(evt.clientX, evt.clientY);
        if (!pick) { this._moveDrag = null; return; }
        this._moveDrag = { rootId: pick.rootId, startPoint: this._groundPoint(evt), isRealDrag: false };
      },

      _onCanvasPointerMove: function (evt) {
        if (this._rotateDrag) { if (this._rotateTool) this._rotateTool.updateDrag(evt.clientX, evt.clientY); return; }
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
        if (this._rotateDrag) {
          var rd = this._rotateDrag;
          this._rotateDrag = null;
          if (this._rotateTool) {
            var self = this;
            this._rotateTool.endDrag(evt.clientX, evt.clientY, function () {
              self.solid._frameAllMeshes();
              self.solid.showRotationGizmo(rd.rootId); // rings need re-centering on the new position/orientation
            });
            this._rotateTool = null;
          }
          return;
        }
        var d = this._moveDrag;
        this._moveDrag = null;
        if (!d) return;
        if (d.isRealDrag && this._moveTool) {
          var point = this._groundPoint(evt) || d.startPoint;
          var self2 = this;
          this._moveTool.endDrag(point, function () {
            self2.solid._frameAllMeshes();
            if (self2.assembly().selectedRootIds[0] === d.rootId) self2.solid.showRotationGizmo(d.rootId);
          });
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

      // ─── select/move mode + create-tool arming (§14.7, radio-style) ──

      // Explicit way back to select/move mode (found live to be missing —
      // before this, the only way to disarm a create tool was re-clicking
      // its own still-armed button, which a first-time user has no reason
      // to know). Also exits edge-pick mode, so this one button always
      // gets back to "click to select, drag to move."
      onSelectMode: function onSelectMode() {
        this._disarmCreateTool();
        if (this.mode === 'edge') { this.mode = 'select'; this.setStatus(''); }
        this._refreshToolbarState();
      },

      onArmBox: function onArmBox() { this._armCreateTool('box', lively.jenga3d.tools.CreateBoxTool); },
      onArmCylinder: function onArmCylinder() { this._armCreateTool('cylinder', lively.jenga3d.tools.CreateCylinderTool); },
      onArmSphere: function onArmSphere() { this._armCreateTool('sphere', lively.jenga3d.tools.CreateSphereTool); },

      _armCreateTool: function (name, ToolClass) {
        if (this._armedCreateToolName === name) { this._disarmCreateTool(); return; } // clicking the armed one again disarms it
        this._disarmCreateTool();
        this._armedCreateToolName = name;
        var self = this;
        // Matches a common CAD-viewer behavior: dropping a shape returns to
        // select/move automatically rather than leaving the tool armed
        // with no visible way back (the exact trap onSelectMode's own
        // doc comment names).
        this._armedCreateTool = new ToolClass(this.solid, this.assembly(), function onCommitted() { self._disarmCreateTool(); });
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
          btns[name].setFill(isArmed ? Color.rgb(150, 195, 245) : Color.rgb(232, 240, 250));
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

        btns.selectBtn.setFill(!this._armedCreateToolName && this.mode === 'select' ? Color.rgb(150, 195, 245) : Color.rgb(232, 240, 250));

        this._syncRotationGizmo();
      },

      // Shows the rotation rings iff exactly one instance is selected,
      // we're in plain select mode with nothing else armed, and that
      // instance is rotatable (its root is a wrapping `transform` node —
      // RotateTool's own v1 scope, shared with MoveTool). Hides them
      // otherwise. Called from the same single "state may have changed"
      // choke point every other toolbar-state refresh already uses.
      _syncRotationGizmo: function () {
        var selected = this.assembly().selectedRootIds;
        var eligible = this.mode === 'select' && !this._armedCreateToolName && selected.length === 1;
        if (eligible) {
          var node = this.solid.featureTree.getNode(selected[0]);
          eligible = !!(node && node.op === 'transform');
        }
        if (eligible) this.solid.showRotationGizmo(selected[0]);
        else this.solid.hideRotationGizmo();
      },

      onRemove: function onRemove() {
        if (this._armedCreateTool && this._armedCreateTool.detach) this._armedCreateTool.detach();
      },
    });

  });
