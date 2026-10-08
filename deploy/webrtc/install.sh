#!/usr/bin/env bash
# deploy/webrtc/install.sh - PATV 1.99et: MediaMTX (WHIP / WHEP / HLS) + coturn (TURN) on the VPS.
# Run as root on patv-vps, from a checkout that has this folder:
#     bash /home/PATV-staging/deploy/webrtc/install.sh            (auth hook -> staging, the first install)
#     AUTH_SITE=prod bash /home/PATV/deploy/webrtc/install.sh     (the promote: auth hook -> prod)
# 1.99fd: also Pepe's main stream over WHIP - MediaMTX path "pepe", RTSP on 127.0.0.1:8554 (TCP only) and
# pepe-relay.sh (-> /usr/local/lib/patv-webrtc/) with its RTMP target in /etc/mediamtx/pepe-relay.conf (written once,
# root:mediamtx 0640, never printed). PEPE_RTMP_NAME=<name> overrides his RTMP stream name (default: the first of
# STAGE_PEPE_KEYS in the prod .env, else "broadcast"). Needs ffmpeg (opus decoder, aac encoder, rtsp + flv).
# Idempotent: every step checks first, a re-run only changes what differs. Stops at the first error
# (nothing after it runs); undo everything with rollback.sh next to it. Never prints the TURN secret.
# See INSTALL.md.
set -Eeuo pipefail
trap 'printf "\n   FAIL install.sh line %s: %s\n   Nothing after this ran. Fix and re-run (idempotent), or undo: bash %s/rollback.sh\n" "$LINENO" "$BASH_COMMAND" "$HERE" >&2' ERR
umask 022

MEDIAMTX_VERSION=v1.21.1
MEDIAMTX_SHA256=653abc672a3e693f8d3b2717752492fdcfb8072291ec108d03d3dd857411b0ee   # checksums.sha256 of that release
HOST=stream.publicaccess.tv
PROD_DIR=/home/PATV
STAGING_DIR=/home/PATV-staging
AUTH_SITE="${AUTH_SITE:-staging}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
BK="/root/patv-webrtc-backups/$TS"
STATE=/var/lib/patv-webrtc                       # what this script changed (rollback.sh reads it)
SECRET_FILE=/etc/patv-webrtc/turn_secret
UDP_PORTS="8189 3478 5349 49160:49200"
TCP_PORTS="8189 3478 5349"

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   ok    %s\n' "$*"; }
warn() { printf '   WARN  %s\n' "$*" >&2; }
die()  { printf '   FAIL  %s\n' "$*" >&2; exit 1; }
mark() { grep -qxF "$1" "$STATE/changes" 2>/dev/null || echo "$1" >> "$STATE/changes"; }
pm2_do() {   # pm2 lives in root's nvm (as in deploy/patv-update.sh)
  ( trap - ERR; set +eu
    export HOME=/root PM2_HOME=/root/.pm2 NVM_DIR=/root/.nvm
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use --silent 20 >/dev/null 2>&1; pm2 "$@" )
}
hls_fresh() { local f=/mnt/hls/broadcast.m3u8; [ -f "$f" ] && [ $(( $(date +%s) - $(stat -c %Y "$f") )) -lt 30 ]; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true; }
CHANGED_MTX=0; CHANGED_TURN=0; CHANGED_NGINX=0; CHANGED_STAGING_ENV=0
put() {      # put <src> <dest> <owner> <group> <mode> <flagvar>: install when different (old copy -> backup)
  local src=$1 dst=$2
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    chown "$3:$4" "$dst"; chmod "$5" "$dst"; ok "$dst unchanged"; return 0
  fi
  if [ -f "$dst" ]; then install -m 0600 "$dst" "$BK/$(echo "$dst" | tr / _)"; fi
  install -m "$5" -o "$3" -g "$4" "$src" "$dst"
  printf -v "$6" 1
  ok "$dst installed"
}

# ───────────────────────────────── preflight ─────────────────────────────────
say "Preflight"
[ "$(id -u)" = 0 ] || die "run as root"
[ "$(uname -m)" = x86_64 ] || die "expects x86_64 (MediaMTX linux_amd64)"
for c in curl openssl sha256sum tar nginx certbot ss awk sed cmp python3 systemctl install getent ip dpkg-query apt-get iptables-save ffmpeg runuser; do
  command -v "$c" >/dev/null || die "missing command: $c"
done
case "$AUTH_SITE" in
  staging) AUTH_URL=http://127.0.0.1:3100/api/stage/whip-auth ;;
  prod)    AUTH_URL=http://127.0.0.1:3000/api/stage/whip-auth ;;
  *) die "AUTH_SITE must be staging or prod" ;;
esac
for f in "$HERE/mediamtx.yml" "$HERE/turnserver.conf" "$HERE/mediamtx.service" "$HERE/patv-turn.service" \
         "$HERE/nginx-stream.publicaccess.tv.conf" "$HERE/certbot-deploy-hook.sh"; do
  [ -f "$f" ] || die "template missing: $f"
done
[ -f "$PROD_DIR/.env" ] || die "$PROD_DIR/.env missing"
[ -f "$STAGING_DIR/.env" ] || die "$STAGING_DIR/.env missing"
PUBLIC_IP="$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
[[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "couldn't find the public IPv4"
DNS_IP="$(getent ahostsv4 "$HOST" | awk 'NR == 1 { print $1 }')"
[ "$DNS_IP" = "$PUBLIC_IP" ] || die "$HOST resolves to '${DNS_IP:-nothing}', not this box ($PUBLIC_IP). It must be a DNS-only (grey cloud) A record: ICE and TURN need the real IP."
ok "public IP $PUBLIC_IP, $HOST points here, auth hook -> $AUTH_SITE ($AUTH_URL)"
# nothing else may own our ports
busy="$(ss -Hlnptu 2>/dev/null | awk '$5 ~ /:(8189|3478|5349|8888|8889|9997|8554)$/' | grep -vE '"(mediamtx|turnserver)"' || true)"
[ -z "$busy" ] || die "ports already in use by something else: $busy"
# 1.99fd: Pepe's WHIP relay (pepe-relay.sh) is ffmpeg: RTSP in, Opus decoded, AAC encoded, FLV (RTMP) out
# 1.99fh: the lists are read in full first - `ffmpeg ... | grep -q` under pipefail fails at random (grep -q exits at
# the first match, ffmpeg gets SIGPIPE writing the rest, the pipeline returns 141)
FF_DEC="$(ffmpeg -hide_banner -decoders 2>/dev/null || true)"
FF_ENC="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
FF_FMT="$(ffmpeg -hide_banner -formats 2>/dev/null || true)"
grep -qE '^ A[.A-Z]{5} opus ' <<<"$FF_DEC" || die "ffmpeg has no opus decoder (Pepe's WHIP relay needs it)"
grep -qE '^ A[.A-Z]{5} aac ' <<<"$FF_ENC" || die "ffmpeg has no aac encoder (Pepe's WHIP relay needs it)"
grep -qE '^ D[E ] rtsp ' <<<"$FF_FMT" || die "ffmpeg can't read rtsp (Pepe's WHIP relay needs it)"
grep -qE '^ [D ]E flv ' <<<"$FF_FMT" || die "ffmpeg can't write flv (Pepe's WHIP relay needs it)"
ok "ffmpeg $(ffmpeg -hide_banner -version | awk 'NR == 1 { print $3 }'): opus decoder, aac encoder, rtsp in, flv out"
# a config change below restarts MediaMTX: every WHIP publisher / WHEP viewer reconnects (OBS does it by itself)
if live="$(curl -fsS --max-time 5 http://127.0.0.1:9997/v3/paths/list 2>/dev/null | python3 -c 'import json, sys; print(" ".join(p["name"] for p in json.load(sys.stdin).get("items", []) if p.get("ready") or p.get("available")))' 2>/dev/null)" && [ -n "$live" ]; then
  warn "live on MediaMTX right now: $live - a MediaMTX restart below drops them for a few seconds"
fi
if systemctl is-active --quiet coturn 2>/dev/null; then die "a coturn.service is already running on this box - not ours, not touching it"; fi
PEPE_WAS_LIVE=0
if hls_fresh; then PEPE_WAS_LIVE=1; ok "Pepe's RTMP -> /mnt/hls is live right now (re-checked at the end)"; else warn "Pepe's /mnt/hls/broadcast.m3u8 isn't fresh right now - the final check can't prove it still works"; fi

# ───────────────────────────────── backups ─────────────────────────────────
say "Backups -> $BK"
install -d -m 0700 "$BK" "$STATE"
tar -czf "$BK/etc-nginx.tgz" -C / etc/nginx
iptables-save > "$BK/iptables.rules"
if command -v ip6tables-save >/dev/null; then ip6tables-save > "$BK/ip6tables.rules"; fi
ufw status verbose > "$BK/ufw-status.txt" 2>&1 || true
install -m 0600 "$PROD_DIR/.env" "$BK/prod.env"
install -m 0600 "$STAGING_DIR/.env" "$BK/staging.env"
chmod -R go-rwx "$BK"
echo "$TS install AUTH_SITE=$AUTH_SITE PUBLIC_IP=$PUBLIC_IP" >> "$STATE/runs"
ok "nginx, iptables, ufw status, both .env files"

# ───────────────────────────────── MediaMTX ─────────────────────────────────
say "MediaMTX $MEDIAMTX_VERSION"
BIN_DIR="/opt/mediamtx/$MEDIAMTX_VERSION"
if [ -x "$BIN_DIR/mediamtx" ] && [ "$(cat "$BIN_DIR/.tarball.sha256" 2>/dev/null)" = "$MEDIAMTX_SHA256" ]; then
  ok "already installed in $BIN_DIR"
else
  TARBALL="mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz"
  TMPD="$(mktemp -d)"
  curl -fsSL --retry 3 -o "$TMPD/$TARBALL" "https://github.com/bluenviron/mediamtx/releases/download/$MEDIAMTX_VERSION/$TARBALL"
  echo "$MEDIAMTX_SHA256  $TMPD/$TARBALL" | sha256sum -c --quiet - || die "checksum mismatch for $TARBALL - not installing it"
  ok "sha256 verified"
  tar -xzf "$TMPD/$TARBALL" -C "$TMPD" mediamtx
  install -d -m 0755 "$BIN_DIR"
  install -m 0755 "$TMPD/mediamtx" "$BIN_DIR/mediamtx"
  echo "$MEDIAMTX_SHA256" > "$BIN_DIR/.tarball.sha256"
  rm -rf "$TMPD"
  mark mediamtx-binary
  CHANGED_MTX=1
  ok "installed $BIN_DIR/mediamtx"
fi
if [ "$(readlink /usr/local/bin/mediamtx 2>/dev/null || true)" != "$BIN_DIR/mediamtx" ]; then
  ln -sfn "$BIN_DIR/mediamtx" /usr/local/bin/mediamtx; CHANGED_MTX=1
fi
if ! id mediamtx >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /var/lib/mediamtx --shell /usr/sbin/nologin mediamtx
  mark user-mediamtx
  ok "system user mediamtx"
fi

# ───────────────────────────────── coturn ─────────────────────────────────
say "coturn"
if dpkg-query -W -f='${Status}' coturn 2>/dev/null | grep -q "install ok installed"; then
  ok "already installed"
else
  # the package's own service must never start with its default config: mask it + block starts during the install
  systemctl mask coturn.service >/dev/null 2>&1 || true
  POLICY_ADDED=0
  if [ ! -e /usr/sbin/policy-rc.d ]; then printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; chmod 0755 /usr/sbin/policy-rc.d; POLICY_ADDED=1; fi
  mark coturn-installed
  if ! DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends coturn; then
    if [ "$POLICY_ADDED" = 1 ]; then rm -f /usr/sbin/policy-rc.d; fi
    die "apt-get install coturn failed (try: apt-get update, then re-run)"
  fi
  if [ "$POLICY_ADDED" = 1 ]; then rm -f /usr/sbin/policy-rc.d; fi
  ok "installed $(dpkg-query -W -f='${Version}' coturn)"
fi
systemctl mask coturn.service >/dev/null 2>&1 || true
systemctl stop coturn.service >/dev/null 2>&1 || true
ok "packaged coturn.service masked (patv-turn.service runs it)"
command -v turnserver >/dev/null || die "turnserver binary missing after the install"
id turnserver >/dev/null 2>&1 || die "user turnserver missing (the coturn package creates it)"

# ───────────────────────────────── TURN secret -> both sites' .env ─────────────────────────────────
say "TURN secret"
install -d -m 0700 -o root -g root /etc/patv-webrtc
if [ ! -s "$SECRET_FILE" ]; then
  ( umask 077; openssl rand -hex 32 > "$SECRET_FILE" )
  mark turn-secret
  ok "generated $SECRET_FILE (root 0600, not shown)"
else
  ok "$SECRET_FILE exists (kept)"
fi
chown root:root "$SECRET_FILE"; chmod 0600 "$SECRET_FILE"
env_add() {   # env_add <env file> <tag>: TURN_SECRET (from the secret file) + WHIP_AUTH_PEER, appended once
  local f=$1 tag=$2 peer st changed=0
  if [ "$tag" = prod ]; then peer=http://127.0.0.1:3100/api/stage/whip-auth; else peer=http://127.0.0.1:3000/api/stage/whip-auth; fi
  # compare without the secret ever being an argument or on screen
  st="$(awk 'NR == FNR { s = $0; next } /^TURN_SECRET=/ { found = 1; print (substr($0, 13) == s) ? "same" : "diff" } END { if (!found) print "none" }' "$SECRET_FILE" "$f" | head -1)"
  case "$st" in
    same) ok "$f: TURN_SECRET already set" ;;
    diff) die "$f has a different TURN_SECRET than $SECRET_FILE - fix it by hand (never print it), then re-run" ;;
    none)
      if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then echo >> "$f"; fi
      { echo "# patv-webrtc (deploy/webrtc/install.sh $TS)"; printf 'TURN_SECRET=%s\n' "$(cat "$SECRET_FILE")"; } >> "$f"
      mark "env-secret:$f"; changed=1
      ok "$f: TURN_SECRET added (not shown)" ;;
  esac
  if grep -q '^WHIP_AUTH_PEER=' "$f"; then
    if grep -qxF "WHIP_AUTH_PEER=$peer" "$f"; then ok "$f: WHIP_AUTH_PEER already set"; else warn "$f: WHIP_AUTH_PEER differs from $peer - left as it is"; fi
  else
    if [ -n "$(tail -c1 "$f")" ]; then echo >> "$f"; fi
    { echo "# patv-webrtc (deploy/webrtc/install.sh $TS)"; echo "WHIP_AUTH_PEER=$peer"; } >> "$f"
    mark "env-peer:$f"; changed=1
    ok "$f: WHIP_AUTH_PEER=$peer"
  fi
  if [ "$tag" = staging ] && [ "$changed" = 1 ]; then CHANGED_STAGING_ENV=1; fi
}
env_add "$PROD_DIR/.env" prod
env_add "$STAGING_DIR/.env" staging

# ───────────────────────────────── certificate for stream.publicaccess.tv ─────────────────────────────────
say "Certificate ($HOST)"
LIVE="/etc/letsencrypt/live/$HOST"
if [ -s "$LIVE/fullchain.pem" ] && [ -s "$LIVE/privkey.pem" ]; then
  ok "already issued"
else
  # http-01 by webroot through the default server (root /var/www/html) - no nginx change needed for it
  ACME=/var/www/html/.well-known/acme-challenge
  if [ ! -d "$ACME" ]; then install -d -m 0755 "$ACME"; mark "acme-dir"; fi
  probe="patv-probe-$TS"
  echo "$probe" > "$ACME/$probe"
  got="$(curl -fsS --max-time 10 --resolve "$HOST:80:127.0.0.1" "http://$HOST/.well-known/acme-challenge/$probe" || true)"
  rm -f "$ACME/$probe"
  [ "$got" = "$probe" ] || die "http://$HOST/.well-known/acme-challenge/ isn't served from /var/www/html - can't issue by webroot"
  mark cert-created
  certbot certonly --webroot -w /var/www/html -d "$HOST" --non-interactive --keep-until-expiring
  ok "issued"
fi
put "$HERE/certbot-deploy-hook.sh" /etc/letsencrypt/renewal-hooks/deploy/patv-webrtc.sh root root 0755 CHANGED_TURN
RENEWED_LINEAGE="$LIVE" bash /etc/letsencrypt/renewal-hooks/deploy/patv-webrtc.sh
ok "cert copied to /etc/patv-turn/certs for turnserver"

# ───────────────────────────────── configs + units ─────────────────────────────────
say "Configs and units"
TMPR="$(mktemp -d)"; chmod 0700 "$TMPR"
sed -e "s|@PUBLIC_IP@|$PUBLIC_IP|g" -e "s|@AUTH_URL@|$AUTH_URL|g" "$HERE/mediamtx.yml" > "$TMPR/mediamtx.yml"
install -d -m 0750 -o root -g mediamtx /etc/mediamtx
put "$TMPR/mediamtx.yml" /etc/mediamtx/mediamtx.yml root mediamtx 0640 CHANGED_MTX
# turnserver.conf: public placeholders by sed, the secret by awk reading the file (never an argument)
sed -e "s|@PUBLIC_IP@|$PUBLIC_IP|g" -e "s|@TURN_HOST@|$HOST|g" "$HERE/turnserver.conf" > "$TMPR/turn.1"
( umask 077; awk -v sf="$SECRET_FILE" 'BEGIN { getline s < sf } { gsub(/@TURN_SECRET@/, s); print }' "$TMPR/turn.1" > "$TMPR/turnserver.conf" )
if grep -q '@[A-Z_]*@' "$TMPR/turnserver.conf"; then die "turnserver.conf still has a placeholder"; fi
if grep -q '@[A-Z_]*@' "$TMPR/mediamtx.yml"; then die "mediamtx.yml still has a placeholder"; fi
if ! grep -q '^static-auth-secret=[0-9a-f]\{64\}$' "$TMPR/turnserver.conf"; then die "turnserver.conf: the secret didn't render"; fi
install -d -m 0750 -o root -g turnserver /etc/patv-turn
put "$TMPR/turnserver.conf" /etc/patv-turn/turnserver.conf root turnserver 0640 CHANGED_TURN
rm -rf "$TMPR"
put "$HERE/mediamtx.service" /etc/systemd/system/mediamtx.service root root 0644 CHANGED_MTX
put "$HERE/patv-turn.service" /etc/systemd/system/patv-turn.service root root 0644 CHANGED_TURN
systemctl daemon-reload

# 1.99fd: Pepe's WHIP relay - the script (MediaMTX runs it, as mediamtx) + its RTMP target (written once, never shown)
CHANGED_RELAY=0
install -d -m 0755 -o root -g root /usr/local/lib/patv-webrtc
put "$HERE/pepe-relay.sh" /usr/local/lib/patv-webrtc/pepe-relay.sh root root 0755 CHANGED_RELAY
RELAY_CONF=/etc/mediamtx/pepe-relay.conf
if [ ! -s "$RELAY_CONF" ]; then
  pname="${PEPE_RTMP_NAME:-$(awk -F= '/^STAGE_PEPE_KEYS=/ { sub(/^STAGE_PEPE_KEYS=/, ""); split($0, a, ","); print a[1] }' "$PROD_DIR/.env" | tr -d ' "' | head -1)}"
  pname="${pname:-broadcast}"
  [[ "$pname" =~ ^[A-Za-z0-9._?=\&-]+$ ]] || die "PEPE_RTMP_NAME / STAGE_PEPE_KEYS has characters an RTMP stream name can't have"
  ( umask 027
    { echo "# Pepe's WHIP relay target (deploy/webrtc/install.sh $TS) - root:mediamtx 0640, never print it"
      echo "RTMP_TARGET=rtmp://127.0.0.1/live/$pname"
      echo "AUDIO_BITRATE=160k"; } > "$RELAY_CONF" )
  mark pepe-relay-conf
  ok "$RELAY_CONF written (his RTMP name, not shown)"
else
  grep -qE '^RTMP_TARGET=rtmp://(127\.0\.0\.1|localhost)(:[0-9]+)?/' "$RELAY_CONF" || die "$RELAY_CONF has no loopback RTMP_TARGET - fix it by hand (never print it)"
  ok "$RELAY_CONF exists (kept)"
fi
chown root:mediamtx "$RELAY_CONF"; chmod 0640 "$RELAY_CONF"

# ───────────────────────────────── nginx (own file; reload, never restart) ─────────────────────────────────
say "nginx"
put "$HERE/nginx-stream.publicaccess.tv.conf" /etc/nginx/sites-available/stream.publicaccess.tv root root 0644 CHANGED_NGINX
if [ "$(readlink /etc/nginx/sites-enabled/stream.publicaccess.tv 2>/dev/null || true)" != /etc/nginx/sites-available/stream.publicaccess.tv ]; then
  ln -sfn /etc/nginx/sites-available/stream.publicaccess.tv /etc/nginx/sites-enabled/stream.publicaccess.tv
  mark nginx-site; CHANGED_NGINX=1
fi
if ! nginx -t; then
  rm -f /etc/nginx/sites-enabled/stream.publicaccess.tv
  die "nginx -t failed - the new site was unlinked again, nginx NOT reloaded (the running config is untouched)"
fi
if [ "$CHANGED_NGINX" = 1 ]; then systemctl reload nginx; ok "nginx reloaded"; else ok "nginx unchanged (no reload)"; fi

# ───────────────────────────────── firewall ─────────────────────────────────
say "Firewall"
if ufw status 2>/dev/null | grep -q '^Status: active'; then
  for p in $UDP_PORTS; do ufw allow "$p/udp" comment 'patv-webrtc' >/dev/null; mark "ufw:$p/udp"; done
  for p in $TCP_PORTS; do ufw allow "$p/tcp" comment 'patv-webrtc' >/dev/null; mark "ufw:$p/tcp"; done
  ok "ufw: opened udp $UDP_PORTS, tcp $TCP_PORTS"
elif iptables -S INPUT | grep -qE '^-P INPUT (DROP|REJECT)|-j (DROP|REJECT)'; then
  for proto in udp tcp; do
    if [ "$proto" = udp ]; then list=$UDP_PORTS; else list=$TCP_PORTS; fi
    for p in $list; do
      if ! iptables -C INPUT -p "$proto" --dport "$p" -m comment --comment patv-webrtc -j ACCEPT 2>/dev/null; then
        iptables -I INPUT -p "$proto" --dport "$p" -m comment --comment patv-webrtc -j ACCEPT
        mark "ipt:$proto:$p"
      fi
    done
  done
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null; else warn "iptables rules added but not persisted across a reboot (no netfilter-persistent)"; fi
  ok "iptables: opened udp $UDP_PORTS, tcp $TCP_PORTS"
else
  ok "no host firewall filters INPUT (ufw inactive, iptables INPUT policy ACCEPT, no DROP/REJECT rules): nothing to open on the box"
  echo "         If the provider has a network firewall, open there: udp 8189, 3478, 5349, 49160-49200 and tcp 8189, 3478, 5349"
fi

# ───────────────────────────────── services ─────────────────────────────────
say "Services"
systemctl enable mediamtx.service patv-turn.service >/dev/null 2>&1
if [ "$CHANGED_MTX" = 1 ] || ! systemctl is-active --quiet mediamtx; then systemctl restart mediamtx; ok "mediamtx (re)started"; else ok "mediamtx unchanged and running"; fi
if [ "$CHANGED_TURN" = 1 ] || ! systemctl is-active --quiet patv-turn; then systemctl restart patv-turn; ok "patv-turn (re)started"; else ok "patv-turn unchanged and running"; fi
if [ "$CHANGED_STAGING_ENV" = 1 ]; then
  # a plain restart: the site reads .env itself (dotenv) at start
  pm2_do restart patv-staging >/dev/null || die "pm2 restart patv-staging failed"
  ok "staging site restarted to read its .env (prod reads its .env at its next deploy / restart)"
fi
for _ in $(seq 1 20); do
  systemctl is-active --quiet mediamtx && systemctl is-active --quiet patv-turn && break
  sleep 1
done

# ───────────────────────────────── health checks ─────────────────────────────────
say "Health checks"
fails=0
check() { local name=$1; shift; if "$@"; then ok "$name"; else printf '   FAIL  %s\n' "$name" >&2; fails=$((fails + 1)); fi; }
wait_fresh() { for _ in $(seq 1 30); do hls_fresh && return 0; sleep 1; done; return 1; }
if [ "$PEPE_WAS_LIVE" = 1 ]; then check "Pepe's RTMP ingest still updating /mnt/hls" wait_fresh
else warn "Pepe wasn't streaming before the install - check /mnt/hls/broadcast.m3u8 the next time he is"; fi
is200() { local c; for _ in $(seq 1 20); do c="$(code "$@")"; [ "$c" = 200 ] && return 0; sleep 3; done; echo "   (last answer: $c)" >&2; return 1; }
check "prod site 200 (127.0.0.1:3000/healthz)" is200 http://127.0.0.1:3000/healthz
check "staging site 200 (127.0.0.1:3100/healthz)" is200 http://127.0.0.1:3100/healthz
check "prod via nginx 200 (https://publicaccess.tv/healthz)" is200 --resolve publicaccess.tv:443:127.0.0.1 https://publicaccess.tv/healthz
check "staging via nginx 200 (https://staging.publicaccess.tv/healthz)" is200 --resolve staging.publicaccess.tv:443:127.0.0.1 https://staging.publicaccess.tv/healthz
both_active() { systemctl is-active --quiet mediamtx && systemctl is-active --quiet patv-turn; }
check "mediamtx + patv-turn active" both_active
api_up() { curl -fsS --max-time 5 http://127.0.0.1:9997/v3/paths/list | grep -q '"items"'; }
check "MediaMTX API up (127.0.0.1:9997)" api_up
hook_up() { local c; c="$(code -X POST -H 'Content-Type: application/json' -d '{"action":"read","protocol":"hls","path":"stg-0000000000000000"}' "$AUTH_URL")"; [ "$c" = 403 ] || [ "$c" = 200 ]; }
check "the $AUTH_SITE site answers MediaMTX's auth hook (needs 1.99et deployed there)" hook_up
whip_up() { local c; c="$(code -X POST -H 'Content-Type: application/sdp' --data-binary 'v=0' --resolve "$HOST:443:127.0.0.1" "https://$HOST/whip/stg-0000000000000000")"; case "$c" in 400|401|403) return 0 ;; *) echo "   (answer: $c)" >&2; return 1 ;; esac; }
check "WHIP through nginx reaches MediaMTX (https://$HOST/whip/...)" whip_up
listening() { ss -Hln"$1" "sport = :$2" | grep -q .; }
check "ICE udp 8189 listening" listening u 8189
# 1.99fd: Pepe's WHIP relay
rtsp_local() { ss -Hlnt "sport = :8554" | awk '{ print $4 }' | grep -qx '127.0.0.1:8554' && ! ss -Hlnt "sport = :8554" | awk '{ print $4 }' | grep -vqx '127.0.0.1:8554' && ! ss -Hlnu | awk '{ print $4 }' | grep -qE ':(8000|8001)$'; }
check "RTSP on 127.0.0.1:8554 only (TCP; no UDP RTP / RTCP)" rtsp_local
relay_ready() { runuser -u mediamtx -- test -r /etc/mediamtx/pepe-relay.conf && runuser -u mediamtx -- test -x /usr/local/lib/patv-webrtc/pepe-relay.sh; }
check "pepe-relay.sh + its target readable by mediamtx" relay_ready
pepe_hook() {   # the relay's loopback RTSP read of "pepe" is allowed, the same read from outside isn't, a bad WHIP bearer isn't
  local a b c
  a="$(code -X POST -H 'Content-Type: application/json' -d '{"action":"read","protocol":"rtsp","path":"pepe","ip":"127.0.0.1"}' "$AUTH_URL")"
  b="$(code -X POST -H 'Content-Type: application/json' -d '{"action":"read","protocol":"rtsp","path":"pepe","ip":"203.0.113.9"}' "$AUTH_URL")"
  c="$(code -X POST -H 'Content-Type: application/json' -d '{"action":"publish","protocol":"webrtc","path":"pepe","token":"not-the-key","ip":"203.0.113.9"}' "$AUTH_URL")"
  [ "$a" = 200 ] && [ "$b" = 403 ] && [ "$c" = 403 ] && return 0
  echo "   (relay read $a, outside read $b, bad bearer $c - needs site 1.99fd on prod)" >&2; return 1
}
check "the auth hook knows Pepe's WHIP path (site 1.99fd)" pepe_hook
check "ICE tcp 8189 listening" listening t 8189
check "TURN udp 3478 listening" listening u 3478
check "TURN tcp 3478 listening" listening t 3478
check "TURNS tcp 5349 listening" listening t 5349
stun_ok() { timeout 15 turnutils_stunclient -p 3478 "$PUBLIC_IP" >/dev/null 2>&1; }
check "turnutils_stunclient (STUN binding on $PUBLIC_IP:3478)" stun_ok
tls_ok() { echo | timeout 15 openssl s_client -connect "$PUBLIC_IP:5349" -servername "$HOST" -verify_hostname "$HOST" -verify_return_error 2>/dev/null | grep -q 'Verify return code: 0'; }
check "TURNS 5349 serves a valid cert for $HOST" tls_ok
turn_ok() {
  local creds tu tp out recv
  # a 2-minute credential, made the same way as the site's /api/turn (the secret is read from its file)
  creds="$(python3 - "$SECRET_FILE" <<'PY'
import base64, hashlib, hmac, sys, time
s = open(sys.argv[1]).read().strip().encode()
u = "%d:install-check" % (int(time.time()) + 120)
print(u, base64.b64encode(hmac.new(s, u.encode(), hashlib.sha1).digest()).decode())
PY
)"
  tu="${creds%% *}"; tp="${creds#* }"
  out="$(timeout 40 turnutils_uclient -y -n 10 -m 1 -l 120 -u "$tu" -w "$tp" -p 3478 "$PUBLIC_IP" 2>&1 || true)"
  recv="$(printf '%s\n' "$out" | grep -o 'tot_recv_msgs=[0-9]*' | tail -1 | cut -d= -f2 || true)"
  if [ "${recv:-0}" -gt 0 ] 2>/dev/null; then echo "         (relayed messages received: $recv)"; return 0; fi
  if printf '%s\n' "$out" | grep -qE 'Total lost packets [0-9]+ \(([0-9]|[1-8][0-9])\.'; then echo "         (relay round trip ok)"; return 0; fi
  printf '%s\n' "$out" | grep -iE 'error|fail|401|403|lost' | sed "s|$tp|<credential>|g" | tail -5 >&2
  return 1
}
check "turnutils_uclient: TURN allocation + relay with REST credentials" turn_ok

say "Result"
if [ "$fails" -gt 0 ]; then
  printf '   %s health check(s) FAILED - see above. Undo everything with: bash %s/rollback.sh\n' "$fails" "$HERE" >&2
  exit 1
fi
cat <<EOF
   All checks passed. Backups: $BK   State: $STATE
   Next: turn it on for $AUTH_SITE in /stage/admin (⚡ WebRTC ultra-low latency) and run the smoke tests in INSTALL.md.
   Pepe's main stream over WHIP (1.99fd): see "Pepe's main stream over WHIP" in INSTALL.md (OBS -> WHIP is a separate step).
EOF
