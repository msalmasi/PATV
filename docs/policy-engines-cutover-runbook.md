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

- **The mint caps have two writers until the Fed's event operations move (Phase 4b).** The site's floor / issuance mints and Pepe's
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
