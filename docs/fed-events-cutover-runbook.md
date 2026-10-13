# Fed events cutover runbook: the Fed's one-off operations → the site (P4-1)

The design: `docs/backend-migration-audit.md` §6 Phase 4 (open question P4-1, approved by the user: "Fed one-offs next").
The code:
- **site** `fed/service.js` - the store (`fed_meta`, `fed_records`, `fed_ops`; `fed_journal` rows written with every record), the
  ops, the donation sweep, the cutover import / export / rollback, the routes; hooks in `policy/apply.js` (`fedMint` and the
  loan legs book through it while live), `policy/gather.js` (`layersOf`: the engines read the site's books while live),
  `econstore.js` (Pepe's pushed `econ_layers` no longer overwrites `fed_journal` while live), `funding.js` (`claims()` stops
  listing `mint:donation` to Pepe while live); `tools/fed-backend.js` (the site switch + status); `test/fed.test.js`.
- **bot** `pepe_fedclient.py` (the switch, the thin client, the mirror, the outbox, `!econ fed backend …`, the request file, the
  staging inject); the choke points in `pepe_layers.py` (`_fed_mint`, `_fl_open`, `_fl_apply_repay`, `_fl_repay_run`) and
  `pepe_monetary.py` (`_mo_fund_run`, `_mo_flash_repay`, `_mo_settle_donation`); `fed_client_test.py`.

## What moves

| Operation | Pepe (local, switch off) | The site (switch on) |
|---|---|---|
| admin mint `!econ mint` / `!reserve mint` (Fed only) | `_fed_mint` policy admin | `mint` op, policy admin, dest reserve |
| restore / seed / cutover mints | `_fed_mint` | `mint` op (restore: the account + what was reclaimed from it) |
| Fed grant `!econ fund` (+ the admin card's form) | `_mo_fund_run` | `grant` op: pool cap, the Fed holds it, the floor's 2nd confirm, protocol shares for House / Bank / MM |
| Fed loan `!econ fedloan`, flash liquidity, the Bank's default backstop | `_fl_open` (+ the shortfall mint) | `loan_open` op: outstanding cap, pool cap (Fort Knox / Casino), the shortfall mint under the loan cap, shares |
| early repayment `!econ fedloan repay` | `_fl_repay_run` | `loan_repay` op |
| the waterfall's / daily release's loan step | `_fl_apply_repay` | `loan_repaid` op (mark `<period>-<vault>`; queued when the site is down) - or booked inside the site's own run when Phase 4 is live |
| a Bank repayment repays flash loans | `_mo_flash_repay` | `flash_repay` op (queued when the site is down) |
| donation mints (wallet + incentive bonus) | `_mo_settle_donation` on the claim | the site's donation sweep (every 15 s): `<cid>-w` dest site, `<cid>-b` into incentives, the claim settled - one transaction |
| the monthly mint caps, the Fed band, the journal | `econ_layers` + `_mo_mint_allowed` | `fed_records` + the caps checked inside each op's transaction |

What does NOT change: every command's dry run, confirm and text (the bot formats the site's answer with the same functions), the
`econ_cfg` settings (Pepe's; every op carries his effective values), the PAT legs' keys (Pepe's own), the donation credit (promo
split, bonus %: `donationpromo.creditTerms`, unchanged - the sweep journals the claim's `amount` and `meta.bonus` exactly).

## The rules

- **One writer.** While live, only `fed/service.js` writes the Fed's journal. Each op is ONE `dbUtils.tx`: check the caps and the
  band, move the legs, journal. `dbUtils.tx` is the site's only transaction primitive (a global chain + `BEGIN IMMEDIATE` on the
  shared connection): two transactions never interleave, so the scheduler's floor / issuance mint and an admin mint can't both
  pass a cap checked a moment earlier (`test/fed.test.js`: two mints racing in the same second - only what fits lands; the
  scheduler's next mint sees it).
- **The switch** (the user's rule): Pepe writes locally ONLY while `fed_client.json` says `"backend": false` (or there is no file /
  no site configured). On, `"cutting"` or unreadable: an admin op with the site down is **refused** (never written locally); a
  booking whose PAT already moved is kept in the outbox and sent again under the same op key.
- **Idempotent.** Every request carries an op key (`mint-<key>`, `grant-<key>`, `loan-<key>`, `repaid-<mark>`, `flrepay-<key>`); a
  repeated key answers the first answer. Records are keyed as Pepe keyed them (a mint key, `FL<n>` / `FL-<key>`, a repayment mark).
- **The mirror.** Pepe's `econ_layers.fed_mints / fed_grants / fed_loans / fed_loan_repaid / fed_loan_seq` and
  `econ_monetary.flash_repaid` are overwritten from `/api/fed/bot/state` after every op and every minute; readers (`!econ mints`,
  `!econ fedloan`, the admin card, the waterfall's loan step, the policy inputs) are unchanged. His `_layers_tick` / grant retry
  don't touch mirror records.
- **Order:** the pools (Phase 1) and the share book (Phase 3) must live on the site (grants, loans and mints into House / Bank / MM
  book protocol shares there) - both sides refuse otherwise. Phase 4 (the engines) is independent: live or not, the scheduler's
  mints go through the same book once the Fed is live.

## 0. When

- After Phase 3 (the capital cluster) is live on prod.
- Not within 20 minutes of 04:00 UTC (the monetary day mints then), not during a Monday epoch run.
- Not in the same hour as another cutover (Phase 3 / Phase 4 / the E-4 go-live).

## 1. Deploy

Site ≥ 1.99uv (`ef6ea17`), bot ≥ 1.99uv. The site switch defaults OFF on prod (`fed_meta.enabled` unset = off; on on staging) and
Pepe's defaults OFF: nothing changes until the cutover.

## 2. Backups

```
TS=$(date -u +%Y%m%dT%H%M%SZ)
sqlite3 /home/PATV/myapp.db ".backup /home/PATV-backups/myapp-pre-fed-cutover-$TS.db"
```
(the import also takes its own verified copy: `backups/myapp-pre-fed-import-*.db`). Pepe (prod VM, PowerShell):
```
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"); $d = "C:\PATV\backups\fed-cutover-$ts"; New-Item -ItemType Directory $d
Copy-Item C:\PATV\camfrog-bot\turf_data.json $d; Copy-Item C:\PATV\camfrog-bot\fed_client.json $d -ErrorAction SilentlyContinue
```

## 3. Enable the site switch (a prod write: the user's go)

`cd /home/PATV && node tools/fed-backend.js --actor=<who> on` (status: `node tools/fed-backend.js`).

## 4. Dry run (changes nothing)

`!econ fed backend export`, or `{"action":"dryrun"}` in `C:\PATV\fed-cutover.request.json` (result in
`C:\PATV\fed-cutover.result.json`). Pepe builds the export (sha256 + totals) and the site runs the whole import in a transaction
and rolls it back: digest, totals, nothing half-done, the supply unchanged. Note the totals + sha256.

## 5. Cutover (a prod write: the user's go)

`!econ fed backend on`, or `{"action":"cutover","actor":"<who>","key":"fc-<date>"}`. Pepe switches to `"cutting"` (no Fed op runs
anywhere), exports again after the freeze, the site imports (backup, one transaction, read back and compared, supply before = after)
and goes live; Pepe's switch goes on and his mirror is refreshed. A refusal turns the switch explicitly off again (local); no
answer leaves it frozen - retry with the SAME key (the site answers a used key with its stored result).

Verify: `!econ fed backend status` = `SITE ... LIVE`; `node tools/fed-backend.js` shows the same totals and sha256 as the dry
run; `!econ mints` unchanged; the Backends card row "Fed one-off ops" = site.

## 6. After the cutover

- Watch the first admin op / the next 04:00 UTC monetary day / the next donation: `SELECT kind, key, state, amount FROM fed_records
  ORDER BY updated DESC LIMIT 10`; `SELECT op_key, op FROM fed_ops ORDER BY created DESC LIMIT 10`; Pepe's log `[FED] ... (publicaccess.tv)`.
- `!econ fed backend status` shows the outbox (bookings waiting for the site).

## 7. Rollback (while the site answers)

`!econ fed backend off`, or `{"action":"rollback","actor":"<who>","key":"fr-<date>"}`. The site goes not-live and answers its books
(sha256 + totals; Pepe checks both before writing); Pepe writes them into `turf_data.json` and switches off. The same key again
answers the stored result. The site's `fed_records` stay (a later cutover replaces them).

## 8. Detach (the site is gone for good)

`!econ fed backend detach confirm`. Refused while the site answers and owns the books. Pepe's last mirror becomes his journal.

## 9. Staging rehearsal (2026-10-13, 02:15-02:32 UTC)

Site 1.99uv `ef6ea17` (deployed with the staging stack at 22:08 EDT) and PepeBeta (VM 111) bot 1.99va `146066a` (in `b03c143`,
**passed probation** 22:22 EDT), on top of staging's live Phase 1 / Phase 3 and the Phase 4 shadow. Nothing on prod was written:
prod's journal was read **read-only** from VM 110 (`agent/file-read` of `turf_data.json`; only `econ_layers.fed_*` and
`econ_monetary.flash_repaid` were copied to `C:\PATVed-prodcopy.json` on VM 111).

| Step | Result |
|---|---|
| prod copy, dry import (`fed-inject.json` `dry_import`) | prod's journal: **12 mints, 205,940,666 PAT; 1 grant, 15,000,000; 0 loans; 0 repayments**; sha256 `3cb35393…5c7114c9`; nothing half-done; Pepe's totals = the site's totals; the import ran in a transaction and rolled back, the staging supply **1,303,062,492** unchanged |
| staging dry run (`dryrun`) | staging's own journal: 8 mints 164,537,666, 1 grant 15,000,000, sha256 `f5101425…`; ready |
| cutover `fc-rehearsal-1` | live; the site's backup `myapp-pre-fed-import-2026-10-13T02-23-58-165Z.db`; supply **1,303,062,492 → 1,303,062,492**, pools 276,439,083 unchanged; merged site mints 0 |
| `!econ mint 1m …` (inject `cmd`, as an admin) | dry run (cap room from the mirror) → confirm: the site minted 1,000,000 into the Fed (Fed 50,500,975 → 51,500,975), **supply +1,000,000 exactly** (1,304,062,492); the same text as the local path (the Fed balance in the text read Pepe's cache - fixed in the follow-up: it shows the site's balance) |
| `!econ fund fortknox 500k …` | refused in the dry run (Fort Knox 15,050,881 of its 15,000,000 cap) - the pool-cap check, unchanged |
| `!econ fund incentives 500k …` → confirm | the site's grant: incentives 69,831,901 → 70,331,901, Fed 51,500,975 → 51,000,975, supply unchanged |
| `!econ fedloan casino 300k …` → confirm | FL1 (the site's loan number), Casino vault 3,420,561 → 3,720,561; `!econ fedloan` lists it from the mirror |
| `!econ fedloan repay FL1` → confirm | repaid 300,000 from the Casino vault to the Fed: fully repaid, supply unchanged |
| a donation claim (synthetic, staging DB: `don-p41-rehearsal-1`, 10,000 + bonus 2,000, stripe) | the site's sweep journaled `…-w` (10,000, dest site) and `…-b` (2,000 into incentives: 70,331,901 → 70,333,901) and settled the claim within 15 s; Pepe never saw it |
| `!econ mints` | the mirror: admin 1,000,000 / total 1,000,000 of 100,000,000 this month |
| rollback `fr-rehearsal-1` | Pepe's journal written back: **11 mints 165,549,666** (= 164,537,666 + 1,000,000 + 12,000), 2 grants 15,500,000, 1 loan (repaid), 1 repayment, seq 1 - sha256 + totals checked by Pepe |
| cutover `fc-rehearsal-2` → rollback `fr-rehearsal-2` | the same totals both ways; supply 1,304,064,492 |

**Staging is left LOCAL** (switch off, the site not live) so the Phase 3 soak and the Phase 4 shadow (tonight's 04:00 UTC, the
Monday 2026-10-19) run exactly as before. The rehearsal changed staging's sandbox PAT by +1,002,000 (the admin mint and the
synthetic donation's bonus; the wallet half of the synthetic claim was journaled without a wallet credit), plus a 500,000 grant into
incentives and a repaid 300,000 loan - all keyed, all in Pepe's journal now.

Tests: `test/fed.test.js` (9: the switch, the import checks + dry run, the admin mint + replays, two mints racing for the cap + the
scheduler's mint sharing it, grants, loans / flash / bookings / early repayment, a loan refused whole by its shortfall mint's cap,
donations, rollback + cutover again), `test/policy.test.js`, `test/import-body-limit.test.js`, the whole site suite (the only
failures: the 7 files needing `@noble/curves`, missing locally - the same on the baseline); bot `fed_client_test.py` (40 checks),
`policy_client_test.py`, `backends_test.py`, `ci/check.py --tests` (the one failure, `achstore_test.py`, is a timing flake under the
parallel runner that fails on the baseline too).

## 10. What the prod cutover needs from the user

1. A go to promote site ≥ 1.99uv and bot ≥ 1.99va (+ the follow-up) to prod - nothing changes while the switches are off.
2. Phase 3 (the capital cluster) live on prod first (both sides refuse without it).
3. A go for each prod write: §3 (the site switch on), §5 (the cutover), each after §2's backups and §4's dry run; not within 20
   minutes of 04:00 UTC, not in the hour of another cutover.
