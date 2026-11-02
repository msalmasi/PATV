"""Generate PATV's starter sticker packs as pixel-art SVGs (1.99iw, stickers.js / stickers.json).

    python tools/gen-stickers.py            -> public/stickers/<pack>/<sticker>.svg

Every sticker is drawn on a small pixel grid (24 x 24, text stickers 32 x 24) and written as runs of <rect>s with
shape-rendering="crispEdges", so it stays crisp at any size and is a few hundred bytes. The look follows the site's
pixel Pepe (public/img/pepe-looks/base-pixel.png) and the kawaii Pepe (base-kawaii.png). Re-running it rewrites the
files byte-for-byte the same.
"""
import math
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "stickers")

# ── canvas ──
class Grid:
    def __init__(self, w=24, h=24):
        self.w, self.h = w, h
        self.px = [[None] * w for _ in range(h)]

    def set(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h and c:
            self.px[y][x] = c

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.set(x, y, c)

    def pts(self, pts, c):
        for x, y in pts:
            self.set(x, y, c)

    def ellipse(self, cx, cy, rx, ry, c):
        for y in range(self.h):
            for x in range(self.w):
                if ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1.0:
                    self.set(x, y, c)

    def outline(self, fill, edge):
        """Paint `edge` on every empty pixel that touches a `fill` pixel (4-neighbour)."""
        add = []
        for y in range(self.h):
            for x in range(self.w):
                if self.px[y][x] is None:
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < self.w and 0 <= ny < self.h and self.px[ny][nx] == fill:
                            add.append((x, y))
                            break
        for x, y in add:
            self.px[y][x] = edge

    def svg(self, title):
        out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" shape-rendering="crispEdges">',
               f"<title>{title}</title>"]
        for y in range(self.h):
            x = 0
            while x < self.w:
                c = self.px[y][x]
                if c is None:
                    x += 1
                    continue
                run = 1
                while x + run < self.w and self.px[y][x + run] == c:
                    run += 1
                out.append(f'<rect x="{x}" y="{y}" width="{run}" height="1" fill="{c}"/>')
                x += run
        out.append("</svg>")
        return "\n".join(out) + "\n"


# ── palette ──
G, GD, GL = "#3fb950", "#1f6f2e", "#7ee08a"          # pixel Pepe green, outline, highlight
K, W, R, RD = "#111111", "#ffffff", "#e5383b", "#9d0208"
KG, KGD = "#9ccc65", "#4e7a2a"                         # kawaii green + its outline
PINK, HEART, GOLD, BLUE, PURPLE = "#ff8fab", "#ff4d6d", "#ffd23f", "#4cc9f0", "#9b5de5"


def pepe_head(g, limbs=None):
    """The pixel Pepe head (base-pixel look): two eye bumps over a wide face. `limbs(g)` adds green arms / hands
    before the outline so they share Pepe's edge (1.99lf packs)."""
    g.ellipse(8.5, 7.5, 4.6, 3.8, G)
    g.ellipse(16.0, 7.5, 4.6, 3.8, G)
    g.ellipse(12.0, 14.0, 10.4, 7.2, G)
    g.rect(3, 12, 20, 19, G)
    if limbs:
        limbs(g)
    g.outline(G, GD)
    g.pts([(6, 5), (7, 5), (14, 5), (15, 5), (4, 11)], GL)


def eyes_normal(g):
    for x0 in (6, 14):
        g.rect(x0, 7, x0 + 3, 8, W)
        g.rect(x0 + 1, 7, x0 + 2, 8, K)


def mouth(g, kind="flat"):
    if kind == "flat":
        g.rect(5, 14, 18, 14, R); g.rect(6, 15, 17, 15, RD)
    elif kind == "smile":
        g.rect(6, 15, 17, 15, R); g.pts([(5, 14), (18, 14)], R); g.rect(7, 16, 16, 16, RD)
    elif kind == "frown":
        g.rect(7, 15, 16, 15, R); g.pts([(6, 16), (17, 16)], R)
    elif kind == "o":
        g.rect(10, 14, 13, 17, RD); g.rect(11, 15, 12, 16, K)
    elif kind == "grin":
        g.rect(5, 14, 18, 17, RD); g.rect(6, 14, 17, 14, W); g.rect(7, 16, 16, 17, R)


def heart(g, x, y, c=HEART):
    g.pts([(x, y), (x + 1, y), (x + 3, y), (x + 4, y)], c)
    g.rect(x, y + 1, x + 4, y + 1, c)
    g.rect(x + 1, y + 2, x + 3, y + 2, c)
    g.set(x + 2, y + 3, c)


def sparkle(g, x, y, c=GOLD):
    g.pts([(x, y - 1), (x - 1, y), (x, y), (x + 1, y), (x, y + 1)], c)


def pixel_pack():
    out = {}

    g = Grid(); pepe_head(g); eyes_normal(g); mouth(g, "smile"); out["happy"] = ("Happy Pepe", g)

    g = Grid(); pepe_head(g)
    for x0 in (6, 14):
        g.rect(x0, 8, x0 + 3, 9, W); g.rect(x0 + 1, 9, x0 + 2, 9, K)
        g.rect(x0, 7, x0 + 3, 7, GD)
    mouth(g, "frown"); g.rect(7, 10, 7, 12, BLUE); g.set(7, 13, BLUE); out["sad"] = ("Sad Pepe", g)

    g = Grid(); pepe_head(g); eyes_normal(g)
    g.pts([(6, 6), (7, 6), (8, 7), (17, 6), (16, 6), (15, 7)], K)
    mouth(g, "flat"); g.pts([(20, 3), (21, 2), (21, 4), (22, 3)], R); out["angry"] = ("Angry Pepe", g)

    g = Grid(); pepe_head(g)
    for x0 in (5, 13):
        g.rect(x0, 5, x0 + 5, 9, W); g.rect(x0 + 2, 6, x0 + 3, 8, K)
    mouth(g, "o"); out["shocked"] = ("Shocked Pepe", g)

    g = Grid(); pepe_head(g)
    heart(g, 5, 6); heart(g, 13, 6)
    mouth(g, "smile"); out["love"] = ("Pepe in love", g)

    g = Grid(); pepe_head(g)
    g.rect(4, 6, 19, 6, K); g.rect(5, 7, 10, 9, K); g.rect(13, 7, 18, 9, K)
    g.pts([(6, 7), (14, 7)], "#5a5a5a")
    mouth(g, "flat"); out["cool"] = ("Cool Pepe", g)

    g = Grid(); pepe_head(g)
    g.rect(6, 8, 9, 8, K); g.rect(14, 8, 17, 8, K)
    g.rect(9, 15, 14, 15, R)
    g.pts([(18, 1), (19, 1), (20, 1), (19, 2), (18, 3), (19, 3), (20, 3)], W)
    g.pts([(21, 4), (22, 4), (21, 5), (21, 6), (22, 6)], W)
    out["sleepy"] = ("Sleepy Pepe", g)

    g = Grid(); pepe_head(g)
    g.pts([(6, 8), (7, 7), (8, 7), (9, 8), (14, 8), (15, 7), (16, 7), (17, 8)], K)
    mouth(g, "grin")
    g.rect(4, 9, 4, 12, BLUE); g.rect(19, 9, 19, 12, BLUE)
    out["lol"] = ("Crying laughing", g)
    return out


def kawaii_base(g):
    g.ellipse(7.5, 7.0, 3.4, 3.2, KG)
    g.ellipse(16.5, 7.0, 3.4, 3.2, KG)
    g.ellipse(12.0, 15.0, 9.6, 6.8, KG)
    g.outline(KG, KGD)
    g.rect(6, 7, 7, 8, K); g.rect(16, 7, 17, 8, K)      # dot eyes
    g.set(6, 7, W); g.set(16, 7, W)
    g.rect(5, 13, 6, 13, PINK); g.rect(17, 13, 18, 13, PINK)   # blush


def kawaii_pack():
    out = {}
    g = Grid(); kawaii_base(g); g.pts([(10, 14), (11, 15), (12, 14), (13, 15), (14, 14)], K); out["blush"] = ("Blushing", g)
    g = Grid(); kawaii_base(g); g.pts([(11, 14), (12, 15), (13, 14)], K)
    g.rect(20, 9, 22, 12, KG); g.pts([(20, 8), (22, 8)], KG); g.outline(KG, KGD); out["wave"] = ("Hi hi!", g)
    g = Grid(); kawaii_base(g); g.pts([(11, 14), (12, 15), (13, 14)], K); heart(g, 9, 17); heart(g, 18, 1); out["heart"] = ("Love you", g)
    g = Grid(); kawaii_base(g); g.pts([(11, 14), (12, 15), (13, 14)], K); sparkle(g, 2, 3); sparkle(g, 21, 3); sparkle(g, 21, 20, PINK)
    out["sparkle"] = ("Sparkly", g)
    g = Grid(); kawaii_base(g); g.pts([(11, 15), (12, 14), (13, 15)], K)
    g.rect(6, 9, 6, 12, BLUE); g.rect(17, 9, 17, 12, BLUE); out["cry"] = ("Teary", g)
    g = Grid(); kawaii_base(g); g.rect(10, 14, 14, 16, RD); g.rect(11, 16, 13, 16, PINK)
    g.rect(15, 17, 20, 21, GOLD); g.pts([(16, 18), (18, 19), (19, 18)], "#c98a00"); out["nom"] = ("Nom nom", g)
    g = Grid(); kawaii_base(g); g.pts([(11, 14), (12, 15), (13, 14)], K)
    g.rect(1, 16, 3, 19, KG); g.rect(1, 13, 1, 15, KG); g.rect(3, 13, 3, 15, KG); g.outline(KG, KGD); out["peace"] = ("Peace", g)
    g = Grid(); kawaii_base(g); g.pts([(11, 14), (12, 15), (13, 14)], K)
    g.pts([(12, 0), (11, 1), (12, 1), (13, 1), (10, 2), (11, 2), (12, 2), (13, 2), (14, 2), (11, 3), (13, 3)], GOLD)
    out["star"] = ("Star frog", g)
    return out


# ── a 3 x 5 pixel font for the text stickers ──
FONT = {
    "G": ["111", "100", "101", "101", "111"], "L": ["100", "100", "100", "100", "111"], "O": ["111", "101", "101", "101", "111"],
    "W": ["10001", "10001", "10101", "10101", "01010"], "P": ["111", "101", "111", "100", "100"], "N": ["101", "111", "111", "111", "101"],
    "A": ["010", "101", "111", "101", "101"], "I": ["111", "010", "010", "010", "111"], "R": ["110", "101", "110", "101", "101"],
    "B": ["110", "101", "110", "101", "110"], "T": ["111", "010", "010", "010", "010"], "F": ["111", "100", "110", "100", "100"],
    "E": ["111", "100", "110", "100", "111"], "S": ["111", "100", "111", "001", "111"], "H": ["101", "101", "111", "101", "101"],
    "Y": ["101", "101", "010", "010", "010"], "!": ["1", "1", "1", "0", "1"], "?": ["111", "001", "011", "000", "010"],
    "K": ["101", "101", "110", "101", "101"], "V": ["101", "101", "101", "101", "010"], "7": ["111", "001", "010", "010", "010"],
    " ": ["00", "00", "00", "00", "00"],
}


def text(g, s, x, y, c, scale=1):
    for ch in s:
        rows = FONT[ch]
        for ry, row in enumerate(rows):
            for rx, bit in enumerate(row):
                if bit == "1":
                    g.rect(x + rx * scale, y + ry * scale, x + rx * scale + scale - 1, y + ry * scale + scale - 1, c)
        x += (len(rows[0]) + 1) * scale


def text_width(s, scale=1):
    return sum((len(FONT[ch][0]) + 1) * scale for ch in s) - scale


def badge(label, bg, fg, scale=2, frog=True):
    g = Grid(32, 24)
    g.rect(1, 3, 30, 20, bg); g.rect(0, 4, 31, 19, bg); g.rect(2, 2, 29, 21, bg)
    g.outline(bg, K)
    tw = text_width(label, scale)
    text(g, label, (32 - tw) // 2, 12 - (5 * scale) // 2 + (1 if frog else 0), fg, scale)
    if frog:                                     # a tiny Pepe peeking over the top edge
        g.rect(3, 0, 5, 1, G); g.rect(8, 0, 10, 1, G); g.rect(3, 1, 10, 2, G)
        g.set(4, 0, W); g.set(9, 0, W)
    return g


def reacts_pack():
    out = {}
    out["gg"] = ("GG", badge("GG", PURPLE, W, 3))
    out["lol"] = ("LOL", badge("LOL", GOLD, K, 2))
    out["w"] = ("W", badge("W", G, W, 3))
    out["l"] = ("L", badge("L", R, W, 3))
    out["pog"] = ("POG", badge("POG", BLUE, K, 2))
    out["onair"] = ("ON AIR", None)
    g = Grid(32, 24); g.rect(1, 5, 30, 18, RD); g.rect(0, 6, 31, 17, RD); g.outline(RD, K)
    text(g, "ON", 2, 9, W, 1); text(g, "AIR", 11, 9, W, 1)
    g.ellipse(27.0, 11.5, 2.4, 2.4, R); g.set(27, 11, W)
    out["onair"] = ("On air", g)
    g = Grid(24, 24); g.ellipse(12, 12, 10.5, 10.5, GOLD); g.outline(GOLD, "#8a6100"); g.ellipse(12, 12, 7.2, 7.2, "#ffe680")
    text(g, "PAT", 6, 10, "#8a6100", 1); out["pat"] = ("PAT coin", g)
    g = badge("RIBBIT", G, W, 1, frog=False); text(g, "!", 28, 10, GOLD, 1); out["ribbit"] = ("Ribbit!", g)
    return out


# ── 1.99lf: three more packs (Mic Life, High Roller, Movie Night) ──
GREY, GREYD, GREYL = "#6c757d", "#3a3f44", "#adb5bd"
ORANGE, FELT, FELTD = "#ff8c42", "#0b6e4f", "#06402e"
TAPE, TAPED = "#e8dcc0", "#a8977a"
NAVY, CYAN = "#1d3557", "#2ec4d6"


def frame_box(g, x0, y0, x1, y1, fill, edge=K):
    """A filled box with a 1-px edge (drawn on top of whatever is there)."""
    g.rect(x0, y0, x1, y1, edge)
    g.rect(x0 + 1, y0 + 1, x1 - 1, y1 - 1, fill)


def stamp(g, shape, edge):
    """Outline a prop drawn on its own grid with `edge`, then paint it over g (so it reads on top of Pepe)."""
    fills = {c for row in shape.px for c in row if c}
    for c in fills:
        shape.outline(c, edge)
    for y in range(shape.h):
        for x in range(shape.w):
            if shape.px[y][x]:
                g.set(x, y, shape.px[y][x])


SEVEN = ["111111", "111111", "000011", "000110", "000110", "001100", "001100", "011000", "011000", "011000"]


def eyes_look(g, dx=0, dy=0):
    """Normal Pepe eyes with the pupils shifted (dx -1 / +1 = left / right, dy -1 = up)."""
    for x0 in (6, 14):
        g.rect(x0, 7, x0 + 3, 8, W)
        if dy < 0:
            g.rect(x0 + 1 + dx, 7, x0 + 2 + dx, 7, K)
        else:
            g.rect(x0 + 1 + dx, 7, x0 + 2 + dx, 8, K)


def mic_pack():
    out = {}

    # On mic: Pepe singing into a handheld mic, sound waves out the side
    g = Grid(); pepe_head(g); eyes_look(g, 0, -1); mouth(g, "o")
    g.rect(16, 18, 17, 23, K); g.rect(15, 20, 16, 23, K)                  # handle
    frame_box(g, 15, 13, 19, 18, GREYL); g.pts([(16, 14), (18, 14), (17, 15), (16, 16), (18, 16), (17, 17)], GREY)
    g.pts([(21, 12), (22, 13), (22, 14), (22, 15), (21, 16)], GOLD); g.pts([(23, 11), (23, 17)], GOLD)
    g.pts([(1, 1), (2, 2)], GOLD); g.pts([(0, 3), (1, 3)], GOLD)
    out["onmic"] = ("On mic", g)

    # Muted: an X of tape over the mouth
    g = Grid(); pepe_head(g); eyes_normal(g); g.rect(6, 7, 9, 7, GD); g.rect(14, 7, 17, 7, GD)
    for i in range(9):
        for x, y in ((7 + i, 12 + i * 5 // 8), (7 + i, 17 - i * 5 // 8)):
            g.rect(x, y, x + 1, y + 1, TAPE)
    g.pts([(7, 12), (7, 18), (16, 12), (16, 18)], TAPED)
    out["muted"] = ("Muted", g)

    # Cam on: Pepe in a camera viewfinder with a red REC dot
    g = Grid(); pepe_head(g); eyes_normal(g); mouth(g, "smile")
    for (cx, cy, sx, sy) in ((0, 0, 1, 1), (23, 0, -1, 1), (0, 23, 1, -1), (23, 23, -1, -1)):
        for i in range(4):
            g.set(cx + sx * i, cy, W); g.set(cx, cy + sy * i, W)
    g.rect(19, 2, 21, 4, R); g.set(19, 2, W)
    out["camon"] = ("Cam on", g)

    # AFK / BRB: grey and orange signs with Pepe peeking over
    out["afk"] = ("AFK", badge("AFK", GREY, W, 2))
    out["brb"] = ("BRB", badge("BRB", ORANGE, K, 2))

    # Me next! hand up for the mic queue
    g = Grid(); pepe_head(g); eyes_look(g, 1, -1); mouth(g, "smile")
    h = Grid(); h.rect(17, 4, 21, 8, GL); h.rect(18, 9, 20, 12, GL)
    for fx in (17, 19, 21):
        h.rect(fx, 1, fx, 3, GL)
    h.pts([(22, 6), (22, 7)], GL)
    stamp(g, h, GD); g.pts([(18, 2), (20, 2)], GD)
    out["handup"] = ("Me next!", g)

    # Vibing: headphones, eyes shut, little music note
    g = Grid(); pepe_head(g)
    g.pts([(6, 8), (7, 7), (8, 7), (9, 8), (14, 8), (15, 7), (16, 7), (17, 8)], K)
    mouth(g, "smile")
    g.rect(5, 1, 18, 1, K); g.pts([(4, 2), (19, 2), (3, 3), (20, 3)], K); g.rect(2, 4, 2, 8, K); g.rect(21, 4, 21, 8, K)
    frame_box(g, 0, 8, 3, 15, PURPLE); frame_box(g, 20, 8, 23, 15, PURPLE)
    g.pts([(1, 10), (22, 10)], "#c7a6ff")
    g.rect(11, 0, 11, 2, GOLD); g.pts([(10, 3), (11, 3), (12, 0), (13, 1)], GOLD)
    out["vibing"] = ("Vibing", g)

    # Who's talking? eyes darting, question marks
    g = Grid(); pepe_head(g); eyes_look(g, -1); mouth(g, "flat")
    text(g, "?", 20, 0, GOLD, 1); text(g, "?", 0, 0, GOLD, 1)
    out["who"] = ("Who's talking?", g)
    return out


def casino_pack():
    out = {}

    # Jackpot: a gold slot window, 7 7 7
    g = Grid(32, 24)
    g.rect(1, 3, 30, 20, GOLD); g.rect(0, 4, 31, 19, GOLD); g.rect(2, 2, 29, 21, GOLD); g.outline(GOLD, K)
    for x0 in (3, 12, 21):
        frame_box(g, x0, 5, x0 + 7, 18, W)
        for ry, row in enumerate(SEVEN):
            g.pts([(x0 + 1 + rx, 7 + ry) for rx, b in enumerate(row) if b == "1"], R)
    g.rect(3, 0, 5, 1, G); g.rect(8, 0, 10, 1, G); g.rect(3, 1, 10, 2, G); g.set(4, 0, W); g.set(9, 0, W)
    out["jackpot"] = ("Jackpot!", g)

    # All in: felt sign + three chip stacks
    g = Grid(32, 24)
    g.rect(1, 3, 30, 20, FELT); g.rect(0, 4, 31, 19, FELT); g.rect(2, 2, 29, 21, FELT); g.outline(FELT, K)
    text(g, "ALL IN", (32 - text_width("ALL IN")) // 2, 4, GOLD, 1)
    for x0, n, c in ((5, 3, R), (13, 5, BLUE), (21, 4, PURPLE)):
        for i in range(n):
            y = 18 - i * 2
            g.rect(x0, y, x0 + 5, y, c); g.pts([(x0 + 1, y), (x0 + 4, y)], W)
            g.rect(x0, y + 1, x0 + 5, y + 1, K)
    out["allin"] = ("All in", g)

    # Blackjack: an ace and a king
    g = Grid()
    frame_box(g, 1, 3, 12, 20, W); text(g, "A", 3, 5, K, 2); g.pts([(9, 17), (10, 17), (9, 18), (10, 18), (8, 16), (11, 16)], K)
    frame_box(g, 11, 4, 22, 21, W); text(g, "K", 13, 6, R, 2); heart(g, 16, 16, R)
    out["blackjack"] = ("Blackjack!", g)

    # Heist mode: Pepe in a balaclava
    g = Grid(); pepe_head(g)
    for y in range(g.h):
        for x in range(g.w):
            c = g.px[y][x]
            if c in (G, GL):
                g.px[y][x] = "#2b2d31" if (x + y) % 5 else "#3a3d44"
            elif c == GD:
                g.px[y][x] = K
    g.rect(5, 6, 18, 9, G); eyes_normal(g)
    g.rect(8, 13, 15, 16, G); g.rect(9, 14, 14, 14, R); g.pts([(8, 13), (15, 13)], R); g.rect(10, 15, 13, 15, RD)
    out["heist"] = ("Heist mode", g)

    # Busted: sad Pepe behind bars
    g = Grid(); pepe_head(g)
    for x0 in (6, 14):
        g.rect(x0, 8, x0 + 3, 9, W); g.rect(x0 + 1, 9, x0 + 2, 9, K); g.rect(x0, 7, x0 + 3, 7, GD)
    mouth(g, "frown")
    for x0 in (0, 11, 21):
        g.rect(x0, 0, x0 + 2, 23, GREYL); g.rect(x0 + 2, 0, x0 + 2, 23, GREY)
    g.rect(0, 0, 23, 1, GREYL); g.rect(0, 22, 23, 23, GREYL); g.rect(0, 1, 23, 1, GREY); g.rect(0, 23, 23, 23, GREY)
    out["busted"] = ("Busted", g)

    # Roll the dice: two red casino dice
    def die(g, x0, y0, pips):
        frame_box(g, x0, y0, x0 + 10, y0 + 10, R)
        g.pts([(x0 + 1, y0 + 1), (x0 + 2, y0 + 1), (x0 + 1, y0 + 2)], "#ff7b7e")
        for px, py in pips:
            g.rect(x0 + 1 + px, y0 + 1 + py, x0 + 2 + px, y0 + 2 + py, W)
    g = Grid(); die(g, 1, 2, [(0, 0), (3, 3), (6, 6)])
    die(g, 12, 12, [(0, 0), (6, 0), (0, 3), (6, 3), (0, 6), (6, 6)])
    out["dice"] = ("Roll the dice", g)

    # Cha-ching: $ eyes and a big grin
    g = Grid(); pepe_head(g)
    for x0 in (5, 14):
        g.rect(x0, 4, x0 + 4, 10, W)
        g.rect(x0 + 1, 5, x0 + 3, 5, "#2e9e44"); g.set(x0 + 1, 6, "#2e9e44"); g.rect(x0 + 1, 7, x0 + 3, 7, "#2e9e44")
        g.set(x0 + 3, 8, "#2e9e44"); g.rect(x0 + 1, 9, x0 + 3, 9, "#2e9e44"); g.set(x0 + 2, 4, "#2e9e44"); g.set(x0 + 2, 10, "#2e9e44")
    mouth(g, "grin"); sparkle(g, 22, 2); sparkle(g, 1, 20)
    out["chaching"] = ("Cha-ching", g)

    # Pepeball: the lotto ball
    g = Grid(); g.ellipse(12, 12, 10.6, 10.6, W); g.outline(W, K)
    for y in range(g.h):
        for x in range(g.w):
            if g.px[y][x] == W and ((x + 0.5 - 12) ** 2 + (y + 0.5 - 12) ** 2) > 49 and x + y > 26:
                g.px[y][x] = "#d0d4da"
    g.ellipse(12, 12, 6.2, 6.2, G); g.outline(G, GD)
    text(g, "P", 9, 7, W, 2); g.pts([(5, 5), (6, 4), (5, 6)], "#f1f3f5")
    out["pepeball"] = ("Pepeball", g)
    return out


def movie_pack():
    out = {}

    # Popcorn time: peeking over a striped bucket
    g = Grid(); pepe_head(g); eyes_look(g, 1)
    for y in range(13, 24):
        inset = (y - 13) // 4
        for x in range(5 + inset, 19 - inset):
            g.set(x, y, R if ((x - 5) // 2) % 2 == 0 else W)
        g.set(4 + inset, y, K); g.set(19 - inset, y, K)
    for x, y in ((5, 12), (6, 11), (7, 12), (8, 11), (9, 10), (10, 11), (11, 12), (12, 11), (13, 10), (14, 11),
                 (15, 12), (16, 11), (17, 12), (18, 12), (7, 11), (11, 10), (15, 11), (12, 10)):
        g.set(x, y, "#fff3c4")
    g.pts([(6, 12), (9, 11), (12, 12), (14, 12), (16, 12), (10, 12), (8, 12), (13, 11)], GOLD)
    out["popcorn"] = ("Popcorn time", g)

    # 3D glasses
    g = Grid(); pepe_head(g)
    g.rect(3, 6, 20, 6, W); g.rect(3, 6, 3, 10, W); g.rect(20, 6, 20, 10, W); g.rect(11, 6, 12, 8, W)
    g.rect(4, 7, 10, 10, R); g.rect(13, 7, 19, 10, CYAN); g.rect(4, 10, 10, 10, W); g.rect(13, 10, 19, 10, W)
    g.pts([(5, 7), (14, 7)], "#ff9b9d")
    mouth(g, "o")
    out["glasses3d"] = ("3D glasses", g)

    # VHS tape
    g = Grid(32, 24)
    frame_box(g, 1, 4, 30, 20, "#2b2b33")
    g.rect(4, 6, 27, 11, W); g.rect(4, 6, 27, 6, R); text(g, "VHS", (32 - text_width("VHS")) // 2, 7, K, 1)
    g.rect(7, 13, 24, 18, GREYD)
    for cx in (10, 21):
        g.rect(cx - 2, 14, cx + 1, 17, GREYL); g.rect(cx - 1, 15, cx, 16, "#2b2b33")
    g.rect(13, 15, 18, 16, "#5a3a22")
    out["vhs"] = ("VHS", g)

    # Now showing: Pepe on an old CRT
    g = Grid()
    g.pts([(8, 1), (9, 2), (10, 3), (11, 4), (16, 1), (15, 2), (14, 3), (13, 4)], GREY)
    g.rect(11, 4, 13, 5, K)
    frame_box(g, 0, 6, 23, 22, "#8d6e63"); g.rect(1, 7, 22, 7, "#a98274")
    frame_box(g, 2, 8, 17, 20, NAVY)
    g.ellipse(7.5, 12.0, 2.2, 2.0, G); g.ellipse(12.0, 12.0, 2.2, 2.0, G); g.ellipse(9.75, 15.5, 5.6, 3.6, G)
    g.pts([(7, 12), (12, 12)], K); g.pts([(6, 11), (11, 11)], W); g.rect(7, 16, 12, 16, R)
    g.pts([(3, 9), (4, 9), (3, 10)], "#3c5a85")
    frame_box(g, 19, 9, 21, 11, GREYD); frame_box(g, 19, 13, 21, 15, GREYD); g.rect(19, 17, 21, 20, "#5d4037")
    g.pts([(19, 18), (21, 18), (19, 20), (21, 20)], "#4e342e")
    g.rect(2, 23, 4, 23, K); g.rect(19, 23, 21, 23, K)
    out["crt"] = ("Now showing", g)

    # Action! clapperboard
    g = Grid()
    for y in range(3, 8):
        for x in range(2, 22):
            g.set(x, y, W if ((x + (7 - y)) // 3) % 2 == 0 else K)
    g.rect(1, 2, 22, 2, K); g.rect(1, 8, 22, 8, K); g.rect(1, 2, 1, 8, K); g.rect(22, 2, 22, 8, K)
    frame_box(g, 1, 9, 22, 22, "#22222a", K)
    g.rect(3, 12, 20, 12, GREYL); g.rect(3, 16, 20, 16, GREYL); g.rect(12, 12, 12, 20, GREYL)
    g.rect(4, 18, 9, 19, W); g.rect(14, 18, 19, 19, W); g.rect(4, 14, 8, 14, GOLD)
    out["action"] = ("Action!", g)

    # Buffering: a little Pepe in a fading loading ring
    import math
    g = Grid()
    shades = ["#ffffff", "#e9ecef", "#ced4da", "#adb5bd", "#868e96", "#6c757d", "#495057", "#343a40"]
    for i in range(8):
        a = -math.pi / 2 + i * math.pi / 4
        cx, cy = 12 + 9.2 * math.cos(a), 12 + 9.2 * math.sin(a)
        g.rect(int(round(cx - 1.5)), int(round(cy - 1.5)), int(round(cx - 1.5)) + 2, int(round(cy - 1.5)) + 2, shades[i])
    g.ellipse(10.0, 10.5, 1.8, 1.7, G); g.ellipse(14.0, 10.5, 1.8, 1.7, G); g.ellipse(12.0, 13.5, 4.6, 3.2, G)
    g.outline(G, GD)
    g.pts([(9, 10), (13, 10)], W); g.pts([(10, 10), (14, 10)], K); g.rect(10, 14, 13, 14, R)
    out["buffering"] = ("Buffering...", g)

    # Be kind, rewind
    g = Grid(32, 24)
    g.rect(1, 3, 30, 20, NAVY); g.rect(0, 4, 31, 19, NAVY); g.rect(2, 2, 29, 21, NAVY); g.outline(NAVY, K)
    for x0 in (7, 15):
        for i in range(7):
            g.rect(x0 + i, 11 - i, x0 + i, 12 + i, W)
    g.rect(23, 5, 24, 18, W)
    g.rect(3, 0, 5, 1, G); g.rect(8, 0, 10, 1, G); g.rect(3, 1, 10, 2, G); g.set(4, 0, W); g.set(9, 0, W)
    out["rewind"] = ("Be kind, rewind", g)

    # No spoilers! hands over the eyes
    g = Grid(); pepe_head(g); mouth(g, "frown")
    h = Grid()
    for x0 in (4, 13):
        h.rect(x0, 6, x0 + 6, 11, GL)
        for fx in (x0, x0 + 2, x0 + 4, x0 + 6):
            h.rect(fx, 4, fx, 5, GL)
    stamp(g, h, GD)
    for x0 in (4, 13):
        g.rect(x0 + 1, 4, x0 + 1, 8, GD); g.rect(x0 + 3, 4, x0 + 3, 8, GD); g.rect(x0 + 5, 4, x0 + 5, 8, GD)
    out["nospoilers"] = ("No spoilers!", g)
    return out


# ── 1.99qp: 🎃 Spooky Season (Season Pass, seasonal) + 💎 Prime Time Plus (the pad tier's own pack). No text, no brands. ──
PUMPK, PUMPKD, PUMPKE = "#ff7b1c", "#c4520a", "#6b2a00"
GLOW = "#ffe066"
ZOMB, ZOMBD, ZOMBL = "#8fae7b", "#4b6343", "#b7cfa6"
MOON, MOOND = "#fff1b8", "#e6c86e"
GOLDD, GOLDL = "#b8860b", "#fff1a8"
DIAM, DIAMD, DIAML = "#7fdbff", "#1b7fa6", "#e6fbff"
PALE = "#4a4430"
HAT, HATD = "#6a3fa0", "#3c1a5b"


def pepe_head_c(g, body, edge, hi, limbs=None):
    """pepe_head in other colours (the zombie)."""
    g.ellipse(8.5, 7.5, 4.6, 3.8, body)
    g.ellipse(16.0, 7.5, 4.6, 3.8, body)
    g.ellipse(12.0, 14.0, 10.4, 7.2, body)
    g.rect(3, 12, 20, 19, body)
    if limbs:
        limbs(g)
    g.outline(body, edge)
    g.pts([(6, 5), (7, 5), (14, 5), (15, 5), (4, 11)], hi)


def spooky_pack():
    out = {}

    # Jack-o'-lantern with a curly stem
    g = Grid()
    g.ellipse(12.0, 14.5, 10.6, 8.2, PUMPK)
    g.outline(PUMPK, PUMPKE)
    for x in (8, 12, 16):
        for y in range(8, 22):
            if g.px[y][x] == PUMPK:
                g.set(x, y, PUMPKD)
    g.rect(11, 3, 13, 6, GD); g.pts([(14, 3), (15, 2), (16, 2)], G); g.pts([(10, 2), (9, 1)], GD)
    for x0 in (6, 14):                                   # triangle eyes
        g.rect(x0, 12, x0 + 3, 12, GLOW); g.rect(x0 + 1, 10, x0 + 2, 11, GLOW)
    g.rect(6, 16, 17, 17, GLOW)                          # zigzag grin
    g.pts([(8, 16), (11, 17), (14, 16), (16, 17)], PUMPKD)
    g.pts([(6, 15), (17, 15)], GLOW)
    out["pumpkin"] = ("Jack-o'-lantern", g)

    # Boo! Pepe under a sheet
    g = Grid()
    g.ellipse(8.5, 7.5, 4.6, 3.8, W); g.ellipse(16.0, 7.5, 4.6, 3.8, W); g.ellipse(12.0, 14.0, 10.4, 7.2, W)
    g.rect(2, 12, 21, 21, W)
    for x in range(2, 22):                               # wavy hem
        if (x // 3) % 2 == 1:
            g.px[21][x] = None
    g.outline(W, GREYL)
    g.rect(7, 7, 8, 9, K); g.rect(15, 7, 16, 9, K)
    g.rect(10, 13, 13, 16, K); g.rect(11, 14, 12, 15, RD)
    g.pts([(0, 4), (1, 3), (22, 2), (23, 1)], GREYL)
    out["ghost"] = ("Boo!", g)

    # Witch Pepe: a pointy purple hat
    g = Grid(); pepe_head(g); eyes_look(g, 1); mouth(g, "smile")
    h = Grid()
    h.rect(2, 4, 21, 5, HAT)
    for y in range(0, 4):
        h.rect(8 + y, y, 15 - y // 2, y, HAT)
    h.pts([(16, 0), (17, 0), (18, 1)], HAT)
    stamp(g, h, K)
    g.rect(9, 3, 14, 3, GOLD); g.set(11, 3, HATD)
    out["witch"] = ("Witch Pepe", g)

    # Vampire Pepe: red eyes, fangs, a high collar
    g = Grid(); pepe_head(g)
    for x0 in (6, 14):
        g.rect(x0, 7, x0 + 3, 8, W); g.rect(x0 + 1, 7, x0 + 2, 8, R)
    g.pts([(6, 6), (7, 6), (16, 6), (17, 6)], K)
    mouth(g, "flat"); g.pts([(8, 16), (15, 16), (8, 17), (15, 17)], W)
    for i in range(6):
        g.rect(0, 23 - i, 5 - i, 23 - i, K); g.rect(18 + i, 23 - i, 23, 23 - i, K)
        if i < 4:
            g.rect(1, 23 - i, max(1, 3 - i), 23 - i, RD); g.rect(min(22, 20 + i), 23 - i, 22, 23 - i, RD)
    out["vampire"] = ("Vampire Pepe", g)

    # A bat across the full moon
    g = Grid()
    g.ellipse(12.0, 11.5, 10.0, 10.0, MOON)
    g.pts([(7, 6), (8, 6), (8, 7), (15, 17), (16, 17), (16, 16), (17, 5)], MOOND)
    g.rect(11, 10, 12, 15, K); g.pts([(10, 9), (13, 9), (10, 10), (13, 10)], K)          # body + ears
    for dx in range(1, 10):                                                              # scalloped wings
        top = 12 - (dx + 1) // 2
        bot = 13 - (2 if dx % 3 == 0 else 0) - (1 if dx > 6 else 0)
        g.rect(11 - dx, top, 11 - dx, max(top, bot), K); g.rect(12 + dx, top, 12 + dx, max(top, bot), K)
    g.pts([(11, 11), (12, 11)], GOLD)
    out["moonbat"] = ("Night flight", g)

    # Sweet tooth: Pepe and floating wrapped candies
    g = Grid(); pepe_head(g); eyes_look(g, 0, -1); mouth(g, "grin")
    for cx, cy, c in ((3, 21, R), (12, 21, PURPLE), (20, 21, ORANGE), (2, 2, CYAN), (21, 2, PINK)):
        g.rect(cx - 1, cy - 1, cx + 1, cy + 1, c); g.set(cx, cy, W)
        g.pts([(cx - 2, cy - 1), (cx - 2, cy + 1), (cx + 2, cy - 1), (cx + 2, cy + 1)], c)
    out["candy"] = ("Sweet tooth", g)

    # Zombie Pepe: grey-green, a stitched cheek, one blank eye
    g = Grid(); pepe_head_c(g, ZOMB, ZOMBD, ZOMBL)
    g.rect(6, 7, 9, 8, W); g.rect(7, 8, 8, 8, K); g.rect(6, 7, 9, 7, ZOMBD)
    g.rect(14, 7, 17, 8, "#e9f0e1")
    g.rect(6, 15, 16, 15, RD); g.pts([(7, 16), (10, 16), (13, 16)], RD)
    g.rect(16, 11, 20, 11, K); g.pts([(17, 10), (19, 10), (17, 12), (19, 12)], K)
    out["zombie"] = ("Zombie Pepe", g)

    # A bubbling cauldron with Pepe's eyes peeking out of the brew
    g = Grid()
    e = Grid(); e.ellipse(8.5, 8.0, 2.6, 2.4, G); e.ellipse(15.5, 8.0, 2.6, 2.4, G); e.outline(G, GD)
    for y in range(e.h):
        for x in range(e.w):
            if e.px[y][x]:
                g.set(x, y, e.px[y][x])
    g.rect(7, 7, 9, 8, W); g.rect(14, 7, 16, 8, W); g.pts([(8, 8), (15, 8)], K)
    g.ellipse(12.0, 16.5, 10.0, 6.8, "#2b2b33"); g.rect(1, 10, 22, 11, "#2b2b33"); g.outline("#2b2b33", K)
    g.rect(3, 10, 20, 11, "#5ddc5d"); g.pts([(4, 9), (5, 9), (11, 9), (12, 9), (19, 9), (20, 9)], "#5ddc5d")
    g.pts([(5, 6), (12, 5), (19, 6), (11, 2), (20, 3)], "#9cf59c")
    g.rect(5, 22, 7, 23, K); g.rect(16, 22, 18, 23, K)
    out["cauldron"] = ("Bubble, bubble", g)
    return out


def plus_pack():
    out = {}

    # Crowned: Pepe in a gold crown
    g = Grid(); pepe_head(g); eyes_normal(g); mouth(g, "smile")
    c = Grid()
    c.rect(6, 2, 17, 4, GOLD); c.pts([(6, 1), (9, 0), (9, 1), (12, 0), (12, 1), (14, 0), (14, 1), (17, 1)], GOLD)
    stamp(g, c, GOLDD)
    g.pts([(9, 3), (14, 3)], R); g.set(12, 3, BLUE); g.pts([(7, 2), (10, 2), (13, 2), (16, 2)], GOLDL)
    out["crown"] = ("Crowned", g)

    # In the spotlight: a light cone from the top
    g = Grid()
    for y in range(24):
        half = 2 + y * 9 // 23
        g.rect(12 - half, y, 11 + half, y, PALE)
    g.rect(9, 0, 14, 1, GREYL); g.rect(10, 0, 13, 0, W)
    h = Grid(); pepe_head(h); eyes_look(h, 0, -1); mouth(h, "o")
    for y in range(24):
        for x in range(24):
            if h.px[y][x] and y >= 3 and y + 2 < 24:
                g.set(x, y + 2, h.px[y][x])
    g.pts([(2, 3), (21, 3), (1, 10), (22, 10)], GOLD)
    out["spotlight"] = ("In the spotlight", g)

    # Trophy
    g = Grid()
    t = Grid()
    t.rect(6, 2, 17, 4, GOLD); t.ellipse(12.0, 6.0, 6.2, 6.2, GOLD)
    t.rect(11, 12, 12, 15, GOLD); t.rect(8, 16, 15, 17, GOLD)
    t.pts([(3, 4), (4, 4), (3, 5), (3, 6), (4, 7), (5, 8), (20, 4), (19, 4), (20, 5), (20, 6), (19, 7), (18, 8)], GOLD)
    stamp(g, t, GOLDD)
    frame_box(g, 6, 18, 17, 22, "#5d4037"); g.rect(9, 20, 14, 20, GOLD)
    g.pts([(9, 4), (9, 5), (10, 3), (8, 6)], GOLDL)
    g.pts([(12, 6), (11, 7), (12, 7), (13, 7), (12, 8)], W)
    out["trophy"] = ("Champion", g)

    # Diamond with sparkles
    g = Grid()
    g.rect(7, 5, 16, 5, DIAM)
    for y in range(6, 9):
        g.rect(6 - (y - 6), y, 17 + (y - 6), y, DIAM)
    for y in range(9, 21):
        k = (y - 9) * 8 // 11
        g.rect(4 + k, y, 19 - k, y, DIAM)
    g.outline(DIAM, DIAMD)
    g.rect(4, 9, 19, 9, DIAMD)
    for y in range(10, 21):
        k = (y - 9) * 8 // 11
        span = 19 - 4 - 2 * k
        g.set(4 + k + span // 3, y, DIAMD); g.set(19 - k - span // 3, y, DIAMD)
    g.pts([(8, 6), (9, 6), (7, 7), (8, 10), (8, 11), (9, 12)], DIAML)
    sparkle(g, 21, 3, W); sparkle(g, 2, 18, DIAML); sparkle(g, 21, 18, GOLD)
    out["diamond"] = ("Diamond", g)

    # Studio camera with a red tally light
    g = Grid()
    frame_box(g, 2, 7, 15, 15, GREYD); g.rect(3, 8, 14, 8, GREY)
    frame_box(g, 15, 8, 21, 14, "#22222a"); g.ellipse(18.5, 11.0, 1.8, 1.8, DIAM); g.set(18, 10, W)
    g.rect(4, 4, 7, 6, R); g.set(5, 4, "#ff9b9d"); g.rect(4, 6, 7, 6, K)
    g.rect(10, 4, 13, 6, GREY)
    g.rect(8, 16, 9, 19, K)
    g.pts([(8, 20), (7, 21), (6, 22), (5, 23), (9, 20), (10, 21), (11, 22), (12, 23), (8, 21), (8, 22), (8, 23)], K)
    g.pts([(1, 2), (2, 1), (0, 1)], GOLD)
    out["camera"] = ("Rolling", g)

    # Red carpet: a runway in perspective between gold rope posts, a star at the end
    g = Grid()
    for y in range(8, 24):
        half = 2 + (y - 8) * 8 // 15
        g.rect(12 - half, y, 11 + half, y, R)
        g.set(12 - half, y, RD); g.set(11 + half, y, RD)
    for x, y in ((6, 10), (17, 10), (2, 16), (21, 16)):
        g.rect(x, y, x, y + 5, GOLD); g.rect(x - 1, y - 1, x + 1, y - 1, GOLD); g.rect(x - 1, y + 6, x + 1, y + 6, GOLDD)
    g.pts([(3, 14), (4, 13), (5, 12), (20, 14), (19, 13), (18, 12)], "#b0002a")
    g.pts([(12, 1), (11, 2), (12, 2), (13, 2), (9, 3), (10, 3), (11, 3), (12, 3), (13, 3), (14, 3), (15, 3),
           (11, 4), (12, 4), (13, 4), (10, 5), (11, 5), (13, 5), (14, 5)], GOLD)
    out["redcarpet"] = ("Red carpet", g)

    # Big time: dark shades and a gold chain
    g = Grid(); pepe_head(g); mouth(g, "smile")
    g.rect(4, 6, 19, 6, K); g.rect(5, 7, 10, 9, K); g.rect(13, 7, 18, 9, K); g.rect(11, 7, 12, 7, K)
    g.pts([(6, 7), (7, 7), (14, 7), (15, 7)], "#5a6b8c")
    for x in range(5, 19):
        g.set(x, 20 + (1 if 8 <= x <= 15 else 0) + (1 if 10 <= x <= 13 else 0), GOLD if x % 2 else GOLDD)
    g.rect(11, 22, 12, 23, GOLD); g.set(11, 22, GOLDL)
    sparkle(g, 21, 3, W); sparkle(g, 2, 2, GOLD)
    out["shades"] = ("Big time", g)

    # Golden mic on a stand
    g = Grid()
    m = Grid(); m.ellipse(12.0, 5.0, 3.6, 4.2, GOLD); m.rect(11, 9, 12, 11, GOLD)
    stamp(g, m, GOLDD)
    g.pts([(11, 2), (13, 2), (10, 4), (12, 4), (14, 4), (11, 6), (13, 6)], GOLDD); g.set(10, 3, GOLDL)
    g.rect(10, 12, 13, 12, K); g.rect(11, 13, 12, 20, GREY); g.rect(7, 21, 16, 22, GREYD)
    g.pts([(6, 3), (5, 2), (4, 4), (18, 3), (19, 2), (20, 4)], GOLD)
    sparkle(g, 3, 10, W); sparkle(g, 20, 10, W)
    out["goldmic"] = ("Golden mic", g)
    return out


# ── November 2026: 🍂 Fireside Season (Season Pass, seasonal: Nov 1 - Dec 1). Bonfire Night, cosy autumn, the feast and
#    moustache month - for the US and the UK alike. No text, no brands, no real people; every prop has a dark edge (the
#    site is dark-only). ──
LEAFO, LEAFR, LEAFG, LEAFB, LEAFE = "#e8772e", "#b5442a", "#f2b134", "#8a5a2b", "#4a2a12"   # leaves + their edge
RUST, RUSTD, MUST, CREAM, CREAMD = "#c0502e", "#5a2412", "#e0a526", "#f3e3c3", "#cdb88f"   # knit
COCOA, MUG, MUGL, MUGE = "#6b3e26", "#c0392b", "#e0604f", "#4a1410"                       # cocoa + a red mug
LOG, LOGL, LOGD = "#7a4a24", "#c08a52", "#3e2410"                                          # logs
CRUST, CRUSTL, CRUSTD, FILL, FILLD, PIEE = "#d9a35b", "#f0c987", "#a8702e", "#d2691e", "#9a4618", "#5a3412"
MOU, MOUE = "#6b4423", "#24160a"                                                           # moustache
MEAT, MEATL, MEATE = "#a0522d", "#d2884a", "#4a2208"                                       # roast drumstick
BONE, BONED = "#f3ead8", "#8d8270"


def leaf(g, x, y, c):
    """A 3x3 leaf with a stem pixel (top-left at x, y)."""
    g.pts([(x + 1, y), (x, y + 1), (x + 1, y + 1), (x + 2, y + 1), (x + 1, y + 2), (x + 2, y)], c)
    g.set(x, y + 2, LEAFB)


def burst(g, cx, cy, r, c, tip):
    """A firework: 8 dotted rays from a bright core, white-hot tips."""
    for d in range(2, r + 1):
        if d == r - 1 and r > 3:
            continue                                     # a gap near the tip so the rays read as sparks
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            g.set(cx + dx * d, cy + dy * d, tip if d == r else c)
        dd = round(d * 0.72)
        if dd >= 2:
            for dx, dy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
                g.set(cx + dx * dd, cy + dy * dd, tip if d == r else c)
    g.rect(cx - 1, cy - 1, cx + 1, cy + 1, c)
    g.set(cx, cy, W)


def fireside_pack():
    out = {}

    # Ooh, aah! - three firework bursts and a rising rocket trail (no Pepe: the sky is the star)
    g = Grid()
    for cx, cy, r, c, e in ((9, 8, 7, GOLD, "#8a6100"), (17, 16, 5, PINK, "#a8325a"), (19, 4, 3, CYAN, "#1b7fa6")):
        b = Grid(); burst(b, cx, cy, r, c, W)
        stamp(g, b, e)                                   # each burst gets a darker rim of its own colour
    g.pts([(6, 23), (6, 21), (7, 19), (7, 18)], GOLD)  # the trail of the next one going up
    out["fireworks"] = ("Ooh, aah!", g)

    # Toasty - a campfire on crossed logs, a marshmallow toasting on a stick
    g = Grid()
    for x in range(3, 21):                                                   # two crossed logs
        y1 = 18 + round((x - 3) * 4 / 17); y2 = 22 - round((x - 3) * 4 / 17)
        g.rect(x, y1, x, y1 + 1, LOG); g.rect(x, y2 - 1, x, y2, LOG)
    g.pts([(3, 18), (3, 19), (20, 18), (20, 19)], LOGL)                     # cut ends
    g.outline(LOG, LOGD); g.outline(LOGL, LOGD)
    f = Grid()                                                               # flame: red, orange, gold core
    f.ellipse(12.0, 15.5, 6.2, 4.6, R)
    for y in range(4, 12):
        half = max(0, (y - 4) * 5 // 7)
        f.rect(12 - half, y, 12 + half - (1 if y < 8 else 0), y, R)
    f.pts([(8, 8), (8, 9), (16, 7), (16, 8), (15, 6)], R)                    # side licks
    f.ellipse(12.0, 16.0, 4.2, 3.2, ORANGE); f.rect(11, 9, 13, 12, ORANGE); f.set(12, 8, ORANGE)
    f.ellipse(12.0, 16.8, 2.2, 2.0, GLOW); f.rect(12, 13, 12, 14, GLOW)
    stamp(g, f, RD)
    for i in range(9):                                                       # the stick, from the left edge (light: it shows on dark)
        g.set(i, 9 + i // 3, LOGL)
    g.rect(8, 10, 10, 12, CREAM); g.rect(8, 12, 10, 12, "#d08a3a"); g.set(10, 10, W)   # the marshmallow, toasting
    g.outline(CREAM, LOGD)
    g.pts([(9, 3), (15, 2), (17, 5)], GOLD)                                  # sparks
    out["toasty"] = ("Toasty", g)

    # Jump in! - Pepe's eyes peeking out of a big leaf pile, two leaves blowing past
    g = Grid(); pepe_head(g); eyes_look(g, 0, -1)
    pal = (LEAFO, LEAFR, LEAFG, LEAFB)
    m = Grid(); m.ellipse(12.0, 16.5, 10.4, 6.0, LEAFO)                    # a closed mound with a margin (review: no edge bleed)
    tops = {x: min(y for y in range(24) if m.px[y][x]) for x in range(24) if any(m.px[y][x] for y in range(24))}
    for x in (3, 8, 15, 20):                                                 # leaves sticking up out of the pile
        m.set(x, tops[x] - 1, LEAFO)
    shapes = (((1, 0), (0, 1), (1, 1), (2, 1)), ((0, 0), (1, 0), (2, 0), (1, 1)), ((0, 0), (1, 0), (1, 1)),
              ((1, 0), (0, 1), (1, 1)), ((0, 0), (0, 1), (1, 1)))
    for j, y0 in enumerate(range(8, 23, 2)):                                 # single leaves scattered over the orange, so they
        for i, x0 in enumerate(range(-1, 24, 3)):                            # show at 48 px (a fixed hash, not random)
            h = (i * 73 + j * 151 + 74 + i * j * 11) % 997
            x, y = x0 + (h % 3) - 1 + (j % 2), y0 + (h // 3) % 2
            c = pal[1 + (h // 7) % 3] if (h // 5) % 4 else LEAFO
            for dx, dy in shapes[(h // 11) % len(shapes)]:
                if 0 <= x + dx < 24 and 0 <= y + dy < 24 and m.px[y + dy][x + dx]:
                    m.px[y + dy][x + dx] = c
    stamp(g, m, LEAFE)
    leaf(g, 0, 1, LEAFG); leaf(g, 20, 0, LEAFR)
    g.outline(LEAFG, LEAFE); g.outline(LEAFR, LEAFE)
    out["leafpile"] = ("Jump in!", g)

    # Sweater weather - Pepe in a striped bobble hat and a chunky scarf, eyes shut, blushing, snug
    g = Grid(); pepe_head(g)
    for x0 in (6, 14):                                                       # happy closed eyes ^ ^
        g.pts([(x0, 8), (x0 + 1, 7), (x0 + 2, 7), (x0 + 3, 8)], K)
    g.pts([(4, 12), (5, 12), (18, 12), (19, 12)], PINK)
    mouth(g, "smile")
    h = Grid()
    h.rect(3, 4, 20, 5, CREAM)                                               # ribbed brim
    for x in range(3, 21, 2):
        h.set(x, 5, CREAMD)
    h.rect(5, 3, 18, 3, MUST); h.rect(6, 2, 17, 2, RUST); h.rect(8, 1, 15, 1, MUST)
    h.ellipse(12.0, 0.6, 2.2, 1.6, CREAM)                                    # the bobble
    stamp(g, h, RUSTD)
    s = Grid()
    s.rect(2, 18, 21, 20, RUST)
    for x in range(2, 22):
        if x % 4 == 1:
            s.rect(x, 18, x, 20, MUST)                                       # knit stripes
    s.rect(15, 21, 18, 22, RUST); s.rect(15, 21, 18, 21, MUST)              # the tail
    s.pts([(15, 23), (17, 23)], MUST)                                        # fringe
    stamp(g, s, RUSTD)
    out["snug"] = ("Sweater weather", g)

    # Hot cocoa - a red mug of cocoa with marshmallows and steam, Pepe's green hands round it
    g = Grid()
    for i, y in enumerate(range(0, 7)):                                      # two curls of steam
        g.set(9 + (1 if (i // 2) % 2 else 0), y, GREYL); g.set(14 - (1 if (i // 2) % 2 else 0), y + 1, GREYL)
    mg = Grid()
    mg.rect(5, 9, 17, 21, MUG); mg.rect(6, 22, 16, 22, MUG)                  # the mug
    mg.rect(6, 10, 7, 20, MUGL)                                              # shine
    mg.rect(18, 11, 20, 18, MUG)                                             # the handle (hollow in the middle)
    for y in range(13, 17):
        mg.px[y][18] = None
    mg.rect(6, 9, 16, 9, COCOA)
    mg.rect(7, 8, 8, 9, W); mg.rect(11, 7, 12, 8, PINK); mg.rect(14, 8, 15, 9, W)   # marshmallows
    stamp(g, mg, MUGE)
    hd = Grid(); hd.rect(3, 14, 6, 18, G); hd.rect(16, 15, 18, 19, G)
    stamp(g, hd, GD)
    g.pts([(4, 14), (17, 15)], GL)
    heart(g, 9, 14, W)                                                       # a little heart on the mug
    out["cocoa"] = ("Hot cocoa", g)

    # Distinguished - Pepe with a big curled handlebar moustache and a gold monocle (moustache month)
    g = Grid(); pepe_head(g); eyes_normal(g)
    g.rect(6, 7, 9, 7, GD)                                                   # one lid lowered: very refined
    mo = Grid()
    mo.rect(8, 12, 15, 12, MOU); mo.rect(6, 13, 17, 13, MOU)
    mo.rect(4, 14, 7, 14, MOU); mo.rect(16, 14, 19, 14, MOU)
    mo.pts([(3, 13), (2, 12), (3, 11), (20, 13), (21, 12), (20, 11)], MOU)   # curled tips
    for x, y in ((11, 13), (12, 13)):                                        # the centre notch
        mo.px[y][x] = None
    mouth(g, "smile")                                                       # under the moustache: its corners hide in the droops
    stamp(g, mo, MOUE)
    g.rect(14, 6, 17, 6, GOLD); g.rect(14, 9, 17, 9, GOLD); g.rect(13, 7, 13, 8, GOLD); g.rect(18, 7, 18, 8, GOLD)
    g.pts([(19, 10), (19, 11)], GOLD)                                        # the chain (short: the right curl mirrors the left)
    out["moustache"] = ("Distinguished", g)

    # Dibs - Pepe grinning at the roast drumstick he's holding (a Thanksgiving table or a Sunday roast)
    g = Grid(); pepe_head(g); eyes_look(g, dx=1); mouth(g, "grin")
    s = Grid()
    s.ellipse(15.5, 17.5, 3.9, 3.0, MEAT)
    s.pts([(18, 15), (19, 14), (19, 15), (20, 13), (20, 14), (21, 12), (21, 13)], MEAT)
    s.pts([(13, 16), (14, 16), (13, 17), (15, 15)], MEATL)                   # glaze
    stamp(g, s, MEATE)
    hd = Grid(); hd.rect(18, 14, 20, 16, G)                                  # his fist round the shank
    stamp(g, hd, GD)
    g.set(18, 14, GL)
    b = Grid()
    b.pts([(21, 11), (22, 11), (22, 10), (21, 10), (23, 10), (22, 9), (20, 10)], BONE)
    stamp(g, b, BONED)
    out["drumstick"] = ("Dibs", g)

    # Room for pie - a slice of pumpkin pie with a swirl of cream
    g = Grid()
    p = Grid()
    for x in range(2, 21):                                                   # the filling's top, a wedge to the point
        top = 16 - round((x - 2) * 8 / 18)
        p.rect(x, top, x, 16, FILL)
    p.rect(2, 17, 21, 19, FILLD); p.rect(2, 20, 21, 20, CRUSTD)             # the cut face + crust bottom
    p.rect(19, 7, 21, 19, CRUST)                                             # the back crust
    for y in range(7, 20, 2):
        p.set(21, y, CRUSTL)
    p.rect(19, 7, 21, 7, CRUSTL)
    stamp(g, p, PIEE)
    c = Grid()                                                               # a dollop of cream, widest at the bottom
    c.rect(9, 11, 15, 11, W); c.rect(10, 10, 14, 10, W); c.rect(11, 9, 13, 9, W); c.rect(12, 8, 13, 8, W); c.set(13, 7, W)
    for x in range(9, 16):                                                   # its base follows the slope, so it sits on the pie
        c.rect(x, 11, x, 16 - round((x - 2) * 8 / 18), W)
    stamp(g, c, GREYL)
    for y in range(24):                                                      # no grey rim under it: it sits right on the pie
        for x in range(24):
            if g.px[y][x] == GREYL and p.px[y][x]:
                g.px[y][x] = p.px[y][x]
    g.pts([(9, 12), (9, 13), (10, 10), (11, 9), (12, 8)], "#e6e1d6")          # shade on the lower left of each tier
    out["pie"] = ("Room for pie", g)
    return out


# ── December 2026: ❄️ Winter Lights Season (Season Pass, seasonal: Dec 1 - Jan 1). Every winter holiday and the New Year
#    without making one of them the theme: lights, the cold, snow, mittens, a gift, a sled, a snowball, a party hat. No
#    text, no brands, no Santa, no religious symbols; every prop has a dark edge of its own colour (the site is dark-only). ──
BULBS = (("#ff5a5f", "#8a1c22"), ("#ffd23f", "#8a6100"), ("#3ee0a0", "#0f6b47"), ("#4cc9f0", "#1b6f9a"), ("#c77dff", "#5a2a8a"))
WIRE, CAP, CAPD = "#8fa3b8", "#d5dae1", "#5b6470"                                          # light string + sockets
SNOW, SNOWD, SNOWE, ICE = "#ffffff", "#d6ebfb", "#6f97bd", "#9fd3f5"                       # snow, its shade + edge, ice
CRAN, CRANL, CRAND = "#c2255c", "#e64980", "#5c0f2b"                                       # cranberry knit
FLUFF, FLUFFD = "#f4f1ea", "#9e978c"                                                       # earmuff fluff
GIFT, GIFTL, GIFTD = "#1fa39a", "#5fd8cc", "#0b4f4a"                                       # teal wrapping
WOOD, WOODL, WOODD = "#b9763a", "#e0a868", "#5a3414"                                       # the sled
COAL = "#2b2b30"


def bulb(g, x, y, c, e):
    """A string-light bulb hanging from the wire at (x + 1, y): a light socket, 3 x 3 glass with a point, a white glint, its
    own dark edge."""
    b = Grid(g.w, g.h)
    b.rect(x, y + 1, x + 2, y + 3, c); b.set(x + 1, y + 4, c)
    stamp(g, b, e)
    g.set(x + 1, y, CAP); g.set(x, y + 1, W)


def flake(g, x, y, c=SNOW, tip=ICE):
    """A 5 x 5 snowflake: eight arms from the centre (never a plain plus - that reads as a first-aid cross)."""
    g.pts([(x, y - 2), (x, y - 1), (x - 1, y - 1), (x + 1, y - 1), (x - 2, y), (x - 1, y), (x, y), (x + 1, y), (x + 2, y),
           (x - 1, y + 1), (x, y + 1), (x + 1, y + 1), (x, y + 2)], c)
    g.pts([(x - 2, y - 2), (x + 2, y - 2), (x - 2, y + 2), (x + 2, y + 2)], tip)


def winterlights_pack():
    out = {}

    # Lights up! - two strands of coloured bulbs swagged across the dark (no Pepe: the lights are the star)
    g = Grid()
    for top, sag, x0 in ((1, 4, 1), (11, 5, 3)):
        wy = {x: top + round(sag * math.sin(math.pi * x / 23)) for x in range(24)}
        for x in range(24):
            g.set(x, wy[x], WIRE)
            if x and wy[x] != wy[x - 1]:
                g.set(x, min(wy[x], wy[x - 1]) + (1 if wy[x] > wy[x - 1] else 0), WIRE)
        for i, x in enumerate(range(x0, 22, 5)):
            c, e = BULBS[(i + (0 if top == 1 else 2)) % len(BULBS)]
            bulb(g, x, wy[x + 1] + 1, c, e)
    out["lights"] = ("Lights up!", g)

    # Brr! - Pepe in fluffy earmuffs, teeth chattering, cheeks gone blue, snow coming down
    g = Grid(); pepe_head(g); eyes_look(g, 0, -1)
    g.rect(6, 6, 9, 6, GD); g.rect(14, 6, 17, 6, GD)                           # brows up: cold
    g.rect(6, 14, 17, 16, RD)                                                 # chattering teeth: a zigzag of white
    for x in range(6, 18):
        if x % 3 != 2:
            g.set(x, 14, W)                                                   # top teeth
        if x % 3 != 0:
            g.set(x, 16, W)                                                   # bottom teeth, out of step: chattering
    g.pts([(4, 12), (5, 12), (18, 12), (19, 12)], ICE)
    m = Grid()
    for x, y in ((3, 6), (4, 4), (5, 3), (6, 2), (7, 2), (8, 1), (9, 1), (10, 1), (11, 1), (12, 1), (13, 1), (14, 1), (15, 1),
                 (16, 2), (17, 2), (18, 3), (19, 4), (20, 6), (3, 5), (20, 5)):
        m.set(x, y, CRAN)                                                     # the headband over the top
    stamp(g, m, CRAND)
    f = Grid(); f.ellipse(2.5, 10.0, 2.6, 3.2, FLUFF); f.ellipse(21.5, 10.0, 2.6, 3.2, FLUFF)
    stamp(g, f, FLUFFD)
    g.pts([(1, 9), (2, 8), (21, 8), (22, 9)], W)                              # fluff highlights
    flake(g, 3, 20); flake(g, 20, 20)
    out["brr"] = ("Brr!", g)

    # Snowfrog - a snowman built frog-shaped: snow Pepe with coal eyes, a pebble smile and a cranberry scarf, on a snow drift
    g = Grid()
    d = Grid(); d.ellipse(12.0, 24.5, 13.0, 3.6, SNOWD)
    stamp(g, d, SNOWE)
    pepe_head_c(g, SNOW, SNOWE, ICE)
    for x0 in (7, 15):
        g.rect(x0, 7, x0 + 1, 8, COAL)
        g.set(x0, 7, GREY)                                                    # a glint on each coal
    for x, y in ((6, 13), (8, 14), (10, 15), (13, 15), (15, 14), (17, 13)):
        g.set(x, y, COAL)
    g.pts([(4, 11), (19, 11)], PINK)
    s = Grid()
    s.rect(3, 17, 20, 18, CRAN)
    for x in range(3, 21):
        if x % 3 == 0:
            s.rect(x, 17, x, 18, CRANL)
    s.rect(15, 19, 17, 21, CRAN); s.rect(15, 20, 17, 20, CRANL); s.pts([(15, 22), (17, 22)], CRANL)
    stamp(g, s, CRAND)
    tw = Grid()                                                               # twig arms, waving
    tw.pts([(3, 15), (2, 14), (1, 13), (0, 12), (1, 12), (1, 11), (20, 15), (21, 14), (22, 13), (23, 12), (22, 12), (22, 11)], WOOD)
    for y in range(24):
        for x in range(24):
            if tw.px[y][x]:
                g.set(x, y, tw.px[y][x])
    for x, y in ((1, 2), (22, 3), (12, 0)):
        g.set(x, y, W)
    out["snowfrog"] = ("Snowfrog", g)

    # Mittens - a pair of cranberry mittens on a string, ribbed cream cuffs, a snowflake on each
    g = Grid()
    for x, y in ((6, 7), (6, 6), (7, 5), (7, 4), (8, 3), (9, 2), (10, 2), (11, 1), (12, 1), (13, 2), (14, 2), (15, 3),
                 (16, 4), (16, 5), (17, 6), (17, 7), (17, 8)):
        g.set(x, y, CREAM)                                                    # the string, looped over a peg
    for dx, dy, thumb in ((0, 0, 1), (11, 2, -1)):
        mt = Grid()
        x0, y0 = 3 + dx, 8 + dy
        mt.rect(x0, y0 + 3, x0 + 6, y0 + 11, CRAN)                            # the hand
        mt.rect(x0 + 1, y0 + 12, x0 + 5, y0 + 12, CRAN)                       # its rounded tip
        tx = x0 + 7 if thumb > 0 else x0 - 2
        mt.rect(tx, y0 + 5, tx + 1, y0 + 8, CRAN); mt.set(tx + (0 if thumb > 0 else 1), y0 + 4, CRAN)   # the thumb
        mt.rect(x0, y0, x0 + 6, y0 + 2, CREAM)                                # the cuff
        for x in range(x0, x0 + 7, 2):
            mt.rect(x, y0, x, y0 + 2, CREAMD)
        stamp(g, mt, CRAND)
        flake(g, x0 + 3, y0 + 7, W, CRANL)
    out["mittens"] = ("Mittens", g)

    # For you! - Pepe's green hands holding out a wrapped gift: teal paper, a gold ribbon and a big bow
    g = Grid()
    bx = Grid()
    bx.rect(5, 11, 18, 21, GIFT); bx.rect(4, 8, 19, 10, GIFT); bx.rect(4, 8, 19, 8, GIFTL)   # box + lid
    bx.rect(6, 12, 6, 20, GIFTL)                                              # shine
    stamp(g, bx, GIFTD)
    g.rect(11, 8, 12, 21, GOLD); g.rect(5, 15, 18, 16, GOLD)                 # the ribbon
    bw = Grid()
    bw.rect(7, 4, 10, 6, GOLD); bw.rect(13, 4, 16, 6, GOLD); bw.rect(11, 6, 12, 7, GOLD)
    bw.pts([(8, 3), (9, 3), (14, 3), (15, 3), (9, 7), (14, 7)], GOLD)
    stamp(g, bw, GOLDD)
    g.pts([(8, 5), (15, 5)], GOLDD); g.pts([(11, 6)], GOLDL)                 # the loops' holes + a glint on the knot
    hd = Grid(); hd.rect(1, 14, 4, 18, G); hd.rect(19, 14, 22, 18, G)
    stamp(g, hd, GD)
    g.pts([(2, 14), (20, 14)], GL)
    sparkle(g, 2, 3, W); sparkle(g, 21, 2, GOLD)
    out["gift"] = ("For you!", g)

    # Wheee! - Pepe on a wooden sled, mouth open, speed lines and a spray of snow behind
    g = Grid(); pepe_head(g); eyes_look(g, 1, -1); mouth(g, "grin")
    sl = Grid()
    sl.rect(2, 19, 20, 20, WOOD)
    for x in range(3, 21, 3):
        sl.set(x, 19, WOODL)
    sl.rect(1, 22, 21, 22, CAP); sl.pts([(22, 21), (23, 20), (23, 19)], CAP)   # the runner, curled up at the front
    for x in (4, 11, 18):
        sl.set(x, 21, CAPD)                                                   # struts
    stamp(g, sl, WOODD)
    for y in (9, 13, 17):
        g.rect(0, y, 1, y, ICE)                                               # speed lines
    g.pts([(0, 21), (1, 20), (0, 19), (2, 23), (0, 23)], SNOW)               # snow spray
    out["sled"] = ("Wheee!", g)

    # Incoming! - Pepe, very pleased with himself, holding up a big snowball
    g = Grid(); pepe_head(g); eyes_look(g, 1, 0); mouth(g, "smile")
    g.rect(6, 7, 9, 7, GD)                                                    # one lid lowered: up to something
    b = Grid(); b.ellipse(19.5, 4.0, 3.8, 3.8, SNOW)
    for y in range(24):
        for x in range(24):
            if b.px[y][x] and (x - 19.5) + (y - 4.0) > 2.2:
                b.px[y][x] = SNOWD                                            # shade on the lower right
    stamp(g, b, SNOWE)
    g.pts([(18, 2), (17, 3)], W)
    hd = Grid(); hd.rect(17, 8, 21, 10, G)
    stamp(g, hd, GD)
    g.set(18, 8, GL)
    flake(g, 3, 2); g.pts([(1, 20), (22, 18)], W)
    out["snowball"] = ("Incoming!", g)

    # New year! - Pepe in a striped party hat with a party horn, confetti everywhere, eyes shut with glee
    g = Grid(); pepe_head(g)
    for x0 in (6, 14):
        g.pts([(x0, 8), (x0 + 1, 7), (x0 + 2, 7), (x0 + 3, 8)], K)
    mouth(g, "smile")
    h = Grid()
    for i, y in enumerate(range(1, 6)):
        h.rect(12 - i, y, 12 + i, y, PURPLE if y % 2 else GOLD)
    stamp(g, h, HATD)
    g.rect(11, 0, 13, 0, W); g.set(12, 1, W)                                  # the pompom
    hn = Grid()
    hn.rect(16, 15, 21, 16, PINK)
    for x in range(16, 22, 2):
        hn.rect(x, 15, x, 16, W)
    hn.pts([(22, 15), (23, 14), (23, 13), (22, 12)], PINK)                    # the curled tip
    stamp(g, hn, "#a8325a")
    for (x, y), c in zip(((2, 1), (5, 3), (19, 1), (21, 5), (1, 6), (22, 9), (8, 0), (16, 2), (3, 22), (20, 22)),
                         (BULBS[0][0], BLUE, GOLD, PINK, GOLD, PURPLE, BLUE, BULBS[2][0], PINK, GOLD)):
        g.set(x, y, c)
    out["newyear"] = ("New year!", g)
    return out


# ── wave2 WP-4 (incognito / mic-stage spec F.4, owner pick J-11 2026-10-28): the hooded-frog covers for veiled speakers ──
# NOT a sticker pack: public/img/anon/hood-peek-{0..7}.svg (incognito: "Peek B", the bandana) and hood-shadow-{0..7}.svg
# (hidden: "Shadow"), one per frog-name hood index. An anonymous frog - never Pepe's face and never his red lips (R / RD).
# Ported from the owner's contact-sheet generators (hood-art/B-bandana/gen_bandana.py, scheme "tint", and
# hood-art/shadow/gen_shadow.py); the two compact writers stay separate because their path syntaxes differ (the bandana's
# greedy rects close with h-W, the shadow's layered plan picks the shorter of h-W / H<x>). Every SVG is parsed back into
# pixels and compared with its grid before it is written.
#     python tools/gen-stickers.py anon            -> public/img/anon/
#     python tools/gen-stickers.py anon --check    -> compares byte for byte, writes nothing (exit 1 on a difference)
ANON_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "img", "anon")
HOODS = [                                    # (name, cloth, shade, rim) - index = the frog-name hood (frognames.js)
    ("charcoal", "#2b2d31", "#1a1b1e", "#4a4d55"),
    ("midnight", "#23305c", "#151d3a", "#3b4f8f"),
    ("plum",     "#4b2a5e", "#2e183b", "#6f4290"),
    ("forest",   "#1f4a33", "#123021", "#2f6e4c"),
    ("maroon",   "#5c2228", "#3a1418", "#863440"),
    ("teal",     "#1d4f57", "#113338", "#2b7480"),
    ("mustard",  "#6b5418", "#45360e", "#9a7a26"),
    ("slate",    "#3d4654", "#262d37", "#5b6779"),
]


def anon_inside(cx, cy, rx, ry, x, y):
    return ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1.0


# ·· peek B: hood up, a bandana over the lower face, round frog eyes looking forward over it ··
PEEK_FACE = "#2c9a3f"     # the frog's face, a step darker than G: it is inside the hood
PEEK_BRIM = "#17532a"     # shadow under the hood's brim
PEEK_BROW = "#4cc860"     # light on the eye domes
PEEK_STRING = "#d9d4c7"   # hoodie drawstrings
PEEK_TINT = [             # the bandana per hood: (cloth, fold shade, dots) - scheme "tint"
    ("#d0743c", "#9a5228", "#f6e3d2"),   # charcoal: rust (keeps it apart from slate)
    ("#5577d0", "#3b56a0", "#e8dfc8"),
    ("#a466cc", "#7a4a9c", "#f0e2f6"),
    ("#c9b27a", "#9a8656", "#5d4a22"),   # forest: khaki (a green bandana would melt into the face)
    ("#c8505c", "#94363f", "#f3dcd9"),   # maroon: a red-pink BANDANA (owner OK) - never lips
    ("#41a3ae", "#2d7a84", "#e3f4f2"),
    ("#e0b542", "#a8852b", "#fff3cf"),
    ("#8d9bb3", "#66748a", "#eef1f6"),
]
PEEK_DOTS = [(7, 13), (11, 13), (15, 13), (9, 15), (13, 15), (11, 17)]


def peek_hem(c):
    r, g_, b = (int(c[k:k + 2], 16) for k in (1, 3, 5))
    return "#%02x%02x%02x" % tuple(round(v + (255 - v) * 0.35) for v in (r, g_, b))


def hood_peek(i):
    _, cloth, shade, rim = HOODS[i]
    band, band_d, dot = PEEK_TINT[i]
    g = Grid()
    opening = lambda x, y: anon_inside(12.0, 12.0, 7.3, 6.0, x, y)     # rows 6-17
    for y in range(24):                       # hood: two bumps (the eye domes under the cloth), a round crown, shoulders
        for x in range(24):
            bumps = anon_inside(7.4, 6.4, 4.7, 4.6, x, y) or anon_inside(16.6, 6.4, 4.7, 4.6, x, y)
            crown = anon_inside(12.0, 12.4, 10.6, 8.6, x, y)
            cape = y >= 18 and abs(x + 0.5 - 12) <= 8.6 + (y - 18) * 1.25
            if bumps or crown or cape:
                g.px[y][x] = cloth
    for y in range(24):                       # the opening: the frog's face, a row of brim shadow on top
        for x in range(24):
            if opening(x, y):
                g.px[y][x] = PEEK_BRIM if not opening(x, y - 1) else PEEK_FACE
    for y in range(24):                       # a lighter cloth rim round the opening
        for x in range(24):
            if g.px[y][x] == cloth and any(opening(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                g.px[y][x] = rim
    for x0 in (6, 14):                        # round eyes, pupils centred (looking forward), light on the domes
        g.rect(x0 + 1, 7, x0 + 2, 7, PEEK_BROW)
        g.rect(x0 + 1, 8, x0 + 2, 11, W)
        g.rect(x0, 9, x0 + 3, 10, W)
        g.rect(x0 + 1, 9, x0 + 2, 10, K)
    band_rows = {12: (10, 13), 13: (5, 18), 14: (5, 18)}     # the band, tied behind the head (inside the opening only)
    tri_rows = {15: (6, 17), 16: (7, 16), 17: (8, 15), 18: (9, 14), 19: (10, 13), 20: (11, 12)}   # the triangle in front
    for y, (a, b) in band_rows.items():
        for x in range(a, b + 1):
            if opening(x, y):
                g.set(x, y, band)
    for y, (a, b) in tri_rows.items():
        g.rect(a, y, b, y, band)
        if y >= 16:
            g.pts([(a, y), (b, y)], band_d)
    g.pts([(10, 12), (11, 12), (12, 12), (13, 12)], peek_hem(band))   # the folded top edge catches light
    g.pts(PEEK_DOTS, dot)
    g.pts([(3, 8), (20, 8), (11, 4), (12, 4)], shade)                  # cloth folds + highlights, drawstrings
    g.pts([(5, 3), (6, 3), (15, 3), (16, 3)], rim)
    g.pts([(7, 19), (7, 20), (16, 19), (16, 20)], PEEK_STRING)
    g.pts([(7, 21), (16, 21)], "#9e998c")
    for c in (cloth, rim, shade):
        g.outline(c, K)
    return g


def anon_short(c):
    c = c.lower()
    return "#" + c[1] + c[3] + c[5] if len(c) == 7 and c[1] == c[2] and c[3] == c[4] and c[5] == c[6] else c


def anon_long(c):
    c = c.lower()
    return "#" + "".join(ch * 2 for ch in c[1:]) if len(c) == 4 else c


def svg_greedy(g, title):
    """peek's writer: one <path> per colour, greedy rectangles; the outline colour first, then by area (later colours
    may overpaint earlier ones)."""
    count = {}
    for row in g.px:
        for c in row:
            if c:
                count[c] = count.get(c, 0) + 1
    order = sorted(count, key=lambda c: (c != K, -count[c]))
    rank = {c: n for n, c in enumerate(order)}
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {g.w} {g.h}" shape-rendering="crispEdges">'
           f"<title>{title}</title>"]
    for c in order:
        r = rank[c]
        allowed = lambda x, y: g.px[y][x] is not None and rank[g.px[y][x]] >= r
        todo = {(x, y) for y in range(g.h) for x in range(g.w) if g.px[y][x] == c}
        d = []
        for y in range(g.h):
            for x in range(g.w):
                if (x, y) not in todo:
                    continue
                x1 = x
                while x1 + 1 < g.w and allowed(x1 + 1, y):
                    x1 += 1
                y1 = y
                while y1 + 1 < g.h and all(allowed(xx, y1 + 1) for xx in range(x, x1 + 1)):
                    y1 += 1
                cells = lambda xa, xb, ya, yb: any((xx, yy) in todo for xx in range(xa, xb + 1) for yy in range(ya, yb + 1))
                while x1 > x and not cells(x1, x1, y, y1):
                    x1 -= 1
                while y1 > y and not cells(x, x1, y1, y1):
                    y1 -= 1
                for yy in range(y, y1 + 1):
                    for xx in range(x, x1 + 1):
                        todo.discard((xx, yy))
                w, h = x1 - x + 1, y1 - y + 1
                d.append(f"M{x} {y}h{w}v{h}h-{w}z")
        out.append(f'<path fill="{anon_short(c)}" d="{"".join(d)}"/>')
    out.append("</svg>")
    return "".join(out) + "\n"


# ·· shadow: the same kind of hood, the face fully dark, two eye glints under faint frog-eye bulges ··
SHADOW_FIXED = {
    "edge": K, "dark": "#0d1410", "dark2": "#13241a", "bulge": "#173d22", "eye": W,
    "glhi": "#d7ffe0", "gllo": "#9fe3a8", "str": "#d9d4c7", "strd": "#9e998c",
}


def hood_shadow_roles():
    """The hidden frog in colour roles (colourised per hood)."""
    g = Grid()
    face = lambda x, y: anon_inside(12.0, 13.0, 7.3, 5.7, x, y)
    for y in range(24):
        for x in range(24):
            bumps = anon_inside(7.6, 7.4, 5.4, 5.0, x, y) or anon_inside(16.4, 7.4, 5.4, 5.0, x, y)
            body = anon_inside(12.0, 13.2, 11.0, 8.4, x, y)
            tip = 1 <= y <= 3 and 15 <= x <= 17 and (x - 15) <= y - 1
            cape = y >= 19 and abs(x + 0.5 - 12) <= 7 + (y - 19) * 1.3
            if bumps or body or tip or cape:
                g.px[y][x] = "cloth"
    for y in range(24):
        for x in range(24):
            if face(x, y):
                g.px[y][x] = "dark" if y < 15 else "dark2"
    for y in range(24):
        for x in range(24):
            if g.px[y][x] == "cloth" and any(face(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                g.px[y][x] = "rim"
    g.pts([(4, 5), (3, 7), (20, 5), (21, 7), (11, 5), (12, 5)], "shade")
    g.pts([(6, 3), (7, 3), (15, 3), (16, 3)], "rim")
    g.pts([(8, 19), (8, 20), (8, 21), (15, 19), (15, 20), (15, 21)], "str")
    g.pts([(8, 22), (15, 22)], "strd")
    g.outline("cloth", "edge"); g.outline("rim", "edge"); g.outline("shade", "edge")
    for x0 in (7, 14):
        g.rect(x0, 9, x0 + 2, 9, "bulge")
        g.pts([(x0 - 1, 10), (x0 + 3, 10)], "bulge")
        g.rect(x0, 10, x0 + 2, 11, "eye")
        g.set(x0, 10, "glhi")
        g.set(x0 + 2, 11, "gllo")
    return g


def hood_shadow(i):
    _, cloth, shade, rim = HOODS[i]
    pal = dict(SHADOW_FIXED, cloth=cloth, shade=shade, rim=rim)
    roles, g = hood_shadow_roles(), Grid()
    for y in range(roles.h):
        for x in range(roles.w):
            c = roles.px[y][x]
            if c:
                g.px[y][x] = pal.get(c, c)
    return g


def _lay_cover(req, allowed, w, h):
    unc = set(req)
    rects = []
    while unc:
        px, py = min(unc, key=lambda p: (p[1], p[0]))
        best = None
        for y0 in range(py, -1, -1):
            if (px, y0) not in allowed:
                break
            ok = [True] * w
            for y1 in range(y0, h):
                if (px, y1) not in allowed:
                    break
                for x in range(w):
                    ok[x] = ok[x] and (x, y1) in allowed
                if y1 < py:
                    continue
                x0 = px
                while x0 > 0 and ok[x0 - 1]:
                    x0 -= 1
                x1 = px
                while x1 < w - 1 and ok[x1 + 1]:
                    x1 += 1
                gain = sum(1 for yy in range(y0, y1 + 1) for xx in range(x0, x1 + 1) if (xx, yy) in unc)
                if best is None or gain > best[0]:
                    best = (gain, x0, y0, x1, y1)
        _, x0, y0, x1, y1 = best
        rects.append((x0, y0, x1, y1))
        unc -= {(xx, yy) for yy in range(y0, y1 + 1) for xx in range(x0, x1 + 1)}
    return rects


def _lay_cmd(r):
    x0, y0, x1, y1 = r
    w, h = x1 - x0 + 1, y1 - y0 + 1
    back = min(f"h-{w}", f"H{x0}", key=len)
    return f"M{x0} {y0}h{w}v{h}{back}"


def layer_plan(g):
    """shadow's writer plan: the colour order (painter's) whose merged rectangles make the shortest path text."""
    cols = {}
    for y in range(g.h):
        for x in range(g.w):
            c = g.px[y][x]
            if c:
                cols.setdefault(c, set()).add((x, y))
    cache = {}

    def cost_of(c, above):
        key = (c, above)
        if key not in cache:
            allowed = set(cols[c])
            for d in above:
                allowed |= cols[d]
            rects = _lay_cover(cols[c], allowed, g.w, g.h)
            cache[key] = (len("".join(_lay_cmd(r) for r in rects)) + 24 + len(anon_short(c)), rects)
        return cache[key]

    def total(order):
        return sum(cost_of(c, frozenset(order[i + 1:]))[0] for i, c in enumerate(order))

    top_down, left = [], set(cols)
    while left:
        above = frozenset(top_down)
        c = min(sorted(left), key=lambda c: cost_of(c, above)[0])
        top_down.append(c)
        left.discard(c)
    order = top_down[::-1]
    best = total(order)
    improved = True
    while improved:
        improved = False
        for i in range(len(order) - 1):
            o = order[:]
            o[i], o[i + 1] = o[i + 1], o[i]
            t = total(o)
            if t < best:
                order, best, improved = o, t, True
    return [(c, cost_of(c, frozenset(order[i + 1:]))[1]) for i, c in enumerate(order)]


def svg_layered(g, title):
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {g.w} {g.h}" shape-rendering="crispEdges">'
             f"<title>{title}</title>"]
    for c, rects in layer_plan(g):
        parts.append(f'<path fill="{anon_short(c)}" d="{"".join(_lay_cmd(r) for r in rects)}"/>')
    parts.append("</svg>\n")
    return "".join(parts)


def anon_svg_pixels(svg, w=24, h=24):
    """Parse either writer's output back into pixels (painter's order; M / h / v / H / V rect sub-paths)."""
    import re
    px = [[None] * w for _ in range(h)]
    for fill, d in re.findall(r'<path fill="(#[0-9a-fA-F]{3,6})" d="([^"]+)"', svg):
        for sub in re.findall(r"M[^M]+", d):
            toks = re.findall(r"[MhvHVz]|-?\d+", sub)
            x = y = 0
            pts, i, cmd = [], 0, None
            while i < len(toks):
                t = toks[i]
                if t.isalpha():
                    cmd = t
                    i += 1
                    if cmd == "z":
                        continue
                if cmd == "M":
                    x, y = int(toks[i]), int(toks[i + 1]); i += 2
                elif cmd == "h":
                    x += int(toks[i]); i += 1
                elif cmd == "v":
                    y += int(toks[i]); i += 1
                elif cmd == "H":
                    x = int(toks[i]); i += 1
                elif cmd == "V":
                    y = int(toks[i]); i += 1
                pts.append((x, y))
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            assert len(set(xs)) == 2 and len(set(ys)) == 2, sub
            for yy in range(min(ys), max(ys)):
                for xx in range(min(xs), max(xs)):
                    px[yy][xx] = anon_long(fill)
    return px


def anon_files():
    """-> {file name: svg text} for the 16 covers, each checked against its grid (and under 3 KB, no Pepe red)."""
    out = {}
    for i in range(len(HOODS)):
        for name, g, write, title in ((f"hood-peek-{i}.svg", hood_peek(i), svg_greedy, "Incognito frog"),
                                      (f"hood-shadow-{i}.svg", hood_shadow(i), svg_layered, "Hidden frog")):
            svg = write(g, title)
            want = [[(c.lower() if c else None) for c in row] for row in g.px]
            assert anon_svg_pixels(svg) == want, f"{name}: the SVG does not round-trip"
            assert len(svg.encode("utf-8")) <= 3072, f"{name}: {len(svg)} bytes"
            assert R not in svg and RD not in svg and anon_short(R) not in svg, f"{name}: Pepe's red"
            out[name] = svg
    return out


def anon_main(check=False):
    if not check:
        os.makedirs(ANON_ROOT, exist_ok=True)
    bad = []
    for name, svg in anon_files().items():
        p = os.path.join(ANON_ROOT, name)
        if check:
            try:
                with open(p, "rb") as f:
                    if f.read() != svg.encode("utf-8"):
                        bad.append(name)
            except OSError:
                bad.append(name)
            continue
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(svg)
    if check:
        print("anon", "differs: " + ", ".join(bad) if bad else "same")
        return not bad
    print("anon ok")
    return True


PACKS = {"pixelpepe": pixel_pack, "kawaiipond": kawaii_pack, "patvreacts": reacts_pack,
         "miclife": mic_pack, "highroller": casino_pack, "movienight": movie_pack,
         "spooky": spooky_pack, "fireside": fireside_pack, "winterlights": winterlights_pack, "primeplus": plus_pack}


def packs_check(only=()):
    """December 2026: `python tools/gen-stickers.py --check [pack ...]` regenerates the packs in memory and compares them with
    public/stickers/<pack>/ byte for byte (a Windows checkout's CRLF line ends read as LF: git stores the files with LF), so a
    change to a shared helper can't quietly redraw a pack nobody meant to touch. Writes nothing."""
    ok = True
    for pack, fn in PACKS.items():
        if only and pack not in only:
            continue
        bad = []
        for sid, (title, grid) in fn().items():
            try:
                with open(os.path.join(ROOT, pack, sid + ".svg"), "rb") as f:
                    if f.read().replace(b"\r\n", b"\n") != grid.svg(title).encode("utf-8"):
                        bad.append(sid)
            except OSError:
                bad.append(sid + " (missing)")
        print(pack, "differs: " + ", ".join(bad) if bad else "same")
        ok = ok and not bad
    return ok


def main():
    import sys
    args = sys.argv[1:]
    if "anon" in args:                                   # wave2 WP-4: the hooded-frog covers (public/img/anon/), not a pack
        ok = anon_main(check="--check" in args)
        if not ok:
            sys.exit(1)
        if not [a for a in args if a in PACKS]:
            return
    only = [a for a in args if a in PACKS]               # 1.99qp: python tools/gen-stickers.py spooky primeplus (just those)
    if "--check" in args:                                # 1.99ahe: compare, write nothing (exit 1 on a difference)
        if not packs_check(only):
            sys.exit(1)
        return
    for pack, fn in PACKS.items():
        if only and pack not in only:
            continue
        d = os.path.join(ROOT, pack)
        os.makedirs(d, exist_ok=True)
        for sid, (title, grid) in fn().items():
            with open(os.path.join(d, sid + ".svg"), "w", encoding="utf-8", newline="\n") as f:
                f.write(grid.svg(title))
        print(pack, "ok")
    if not only:
        anon_main()


if __name__ == "__main__":
    main()
