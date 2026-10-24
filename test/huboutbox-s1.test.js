// 1.99ads (S1 Q5b, release L3) - the v1 seam's identity/changed and looks/changed topics, the looks call and text style
// (seam plan §12.2-§12.7, §12.10, §12.12 "Q4 / Q5b (v1)"; ADR 0007 D11, D13). Against the golden rows' `s1` section
// (test/fixtures/hubseam-golden-rows.json, byte-identical in the hub repo):
//   * every identity and looks builder produces its golden row's payload for its input, with the database seeded as the
//     golden rows' inputs say; v1 never produces the rows the hub must quarantine (a malformed link, a non-hex colour);
//   * each trigger writes only with its switch on and only for its listed columns (never points / xp), OLD and NEW keys;
//   * the identity and looks snapshot pages are the golden pages (the looks page lists non-default looks only: the default
//     rule recomputed), 404 (null) while the switch is off, paged in byte order;
//   * the hub's POST /internal/v1/looks answers the golden call (signed, through hubinbound), 404 while looks is off, 400 /
//     413, card false leaves profile and gtf out with the same h;
//   * the poster reads a batch of trigger rows in one build and posts the golden payloads;
//   * the heartbeat carries the S1 switches; the W1 palette copy is the pinned one; text_style takes palette colours only;
//     padflair's hub definitions are the golden pad's flairs.
//   node --test test/huboutbox-s1.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "huboutbox-s1-test-"));
process.chdir(dir);
delete process.env.STAGING;
delete process.env.HUB_V1_URL; delete process.env.HUB_V1_PROXY;
delete process.env.CHAT_GENESIS_NS;
delete process.env.PUBLIC_BASE_URL; delete process.env.SITE_URL;
process.env.HUB_V1_ENV = "test";
process.env.SECRET_KEY = "test-secret";
const repo = path.resolve(__dirname, "..");
const G = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "hubseam-golden-rows.json"), "utf8"));
const V = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "hubseam-sign-vectors.json"), "utf8"));
const S1 = G.s1;
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

// rt-schema registry/text-styles.json at the S1 wire (W1): update together with the platform's copy
const TEXT_STYLES_PIN = "d19457013a816a33b554e9ef3f68c93d8b8062e23d309456cd677dc96f59b511";

const built = (async () => {                        // the real schema: a staging dump + every CREATE in the source
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  for (const c of ["meta TEXT", "queued INTEGER DEFAULT 0"]) await run(`ALTER TABLE reserve_claims ADD COLUMN ${c}`).catch(() => {});
  await new Promise((r) => db.close(r));
})();

const AT = 1760727590000, DAY = 86400000;
const ACCT = { 1001: "0192a5b4-1111-7c2d-8e3f-4a5b6c7d8e9f", 1002: "0192a5b4-2222-7c2d-8e3f-4a5b6c7d8e9f", 1004: "0192a5b4-4444-7c2d-8e3f-4a5b6c7d8e9f",
               1005: "0192a5b4-5555-7c2d-8e3f-4a5b6c7d8e9f", 1006: "0192a5b4-6666-7c2d-8e3f-4a5b6c7d8e9f", 1007: "0192a5b4-7777-7c2d-8e3f-4a5b6c7d8e9f",
               1008: "0192a5b4-8888-7c2d-8e3f-4a5b6c7d8e9f", 1009: "0192a5b4-9999-7c2d-8e3f-4a5b6c7d8e9f", 1010: "0192a5b4-aaaa-7c2d-8e3f-4a5b6c7d8e9f",
               1011: "0192a5b4-bbbb-7c2d-8e3f-4a5b6c7d8e9f", 1012: "0192a5b4-cccc-7c2d-8e3f-4a5b6c7d8e9f" };
const FROGPOND = "5c0b2a19-9f6d-4b40-8a1c-2d3e4f5a6b7c";
const golden = (name) => { const r = S1.rows.find((x) => x.name === name); assert.ok(r, "golden row " + name); return r; };
const goldenRow = (topic, entity) => { const r = S1.rows.find((x) => x.row.topic === topic && x.row.entity === entity); assert.ok(r, entity); return r; };
const sqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

let runQuery, getQuery, HO, HI, HL, UL, TS, PF, IN, hubsign;
const outbox = (topic) => getQuery("SELECT entity, payload FROM hub_outbox WHERE topic = ? ORDER BY id", [topic]);
const clearOutbox = () => runQuery("DELETE FROM hub_outbox");

async function addUser(id, f) {
  const cols = { userId: id, username: f.username, displayname: f.displayname || null, password: "x", avatar: f.avatar || "avatar.png",
                 camfrogUsername: f.camfrog || null, discordId: f.discordId || null, discordUsername: f.discordUsername || null,
                 twitchId: f.twitchId || null, twitchLogin: f.twitchLogin || null, twitchDisplayname: f.twitchDisplayname || null,
                 isEmailVerified: f.emailVerified ? 1 : 0, email: f.email || null, level: f.level == null ? 0 : f.level,
                 created_at: f.created == null ? null : sqlTime(f.created), archived_at: f.archived == null ? null : f.archived,
                 text_style: f.textStyle ? JSON.stringify(f.textStyle) : null };
  const k = Object.keys(cols);
  await runQuery(`INSERT INTO users (${k.map((c) => `"${c}"`).join(", ")}) VALUES (${k.map(() => "?").join(", ")})`, k.map((c) => cols[c]));
}
async function equip(userId, itemId) {
  const C = require(path.join(repo, "cosmetics"));
  const it = C.byId(itemId);
  const r = await runQuery("INSERT INTO user_cosmetics (user_id, item_id, source, acquired, idem, locked) VALUES (?, ?, 'test', ?, ?, 0)",
                           [userId, itemId, AT, `t-${userId}-${itemId}`]);
  await runQuery("INSERT OR REPLACE INTO user_cosmetic_equips (user_id, kind, inv_id) VALUES (?, ?, ?)", [userId, it.kind, r.id]);
  return r.id;
}

/** The golden rows' v1 state (their `input`s): what v1 holds once every golden row has happened. */
async function seedGolden() {
  const A = golden("looks: a rich look (cosmetics, text style, a pad flair, Supporter, a Plus pad)").input;
  await addUser("1001", { username: "alice", displayname: "Alice", avatar: "/uploads/avatars/1001.webp", camfrog: "Alice",
                          discordId: "200000000000000001", discordUsername: "alice_d", emailVerified: true, email: "alice@example.com", level: 12,
                          created: AT - 400 * DAY, textStyle: A.text_style });
  await addUser("1002", { username: "bob", displayname: "Bob", level: 3, created: AT - 90 * DAY });           // his login moved to 1005, Discord unlinked
  await addUser("1004", { username: "deleted-7f3c1a2b", displayname: "Deleted user", avatar: "/public/img/avatar.png", archived: AT + 100,
                          created: AT - 200 * DAY });                                                       // a done deletion's pseudonymous row
  await runQuery(`INSERT INTO account_deletions (user_id, state, requested_at, execute_at, done_at, pseudonym) VALUES ('1004', 'done', ?, ?, ?, 'deleted-7f3c1a2b')`,
                 [AT - 31 * DAY, AT, AT + 100]);
  await addUser("1005", { username: "erin", displayname: "Erin", camfrog: "Bob", level: 5, created: AT - 30 * DAY, email: "erin@example.com" });
  await addUser("1008", { username: "hank", displayname: "Hank", camfrog: "ivan", twitchId: "300000000000000008", twitchLogin: "hanktv",
                          twitchDisplayname: "HankTV", emailVerified: true, email: "hank@example.com", level: 20, created: AT - 700 * DAY });
  await runQuery("INSERT INTO account_merges (old_id, new_id, merged_at, via) VALUES ('1009', '1008', ?, 'test')", [AT + 200]);   // ivan's row is gone
  await addUser("1011", { username: "kate", displayname: "Kate", emailVerified: true, email: "kate@example.com", level: 2, created: AT - 900 * DAY,
                          archived: AT - 5 * DAY });
  await addUser("1012", { username: "leo", displayname: "Leo", level: 4, created: AT - 15 * DAY });
  await runQuery("INSERT INTO account_deletions (user_id, state, requested_at, execute_at) VALUES ('1012', 'scheduled', ?, ?)", [AT - 2 * DAY, AT + 28 * DAY]);
  // alice's look: her cosmetics, a flair in her Plus pad (Frog Pond), a $100 donation (Supporter gold)
  for (const it of Object.values(A.equips)) await equip("1001", it);
  await runQuery(`INSERT INTO rooms_registry (room_id, slug, title, owner_kind, owner_user_id, platform, created, updated)
                  VALUES ('patv:frogpond', 'frog-pond', 'Frog Pond', 'user', '1001', 'site', ?, ?)`, [AT - 40 * DAY, AT]);
  await runQuery("UPDATE pad_hub SET hub_pad_id = ? WHERE room_id = 'patv:frogpond'", [FROGPOND]);
  await runQuery(`INSERT INTO premium_subs (tier, target, paid_through, status, started, updated) VALUES ('prime_plus', 'patv:frogpond', ?, 'active', ?, ?)`,
                 [AT + 20 * DAY, AT - 40 * DAY, AT]);
  await runQuery(`INSERT INTO pad_flairs (id, room_id, name, color, emoji, self_assign, sort, kind) VALUES (17, 'patv:frogpond', 'Tadpole', '#4caf50', '🐸', 1, 0, 'user'),
                  (18, 'patv:frogpond', 'Lily', '#e91e63', NULL, 0, 1, 'user')`);
  await runQuery("INSERT INTO pad_user_flairs (room_id, user_id, flair_id, set_by, self, set_at) VALUES ('patv:frogpond', '1001', ?, 'alice', 1, ?)",
                 [A.pad_flair.flair_id, AT]);
  await runQuery(`INSERT INTO reserve_claims (claimId, flow, userId, type, amount, meta) VALUES ('don-1', 'mint:donation', '1001', 'mint', 1000000, '{"usd_cents":10000}')`);
  await require(path.join(repo, "premium")).loadCache();
}

test.before(async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  HO = require(path.join(repo, "huboutbox"));
  HI = require(path.join(repo, "hubidentity"));
  HL = require(path.join(repo, "hublooks"));
  UL = require(path.join(repo, "userlook"));
  TS = require(path.join(repo, "textstyle"));
  PF = require(path.join(repo, "padflair"));
  IN = require(path.join(repo, "hubinbound"));
  hubsign = require(path.join(repo, "hubsign"));
  HO._setAccountOf((id) => ACCT[id] || null);
  HO._setClock(() => AT);
  await HO.init();
  assert.equal(HO.status && (await HO.status()).s1.ready, true, "the S1 topics are set up");
  await seedGolden();
});
test.after(() => { HO.stop(); });

test("the fixtures: the golden rows carry the S1 section; chat-text-styles.json is rt-schema's palette (pinned)", () => {
  assert.ok(Array.isArray(S1.rows) && S1.rows.length > 30, "s1.rows");
  for (const k of ["snapshots", "absent", "ranged", "refs", "heartbeat", "calls", "h_rule", "default_look_rule"]) assert.ok(k in S1, k);
  const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, "chat-text-styles.json"))).digest("hex");
  assert.equal(sha, TEXT_STYLES_PIN, "chat-text-styles.json is the pinned rt-schema registry/text-styles.json");
  const other = process.env.PATV_HUB_DIR;
  if (other) {
    const hub = crypto.createHash("sha256").update(fs.readFileSync(path.join(other, "packages", "rt-schema", "registry", "text-styles.json"))).digest("hex");
    assert.equal(hub, TEXT_STYLES_PIN, "the platform's copy");
  }
});

test("identity: the builder produces every golden identity row v1 can produce, for its input", async () => {
  const want = S1.rows.filter((r) => r.row.topic === "identity/changed" && r.input.fn !== "reader");
  assert.equal(want.length, 9);
  const got = await HI.build(want.map((r) => r.row.entity.slice(5)));
  for (const r of want) assert.deepEqual(got.get(r.row.entity.slice(5)), r.row.payload, r.name);
});

test("identity: v1 never produces the row the hub must quarantine - a malformed link is left out (and counted)", async () => {
  const q = golden("identity: a link with a malformed Discord id is quarantined");
  const before = HI.status().skipped.discord;
  await addUser("1010", { username: "judy", displayname: "Judy", discordId: "judy#1234", discordUsername: "judy", level: 1,
                          created: q.row.payload.created_at, email: "judy@example.com" });
  const p = (await HI.build(["1010"])).get("1010");
  assert.deepEqual(p, { ...q.row.payload, links: [] }, "everything but the link");
  assert.equal(HI.status().skipped.discord, before + 1);
  assert.deepEqual(HI.linksOf({ camfrogUsername: "  Mixed Case ÉÀ  " }), [{ platform: "camfrog", external_id: "mixed case ÉÀ", login: "Mixed Case ÉÀ", display: null }],
                   "Camfrog: SQLite's trim and ASCII lower(), identity's own normalisation");
  assert.deepEqual(HI.linksOf({ camfrogUsername: "x".repeat(65) }), [], "over 64 characters");
  await runQuery("DELETE FROM users WHERE userId = '1010'");
  await clearOutbox();
});

test("identity triggers: only with the switch on, only for the listed columns, OLD and NEW keys", async () => {
  await clearOutbox();
  await runQuery("UPDATE users SET level = 13 WHERE userId = '1001'");
  assert.equal((await outbox("identity/changed")).length, 0, "switch off: nothing");
  await HO.setSettings({ identity: true });
  await runQuery("UPDATE users SET points_balance = points_balance + 5, xp = xp + 3 WHERE userId = '1001'");
  assert.equal((await outbox("identity/changed")).length, 0, "points and xp change on every chat line: never a row");
  await runQuery("UPDATE users SET level = 12 WHERE userId = '1001'");
  await runQuery("UPDATE users SET twitchLogin = 'hank_tv' WHERE userId = '1008'");
  await runQuery("UPDATE users SET twitchLogin = 'hanktv' WHERE userId = '1008'");
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, handle, linked_at) VALUES ('1002', '400000000000000002', 'bobtg', ?)", [AT]);
  await runQuery("UPDATE telegram_links SET user_id = '1005' WHERE user_id = '1002'");
  await runQuery("DELETE FROM telegram_links WHERE user_id = '1005'");
  await runQuery("INSERT INTO account_merges (old_id, new_id, merged_at) VALUES ('1013', '1002', ?)", [AT]);
  await runQuery("UPDATE account_merges SET new_id = '1005' WHERE new_id = '1002'");           // ledger.recordMerge's chain re-point
  await runQuery("UPDATE account_deletions SET state = 'cancelled' WHERE user_id = '1012'");
  await runQuery("UPDATE account_deletions SET state = 'scheduled' WHERE user_id = '1012'");
  const rows = (await outbox("identity/changed")).map((r) => [r.entity, r.payload]);
  assert.deepEqual(rows, [["acct:1001", null], ["acct:1008", null], ["acct:1008", null], ["acct:1002", null], ["acct:1005", null], ["acct:1002", null],
                          ["acct:1005", null], ["acct:1013", null], ["acct:1002", null], ["acct:1013", null], ["acct:1005", null], ["acct:1002", null],
                          ["acct:1012", null], ["acct:1012", null]],
                   "trigger rows carry only the entity; a moved telegram link and a re-pointed merge name both accounts");
  await runQuery("DELETE FROM account_merges WHERE old_id = '1013'");
  await HO.setSettings({ identity: false });
  await runQuery("UPDATE users SET level = 13 WHERE userId = '1001'");
  await runQuery("UPDATE users SET level = 12 WHERE userId = '1001'");
  assert.equal((await outbox("identity/changed")).length, 14, "off again: nothing more");
  await clearOutbox();
});

test("looks: the builder produces the golden looks (rich, default, gone) and never the quarantined one", async () => {
  const rich = golden("looks: a rich look (cosmetics, text style, a pad flair, Supporter, a Plus pad)");
  const def = golden("looks: the default look (no cosmetics)");
  const gone = golden("looks: an account gone from v1");
  const got = await UL.buildLooks(["1001", "1005", "1007", "1009", "1004"], { card: true, t: AT });
  assert.deepEqual(got.get("1001"), rich.row.payload, rich.name);
  assert.deepEqual(got.get("1005"), def.row.payload, def.name);
  assert.deepEqual(got.get("1007"), gone.row.payload, "purged: gone");
  assert.deepEqual(got.get("1009"), { acct: ACCT[1009], v1_user: "1009", gone: true }, "merged away: gone");
  assert.deepEqual(got.get("1004"), { acct: ACCT[1004], v1_user: "1004", gone: true }, "a done deletion's pseudonymous row: gone");
  for (const p of [got.get("1001"), got.get("1005")]) assert.equal(p.h, UL.lookHash(p), "h is the canonical hash (seam plan §12.4)");
  assert.equal(UL.isDefaultLook(got.get("1005")), true);
  assert.equal(UL.isDefaultLook(got.get("1001")), false);
  // the hub's own h rule, written out again: keys sorted at every depth
  const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object"
    ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",")}}` : JSON.stringify(v));
  const { h, ...rest } = got.get("1001");
  assert.equal(h, crypto.createHash("sha256").update(canon(rest), "utf8").digest("hex"));
  // a colour that isn't hex never leaves v1 (golden 244 is the hub's own test): every colour v1 sends is #rrggbb
  const all = JSON.stringify([...got.values()]);
  for (const m of all.matchAll(/"colors":\[([^\]]*)\]/g)) for (const c of JSON.parse("[" + m[1] + "]")) assert.match(c, /^#[0-9a-f]{6}$/);
  // card false: no profile, no gtf, the same h (a chat-only answer never moves the hub's v)
  const chat = (await UL.buildLooks(["1001"], { card: false, t: AT })).get("1001");
  assert.equal(chat.profile, undefined); assert.equal(chat.gtf, undefined);
  assert.equal(chat.h, rich.row.payload.h);
});

test("looks: perks lapse out of the look; valid_until is the earliest end; bots get a bot badge only", async () => {
  // the Plus pad lapses: no auto.plus_pads, no valid_until
  const later = (await UL.buildLooks(["1001"], { t: AT + 21 * DAY })).get("1001");
  assert.deepEqual(later.auto.plus_pads, []);
  assert.equal(later.valid_until, null);
  // a Season Pass perk item is drawn only while the pass holds, and its end bounds valid_until
  await runQuery(`INSERT INTO premium_subs (tier, target, paid_through, status, started, updated) VALUES ('season_pass', '1005', ?, 'active', ?, ?)`,
                 [AT + 5 * DAY, AT - DAY, AT]);
  const inv = await equip("1005", "nc_seasonpass");
  let e = (await UL.buildLooks(["1005"], { t: AT })).get("1005");
  assert.equal(e.name.item, "nc_seasonpass");
  assert.equal(e.valid_until, AT + 5 * DAY);
  e = (await UL.buildLooks(["1005"], { t: AT + 6 * DAY })).get("1005");
  assert.deepEqual(e.name, { kind: "solid" }, "a lapsed pass's item isn't drawn");
  assert.equal(e.valid_until, null);
  await runQuery("DELETE FROM user_cosmetic_equips WHERE inv_id = ?", [inv]);
  await runQuery("DELETE FROM user_cosmetics WHERE id = ?", [inv]);
  await runQuery("DELETE FROM premium_subs WHERE tier = 'season_pass' AND target = '1005'");
  // a market listing locks the copy: it stops being drawn
  await runQuery("UPDATE user_cosmetics SET locked = 1 WHERE user_id = '1001' AND item_id = 'nc_sunset'");
  assert.deepEqual((await UL.buildLooks(["1001"], { t: AT })).get("1001").name, { kind: "solid" });
  await runQuery("UPDATE user_cosmetics SET locked = 0 WHERE user_id = '1001' AND item_id = 'nc_sunset'");
  // Pepe
  await addUser("pepe-bot", { username: "Pepe", displayname: "Pepe", camfrog: "Pepe" });
  const p = (await UL.buildLooks(["pepe-bot"], { t: AT })).get("pepe-bot");
  assert.equal(p.bot, true);
  assert.deepEqual(p.badges, [{ id: "bot", icon: "badges/bot", label_key: "badge.bot" }]);
  assert.deepEqual(p.name, { kind: "solid" });
  assert.equal(p.avatar.url, "https://publicaccess.tv/public/img/pepe.png");
  assert.equal(p.text, undefined); assert.equal(p.profile, undefined);
  await runQuery("DELETE FROM users WHERE userId = 'pepe-bot'");
  // an avatar path needs an https origin; a non-https one leaves the url out
  process.env.SITE_URL = "http://localhost:3000";
  assert.equal((await UL.buildLooks(["1001"], { t: AT })).get("1001").avatar.url, undefined);
  delete process.env.SITE_URL;
  await clearOutbox();
});

test("looks triggers: only with the switch on, only for the look's sources and columns, both owners of a pad", async () => {
  await clearOutbox();
  await runQuery("UPDATE users SET avatar = '/uploads/avatars/1001b.webp' WHERE userId = '1001'");
  assert.equal((await outbox("looks/changed")).length, 0, "switch off: nothing");
  await HO.setSettings({ looks: true });
  await runQuery("UPDATE users SET points_balance = points_balance + 5, xp = xp + 3, level = 12 WHERE userId = '1001'");
  assert.equal((await outbox("looks/changed")).length, 0, "points, xp and level aren't the look's");
  const step = async (label, sql, args, want) => {
    await clearOutbox();
    await runQuery(sql, args);
    assert.deepEqual((await outbox("looks/changed")).map((r) => r.entity), want, label);
  };
  await step("an avatar", "UPDATE users SET avatar = '/uploads/avatars/1001.webp' WHERE userId = '1001'", [], ["acct:1001"]);
  await step("a text style", "UPDATE users SET text_style = NULL WHERE userId = '1005'", [], []);
  await step("a text style set", `UPDATE users SET text_style = '{"color":null,"font":"serif"}' WHERE userId = '1005'`, [], ["acct:1005"]);
  await step("verified: an email confirmed", "UPDATE users SET isEmailVerified = 1 WHERE userId = '1005'", [], ["acct:1005"]);
  await step("an equip", "UPDATE user_cosmetic_equips SET inv_id = inv_id WHERE user_id = '1001' AND kind = 'name_color'", [], ["acct:1001"]);
  await step("a copy listed (locked)", "UPDATE user_cosmetics SET locked = 1 WHERE user_id = '1001' AND item_id = 'gh_crown'", [], ["acct:1001"]);
  await step("a copy transferred", "UPDATE user_cosmetics SET user_id = '1005', locked = 0 WHERE user_id = '1001' AND item_id = 'gh_crown'", [], ["acct:1005", "acct:1001"]);
  await step("a Telegram link", "INSERT INTO telegram_links (user_id, tg_id, handle, linked_at) VALUES ('1002', '400000000000000003', 'b', ?)", [AT], ["acct:1002"]);
  await step("a Google sign-in link", "INSERT INTO sso_links (provider, subject, user_id, link_source, proof, linked_at) VALUES ('google', 's1', '1002', 'self', 'x', ?)", [AT], ["acct:1002"]);
  await step("a provider verified.js doesn't count: not the look's", "INSERT INTO sso_links (provider, subject, user_id, link_source, proof, linked_at) VALUES ('example', 's2', '1002', 'self', 'x', ?)", [AT], []);
  await step("a Season Pass", "INSERT INTO premium_subs (tier, target, paid_through, status, started, updated) VALUES ('season_pass', '1002', ?, 'active', ?, ?)",
             [AT + DAY, AT, AT], ["acct:1002"]);
  await step("a Stripe renewal of the Plus pad (stripe_through only): its owner", "UPDATE premium_subs SET stripe_through = ? WHERE tier = 'prime_plus'",
             [AT + 50 * DAY], ["acct:1001", "acct:1001"]);
  await step("a Plex membership", "INSERT INTO plex_members (plex_id, username, user_id, on_server, pending, access, expires) VALUES ('p1', 'bob', '1002', 1, 0, 'monthly', ?)",
             [AT + DAY], ["acct:1002"]);
  await step("a Plex renewal (expires only): valid_until moves", "UPDATE plex_members SET expires = ? WHERE user_id = '1002'", [AT + 30 * DAY], ["acct:1002"]);
  await step("a donation", "INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES ('don-2', 'mint:donation', '1002', 'mint', 5)", [], ["acct:1002"]);
  await step("another claim: not the look's", "INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES ('c-3', 'heist', '1002', 'x', 5)", [], []);
  await step("a badge showcase", "INSERT INTO user_badge_showcase (user_id, badges) VALUES ('1002', '[\"cf_linked\"]')", [], ["acct:1002"]);
  await step("a pad flair", "INSERT INTO pad_user_flairs (room_id, user_id, flair_id, set_by, self, set_at) VALUES ('patv:frogpond', '1002', 18, 'alice', 0, ?)", [AT],
             ["acct:1002"]);
  await step("the pad's owner changes: both owners' plus_pads", "UPDATE rooms_registry SET owner_user_id = '1002' WHERE room_id = 'patv:frogpond'", [],
             ["acct:1002", "acct:1001"]);
  await step("...and back", "UPDATE rooms_registry SET owner_user_id = '1001' WHERE room_id = 'patv:frogpond'", [], ["acct:1001", "acct:1002"]);
  await step("a deletion completes", "UPDATE account_deletions SET state = 'held' WHERE user_id = '1012'", [], ["acct:1012"]);
  // back to the golden state
  await HO.setSettings({ looks: false });
  await runQuery("UPDATE user_cosmetics SET user_id = '1001', locked = 0 WHERE item_id = 'gh_crown'");
  await runQuery("UPDATE users SET text_style = NULL, isEmailVerified = 0 WHERE userId = '1005'");
  for (const sql of ["DELETE FROM telegram_links WHERE user_id = '1002'", "DELETE FROM sso_links WHERE user_id = '1002'",
                     "DELETE FROM premium_subs WHERE target = '1002'", "UPDATE premium_subs SET stripe_through = 0 WHERE tier = 'prime_plus'",
                     "DELETE FROM plex_members WHERE user_id = '1002'", "DELETE FROM reserve_claims WHERE userId = '1002'",
                     "DELETE FROM user_badge_showcase WHERE user_id = '1002'", "DELETE FROM pad_user_flairs WHERE user_id = '1002'",
                     "UPDATE account_deletions SET state = 'scheduled' WHERE user_id = '1012'"]) await runQuery(sql);
  await require(path.join(repo, "premium")).loadCache();
  await clearOutbox();
});

test("snapshots: the identity and looks pages are the golden pages; null (404) while the switch is off; byte-order paging", async () => {
  await clearOutbox();
  assert.equal(await HO.snapshot("identity/changed", null), null, "identity off");
  assert.equal(await HO.snapshot("looks/changed", null), null, "looks off");
  await HO.setSettings({ identity: true, looks: true });
  for (const topic of ["identity/changed", "looks/changed"]) {
    const page = await HO.snapshot(topic, null);
    const g = S1.snapshots[topic];
    assert.equal(page.topic, topic);
    assert.equal(page.complete, true);
    assert.deepEqual(page.range, { after: null, through: null });
    assert.deepEqual(page.rows, g.rows, topic + ": exactly the golden page's rows");
    assert.equal(page.head, await HO.headId());
  }
  // paging: identity in pages of 3, cursors in byte order, the same rows
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const p = await HO.snapshot("identity/changed", cursor, { limit: 3 });
    seen.push(...p.rows.map((r) => r.entity));
    if (p.complete) break;
    assert.equal(p.range.through, p.rows[p.rows.length - 1].entity);
    cursor = p.next;
  }
  assert.deepEqual(seen, S1.snapshots["identity/changed"].rows.map((r) => r.entity));
  // the looks page lists only non-default looks (§12.4's rule): a default look with an avatar becomes listed
  await runQuery("UPDATE users SET avatar = 'https://cdn.example.com/e.png' WHERE userId = '1005'");
  const withErin = await HO.snapshot("looks/changed", null);
  assert.deepEqual(withErin.rows.map((r) => r.entity), ["acct:1001", "acct:1005"]);
  await runQuery("UPDATE users SET avatar = 'avatar.png' WHERE userId = '1005'");
  await HO.setSettings({ identity: false, looks: false });
  await clearOutbox();
});

// ── the looks call over the wire (hubinbound) ──
let base, server;
const signedCall = async (body, { raw = null, keyId = "hub-test-1", key = V.keys["hub-test-1"] } = {}) => {
  const b = raw != null ? raw : JSON.stringify(body);
  const h = hubsign.sign({ method: "POST", path: "/internal/v1/looks", body: b, keyId, key });
  const r = await fetch(base + "/internal/v1/looks", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: b });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, j, cache: r.headers.get("cache-control") };
};

test("the looks call: the golden answer; 404 while looks is off; 400 / 413; card false; signed only", async () => {
  process.env.HUB_V1_IN_KEY_ID = "hub-test-1";
  process.env.HUB_V1_IN_KEY = V.keys["hub-test-1"];
  const app = express();
  app.use((req, res, next) => (req.path.startsWith("/internal/") ? next() : express.json()(req, res, next)));
  IN.register(app);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const g = S1.calls.looks[0];
    assert.equal((await signedCall(g.request)).status, 404, "looks off: like an unknown path");
    await HO.setSettings({ looks: true });
    HL._resetReverse();
    const ok = await signedCall(g.request);
    assert.equal(ok.status, 200);
    assert.equal(ok.cache, "no-store");
    assert.deepEqual(ok.j, g.answer, "the golden answer: items in request order, the unknown id missing");
    // S1 H9-15-edge-key: the edges' looks-only key gets the same answer (v1's half of F9; refused off this route:
    // hubinbound.test.js)
    process.env.HUB_V1_IN_LOOKS_KEY_ID = "hub-test-looks1";
    process.env.HUB_V1_IN_LOOKS_KEY = "hub-test-looks-only-key-0123456789-not-real";
    try {
      const byLooks = await signedCall(g.request, { keyId: "hub-test-looks1", key: process.env.HUB_V1_IN_LOOKS_KEY });
      assert.equal(byLooks.status, 200);
      assert.deepEqual(byLooks.j, g.answer, "the looks-only key: the golden answer too");
      assert.equal((await signedCall(g.request, { keyId: "hub-test-looks1", key: "a-wrong-secret-0123456789-0123456789" })).status, 401);
    } finally {
      delete process.env.HUB_V1_IN_LOOKS_KEY_ID; delete process.env.HUB_V1_IN_LOOKS_KEY;
    }
    assert.equal((await signedCall(g.request, { keyId: "hub-test-looks1", key: "hub-test-looks-only-key-0123456789-not-real" })).status, 401,
                 "unset again: no key at all");
    const dup = await signedCall({ ids: [ACCT[1005], ACCT[1005], ACCT[1007], ACCT[1009], ACCT[1004]] });
    assert.deepEqual(dup.j.items.map((x) => x.acct), [ACCT[1005]], "duplicates ignored");
    assert.deepEqual(dup.j.missing, [ACCT[1007], ACCT[1009], ACCT[1004]], "purged, merged away, a done deletion: missing");
    const chat = await signedCall({ ids: [ACCT[1001]] });
    assert.equal(chat.j.items[0].profile, undefined, "card defaults to false");
    assert.equal(chat.j.items[0].h, g.answer.items[0].h, "h covers the card look either way");
    assert.equal((await signedCall({ ids: [] })).status, 400);
    assert.equal((await signedCall({ ids: ["NOT-A-UUID"] })).status, 400);
    assert.equal((await signedCall({ ids: [ACCT[1001].toUpperCase()] })).status, 400, "lower-case ids only");
    assert.equal((await signedCall({ ids: [ACCT[1001]], card: "yes" })).status, 400);
    assert.equal((await signedCall(null, { raw: "{nope" })).status, 400);
    const many = Array.from({ length: 451 }, (_, i) => `0192a5b4-0000-7000-8000-${String(i).padStart(12, "0")}`);
    assert.equal((await signedCall({ ids: many })).status, 413);
    const ok450 = await signedCall({ ids: many.slice(0, 450) });
    assert.equal(ok450.status, 200);
    assert.equal(ok450.j.missing.length, 450);
    const unsigned = await fetch(base + "/internal/v1/looks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(g.request) });
    assert.equal(unsigned.status, 401, "unsigned: refused");
    assert.equal(IN.status().last.looks.status, 401);
  } finally {
    await HO.setSettings({ looks: false });
    server.close();
  }
});

test("the poster: a batch of identity and looks trigger rows is read in one build each and posts the golden payloads", async () => {
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
  const realBuild = UL.buildLooks;
  let builds = 0;
  UL.buildLooks = (...a) => { builds++; return realBuild(...a); };
  try {
    await clearOutbox();
    HO._resetPoster();
    await HO.setSettings({ identity: true, looks: true });
    await runQuery("UPDATE users SET avatar = '/uploads/avatars/1001.webp' WHERE userId = '1001'");      // the same value: no row
    await runQuery("UPDATE users SET avatar = '/x.png' WHERE userId = '1001'");
    await runQuery("UPDATE users SET avatar = '/uploads/avatars/1001.webp' WHERE userId = '1001'");
    await runQuery("UPDATE users SET displayname = 'Erin!' WHERE userId = '1005'");
    await runQuery("UPDATE users SET displayname = 'Erin' WHERE userId = '1005'");
    await runQuery("UPDATE users SET level = 6 WHERE userId = '1005'");
    await runQuery("UPDATE users SET level = 5 WHERE userId = '1005'");
    await runQuery("UPDATE users SET level = 5 WHERE userId = '1012'");
    await runQuery("UPDATE users SET level = 4 WHERE userId = '1012'");
    builds = 0;
    const r = await HO.pumpOnce();
    assert.equal(r.posted, 8, "4 looks rows + 4 identity rows (the unchanged avatar wrote none)");
    assert.equal(builds, 1, "one look build for the whole looks batch");
    const looks = got.find((x) => x.url === "/internal/v1/looks/changed").body.rows;
    assert.deepEqual(looks.map((x) => x.entity), ["acct:1001", "acct:1001", "acct:1005", "acct:1005"]);
    for (const row of looks) {
      const want = goldenRow("looks/changed", row.entity).row.payload;
      assert.deepEqual(row.payload, want, row.entity);
    }
    const ids = got.find((x) => x.url === "/internal/v1/identity/changed").body.rows;
    assert.deepEqual(ids.map((x) => x.entity), ["acct:1005", "acct:1005", "acct:1012", "acct:1012"]);
    for (const row of ids) assert.deepEqual(row.payload, goldenRow("identity/changed", row.entity).row.payload, row.entity);
    assert.deepEqual((await getQuery("SELECT COUNT(*) AS n FROM hub_outbox WHERE posted_at IS NULL"))[0].n, 0, "all posted");
  } finally {
    UL.buildLooks = realBuild;
    await HO.setSettings({ identity: false, looks: false });
    delete process.env.HUB_V1_URL; delete process.env.HUB_V1_KEY_ID; delete process.env.HUB_V1_KEY;
    hub.close();
    await clearOutbox();
  }
});

test("the heartbeat carries the S1 switches (additive); the golden S1 heartbeat names them", async () => {
  await HO.setSettings({ identity: true });
  const b = await HO.heartbeatBody();
  assert.equal(b.switches.identity, true);
  assert.equal(b.switches.looks, false);
  assert.deepEqual(b.topics["identity/changed"], { head: 0, pending: 0, oldest_pending_at: null }, "a switched-on S1 topic is listed");
  assert.equal(b.version, "1.99aec", "S1 Q4 (release L1) changed the seam last (ADR 0007 D19)");
  assert.equal(b.version, HO.VERSION);
  const g = S1.heartbeat;
  for (const k of Object.keys(b.switches)) assert.ok(k in g.switches, "the golden S1 heartbeat has " + k);
  for (const t of ["identity/changed", "looks/changed"]) assert.ok(t in g.topics, t);
  // the version is informational (as in hubseam-golden.test.js): the golden, byte-pinned in both repos, keeps the test
  // letter it was recorded with (1.99adp, which the release letter rule later gave to a bot release); the live body
  // names this release
  assert.match(String(g.version), /^\d+\.\d+[a-z]+$/, "the golden S1 heartbeat names a site version");
  await HO.setSettings({ identity: false });
});

test("text style: palette colours and the six fonts only; set() refuses anything else; the look's text", async () => {
  const blue = TS.REG.palette.blue;
  assert.deepEqual(TS.clean({ color: blue.light, font: "mono" }), { color: blue.light, font: "mono" });
  assert.deepEqual(TS.clean({ color: blue.dark.toUpperCase() }), { color: blue.dark, font: "sans" });
  assert.equal(TS.clean({ color: "#123456", font: "mono" }), null, "not a palette colour");
  assert.equal(TS.clean({ color: blue.light, font: "papyrus" }), null, "not an allowed font");
  assert.equal(TS.clean({}), null, "nothing set");
  assert.equal(TS.clean("{nope"), null);
  assert.deepEqual(TS.lookText('{"font":"pixel"}'), { font: "pixel", scope: "all" });
  assert.deepEqual(TS.FONTS, ["sans", "serif", "mono", "rounded", "comic", "pixel"]);
  assert.equal(TS.PALETTE.size, 32, "16 colours, both themes");
  await assert.rejects(TS.set("1005", { color: "#123456" }), (e) => e.code === "bad_text_style");
  await assert.rejects(TS.set("nobody", { font: "mono" }), (e) => e.code === "no_user");
  assert.deepEqual(await TS.set("1005", { color: blue.dark, font: "rounded" }), { color: blue.dark, font: "rounded" });
  assert.deepEqual(await TS.get("1005"), { color: blue.dark, font: "rounded" });
  assert.equal(await TS.set("1005", null), null);
  assert.equal(await TS.get("1005"), null);
});

test("padflair.hubDefs: the pad's user flairs as pads/changed carries them (the golden Frog Pond's)", async () => {
  const pad = S1.snapshots["pads/changed"].rows.find((r) => r.entity === "pad:" + FROGPOND).payload;
  assert.deepEqual(await PF.hubDefs("patv:frogpond"), pad.flairs);
  assert.deepEqual(await PF.hubDefs("user:someone"), [], "profile pads have none");
});

// ── the S1 Q5b review's additions ──
const acctOf = (n) => `0192a5b4-${String(n).padStart(4, "0")}-7c2d-8e3f-4a5b6c7d8e9f`;

test("identity: the Camfrog link rule's edge vectors (golden s1.link_rules): SQLite's trim and lower, 64 code points", async () => {
  const L = S1.link_rules;
  assert.ok(L && L.camfrog.length >= 8 && L.bad.length >= 3);
  for (const v of L.camfrog) {
    const want = v.link ? [{ platform: "camfrog", external_id: v.link.external_id, login: v.link.login, display: null }] : [];
    assert.deepEqual(HI.linksOf({ camfrogUsername: v.raw }), want, v.name);
    // the same key SQLite computes (identity's import: lower(trim(camfrogUsername)))
    if (v.link) assert.equal((await getQuery("SELECT lower(trim(?)) AS k", [v.raw]))[0].k, v.link.external_id, v.name);
  }
  // v1 never produces a link the hub quarantines bad_link
  const produced = new Set(L.camfrog.filter((v) => v.link).map((v) => JSON.stringify(v.link)));
  for (const b of L.bad) assert.equal(produced.has(JSON.stringify(b.link)), false, b.name);
});

test("identity: a done deletion wins over a later open one; a held deletion is deleting", async () => {
  ACCT[1014] = acctOf(1014); ACCT[1015] = acctOf(1015);
  await addUser("1014", { username: "mia", displayname: "Mia", level: 3, created: AT - 60 * DAY });
  await addUser("1015", { username: "ned", displayname: "Ned", level: 3, created: AT - 60 * DAY });
  await runQuery(`INSERT INTO account_deletions (user_id, state, requested_at, execute_at, done_at, pseudonym) VALUES ('1014', 'done', ?, ?, ?, 'deleted-aa')`,
                 [AT - 40 * DAY, AT - 10 * DAY, AT - 10 * DAY]);
  await runQuery("INSERT INTO account_deletions (user_id, state, requested_at, execute_at) VALUES ('1014', 'scheduled', ?, ?)", [AT - DAY, AT + 29 * DAY]);
  await runQuery("INSERT INTO account_deletions (user_id, state, requested_at, execute_at) VALUES ('1015', 'held', ?, ?)", [AT - 3 * DAY, AT + 27 * DAY]);
  try {
    const got = await HI.build(["1014", "1015"]);
    assert.equal(got.get("1014").status, "deleted", "the done deletion, though a later request is open");
    assert.equal(got.get("1014").status_at, AT - 10 * DAY);
    assert.equal(got.get("1015").status, "deleting", "held is still a deletion in progress");
    assert.equal(got.get("1015").status_at, AT - 3 * DAY);
  } finally {
    await runQuery("DELETE FROM account_deletions WHERE user_id IN ('1014', '1015')");
    await runQuery("DELETE FROM users WHERE userId IN ('1014', '1015')");
    await clearOutbox();
  }
});

test("looks: a copy transferred away isn't drawn for the seller, whose equip still points at it", async () => {
  const inv = (await getQuery("SELECT id FROM user_cosmetics WHERE user_id = '1001' AND item_id = 'nc_sunset'"))[0].id;
  assert.ok((await getQuery("SELECT 1 FROM user_cosmetic_equips WHERE user_id = '1001' AND inv_id = ?", [inv])).length, "alice has it equipped");
  await runQuery("UPDATE user_cosmetics SET user_id = '1005' WHERE id = ?", [inv]);
  try {
    const got = await UL.buildLooks(["1001", "1005"], { t: AT });
    assert.deepEqual(got.get("1001").name, { kind: "solid" }, "not alice's any more");
    assert.deepEqual(got.get("1005").name, { kind: "solid" }, "erin owns it but hasn't equipped it");
  } finally {
    await runQuery("UPDATE user_cosmetics SET user_id = '1001' WHERE id = ?", [inv]);
  }
  assert.equal((await UL.buildLooks(["1001"], { t: AT })).get("1001").name.item, "nc_sunset");
});

test("looks snapshot: an account whose only non-default part is a pad flair or the Plex auto flair is listed; plex_flair off unlists it", async () => {
  const MC = require(path.join(repo, "mediaconf"));
  await MC.init();
  const was = MC.get().plex_flair;
  await HO.setSettings({ looks: true });
  try {
    await MC.set({ plex_flair: true }, "test");
    const base = (await HO.snapshot("looks/changed", null)).rows.map((r) => r.entity);
    assert.deepEqual(base, ["acct:1001"], "the golden page");
    await runQuery("INSERT INTO pad_user_flairs (room_id, user_id, flair_id, set_by, self, set_at) VALUES ('patv:frogpond', '1005', 17, 'erin', 1, ?)", [AT]);
    await runQuery("INSERT INTO plex_members (plex_id, username, user_id, on_server, pending, access, expires) VALUES ('p9', 'bobplex', '1002', 1, 0, 'monthly', ?)",
                   [AT + 9 * DAY]);
    const page = await HO.snapshot("looks/changed", null);
    assert.deepEqual(page.rows.map((r) => r.entity), ["acct:1001", "acct:1002", "acct:1005"], "a flair, a Plex membership: both listed");
    const bob = page.rows.find((r) => r.entity === "acct:1002").payload;
    assert.equal(bob.auto.plex, true);
    assert.equal(bob.valid_until, AT + 9 * DAY, "the membership's end");
    assert.deepEqual(page.rows.find((r) => r.entity === "acct:1005").payload.flairs, { [FROGPOND]: "f17" });
    await MC.set({ plex_flair: false }, "test");
    const off = await HO.snapshot("looks/changed", null);
    assert.deepEqual(off.rows.map((r) => r.entity), ["acct:1001", "acct:1005"], "plex_flair off: no auto flair, bob's look is default");
    const b2 = (await UL.buildLooks(["1002"], { t: AT })).get("1002");
    assert.equal(b2.auto.plex, false);
    assert.equal(b2.valid_until, null);
  } finally {
    await MC.set({ plex_flair: was }, "test");
    await runQuery("DELETE FROM pad_user_flairs WHERE user_id = '1005'");
    await runQuery("DELETE FROM plex_members WHERE user_id = '1002'");
    await HO.setSettings({ looks: false });
    await clearOutbox();
  }
});

test("verified: the look's verified and its trigger rows follow verified.js for every sign-in provider", async () => {
  const VF = require(path.join(repo, "verified"));
  assert.ok(VF.SSO_PROOF_PROVIDERS.includes("google"));
  ACCT[1016] = acctOf(1016);
  await addUser("1016", { username: "olga", displayname: "Olga", level: 1, created: AT - DAY });
  await HO.setSettings({ looks: true });
  try {
    for (const provider of ["google", "apple", "example"]) {
      await clearOutbox();
      await runQuery("INSERT INTO sso_links (provider, subject, user_id, link_source, proof, linked_at) VALUES (?, ?, '1016', 'self', 'x', ?)",
                     [provider, "s-" + provider, AT]);
      const rows = (await outbox("looks/changed")).map((r) => r.entity);
      VF.forget("1016");
      const v1 = await VF.verify((await getQuery("SELECT * FROM users WHERE userId = '1016'"))[0]);
      assert.equal(v1, VF.SSO_PROOF_PROVIDERS.includes(provider), provider + ": verified.js's own answer");
      const look = (await UL.buildLooks(["1016"], { t: AT })).get("1016");
      assert.equal(look.verified, v1, provider + ": the hub's look agrees with v1");
      assert.deepEqual(rows, v1 ? ["acct:1016"] : [], provider + ": linking it posts a looks row exactly when it is a proof");
      await clearOutbox();
      await runQuery("DELETE FROM sso_links WHERE user_id = '1016'");
      assert.deepEqual((await outbox("looks/changed")).map((r) => r.entity), v1 ? ["acct:1016"] : [], provider + ": unlinking it too");
    }
  } finally {
    await HO.setSettings({ looks: false });
    await runQuery("DELETE FROM sso_links WHERE user_id = '1016'");
    await runQuery("DELETE FROM users WHERE userId = '1016'");
    await clearOutbox();
  }
});

test("looks: a source that can't be read fails the build (the poster retries) - never a look without its part", async () => {
  await runQuery("ALTER TABLE reserve_claims RENAME COLUMN amount TO amount_q5b");
  try {
    await assert.rejects(UL.buildLooks(["1001"], { t: AT }), /no such column/, "supporter.tiersFor");
    await assert.rejects(HL.candidates("", 10), /no such column/, "the snapshot's candidate sources");
  } finally {
    await runQuery("ALTER TABLE reserve_claims RENAME COLUMN amount_q5b TO amount");
  }
  assert.equal((await UL.buildLooks(["1001"], { t: AT })).get("1001").badges[0].id, "supporter.gold");
  await runQuery("ALTER TABLE plex_members RENAME COLUMN link_source TO link_source_q5b");
  try {
    await assert.rejects(UL.buildLooks(["1005"], { t: AT }), /no such column/, "verified.tableProofsMany (a look without a proof it has)");
  } finally {
    await runQuery("ALTER TABLE plex_members RENAME COLUMN link_source_q5b TO link_source");
  }
  assert.equal((await UL.buildLooks(["1005"], { t: AT })).get("1005").verified, true);
});

test("the looks call reads in one transaction: another request's uncommitted DELETE never makes a live account missing", async () => {
  ACCT[1017] = acctOf(1017);
  await addUser("1017", { username: "pia", displayname: "Pia", avatar: "/uploads/avatars/1017.webp", level: 2, created: AT - DAY });
  const { tx } = require(path.join(repo, "dbUtils"));
  try {
    let release, entered;
    const gate = new Promise((r) => { release = r; });
    const inside = new Promise((r) => { entered = r; });
    const merge = tx(async () => {
      await runQuery("DELETE FROM users WHERE userId = '1017'");       // e.g. a merge's removal of the old row...
      entered();
      await gate;
      throw new Error("...then a later step fails");                   // ...and the whole merge rolls back
    }).catch((e) => e.message);
    await inside;
    const answer = HL.call({ ids: [ACCT[1017]], card: true });         // the hub's call arrives meanwhile
    await new Promise((r) => setTimeout(r, 50));
    release();
    const a = await answer;
    assert.equal(await merge, "...then a later step fails");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM users WHERE userId = '1017'"))[0].n, 1, "rolled back: the account is live");
    assert.deepEqual(a.body.missing, [], "never missing");
    assert.deepEqual(a.body.items.map((x) => x.acct), [ACCT[1017]]);
  } finally {
    await runQuery("DELETE FROM users WHERE userId = '1017'");
    await clearOutbox();
  }
});

test("the looks call: a legacy account resolves from the moment its users row commits (no rebuild window); a hit scans nothing", async () => {
  const id = "rh-new-1";
  ACCT[id] = acctOf(1018);
  HL._resetReverse();
  try {
    let r = await HL.call({ ids: [ACCT[id]] });
    assert.deepEqual(r.body.missing, [ACCT[id]], "no such account yet");
    await addUser(id, { username: "rhnew", displayname: "RH New", level: 0, created: AT });
    r = await HL.call({ ids: [ACCT[id]] });
    assert.deepEqual(r.body.items.map((x) => x.v1_user), [id], "found at once (the map caught up with users inside the call)");
    const scans = HL.status().reverse_scans;
    r = await HL.call({ ids: [ACCT[id], ACCT[1001]] });
    assert.equal(r.body.items.length, 2);
    assert.equal(HL.status().reverse_scans, scans, "every id resolved: no scan of users");
    await runQuery("DELETE FROM users WHERE userId = ?", [id]);
    r = await HL.call({ ids: [ACCT[id]] });
    assert.deepEqual(r.body.missing, [ACCT[id]], "deleted: missing again");
  } finally {
    await runQuery("DELETE FROM users WHERE userId = ?", [id]);
    await clearOutbox();
  }
});
