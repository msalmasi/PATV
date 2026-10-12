# Pads: ownership, connections and Prime Time Plus

How a pad gets an owner, how it is linked to a Camfrog room (or, later, a Twitch channel, Discord server or IRC
channel), and what 💎 Prime Time Plus has to do with it. The user set these rules on 2026-10-11 (site 1.99qy–1.99rd,
bot 1.99qz–1.99rc).

## 1. Ownership

**A pad's owner is whoever created it, or whoever a site admin assigned.** Nothing else.

- Stored in `rooms_registry`: `owner_kind` (`user` | `house` | `none`) and `owner_user_id`.
- A pad made on the site (`padcreate.js`) gets its creator as owner (`created_by` → `owner_user_id`).
- A site admin can set or clear an owner at any time: Pads admin → owners (`POST /api/rooms/admin/owner` →
  `rooms.setOwner`). `house` is the site's own pads (Pepe's Pad, PepeLab, the Lounge).
- Rooms Pepe saw before anyone made a pad for them have a registry row with `owner_kind = none` until an admin assigns
  one, or a member connects their own pad to the room (see §2).

Everything owner-only reads the registry:

| What | How it checks |
|---|---|
| Pad settings, moderation, flair, stage | `rooms.canManage(user, padId)`: the registry owner, plus site Admin / Staff |
| Room vault controls (payout rate) | `rooms.canManage` (`roomvaults.js`) |
| Owner royalties | `royalties.js` accrues to the registry owner at the moment of the spend (`royalty_ledger.owner_user_id`) and pays that account, whether or not the pad is still connected |
| The owner panel (`/p/<slug>/owner`) | `padowner.js`: `rooms.canManage` |
| Pepe's owner-only chat commands | `ownersForPepe()` sends the registry owner and their **linked** Camfrog login (`users.camfrogUsername`); `pepe_rooms._ro_is_owner` compares the chatter with that login. Linking your Camfrog name to your account is an account link, not a pad connection. |

**A connection never makes anyone an owner, and disconnecting never takes ownership away.**

## 2. Connections

A connection maps a pad to an outside room or channel, so Pepe and the site know where the pad's activity comes from
(chat, room spending → the pad's vault and the owner's royalties, the live view).

- Stored in `pad_connections`: `room_id` (the pad), `platform` (`camfrog` | `twitch` | `discord`, with `irc` reserved),
  `external_id` (the Camfrog room id, the Twitch login, …), `status` (`pending` | `review` | `verified` | …).
- **Camfrog.** The pad's owner asks for a code (`PATV-XXXXXX`). They prove they run the room by putting the code in the
  room's topic, or someone types `!verifypad`, which a site admin reviews. The proof secures the **mapping**, so nobody
  can point their pad at someone else's room and pull its activity in. On success the pad takes the room's id
  (`padrekey.js` re-keys it), and it keeps its owner, feed, follows, settings, address, Prime Time / Plus time and
  **its room vault** (§2a). Room-bound data stays with the room id: the bridge log, room stats and activity, and economy
  telemetry.
- **Twitch (pad-level).** A pad-level Twitch connection makes the pad a Twitch channel's room: today its Live tab embeds
  the channel's player; the chat bridge is coming later (`padconnect.twitchChatHook`). The owner's linked Twitch login is
  the proof that they run the channel. The pad keeps its id.
- **Discord / IRC.** The schema takes them, but there is no handler yet. A new platform needs an entry in
  `padconnect.PLATFORMS`, a connect / disconnect handler, and, if it should be gated, the platform name in
  `plus_gate_platforms`.
- **Disconnect** (camfrog): the pad goes back to its `patv:` id with its feed, owner, Plus and vault. The Camfrog room
  keeps its own data (activity, stats, the bridge log) and gets a fresh unowned registry row if Pepe is still in it.

### Account links are not pad connections

**The account-level Twitch link and a pad-level Twitch connection are two different things.**

| | Account link | Pad connection |
|---|---|---|
| What | Your PATV account's identity on another service | A pad that *is* a room on another service, with a chat bridge |
| Where | Edit profile → Connections; Sign in with Twitch / Google / Telegram / Plex (`twitchlogin.js`, `oauthlink.js`, `ssolinks.js`) | Pad settings → Address & platform (`padconnect.js`, `pad_connections`) |
| Used for | Signing in, achievements, proving who you are | The pad's room: the live view, its chat bridge, its vault, Pepe in it |
| Plus-gated | Never | Yes, per `plus_gate_platforms` (pad bridges) |

Linking your account's Twitch never creates, changes or removes a pad connection (`test/ptplus-rooms.test.js` checks the
account-link modules never touch `pad_connections`). A pad-level Twitch connect only *uses* the owner's account link as
proof that they run the channel.

**Pad bridges are the Plus-gated thing:** `camfrog` today, and `twitch`, `discord` and `irc` once their chat bridges
exist. Add a platform to `plus_gate_platforms` when its bridge ships. The Twitch pad connection is not in the default
list, because today it's a player embed with no bridge.

### 2a. The vault belongs to the pad

"The vault belongs to the pad" (the user, 2026-10-11). A pad's room vault, its owner's royalties and its launchpad state
follow the PAD through connect, disconnect and reconnect, even to a different Camfrog room.

- **On the site** (`padrekey.js`): the vault mirror, the owner's payout rate and its log (`room_vault_*`), owner
  royalties (`royalty_ledger`, `royalty_runs`), the room-flow escrow (`room_flow_ledger`) and the launchpad tables move
  with the pad.
- **The PAT itself** is Pepe's pool `room:<pad id>`, local or on the site's `pools.js` (Phase 1). Every re-key files a
  `pad_vault_rekeys` row `{from, to}`. The owner sync hands the open ones to Pepe.
- **Pepe** (`pepe_roomvault._rv_rekeys`):
  1. journals the move first (`econ_rooms.rekeys`);
  2. moves the balance `room:<from>` → `room:<to>` with `_vault_transfer`: two keyed legs, `rvrekey-<id>:out` / `:in`,
     the same on the local and the site pool paths (dual path: local only when the backend switch is explicitly off);
  3. moves the vault's day records and the launchpad grants;
  4. reports it done on the next sync.

  A retry never moves twice. Supply never changes: one pool goes down by exactly what the other goes up
  (`vaultrekey_test.py`).
- **Merge:** connecting to a room that already had an unowned pad adds the moving pad's vault onto that room's.
- **The 50M cap** doesn't apply to a re-key: it's the pad's own PAT.

## 3. 💎 Prime Time Plus gates connections

**Prime Time Plus is what lets a pad be connected to a Camfrog room, and what makes Pepe join that room.** Pepe can be in
5 Camfrog rooms at a time, so at most 5 pads have Plus at once.

| Setting (`premium_config`) | Default | Meaning |
|---|---|---|
| `plus_price` | 50,000,000 | PAT per 30 days |
| `ptplus_max_rooms` | 5 | Plus pads at once, comps included. Always applies to sales. |
| `plus_bridge_gate` | off | The master switch: Plus decides connections (below). Off = the old flow. |
| `plus_gate_platforms` | `["camfrog"]` | Which platforms need Plus to connect while the gate is on |

While the gate is on:

- **Connect:** a pad needs Plus to start a Camfrog connect. Buy Plus for the site pad first; it moves with the pad when
  it is re-keyed. `finishCamfrog` re-checks.
- **Pepe joins on his own.** The owner sync carries `plus_rooms` = connected Plus pads plus Plus pads' pending connects
  (`padconnect.plusRoomsForPepe`). Pepe's `pepe_plusrooms.py` joins those rooms, keeps them on auto-join, and never goes
  past 5 rooms.
- **Pepe leaves** a registered pad's room that drops off the list: its Plus ran out after grace, it was disconnected, or a
  code expired. He says goodbye first and switches its auto-join entry off. The owner was told 3 days before
  (`premium.plusLeaveNotices`). Pepe never leaves his home room, a house pad, or a room the site doesn't know.
- **The pad page** of a Camfrog pad without Plus shows "Connect your Camfrog room with Prime Time Plus (N of 5 spots
  left)" instead of the live room. The settings connect panel says the same.
- **Never on staging:** staging Pepe (PepeBeta) never acts on the list. The staging site's list names the real rooms.

The cap is checked inside the charge or comp transaction (`BEGIN IMMEDIATE`, so two buyers can't both take the last
spot). Buying, gifting, chipping in or comping **new** Plus time on a pad without it is refused when full. Renewing or
extending a Plus pad always works. When full, /premium shows **Sold out** and a waitlist (`premium_plus_waitlist`); everyone
on it is told when a spot frees.

Launch comps (`tools/ptplus-comps.js`) take spots:
- Pepe's Pad: no end date.
- Houseplants (`plant_based_chatting`): 3 periods (the user, 2026-10-11).
- PepeLab: where Pepe sits in it (staging).
- Players__lounge and DRAMA_CENTRAL: 3 periods each.

That makes 4 of 5 on prod.

## 4. Owner panel: Pepe's room settings (1.99tn audit)

The owner panel (`/p/<slug>/owner`, `padowner.js`) changes Pepe's settings for **that pad's Camfrog room only**. Each
change is the website action `room.owner`. Pepe re-checks that the acting account owns that pad (or is a site admin),
and writes to the same per-room storage as the chat commands and the admin panel's room scope. The site checks the
values, limits each account to 20 changes a minute per pad (Pepe limits each room the same way), and logs every
change to the pad's events (`room_events`, `pepe-setting`). The panel shows what Pepe actually has, from his owner
sync (`room_settings`, every 2 minutes and right after a change), never a default.

Owners never get anything that reaches other rooms, the economy, or real-money and LLM budgets. House pads (Pepe's
own room, DRAMA_CENTRAL and the other house rooms) have no user owner, so their admin settings and locks, such as the
DRAMA_CENTRAL vibe lock, stay with Pepe's admins.

### The pad's default voice

- **Choices.** The owner can pick any voice they own: one bought, gifted or comped (`voice_owned`), an unlock imported
  under their linked Camfrog login (`voice_owned_logins`), or their own approved clone. The voice has to be active and
  in VoiceBox. Someone else's clone only counts when its owner allows free text (D12). "Pepe's default" clears the
  room voice. The list comes from `voicestore.roomVoices`.
- **Three checks.**
  1. The site refuses a voice that isn't on the PAD OWNER's list. A staff member acting on the pad still only gets the
     owner's voices.
  2. Pepe refuses it when the action runs (`pepe_roomowner._op_voice_ok`). He checks the owner sync's `owner_voices`
     list, his voice-store cache and the voice's status.
  3. Pepe checks again **at every spoken line** (`_room_voice`). The pick is stored as the room's `tts_profile` plus
     `tts_profile_owner`.
- **When the owner loses the voice.** This covers a refund, a revoked clone consent, a paused or taken-down voice, or
  the pad changing hands. Pepe then speaks in his default voice in that room. The pick stays saved, so a paused voice
  comes back by itself. The panel explains why.
- **Precedence for a spoken line.** From strongest to weakest:
  1. the speaker's own `-v` voice (`!say … -v X`);
  2. the active persona's voice (Pepe-wide, set by admins);
  3. the room's default voice (this setting, or one an admin set);
  4. Pepe's global default.

  Alerts with their own `alert_voice` keep it.
- **Who pays.** Pepe's own lines in the room's voice (chatty, `!say` without `-v`, DJ patter, alerts) have no requester.
  They charge nobody a per-use price and pay no per-use royalty, the same as an admin-set room voice always did. The
  voice's owner was already paid their cut when the pad owner bought the unlock (the `voice_unlock` likeness cut). A
  user's own `-v` keeps its per-use price and royalty.

### Conversation starters

`convo` (on/off) and `convo_quiet` (5 to 240 quiet minutes, or "default") are `pepe_convo`'s `convo_enabled` and
`convo_quiet_min`, the same as `!convo on|off` and `!convo minutes <n>`. When a room goes quiet with at least two people
around, Pepe posts one starter for that quiet spell. While the Auto-DJ plays there, the DJ's next link opens the topic
instead. Starters need Pepe's chat model, which is Pepe-wide. When admins have it off, the panel says so.

### The audit: every per-room Pepe setting

Classes:
- **(a)** was already in the owner panel.
- **(b)** added in 1.99tn, or later where it says so (1.99up: the room topic, the auto-topic, the mic transcription
  language - moved out of (c) with the reasons in the table).
- **(c)** admins only, for the reason given.

Connection-specific settings (the topic, the transcription language) are stored per Camfrog room id today, which is the
pad's connection key (`pad_connections.external_id`). When another chat platform gets a bridge, its adapter implements the
same owner keys for its own channel (a Twitch title, a Discord channel topic) under that connection; the panel's copy
already says "your pad's chat room", not "Camfrog room".

| Setting (bot key) | Class | Notes / reason |
|---|---|---|
| Cam snapshots `snap_enabled`, cam clips `clip_enabled`, mic challenges `challenge_enabled` | a | |
| Soundboard `soundboard_enabled` | a | inside the admins' master switch |
| Pepe's CHAT language `room_language` | a | the language he writes and answers in (1.99jl). Not the transcription language. |
| Greetings `greeter_enabled` + `greeter_note` | a | |
| Chatty level `chatty_enabled` / `chatty_frequency` | a | |
| Music + DJ in the room `spotify_enabled`, song requests `music_queue_enabled` / `music_play_enabled` | a | |
| Games: trivia, pictionary, heist, wheel, bingo, duels / brawls / arena / showdown, casino tables (Hold'em + blackjack) | a | |
| `!say`, `-v` voices, `-mic` replies | a | |
| Global unblock, mic-hog policing, strike leeway (inside the admins' bounds), community votes | a | |
| Room vibe / roasts / vibe lock `room_vibe_*` | a | house rooms keep their admin lock (DRAMA_CENTRAL) |
| Bridge: relay, mic, cams, room audio, transcripts `bridge_*` | a | `/api/rooms/:slug/bridge` |
| Pepe join / leave / rejoin `owner_paused` | a | 💎 Plus pads, never his home room, never on staging |
| Room moderation + room roles (kick, ban, punish, mic block, timeout, fine, friend / mod / admin) | a | chat and the panel |
| What Pepe knows about the room `room_analytics` | a | `!roominfo` in chat |
| **Pad default voice** `tts_profile` + `tts_profile_owner` | **b** | owned voices only, see above |
| **Conversation starters** `convo_enabled`, `convo_quiet_min` | **b** | |
| **Captions of Pepe's mic lines** `mic_caption_enabled` | **b** | room-only, free |
| **Event alerts here** `alerts_enabled` | **b** | room-only (other rooms are unaffected) |
| **The DJ's spoken drops here** `dj_talk_enabled` | **b** | room-only; the LLM cap per hour stays global |
| **Room topic** (`!topic` / web action `room.topic`) | **b** (1.99up) | free for the owner in their own room, 6 an hour, text guard, never a pad code, a pending code kept. See "The room topic". |
| **Auto-topic** `auto_topic_enabled` / `autotopic_frequency` | **b** (1.99up, was c) | the user's decision ("Pepe's behaviour in their room"). LLM spend stays bounded by the admins' master switch `autotopic_master` and floor `autotopic_owner_min`; pad codes are protected by `_topic_send` like any topic. |
| **Mic transcription language** `stt_room_language` | **b** (1.99up, was c) | the transcriber is shared but the language is a per-request hint, so per room is safe. See "The mic transcription language". |
| Pepe speaks at all `tts_enabled`, chatty mic chance `tts_chatty_chance`, starter mic chance `convo_mic_chance`, spoken alerts `alert_tts_enabled` / `alert_voice` | c | one shared VoiceBox and TTS queue for every room (GPU time) |
| Persona / costume `persona_active`, `avatar_costume` | c | global: one Pepe, one avatar for every room |
| Auto-DJ `auto_dj_enabled`, patter settings `dj_patter_*` | c | one Spotify and one DJ for every room; LLM spend |
| The auto-topic's master switch `autotopic_master` and the owners' shortest interval `autotopic_owner_min` | c | LLM spend (one call per topic) |
| `!ask`, `!look`, roasts, cam roasts, `!imagine` overlay, research | c | LLM, vision and image spend (real money); roasts follow the room vibe |
| Command prices `pat_costs`, heist shop `shop_enabled`, wheel cooldown `spin_cooldown_s` | c | economy |
| Turf wars `game_turf_enabled` | c | economy, cross-room war map |
| Casino backend `!casino backend` | c | economy (site-run tables) |
| Automod rules + anti-abuse switch, `kickback_enabled`, `modfines_enabled` | c | safety and economy (fines go to the Fed) |
| Room bots, red list, DJ bans, ignored users, kick / modfine exemptions | c | they bypass abuse and economy rules. The owner has direct mod commands instead. |
| Website commands through the bridge `bridge_cmds` | c | web users spending PAT in the room through the relay. The owner can switch the whole relay off. |
| House ads `promo_enabled`, sponsors, banner bookings | c | one shared promo slot, revenue |
| Mic mechanics: `mic_slot_limit`, jukebox mic hold `mic_music_enabled`, `mic_alerts_enabled`, room auto-switch, music pause | c | one mic and one audio pipeline. A wrong slot count makes Pepe grab or bump the mic. |
| Spoken language `tts_language`; the transcriber's global rules `stt_language`, `stt_languages` (auto-detect allow-list), `stt_min_lang_prob`, `stt_user_languages` | c | one VoiceBox and one transcriber; per-person languages are Pepe admins' (a person, not a room). The room's own transcription language is the owner's (b). |
| Auto stickers `sticker_auto_enabled` | c | fragile native send path, staged rollout |
| Snapshot link lifetime `snap_expiry_hours` | c | storage on Pepe's shared disk |
| Chat-log / recording retention | c | set by the pad's tier (Prime Time / Plus), not a switch |
| Clip opt-ins (`!clipmic`, `!autoclip`) | n/a | per user, not per room |

### The room topic (1.99up)

The owner sets their connected room's topic from the panel (website action `room.topic` [room id, text]) or with
`!topic <text>` in the room. For the owner in their own room it is free (everyone else's `!topic` costs its price, admins
free). Both paths check the same things, on the site and again in Pepe (`pepe_roomowner._op_set_topic`):

- 2 to 200 characters, one line, no leading slash;
- the text guard (`textguard.js` on the site, `pepe_roomowner.TOPIC_BAD` in Pepe, the same list): slurs, sexual content
  about minors, threats, PAT scams, fake staff announcements, phone numbers and street addresses;
- at most 6 owner topic changes per room per hour (site per pad, Pepe per room; staff / Pepe admins exempt);
- an audit row: `room_events` "pepe-topic" on the site, the mod log "pepe_owner_topic" in Pepe.

**Pad verification codes.** A `PATV-XXXXXX` code in a room's topic is the room owner's proof that they run the room
(`padconnect.js`): only the room's owner / operators can set a topic in Camfrog. If Pepe set a topic that carried a code,
anyone could pay for `!topic PATV-XXXXXX` in a room they don't run and connect it to their own pad. So every topic Pepe
sets goes through one function, `_topic_send`:

- Text that looks like a code (`PATV` + any separators + 6 letters/digits, after NFKC and with invisible format characters
  removed) is refused: the owner's topic, the paid `!topic` and the auto-topic (a generated topic like that is dropped).
  This closed a real gap: before 1.99up the paid `!topic` put any text in the topic.
- A **pending** code (one the site's owner sync lists in `pad_verify`) that is in the room's topic right now is kept:
  Pepe appends it (` · PATV-XXXXXX`, inside the 200 characters), so changing the topic can't break a verification in
  progress. A code that isn't pending is not copied.
- The website path only ever sends to that room's own socket. When Pepe isn't in the room the action is refused (never
  a fallback room) and doesn't count against the limit.

**Auto-topic vs the owner's topic.** The owner's manual topic pauses the room's auto-topic for 6 hours
(`autotopic_paused_until`); switching the auto-topic on again in the panel ends the pause at once. The panel shows the
pause. A paid `!topic` from someone else only restarts the auto-topic's timer, as before.

### The auto-topic (1.99up)

The user's decision (2026-10-12): the auto-topic is Pepe's behaviour in the owner's room, so the owner controls it.

- `autotopic` on/off = the room's `auto_topic_enabled` (the same key as `!autotopic on|off`). Until the owner sets it,
  the room follows the global default (the panel says "Following Pepe's default").
- `autotopic_every` = one of 15 / 20 / 30 / 45 / 60 / 90 / 120 / 180 minutes, or "default" (the global slider). Stored as
  the room's `autotopic_frequency` on the admin slider's scale.
- **Cost guard (admins):** `autotopic_master` (default on) stops the auto-topic in every room; `autotopic_owner_min`
  (default 30 minutes) is the shortest interval in any room whose pad has a user owner, whatever the owner, the room or the
  global slider says. Both are in the admin panel's Conversation starters & topic card. House rooms aren't floored.
- Real state: Pepe's report carries `topic` = {text he last saw, paused_until, auto, running, every_effective} and
  `admin.autotopic_master` / `admin.autotopic_min`.

### The mic transcription language (1.99up)

**What the existing "Language" picker is:** `room_language` (1.99jl) is the language Pepe **chats in** in that room - his
replies, chatty lines, topics and starters. Its only effect on speech-to-text was a side one: a fixed non-English room
language is added to the admins' auto-detect allow-list (`_rl_stt_hint`). It never set the transcription language. The
panel now calls it "Pepe's chat language".

The new `stt_language` setting is the room's own **transcription** language (`stt_room_language`): "default" (follow the
global `stt_language`), "auto" (auto-detect each clip, with the admins' allow-list rules), or one fixed language from the
transcriber's list (`transcriber.LANG_NAMES`). It is the language hint sent with that room's mic clips
(`MicRecorder._language_for(username, room)`); a per-person forced language (`stt_user_languages`, admins) still wins.
The per-room net_audio recorders get the hook too (`_na_sync_recorder`) - they never had 1.99jl's `room_language_hint`
before, so that side effect now also works per room.

Backends: the transcriber is shared, but `language` is a per-request form field.
- Thor pepe-stt (live): `language=auto` -> Whisper large-v3 language ID, then English -> Parakeet, anything else -> Whisper;
  an explicit code skips detection: `en` -> Parakeet, any other code -> Whisper in that language. Parakeet is English-only,
  so it has no hint of its own; the routing is the fallback. The Thor app ignores the `languages=` allow-list (it uses its
  own LID_STRICT rules).
- CT 101 Whisper (standby): takes `language` directly (and the allow-list fields).
- The local GPU fallback (faster-whisper): `language=` the same way.

## 5. Pepe on your pad's page (1.99up)

The owner panel's 🌐 card (`padsite.js`, any pad, not only connected ones) collects what Pepe does on the pad's SITE side.
The site applies these itself (no Pepe round trip); each value shown is the effective one read back from the store that
enforces it, and Pepe follows it from his next feed sync.

| Group | Setting | Store | Default |
|---|---|---|---|
| | Pepe on this pad's feed | `pepefeed` scope `enabled` | on |
| Posts | His own posts | `pepefeed` `posts` (unset = the old `auto`) | off |
| | Which kinds (recaps, questions, music picks, news, snaps) | `pepefeed` `kinds` (unset = all) | all |
| | Posts a day (1, 2, 3, 5, 10) | `pepefeed` `posts_per_day` | 1 |
| | Go-live / now-playing announcements in the pad | `golive_pad.announce` | on |
| Comments | Answer mentions | `pepefeed` `respond` | on |
| | Comment on his own | `pepefeed` `comments` (unset = `auto`) | off |
| | How chatty: low 4/day 60 min apart, normal 10 / 30, high 25 / 15 | `comments_per_day` + `gap_min` | normal |
| Moderation | Pepe's feed moderation | `feedautomod` `on` | off |
| | How strict: relaxed (none / flag / hide), standard (flag / flag / hide), strict (flag / hide / remove) for minor / serious / severe | `feedautomod` severities | standard |

- **Inheritance.** Every setting follows the default until the owner changes it ("Default: on"); "Reset to default"
  removes the stored value (`pepefeed.resetScope`, `golive.resetPadAnnounce`, the automod defaults). A setting counts as
  changed when this card set it (`pad_site_overrides`) or when its stored value differs from the default (the pad settings'
  Pepe tab writes the same stores and still works).
- **Bot.** The sync's scope entry now carries `posts`, `comments` and `kinds` (and `auto` = either, for an older bot);
  `pepe_feed.pf_gate` reads them and `_pf_kind_ok` skips a kind the pad doesn't allow before any model call. The site
  refuses a post of a kind the pad keeps out (`pepefeed.post`).
- **Limits and audit.** 20 changes a minute and 100 an hour per account and pad (staff exempt); every change and reset is a
  `room_events` "pepe-site" row, on top of `pepe_feed_log` and "feed-automod-settings".
- **A site admin's lock** (`admin_lock` on the Pepe or the automod settings) still holds: the card shows it and refuses.

**The safety floor - not owner settings:** image safety on uploads (`imagesafety.js`), reports and the admins' review
queue, the TAKE IT DOWN process (`takedown.js`), the CSAM escalation (always at least hidden, admins told, whatever the
pad says), and - new in 1.99up - while Pepe's feed moderation is on, a **severe** verdict (illegal content, doxxing,
credible threats, NCII) is at least hidden (`feedautomod.SEVERE_FLOOR`, applied when settings are read and in `decide`).
Owners only choose Pepe's optional extras and how strict they are above that floor. Pepe's feed moderation itself stays
opt-in per pad (default off), as before.
