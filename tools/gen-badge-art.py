"""Pixel-art badge icons the chat hub's widget asks v1 for (1.99aek) -> public/img/badges/<name>.png

    python tools/gen-badge-art.py

The hub's look of a person carries badges as {id, icon, label_key}; the widget draws `<assets><icon>.png` with the page's
assets base /public/img/ (chatwidget.js; rt-schema look, chat-core badgeLooks). userlook.buildLooks sends:

    supporter.<tier>  icon badges/supporter-<tier>   the 💚 Supporter tier by lifetime donations (supporter.js TIERS:
                                                     bronze, silver, gold) - a medal in the tier's colour with a green heart
    bot               icon badges/bot                 Pepe's bot badge - a green robot head (the site's 🤖 bot chip colours)
    ach.<id>          icon ach/<id>                   the achievement's own art (public/img/badges/ach/<id>.png, served at
                                                     /public/img/ach/ too - index.js)

None of the first four existed (each line of a supporter or of Pepe asked for a 404). Each icon is a 32 x 32 sprite with a
1-px dark outline, drawn 4x (128 x 128, nearest-neighbour) - the house pixel style of the achievement badges and the sticker
packs (tools/gen-stickers.py). Standard library only (zlib PNG writer, RGBA, no metadata), so re-running it rewrites the
files byte-for-byte the same.
"""
import os
import struct
import zlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "img", "badges")
N = 32
SCALE = 4
EDGE = "#0a0a0a"


class Grid:
    def __init__(self, n=N):
        self.n = n
        self.px = [[None] * n for _ in range(n)]

    def set(self, x, y, c):
        if 0 <= x < self.n and 0 <= y < self.n:
            self.px[y][x] = c

    def get(self, x, y):
        return self.px[y][x] if 0 <= x < self.n and 0 <= y < self.n else None

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.set(x, y, c)

    def disc(self, cx, cy, r, c):
        for y in range(self.n):
            for x in range(self.n):
                if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r:
                    self.set(x, y, c)

    def poly(self, pts, c):
        """Fill a polygon (pixel centres inside)."""
        n = len(pts)
        for y in range(self.n):
            for x in range(self.n):
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

    def pattern(self, x0, y0, rows, colors):
        for dy, row in enumerate(rows):
            for dx, ch in enumerate(row):
                if ch in colors:
                    self.set(x0 + dx, y0 + dy, colors[ch])

    def outline(self, edge=EDGE):
        """Paint `edge` round everything drawn so far (4-neighbour)."""
        add = []
        for y in range(self.n):
            for x in range(self.n):
                if self.px[y][x] is None:
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        v = self.get(x + dx, y + dy)
                        if v is not None and v != edge:
                            add.append((x, y))
                            break
        for x, y in add:
            self.px[y][x] = edge


def rgba(c):
    if c is None:
        return (0, 0, 0, 0)
    c = c.lstrip("#")
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), 255)


def png(grid, scale=SCALE):
    """The grid as an RGBA PNG, each pixel scale x scale (nearest-neighbour), no ancillary chunks."""
    size = grid.n * scale
    raw = bytearray()
    for y in range(grid.n):
        row = bytearray()
        for x in range(grid.n):
            row += bytes(rgba(grid.px[y][x])) * scale
        for _ in range(scale):
            raw += b"\x00" + row
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


# ── 💚 Supporter medals (supporter.js TIERS colours, each with a light and a dark shade) ──
TIERS = {
    "gold": {"face": "#ffd740", "light": "#fff3b0", "dark": "#c79a00"},
    "silver": {"face": "#cfd8dc", "light": "#f5f8f9", "dark": "#8b9aa1"},
    "bronze": {"face": "#d7894a", "light": "#f2c099", "dark": "#9a5a26"},
}
RIBBON = {"a": "#2e7d32", "b": "#43a047"}           # the Supporter green, two shades (stripes)
HEART = ["0110110", "1111111", "1111111", "0111110", "0011100", "0001000"]


def medal(tier):
    t = TIERS[tier]
    g = Grid()
    # the ribbon: two straps meeting behind the medal, striped
    g.poly([(7, 1), (13, 1), (19, 15), (13, 15)], RIBBON["a"])
    g.poly([(19, 1), (25, 1), (19, 15), (13, 15)], RIBBON["b"])
    g.poly([(9, 1), (11, 1), (16, 13), (14, 13)], RIBBON["b"])
    g.poly([(21, 1), (23, 1), (18, 13), (16, 13)], RIBBON["a"])
    # the medal: rim, face, a light arc top-left
    g.disc(16, 20.5, 10.5, t["dark"])
    g.disc(16, 20.5, 9, t["face"])
    for y in range(g.n):
        for x in range(g.n):
            d_out = (x + 0.5 - 16) ** 2 + (y + 0.5 - 20.5) ** 2
            d_in = (x + 0.5 - 17) ** 2 + (y + 0.5 - 21.5) ** 2
            if d_out <= 81 and d_in > 81 and x + y < 36:
                g.set(x, y, t["light"])
    # the green heart (💚) in the middle, a one-pixel shine
    g.pattern(13, 18, HEART, {"1": "#2fbf4a"})
    g.set(14, 19, "#b9f5c4")
    g.outline()
    return g


# ── 🤖 the bot badge: a green robot head (the site's .bot-badge chip: #1f3a1f / #d7f5b0) ──
def robot():
    g = Grid()
    body, light, dark, eye, mouth = "#7fbf6a", "#d7f5b0", "#3f7a3a", "#5ef0ff", "#1f3a1f"
    g.rect(15, 2, 16, 6, dark)                      # antenna
    g.disc(16, 2.5, 2, "#ff5252")                   # its light
    g.rect(4, 13, 5, 20, dark)                      # ears
    g.rect(26, 13, 27, 20, dark)
    g.rect(6, 7, 25, 27, body)                      # the head
    g.rect(7, 8, 24, 9, light)                      # top highlight
    g.rect(6, 26, 25, 27, dark)                     # chin shadow
    g.rect(9, 12, 22, 19, mouth)                    # the face plate
    g.rect(11, 14, 13, 16, eye)                     # eyes
    g.rect(18, 14, 20, 16, eye)
    g.set(11, 14, "#e8fdff")
    g.set(18, 14, "#e8fdff")
    for x in (11, 13, 15, 17, 19):                  # the mouth grille
        g.rect(x, 22, x, 23, mouth)
    g.rect(10, 21, 21, 21, dark)
    g.rect(10, 24, 21, 24, dark)
    g.outline()
    return g


def main():
    os.makedirs(ROOT, exist_ok=True)
    out = {f"supporter-{t}": medal(t) for t in ("bronze", "silver", "gold")}
    out["bot"] = robot()
    for name, grid in out.items():
        data = png(grid)
        with open(os.path.join(ROOT, name + ".png"), "wb") as f:
            f.write(data)
        print(f"{name}.png  {len(data)} bytes")


if __name__ == "__main__":
    main()
