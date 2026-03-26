module('apps.GlyphEditor.GlyphEditor')
    .requires('lively.morphic.PathShapes', 'lively.morphic.Core')
    .toRun(function() {

// ============================================================
// GlyphShape
// Extends lively.morphic.Shapes.Path with full cubic Bezier
// (BezierCurve2CtlTo, SVG 'C') support and a proper reshape()
// that handles both control points of each cubic segment.
// ============================================================

lively.morphic.Shapes.Path.subclass('lively.morphic.Shapes.GlyphShape',
'documentation', {
    documentation: 'Path shape for glyph outlines. Uses BezierCurve2CtlTo (cubic, SVG C) ' +
                   'for smooth curves and LineTo for straight segments.',
},
'initialization', {
    initialize: function($super) {
        $super([pt(0,0)]);
        this.isClosed = false;
    },
},
'building', {
    buildPath: function(vertices, cps1, cps2, closed) {
        // Build the SVG path from arrays of points.
        // vertices[i] = endpoint pt(x,y)
        // cps1[i]     = first  control point pt(x,y)  (null → skip)
        // cps2[i]     = second control point pt(x,y)  (null → skip)
        // closed      = true to append ClosePath ('Z')
        var g = lively.morphic.Shapes, cmds = [];
        if (!vertices || vertices.length === 0) return;
        cmds.push(new g.MoveTo(true, vertices[0].x, vertices[0].y));
        for (var i = 1; i < vertices.length; i++) {
            var cp1 = (cps1 && cps1[i]) || null,
                cp2 = (cps2 && cps2[i]) || null,
                v   = vertices[i];
            if (cp1 && cp2) {
                cmds.push(new g.BezierCurve2CtlTo(true,
                    v.x, v.y,
                    cp1.x, cp1.y,
                    cp2.x, cp2.y));
            } else if (cp1) {
                cmds.push(new g.QuadCurveTo(true, v.x, v.y, cp1.x, cp1.y));
            } else {
                cmds.push(new g.LineTo(true, v.x, v.y));
            }
        }
        if (closed) {
            cmds.push(new g.ClosePath(true));
            this.isClosed = true;
        }
        this.setPathElements(cmds);
    },
},
'updating', {
    reshape: function(ix, newPoint, lastCall) {
        // Override to handle cubic Bezier BezierCurve2CtlTo control points.
        // allPartNames() encoding (same as base Path):
        //   0 … N-1        = the N vertex endpoints
        //   N … 2N-1       = first  control point of the i-th element
        //   2N … 3N-1      = second control point of the i-th element
        var elems = this.getPathElements();
        var verts = this.vertices();  // endpoints only (ClosePath excluded)
        var N     = verts.length;

        if (ix < 0) {
            // Negative index = insert a vertex at midpoint – not used in glyph editing
            return false;
        }

        // --- Move a vertex (endpoint) ---
        if (ix < N) {
            var elem = elems[ix];
            if (elem) { elem.x = newPoint.x; elem.y = newPoint.y; }
            this.setPathElements(elems);
            return false;
        }

        // --- Move first control point (N ≤ ix < 2N) ---
        if (ix < N * 2) {
            var elem = elems[ix - N];
            if (elem && elem.controlX1 !== undefined) {
                elem.controlX1 = newPoint.x;
                elem.controlY1 = newPoint.y;
            }
            this.setPathElements(elems);
            return false;
        }

        // --- Move second control point (2N ≤ ix < 3N) ---
        if (ix < N * 3) {
            var elem = elems[ix - (N * 2)];
            if (elem && elem.controlX2 !== undefined) {
                elem.controlX2 = newPoint.x;
                elem.controlY2 = newPoint.y;
            }
            this.setPathElements(elems);
            return false;
        }

        return false;
    },

    getControlPointData: function() {
        // Returns { vertices, cps1, cps2 } parallel arrays for export / redraw.
        var elems = this.getPathElements();
        var vertices = [], cps1 = [], cps2 = [];
        elems.forEach(function(el) {
            var last = el.controlPoints().last();
            if (!last) return; // ClosePath
            vertices.push(pt(el.x || 0, el.y || 0));
            if (el.controlX1 !== undefined) {
                cps1.push(pt(el.controlX1, el.controlY1));
                cps2.push(pt(el.controlX2, el.controlY2));
            } else if (el.controlX !== undefined) { // QuadCurveTo
                cps1.push(pt(el.controlX, el.controlY));
                cps2.push(null);
            } else {
                cps1.push(null);
                cps2.push(null);
            }
        });
        return { vertices: vertices, cps1: cps1, cps2: cps2, closed: this.isClosed };
    },
});


// ============================================================
// ControlPointHandle
// A small draggable square/circle that represents one vertex
// or Bezier control point of a GlyphMorph's path.
// ============================================================

lively.morphic.Morph.subclass('lively.morphic.ControlPointHandle',
'properties', {
    style: {
        enableGrabbing: false,
        enableHalos:    false,
        enableMorphMenu: false,
        enableDragging:  true,   // key applyStyle recognises → sets this.draggingEnabled = true
    },
    HANDLE_SIZE: 8,
},
'initialization', {
    initialize: function($super, glyphMorph, partIndex) {
        var s = this.HANDLE_SIZE;
        $super(new lively.morphic.Shapes.Rectangle(lively.rect(0, 0, s, s)));
        this.glyphMorph = glyphMorph;
        this.partIndex  = partIndex;

        var N = glyphMorph.shape.vertices().length;
        var isVertex = (partIndex < N);
        var isCp1    = (partIndex >= N && partIndex < N * 2);

        if (isVertex) {
            this.setFill(Color.white);
            this.setBorderColor(Color.black);
            this.setBorderWidth(1.5);
        } else if (isCp1) {
            this.setFill(Color.blue.withA(0.7));
            this.setBorderColor(Color.blue.darker());
            this.setBorderWidth(1);
            this.setExtent(pt(6, 6));
        } else {
            this.setFill(Color.red.withA(0.7));
            this.setBorderColor(Color.red.darker());
            this.setBorderWidth(1);
            this.setExtent(pt(6, 6));
        }
        this.dragStarted = false;
        this.applyStyle(this.style);  // ensures draggingEnabled:true takes effect
    },

    syncToShape: function(glyphPos) {
        // Position this handle in owner (canvas) space.
        var localPos = this.glyphMorph.shape.partPosition(this.partIndex);
        if (!localPos) return;
        var origin = glyphPos || this.glyphMorph.getPosition();
        var s = this.getExtent();
        this.setPosition(pt(
            origin.x + localPos.x - s.x / 2,
            origin.y + localPos.y - s.y / 2));
    },
},
'dragging', {
    onDragStart: function(evt) {
        this.dragStarted = true;
        evt.stop();
        return true;
    },

    onDrag: function(evt) {
        if (!this.dragStarted) return false;
        // Handles live in canvas space; convert to glyph-local space for reshape.
        var canvasPos = evt.getPositionIn(this.owner);
        var glyphPos  = this.glyphMorph.getPosition();
        var localPos  = canvasPos.subPt(glyphPos);
        this.glyphMorph.shape.reshape(this.partIndex, localPos, false);
        this.glyphMorph._syncAllHandles && this.glyphMorph._syncAllHandles();
        evt.stop();
        return true;
    },

    onDragEnd: function(evt) {
        if (!this.dragStarted) return false;
        this.dragStarted = false;
        var canvasPos = evt.getPositionIn(this.owner);
        var glyphPos  = this.glyphMorph.getPosition();
        var localPos  = canvasPos.subPt(glyphPos);
        this.glyphMorph.shape.reshape(this.partIndex, localPos, true);
        this.glyphMorph._syncAllHandles && this.glyphMorph._syncAllHandles();
        evt.stop();
        return true;
    },
});


// ============================================================
// GlyphMorph
// A PathMorph subclass representing a single glyph character.
// Stores Unicode code point, advance width, kerning pairs.
// Ctrl+click enters "dive mode" to expose Bezier control handles.
// ============================================================

lively.morphic.Path.subclass('lively.morphic.GlyphMorph',
'properties', {
    style: {
        borderWidth: 1.5,
        borderColor: Color.rgb(40, 40, 40),
        fill:        Color.rgb(30, 30, 30),
        enableGrabbing: false,
        enableHalos:    true,   // must be true so ctrl+click triggers showHalos() → dive mode
        enableMorphMenu: false,
        enableDragging:  false,
    },
},
'initialization', {
    initialize: function($super, unicodeChar) {
        $super([pt(0,0)]);
        this.unicodeChar  = unicodeChar || '?';
        this.advanceWidth = 400;
        this.kerningPairs = {};
        this.isDiveMode   = false;
        this._handles     = [];
        this._stems       = [];
        // Replace base Path shape with our GlyphShape (setShape wires render context)
        this.setShape(new lively.morphic.Shapes.GlyphShape());
        this.applyStyle(this.style);
    },

    initDefaultPath: function(verts, cps1, cps2, closed) {
        this.shape.buildPath(verts, cps1, cps2, closed || false);
        return this;
    },
},
'accessing', {
    setUnicodeChar: function(c)   { this.unicodeChar = c; },
    getUnicodeChar: function()    { return this.unicodeChar; },
    setAdvanceWidth: function(w)  { this.advanceWidth = w; },
    getAdvanceWidth: function()   { return this.advanceWidth; },
},
'dive mode', {
    enterDiveMode: function() {
        if (this.isDiveMode) return;
        this.isDiveMode = true;
        this._buildHandles();
    },

    exitDiveMode: function() {
        if (!this.isDiveMode) return;
        this.isDiveMode = false;
        this._removeHandles();
    },

    toggleDiveMode: function() {
        this.isDiveMode ? this.exitDiveMode() : this.enterDiveMode();
    },

    // Handles and stems are added to our owner (canvas morph), not to this SVG path
    // morph, so they sit as peer divs and are not occluded by the SVG element.
    _buildHandles: function() {
        this._removeHandles();
        var canvas = this.owner;
        if (!canvas) return;
        var glyphPos  = this.getPosition();
        var partNames = this.shape.allPartNames();
        var N         = this.shape.vertices().length;
        var self      = this;

        // Stems first so handles render on top of them.
        partNames.forEach(function(ix) {
            if (ix < N) return; // only CP indices get stems
            var isCp1   = (ix < N * 2);
            var elemIx  = isCp1 ? (ix - N) : (ix - N * 2);
            var vertIx  = isCp1 ? (elemIx - 1) : elemIx;
            if (vertIx < 0 || vertIx >= N) return;
            var cpPos   = self.shape.partPosition(ix);
            var vertPos = self.shape.partPosition(vertIx);
            if (!cpPos || !vertPos) return;
            var stem = self._makeStem(
                pt(glyphPos.x + cpPos.x,   glyphPos.y + cpPos.y),
                pt(glyphPos.x + vertPos.x, glyphPos.y + vertPos.y));
            canvas.addMorph(stem);
            self._stems.push({ morph: stem, cpIndex: ix, vertIndex: vertIx });
        });

        // Handles on top.
        partNames.forEach(function(ix) {
            if (ix < 0) return; // skip midpoint-insertion indices
            var handle = new lively.morphic.ControlPointHandle(self, ix);
            handle.syncToShape(glyphPos);
            canvas.addMorph(handle);
            self._handles.push(handle);
        });
    },

    _makeStem: function(p1, p2) {
        var stem = new lively.morphic.Path([p1, p2]);
        stem.setBorderColor(Color.rgb(160, 160, 160));
        stem.setBorderWidth(0.8);
        stem.setFill(null);
        stem.ignoreEvents(); // click-through: never intercepts mouse
        return stem;
    },

    _removeHandles: function() {
        this._handles.forEach(function(h) { h.owner && h.owner.removeMorph(h); });
        this._handles = [];
        this._stems.forEach(function(s) { s.morph.owner && s.morph.owner.removeMorph(s.morph); });
        this._stems = [];
    },

    _syncAllHandles: function() {
        var glyphPos = this.getPosition();
        var self     = this;
        this._handles.forEach(function(h) { h.syncToShape(glyphPos); });
        this._stems.forEach(function(s) {
            var cpPos   = self.shape.partPosition(s.cpIndex);
            var vertPos = self.shape.partPosition(s.vertIndex);
            if (!cpPos || !vertPos) return;
            s.morph.setVertices([
                pt(glyphPos.x + cpPos.x,   glyphPos.y + cpPos.y),
                pt(glyphPos.x + vertPos.x, glyphPos.y + vertPos.y)
            ]);
        });
    },
},
'events', {
    // Override showHalos: ctrl+click triggers Lively's halo system which calls showHalos()
    // before dispatching onMouseDown. We intercept here to enter dive mode instead.
    showHalos: function($super, shiftedActivation) {
        this.toggleDiveMode();
        // don't show actual halos
    },
});


// ============================================================
// GlyphEditorMorph
// The main editor container (extends Morph).
// Provides a drawing canvas with metric guide lines,
// a glyph tray at the bottom, and an export button.
// ============================================================

lively.morphic.Morph.subclass('lively.morphic.GlyphEditorMorph',
'properties', {
    CANVAS_W: 780,
    CANVAS_H: 620,
    UPM:      1000,
    // Pixel Y positions for metric guides (relative to this morph)
    BASELINE:    470,
    CAP_HEIGHT:   90,
    X_HEIGHT:    220,
    ASCENDER:     40,
    DESCENDER:   530,
    // Horizontal center for glyph display
    GLYPH_CENTER_X: 360,
    style: {
        fill: Color.rgb(245, 245, 245),
        borderWidth: 1,
        borderColor: Color.rgb(180, 180, 180),
        enableGrabbing: false,
        enableHalos:    true,
        enableMorphMenu: false,
        enableDragging:  true,
    },
},
'initialization', {
    initialize: function($super) {
        $super(new lively.morphic.Shapes.Rectangle(lively.rect(0, 0, this.CANVAS_W, this.CANVAS_H + 80)));
        this.glyphs         = [];
        this.activeGlyph    = null;
        this._guideLines    = [];
        this._glyphTray     = null;
        this._toolbar       = null;
        this._buildUI();
    },

    _buildUI: function() {
        this._buildToolbar();
        this._buildCanvas();
        this._buildGlyphTray();
        this._buildGuideLines();
    },

    _buildToolbar: function() {
        var W = this.CANVAS_W, self = this;
        var bar = new lively.morphic.Morph(new lively.morphic.Shapes.Rectangle(lively.rect(0, 0, W, 36)));
        bar.setFill(Color.rgb(60, 60, 70));
        bar.setBorderWidth(0);

        var title = new lively.morphic.Text(lively.rect(10, 7, 180, 22), 'Glyph Editor');
        title.setFontSize(14);
        title.setFontWeight('bold');
        title.setTextColor(Color.white);
        title.beLabel();
        bar.addMorph(title);

        // Unicode input
        var uniLabel = new lively.morphic.Text(lively.rect(200, 9, 65, 18), 'Unicode:');
        uniLabel.setFontSize(11);
        uniLabel.setTextColor(Color.rgb(200, 200, 200));
        uniLabel.beLabel();
        bar.addMorph(uniLabel);

        var uniInput = new lively.morphic.Text(lively.rect(268, 6, 60, 24), 'A');
        uniInput.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.gray });
        uniInput.setFontSize(12);
        bar.addMorph(uniInput);
        this._uniInput = uniInput;

        // Add Glyph button
        var addBtn = new lively.morphic.Button(lively.rect(340, 5, 90, 26), 'Add Glyph');
        addBtn.setLabel('Add Glyph');
        lively.bindings.connect(addBtn, 'fire', {onFire: function() {
            var ch = self._uniInput && self._uniInput.textString || 'A';
            self.addNewGlyph(ch);
        }}, 'onFire');
        bar.addMorph(addBtn);

        // Export button
        var exportBtn = new lively.morphic.Button(lively.rect(445, 5, 100, 26), 'Export .otf');
        exportBtn.setLabel('Export .otf');
        lively.bindings.connect(exportBtn, 'fire', {onFire: function() {
            self.exportFont();
        }}, 'onFire');
        bar.addMorph(exportBtn);

        // Hint
        var hint = new lively.morphic.Text(lively.rect(560, 9, 210, 18),
            'Ctrl+click glyph → edit control points');
        hint.setFontSize(10);
        hint.setTextColor(Color.rgb(160, 160, 160));
        hint.beLabel();
        bar.addMorph(hint);

        this.addMorph(bar);
        this._toolbar = bar;
    },

    _buildCanvas: function() {
        var canvas = new lively.morphic.Morph(new lively.morphic.Shapes.Rectangle(lively.rect(0, 36, this.CANVAS_W, this.CANVAS_H)));
        canvas.setFill(Color.rgb(255, 255, 255));
        canvas.setBorderWidth(0);
        canvas.applyStyle({ enableGrabbing: false, enableHalos: false, enableMorphMenu: false });
        this.addMorph(canvas);
        this._canvas = canvas;
    },

    _buildGlyphTray: function() {
        var tray = new lively.morphic.Morph(
            new lively.morphic.Shapes.Rectangle(lively.rect(0, 36 + this.CANVAS_H, this.CANVAS_W, 80)));
        tray.setFill(Color.rgb(230, 230, 235));
        tray.setBorderWidth(0);
        var label = new lively.morphic.Text(lively.rect(8, 8, 80, 18), 'Glyph Set:');
        label.setFontSize(11);
        label.setTextColor(Color.rgb(80, 80, 80));
        label.beLabel();
        tray.addMorph(label);
        this.addMorph(tray);
        this._glyphTray = tray;
    },

    _buildGuideLines: function() {
        var W = this.CANVAS_W, self = this;
        var guides = [
            { y: this.ASCENDER,    color: Color.rgb(180, 220, 255), label: 'ascender' },
            { y: this.CAP_HEIGHT,  color: Color.rgb(100, 180, 100), label: 'cap height' },
            { y: this.X_HEIGHT,    color: Color.rgb(150, 200, 150), label: 'x-height' },
            { y: this.BASELINE,    color: Color.rgb(200, 80,  80),  label: 'baseline' },
            { y: this.DESCENDER,   color: Color.rgb(180, 130, 220), label: 'descender' },
        ];
        guides.forEach(function(g) {
            var line = self._makeGuide(g.y, g.color, g.label);
            self._canvas.addMorph(line);
            self._guideLines.push(line);
        });
    },

    _makeGuide: function(y, color, label) {
        var W = this.CANVAS_W;
        var line = new lively.morphic.Path([pt(0, y), pt(W, y)]);
        line.setBorderColor(color);
        line.setBorderWidth(1);
        line.setFill(null);
        line.applyStyle({ enableGrabbing: false, enableHalos: false,
                          enableMorphMenu: false, draggingEnabled: false });
        // Dashed via CSS
        if (line.getNode) {
            var node = line.renderContext && line.renderContext.morphNode;
            if (node) {
                var svgEl = node.querySelector('path,svg,polyline');
                if (svgEl) svgEl.style.strokeDasharray = '6,4';
            }
        }
        // Label
        var lbl = new lively.morphic.Text(lively.rect(W - 72, y - 14, 70, 14), label);
        lbl.setFontSize(9);
        lbl.setTextColor(color);
        lbl.beLabel();
        line.addMorph(lbl);
        return line;
    },
},
'glyph management', {
    addGlyph: function(glyphMorph) {
        // addMorph first so the render context exists, then setPosition.
        // Offset each successive glyph rightward using advanceWidth.
        var count = this.glyphs.length,
            gw    = glyphMorph.advanceWidth || 280,
            gx    = 40 + count * (gw + 60),
            gy    = this.ASCENDER;
        this._canvas.addMorph(glyphMorph);
        glyphMorph.setPosition(pt(gx, gy));
        this.glyphs.push(glyphMorph);
        this.activeGlyph = glyphMorph;
        this._addGlyphToTray(glyphMorph);
    },

    addNewGlyph: function(unicodeChar) {
        var glyph = apps.GlyphEditor.GlyphEditor.makeDefaultGlyph(unicodeChar || 'A');
        this.addGlyph(glyph);
    },

    _addGlyphToTray: function(glyphMorph) {
        var tray    = this._glyphTray,
            count   = this.glyphs.length,
            thumbX  = 90 + (count - 1) * 52,
            thumb   = new lively.morphic.Text(
                lively.rect(thumbX, 8, 44, 60),
                glyphMorph.unicodeChar);
        thumb.setFontSize(36);
        thumb.setFontWeight('bold');
        thumb.setTextColor(Color.rgb(60, 60, 60));
        thumb.beLabel();
        tray.addMorph(thumb);
    },
},
'font export', {
    exportFont: function() {
        lively.require('apps.GlyphEditor.FontExporter').toRun(function() {
            apps.GlyphEditor.FontExporter.exportGlyphs(this.glyphs);
        }.bind(this));
    },
});


// ============================================================
// Factory helpers – exported on the module namespace
// ============================================================

Object.extend(apps.GlyphEditor.GlyphEditor, {

    makeDefaultGlyph: function(unicodeChar) {
        // Create a sample glyph shape for the given character.
        // The path is defined in screen-pixel coordinates; y increases downward.
        // Metrics: UPM=1000, scale=0.4px/unit, baseline offset handled by editor.
        var glyph = new lively.morphic.GlyphMorph(unicodeChar || 'A');

        // All-cubic-Bezier 'A': every explicit segment has control point handles.
        // Collinear handles = initially straight; pull any blue/red square to add curvature.
        // The final closing segment (bottom-left → apex) is a straight ClosePath and
        // has no handles — all other 6 segments are fully editable cubics.
        var verts = [
            pt(140,  0),   // 0 apex
            pt(280, 380),  // 1 bottom-right outer foot
            pt(220, 380),  // 2 bottom-right inner foot
            pt(160, 210),  // 3 right crossbar
            pt(120, 210),  // 4 left  crossbar
            pt( 60, 380),  // 5 bottom-left inner foot
            pt(  0, 380),  // 6 bottom-left outer foot
        ];

        // Returns {c1, c2}: collinear control points for a straight cubic segment a→b.
        function collin(a, b) {
            return {
                c1: pt(a.x + (b.x - a.x) / 3,       a.y + (b.y - a.y) / 3),
                c2: pt(a.x + 2 * (b.x - a.x) / 3,   a.y + 2 * (b.y - a.y) / 3)
            };
        }

        var cps1 = [null], cps2 = [null]; // index 0 = MoveTo, no control points

        // Segment 0→1: right outer leg — slight outward bow to start with
        cps1.push(pt(180,  80));
        cps2.push(pt(310, 290));

        // Segments 1→2 through 5→6: collinear (straight until the user pulls the handles)
        for (var i = 1; i < verts.length - 1; i++) {
            var c = collin(verts[i], verts[i + 1]);
            cps1.push(c.c1);
            cps2.push(c.c2);
        }

        glyph.initDefaultPath(verts, cps1, cps2, true);
        glyph.setAdvanceWidth(280);
        glyph.setBorderWidth(1.5);
        glyph.setBorderColor(Color.rgb(40, 40, 40));
        glyph.setFill(Color.rgb(30, 30, 30));

        return glyph;
    },

    openEditor: function() {
        var editor = new lively.morphic.GlyphEditorMorph();
        editor.openInWorld(pt(40, 40));
        // Add a default 'A' glyph to start
        editor.addNewGlyph('A');
        return editor;
    },

});


}) // end of module
