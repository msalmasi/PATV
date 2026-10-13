# Connections neutrality audit (1.99ul)

PATV is a hub, and pads are the product. Camfrog is **one** chat service a pad can connect to; Twitch, Discord,
IRC and PATV's own chat come later. Pepe is PATV's host, and he works across the connected services. This audit
lists every place that makes Camfrog sound like a dependency, and every place that actually is one.

Categories: **(a)** copy that frames Camfrog as required or central, **(b)** UX dead ends for an account with no
Camfrog link, **(c)** structural or data-model dependencies that would block other connections.

Severity: **H** blocks a user or a future connection, **M** misleading or a partial block, **L** wording.

## House style (from this pass)

- "the pad's chat room", "in chat", "chat rooms": never "the Camfrog room(s)" for something that isn't
  Camfrog-specific.
- "connected chat room (Camfrog today)" where the reader needs to know what it is now.
- Linking: "Link a chat account (Edit profile → Connections; for Camfrog, `!verify` ...)".
- Pepe is "PATV's host", not a Camfrog bot.
- Keep **Camfrog** named only where the thing really is Camfrog: the Camfrog connection setup (pad connect,
  `!verifypad`), the Camfrog login field and `!verify`, Camfrog PM alerts, Camfrog Pro shop items, Camfrog-specific
  achievements (`cf_*` counters), the Join-the-Camfrog-room steps on a Camfrog pad, and admin tools that drive the
  Camfrog client.
- PAT is points, never money.

## (a) Copy, fixed in 1.99ul

`locales/en.json` (120 keys, stale translations dropped from the 22 catalogs so the i18n sync retranslates them):

| Area | Keys | Was | Now |
|---|---|---|---|
| Home | `home.pitch.text`, `home.room.*`, `home.me.link_camfrog` | "Camfrog rooms where Pepe runs the games", "Live from Camfrog" | "pads with live stages, feeds and chat rooms, Pepe the frog who hosts...", "the pad's chat room (Camfrog)" |
| /help | `help.hero.eyebrow`, `help.intro` | "PEPEFROG · THE CAMFROG ROOM BOT", "Everything PepeFrog does in the Camfrog rooms" | "PEPEFROG · PATV'S HOST", "Everything PepeFrog does in chat ... (Camfrog today)" |
| /premium, perks | `premium.lead3`, `premium.pp.*`, `perks.pp.room`, `perks.pt.soundboard_d` | "The Camfrog bridge", "Your Camfrog room, with Pepe in it" | "The live chat bridge", "Pepe in your pad's chat room", "(Camfrog today)" |
| Pads | `rooms.*`, `pad.hdr.room_tip`, `pad.live.*`, `pad.plus*`, `pad.tease.*`, `pad.chat.*`, `pad.people.h`, `pad.vault.in_room`, `pad.boost.in_room`, `pad.an.gate`, `js.pad.*` | "the Camfrog room" (everywhere) | "the pad's chat room", "the chat room"; the live banner keeps "the pad's Camfrog room" once |
| Feed, stories | `feed.sub.all`, `feed.story.strip_aria`, `feed.fc.*`, `feed.pc.quote_aria`, `js.feed.*` | "the pads' Camfrog rooms", "linked Camfrog name" | "the pads' chat rooms", "linked chat account" |
| Profile, settings | `profile.analytics.*`, `profile.gtf.*`, `profile.posts.roomgen`, `profile.an.activity`, `settings.layout.desc.analytics`, `settings.mentions.*`, `msg.set.mentions`, `settings.telegram.no_camfrog` | "Camfrog activity", "in a Camfrog room with Pepe" | "Chat activity", "in chat with Pepe" |
| Wallet, economy | `wallet.*` (link hint, limit, donate, send), `economy.lead` | "Link your Camfrog name", "thanks you in the Camfrog room" | "Link a chat account (Edit profile → Connections; ...)", "in chat" |
| Games | `markets.*`, `market.*`, `aij.*`, `wagers.*`, `polls.*`, `bounties.*`, `bounty.signin`, `lotto.*`, `casino.*`, `js.casino.*`, `gtf.*`, `hm.*`, `automkt.feed.foot` | "In a Camfrog room: ...", "Camfrog rooms live" | "In chat: ...", "Chat rooms live" |
| Other | `ach.lede`, `tip.no_tips`, `sb.lead`, `vs.clone_note`, `js.sb.bought`, `shop.hero.lead`, `tg.*` | "Earned ... in the Camfrog rooms", "Camfrog memberships, Plex access, ..." | "in the pads' chat rooms", "Roles, perks, Plex access, Camfrog memberships ..." |

Untranslated views and server copy:

| File | What changed |
|---|---|
| `views/about.ejs` | Hero "A TV station, a Camfrog crew" → "a hub of pads"; the lead, the "Camfrog rooms" card → "Pads", the live-pads and casino blurbs, Getting started (Connections instead of "In a Camfrog room type !verify") |
| `views/casino.ejs` | "Pepe deals in Camfrog" → "Pepe deals"; link hints → "link a chat account"; "In a Camfrog room with Pepe" → "In a pad's chat room with Pepe" |
| `views/economy.ejs` | 8 lines, including the self-contradicting "NO CAMFROG NEEDED" eyebrow over "Once your Camfrog name is linked" → "FROM ANY BROWSER" / "Once a chat account is linked" |
| `views/gangs.ejs`, `quotes.ejs`, `cosmetics.ejs`, `staking.ejs`, `partials/room-dj.ejs` | "in a Camfrog room" → "in chat"; link hints |
| `home.js`, `bridge.js`, `lotto.js` | OG/meta descriptions ("Camfrog rooms live on the web" → "pads with live stages, feeds and chat rooms") |
| `feedstore.js`, `dmmedia.js`, `stagecap.js`, `wallet.js`, `tables.js`, `capital/service.js`, `stashes.js`, `polls.js`, `gtfsheet.js`, `heistmarket.js`, `cosmetics.js` | "Link your Camfrog name first (type !verify in a Camfrog room)" → "Link a chat account first (Edit profile → Connections; for Camfrog, type !verify in a room with Pepe)" |
| `guidelines.js` | "that's half of Camfrog" → "that's half of chat" |
| `bridge.js` | the Plus-locked error: "live Camfrog room" → "live chat room" |
| Pepe's help catalog (bot `help/catalog.json`, regenerated into `data/help-commands.json`) | 23 strings: `!message`, `!boost`, `!padvault`, `!achievements`, `!prizes`, earning/redeem, Telegram, `!displayname`, `!verifypad` ("its chat room (Camfrog today)"), multi-room explainer, 3 admin backend cards |

### (a) Left as is, on purpose

| Where | Why |
|---|---|
| `settings.verify.*`, `settings.connections.cf_*`, `auth.err.username_cf`, `profile.on_camfrog`, `wallet.hero.camfrog` | The Camfrog connection itself |
| `pad.conn.*`, `views/partials/pad-connect.ejs`, `pads-admin-conn`, `!verifypad` | Camfrog connection setup |
| `pad.join.*`, `pad.chat.link_first`, `pad.tease.register`, `pad.about.cf_room`, `pad.live.cf_room` | Shown only on a Camfrog pad, about that Camfrog room |
| `msg.*` / `js.msg.*` Camfrog alerts, `feed.fl.golive_pm`, `shop.sd.notify.pm*`, `storealert.*` | Pepe's Camfrog PMs are a Camfrog delivery channel |
| `vc.*` (voice clone) | The recording happens on a Camfrog mic today |
| `shop.cat.item.camfrog_*`, `shop.shelf.camfrog`, `shop.anywhere.camfrog`, `shop.role.high_roller.camfrog` | Camfrog Pro products and Camfrog-side perks |
| `ach.d.cf_*` | Literally Camfrog counters |
| `wagers.f_opp_ph`, `wagers.f_judge_ph`, `views/gang.ejs` invite, gift fields | The backend takes a Camfrog name there (see (b)) |
| Pad-room relay/clip/mod errors (`bridge-relay.js`, `camclip.js`, `micclip.js`, `padmod.js`, `padpepe.js`, `roomdj.js`) | Actions inside a Camfrog room, run as the Camfrog login (see (b) 7-8) |
| Admin pages (`roomsAdmin`, `feedAdmin`, `pepe-control`, `admin/*`) | Staff tools for the Camfrog client |
| `views/terms.ejs`, `views/privacy.ejs` | Legal text. Terms §1 says the service is "built around live Camfrog video chat rooms" (M). Privacy §3 accurately describes the Camfrog mirroring. Suggest a reviewed legal edit: "built around pads: feeds, live stages and the chat services they connect (such as Camfrog)", plus a dated change note |
| `views/padCreate.ejs:36,76` | Already neutral ("your Camfrog room or Twitch channel") |

### (a) Not edited: owner guide and owner panel (other agents own them)

| Key / file:line | Text | Proposed |
|---|---|---|
| `owner.guide_lead` | "Own a pad with a Camfrog room?" | "Own a pad? Here's everything Pepe lets you run yourself, in your pad's chat room and on the website" |
| `owner.topup_why`, `owner.topup_link`, `owner.cap.web_vault_topup.howto` | "from your linked Camfrog name" | "from your linked chat account" (and see (b) 6: the check isn't needed) |
| `owner.share_why` | "in your Camfrog room on at least {days}" | "in your pad's chat room" |
| `owner.mod_why`, `owner.mod_checking`, `owner.bridge_why`, `owner.can_why` | "your own pad's Camfrog room", "linked Camfrog name" | "your pad's chat room", "linked chat name" |
| `owner.cap.stage.howto`, `owner.cap.bridge.howto`, `owner.cap.topup_web.howto` | generated by bot `tools/build_owner_caps.py:51,158,192` | Fix in the generator, or `en.json` regresses on the next run |
| `js.owner.mod_offline/mod_nolink/mod_unbridged` (`public/js/pad-owner-mod.js:27,28,51`) | "The Camfrog room isn't live" | "The pad's chat room ..." |
| `views/padSettings.ejs:24,29,75,83,144,226,242,259,270,272,279,421,449-465,502` (hardcoded English) | "Linked Camfrog accounts", "Announcements in the Camfrog room", "PATV or Camfrog name" | "Linked chat accounts", "in the pad's chat room", "username or chat name"; keep the "Camfrog room" connection tab |
| `padowner.js:314,402,426` (API errors) | "This pad has no Camfrog room.", "Pepe sits in Camfrog rooms for Prime Time Plus pads" | "no connected chat room", "Pepe joins pad chat rooms for Prime Time Plus pads" |
| `pad.settings.golive.hint` | "from Pepe in the Camfrog room" | "in the pad's chat room" |

## (b) UX dependencies (an account with no Camfrog link)

The link is `users.camfrogUsername`. Most refusals exist because a website action is queued to Pepe
(`actions.js`, `pepe_actions.camfrog`) and Pepe runs it "as that name". Several features now run on the site and
fall back to the PATV account, so some gates are stale.

| # | Feature | Where | Behaviour | Enforced | Sev | Fix |
|---|---|---|---|---|---|---|
| 1 | Wallet: donate, stashes, staking, loans, Reserve | `views/wallet.ejs:153` (`canAct = !!camfrog`); `stashes.js:428`; `capital/service.js:493`; `wallet.js:72,154` | Forms hidden | View, plus server for stashes. Reserve and P2P loans already work by account on the server (`capital/reserve.js:580`, `escrow/games.js:295`): **stale gate** | H | Gate per section; key stashes and staking by `u:<id>`; site donate handler |
| 2 | Market creation | `views/markets.ejs:111`; `markets.js:470`; `actions.js` doesn't intercept `cmd=market` | Create form hidden (betting works) | View, then Pepe | M | Route create to `capital/markets` when live |
| 3 | Wagers, bounties, pools | `views/wagers.ejs:190`, `wagers.js:113`; `views/bounties.ejs:68`, `bounties.js:275` | Forms hidden | View only while the escrow game is live (`escrow/games.js:288` accepts the username) | M | Gate on `gameLive()`, not the link |
| 4 | Poll creation | `polls.js:164` | Refused (voting works as `🌐username`) | Server | M | Create as `🌐username`, like votes |
| 5 | Lotto | `views/lotto.ejs:250` | Gated only with the lotto backend off | View/Pepe | L | Keep the backend on, retire the Pepe path |
| 6 | Owner pad-vault top-up | `padowner.js:426` | Refused, although the public Donate to the same vault takes unlinked accounts (`roomvaults.js:289`) | Server, inconsistent | H | Drop the check (same `roomvault.deposit` action) |
| 7 | Talking in a pad's live chat (relay, `!cmds`, push-to-talk, snapshots) | `bridge-relay.js:271,287,320,434` | 403: you can't talk in a pad without a Camfrog name | Server | H | Relay as the PATV username; keep `!cmds` linked until WP-C |
| 8 | Pad Pepe menu, DJ requests, cam/mic clips, web moderation | `padpepe.js:79`, `roomdj.js:236`, `camclip.js:115,150,255`, `micclip.js:176`, `padmod.js:262` | 403 | Server | M (mod and clips are genuinely Camfrog-room) | Account actor (WP-C) for DJ and the Pepe menu |
| 9 | Casino tables | `tables.js:334`, `views/casino.ejs:163` | Watch only | Server (seats queued to Pepe) | M | Account actor or the casino backend (already on staging) |
| 10 | Cosmetics buy/gift | `cosmetics.js:1074,1087` | Refused | Server (queued to Pepe) | M | Own by `userId` on the site |
| 11 | GTF sheet, heist market | `gtf.js:117`, `gtfsheet.js:300`, `heistmarket.js:462` | No sheet, can't trade | Server; sheets keyed by login | M | Key sheets `u:<id>` when unlinked (the GTF backend can) |
| 12 | Voice clone | `voiceclone.js:138`, `voicestore.js` | Refused | Server; consent and royalties by login | M (the recording is Camfrog-mic today) | Sign with the username, own by userId |
| 13 | Feed trust gates | `feedstore.js:531,534,1408,2148`, `dmmedia.js:97`, `stagecap.js:240` | A Camfrog link is the only trust signal besides level | Server | M | One `isVerified(u)` (any proven link: CF, Twitch, Discord, Telegram, Google, Plex), like `padcreate.linkedAny` |
| 14 | Telegram commands | bot side; `tg.need_camfrog` | Commands refused, chat works | Pepe | M | Account actor (WP-C) |
| 15 | DM/notice alerts | `public/js/messages.js:464,982` | Alerts only as Camfrog PMs | View; Camfrog is the channel | L | More alert channels (Telegram exists) |

Already neutral: gifts, tips and post tips; shop purchases; gangs (`gangs.js:257` falls back to `u:<userId>`); the
public pad-vault donate; pad create (default `create_link: "any"`); market betting; poll voting.

## (c) Structural and data-model dependencies

| # | Item | Where | Issue | Sev |
|---|---|---|---|---|
| 1 | One external identity column | `users.camfrogUsername` (unique `users_camfrog_login`); Twitch/Discord are columns; Google/Plex/Telegram in `sso_links`/`telegram_links` | No generic account ↔ chat identity table; every chat feature asks `camfrogUsername` | H |
| 2 | Bare-login keys | `stash_members.login`, `escrow_holds.login`, `gtf_records`/`gtf_ops`, `gang_members.member_key`, `ach_progress`, `voice_consents`, `voice_owned_logins`, `econ_participation`, `sb_plays`, `casino_rep_queue.camfrog NOT NULL`, `cosmetic_avatar_seeds.camfrog`, `camfrog_userstats`, `camfrog_roomstats`; `loginrekey.js` | A Twitch or IRC "bob" collides with Camfrog "bob"; re-keying on every link change | H |
| 3 | Website actions run "as the Camfrog name" | `actions.js:6,59-82`, `bridge-relay.js:24`, `padpepe.js:89` | No account actor in the site → Pepe contract (`roomvault.deposit` proves Pepe can charge an account) | H |
| 4 | One platform per pad; the pad id changes on connect | `rooms.js:56,80,102`; `padconnect.js:33,89,239`; `padrekey.js` | A pad can't bridge Camfrog and Twitch at once; connecting re-keys feed, vault and royalties | H |
| 5 | `platform === "camfrog"` gates | `boosts.js:235` (only Camfrog pads can be boosted / front-paged), `bridge.js:922,1010`, `padsettings.js:54`, `launchpad.js:516`, `public/js/pad-tabs.js:41,205`, `stagecap.js:225`, `aigen.js:162`, `padconnect.js:164` | Other pads lose the front page, boosts and the Live tab | M |
| 6 | Bridge identity | `bridge.js:474-490,544`; `padconnect.js:497` (Twitch chat stub) | PCP has a `connector` field nobody reads; members resolve via `camfrogUsername` only | M-H |
| 7 | Pad vault keyed `room:<id>`, held by Pepe | `roomvaults.js`, `pools.js:362`, `boosts.js:198`, `premium.js:499` | Survives only through re-keying | M |
| 8 | Stats are Camfrog-only | `userstats.js:23`, `roomstats.js:25` | No analytics for other services | M |
| 9 | Achievement ids `cf_*`; requirement text "Camfrog: …" | `achievements.json`, `achievements.js:32,45` | Naming; keys follow #2 | L |
| 10 | Mentions | `mentions.js` | Matches only the bridged Camfrog feed | L |
| 11 | "CF" auto accounts | `middleware/authGuard.js:143`, `telegram.js:150` (different regex), ~13 `LIKE 'CF%'` heuristics | Auto-account detection by name prefix | M |
| 12 | Help catalog | `help.js`, bot `help/catalog.json` | One syntax (`!cmd`), no per-service availability | L |
| 13 | `!verify` is the only link path offered for chat | `settings.connections.cf_hint`, all `*.link` copy | No neutral "link a chat account" flow | L |
| 14 | Plus gate and Pepe's room cap | `padconnect.js:164` (`["camfrog"]`), `premium.js` | "Prime Time Plus = Pepe in a Camfrog room"; the cap is Pepe's Camfrog client count | M |

## Proposed work packages (for the user to decide)

| WP | Scope | Covers | Effort | Needs |
|---|---|---|---|---|
| **A. Stale gates** | Wallet `canAct` split (loans/Reserve unlinked), wagers/bounties/pools gate on `gameLive()`, owner top-up check dropped, polls created as `🌐username`, lotto Pepe path retired | (b) 1 partly, 3, 4, 5, 6 | S (1 day) | Site only |
| **B. `isVerified(u)`** | One helper (any proven link) for media upload, DM pictures, stage capture, downvotes, pad `who=linked`, pad create | (b) 13 | S (half a day) | Site only |
| **C. Account actor for Pepe actions** | `actor {userId, username, login?}` on `pepe_actions` and relay jobs; Pepe runs by account and echoes the PATV name in rooms | (b) 7, 8, 9, 11, 12, 14; (c) 3 | M (3-4 days) | Bot change, ship bot first |
| **D. Site-side records** | `cmd=market` to `capital/markets`; stashes and staking by `u:<id>`; a donate handler; cosmetics owned by userId | (b) 1, 2, 10 | M (3-5 days) | Pepe must treat the site as source of truth for those |
| **E. Identity model** | `identities(user_id, platform, external_id, login)` + backfill; `users.auto_source`; login-keyed tables → `u:<userId>` (external logins as aliases); `loginrekey` becomes an alias update | (c) 1, 2, 8, 11, 13 | L (1-2 weeks) | Bot mirror change; a migration with backups |
| **F. Multi-connection pads** | Stable `patv:` pad ids; N rows in `pad_connections`; capability flags instead of `platform === "camfrog"`; no re-key on connect; Plus gate by capability | (c) 4, 5, 7, 14 | L (1-2 weeks) | E first; Pepe keys vaults and settings by pad id |
| **G. Connector-neutral bridge** | Read the PCP `connector`; members via identities; the Twitch chat hook; neutral stats and mentions; per-service command availability in the help catalog | (c) 6, 8, 10, 12 | M-L | E and F; bot connectors |
| **H. Owner surfaces + legal** | The owner-guide/panel copy above (after the other agents land), `build_owner_caps.py` strings, terms §1 wording with a dated note | (a) leftovers | S | Coordinate; legal review for terms |

Suggested order: A and B now (cheap, user-visible), then C (unblocks talking in pads and Telegram), then E → F → G as
the multi-service track.

## Status of work packages A-C (1.99wr onwards)

The user's direction (2026-10-13): most of this only needs a PATV account; the bridge relays chat under the PATV
username; owners don't need a Camfrog account; the PAT system lives outside Camfrog. A, B and C are done here; D-G are
kept for the v2 rewrite.

### A. Stale gates (1.99wr, site)

| (b) # | Feature | Before | After |
|---|---|---|---|
| 1 | Wallet | one `canAct = !!camfrog` hid stashes, staking, loans, the Reserve borrow form and donate | Per section. **Loans** (P2P) show while the escrow `loans` game runs on the site, the **Reserve** borrow form while the capital cluster is live (both take the account); the borrower / lender / position key is the username only while no other account has it as a chat login (`accountkey.gameName`). **Stashes / staking** are shown with why they still need a chat login (owner and members are chat names; Pepe moves stashes in and out of the vaults by login; keying them `u:<id>` is WP-D) and a link to Settings → Account → Connections. **Donate** stays with Pepe (see C). `/wallet/credit` (look up a borrower) takes any signed-in account |
| 3 | Wagers, pools, bounties | create / accept / bet / dispute forms needed a Camfrog link | each form shows while its escrow game is live on the site (`escrow/games.gameLive`), else for linked accounts only (Pepe's path) |
| 4 | Poll creation | refused without a link | created as `🌐<username>` (the name web votes already used); the author can end it |
| 5 | Lotto | gated with the backend off | unchanged on purpose: with `lotto_backend` on the page and the form already take the account (1.99ml); the Pepe fallback stays only for a site whose lotto still runs on Pepe (prod, until the lotto cutover) |
| 6 | Owner pad-vault top-up | - | verified: no link check since 1.99uu (`padowner.js` top-up -> `roomvault.deposit` from the account) |
| 11 | GTF sheet, heist market | link required | unchanged: a GTF character exists only for a chat login (heists happen in chat rooms; Telegram excludes them), so there is nothing to show an unlinked account. Wording points to Settings → Account → Connections |

The "Edit profile → Connections" wording in the remaining refusals now says "Settings → Account → Connections" (1.99vz
moved it).

### B. One `isVerified(u)` (1.99ws, site)

`verified.js`: any proven identity counts - a chat login (Camfrog `!verify`), Discord, Twitch (OAuth), Telegram (the
`/start` code from the user's own Telegram), Google (OIDC, self link) or Plex (a trusted link source). Each can be
linked to ONE PATV account only, so one identity can't vouch for a set of sock puppets. A verified email does NOT
count (a fresh address is free); level / age stay each gate's own fallback. Account rows from `feedstore.account`,
`stagecap.account` and `padcreate.account` carry their proofs; `isVerified(u)` is then synchronous.

| Gate | Protects against | Before | After |
|---|---|---|---|
| Feed media upload (`feedstore.postRefusal` media) | illegal / abusive uploads and storage abuse from throwaways | Camfrog link or level 2 | verified or level 2 |
| DM pictures (`dmmedia.pictureRefusal`, now async) | the same, in private | Camfrog link or level | verified or level |
| Stage snaps / clips (`stagecap.eligibility`) | harassment clips from throwaways | Camfrog link or level 2 | verified or level 2 |
| Downvotes count (`feedstore.downCounts`) | brigading with sock puppets | Camfrog link or level | verified or level |
| "New account" limits (`feedstore.isNewAccount`) | post / comment / report spam | Camfrog, Discord or Twitch | verified |
| Feed `require_link_to_post` | admin's "proven accounts only" | Camfrog link | verified |
| A pad's "who can post: linked" (`padSettings` label "Verified accounts") | owner's "proven accounts only" | Camfrog link | verified |
| Pad create, `create_link: "any"` (`padcreate.linkedAny`) | pad spam, slug squatting | Camfrog, Discord or Twitch | verified (`create_link: "camfrog"` stays an explicit admin choice) |

### C. The account as the actor (bot 1.99wt, site 1.99wv)

Every website action (`actions.js` claim, `tables.js` claim) and every relay job (`bridge-relay.takeJobs`) now carries
`user_id` and `actor` {userId, username, login, display}. Pepe (`pepe_acctactor.py`) acts as the linked chat login when
there is one, else as the **account nick `u:<userId>`**: `find_or_create_user` answers that PATV account by id (never
creates one), charges hit the account, `dn()` shows "🌐 <name>", it holds no roles, and nobody can type it as a chat
sender. It is the key `loginrekey.js` / `pepe_loginrekey.py` already use for an account with no login, so the records
follow the account to a chat login it links later. On the site, `userlinks.ul("u:<id>")` shows the account.

Compatibility: Pepe says `actor_cap: 1` on each claim / sync; the site offers the account-only paths only while it has
heard that in the last 10 minutes (`actorcap.js`). An old Pepe never says it, so an unlinked account keeps the old
refusals; an old site never sends `actor`, so a new Pepe refuses unlinked actions as before.

Relay lines from an account with no chat login go into the room as **"🌐 <PATV username> (PATV web): ..."** - the
username, never a free-text display name, and a label no chat login's relay gets ("(web)"). The site refuses an account
that hasn't proven an identity (`verified.js`), is archived / casino-restricted / feed-banned on that pad or site-wide,
whose username is another member's chat login, or whose line trips `textguard.js`; Pepe adds the room's ignore lists
(`u:<id>` or `🌐<username>`), time-outs, a casino restriction and his rate limit, logs it to the mod log, and never
remembers it (no incognito switch exists without a chat login, so it is treated as incognito).

| Surface | No chat login, now | Still needs a chat login (why) |
|---|---|---|
| Pad live chat (relay lines) | yes, as above | - |
| 🐸 Pepe menu (look / camroast / roast) | yes, charged from the account | - |
| Typed `!commands` from the relay, Manage panel | - | Pepe's dispatcher authorises them by the login's room roles / mod history |
| Push-to-talk clips, cam snapshots + Save snap, cam / mic clip saves | - | they act on a Camfrog room's mic and cams as a member of that room; audio can't be text-guarded |
| DJ panel (find / pick / skip / vibe ...) | yes (`u:<id>` requester) | DJ admin verbs stay Pepe-admin logins |
| Casino tables (legacy Pepe tables) | yes, seated as "🌐 <name>" | - (the casino backend already plays by account) |
| Donate to a pool (`/wallet`) | yes | - |
| Market create (`/markets`) | yes, creator `u:<id>` | - |
| Polls | yes (1.99wr: `🌐username` on the site's polls; `u:<id>` on Pepe's local polls) | - |
| Cosmetics buy / gift (`/cosmetics`) | yes; a gift to an unlinked account goes `@u:<id>` | - |
| Wagers, bounties, pools, P2P loans, lotto | yes on the site (A) | Pepe's local path while a site switch is off (keyed by login) |
| Stashes + vault staking, GTF sheet / avatar re-roll, heist market | - | still keyed by chat login (WP-D) |
| Voice clone (`!clonemyvoice`) | - | the consent is read on a Camfrog mic |
| Telegram commands | yes, as the account | `!patv`, `!avatar`, `!stash`, and `!relay` / `!tell` / `!message` (delivered in chat under a chat name) |
| Snap from stage capture / AI generate | unchanged (already by account at level 2) | - |
