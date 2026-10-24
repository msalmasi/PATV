# v1 chat tickets and the hub seam

Site 1.99acf + 1.99acm. The S0 pieces of the native chat plan that live in v1: chat tickets with their JWKS, the v1
seam (R-14: the hub outbox, the revoke hook, the request-time incognito call, the `econ/committed` callback, the heartbeat,
1.99acm: the private-activity and `hidden_h` feeds, snapshots, rewind) and v1's half of the privacy seam (R-12, 1.99acm:
account deletion, "Make Pepe forget me" and the export call). Everything here is off until it is configured, and nothing is
sent while no hub address is set. The decisions behind 1.99acm are the "seam plan" D-numbers cited in the code comments; they are
kept with the hub (`docs/seam-plan.md` in the platform repo).

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

`HUB_V1_URL` is an **origin** (no path): the signature covers the raw request target, so a proxy or a path prefix that
rewrote it would fail verification (status `url_path`). The outbound key id must be `v1-<env>-<n>` for this site's
environment (`HUB_V1_ENV`: `prod`, `staging`, `test` or `dev`; empty = `staging` when `STAGING` is set, else `prod`);
another one is never used (status `key_env`, an unknown `HUB_V1_ENV` is `bad_env`). The hub accepts only `v1-<its env>-…`
ids, and v1 only `hub-<its env>-…` ids, so a staging key or a key of the other direction fails even if a proxy were
miswired.

### Poster contract

While `HUB_V1_URL` and `HUB_V1_KEY` are set, the poster wakes on every emit and polls every second. For each topic with
pending rows it posts at most 300 rows, in `id` order:

```
POST {HUB_V1_URL}/internal/v1/{topic}
{"rows":[{"id":123,"topic":"sessions/revoked","entity":"sid:…","payload":{…},"created_at":1760727600000}, …]}
```

The hub answers 2xx only after its transaction has committed, so "posted" means "applied". Rows are marked posted only
on a 2xx. Each topic has its own failure state: a topic the hub refuses (a 404 from an
endpoint it hasn't built yet, a 500) backs off from 1 s to 30 s on its own, and the other topics keep posting in the same
pass, so a revocation never waits behind another topic. Order is kept within a topic. `/admin/keys#seam` lists a topic
that is backing off. The hub applies a row only if its `id` is above what it has for that `(topic, entity)`, so retries
and duplicates are harmless. Posted rows are deleted after 7 days. While no hub is configured, unposted rows older than 7
days are deleted too (the hub bootstraps from snapshots, R-14).

`HUB_V1_PROXY` (`host:port`, the userspace tailscaled HTTP proxy: 1055 prod, 1056 staging) is used for an `http://` hub
(absolute-URI requests). HTTPS through CONNECT is left to the network-plane work. 1.99acm: a plain `http://` hub address
is used only when its host is loopback or on the tailnet - `127.0.0.0/8`, `::1`, `localhost`, `100.64.0.0/10`,
`fd7a:115c:a1e0::/48` or `*.ts.net`, the hub's own rule for `SEAM_V1_URL` - whether `HUB_V1_PROXY` is set or not
(tailscaled's proxy dials any other host directly, in the clear): session ids, account ids and privacy subjects never cross
a network in cleartext. The status error is `insecure_url`, shown on `/admin/keys#seam`. An outbound key equal to an
inbound one (`HUB_V1_IN_KEY` / `HUB_V1_IN_PREV_KEY`) is never used either: `key_reuse`.

### Every request is signed (`hubsign.js`)

```
X-PATV-Key-Id   HUB_V1_KEY_ID
X-PATV-Ts       unix seconds (±60 s)
X-PATV-Nonce    16 random bytes, hex (a cache refuses replays while the timestamp is in the window)
X-PATV-Sig      v1=<hex HMAC-SHA256(HUB_V1_KEY, keyId "\n" METHOD "\n" path "\n" ts "\n" nonce "\n" hex(sha256(body)))>
```

`keyId` is the `X-PATV-Key-Id` value as sent (1.99acm: signed too, so a captured request can't be relabelled with another
key id that happens to share the secret - staging and prod, or the two directions), `path` the request path with its
query string, `body` the exact bytes sent. The key is the UTF-8 bytes of the configured
string (never decoded). **Shared vectors** (1.99acm): `test/fixtures/hubseam-sign-vectors.json` is byte-identical in the hub
repo (`services/rooms/test/fixtures/`), and both repos pin its sha256, so a change on one side fails until the other is
updated. It holds positive vectors in both directions (expected headers), negative vectors with their refusal codes, the
`hidden_h` hashes and the `why` → reason table; `node tools/hubseam-vectors.js` checks it against `hubsign.js` (`--write`
regenerates the computed fields). `hubsign.verifyFrom({dir, env, …})` is the receiver: refusals in this order - `missing`,
`wrong_env` (a seam-shaped key id of the other direction or another environment), `unknown_key`, `stale`, `missing` (nonce
format), `bad_sig`, `replay`, `busy`. Test vector: key `test-key-not-real`,
`POST /internal/v1/heartbeat`, ts `1760727600`, nonce `00112233445566778899aabbccddeeff`, body `{"v":1}` (sha256
`afbf9d0f3560b0fd7795e81c42a0a79ee6b6fc67e064f77826aee642cad28d91`) →
`v1=270a385ccba6ace561f8c1715198d39260435a33c0d61c721c5b5b533f26a18a` (key id `v1-prod-1`). `verify()` is exported for
the inbound side. It remembers a nonce until its timestamp leaves the ±60 s window (`ts + 60 s` plus a 5 s margin); only
expired nonces are evicted, and a cache full of live nonces refuses new requests with `busy` (answer 503) instead of
forgetting them. That cache is in memory - a fast path: 1.99acm, the inbound routes also take every nonce durably (see
"Calls into v1"), so a restart doesn't reopen the window.

### Topics

| Topic | Source | Entity | Payload |
|---|---|---|---|
| `sessions/revoked` | trigger on `sessions.revoked_at` (any writer, CLI scripts too) | `sid:<sessions.id>` | read at post time: `{kind:"session", sid: id[:32], account, v1_user, at, until, why}` (`{kind:"session", sid, gone:true}` if the row is gone) |
| `sessions/revoked` | `sessions.revokeAll()` with nothing excepted: sign out everywhere, admin, feed ban, password reset, deletion request | `acct:<userId>` | `{kind:"account", account, v1_user, before, why}`: close every socket whose credential `iat < before` (4003) |
| `sessions/revoked` | `sessions.revokeForMerge()` | `acct:<fromId>` | `{kind:"merge", account, into, v1_user, v1_into, before}`: close with 4005 |
| `privacy/changed` | `incognito.request()` (web), in the action's transaction, before Pepe answers | `cfh:<login hash>` or `acct:<userId>` | `{flag:"incognito", value, phase:"requested", via:"web", subject, at}` |
| `privacy/changed` | `incognito.sync()` (Pepe's report), linked and unlinked logins; 1.99acm: also every key Pepe's full list (`full`) turns ON or OFF, in one transaction with that heal | same | `{flag:"incognito", value, phase:"confirmed", via, subject, at}` |
| `privacy/changed` | 1.99acm: trigger on `profile_layout` (any write) | `pa:<userId>` | read at post time: `{flag:"private_activity", value, subject:{acct, v1_user}, at}` - the Analytics section or its Rooms panel hidden (`stories.privateLogins`' rule; an unreadable layout counts as private) |
| `privacy/changed` | 1.99acm: trigger on `hub_hidden_h` (`hubhidden.js`: Pepe's `hidden_h` from each bridge sync, only the difference written; 1.99add: sticky - a row goes only on an explicit un-hide, never because a list lacks it; incognito ON reports and website ON requests add at once; refix 4: also a change of its `scope`) | `hh:<h>` | read at post time: `{flag:"hidden_h", h, value, at}` + `scope: "incognito"` when only incognito hides it (shown as "someone"; absent = left out) (20-hex hashes only, never a login) |
| `privacy/account-deleted` | 1.99acm: `accountdelete.execute()`, in the deletion's transaction | `acct:<userId>` | `{acct, v1_user, pseudonym, remove_public, request:<account_deletions.id>, at}` (S1 V4: `remove_public` = the row's choice) |
| `privacy/forget` | 1.99acm: `pepeforget.request()` / `fromBot()` (linked accounts only), in the request's transaction | `forget:<pepe_forget_log.id>` | `{subject_kind:"acct", acct, v1_user, scope:"bot", ref, at}` |
| `econ/committed` | `idemBegin` `done()` for a key starting `ix:` | the key | `{key, tx, outcome:{status, ok, code}, endpoint, at}` (refusals with a stored status included). The hub has no intake for it before R-4 (404; the topic backs off on its own). |

`subject` is `{platform:"camfrog", login_h, acct?, v1_user?}`, or `{acct, v1_user}` for an account key. 1.99acm (seam
plan D-6): a chat login never leaves v1 - its entity is `cfh:<h>` and its subject carries `login_h`, both
`hubhidden.loginHash(login)` (`sha256("pepe-hidden:" + lower(trim(login)))[:20]`, `quotes.hiddenHash`'s form), so the hub
stores no plaintext login anywhere (its feed positions and privacy mirror are keyed by the hash). Never any line text. Hub rule: apply an incognito ON at `requested`, an OFF only at `confirmed`. "Sign out everywhere else" and a password
change keep the current device, so they send only the per-session rows. No v1 path issues `ix:` keys before S4 / S7a.

**Account ids.** Every account field (`account`, `into`, `subject.acct`) is the hub's `account_id`: exactly the ticket's
`sub` (`chatticket.subjectOf(users.userId)`: the userId when it is a UUID, a legacy id → `uuidv5(id, CHAT_GENESIS_NS)`,
`null` while that namespace isn't set - such accounts get no tickets either). The raw `users.userId` rides beside it as
`v1_user` (`v1_into` for a merge's target). The `entity` stays v1's own ordering key (`acct:<users.userId>`).

**Units.** `before` is epoch **seconds**, rounded up - the unit of the ticket's `iat`, so the hub compares `iat < before`
directly. Every other time field is epoch **milliseconds**: `at`, `until`, `created_at` (rows and payloads) and the
heartbeat's `at`.

An account deletion names the account only - 1.99acm: never the released chat login nor a hash of it (an unkeyed hash of a
short public username is reversible by dictionary, and the hub's deletion journal is write-once under Object Lock; the
hub's erasure works on the account's lines, and an identity-scoped erasure is S2's, with its own design).
`remove_public` is the member's "Also remove my public messages" (S1 V4, below; `false` without it, and on every deletion
before it). "Make Pepe forget me" is scope `bot` (DMs with Pepe and his memory, never public lines); a login with no linked
account sends nothing (identity-scoped requests are S2's `privacy/idn-request`).

### Heartbeat

Every 30 s while configured and the `heartbeat` switch is on: a signed `POST {HUB_V1_URL}/internal/v1/heartbeat` with
`{v:1, env, at, outbox_head, jwks_kids:[current, previous], version, switches, topics}` (`at` in epoch milliseconds).
1.99acm: `env` is `HUB_V1_ENV`; `outbox_head` is the AUTOINCREMENT high-water mark (`sqlite_sequence.seq`, never
`MAX(id)`, which is 0 on an emptied table); `switches` are the seam switches (`spans` excepted); `topics` has
`{head, pending, oldest_pending_at}` for every topic with rows and every topic whose switch is on - the hub measures lag
and privacy staleness from it.

## Calls into v1 (`hubinbound.js`, 1.99acm)

Signed by the hub with `hub-<env>-<n>` (`HUB_V1_IN_KEY_ID` / `HUB_V1_IN_KEY`, plus `HUB_V1_IN_PREV_KEY_ID` /
`HUB_V1_IN_PREV_KEY` during a rotation). Without a valid inbound key the routes answer 404. The signature covers
`req.originalUrl` (path and query exactly as sent) and the raw body: the site's JSON and form parsers skip `/internal/`.
Refusals: `missing`, `unknown_key`, `wrong_env`, `stale`, `bad_sig` → 401, `replay` → 409, `busy` → 503 with
`Retry-After: 2`; the answer carries the code only. Every answer is `Cache-Control: no-store`; logs carry the route, the
code and counts - 1.99acm: refusal warnings at most one line per code per minute (the counters keep the totals). The hub
reaches the routes over the tailnet (`tailscale serve` forwarding `/internal/v1/` unchanged); the public nginx must answer
404 for `/internal/` case-insensitively (`location ~* ^/internal/ { return 404; }`, checked by `deploy/check-internal.sh` -
deploy/README.md, an operator step before the inbound key is set). Defence in depth, before anything is parsed or verified
and with no log line: a target that isn't exactly the lowercase `/internal/v1/` prefix (Express mounts are
case-insensitive), or a request carrying Cloudflare's `cf-ray` / `cf-connecting-ip` headers, is a bare 404 (counted as
"reached through the public site" on `/admin/keys#seam`).

**Replays** (§16): besides `hubsign`'s in-memory cache, every verified request's nonce is taken durably, INSERT-first, in
`hub_inbound_nonces(key_id, nonce, until)` - kept until the later of now and its timestamp, plus 10 minutes (the hub's
rule) - before a snapshot page is served and inside the rewind's own transaction (a rewind that fails leaves no nonce).
A v1 restart or deploy therefore never reopens the window. `huboutbox.cleanup()` sweeps expired rows hourly.

```
GET  /internal/v1/snapshot/<topic>?cursor=<opaque>
  -> {v:1, topic, head, range:{after, through}, rows:[{entity, payload}], next, complete}     404 while the topic's switch is off
POST /internal/v1/outbox/rewind {topic, after_id}
  -> {ok, reposted, oldest_kept_id, head}
```

**Snapshots** list a topic's current **non-default** state in pages of 500, in byte order of the entity (SQLite BINARY,
the hub's `COLLATE "C"`), with the payloads the feed carries. `head` is the outbox high-water mark, read first in the same
SQLite transaction as the rows, so every row is at least as new as it: the hub applies a page row only where its feed
position is at or below `head`. `range.after` is the cursor's entity (null on the first page) and `range.through` this
page's last entity (null on the last page = to the end); the hub resets `privacy/changed` entities it holds inside the
range but absent from the page. The cursor is base64url JSON `{k:<last entity>, s:<source>}`, opaque to the hub. Sources:

| Topic | Rows |
|---|---|
| `sessions/revoked` | revoked sessions not yet expired (`sid:`), the account cutoffs the feed sent (`acct:`, 1.99acm: `session_cutoffs.hub_before` / `hub_why`, written only when `revokeAll` excepts nothing - never the cookie cutoff of "sign out everywhere else" or a password change, which keep this device; `before = ceil(hub_before / 1000)`), `account_merge_log` (`acct:<from_id>`, kind `merge`; a merge wins over a cutoff of the same id) |
| `privacy/changed` | incognito keys confirmed ON (`incognito_state`, `incognito_anon` - unlinked logins too) or with a pending ON (an open `privacy.incognito` `["on"]` action newer than Pepe's last report, at most 24 h): `{flag:"incognito", value (confirmed), phase:"state", via (when ON), subject, at, pending_on, pending_at}`; private activity (`pa:`); `hub_hidden_h` (`hh:`) |
| `privacy/account-deleted` | every `account_deletions` row in state `done` (the newest per account) |
| `privacy/forget` | every `pepe_forget_log` row with an account |

1.99acm: every source is a keyset read - at most `limit + 1` matching rows past the cursor, through an index where the
entity is `<prefix><column>` (`sessions` by the partial index `hub_sessions_revoked`, cutoffs / deletions / hashes /
layouts by their keys, merges by `account_merge_log_from`) - because a page runs inside `dbUtils.tx`, the process-wide
chain. The incognito keys are cut at the cursor and the limit before any account is resolved, and a page's linked logins
are resolved in one query on `users_camfrog_login` (`lower(trim(camfrogUsername))`). `privacy/forget` pages by the TEXT
order of its decimal id (no index fits; the log is small).

**Rewind** (the promotion runbook): `posted_at = NULL` on the kept rows of the topic with `id > after_id`, and the poster
wakes. Posted rows are kept 7 days.

## The export call (`accountexport.js`, 1.99acm)

While the `export` switch is on and a hub is configured, "Download my data" also asks the hub:
`GET {HUB_V1_URL}/internal/v1/privacy/export/acct/<the hub's account id>?ref=<the export's id>`, signed; the answer
(`application/x-ndjson`, at most 64 MB, 60 s) is streamed to a 0600 temp file and must end with
`{"t":"end","complete":true}` (a truncated answer is refused). It goes into the zip as `chat-hub.jsonl`, and the README
names it. The export **never ships without it while the switch is on**: if the hub can't answer, the job goes back to
`queued` with `hub_wait_since` (the first failure) and `hub_error` (a code), the 10-minute tick retries it (new jobs
first), the member keeps seeing it as being prepared, and after 24 h a console error and `/admin/keys#seam` flag it. An
account without a hub account id (a legacy id while `CHAT_GENESIS_NS` is unset) exports without it, and the README says
so.

## S1: pads, roles, bans, switches (release L1's Q4 part, 1.99aea - tentative until it reaches staging)

S1 plan §2.4 Q4; the hub repo's `docs/seam-plan.md` §12 is the spec (§12.14 "Q4" records what this release settled, and
its review fixes). L1 is split: V1's `/admin/chat` (below) reached v1 staging first as 1.99adz; Q4 merges it and takes the
next free letter, **1.99aea**, when it lands (ADR 0007 D19: `huboutbox.VERSION` names the release that changed the seam -
neither V4's 1.99ady nor V1's 1.99adz did). Built on Q5b's `pad_hub` (`padhub.js`). Every switch is off: with them off
nothing posts and nothing a member sees changes, except the two seeded pads and the Lounge's name (below).

| Topic | Switch | Entity | Payload (read when the row posts; one read per batch) |
|---|---|---|---|
| `pads/changed` (`hubpads.js`) | `pads` | `pad:<hub_pad_id>`, `pm:<hub_pad_id>/<userId>` | the pad: `{kind:"pad", pad_id, v1_room_id, slug, title, platform, visibility, nsfw, listed, tier, tier_until, owner, owner_since, owner_grant, chat_backend, history, flairs, fx, badges, badge_max, created_at}` or `{kind, pad_id, gone}`; a member: `{kind:"pm", pad_id, account, v1_user, status}` or `gone` |
| `roles/changed` (`hubroles.js`) | `roles` | `acct:<userId>` | `{account, v1_user, role, cls, role_at}` (`staffroles.globalRolesOf`: the Pepe role of the linked Camfrog login) or `gone` |
| `bans/changed` (`hubbans.js`) | `bans` | `fb:<userId>/<room_id>` (`*` = site-wide) | `{kind:"feed_ban", scope, pad_id, v1_room_id, account, v1_user, feature, until, banned_at, active:true}` or `active:false` (no reason, no actor) |
| `switches/changed` (`chatswitches.js`) | `switches` | `sw:<key>` | `{key, value, updated_at}` - `CHAT_HUB` only in S1 |

- **The pad:** every source read from the database (never a module cache): the registry row, `pad_hub` (`chat_backend`),
  `pad_access` (no row = members, except a seeded pad, which reads its seed's level - `rooms.seedAccess`, as
  `padaccess.levelOf` does; a profile pad is members), `premium_subs` (the tier and its end by `premium.endsAt` - a comp, a
  renewing sub's grace, a Stripe renewal's `stripe_through`; `tier_until` null = no end), `pad_chat_cfg` (the history keys;
  NULL = the defaults `null, true, null, false`), `chatlog_rooms` (CL3's `owner_since` / `owner_grant`, user owners only),
  `padflair.hubDefsMany` (the user flairs: one query per 400 pads, since the builder runs inside the poster's and the
  snapshot's transaction), `pad_looks.cosmetics` through `padlook.parseCosmetics` and the `padcosmetics` catalog
  (`fx {frame, glow}` and `badges`, each `{.., perk}`: the hub draws them by `padcosmetics.fx()`'s rule) and
  `badge_max {free: 3, prime: 3 + prime_extra_badges}`. A tier lapsing or a config change needs no row (the payload carries
  `tier_until`; the 10-minute snapshot carries the rest). A member status v1 doesn't know posts `removed` (it grants nothing).
- **Triggers** (all gated by the topic's switch, `(topic, entity)` only, an UPDATE only for its listed columns and only when
  one changed): pads - `rooms_registry` (insert; update of `room_id, slug, title, platform, owner_kind, owner_user_id,
  adult, listed` - never `updated`, `slot_*`, `banner`, `takeover`), `pad_hub` (insert, delete - a pad's deletion through
  `pad_hub_drop` -, update of `room_id, hub_pad_id, chat_backend`), `pad_access`, `premium_subs` (Prime Time / Plus rows,
  every column `endsAt` reads), `pad_chat_cfg`, `chatlog_rooms` (`room_id, owner_since, owner_grant` - never the archive's
  counters), `pad_flairs` (user flairs), `pad_looks` (`cosmetics`) and `pad_members` (`pm:`); a room id resolves through
  `pad_hub` for OLD and NEW. Roles - `pepe_roles` (insert / delete / a change of `login` or `role` - the WHEN matters:
  `staffroles.botSync`'s upsert sets `role` on every write, so Pepe's per-minute sync of the same role posts nothing; one row
  per account whose `lower(trim(camfrogUsername))` is the login, found through `accountMerge.js`'s unique
  `users_camfrog_login`) and `users` (a sign-up with a linked login, a change of `camfrogUsername` / `class`, the deletion
  of a linked account; never points / xp / level). Bans - `feed_bans` (insert - a re-ban's `INSERT OR REPLACE` too -,
  delete - unbans and v1's sweep -, update of `user_id, room_id, until`: OLD and NEW) and `pad_hub`'s insert (the room's pad
  bans: a pad re-created under a room id whose feed bans outlived the old pad, a bridged room banned in before it was
  registered - v1 enforces feed bans by room id, whatever the pad). Switches - `chat_switches` (insert, delete, update of
  `key, value`). Each start drops and recreates the triggers in one transaction; a setup failure is shown on
  `/admin/keys#seam` and keeps the four switches from turning on (409 `l1_not_ready`; it never takes identity / looks down).
- **Re-keys** (`padrekey.js`): a `pad_hub` row the moving pad's row would displace (`UPDATE OR REPLACE` fires no DELETE
  trigger) is deleted first, so `pad_hub`'s DELETE trigger posts `pad:<displaced id>` in the re-key's transaction; after the
  move, the members and pad feed bans left at the new id (now the moved pad's) get a row each. The moving pad keeps its id.
- **Snapshots:** `pads/changed` lists every registry row (`pad:`, by `hub_pad_id`) then every approved member (`pm:`);
  `roles/changed` the accounts whose linked login has a role; `bans/changed` the live feed bans the hub can hold - site-wide
  ones and pad ones whose room has a pad (`pad_hub`) - entities ordered in SQL (the entity's byte order isn't
  `(user_id, room_id)`'s); `switches/changed` every key (a key without a row is its default). A live pad ban on a room
  without a pad (a deleted pad's - `padcreate.removePad` leaves `feed_bans` - or a room the registry never knew) is left out:
  listed, the hub would quarantine it (`no_pad`) on every 10-minute pull; left out it reads absent, so the hub revokes the
  ban it held for a deleted pad (the pad itself archived at once by `pads/changed`). A feed row for one (a ban or change
  after the pad went) still posts it active with `pad_id` null - the golden unknown-room row, quarantined once per change:
  v1 keeps no record of the pads it deleted, so it can't tell the two apart.
- **`chat_switches`** (`chatswitches.js`; `CHAT_HUB` on | off, default off): written only through `chatswitches.set(key,
  value, actor, {reason})` - V1's `set()` (`/admin/chat` decides who may: a Pepe owner turns it on, any admin off): it checks
  the key, the value and the interlock and writes the row and its `admin_audit` row (`chat.switch`) **in one transaction** (a
  row that can't be written rolls the change back). The payload of a stored value `KEYS` doesn't allow (the sqlite3 CLI) is
  the key's default, as `get()` reads it - fail closed on both sides. Staging keeps its own (`deploy/keep-staging-tables.js`
  `KEEP`).
- **The interlock (S1-D7):** `CHAT_HUB = on` is refused (409 `chat_hub_needs`, `err.needs`) unless `tickets`, `sessions`,
  `heartbeat`, `privacy`, `erasure`, `export`, `pads`, `roles`, `bans`, `identity`, `looks` and `switches` are on; while it is
  on, `/admin/keys#seam` refuses turning any of them off (409 `chat_hub_on`). Both checks read the database inside the
  writing transaction; `huboutbox.setSettings` reads `CHAT_HUB` with `chatHubOnNow({strict: true})`, so a read that fails
  refuses the save instead of reading "off" (a missing table is the default, off). Readers (`chatHubOnNow()`, V2's widget
  mount) fail closed: a failed read is off. Turning `CHAT_HUB` off is never refused.
- **`chat_backend`** (`padhub.setBackend(roomId, backend, actor)` - V1's -; `padhub.backendOf`): `v1 | hub_read | hub`; `hub`
  only on a site pad (409 `site_pads_only`), `hub_read` is S2's (409 `hub_read_s2`), `v1` never refused (a `pad_hub` row
  whose registry row is gone included); `pad_hub.updated_by` gets the admin, the pad's `room_events` row `chat-backend` names
  **`PATV staff`** (`padhub.STAFF_ACTOR`; the owner reads `room_events`). Its reads, the UPDATE and the event are one
  `dbUtils.tx` (a savepoint of `/admin/chat`'s, with its audit row). **A pad that stops being a site pad** (padconnect
  re-keys it onto a Camfrog room or connects a Twitch channel; any writer) goes back to `v1` in the same statement's
  transaction (`padhub`'s trigger `pad_hub_site_only`, with a `chat-backend` event `hub -> v1 (not a site pad any more)`).
- **Unlisted pads (ADR 0007 D1):** `rooms_registry.listed` (default 1). `rooms.list()` / `listCached()` - the listing paths:
  the Pads page and its guide, the pickers (the composer's and the crosspost dialog's, the story form's, the pad links form,
  `/go-live`'s stage picker), Top Pads and the front pick (`withSitePads` drops a bridged room's row of an unlisted pad too),
  Pepe's news routing (`pepetopics.route`), the pad search's suggestions - leave unlisted pads out, like profile pads. **The
  page a member is on is not a listing:** on an unlisted pad's own page the composer offers (and picks) that pad, the story
  form opened there offers it (`/api/stories/targets?pad=`), `/go-live?room=` offers it, the pad links form keeps it as its
  default (`feedstore.communities(viewer, {include})` - still never a profile pad, an Approved one only for those inside).
  `rooms.listAll()` / `listAllCached()` are every non-profile pad for what isn't a listing: an owner's own pads (`ownedBy`,
  the owner menu), admin pages (`/pads/admin`, `/admin/media`, the feed admin's names, Pepe's feed scopes), entitlements
  (Plus ownership, admins' comps, Pepe's Plus rooms and voices, launch-pad grants), the automod, the 18+ gate's pad list,
  `p/<slug>` and id resolution, and **Pepe's owner sync** (`ownersForPepe`: every pad with `listed: false|true` - it
  carries the owner, the 18+ flag and Prime Time / Plus retention, so an unlisted pad left out would lose its owner's
  `!stage` commands and get the free chat-log / recording window; Q4's review, against D1's letter). `rooms.isListed(id)`,
  `rooms.setListed(id, on, actor)` (no page sets it yet). PATV has no sitemap.
- **Seeds:** `patv:staff` ("Staff room", slug `staff`) and `patv:canary` ("Canary", slug `canary`): house site pads, unlisted,
  Approved, so staff and above are inside and everyone else gets the locked card. They fail closed: the registry row is
  inserted with `listed = 0` in its own INSERT (never listed for a moment), and until `padaccess.js` writes their level row
  (once, `rooms_kv seeded_access:<id>`) both `padaccess.levelOf` and `pads/changed` read them as their seed's level
  (`approved`), never the default `members`; a row an admin writes later wins. **The Lounge is the "PATV Lounge" again**
  (OQ-1: slug `patv-lounge`, the description "The general PATV pad: …"; `rooms_kv lounge_patv_v1`, once, each field only
  while it still holds a seeded value - an admin's edit stays); its 1.99x address `camfrog-lounge` is the pad's alias (301)
  and in `pads.OLD_SLUGS`.
- **Heartbeat:** `switches` gains `pads`, `roles`, `bans`, `switches`; `topics` the four topics; `version` is `1.99aea`
  (tentative: the next free letter after V1's 1.99adz - the operator assigns the real one when the release reaches staging;
  the shared golden keeps its test letter).
- **Driver:** `pad`, `padMember`, `padLook`, `padChat`, `ownerGrant`, `premiumComp`, `stripeRenew`, `flair`, `role`,
  `pepeRoles`, `signup`, `feedBan`, `feedUnban`, `feedSweep`, `chatSwitch` (the interlock included), `beat`
  (`test/hubseam-driver-s1.test.js`).
- **Tests:** `test/huboutbox-s1-l1.test.js` (every golden pads / roles / bans / switches row from its input, each trigger
  only with its switch on and only for its listed columns, OLD and NEW keys, the backfill, the displaced-row emit, the four
  golden snapshot pages and their paging, the poster, the heartbeat, the interlock both ways, `setBackend`; the review
  fixes: a stored bad `CHAT_HUB` value posts off, Pepe's same-role sync and a same-value switch update post nothing, a ban
  ends at `until`, a pad ban on a room without a pad stays out of the snapshot and posts when the room gets a pad, an unknown
  member status grants nothing, a profile is never more than members, the seeds' fail-closed level, a pad that stops being a
  site pad back at `v1`, `setBackend` rolled back with its caller, the strict interlock read, `l1_not_ready`, unlisted pads
  in Pepe's sync / Plus ownership / the automod / id links), `test/padhub.test.js` (the listing paths skip unlisted pads;
  Pepe's sync keeps them with `listed: false`; the 18+ gate stops visitors at an unlisted 18+ pad; links and the pad form's
  default), `test/communities.test.js` (the composer and story form on an unlisted pad's page), `test/pad-platform.test.js`
  (the Lounge's rename back), `test/adminchat.test.js` (V1's, with Q4's files).
- **Before Q7:** count the live pad bans on rooms without a pad on staging (`SELECT COUNT(*) FROM feed_bans b WHERE b.room_id
  <> '' AND (b.until IS NULL OR b.until > <now ms>) AND NOT EXISTS (SELECT 1 FROM pad_hub h WHERE h.room_id = b.room_id)`):
  each one quarantines once (its next feed row) and never appears in a snapshot.
- **Turn-on (Q7, staging):** hub → v1 direction wired → `JOURNAL_ENABLED` → `privacy` → `erasure`, `export` → `pads` →
  `roles` → `bans` → `identity` → `looks` → `switches`, each once its hub topic is live and has bootstrapped; then
  `CHAT_HUB` on at `/admin/chat` with only the staging canary / staff pads at `hub`.

## S1: identity, looks, the looks call, text style (release L3, 1.99ads)

S1 plan §2.4 Q5b; the hub repo's `docs/seam-plan.md` §12 is the spec (§12.14 records what this release changed in it).
Built on two prerequisites in the same branch: **Q5a** (release L2, no behaviour change: `cosmeticstyle.js` - the ring,
border and banner cosmetics are structured fields, golden-tested to render today's CSS, `test/cosmetics-structured.test.js`;
each item's structured look travels whole - no colour list is cut, the caps being rt-schema's `look.schema.json`'s: name 12,
ring / border / banner 8) and **`pad_hub`** (S1-D1, `padhub.js`: every pad's stable `hub_pad_id`, minted by an
`AFTER INSERT` trigger on `rooms_registry` and a start-up backfill, moved by re-keys, dropped by an `AFTER DELETE` trigger
in the deleting transaction - a pad re-created under the same room id is a new pad -, kept on a staging refresh; Q4 owns
the rest of the pad seam: the `pads/changed` triggers, among them `pad_flairs` for the flair definitions
`padflair.hubDefs` reads).

| Topic | Switch | Entity | Payload (read when the row posts; one read per batch) |
|---|---|---|---|
| `identity/changed` (`hubidentity.js`) | `identity` | `acct:<userId>` | `{account, v1_user, status: active\|archived\|deleting\|deleted\|merged\|gone, status_at, merged_into, v1_into, merged_from[≤ 50], email_verified, level, created_at, links[{platform: camfrog\|discord\|twitch\|telegram, external_id, login, display}]}` - no username, no display name |
| `looks/changed` (`hublooks.js`, built by `userlook.buildLooks`) | `looks` | `acct:<userId>` | the full structured look (avatar, name, text, badges, profile, gtf, `flairs {hub_pad_id: "f<id>"}`, `auto {supporter, plex, plus_pads}`, `valid_until`) + `h`; `{acct, v1_user, gone:true}` with no `users` row or a done deletion |

- **Identity status:** a done deletion → `deleted` (`done_at`), an open one (`scheduled` / `held`) → `deleting`
  (`requested_at`), `users.archived_at` → `archived`; no `users` row → `merged` (`account_merges`, `merged_at`) or `gone`.
  Facts are null for merged, deleted and gone. `email_verified` is `verified.js`'s email proof. Links follow the hub's
  platform rules (Camfrog `external_id` = SQLite's `lower(trim(login))` - trim removes spaces only, lower maps A-Z only -
  1-64 characters counted as code points: the golden `s1.link_rules` vectors; numeric ids for the others); a
  link that would fail is left out and counted (`/admin/keys#seam`), so v1 never posts what the hub quarantines.
- **The look:** one builder for the topic, its snapshot and the call; every source read from the database (never a module
  cache): equipped unlocked copies whose perk is live (Season Pass / Plex items), `cosmeticstyle.lookOf` for the
  structured fields, the absolute https avatar (a site path gets `PUBLIC_BASE_URL` / `SITE_URL` / the prod or staging
  origin; no https origin → no url), `hue` = the monogram hue of the username, `verified` = any `verified.js` proof, the
  Supporter badge and up to three showcased achievement badges (`ach.<id>`, label `ach.n.<id>`), pad flair assignments
  keyed by `hub_pad_id`, the auto-flair inputs and `valid_until` (the earliest end of an equipped perk item, the Plex auto
  flair or an owned Plus pad). Bots (Pepe) get a bot badge and nothing else. `h` = sha256 of the canonical JSON (keys
  sorted at every depth) without `h`, always over the card look.
- **Text style:** `users.text_style` = JSON `{color, font}` (`textstyle.js`): a W1 palette colour (`chat-text-styles.json`,
  rt-schema's `registry/text-styles.json` byte for byte, sha256 pinned in `test/huboutbox-s1.test.js`) and one of the six
  fonts; the look carries `text {color?, font, scope:"all"}`. The picker is V3 (release L5, below; behind the `looks` switch);
  account deletion clears it, "Download my data" includes it.
- **Triggers** (all gated by the topic's switch, `(topic, entity)` only, never on points / xp): identity - `users`
  insert / delete / the link, status and fact columns, `telegram_links`, `account_deletions`, `account_merges` (insert,
  and the upsert / chain re-point's update); looks - `users` insert / delete / the look's and `verified.js`'s columns, a
  deletion's state, equips and the equipped copies (transfer, market lock), Telegram links and the sign-in links of
  `verified.js`'s `SSO_PROOF_PROVIDERS` (Google and Apple; the one list its gates and the look's `verified` read), `premium_subs`
  (the Season Pass holder; a Plus pad's owner), `plex_members`, donations, the badge showcase, `pad_user_flairs`, a pad's
  owner change (both owners) and deletion. The trigger SQL names only `users` columns the database has; each start drops
  and recreates the S1 triggers in one transaction. A setup failure is shown on `/admin/keys#seam` and keeps the two
  switches from turning on.
- **Snapshots:** `identity/changed` lists every account, every merged id and every deleted account; `looks/changed` the
  accounts with a non-default look (the seam plan's default-look rule), found through candidate sources (avatars, text
  styles, equips, flairs, showcases, donors - partial index `hub_s1_donors` - Plex members, Season Passes, Plus owners,
  Pepe) and built 200 at a time.
- **The looks call:** `POST /internal/v1/looks {ids: [hub account uuid] (1-450, lower case), card?}` →
  `{v:1, items, missing}`, items in request order, duplicates ignored; an id resolves as the `users.userId` or through the
  reverse map of `chatticket.subjectOf`, which catches up with `users` whenever an id doesn't resolve (every row
  committed before the call; only rows it hasn't seen are hashed); purged, merged and deleted ids are `missing`. The
  whole answer is read in one transaction (`dbUtils.tx`), so no other request's uncommitted write - a merge's DELETE that
  rolls back - can make a live account `missing`. 404 while `looks` is off, 400 a malformed body or id, 413 over 450
  ids; the nonce is taken durably first.
- **Heartbeat:** `switches` gains `identity` and `looks` (additive); `version` is `1.99ads`. The version is informational:
  the shared golden's S1 heartbeat keeps the test letter it was recorded with (`1.99adp`, the letter this release was
  built under before the release letter rule gave it to a bot release), and the tests only check that it names one.
- **Driver:** `link`, `unlink`, `moveLogin`, `merge` (now also `account_merges` and the row's removal), `cosmetic`,
  `textStyle`, `looks` (`test/hubseam-driver-s1.test.js`).
- **Turn-on (Q7, staging):** after release L1's topics: `identity` → `looks`, each once its hub topic is live and has
  bootstrapped (`CHAT_HUB` needs both, with the rest of S1-D7's switches - Q4 / V1).

## S1: the chat text-style picker (release L5, 1.99adt)

S1 plan §2.5 V3 (ADR 0007 D13: text style is v1-owned until looks move, set from a picker on Edit profile).

- **Behind the `looks` switch** (1.99adt fix-up; `textstyle.pickerOn()` = `huboutbox.on("looks")`, the switch that sends text
  styles to the chat hub): while it is off - the default, and until Q7 turns S1's switches on (ADR 0007 D19: nothing a
  member sees changes before then) - Edit profile has no card and no jump link and loads no webfonts
  (`textstyle.editData` answers nulls), `/settings` has no row, and the save route answers 404 (`{ok:false,
  error:"not_found"}` for the page script; the site's own 404 for a form post), nothing written. A style saved while it was
  on stays stored and comes back with the card. `CHAT_HUB` came with V1 (1.99adz: `chatswitches.chatHubOnNow()`), not V2,
  and `pickerOn()` does not read it: the picker stays gated on `looks` alone (ADR 0007's owner answers, "Default
  accepted"; the question V3 left for V2 is closed, 2026-10-24).
- **One home:** the "Chat text style" card on Edit profile (`views/editProfile.ejs` `#textstyle`, between Avatar and Profile
  layout, in the jump links). The `/settings` hub's Profile section links to it (`settingshub.js` row `textstyle`, after
  Cosmetics) with the saved style as its state ("Blue · Mono", "Pixel", "Default"; the colour and font names are catalog
  keys the hub view translates, `state.vk`); no other page has the control or posts to its route.
- **Palette only:** the card offers Default plus the 16 palette colours (each swatch shows the dark | light pair, the name
  in its dark-theme colour) and the six fonts (each drawn in its face; the three webfonts load from Google Fonts on this
  page), all from `chat-text-styles.json` (`textstyle.choices()`). The form posts a palette KEY and a font key;
  `textstyle.fromForm` stores the key's **dark-theme** value (the site's own theme) and refuses anything else - a typed hex
  (even a palette value), a key outside the palette, an inherited name (`__proto__`), an unknown font - with 400
  `bad_text_style`, nothing written. Default colour + Sans clears the column (NULL). The hub turns a palette value of
  either theme into that palette's pair (chat-core `validateTextColor`, S1 V3's platform part), so a style stored by Q5b's
  driver with the light value (the shared golden's `#1d4ed8`) and one stored by the picker look the same.
- **Preview:** one chat line (the member's display name, a sample sentence, an `@Pepe` mention in the chat's link colour) on
  each chat theme's background - the registry's first background and link accent of each theme - with the chosen pair and
  face (and the pixel face's size scale). Server-rendered from the saved style; the page script repaints it on every
  change and says "Not saved yet." until Save.
- **Save:** `POST /api/u/<me>/update/textstyle {color, font}` (`textstyle.register`): signed in, your own name, same site
  (`authGuard.sameSite`), at most 30 posts per member per 10 minutes - refused ones count too, so probing the palette is
  slowed like saving (each saved change is one `looks/changed` row while the switch is on). Every answer is
  `Cache-Control: private, no-store`. The page script sends `Accept: application/json` and gets `{ok, style: {color: key |
  null, font}}` (400 `bad_text_style`, 401 `signin`, 403 `not_yours` / `cross_site`, 404 `not_found` while the switch is off,
  429 `slow`, 500 `error`); without JS the form posts and comes back to `#textstyle` with a flash. A failed save logs
  `[textstyle] save: <error>` only - no account, name or posted value. Setting the column is `textstyle.set`
  (`dbUtils.tx`), the one place the site sets it (the picker and the contract driver both go through it); account
  deletion's tombstone clears it (`accountdelete.js` step 8, part of its column map). With the `looks` switch on, the
  `users.text_style` trigger queues the member's `looks/changed` row either way.
- **Font stacks:** the view prints a font's stack into a `style` attribute, so `choices()` keeps only stacks made of letters,
  digits, spaces and `, " ' ( ) . -` (`textstyle.SAFE_STACK`; the registry's six are), and the Google Fonts address only
  plain family names.
- **Tests:** `test/textstyle-picker.test.js` (choices = the registry, the stack and webfont guards on a hostile registry,
  `fromForm` refusals and every key x font round trip, the route's checks, `private, no-store` on every answer, its limit -
  refused posts counted - and both answers, a failed save's answer and log, the card rendered with and without a saved
  style, one home: the only poster, and every server file that names the column with what it does - `textstyle.js` sets,
  `accountdelete.js` clears, `hublooks.js` / `userlook.js` read - the hub row and its states, and the `looks` switch off
  and on); `test/settingshub.test.js` (looks on) lists the row and the card's ids (one home per setting).
- **i18n:** new keys only - `textstyle.*` (the palette's and the fonts' `label_key`s from the registry, the card's copy),
  `sethub.e/d.textstyle`, `sethub.st.ts*`, `js.textstyle.*`; the sync translates them after the staging push.

## S1: the privacy UI - "Also remove my public messages" (release L4's V4 part, 1.99ady)

S1 plan §2.5 V4 (ADR 0007 D16; OQ-20, answered 2026-10-19: the choice also hard-deletes the account's web lines in the pad
chat archive, with the same exceptions, under one checkbox wording; CHAT-ARCHITECTURE rev 5.1 §9.4, seam plan D-23). Release
L4 is V2 + V4; V4 reached v1 staging first, on its own, as **1.99ady** (2026-10-21; the staging merge carries the letter,
ADR 0007 D19), and V2 takes the next free letter when it lands. No seam shape change, so `huboutbox.VERSION` stays 1.99ads.

- **Behind the `erasure` switch** (`accountdelete.removeOffered()` = `huboutbox.on("erasure")`; off by default, so nothing a
  member sees changes until `erasure` goes on): while it is off the delete page has no box and no PATV chat copy, the privacy
  page has no paragraph, and `POST /api/account/delete {remove_public: true}` is refused 409 `E_REMOVE_OFF` (nothing
  scheduled). A request scheduled while it was on keeps its choice if the switch goes off before the deletion runs (the
  switch gates the offer, not what a member already asked for). **When members see it:** on prod, `erasure` goes on at
  E-2 step 2 (the privacy seam's dark launch: `privacy` → `erasure`, `export`), before `CHAT_HUB` reaches anyone (step 3,
  canaries first) - ADR 0007 D16's "prod before users". From that moment every member sees the checkbox, its PATV chat copy
  and the privacy page's paragraph naming PATV chat (such as the PATV Lounge), while PATV chat itself is still dark; the
  copy stays true then (a member with no PATV chat messages has nothing there to keep or remove).
- **One checkbox, one wording, both stores:** "Also remove my public messages" on `/settings/account/delete`, unticked, under
  CL6's "Also hide my past public chat lines" (independent of it; both can be ticked). Its hint names both stores (PATV chat
  and pads' chat history), the exceptions, the once-a-day rule and what can't be reached (copies already sent to Camfrog or
  downloaded, a linked member's Camfrog and incognito lines). "What deleting does" gains one item for PATV chat
  (`acctdel.what.hub`). Admin-scheduled deletions (`POST /api/admin/users/:id/delete`) never carry it: it is the member's
  own choice.
- **At most once a day** (CA §9.4): a request carrying the choice is refused 429 `E_REMOVE_DAILY` (`retry_at`, ms) while
  another request of the account carried it in the last 24 hours (`account_deletions.requested_at`) - one a sign-in
  cancelled counts too. The page shows the box disabled with the time it opens again; the deletion itself can still be
  asked for without it. Review fix: `schedule()` checks "already scheduled" and the day again inside the insert's own
  `dbUtils.tx` (one at a time), so two requests sent at once can't both be scheduled or both carry the choice.
- **Stored with the request:** `account_deletions.remove_public` (1 / NULL), `public_done_at` and `public_login` (columns
  added by `init()`). Signing in during the grace cancels the request and its choice together. `public_login` is the
  released Camfrog login, written only on a done row with the choice and only until the archive's part has run (its web
  lines are under it, below); `removePublicNow` NULLs it. Nothing reads it but the retry, and the hub row never names it.
- **The hub's part:** the `privacy/account-deleted` row (and its snapshot row: `huboutbox`'s reader selects the column)
  carries `remove_public: true`; the hub then forgets the text of the account's public lines (`_erase_account`), a line
  under a report kept as a former member's until its hold ends (D10) and forgotten then (`erasure_deferred`). The payload's
  shape is unchanged (the field has existed since S0, seam plan D-23), so `huboutbox.VERSION` stays `1.99ads` and the shared
  golden rows are unchanged.
- **The pad chat archive's part** (`chatlogmod.removeAccountLines(userId, {login, upto})`, run by `execute()` **after** the
  deletion's commit, so a deletion that rolls back - or that a sign-in then cancels - purges nothing). Purged at once by
  `purgeRows` as their author (`rm_by` `self`: text, name and key - only the one-way hash stays -, the search index,
  `bridge_feed`, quotes, mention notices and alerts):
  - the account's own web lines: `u:<id>`, and the lines it said while incognito, archived as `h:<hash of u:<id>>`;
  - review fix: **a linked member's web lines**, which the bridge archives under the Camfrog **login** with `d.u.web`
    (`bridge.js` `jobSender`), not under `u:<id>`: `execute()` reads the login before it releases it and passes it with
    `upto` = the deletion's time (a released login is someone else's to link afterwards, and their web lines aren't this
    member's). Like Remove my line (CL6 `isAuthor`: every line under a login is its current holder's), an earlier holder's
    web lines under the same login go too.
  - Not reached: the login's Camfrog lines (the login's, not the account's - "Also hide my past public chat lines" leaves
    them out), and a linked member's lines said **while incognito** (`h:<hash of the login>`: Pepe sends an anonymised line
    with no web mark, so the archive can't tell the ones sent from the website from the Camfrog ones; they name nobody, and
    "Also hide my past public chat lines" leaves them out too). The checkbox hint and the privacy paragraph say so.
- **The same exceptions as the hub, with D10's bounds** (review fix; ADR 0007 OQ-20 "yes, same exceptions", OQ-21 / D10;
  the hub's `rooms._report_hold_until`): a line a legal hold covers (its room, or its speaker) or a report holds is taken down
  at once instead (`rm_by` `self`, like Remove my line: out of every view, its copies with it, the live feed too) and listed in
  `chatlog_erase_wait (c, at)`. A report holds a line until 30 days after its decision, or 90 days after it was filed while
  nobody has decided it (a decision after those 90 days doesn't hold it again; the report stays open, its line's words gone -
  the hub's "snapshot expired"); a report filed after the removal doesn't hold it (the hub's rule for a deferred erasure). The
  nightly pass (`nightly()` → `eraseWaitPass`) deletes a listed line's words once no legal hold and no such report holds it,
  and CL6's 30-day pass leaves listed lines to it (so a decision can't be cut short of its 30 days, nor an undecided report
  keep the words past 90). v1 has no bounty evidence on chat lines. The hub's 14-day escalation is the hub's `/admin` card;
  v1's report queue lists the open report as before.
- **A kept line that was already down** (review fix): a line a "minor" report, a moderator or staff had hidden before the
  deletion is re-marked as its author's removal (`rm_by` `self`, `rm_why` NULL, `rm_at` kept): `unhide` refuses a `self`
  line and `reportDecide`'s dismiss / false lifts only `report:minor`, so neither can bring the deleted member's words back.
- Pepe's `!log` / `!search` skip every line of the account key up to then (`removed_who`, as "Delete every line"); the
  login's lines aren't the account's to hide from him (each purged one is in his per-line removed list).
  `public_done_at` and the counts (`report.public_removed = {lines, held}`, no words or names) record it; a **done** row with
  the choice and no `public_done_at` (a restart between the commit and the purge, an error) is run again by the tick
  (`retryRemovePublic`, with the row's `public_login`); never a scheduled, held or cancelled one. Logs carry counts only.
- **Where the two stores still differ** (V4's call, for the owner's review; default: as built): a held or reported line is
  out of view in v1's archive at once (taken down as the author's, its words kept for the hold), while on the hub it stays
  visible as a former member's line until its hold ends (`erasure_deferred`). What is kept, and for how long, is the same.
- **The privacy page** (`views/privacy.ejs`, `terms.js` passes `accountdelete.privacyCopy()`): one paragraph,
  "Your chat lines when you delete your account" (`#delete-chat`, section 10, in the contents), covering PATV chat and the
  pad chat archive together, only while `erasure` is on; with the `export` switch also on, one sentence says "Download my
  data" includes what PATV chat keeps. It names what stays without the tick (a former member's lines - or, for a linked
  member's web lines, the Camfrog name), what the tick deletes, D10's bounds, and what it can't reach. Dated by the switch's
  own row (`hubseam_settings.updated`): a dated note in "Changes", and "Last updated" when it is the newest change. Review
  fix: `huboutbox.setSettings` now moves a switch's `updated` / `actor` only when its value changes (the `/admin/keys#seam`
  form posts every switch on each save, which moved the date before); every save is still in the admin audit. **Owner
  action O-20** ("one privacy paragraph", S1 plan) is this paragraph's wording: it is put to the owner (default: as
  written).
- **Tests:** `test/account-delete-remove-public.test.js` (the offer and its refusal while off, the stored choice, once a day
  with a cancelled request counting, two requests at once, the flag in the feed and snapshot rows, the cross-store rule -
  purged lines, a linked member's web lines under the login, held and reported ones kept and taken down with their copies
  and the live feed, other people's lines and the login's Camfrog, incognito and later lines untouched, `removed_who`, the
  nightly pass once the hold and the report end - D10's bounds (decided, undecided, decided late, a report filed after the
  removal), kept lines already down (a dismissed "minor" report), a person hold (`who:`), no purge on a rolled-back deletion,
  the tick's retry with the kept login and never for a scheduled or cancelled request - the routes (GET's box, POST's strict
  `true`, 409 / 429), the delete page and the privacy page with the switches off and on and a save of every switch);
  `test/chatlog-attach.test.js` (an archive in the attached `chatlog.db`: `removeAccountLines` finds `chat_log` there);
  `test/hubseam-driver-v4.test.js` (the driver's commands, an unlinked and a linked account). The hub half of the
  cross-store test is the contract suite's scenario **5b** (the hub repo,
  `services/rooms/test/seam-contract.integration.test.ts`): one deletion with the choice, through the real seam, checked in
  both stores (an unlinked and a linked account's web lines in v1's archive).
- **Driver:** `deleteAccount {user, remove_public?}`, `chatLines {user, lines, hold_rooms?}` (a linked account's web lines
  under its login, as the bridge archives them; `camfrog: true` for a Camfrog line), `chatLog {cs}`.
- **i18n:** new keys only - `acctdel.what.hub`, `acctdel.remove_public`, `acctdel.remove_public_meta`,
  `acctdel.remove_public_wait`; the sync translates them after the staging push. The privacy page is English, like the rest
  of it.
- **Turn-on (Q7):** nothing of its own - it appears with `erasure` (and its export sentence with `export`).

## S1: `/admin/chat`, the chat hub's break-glass (release L1's V1 part, 1.99adz)

S1 plan §2.5 V1; ADR 0007 D3 and D15, OQ-19; CHAT-ARCHITECTURE §8.5 (R-15, CF F4). Built beside Q4 (the rest of L1: the
pads / roles / bans / switches topics, `listed`, the staff and canary pads) and in parallel with it; V1 changes no seam wire,
so `huboutbox.VERSION` stays as it is. L1 is split, as L4 was: V1 reaches v1 staging on its own as 1.99adz, ahead of Q4,
which takes the next free letter when it lands (see "Without Q4" below). The 1.99adz fix-up (V1's second review) keeps the
letter, since 1.99adz is only on staging. The owner accepted V1's calls (ADR 0007 D15 "As built (V1)": the server-enforced
confirm step, a reason on every change, no audit row when nothing changes, an off refused when its audit row is refused,
the Chat group holding `/admin/chat` only until V2, 500-row lists with the pilot pads first, `PATV staff` in
`room_events`) on 2026-10-24.

- **What it sets** - the two v1-owned controls of ADR 0007 D3, set only here:
  - `CHAT_HUB` in `chat_switches(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER, updated_by TEXT)`
    (`chatswitches.js`: `on` | `off`, no row = `off`; `updated_by` is the admin's username, an audit label that
    `accountMerge.js` classifies `deny`). `chatswitches.set(key, value, actor, {reason})` checks the key, the value and the
    interlock in its transaction and writes the `chat.switch` audit row `{key, from, to}` **in the same transaction**: a row
    that can't be written rolls the change back and `set()` rejects (an actor-less call - a script - writes no row).
    `set()` writes nothing (`changed: false`) for the value already there **or for the default when there is no row** (no
    row is `off`: writing one would stamp `updated` / `updated_by` with no audit row to match and, once Q4's triggers are
    in, queue a `switches/changed` row for nothing); a stored value it doesn't know (a hand edit: `ON`) is rewritten as a
    change with its own audit row, `from` being what was stored (1.99adz fix-up). `changed` means "the row was written".
    `dm_backend` is S5's key and is refused (`bad_key`) until then. `chatHubOn()` reads a per-process cache that `set()`,
    `load()` and `init()` refresh, so it misses an out-of-band write (a script, the sqlite3 CLI) until one of them runs (a
    view of `/admin/chat` reloads it); **V2's widget mount reads `chatHubOnNow()`** (one row) or calls `load()` on a short
    timer.
  - a pad's `pad_hub.chat_backend` (S1-D1's table): `padhub.setBackend(room_id, backend, actor)` - `v1` | `hub`; `hub_read`
    is refused (409 `hub_read_s2`), `hub` only for a **site** pad (409 `site_pads_only`: Camfrog, Twitch, Discord and profile
    pads keep their v1 chat in S1); any pad can always go back to `v1`, a `pad_hub` row whose registry row is gone (a
    staging refresh, a hand edit) included. `updated_by` gets the admin's username; the pad's `room_events` row
    `chat-backend` names **`PATV staff`** (`padhub.STAFF_ACTOR`, as `chatlogmod.js` does), never the admin, since the pad's
    owner reads `room_events` on `/p/:slug/settings`. `/admin/chat` runs it and its `chat.pad_backend` audit row
    `{room_id, slug, hub_pad_id, from, to}` in one `dbUtils.tx`.
  - `chatswitches.js` and `padhub.setBackend` are shared with Q4, which builds the same table, API and refusals and adds the
    rest: the `switches/changed` topic on this table (triggers, payload `{key, value, updated_at}`, the every-key snapshot),
    the `pads/changed` trigger that carries `chat_backend`, `huboutbox.setSettings`' half of the interlock and
    `chat_switches` in the staging `KEEP`. **When the two branches meet (release L1), keep Q4's two files with V1's
    `set()` and `setBackend()`** (V1's review fixes above: the audit row inside the transaction; `v1` for a row whose pad is
    gone; `PATV staff`, plus the `STAFF_ACTOR` constant and its export; Q4's `rooms.cleanPlatform` for the platform), and
    change Q4's `huboutbox-s1-l1` assertion on the `chat-backend` event's actor from `owner` to `PATV staff`.
    `test/adminchat.test.js` fails on a merge that keeps Q4's unchanged functions (take `set()` as it is now, with the
    fix-up's no-op rule). Q4's land merges v1 staging into its branch, so it meets these two conflicts there **and a
    third, `tools/hubseam-driver.js`**, which is V4's (1.99ady: `1abb0b9f`, `fa443753` add the driver's V4 ops), not
    V1's: keep both sides' ops. A trial merge of `s1-q4-pads-seam` `734d360c` with the fixed-up V1 resolved this way passes
    adminchat, the page script, huboutbox-s1-l1, siteperms, padhub, i18n, staging keep, account merge, merge coverage,
    hubseam golden, huboutbox-s1, admin-keys and tx-global (139 tests).
    (Done: Q4's branch merged v1 staging - 8e143422, then the fix-up's ac0066f5 - this way; Q4's section above is the
    result, with its own review fixes on top: a pad that stops being a site pad goes back to `v1` by itself now.)
  - **Without Q4** (1.99adz until Q4 lands) `chat_switches` isn't in the staging `KEEP` and the interlock's other half
    (stated on the page) isn't there, and neither matters yet: `CHAT_HUB` can't go on, because Q4's four switches (`pads`,
    `roles`, `bans`, `switches`) aren't in `huboutbox.SWITCHES`, so `setSettings` can't turn them on and `set()` refuses
    with `chat_hub_needs`; a staging refresh that drops `chat_switches` leaves `CHAT_HUB` at its default, `off`; and nothing
    reads `pad_hub.chat_backend` before V2 (a pad an owner moves to `hub` keeps its v1 chat; the hub learns the value
    once Q4's `pads/changed` carries it).
- **The page** (`adminchat.js`, `views/admin/chat.ejs`, `public/js/admin-chat.js`): `GET /admin/chat` and
  `GET /api/admin/chat` (same data, both `no-store`): `CHAT_HUB` (re-read from the database on every view) with when and by
  whom it last changed, the pads not on `v1` (read from `pad_hub`, the registry joined when it still has the pad; each with
  a one-click "Back to v1 chat"; a value the form doesn't know is shown as written, a row whose pad is gone is marked so,
  and a pad that isn't a site pad - a Camfrog pad a re-key left at `hub`, below - is flagged "not a site pad"),
  for owners the site pads still on `v1` (filtered in SQL; the pilot pads `patv:staff`, `patv:canary`, `patv:lounge`
  first), each list at most 500 rows with a line saying when there are more, the interlock (the twelve seam switches,
  on / off, linking to `/admin/keys#seam`), the seam poster's status (this site's queue, the `switches/changed` and
  `pads/changed` queues once Q4 adds those topics, the last post and heartbeat - `huboutbox.status()`, local state only) and
  the change log (the newest 20 `chat.*` audit rows, newest first). **It makes no call to the chat hub**, so it works while
  the hub is down (the test runs it with every connection, request and `fetch` stubbed to throw). Turning `CHAT_HUB` off
  needs only `chat_switches` and `admin_audit` (`adminchat.initCore`), never `padhub` or the registry; when the pads can't
  be read the page says so and shows the rest.
- **Who:** seeing the page and turning **off** (`CHAT_HUB` off, a pad back to `v1`) need `chat.breakglass` (siteperms,
  locked at Admin, lock reason `ops`): any admin, one click, never refused. Turning **on** (`CHAT_HUB` on, a pad to `hub`) is
  a Pepe owner's: `staffroles.ownerHolds(me, "chat.breakglass")` (the Admin class and Pepe's owner role on the linked chat
  login, read fresh), 403 `owner_only` otherwise.
- **The confirm step** (server-enforced): an owner's on-post without `confirm: true` answers 409 `confirm` with what would
  happen (`preview`: the pads on the hub for `CHAT_HUB`; the pad's title and whether `CHAT_HUB` is on for a pad) and writes
  nothing; the page asks with that text and only a yes posts again with `confirm: true`. The step is decided on the state
  read **inside the writing transaction** (`CHAT_HUB`; the pad, its platform and its backend), so a stale page or a retry
  can't undo, unconfirmed, an admin's off that landed in between (`dbUtils.tx` runs one transaction at a time).
- **Every change:** `POST /api/admin/chat/hub {on, reason, confirm?}` and `POST /api/admin/chat/pad {room_id, backend,
  reason, confirm?}` are same-origin fetches (ADR 0007 D15's `sameOriginStrict`, as `adminkeys.js`: `X-Requested-With:
  fetch` and an Origin, else a Referer, whose host **is** this request's Host - no `www.` folding, stricter than
  `authGuard.sameOriginFetch`; else 403 `cross_site`), answer `Cache-Control: no-store`, need a reason (400
  `reason_required`: format characters - zero-width, bidi controls, BOM - and lone surrogates out; control characters, NEL
  and line / paragraph separators to a space; spaces folded; at least one letter or digit; at most 200 UTF-16 units, cut
  between characters) and write one `admin_audit` row with it, in the change's own transaction. A post that changes nothing
  (the value already there, or `off` while `CHAT_HUB` has no row) answers `changed: false` and writes nothing: no audit
  row, no `chat_switches` row, `updated` / `updated_by` untouched. A change whose row can't be written answers 500
  "nothing changed" - off included: D15's every-change-is-audited rule wins over "never refused" when the site's own
  database refuses the row (the database that would hold the switch). The page shows refusals from `js.admchat.e.<code>`
  (the server's text for a code it doesn't know).
- **When the page itself can't be used** (the site is up but `/admin/chat` fails): an owner on the VM sets the row with the
  sqlite3 CLI (`UPDATE chat_switches SET value = 'off', updated = <ms>, updated_by = '<name>' WHERE key = 'CHAT_HUB'`) and
  records why in `admin_audit` by hand; the seam's trigger carries it to the hub, and readers that use `chatHubOnNow()` see
  it at once (the cache: the next `/admin/chat` view or a restart).
- **The interlock** (S1-D7, seam plan §12.10): `CHAT_HUB` on is refused (409 `chat_hub_needs`, `missing` names the
  switches) unless `tickets`, `sessions`, `heartbeat`, `privacy`, `erasure`, `export`, `pads`, `roles`, `bans`, `identity`,
  `looks` and `switches` are all on - read from `hubseam_settings` inside the writing transaction; a switch huboutbox doesn't
  have yet (Q4's four) reads as off. Turning `CHAT_HUB` off is never refused. The other half (no seam switch it needs goes
  off while it is on, 409 `chat_hub_on`) is Q4's, in `huboutbox.setSettings`.
- **The admin nav's Chat group** (`views/partials/admin-nav.ejs`): "💬 Chat hub" → `/admin/chat` with its sections, shown to
  `chat.breakglass` holders. The siteperms group `chat` also has `chat.mod_queue` (Assistant) and `chat.audit` (Admin) for
  V2's moderation screens (`adminchat.MOD_VIEWS`: `/admin/chat/{reports,held,modlog,bans}` and `{audit,switches}`), which
  V2 (release L4) hosts and adds to the group; until then nothing opens with them.
- **Logs:** `[adminchat] <what>: <error>` and `[chatswitches] reload: <error>` only - never a reason, pad, account or value.
- **Tests:** `test/adminchat.test.js` (no hub call; who sees it and the nav; cross-site, header-less, `www.`-folded and
  signed-out posts refused; a reason on every change, the stricter cleaning; the interlock; an admin turns off but not on;
  the owner turns on after the confirm step; one audit row per change and none for no change (no `chat_switches` write
  either - a write-counting trigger - for the default with no row; a hand-edited `ON` rewritten with its audit row); a
  failing audit insert rolls the switch and the pad back; the two races (a stale on-post during an admin's off, for
  `CHAT_HUB` and for a pad), driven from the reads themselves - a stub on `chatswitches.chatHubOnNow` and the pad read
  through `adminchat._setPadRead` - so a read moved out of the transaction, or to the cache, fails; an out-of-band off
  (the sqlite3 CLI fallback, no `load()`) then an on-post without confirm answers 409 `confirm`; the interlock with a
  `CHAT_HUB` row there (and a hand-edited `ON`), through the route and `set()`; Camfrog and profile pads can't pick
  `hub`, `hub_read` refused, unknown pads 404, a hand-edited value and a row whose pad is gone put back; the platform
  column wins over the id's prefix (a `patv:` id that is a Camfrog pad refused and not offered, a site pad without the
  prefix allowed); `PATV staff` in `room_events`; `padhub` down; the 500-row bounds; the JSON `no-store`, the switch read
  fresh, the log newest first; escaped titles, room ids and reasons; the "not a site pad" flag),
  `test/admin-chat-js.test.js` (the page script in a vm: no `confirm` on
  a first on-post, the question from the server's preview, a no posts nothing more, off is one post, the reason prompt, the
  refusal texts), `test/siteperms.test.js` (the three capabilities' classes and locks).
- **i18n:** new keys only - `admchat.*`, `js.admchat.*` (`js.admchat.e.*` the refusals), `siteperm.g.chat`,
  `siteperm.k.chat.*`.
- **Open (cross-slice, not V1's code): a pad at `hub` re-keyed into a Camfrog pad.** `padrekey.js` moves every room-id
  column, `pad_hub` included (`ROOM_COLUMNS`), so a site pad at `hub` whose owner connects it to Camfrog (`padconnect`
  re-keys it to the room's id, platform `camfrog`) becomes a Camfrog pad at `hub`, against D3's "hub only on site pads"
  and the bridge's chat. `/admin/chat` lists it, flags it "not a site pad" and any admin moves it back in one click, but
  nothing refuses or resets it. The fix belongs to Q4 (`chat_backend`'s writers and the displaced-row emit) or to
  `padconnect`: refuse to connect a pad at `hub`, or reset it to `v1` in the re-key. **Closed by Q4's review fixes:**
  `padhub`'s trigger `pad_hub_site_only` resets a pad that stops being a site pad to `v1` in the same statement (the
  Camfrog re-key, a Twitch connect, any writer), with a `chat-backend` event naming `PATV staff`; the flag stays for a
  value written by hand.

## Fixtures and the contract suite

- `test/fixtures/hubseam-sign-vectors.json` and `test/fixtures/hubseam-golden-rows.json` are byte-identical in the hub repo
  and pinned by sha256 in both (`test/hubsign.test.js`; `PATV_HUB_DIR=<hub checkout>` also compares the copies). The
  golden rows are what each v1 builder must produce (`test/hubseam-golden.test.js`; 1.99ads: the S1 section `s1` -
  `test/huboutbox-s1.test.js` for identity and looks, S1 Q4: `test/huboutbox-s1-l1.test.js` for pads, roles, bans and
  switches) and what the hub makes of them. `.gitattributes` keeps them LF on
  every checkout.
- `tools/hubseam-driver.js` is v1's side of the hub's contract suite (`services/rooms/test/seam-contract.integration.test.ts`,
  run with `PATV_V1_DIR` pointing at this checkout): v1's real modules on a throwaway SQLite database in a fresh directory
  under the OS temp dir (it refuses any other), driven over JSON lines on stdin / stdout. It is outside `test/` on purpose
  (`node --test test/` runs every file there). How to run the suite: the hub repo's `docs/seam-contract.md`.

## Switches (`/admin/keys#seam`)

`hubseam_settings`: `tickets`, `heartbeat`, `sessions`, `privacy`, 1.99acm: `erasure` (`privacy/account-deleted` and
`privacy/forget` - one fan-out, on together) and `export` (the hub part of "Download my data"), `econ`, 1.99ads: `identity`
and `looks` (the S1 topics above; `looks` also gates the hub's looks call), S1 Q4: `pads`, `roles`, `bans` and `switches`
(release L1, above) - all off - and `spans` (on). A topic whose switch is off writes nothing and serves no snapshot. `tickets` can only be on together with
`sessions` and `heartbeat` (above); while `CHAT_HUB` is on (`/admin/chat`), none of its twelve switches may go off (S1 Q4). The turn-on order on staging: hub `SEAM_ENABLED` → `heartbeat` → `sessions` →
`privacy` → (S1) `erasure`, `export`. `/admin/keys#seam` also shows the seam environment and any outbound refusal, the
per-topic queues, the hub's last snapshot and rewind calls and refusals, and exports waiting for the hub.

When the privacy switches go on in S1, the privacy page names the chat hub in deletion and export (S1 V4, above: the
paragraph appears with `erasure`, its export sentence with `export`).

## Bridge spans (`bridgespans.js`)

`bridge_spans(room_id, session, opened_at, last_seen, closed_at, close_reason)` records when each Camfrog room was bridged,
from Pepe's syncs, for the later VM-log import (R-10). A span opens on the first sync that carries the room, closes on
`closed[]` (`closed`), a `room.left` event (`left`), or 10 minutes without the room (`timeout`, at `last_seen + 10 min`).
It only records and never affects the sync.

## Environment summary

`CHAT_TICKET_KEY`, `CHAT_TICKET_KID`, `CHAT_TICKET_PREV_PUB`, `CHAT_TICKET_PREV_KID`, `CHAT_GENESIS_NS`, `HUB_V1_URL`,
`HUB_V1_KEY_ID`, `HUB_V1_KEY`, `HUB_V1_PROXY`, 1.99acm: `HUB_V1_ENV`, `HUB_V1_IN_KEY_ID`, `HUB_V1_IN_KEY`,
`HUB_V1_IN_PREV_KEY_ID`, `HUB_V1_IN_PREV_KEY` (names in `.env.example`, no values). Keys are per direction and per
environment (four in all: v1 → hub and hub → v1, prod and staging), each generated separately (never one secret for two
key ids: `key_reuse`), at least 32 random characters, and never printed: the operator copies them from the hub's SOPS
file into the site's `.env` (0600).

**Operator steps** (nothing here is live until they are done; every switch defaults off):
1. nginx: `location ~* ^/internal/ { return 404; }` on the public server blocks of prod, www and staging, then
   `bash deploy/check-internal.sh` (deploy/README.md) - before `HUB_V1_IN_KEY_ID` / `HUB_V1_IN_KEY` are set.
2. `tailscale serve` mapping `/internal/v1/` to the site (127.0.0.1:3000 prod, :3100 staging), unchanged paths.
3. The keys above, from the hub's SOPS file; `HUB_V1_ENV`; `HUB_V1_URL` (an origin: https, or http to loopback / the
   tailnet) and `HUB_V1_PROXY` for an http tailnet hub.
4. The switches, in the order under "Switches".

A staging DB refresh (`deploy/keep-staging-tables.js`) keeps staging's own keys and switches, empties `hub_outbox` (its id
sequence carries on) and, 1.99acm, `hub_hidden_h` and `hub_inbound_nonces` (1.99add: and `hub_hidden_meta`, `hub_hidden_held`) -
those first, the outbox last, since the copy carries prod's triggers - and marks prod's unfinished exports expired
(`refresh-staging-db.sh`).

**Pepe's hidden set** (`hubhidden.js`, 1.99acm): the hub's copy, `hub_hidden_h`, is stored only while the `privacy` switch
is on; turning the switch off empties it (without a row for the hub), and the first write after it turns on writes the whole
set. 1.99add: the set is **sticky** (the chat-history design's rule, spec §3.1): an empty, short or truncated list (Pepe's
bridge state file failed to load, his 3,000 cut) un-hides nobody, and the set itself is kept in `hub_hidden_set` **whatever
the switches say**.

**Kinds** (1.99add refix 4, the owner's rule of 2026-10-19: incognito hides WHO, not WHAT). Each hash carries one row per
reason it is hidden (`hub_hidden_set (h, kind, since, src)`):

| kind | from | what readers do |
|---|---|---|
| `bridge` | `!bridge hide`: `privacy.hidden {scope: bridge}`, a `bridge_hidden_h` list | **left out** - quote lines dropped (also from the post's text), the hub leaves them out |
| `incognito` | `!incognito` / Settings: Pepe's ON report, his full incognito list, `privacy.hidden {scope: incognito}`, an `incog_hidden_h` list, a website ON (`src` `web` until Pepe applies it) | **"someone"** - no name, the words stay; the hub row carries `scope: "incognito"` |
| `unknown` | an older Pepe's mixed `hidden_h` (prod Pepe 1.99adc sends only that) | **left out** (fail closed): on 1.99adc incognito people are left out too, until Pepe sends the kinds |

A hash is hidden while it has any kind; `quotes.isHidden` (any kind) drives pad tips (refused as private), boost and go-live
lines (no name) and @mention alerts (none), and 🔊 mic clips are refused (a voice says who it is); `quotes.isLeftOut` picks the
lines a quote drops. The hub's `hh:<h>` row gains `scope: "incognito"` when that is the only kind - an optional field the S0
hub ignores (it keeps leaving everyone out until its consumer reads `scope`; the golden row, an older Pepe's hash, is
unchanged); a change of scope is a row too (trigger `hub_outbox_hh_update`).

**Wire** (what the site accepts; the bot half is CL1's): `hidden_h` (everyone hidden now, mixed), `bridge_hidden_h` and
`incog_hidden_h` (a Pepe that knows why - each **left out (null)** when that state failed to load, so a list he sends is one he
vouches for), `tx_hidden_h` (marks a CL1 Pepe that sends `privacy.shown`), events `privacy.hidden` / `privacy.shown
{h, scope}` with their own `id` and `ts`. Pepe must send `privacy.shown` **per scope, every time** (a `!bridge show` while still
incognito is `shown {scope: bridge}`), and his send-time redaction must send incognito people's lines anonymised, not drop them.

**Removed** - each un-hide takes away only its own kind, and the hub hears `value:false` only when no kind is left:
- `privacy.shown {h, scope}` → that kind; also the `unknown` row when no list of the same sync carries the hash. Not when the
  same sync's list of that kind still carries it; not a resend (an event `id` already taken); not in a late post of an older
  run; not one older (his clock) than a hide of that kind that arrived in the last `STALE_MS` (120 s - a late post; older than
  that, his clock went back since and it counts);
- Pepe's incognito OFF report (linked or not, changed or not - he has them off) → the `incognito` row, unless older than an ON
  of theirs that arrived in the last `STALE_MS`. An ON report always hides (one that looks older than his last OFF means his
  clock went back); his full list (every 10 min) only adds, skipping a login whose OFF arrived in the last `STALE_MS`;
- `incognito.actionsSettled` / `reconcileWeb`: a website ON Pepe never applied → its `web` row;
- an older Pepe (no `tx_hidden_h`): the `unknown` row of a hash his list had and **two** whole, in-order lists of the same
  bridge `session` in a row lack (one short list - a read that failed once - un-hides nobody, and the hub hears nothing); at the
  **first** such list when his own real OFF report dated after the list that still had them and no later than the first without
  explains it. More than 5 unexplained in one list (or more than 10 % of the set, when 2+) are held (`mass`). The hashes absent
  once are kept with `last` (a site restart in between changes nothing). Prod Pepe 1.99adc passes on a `!bridge show`, an
  `!incognito off` and an admin-panel un-hide this way - **deploy this after the acl-nick bot fix** (`G:/wt/acl-nick-bot`): on
  prod bot 5505fe1 a room-line impersonator can type `!bridge show` or `!incognito off` for someone else;
- a Pepe that knows the kinds: an `unknown` row his vouched lists carry becomes those kinds (not an un-hide); one neither carries
  (and his mixed list doesn't either) is held once per run (`legacy`);
- an owner on `/admin/keys#seam`: `POST /api/admin/hubseam/unhide {login | h, kind, reason}` (one kind or `all`; the audit row -
  hash, kind asked, kinds it had - and the stored rows in one transaction; a hash is written `#` + 20 hex - anything else is a
  chat login), or approving a held batch (`POST /api/admin/hubseam/held {id, approve, reason}`: its `unknown` rows go - someone
  also incognito stays "someone"; audited with id, kind and count, never a hash). `POST /api/admin/hubseam/check {login | h}`
  answers the kinds, held batch and "absent once" and changes nothing - **audited** (`hubseam.check`, the hash only).

A row Pepe hides again while an owner's un-hide or approval commits stays (it comes back with the next write).

**Held** (`hub_hidden_held`): `unknown` rows that vanished in a way that can also be a lost state stay until an owner decides -
`mass`, `restart` (what an older Pepe's last list had - or lacked once - and his first whole list after a restart lacks, unless
his OFF report explains it: a `!bridge show` just before the restart looks exactly like a bridge file that failed to load) and
`legacy`. A held hash Pepe lists again leaves its batch. A `mass` batch whose other hashes were all explained (Pepe's own word
about a change between the list that had them and the first without, `prev_ts` < at <= `sent_ts`, his clock) releases its last
one; an owner's un-hide or a merge makes it `manual`. The seam card lists every open batch by id, kind, count, time and how many
of it stay hidden another way. **Approving a batch that really was Pepe losing track shows all of them by name again and nobody
can say who they were** - the help text says so. A held member can fix it in a bridged room with `!bridge hide`, then `!bridge show`.

**Order.** Lists of one run are taken in the order they arrive; his `sent` and his reports' `ts` are compared only with each
other, never with the site's clock (the card shows the difference). A list whose `sent` is older than the one before it (his
clock went back, or a late post) is compared with nothing, but the next is compared with it **and** with what the list before
it had (nothing it lacked is skipped), and no window from it explains a drop. A list of an older run only adds; one without a
`sent` only adds; an older Pepe's list of 3,000 or more proves nothing by what it lacks.

**Start-up.** `hubhidden.boot()` (from `bridge.register`, first; a failed read is tried again after 5 s, 30 s, then every
120 s) loads the set, the list compared with, the hashes absent once, the OFF reports that explain drops (`offs`) and the open
held batches. **Until that read has worked every reader hides everyone** (`hubhidden.loading()`: quotes refuse, a quote card
shows no line and nothing is stored, tips are refused, no names in boost / go-live lines, no mention alerts) - a failed read
never names anyone - and a list only adds. A staging DB refresh keeps prod's `hub_hidden_set` (hidden on prod = hidden on
staging) and empties `hub_hidden_meta` and `hub_hidden_held`.

**What stays held for an owner on an older Pepe** (CL1's events with kinds make these explicit): a `!bridge show` just before he
restarts, two or more people un-hiding in one tick when that is more than 10 % of a small set. **What can still un-hide wrongly**
(accepted on an older Pepe; a kinded CL1 Pepe fixes it): someone on BOTH incognito and `!bridge hide` whose bridge file was lost
at a restart, once they really turn incognito off; someone who typed `!bridge hide` while no room was
bridged (an older Pepe sends nothing then) shows by name after their incognito OFF until his next list carries them again; a lasting in-run loss of up to 5 hashes (10 %) is taken as their `!bridge show` - someone Pepe has
reported as incognito still shows as "someone" then, never by name. While no room is bridged an older Pepe sends no lists, so an
`unknown` row waits for the next one (left out meanwhile).

The chat archive's own switch-independent set is `chatlog_hidden` (CL2, `chatlog.js`): the same inputs and kinds (its reasons;
`chatlog.kindsOf` / `hubRows()` map them onto this set's rows), but stickier - it un-hides only on Pepe's explicit `privacy.shown`
{scope} or an operator's decision on `/admin/bridge` (never on an older Pepe's drop or an OFF report). **Train 2 (train2-site +
cl-site): ONE reader rule** - `quotes.isHidden` (pad tips, boost / go-live names, @mention alerts, mic clips, the 🎙 mic stage) and
the quote rules hide whom EITHER set hides (left out if either leaves them out; everyone while either loads), so nothing on the
site names a person the live chat, its history, search or downloads show as "someone" or leave out. **Train 3 review: the chat's
own readers too** - `chatlogview.kindNow` (privacyOf, the roster, isHiddenLogin, the hidden-names job) is the STRICTER of
`chatlog.hiddenKind` and this set's kind (bridge / unknown -> left out, incognito -> "someone"; while this set's start-up read is
still running the chat reads the archive's set alone - itself fail-closed while it loads - rather than blank every pad), so a
person only this set holds (the first deploy: `chatlog_hidden` starts empty and is never seeded from here; a held
older-Pepe drop) is not named in the chat either. A change here re-runs the hidden-names job and bumps open pages' privacy digest;
it doesn't push `removed` / `redo` to open live pages (both stores take the same inputs, so the archive's own change does that).
Still two stores: an un-hide now needs BOTH - an owner's un-hide here (`/admin/keys#seam`) names nobody while the archive's set
still hides them (its own held / operator tools on `/admin/bridge` decide there), nor the other way round - and the hub's `hh:`
cache reads this set alone. Folding the two into one table (one held table, one owner tool) is open.
