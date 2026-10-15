// 1.99zp: Pepe banned from a pad's Camfrog room (bot pepe_roomban). His owner-sync status says "out" + banned {...}:
// the owner panel shows it as "banned" (who, since, next automatic try); his room-state push lists the bans for
// /admin/pepe/rooms. Pure cleaners, no DB.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const repo = path.join(__dirname, "..");
const PO = require(path.join(repo, "padowner"));
const RC = require(path.join(repo, "roomctl"));

test("owner panel: out + banned -> state banned with who / when", () => {
  const s = PO.cleanOne({ status: { state: "out", rooms: 4, max: 5, banned: { by: "Sard0nicGrin<script>", at: 1760000000000, since: 1759990000000, retry_at: 1760021600000 } } }).status;
  assert.equal(s.state, "banned");
  assert.equal(s.banned.by, "Sard0nicGrinscript");
  assert.equal(s.banned.retry_at, 1760021600000);
  assert.equal(s.banned.since, 1759990000000);
});

test("owner panel: in the room wins over an old ban record; no ban -> unchanged", () => {
  assert.equal(PO.cleanOne({ status: { state: "in", banned: { by: "x", at: 1 } } }).status.state, "in");
  const s = PO.cleanOne({ status: { state: "out" } }).status;
  assert.equal(s.state, "out");
  assert.equal(s.banned, null);
});

test("room-state push: bans are kept, cleaned", () => {
  const st = RC.cleanState({ rooms: [], bans: [{ room: "DRAMA_CENTRAL", by: "Sard0nicGrin", at: 5, since: 4, retry_at: 9, tries: 2 }, { by: "no room" }] });
  assert.deepEqual(st.bans, [{ room: "DRAMA_CENTRAL", by: "Sard0nicGrin", at: 5, since: 4, retry_at: 9, tries: 2 }]);
  assert.deepEqual(RC.cleanState({ rooms: [] }).bans, []);
});

test("the panel knows the banned state + its strings exist", () => {
  const js = fs.readFileSync(path.join(repo, "public/js/pad-owner.js"), "utf8");
  const ejs = fs.readFileSync(path.join(repo, "views/padOwner.ejs"), "utf8");
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales/en.json"), "utf8"));
  assert.ok(/banned: function/.test(js) && /poBanned/.test(js));
  assert.ok(/banned: 'bad'/.test(ejs) && /id="poBanned"/.test(ejs));
  for (const k of ["owner.ps_banned", "owner.ps_banned_note", "js.owner.ps_banned", "js.owner.ps_banned_note"]) assert.ok(en[k], k);
});
