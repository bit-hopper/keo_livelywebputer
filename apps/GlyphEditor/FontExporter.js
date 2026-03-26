module('apps.GlyphEditor.FontExporter')
    .requires('apps.GlyphEditor.GlyphEditor')
    .toRun(function() {

// ============================================================
// FontExporter
// Converts a collection of GlyphMorphs into an OpenType font
// using opentype.js, then triggers a browser download.
//
// opentype.js is loaded once from the local lib/ directory.
// ============================================================

Object.subclass('apps.GlyphEditor.FontExporter',
'documentation', {
    documentation: 'Converts GlyphMorphs to an .otf font via opentype.js',
},
'class-side helpers');

Object.extend(apps.GlyphEditor.FontExporter, {

    OPENTYPEJS_PATH: '/apps/GlyphEditor/lib/opentype.min.js',

    UPM:          1000,  // units per em
    ASCENDER:      800,
    DESCENDER:    -200,
    CAP_HEIGHT:    700,
    X_HEIGHT:      500,

    // --------------------------------------------------------
    // Public API
    // --------------------------------------------------------

    exportGlyphs: function(glyphMorphs, fontName) {
        this._ensureOpentype(function() {
            try {
                var font = apps.GlyphEditor.FontExporter._buildFont(glyphMorphs, fontName);
                apps.GlyphEditor.FontExporter._download(font, (fontName || 'MyGlyphFont') + '.otf');
            } catch (e) {
                alert('Font export failed:\n' + e.message);
                console.error(e);
            }
        });
    },

    // --------------------------------------------------------
    // opentype.js loader
    // --------------------------------------------------------

    _opentypeReady: false,

    _ensureOpentype: function(callback) {
        if (typeof opentype !== 'undefined') {
            this._opentypeReady = true;
        }
        if (this._opentypeReady) {
            callback();
            return;
        }
        var self   = this,
            script = document.createElement('script');
        script.src = this.OPENTYPEJS_PATH;
        script.onload = function() {
            self._opentypeReady = true;
            callback();
        };
        script.onerror = function() {
            alert('Could not load opentype.js from:\n' + self.OPENTYPEJS_PATH);
        };
        document.head.appendChild(script);
    },

    // --------------------------------------------------------
    // Font builder
    // --------------------------------------------------------

    _buildFont: function(glyphMorphs, fontName) {
        var UPM  = this.UPM,
            self = this;

        // opentype.js requires a .notdef glyph at index 0
        var notdefGlyph = new opentype.Glyph({
            name:         '.notdef',
            unicode:      0,
            advanceWidth: 500,
            path:         new opentype.Path()
        });

        var otGlyphs = [notdefGlyph];

        glyphMorphs.forEach(function(gm) {
            try {
                var otGlyph = self._morphToOTGlyph(gm, UPM);
                if (otGlyph) otGlyphs.push(otGlyph);
            } catch (e) {
                console.warn('Skipping glyph "' + gm.unicodeChar + '": ' + e.message);
            }
        });

        return new opentype.Font({
            familyName:   fontName || 'MyGlyphFont',
            styleName:    'Regular',
            unitsPerEm:   UPM,
            ascender:     this.ASCENDER,
            descender:    this.DESCENDER,
            glyphs:       otGlyphs,
        });
    },

    // --------------------------------------------------------
    // GlyphMorph → opentype.Glyph
    // --------------------------------------------------------

    _morphToOTGlyph: function(glyphMorph, UPM) {
        var shape  = glyphMorph.shape,
            data   = shape.getControlPointData
                         ? shape.getControlPointData()
                         : null;

        if (!data || !data.vertices || data.vertices.length < 2) {
            console.warn('GlyphMorph "' + glyphMorph.unicodeChar + '" has no usable path data');
            return null;
        }

        var path    = new opentype.Path(),
            verts   = data.vertices,
            cps1    = data.cps1,
            cps2    = data.cps2,
            closed  = data.closed,
            scale   = this._computeScale(glyphMorph, UPM);

        // Flip Y: SVG has y-down, OpenType has y-up.
        // We shift by UPM * 0.8 (≈ cap-height) so the glyph sits on the baseline.
        var baselineOffset = UPM * 0.8;

        var toOT = function(screenPt) {
            return {
                x: Math.round(screenPt.x * scale),
                y: Math.round(baselineOffset - screenPt.y * scale)
            };
        };

        // MoveTo
        var start = toOT(verts[0]);
        path.moveTo(start.x, start.y);

        for (var i = 1; i < verts.length; i++) {
            var cp1  = cps1 && cps1[i],
                cp2  = cps2 && cps2[i],
                end  = toOT(verts[i]);

            if (cp1 && cp2) {
                var c1 = toOT(cp1), c2 = toOT(cp2);
                path.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
            } else if (cp1) {
                var c1 = toOT(cp1);
                path.quadraticCurveTo(c1.x, c1.y, end.x, end.y);
            } else {
                path.lineTo(end.x, end.y);
            }
        }

        if (closed) path.close();

        return new opentype.Glyph({
            name:         'uni' + (glyphMorph.unicodeChar.codePointAt
                                    ? glyphMorph.unicodeChar.codePointAt(0).toString(16).toUpperCase()
                                    : glyphMorph.unicodeChar.charCodeAt(0).toString(16).toUpperCase()),
            unicode:      glyphMorph.unicodeChar.charCodeAt
                              ? glyphMorph.unicodeChar.charCodeAt(0)
                              : 0,
            advanceWidth: Math.round(glyphMorph.advanceWidth * scale),
            path:         path,
        });
    },

    _computeScale: function(glyphMorph, UPM) {
        // Scale screen pixels → font units.
        // Target: cap-height in screen pixels → CAP_HEIGHT in font units.
        var shape = glyphMorph.shape;
        var bounds = shape.bounds ? shape.bounds() : null;
        var screenCapHeight = bounds ? bounds.height : 380;
        return this.CAP_HEIGHT / (screenCapHeight || 380);
    },

    // --------------------------------------------------------
    // Download trigger
    // --------------------------------------------------------

    _download: function(font, filename) {
        var arrayBuffer = font.download ? null : font.toArrayBuffer();
        if (font.download) {
            // opentype.js v1+ has download() method
            font.download(filename);
            return;
        }
        // Fallback: manual download via Blob
        var blob = new Blob([arrayBuffer], { type: 'font/otf' });
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

});


}) // end of module
