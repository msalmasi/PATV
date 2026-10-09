#!/usr/bin/env bash
# deploy/restream/install.sh - PATV 1.99fk: the "Also stream to Twitch" relay worker on the VPS.
# Run as root on patv-vps, from a checkout that has this folder:
#     INST=staging bash /home/PATV-staging/deploy/restream/install.sh     (staging: loopback test targets only)
#     INST=prod    bash /home/PATV/deploy/restream/install.sh             (prod: Twitch targets only)
#     INST=prod UNINSTALL=1 bash .../install.sh                           (stop + disable the worker; keeps the secrets)
# What it does (idempotent - every step checks first; a re-run only changes what differs; never prints a secret):
#   1. backs up the site's .env and any existing worker files to /root/patv-restream-backups/<time>/
#   2. adds RESTREAM_SECRET (stream-key encryption) and RESTREAM_TOKEN (worker <-> site) to the site's .env when
#      missing (openssl rand, 0600 stays), staging also RESTREAM_ALLOW_LOOPBACK=1 (its test sink)
#   3. system user patv-restream; /usr/local/lib/patv-restream/patv-restream.js; /etc/patv-restream/<inst>.env
#      (root:patv-restream 0640: SITE_URL, RESTREAM_TOKEN copied from the .env, ALLOW_TARGETS)
#   4. systemd patv-restream@<inst>: enabled + (re)started when anything changed
#   5. restarts the site's pm2 app ONLY when its .env gained a variable and the site already has restream.js
#      (otherwise the next deploy picks the variables up)
#   6. health: the worker is active and has synced with the site (or says why not)
# Emergency stop:  systemctl stop patv-restream@<inst>
set -Eeuo pipefail
trap 'printf "\n   FAIL install.sh line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
umask 022

INST="${INST:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
BK="/root/patv-restream-backups/$TS"
LIB=/usr/local/lib/patv-restream
ETC=/etc/patv-restream
UNIT=/etc/systemd/system/patv-restream@.service
USER_=patv-restream

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   ok    %s\n' "$*"; }
warn() { printf '   WARN  %s\n' "$*" >&2; }
die()  { printf '   FAIL  %s\n' "$*" >&2; exit 1; }
pm2_do() {   # pm2 lives in root's nvm (as in deploy/patv-update.sh)
  ( trap - ERR; set +eu
    export HOME=/root PM2_HOME=/root/.pm2 NVM_DIR=/root/.nvm
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use --silent 20 >/dev/null 2>&1; pm2 "$@" )
}
envget() { sed -n "s/^$1=//p" "$2" | tail -1; }       # value of KEY in an env file (never echoed by callers)
envhas() { grep -qE "^$1=.+" "$2"; }

case "$INST" in
  prod)    SITE_DIR=/home/PATV;         SITE_URL=http://127.0.0.1:3000; PM2_APP=index;        ALLOW=twitch ;;
  staging) SITE_DIR=/home/PATV-staging; SITE_URL=http://127.0.0.1:3100; PM2_APP=patv-staging; ALLOW=loopback ;;
  *) die "set INST=staging or INST=prod" ;;
esac
SVC="patv-restream@$INST"
ENVF="$SITE_DIR/.env"

say "Preflight ($INST)"
[ "$(id -u)" = 0 ] || die "run as root"
for c in node ffmpeg openssl systemctl install useradd getent curl; do command -v "$c" >/dev/null || die "missing command: $c"; done
[ -x /usr/bin/node ] || die "/usr/bin/node missing (the unit runs it)"
NODE_MAJOR="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 16 ] || die "/usr/bin/node is v$NODE_MAJOR - needs 16+"
FF_FMT="$(ffmpeg -hide_banner -formats 2>/dev/null || true)"
FF_PROTO="$(ffmpeg -hide_banner -protocols 2>/dev/null || true)"
grep -qE '^ [D ]E flv ' <<<"$FF_FMT" || die "ffmpeg can't write flv"
grep -qE '^ +rtmp$' <<<"$FF_PROTO" || die "ffmpeg has no rtmp protocol"
[ -f "$ENVF" ] || die "$ENVF missing"
for f in patv-restream.js patv-restream@.service; do [ -f "$HERE/$f" ] || die "template missing: $HERE/$f"; done
/usr/bin/node --check "$HERE/patv-restream.js" || die "patv-restream.js doesn't parse"
ok "node v$(/usr/bin/node -v | tr -d v), ffmpeg $(ffmpeg -hide_banner -version | awk 'NR == 1 { print $3 }') (rtmp + flv), site $SITE_DIR"

if [ "${UNINSTALL:-0}" = 1 ]; then
  say "Uninstall $SVC"
  systemctl disable --now "$SVC" 2>/dev/null || true
  ok "$SVC stopped + disabled (secrets, files and the unit template are kept; re-run without UNINSTALL to bring it back)"
  exit 0
fi

say "Backups -> $BK"
install -d -m 0700 "$BK"
install -m 0600 "$ENVF" "$BK/$INST.env"
[ -f "$ETC/$INST.env" ] && install -m 0600 "$ETC/$INST.env" "$BK/worker-$INST.env"
[ -f "$LIB/patv-restream.js" ] && install -m 0600 "$LIB/patv-restream.js" "$BK/patv-restream.js"
[ -f "$UNIT" ] && install -m 0600 "$UNIT" "$BK/patv-restream@.service"
ok "site .env + any existing worker files"

say "Secrets in $ENVF"
ENV_CHANGED=0
addenv() {   # addenv KEY VALUE - appends when missing; never prints VALUE
  if envhas "$1" "$ENVF"; then ok "$1 already set"; return 0; fi
  [ -n "$(tail -c1 "$ENVF")" ] && echo >> "$ENVF"
  printf '%s=%s\n' "$1" "$2" >> "$ENVF"
  ENV_CHANGED=1
  ok "$1 added"
}
addenv RESTREAM_SECRET "$(openssl rand -hex 32)"
addenv RESTREAM_TOKEN "$(openssl rand -hex 24)"
if [ "$INST" = staging ]; then addenv RESTREAM_ALLOW_LOOPBACK 1; fi
TOKEN="$(envget RESTREAM_TOKEN "$ENVF")"
[ "${#TOKEN}" -ge 16 ] || die "RESTREAM_TOKEN in $ENVF is too short"

say "Worker"
CHANGED=0
getent passwd "$USER_" >/dev/null || { useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$USER_"; ok "user $USER_ created"; CHANGED=1; }
install -d -m 0755 "$LIB"
install -d -m 0750 -o root -g "$USER_" "$ETC"
put() {   # put SRC DST MODE OWNER GROUP
  if [ -f "$2" ] && cmp -s "$1" "$2"; then chmod "$3" "$2"; chown "$4:$5" "$2"; ok "$2 unchanged"; return 0; fi
  install -m "$3" -o "$4" -g "$5" "$1" "$2"; CHANGED=1; ok "$2 installed"
}
put "$HERE/patv-restream.js" "$LIB/patv-restream.js" 0644 root root
put "$HERE/patv-restream@.service" "$UNIT" 0644 root root
TMPENV="$(mktemp)"; chmod 0600 "$TMPENV"
printf 'SITE_URL=%s\nRESTREAM_TOKEN=%s\nALLOW_TARGETS=%s\nFFMPEG=%s\n' "$SITE_URL" "$TOKEN" "$ALLOW" "$(command -v ffmpeg)" > "$TMPENV"
put "$TMPENV" "$ETC/$INST.env" 0640 root "$USER_"
rm -f "$TMPENV"; unset TOKEN
systemctl daemon-reload
systemctl enable "$SVC" >/dev/null 2>&1
if [ "$CHANGED" = 1 ] || ! systemctl is-active --quiet "$SVC"; then systemctl restart "$SVC"; ok "$SVC (re)started"; else ok "$SVC running, nothing changed"; fi

if [ "$ENV_CHANGED" = 1 ]; then
  if [ -f "$SITE_DIR/restream.js" ]; then
    say "Site restart (its .env gained variables)"
    pm2_do restart "$PM2_APP" >/dev/null
    for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$SITE_URL/healthz" || true)" = 200 ] && break; sleep 2; done
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$SITE_URL/healthz" || true)" = 200 ] || die "the site isn't healthy after the restart - check pm2 logs $PM2_APP"
    ok "$PM2_APP restarted, /healthz 200"
  else
    warn "the site has no restream.js yet - the next deploy restarts it with the new variables"
  fi
fi

say "Health"
sleep 8
systemctl is-active --quiet "$SVC" || die "$SVC isn't running: journalctl -u $SVC -n 50"
ok "$SVC active"
# the worker logs "site sync failed" once when it starts failing and "site reachable again" when it recovers
if journalctl -u "$SVC" -n 200 --no-pager -q -o cat | grep -E "site sync failed|site reachable again|^patv-restream " | tail -1 | grep -q "site sync failed"; then
  warn "the worker can't sync with the site yet (expected until the site with restream.js is deployed): journalctl -u $SVC -n 20"
else
  ok "worker syncing with $SITE_URL"
fi
# 1.99go: the worker publishes to the target itself - no relay ffmpeg may carry a target (and its key) in argv
ARGV_TARGETS=0
for p in $(pgrep -u "$USER_" -x ffmpeg || true); do
  tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null | tail -1 | grep -qx 'pipe:1' || ARGV_TARGETS=$((ARGV_TARGETS + 1))
done
if [ "$ARGV_TARGETS" -gt 0 ]; then warn "$ARGV_TARGETS relay ffmpeg(s) still have their target in argv (RELAY_MODE=argv, or the other instance still runs an old worker)"
else ok "no relay ffmpeg has a target URL / stream key in its arguments"; fi
printf '\nDone. Emergency stop: systemctl stop %s\n' "$SVC"
