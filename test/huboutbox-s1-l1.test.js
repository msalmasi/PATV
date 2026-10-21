// S1 Q4 (release L1) - the v1 seam's pads/changed, roles/changed, bans/changed and switches/changed topics and the CHAT_HUB
// interlock (seam plan §12.2-§12.6, §12.10, §12.12 "Q4 / Q5b (v1)"; ADR 0007 D1-D3, D9, D11). Against the golden rows' `s1`
// section (test/fixtures/hubseam-golden-rows.json, byte-identical in the hub repo):
//   * every pads / roles / bans / switches builder produces its golden row's payload for its input, with the database seeded as
//     the golden rows' inputs say (v1 never produces the switch value the hub must quarantine);
//   * each trigger writes only with its switch on and only for its listed columns (never the bridge's / the stage's / the
//     archive's busy columns), OLD and NEW keys; pad_hub's backfill and insert trigger; the displaced-row emit of a re-key;
//   * the four snapshot pages are the golden pages, 404 (null) while the switch is off, paged in byte order across pad: / pm:;
//   * the poster reads a batch of trigger rows in one build per topic and posts the golden payloads;
//   * the heartbeat carries the four switches; the interlock (S1-D7) both ways; chat_backend's writer.
//   node --test test/huboutbox-s1-l1.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "huboutbox-s1-l1-test-"));
process.chdir(dir);
delete process.env.STAGING;
delete process.env.HUB_V1_URL; delete process.env.HUB_V1_PROXY;
delete process.env.CHAT_GENESIS_NS;
process.env.HUB_V1_ENV = "test";
process.env.SECRET_KEY = "test-secret";
const repo = path.resolve(__dirname, "..");
const G = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "hubseam-golden-rows.json"), "utf8"));
const S1 = G.s1;
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

const built = (async () => {                        // the real schema: a staging dump + every CREATE in the source
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  await new Promise((r) => db.close(r));
})();

const AT = 1760727590000, DAY = 86400000;
const ACCT = { 1001: "0192a5b4-1111-7c2d-8e3f-4a5b6c7d8e9f", 1002: "0192a5b4-2222-7c2d-8e3f-4a5b6c7d8e9f", 1005: "0192a5b4-5555-7c2d-8e3f-4a5b6c7d8e9f",
               1006: "0192a5b4-6666-7c2d-8e3f-4a5b6c7d8e9f", 1007: "0192a5b4-7777-7c2d-8e3f-4a5b6c7d8e9f" };
const PAD = { lounge: "6f1d3c2a-0b7e-4c51-9a2d-3e4f5a6b7c8d", frogpond: "5c0b2a19-9f6d-4b40-8a1c-2d3e4f5a6b7c", staff: "7a2e4d3b-1c8f-4d62-8b3e-4f5a6b7c8d9e",
              oldpad: "8b3f5e4c-2d9a-4e73-9c4f-5a6b7c8d9eaf" };
const goldenRow = (topic, entity) => { const r = S1.rows.find((x) => x.row.topic === topic && x.row.entity === entity); assert.ok(r, entity); return r; };
const golden = (name) => { const r = S1.rows.find((x) => x.name === name); assert.ok(r, "golden row " + name); return r; };
const L1_TOPICS = ["pads/changed", "roles/changed", "bans/changed", "switches/changed"];

let runQuery, getQuery, tx, HO, HP, HR, HB, CS, PH, RK, rooms, PA;
const outbox = (topic) => getQuery("SELECT entity, payload FROM hub_outbox WHERE topic = ? ORDER BY id", [topic]);
const clearOutbox = () => runQuery("DELETE FROM hub_outbox");
const entitiesOf = async (topic) => (await outbox(topic)).map((r) => r.entity);

async function addUser(id, f) {
  const cols = { userId: id, username: f.username, displayname: f.displayname || f.username, password: "x", class: f.cls || "pleb",
                 camfrogUsername: f.camfrog || null, level: 1 };
  const k = Object.keys(cols);
  await runQuery(`INSERT INTO users (${k.map((c) => `"${c}"`).join(", ")}) VALUES (${k.map(() => "?").join(", ")})`, k.map((c) => cols[c]));
}
const hubId = async (roomId) => (await getQuery("SELECT hub_pad_id FROM pad_hub WHERE room_id = ?", [roomId]))[0].hub_pad_id;
/** The golden CHAT_HUB row (on: "turned on at /admin/chat", golden 251) - written directly, past the interlock. */
async function chatHub(on) {
  await runQuery(`INSERT INTO chat_switches (key, value, updated, updated_by) VALUES ('CHAT_HUB', ?, ?, 'owner')
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, updated_by = excluded.updated_by`, [on ? "on" : "off", AT]);
  await CS.load();
}

/** The golden rows' v1 state (their `input`s) for the four L1 topics. */
async function seedGolden() {
  // only the golden pads: the other seeds go (a seed is never re-made once its rooms_kv marker is set)
  await runQuery("DELETE FROM rooms_registry WHERE room_id NOT IN ('patv:lounge', 'patv:staff')");
  // the Lounge: the house site pad, renamed back to the PATV Lounge, at hub; the staff pad: Approved, unlisted (both seeded)
  const L = (await getQuery("SELECT title, slug, owner_kind, listed FROM rooms_registry WHERE room_id = 'patv:lounge'"))[0];
  assert.deepEqual(L, { title: "PATV Lounge", slug: "patv-lounge", owner_kind: "house", listed: 1 }, "the seed (ADR 0007 OQ-1)");
  const St = (await getQuery("SELECT title, slug, owner_kind, listed, platform FROM rooms_registry WHERE room_id = 'patv:staff'"))[0];
  assert.deepEqual(St, { title: "Staff room", slug: "staff", owner_kind: "house", listed: 0, platform: "site" }, "the staff pad's seed");
  assert.equal(PA.levelOf("patv:staff"), "approved", "padaccess seeded its level");
  await runQuery("UPDATE rooms_registry SET created = ? WHERE room_id = 'patv:lounge'", [AT - 300 * DAY]);
  await runQuery("UPDATE rooms_registry SET created = ? WHERE room_id = 'patv:staff'", [AT - DAY]);
  await runQuery("UPDATE pad_hub SET hub_pad_id = ? WHERE room_id = 'patv:lounge'", [PAD.lounge]);
  await runQuery("UPDATE pad_hub SET hub_pad_id = ? WHERE room_id = 'patv:staff'", [PAD.staff]);
  assert.deepEqual(await PH.setBackend("patv:lounge", "hub", { username: "owner" }), { room_id: "patv:lounge", hub_pad_id: PAD.lounge, chat_backend: "hub", changed: true });
  // the Frog Pond: alice's Prime Time Plus pad (comped), Public, its chat settings, flairs, cosmetics, the owner's era (CL3)
  const F = golden("pads: a user-owned Prime Time Plus pad with chat settings, flairs, fx and badges").input;
  await addUser("1001", { username: "alice", camfrog: "Alice" });
  await addUser("1005", { username: "erin", camfrog: "erin", cls: "Staff" });
  await addUser("1006", { username: "frank", camfrog: "frank" });
  await runQuery(`INSERT INTO rooms_registry (room_id, slug, title, owner_kind, owner_user_id, platform, created, updated)
                  VALUES ('patv:frogpond', 'frog-pond', 'Frog Pond', 'user', '1001', 'site', ?, ?)`, [AT - 40 * DAY, AT]);
  await runQuery("UPDATE pad_hub SET hub_pad_id = ? WHERE room_id = 'patv:frogpond'", [PAD.frogpond]);
  await runQuery("INSERT INTO pad_access (room_id, level, updated, updated_by) VALUES ('patv:frogpond', 'public', ?, 'alice')", [AT]);
  await runQuery(`INSERT INTO premium_subs (tier, target, paid_through, status, comped, comp_until, started, updated)
                  VALUES ('prime_plus', 'patv:frogpond', 0, 'active', 1, ?, ?, ?)`, [F.comp_until, AT - 40 * DAY, AT]);
  await runQuery(`INSERT INTO pad_chat_cfg (room_id, window_s, search, downloads, mods_all, locked, updated, by_user)
                  VALUES ('patv:frogpond', ?, NULL, 0, 1, 0, ?, '1001')`, [F.chat_settings.window_s, AT]);
  await runQuery("INSERT INTO chatlog_rooms (room_id, pad_id, owner_id, owner_since, created) VALUES ('patv:frogpond', 'patv:frogpond', '1001', ?, ?)",
                 [F.owner_set_at, AT - 40 * DAY]);
  for (const [i, f] of F.flairs.entries()) {
    await runQuery("INSERT INTO pad_flairs (id, room_id, name, color, emoji, self_assign, sort, kind) VALUES (?, 'patv:frogpond', ?, ?, ?, ?, ?, 'user')",
                   [f.id, f.name, f.color, f.emoji || null, f.self ? 1 : 0, i]);
  }
  await require(path.join(repo, "padlook")).setCosmetics("patv:frogpond", { pad_frame: F.equip.pad_frame, pad_glow: F.equip.pad_glow, pad_badge: F.equip.pad_badge }, "alice");
  // the staff pad's members: erin approved, bob still asking (frank was removed: no row)
  await runQuery("INSERT INTO pad_members (room_id, user_id, status, requested_at, decided_at) VALUES ('patv:staff', '1005', 'approved', ?, ?)", [AT - DAY, AT]);
  await runQuery("INSERT INTO pad_members (room_id, user_id, status, requested_at) VALUES ('patv:staff', '1002', 'pending', ?)", [AT]);
  // roles: erin staff (set on /admin/roles), alice trusted, frank's removed (Pepe's tombstone)
  await runQuery("INSERT INTO pepe_roles (login, role, ts, by, via) VALUES ('erin', 'staff', ?, 'web:owner', 'web'), ('alice', 'trusted', ?, 'pepe', 'chat'), ('frank', NULL, ?, 'pepe', 'chat')",
                 [goldenRow("roles/changed", "acct:1005").row.payload.role_at, goldenRow("roles/changed", "acct:1001").row.payload.role_at,
                  goldenRow("roles/changed", "acct:1006").row.payload.role_at]);
  // bans: frank site-wide for good, erin from the Frog Pond for 7 days
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES ('1006', '', 'frank', 'spam', 'owner', ?, NULL)", [AT - 1000]);
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES ('1005', 'patv:frogpond', 'erin', 'x', 'alice', ?, ?)", [AT, AT + 7 * DAY]);
  // CHAT_HUB: off here (else the interlock keeps the tests' switches on); chatHub(true) writes the golden "turned on at
  // /admin/chat" state directly (the interlock itself is tested below)
  await chatHub(false);
  await require(path.join(repo, "premium")).loadCache();
  await PA.load();
  await rooms.loadCache();
}

test.before(async () => {
  await built;
  ({ runQuery, getQuery, tx } = require(path.join(repo, "dbUtils")));
  HO = require(path.join(repo, "huboutbox"));
  HP = require(path.join(repo, "hubpads"));
  HR = require(path.join(repo, "hubroles"));
  HB = require(path.join(repo, "hubbans"));
  CS = require(path.join(repo, "chatswitches"));
  PH = require(path.join(repo, "padhub"));
  RK = require(path.join(repo, "padrekey"));
  rooms = require(path.join(repo, "rooms"));
  PA = require(path.join(repo, "padaccess"));
  HO._setAccountOf((id) => ACCT[id] || null);
  HO._setClock(() => AT);
  await HO.init();
  const st = await HO.status();
  assert.equal(st.l1.ready, true, "release L1's topics are set up: " + st.l1.error);
  await seedGolden();
  await clearOutbox();
});
test.after(() => { HO.stop(); });

// ── the builders against the golden rows ──
test("pads: the builder produces every golden pads row (pad, gone, members) for its input", async () => {
  const want = S1.rows.filter((r) => r.row.topic === "pads/changed" && r.input.note !== "CHAT_GENESIS_NS unset");
  assert.equal(want.length, 7);
  const got = await HP.build(want.map((r) => r.row.entity), AT);
  for (const r of want) assert.deepEqual(got.get(r.row.entity), r.row.payload, r.name);
  // the member without a hub account (a legacy id, no namespace): v1 posts it, account null - the hub's to quarantine (no_subject)
  const q = golden("pads: a member without a hub account (legacy id, no namespace) is quarantined");
  await runQuery("INSERT INTO pad_members (room_id, user_id, status, requested_at, decided_at) VALUES ('patv:staff', 'legacy7', 'approved', ?, ?)", [AT, AT]);
  try {
    assert.deepEqual((await HP.build([q.row.entity], AT)).get(q.row.entity), q.row.payload);
  } finally { await runQuery("DELETE FROM pad_members WHERE user_id = 'legacy7'"); }
  // a pad's tier: the comp ends -> free (tier lapses write nothing: the payload's tier_until says when)
  const later = (await HP.build(["pad:" + PAD.frogpond], AT + 21 * DAY)).get("pad:" + PAD.frogpond);
  assert.deepEqual([later.tier, later.tier_until], ["free", null]);
  // another shape is left out (posted with payload null)
  assert.equal((await HP.build(["pad:NOPE", "pm:x"], AT)).size, 0);
});

test("pads: tier from the database rows (premium.endsAt): a Stripe renewal (stripe_through only), grace, Prime Time, a no-end comp", async () => {
  const id = "pad:" + PAD.frogpond;
  const tierAt = async (t) => { const p = (await HP.build([id], t)).get(id); return [p.tier, p.tier_until]; };
  await runQuery("UPDATE premium_subs SET comped = 0, comp_until = NULL, paid_through = ?, stripe_through = ?, stripe_sub = 'sub_1' WHERE target = 'patv:frogpond'",
                 [AT + DAY, AT + 30 * DAY]);
  try {
    const P = require(path.join(repo, "premium"));
    const grace = P.config().grace_days * DAY;
    assert.deepEqual(await tierAt(AT), ["plus", AT + 30 * DAY + grace], "a renewing Stripe sub: stripe_through + the grace");
    await runQuery("UPDATE premium_subs SET comped = 1, comp_until = NULL WHERE target = 'patv:frogpond'");
    assert.deepEqual(await tierAt(AT), ["plus", null], "a comp with no end");
    await runQuery("UPDATE premium_subs SET tier = 'prime_time', comped = 0, stripe_sub = NULL, stripe_through = 0, paid_through = ? WHERE target = 'patv:frogpond'",
                   [AT + 5 * DAY]);
    assert.deepEqual(await tierAt(AT), ["prime", AT + 5 * DAY], "Prime Time");
    assert.deepEqual(await tierAt(AT + 6 * DAY), ["free", null], "lapsed");
  } finally {
    await runQuery(`UPDATE premium_subs SET tier = 'prime_plus', paid_through = 0, stripe_through = 0, stripe_sub = NULL, comped = 1, comp_until = ?
                    WHERE target = 'patv:frogpond'`, [AT + 20 * DAY]);
  }
  assert.deepEqual(await tierAt(AT), ["plus", AT + 20 * DAY]);
});

test("roles: the builder produces every golden roles row (staffroles.globalRolesOf: the linked login's Pepe role)", async () => {
  const want = S1.rows.filter((r) => r.row.topic === "roles/changed");
  assert.equal(want.length, 4);
  const got = await HR.build(want.map((r) => r.row.entity));
  for (const r of want) assert.deepEqual(got.get(r.row.entity), r.row.payload, r.name);
  const SR = require(path.join(repo, "staffroles"));
  assert.deepEqual(await SR.globalRoleOf("1005"), { login: "erin", role: "staff", role_at: goldenRow("roles/changed", "acct:1005").row.payload.role_at, cls: "Staff" });
  assert.equal(await SR.globalRoleOf("1007"), null, "no users row");
  // the login key is SQLite's lower(trim()) - a padded, upper-case link still finds its role
  await runQuery("UPDATE users SET camfrogUsername = '  ERIN ' WHERE userId = '1005'");
  try { assert.equal((await SR.globalRoleOf("1005")).role, "staff"); }
  finally { await runQuery("UPDATE users SET camfrogUsername = 'erin' WHERE userId = '1005'"); }
});

test("bans: the builder produces every golden bans row (active, unban, expired, unknown room, a re-keyed OLD key)", async () => {
  const q = golden("bans: an active pad ban for a room the registry does not know is quarantined");
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, by, at, until) VALUES ('1005', 'PepeFrog.Old', 'erin', 'x', ?, NULL)", [q.row.payload.banned_at]);
  try {
    const want = S1.rows.filter((r) => r.row.topic === "bans/changed");
    assert.equal(want.length, 6);
    const got = await HB.build(want.map((r) => r.row.entity), AT);
    for (const r of want) assert.deepEqual(got.get(r.row.entity), r.row.payload, r.name);
  } finally { await runQuery("DELETE FROM feed_bans WHERE room_id = 'PepeFrog.Old'"); }
  // an expired row v1's sweep hasn't deleted yet already reads inactive
  const later = (await HB.build(["fb:1005/patv:frogpond"], AT + 8 * DAY)).get("fb:1005/patv:frogpond");
  assert.equal(later.active, false);
  assert.deepEqual(HB.parse("fb:1006/*"), { user: "1006", room: "" });
  assert.equal(HB.parse("fb:nope"), null);
});

test("switches: the builder produces the golden switches row; v1 never produces the value the hub quarantines", async () => {
  const on = golden("switches: CHAT_HUB turned on at /admin/chat");
  await chatHub(true);
  try {
    assert.deepEqual((await CS.build([on.row.entity])).get(on.row.entity), on.row.payload);
    assert.equal(CS.get("CHAT_HUB"), "on");
  } finally { await chatHub(false); }
  await assert.rejects(CS.set("CHAT_HUB", "maybe", null), (e) => e.code === "bad_value" && e.status === 400, "the quarantined value (golden 252)");
  await assert.rejects(CS.set("dm_backend", "hub", null), (e) => e.code === "bad_key", "S5's key isn't v1's yet");
  assert.equal((await CS.build(["sw:nope"])).size, 0, "a key v1 never had: no payload");
});

// ── triggers ──
const step = async (topic, label, sql, args, want) => {
  await clearOutbox();
  await runQuery(sql, args || []);
  assert.deepEqual(await entitiesOf(topic), want, label);
};

test("pads triggers: only with the switch on, only for the listed columns, OLD and NEW keys", async () => {
  await clearOutbox();
  await runQuery("UPDATE rooms_registry SET title = 'Frog Pond!' WHERE room_id = 'patv:frogpond'");
  assert.deepEqual(await entitiesOf("pads/changed"), [], "switch off: nothing");
  await HO.setSettings({ pads: true });
  const F = "pad:" + PAD.frogpond, S = "pad:" + PAD.staff;
  const T = "pads/changed";
  try {
    await step(T, "a title", "UPDATE rooms_registry SET title = 'Frog Pond' WHERE room_id = 'patv:frogpond'", [], [F]);
    await step(T, "the bridge's / stage's columns: never", "UPDATE rooms_registry SET updated = updated + 1, slot_count = 2, banner = 'https://x/b.png', takeover = 'off' WHERE room_id = 'patv:frogpond'", [], []);
    await step(T, "the same value: nothing", "UPDATE rooms_registry SET title = 'Frog Pond' WHERE room_id = 'patv:frogpond'", [], []);
    for (const [c, v] of [["slug", "'frog-pond-2'"], ["adult", "1"], ["listed", "0"], ["owner_user_id", "'1005'"], ["platform", "'camfrog'"]]) {
      await step(T, "rooms_registry." + c, `UPDATE rooms_registry SET ${c} = ${v} WHERE room_id = 'patv:frogpond'`, [], [F]);
    }
    await runQuery("UPDATE rooms_registry SET slug = 'frog-pond', adult = 0, listed = 1, owner_user_id = '1001', platform = 'site' WHERE room_id = 'patv:frogpond'");
    await step(T, "pad_access", "UPDATE pad_access SET level = 'members' WHERE room_id = 'patv:frogpond'", [], [F]);
    await step(T, "pad_access: updated only", "UPDATE pad_access SET updated = 5 WHERE room_id = 'patv:frogpond'", [], []);
    await runQuery("UPDATE pad_access SET level = 'public' WHERE room_id = 'patv:frogpond'");
    await step(T, "a Stripe renewal (stripe_through only)", "UPDATE premium_subs SET stripe_through = ? WHERE target = 'patv:frogpond'", [AT + 40 * DAY], [F]);
    await step(T, "a Season Pass: not a pad's", "INSERT INTO premium_subs (tier, target, paid_through, status, started, updated) VALUES ('season_pass', '1001', ?, 'active', ?, ?)",
               [AT + DAY, AT, AT], []);
    await step(T, "chat settings", "UPDATE pad_chat_cfg SET search = 0 WHERE room_id = 'patv:frogpond'", [], [F]);
    await step(T, "chat settings: who / when only", "UPDATE pad_chat_cfg SET updated = 9, by_user = 'x' WHERE room_id = 'patv:frogpond'", [], []);
    await step(T, "CL3's owner time", "UPDATE chatlog_rooms SET owner_grant = ? WHERE room_id = 'patv:frogpond'", [AT], [F]);
    await step(T, "the archive's counters: never", "UPDATE chatlog_rooms SET rows = rows + 1, bytes = bytes + 10, wm_chat = 5 WHERE room_id = 'patv:frogpond'", [], []);
    await step(T, "a user flair", "INSERT INTO pad_flairs (room_id, name, color, self_assign, sort, kind) VALUES ('patv:frogpond', 'Newt', '#4caf50', 0, 5, 'user')", [], [F]);
    await step(T, "a post flair: not the pad's flair definitions", "INSERT INTO pad_flairs (room_id, name, color, sort, kind) VALUES ('patv:frogpond', 'News', '#4caf50', 6, 'post')", [], []);
    await step(T, "a flair renamed", "UPDATE pad_flairs SET name = 'Newty' WHERE name = 'Newt'", [], [F]);
    await step(T, "a flair deleted", "DELETE FROM pad_flairs WHERE name = 'Newty'", [], [F]);
    await step(T, "cosmetics", "UPDATE pad_looks SET cosmetics = ? WHERE room_id = 'patv:frogpond'", [JSON.stringify({ pad_frame: "pp_frame" })], [F]);
    await step(T, "the pad's picture: not the pad's fx", "UPDATE pad_looks SET banner_y = 10 WHERE room_id = 'patv:frogpond'", [], []);
    await step(T, "chat_backend (padhub.setBackend)", "UPDATE pad_hub SET chat_backend = 'hub' WHERE room_id = 'patv:frogpond'", [], [F]);
    await step(T, "pad_hub: who / when only", "UPDATE pad_hub SET updated = 1, updated_by = 'x' WHERE room_id = 'patv:frogpond'", [], []);
    const pm = (u) => `pm:${PAD.staff}/${u}`;
    await step(T, "a member approved", "UPDATE pad_members SET status = 'approved' WHERE user_id = '1002'", [], [pm("1002")]);
    await step(T, "a member removed (row kept)", "UPDATE pad_members SET status = 'removed' WHERE user_id = '1002'", [], [pm("1002")]);
    await step(T, "a member's note: nothing", "UPDATE pad_members SET note = 'hi' WHERE user_id = '1002'", [], []);
    await step(T, "a member moved to another pad: OLD and NEW", "UPDATE pad_members SET room_id = 'patv:frogpond' WHERE user_id = '1002'", [],
               [`pm:${PAD.frogpond}/1002`, pm("1002")]);
    await step(T, "a member row deleted", "DELETE FROM pad_members WHERE user_id = '1002'", [], [`pm:${PAD.frogpond}/1002`]);
    await runQuery("INSERT INTO pad_members (room_id, user_id, status, requested_at) VALUES ('patv:staff', '1002', 'pending', ?)", [AT]);
    // a new pad: its pad_hub row (the insert trigger, or the backfill) posts it; a deleted one posts its old id (gone)
    await clearOutbox();
    await runQuery("INSERT INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated) VALUES ('patv:tmp', 'tmp', 'Tmp', 'none', 'site', 1, 1)");
    const tmp = await hubId("patv:tmp");
    assert.deepEqual([...new Set(await entitiesOf(T))], ["pad:" + tmp], "a new pad");
    await step(T, "a pad deleted (pad_hub_drop in the same statement)", "DELETE FROM rooms_registry WHERE room_id = 'patv:tmp'", [], ["pad:" + tmp]);
    assert.deepEqual((await HP.build(["pad:" + tmp], AT)).get("pad:" + tmp), { kind: "pad", pad_id: tmp, gone: true });
    // the backfill posts the pads that had no id
    await HO.setSettings({ pads: false });
    await runQuery("DROP TRIGGER pad_hub_mint");
    await runQuery("INSERT INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated) VALUES ('patv:tmp2', 'tmp2', 'Tmp2', 'none', 'site', 1, 1)");
    await HO.setSettings({ pads: true });
    await clearOutbox();
    assert.equal(await PH.backfill(), 1);
    assert.deepEqual(await entitiesOf(T), ["pad:" + (await hubId("patv:tmp2"))], "the backfill's insert");
    await runQuery("DELETE FROM rooms_registry WHERE room_id = 'patv:tmp2'");
    // switch off again: nothing more
    await HO.setSettings({ pads: false });
    await step(T, "off again", "UPDATE rooms_registry SET title = 'X' WHERE room_id = 'patv:frogpond'", [], []);
  } finally {
    await HO.setSettings({ pads: false });
    await PH.init().catch(() => {});
    // padhub.init is memoised: the insert trigger comes back the way padhub.js makes it
    await runQuery(`CREATE TRIGGER IF NOT EXISTS pad_hub_mint AFTER INSERT ON rooms_registry
      BEGIN INSERT OR IGNORE INTO pad_hub (room_id, hub_pad_id, updated) VALUES (NEW.room_id, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 0); END`);
    await runQuery("UPDATE rooms_registry SET title = 'Frog Pond' WHERE room_id = 'patv:frogpond'");
    await runQuery("UPDATE pad_hub SET chat_backend = 'v1' WHERE room_id = 'patv:frogpond'");
    await runQuery("UPDATE pad_chat_cfg SET search = NULL WHERE room_id = 'patv:frogpond'");
    await runQuery("UPDATE chatlog_rooms SET owner_grant = NULL WHERE room_id = 'patv:frogpond'");
    await runQuery("UPDATE premium_subs SET stripe_through = 0 WHERE target = 'patv:frogpond'");
    await runQuery("DELETE FROM premium_subs WHERE tier = 'season_pass'");
    await runQuery("DELETE FROM pad_flairs WHERE kind = 'post'");
    await require(path.join(repo, "padlook")).setCosmetics("patv:frogpond", { pad_frame: "pp_frame", pad_glow: "pg_gold", pad_badge: ["pp_headliner", "pb_est2026"] }, "alice");
    await clearOutbox();
  }
});

test("roles triggers: pepe_roles by login (every linked account), users' login / class, never points or xp", async () => {
  await clearOutbox();
  await runQuery("UPDATE pepe_roles SET role = 'assistant' WHERE login = 'alice'");
  assert.deepEqual(await entitiesOf("roles/changed"), [], "switch off: nothing");
  await runQuery("UPDATE pepe_roles SET role = 'trusted' WHERE login = 'alice'");
  await HO.setSettings({ roles: true });
  const T = "roles/changed";
  try {
    await step(T, "a role changed", "UPDATE pepe_roles SET role = 'assistant' WHERE login = 'alice'", [], ["acct:1001"]);
    await step(T, "the same role, a newer ts (Pepe's sync): nothing", "UPDATE pepe_roles SET ts = ts + 1 WHERE login = 'alice'", [], []);
    await step(T, "a role removed (tombstone)", "UPDATE pepe_roles SET role = NULL WHERE login = 'alice'", [], ["acct:1001"]);
    await step(T, "a new login's role, nobody linked to it yet", "INSERT INTO pepe_roles (login, role, ts) VALUES ('gina', 'staff', 1)", [], []);
    await addUser("1009", { username: "gina1", camfrog: " GINA " });
    await step(T, "...the account linked to it (SQLite's lower(trim()))", "UPDATE pepe_roles SET role = 'admin' WHERE login = 'gina'", [], ["acct:1009"]);
    await step(T, "a pepe_roles row deleted", "DELETE FROM pepe_roles WHERE login = 'gina'", [], ["acct:1009"]);
    await step(T, "a login renamed: OLD and NEW", "UPDATE pepe_roles SET login = 'erin2' WHERE login = 'erin'", [], ["acct:1005"]);
    await runQuery("UPDATE pepe_roles SET login = 'erin' WHERE login = 'erin2'");
    await step(T, "a linked login changed", "UPDATE users SET camfrogUsername = 'frank2' WHERE userId = '1006'", [], ["acct:1006"]);
    await step(T, "the class", "UPDATE users SET class = 'Assistant' WHERE userId = '1006'", [], ["acct:1006"]);
    await step(T, "points, xp, level: never", "UPDATE users SET points_balance = points_balance + 5, xp = xp + 3, level = 9 WHERE userId = '1006'", [], []);
    await step(T, "a sign-up with a linked login", "INSERT INTO users (userId, username, password, class, camfrogUsername) VALUES ('1011', 'hal', 'x', 'pleb', 'hal')", [], ["acct:1011"]);
    await step(T, "a sign-up without one: nothing", "INSERT INTO users (userId, username, password, class) VALUES ('1012', 'ivy', 'x', 'pleb')", [], []);
    await step(T, "an account with a login deleted", "DELETE FROM users WHERE userId = '1011'", [], ["acct:1011"]);
    await step(T, "...without one: nothing", "DELETE FROM users WHERE userId = '1012'", [], []);
    // the login lookup is accountMerge.js's partial unique index, never a scan of users (the trigger's own terms)
    const plan = (await getQuery(`EXPLAIN QUERY PLAN SELECT u.userId FROM users u WHERE lower(trim(u.camfrogUsername)) = ?
                                  AND u.camfrogUsername IS NOT NULL AND trim(u.camfrogUsername) != ''`, ["erin"])).map((r) => r.detail).join(" | ");
    assert.match(plan, /USING INDEX users_camfrog_login/, plan);
    await HO.setSettings({ roles: false });
    await step(T, "off again", "UPDATE users SET class = 'pleb' WHERE userId = '1006'", [], []);
  } finally {
    await HO.setSettings({ roles: false });
    await runQuery("UPDATE pepe_roles SET role = 'trusted', ts = ? WHERE login = 'alice'", [goldenRow("roles/changed", "acct:1001").row.payload.role_at]);
    await runQuery("UPDATE users SET camfrogUsername = 'frank', class = 'pleb' WHERE userId = '1006'");
    await runQuery("DELETE FROM users WHERE userId IN ('1009', '1011', '1012')");
    await clearOutbox();
  }
});

test("bans triggers: a ban, a re-ban (INSERT OR REPLACE), its end, a merge's move (OLD and NEW), an unban, the sweep", async () => {
  await clearOutbox();
  await runQuery("UPDATE feed_bans SET until = 1 WHERE user_id = '1006'");
  assert.deepEqual(await entitiesOf("bans/changed"), [], "switch off: nothing");
  await runQuery("UPDATE feed_bans SET until = NULL WHERE user_id = '1006'");
  await HO.setSettings({ bans: true });
  const T = "bans/changed";
  try {
    await step(T, "a site-wide ban", "INSERT INTO feed_bans (user_id, room_id, username, at, until) VALUES ('1001', '', 'alice', 1, NULL)", [], ["fb:1001/*"]);
    await step(T, "a re-ban (INSERT OR REPLACE)", "INSERT OR REPLACE INTO feed_bans (user_id, room_id, username, at, until) VALUES ('1001', '', 'alice', 2, 99)", [], ["fb:1001/*"]);
    await step(T, "the reason only: nothing", "UPDATE feed_bans SET reason = 'x', by = 'y' WHERE user_id = '1001'", [], []);
    await step(T, "its end moved", "UPDATE feed_bans SET until = NULL WHERE user_id = '1001'", [], ["fb:1001/*"]);
    await step(T, "a merge moves the ban: OLD and NEW", "UPDATE feed_bans SET user_id = '1002' WHERE user_id = '1001'", [], ["fb:1002/*", "fb:1001/*"]);
    await step(T, "an unban", "DELETE FROM feed_bans WHERE user_id = '1002'", [], ["fb:1002/*"]);
    await step(T, "a pad ban's room re-keyed: OLD and NEW", "UPDATE feed_bans SET room_id = 'patv:pond-old' WHERE user_id = '1005'", [],
               ["fb:1005/patv:pond-old", "fb:1005/patv:frogpond"]);
    await runQuery("UPDATE feed_bans SET room_id = 'patv:frogpond' WHERE user_id = '1005'");
    await runQuery("INSERT INTO feed_bans (user_id, room_id, username, at, until) VALUES ('1001', 'patv:frogpond', 'alice', 1, ?)", [AT - DAY]);
    await step(T, "v1's sweep deletes the expired rows (feedstore.sweep's statement)", "DELETE FROM feed_bans WHERE until IS NOT NULL AND until < ?", [AT],
               ["fb:1001/patv:frogpond"]);
    assert.deepEqual((await HB.build(["fb:1001/patv:frogpond"], AT)).get("fb:1001/patv:frogpond"), goldenRow(T, "fb:1001/patv:frogpond").row.payload, "golden 225");
    await HO.setSettings({ bans: false });
    await step(T, "off again", "UPDATE feed_bans SET until = 5 WHERE user_id = '1006'", [], []);
  } finally {
    await HO.setSettings({ bans: false });
    await runQuery("UPDATE feed_bans SET until = NULL WHERE user_id = '1006'");
    await clearOutbox();
  }
});

test("switches triggers: CHAT_HUB's value, gated by the `switches` switch", async () => {
  await clearOutbox();
  const T = "switches/changed";
  await step(T, "switch off: nothing", "UPDATE chat_switches SET value = 'on' WHERE key = 'CHAT_HUB'", [], []);
  await runQuery("UPDATE chat_switches SET value = 'off' WHERE key = 'CHAT_HUB'");
  await HO.setSettings({ switches: true });
  try {
    await step(T, "the value", "UPDATE chat_switches SET value = 'on' WHERE key = 'CHAT_HUB'", [], ["sw:CHAT_HUB"]);
    await step(T, "who / when only: nothing", "UPDATE chat_switches SET updated = 1, updated_by = 'x' WHERE key = 'CHAT_HUB'", [], []);
    await step(T, "a row deleted (a staging refresh's KEEP): the default", "DELETE FROM chat_switches WHERE key = 'CHAT_HUB'", [], ["sw:CHAT_HUB"]);
    assert.deepEqual((await CS.build(["sw:CHAT_HUB"])).get("sw:CHAT_HUB"), { key: "CHAT_HUB", value: "off", updated_at: null });
    await step(T, "...and back", "INSERT INTO chat_switches (key, value, updated, updated_by) VALUES ('CHAT_HUB', 'off', ?, 'owner')", [AT], ["sw:CHAT_HUB"]);
  } finally {
    await chatHub(false);
    await HO.setSettings({ switches: false });
    await clearOutbox();
  }
});

// ── snapshots ──
test("snapshots: the four golden pages; null (404) while the switch is off; byte-order paging across pad: and pm:", async () => {
  await clearOutbox();
  for (const t of L1_TOPICS) assert.equal(await HO.snapshot(t, null), null, t + " off");
  await HO.setSettings({ pads: true, roles: true, bans: true, switches: true });
  await chatHub(true);
  try {
    for (const topic of L1_TOPICS) {
      const page = await HO.snapshot(topic, null);
      const g = S1.snapshots[topic];
      assert.equal(page.topic, topic);
      assert.equal(page.complete, true, topic);
      assert.deepEqual(page.range, { after: null, through: null });
      assert.deepEqual(page.rows, g.rows, topic + ": exactly the golden page's rows");
      assert.equal(page.head, await HO.headId());
    }
    // pads in pages of 2: the cursor crosses from the pad: range into the pm: range
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 10; i++) {
      const p = await HO.snapshot("pads/changed", cursor, { limit: 2 });
      seen.push(...p.rows.map((r) => r.entity));
      if (p.complete) break;
      assert.equal(p.range.through, p.rows[p.rows.length - 1].entity);
      cursor = p.next;
    }
    assert.deepEqual(seen, S1.snapshots["pads/changed"].rows.map((r) => r.entity));
    // an expired ban isn't listed (its row may still be there until v1's sweep); a removed role isn't either
    await runQuery("UPDATE feed_bans SET until = ? WHERE user_id = '1005'", [AT - 1]);
    assert.deepEqual((await HO.snapshot("bans/changed", null)).rows.map((r) => r.entity), ["fb:1006/*"]);
    await runQuery("UPDATE feed_bans SET until = ? WHERE user_id = '1005'", [AT + 7 * DAY]);
    // a bans cursor in byte order of the whole entity (not (user_id, room_id)'s: "fb:a/x" > "fb:a-b/y")
    await runQuery("INSERT INTO feed_bans (user_id, room_id, username, at) VALUES ('a', 'x', 'a', 1), ('a-b', 'y', 'ab', 1)");
    const order = [];
    cursor = null;
    for (let i = 0; i < 10; i++) {
      const p = await HO.snapshot("bans/changed", cursor, { limit: 1 });
      order.push(...p.rows.map((r) => r.entity));
      if (p.complete) break;
      cursor = p.next;
    }
    const byte = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
    assert.deepEqual(order, [...order].sort(byte));
    assert.deepEqual(order, ["fb:1005/patv:frogpond", "fb:1006/*", "fb:a-b/y", "fb:a/x"]);
    await runQuery("DELETE FROM feed_bans WHERE user_id IN ('a', 'a-b')");
    // the staff pad is listed in the snapshot even though it's unlisted on the site (the hub mirrors every pad)
    assert.ok((await HO.snapshot("pads/changed", null)).rows.some((r) => r.entity === "pad:" + PAD.staff && r.payload.listed === false));
  } finally {
    await chatHub(false);
    await HO.setSettings({ pads: false, roles: false, bans: false, switches: false });
    await clearOutbox();
  }
});

// ── the poster ──
test("the poster: a batch of pads / roles / bans / switches trigger rows is read in one build per topic and posts the golden payloads", async () => {
  const got = [];
  const hub = http.createServer((req, res) => {
    const b = [];
    req.on("data", (c) => b.push(c));
    req.on("end", () => { got.push({ url: req.url, body: JSON.parse(Buffer.concat(b).toString("utf8")) }); res.writeHead(200); res.end("{}"); });
  });
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  process.env.HUB_V1_URL = `http://127.0.0.1:${hub.address().port}`;
  process.env.HUB_V1_KEY_ID = "v1-test-1";
  process.env.HUB_V1_KEY = "v1-test-key-0123456789abcdef-not-real";
  const builds = { pads: 0, roles: 0, bans: 0 };
  const real = { pads: HP.build, roles: HR.build, bans: HB.build };
  HP.build = (...a) => { builds.pads++; return real.pads(...a); };
  HR.build = (...a) => { builds.roles++; return real.roles(...a); };
  HB.build = (...a) => { builds.bans++; return real.bans(...a); };
  try {
    await HO.setSettings({ pads: true, roles: true, bans: true, switches: true });
    await chatHub(true);
    await clearOutbox();
    HO._resetPoster();
    await runQuery("UPDATE rooms_registry SET title = 'x' WHERE room_id = 'patv:frogpond'");
    await runQuery("UPDATE rooms_registry SET title = 'Frog Pond' WHERE room_id = 'patv:frogpond'");
    await runQuery("UPDATE pad_access SET level = 'approved' WHERE room_id = 'patv:staff'");                // the same value: no row
    await runQuery("UPDATE pad_hub SET chat_backend = 'v1' WHERE room_id = 'patv:lounge'");
    await runQuery("UPDATE pad_hub SET chat_backend = 'hub' WHERE room_id = 'patv:lounge'");
    await runQuery("UPDATE pad_members SET status = 'denied' WHERE user_id = '1005'");
    await runQuery("UPDATE pad_members SET status = 'approved' WHERE user_id = '1005'");
    await runQuery("UPDATE users SET class = 'pleb' WHERE userId = '1005'");
    await runQuery("UPDATE users SET class = 'Staff' WHERE userId = '1005'");
    await runQuery("UPDATE feed_bans SET until = NULL WHERE user_id = '1005'");
    await runQuery("UPDATE feed_bans SET until = ? WHERE user_id = '1005'", [AT + 7 * DAY]);
    await runQuery("UPDATE chat_switches SET value = 'off' WHERE key = 'CHAT_HUB'");
    await runQuery("UPDATE chat_switches SET value = 'on', updated = ? WHERE key = 'CHAT_HUB'", [AT]);
    builds.pads = builds.roles = builds.bans = 0;
    const r = await HO.pumpOnce();
    assert.equal(r.posted, 12);
    assert.deepEqual(builds, { pads: 1, roles: 1, bans: 1 }, "one build per topic batch");
    const sent = (t) => got.find((x) => x.url === "/internal/v1/" + t).body.rows;
    assert.deepEqual(sent("pads/changed").map((x) => x.entity), ["pad:" + PAD.frogpond, "pad:" + PAD.frogpond, "pad:" + PAD.lounge, "pad:" + PAD.lounge,
                                                                  `pm:${PAD.staff}/1005`, `pm:${PAD.staff}/1005`]);
    for (const t of L1_TOPICS) {
      for (const row of sent(t)) {
        assert.deepEqual(row.payload, goldenRow(t, row.entity).row.payload, row.entity);
        assert.equal(typeof row.created_at, "number", "every row carries the envelope's created_at (S1-D5)");
      }
    }
    assert.deepEqual((await getQuery("SELECT COUNT(*) AS n FROM hub_outbox WHERE posted_at IS NULL"))[0].n, 0, "all posted");
  } finally {
    Object.assign(HP, { build: real.pads }); Object.assign(HR, { build: real.roles }); Object.assign(HB, { build: real.bans });
    await chatHub(false);
    await HO.setSettings({ pads: false, roles: false, bans: false, switches: false });
    delete process.env.HUB_V1_URL; delete process.env.HUB_V1_KEY_ID; delete process.env.HUB_V1_KEY;
    hub.close();
    await clearOutbox();
  }
});

// ── the heartbeat, the interlock, chat_backend ──
test("the heartbeat carries the four switches and their topics (additive); the golden S1 heartbeat names them", async () => {
  await HO.setSettings({ pads: true, switches: true });
  try {
    const b = await HO.heartbeatBody();
    assert.equal(b.switches.pads, true);
    assert.equal(b.switches.roles, false);
    assert.equal(b.switches.switches, true);
    assert.deepEqual(b.topics["pads/changed"], { head: 0, pending: 0, oldest_pending_at: null });
    assert.ok(!("roles/changed" in b.topics), "a topic whose switch is off and that has no rows isn't listed");
    for (const k of ["pads", "roles", "bans", "switches"]) assert.ok(k in S1.heartbeat.switches, k);
    for (const t of L1_TOPICS) assert.ok(t in S1.heartbeat.topics, t);
    assert.equal(b.version, HO.VERSION);
  } finally { await HO.setSettings({ pads: false, switches: false }); }
});

const ALL12 = Object.fromEntries(["tickets", "sessions", "heartbeat", "privacy", "erasure", "export", "pads", "roles", "bans", "identity", "looks", "switches"].map((k) => [k, true]));
test("the interlock (S1-D7): CHAT_HUB on needs the twelve switches; none goes off under it; off is never refused", async () => {
  assert.deepEqual([...CS.INTERLOCK].sort(), Object.keys(ALL12).sort());
  const admin = { userId: "1005", username: "erin" };
  await CS.set("CHAT_HUB", "off", admin);
  assert.equal(CS.get("CHAT_HUB"), "off");
  await assert.rejects(CS.set("CHAT_HUB", "on", admin), (e) => e.status === 409 && e.code === "chat_hub_needs" && e.needs.length === 12);
  await HO.setSettings({ ...ALL12, looks: false });
  await assert.rejects(CS.set("CHAT_HUB", "on", admin), (e) => e.code === "chat_hub_needs" && e.needs.join() === "looks", "one missing");
  await HO.setSettings({ looks: true });
  await clearOutbox();
  try {
    const r = await CS.set("CHAT_HUB", "on", admin, { reason: "pilot" });
    assert.deepEqual([r.key, r.value, r.changed], ["CHAT_HUB", "on", true]);
    assert.equal(CS.chatHubOn(), true);
    assert.deepEqual(await entitiesOf("switches/changed"), ["sw:CHAT_HUB"], "it posts (switches on)");
    const audit = await require(path.join(repo, "adminaudit")).recent("chat.switch", 5);
    assert.deepEqual([audit[0].detail, audit[0].reason], [{ key: "CHAT_HUB", from: "off", to: "on" }, "pilot"], "the admin_audit row");
    assert.deepEqual((await CS.set("CHAT_HUB", "on", admin)).changed, false, "on again: no change, no audit row");
    // none of the twelve goes off under it; others (econ, spans) may
    for (const k of Object.keys(ALL12)) {
      // (sessions and heartbeat: tickets need them too - whichever refusal comes first, nothing changes)
      const codes = k === "sessions" || k === "heartbeat" ? ["chat_hub_on", "tickets_need"] : ["chat_hub_on"];
      await assert.rejects(HO.setSettings({ [k]: false }, admin), (e) => e.status === 409 && codes.includes(e.code), k);
    }
    await assert.rejects(HO.setSettings({ tickets: false, sessions: false }, admin), (e) => e.code === "chat_hub_on", "tickets, sessions together: the interlock");
    assert.equal(HO.settings().pads, true, "nothing was changed");
    assert.equal((await HO.setSettings({ econ: false })).econ, false);
    assert.equal((await HO.setSettings({ ...ALL12 })).pads, true, "a save that keeps them all on is fine (the admin page posts every box)");
    const st = await HO.status();
    assert.deepEqual([st.l1.chat.CHAT_HUB.value, st.l1.needs], ["on", []]);
    // off: never refused, any value of the others
    assert.equal((await CS.set("CHAT_HUB", "off", admin)).value, "off");
    assert.equal((await HO.setSettings({ pads: false })).pads, false);
  } finally {
    await CS.set("CHAT_HUB", "off", null);
    await HO.setSettings(Object.fromEntries(Object.keys(ALL12).map((k) => [k, false])));
    await chatHub(false);
    await clearOutbox();
  }
});

test("chat_backend's writer (padhub.setBackend): hub on site pads only, hub_read is S2's, a profile never; an audit event", async () => {
  await assert.rejects(PH.setBackend("patv:frogpond", "hub_read"), (e) => e.code === "hub_read_s2" && e.status === 409);
  await assert.rejects(PH.setBackend("patv:frogpond", "nope"), (e) => e.code === "bad_backend" && e.status === 400);
  await assert.rejects(PH.setBackend("patv:none", "hub"), (e) => e.code === "no_pad" && e.status === 404);
  await runQuery("INSERT INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated) VALUES ('Cam.Room', 'cam-room', 'Cam', 'none', 'camfrog', 1, 1)");
  try {
    await assert.rejects(PH.setBackend("Cam.Room", "hub"), (e) => e.code === "site_pads_only", "a Camfrog pad's chat is its room's");
    assert.equal((await PH.setBackend("Cam.Room", "v1")).changed, false, "v1 is fine anywhere");
  } finally { await runQuery("DELETE FROM rooms_registry WHERE room_id = 'Cam.Room'"); }
  const r = await PH.setBackend("patv:frogpond", "hub", { username: "owner" });
  assert.deepEqual([r.chat_backend, r.changed, r.hub_pad_id], ["hub", true, PAD.frogpond]);
  assert.equal(await PH.backendOf("patv:frogpond"), "hub");
  const ev = (await getQuery("SELECT what, actor, detail FROM room_events WHERE room_id = 'patv:frogpond' AND what = 'chat-backend' ORDER BY ts DESC LIMIT 1"))[0];
  assert.deepEqual(ev, { what: "chat-backend", actor: "owner", detail: "v1 -> hub" });
  assert.equal((await getQuery("SELECT updated_by FROM pad_hub WHERE room_id = 'patv:frogpond'"))[0].updated_by, "owner");
  await PH.setBackend("patv:frogpond", "v1", { username: "owner" });
  assert.equal(await PH.backendOf("patv:nope"), "v1");
});

// ── re-keys ──
test("re-keys: the displaced pad's row is emitted in the re-key's transaction; the moved pad's members and pad bans follow it", async () => {
  await HO.setSettings({ pads: true, bans: true });
  try {
    await runQuery("INSERT INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated) VALUES ('patv:mover', 'mover', 'Mover', 'none', 'site', 1, 1)");
    await runQuery("INSERT INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated) VALUES ('Room.X', 'room-x', 'Room X', 'none', 'camfrog', 1, 1)");
    const mine = await hubId("patv:mover"), theirs = await hubId("Room.X");
    await runQuery("INSERT INTO pad_members (room_id, user_id, status) VALUES ('Room.X', '1006', 'approved')");          // the room pad's member (stays)
    await runQuery("INSERT INTO feed_bans (user_id, room_id, username, at) VALUES ('1001', 'Room.X', 'alice', 1)");      // the room pad's ban (stays)
    await clearOutbox();
    // a caller that re-keys onto a room whose pad still has its pad_hub row (padconnect deletes the registry row first; a
    // generic caller may not): the moving pad's id wins, and the hub hears of the displaced one at once
    await tx(async () => { await RK.rekey("patv:mover", "Room.X"); });
    assert.equal(await hubId("Room.X"), mine, "the moving pad keeps its id");
    const pads = await entitiesOf("pads/changed");
    assert.ok(pads.includes("pad:" + theirs), "the displaced pad: " + JSON.stringify(pads));
    assert.ok(pads.includes("pad:" + mine), "the moved pad");
    assert.ok(pads.includes(`pm:${mine}/1006`), "the member left at the room id belongs to the moved pad now");
    assert.ok((await entitiesOf("bans/changed")).includes("fb:1001/Room.X"), "...and so does the pad ban");
    assert.deepEqual((await HP.build(["pad:" + theirs], AT)).get("pad:" + theirs), { kind: "pad", pad_id: theirs, gone: true });
    // rolled back with its transaction
    await clearOutbox();
    await runQuery("INSERT INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated) VALUES ('patv:m2', 'm2', 'M2', 'none', 'site', 1, 1)");
    await runQuery("INSERT INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated) VALUES ('Room.Y', 'room-y', 'Room Y', 'none', 'camfrog', 1, 1)");
    await clearOutbox();
    await assert.rejects(tx(async () => { await RK.rekey("patv:m2", "Room.Y"); throw new Error("a later step failed"); }));
    assert.deepEqual(await entitiesOf("pads/changed"), [], "nothing left behind");
    assert.ok(await hubId("Room.Y"), "the room pad's id is back");
  } finally {
    await HO.setSettings({ pads: false, bans: false });
    for (const id of ["Room.X", "patv:mover", "patv:m2", "Room.Y"]) await runQuery("DELETE FROM rooms_registry WHERE room_id = ?", [id]);
    await runQuery("DELETE FROM pad_members WHERE room_id IN ('Room.X', 'Room.Y')");
    await runQuery("DELETE FROM feed_bans WHERE room_id IN ('Room.X', 'Room.Y')");
    await clearOutbox();
  }
});

test("status: release L1's setup, the chat switches and what CHAT_HUB still needs (for /admin/keys#seam)", async () => {
  const st = await HO.status();
  assert.equal(st.l1.ready, true);
  assert.equal(st.l1.error, null);
  assert.equal(st.l1.chat.CHAT_HUB.default, "off");
  assert.deepEqual(st.l1.needs, CS.INTERLOCK.slice(), "every switch is off here");
  assert.deepEqual(HO.L1_SWITCHES, ["pads", "roles", "bans", "switches"]);
  for (const t of L1_TOPICS) assert.ok(HO.SNAPSHOT_TOPICS.includes(t) && HO.TOPICS[t], t);
});
