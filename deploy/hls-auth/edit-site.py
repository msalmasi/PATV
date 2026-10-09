#!/usr/bin/env python3
# deploy/hls-auth/edit-site.py - PATV 1.99gk: swap the publicaccess.tv server block's old static
#     location /hls { root /mnt/; ... }
# for `include snippets/patv-hls.conf;` in /etc/nginx/sites-available/default (install.sh runs it).
# Idempotent: a file that already includes the snippet is left alone. Exactly ONE old block must exist, else it
# refuses (exit 1) without writing anything.
#     python3 edit-site.py /etc/nginx/sites-available/default
import re
import sys

INCLUDE = "include snippets/patv-hls.conf;"


def main(path):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    if INCLUDE in src:
        print("   ok    already includes the snippet")
        return 0
    starts = [m.start() for m in re.finditer(r"(?m)^[ \t]*location /hls \{", src)]
    if len(starts) != 1:
        print("   FAIL  expected exactly one 'location /hls {' block, found %d" % len(starts), file=sys.stderr)
        return 1
    i = starts[0]
    j = src.index("{", i)
    depth = 0
    k = j
    while k < len(src):
        if src[k] == "{":
            depth += 1
        elif src[k] == "}":
            depth -= 1
            if depth == 0:
                break
        k += 1
    if depth != 0:
        print("   FAIL  unbalanced braces after 'location /hls'", file=sys.stderr)
        return 1
    block = src[i:k + 1]
    if "root /mnt/" not in block:
        print("   FAIL  the /hls block doesn't look like the static one (no 'root /mnt/')", file=sys.stderr)
        return 1
    indent = re.match(r"[ \t]*", src[i:]).group(0)
    new = src[:i] + indent + "# 1.99gk: /hls (Pepe's broadcast + RTMP slots, auth_request for slots) - deploy/hls-auth/\n" \
        + indent + INCLUDE + src[k + 1:]
    with open(path, "w", encoding="utf-8") as f:
        f.write(new)
    print("   ok    replaced the static /hls block with the include")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "/etc/nginx/sites-available/default"))
