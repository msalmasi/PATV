# v1 chat tickets and the hub seam

Site 1.99acf. The S0 pieces of the native chat plan that live in v1: chat tickets with their JWKS, and the first slice of
the v1 seam (the hub outbox, the revoke hook, the request-time incognito call, the `econ/committed` callback, the
heartbeat). Everything here is off until it is configured, and nothing is sent while no hub address is set.

## Chat tickets (`chatticket.js`)

```
POST /api/chat/ticket          same-origin fetch, X-Requested-With: fetch, a signed-in session
  -> {"ok":true,"token":"<JWT>","exp":<unix s>,"kid":"v1-2026-10"}      Cache-Control: no-store
GET  /.well-known/patv-jwks.json
  -> {"keys":[{"kty":"OKP","crv":"Ed25519","x":"…","kid":"v1-2026-10","alg":"EdDSA","use":"sig"}, …previous]}
     Cache-Control: public, max-age=300
```

The ticket is a compact JWS, header `{"alg":"EdDSA","typ":"JWT","kid":…}`, valid for 5 minutes. Its claims are display
hints only:

| Claim | Value |
|---|---|
| `iss` / `aud` | `patv-v1` / `patv-rt` (the same on staging; the keys differ, so a staging ticket fails at prod) |
| `sub` | `users.userId` (a UUID). A legacy non-UUID id becomes `uuidv5(id, CHAT_GENESIS_NS)` when that is set, else the request is refused with `E_LEGACY_ID`. |
| `sid` | `sessions.id[:32]` (`sessions.id` is already the SHA-256 of the cookie's sid) |
| `iat`, `exp` | `exp = iat + 300` |
| `cls` | `users.class`, lower-cased |
| `ver` | `verified.verify()` (any proven identity) |
| `lvl` | `users.level` |
| `nsfw` | `false` (v1 has no server-side opt-in) |
| `scp` | `["chat"]` |
| `pp` | `"web"` |
| `kid` | also in the payload, as in the design's example |

Refusals are codes only: `503 E_FEATURE_OFF` (switch off or no key), `403 E_CSRF`, `401 E_AUTH` (no live session; a revoked
one included), `403 E_ARCHIVED`, `429 E_RATE` (20 a minute per session, 200 an hour per account, with `Retry-After`),
`409 E_LEGACY_ID`. The token never appears in a URL or a log.

### Keys

Environment only, per environment:

```
CHAT_TICKET_KEY       base64 PKCS8 DER Ed25519 private key (signs)
CHAT_TICKET_KID       e.g. v1-2026-10 (staging v1stg-2026-10), ^[A-Za-z0-9._:~-]{1,64}$
CHAT_TICKET_PREV_PUB  the previous key (base64 SPKI DER, or its PKCS8 key), JWKS only
CHAT_TICKET_PREV_KID  its kid
CHAT_GENESIS_NS       optional UUID namespace for legacy ids
```

No key (or an unusable one, logged once by variable name, never by value) means tickets are off and the JWKS answers 404.
With a key, the JWKS is served even while the `tickets` switch is off, so the hub can fetch it first.

Tickets are minted only while the `sessions` and `heartbeat` switches are on too: without the revocation feed a sign-out,
ban, password reset or merge never reaches the hub, and its 12-hour resume credential (bound to the ticket's `sid`) and
open sockets would outlive the v1 session; the hub's 30-minute grace rides the heartbeat. `/admin/keys#seam` refuses to
turn `tickets` on (or `sessions` / `heartbeat` off under it), and a row forced past that still answers `E_FEATURE_OFF`.

Make a key with `node tools/chat-ticket-key.js --out <new file> [--kid v1-YYYY-MM]`. It writes a new 0600 file, refuses
stdout and existing files, and prints only the kid and the public `x`.

**Rotation**: `node tools/chat-ticket-key.js --out <new file> --kid <new kid> --prev-from <the current key file>`,
replace the four lines in the site's `.env`, restart. The hub caches the JWKS for 5 minutes and tickets live 5 minutes,
so old tickets still verify through the overlap. Drop the PREV lines at the next rotation.

## The hub outbox (`huboutbox.js`)

```
hub_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, topic, entity, payload, created_at, posted_at, dedupe_key)
```

**Deviation from the design** (§1.7 sketches `id integer primary key`): the ids are `AUTOINCREMENT`, so they are never
handed out twice, even after cleanup empties the table (a quiet staging, switches off and on). The heartbeat's
`outbox_head`, the hub's `v1_feed_pos` and `outbox/rewind{after_id}` all rely on ids only ever going up; a plain rowid
would restart at 1 and the hub would drop new revocations as already applied. `deploy/refresh-staging-db.sh` drops prod's
rows from a refreshed staging copy and carries staging's sequence on.

- **Trigger rows** carry only `(topic, entity)`; the poster reads the entity's current state when it posts.
- **`emit()` rows** carry their payload. `emit()` runs only inside the action's `dbUtils.tx` (it throws otherwise), so the
  row commits or rolls back with the action, and it is deduped on `dedupe_key`.

### Poster contract

While `HUB_V1_URL` and `HUB_V1_KEY` are set, the poster wakes on every emit and polls every second. For each topic with
pending rows it posts at most 300 rows, in `id` order:

```
POST {HUB_V1_URL}/internal/v1/{topic}
{"rows":[{"id":123,"topic":"sessions/revoked","entity":"sid:…","payload":{…},"created_at":1760727600000}, …]}
```

Rows are marked posted only on a 2xx. Each topic has its own failure state: a topic the hub refuses (a 404 from an
endpoint it hasn't built yet, a 500) backs off from 1 s to 30 s on its own, and the other topics keep posting in the same
pass, so a revocation never waits behind another topic. Order is kept within a topic. `/admin/keys#seam` lists a topic
that is backing off. The hub applies a row only if its `id` is above what it has for that `(topic, entity)`, so retries
and duplicates are harmless. Posted rows are deleted after 7 days. While no hub is configured, unposted rows older than 7
days are deleted too (the hub bootstraps from snapshots, R-14).

`HUB_V1_PROXY` (`host:port`, the userspace tailscaled HTTP proxy: 1055 prod, 1056 staging) is used for an `http://` hub
(absolute-URI requests). HTTPS through CONNECT is left to the network-plane work. Nothing is posted to a plain `http://`
hub address that isn't loopback unless `HUB_V1_PROXY` carries it (the tailnet, §1.4 / §16): session ids, account ids and
privacy subjects never cross a network in cleartext. The status error is `insecure_url`, shown on `/admin/keys#seam`.

### Every request is signed (`hubsign.js`)

```
X-PATV-Key-Id   HUB_V1_KEY_ID
X-PATV-Ts       unix seconds (±60 s)
X-PATV-Nonce    16 random bytes, hex (a cache refuses replays while the timestamp is in the window)
X-PATV-Sig      v1=<hex HMAC-SHA256(HUB_V1_KEY, METHOD "\n" path "\n" ts "\n" nonce "\n" hex(sha256(body)))>
```

`path` is the request path with its query string, `body` the exact bytes sent. Test vector: key `test-key-not-real`,
`POST /internal/v1/heartbeat`, ts `1760727600`, nonce `00112233445566778899aabbccddeeff`, body `{"v":1}` (sha256
`afbf9d0f3560b0fd7795e81c42a0a79ee6b6fc67e064f77826aee642cad28d91`) →
`v1=d74f5230393ff8b27f916e4089692954d0135d024e45f87962d7e974927ad31d`. `verify()` is exported for the inbound side. It
remembers a nonce until its timestamp leaves the ±60 s window (`ts + 60 s` plus a 5 s margin); only expired nonces are
evicted, and a cache full of live nonces refuses new requests with `busy` (answer 503) instead of forgetting them. The
cache is in memory, so a restart reopens the window for requests captured in the last two minutes.

### Topics

| Topic | Source | Entity | Payload |
|---|---|---|---|
| `sessions/revoked` | trigger on `sessions.revoked_at` (any writer, CLI scripts too) | `sid:<sessions.id>` | read at post time: `{kind:"session", sid: id[:32], account, v1_user, at, until, why}` (`{kind:"session", sid, gone:true}` if the row is gone) |
| `sessions/revoked` | `sessions.revokeAll()` with nothing excepted: sign out everywhere, admin, feed ban, password reset, deletion request | `acct:<userId>` | `{kind:"account", account, v1_user, before, why}`: close every socket whose credential `iat < before` (4003) |
| `sessions/revoked` | `sessions.revokeForMerge()` | `acct:<fromId>` | `{kind:"merge", account, into, v1_user, v1_into, before}`: close with 4005 |
| `privacy/changed` | `incognito.request()` (web), in the action's transaction, before Pepe answers | `camfrog:<login>` or `acct:<userId>` | `{flag:"incognito", value, phase:"requested", via:"web", subject, at}` |
| `privacy/changed` | `incognito.sync()` (Pepe's report), linked and unlinked logins | same | `{flag:"incognito", value, phase:"confirmed", via, subject, at}` |
| `econ/committed` | `idemBegin` `done()` for a key starting `ix:` | the key | `{key, tx, outcome:{status, ok, code}, endpoint, at}` (refusals with a stored status included) |

`subject` is `{platform:"camfrog", login, acct?, v1_user?}`, or `{acct, v1_user}` for an account key. Never any line
text. Hub rule: apply an incognito ON at `requested`, an OFF only at `confirmed`. "Sign out everywhere else" and a password
change keep the current device, so they send only the per-session rows. No v1 path issues `ix:` keys before S4 / S7a.

**Account ids.** Every account field (`account`, `into`, `subject.acct`) is the hub's `account_id`: exactly the ticket's
`sub` (`chatticket.subjectOf(users.userId)`: the userId when it is a UUID, a legacy id → `uuidv5(id, CHAT_GENESIS_NS)`,
`null` while that namespace isn't set - such accounts get no tickets either). The raw `users.userId` rides beside it as
`v1_user` (`v1_into` for a merge's target). The `entity` stays v1's own ordering key (`acct:<users.userId>`).

**Units.** `before` is epoch **seconds**, rounded up - the unit of the ticket's `iat`, so the hub compares `iat < before`
directly. Every other time field is epoch **milliseconds**: `at`, `until`, `created_at` (rows and payloads) and the
heartbeat's `at`.

### Heartbeat

Every 30 s while configured and the `heartbeat` switch is on: a signed `POST {HUB_V1_URL}/internal/v1/heartbeat` with
`{v:1, env:"prod"|"staging", at, outbox_head: MAX(hub_outbox.id), jwks_kids:[current, previous], version}` (`at` in epoch
milliseconds).

## Switches (`/admin/keys#seam`)

`hubseam_settings`: `tickets`, `heartbeat`, `sessions`, `privacy`, `econ` (all off) and `spans` (on). A topic whose switch
is off writes nothing. `tickets` can only be on together with `sessions` and `heartbeat` (above).

## Bridge spans (`bridgespans.js`)

`bridge_spans(room_id, session, opened_at, last_seen, closed_at, close_reason)` records when each Camfrog room was bridged,
from Pepe's syncs, for the later VM-log import (R-10). A span opens on the first sync that carries the room, closes on
`closed[]` (`closed`), a `room.left` event (`left`), or 10 minutes without the room (`timeout`, at `last_seen + 10 min`).
It only records and never affects the sync.

## Environment summary

`CHAT_TICKET_KEY`, `CHAT_TICKET_KID`, `CHAT_TICKET_PREV_PUB`, `CHAT_TICKET_PREV_KID`, `CHAT_GENESIS_NS`, `HUB_V1_URL`,
`HUB_V1_KEY_ID`, `HUB_V1_KEY`, `HUB_V1_PROXY` (names in `.env.example`, no values).
