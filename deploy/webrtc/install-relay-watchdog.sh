#!/usr/bin/env bash
# deploy/webrtc/install-relay-watchdog.sh - PATV 1.99aai: install (or remove) pepe-relay-watchdog on the VPS, as root,
# from a checkout of the site (e.g. /home/PATV after the deploy). Idempotent; never restarts MediaMTX, nginx or the relay.
#
#   bash deploy/webrtc/install-relay-watchdog.sh            # install + start the timer (restarts for real)
#   bash deploy/webrtc/install-relay-watchdog.sh --dry-run  # same, but the watchdog only LOGS what it would do
#   bash deploy/webrtc/install-relay-watchdog.sh --remove   # stop + remove the timer/units/script (settings + state kept)
#
# Also refreshes /usr/local/lib/patv-webrtc/pepe-relay.sh (1.99aai TIMESTAMPS knob; default "source" = unchanged
# behaviour, and the running relay keeps its old copy until it next restarts). Old copies -> /var/backups/patv-webrtc/.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB=/usr/local/lib/patv-webrtc
UNITS=/etc/systemd/system
DEF=/etc/default/pepe-relay-watchdog
BK=/var/backups/patv-webrtc/relay-watchdog-$(date +%Y%m%d-%H%M%S)
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now pepe-relay-watchdog.timer 2>/dev/null || true
  rm -f "$UNITS/pepe-relay-watchdog.timer" "$UNITS/pepe-relay-watchdog.service" "$LIB/pepe-relay-watchdog.sh"
  systemctl daemon-reload
  echo "removed (kept $DEF and /var/lib/patv-webrtc/relay-watchdog.state)"
  exit 0
fi

for c in pgrep ps awk stat date tail curl python3 systemctl; do command -v "$c" >/dev/null || { echo "missing: $c"; exit 1; }; done
bash -n "$HERE/pepe-relay-watchdog.sh"
bash -n "$HERE/pepe-relay.sh"
install -d -m 0700 "$BK"
install -d -m 0755 -o root -g root "$LIB"
install -d -m 0750 /var/lib/patv-webrtc
for f in pepe-relay.sh pepe-relay-watchdog.sh; do
  [ -f "$LIB/$f" ] && cp -p "$LIB/$f" "$BK/$f"
  install -m 0755 -o root -g root "$HERE/$f" "$LIB/$f"
done
for f in pepe-relay-watchdog.service pepe-relay-watchdog.timer; do
  [ -f "$UNITS/$f" ] && cp -p "$UNITS/$f" "$BK/$f"
  install -m 0644 -o root -g root "$HERE/$f" "$UNITS/$f"
done
if [ ! -f "$DEF" ]; then
  cat > "$DEF" <<'EOF'
# pepe-relay-watchdog settings (deploy/webrtc/pepe-relay-watchdog.sh has the full list + defaults)
DRY_RUN=0
#SPLIT_MAX=40
#STALE_S=45
#BACKOFF_MAX=1800
#SITE=http://127.0.0.1:3000
#SITE_ENV=/home/PATV/.env
EOF
  chmod 0644 "$DEF"
fi
if [ "${1:-}" = "--dry-run" ]; then sed -i 's/^DRY_RUN=.*/DRY_RUN=1/' "$DEF"; else sed -i 's/^DRY_RUN=.*/DRY_RUN=0/' "$DEF"; fi
systemctl daemon-reload
systemctl enable --now pepe-relay-watchdog.timer
echo "installed (backups in $BK); mode: $(sed -n 's/^DRY_RUN=//p' "$DEF" | sed 's/1/DRY RUN (log only)/; s/0/live/')"
echo "watch it: journalctl -u pepe-relay-watchdog -f    timer: systemctl list-timers pepe-relay-watchdog.timer"
