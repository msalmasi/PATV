# Browser notifications (Web Push, QW-1)

Status: site 1.99acd, **shipped off**. Code: `webpush.js` (feature), `webpushcrypto.js` (RFC 8291 / 8292 on `node:crypto`),
`public/js/push-sw.js` (served as `/sw.js`), `public/js/webpush.js` (the Messages ⚙ widget), `views/admin/push.ejs`,
`tools/vapid-keys.js`. Tests: `test/webpush*.test.js`, `test/vapid-keys.test.js`. Design: CHAT-ARCHITECTURE §17.5 QW-1, §7.1.

## What it does

A member turns notifications on **per browser** in the 💬 Messages ⚙ dialog ("Browser notifications"). The browser's
permission prompt only appears after they click "Turn on". They pick kinds: direct messages, mentions (your name in a
bridged pad's chat, @you in posts and comments), alert words.

When a DM or a mention that the existing rules already allow arrives (mute, blocks, quiet hours, pad visibility and the
mention settings all run first, unchanged), the site queues one push and sends it to the browser's push service
(Google FCM, Mozilla, Apple, Microsoft WNS). Every push is **content-free**: the payload is
`{v:1, k, t, b, u, tag, ts, d}` - kind, a generic localised title ("New message", "You were mentioned in <pad>"), a
generic body, a local link, a collapse tag, the time and the text direction. Never the message, the sender, a group title
or an Approved pad's name. It is encrypted to the browser and padded to a fixed size (1 KB), so its length doesn't give a
pad's name away either; the `Topic` header push services read is keyed per browser (it can't link the members of a
conversation, or be looked up to a pad). The service worker shows it and opens the link; a focused tab already on that page gets none.

Push-only rules on top: the kill switch and per-kind switches, an audience, a per-kind grace (DM 0 s, mention 15 s,
alert word 60 s) during which reading it on the site cancels it, one DM push per conversation per 30 s (only while the
earlier one is still waiting, or went out and is still unread - after a read the next DM pushes again), 60 pushes per
account an hour, bridge lines older than 2 minutes (a backlog after Pepe reconnects) stay inbox-only, a speaker whose
account the member blocked in DMs gets no push. A subscription belongs to the sign-in it was made under: signing that
browser out (or "sign out everywhere") ends its pushes, and so does another account signing in there (the replaced
sign-in is ended; opening Messages settings as the new account removes the old account's row for that browser). When the
sign-in can't be checked (the database busy), that browser is skipped and the push retried - never sent blind.

Turning notifications **off** always works: `/api/push/unsubscribe` answers even while the switch is off or the member is
out of the audience, and the Messages ⚙ dialog (and the /settings hub row) then shows only "Turn off everywhere" for a
member who still has browsers saved.

## Keys (one pair per instance)

```
node tools/vapid-keys.js --env <path to the site's .env> --subject mailto:<ops address>
```

writes `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` into the file (it refuses if `VAPID_` lines are already
there; new files are mode 0600). It prints the public key and its kid, never the private key. Restart the site and look for:

```
[webpush] keys loaded (kid 1a2b3c4d5e6f7a8b); sending is off (/admin/push)
```

With no or broken keys the feature stays off and the log says why, once:

| Log line | Fix |
|---|---|
| `[webpush] off: no VAPID key pair (...)` | run the tool, restart |
| `[webpush] off: VAPID_PUBLIC_KEY isn't a P-256 public key` | a damaged line - restore it from the password manager |
| `[webpush] off: VAPID_PRIVATE_KEY doesn't match VAPID_PUBLIC_KEY` | the two lines come from different pairs |
| `[webpush] off: VAPID_SUBJECT must be a mailto: or https: address` | `mailto:ops@...` or `https://publicaccess.tv` (Apple requires one) |

- **Staging and prod each get their own pair.** Never copy staging's to prod, or prod's to staging. Defence in depth:
  `deploy/refresh-staging-db.sh` empties `webpush_subs` / `webpush_outbox` and turns the switch off in prod's copy, and
  every subscription remembers the instance it was made on (`instance`: prod / staging, by the `STAGING` env) - another
  instance's rows are never sent to and are removed.
- **Never rotate a pair once people have turned notifications on**: subscriptions are bound to the public key, so a new
  key orphans every browser (they must turn notifications on again). `--force-rotate` exists for a leaked key only.
- **Keep a copy in the password manager.** At S5 the pair moves to notify's SOPS secrets and is removed from v1's `.env`.
- The private key, the JWT, endpoints (logs show the host only), the browser keys and payloads are never logged or shown.
  `/admin/push` shows the kid (a fingerprint of the public key) only.
- Break-glass: the switch in `/admin/push`, or unset the env and restart.

## Rollout

1. Deploy (no keys): the log shows the `off:` line, `/admin/push` says "Keys not configured", nothing visible changes.
   `/sw.js` is served but nobody registers it.
2. Add the keys (above), restart, check the `keys loaded` line.
3. `/admin/push` → Settings: switch on, audience **Admins only**. Turn notifications on in your own browser (Messages ⚙),
   then "Send a test to my browsers".
4. Verify on staging: Chrome (Windows), Edge, Firefox, Android Chrome. A DM shows "New message" with no text and opens
   the conversation; a focused conversation shows none; reading within the grace cancels it. A mention in PepeLab shows
   "You were mentioned in PepeLab". An alert word, a feed @mention. Unsubscribe in devtools, DM again: the row is removed
   (Delivery: "subscription gone"). Sign out, DM: no push. A Spanish account gets the Spanish title. Switch off: nothing sent,
   the dialog section shows only "Turn off everywhere" (for members with browsers saved; nothing for anyone else), and it works.
5. Prod: its own pair, then the same steps - admins for a day, staff for 2-3 days (watch Delivery: failures, 401s / 403s, caps,
   queue), then everyone.

Rollback at any step: the switch (immediate; subscriptions are kept). Reverting the commit is safe: the tables stay and
nothing else reads them; an installed service worker is inert without pushes.

## Switches (`/admin/push#settings`, Admins only, table `webpush_cfg`)

| Setting | Default | Effect |
|---|---|---|
| `webpush_enabled` | 0 | off: nothing queued, due pushes dropped as `off`, the UI and the settings-hub row hidden (a member with browsers still saved sees only "Turn off everywhere"), the APIs answer `E_OFF` - except unsubscribe, which always works |
| `webpush_audience` | admins | admins / staff / everyone - checked at subscribe and at send, by the class in the database |
| `webpush_kind_dm` / `_mention` / `_keyword` | 1 | an off kind is hidden from the widget and never sent |
| `webpush_grace_dm_s` / `_mention_s` / `_keyword_s` | 0 / 15 / 60 | wait before sending; a read on the site in that time cancels |
| `webpush_dm_gap_s` | 30 | one DM push per conversation per this many seconds |
| `webpush_hour_max` | 60 | pushes per account an hour |
| `webpush_late_s` | 120 | pad lines older than this stay inbox-only (needs the site's and Pepe's clocks in sync) |
| `webpush_hosts_extra` | "" | more push-service host names - exact names only, never a wildcard (the built-in list: FCM, Mozilla, Apple, WNS) |

Changes are audited (`admin_audit`, action `webpush.settings`) and logged (`[webpush] settings saved by <name>: ...`).

## Delivery health (`/admin/push#health`)

The last 24 h of the outbox by kind × outcome:

- `sent` - at least one browser took it (2xx)
- `read` - cancelled: read on the site during the grace, or the conversation was muted / left
- `nodevice` - no browser on for that kind (or its sign-in ended)
- `off` - the switch or the kind was off when it came due
- `failed` - every browser refused it (including 401 / 403: our VAPID signature refused, and `addr`: the push service's
  name resolved to no public address), or it ran out of retries (30 s, 2 min, 10 min)
- `gone` - every browser's subscription was gone (404 / 410): those rows are removed
- `sending` - claimed by the sender, not finished yet (a row is claimed before anything goes out, so it is never sent
  twice; one still `sending` after 5 minutes is closed as `failed` by the sweep)

Plus queue depth, browsers by kind and family, push-service answers by family since the start, what wasn't queued (cap,
late, blocked, DM burst, muted) and the last error. Overview alerts: switched on without keys; a 401 or 403 in the last
hour; more than max(20, sent / 2) failed in 24 h.

## Troubleshooting

- **401 or 403 from a push service**: our VAPID JWT was refused - a `VAPID_SUBJECT` the service won't take, a changed private
  key, or the server clock (Apple answers 403 `BadJwtToken` / `ExpiredJwtToken`; WNS and FCM answer 403 for credential
  errors). **Rows are kept** - a server-side signing problem must never wipe every Safari / Edge subscription. Fix the cause;
  pushes resume. A 403 counts as a failure on the row, so one that only ever gets 403 goes with the long-dead sweep (20+
  failures, nothing good for 30 days). Rows made with another key are never sent to (`vapid_kid`); the browser re-subscribes.
- **`addr` in Last error**: an endpoint's host resolved to a loopback / private / link-local / CGNAT / ULA address. Every push
  goes through a pinned lookup (only public addresses, the socket connects to the checked one); not retried.
- **"This browser's push service isn't supported"**: the endpoint's host isn't in the allow-list (an SSRF guard - we only
  POST to known push services). Add a real push service's exact host name in `webpush_hosts_extra`; never an IP or a
  wildcard.
- **Brave**: push needs "Use Google services for push messaging" on; otherwise subscribing fails.
- **iPhone / iPad**: website push needs an installed web app (iOS 16.4+), which PATV doesn't offer until the PWA (S6). The
  widget says so. macOS Safari 16+ works.
- **Nothing arrives, Delivery says `sent`**: the OS / browser is blocking notifications (Focus mode, site settings).

## Tables

- `webpush_subs` - `endpoint` (unique; a capability URL), `p256dh`, `auth`, `user_id`, `kinds`, `session_id`, `vapid_kid`,
  `ua` (coarse family), `locale`, `expiration_time`, `created`, `updated`, `last_ok`, `last_fail`, `fail_count`,
  `last_error`, `instance` (prod / staging). At most 10 per account. Removed on 404 / 410, an ended sign-in (signed out, or
  another account signed in there), a passed expiration time, another instance's row, or 20+ failures with nothing good for
  30 days. Account deletion removes them; a merge moves them; the data export lists them
  (push service host, kinds, browser, language, dates - never the endpoint path or the keys).
- `webpush_outbox` - one row per push decided (no text): `user_id, kind, room_id, src_key, url, tag, ctx, check_ref,
  only_sub, due_at, created, sent_at, tries, outcome, devices`. A row is claimed (`sent_at` + outcome `sending`) before it is
  sent: at most one push per row. Kept 3 days.
- `webpush_cfg` - the switches.

## The S5 hand-over (N-1 imports QW-1)

- **Subscriptions**: N-1 imports `webpush_subs` (`endpoint, p256dh, auth, user_id → account_id, kinds, session_id,
  vapid_kid, ua, locale, expiration_time, created, updated, last_ok, fail_count`) through a snapshot keyed on `updated`
  (R-14's snapshot pattern, built in S5). No browser re-subscribes.
- **Key pair**: the three `VAPID_` values move into notify's secrets and leave v1's `.env` (§16). Same public key, so the
  subscriptions stay valid.
- **Pushes v1 still decides**: behind a `hubseam.push` switch, the local enqueue becomes
  `hubOutbox.emit("push/intent", {acct: user_id, kind, pad: room_id, src_key, url})` - exactly the outbox columns, so the
  hooks and gates stay. `webpush_outbox` and the in-process sender retire. `dm` stops at the S5 DM cutover; room kinds stop
  per pad at its `alerts_cutover`.
- **Device contract**: N-1 sends payload schema `v:1` (above) to the same `/sw.js`, or ships a worker that accepts both
  `v:1` and its own `v:2` first (the site serves `/sw.js`, so it can be updated before the switch).
- **Preferences**: per-subscription `kinds` → N-1's kind × transport (`webpush`), per device or as the union per account.
- **Sign-out**: the session binding becomes N-1's revocation through the `sessions/revoked` topic.
