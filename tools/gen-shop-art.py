"""Pixel-art pictures for the official PATV store items (1.99lz) -> public/img/shop/<key>.svg

    python tools/gen-shop-art.py

One house style for the whole shop, the same family as the sticker packs (tools/gen-stickers.py): every item is a
pixel sprite on a 48 x 36 grid (4:3, the shop's card ratio) with a 1-px dark outline, standing on a soft shadow in a
spotlight whose colour is the item's shelf (shopcatalog.js SHELVES). A small dark chip in the corner says the term or
amount when the item has one (1 MO, 1 YR, LIFE, +100, ROLE ...). Rects with shape-rendering="crispEdges", so the
files stay crisp at any size and are a few KB. Re-running it rewrites the files byte-for-byte the same.

No brand logos are drawn: memberships are generic member cards in the tier's colour, consoles and games are generic.
"""
import math
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "img", "shop")
W_, H_ = 48, 36
EDGE = "#0a0a0a"


class Grid:
    def __init__(self, w=W_, h=H_):
        self.w, self.h = w, h
        self.px = [[None] * w for _ in range(h)]

    def set(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y][x] = c

    def get(self, x, y):
        return self.px[y][x] if 0 <= x < self.w and 0 <= y < self.h else None

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

    def poly(self, pts, c):
        """Fill a polygon (pixel centres inside)."""
        n = len(pts)
        for y in range(self.h):
            for x in range(self.w):
                px, py = x + 0.5, y + 0.5
                inside = False
                j = n - 1
                for i in range(n):
                    xi, yi = pts[i]
                    xj, yj = pts[j]
                    if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / (yj - yi) + xi:
                        inside = not inside
                    j = i
                if inside:
                    self.set(x, y, c)

    def line(self, x0, y0, x1, y1, c):
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err = dx + dy
        while True:
            self.set(x0, y0, c)
            if x0 == x1 and y0 == y1:
                return
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def outline(self, edge=EDGE):
        """Paint `edge` round everything drawn so far (4-neighbour)."""
        add = []
        for y in range(self.h):
            for x in range(self.w):
                if self.px[y][x] is None:
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        v = self.get(x + dx, y + dy)
                        if v is not None and v != edge:
                            add.append((x, y))
                            break
        for x, y in add:
            self.px[y][x] = edge

    def runs(self):
        out = []
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
        return out


# ── 3 x 5 pixel font ──
FONT = {
    "A": ["010", "101", "111", "101", "101"], "B": ["110", "101", "110", "101", "110"], "C": ["011", "100", "100", "100", "011"],
    "D": ["110", "101", "101", "101", "110"], "E": ["111", "100", "110", "100", "111"], "F": ["111", "100", "110", "100", "100"],
    "G": ["011", "100", "101", "101", "011"], "H": ["101", "101", "111", "101", "101"], "I": ["111", "010", "010", "010", "111"],
    "K": ["101", "101", "110", "101", "101"], "L": ["100", "100", "100", "100", "111"], "M": ["10001", "11011", "10101", "10001", "10001"],
    "N": ["1001", "1101", "1011", "1001", "1001"], "O": ["010", "101", "101", "101", "010"], "P": ["110", "101", "110", "100", "100"],
    "R": ["110", "101", "110", "101", "101"], "S": ["011", "100", "010", "001", "110"], "T": ["111", "010", "010", "010", "010"],
    "U": ["101", "101", "101", "101", "111"], "V": ["101", "101", "101", "101", "010"], "X": ["101", "101", "010", "101", "101"],
    "Y": ["101", "101", "010", "010", "010"], "W": ["10001", "10001", "10101", "10101", "01010"],
    "0": ["111", "101", "101", "101", "111"], "1": ["010", "110", "010", "010", "111"], "2": ["110", "001", "010", "100", "111"],
    "+": ["000", "010", "111", "010", "000"], "?": ["111", "001", "011", "000", "010"], "-": ["000", "000", "111", "000", "000"],
    " ": ["0", "0", "0", "0", "0"],
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


# ── palette ──
K, W = "#111111", "#ffffff"
FROG, FROGD, FROGL = "#3fb950", "#1f6f2e", "#7ee08a"
GOLD, GOLDD, GOLDL = "#ffcf40", "#b8860b", "#fff1a8"
RED, REDD = "#e5383b", "#9d0208"
GREY, GREYD, GREYL = "#6c757d", "#3a3f44", "#adb5bd"
CYAN, PINK, PURPLE = "#4cc9f0", "#ff6ad5", "#9b5de5"

# shelf spotlight colours (inner, outer)
SHELF_BG = {
    "camfrog": ("#1f6b46", "#0b1a12"),
    "plex": ("#7a5208", "#1a1204"),
    "roles": ("#4b2a8a", "#130b24"),
    "perks": ("#2a3a9a", "#0b0f26"),
    "gaming": ("#155a86", "#06141f"),
    "goods": ("#16706a", "#06181a"),
    "fun": ("#8a1f5a", "#1f0614"),
}


def sparkle(g, x, y, c):
    g.pts([(x, y - 1), (x - 1, y), (x, y), (x + 1, y), (x, y + 1)], c)


# ── shared sprites ──
def card(g, x0, y0, x1, y1, base, light, dark):
    """A member card with cut corners, a light top band and a dark bottom band."""
    g.rect(x0, y0, x1, y1, base)
    for (x, y) in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
        g.set(x, y, None)
    g.rect(x0 + 1, y0 + 1, x1 - 1, y0 + 2, light)
    g.rect(x0 + 1, y1 - 2, x1 - 1, y1 - 1, dark)


def frog_emblem(g, cx, cy):
    g.ellipse(cx - 2.2, cy - 2.2, 2.0, 1.8, FROG)
    g.ellipse(cx + 2.2, cy - 2.2, 2.0, 1.8, FROG)
    g.ellipse(cx, cy + 0.6, 4.4, 3.0, FROG)
    g.pts([(int(cx) - 3, int(cy) - 3), (int(cx) + 1, int(cy) - 3)], W)
    g.pts([(int(cx) - 2, int(cy) - 3), (int(cx) + 2, int(cy) - 3)], K)
    g.rect(int(cx) - 3, int(cy) + 1, int(cx) + 2, int(cy) + 1, RED)


def gem(g, cx, top, w, h, c, light, dark):
    hw = w // 2
    g.poly([(cx - hw, top + 2), (cx - hw + 2, top), (cx + hw - 1, top), (cx + hw + 1, top + 2), (cx + 0.5, top + h)], c)
    g.rect(cx - hw + 2, top, cx + hw - 2, top, light)
    g.line(cx - hw + 1, top + 2, cx, top + h - 1, dark)
    g.pts([(cx - 1, top + 1), (cx, top + 1)], W)


def member_card(tier, years):
    base, light, dark, label, fg = {
        "pro": ("#3a86ff", "#8fb8ff", "#1f4fa8", "PRO", W),
        "extreme": ("#c0244e", "#ff6b8b", "#6e0f2b", "EXT", W),
        "gold": (GOLD, GOLDL, GOLDD, "GOLD", "#4a3200"),
        "nitro": ("#5865f2", "#9aa3ff", "#323a9e", "NITRO", W),
    }[tier]
    g = Grid()
    ox, oy = (0, 0) if not years else (-2, 2)
    if years:                                   # the year cards: a little stack behind the front one
        card(g, 13, 6, 42, 23, dark, base, dark)
        card(g, 10, 8, 39, 25, base, light, dark)
    x0, y0, x1, y1 = 7 + ox, 9 + oy, 40 + ox, 28 + oy
    card(g, x0, y0, x1, y1, base, light, dark)
    if tier == "nitro":
        gem(g, x0 + 7, y0 + 5, 8, 8, PINK, "#ffc2ec", "#a0287f")
    else:
        frog_emblem(g, x0 + 7.5, y0 + 9)
    text(g, label, x0 + 15, y0 + 5, fg)
    g.rect(x0 + 15, y0 + 12, x0 + 19, y0 + 15, GOLD if tier != "gold" else "#fff7d6")
    g.rect(x0 + 16, y0 + 13, x0 + 18, y0 + 14, GOLDD)
    for i in range(4):
        g.rect(x0 + 22 + i * 3, y0 + 14, x0 + 23 + i * 3, y0 + 14, light)
    return g


def vhs(body, label, mark, lifetime=False):
    g = Grid()
    g.rect(7, 9, 40, 28, body)
    g.rect(8, 10, 39, 10, "#3a3a3a" if not lifetime else GOLDL)
    g.rect(11, 12, 36, 19, label)
    g.rect(11, 12, 36, 12, W if not lifetime else "#fff7d6")
    # the label's chevron (a play arrow)
    g.poly([(20, 13), (24, 13), (28.5, 16), (24, 19), (20, 19), (24.5, 16)], mark)
    # the window and two reels
    g.rect(13, 21, 34, 26, "#1a1a1a")
    for cx in (17, 30):
        g.ellipse(cx + 0.5, 23.5, 3.2, 3.2, "#e8e8e8")
        g.ellipse(cx + 0.5, 23.5, 1.4, 1.4, "#555555")
        g.pts([(cx, 21), (cx, 26), (cx - 2, 23), (cx + 3, 23)], "#bbbbbb")
    g.rect(20, 22, 27, 25, "#5a3a22")
    g.rect(11, 27, 36, 27, "#2a2a2a" if not lifetime else GOLDD)
    return g


# ── one function per item ──
def a_filmreel():
    g = Grid()
    g.ellipse(22.5, 18.5, 11.5, 11.5, GREYL)
    g.ellipse(22.5, 18.5, 9.5, 9.5, GREY)
    for a in range(6):
        ang = a * math.pi / 3
        g.ellipse(22.5 + 5.6 * math.cos(ang), 18.5 + 5.6 * math.sin(ang), 2.3, 2.3, "#202020")
    g.ellipse(22.5, 18.5, 1.6, 1.6, GREYL)
    g.rect(31, 26, 42, 29, "#2b2b2b")            # film leader running off the reel
    for x in range(32, 42, 3):
        g.set(x, 27, "#9a9a9a")
    return g


def a_crt():
    g = Grid()
    g.line(19, 3, 23, 8, GREYL); g.line(30, 3, 25, 8, GREYL)
    g.rect(9, 8, 38, 29, "#8a5a32")
    g.rect(10, 9, 37, 9, "#b07a48")
    g.rect(12, 11, 31, 26, "#1b2a3a")
    g.rect(13, 12, 30, 25, "#2ec4d6")
    g.rect(14, 13, 29, 15, "#7ee8f2")
    g.rect(33, 12, 36, 14, GREYL); g.rect(33, 17, 36, 19, GREYL)
    g.rect(33, 22, 36, 26, "#5a3a20")
    g.rect(12, 30, 14, 31, "#4a2f1a"); g.rect(33, 30, 35, 31, "#4a2f1a")
    return g


def a_binoculars():
    g = Grid()
    for x0 in (10, 26):
        g.rect(x0, 8, x0 + 11, 25, "#253047")
        g.rect(x0 + 1, 9, x0 + 3, 23, "#3d4d70")
        g.ellipse(x0 + 6, 26.5, 6.2, 4.2, "#253047")
        g.ellipse(x0 + 6, 26.5, 4.4, 2.8, CYAN)
        g.pts([(x0 + 3, 25), (x0 + 4, 25)], W)
        g.rect(x0 + 2, 5, x0 + 9, 8, "#1a2235")
    g.rect(21, 12, 26, 17, "#1a2235")
    g.rect(22, 9, 25, 11, GREY)
    return g


def a_clapper():
    g = Grid()
    # the clapstick, raised a little, and the board's own striped band (diagonal stripes)
    for (y0, y1, x0) in ((6, 10, 9), (14, 18, 8)):
        for y in range(y0, y1 + 1):
            for x in range(x0, 40):
                g.set(x, y, W if (x + y) % 8 < 4 else "#222222")
    g.rect(8, 11, 10, 13, GREYL)
    g.rect(8, 19, 39, 31, "#222222")
    g.rect(10, 21, 22, 21, "#555555"); g.rect(10, 29, 18, 29, "#555555")
    g.line(20, 24, 23, 27, FROG); g.line(21, 24, 24, 27, FROG)
    g.line(23, 27, 31, 21, FROG); g.line(24, 27, 32, 21, FROG)
    return g


def a_highroller():
    g = Grid()
    for i, (cx, c) in enumerate(((15, RED), (33, "#1d4ed8"))):
        for k in range(4):
            y = 28 - k * 3
            g.ellipse(cx + 0.5, y + 0.5, 6.4, 2.4, c)
            g.rect(cx - 5, y + 1, cx + 6, y + 1, "#7a0010" if c == RED else "#0f2a7a")
            for dx in (-4, 0, 4):
                g.set(cx + dx, y, W)
    gem(g, 24, 4, 16, 13, CYAN, "#c8f4ff", "#1b7fa0")
    return g


def a_wheel():
    g = Grid()
    cx, cy, r = 24.0, 19.0, 12.0
    cols = [GOLD, RED, GOLD, "#1d4ed8", GOLD, RED, GOLD, FROG]
    for y in range(H_):
        for x in range(W_):
            dx, dy = x + 0.5 - cx, y + 0.5 - cy
            d = math.hypot(dx, dy)
            if d <= r:
                if d > r - 1.5:
                    g.set(x, y, GOLDD)
                else:
                    seg = int(((math.atan2(dy, dx) + math.pi) / (2 * math.pi)) * 8) % 8
                    g.set(x, y, cols[seg])
    g.ellipse(cx, cy, 2.4, 2.4, W)
    g.poly([(21, 3), (27, 3), (24, 9)], W)
    return g


def a_console():
    g = Grid()
    g.poly([(14, 6), (21, 4), (21, 31), (14, 31), (12, 18)], "#f2f2f2")
    g.poly([(34, 6), (27, 4), (27, 31), (34, 31), (36, 18)], "#f2f2f2")
    g.rect(21, 5, 26, 30, "#151515")
    g.rect(22, 6, 22, 29, "#3a7bff")
    g.rect(13, 31, 35, 32, "#2a2a2a")
    g.line(15, 9, 15, 27, "#d0d0d0"); g.line(33, 9, 33, 27, "#d0d0d0")
    # a pad leaning on it
    g.ellipse(9.5, 28.5, 5.4, 3.6, "#f2f2f2")
    g.rect(7, 27, 12, 29, "#151515")
    g.pts([(8, 28), (11, 28)], "#3a7bff")
    return g


def a_pc():
    g = Grid()
    g.rect(14, 3, 34, 31, "#1c1c22")
    g.rect(15, 4, 33, 4, "#ff2bd6")
    g.rect(16, 6, 32, 29, "#0c0c10")
    for cy, c in ((10.5, "#ff2bd6"), (17.5, CYAN), (24.5, FROG)):
        g.ellipse(24.5, cy, 3.6, 3.0, c)
        g.ellipse(24.5, cy, 2.0, 1.6, "#202028")
        g.set(24, int(cy), c)
    g.rect(17, 7, 18, 28, "#2a2a36")
    g.rect(15, 32, 17, 32, "#2a2a2a"); g.rect(31, 32, 33, 32, "#2a2a2a")
    return g


def a_gamecase():
    g = Grid()
    g.rect(12, 3, 35, 32, "#0e1a3a")
    g.rect(12, 3, 14, 32, "#1a2a5a")
    bands = ["#3b1c6e", "#6a1f7a", "#b0306e", "#e0564a", "#f08a3c", "#f7b84a"]
    for i, c in enumerate(bands):
        g.rect(15, 4 + i * 3, 34, 6 + i * 3, c)
    g.ellipse(28.5, 16.5, 3.6, 3.6, "#ffe08a")
    g.rect(15, 19, 34, 21, "#2a0f3a")
    # palm tree
    g.rect(21, 9, 21, 20, "#2a0f3a"); g.rect(22, 11, 22, 20, "#2a0f3a")
    g.line(16, 10, 21, 8, "#2a0f3a"); g.line(21, 8, 27, 10, "#2a0f3a"); g.line(17, 7, 21, 8, "#2a0f3a"); g.line(21, 8, 26, 6, "#2a0f3a")
    g.rect(15, 22, 34, 31, "#141b33")
    text(g, "VI", 19, 23, W, 2)
    return g


def a_cart():
    g = Grid()
    g.rect(11, 5, 36, 30, "#9aa0a6")
    g.rect(11, 5, 14, 7, None); g.rect(33, 5, 36, 7, None)
    g.rect(15, 5, 32, 5, "#c4c9cf")
    g.rect(14, 9, 33, 22, PURPLE)
    g.rect(14, 9, 33, 10, "#c9a7ff")
    text(g, "?", 20, 13, GOLD, 2)
    sparkle(g, 16, 18, GOLDL); sparkle(g, 31, 13, GOLDL)
    for x in range(14, 34, 3):
        g.rect(x, 25, x + 1, 29, "#6c727a")
    return g


def a_cardpack():
    g = Grid()
    g.rect(14, 5, 33, 30, "#c7ccd6")
    for x in range(14, 34):
        if x % 2 == 0:
            g.set(x, 4, "#e9edf5"); g.set(x, 31, "#e9edf5")
    g.rect(14, 5, 33, 7, "#e9edf5"); g.rect(14, 28, 33, 30, "#e9edf5")
    for i, c in enumerate([RED, "#ff9f1c", GOLD, FROG, CYAN, PURPLE]):
        g.line(14, 20 + i, 33, 10 + i, c)
    g.poly([(23.5, 11), (25.6, 15.6), (30.5, 16), (26.6, 19.2), (28, 24), (23.5, 21.2), (19, 24), (20.4, 19.2), (16.5, 16), (21.4, 15.6)], GOLD)
    g.pts([(23, 14), (24, 14)], GOLDL)
    # a card peeking out the back
    g.rect(31, 8, 37, 26, W); g.rect(32, 9, 36, 25, "#5b8def")
    return g


def a_giftcard():
    g = Grid()
    card(g, 7, 9, 40, 28, "#d62839", "#ff6b78", "#8a1020")
    g.rect(16, 10, 18, 27, GOLD)
    g.rect(8, 16, 39, 18, GOLD)
    g.poly([(17, 15), (11, 10), (10, 15)], GOLDL)
    g.poly([(17, 15), (23, 10), (24, 15)], GOLDL)
    g.rect(16, 14, 18, 16, GOLDD)
    text(g, "GIFT", 23, 21, W)
    return g


def a_watch():
    g = Grid()
    g.rect(19, 2, 28, 33, "#6b3f1f")
    for y in range(4, 33, 4):
        g.rect(19, y, 28, y, "#4a2a12")
    g.ellipse(24, 18, 9.2, 9.2, GOLD)
    g.ellipse(24, 18, 7.4, 7.4, "#fbfbf2")
    g.rect(33, 16, 34, 19, GOLDD)
    for (x, y) in ((24, 11), (24, 24), (17, 18), (30, 18)):
        g.set(x, y, "#444444")
    g.line(24, 18, 24, 13, K)
    g.line(24, 18, 28, 20, K)
    g.set(19, 13, W); g.set(20, 12, W)
    return g


def a_ring():
    g = Grid()
    g.ellipse(24, 23, 11.5, 9.0, GOLD)
    g.ellipse(24, 23.5, 8.2, 6.0, None)
    for y in range(H_):                          # shade the band's lower half
        for x in range(W_):
            if g.get(x, y) == GOLD and y > 25:
                g.set(x, y, "#e0a92a")
    g.rect(19, 13, 29, 15, GOLDD)
    gem(g, 24, 3, 14, 11, PINK, "#ffd0f0", "#a0287f")
    g.pts([(14, 18), (15, 17)], GOLDL)
    return g


def a_golden():
    g = Grid()
    g.ellipse(24, 26, 16.5, 5.5, "#8e1b2f")
    g.ellipse(24, 25, 15.5, 4.2, "#b52a42")
    for x in (8, 39):
        g.rect(x, 27, x, 30, GOLD); g.rect(x - 1, 31, x + 1, 32, GOLD)
    # a golden baton resting on the cushion
    g.ellipse(14, 19, 4.0, 4.0, GOLD)
    g.ellipse(34, 19, 4.0, 4.0, GOLD)
    g.rect(14, 15, 34, 22, GOLD)
    g.rect(13, 16, 34, 17, GOLDL)
    g.rect(14, 21, 34, 22, "#d39b1b")
    return g


def a_mystery():
    g = Grid()
    g.rect(11, 14, 36, 31, "#5b2a9a")
    g.rect(9, 10, 38, 15, "#7d45c9")
    g.rect(9, 10, 38, 10, "#a57be0")
    g.rect(22, 10, 25, 15, GOLD)
    g.poly([(23.5, 10), (15, 3), (14, 9)], GOLD)
    g.poly([(23.5, 10), (32, 3), (33, 9)], GOLD)
    g.rect(22, 8, 25, 10, GOLDD)
    text(g, "?", 19, 17, W, 3)
    return g


def a_probation():
    g = Grid()
    g.poly([(12, 3), (30, 3), (36, 9), (36, 32), (12, 32)], "#f4efe2")
    g.poly([(30, 3), (30, 9), (36, 9)], "#d6cfbd")
    for y in (7, 10, 13):
        g.rect(15, y, 27 if y == 7 else 32, y, "#b9b09a")
    g.rect(15, 28, 24, 28, "#7a7466")
    # PAID stamp: red letters in a red frame, like an ink stamp
    g.rect(14, 16, 34, 26, RED)
    g.rect(15, 17, 33, 25, "#f4efe2")
    text(g, "PAID", 17, 19, RED)
    g.set(14, 16, "#f4efe2"); g.set(34, 26, "#f4efe2")
    return g


# key -> (title, shelf, sprite fn, tag)
ITEMS = {
    "camfrog-pro-1m": ("Camfrog Pro, 1 month", "camfrog", lambda: member_card("pro", False), "1 MO"),
    "camfrog-pro-1y": ("Camfrog Pro, 1 year", "camfrog", lambda: member_card("pro", True), "1 YR"),
    "camfrog-extreme-1m": ("Camfrog Extreme, 1 month", "camfrog", lambda: member_card("extreme", False), "1 MO"),
    "camfrog-extreme-1y": ("Camfrog Extreme, 1 year", "camfrog", lambda: member_card("extreme", True), "1 YR"),
    "camfrog-gold-1m": ("Camfrog Gold, 1 month", "camfrog", lambda: member_card("gold", False), "1 MO"),
    "camfrog-gold-1y": ("Camfrog Gold, 1 year", "camfrog", lambda: member_card("gold", True), "1 YR"),
    "nitro-1m": ("Discord Nitro, 1 month", "perks", lambda: member_card("nitro", False), "1 MO"),
    "nitro-1y": ("Discord Nitro, 1 year", "perks", lambda: member_card("nitro", True), "1 YR"),
    "spin-boost": ("+100 daily gold spins", "perks", a_wheel, "+100"),
    "plex-1m": ("Plex invite, 1 month", "plex", lambda: vhs("#262626", "#e5a00d", "#7a4a00"), "1 MO"),
    "plex-1y": ("Plex invite, 1 year", "plex", lambda: vhs("#262626", "#e5a00d", "#7a4a00"), "1 YR"),
    "plex-life": ("Plex invite, lifetime", "plex", lambda: vhs("#c8961e", "#e5a00d", "#7a4a00", True), "LIFE"),
    "movie-requests": ("Movie requests", "plex", a_filmreel, "+10"),
    "tv-requests": ("TV requests", "plex", a_crt, "+2"),
    "role-scout": ("Scout role", "roles", a_binoculars, "ROLE"),
    "role-curator": ("Curator role", "roles", a_clapper, "ROLE"),
    "role-high-roller": ("High Roller role", "roles", a_highroller, "ROLE"),
    "ps5-pro": ("Console", "gaming", a_console, None),
    "gaming-pc": ("Custom gaming PC", "gaming", a_pc, None),
    "gta6": ("Game pre-order", "gaming", a_gamecase, None),
    "retro-game": ("Random retro game", "gaming", a_cart, "RETRO"),
    "card-pack": ("Trading card pack", "goods", a_cardpack, "PACK"),
    "gift-card": ("Gift card", "goods", a_giftcard, None),
    "watch": ("Watch", "goods", a_watch, None),
    "ring": ("Custom ring", "goods", a_ring, None),
    "golden": ("Golden novelty", "fun", a_golden, None),
    "mystery": ("Mystery prize", "fun", a_mystery, None),
    "probation": ("Probation, paid", "fun", a_probation, None),
}

SPARKS = [(5, 5), (42, 7), (40, 30), (6, 24)]


def render(key, title, shelf, fn, tag):
    inner, outer = SHELF_BG[shelf]
    g = fn()
    g.outline(EDGE)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W_} {H_}" shape-rendering="crispEdges">',
           f"<title>{title}</title>",
           f'<defs><radialGradient id="s" cx="50%" cy="42%" r="65%"><stop offset="0" stop-color="{inner}"/>'
           f'<stop offset="1" stop-color="{outer}"/></radialGradient></defs>',
           f'<rect width="{W_}" height="{H_}" fill="url(#s)"/>']
    # floor shadow + the spotlight's sparkles
    sh = Grid()
    sh.ellipse(24, 33.2, 15, 2.2, "#000")
    out.append('<g fill-opacity=".35">' + "".join(sh.runs()) + "</g>")
    sp = Grid()
    for (x, y) in SPARKS:
        sparkle(sp, x, y, "#fff")
    out.append('<g fill-opacity=".28">' + "".join(sp.runs()) + "</g>")
    out.extend(g.runs())
    if tag:
        t = Grid()
        tw = text_width(tag)
        x1 = W_ - 2
        x0 = x1 - tw - 3
        t.rect(x0, H_ - 9, x1, H_ - 2, "#0b0b0b")
        t.rect(x0 + 1, H_ - 10, x1 - 1, H_ - 1, "#0b0b0b")
        text(t, tag, x0 + 2, H_ - 8, "#ffe27a" if tag in ("LIFE", "+100") else W)
        out.extend(t.runs())
    out.append("</svg>")
    return "\n".join(out) + "\n"


def main():
    os.makedirs(ROOT, exist_ok=True)
    for key, (title, shelf, fn, tag) in ITEMS.items():
        with open(os.path.join(ROOT, key + ".svg"), "w", encoding="utf-8", newline="\n") as f:
            f.write(render(key, title, shelf, fn, tag))
    print(f"wrote {len(ITEMS)} pictures to {os.path.normpath(ROOT)}")


if __name__ == "__main__":
    main()
