# GlyphEditor — Task Record

## What You Asked For

A **GlyphEditor** built as a proper **Lively Kernel Morphic** application — not a standalone prototype, but a real Lively world served from the LivelyKernel repo, leveraging the existing Morphic framework exactly as it was designed.

### Core Requirements

- A `glyphEditor.html` page served from LivelyKernel (like `welcome.html` or `blank.html`) that loads a proper Lively world
- **Ctrl+click** on a GlyphMorph "dives into" the character, revealing underlying **cubic Bezier** smoothed polygon geometry as editable control points
- **Direct manipulation via HandMorph** — grabbing a control point sends messages that update the shape's internal "meaning", triggering re-render
- Architecture following the VPRI / STEPS research philosophy:
  - Shape holds geometry; Morph holds behavior
  - Recursive embedding (a glyph can contain other morphs)
  - View = Object: editing and rendering are roles of the same Morph
- **Font table export** — mapping Morphic vector shapes to industry-standard binary font format using `opentype.js`
- Cubic Bezier (CFF/OpenType style), not quadratic
- `GlyphMorph extends PathMorph`, `GlyphEditorMorph extends PasteUpMorph/Morph`
- Metadata per glyph: `unicode_point`, `advance_width`, `kerning_pairs`

### What You Did NOT Want

- A reimplementation of Morphic from scratch
- Canvas-based drawing apps
- Toolbox-based interaction (Lively uses HandMorph and Halos, not toolbars)
- Halos triggered on regular click (correct trigger is Cmd/Ctrl+click)
- Anything that ignores the real LivelyKernel codebase

---

## What Was Done

### 1. Research Phase

- Read your design notes (`GlyphEditor_Notes.txt`, `GlyphEditor.txt`)
- Read the VPRI/STEPS research paper summary (page 6) describing the Universal Object Model and smoothed polygons as the mathematical basis for all 2D graphics including TTF fonts
- Read the Squeak Morphic wiki to understand the correct interaction model (HandMorph grabs, Halos are meta-actions triggered by blue-click)
- Cloned the LivelyKernel repo to `proto_lab/LivelyKernel/` with `git clone --depth=1`
- Read key LivelyKernel source files:
  - `core/lively/morphic/PathShapes.js` — confirmed `lively.morphic.Shapes.BezierCurve2CtlTo` (SVG `C`, true cubic Bezier with 2 control points), `reshape()`, `allPartNames()` encoding
  - `core/lively/morphic/Core.js` — confirmed `lively.morphic.Path` and `lively.morphic.World` class definitions, `applyStyle()` key mapping (`enableDragging` not `draggingEnabled`)
  - `core/lively/morphic/Events.js` — confirmed `onDragStart/onDrag/onDragEnd` event pattern, `evt.getPositionIn(morph)`, `halosEnabled` property, drag detection via `targetMorph.draggingEnabled`
  - `blank.html` — confirmed Lively world format: pre-rendered HTML + `<script type="text/x-lively-world">` JSON + `bootstrap.js`
  - `apps/ColorParser.js` — confirmed the `module('name').requires(...).toRun(fn)` pattern for app modules

### 2. Three Discarded Iterations (previous session)

Each was deleted because it reimplemented Morphic from scratch instead of using the real LivelyKernel:

| Iteration | Approach | Problem |
|-----------|----------|---------|
| 1 | Canvas-based, colored rectangles as glyphs, halos on regular click | Completely wrong on every level |
| 2 | SVG with `morph.js`, `glyphs.js`, `tools.js`, etc. | Still reimplementing Morphic |
| 3 | SVG with correct halo trigger, `submorphs`/`owner` terminology | Better concepts, still not real LivelyKernel |

### 3. Final Implementation

Built as a real Lively module loaded by the real LivelyKernel:

#### Files Created

| File | Description |
|------|-------------|
| `proto_lab/LivelyKernel/glyphEditor.html` | Lively world HTML — sets `Config.onStartWorld`, bootstraps the real Lively system, opens GlyphEditorMorph |
| `proto_lab/LivelyKernel/apps/GlyphEditor/GlyphEditor.js` | Main Lively module defining all GlyphEditor classes |
| `proto_lab/LivelyKernel/apps/GlyphEditor/FontExporter.js` | Font export module using opentype.js |
| `proto_lab/LivelyKernel/apps/GlyphEditor/lib/opentype.min.js` | opentype.js 1.3.4 (171KB, local copy) |

#### Classes Defined (`GlyphEditor.js`)

**`lively.morphic.Shapes.GlyphShape`** — extends `lively.morphic.Shapes.Path`
- `buildPath(vertices, cps1, cps2, closed)` — constructs SVG path from arrays of endpoints + cubic control points using `BezierCurve2CtlTo` (charCode `C`, true SVG cubic bezier)
- `reshape(ix, newPoint, lastCall)` — override handling the full `allPartNames()` encoding:
  - `0..N-1` → move vertex endpoint (`elem.x`, `elem.y`)
  - `N..2N-1` → move first control point (`elem.controlX1`, `elem.controlY1`)
  - `2N..3N-1` → move second control point (`elem.controlX2`, `elem.controlY2`)
- `getControlPointData()` — extracts `{ vertices, cps1, cps2, closed }` for font export

**`lively.morphic.ControlPointHandle`** — extends `lively.morphic.Morph`
- 8×8px draggable handle morph added to the canvas (not as submorph of GlyphMorph) so it is not occluded by the SVG element
- White squares = on-curve vertices, blue squares = first control points (cp1), red squares = second control points (cp2)
- Style uses `enableDragging: true` (the correct `applyStyle` key — not `draggingEnabled`)
- `onDragStart/onDrag/onDragEnd`: converts canvas-space event position to glyph-local via `canvasPos.subPt(glyphPos)`, calls `glyphMorph.shape.reshape(partIndex, localPos, lastCall)`
- `syncToShape(glyphPos)` — positions handle in canvas space using `shape.partPosition(partIndex)` + glyph offset

**`lively.morphic.GlyphMorph`** — extends `lively.morphic.Path`
- Metadata: `unicodeChar`, `advanceWidth`, `kerningPairs`
- Uses `GlyphShape` as its shape object (wired via `setShape()`, not direct assignment)
- Style uses `enableHalos: true` so Ctrl+click triggers the halo mechanism
- `showHalos()` override intercepts the halo trigger → calls `toggleDiveMode()` instead of showing actual halos
- `enterDiveMode()` / `exitDiveMode()` — builds/removes `ControlPointHandle` morphs and stem lines on the canvas
- `_buildHandles()` — adds stems first (below handles in z-order), then handles; stems use `ignoreEvents()` to be click-through
- `_makeStem(p1, p2)` — thin grey `lively.morphic.Path` line connecting a control point to its anchor vertex
- `_syncAllHandles()` — repositions all handles and updates all stem endpoints after every reshape
- `_stems` array tracks `{ morph, cpIndex, vertIndex }` for live stem updates

**`lively.morphic.GlyphEditorMorph`** — extends `lively.morphic.Morph`
- 780×700px container
- Dark toolbar: Unicode input field, "Add Glyph" button, "Export .otf" button
- Buttons wired via `lively.bindings.connect(btn, 'fire', handler, 'onFire')` (Lively buttons signal via `lively.bindings.signal`, not direct method calls)
- White canvas area with 5 metric guide lines (ascender, cap height, x-height, baseline, descender)
- Glyph tray at bottom showing character thumbnails
- `addGlyph(glyphMorph)` — calls `addMorph` first (establishes render context), then `setPosition`; offsets each successive glyph by `advanceWidth + 60px` so they don't overlap
- `exportFont()` — lazily requires `FontExporter` module and calls export

**`apps.GlyphEditor.GlyphEditor.makeDefaultGlyph(char)`** — factory
- Creates an all-cubic-Bezier template 'A' shape
- Every explicit segment (6 out of 7) is a `BezierCurve2CtlTo` with editable control points
- Segments 1–6 start with collinear (straight) control points — pull any blue/red handle to add curvature
- The closing segment (bottom-left foot → apex via `ClosePath`) is a straight line with no handles
- Results in 19 handles per glyph in dive mode: 7 white vertex squares + 12 blue/red CP squares

#### Font Export (`FontExporter.js`)

- Lazily loads `opentype.min.js` via dynamic `<script>` injection (avoids Lively module system complications with non-Lively libs)
- Path fixed to `/apps/GlyphEditor/lib/opentype.min.js` (not relative to `URL.codeBase` which resolves to `/core/`)
- Converts each `GlyphMorph` to an `opentype.Glyph`:
  - Y-axis flip (SVG is y-down, OpenType is y-up)
  - Scales screen pixels → font units (target cap-height = 700 UPM out of 1000)
  - Maps `BezierCurve2CtlTo` → `path.bezierCurveTo()`
  - Maps `QuadCurveTo` → `path.quadraticCurveTo()`
  - Maps `LineTo` → `path.lineTo()`
- Includes `.notdef` glyph at index 0 (required by OpenType spec)
- Downloads `.otf` file via `font.download()` or Blob URL fallback

#### World Bootstrap (`glyphEditor.html`)

- Generated from `blank.html` (same CSS, same pre-rendered World/HandMorph divs, same world JSON structure)
- Three patches applied:
  1. Title changed to "GlyphEditor"
  2. `Config.onStartWorld` set before `bootstrap.js` loads — fires after Lively finishes loading, requires `apps.GlyphEditor.GlyphEditor`, calls `openEditor()`
  3. `savedWorldAsURL` in the world JSON updated to `/glyphEditor.html`

### 4. Server Fix

- Initial `npm install` ran under Windows Git Bash → compiled `sqlite3.node` as a Windows PE binary
- `npm start` was run from WSL → tried to load it as Linux ELF → crash
- Fix: `npm rebuild` inside WSL recompiles native modules for the running environment
- Server runs successfully at `http://localhost:9001` after rebuild

### 5. Debugging Session — Bugs Found and Fixed

A full debugging pass was required to get the editor functional. Key bugs and root causes:

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| `setRenderContext is not a function` | `Morph.initialize(shape)` takes a Shape object; all callsites were passing `lively.rect()` geometry instead | Wrapped all with `new lively.morphic.Shapes.Rectangle(lively.rect(...))` |
| Ctrl+click showed halos, not dive mode | `onMouseDownEntry` intercepts ctrl+click before `onMouseDown` fires; halos are shown on mouseup via `showHalos()` | Override `showHalos()` on GlyphMorph to call `toggleDiveMode()` instead |
| Dive mode never triggered | `GlyphMorph.style.enableHalos: false` — prevented the halo mechanism from ever activating | Changed to `enableHalos: true` |
| Handles not draggable | Style key `draggingEnabled` is not processed by `applyStyle`; the correct key is `enableDragging` | Changed all occurrences of `draggingEnabled` → `enableDragging` in style objects |
| ControlPointHandles occluded by SVG | Handles added as submorphs of `GlyphMorph` (an SVG Path) sit behind the SVG element in DOM | Moved handles to `this.owner` (the canvas div morph) as sibling morphs |
| Buttons not firing | `addScript(function fire(){})` adds a method, but Lively buttons signal via `lively.bindings.signal` which only triggers attribute connections | Replaced with `lively.bindings.connect(btn, 'fire', handler, 'onFire')` |
| New glyphs not visible in canvas | `setPosition` called before `addMorph` — no render context exists yet, position is lost | Swapped order: `addMorph` first, then `setPosition` |
| opentype.js 404 | `URL.codeBase` resolves to `/core/`, making relative path load from `/core/apps/...` | Hardcoded path to `/apps/GlyphEditor/lib/opentype.min.js` |
| GlyphMorph shape not rendering | `this.shape = new GlyphShape()` bypasses render context wiring | Changed to `this.setShape(new GlyphShape())` |

### 6. Editing UX Improvements

- **All-Bezier default template**: `makeDefaultGlyph` now makes every explicit segment a cubic Bezier. Previously only 1 of 6 segments had control point handles (5 were LineTo with no handles). Now all 6 have handles — 12 blue/red CP handles + 7 white vertex handles = 19 total per glyph.
- **Stem lines**: `_buildHandles` now draws thin grey `lively.morphic.Path` lines connecting each control point back to its anchor vertex. Stems are click-through (`ignoreEvents()`), added behind handles in z-order, and update live on every drag via `_syncAllHandles`.
- **Stem indexing**: cp1 of element `i` (part index `N+i`) stems to vertex `i-1`; cp2 of element `i` (part index `2N+i`) stems to vertex `i`. Each interior vertex has two stems (in-handle and out-handle).

---

## How to Use

```bash
# Start server (from WSL bash)
cd /mnt/c/Users/Dream/Documents/Spellcasting/Art/keo_web/proto_lab/LivelyKernel
npm start

# Open in browser
http://localhost:9001/glyphEditor.html
```

**In the editor:**
- **Ctrl+click** a glyph → reveals cubic Bezier control point handles + grey stem lines
- **Drag white squares** → moves vertex anchor points
- **Drag blue squares** → adjusts outgoing Bezier tangent (cp1)
- **Drag red squares** → adjusts incoming Bezier tangent (cp2)
- **Add Glyph** → type a Unicode character in the input, click to add a new editable glyph to the right
- **Export .otf** → downloads a working OpenType font file

**Design note:** "Add Glyph" creates a new glyph *associated* with the unicode character (metadata for export) but always starts with the default 'A' template shape. Reshape it using the handles to draw the actual character.

---

## Key Architectural Principles Upheld

| Principle | How it's implemented |
|-----------|---------------------|
| Shape vs Morph | `GlyphShape` holds geometry; `GlyphMorph` holds behavior and submorphs |
| HandMorph as cursor | Drag events go through Lively's `onDragStart/onDrag/onDragEnd` pipeline |
| Halos are meta-actions | Halos NOT used for editing; Ctrl+click triggers `showHalos()` which we override to enter dive mode |
| Recursive embedding | ControlPointHandle morphs and stem morphs are siblings on the canvas, owned by the canvas morph |
| Smoothed polygons | `BezierCurve2CtlTo` (SVG `C`) = cubic Bezier, the mathematical basis per VPRI paper |
| Live rendering | `reshape()` updates path elements in place; Lively re-renders the SVG immediately |
| Programming in Meanings | `GlyphShape.reshape()` updates the "meaning" (control point geometry); rendering is Lively's concern |

## Known Limitations / Future Work

- The closing segment (last vertex → first vertex via `ClosePath`) has no editable handles. Fix: replace `ClosePath` with an explicit `BezierCurve2CtlTo` back to `verts[0]`, with special handling in `reshape()` to keep `verts[0]` and `verts[N]` in sync.
- No segment type toggle (line ↔ curve). Would require a right-click/modifier UI on segment midpoints.
- No smooth vs corner node distinction. A smooth node keeps cp1 and cp2 collinear through the anchor; a corner node lets them diverge independently.
- No node insertion/deletion. The `allPartNames()` negative indices support midpoint insertion in the base class but it is not yet wired up.
