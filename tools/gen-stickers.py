"""Generate PATV's starter sticker packs as pixel-art SVGs (1.99iw, stickers.js / stickers.json).

    python tools/gen-stickers.py            -> public/stickers/<pack>/<sticker>.svg

Every sticker is drawn on a small pixel grid (24 x 24, text stickers 32 x 24) and written as runs of <rect>s with
shape-rendering="crispEdges", so it stays crisp at any size and is a few hundred bytes. The look follows the site's
pixel Pepe (public/img/pepe-looks/base-pixel.png) and the kawaii Pepe (base-kawaii.png). Re-running it rewrites the
files byte-for-byte the same.
"""
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


PACKS = {"pixelpepe": pixel_pack, "kawaiipond": kawaii_pack, "patvreacts": reacts_pack,
         "miclife": mic_pack, "highroller": casino_pack, "movienight": movie_pack,
         "spooky": spooky_pack, "primeplus": plus_pack}


def main():
    import sys
    only = [a for a in sys.argv[1:] if a in PACKS]       # 1.99qp: python tools/gen-stickers.py spooky primeplus (just those)
    for pack, fn in PACKS.items():
        if only and pack not in only:
            continue
        d = os.path.join(ROOT, pack)
        os.makedirs(d, exist_ok=True)
        for sid, (title, grid) in fn().items():
            with open(os.path.join(d, sid + ".svg"), "w", encoding="utf-8", newline="\n") as f:
                f.write(grid.svg(title))
        print(pack, "ok")


if __name__ == "__main__":
    main()
