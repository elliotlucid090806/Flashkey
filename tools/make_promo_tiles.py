#!/usr/bin/env python3
"""
FlashKey — Chrome Web Store promo tiles (Pillow).

    python3 tools/make_promo_tiles.py [output_dir]

Writes, into output_dir (default: <project>/store-assets):
    small_promo_tile_440x280.png       440 x 280, 24-bit RGB, no alpha
    marquee_promo_tile_1400x560.png   1400 x 560, 24-bit RGB, no alpha

Everything is drawn as vectors at 4x (small) / 3x (marquee) and downsampled with
Lanczos, so edges and type are crisp. The keycap + lightning-bolt mark uses the
same geometry as flashkey/icons/icon.svg. Fonts: Inter if installed, otherwise
DejaVu Sans / Liberation Sans / Cantarell (whatever fc-match finds).
"""
import os
import subprocess
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ----------------------------------------------------------------------------- fonts

def _fc_match(pattern):
    try:
        out = subprocess.run(["fc-match", "-f", "%{file}", pattern], capture_output=True, text=True, timeout=5).stdout.strip()
        return out if out and os.path.exists(out) else None
    except Exception:
        return None


def _first(paths):
    for p in paths:
        if p and os.path.exists(p):
            return p
    return None


SANS = {
    "bold": _first([
        "/usr/share/fonts/opentype/inter/InterDisplay-Bold.otf",
        "/usr/share/fonts/opentype/inter/Inter-Bold.otf",
        "/usr/share/fonts/rsms-inter-fonts/InterDisplay-Bold.otf",
        "/usr/share/fonts/rsms-inter-fonts/Inter-Bold.otf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
    ]) or _fc_match("Inter:bold") or _fc_match("sans:bold"),
    "semibold": _first([
        "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf",
        "/usr/share/fonts/rsms-inter-fonts/Inter-SemiBold.otf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
    ]) or _fc_match("Inter:semibold") or _fc_match("sans:bold"),
    "medium": _first([
        "/usr/share/fonts/opentype/inter/Inter-Medium.otf",
        "/usr/share/fonts/rsms-inter-fonts/Inter-Medium.otf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
    ]) or _fc_match("Inter:medium") or _fc_match("sans"),
    "regular": _first([
        "/usr/share/fonts/opentype/inter/Inter-Regular.otf",
        "/usr/share/fonts/rsms-inter-fonts/Inter-Regular.otf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
    ]) or _fc_match("Inter") or _fc_match("sans"),
}


def _mono_font():
    p = _first([
        "/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Bold.ttf",
        "/usr/share/fonts/jetbrains-mono-fonts/JetBrainsMono-Bold.otf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/liberation-mono/LiberationMono-Bold.ttf",
    ])
    if p:
        return (p, 0)
    ttc = _first(["/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Bold.ttc"])
    if ttc:
        for i in range(30):
            try:
                if "Mono CJK SC" in " ".join(ImageFont.truetype(ttc, 20, index=i).getname()):
                    return (ttc, i)
            except Exception:
                break
    p = _fc_match("monospace:bold")
    return (p, 0) if p else (SANS["bold"], 0)


MONO = _mono_font()


def font(kind, px):
    if kind == "mono":
        return ImageFont.truetype(MONO[0], int(px), index=MONO[1])
    return ImageFont.truetype(SANS[kind], int(px))

# ----------------------------------------------------------------------------- helpers

def hexrgb(h, a=255):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def linear_gradient(size, c0, c1, angle_deg=135):
    """Diagonal gradient, built small and upscaled smoothly (no banding steps)."""
    w, h = size
    sw, sh = 256, max(2, round(256 * h / w))
    import math
    ax, ay = math.cos(math.radians(angle_deg - 90)), math.sin(math.radians(angle_deg - 90))
    small = Image.new("RGBA", (sw, sh))
    px = small.load()
    corners = [0 * ax + 0 * ay, sw * ax, sh * ay, sw * ax + sh * ay]
    lo, hi = min(corners), max(corners)
    for y in range(sh):
        for x in range(sw):
            t = ((x * ax + y * ay) - lo) / (hi - lo)
            px[x, y] = lerp(c0, c1, t)
    return small.resize(size, Image.BICUBIC)


def radial_glow(size, center, radius, color, peak_alpha):
    """Soft radial glow as an RGBA layer."""
    w, h = size
    layer = Image.new("L", size, 0)
    d = ImageDraw.Draw(layer)
    cx, cy = center
    d.ellipse([cx - radius, cy - radius * 0.72, cx + radius, cy + radius * 0.72], fill=255)
    layer = layer.filter(ImageFilter.GaussianBlur(radius * 0.45))
    alpha = layer.point(lambda v: round(v * peak_alpha))
    out = Image.new("RGBA", size, color[:3] + (0,))
    out.putalpha(alpha)
    return out


def rounded_mask(size, box, r):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle(box, radius=r, fill=255)
    return m


def drop_shadow(base, box, r, blur, offset, alpha):
    m = rounded_mask(base.size, [box[0] + offset[0], box[1] + offset[1], box[2] + offset[0], box[3] + offset[1]], r)
    m = m.filter(ImageFilter.GaussianBlur(blur)).point(lambda v: round(v * alpha))
    sh = Image.new("RGBA", base.size, (0, 0, 0, 0))
    sh.putalpha(m)
    base.alpha_composite(sh)


def fill_mask(base, mask, fill):
    """Composite a solid color or an RGBA image through a mask."""
    src = fill if isinstance(fill, Image.Image) else Image.new("RGBA", base.size, fill)
    a = src.getchannel("A") if src.mode == "RGBA" else Image.new("L", base.size, 255)
    layer = src.copy()
    layer.putalpha(ImageChops.multiply(a, mask))
    base.alpha_composite(layer)


def text_w(f, s):
    b = f.getbbox(s)
    return b[2] - b[0]


def draw_text(base, xy, s, f, color, anchor="ls"):
    d = ImageDraw.Draw(base)
    d.text(xy, s, font=f, fill=color, anchor=anchor)

# ----------------------------------------------------------------------------- brand mark

BOLT24 = [(13.5, 2.0), (4.5, 13.6), (10.6, 13.6), (9.4, 22.0), (18.5, 10.3), (12.3, 10.3)]


def bolt_points(cx, cy, scale):
    return [(cx + (x - 11.5) * scale, cy + (y - 12.0) * scale) for x, y in BOLT24]


def amber_bolt(base, cx, cy, scale, glow=True):
    """Lightning bolt with an amber→gold gradient and soft glow."""
    pts = bolt_points(cx, cy, scale)
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    if glow:
        g = mask.filter(ImageFilter.GaussianBlur(scale * 2.4)).point(lambda v: round(v * 0.55))
        layer = Image.new("RGBA", base.size, hexrgb("#F59E0B"))
        layer.putalpha(g)
        base.alpha_composite(layer)
    top, bottom = cy - 12 * scale, cy + 12 * scale
    grad = Image.new("RGBA", (1, 256))
    for i in range(256):
        grad.putpixel((0, i), lerp(hexrgb("#FCD34D"), hexrgb("#F59E0B"), i / 255))
    grad = grad.resize((base.size[0], max(1, round(bottom - top))), Image.BICUBIC)
    full = Image.new("RGBA", base.size, hexrgb("#F59E0B"))
    full.paste(grad, (0, round(top)))
    fill_mask(base, mask, full)


def keycap_mark(base, x, y, s):
    """FlashKey app mark (dark keycap + amber bolt) at top-left x,y with side s."""
    k = s / 128.0
    R = lambda a, b, c, d: [x + a * k, y + b * k, x + c * k, y + d * k]
    # ambient amber halo so the dark keycap reads on a dark background
    halo = Image.new("L", base.size, 0)
    ImageDraw.Draw(halo).rounded_rectangle(R(6, 6, 122, 122), radius=26 * k, fill=255)
    halo = halo.filter(ImageFilter.GaussianBlur(18 * k)).point(lambda v: round(v * 0.35))
    hl = Image.new("RGBA", base.size, hexrgb("#F59E0B"))
    hl.putalpha(halo)
    base.alpha_composite(hl)
    d = ImageDraw.Draw(base)
    d.rounded_rectangle(R(6, 6, 122, 122), radius=26 * k, fill=hexrgb("#16181D"), outline=hexrgb("#353B48"), width=max(1, round(1.5 * k)))
    d.rounded_rectangle(R(14, 11, 114, 105), radius=19 * k, fill=hexrgb("#3C424F"))
    d.rounded_rectangle(R(14, 13, 114, 105), radius=19 * k, fill=hexrgb("#262A33"))
    amber_bolt(base, x + 64 * k, y + 59 * k, 3.6 * k, glow=False)

# ----------------------------------------------------------------------------- small tile

def small_tile(out_path):
    S = 4
    W, H = 440 * S, 280 * S
    img = linear_gradient((W, H), hexrgb("#0F1117"), hexrgb("#181C26"), 135)
    img.alpha_composite(radial_glow((W, H), (W // 2, int(H * 0.44)), int(170 * S), hexrgb("#F59E0B"), 0.13))
    img.alpha_composite(radial_glow((W, H), (W // 2, int(H * 0.36)), int(90 * S), hexrgb("#FCD34D"), 0.06))

    # Brand row: mark + wordmark, centered as a unit
    mark = 62 * S
    title_f = font("bold", 50 * S)
    gap = 16 * S
    tw = text_w(title_f, "FlashKey")
    row_w = mark + gap + tw
    x0 = (W - row_w) // 2
    row_cy = 88 * S
    keycap_mark(img, x0, row_cy - mark // 2, mark)
    draw_text(img, (x0 + mark + gap, row_cy), "FlashKey", title_f, hexrgb("#FFFFFF"), anchor="lm")

    # Subtitle
    sub_f = font("medium", 19.5 * S)
    draw_text(img, (W // 2, 148 * S), "Instant Offline Text Expander", sub_f, hexrgb("#94A3B8"), anchor="mm")

    # Feature pill: [;sig] → Best regards, Elliot
    key_f = font("mono", 15 * S)
    out_f = font("semibold", 15.5 * S)
    arrow_f = font("semibold", 16 * S)
    key_txt, out_txt = ";sig", "Best regards, Elliot"
    kpad_x, kh = 9 * S, 27 * S
    kw = text_w(key_f, key_txt) + 2 * kpad_x
    aw = text_w(arrow_f, "→")
    ow = text_w(out_f, out_txt)
    inner = kw + 13 * S + aw + 13 * S + ow
    ph = 46 * S
    pw = inner + 2 * 12 * S
    px0 = (W - pw) // 2
    py0 = 196 * S
    box = [px0, py0, px0 + pw, py0 + ph]
    drop_shadow(img, box, ph // 2, 14 * S, (0, 6 * S), 0.55)
    # amber border glow
    gm = rounded_mask(img.size, box, ph // 2).filter(ImageFilter.GaussianBlur(7 * S)).point(lambda v: round(v * 0.30))
    gl = Image.new("RGBA", img.size, hexrgb("#F59E0B"))
    gl.putalpha(gm)
    img.alpha_composite(gl)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(box, radius=ph // 2, fill=hexrgb("#141821"), outline=hexrgb("#F59E0B", 215), width=round(1.5 * S))
    cy = py0 + ph // 2
    kx = px0 + 12 * S
    kbox = [kx, cy - kh // 2, kx + kw, cy + kh // 2]
    d.rounded_rectangle([kbox[0], kbox[1], kbox[2], kbox[3] + 3 * S], radius=6 * S, fill=hexrgb("#B97800"))
    d.rounded_rectangle(kbox, radius=6 * S, fill=hexrgb("#FBBF24"))
    draw_text(img, ((kbox[0] + kbox[2]) // 2, cy + S), key_txt, key_f, hexrgb("#16181D"), anchor="mm")
    ax = kbox[2] + 13 * S
    draw_text(img, (ax, cy), "→", arrow_f, hexrgb("#F59E0B"), anchor="lm")
    draw_text(img, (ax + aw + 13 * S, cy), out_txt, out_f, hexrgb("#F1F5F9"), anchor="lm")

    final = img.resize((440, 280), Image.LANCZOS).convert("RGB")
    final.save(out_path, "PNG", optimize=True)
    return final

# ----------------------------------------------------------------------------- marquee icons

def badge_icon(base, kind, cx, cy, r, S):
    """Small vector glyphs for the feature badges (drawn, not emoji, for crisp output)."""
    d = ImageDraw.Draw(base)
    amber = hexrgb("#FBBF24")
    lw = round(2.2 * S)
    if kind == "bolt":
        amber_bolt(base, cx, cy, r / 11.0, glow=False)
    elif kind == "lock":
        bw, bh = r * 1.25, r * 0.95
        d.arc([cx - r * 0.42, cy - r * 0.95, cx + r * 0.42, cy - r * 0.05], 180, 360, fill=amber, width=lw)
        d.line([cx - r * 0.42, cy - r * 0.5, cx - r * 0.42, cy - r * 0.08], fill=amber, width=lw)
        d.line([cx + r * 0.42, cy - r * 0.5, cx + r * 0.42, cy - r * 0.08], fill=amber, width=lw)
        d.rounded_rectangle([cx - bw / 2, cy - r * 0.12, cx + bw / 2, cy - r * 0.12 + bh], radius=r * 0.18, fill=amber)
        d.ellipse([cx - r * 0.12, cy + r * 0.2, cx + r * 0.12, cy + r * 0.44], fill=hexrgb("#1A1F2B"))
    elif kind == "box":
        t, m, b = cy - r * 0.85, cy - r * 0.35, cy + r * 0.85
        L, C, Rr = cx - r * 0.85, cx, cx + r * 0.85
        top = [(C, t), (Rr, cy - r * 0.55), (C, cy - r * 0.15), (L, cy - r * 0.55)]
        d.polygon(top, fill=hexrgb("#FCD34D"))
        d.polygon([(L, cy - r * 0.55), (C, cy - r * 0.15), (C, b), (L, cy + r * 0.45)], fill=hexrgb("#F59E0B"))
        d.polygon([(Rr, cy - r * 0.55), (C, cy - r * 0.15), (C, b), (Rr, cy + r * 0.45)], fill=hexrgb("#D97706"))
    elif kind == "free":
        f = font("bold", r * 1.9)
        draw_text(base, (cx, cy + r * 0.05), "∞", f, amber, anchor="mm")


def marquee(out_path):
    S = 3
    W, H = 1400 * S, 560 * S
    M = 60 * S  # safe margin
    img = linear_gradient((W, H), hexrgb("#090D16"), hexrgb("#0F172A"), 120)
    # very subtle grid for depth (kept faint so it never reads as "busy")
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for gx in range(0, W, 40 * S):
        gd.line([gx, 0, gx, H], fill=(148, 163, 184, 7), width=S)
    for gy in range(0, H, 40 * S):
        gd.line([0, gy, W, gy], fill=(148, 163, 184, 7), width=S)
    fade = Image.new("L", (W, H), 0)
    ImageDraw.Draw(fade).ellipse([int(W * 0.35), -int(H * 0.3), int(W * 1.15), int(H * 1.3)], fill=255)
    fade = fade.filter(ImageFilter.GaussianBlur(160 * S))
    grid.putalpha(ImageChops.multiply(grid.getchannel("A"), fade))
    img.alpha_composite(grid)
    # ambient glows (#F59E0B @ ~8%)
    img.alpha_composite(radial_glow((W, H), (int(W * 0.76), int(H * 0.50)), int(420 * S), hexrgb("#F59E0B"), 0.09))
    img.alpha_composite(radial_glow((W, H), (M + 60 * S, M + 50 * S), int(200 * S), hexrgb("#F59E0B"), 0.08))

    # ---------------- LEFT: brand, tagline, badges
    mark = 76 * S
    title_f = font("bold", 64 * S)
    lx = M
    brand_cy = M + 66 * S
    keycap_mark(img, lx, brand_cy - mark // 2, mark)
    draw_text(img, (lx + mark + 20 * S, brand_cy + 2 * S), "FlashKey", title_f, hexrgb("#FFFFFF"), anchor="lm")

    tag_f = font("regular", 26 * S)
    draw_text(img, (lx, M + 168 * S), "Type Less. Do More. 100% Private Text Expander.", tag_f, hexrgb("#94A3B8"), anchor="ls")

    badges = [
        ("bolt", "Instant Expansion", "<1 ms trigger match"),
        ("lock", "100% Local", "Zero cloud tracking"),
        ("box", "Ultra-Lightweight", "85 KB package"),
        ("free", "Free Forever", "No paywalls, no limits"),
    ]
    bw, bh, gapx, gapy = 334 * S, 72 * S, 16 * S, 16 * S
    by0 = M + 212 * S
    bt_f = font("semibold", 19 * S)
    bs_f = font("regular", 15.5 * S)
    d = ImageDraw.Draw(img)
    for i, (icon, title, sub) in enumerate(badges):
        col, row = i % 2, i // 2
        x = lx + col * (bw + gapx)
        y = by0 + row * (bh + gapy)
        box = [x, y, x + bw, y + bh]
        drop_shadow(img, box, 16 * S, 10 * S, (0, 4 * S), 0.35)
        d = ImageDraw.Draw(img)
        d.rounded_rectangle(box, radius=16 * S, fill=hexrgb("#111827", 235), outline=hexrgb("#334155"), width=S)
        icx, icy, ir = x + 38 * S, y + bh // 2, 19 * S
        d.rounded_rectangle([icx - ir, icy - ir, icx + ir, icy + ir], radius=11 * S, fill=hexrgb("#1A1F2B"), outline=hexrgb("#F59E0B", 90), width=S)
        badge_icon(img, icon, icx, icy, 11 * S, S)
        tx = x + 72 * S
        draw_text(img, (tx, y + 31 * S), title, bt_f, hexrgb("#F8FAFC"), anchor="ls")
        draw_text(img, (tx, y + 54 * S), sub, bs_f, hexrgb("#94A3B8"), anchor="ls")

    # ---------------- RIGHT: glass editor card
    cx0, cy0, cx1, cy1 = 812 * S, 84 * S, 1340 * S, 456 * S
    card = [cx0, cy0, cx1, cy1]
    drop_shadow(img, card, 22 * S, 40 * S, (0, 26 * S), 0.70)
    # glass: blur what is behind the card, tint it, add a top sheen
    behind = img.crop(card).filter(ImageFilter.GaussianBlur(24 * S))
    tint = Image.new("RGBA", behind.size, hexrgb("#1E293B", 150))
    behind.alpha_composite(tint)
    sheen = linear_gradient(behind.size, (255, 255, 255, 18), (255, 255, 255, 0), 180)
    behind.alpha_composite(sheen)
    cm = Image.new("L", behind.size, 0)
    ImageDraw.Draw(cm).rounded_rectangle([0, 0, behind.size[0] - 1, behind.size[1] - 1], radius=22 * S, fill=255)
    img.paste(behind, (cx0, cy0), cm)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(card, radius=22 * S, outline=hexrgb("#334155"), width=S)
    # title bar
    tb = cy0 + 48 * S
    d.line([cx0 + S, tb, cx1 - S, tb], fill=hexrgb("#334155"), width=S)
    for i in range(3):
        ex = cx0 + 26 * S + i * 18 * S
        d.ellipse([ex - 5 * S, cy0 + 24 * S - 5 * S, ex + 5 * S, cy0 + 24 * S + 5 * S], fill=hexrgb("#334155"))
    draw_text(img, ((cx0 + cx1) // 2, cy0 + 24 * S), "Reply to Sarah", font("medium", 14 * S), hexrgb("#64748B"), anchor="mm")

    # line 1 — what you type
    ix = cx0 + 34 * S
    lab_f = font("semibold", 12.5 * S)
    draw_text(img, (ix, cy0 + 86 * S), "You type", lab_f, hexrgb("#64748B"), anchor="ls")
    mono = font("mono", 30 * S)
    l1y = cy0 + 128 * S
    pre = "Thanks! "
    pre_f = font("regular", 26 * S)
    draw_text(img, (ix, l1y), pre, pre_f, hexrgb("#CBD5E1"), anchor="ls")
    kx = ix + text_w(pre_f, pre) + 10 * S
    kt = ";sig"
    kw = text_w(mono, kt) + 22 * S
    ktop, kbot = l1y - 30 * S, l1y + 9 * S
    d.rounded_rectangle([kx, ktop, kx + kw, kbot + 4 * S], radius=8 * S, fill=hexrgb("#0B0F17"))
    d.rounded_rectangle([kx, ktop, kx + kw, kbot], radius=8 * S, fill=hexrgb("#1F2633"), outline=hexrgb("#475569"), width=S)
    draw_text(img, (kx + kw // 2, (ktop + kbot) // 2 + S), kt, mono, hexrgb("#FCD34D"), anchor="mm")
    # glowing caret
    caret_x = kx + kw + 10 * S
    cmask = Image.new("L", img.size, 0)
    ImageDraw.Draw(cmask).rectangle([caret_x, ktop - 2 * S, caret_x + 3 * S, kbot + 2 * S], fill=255)
    glow = cmask.filter(ImageFilter.GaussianBlur(6 * S)).point(lambda v: min(255, round(v * 1.6)))
    gl = Image.new("RGBA", img.size, hexrgb("#F59E0B"))
    gl.putalpha(glow)
    img.alpha_composite(gl)
    fill_mask(img, cmask, hexrgb("#FCD34D"))

    # energy arrow
    d = ImageDraw.Draw(img)
    ay0, ay1 = cy0 + 150 * S, cy0 + 214 * S
    ax = ix + 18 * S
    amask = Image.new("L", img.size, 0)
    ad = ImageDraw.Draw(amask)
    ad.line([ax, ay0, ax, ay1 - 14 * S], fill=255, width=3 * S)
    ad.polygon([(ax - 10 * S, ay1 - 18 * S), (ax + 10 * S, ay1 - 18 * S), (ax, ay1)], fill=255)
    ag = amask.filter(ImageFilter.GaussianBlur(7 * S)).point(lambda v: round(v * 0.7))
    gl = Image.new("RGBA", img.size, hexrgb("#F59E0B"))
    gl.putalpha(ag)
    img.alpha_composite(gl)
    grad = linear_gradient(img.size, hexrgb("#FCD34D"), hexrgb("#F59E0B"), 180)
    fill_mask(img, amask, grad)
    # spark (4-point star)
    sx, sy, sr = ax + 30 * S, (ay0 + ay1) // 2 - 4 * S, 9 * S
    star = [(sx, sy - sr), (sx + sr * 0.28, sy - sr * 0.28), (sx + sr, sy), (sx + sr * 0.28, sy + sr * 0.28), (sx, sy + sr), (sx - sr * 0.28, sy + sr * 0.28), (sx - sr, sy), (sx - sr * 0.28, sy - sr * 0.28)]
    smask = Image.new("L", img.size, 0)
    ImageDraw.Draw(smask).polygon(star, fill=255)
    fill_mask(img, smask, hexrgb("#FDE68A"))
    draw_text(img, (sx + 22 * S, sy + 6 * S), "expands instantly", font("medium", 15 * S), hexrgb("#F59E0B"), anchor="ls")

    # line 2 — expanded output
    out_f = font("semibold", 30 * S)
    o1 = cy0 + 262 * S
    draw_text(img, (ix, o1), "Best regards,", out_f, hexrgb("#F8FAFC"), anchor="ls")
    draw_text(img, (ix, o1 + 44 * S), "Elliot", out_f, hexrgb("#67E8F9"), anchor="ls")
    nx = ix + text_w(out_f, "Elliot") + 12 * S
    draw_text(img, (nx, o1 + 44 * S), "| Founder", font("regular", 28 * S), hexrgb("#94A3B8"), anchor="ls")

    # floating Quick-Picker pill (overlaps the card's bottom-right edge, inside the safe zone)
    pill_f = font("semibold", 14.5 * S)
    kbd_f = font("semibold", 13 * S)
    keys = ["Ctrl", "Shift", "Space"]
    label = "Quick-Picker"
    kws = [text_w(kbd_f, k) + 16 * S for k in keys]
    plus_w = text_w(pill_f, "+")
    inner = sum(kws) + 2 * (plus_w + 12 * S) + 14 * S + text_w(pill_f, label)
    ph = 44 * S
    pw = inner + 32 * S
    px1 = cx1 - 22 * S
    px0 = px1 - pw
    py0 = cy1 - ph // 2
    pbox = [px0, py0, px1, py0 + ph]
    drop_shadow(img, pbox, ph // 2, 16 * S, (0, 8 * S), 0.6)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(pbox, radius=ph // 2, fill=hexrgb("#111827"), outline=hexrgb("#F59E0B", 200), width=round(1.5 * S))
    x = px0 + 16 * S
    mid = py0 + ph // 2
    for i, k in enumerate(keys):
        kb = [x, mid - 13 * S, x + kws[i], mid + 11 * S]
        d.rounded_rectangle([kb[0], kb[1], kb[2], kb[3] + 3 * S], radius=6 * S, fill=hexrgb("#0B0F17"))
        d.rounded_rectangle(kb, radius=6 * S, fill=hexrgb("#1F2633"), outline=hexrgb("#475569"), width=S)
        draw_text(img, ((kb[0] + kb[2]) // 2, (kb[1] + kb[3]) // 2 + S), k, kbd_f, hexrgb("#E2E8F0"), anchor="mm")
        x = kb[2]
        if i < len(keys) - 1:
            draw_text(img, (x + 6 * S + plus_w // 2, mid), "+", pill_f, hexrgb("#64748B"), anchor="mm")
            x += plus_w + 12 * S
    draw_text(img, (x + 14 * S, mid), label, pill_f, hexrgb("#FCD34D"), anchor="lm")

    final = img.resize((1400, 560), Image.LANCZOS).convert("RGB")
    final.save(out_path, "PNG", optimize=True)
    return final

# ----------------------------------------------------------------------------- main

def verify(path, size):
    with Image.open(path) as im:
        im.load()
        assert im.size == size, (path, im.size)
        assert im.mode == "RGB", (path, im.mode)
        assert "transparency" not in im.info, path
        return im.size, im.mode, os.path.getsize(path)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "store-assets")
    os.makedirs(out_dir, exist_ok=True)
    print("fonts:", SANS["bold"], "|", MONO[0], "index", MONO[1])
    jobs = [
        ("small_promo_tile_440x280.png", (440, 280), small_tile),
        ("marquee_promo_tile_1400x560.png", (1400, 560), marquee),
    ]
    for name, size, fn in jobs:
        path = os.path.join(out_dir, name)
        fn(path)
        (w, h), mode, nbytes = verify(path, size)
        print(f"OK  {path}  {w}x{h}  mode={mode} (24-bit, no alpha)  {nbytes:,} bytes")


if __name__ == "__main__":
    main()
