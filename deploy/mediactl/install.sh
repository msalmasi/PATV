#!/usr/bin/env bash
# deploy/mediactl/install.sh - PATV 1.99ji: install / update the media-control service ("📼 Play from library").
# Run as root INSIDE the Plex container (it needs the media mounts, /dev/dri and Plex on loopback):
#     ALLOW_IPS=<vps-ip>/32 bash install.sh              first install / update (idempotent)
#     UNINSTALL=1 bash install.sh                         stop + disable (keeps /etc/mediactl)
# Options (environment):
#     ALLOW_IPS     extra allowed client IPs/CIDRs (the VPS), added to loopback. Required on a first install.
#     PORT          listen port (default 8790)
#     TLS=0         plain HTTP (only when the site reaches it over Tailscale)
#     ENCODER       vaapi (default) | x264
# What it does (every step checks first; never prints a secret):
#   1. installs nodejs + openssl from Debian if missing (apt)
#   2. system user mediactl (groups render, video); /usr/local/lib/mediactl/mediactl.js
#   3. /etc/mediactl/mediactl.env (root:mediactl 0640): a fresh MEDIACTL_SECRET if none, PLEX_TOKEN copied from Plex's
#      Preferences.xml if none, MEDIACTL_ALLOW = loopback + ALLOW_IPS
#   4. a self-signed TLS certificate (10 years) unless TLS=0; prints its SHA-256 fingerprint (public, the site pins it)
#   5. systemd unit mediactl: enabled + restarted; health check on loopback
set -Eeuo pipefail
trap 'printf "\n   FAIL install.sh line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB=/usr/local/lib/mediactl
ETC=/etc/mediactl
ENVF=$ETC/mediactl.env
UNIT=/etc/systemd/system/mediactl.service
PORT="${PORT:-8790}"
TLS="${TLS:-1}"
ENCODER="${ENCODER:-vaapi}"
PREFS="/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml"

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   ok    %s\n' "$*"; }
warn() { printf '   WARN  %s\n' "$*" >&2; }
die()  { printf '   FAIL  %s\n' "$*" >&2; exit 1; }
envget() { sed -n "s/^$1=//p" "$ENVF" | tail -1; }
envset() {   # envset KEY VALUE  (value never echoed)
  local k="$1" v="$2" tmp
  tmp="$(mktemp "$ETC/.env.XXXXXX")"
  grep -v "^$k=" "$ENVF" > "$tmp" || true
  printf '%s=%s\n' "$k" "$v" >> "$tmp"
  cat "$tmp" > "$ENVF"; rm -f "$tmp"
}

[ "$(id -u)" = 0 ] || die "run as root"

if [ "${UNINSTALL:-0}" = 1 ]; then
  say "Uninstall"
  systemctl disable --now mediactl 2>/dev/null || true
  ok "mediactl stopped + disabled (config kept in $ETC; remove it by hand if you want it gone)"
  exit 0
fi

say "Preflight"
[ -f "$HERE/mediactl.js" ] || die "mediactl.js not next to install.sh"
need=()
command -v node >/dev/null || need+=(nodejs)
command -v openssl >/dev/null || [ "$TLS" = 0 ] || need+=(openssl)
if [ ${#need[@]} -gt 0 ]; then
  say "apt install ${need[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${need[@]}"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node is v$NODE_MAJOR - needs 18+"
[ -x /usr/bin/node ] || die "/usr/bin/node missing (the unit runs it)"
command -v ffmpeg >/dev/null || die "ffmpeg missing (apt install ffmpeg)"
if [ "$ENCODER" = vaapi ]; then
  [ -e /dev/dri/renderD128 ] || die "/dev/dri/renderD128 missing - pass the iGPU into this container, or ENCODER=x264"
  ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_vaapi || die "this ffmpeg has no h264_vaapi - ENCODER=x264 or a full ffmpeg build"
fi
ok "node v$(node -v | tr -d v), $(ffmpeg -version | head -1 | cut -d' ' -f1-3), encoder $ENCODER"

say "User + files"
getent group render >/dev/null || die "no render group (the /dev/dri gid)"
if ! id mediactl >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin mediactl
  ok "created user mediactl"
fi
usermod -a -G render,video mediactl
install -d -m 0755 "$LIB"
install -m 0644 "$HERE/mediactl.js" "$LIB/mediactl.js"
install -d -m 0750 -o root -g mediactl "$ETC"
ok "$LIB/mediactl.js"

say "Config ($ENVF)"
if [ ! -f "$ENVF" ]; then
  install -m 0640 -o root -g mediactl "$HERE/mediactl.env.example" "$ENVF"
  ok "created from mediactl.env.example"
fi
chown root:mediactl "$ENVF"; chmod 0640 "$ENVF"
cur="$(envget MEDIACTL_SECRET)"
if [ -z "$cur" ] || [ "${#cur}" -lt 32 ] || printf '%s' "$cur" | grep -q REPLACE_ME; then
  envset MEDIACTL_SECRET "$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
  ok "generated MEDIACTL_SECRET (read it with: grep ^MEDIACTL_SECRET= $ENVF)"
else ok "MEDIACTL_SECRET kept"; fi
cur="$(envget PLEX_TOKEN)"
if [ -z "$cur" ] || [ "$cur" = REPLACE_ME ]; then
  tok="$(sed -n 's/.*PlexOnlineToken="\([^"]*\)".*/\1/p' "$PREFS" 2>/dev/null | head -1 || true)"
  if [ -n "$tok" ]; then envset PLEX_TOKEN "$tok"; ok "PLEX_TOKEN copied from Plex's Preferences.xml"; else warn "no PlexOnlineToken found - set PLEX_TOKEN in $ENVF by hand"; fi
  unset tok
else ok "PLEX_TOKEN kept"; fi
allow="127.0.0.1/32,::1"
if [ -n "${ALLOW_IPS:-}" ]; then allow="$allow,$ALLOW_IPS"
else
  prev="$(envget MEDIACTL_ALLOW)"
  if printf '%s' "$prev" | grep -q VPS_PUBLIC_IP || [ -z "$prev" ]; then warn "ALLOW_IPS not given: only loopback may call it until you re-run with ALLOW_IPS=<vps-ip>/32"
  else allow="$prev"; fi
fi
envset MEDIACTL_ALLOW "$allow"
envset MEDIACTL_LISTEN "0.0.0.0:$PORT"
envset MEDIACTL_ENCODER "$ENCODER"
ok "listen :$PORT, allow $allow"

if [ "$TLS" != 0 ]; then
  say "TLS"
  if [ ! -s "$ETC/tls.crt" ] || [ ! -s "$ETC/tls.key" ]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -subj "/CN=patv-mediactl" \
      -keyout "$ETC/tls.key" -out "$ETC/tls.crt" 2>/dev/null
    ok "made a self-signed certificate"
  fi
  chown root:mediactl "$ETC/tls.key" "$ETC/tls.crt"; chmod 0640 "$ETC/tls.key"; chmod 0644 "$ETC/tls.crt"
  envset MEDIACTL_TLS_CERT "$ETC/tls.crt"
  envset MEDIACTL_TLS_KEY "$ETC/tls.key"
  FP="$(openssl x509 -noout -fingerprint -sha256 -in "$ETC/tls.crt" | sed 's/.*=//')"
else
  envset MEDIACTL_TLS_CERT ""
  envset MEDIACTL_TLS_KEY ""
  FP=""
fi

say "systemd"
install -m 0644 "$HERE/mediactl.service" "$UNIT"
systemctl daemon-reload
systemctl enable mediactl >/dev/null 2>&1
systemctl restart mediactl
sleep 2
systemctl is-active --quiet mediactl || { journalctl -u mediactl -n 20 --no-pager >&2; die "mediactl did not start"; }
ok "mediactl active"

say "Health"
SCHEME=http; [ "$TLS" != 0 ] && SCHEME=https
H="$(node -e '
  const u = process.argv[1]; const m = require(u.startsWith("https") ? "https" : "http");
  m.get(u, { rejectUnauthorized: false, timeout: 5000 }, (r) => { let b = ""; r.on("data", (d) => b += d); r.on("end", () => console.log(b)); })
   .on("error", (e) => console.log("ERR " + e.message));' "$SCHEME://127.0.0.1:$PORT/health")"
echo "   $H"
printf '%s' "$H" | grep -q '"ok":true' || die "health check failed"
printf '%s' "$H" | grep -q '"plex":true' || warn "PLEX_TOKEN missing - search/play will fail"

say "Done. Put these in the PATV site's .env (prod: /home/PATV/.env, staging: /home/PATV-staging/.env), then restart it:"
echo "   MEDIACTL_URL=$SCHEME://<this box's public address or Tailscale IP>:$PORT"
echo "   MEDIACTL_SECRET=<the value of: grep ^MEDIACTL_SECRET= $ENVF>"
[ -n "$FP" ] && echo "   MEDIACTL_TLS_SHA256=$FP"
echo "Emergency stop of every library stream:  systemctl stop mediactl"
