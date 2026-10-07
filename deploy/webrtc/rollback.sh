#!/usr/bin/env bash
# deploy/webrtc/rollback.sh - PATV 1.99et: undo deploy/webrtc/install.sh completely.
#     bash /home/PATV-staging/deploy/webrtc/rollback.sh
# First turn "⚡ WebRTC ultra-low latency" OFF in /stage/admin on every site that has it on (the site then
# shows no WebRTC at all). Without that the players just fall back to HLS and WHIP go-live fails cleanly.
# Reverses, in order: services + units, the nginx site (nginx -t, then reload - never restart), the
# renewal hook (+ the stream.publicaccess.tv cert if install.sh issued it), the firewall rules it added,
# the .env lines it added (staging restarted to drop them), coturn (purged if install.sh installed it;
# the package's service unmasked), MediaMTX, the TURN secret and its state. Idempotent; stops at the
# first error. Backups of what it removes go to /root/patv-webrtc-backups/rollback-<time>/.
set -Eeuo pipefail
trap 'printf "\n   FAIL rollback.sh line %s: %s\n   Fix and re-run (idempotent).\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
umask 022

HOST=stream.publicaccess.tv
PROD_DIR=/home/PATV
STAGING_DIR=/home/PATV-staging
STATE=/var/lib/patv-webrtc
TS="$(date +%Y%m%d-%H%M%S)"
BK="/root/patv-webrtc-backups/rollback-$TS"

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   ok    %s\n' "$*"; }
warn() { printf '   WARN  %s\n' "$*" >&2; }
die()  { printf '   FAIL  %s\n' "$*" >&2; exit 1; }
has()  { grep -qxF "$1" "$STATE/changes" 2>/dev/null; }
pm2_do() {
  ( trap - ERR; set +eu
    export HOME=/root PM2_HOME=/root/.pm2 NVM_DIR=/root/.nvm
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use --silent 20 >/dev/null 2>&1; pm2 "$@" )
}
hls_fresh() { local f=/mnt/hls/broadcast.m3u8; [ -f "$f" ] && [ $(( $(date +%s) - $(stat -c %Y "$f") )) -lt 30 ]; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true; }

[ "$(id -u)" = 0 ] || die "run as root"
[ -f "$STATE/changes" ] || warn "no $STATE/changes - removing the known paths only (coturn, .env lines and the cert are left alone)"
PEPE_WAS_LIVE=0; if hls_fresh; then PEPE_WAS_LIVE=1; fi

say "Backups -> $BK"
install -d -m 0700 "$BK"
tar -czf "$BK/etc-nginx.tgz" -C / etc/nginx
iptables-save > "$BK/iptables.rules"
ufw status verbose > "$BK/ufw-status.txt" 2>&1 || true
for d in "$PROD_DIR" "$STAGING_DIR"; do if [ -f "$d/.env" ]; then install -m 0600 "$d/.env" "$BK/$(basename "$d").env"; fi; done
for f in /etc/mediamtx/mediamtx.yml /etc/patv-turn/turnserver.conf; do if [ -f "$f" ]; then install -m 0600 "$f" "$BK/$(echo "$f" | tr / _)"; fi; done
ok "done"

say "Services"
for u in mediamtx patv-turn; do
  if systemctl list-unit-files "$u.service" 2>/dev/null | grep -q "^$u.service"; then
    systemctl disable --now "$u.service" >/dev/null 2>&1 || true
    ok "$u stopped + disabled"
  fi
  rm -f "/etc/systemd/system/$u.service"
done
systemctl daemon-reload

say "nginx"
if [ -L /etc/nginx/sites-enabled/stream.publicaccess.tv ] || [ -e /etc/nginx/sites-enabled/stream.publicaccess.tv ] || [ -e /etc/nginx/sites-available/stream.publicaccess.tv ]; then
  rm -f /etc/nginx/sites-enabled/stream.publicaccess.tv /etc/nginx/sites-available/stream.publicaccess.tv
  nginx -t || die "nginx -t failed after removing the stream site - NOT reloading; the backup is $BK/etc-nginx.tgz"
  systemctl reload nginx
  ok "stream.publicaccess.tv site removed, nginx reloaded"
else
  ok "no stream site"
fi

say "Certificate"
rm -f /etc/letsencrypt/renewal-hooks/deploy/patv-webrtc.sh
if has cert-created && [ -d "/etc/letsencrypt/live/$HOST" ]; then
  certbot delete --cert-name "$HOST" --non-interactive
  ok "the $HOST certificate install.sh issued is deleted"
else
  ok "renewal hook removed (no cert of ours to delete)"
fi
if has acme-dir; then rmdir /var/www/html/.well-known/acme-challenge /var/www/html/.well-known 2>/dev/null || true; fi

say "Firewall"
if [ -f "$STATE/changes" ]; then
  while read -r line; do
    case "$line" in
      ufw:*) ufw delete allow "${line#ufw:}" >/dev/null 2>&1 || true; ok "ufw: removed ${line#ufw:}" ;;
      ipt:*)
        rest="${line#ipt:}"; proto="${rest%%:*}"; port="${rest#*:}"
        while iptables -C INPUT -p "$proto" --dport "$port" -m comment --comment patv-webrtc -j ACCEPT 2>/dev/null; do
          iptables -D INPUT -p "$proto" --dport "$port" -m comment --comment patv-webrtc -j ACCEPT
        done
        ok "iptables: removed $proto $port" ;;
    esac
  done < "$STATE/changes"
  if grep -q '^ipt:' "$STATE/changes" && command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null; fi
fi
ok "firewall back to before"

say ".env"
STAGING_ENV_CHANGED=0
for d in "$PROD_DIR" "$STAGING_DIR"; do
  f="$d/.env"
  [ -f "$f" ] || continue
  touched=0
  if has "env-secret:$f"; then sed -i '/^TURN_SECRET=/d' "$f"; touched=1; fi
  if has "env-peer:$f"; then sed -i '/^WHIP_AUTH_PEER=/d' "$f"; touched=1; fi
  if [ "$touched" = 1 ]; then
    sed -i '/^# patv-webrtc (deploy\/webrtc\/install\.sh /d' "$f"
    ok "$f: the lines install.sh added are removed"
    if [ "$d" = "$STAGING_DIR" ]; then STAGING_ENV_CHANGED=1; fi
  fi
done
if [ "$STAGING_ENV_CHANGED" = 1 ]; then pm2_do restart patv-staging >/dev/null || die "pm2 restart patv-staging failed"; ok "staging restarted"; fi

say "coturn"
systemctl unmask coturn.service >/dev/null 2>&1 || true
if has coturn-installed && dpkg-query -W -f='${Status}' coturn 2>/dev/null | grep -q "install ok installed"; then
  DEBIAN_FRONTEND=noninteractive apt-get purge -y coturn
  ok "coturn purged"
else
  ok "coturn left as it was (not installed by install.sh)"
fi
rm -rf /etc/patv-turn

say "MediaMTX"
rm -f /usr/local/bin/mediamtx
rm -rf /opt/mediamtx /etc/mediamtx /var/lib/mediamtx
if has user-mediamtx && id mediamtx >/dev/null 2>&1; then userdel mediamtx; ok "user mediamtx removed"; fi
ok "binary, config and state removed"

say "TURN secret + state"
rm -rf /etc/patv-webrtc
install -m 0600 "$STATE/changes" "$BK/install-changes" 2>/dev/null || true
rm -rf "$STATE"
ok "removed (the install's change list is kept in $BK)"

say "Health checks"
fails=0
check() { local name=$1; shift; if "$@"; then ok "$name"; else printf '   FAIL  %s\n' "$name" >&2; fails=$((fails + 1)); fi; }
wait_fresh() { for _ in $(seq 1 30); do hls_fresh && return 0; sleep 1; done; return 1; }
is200() { local c; for _ in $(seq 1 20); do c="$(code "$@")"; [ "$c" = 200 ] && return 0; sleep 3; done; return 1; }
if [ "$PEPE_WAS_LIVE" = 1 ]; then check "Pepe's RTMP ingest still updating /mnt/hls" wait_fresh; else warn "Pepe isn't streaming right now - not checked"; fi
check "prod site 200" is200 http://127.0.0.1:3000/healthz
check "staging site 200" is200 http://127.0.0.1:3100/healthz
check "prod via nginx 200" is200 --resolve publicaccess.tv:443:127.0.0.1 https://publicaccess.tv/healthz
gone() { ! ss -Hlnu "sport = :8189" | grep -q . && ! ss -Hlnu "sport = :3478" | grep -q .; }
check "nothing listens on 8189 / 3478 any more" gone
if [ "$fails" -gt 0 ]; then printf '   %s check(s) FAILED - see above.\n' "$fails" >&2; exit 1; fi
echo "   Rolled back. Backups: $BK"
