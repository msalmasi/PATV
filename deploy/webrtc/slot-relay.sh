#!/usr/bin/env bash
# deploy/webrtc/slot-relay.sh - PATV 1.99abf: MediaMTX runs this (runOnReady, as the mediamtx user) while a stage slot's WHIP
# stream is up on its path (stage-<16 hex> on prod, stg-<16 hex> on staging). Like pepe-relay.sh it reads the stream back over
# loopback RTSP and pushes it into nginx-rtmp's HLS app under the SAME public name - H.264 copied as is (the site's browser
# publisher and OBS's WHIP output send H.264), Opus -> AAC - so the slot also gets /mnt/hls/<name>.m3u8: stage snaps + clips
# (stagecap.js cuts those segments), Pepe's OBS pulls it over RTMP for on-air picks. The WHIP / WHEP / MediaMTX-HLS playback
# is untouched. nginx-rtmp's on_publish asks the site, which accepts a loopback push of an OPEN slot's name only.
# No secret anywhere: the slot name is public (it is the HLS file name). MediaMTX stops it with SIGINT when the path goes
# away and restarts it if it dies (runOnReadyRestart).
#   RTMP_BASE  default rtmp://127.0.0.1  (loopback only)
set -u
NAME="${MTX_PATH:?MTX_PATH is set by MediaMTX}"
case "$NAME" in
  stage-*) APP=live ;;
  stg-*)   APP=live_staging ;;
  *) echo "slot-relay: not a slot path: $NAME" >&2; exit 1 ;;
esac
[[ "$NAME" =~ ^(stage|stg)-[0-9a-f]{16}$ ]] || { echo "slot-relay: bad slot name" >&2; exit 1; }
BASE="${RTMP_BASE:-rtmp://127.0.0.1}"
case "$BASE" in rtmp://127.0.0.1|rtmp://127.0.0.1:*|rtmp://localhost) ;; *) echo "slot-relay: RTMP_BASE must be loopback" >&2; exit 1 ;; esac
SRC="rtsp://127.0.0.1:${RTSP_PORT:-8554}/${NAME}"
echo "slot-relay: ${NAME} -> nginx-rtmp ${APP} (H.264 copy, Opus -> AAC)" >&2
exec ffmpeg -hide_banner -nostdin -loglevel error \
  -rtsp_transport tcp -analyzeduration 3000000 -probesize 2000000 -i "$SRC" \
  -map 0:v:0 -map '0:a:0?' -c:v copy -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -f flv "${BASE}/${APP}/${NAME}" \
  2> >(sed -u 's/^/slot-relay: /' >&2)
