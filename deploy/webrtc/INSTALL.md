# WebRTC on the stages: MediaMTX + coturn (PATV 1.99et)

Ultra-low-latency streaming for the stage slots. It has three parts:

- **WHIP ingest.** OBS 30+ (the "WHIP" service) or the Go live page streams over WebRTC.
- **WHEP playback.** Viewers press **⚡ Low latency** and watch about a second behind.
- **TURN.** coturn relays viewers whose networks block direct WebRTC.

The site side is `webrtc.js` plus `mainstage.publishGate`. Everything is behind the stage setting
**`webrtc_enabled`** in `/stage/admin`, labelled "⚡ WebRTC ultra-low latency". It is **off by default**.
While it's off nothing changes for anyone, even with these servers installed.

This folder holds templates only. It contains no secrets.

| File | Installed to |
|------|--------------|
| `mediamtx.yml` | `/etc/mediamtx/mediamtx.yml` (root:mediamtx 0640; `@PUBLIC_IP@`, `@AUTH_URL@` filled) |
| `mediamtx.service` | `/etc/systemd/system/mediamtx.service` (runs `/usr/local/bin/mediamtx` → `/opt/mediamtx/v1.21.1/`) |
| `turnserver.conf` | `/etc/patv-turn/turnserver.conf` (root:turnserver 0640; IP, host and secret filled) |
| `patv-turn.service` | `/etc/systemd/system/patv-turn.service`. The package's own `coturn.service` stays **masked**. |
| `nginx-stream.publicaccess.tv.conf` | `/etc/nginx/sites-available/stream.publicaccess.tv`, symlinked into `sites-enabled` |
| `certbot-deploy-hook.sh` | `/etc/letsencrypt/renewal-hooks/deploy/patv-webrtc.sh` (copies the cert for coturn on renewal) |
| `install.sh` / `rollback.sh` | run from the checkout |

## How it fits together

```
OBS / browser --WHIP (HTTPS)--> nginx stream.publicaccess.tv/whip/<stream> --> MediaMTX 127.0.0.1:8889
                                   MediaMTX --POST /api/stage/whip-auth--> site (same gate as RTMP on_publish)
              --ICE (media)----> UDP 8189 / TCP 8189 on the public IP (TURN 3478/5349 when direct fails)
viewer -------WHEP-------------> nginx /whep/<stream> --> MediaMTX            (⚡ Low latency)
       -------HLS--------------> nginx /<stream>/index.m3u8 --> MediaMTX :8888 (default + fallback)
site   -------every 5 s--------> MediaMTX API 127.0.0.1:9997 /v3/paths/list  (live = a ready path)
```

- **Streams.** `<stream>` is a slot's public stream name: `stage-<16 hex>` on prod, `stg-<16 hex>` on staging.
  MediaMTX only accepts those path names.
- **Publish auth.**
  - The OBS bearer token is the slot's stream key, the same key as for RTMP.
  - The browser gets a 10-minute token from `POST /api/stage/slots/:id/whip` and never sees the key.
  - The key is checked by `mainstage.publishGate`, the same function nginx-rtmp's `on_publish` uses, so
    permissions are identical.
- **Reads.** Reads (WHEP and HLS) are public for any open slot.
- **Two sites, one auth hook.** One MediaMTX serves both sites but has one auth hook. The site it calls
  forwards the other site's prefix to its peer (`WHIP_AUTH_PEER` in each `.env`). Until the promote, the
  hook points at **staging** (:3100).
- **Live detection.** A ready MediaMTX path with an open slot counts as live. It is that slot's
  heartbeat, like `on_update` for RTMP, so billing, idle and ending all work unchanged. A ready path whose
  slot ended or was cut is kicked.
- **Pepe's stream and RTMP slots are untouched.** They stay on nginx-rtmp's `/mnt/hls`. RTMP streams get
  no ⚡ because MediaMTX can't turn AAC into Opus. Snaps and clips aren't offered on WHIP slots.
- **Capacity.**
  - The relay range 49160–49200 is 41 ports, so roughly 40 relayed sessions at once. Most viewers
    connect directly.
  - MediaMTX `maxReaders` is 150 WHEP viewers per stream.

## What the VPS already looks like (checked read-only, 2026-10-07)

- **System.** Ubuntu 20.04.3, nginx 1.18 with nginx-rtmp, certbot 5.8, systemd 245, x86_64.
- **Firewall.** There is no host firewall: `ufw` is inactive, iptables `INPUT` policy is ACCEPT with no
  rules, and only Docker chains exist. `install.sh` detects this and opens nothing on the box. If
  ufw or DROP rules ever appear, it opens the ports there and `rollback.sh` closes them again.
- **DNS.** `stream.publicaccess.tv` points straight at the VPS. It is DNS-only, not proxied by Cloudflare, which
  WebRTC needs. Nothing served it on 443 yet, and there was **no certificate** for it. `install.sh`
  issues one with `certbot certonly --webroot -w /var/www/html`, through the default port-80 server. No
  nginx change is needed for that.
- **Docker bridges.** 172.17/172.18 exist. MediaMTX only advertises the public IP, and coturn listens and
  relays only on it. coturn refuses private, loopback and link-local peers.
- **Sites and pm2.**
  - The sites run under pm2 via root's nvm: `index` = prod (:3000) and `patv-staging` = staging (:3100).
  - Health is `/healthz`.
  - nginx-rtmp `live` and `stage` call :3000/`api/stage/rtmp`; `stage_staging` and `live_staging` call :3100.

## Install (staging first)

These are the exact commands. Run them as root on patv-vps **after** staging has deployed the 1.99et site
(`git -C /home/PATV-staging log -1 --oneline` shows it).

```bash
# 1. the servers: backs up /etc/nginx + firewall + both .env, installs, health-checks (~1-2 min)
bash /home/PATV-staging/deploy/webrtc/install.sh

# 2. turn it on for STAGING only: https://staging.publicaccess.tv/stage/admin
#    -> tick "⚡ WebRTC ultra-low latency" -> Save settings
```

`install.sh` stops at the first error. It is idempotent: a re-run only changes what differs, and it
restarts a service only when that service's binary, unit or config changed. It does this, in order:

1. **Preflight.** Checks that it runs as root, that `stream.publicaccess.tv` resolves to this box, and
   that nothing else holds ports 8189, 3478, 5349, 8888, 8889 or 9997. It also notes whether Pepe's
   `/mnt/hls/broadcast.m3u8` is fresh.
2. **Backups** go to `/root/patv-webrtc-backups/<time>/` (root only):
   - `etc-nginx.tgz`
   - `iptables.rules`, `ip6tables.rules` and `ufw-status.txt`
   - `prod.env` and `staging.env`
3. **MediaMTX v1.21.1.** Downloads the release from GitHub and checks it against the **pinned sha256**
   (`653abc67…b0ee`, from the release's `checksums.sha256`). It installs into
   `/opt/mediamtx/v1.21.1/` and adds the system user `mediamtx`.
4. **coturn.** Masks `coturn.service` and blocks service starts during the install, so the package never
   runs with its default config. Then it runs `apt-get install coturn` (4.5.1).
5. **TURN secret.**
   - Runs `openssl rand -hex 32` into `/etc/patv-webrtc/turn_secret` (root 0600).
   - Appends `TURN_SECRET=` and `WHIP_AUTH_PEER=` to `/home/PATV/.env` and `/home/PATV-staging/.env`,
     with a `# patv-webrtc` marker line.
   - The secret is never echoed and never appears on a command line.
   - Staging is restarted with `pm2 restart patv-staging` to read its `.env`. **Prod is not restarted.**
     It reads its `.env` at its next deploy.
6. **Certificate.** Issues the cert for `stream.publicaccess.tv` and installs the renewal hook, which
   copies it to `/etc/patv-turn/certs` for turnserver.
7. **Configs and units.** Renders and installs them. Any differing old copy goes into the backup folder.
8. **nginx.** Adds its own site file plus a symlink, then runs **`nginx -t`, then `systemctl reload nginx`**.
   It never restarts nginx. If `nginx -t` fails, the symlink is removed again and nginx is not reloaded.
9. **Firewall.** Opens udp 8189, 3478, 5349 and 49160–49200, and tcp 8189, 3478 and 5349, **only if** a
   host firewall is active. Today none is, so it opens nothing.
10. **Services.** Runs `systemctl enable` on `mediamtx` and `patv-turn`, then starts or restarts them.
11. **Health checks.** The run fails if any of these fail:
    - Pepe's RTMP ingest still updates `/mnt/hls`.
    - Prod and staging return 200, both direct and through nginx.
    - The MediaMTX API is up.
    - The site answers the auth hook.
    - WHIP through nginx reaches MediaMTX.
    - The 8189, 3478 and 5349 listeners are up.
    - `turnutils_stunclient` works.
    - TURNS on 5349 serves a valid cert.
    - `turnutils_uclient` gets a TURN allocation and relays with REST credentials.

### Smoke tests (staging, flag on)

1. **TURN credentials.**
   - Signed out, `curl -s https://staging.publicaccess.tv/api/turn` returns `iceServers` with **STUN only**.
   - Signed in, in the browser, `/api/turn` shows `turn:` udp, `turn:` tcp and `turns:…:5349` with a
     username `<expiry>:<userId>` about 1 hour ahead.
2. **Browser go-live.** On `/stage`, book a slot on a test pad, open the **⚡ Browser · ultra-low
   latency** tab, press Preview and pick a camera and mic, then press **⚡ Go live**. Expect:
   - The slot turns LIVE within about 5 seconds.
   - The pad page shows the stream, with the **⚡ Low latency** button on the player.
3. **⚡ on.** Press ⚡ on the pad page. The video should run about 1 s behind, against 3–6 s on the
   normal stream. Reload the page: ⚡ is still on, because the choice is remembered.
4. **Fallback.**
   - Turn ⚡ on, then block UDP 8189 or use a network that blocks WebRTC. The player is back on HLS
     within about 8 s, never black, and the ⚡ title says it's unavailable.
   - Stop MediaMTX briefly with `systemctl stop mediamtx` and confirm the same, then
     `systemctl start mediamtx`.
5. **OBS 30+.** Set Settings → Stream → Service **WHIP**, with the Server from the OBS tab
   (`https://stream.publicaccess.tv/whip/stg-…`) and the Bearer Token set to the stream key. It goes live
   the same way.
6. **Cut or end.** End the slot. MediaMTX drops the publisher within about 5 s
   (`journalctl -u mediamtx` shows the kick), and the old key or token is refused.
7. **Untouched.**
   - Pepe's stream is still ON AIR on the homepage, and `/mnt/hls/broadcast.m3u8` is fresh.
   - An RTMP slot still works, with no ⚡ on it.
   - `journalctl -u mediamtx -u patv-turn` shows no errors.
8. **TURN relay.**
   - In <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>, add
     `turn:stream.publicaccess.tv:3478` with the username and credential from a signed-in `/api/turn`.
     "Gather candidates" shows `relay` candidates.
   - `turns:…:5349` works the same way.

## Promote to prod

1. **Ship the site.** Run `git fetch origin && git push origin origin/staging:main`. Wait for the prod
   deploy, which restarts `index`, so prod now reads `TURN_SECRET` and `WHIP_AUTH_PEER` from its `.env`.
   Check `/healthz` returns 200.
2. **Point MediaMTX's auth hook at prod.** This re-renders `mediamtx.yml` with :3000. MediaMTX
   hot-reloads it, and the restart only happens because the config changed. Staging keeps working
   through `WHIP_AUTH_PEER`.
   ```bash
   AUTH_SITE=prod bash /home/PATV/deploy/webrtc/install.sh
   ```
3. **Flip `webrtc_enabled` for prod.** On https://publicaccess.tv/stage/admin, tick
   "⚡ WebRTC ultra-low latency", then Save settings.
4. **Smoke tests on prod.** Run steps 1–3 and 6–7 above on publicaccess.tv. Use a `stage-…` path, and
   check Pepe's stream and an RTMP slot again.
5. **If anything is off,** untick the flag in `/stage/admin`. That turns WebRTC off for everyone at once,
   and the servers can stay.

## Pepe's main stream over WHIP (1.99fd)

Pepe's OBS can publish his main stream over WHIP (H.264 + Opus) instead of RTMP, so viewers get ⚡ on his
stage too. Everything that reads `/mnt/hls` keeps working, because MediaMTX hands the stream straight back
to nginx-rtmp:

```
OBS (profile "PepeWHIP": WHIP, Opus) --WHIP--> MediaMTX path "pepe" --WHEP--> ⚡ viewers
                                                 | runOnAvailable: pepe-relay.sh (as mediamtx)
                                                 |   ffmpeg: RTSP 127.0.0.1:8554 in, H.264 copy, Opus -> AAC
                                                 v
                                   nginx-rtmp live/<his RTMP name> (on_publish: his key, as today)
                                                 v
                                   /mnt/hls/broadcast.m3u8 -> ON AIR, snaps, clips, the HLS player
```

- **Auth.** The hook allows `pepe` publishes over WHIP with Pepe's bearer only. The bearer is an HMAC of
  the prod site's `SECRET_KEY`, so there is nothing new to store. Rotate it with `PEPE_WHIP_KEY_VERSION`
  in the prod `.env`, or set that to `off` to refuse it. The relay's loopback RTSP read is always allowed.
  The same read from anywhere else is refused, and WHEP/HLS reads of `pepe` need `webrtc_enabled`.
  Pepe's publish doesn't need the flag, because it is his main stream.
- **Site.** The 5-second MediaMTX sync notes that `pepe` is up, and never treats it as a slot.
  `/api/stage` then carries `whep`, and the stage player shows ⚡ for his stream. The bot fetches the
  bearer with its token: `POST /api/stage/pepe-whip`.
- **OBS (`camfrog-bot/obs_control.py`).** It uses two profiles. The RTMP one stays untouched as the
  fallback. The "PepeWHIP" copy has the WHIP service and the Opus stream audio encoder. Switching stops
  the stream and the virtual camera for about 10 s, because OBS only rebuilds the audio encoder when no
  output is active.
- **Fallbacks.** If WHIP won't go live, or the site's HLS stays off air, for 3 watchdog passes, the
  watchdog switches back to RTMP by itself and posts one admin notice. The setting is
  `obs_whip_fallback`. To switch by hand, use `!stream via rtmp` / `!stream via whip`, or
  `python obs_control.py via rtmp|whip` on the VM.

**Cut-over (prod), in order.**

1. **Ship the site (1.99fd) to prod and check it.** Promote staging. Then confirm that
   `curl -s -X POST -H 'Content-Type: application/json' -d '{"action":"read","protocol":"rtsp","path":"pepe","ip":"127.0.0.1"}' http://127.0.0.1:3000/api/stage/whip-auth -o /dev/null -w '%{http_code}'`
   returns `200`.
2. **Install the MediaMTX side.** Run `AUTH_SITE=prod bash /home/PATV/deploy/webrtc/install.sh`. It
   restarts MediaMTX, so live WHIP slots and WHEP viewers reconnect after a few seconds. It doesn't touch
   nginx-rtmp, and Pepe stays on RTMP. It writes `/etc/mediamtx/pepe-relay.conf` once, and checks that
   RTSP is on loopback only and that the hook knows `pepe`.
3. **Switch OBS, on pepe-prod.**
   1. First check that no extra OBS output (Aitum Multistream / multi-RTMP Twitch target) *shares* the
      main stream's audio encoder.
   2. Then run `python C:\PATV\camfrog-bot\obs_control.py setup-whip`. It backs up every profile to
      `C:\PATV\obs-backups\obs-profiles-<ts>.zip`, clones the RTMP profile to "PepeWHIP", and fetches the
      bearer. It then closes OBS cleanly and relaunches it once, because OBS only reads its profile list
      at start, then switches and goes live.
4. **Verify.** Check that:
   - `/mnt/hls/broadcast.m3u8` keeps updating;
   - the journal shows `journalctl -u mediamtx | grep pepe-relay`;
   - the ⚡ button shows on Pepe's stage;
   - a stage snap and a clip of "pepe" work.

**Rollback, one command.** Use `!stream via rtmp` in Camfrog, or
`python C:\PATV\camfrog-bot\obs_control.py via rtmp` on pepe-prod. Nothing on the VPS needs to change,
because the `pepe` path just goes idle. `rollback.sh` refuses to run while Pepe is on WHIP.

## Roll back

```bash
# first untick "⚡ WebRTC ultra-low latency" in /stage/admin on every site that has it on
bash /home/PATV-staging/deploy/webrtc/rollback.sh
```

The script backs up first, to `/root/patv-webrtc-backups/rollback-<time>/`. Then it reverses everything
`install.sh` did:

- **Services.** Stops and disables them and removes the units.
- **nginx.** Removes the stream site, runs `nginx -t`, then reloads.
- **Certificate.** Removes the renewal hook, and deletes the `stream.publicaccess.tv` cert if `install.sh`
  issued it.
- **Firewall.** Removes the rules it added.
- **`.env`.** Removes the lines it added, then restarts staging.
- **coturn.** Purges coturn if `install.sh` installed it, and unmasks the packaged service.
- **MediaMTX.** Removes the binary, config, user and state.
- **TURN secret.** Removes it.

After that it re-checks that Pepe's HLS is still updating, that both sites return 200, and that nothing
listens on 8189 or 3478. It is idempotent and stops at the first error.
