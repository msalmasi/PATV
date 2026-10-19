# Account deletion

Status: built on staging (site 1.99wj, bot 1.99wj). Code: `accountdelete.js`, page `views/accountDelete.ejs`
(`/settings/account/delete`), tests `test/account-delete.test.js`. PAT is points, not money; the rules below still treat
it with ledger care, because it is supply.

## The flow

1. **Settings → Account → Delete account** opens `/settings/account/delete`: what deletion does (below), what has to be
   closed first, what is settled automatically, and a link to download your data first.
2. **Re-authentication**, one of:
   - the account's password;
   - a **fresh sign-in**: a session created in the last 10 minutes by any method - Google, Plex, Telegram, Twitch,
     Discord, the `!signin` chat link (that is the "chat-link confirmation") or the password. A converted
     pre-sessions cookie never counts as fresh.
3. **Typed confirmation**: the username, exactly.
4. **Scheduled, 14 days of grace.** Every device is signed out at once (`sessions.revokeAll`, including cookies from
   before sessions existed - the cutoff) and a notice is filed. **Signing in again by any method during the grace
   period cancels the deletion** (`sessions.signIn` -> `cancelOnSignIn`, with a notice).
5. **The job** (`tick()`, every 10 minutes) runs a request that is due. It checks the blockers again; anything new
   (the person kept playing in chat) puts the request on **hold** (one notice, retried every tick; a sign-in still
   cancels). Then it settles what is automatic and runs the deletion in **one database transaction**.

**Admins, staff and moderators** (a class other than a member, or an admin / staff / moderator role) are refused on the
self-service page: another admin schedules it - `POST /api/admin/users/:id/delete {confirm: <username>, reason}` (not for
your own account; audit-logged as `account.delete`), with the same grace, blockers and job. Admins can list and cancel
requests: `GET /api/admin/account-deletions`, `POST /api/admin/account-deletions/:id/cancel`.

## What blocks it, what is settled automatically

The rule: **anything owed to other people or still in play blocks** (with a list and a link to where to close it);
what has a safe existing rule is settled automatically.

| Blocks (close it first) | Why |
|---|---|
| Pads you own (not your profile pad) | Recommended: transfer or delete each pad first; nothing is left ownerless |
| Loans (either side), loan requests | Owed to / by someone else |
| Escrow holds (wagers, bets, challenges, games), escrow payouts on their way | PAT in play |
| Open markets (positions, orders, markets you created or judge), bounties, wagers | PAT in play, other people's outcomes |
| Lotto tickets in a draw that hasn't paid out | A prize may still be owed |
| Open shop orders (buyer or seller), shop listings, cosmetic listings, heist market listings | Other people's purchases |
| Stage slots not settled, stage queue bookings, 📼 Plex bookings, homepage banner bookings | Booked with points, refund rules apply |
| Active subscribers to your creator page | They paid you |
| A card subscription (Stripe) | Real money: it must be cancelled so it isn't charged again |
| Your cloned voice on the voice store | Your likeness: revoke it through its own consent flow |
| Gang membership | Leave the gang (`!gang leave`) |
| A stash with other members, staked PAT, or stashes still in Pepe | Other people's PAT may be in it |
| A balance below zero | Owed to the economy |

| Settled automatically | How |
|---|---|
| Your balance | Routed by the PAT Routing row `account_deleted` (below) |
| Stashes only you use (site-owned, unstaked) | Withdrawn into the wallet (keyed stash move), closed, then routed with the balance |
| Creator subscriptions you pay for, store subscriptions | Stop renewing (`cancel_at_end`); one in grace ends |
| Prime Time / Season Pass renewals you pay with PAT | Stop (`renewer_id` cleared) |
| A pending welcome bonus | Expired (never paid) |
| A pending Camfrog link | Deleted |
| Website actions still waiting for Pepe | Failed with "account deleted" (so nothing runs as you later) |

## PAT: never vanishes from supply

- The whole-PAT balance leaves the wallet as an `account-deleted` transaction and goes to the destinations of the PAT
  Routing row **`account_deleted`** - default **100% the Federal Reserve** (like the stale-account cleanup). An admin
  can override the row like any other (`pat_routes`); a destination that isn't a pool or the House goes to the Fed.
- Legs: a site-owned pool (`pools._inTx` move), the House (a `jackpot_rakes` row), or - while the pools still live in
  Pepe - a negative `reserve_claims` row (flow `account_deleted`) his funding tick credits to the Reserve.
- One transaction, keyed `acctdel-<userId>-<n>` and journaled in `account_deletion_routes` (amount, legs, txid):
  running it again moves nothing. Sub-1 PAT dust stays on the row (still counted in supply).
- A deleted account credited later (a late refund, a payout already in flight) is **swept** by the job the same way
  (`acctdel-<userId>-1`, `-2`, ...).

## What happens to the data

| Data | Policy |
|---|---|
| The account row | Kept as a **pseudonymous tombstone**: username `deleted-<10 hex>` (a hash of the id), display name "Deleted user", no email, no Twitch / Discord / Camfrog ids, no stream key or tokens, no age confirmation (`age_confirmed_at`, `age_confirmed_v`), a random password nobody knows, archived (hidden from leaderboards and counts) and marked `DELETED` in `account_archive` (the stale cleanup never revives it). The ledger needs the id to exist (`transactions_user_must_exist`). |
| Sessions, sign-in links (Google, Telegram), crypto wallets, chat sign-in tokens / log / switch, incognito log | Deleted |
| Profile settings: language, time zone, layout, showcase, mention words, alerts, follows (both ways), notices (inbox), username and display-name history, likeness settings | Deleted (the old username is free again) |
| Badges, cosmetics, sticker packs, soundboard items, owned voices, roles, pad memberships | Deleted (what they cost stays in the ledger) |
| **Posts and comments** | **Anonymised where someone replied** (the text stays, shown as "Deleted user", so threads still make sense); **deleted otherwise** (text cleared at once, attachments purged by the feed's sweep). Stories by or of them are removed. |
| **DMs** | The messages they **sent** are deleted (the other side sees "deleted"; their pictures are purged by the DM sweep); they leave every conversation. Messages other people sent stay theirs. |
| Clips they made or that are of them (`media`) | Files removed, rows flagged deleted |
| Chat statistics for the login (`camfrog_userstats`) | Deleted |
| Votes on posts | Kept, pseudonymous (removing them would change other people's scores) |
| **Pepe's memory** | The website action **`privacy.forget`** (keyed per attempt, TTL 7 days, retried up to 10 times) asks Pepe to forget the login: `memory_store.delete_user` (profile, aliases, links) + the PM lines waiting to become memories. Once Pepe answers, the login is cleared from the action row too. |
| The Camfrog login | Released: another account can link it; if the person chats again Pepe makes a new automatic account. |

**Kept, pseudonymised** (needed for the ledger, legal, fraud or safety reasons). The rows keep pointing at the tombstone's
id; usernames / Camfrog logins written in them as text are replaced by the pseudonym:

- the ledger: `transactions`, `bonus_winners`, `wheel_spins`, `jackpot_rakes`, `reserve_claims`, `bot_credit_log`,
  `pat_burns`, `econ_charges`, `room_flow_ledger`, `royalty_ledger`, `premium_ledger`, `creator_ledger`,
  `likeness_ledger`, `post_tips`, `gift_log`, `escrow_holds`, `stash_moves`, `pat_route_intents`, `market_orders`,
  `bounty_actions`, `pepe_actions`, `lotto_purchases` / `lotto_tickets`, the casino journals, `account_deletion_routes`;
- purchases and orders: `shop_orders`, `shop_order_events`, `premium_subs`, `shop_subs`, `creator_subs`;
- donations with payment-processor ids: `donation_usd_log`, `donation_promo_credits`, `crypto_payments`, `stripe_events`;
- moderation and safety: `admin_audit`, `content_audit` (+ views), `feed_automod`, `feed_filter`, `image_safety_log`,
  `feed_reports`, `user_reports`, `dm_reports` (with the reported message's copy), `feed_bans`, `stage_bans`,
  `adult_gate_cfg` (who last flipped the 18+ pad gate);
- **TAKE IT DOWN** reports (`takedown_cases`, `takedown_hashes`) and creator performer records (`creator_performers`);
- consent records: `voice_consents` (proof of consent / revocation);
- fraud: `welcome_keys` (hashes only), `welcome_bonus`;
- merges and archives: `account_merge_log`, `account_archive`, `login_changes`.

Not rewritten: Pepe-owned game records stored as JSON blobs (finished markets, wagers, bounties, GTF records) - they
name the Camfrog login as Pepe keeps it, and Pepe's own data is his to forget (the forget action covers his memory).

## Tables

- `account_deletions`: id, user_id, state `scheduled | held | cancelled | done`, requested_at, execute_at, requested_by
  (`self` / `admin:<id>`), reauth (`password` / `fresh-sign-in` / `admin`), reason, cancelled_at, cancel_via, held_reason,
  held_at, done_at, pseudonym, report (JSON counts - no personal data).
- `account_deletion_routes`: key PK, user_id, amount, legs, txid, at.

Both are classified for account merges (`keep`). The prod tables are created on boot (idempotent); nothing to migrate.
