# mediactl — 📼 Play from library (PATV 1.99ji)

A small service that lives **next to the media files and the Intel iGPU** (in the Plex container) and lets the PATV
site play a movie or an episode from the Plex library on a pad's stage.

```
 site admin ── /admin/media or pad settings ─▶ PATV site (VPS)
                                               │  signed HTTPS (HMAC + pinned cert), VPS IP only
                                               ▼
                               mediactl (Plex container) ── Plex API on loopback (search, file path, tracks)
                                               │
                                               └─ ffmpeg -re  file ─▶ VA-API H.264 + AAC ─▶ rtmp://stream.publicaccess.tv/stage/<one-time slot key>
                                                                                              │
                                     nginx-rtmp on_publish → the site's slot gate → live/<slot> → HLS / WHEP / Twitch relay
```

* The site opens a free **library slot** on the pad (one per pad) and hands mediactl that slot's one-time RTMP key.
  Everything after the RTMP ingest is the ordinary stage pipeline, so nothing else changes.
* Stop / pause (stops ffmpeg, keeps the position) / seek (restarts ffmpeg at the new time) / status + progress.
* One stream per stage; at most `MEDIACTL_MAX_STREAMS` at once (default 2, the iGPU's budget next to Plex).
* The Plex token never leaves the container. The site only ever sees titles, posters, tracks and play status.

## Sources (mediactl 1.1.0)

Before each play mediactl runs `ffprobe` on the file and picks a filter graph, best first. A way that dies before
the first frame (and not because of the RTMP ingest) falls through to the next one automatically:

| mode | decode | filters | encode | used for |
|------|--------|---------|--------|----------|
| `hw` | GPU | deinterlace_vaapi + scale_vaapi | h264_vaapi | SDR H.264 / HEVC / VP9 / AV1 / MPEG-2 with nothing drawn on the picture |
| `hwdl` | GPU | scale_vaapi, then on the CPU: HDR tone-map (zscale + hable) and/or burnt-in subtitles | h264_vaapi | HDR10 / HLG / Dolby Vision 8.1, subtitles |
| `sw` | CPU | bwdif, scale, tone-map, subtitles | h264_vaapi | what the iGPU can't decode: H.264 Hi10P, XviD/DivX, VC-1, WMV, 4:2:2, rotated video |
| `x264` | CPU | same | libx264 | last resort (or `MEDIACTL_ENCODER=x264`) |

* **HDR:** `tonemap_vaapi` fails on this Arrow Lake iGPU with the iHD driver ("Failed to start picture processing",
  then h264_vaapi error -22 and "Nothing was written"). That was the 1.99ji "Slow Horses won't play" bug. HDR is
  tone-mapped on the CPU after the GPU shrank the frame, capped at `MEDIACTL_HDR_MAX_HEIGHT` (720: two at once keep up
  on 4 cores; 1080 costs ~1.4 cores each).
* Interlaced sources are deinterlaced, anamorphic DVDs keep their display aspect, a cover-art stream is never picked.
* Known limits: Dolby Vision profile 5 (no HDR10 base layer) comes out with the wrong colours; burnt-in subtitles make
  ffmpeg read the subtitle track from the whole file first (a minute or so on a 4K remux on the NAS).
* `/streams` reports each stream's `mode`, `fallbacks` and `source` (codec, pix_fmt, hdr, dv, interlaced).

## Plex members (mediactl 1.2.0, site 1.99jp)

* `GET /plex/shares` lists who the server is shared with (plex.tv `api/servers/<machineId>/shared_servers`, read with the
  server owner's token that's already here): share id, Plex user id, username, email (the site keeps only a keyed hash),
  invited / accepted times. Never an access token.
* `POST /plex/shares/:id/remove {plex_id}` removes ONE library share (not the friendship) - only when that share belongs to
  that Plex user. The site asks only after an admin confirmed on /admin/media (or with its `plex_auto_revoke` setting on).
  `MEDIACTL_PLEX_REVOKE=0` in `/etc/mediactl/mediactl.env` refuses every removal here.

## Security

* Every call except `GET /health` is HMAC-SHA256 signed with `MEDIACTL_SECRET` (timestamp ±120 s, single-use nonce).
* `MEDIACTL_ALLOW`: only these client IPs/CIDRs get an answer at all (the VPS's public IP, or its Tailscale address).
* HTTPS with a self-signed certificate; the site pins its SHA-256 fingerprint (`MEDIACTL_TLS_SHA256`).
* RTMP targets must start with `MEDIACTL_RTMP_ALLOW` (default `rtmp://stream.publicaccess.tv/`), files must resolve
  under `MEDIACTL_MEDIA_ROOTS` (default `/mnt/`) - a leaked secret can't push the library anywhere else or read other files.
* systemd sandboxing (`ProtectSystem=strict`, `NoNewPrivileges`, own user in `render`/`video` only).

## Reaching it from the VPS — pick one

1. **Port-forward (no VPS changes):** router forwards a WAN port (e.g. 8790) to the Plex container's port 8790.
   `MEDIACTL_ALLOW` = loopback + the VPS's public IP; the site uses `MEDIACTL_URL=https://<home public IP or DNS>:8790`
   and pins the certificate. Nothing else on the internet gets past the allow-list.
2. **Tailscale:** install Tailscale on the VPS and in the Plex container (or advertise the LAN route from the Proxmox
   host); `MEDIACTL_ALLOW` = the VPS's 100.x address; `MEDIACTL_URL=https://<container 100.x>:8790`.

## Install (in the Plex container, as root)

```bash
# from a machine with the repo: copy the folder in
pct push <ctid> deploy/mediactl/mediactl.js         /root/mediactl/mediactl.js          # on the Proxmox host
pct push <ctid> deploy/mediactl/mediactl.service    /root/mediactl/mediactl.service
pct push <ctid> deploy/mediactl/mediactl.env.example /root/mediactl/mediactl.env.example
pct push <ctid> deploy/mediactl/install.sh          /root/mediactl/install.sh
pct exec <ctid> -- env ALLOW_IPS=<vps-ip>/32 bash /root/mediactl/install.sh
```

`install.sh` is idempotent: it installs `nodejs` (+ `openssl`) from Debian if missing, creates the `mediactl` user,
writes `/etc/mediactl/mediactl.env` (a fresh secret; the Plex token copied from Plex's `Preferences.xml`; never printed),
makes the certificate, installs + starts the systemd unit and checks `/health`. At the end it prints what goes into the
site's `.env`:

```
MEDIACTL_URL=https://<address the VPS uses>:8790
MEDIACTL_SECRET=<grep ^MEDIACTL_SECRET= /etc/mediactl/mediactl.env>
MEDIACTL_TLS_SHA256=<the fingerprint it printed>
```

Then on the site: restart it, open **/admin/media** → Connections should show ✅, tick **📼 Play from library → On**.

## Operating

* Emergency stop of every library stream: `systemctl stop mediactl` (the stage slots end by themselves).
* Logs: `journalctl -u mediactl -f` (stream keys are masked in ffmpeg's error lines).
* Update: re-run `install.sh` with the new `mediactl.js` next to it.
* Uninstall: `UNINSTALL=1 bash install.sh` (keeps `/etc/mediactl`).
* CPU fallback (no iGPU): `ENCODER=x264 bash install.sh`.

## Tests

`node --test test/mediactl.test.js` (service, mocked Plex + fake ffmpeg) and `test/medialib.test.js` (site ↔ service end to end).
