#!/usr/bin/env bash
# deploy/webrtc/pepe-relay.sh - PATV 1.99fd: MediaMTX runs this (runOnAvailable, as the mediamtx user) while Pepe's
# main stream is up on its WHIP path. It reads the stream back over loopback RTSP and pushes it into nginx-rtmp under
# his usual RTMP name - H.264 copied as is, Opus -> AAC (RTMP / nginx HLS can't carry Opus) - so /mnt/hls/broadcast.m3u8
# and everything that reads it (ON AIR, stage snaps + clips, the HLS player) work exactly as with OBS on RTMP.
# MediaMTX stops it with SIGINT when the path goes away and restarts it if it dies (runOnAvailableRestart).
#
# The RTMP target (it carries Pepe's RTMP key) is read from $PEPE_RELAY_CONF (default /etc/mediamtx/pepe-relay.conf,
# root:mediamtx 0640, written by install.sh) - never from MediaMTX's config, never printed: ffmpeg's messages are
# filtered so the URL can't reach the journal. Installed by install.sh to /usr/local/lib/patv-webrtc/pepe-relay.sh.
#   RTMP_TARGET=rtmp://127.0.0.1/<app>/<stream name>      (loopback only)
#   AUDIO_BITRATE=160k                                     (optional)
set -u
CONF="${PEPE_RELAY_CONF:-/etc/mediamtx/pepe-relay.conf}"
conf() { sed -n "s/^$1=//p" "$CONF" 2>/dev/null | head -1; }
TARGET="$(conf RTMP_TARGET)"
ABR="$(conf AUDIO_BITRATE)"
[ -n "$TARGET" ] || { echo "pepe-relay: no RTMP_TARGET in $CONF" >&2; exit 1; }
case "$TARGET" in
  rtmp://127.0.0.1/*|rtmp://127.0.0.1:*/*|rtmp://localhost/*) ;;
  *) echo "pepe-relay: RTMP_TARGET must be a loopback rtmp:// URL" >&2; exit 1 ;;
esac
case "${ABR:-160k}" in [0-9]*k) ;; *) ABR=160k ;; esac
SRC="rtsp://127.0.0.1:${RTSP_PORT:-8554}/${MTX_PATH:?MTX_PATH is set by MediaMTX}"
echo "pepe-relay: ${MTX_PATH} -> nginx-rtmp (H.264 copy, Opus -> AAC ${ABR:-160k})" >&2
# exec: MediaMTX's SIGINT goes straight to ffmpeg (clean RTMP close). stderr goes through a filter that blanks the
# target (read from the environment, not an argument), so a connect error can't print the key.
export PEPE_RELAY_TARGET="$TARGET"
exec ffmpeg -hide_banner -nostdin -loglevel error \
  -rtsp_transport tcp -analyzeduration 3000000 -probesize 2000000 -i "$SRC" \
  -map 0:v:0 -map '0:a:0?' -c:v copy -c:a aac -b:a "${ABR:-160k}" -ar 48000 -ac 2 \
  -f flv "$TARGET" \
  2> >(awk 'BEGIN { t = ENVIRON["PEPE_RELAY_TARGET"] }
            { if (t != "") while ((i = index($0, t)) > 0) $0 = substr($0, 1, i - 1) "<rtmp-target>" substr($0, i + length(t))
              print "pepe-relay: " $0; fflush() }' >&2)
