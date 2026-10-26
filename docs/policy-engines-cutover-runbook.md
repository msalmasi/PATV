# Policy engines cutover runbook: Pepe → the site's scheduler (Phase 4)

The design is `docs/backend-migration-audit.md` §5.12 (policy ticks), §5.13 (room vaults, launchpad, E-4) and §6 Phase 4.
The code:
- **site** `policy/` - `engines.js` (the plans, ported from Python expression for expression), `gather.js` (the inputs from
  the site's tables + Pepe's pushed docs), `apply.js` (the live runs), `scheduler.js` (the clock, modes, shadow reports,
  cutover / rollback, routes), `core.js` (the store); the admin card `views/partials/econ-policy.ejs` + `public/js/admin-policy.js`;
  hooks in `supplyhistory.js` (the site's mints), `jackpotflows.js` (`policy:` House legs), `econstore.js` (the 413 fix).
- **bot** `pepe_policyclient.py` (the switch, effects, shadow reports, the handshake, `!econ engines`), `pepe_policyinputs.py`
  (the inputs object), gates in `pepe_treasury.py`, `pepe_monetary.py`, `pepe_burn.py`; `tools/gen_policy_vectors.py`.

## What moves, what doesn't

| Engine | Pepe's tick | On the site |
|---|---|---|
| **treasury** | `_tr_tick`: the Monday 04:00 UTC surplus waterfall (`_tr_run`) and the daily 04:00 release (`_tr_daily`) | `apply.runTreasuryEpoch` / `runTreasuryDaily`, one transaction each |
| **monetary** | `_mo_tick` (the day part): floor mint, issuance, the Monday guarantee, the ceiling release, the activity rewards | `apply.runMonetary` (mints journaled under the monthly caps; activity payouts one savepoint each) |
| **burn** | `_burn_tick` (the accrual step) | `apply.runBurn` (pool move kind `burn` + a `pat_burns` row) |

Three switches (`policy_client.json` in Pepe, `policy_engines` on the site). Treasury and monetary can move separately
(the site's monetary day reads the epoch / release journals from either side), but the recommendation is all three together.

**Not engines, and why** (the card lists them):
- **automint** - retired. Dead under the economy layers: `_automint_tick` returns at `_layers_no_mint("automint")` and prod has
  `econ_layers` on. Nothing to port.
- **the wheel cut** - already removed in 1.99pk (the House keeps 100% of wheel turnover).
- **the Casino-vault feed** (`_heist_vault_tick`) - a no-op under the live treasury: the feed is 0, the overflow runs in the daily
  release (moved), the Reserve top-up is off. The v1 path (treasury off) needs Pepe's House P&L ledger and stays his.
- **layers recovery** (`_layers_tick`) - subsumed: each site run is one transaction keyed by its period, so there is nothing
  half-done to finish. Pepe keeps it for his own Fed operations.

**Staying in Pepe** (Phase 4b / v2):
- the Fed's *event* operations - `!econ mint`, `!econ fund` (grants), `!econ fedloan`, flash liquidity, donation mints, the seed,
  restores. Their PAT already moves on the site's pools (Phase 1) and their protocol shares on the site's book (Phase 3); what
  stays is the journal and the validation. The site reads those records from Pepe's pushed `econ_layers` (the caps, the loans).
- the E-4 room payout recipe, activity → pad vaults, profile vaults (`pepe_recipe.py`, `pepe_padtopup.py`): they score Camfrog
  observations (anti-AFK chat, speech-verified mic, presence) and pay through convoys (room wars, pinned with the heists). Their
  money legs are already keyed site pool moves. Going live ~2026-10-31; revisit after.
- the launchpad's grant payments (`_lp_tick`: an admin approves on the site, Pepe pays from his setting) and the room vaults' claim
  settling (`_rv_settle_claim` feeds the E-4 inflow journal). Both are event paths; momentum and the review queue are already the site's.
- the incentive budget's week record (`econ_treasury.week`): Pepe's routed payouts count their spend in it at the moment they pay
  (the room games' pacing); the site's activity rewards add their spend through an effect.

## The rules

- **The switch.** Pepe runs an engine ONLY while its switch is explicitly off. On (or `"cutting"`, or an unreadable
  `policy_client.json`) he never runs it, even with the site down: the site runs the period when it is back.
- **One runner per period.** The site's done-key `policy_runs "<engine>:<period>"` is written in the run's transaction; the
  periods Pepe ran before the cutover are recorded as `handed`. Every leg uses the key Pepe's own leg uses (pools
  `"<tid>:out"` / `"<tid>:in"`, the stash move key, `"fedmint-<key>:in"`, the capital booking `"vaults:proto-wf-<epoch>-<vault>"`),
  so even if both sides ever ran one, the second is a no-op leg by leg.
- **One scheduler process.** `policy_lease "scheduler"` (90 s, renewed every 15 s pass). A second process or a restart waits it out.
- **Catch-up cap = 1.** After an outage only the current period runs (late, once). An earlier period that was never run is
  recorded `missed` and never run late - Pepe's `armed_at` rule, which never ran a past day either.
- **Modes.** `off` → `dry` (the site plans each period and records what would move: `policy_sims dry:*`) → `shadow` (the same, plus
  Pepe's report for every period he runs: the **engine diff** = the site's plan on Pepe's inputs vs his plan, must be empty; the
  **inputs diff** = the site's inputs vs his; the **total diff** = the site's plan on its own inputs vs his) → `live` (only through the
  handshake below). Admins switch off / dry / shadow on /admin/economy (audit-logged, `policy_audit` + `admin_audit`).
- **Pepe's books stay his record.** What the site does reaches Pepe as `policy_effects` (epoch / day records, Fed mints with
  `via: "site"`, Fed loan repayments → `_fl_apply_repay`, budget spends, bank-lent samples, cap notices → admin inbox, burns →
  `burns.json` + the announcement, run failures → admin inbox), applied in order, once each, then acked. The site never needs the
  ack to stay right: `gather.js` overlays its own effects on Pepe's pushed docs by content (a loan repayment whose mark isn't in
  `fed_loan_repaid`, a mint whose key isn't in `fed_mints`, ...).
- **Supply.** The waterfall and the release move PAT between pools, the House and stashes (checked `conserved` in each run); the
  monetary day changes the supply by exactly its mints; the burn lowers it by exactly the burn. `supply_history` gets the site's
  mints per day (`site_mints`, merged when read; Pepe leaves the site's records out of his map) and a row update after every live run.

## 0. When

- **After** the pools (Phase 1) and the capital cluster (Phase 3) are live on prod - the waterfall redeems the protocol's shares
  on the site's share book (the site refuses `capital_local`, Pepe refuses too).
- **After** the site fix for `/api/econ/docs/put` is on prod and Pepe's docs have flowed for a day (see §"PayloadTooLarge").
- Not within 20 minutes of 04:00 UTC (both sides refuse), not during a Monday epoch run.
- In a week with no change to the Monday epoch's settings, after at least one clean shadow Monday (engine diff and total diff empty).

## 1. Deploy (site first, then bot)

Site ≥ 1.99uo (`6ff3664`; contains 1.99ug `1529f05` and 1.99um `43f276a`), bot ≥ 1.99un (`a87ed52`; 1.99ug `b4f0d3d`, 1.99um `2d47996`).
Every mode defaults to `off`; with the site's modes off Pepe sends nothing new and runs everything as before.
After the site deploy, check that Pepe's econ docs land again: `sqlite3 /home/PATV/myapp.db "SELECT name, rev, updated FROM econ_docs"`
(`updated` moves within minutes) and that `grep -c PayloadTooLarge ~/.pm2/logs/index-error.log` stops growing.

## 2. Dry run (at least one 04:00 UTC tick)

Admin card (/admin/economy → ⏱️ Policy scheduler): engine `treasury`, mode `dry run`, Set; the same for `monetary` and `burn`.
After 04:00 UTC: the card shows each engine's last plan; `sqlite3 /home/PATV/myapp.db "SELECT key, site_plan FROM policy_sims WHERE mode='dry'"`.
Nothing moves (supply and every pool unchanged). **A prod write (mode rows): the user's go.**

## 3. Shadow (at least one Monday epoch)

Set the three engines to `shadow`. Pepe reads the mode within 20 s and from then on reports every period he runs (before his legs
move). Each report's diffs: the card's "Last diff" column, Pepe's log `[POLICY] shadow <engine> <period>: engine diff N, inputs
diff N, total diff N`, and `SELECT key, engine_diff, input_diff, total_diff FROM policy_sims WHERE mode='shadow' ORDER BY updated`.
Gate for the cutover: every engine diff empty; every total diff empty (input diffs that change no output are fine - e.g. a
journal one push behind). **A prod write: the user's go.**

## 4. Backups

```
TS=$(date -u +%Y%m%dT%H%M%SZ)
sqlite3 /home/PATV/myapp.db ".backup /home/PATV-backups/myapp-pre-policy-cutover-$TS.db"
```
Pepe (prod VM, PowerShell):
```
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"); $d = "C:\PATV\backups\policy-cutover-$ts"; New-Item -ItemType Directory $d
Copy-Item C:\PATV\camfrog-bot\turf_data.json, C:\PATV\camfrog-bot\vaults.json, C:\PATV\camfrog-bot\burns.json $d
Copy-Item C:\PATV\camfrog-bot\policy_client.json $d -ErrorAction SilentlyContinue
```

## 5. Cutover

1. Dry run: `!econ engines export all` (or `{"action":"dryrun"}` in `C:\PATV\policy-cutover.request.json`, result in
   `C:\PATV\policy-cutover.result.json`). It lists what will be handed over (the periods Pepe ran, his `armed_at`) and anything
   that blocks it.
2. `!econ engines cutover all confirm` (or `{"action":"cutover","actor":"<who>"}`). Pepe switches the engines to `cutting` (= on:
   nothing runs here from this moment), then the site checks: the pools and the share book live, each engine in shadow; records
   the handed-over periods; sets the engines live with Pepe's `armed_at`. Pepe's switches go on and he pushes his config.
   A refusal turns the switches explicitly off again (Pepe runs them); no answer leaves them on - retry the same key.
3. Verify: `!econ engines status` = `SITE (site mode live)` for each; the card shows `LIVE on the site`;
   `SELECT key, state, via FROM policy_runs ORDER BY created` lists the `handed` periods.
**A prod write: the user's go.**

## 6. After the cutover

- The next 04:00 UTC: `SELECT key, state, error, result FROM policy_runs ORDER BY created DESC LIMIT 5` - `done`, `conserved: true`;
  Pepe's log shows the effects applied; `!econ monetary` / `!econ budget` / the admin card show the site's numbers.
- A failed run is rolled back (nothing moved), retried every 5 minutes, and the admins get an inbox notice.

## 7. Rollback (while the site answers)

`!econ engines rollback all confirm` (or `{"action":"rollback","actor":"<who>"}`). Refused while a run is mid-move. The site sets
the engines back to **shadow**, answers every period it ran and every effect Pepe hasn't applied; Pepe applies them (his journals
then hold the site's periods: his tick never re-runs them) and switches off. The same key again answers the stored result.

## 8. Detach (the site is gone for good)

`!econ engines detach all confirm`. Refused while the site answers and runs them. Pepe switches off and arms his ticks **from now**
(`econ_treasury.armed_at` / `econ_monetary.armed_at`): a period whose boundary passed while the site owned it may have run there,
so it never runs here; the next boundary does.

## 9. PayloadTooLarge (found while checking, fixed in 1.99ug)

The staging site's and prod's `PayloadTooLargeError` (prod: 925 in `index-error.log` on 2026-10-12, growing ~4 a minute) is Pepe's
econ docs push, `POST /api/econ/docs/put`: since the pools cutover Pepe pushes `econ_layers`, `econ_monetary`, `econ_treasury`,
`econ_launchpad`, `econ_rooms`, `vault_marks`, ... (prod: 116,426 bytes of JSON) through index.js's global 100 KB parser. Every
push answered 413; prod's `econ_doc_revs` is `{}` and the site's `econ_docs` still hold the 2026-10-12 cutover copy (so
`fed_journal` and `incentive_groups` on /admin/economy are stale too). Same class as the pools import 413: the route now parses its
own 32 MB body and is on index.js's skip list (`test/import-body-limit.test.js`). On staging the 413s stopped with the deploy and
all eight docs landed in one push. Phase 4's site inputs depend on these docs - this fix must reach prod first.

## 10. Staging rehearsal (2026-10-12)

Site 1.99ug `1529f05` (+ 1.99um `43f276a`, 1.99uo `6ff3664`) and PepeBeta (VM 111, bot 1.99ug `b4f0d3d`, then 1.99un `a87ed52`;
both passed probation; 1.99um `2d47996` was rolled back by an unrelated "Camfrog crashed" at start and redeployed as 1.99un), on
top of staging's live Phase 1 / Phase 3. Prod's `econ_layers`, `econ_treasury` and `econ_monetary` were copied **read-only** from
VM 110 (`scp` of `turf_data.json`, nothing written there) and loaded into PepeBeta with the staging-only inject (`load_prod_copy`;
staging's own kept in `C:\PATV\camfrog-bot\policy_staging_backup_1791843599.json`). Simulated ticks used the staging test clock
with **tagged period ids** (`W2026-10-12-r1`, `D2026-10-13-r2`, ...) so no real period was used up: the Monday at 2026-10-12 04:05
UTC, the Tuesday at 2026-10-13 04:05 (monetary 05:10, after the release window).

| Step | Result |
|---|---|
| vectors | 900 committed cases (300 epoch, 300 daily, 300 monetary + activity payouts) from the REAL Python: every plan equal; 6,000 more (seed 777) checked once: 0 differences; the inverse (Python's plan from an inputs object alone) round-trips all 900 |
| dry run (`r0`) | all three engines `dry`: the Monday epoch planned surplus **11,203,668** (House) → stakers 9,193 / Fed 5,597,237 / incentives 5,597,238 (13 legs); the release planned Fort Knox overflow **205,550**; the monetary days planned (Fed 92.7M in its 50M-150M band: no mint, no release; activity → pads on staging: allowance 0). Supply and pools unchanged |
| shadow (`r1`) - Pepe ran, the site compared | epoch W2026-10-12-r1 (Pepe moved 11,203,668: stakers 9,193, Fed 5,597,237, incentives 5,597,238), release D2026-10-12-r1 (FK overflow 205,550), monetary D2026-10-12-r1 (Monday guarantee **17,254,730**), release D2026-10-13-r1, monetary D2026-10-13-r1: **engine diff 0 and total diff 0 on all five**; inputs diff 0 on the treasury, on the monetary days only the journal one push behind and staging's participation rows (the staging DB is a prod copy, PepeBeta has his own rows) - neither changes a number (activity → pads) |
| cutover `pc4-rehearsal-1` | treasury, monetary, burn live; 11 periods handed over (`handed`), Pepe's `armed_at` kept |
| live (`r2`) - the site ran | epoch W2026-10-12-r2 (surplus 0: r1 had taken it), release D2026-10-12-r2 / D2026-10-13-r2, monetary D2026-10-12-r2 (guarantee **17,254,730** paid by the site, the leg `mo-D2026-10-12-r2-guarantee`) and D2026-10-13-r2; every run `conserved: true`. **Python on the site's own inputs (`--replay`): 5 / 5 plans equal** |
| live burn | PepeBeta's stagetest moved 250,000 Reserve → burn reserve; the site's accrual burned it within the slot (`S1`, `burn:S1-8f490542fe98`, kind `burn`); supply **1,303,320,798 → 1,303,070,798** (−250,000 exactly); Pepe applied the effect (burns.json) and announced "Burned 250,000 PAT … Total burned: 260,000 PAT" |
| rollback `pr4-rehearsal-1` | refused nothing; Pepe's journals hold every site period (epoch `W2026-10-12-r2`, days, monetary days, burn `S1`), his pushed docs back on the site; effects open 0; site → shadow |
| shadow after rollback (`r3`) | Pepe ran epoch / release / monetary: engine diff 0, total diff 0 (inputs: journal lag only) - the books agree after the way back |
| cutover again `pc4-rehearsal-2` | live; `r4` live ticks (3 runs) - **Python replay 3 / 3 equal**; then a 6,000,000 simulated House profit (stagetest, Reserve → House) and a live epoch `W2026-10-12-r5`: surplus **6,000,000** → stakers **10,699** (4 stashes: 231 / 4,521 / 913 / 5,034), Fed **2,994,650**, incentives **2,994,651**; **1,698,212.398…** protocol House shares redeemed on the capital book (`vaults:proto-wf-W2026-10-12-r5-house`); conserved; **Python replay: every number equal** (the stored plan carried a `shares_redeemed` annotation - fixed in 1.99uo, the record is a copy now) |
| rollback `pr4-rehearsal-2` | back to shadow. **Staging is left in SHADOW** (all three engines): PepeBeta runs every real period, the site compares - tonight's 04:00 UTC and the real Monday 2026-10-19 (the Phase 3 soak point) |

Staging state the rehearsal changed (sandbox PAT, all keyed moves): prod's three econ docs replaced staging's (backup above); the
waterfall moved the House surplus twice (r1 11,203,668 by Pepe, r5 6,000,000 by the site after a simulated 6M profit); the Monday
guarantee was paid twice (r1 by Pepe, r2 by the site, 17,254,730 each: a tagged period still reads the untagged epoch's
`incentives_after`, as Python does); 250,000 burned. To keep a real House surplus for the **Phase 3 soak** at 2026-10-19, a further
10,000,000 simulated House profit was moved Reserve → House (`st-houseprofit-1791845646`, supply unchanged): the site's preview of
W2026-10-19 shows surplus 10,000,000 (stakers 17,834, Fed 4,991,083, incentives 4,991,083). The supply moved only by the burn.

Also run before staging: `test/policy.test.js` (13: modes, lease, dry, shadow diffs, the handshake, a live epoch with the
protocol's shares redeemed and stakers paid, a leg Pepe already moved, the monetary day with a floor mint / activity rewards /
the Monday guarantee, the catch-up cap, a burn, rollback, the staging-only routes), `test/policy-vectors.test.js`, the whole site
suite (6 pre-existing failures: `@noble/curves` missing locally), `policy_client_test.py` (48 checks) and the bot's 150 harnesses.

## 11. What the prod cutover needs from the user

- **Now (independent of Phase 4):** a go to deploy site ≥ 1.99uo to prod - it carries the `/api/econ/docs/put` fix; prod's econ docs
  on the site have been stale since the 2026-10-12 pools cutover. Then bot ≥ 1.99un (no behaviour change while the site's modes are off).
- A go for each prod write: §2 (modes → dry), §3 (→ shadow), §5 (the cutover) - each from the admin card or the request file.
- The order with Phase 3: the treasury engine needs the capital cluster live on prod (the waterfall redeems on the site's book).
  Recommended: Phase 3 prod cutover first; Phase 4 dry from the day after the deploy, shadow from the next day through **two**
  Mondays (2026-10-19 = Phase 3's soak point - Pepe runs it, the site only compares - and 2026-10-26), then the cutover on
  **Tuesday 2026-10-27**, after 04:20 UTC, in a week with no epoch-setting change. If Phase 3 reaches prod later, shift by the same.
- The E-4 go-live (~2026-10-31) is independent (the recipe stays in Pepe; `ap_on` reaches the site in Pepe's config push), but
  don't flip it in the same hour as the cutover.
- Decisions: see the audit's Phase 4 open questions (the Fed's event operations - one writer for the mint caps; activity payouts
  to logins with no PATV account).

## 12. Known limits

- **(Fixed by P4-1, `docs/fed-events-cutover-runbook.md`: once the Fed events backend is live the site is the caps' only writer.)**
  **Until then the mint caps have two writers.** The site's floor / issuance mints and Pepe's
  admin / loan / flash / donation mints both journal Fed mints. Each checks the caps against the freshest merged view (Pepe's
  pushed `fed_mints` + the site's `policy_mints`), so a cap can only be overshot by two mints in the same seconds (`mintcap_total`
  is 100M on prod; the floor cap 30M is the site's alone after the cutover).
- **Activity rewards** are paid to the PATV account linked to each login (`capital/core.account`); a login with no account isn't
  paid (Pepe's `find_or_create_user` used to create one) and its share stays in the incentive budget. The participation rows are
  the site's `econ_participation` (Pepe's E-0 sync) - the shadow's inputs diff shows any lag at 04:00 UTC.
- Pepe's daily release first settled pending website grant claims (`_funding_tick`); the site's release reads the incentive budget
  as it stands (those claims are still Pepe's, every ~30 s).
- A shadow report is Pepe's state just before his legs; the site's own gather at the same moment can differ by a journal push
  (the inputs diff says so; Pepe pushes his config after every report).

## 13. Phase 6 / PO-1: the cut-off wait, the boundary handshake, clean periods, the pause

The economy-policy-to-site plan (2026-10-20, slice PO-1) hardened the scheduler before any engine goes live:

- **The Monday cut-off wait.** The epoch (live, dry and shadow alike) waits up to `TR_CUTOFF_WAIT` = 1 h past Monday's boundary for
  the capital cut-off that closes the week's PAT-days bucket (the share book's newest cut-off at or after the boundary) - Pepe's
  `_tr_cutoff_pending`. The Monday daily waits with it (it runs after the epoch). A book with no cut-offs never waits; with no
  cut-off within the hour the epoch runs on what there is. The log says `[policy] treasury W...: waiting for the Monday cut-off`
  once. (On 2026-10-19 the site's sim was at 04:00:08 and the cut-off at 04:00:11.) On staging the capital cut-off runs on the real
  clock, not the policy test clock: a test-clock Monday exercises the wait only when the book's last real cut-off is before it.
  **Past the hour (review fix):** while the site's OWN cut-off is overdue - capital live, vaults on, the capital clock at or past
  the book's `next_epoch`, i.e. the capital tick (same process) runs it at its next pass - the epoch keeps waiting, however long:
  after a site outage across Monday 04:00 the hour is long up when the site comes back, and settling first would pay the week
  without its last day (the I8 late-monday case). Log: `the site's capital cut-off is OVERDUE` once; after 15 minutes an ops alert
  + Pepe notice `... held - the capital cut-off is overdue`. If you get that alert, the capital tick isn't cutting
  (`[capital] epoch:` errors, the staking watch's I8): fix the cut-off; the epoch runs at the first pass after it. Nothing moves
  while it waits.
- **The boundary handshake (T9).** `POST /api/policy/bot/boundary {engine, period, now, guarantee}` (bot token): before Pepe moves a
  leg of an epoch, daily or monetary period he asks the site for its snapshot of that moment - inputs + plan in ONE `dbUtils.tx`,
  stored once in `policy_sims` (`site_boundary_inputs`, `site_boundary_plan`, `boundary_ts`), never overwritten (a second call
  answers `dup`). His report is then compared against it. Only while the engine is dry / shadow (`off` / `live` answer `skipped`).
  The snapshot also keeps the site's OWN decisions of that moment (`boundary_meta`: the monetary day's guarantee - the site's
  decision, the gate, the epoch state it saw, and Pepe's flag); the plan itself is computed on Pepe's flag.
- **Clean (D-15).** `policy_sims.ok = 1` only when the engine diff is empty, a boundary snapshot exists and nothing differs - in
  the PLAN (boundary plan vs Pepe's), in the INPUTS, or in the site's own DECISIONS (the guarantee flag) - outside the whitelist
  (`policy/scheduler.js WHITELIST`, each entry with a condition and a test in `test/policy-boundary.test.js`): the Monday daily's
  `release` and the `week.*` inputs of the Monday daily / monetary day while the site still holds LAST week's record - exactly
  last week's: a site record from the future or from 2+ weeks back blocks (post-move); 1.99afg: the Monday daily's `release` and
  the `week.share` / `week.release_per_day` inputs of the Monday daily / monetary day while the site already holds THIS week's
  record but not filled yet (both exactly null on the site, both set on Pepe's record of the same week - his push opened the
  week before his epoch's share landed, as on prod's D2026-10-19 / D2026-10-26), the week's `budgets` / `spent` still count;
  the Monday guarantee decision "site waits for the epoch / pepe true" (post-move: his epoch ran a moment earlier); the
  participation rows (`rows` / `days` / `skip`) only while no rule reads them (no activity reward paid, issuance not scaled by
  activity). Anything else - any other input, a decided guarantee mismatch, a site gather failure - keeps the period unclean.
  `policy_sims.whitelisted` / `blocking` = `{plan, inputs, decision}`. A report without a snapshot (a Pepe before PO-0c, a
  timed-out handshake) is never clean. Diffs list at most 400 entries (`truncated = 1` when there were more: never clean) -
  1.99afg: except the monetary day's participation while no rule reads it. Pepe's rows also hold active-minute-only rows
  (lines 0, mic 0) the site's gather drops, in his own order, and the E-0 sync lags his counters: compared by position, prod's
  monetary days 10-15..10-26 ran to 523-805 participation entries, so every one of them read truncated. Under that condition the
  participation is diffed apart and excused whole: the row can read `ok = 1` with `truncated = 1` (its list is cut, the admin
  page says so); every other input keeps its own 400 cap, and that cut still blocks. If a rule ever reads participation
  (activity rewards on, issuance scaled by activity) it is compared with the rest again, entry by entry.
  *Staging rehearsals (1.99afg):* the Monday's stale-week excuse is now EXACTLY last week's record (`prevEpochId`). A Monday
  whose site record is 2+ weeks older than the period's week (a test clock jumped 2+ weeks past the real week record, or a site
  that missed a whole week of Pepe's pushes) or that has no week record at all reads unclean (1.99aff excused it): push the
  week's `econ_treasury` doc first, or expect those Mondays' rows to be `ok = 0`.
- **Burn.** Pepe's daily `burn` report (`inputs.kind = "burn"`: the closed policy day `[04:00, 04:00)` UTC - `from`, `to`, `mode`,
  `burned`, `burns`) is planned by `engines.planBurn`; the scheduler records a day summary `<mode>:burn:D<date>` of every closed
  day, even at zero (from the pool history: the `burn` moves out of the burn reserve) - it is also that day's boundary snapshot.
  Only a day that has CLOSED by the pool history's clock (real time + 60 s - never the staging test clock): a boundary call or a
  report for an open day is refused and nothing is recorded. Days a pause or an outage skipped are summarized when the engine
  runs again (7 days back, never before the engine was armed). A paused burn engine summarizes nothing until it is resumed.
- **Pause (T3).** The owner's kill switch, Pepe not needed:
  ```
  cd /home/PATV && node tools/policy-backend.js --actor=<you> pause <treasury|monetary|burn|all> --note "why"
  cd /home/PATV && node tools/policy-backend.js --actor=<you> resume <treasury|monetary|burn|all>
  ```
  or /admin/economy → ⏱️ Policy scheduler → Pause an engine (a Pepe owner, password step-up). One transaction (the flag,
  `policy_audit`, `admin_audit` `policy.pause` / `policy.resume`), then every site admin gets an ops alert (inbox + Telegram).
  A paused engine runs nothing: a live one's due periods are recorded `missed` (`result.missed = "paused"`), nothing is handed
  back, the mode stays. A paused engine can't be cut over. **A prod write: the user's go.** Enforced at write time (review fix):
  every live run re-reads the switch inside its own transaction, so a pause pressed while an earlier run holds the write gate
  stops the rest of that pass; the "missed paused" record is written in a transaction that re-reads the flag (a resume is never
  undone). The shell refuses to run without `./myapp.db` (exit 2, nothing created - run it in `/home/PATV` or pass
  `--dir=/home/PATV`), and pause / resume refuse a database without the site's `users` and `policy_engines` tables.
- **Missed periods (D-18).** Only the current period runs after an outage or a resume, flagged `late` on its result and record
  (`{why: "site_down" | "paused", late_s, seen_at}`) with an admin notice; older ones stay `missed` (the card's "Missed periods").
  `late` is decided by when a scheduler FIRST SAW the period due (`policy_meta seen:<engine>:<period>`, any process): more than
  15 minutes past its boundary = the site was down at it. A cut-off / guarantee wait, a failed run's retry or a lease takeover
  doesn't change it. Every period an outage skipped is recorded `missed` (14 days / 4 weeks back, never before the engine was
  armed), and so is a period whose run was still failing when it ended (`result.missed = "failed"`); one Pepe notice per sweep.
  A missed MONDAY monetary day says the week's guarantee top-up rode on it and was not paid (`result.guarantee_unpaid`).
  An owner's "Run now" for an older period comes with the web-approval flow (PO-7), not here.
- `node tools/policy-backend.js preflight` FAILs while an engine is paused and WARNs on missed periods and on unclean shadow
  periods of the last 14 days.
- Every reader of Pepe's policy push (flags, the epoch hour, burn settings, his journals, the effective `econ_cfg`) reads it
  through `policy/source.js`; PO-2 / H1 switch that one module to the site's own config. `policy/core`'s reader is named
  `_pushForSource` (no `cfg()`): `test/policy.test.js` fails if any other file calls it.

## 14. Phase 6 / PO-2: the policy config store (mirror + dual read)

`policy/config.js` (the store), `policy/cfgspec.js` (the spec: Pepe's `pepe_econcfg` rules, ported - 112 keys: the 69 `econ_cfg`
keys, the economy sink rates, `burn_cfg`, the flags, PAT Routing, the system constants, the read-only v1 knobs) and
`policy/handover.js` (the hand-over). It ships in **MIRROR** mode: `policy_ownership.cfg = pepe`, Pepe is the writer.

- **The mirror.** Every push Pepe makes is normalised into `policy_cfg` (by `pepe`, via `mirror`): his policy config (`econ_cfg`,
  the economy `sink` rates (PO-2's bot change adds them to the push), consts, flags, burn_cfg, skip, tz), his capital config, PAT Routing
  (`/api/econ/settings/put`) and the funding sync's `monetary` block. A key several pushes carry is written from its best source
  (his stored value first, derived copies never) while that push is fresh (25 h); at start the stored copies are replayed. The
  `[policycfg]` log names mirror errors - a push is never refused because of the mirror.
- **The diff report** (/admin/economy → ⚙️ Policy settings → Mirror diff report; `node tools/policy-backend.js status`): keys
  Pepe never pushed (`missing`), keys he has that the site doesn't (`unknown`), values the site's checks would refuse
  (`invalid`, `whole`), two of his pushes disagreeing on a key for more than 10 minutes (`disagree`). The worst counts of each
  UTC day are kept (`cfg_mirror_days`). **H1 gate 1: empty 10-30..11-02.**
- **The dual read.** Each reader compares Pepe's value with the store's, logs every difference (`policy_cfg_dualread`: day,
  reader, key, Pepe's value, the site's, how often) with a per-day check count (`policy_cfg_dualcheck`), and keeps USING PEPE'S:
  `capital.cutoff` (the daily cut-off: ceiling, cushion, Auto cap, staker limit, House float, top-up, dividend),
  `capital.reserve` (the loan terms), `fed.cfgNow` (a Fed op's numbers incl. his per-op `econ_cfg` - T2), `funding.monetary`,
  `policy.source` (every engine reader). **H1 gate 2: no difference on the daily cut-offs 10-31..11-04 and the 11-02 epoch.**
- **After H1 (dormant now):** the readers use `policy_cfg` (`policy/source.js` answers `from: "site"`; `capital/core.cfg()`,
  funding's monetary block and econstore's PAT Routing overlay it); a Fed `mint` / `grant` / `loan_open` ignores the per-op
  `econ_cfg` and must carry `cfg_rev` = the store's rev (else HTTP 409 `E_CFG_REV` with the values - checked inside the op's
  transaction); `capital_ceil_log` gets a row per ceiling-key change; a missing key is never filled with a code default: the
  reader throws `E_CFG_MISSING` (the engine defers that period) and the admins get an ops alert. A release that adds a SPEC key
  ships a migration in `policy/config.js MIGRATIONS` (seeded once, `policy_cfg_seed` + the log via `migration`).
- **Edits (site-owned only):** /admin/economy → ⚙️ Policy settings (a Pepe owner: the class + the owner role on the linked
  login, the password step-up, CSRF, a note, the rev the page loaded - stale: 409 with the saved values) or Pepe's chat through
  `POST /api/policy/bot/cfg/set` (a Pepe owner by role on the site; never Telegram). A fraction key is a percent: chat must
  spell the `%`. Settings an engine reads are frozen from 03:40 UTC until that day's runs are done / handed / missed (423, the
  runs it waits for are named); everything is 423 while frozen for a hand-over or paused. Every save: one rev, a log row each,
  an `admin_audit` `policy.cfg` row.
- **Pepe's read:** `GET /api/policy/bot/cfg?have=<rev>` (header `x-bot-token`, or POST with the token) → `{rev, sha, owner,
  paused, spec_hash, cfg, log_tail}`, or `unchanged` at his rev (the card shows the rev he has).
- **The hand-over (H1, driven by Pepe - PO-3):** `POST /api/policy/bot/handover/freeze` (pepe → cutting: the mirror stops,
  edits 423) → `begin {feature, key = sha256 of the export, size, chunks}` → `chunk {key, idx, data = base64}` (its own 1 MB
  body limit: index.js skips the path) → `commit` (sha checked, every key present and valid, ONE transaction, the money tables
  counted before and after - zero rows or it rolls back, Pepe's change log with its original times and who, his ceiling log;
  a rerun answers `dup`) → `verify` (per-key equality, the digests, `supply_history` gap-free) → `cutover {feature, key}`
  (cutting → site, only if the store still equals that import) / `rollback` (site → pepe, refused while an engine is live or the
  budget is the site's; answers the site's values + its log since the flip for Pepe to write back). Every step names an actor
  with Pepe's owner role ON THE SITE.
- **Pause a feature:** `node tools/policy-backend.js --actor=<you> pause cfg --note "why"` (or `resume`; `features` = all four)
  or the card's "Pause a feature" (owner + step-up). One transaction, `admin_audit` `policy.feature_pause` / `_resume`, an ops
  alert. A paused cfg refuses every edit (423); the readers keep reading.
- `node tools/policy-backend.js preflight` FAILs on a missing key, a paused feature, a feature being handed back and on the H1
  evidence gates (14.1).
- The engines card's anchor is now `/admin/economy#engines`; `#policy` is ⚙️ Policy settings.

### 14.1 Review of PO-2 (before H1)

- **Committed reads only.** Outside a transaction the store is read in a transaction of its own on the chain (the 1.99adl
  `settledMoveStatus` rule): no reader - the cut-off, the engines, funding's monetary block, Pepe's pull - ever sees an open
  edit's / mirror's / import's rows, nor a rev its rollback takes back. Pepe's pull answers `unchanged` only when BOTH the rev
  and the sha he holds are current (`GET /api/policy/bot/cfg?have=<rev>&sha=<sha>`); a Fed `mint` / `grant` / `loan_open` must
  carry `cfg_rev` AND `cfg_sha` (409 `E_CFG_REV` otherwise - not recorded under the op key: Pepe re-previews and retries the
  same key; it is never a terminal refusal).
- **No auto-fallback.** While the site owns the config (or its owner isn't known yet - just after a start, or while it is being
  changed) an unreadable store fails every reader with `E_CFG_UNREADABLE` (503; the cut-off and the engines defer; an ops alert
  "Economy settings unreadable") - never Pepe's push, never the pre-H1 `pat_routes` table, never a guessed "pepe". Funding's
  monetary block keeps the site's last block (tagged `cfg_rev`) when a key is missing or the owner isn't known. While Pepe owns
  the config his push stays the readers' source exactly as before.
- **The run window** also waits for the site's own 04:00 capital cut-off whenever the vaults run on the site (the cut-off reads
  the staking keys), with the engines' flags off too; an OVERDUE cut-off freezes the engine-input keys at any hour
  (`capital:cutoff <day>` in the 423's waiting list).
- **H1 verify / cutover.** `verify.ok` is true only when the store equals the import AND the import equals what every reader
  uses: the values at the freeze (`changed_keys`; the freeze keeps them in `policy_meta.cfg_freeze`) and Pepe's pushes as each
  consumer reads them (`readers`: policy.source, capital, funding.monetary, econstore's routing table). The cutover re-checks
  the readers and is refused (409 `differs`, the keys listed) unless `force` names EXACTLY the keys that differ - the owner's
  explicit go, audited (`forced`). Normal path: Pepe pushes, then exports - nothing differs.
- **Rollback is two steps.** `rollback {feature, actor}` keeps the config on the site (its readers keep its values; every edit is
  423 `returning`; the card shows "Being handed back") and answers its values + rev + sha + log. Pepe writes them back and pushes;
  then `rollback {feature, actor, confirm_sha}` - refused (409 `push_behind`) until his policy push (and his capital push, if he
  sends one) arrived after step 1 and every reader's push value equals the store (or `force` names exactly the keys) - flips to
  Pepe, writes the routes handed back into econstore's table, re-applies funding's block. `rollback {..., cancel: true}` ends
  step 1 with the site still the owner.
- **Every hand-over step** names a Pepe owner and is a chat command: `via` telegram is 403, anything but chat 400; Pepe's
  `cfg/set` is always `via chat` (web / cli refused). The import's money guard also sums the balances (users, pools, stashes,
  escrow holds): a balance UPDATE writes no row. Each step's `admin_audit` row is written in the step's own transaction.
- **PAT Routing from the pools card** (site-owned) sends the rev the card loaded and a note (both required; a stale rev is 409).
- **Evidence.** The dual read's buffer is flushed right after the cut-off, after each scheduler pass and when the site starts to
  stop; a failed flush keeps its rows for the next one. `node tools/policy-backend.js preflight --since=2026-10-30` FAILs when a
  day in the window has no checked mirror record or a non-empty one, when a daily reader (capital.cutoff while capital is live,
  policy.source while an engine is on, funding.monetary while Pepe pushes) has no comparison that day, or on any dual-read
  difference (today included) - no evidence is never a PASS. Only the mirror's own change-log rows are pruned (20,000 kept).

### 14.2 PO-3: Pepe's thin client for the settings (bot `pepe_policycfg.py`; dormant until H1)

- **The switch** is Pepe's `policy_client.json` `features.cfg`: false (ships; nothing changes), "cutting" (frozen: he reads his
  own values, every edit refused), true (he reads the site's: `policy_cfg_cache.json`, the site's last answer). Only the owner's
  chat commands move it: `!econ policy freeze|unfreeze|export|cutover|rollback|detach cfg confirm` (owners by role; never from
  Telegram; refused from 03:40 UTC until that day's runs are done). `!econ policy status` = his half of the preflight.
- **The pull:** `POST /api/policy/bot/cfg {have, sha}` (the POST form of the GET - the token rides the body) every 60 s while the
  site owns / takes the settings (10 min otherwise) and right before each engine period's plan; the shadow report names the
  settings it was planned with (`cfg {rev, sha, src}` -> `policy_sims.pepe_cfg`).
- **H1, as Pepe drives it:** freeze (Pepe first, then the site) -> `export cfg confirm` PUSHES first (policy, PAT Routing,
  capital) and then writes `policy_export_cfg_<ts>.json` + sha256 and uploads it in 60 KB pieces -> verify -> `cutover cfg
  confirm [force k1,k2]`: Pepe flips only after he pulled the site's values. Money still in flight on his side (pools outbox /
  uncertain / inbox, policy outbox / dead letters, capital uncertain, Fed outbox, stash moves, corrections) blocks the cutover.
- **While the site owns them:** `!econ set` / `!econ sink` / `!econ layers|treasury|activitypads on|off` / `!burn mode|set` write
  through `cfg/set` (base_rev = a fresh pull's rev); Pepe's panel shows them read-only with a link to `#policy`; the site down ->
  "the website is unreachable - nothing changed" and his cached copy stays in use. Fed `mint` / `grant` / `loan_open` carry
  `cfg_rev` + `cfg_sha`; a 409 `E_CFG_REV` -> pull, re-preview (a grant that would now cross the Fed floor is refused), the same
  `op_key` again (at most twice) - never terminal.
- **Rollback / detach:** step 1 -> Pepe writes the values back (`_pcf_write_back`), keeps the site's log rows (`econ_cfg_log`,
  via `site:<via>`), pushes, confirms (a `push_behind` with `behind` is pushed again once; a reader difference is shown - `force`
  or `cancel`). Detach writes his cached copy back (refused while the site answers and owns them; `force` past a day old).
- **The contract** is pinned by `test/fixtures/policycfg-contract.json`, byte-identical with the bot's
  `ci/fixtures/policycfg-contract.json` (written by his real code, `tools/gen_policycfg_contract.py`; sha256 pinned in
  `test/policycfg-contract.test.js` and the bot's `policycfg_contract_test.py`): his three pushes mirror to every key with an
  empty diff report; his routing catalog gives checkRoutes the same answer as his `_clean_routes` for every flow x destination
  (a room-vault share needs `rv` or a v2 room flow - `room` alone is not enough; an older catalog without `room_flow` keeps the
  old reading); his export imports with verify ok and cuts over without force; his write-back pushes confirm a rollback without
  force.

### 14.3 Review of PO-3 (2026-10-21, before H1)

What changed in Pepe's half, and what the H1 owner needs to know:

- **The freeze pushes first.** `freeze cfg confirm` sets Pepe "cutting", sends his policy, PAT Routing, capital and funding
  pushes, and only then asks the site to freeze. The site's freeze snapshot (`cfg_freeze`) is what its store holds at that
  moment, so a change made in the last 5 minutes (before the periodic push) is in it. If a push fails, nothing is frozen and
  Pepe writes as before. Two kinds of difference at the export or cutover:
  - a key that differs from the **freeze snapshot** (`changed_keys`) can't be cleared by pushing, because pushes don't write the
    store while it is frozen. Run `unfreeze`, then `freeze` and `export` again, or cut over naming exactly those keys (`force`);
  - a key only the **readers** differ on is cleared by a push and a new export.
- **Each export is its own.** Every export gets a later `at` than the last one, so it has its own sha (the key). A re-export in the
  same second no longer gets the first import's verify back.
- **A refused freeze changes nothing.** The site's own 403 refusals carry a `code` (`owner_only`: a Pepe owner by ACL who isn't
  on the site's pinned owner list; `telegram`). Pepe now reads these as the site's answer, not as "no answer":
  - a refused freeze puts Pepe back as he was;
  - `!econ set` passes the refusal on, instead of saying "the website is unreachable".
  The token check's 403 (no `code`), a 404 (an older site without these routes) and a 429 mean the site never ran the call: the
  freeze is undone. An `unfreeze` that gets no answer, or is refused, asks the site's state. If the site isn't frozen (it says
  Pepe owns the settings, or it has no policy routes), Pepe writes again.
- **One live switch each.** The site keeps the treasury and the activity -> pads switches as one live switch each:
  - `tr_live` = Pepe's treasury switch AND the layers;
  - `ap_on` = his activity switch AND the room payouts recipe.
  While one of Pepe's own switches is on but not live, `freeze`, `export` and `cutover` are refused (`!econ policy status` shows
  "hand-over blocked"). Otherwise the hand-over would quietly turn that switch off on Pepe while verify said every value was
  equal. Settle it first: `!econ treasury off` or `!econ layers on`; `!econ activitypads off` or turn the room payouts on.
- **The treasury switch turned on on the site arms Pepe's scheduler from that moment.** This covers a web edit, the CLI or the
  chat write-through, which Pepe learns of by the pull. Between H1 and H2a Pepe still runs the engines, and this is what his own
  `!econ treasury on` does: the first run is the next boundary, never this week's epoch late or today's release at once. The
  flag log records the site's actor (`via site`).
- **After a detach, when the site comes back still owning the settings:**
  - the CONFLICT log says DETACHED;
  - Pepe stays the writer. A freeze refused `site_owned` no longer leaves him frozen;
  - his Fed ops that need the settings are refused (E_CFG_REV, never recorded, the key free) and are never re-sent under the
    site's rev.
  The way out is **`!econ policy cutover cfg confirm`, which re-attaches Pepe.** Nothing is imported: he pulls the site's values
  and reads them again. Every value of his that differs (changed here since the detach, or on the site meanwhile) is named, and
  `force` must name exactly those keys; his values are dropped. Money in flight blocks it, as it blocks a cutover. To give the
  settings back to Pepe instead: re-attach, then `rollback cfg confirm`, and re-apply anything changed while he was detached.
- **An unreadable `policy_client.json`.** PO-0c's rule still counts every switch as on, but for the settings the site's last
  answer decides:
  - the site said it owns them: Pepe reads the site's values, as before;
  - otherwise (mirror mode): Pepe reads his **own** values and refuses every edit until a human fixes the file. Before, he read
    the site's cached mirror (up to 10 minutes old) and sent every `!econ set` to a site that refuses it in mirror mode.
  `!econ policy status` says UNREADABLE, and every hand-over step is refused until the file is fixed.
- **Rollback.** Pepe's pushes now include the funding sync (its `monetary` block: the Fed band, donations, the grant cap, the
  House floor, flash). The confirm's reader check no longer fails with `differs` when a monetary key was edited on the site in
  the ~90 s before the rollback. The values are written back before Pepe's switch moves, so no reader passes through his old
  values.
- **Pepe's panel while the site owns the settings:**
  - the Sink rates card shows each economy row's value in force (the site's), read-only, with a link to `/admin/economy#policy`;
  - the PAT Routing card shows the site's routes, read-only;
  - a game row (rakes, prices, faucets) still saves. A save that echoes the economy rows is ignored for them (Pepe's own
    override is kept); a changed economy row is refused whole.

### 14.4 PO-3 follow-up (2026-10-21, after the staging review of 1.99adv)

- **Armed before the readers see it.** When a pull brings a copy that turns Pepe's treasury switch on, his treasury scheduler is
  armed *before* the copy becomes the cache and his readers' view. The same holds when the switch itself moves (a cutover or a
  re-attach). Before, a treasury tick on the GTF loop (another thread) could land in the ~1 ms window between the two, read the
  switch on with the old `armed_at`, and run this week's epoch late and today's release at once. If the readers end up seeing
  something else than expected, the arming follows what they see.
- **An unreadable `policy_client.json`, the site's answer changing.** The settings follow the site's last answer (14.3); the pull
  now rebuilds the readers' view when that answer moves who owns them, not only when the values change.
- **The re-attach refuses a switch that is on but not live**, as the freeze, export and cutover do: with the site's `tr_live` and
  layers both off there is no difference to name, so the re-attach would quietly turn Pepe's treasury switch off. Settle it
  first (`!econ treasury off` or `!econ layers on`; `!econ activitypads off` or the room payouts on). A Pepe left frozen by the
  old freeze goes back to writing his own settings so it can be settled, then re-attaches.
- **Pepe's panel, unreadable file.** Its refusal says the file is unreadable (as chat does), no longer "frozen for their
  hand-over" - no hand-over is running then.
- **Pepe's links** to `/admin/economy#policy` use the public site (`staging.publicaccess.tv` on staging), never the staging
  router's backend address.
- **The Phase 4b switches on /admin/economy.** Room vaults, room payouts (the recipe), profile vaults, convoys, verified
  watch-minutes, mic challenges and the pad launchpad stay Pepe's (D-1: never handed over, never in the H1 export or the config
  store). Pepe's policy push now carries them (`phase4b`: `{setting: {on, live}}`) and the Policy settings card shows them
  read-only: owner Pepe, changed by a Pepe admin or owner with the chat command in each row (`!econ roomvaults on|off`, ...) or
  on Pepe's admin panel. A push from an older Pepe has no block: the card says so and shows nothing as on or off.
- **`pools_client.json` unreadable is never overwritten.** Pepe treats the pools as on (unknown) in memory, as before, but no
  longer saves that stand-in over the file (a transient Windows sharing violation at start left the pools switch on for good).
  A readable file that carries an old `unreadable` marker (saved by an older Pepe) is read with the marker dropped and a log
  line naming its switch - check it with `!econ pools backend status` (not `!pools`, which lists the escrow betting pools).
- **Test hygiene.** Every bot harness writes only into temp folders; `ci/harness_main.py` fails a harness that writes a JSON
  file into the bot's own folder (`test_hygiene_test.py`).

### 14.5 Review of the PO-3 follow-up (2026-10-21)

- **One reader of Pepe's push (T14).** The Phase 4b card on `/admin/economy` reads Pepe's push through `policy/source.js`
  (`phase4b()`), like every other reader. The guard in `test/policy.test.js` now also fails on a `meta("cfg")` call made on a
  binding of `policy/core` (any name, destructured, or chained on the `require`). `capital/core` and `gangs` have their own
  `cfg` rows and are not caught.
- **The treasury is armed when it goes live, not only when its switch turns on.** It runs only while its switch *and* the
  layers are on. Pepe now arms the scheduler whenever that pair goes from not live to live, before any reader sees it:
  - on the site, after H1: an edit of `layers` while `tr_live` is already on;
  - on Pepe: `!econ layers on` while the treasury switch is on, and the panel's save of `econ_layers` / `econ_treasury`
    (an echo save moves nothing; the file Pepe loads at start never arms).
  Before, the treasury went live with an old `armed_at`, and the next tick ran this week's epoch late and today's release at once.
  When it stops being live, the flag log gets a row `live: false` that names who moved it.
- **The staging inject (`policy-inject.json {"action": "econ"}`) is narrower.**
  - It runs only `!econ policy ...`. Every other `!econ` command is refused and nothing runs.
  - It checks roles as a typed line does: `!econ` is an owner power, so an admin or staff login is refused.
  - It runs one at a time, on Pepe's policy worker. Write the next inject only after `policy-inject.result.json` says
    `final: true` for ITS args. One written earlier is not refused in the usual case: the heartbeat reads it while the first
    one's hand-over step is running, it is queued behind that step, and it runs after the first one's final (serialized). Its
    own result follows and overwrites the first one's final within milliseconds, so a script that polls slowly can miss that
    final. Only one read while the first command is still being handled (before its steps are queued) is refused; nothing runs
    for it, and the first one's final result lists it under `refused_while_running`. A script that expects a refusal and sends
    the same step again would run that step twice.
  - Pepe's answers are collected only while that command and the items it queued are running. Another command's answer is
    posted to the room as usual.
  - Each hand-over step it runs sends `note: "rehearsal-inject (policy-inject.json): !econ policy ..."`. The site keeps that
    note on the ownership record (via stays `chat`), and Pepe's switch log names it too. A typed step sends no note.
- **The pools command.** The status of the protocol pools is `!econ pools backend status` (14.4's line, and Pepe's own log
  and hints, said `!pools`, which lists the escrow betting pools).

### 14.6 Loose ends of the 1.99adw staging rehearsal (2026-10-21)

- **The participation skip list no longer depends on which account Pepe runs as.** Pepe's policy push carries `skip`, the
  logins left out of participation. The site's mirror stores it, its engines read it and the H1 export carries it. Pepe used to
  add his own login, read from his username, which says `pepefrog` until the room's join packet names the real account. So
  every PepeBeta restart pushed a list with `pepefrog`, then about 5 minutes later one with `pepebeta`. On staging that made
  mirror revs 4/5, 6/7, 8/9 and 14/15 (`by pepe via mirror`), and the 1.99adw restart left a `policy.source` dual-read
  difference that failed the staging preflight's "dual read clean" for 2026-10-21.
  - Now the list is the room's pseudo-senders, BOTH of Pepe's accounts (`pepefrog`, `pepebeta`) and the room bots (Pepe's
    `room_bots` setting plus the ignored bots). It is the same on prod and staging, before and after the join packet, from
    his first push on. Pepe's own activity day and his shadow reports' inputs read the same list
    (`pepe_policyinputs.econ_skip`).
  - Prod never flipped: its login is `pepefrog`, the same as the fallback (read-only check on 2026-10-21: prod's stored push
    lists `pepefrog` only, and prod has no `policy_cfg_log` yet). At the 10-27 promote, the new bot's first push adds
    `pepebeta` to prod's list. That is ONE expected mirror row on `skip` (`by pepe via mirror`) on 10-27, and at most one
    `policy.source` dual-read difference that day. Both fall before the H1 evidence days (gate 1 from 10-30, gate 2 from 10-31).
    After it there must be no further `skip` rows on a restart. Staging gets the same single row when 1.99adx deploys.
  - A login that is neither of Pepe's accounts (a test account) is never added automatically, because that would make the list
    depend on the login again. Pepe logs once that it belongs in `room_bots`.
- **Who moved the treasury.** The flag log's `by` (at most 40 characters) cuts the site actor, never its ` via <via>` suffix.
  Staging logged `... (stgcfownb4a79d08) via `, which lost the `web`.
- **`capital_client.json` unreadable is never overwritten**, as 14.4 does for `pools_client.json`. Pepe counts the capital
  cluster as on (unknown) in memory, never saves that stand-in over the file, and drops an old `unreadable` marker that an
  older Pepe saved into a readable file, logging its switch. While the file is unreadable, `!capital backend cutover`,
  `rollback` and `detach` are refused, because their result would live only in memory and the switch would read ON again at
  the next start. `!capital backend status` says UNREADABLE. Fix the file and restart Pepe.
- **Tests for the reverify gaps.** The panel's save arms the treasury before the switches are visible, now tested from an old
  `armed_at` (mutant N1 is killed). The Phase 4b card's `at` must be the push's own time in ms, not the read's clock and not
  seconds (S2 and S4 are killed).
- **The shared contract fixture** `policycfg-contract.json` is regenerated (its pushes, rollback and export carry the new
  `skip`) and re-pinned in both repos.
