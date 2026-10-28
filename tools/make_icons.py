#!/usr/bin/env python3
"""
FlashKey icon generator — dependency-free (stock Python 3 only).

Draws the FlashKey mark (a dark keycap with an amber lightning bolt) with an
anti-aliasing supersampling rasterizer and writes crisp PNGs for every size
Chrome needs, plus a matching SVG for the Web Store listing.

    python3 tools/make_icons.py            # writes flashkey/icons/*
"""
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "flashkey", "icons")

INK = (22, 24, 29)        # keycap body
FACE = (38, 42, 51)       # keycap top face
EDGE = (60, 66, 79)       # subtle top highlight
BOLT = (255, 197, 61)     # amber
BOLT_SHADE = (232, 164, 0)

# Bolt from the 24-unit SVG path: M13.5 2 4.5 13.6h6.1L9.4 22l9.1-11.7h-6.2z
BOLT24 = [(13.5, 2.0), (4.5, 13.6), (10.6, 13.6), (9.4, 22.0), (18.5, 10.3), (12.3, 10.3)]


def rrect(x0, y0, x1, y1, r):
    def inside(x, y):
        if x < x0 or x > x1 or y < y0 or y > y1:
            return False
        cx = min(max(x, x0 + r), x1 - r)
        cy = min(max(y, y0 + r), y1 - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    return inside


def polygon(points):
    def inside(x, y):
        n = len(points)
        c = False
        j = n - 1
        for i in range(n):
            xi, yi = points[i]
            xj, yj = points[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                c = not c
            j = i
        return c
    return inside


def bolt(cx, cy, scale):
    return [(cx + (x - 11.5) * scale, cy + (y - 12.0) * scale) for x, y in BOLT24]


def shapes_for(size):
    """Shapes in a 128-unit design space, simplified for tiny sizes."""
    if size <= 16:
        return [
            (rrect(4, 4, 124, 124, 30), INK),
            (polygon(bolt(64, 64, 5.0)), BOLT),
        ]
    if size <= 32:
        return [
            (rrect(4, 4, 124, 124, 28), INK),
            (rrect(12, 10, 116, 106, 20), FACE),
            (polygon(bolt(64, 58, 4.1)), BOLT),
        ]
    return [
        (rrect(6, 6, 122, 122, 26), INK),
        (rrect(14, 11, 114, 105, 19), EDGE),
        (rrect(14, 13, 114, 105, 19), FACE),
        (polygon(bolt(65.2, 60.6, 3.6)), BOLT_SHADE),
        (polygon(bolt(64, 59, 3.6)), BOLT),
    ]


def render(size, ss=8):
    shapes = shapes_for(size)
    scale = 128.0 / size
    rows = []
    step = 1.0 / ss
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0.0, 0.0, 0.0]
            alpha = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) * step) * scale
                    y = (py + (sy + 0.5) * step) * scale
                    col = None
                    for test, color in shapes:
                        if test(x, y):
                            col = color
                    if col is not None:
                        acc[0] += col[0]
                        acc[1] += col[1]
                        acc[2] += col[2]
                        alpha += 1
            n = ss * ss
            if alpha:
                row += bytes((round(acc[0] / alpha), round(acc[1] / alpha), round(acc[2] / alpha), round(255 * alpha / n)))
            else:
                row += b"\x00\x00\x00\x00"
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect x="6" y="6" width="116" height="116" rx="26" fill="#16181d"/>
  <rect x="14" y="11" width="100" height="94" rx="19" fill="#3c424f"/>
  <rect x="14" y="13" width="100" height="92" rx="19" fill="#262a33"/>
  <polygon points="{shade}" fill="#e8a400"/>
  <polygon points="{bolt}" fill="#ffc53d"/>
</svg>
"""


def main():
    os.makedirs(OUT, exist_ok=True)
    sizes = [int(a) for a in sys.argv[1:]] or [16, 32, 48, 128]
    for s in sizes:
        rows = render(s, ss=8 if s <= 48 else 4)
        path = os.path.join(OUT, "icon%d.png" % s)
        write_png(path, s, rows)
        print("wrote", os.path.relpath(path, ROOT))
    fmt = lambda pts: " ".join("%.2f,%.2f" % p for p in pts)
    with open(os.path.join(OUT, "icon.svg"), "w") as f:
        f.write(SVG.format(shade=fmt(bolt(65.2, 60.6, 3.6)), bolt=fmt(bolt(64, 59, 3.6))))
    print("wrote", os.path.relpath(os.path.join(OUT, "icon.svg"), ROOT))


if __name__ == "__main__":
    main()
