// Account merge coverage guard (1.99gb): every column, in every table, that may hold a userId must be classified
// in accountMerge.js RULES (moved / folded, "special", "keep" or a deny reason). A new table with a user column
// that nobody classified fails here - so a merge can't quietly leave someone's data behind again.
// The universe: test/fixtures/schema.sql (a real database) + every CREATE TABLE / ADD COLUMN in the server code.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const sqlite3 = require("sqlite3");

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "mergecov-")));   // dbUtils opens ./myapp.db
const repo = path.join(__dirname, "..");
const AM = require(path.join(repo, "accountMerge"));
const { columnUniverse } = require(path.join(__dirname, "fixtures", "schemascan"));

test("every user column of every table is classified for account merges", async () => {
  const U = await columnUniverse(repo, sqlite3);
  assert.ok(Object.keys(U).length > 120, "the schema snapshot + source scan found the tables");
  const missing = [];
  for (const [t, cols] of Object.entries(U)) {
    if (t === "users" || t.startsWith("sqlite_")) continue;
    for (const c of cols) {
      const k = `${t}.${c}`;
      if ((AM.isCandidate(c) || AM.EXTRA.includes(k)) && !AM.classify(t, c)) missing.push(k);
    }
  }
  assert.deepStrictEqual(missing, [], `unclassified user columns - add them to accountMerge.js RULES: ${missing.join(", ")}`);
});

test("the rules name real columns, and every rule is well-formed", async () => {
  const U = await columnUniverse(repo, sqlite3);
  const stale = Object.keys(AM.RULES).filter((k) => { const [t, c] = k.split("."); return !(U[t] && U[t].has(c)); });
  assert.deepStrictEqual(stale, [], `RULES entries for columns that don't exist: ${stale.join(", ")}`);
  const OPS = new Set(["MIN", "MAX", "SUM", "OLD_IF_NULL", "NULL_WINS"]);
  for (const [k, r] of Object.entries(AM.RULES)) {
    const kinds = ["move", "special", "keep", "deny"].filter((x) => r[x]);
    assert.equal(kinds.length, 1, `${k}: exactly one of move / special / keep / deny`);
    if (r.deny || r.keep || r.special) assert.equal(typeof (r.deny || r.keep || r.special), "string", `${k}: say why`);
    const [t] = k.split(".");
    for (const kc of r.key || []) assert.ok(U[t].has(kc), `${k}: key column ${kc} exists`);
    for (const [c, op] of Object.entries(r.merge || {})) {
      assert.ok(U[t].has(c), `${k}: merge column ${c} exists`);
      assert.ok(OPS.has(op) || (op && Array.isArray(op.rank)), `${k}: merge op ${JSON.stringify(op)}`);
    }
  }
});

test("the candidate pattern catches the usual user-column names (and not plain ids)", () => {
  for (const c of ["userId", "user_id", "owner_user_id", "subject_user_id", "by_user_id", "author_id", "follower", "target_id",
                   "counterparty", "payer_id", "posted_by", "created_by", "owner_id", "sender_id", "buyer_id", "seller_id", "owner"]) {
    assert.ok(AM.isCandidate(c), c);
  }
  for (const c of ["id", "post_id", "room_id", "badgeId", "created", "amount", "body"]) assert.ok(!AM.isCandidate(c), c);
});
