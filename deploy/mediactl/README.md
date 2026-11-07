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
  1.6.0 (site 1.99acx): a seek / resume (and a 📼 queue's next title after a stop) starts the new ffmpeg only once the one
  it replaces has **exited** (at most 5 s): it publishes with the same slot key, and while the old one still holds that stream
  name nginx-rtmp refuses the new one ("live: already publishing") - 1.5.0 then reported `error` and the site ended the slot.
  That was "seeking ends the stream" (confirmed on prod 2026-10-18: nginx's refusal in the same second as both seeks); it
  depends on how quickly the old ffmpeg lets go, so some seeks got through. A start still refused that way is retried every
  2.5 s (8 times). Seeks (with how long they waited for the old ffmpeg), those retries and a stream that dies (its last
  words, key masked) are now logged in `journalctl -u mediactl`.
* One stream per stage; at most `MEDIACTL_MAX_STREAMS` at once (default 2, the iGPU's budget next to Plex).
* The Plex token never leaves the container. The site only ever sees titles, posters, tracks and play status.

## Section policy and catalog (mediactl 1.7.0)

`MEDIACTL_SECTIONS` is the comma-separated allow-list of reviewed Plex section IDs.
`MEDIACTL_SECTIONS_ADULT` is a comma-separated deny-list; a section in both lists is
always denied. With either list set, an item without `librarySectionID` is denied.
Plex 1.43 lists a show's episodes, a section's catalog and collections and a collection's
members with `librarySectionID` only on the response's container, not on each row: such a
row takes the container's ID (a row's own ID always wins; no ID on either is denied).
Search hits are judged by their own ID only, since one search spans sections.
The same check applies to search hits, item metadata and nested episodes, posters,
stream starts and resumes, and the catalog routes. A remembered key is not an
exception: item reads check the section again. File-root and RTMP guards still apply.
A seek, a resume and an automatic restart (mode fallback, network blip, ingest retry)
re-read the stream's section first. Only Plex's own answer stops the stream: the item
is gone (404) or now sits in a denied section. When Plex can't be read (restarting,
down, an error answer, or no answer within 5 s) the stream plays on with the section
it was started from, as 1.6.0 did, and the next re-read asks again.

An empty allow-list preserves legacy reads of sections outside the adult deny-list.
It deliberately **does not enable the catalog**: `/catalog` and `/collections`
answer `{ok:false,error:"set MEDIACTL_SECTIONS"}` until the allow-list is populated.
Newly created or unreviewed sections are excluded once an allow-list is set.
There is no request parameter to bypass the policy or include adult sections.

All three new routes use the existing signed HTTPS authentication:

| Read | Result |
| --- | --- |
| `GET /sections` | `allow_list_set`, plus section IDs, type, count and policy (`allowed`, `adult`, `off`). Adult/off names are always `(hidden)`. |
| `GET /catalog?section=<reviewed-id>&type=1&start=0&size=500` | A page of movie metadata, `total` and `next`; types `2` and `4` read shows and episodes. `size` is capped at 500. |
| `GET /collections?section=<reviewed-id>` | Allowed collections and up to 2,000 allowed member keys each. |

Catalog rows contain descriptive metadata and public metadata IDs, never media file
paths or Plex tokens. Summaries are capped at 1,000 characters (500 for episodes);
directors, cast and countries are capped at 3, 6 and 3. Catalog-related Plex reads
share a service-wide limit of four requests per second, including concurrent clients.
`since=<unix-seconds>` uses Plex's `updatedAt>>=` filter (sent as `updatedAt%3E%3E=`;
a key of `updatedAt>=` would have its own `=` encoded, which Plex ignores). Episodes
(`type=4`) send `episode.updatedAt>>=`: in a TV library a field without a type prefix
is the show's (as plexapi documents it), so a bare filter would pick episodes by their
show's update time.
Movies and shows keep the bare field, which is their own. On Plex 1.43.4 (2026-11-07)
only the movie form was checked against Plex's own count; check the show and episode
forms the same way on the installed Plex (a show section's delta total against a count
of rows whose own `updatedAt` is at or after `since`). The mocked Plex verifies each
filter as Plex reads it. The site's nightly full read remains necessary to find
deletions and to recover if that Plex version does not support the filter.

The main agent fills the policy on the host, after owner approval:

1. Read signed `GET /sections` and map its IDs to Plex libraries locally. Hidden
   names stay hidden in this response; inspect Plex on the host to review them.
   Keep the mapping out of commits, delivery evidence and chat.
2. Put reviewed IDs in `MEDIACTL_SECTIONS`, and every adult library ID in
   `MEDIACTL_SECTIONS_ADULT` in the existing service environment. Empty lists are
   compatibility defaults, not a completed policy review.
3. After the approved install/restart, read `/health` (version `1.7.0`) and signed
   `/sections`; verify the allow-list is set and each reviewed policy is correct.
4. Using a known denied key locally, make **read-only** signed `/item/<key>` and
   `/poster/<key>` requests. Both must refuse without returning metadata. Check
   search omits that key and nested show/season results omit denied episodes.
   Do not start a stream for this verification, and do not publish the key or title.
5. Check one allowed catalog page and a delta against the real server. Record only
   aggregate counts and pass/fail results in the main agent's evidence.

Installation and host checks belong to the owner/main agent; a patch delivery does
not install the service or configure a real library. Version 1.7.0 keeps existing
1.6.0 routes and response shapes, with `section` added to item/search briefs and
denied metadata omitted. Existing clients need no change. New catalog clients
treat a 404 from `/sections` on 1.6.0 as unavailable and show
"needs media-control 1.7.0", keeping ordinary title search available.

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
* 1.4.0 (site 1.99lr, 📼 queues): `/item/:key` episodes carry `show_key` + `season_key` (Plex grandparent / parent
  rating keys), so the site can queue the rest of a season or the series. The site plays a queue one episode at a time
  (a fresh `PUT /streams/:stage` on the same stage slot for each), so nothing else changed here.

## Plex members (mediactl 1.2.0, site 1.99jp)

* `GET /plex/shares` lists who the server is shared with (plex.tv `api/servers/<machineId>/shared_servers`, read with the
  server owner's token that's already here): share id, Plex user id, username, email (the site keeps only a keyed hash),
  invited / accepted times. Never an access token.
* 1.3.0 (site 1.99jt): the same answer carries `owner` = the account that OWNS the server (plex.tv `api/v2/user` for the
  token here, cached an hour): Plex user id, username, title only - never its token or email. The owner is never in its own
  share list; the site keeps it as an `owner` member (never revoked). `GET /plex/owner` returns just that.
* `POST /plex/shares/:id/remove {plex_id}` removes ONE library share (not the friendship) - only when that share belongs to
  that Plex user. The site asks only after an admin confirmed on /admin/media (or with its `plex_auto_revoke` setting on).
  `MEDIACTL_PLEX_REVOKE=0` in `/etc/mediactl/mediactl.env` refuses every removal here.
* 1.6.0 (site 1.99acx): plex.tv calls go out AS the server - its machine identifier, product `Plex Media Server` and its
  real version (read from the local `/identity`, re-read every 10 minutes, the last good one kept if Plex is restarting); with
  no readable version nothing is sent to plex.tv. The token here is the server's own, and the members-sync calls with the old
  `PATV mediactl` / mediactl-version headers re-stamped the server's plex.tv entry: it read "1.5.0" after every hourly sync
  until Plex's own check-in put 1.43 back - and the Plex apps (they want 1.41.2 or newer) called the server outdated. To check
  after the update: look at the server's version in a Plex app or app.plex.tv **within a few seconds of Sync now** on
  /admin/media (later proves nothing - Plex heals it either way). Calls to the local Plex still say `PATV mediactl`.

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
