#!/usr/bin/env bash
# deploy/hls-auth/rollback.sh - PATV 1.99gk: undo deploy/hls-auth/install.sh from one of its backups.
#     bash deploy/hls-auth/rollback.sh                                    # the latest backup
#     bash deploy/hls-auth/rollback.sh /root/patv-hls-auth-backups/<time>
# Restores sites-available/default and puts back (or removes) snippets/patv-hls.conf and
# conf.d/patv-hls-auth-upstreams.conf exactly as they were, nginx -t, then RELOAD (never restart). /hls is then
# the old static block again: every slot stream is public, Pepe's broadcast unchanged.
set -Eeuo pipefail
umask 022
ROOT=/root/patv-hls-auth-backups
BK="${1:-$(ls -1d "$ROOT"/*/ 2>/dev/null | sort | tail -1)}"
BK="${BK%/}"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -n "$BK" ] && [ -f "$BK/default" ] || { echo "no backup found (${BK:-none})" >&2; exit 1; }
SITE=/etc/nginx/sites-available/default
SNIP=/etc/nginx/snippets/patv-hls.conf
UPS=/etc/nginx/conf.d/patv-hls-auth-upstreams.conf

echo "== rollback from $BK"
cp -a "$BK/default" "$SITE"
if [ -f "$BK/patv-hls.conf" ]; then cp -a "$BK/patv-hls.conf" "$SNIP"; else rm -f "$SNIP"; fi
if [ -f "$BK/patv-hls-auth-upstreams.conf" ]; then cp -a "$BK/patv-hls-auth-upstreams.conf" "$UPS"; else rm -f "$UPS"; fi
nginx -t
systemctl reload nginx
sleep 1
c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve publicaccess.tv:443:127.0.0.1 https://publicaccess.tv/hls/broadcast.m3u8 || true)"
echo "   ok    reloaded; Pepe's /hls/broadcast.m3u8 -> $c"
