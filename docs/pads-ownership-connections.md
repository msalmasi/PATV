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
  (`padrekey.js` re-keys it), and it keeps its owner, feed, follows, settings, address and Prime Time / Plus time.
  Room-bound data stays with the room id: the bridge log, room stats and activity, Pepe's room vault pool, and economy
  telemetry.
- **Twitch.** The owner's linked Twitch login is the proof; the pad keeps its id.
- **Discord / IRC.** The schema takes them, but there is no handler yet. A new platform needs an entry in
  `padconnect.PLATFORMS`, a connect / disconnect handler, and, if it should be gated, the platform name in
  `plus_gate_platforms`.
- **Disconnect** (camfrog): the pad goes back to its `patv:` id with its feed, owner and Plus. The Camfrog room keeps
  its own data and gets a fresh unowned registry row if Pepe is still in it.

> Known limit: a room vault is Pepe's pool keyed by the Camfrog room id (`room:<room id>`, `pepe_roomvault.py`). It
> belongs to the room's activity. After a disconnect its balance stays with the room; the owner's royalties do not,
> they stay with the owner. Moving a vault pool with a pad would need a Pepe-side re-key (not built).

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

Launch comps (`tools/ptplus-comps.js`) take spots: Pepe's Pad (no end), PepeLab where Pepe sits in it (staging), and
Players__lounge and DRAMA_CENTRAL for 3 periods each.
