// PO-4 (1.99aju): tools/policy-backend.js's H2a gate-5 lines, run as the shell runs them (a child process, --dir, read-only):
//   * "derived dual read recorded every day <span>" (FAIL on a missing day; INFO "not running yet" before the first row)
//   * "derived dual read clean since <day>" (PASS: the latest final row clean, "N days in a row, Mondays: ..."; FAIL: its blocking)
//   * "shadow audit = Pepe's (<eid>)" (PASS both match, WARN pending, FAIL a mismatch) and the INFO "staking readers" line
//   * the engines' "shadow periods clean" line ignores the derived rows; a database without policy_epoch_audit still works; the
//     tool writes nothing (no CREATE, no INSERT); "recorded every day" starts at the first row or a later --since (review of PO-4)
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-backend-derived.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const sqlite3 = require("sqlite3");

const repo = path.resolve(__dirname, "..");
const DAY = 86400e3;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const days = (n) => Array.from({ length: n }, (_, i) => utcDay(Date.now() - (n - i) * DAY));     // the n days before today, oldest first

function makeDb(dir, { audit = true, derived = [], audits = [], sims = [] } = {}) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(dir, "myapp.db"));
    const st = [
      "CREATE TABLE policy_engines (engine TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'off', armed_at REAL, updated INTEGER, by TEXT, note TEXT, paused INTEGER NOT NULL DEFAULT 0, paused_by TEXT, paused_at INTEGER, pause_note TEXT)",
      "INSERT INTO policy_engines (engine, mode) VALUES ('treasury', 'shadow'), ('monetary', 'shadow'), ('burn', 'shadow')",
      `CREATE TABLE policy_sims (key TEXT PRIMARY KEY, mode TEXT NOT NULL, engine TEXT NOT NULL, period TEXT NOT NULL, site_inputs TEXT, site_plan TEXT, pepe_inputs TEXT, pepe_plan TEXT,
        replay_plan TEXT, engine_diff TEXT, input_diff TEXT, total_diff TEXT, ok INTEGER, created INTEGER, updated INTEGER, site_boundary_inputs TEXT, site_boundary_plan TEXT,
        boundary_ts REAL, truncated INTEGER, whitelisted TEXT, boundary_meta TEXT, blocking TEXT, pepe_cfg TEXT)`,
      "CREATE TABLE policy_runs (key TEXT PRIMARY KEY, engine TEXT NOT NULL, period TEXT NOT NULL, state TEXT NOT NULL, boundary REAL, via TEXT, inputs TEXT, plan TEXT, result TEXT, error TEXT, created INTEGER, done INTEGER)",
    ];
    if (audit) {
      st.push(`CREATE TABLE policy_epoch_audit (eid TEXT PRIMARY KEY, via TEXT, state TEXT, audit TEXT, notice TEXT, digest TEXT, pepe TEXT, audit_match INTEGER, digest_match INTEGER,
               audit_sent_at INTEGER, digest_sent_at INTEGER, created INTEGER, updated INTEGER)`);
    }
    const ins = [];
    for (const d of derived) {
      ins.push(["INSERT INTO policy_sims (key, mode, engine, period, site_inputs, site_plan, blocking, ok, created, updated) VALUES (?, 'shadow', 'derived', ?, ?, ?, ?, ?, ?, ?)",
                [`shadow:derived:D${d.day}`, `D${d.day}`, JSON.stringify({ attempts: [{}] }), JSON.stringify({ targets: { bank: 2000000, house: 15000000, mm: 1000000 }, fl_room: 10000000 }),
                 JSON.stringify({ plan: d.blocking || [] }), d.ok, Date.now(), Date.now()]]);
    }
    for (const a of audits) {
      ins.push(["INSERT INTO policy_epoch_audit (eid, via, state, audit_match, digest_match, created, updated) VALUES (?, 'shadow', ?, ?, ?, ?, ?)", [a.eid, a.state, a.am, a.dm, Date.now(), Date.now()]]);
    }
    for (const s of sims) {
      ins.push(["INSERT INTO policy_sims (key, mode, engine, period, pepe_plan, ok, boundary_ts, created, updated) VALUES (?, 'shadow', ?, ?, '{}', ?, 1, ?, ?)",
                [`shadow:${s.engine}:${s.period}`, s.engine, s.period, s.ok, Date.now(), Date.now()]]);
    }
    db.serialize(() => {
      for (const s of st) db.run(s);
      for (const [q, p] of ins) db.run(q, p);
      db.close((e) => (e ? reject(e) : resolve()));
    });
  });
}
function schemaOf(dir) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(dir, "myapp.db"), sqlite3.OPEN_READONLY);
    db.all("SELECT type, name, sql FROM sqlite_master ORDER BY name", (e, rows) => {
      if (e) return reject(e);
      const counts = {};
      const tables = rows.filter((r) => r.type === "table").map((r) => r.name);
      let left = tables.length;
      if (!left) return db.close(() => resolve({ rows, counts }));
      for (const t of tables) {
        db.get(`SELECT COUNT(*) AS n FROM ${t}`, (e2, r) => {
          counts[t] = e2 ? null : r.n;
          if (!--left) db.close(() => resolve({ rows, counts }));
        });
      }
    });
  });
}
function preflight(dir, extra = []) {
  const r = spawnSync(process.execPath, [path.join(repo, "tools", "policy-backend.js"), "preflight", `--dir=${dir}`, "--json", ...extra], { encoding: "utf8", env: Object.assign({}, process.env, { STAGING: "" }) });
  const m = /^\[$/m.exec(r.stdout || "");                          // the JSON (after the database's own start-up lines)
  assert.ok(m, `${r.status} ${r.stderr} ${r.stdout}`);
  return JSON.parse(r.stdout.slice(m.index));
}
const line = (res, re) => res.find((x) => re.test(x.check));

test("preflight: every day recorded and the latest clean -> PASS 'clean since <day>' with the streak and its Mondays; the shadow audit = Pepe's", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-derived-1-"));
  const ds = days(9);
  await makeDb(dir, { derived: ds.map((day, i) => ({ day, ok: i < 2 ? 0 : 1, blocking: i < 2 ? ["targets.bank: site 1 / pepe 2"] : [] })),
                      audits: [{ eid: "W2026-10-26", state: "final", am: 1, dm: 1 }, { eid: "W2026-11-02", state: "final", am: 1, dm: 1 }],
                      sims: [{ engine: "treasury", period: "D2026-11-01", ok: 1 }] });
  const before = await schemaOf(dir);
  const res = preflight(dir);
  const rec = line(res, /^derived dual read recorded every day /);
  assert.equal(rec.level, "PASS", JSON.stringify(rec));
  assert.ok(rec.check.includes(`${ds[0]}..${ds[ds.length - 1]}`), rec.check);
  const cl = line(res, /^derived dual read clean since /);
  assert.equal(cl.level, "PASS", JSON.stringify(cl));
  assert.equal(cl.check, `derived dual read clean since ${ds[2]}`);
  const mondays = ds.slice(2).filter((d) => new Date(d + "T00:00:00Z").getUTCDay() === 1);
  assert.equal(cl.detail, `${ds.length - 2} day(s) in a row, Mondays: ${mondays.join(", ") || "none yet"}`);
  assert.equal(line(res, /^shadow audit = Pepe's/).level, "PASS");
  assert.equal(line(res, /^shadow audit = Pepe's/).check, "shadow audit = Pepe's (W2026-11-02)");
  assert.equal(line(res, /^staking readers/).level, "INFO");
  assert.match(line(res, /^staking readers/).detail, /capital push/);
  // the engines' line counts only the engines' rows (the derived rows have pepe_plan NULL anyway: never "reported")
  assert.match(line(res, /^shadow periods clean/).detail, /^1 compared, all clean$/);
  assert.deepEqual(await schemaOf(dir), before, "read-only: no CREATE, no INSERT");
});

test("preflight: a missing day FAILs; the latest row not clean FAILs with its blocking entries; a pending audit WARNs, a mismatch FAILs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-derived-2-"));
  const ds = days(5);
  await makeDb(dir, { derived: [{ day: ds[0], ok: 1 }, { day: ds[1], ok: 1 }, { day: ds[3], ok: 1 }, { day: ds[4], ok: 0, blocking: ["targets.bank: site 3000000 / pepe 2000000"] }],
                      audits: [{ eid: "W2026-11-02", state: "pending", am: null, dm: 1 }] });
  const res = preflight(dir);
  const rec = line(res, /^derived dual read recorded every day /);
  assert.equal(rec.level, "FAIL");
  assert.match(rec.detail, new RegExp(`no row: ${ds[2]}`));
  const cl = line(res, /^derived dual read clean since /);
  assert.equal(cl.level, "FAIL");
  assert.match(cl.detail, /targets\.bank: site 3000000 \/ pepe 2000000/);
  assert.equal(line(res, /^shadow audit = Pepe's/).level, "WARN");
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pb-derived-3-"));
  await makeDb(dir2, { derived: [{ day: days(1)[0], ok: 1 }], audits: [{ eid: "W2026-11-02", state: "final", am: 1, dm: 0 }] });
  assert.equal(line(preflight(dir2), /^shadow audit = Pepe's/).level, "FAIL");
});

test("preflight (review of PO-4): 'recorded every day' starts at the first derived row, or at --since when that is later", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-derived-5-"));
  const ds = days(6);
  await makeDb(dir, { derived: ds.slice(3).map((day) => ({ day, ok: 1 })) });          // PO-4 deployed 3 days ago
  // an older --since (the H1 evidence window): not a FAIL for the days before PO-4 ran
  const old = line(preflight(dir, [`--since=${ds[0]}`]), /^derived dual read recorded every day /);
  assert.equal(old.level, "PASS", JSON.stringify(old));
  assert.ok(old.check.includes(`${ds[3]}..${ds[5]}`), old.check);
  // a later --since narrows it
  const late = line(preflight(dir, [`--since=${ds[4]}`]), /^derived dual read recorded every day /);
  assert.equal(late.level, "PASS", JSON.stringify(late));
  assert.ok(late.check.includes(`${ds[4]}..${ds[5]}`), late.check);
});

test("preflight: before the first row 'not running yet'; a database without policy_epoch_audit still works", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-derived-4-"));
  await makeDb(dir, { audit: false });
  const before = await schemaOf(dir);
  const res = preflight(dir);
  const rec = line(res, /^derived dual read recorded every day/);
  assert.equal(rec.level, "INFO");
  assert.match(rec.detail, /not running yet/);
  assert.equal(line(res, /^shadow audit = Pepe's/).level, "INFO");
  assert.deepEqual(await schemaOf(dir), before, "nothing created");
  // status prints the new lines too
  const r = spawnSync(process.execPath, [path.join(repo, "tools", "policy-backend.js"), "status", `--dir=${dir}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
