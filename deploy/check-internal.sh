#!/usr/bin/env bash
# deploy/check-internal.sh - PATV 1.99acm: the chat hub seam's /internal/ routes must never answer through the public site.
#     bash /home/PATV/deploy/check-internal.sh
# Read-only. Asks this server's nginx (--resolve to 127.0.0.1, the way deploy/hls-auth/install.sh checks) for
# /internal/v1/snapshot/x on every public host, in the lower and a mixed case, and wants 404 from nginx for each one. Then
# asks the sites directly on loopback and wants their own 404 too (no inbound key, or the case guard in hubinbound.js).
# Exit 0 when every answer is 404, 1 otherwise (it prints which). Run it after adding the nginx rule (deploy/README.md,
# "The chat hub seam's /internal/ routes") and before setting HUB_V1_IN_KEY_ID / HUB_V1_IN_KEY on a site.
set -uo pipefail

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true; }
via()  { code --resolve "$1:443:127.0.0.1" "https://$1$2"; }   # through this nginx, not Cloudflare
fail=""
for host in publicaccess.tv www.publicaccess.tv staging.publicaccess.tv; do
  for p in /internal/v1/snapshot/x /Internal/V1/snapshot/x /internal/v1/outbox/rewind; do
    c="$(via "$host" "$p")"
    if [ "$c" = 404 ]; then printf '   ok    %s%s -> %s\n' "$host" "$p" "$c"; else printf '   FAIL  %s%s -> %s (want 404)\n' "$host" "$p" "$c"; fail="$fail $host$p=$c"; fi
  done
done
for port in 3000 3100; do
  c="$(code "http://127.0.0.1:$port/Internal/v1/snapshot/x")"
  if [ "$c" = 404 ]; then printf '   ok    :%s /Internal/v1/... -> %s\n' "$port" "$c"; else printf '   FAIL  :%s /Internal/v1/... -> %s (want 404)\n' "$port" "$c"; fail="$fail :$port=$c"; fi
done
if [ -n "$fail" ]; then echo "the public site still reaches /internal/:$fail - add the nginx rule (deploy/README.md)"; exit 1; fi
echo "/internal/ is closed on every public host"
