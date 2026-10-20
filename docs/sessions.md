# Sign-in sessions

Status: built on staging (site 1.99wj). Code: `sessions.js`, `middleware/loginCookie.js`; tests `test/sessions.test.js`.

## What changed

A login used to be a self-contained 90-day JWT in the `jwt` cookie; nothing on the server could end it early. Now every
sign-in is a row in `sessions` and the cookie's JWT carries its id (`sid`). The JWT still proves the cookie is ours; the
row says whether it is still allowed.

- **One place issues logins:** `sessions.signIn(req, res, user, method)` - password and sign-up, Google, Apple, Plex, Telegram,
  Discord, Twitch, the `!signin` chat link, and `!signup` claim links (a sign-in / sign-up that started from `/claim/...`).
  It creates the row, issues the cookie, cancels a pending account deletion and files the new-device notice.
- **One place checks them:** `sessions.gate`, mounted right after cookie-parser in `index.js`. A JWT whose session is
  missing, revoked, expired or someone else's is a signed-out request: the cookie is cleared and `req.cookies.jwt`
  removed, so every later reader (addUser, the inbox bell, the DM stream, the language / time zone / welcome
  middlewares, the Twitch / Discord link callbacks) sees no login. `hlsauth.js` (nginx auth_request, before
  cookie-parser) asks `sessions.userIdOfToken`.
- **Cache:** rows are cached in memory for 5 s. A revocation in the site process is immediate; one written by another
  process (a CLI tool) lands within 5 s. `last_seen` / `expires` / IP are written at most every 5 minutes per session.
- **Expiry:** unchanged policy - 90 days, sliding: `expires` = last activity + 90 days (the cookie keeps renewing daily
  as before).
- **Stored:** the SHA-256 of the sid (never the sid), the user, created, last seen, expiry, the last IP, the country
  (Cloudflare's `CF-IPCountry`, only when the request really came through our proxy), a coarse device name
  ("Chrome on Windows" - never the raw user agent), a hash of the browser id (`patv_dev`, for "new device"), the method.
- **Fails open on a database error** (the JWT alone decides that request, logged) - the old behaviour, so a busy
  database never signs everyone out.

## Migration: no forced logout

Cookies issued before this release have no `sid`. On their next request the gate **converts** them: it creates a row
(method `legacy`, "Unknown device, signed in before <the token's issue date>") and re-issues the cookie with a sid. The
sid of a converted cookie is an HMAC of the old token, so two requests racing with the same old cookie make one row, and
the old token keeps mapping to it (revoking the row kills both).

"Sign out everywhere" (and a password reset, a ban, a merge) also writes `session_cutoffs.after`: an old cookie issued
before that moment can't be converted any more, even if it was never seen since the switch-over.

Nothing to run on prod: the tables are created at boot, the conversion is lazy. A converted session never counts as a
fresh sign-in (account deletion's re-authentication).

## Settings → Account → Security → Your devices

Each live session: device, method, country / IP, last active, signed in, "This device", a **Sign out** button;
**Sign out everywhere else**; **Sign out everywhere, including here**. Routes: `GET /api/account/sessions`,
`POST /api/account/sessions/revoke {id}`, `/revoke-others`, `/revoke-all` (same-origin fetch only).

## Security events

| Event | Sessions |
|---|---|
| Password change (Settings) | "Sign out my other devices" - ticked by default; this device stays signed in |
| Password reset by email | Every session (and the cutoff) |
| Removing a sign-in method (Google, Apple, Plex, Telegram...) | Nothing is signed out - the page says so and points at Your devices |
| Apple says the member stopped using Sign in with Apple (`consent-revoked`), or deleted the Apple Account (`account-deleted`) - `/auth/apple/notifications`, applesso.js | The sessions signed in with Apple **before Apple's event time** (`sessions.revokeMethod(..., { before })`); the others stay, and so does an Apple sign-in made after it (a new authorization). Each notification is applied once (`apple_notices`) |
| Site-wide ban by staff (feed ban with no pad) | Every session; a pad owner's ban doesn't |
| Admin "sign out everywhere" | `POST /api/admin/users/:id/sessions/revoke` (Admin, audit-logged) |
| Account merge | The merged-away account's sessions are revoked, never moved (`accountMerge.moveUserRows`; `sessions.user_id` is a `keep` rule) |
| Account deletion requested | Every session |
| Logout | That session |

There is no account-level sign-in ban on the site (bans are feature restrictions); the staff feed ban is the closest
and now signs the account out.

## New-device notices

A sign-in from a browser the account hasn't used (no earlier session with the same browser id) files an inbox notice
"New sign-in on a new device" (method, device, country, IP; a link to Your devices). Not for the account's first session
on record, not for sign-ups, not for chat sign-ins (they file their own), at most 3 an hour per account.
