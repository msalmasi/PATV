"""Pepe's Pad showcase art (1.99wq): the pad's avatar and banner, drawn as pixel art in the PATV style.

    python tools/gen-pepespad-art.py      -> tools/pepespad/avatar.png (512 x 512) + banner.png (1600 x 400)

Same pixel Pepe as the sticker packs (tools/gen-stickers.py: his head, eyes, mouth and palette), on the site's dark arcade
canvas (docs/design-system.md: --ds-bg #0f0f11, green #4caf50, gold #ffcf40, red for ON AIR). Each picture is drawn on a
small grid and scaled up with nearest-neighbour, so it stays crisp. Re-running it rewrites the files byte-for-byte the same.
tools/setup-pepes-pad.js uploads them through padlook.setImage (the site re-encodes to webp).
"""
import importlib.util
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "pepespad")
_spec = importlib.util.spec_from_file_location("gen_stickers", os.path.join(HERE, "gen-stickers.py"))
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)
Grid, G, GD, GL, K, W, R, RD = S.Grid, S.G, S.GD, S.GL, S.K, S.W, S.R, S.RD

BG, BG2, DEEP, LINE = "#0f0f11", "#141418", "#12301a", "#1f3a26"
GOLD, GOLD2, GOLDT = "#ffcf40", "#ff8a3d", "#ffe082"
GREEN, GREEN2 = "#4caf50", "#81c784"
ONAIR, ONAIR2 = "#e53935", "#ff8a80"
GREY, GREY2, GREY3 = "#24242a", "#33333b", "#4a4a55"
STAR = "#cfd8dc"

# a 5 x 7 pixel font (capitals, digits, a little punctuation)
F5 = {
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"], "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"], "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"], "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "G": ["01111", "10000", "10000", "10011", "10001", "10001", "01111"], "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "I": ["111", "010", "010", "010", "010", "010", "111"], "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"], "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"], "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"], "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"], "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"], "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"], "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    "'": ["1", "1", "0", "0", "0", "0", "0"], ".": ["0", "0", "0", "0", "0", "0", "1"], " ": ["000", "000", "000", "000", "000", "000", "000"],
    "-": ["000", "000", "000", "111", "000", "000", "000"], "+": ["000", "010", "010", "111", "010", "010", "000"],
}


def text5(g, s, x, y, c, scale=1, shadow=None):
    if shadow:
        text5(g, s, x + scale, y + scale, shadow, scale)
    for ch in s:
        rows = F5[ch]
        for ry, row in enumerate(rows):
            for rx, bit in enumerate(row):
                if bit == "1":
                    g.rect(x + rx * scale, y + ry * scale, x + rx * scale + scale - 1, y + ry * scale + scale - 1, c)
        x += (len(rows[0]) + 1) * scale
    return x


def width5(s, scale=1):
    return sum((len(F5[ch][0]) + 1) * scale for ch in s) - scale


def png(g, path, px):
    """The grid as a PNG, every cell px x px (nearest-neighbour); empty cells are the dark canvas."""
    im = Image.new("RGB", (g.w, g.h), BG)
    pal = {}
    for y in range(g.h):
        for x in range(g.w):
            c = g.px[y][x]
            if c:
                if c not in pal:
                    pal[c] = tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))
                im.putpixel((x, y), pal[c])
    im = im.resize((g.w * px, g.h * px), Image.NEAREST)
    im.save(path, optimize=True)


def paste(dst, src, ox, oy):
    for y in range(src.h):
        for x in range(src.w):
            c = src.px[y][x]
            if c:
                dst.set(ox + x, oy + y, c)


def pepe(kind="smile"):
    """The sticker Pepe head on its own 24 x 24 grid."""
    g = Grid(24, 24)
    S.pepe_head(g)
    S.eyes_normal(g)
    S.mouth(g, kind)
    return g


def tv(g, x0, y0, w, h, face=True, onair=True):
    """A retro TV set: antennae, a grey cabinet, a green-glow screen with scanlines (+ Pepe on it), knobs."""
    cx = x0 + w // 2
    for i in range(6):                                     # antennae
        g.set(cx - 2 - i, y0 - 1 - i, GREY3); g.set(cx + 2 + i, y0 - 1 - i, GREY3)
    g.rect(cx - 9, y0 - 8, cx - 8, y0 - 7, GOLD); g.rect(cx + 8, y0 - 8, cx + 9, y0 - 7, GOLD)
    g.rect(x0, y0, x0 + w - 1, y0 + h - 1, GREY)
    g.rect(x0 + 1, y0 + 1, x0 + w - 2, y0 + 1, GREY2)
    sx0, sy0, sx1, sy1 = x0 + 3, y0 + 3, x0 + w - 10, y0 + h - 4
    g.rect(sx0 - 1, sy0 - 1, sx1 + 1, sy1 + 1, K)
    g.rect(sx0, sy0, sx1, sy1, DEEP)
    for y in range(sy0, sy1 + 1, 2):
        g.rect(sx0, y, sx1, y, "#0f2615")
    if face:
        p = pepe("smile")
        paste(g, p, sx0 + (sx1 - sx0 + 1 - 24) // 2, sy0 + (sy1 - sy0 + 1 - 22) // 2)
    g.pts([(sx0 + 1, sy0 + 1), (sx0 + 2, sy0 + 1), (sx0 + 1, sy0 + 2)], "#2f6b3d")     # glass glint
    kx = x0 + w - 6                                        # knobs + speaker
    g.rect(kx - 1, y0 + 4, kx + 1, y0 + 6, GREY3); g.set(kx, y0 + 5, GOLD)
    g.rect(kx - 1, y0 + 9, kx + 1, y0 + 11, GREY3); g.set(kx, y0 + 10, GREEN)
    for yy in range(y0 + 14, y0 + h - 4, 2):
        g.rect(kx - 2, yy, kx + 2, yy, GREY2)
    g.rect(x0 + 3, y0 + h, x0 + 5, y0 + h + 1, GREY2); g.rect(x0 + w - 6, y0 + h, x0 + w - 4, y0 + h + 1, GREY2)     # feet
    if onair:                                              # the ON AIR sign on top
        lw = width5("ON AIR") + 4
        lx = x0 + 2
        g.rect(lx, y0 - 11, lx + lw - 1, y0 - 3, ONAIR)
        g.rect(lx + 1, y0 - 10, lx + lw - 2, y0 - 4, "#b71c1c")
        text5(g, "ON AIR", lx + 2, y0 - 10, "#ffebee")


def coin(g, x, y):
    g.rect(x + 1, y, x + 4, y, GOLD2); g.rect(x, y + 1, x + 5, y + 2, GOLD); g.rect(x + 1, y + 3, x + 4, y + 3, GOLD2)
    g.set(x + 2, y + 1, GOLDT); g.set(x + 3, y + 1, GOLDT)


def card(g, x, y, suit="heart"):
    g.rect(x, y, x + 7, y + 10, W); g.rect(x - 1, y + 1, x - 1, y + 9, "#cfcfcf"); g.rect(x + 8, y + 1, x + 8, y + 9, "#cfcfcf")
    if suit == "heart":
        S.heart(g, x + 2, y + 4, ONAIR)
    else:
        g.pts([(x + 4, y + 3), (x + 3, y + 4), (x + 4, y + 4), (x + 5, y + 4), (x + 2, y + 5), (x + 3, y + 5), (x + 4, y + 5), (x + 5, y + 5),
               (x + 6, y + 5), (x + 4, y + 6), (x + 3, y + 7), (x + 4, y + 7), (x + 5, y + 7)], K)
    g.set(x + 1, y + 1, ONAIR if suit == "heart" else K)


def ball(g, x, y):
    """A crystal ball (🔮 markets)."""
    g.ellipse(x + 4.5, y + 4.5, 4.6, 4.6, "#7e57c2")
    g.ellipse(x + 3.5, y + 3.5, 1.6, 1.6, "#d1c4e9")
    g.rect(x + 1, y + 9, x + 8, y + 10, "#5d4037")


def mic(g, x, y):
    g.rect(x + 1, y, x + 3, y + 4, "#9e9e9e"); g.pts([(x + 2, y + 1), (x + 2, y + 3)], "#e0e0e0")
    g.rect(x + 2, y + 5, x + 2, y + 9, GREY3); g.rect(x, y + 10, x + 4, y + 10, GREY3)


def note(g, x, y, c=GREEN2):
    g.rect(x + 2, y, x + 4, y, c); g.rect(x + 2, y, x + 2, y + 5, c); g.rect(x + 4, y, x + 4, y + 4, c)
    g.rect(x, y + 4, x + 1, y + 5, c); g.rect(x + 3, y + 4, x + 4, y + 5, c)


def avatar():
    """512 x 512: Pepe on a green glow, a TV antenna on his head (PATV's frog) and two gold sparkles."""
    g = Grid(32, 32)
    g.ellipse(16, 17, 15.5, 15.5, "#101d14")
    g.ellipse(16, 17, 13.5, 13.5, DEEP)
    p = pepe("smile")
    paste(g, p, 4, 9)
    for i in range(5):                                     # antennae on his head
        g.set(13 - i, 12 - i, GREY3); g.set(19 + i, 12 - i, GREY3)
    g.rect(7, 6, 8, 7, GOLD); g.rect(24, 6, 25, 7, GOLD)
    S.sparkle(g, 4, 6, GOLDT); S.sparkle(g, 28, 13, GOLDT)
    png(g, os.path.join(OUT, "avatar.png"), 16)


def banner():
    """1600 x 400 (200 x 50 cells, 4:1 - the pad header shows all of it): a night-sky station - PEPE'S PAD in gold over what's
    on, the ON AIR TV with Pepe on the right. The pad's name, badges and Follow button sit over the lower half, so everything
    that has to be read is in the top half and the bottom is a quiet skyline."""
    g = Grid(200, 50)
    bands = [BG, BG, "#101113", "#101214", "#111416", "#111618", "#12181a", "#121a1b", "#121c1c", "#12201d", "#12241d", "#12281c", "#122c1b", DEEP]
    for y in range(50):                                    # the sky: dark at the top, deep green at the bottom
        g.rect(0, y, 199, y, bands[min(len(bands) - 1, y * len(bands) // 50)])
    for (x, y, c) in [(7, 3, STAR), (41, 2, STAR), (66, 1, GOLDT), (104, 2, STAR), (121, 26, STAR), (133, 19, STAR),
                      (194, 3, STAR), (3, 25, STAR), (60, 30, STAR), (96, 33, STAR), (196, 20, STAR)]:
        g.set(x, y, c)
    S.sparkle(g, 5, 13, GOLDT); S.sparkle(g, 191, 12, GOLDT); S.sparkle(g, 128, 3, GOLDT)
    # the skyline: little buildings with lit windows (the pads)
    import random
    rnd = random.Random(7)
    x = 0
    while x < 200:
        w = rnd.randint(6, 13)
        h = rnd.randint(4, 9)
        g.rect(x, 49 - h, x + w - 1, 49, "#0b0f0c")
        for wy in range(49 - h + 2, 48, 3):
            for wx in range(x + 1, x + w - 1, 3):
                if rnd.random() < 0.38:
                    g.set(wx, wy, rnd.choice([GOLDT, GREEN2, "#ffcc80"]))
        x += w + rnd.randint(0, 2)
    g.rect(0, 48, 199, 49, "#0a0d0b")
    # the title
    t = "PEPE'S PAD"
    tw = width5(t, 2)
    tx, ty = 12, 4
    text5(g, t, tx + 1, ty + 1, "#5c3a00", 2)              # a one-cell drop shadow
    text5(g, t, tx, ty, GOLD, 2)
    for x in range(tx, tx + tw):                           # the top row of each letter catches the light
        if g.px[ty][x] == GOLD:
            g.set(x, ty, GOLDT)
    g.rect(tx, ty + 17, tx + tw - 1, ty + 17, GREEN)
    sub = "NEWS  CASINO  MARKETS"
    sx = tx + (tw - width5(sub)) // 2
    text5(g, sub, sx, ty + 20, GREEN2)
    for dx in (width5("NEWS") + 2, width5("NEWS  CASINO") + 2):   # dots between the words
        g.rect(sx + dx, ty + 23, sx + dx + 1, ty + 24, GOLD)
    coin(g, 124, 30); coin(g, 126, 27); coin(g, 125, 24)  # a little stack of PAT by the title
    # the station: an ON AIR TV with Pepe on screen
    tv(g, 136, 13, 44, 30)
    png(g, os.path.join(OUT, "banner.png"), 8)


def main():
    os.makedirs(OUT, exist_ok=True)
    avatar()
    banner()
    print("wrote", os.path.join(OUT, "avatar.png"), "and", os.path.join(OUT, "banner.png"))


if __name__ == "__main__":
    main()
