// h22 phase 2 (1.99amj): the scheduled tournaments' notices - the inbox kind "tourney" (🏆, Telegram opt-in: off by default, the inline
// toggle sets it), reminders due and sent once (remind-on entrants and watchers), stale reminders dropped (cancel, start now, a delay),
// result + cancel notices to every entrant, room lines only in the announce rooms (a player's own lines only in their room, a per-room
// budget that merges bust lines), Pepe's notice PMs only where pmAllowed, and the Discord kinds (starting + winner by default; the role
// pinged on 'starting' only).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { harness } = require("./fixtures/mtt-harness");
const h = harness("casino-mtt-notify");
const { svc, MT, getQuery, runQuery } = h;
require(path.join(h.repo, "casino", "mttseat")).newSeed = () => "e5".repeat(32);
const inbox = require(path.join(h.repo, "inbox"));
const TG = require(path.join(h.repo, "telegram"));
const onNotice = [];
TG.onNotice = (uid, n) => { onNotice.push([uid, n.kind, n.ref]); };
const posts = [];

test.before(async () => {
  await h.setup(40);
  svc.setDiscordBridge(async (p, body) => { posts.push([p, body]); return { ok: true }; });
});
test.after(() => svc.stop());
const P = () => h.players;
const notices = async (uid, like) => (await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref LIKE ?", [uid, like || "mtt:%"]));
const remindRows = (M, where) => getQuery(`SELECT * FROM casino_mtt_reminders WHERE tid = ?${where ? " AND " + where : ""}`, [M.id]);

test("the inbox kind: 🏆 Poker tournaments, Telegram opt-in (not default on); the inline toggle sets the pref for a linked member", async () => {
  await h.fresh();
  assert.deepEqual(inbox.KINDS.tourney, { icon: "🏆", label: "Poker tournaments", link: "/casino/holdem#mtt" });
  assert.ok(!TG.DEFAULT_ON.has("tourney"), "off by default");
  await TG.init();
  await runQuery("INSERT OR REPLACE INTO telegram_links (user_id, tg_id, linked_at) VALUES (?, '777', ?)", [P()[0].uid, Date.now()]);
  const M = await h.schedule({ max_entries: 20, min_entries: 2 });
  let me = await MT.meFor(M, P()[0].uid);
  assert.equal(me.telegram_linked, true);
  assert.equal(me.telegram_tourney, false);
  const r = await h.act(P()[0], "remind", [String(M.no), "on"], { game: "mtt", room: null, telegram: true });
  assert.ok(r.ok, r.reply);
  me = await MT.meFor(M, P()[0].uid);
  assert.equal(me.telegram_tourney, true, "the toggle set telegram_prefs explicitly");
  assert.equal(me.watching, true);
});

test("reminders: 'starting' for remind-on entrants and watchers, due mtt_remind_mins before the start, sent once (the inbox ref); stale rows dropped after a delay / a start now / a cancel", async () => {
  await h.fresh();
  onNotice.length = 0;
  const M = await h.schedule({ max_entries: 20, min_entries: 2 }, { startIn: 60 });
  await h.reg(M, [P()[1]], { remind: true });
  await h.reg(M, [P()[2]]);
  await h.act(P()[3], "remind", [String(M.no), "on"], { game: "mtt", room: null });
  // a delay re-dates the starting reminders (the old ones dropped as re-dated)
  await svc.locked(() => MT.admin("delay", h.admin, M, { minutes: 20 }));
  assert.equal((await remindRows(M, "kind = 'starting' AND dropped = 're-dated'")).length, 2);
  const due = M.start_at - 15 * 60e3;
  h.NOW = due + 1000;
  await svc.tickOnce();
  h.NOW += 31e3; await svc.tickOnce();
  const n1 = await notices(P()[1].uid, `mtt:${M.id}:%:starting%`);
  const n3 = await notices(P()[3].uid, `mtt:${M.id}:%:starting%`);
  assert.equal(n1.length, 1, "the remind-on entrant");
  assert.equal(n3.length, 1, "the watcher");
  assert.equal((await notices(P()[2].uid, `mtt:${M.id}:%:starting%`)).length, 0, "no reminder without remind");
  assert.ok(onNotice.some(([u, kind]) => u === P()[1].uid && kind === "tourney"), "the Telegram hook sees it (its own pref decides)");
  h.NOW += 31e3; await svc.tickOnce();
  assert.equal((await notices(P()[1].uid, `mtt:${M.id}:%:starting%`)).length, 1, "sent once");
  // start now: a 'starting' still due later is dropped as started
  const M2 = await h.schedule({ max_entries: 20, min_entries: 2 }, { startIn: 120 });
  await h.reg(M2, P().slice(5, 8), { remind: true });
  await svc.locked(() => MT.admin("start", h.admin, M2, {}));
  h.NOW = M2.start_at; h.NOW += 31e3; await svc.tickOnce();
  h.NOW += 31e3; await svc.tickOnce();
  assert.ok((await remindRows(M2, "kind = 'starting'")).every((r) => r.dropped || !r.sent_at), "never sent after the start");
  // cancel: dropped
  const M3 = await h.schedule({ max_entries: 20, min_entries: 2 }, { startIn: 120 });
  await h.reg(M3, P().slice(10, 12), { remind: true });
  await svc.locked(() => MT.admin("cancel", h.admin, M3, { confirm: true, reason: "test" }));
  assert.ok((await remindRows(M3, "kind = 'starting'")).every((r) => r.dropped === "cancelled"));
  // the cancel notice reached every entrant
  for (const p of P().slice(10, 12)) assert.equal((await notices(p.uid, `mtt:${M3.id}:%:cancelled%`)).length, 1);
});

test("the result notice to every entrant; room lines only in the announce rooms, a player's own lines only in their room; the per-room budget merges bust lines", async () => {
  await h.fresh({ settings: { mtt_room_lines_per_min: 2 } });
  svc.noteRooms([{ id: "PepeLab", name: "PepeLab" }, { id: "Lounge", name: "Lounge" }, { id: "Elsewhere", name: "Elsewhere" }]);
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 3, rooms: ["PepeLab"] });
  const roomP = h.mk(P()[20].uid, P()[20].name, { via: "room", camfrog: "LoungeGuy", room: "Lounge" });
  await h.reg(M, [roomP].concat(P().slice(21, 28)));
  const refresh = () => svc.noteRooms([{ id: "PepeLab", name: "PepeLab" }, { id: "Lounge", name: "Lounge" }, { id: "Elsewhere", name: "Elsewhere" }]);
  h.NOW = M.start_at - 5e3; refresh();
  await h.toStart(M);
  await h.drive(M, { policy: h.allIn(), each: () => refresh() });
  for (let i = 0; i < 5; i++) { h.NOW += 61e3; refresh(); await svc.tickOnce(); }
  const ev = await getQuery("SELECT room, data FROM casino_events WHERE table_id = ? AND kind = 'mtt'", [M.id]);
  const rooms = new Set(ev.map((r) => r.room));
  assert.ok(!rooms.has("Elsewhere"), "never a room that isn't announced or a player's own");
  const lounge = ev.filter((x) => x.room === "Lounge");
  assert.ok(lounge.length >= 1, "(review) the room player's own line reached their room");
  for (const r of lounge) assert.match(JSON.parse(r.data).text, /LoungeGuy|you're moving/, "only the player's own lines in their room");
  // (the per-room budget and the merged bust lines: the next test - here, during late registration, bust lines go to the player's own room only)
  for (const p of P().slice(20, 28)) assert.equal((await notices(p.uid, `mtt:${M.id}:%:result%`)).length, 1, `${p.uid}: the result notice`);
});

test("review: the per-room budget - at most mtt_room_lines_per_min lines in any minute in an announce room; the bust lines over it merged into one ('N more players out')", async () => {
  await h.fresh({ settings: { mtt_room_lines_per_min: 2 }, deckSeed: 5 });
  const refresh = () => svc.noteRooms([{ id: "PepeLab", name: "PepeLab" }]);
  refresh();
  const M = await h.schedule({ max_entries: 30, min_entries: 2, table_size: 6, late_levels: 0, rooms: ["PepeLab"] });
  await h.reg(M, P().slice(0, 18));
  h.NOW = M.start_at - 5e3; refresh();
  await h.toStart(M);
  await h.drive(M, { policy: h.allIn(), each: () => refresh() });
  for (let i = 0; i < 12; i++) { h.NOW += 61e3; refresh(); await svc.tickOnce(); }
  const ev = (await getQuery("SELECT ts, data FROM casino_events WHERE table_id = ? AND kind = 'mtt' AND room = 'PepeLab' ORDER BY seq", [M.id])).map((r) => ({ ts: r.ts, text: JSON.parse(r.data).text }));
  assert.ok(ev.length >= 4, `lines were said (${ev.length})`);
  for (const x of ev) {
    const n = ev.filter((y) => y.ts >= x.ts && y.ts < x.ts + 60e3).length;
    assert.ok(n <= 2, `at most 2 lines in the minute from ${new Date(x.ts).toISOString()}: ${n}`);
  }
  assert.ok(ev.some((x) => /more players out/.test(x.text)), `bust lines over the budget merged: ${ev.map((x) => x.text).join(" | ")}`);
  assert.ok(ev.some((x) => /wins tournament/.test(x.text)), "the winner line still came");
});

test("Pepe's notice PMs (the start, 15 minutes) go to room players only, in their own room, only where they allow Pepe's PMs for tournaments", async () => {
  await h.fresh();
  await inbox.ready;
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  const a = h.mk(P()[30].uid, P()[30].name, { via: "room", camfrog: "PmYes", room: "PepeLab" });
  const b = h.mk(P()[31].uid, P()[31].name, { via: "room", camfrog: "PmNo", room: "PepeLab" });
  await h.reg(M, [a, b, P()[32]]);
  await runQuery("INSERT OR REPLACE INTO inbox_prefs (user_id, kind, pm_off) VALUES (?, 'tourney', 1)", [b.uid]);
  await h.toStart(M);
  svc.noteRooms([{ id: "PepeLab", name: "PepeLab" }]);
  const out = (await MT.privateMtt()).filter((x) => x.kind === "notice");
  assert.ok(out.some((x) => x.camfrog === "PmYes" && /has started/.test(x.text)), "the start PM");
  assert.ok(!out.some((x) => x.camfrog === "PmNo"), "pm_off for tournaments: none");
  assert.equal((await MT.privateMtt()).filter((x) => x.kind === "notice").length, 0, "claimed once");
});

test("Discord: off by default; with a channel, the default kinds are starting + winner; the role only on 'starting'; one post per (tournament, kind)", async () => {
  await h.fresh({ settings: { mtt_discord: "on", mtt_discord_channel: "123456789012345678", mtt_discord_role: "223456789012345678" } });
  posts.length = 0;
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  await h.reg(M, P().slice(0, 3));
  await h.toStart(M);
  await h.drive(M, { policy: h.allIn() });
  await new Promise((r) => setTimeout(r, 20));
  const kinds = posts.map(([, b]) => b.kind);
  assert.deepEqual(kinds.sort(), ["starting", "winner"]);
  const start = posts.find(([, b]) => b.kind === "starting")[1], win = posts.find(([, b]) => b.kind === "winner")[1];
  assert.equal(start.role_id, "223456789012345678");
  assert.equal(win.role_id, undefined, "never the role on the winner post");
  assert.match(start.url, new RegExp(`/casino/holdem/mtt/${M.id}$`));
  assert.ok(posts.every(([p]) => p === "/casino/tourney"));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM casino_mtt_log WHERE key LIKE ?", [`discord:${M.id}:%`]))[0].n, 2, "one per kind");
  await svc.setSetting("mtt_discord", "off", "test");
  posts.length = 0;
  const M2 = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  await h.reg(M2, P().slice(5, 8));
  await h.toStart(M2);
  assert.equal(posts.length, 0, "off: nothing");
});
