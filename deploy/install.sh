#!/usr/bin/env bash
# Install or refresh the PATV deploy pipeline on the VPS. Run as root from the repo:
#   bash deploy/install.sh prod        (and/or: staging)
set -euo pipefail
cd "$(dirname "$0")"
install -d -m 755 /opt/patv-deploy /etc/patv-deploy /var/lib/patv-deploy
install -m 755 patv-update.sh /opt/patv-deploy/patv-update.sh
install -m 644 patv-update@.service patv-update@.timer /etc/systemd/system/
systemctl daemon-reload
for inst in "$@"; do
  if [ ! -f "/etc/patv-deploy/$inst.env" ]; then
    install -m 600 "$inst.env.example" "/etc/patv-deploy/$inst.env"
    echo "created /etc/patv-deploy/$inst.env - review it"
  fi
  systemctl enable --now "patv-update@$inst.timer"
done
systemctl list-timers 'patv-update@*' --no-pager
