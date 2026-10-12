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
- **(b)** added in 1.99tn.
- **(c)** admins only, for the reason given.

| Setting (bot key) | Class | Notes / reason |
|---|---|---|
| Cam snapshots `snap_enabled`, cam clips `clip_enabled`, mic challenges `challenge_enabled` | a | |
| Soundboard `soundboard_enabled` | a | inside the admins' master switch |
| Language `room_language` | a | |
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
| Pepe speaks at all `tts_enabled`, chatty mic chance `tts_chatty_chance`, starter mic chance `convo_mic_chance`, spoken alerts `alert_tts_enabled` / `alert_voice` | c | one shared VoiceBox and TTS queue for every room (GPU time) |
| Persona / costume `persona_active`, `avatar_costume` | c | global: one Pepe, one avatar for every room |
| Auto-DJ `auto_dj_enabled`, patter settings `dj_patter_*` | c | one Spotify and one DJ for every room; LLM spend |
| Room topic setter `auto_topic_enabled` / `autotopic_frequency` | c | rewrites the Camfrog room's /topic (pad verification codes live there) and spends LLM per topic |
| `!ask`, `!look`, roasts, cam roasts, `!imagine` overlay, research | c | LLM, vision and image spend (real money); roasts follow the room vibe |
| Command prices `pat_costs`, heist shop `shop_enabled`, wheel cooldown `spin_cooldown_s` | c | economy |
| Turf wars `game_turf_enabled` | c | economy, cross-room war map |
| Casino backend `!casino backend` | c | economy (site-run tables) |
| Automod rules + anti-abuse switch, `kickback_enabled`, `modfines_enabled` | c | safety and economy (fines go to the Fed) |
| Room bots, red list, DJ bans, ignored users, kick / modfine exemptions | c | they bypass abuse and economy rules. The owner has direct mod commands instead. |
| Website commands through the bridge `bridge_cmds` | c | web users spending PAT in the room through the relay. The owner can switch the whole relay off. |
| House ads `promo_enabled`, sponsors, banner bookings | c | one shared promo slot, revenue |
| Mic mechanics: `mic_slot_limit`, jukebox mic hold `mic_music_enabled`, `mic_alerts_enabled`, room auto-switch, music pause | c | one mic and one audio pipeline. A wrong slot count makes Pepe grab or bump the mic. |
| Spoken / transcribed language `tts_language`, `stt_*` | c | one transcriber for every room |
| Auto stickers `sticker_auto_enabled` | c | fragile native send path, staged rollout |
| Snapshot link lifetime `snap_expiry_hours` | c | storage on Pepe's shared disk |
| Chat-log / recording retention | c | set by the pad's tier (Prime Time / Plus), not a switch |
| Clip opt-ins (`!clipmic`, `!autoclip`) | n/a | per user, not per room |
