// PO-0b review: tools/policy-backend.js (read-only) names the closed stashes a credit can't reach - their owner has no PATV
// account to pay, so a credit to one is refused (409 E_STASH_CLOSED, recorded) - and the waterfall stash legs refused in the
// last 14 days (until PO-0c, Pepe's _tr_finish resends a refused leg every tick: the deploy gate before a Monday epoch).
// The owner rule is stashes.holderInfo's: an account key "u:<id>" follows merges; a login needs exactly one linked account.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-backend-closed.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-backend-closed-"));
const env = Object.assign({}, process.env, { NODE_PATH: process.env.NODE_PATH || path.join(repo, "node_modules") });
delete env.STAGING;
const node = (args) => spawnSync(process.execPath, args, { cwd: dir, env, encoding: "utf8", timeout: 60000 });

test.before(() => {
  const setup = `
    const s = require("sqlite3"); const d = new s.Database("myapp.db");
    const q = [
      "CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT, camfrogUsername TEXT)",
      "INSERT INTO users VALUES ('u1', 'ann', 'Ann_CF'), ('u3', 'c', 'dup_cf'), ('u4', 'd', 'dup_cf')",
      "CREATE TABLE account_merges (old_id TEXT, new_id TEXT)",
      "INSERT INTO account_merges VALUES ('u_old', 'u1')",
      "CREATE TABLE stashes (id TEXT PRIMARY KEY, owner TEXT, name TEXT, balance INTEGER, staked INTEGER, earned INTEGER, created REAL, closed REAL, updated INTEGER)",
      "INSERT INTO stashes (id, owner, name, balance, staked, earned, closed) VALUES ('1', 'ann_cf', 'a', 0, 0, 0, 1), ('2', 'u:u1', 'b', 0, 0, 0, 1),"
        + " ('3', 'u:u_old', 'c', 0, 0, 0, 1), ('4', 'u:gone', 'd', 0, 0, 0, 1), ('5', 'nobody', 'e', 0, 0, 0, 1), ('6', 'dup_cf', 'f', 0, 0, 0, 1),"
        + " ('7', 'nobody', 'open', 0, 0, 0, NULL)",
      "CREATE TABLE stash_moves (key TEXT PRIMARY KEY, stash_id TEXT, kind TEXT, amount INTEGER, staked_delta INTEGER, login TEXT, user_id TEXT, txid TEXT, via TEXT, ts INTEGER, result TEXT)",
      "INSERT INTO stash_moves (key, stash_id, kind, amount, ts, result) VALUES ('wf-W1-bank-stk-5:in', '5', 'refused', 0, " + Date.now() + ", '{\\"ok\\":false,\\"code\\":\\"E_STASH_CLOSED\\"}'),"
        + " ('wf-W0-bank-stk-4:in', '4', 'refused', 0, " + (Date.now() - 20 * 86400e3) + ", '{\\"ok\\":false}'),"
        + " ('corr-x-s5:in', '5', 'refused', 0, " + Date.now() + ", '{\\"ok\\":false}')",
    ];
    d.serialize(() => { for (const x of q) d.run(x, (e) => { if (e) { console.error(e.message); process.exitCode = 1; } }); });
    d.close();`;
  const r = node(["-e", setup]);
  assert.equal(r.status, 0, r.stderr);
});

test("status + preflight: closed stashes with no account to pay, waterfall legs refused in 14 days (WARN, read-only)", () => {
  const st = node([path.join(repo, "tools", "policy-backend.js"), "status"]);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /stashes {2}3 closed stash\(es\) with no account to pay: 4 \(u:gone\), 5 \(nobody\), 6 \(dup_cf\)/);
  assert.match(st.stdout, /refused {2}wf-W1-bank-stk-5:in \(stash 5, .*\): E_STASH_CLOSED/);
  assert.doesNotMatch(st.stdout, /wf-W0-bank-stk-4/, "older than 14 days");
  assert.doesNotMatch(st.stdout, /refused {2}corr-/, "waterfall legs only");
  const pf = node([path.join(repo, "tools", "policy-backend.js"), "preflight", "--json"]);
  assert.equal(pf.status, 0, pf.stderr);
  const rows = JSON.parse(pf.stdout.slice(pf.stdout.indexOf("[\n")));    // after dbUtils' "Database connected." / [sqlite] lines
  const by = Object.fromEntries(rows.map((r) => [r.check, r]));
  assert.equal(by["every closed stash has an account to pay"].level, "WARN");
  assert.match(by["every closed stash has an account to pay"].detail, /^3: 4 \(u:gone\), 5 \(nobody\), 6 \(dup_cf\)/);
  assert.equal(by["no waterfall stash leg refused in 14 days"].level, "WARN");
  assert.match(by["no waterfall stash leg refused in 14 days"].detail, /wf-W1-bank-stk-5:in \(E_STASH_CLOSED\)/);
  // still read-only: it created nothing
  const t = node(["-e", `const s=require("sqlite3");const d=new s.Database("myapp.db");d.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",(e,r)=>{console.log(JSON.stringify(r.map(x=>x.name)));d.close();});`]);
  assert.deepEqual(JSON.parse(t.stdout.trim()), ["account_merges", "stash_moves", "stashes", "users"]);
});
