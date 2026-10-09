#!/usr/bin/env bash
# deploy/hls-auth/install.sh - PATV 1.99gk: nginx auth_request for RTMP-slot HLS on Approved pads.
#     bash /home/PATV-staging/deploy/hls-auth/install.sh staging   # gate /hls/staging/ (stg-) only - test first
#     bash /home/PATV/deploy/hls-auth/install.sh prod              # gate prod (stage-) AND staging slots
# The site(s) must already run 1.99gk+ (GET /api/stage/hls-auth): staging for "staging", BOTH for "prod".
#
# What it does: backs up the nginx files it touches -> /root/patv-hls-auth-backups/<time>/, installs
# conf.d/patv-hls-auth-upstreams.conf + snippets/patv-hls.conf ("staging" = without the prod gate), swaps the static
# `location /hls {}` in sites-available/default for the include (edit-site.py), nginx -t, RELOAD (never restart), then
# health checks - Pepe's /hls/broadcast.m3u8 still public, the gate answers (a made-up slot name -> 404, not 500), prod
# and staging /healthz 200. Any failure -> automatic rollback to the backup. Idempotent (re-run to switch modes).
# Rollback by hand: bash deploy/hls-auth/rollback.sh [/root/patv-hls-auth-backups/<time>]   (default: the latest)
set -Eeuo pipefail
trap 'printf "\n   FAIL install.sh line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
umask 022

MODE="${1:-}"
[ "$MODE" = staging ] || [ "$MODE" = prod ] || { echo "usage: install.sh staging|prod" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE=/etc/nginx/sites-available/default
SNIP=/etc/nginx/snippets/patv-hls.conf
UPS=/etc/nginx/conf.d/patv-hls-auth-upstreams.conf
TS="$(date +%Y%m%d-%H%M%S)"
BK="/root/patv-hls-auth-backups/$TS"

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   ok    %s\n' "$*"; }
warn() { printf '   WARN  %s\n' "$*" >&2; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true; }
via()  { code --resolve "$1:443:127.0.0.1" "https://$1$2"; }   # through this nginx, not Cloudflare
hls_fresh() { local f=/mnt/hls/broadcast.m3u8; [ -f "$f" ] && [ $(( $(date +%s) - $(stat -c %Y "$f") )) -lt 30 ]; }

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
for f in patv-hls.conf patv-hls-auth-upstreams.conf edit-site.py rollback.sh; do [ -f "$HERE/$f" ] || { echo "missing $HERE/$f" >&2; exit 1; }; done

say "Pre-checks"
nginx -t >/dev/null 2>&1 || { echo "nginx -t fails BEFORE any change - fix that first" >&2; exit 1; }
PEPE_LIVE=0; if hls_fresh; then PEPE_LIVE=1; fi
ok "Pepe's broadcast.m3u8 fresh: $PEPE_LIVE"
for s in staging prod; do
  [ "$MODE" = prod ] || [ "$s" = staging ] || continue
  port=3100; [ "$s" = prod ] && port=3000
  c="$(code -H 'X-Original-URI: /hls/x.m3u8' "http://127.0.0.1:$port/api/stage/hls-auth")"
  [ "$c" = 200 ] || { echo "the $s site (:$port) has no /api/stage/hls-auth yet (got $c) - deploy 1.99gk there first" >&2; exit 1; }
  ok "$s site answers /api/stage/hls-auth"
done

say "Backups -> $BK"
install -d -m 0700 "$BK"
cp -a "$SITE" "$BK/default"
if [ -f "$SNIP" ]; then cp -a "$SNIP" "$BK/patv-hls.conf"; else touch "$BK/patv-hls.conf.absent"; fi
if [ -f "$UPS" ]; then cp -a "$UPS" "$BK/patv-hls-auth-upstreams.conf"; else touch "$BK/patv-hls-auth-upstreams.conf.absent"; fi
ok "done"

rollback() {
  warn "rolling back: $*"
  bash "$HERE/rollback.sh" "$BK" || warn "rollback.sh failed - restore $BK by hand"
  exit 1
}

say "Install ($MODE)"
install -m 0644 "$HERE/patv-hls-auth-upstreams.conf" "$UPS"
if [ "$MODE" = staging ]; then
  sed '/# BEGIN prod-gate/,/# END prod-gate/d' "$HERE/patv-hls.conf" > "$SNIP.tmp"
else
  cp "$HERE/patv-hls.conf" "$SNIP.tmp"
fi
chmod 0644 "$SNIP.tmp"; mv -f "$SNIP.tmp" "$SNIP"
python3 "$HERE/edit-site.py" "$SITE" || rollback "edit-site.py"
if ! nginx -t 2>&1 | sed 's/^/   /'; then rollback "nginx -t"; fi
nginx -t >/dev/null 2>&1 || rollback "nginx -t"
ELOG_LINES="$(wc -l < /var/log/nginx/error.log 2>/dev/null || echo 0)"
systemctl reload nginx
sleep 2
ok "reloaded"

say "Health checks"
fail=""
c="$(via publicaccess.tv /hls/broadcast.m3u8)"
if [ "$PEPE_LIVE" = 1 ]; then [ "$c" = 200 ] || fail="$fail broadcast.m3u8=$c"; else case "$c" in 200|404) ;; *) fail="$fail broadcast.m3u8=$c";; esac; fi
ok "Pepe's /hls/broadcast.m3u8 -> $c"
c="$(via publicaccess.tv /hls/staging/stg-0000000000000000.m3u8)"; [ "$c" = 404 ] || fail="$fail staging-gate=$c"
ok "staging gate (made-up stg- name) -> $c (want 404: auth said yes, no such file)"
c="$(via publicaccess.tv /hls/stage-0000000000000000.m3u8)"
if [ "$MODE" = prod ]; then [ "$c" = 404 ] || fail="$fail prod-gate=$c"; fi
ok "prod gate (made-up stage- name) -> $c"
c="$(via publicaccess.tv /_hls_auth)"; [ "$c" = 404 ] || fail="$fail internal=$c"
ok "/_hls_auth from outside -> $c (want 404)"
c="$(via publicaccess.tv /healthz)"; [ "$c" = 200 ] || fail="$fail prod-healthz=$c"
ok "prod /healthz -> $c"
c="$(via staging.publicaccess.tv /healthz)"; [ "$c" = 200 ] || fail="$fail staging-healthz=$c"
ok "staging /healthz -> $c"
NEW_ERR="$(tail -n +"$((ELOG_LINES + 1))" /var/log/nginx/error.log 2>/dev/null | grep -iE 'hls|auth' || true)"
if [ -n "$NEW_ERR" ]; then warn "new error.log lines:"; printf '%s\n' "$NEW_ERR" | tail -20 >&2; fi
[ -z "$fail" ] || rollback "health:$fail"

say "Installed ($MODE). Backup: $BK"
echo "   rollback: bash $HERE/rollback.sh $BK"
