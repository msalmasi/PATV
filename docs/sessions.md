# Sign-in sessions

Status: built on staging (site 1.99wj). Code: `sessions.js`, `middleware/loginCookie.js`; tests `test/sessions.test.js`.

## What changed

A login used to be a self-contained 90-day JWT in the `jwt` cookie; nothing on the server could end it early. Now every
sign-in is a row in `sessions` and the cookie's JWT carries its id (`sid`). The JWT still proves the cookie is ours; the
row says whether it is still allowed.

- **One place issues logins:** `sessions.signIn(req, res, user, method)` - password and sign-up, Google, Apple, Plex, Telegram,
  Discord, Twitch, the `!signin` chat link, and `!signup` claim links (a sign-in / sign-up that started from `/claim/...`).
  It refuses a site-banned account first (see Site bans), then creates the row, issues the cookie, cancels a pending account
  deletion the member asked for themselves (never one PATV staff scheduled) and files the new-device notice.
- **One place checks them:** `sessions.gate`, mounted right after cookie-parser in `index.js`. A JWT whose session is
  missing, revoked, expired or someone else's - or whose account is site-banned (checked first) - is a signed-out
  request: the cookie is cleared and `req.cookies.jwt` removed, so every later reader (addUser, the inbox bell, the DM
  stream, the language / time zone / welcome middlewares, the Twitch / Discord link callbacks) sees no login.
  `hlsauth.js` (nginx auth_request, before cookie-parser) asks `sessions.userIdOfToken`.
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
| Site-wide ban by staff (feed ban with no pad) | Every session - and no new sign-in by any method until the ban ends (see Site bans); a pad owner's ban doesn't |
| A site ban written without a sign-out (`padbans.linked`, an account merge, a CLI tool) | Every session, on the account's next request (the gate) |
| Admin "sign out everywhere" | `POST /api/admin/users/:id/sessions/revoke` (Admin, audit-logged) |
| Account merge | The merged-away account's sessions are revoked, never moved (`accountMerge.moveUserRows`; `sessions.user_id` is a `keep` rule) |
| Account deletion requested | Every session |
| Logout | That session |

## Site bans (1.99aoi, `siteban.js`)

Owner report 2026-11-16: a site-banned account kept posting bounties, and kept signing back in, which cancelled the
deletion staff had scheduled for it. A **site ban** - a `feed_bans` row with `room_id ''` whose `until` is NULL (for good)
or in the future, what staff make with "Site ban…" (person menu, profile, /feed/admin, the report actions) - is now an
account lock:

- **No sign-in, by any method.** `sessions.signIn` refuses it before anything is issued: an Error `{status 403, code
  'banned', until}` whose message ("This account is banned from PATV until <date> UTC. Reason: ...") every sign-in
  caller shows as itself (`siteban.isRefusal` - a network ban's `network` refusal the same way): the password form,
  Google, Apple, Telegram, Plex (callback and the create page), Twitch, Discord, the `!signin` chat link (no link is
  issued at all: reason `banned`), `!signup` claim links. `user.controller.finishLogin` and the Twitch / Discord callbacks
  ask first (`siteban.assertSignIn`), so an archived banned account isn't restored and a provider id isn't linked. No
  session row, no cookie, no deletion cancel.
- **A live session ends on its next request.** The gate checks the lock before the session (no legacy conversion), clears
  the cookie, ends every session of the account (`revokeAll` why `ban`, at most every 30 s per account; the cutoff stops
  old sid-less cookies even after the ban) and sets `req.siteLock`; the next HTML page flashes the ban's message (the
  sign-in form shows it). Every authenticated page, API and write - bounties, the feed, DMs, stories, comments, the
  casino, markets, uploads, the chat ticket - is refused as for any signed-out visitor. Signed-out visitors are untouched.
- **Bots acting for the account refuse it too** (no session involved): Pepe's escrow games (`escrow/games.act`: bounties,
  wagers, pools, loans - only the wind-down verbs stay: cancel / decline / repay / forgive, and a judge's or poster's call
  on what OTHER people hold - settle a wager / pool it judges, resolve / reject claims on its own bounty - so the winners
  are paid instead of refunded; Pepe's own verbs always run), every escrow stake (`escrow/ledger.holdInTx` `E_SITE_BANNED`
  - a loan repayment still goes), the capital cluster (`capital/service.act`: no buy, no market Pepe opens for it, no
  loan, no stake - sell / cancel / a judge's settle / repay / unstake stay), the gangs (`/api/gangs/bot/op`: no founding,
  joining, inviting, depositing - decline / leave / defect / withdraw / hand over / disband stay), Pepe's generic charges
  (`/api/wager/charge` - duel / brawl stakes, paid commands, heist gear - and `/api/pat/charge`; a fine or a clawback,
  `siteban.systemCharge`, still goes), `!boost`, the casino / lotto / stash / raffle / creator bot routers, `!tip`
  (Pepe / Discord), the chat shop, the chat wheel spin, the queued web actions Pepe claims (failed at ban time and
  skipped at claim; Pepe's `privacy.*` jobs always run), a chat sign-in link. The Telegram bridge already treated a site
  ban as tier `none`. Credits, refunds and settlements never ask (an expiring bounty refunds a banned poster; an
  admin-scheduled deletion of a banned account runs at its time).
- **The ledger backs them all up** (1.99aoi review): `ledger.post` refuses a debit the account has to cover itself
  (`requireCover` - a spend, a stake, a buy, a fee) for a site-banned account, whoever asks (`E_SITE_BANNED`), so a bot
  path that forgot to ask still moves nothing. `opts.system` is "not the account acting" and is never asked: the deletion
  job's routing, a creator clawback, a loan repayment / the collection, a market re-settle's clawback, a fine through
  Pepe's charges, a stake the escrow ledger already checked. A banned subscriber's store / creator renewal runs out like
  an unpaid one (grace, then lapsed).
- **Nobody can name them** (1.99aoi review): a new wager, pool or capital market refuses a site-banned account - or one
  PATV staff scheduled for deletion - as its opponent or judge (an open game naming them would keep that deletion on
  hold); the refusal never says why.
- **A !verify can't take the Camfrog name off a banned account** (or one staff are deleting): the name stays (Pepe would
  resolve it to the new account; the ban doesn't follow a name), "please contact PATV staff"; the `!signup` claim page the
  same. No merge path moves an account staff scheduled for deletion (`accountMerge.moveUserRows` `E_DELETION_PENDING`).
- **Ends on time.** Every read compares `until` with the clock (a cached lock too); no manual step. The lock is cached 5 s
  per account; `feedstore.ban` / `unban`, `padbans.linked` and a merge forget it at once. Sign-in reads it fresh.
- **Admins can't be locked out (D1).** The Admin class and the owner (`classRank >= 3`) are exempt, so a stray ban can't
  lock out the people who lift bans. Banning yourself or your alt was already impossible (`staffrank`), and only the owner
  can ban an Admin - to lock an Admin out, remove the Admin class first. Staff and Assistants can be locked out.
- **Merges.** A Twitch / Discord conflict merge refuses a site-banned account (`banned`) or one staff scheduled for deletion
  (`deleting`) - "please contact staff".
- **A pending staff deletion starts nothing new** (1.99aoi review, `siteban.startLock`): with D3 off a NON-banned account
  under a staff deletion can still sign in, but it puts up no new escrow stake (`E_DELETION_PENDING`), and the bot paths
  above start nothing for it (code `deleting`) - so nothing new holds the deletion off. What it can still open through the
  website without PAT (a pad, a shop listing ...) holds the job and the admin is told; D3 on closes that too (it can't
  sign in at all).
- **The /feed/admin words** (1.99aoi review): a ban there with no pad IS this site ban, so the buttons, prompts and the
  table say "Site ban" / "whole site" and what it does; a mistyped number of days is asked again (it used to become
  "for good").
- **Knobs** (constants at the top of `siteban.js`): `EXEMPT_MIN_RANK` (D1), the wind-down verbs `WIND_DOWN` / `CASINO_OK` /
  `STASH_OK` / `CAPITAL_OK` / `GANG_OK` (D2), `SYSTEM_CHARGE_RE` (Pepe's charges that aren't the account acting),
  `ADMIN_DELETION_LOCKS` (D3, off: a pending staff-scheduled deletion of a NON-banned account doesn't lock it out - it can
  sign in but can't cancel it, and starts nothing new), `SHOW_REASON` (D4).
- **Not covered yet** (follow-up): debits that skip `requireCover` or the ledger (raw balance updates - the remaining ones
  are system moves today), the Discord bot's buy-in / bonus routes and Twitch channel points beyond what the ledger
  backstop catches, and GTF's bot routes that write no PAT.

## New-device notices

A sign-in from a browser the account hasn't used (no earlier session with the same browser id) files an inbox notice
"New sign-in on a new device" (method, device, country, IP; a link to Your devices). Not for the account's first session
on record, not for sign-ups, not for chat sign-ins (they file their own), at most 3 an hour per account.
