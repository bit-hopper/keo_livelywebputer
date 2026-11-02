#!/usr/bin/env python3
"""Write one or more Material Symbols Rounded icons as plain SVG files under core/media/material-icons/.

The repo no longer carries the per-icon SVG set (about 4000 files, 13 MB, none loaded by any code: icons render through the
vendored font, see core/styles/material-symbols.css). When a UI really needs a plain image (lively.morphic.Image) instead of a
font glyph, vendor just that icon:

    python bin/vendor-icon.py settings mic headset_off      # writes core/media/material-icons/<name>.svg for each
    python bin/vendor-icon.py --out some/dir settings       # somewhere else
    python bin/vendor-icon.py --list | grep -i camera        # every ligature name the font has

The outline is read from core/lib/material-symbols/MaterialSymbolsRounded-Regular.woff2 (no network). It is the same static
instance the font renders (FILL 0, wght 400, opsz 24), in the 24px / 0 -960 960 960 box the earlier SVG set used, so the
file is a drop-in for any `media/material-icons/<name>.svg` reference. Needs fontTools and brotli (pip install fonttools brotli).
"""
import argparse, os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(ROOT, 'core', 'lib', 'material-symbols', 'MaterialSymbolsRounded-Regular.woff2')
DEFAULT_OUT = os.path.join(ROOT, 'core', 'media', 'material-icons')


def ligatures(font):
    """ligature name -> glyph name, from the GSUB 'liga' lookups (the font spells each icon name as letters that ligate)."""
    cmap = font.getBestCmap()
    gsub = font['GSUB'].table
    out = {}
    for lookup in gsub.LookupList.Lookup:
        for st in lookup.SubTable:
            if st.LookupType == 7:      # extension
                st = st.ExtSubTable
            if getattr(st, "LookupType", 4) != 4:
                continue
            for first, ligs in getattr(st, 'ligatures', {}).items():
                for lig in ligs:
                    names = [first] + list(lig.Component)
                    chars = []
                    for g in names:
                        c = next((cp for cp, gn in cmap.items() if gn == g), None)
                        if c is None:
                            break
                        chars.append(chr(c))
                    else:
                        out[''.join(chars).lower()] = lig.LigGlyph      # the font spells ligatures in capitals
    return out


def svg_for(font, glyph):
    gs = font.getGlyphSet()
    upm = font['head'].unitsPerEm
    pen = SVGPathPen(gs, ntos=lambda v: ('%.1f' % v).rstrip('0').rstrip('.'))
    # the SVG set draws in a 960-unit box with the origin at the top (y from -960 to 0): scale the font's em to 960 and flip y
    s = 960.0 / upm
    gs[glyph].draw(TransformPen(pen, (s, 0, 0, -s, 0, 0)))
    return ('<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24"><path d="%s"/></svg>\n'
            % pen.getCommands())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('names', nargs='*', help='icon ligature names, e.g. settings')
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--list', action='store_true', help='print every available icon name and exit')
    a = ap.parse_args()
    font = TTFont(FONT)
    lig = ligatures(font)
    if a.list:
        print('\n'.join(sorted(lig)))
        return 0
    if not a.names:
        ap.error('give at least one icon name (or --list)')
    os.makedirs(a.out, exist_ok=True)
    bad = 0
    for n in a.names:
        if n not in lig:
            print('no such icon: ' + n, file=sys.stderr)
            bad += 1
            continue
        p = os.path.join(a.out, n + '.svg')
        open(p, 'w', newline='\n').write(svg_for(font, lig[n]))
        print('wrote ' + os.path.relpath(p, ROOT))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
