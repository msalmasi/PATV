# The AI judge as an oracle client (Phase 5, 5.15)

The design is `docs/backend-migration-audit.md` §5.15. The code: site `oracle.js`, bot `pepe_aioracle.py` (+ two hooks in
`pepe_aijudge.py`). Tests: site `test/oracle.test.js` (a real escrow pool settled by the site), bot - the judge's own tests.

## Why it splits this way

The judge stays in Pepe: it needs his Camfrog records (chat logs, mic transcripts, joins, cams, his vision check) and the
LLMs. What moves is the part that decides money: the **proposal record, the dispute window and the settle**. Pepe only
proposes. The site settles every item it owns as one site transition; an item that still lives in Pepe is settled by Pepe
when the site says the window is over.

## The switches

- site `oracle_meta.enabled` - default on on staging (`STAGING`), off on prod; admin `POST /api/admin/oracle {on}`.
- Pepe `aijudge_client.json` `on` - `!aijudge backend status | on confirm | off confirm` (or the panel's Backends card).
  `on` is refused unless the site answers and its switch is on.

Off (either side): the judge runs its own window and settles as before (v1 1.90 → 1.99jx behaviour).

## Bot routes (bot token, POST)

| Route | Body | Answer |
|---|---|---|
| `/api/oracle/bot/propose` | `{key, kind, ref, outcome, raw, result, confidence, reason, evidence, window_s, need_disputes, judge, pepe_login}` | `{ok, key, state, until, owner}` |
| `/api/oracle/bot/dispute` | `{kind, ref, login, why, checked}` | `{ok, state, n, need}` or `{ok:false, code: no_proposal / not_in_it / already}` |
| `/api/oracle/bot/feed` | `{after, limit}` | `{ok, events: [{seq, key, kind, ref, event, data, ts}], last}` |
| `/api/oracle/bot/settled` | `{key, ok, error}` | `{ok, state}` |
| `/api/oracle/bot/get` | `{kind, ref}` | `{ok, proposal}` |
| `/api/oracle/bot/status` | `{}` | `{ok, enabled}` |

Public: `GET /api/oracle/:kind/:ref` → the latest ruling (outcome, confidence, reason, state, window, dispute count).

- `kind`: `market` (an LMSR market), `pool` (a parimutuel betting pool), `wager`. `ref`: `M12` / `W3`.
- `key`: Pepe's `aj:<kind>:<id>:<try>`. Idempotent: the same key answers the stored proposal. A new key on the same item
  **supersedes** the open proposal (event `superseded`).
- `outcome`: the exact argument of the settle - an option (`yes`), a wager's winner login, or `void <why>`. The site never
  re-interprets it.
- `window_s`: the dispute window (Pepe's `AI_DISPUTE_MINUTES`, 60 min). `need_disputes`: 2 on markets and pools, 1 on a wager.
- `evidence`: `{text, price, auto}` - what the judge saw (the web / Camfrog summary, the exchange-candle check, an auto
  market's data record). Kept with the proposal (≤ 20 KB).
- `checked: true` on a dispute = Pepe already checked the person is in it (his own items). For a site-owned item without
  it, the site checks the participants itself (pool bettors + creator, the wager's two sides).

## States and events

```
proposed --(window ends, undisputed)--> settled (the site settled it)      event "settled"
         |                           \-> due (Pepe owns it) --ack--> settled / failed
         |--(need disputes)--> disputed (an admin settles by hand; never auto-settled)
         |--(a newer proposal)--> superseded
         \--(the item was decided meanwhile)--> superseded
site settle refused --> failed (Pepe tells the admins)
```

Feed events: `proposed`, `superseded`, `disputed`, `due`, `settled`, `failed`. Pepe reads them with his cursor (every 20 s):
`due` → he finalises like his old sweep (`_wager_settle` / `_market_settle` as the judge) and acks `/settled`; `settled` →
his copy goes `final`; `disputed` → his copy goes `disputed` and the admins are told; `failed` → the admins are told.

## Owners: the resolver contract

```js
oracle.registerResolver(kind, {
  owner: async (ref) => "site" | "pepe",        // who settles this item now
  decidable: async (ref) => bool,               // can it still be settled (open / closed, not decided)
  settle: async (ref, outcome, key, pepeLogin) => ({ ok, error }),   // the site's transition, as Pepe's AI judge
  participants: async (ref) => [logins],        // optional: who may dispute (lower case)
})
```

- `pool` and `wager` are registered by `oracle.js` on the **escrow engine** (`escrow/games.js`): owner `site` while
  `live:pools` / `live:wagers`, else `pepe`; settle = `games.act(game, {verb: "settle", actor: {pepe: true, login, via:
  "oracle"}, args: {ref, outcome}, idem: "oracle-<key>"})` - the same keyed, one-transaction settle Pepe's own call uses.
- `market` (LMSR) is **Pepe-owned until Phase 3 registers its resolver.** Phase 3 (the capital engine) only has to call
  `require("./oracle").registerResolver("market", {...})` with its own `settle` (its `act("settle", {pepe: true, ...})`)
  and `owner` = its live switch. Nothing else in the oracle, in Pepe or in this contract changes; a proposal made while the
  market lived in Pepe and settled after the market moved is settled by whoever owns it when the window ends.

## The rule (switch on, site down)

Pepe queues the proposal under its key (`aijudge_client.json` outbox, sent in order until the site answers) and **never**
finalises an oracle call locally - his sweep skips every item whose AI state carries an oracle key. A dispute says the site
isn't answering. If the site refuses a proposal (switched off, the item already decided), that call falls back to the
local window and the refusal is kept in `aijudge_client.json` `refused`.

Turning Pepe's switch off: calls already proposed fall back to their local window; the site's later `due` for them is
ignored, and a site-owned item it settles meanwhile is settled once (the escrow engine refuses a second settle).

## Staging

`oracle_meta.enabled` defaults on there; Pepe's switch is off until an admin runs `!aijudge backend on confirm`.

## Admins: /admin/oracle (1.99uc)

`oracleadmin.js` + `oracle.js` (`adminList` / `adminSummary` / `adminDetail` / `adminAct`), page `views/admin/oracle.ejs`,
script `public/js/admin-oracle.js`, tests `test/oracle-admin.test.js`. Admins only; linked from the admin nav and /admin/economy.

- **The list**: newest first, filters status (`window` = proposed and still open, `proposed`, `disputed`, `due`, `settled`,
  `overridden`, `failed`, `superseded`), kind and date; summary tiles (open in window, disputed, due for Pepe, failed,
  settled in the last 7 days). **The detail**: the rationale and the evidence (escaped; http(s) links only), the timeline
  (the row + the feed's events + the admin actions, which outlive the feed's 14 days), the disputes and their status.
- **Actions** (`POST /api/admin/oracle/act {key, action, idem, minutes, outcome, reason, login}`, same-site + `X-Requested-With:
  fetch`). Each is keyed by `idem` (`oracle_admin_actions`; the same key answers the stored result), runs in one transaction on a
  fresh read of the proposal, and goes to `admin_audit` (`oracle.<action>`):
  - `extend` (5 min to 7 days; only `proposed`) - event `extended`;
  - `uphold` = settle now: a site-owned item is settled through its resolver **as the admin** (`settle(ref, outcome, key, null,
    actor)`, keyed `<key>:adm:<idem>`) from `proposed` / `disputed` / `failed` -> `settled`, event `settled`; a Pepe-owned one only
    from `proposed` -> `due` (Pepe settles with his own copy of the call, which is why he can't take an override);
  - `override` (a different outcome, reason required) / `void` (`void <why>`, a wager `void`): site-owned only -> `overridden`,
    event `settled` with `{override: true, judge_outcome}` (Pepe's copy goes final);
  - `reject_dispute {login}`: the dispute stays, marked `rejected`, and stops counting; a site-owned call it had escalated goes
    back to `proposed` with at least 15 minutes left - event `dispute_rejected`. A rejected disputer can't file again;
  - `reask`: `superseded` + event `reask`; Pepe forgets the call and its disputes and judges the item again (a new key). Offered
    only while Pepe's feed poll says it handles it (`caps: ["reask"]` on `/api/oracle/bot/feed`, bot 1.99uc, fresher than 10 min).
- New columns: `final_outcome`, `decided_by` (`window` | `pepe` | `admin:<name>`), `admin_reason`. The window's tick now handles
  each row in one transaction and only while it is still `proposed`, so an admin's action is never overwritten.
- Users dispute from the item page (`/markets/<id>` for markets and pools, `/wagers`) or in the room; that goes through Pepe
  (`!market dispute` / `!wager dispute`, `checked: true`). The site has no direct dispute route of its own.
