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


def pepe_head(g):
    """The pixel Pepe head (base-pixel look): two eye bumps over a wide face."""
    g.ellipse(8.5, 7.5, 4.6, 3.8, G)
    g.ellipse(16.0, 7.5, 4.6, 3.8, G)
    g.ellipse(12.0, 14.0, 10.4, 7.2, G)
    g.rect(3, 12, 20, 19, G)
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


PACKS = {"pixelpepe": pixel_pack, "kawaiipond": kawaii_pack, "patvreacts": reacts_pack}


def main():
    for pack, fn in PACKS.items():
        d = os.path.join(ROOT, pack)
        os.makedirs(d, exist_ok=True)
        for sid, (title, grid) in fn().items():
            with open(os.path.join(d, sid + ".svg"), "w", encoding="utf-8", newline="\n") as f:
                f.write(grid.svg(title))
        print(pack, "ok")


if __name__ == "__main__":
    main()
