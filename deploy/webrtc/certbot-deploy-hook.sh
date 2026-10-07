#!/usr/bin/env bash
# PATV 1.99et: certbot deploy hook for stream.publicaccess.tv. install.sh puts it at
# /etc/letsencrypt/renewal-hooks/deploy/patv-webrtc.sh. On every renewal of THAT lineage it copies the cert
# where coturn (user turnserver) can read it, restarts patv-turn (TURN sessions reconnect) and reloads nginx.
# Other certificates are ignored. Also run once by install.sh with RENEWED_LINEAGE set.
set -euo pipefail
LINEAGE="${RENEWED_LINEAGE:-}"
case "$LINEAGE" in
  */live/stream.publicaccess.tv) ;;
  *) exit 0 ;;
esac
DEST=/etc/patv-turn/certs
install -d -m 0750 -o root -g turnserver "$DEST"
install -m 0644 -o root -g turnserver "$LINEAGE/fullchain.pem" "$DEST/fullchain.pem"
install -m 0640 -o root -g turnserver "$LINEAGE/privkey.pem" "$DEST/privkey.pem"
if systemctl is-active --quiet patv-turn; then systemctl restart patv-turn; fi
if nginx -t >/dev/null 2>&1; then systemctl reload nginx; fi
