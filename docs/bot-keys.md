# Bot keys (`X-PATV-Key`)

Site 1.99acf, bot 1.99abz. Work package R-11 of the native chat plan (the per-caller secret split, S0).

Every bot used to call the site with one shared secret, `TWITCH_BOT_TOKEN` (the Discord bot also had `DISCORD_BOT_TOKEN`).
Now each caller gets its own key. A request that carries one is known to come from that caller, so a leaked or retired
key only affects one bot, and the site knows exactly which routes each bot uses.

## The header

```
X-PATV-Key: <caller>.<secret>
```

- `caller` matches `^[a-z][a-z0-9-]{1,31}$` (`pepe`, `discord`, `twitch`, `ops`, `pepe-vm`).
- `secret` is 32 random bytes as base64url (43 characters).

The site stores only an argon2id hash (PHC string, `@noble/hashes`) and a 16-hex SHA-256 tag used as a prefilter, so a
stream of random headers never runs argon2. A verified header is cached for 10 minutes and the cache is dropped at once
on rotate, revoke, or a mode or scope change. When an entry runs out and nothing in the process changed the key, the row
is re-checked instead (the same stored hash and tag, not revoked, a grace secret still in its window; a 30-second cached
SELECT), so argon2 (about 0.25 s) runs again only when the stored secret changed. Pepe's audio chunks never wait on it.

A request that `botupload.js` replays on its target route (`/api/bot/upload/finish` → `app.handle`) gets a context of
its own on the second pass: the finish route and the target are logged separately, each under its own family, and the
target's family is the one scope-checked.

When a key resolves, `isBotToken()` and `isPlatformBot()` answer true for that request and the body `password` is
ignored. The key's caller lives in an AsyncLocalStorage request context that ends when the response finishes, so a timer
a request started can never act as that caller later.

## Callers

| Caller | Where the key goes | Notes |
|---|---|---|
| `pepe` | Pepe's admin panel: API keys → **PATV caller key** (`patv_key`, env `PATV_KEY`). Staging: `C:\PATV\staging-backend.key` on the staging VM. | Sent on every request to the site (`pepe_siteauth.py`), over verified TLS only (a keyed https request is certificate-checked even though Pepe's shared session runs with `verify=False`). Links chat users post (image links, `!imagine` / `!video` references) are fetched on a plain session that never carries it. The panel's Test button calls `GET /api/botkeys/whoami`. The VM supervisor (`vm/control.py`, which re-reads the key every minute and on a 401) and the WHIP setup (`obs_control.py`) send it too; a separate `pepe-vm` key scoped to `/api/pepe` is the next step. |
| `discord` | `PATV_KEY=` in `discord-bot/.env` | Every axios request to `BACKEND_BASE_URL`'s exact origin, `/chattip` included, the `/events` streams of `/spin` and the one `fetch()` (`siteHeaders()`). User-Agent `patv-discord-bot/1` (blackjack: `patv-blackjack/1`). |
| `twitch` | `PATV_KEY=` in the Twitch bot's `.env` | The same (`twitchbot/patvAuth.js`), including its two `/events` streams and the `!spin` chatspin `fetch()`. User-Agent `patv-twitch-bot/1`. |
| `ops` | `OPS_PATV_KEY=` in the site's `.env` | `deploy/webrtc/pepe-relay-watchdog.sh` sends it as a header read from a pipe (never on the command line). Reinstall the watchdog after setting it. |
| selfbot | none | It only drives the retired PokerNow bridge. Its fallback to the site's `TWITCH_BOT_TOKEN` was removed. |

The body passwords and `X-Bot-Token` stay on every caller until the legacy branch is deleted, so a missing or unknown
key never stops a bot.

The Node bots send the key only to `BACKEND_BASE_URL`'s exact origin, and only over https or to loopback (they run beside
the site on the VPS), never in cleartext across a network. axios drops it on a redirect off the site (`beforeRedirect`);
the `eventsource` package keeps custom headers on a redirect, so for the streams the https / loopback rule is the guard (the
site never redirects `/events`). Their own User-Agents let the legacy-token rows tell the Discord bot from the Twitch bot
(both send the same shared token from `127.0.0.1`). Path parameters (a chat-supplied `!tip` name) are
`encodeURIComponent()`ed, so a name can't walk to another route.

Keys are per environment: staging mints its own on staging's `/admin/keys`. `deploy/refresh-staging-db.sh` keeps every
per-environment table staging's own across a refresh (`deploy/keep-staging-tables.js`: `bot_keys`, `bot_keys_settings`,
`bot_key_families`, `hubseam_settings`, the usage logs and `bridge_spans`; prod's `hub_outbox` rows are dropped), so prod's
switches never lock staging Pepe out and staging's retirement count is its own.

## Making and rotating keys (`/admin/keys`)

Admins can look at the page; only an **owner** (an admin whose linked chat login has Pepe's `owner` role) can change
anything. Every change is a same-origin fetch and is written to the admin audit log.

1. **Make a key**: type the caller and a label, then press Make a key. The full header value (`pepe.<secret>`) is shown
   **once**, in the page only. Copy it to where that caller reads it (table above). Nothing stores it raw.
2. **Rotate**: makes a new secret. The old one keeps working for the grace period you pick (0–72 hours, default 24), so
   you can update the caller without downtime.
3. **Revoke**: stops the key at once (a reason is required). A revoked caller can be given a fresh key; it starts in
   observe again and keeps its scopes.

## Observe, then enforce

- **Observe** (every new key, 7 days): every route is allowed. Each request is counted in `bot_route_log` as
  `(caller, method, route pattern, route family)` when it finishes, public routes included.
- **Route families** are generated from the path: `/api/<x>` (plus `/bot` when that is the third segment, e.g.
  `/api/soundboards/bot`), otherwise the first segment (`/events`, `/u`).
- After 7 days, open **Scopes**, tick the families the key needs and press **Save scopes and enforce**. Enforcing
  earlier needs the override box and a confirmation.
- **Enforce**: outside the key's scopes the key counts for nothing on that request. It is logged as refused (one
  `bot_route_log` row per family) with one ops alert per caller and family a day (source `botkeys-scope`, so a flood of
  other alerts can't starve it), and the request is judged on its legacy credentials (hint `scope:<caller>`), as if it had
  no header. Once that family's legacy switch is on (nothing else could authenticate it there) it gets
  `403 {"error":"scope"}` before routing (the handler never runs). A route added later needs its family granted; a
  refused family shows a Grant button. The admin Overview warns when a key in enforce was refused in the last hour.
- Suggested order: `ops` → `twitch` → `discord` → `pepe`, one at a time, watching for refusals.

## The shared tokens (legacy)

Every request authenticated by a shared token alone is counted in `legacy_token_use` (route, caller hint = token | client
family | address, never the raw user agent) and per day in `legacy_token_daily`. The page shows how many days ago each
token was last used.

- **Route families → legacy switch**: refuses the shared tokens on that family only (keys are unaffected). Switch a
  family on once its 14-day count is zero.
- **Retirement** (a later release, not 1.99acf): delete the legacy branch of `isBotToken()` / `isPlatformBot()` and rotate
  both tokens after **14 consecutive days at zero on prod and staging**. The S0 exit is zero for Pepe and the Discord bot.
- `legacybj.js` (the old Discord blackjack routes) is not converted: it answers 410 unless `LEGACY_DISCORD_BLACKJACK=1`, and
  when on it still wants a non-empty password, so a key-only caller is refused there.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `enabled` | on | Read the `X-PATV-Key` header at all. Off is the kill switch: only the shared tokens count. |
| `bad_key` | fallback | A header that doesn't resolve: `fallback` ignores it and judges the request on its legacy credentials (counted with hint `badkey:<caller>`); `refuse` answers `401 {"error":"key"}`. A caller that has a key here sending a wrong, revoked or expired secret raises one ops alert a day (source `botkeys`, the family but never the request path). A caller with no key here (anyone can send that) raises none; those are counted, with at most one summary alert a day (source `botkeys-unknown`). |
| `events` | observe | The `/events` bus (below). |
| `control_get` | allow | The VM supervisor's claim of a pending control-panel command (`pepecontrol.js`). The claim is `POST /api/pepe/control/pending` since the R-11 review (a GET on the site is what a chat name walked onto a bot-only route with Pepe's key - `!tip ../../../pepe/control/pending`, closed on his side too: quoted path segments and no credentials on a URL with a `.` / `..` segment). `allow` keeps the old GET working for VM pollers that predate it; `refuse` answers the GET `405 {"error":"method"}` and claims nothing. Refuse it once the route log shows only `POST` for `/api/pepe/control/pending`. |

## `/events`

`eventsauth.js`. In **observe** nothing changes and every subscription is counted in `events_auth_log` (day, type,
channel, auth: session | key | anon | mismatch), shown on the page. The log is bounded: `type` is counted as `dm`,
`spin`, `results` or `other` (anyone can send any `?type=`), at most 1,000 distinct rows build up between two flushes,
and the page reads at most 500.

In **both** modes an incognito spinner is anonymous on every public spin surface: the homepage stage stream, its first
paint from `/api/g/wheel/last.json`, and the OBS wheel's `acknowledge-spin` answer all carry `{anon: true}` with no name
or colour; the homepage says "someone" in the visitor's language (`js.home.spin.someone`), the OBS overlay "someone".

In **enforce**:

| Stream | Consumer | Rule |
|---|---|---|
| `type=dm` | `/messages` | unchanged (the session was always required) |
| `spin` / `public` | the OBS wheel | open, but the request carries no username (only `Request` and the spin id); the open `acknowledge-spin` answer's message drops the username too |
| `spin` / `watch` | the homepage stage | open, no spin id |
| `spin` / `<pageId>` | the gold wheel page | a session; registered as `<userId>:<pageId>` (the gold spin sends to both names) |
| `spin` or `results` / `<spinId>` | the homepage after a spin, both bots | the spin owner's session or a bot key; another member → 403, nobody → 401 |
| anything else | | 400 |

Switch to enforce only once the log shows `key` (not `anon`) for both bots' spin and results subscriptions, and after
checking the homepage, the gold wheel and the OBS wheel on staging.

## Tables

`bot_keys`, `bot_route_log` (keyed by caller, method, route and family), `legacy_token_use`, `legacy_token_daily` (kept
90 days), `bot_key_families`, `bot_keys_settings`, `events_auth_log` (kept 90 days).

Counters are kept in memory and flushed every 30 seconds (and when the site starts stopping), so a crash loses at most
30 seconds of counts.

## Code

- `botkeys.js`: the middleware, `isBotToken` / `isPlatformBot` (index.js wraps them), management, `whoami`.
- `adminkeys.js`, `views/admin/keys.ejs`, `public/js/admin-keys.js`: the page.
- `eventsauth.js`: `/events`.
- The 12 places that compared the token directly (10 in `index.js`, `shop.js` `/chatshop`, `user.controller.js`
  `verifyCamfrogLink`) call `isBotToken()` now. `test/botkeys-callsites.test.js` fails if a new direct comparison appears,
  and checks that no bot route uses multer (which would lose the request context).
