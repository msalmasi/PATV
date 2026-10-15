#!/usr/bin/env bash
# deploy/webrtc/pepe-relay-watchdog.sh - PATV 1.99aai: keeps Pepe's main-stream HLS from silently breaking for hours.
#
# Why: on 2026-10-14 the WHIP relay (pepe-relay.sh: MediaMTX path "pepe" -> RTSP -> ffmpeg -> rtmp live/broadcast) kept
# running but its audio and video timestamps drifted apart after an RTP loss burst (14:56 EDT, ~1 s per second, 8 h by
# 23:00). nginx-rtmp then cut an HLS fragment at EVERY packet ("hls: force fragment split", 1.65M log lines),
# broadcast.m3u8 became 0.000/0.021 s segments each behind an EXT-X-DISCONTINUITY, and every player (prod + staging,
# both play publicaccess.tv/hls/broadcast.m3u8) failed with MEDIA_ERR_DECODE. Restarting that one ffmpeg fixed it.
#
# What: run every 20 s by pepe-relay-watchdog.timer (root). Only while the relay ffmpeg is running and has been up for
# MIN_UP s, it looks at
#   * nginx's error log: "force fragment split" lines in the last WINDOW s (more than SPLIT_MAX = bad)
#   * the HLS playlist: missing / not rewritten for STALE_S s (bad), or with >= 4 segments, 80 % of them shorter than
#     MIN_SEG s or a DISCONTINUITY in front of (almost) every one (bad)
# STRIKES bad checks in a row -> SIGINT that ffmpeg (SIGTERM after 8 s); MediaMTX restarts it at once
# (runOnAvailableRestart: yes). OBS, the WHIP session and MediaMTX itself are never touched. Restarts back off
# (BACKOFF_MIN doubling to BACKOFF_MAX, reset after CALM_S without one). Every restart, and the first healthy check
# after it, is a log line (journalctl -u pepe-relay-watchdog) and an ops alert: POST /api/ops/alert on the prod site
# (loopback + the site's bot token, read from its .env, sent on stdin - never in argv or the log) -> every site admin's
# inbox + Telegram (alerts outbox). The Twitch restream (patv-restream) restarts its own ffmpeg when the source's
# timestamps jump back (1.99gp), which a relay restart causes - nothing to do for it here.
#
# Settings (all optional) in /etc/default/pepe-relay-watchdog:
#   HLS=/mnt/hls/broadcast.m3u8  NGINX_ERR=/var/log/nginx/error.log  WINDOW=30  SPLIT_MAX=40  MIN_SEG=0.5  STALE_S=45
#   MIN_UP=60  STRIKES=2  BACKOFF_MIN=60  BACKOFF_MAX=1800  CALM_S=1800  SITE=http://127.0.0.1:3000
#   SITE_ENV=/home/PATV/.env  STATE=/var/lib/patv-webrtc/relay-watchdog.state  DRY_RUN=0 (1 = log what it would do)
# Tests (test/relay-watchdog.test.js) also set WD_PID / WD_UP / WD_NOW / WD_KILL / WD_ALERT to stub the process side.
set -u
[ -r /etc/default/pepe-relay-watchdog ] && . /etc/default/pepe-relay-watchdog
HLS="${HLS:-/mnt/hls/broadcast.m3u8}"
NGINX_ERR="${NGINX_ERR:-/var/log/nginx/error.log}"
WINDOW="${WINDOW:-30}"; SPLIT_MAX="${SPLIT_MAX:-40}"; MIN_SEG="${MIN_SEG:-0.5}"; STALE_S="${STALE_S:-45}"
MIN_UP="${MIN_UP:-60}"; STRIKES="${STRIKES:-2}"
BACKOFF_MIN="${BACKOFF_MIN:-60}"; BACKOFF_MAX="${BACKOFF_MAX:-1800}"; CALM_S="${CALM_S:-1800}"
SITE="${SITE:-http://127.0.0.1:3000}"; SITE_ENV="${SITE_ENV:-/home/PATV/.env}"
STATE="${STATE:-/var/lib/patv-webrtc/relay-watchdog.state}"
DRY_RUN="${DRY_RUN:-0}"
NOW="${WD_NOW:-$(date +%s)}"

log() { echo "pepe-relay-watchdog: $*"; }

# ── state ──
strikes=0; last_restart=0; backoff="$BACKOFF_MIN"; restarts=0; healing=0; why_last=""
if [ -r "$STATE" ]; then
  while IFS='=' read -r k v; do
    case "$k" in
      strikes|last_restart|backoff|restarts|healing) [[ "$v" =~ ^[0-9]+$ ]] && printf -v "$k" '%s' "$v" ;;
    esac
  done < "$STATE"
fi
save() {
  mkdir -p "$(dirname "$STATE")" 2>/dev/null
  printf 'strikes=%s\nlast_restart=%s\nbackoff=%s\nrestarts=%s\nhealing=%s\n' \
    "$strikes" "$last_restart" "$backoff" "$restarts" "$healing" > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
}

# ── the alert (best effort; never fails the run) ──
alert() {   # alert <ref> <title> <body>
  if [ -n "${WD_ALERT:-}" ]; then printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$WD_ALERT"; return 0; fi
  [ "$DRY_RUN" = 1 ] && { log "(dry run) alert: $2"; return 0; }
  local tok
  tok="$(sed -n 's/^TWITCH_BOT_TOKEN=//p' "$SITE_ENV" 2>/dev/null | head -1 | tr -d '\r' | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
  [ -n "$tok" ] || { log "alert not sent: no bot token in $SITE_ENV"; return 0; }
  local out
  out="$(TOK="$tok" REF="$1" TITLE="$2" BODY="$3" python3 -c 'import json,os; print(json.dumps({"password": os.environ["TOK"], "source": "pepe-relay", "ref": os.environ["REF"], "title": os.environ["TITLE"], "body": os.environ["BODY"]}))' \
        | curl -s -m 10 -H 'Content-Type: application/json' --data-binary @- "$SITE/api/ops/alert" 2>&1)"
  case "$out" in *'"ok":true'*) log "alert sent ($1)" ;; *) log "alert failed ($1): $(echo "$out" | head -c 200)" ;; esac
}

# ── the relay ffmpeg ──
if [ -n "${WD_PID+x}" ]; then pid="$WD_PID"
else pid="$(pgrep -o -f '^ffmpeg .*-i rtsp://127\.0\.0\.1:[0-9]+/pepe( |$)' 2>/dev/null || true)"; fi
if [ -z "$pid" ]; then
  [ "$strikes" != 0 ] && { strikes=0; save; }
  exit 0                                    # Pepe isn't streaming over WHIP right now - nothing to look after
fi
up="${WD_UP:-$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')}"
up="${up:-0}"
if [ "$up" -lt "$MIN_UP" ]; then exit 0; fi   # (re)started a moment ago - let it settle

# ── the checks ──
bad=()
cut="$(date -d "@$((NOW - WINDOW))" '+%Y/%m/%d %H:%M:%S' 2>/dev/null)"
if [ -r "$NGINX_ERR" ] && [ -n "$cut" ]; then
  splits="$(tail -n 20000 "$NGINX_ERR" | awk -v c="$cut" 'index($0, "force fragment split") && substr($0, 1, 19) >= c { n++ } END { print n + 0 }')"
  [ "$splits" -gt "$SPLIT_MAX" ] && bad+=("nginx-rtmp forced $splits HLS fragment splits in ${WINDOW} s")
fi
if [ ! -f "$HLS" ]; then
  bad+=("no HLS playlist ($HLS)")
else
  mt="$(stat -c %Y "$HLS" 2>/dev/null || echo 0)"
  age=$((NOW - mt))
  if [ "$age" -gt "$STALE_S" ]; then
    bad+=("HLS playlist not updated for ${age} s")
  else
    read -r n short disc < <(awk -v m="$MIN_SEG" '
      /^#EXTINF:/ { d = substr($0, 9); sub(/,.*/, "", d); n++; if (d + 0 < m) s++ }
      /^#EXT-X-DISCONTINUITY/ { x++ }
      END { print n + 0, s + 0, x + 0 }' "$HLS")
    if [ "$n" -ge 4 ]; then
      [ $((short * 10)) -ge $((n * 8)) ] && bad+=("$short of $n HLS segments shorter than ${MIN_SEG} s")
      [ "$disc" -ge $((n - 1)) ] && bad+=("$disc DISCONTINUITY marks in $n HLS segments")
    fi
  fi
fi

# ── healthy ──
if [ "${#bad[@]}" -eq 0 ]; then
  if [ "$healing" = 1 ]; then
    log "relay healthy again (pid $pid, up ${up} s)"
    alert "ok-$last_restart" "Pepe's stream relay is healthy again" "The HLS relay restarted by the watchdog is producing normal segments again (pid $pid)."
    healing=0
  fi
  strikes=0
  if [ "$last_restart" -gt 0 ] && [ $((NOW - last_restart)) -ge "$CALM_S" ]; then backoff="$BACKOFF_MIN"; fi
  save; exit 0
fi

# ── bad ──
why="$(printf '%s; ' "${bad[@]}")"; why="${why%; }"
strikes=$((strikes + 1))
log "bad check $strikes/$STRIKES (pid $pid, up ${up} s): $why"
if [ "$strikes" -lt "$STRIKES" ]; then save; exit 0; fi
wait_left=$(( last_restart + backoff - NOW ))
if [ "$last_restart" -gt 0 ] && [ "$wait_left" -gt 0 ]; then
  log "restart held by backoff (${backoff} s) - next one possible in ${wait_left} s"
  save; exit 0
fi
if [ "$DRY_RUN" = 1 ]; then log "(dry run) would restart relay pid $pid"; save; exit 0; fi

log "restarting the relay ffmpeg (pid $pid): $why"
if [ -n "${WD_KILL:-}" ]; then echo "$pid" >> "$WD_KILL"
else
  kill -INT "$pid" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && { log "pid $pid ignored SIGINT - SIGTERM"; kill -TERM "$pid" 2>/dev/null; }
fi
restarts=$((restarts + 1))
[ "$last_restart" -gt 0 ] && backoff=$(( backoff * 2 > BACKOFF_MAX ? BACKOFF_MAX : backoff * 2 ))
last_restart="$NOW"; strikes=0; healing=1
save
alert "restart-$NOW" "Pepe's stream relay restarted by the watchdog" \
  "The HLS of Pepe's main stream went bad ($why), so the watchdog restarted the WHIP->RTMP relay ffmpeg (pid $pid; restart #$restarts since the watchdog started, next one allowed after ${backoff} s). MediaMTX starts a fresh relay at once; the Twitch restream reconnects by itself. If this repeats, check OBS / the WHIP session (journalctl -u mediamtx)."
exit 0
