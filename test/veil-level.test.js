// privacy fix (owner decision 2026-11-01, spec M addendum 3 #1): "incognito -> hidden ends the frog-name session at once" - on EVERY
// path, through bridge.ingest on the privacy wire v2:
//   * the staging repro (bridge_feed 157809 / 157816 / 157827, PepeBeta.Room session 4): an incognito person ("Bouncy Paddler") talks,
//     takes the mic, leaves, and comes back HIDDEN within the hour - the hidden line kept the incognito frog name
//   * a per-line priv change from incognito to hidden (no privacy event, no leave)
//   * Pepe's privacy.hidden (the real !bridge hide path) for someone with NO named line since G: the session ends at once, before
//     any further line, and the next roster entry / line has no frog name
//   * a "hidden" leave never carries the incognito frog name
//   * a mic hold begun incognito whose holder switches to hidden mid-hold: the release / its 🎙 line never shows the grab's name
// The next hidden sighting is alias-less (the masked form, "someone" with a bar) - never the incognito name.
// (C) a mid-hold release (spec B.2 / B.4): a hold that began NAMED whose holder went private mid-hold is "someone dropped the mic" -
//     never dropped for everyone (staging bridge_feed 157841: the unresolved holder's anonymous release), never named, never the hold id.
//   node --test test/veil-level.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "veil-level-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "cd".repeat(32);
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const PW = require(path.join(repo, "privwire"));
const FN = require(path.join(repo, "frognames"));

const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "PepeBeta.Room", name: "PepeBeta" };
let seq = 0;
const ev = (type, data, ts = Date.now(), room = ROOM) => ({ op: "event", id: "vl-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room }, data });
const real = (login, display) => ({ id: login.toLowerCase(), login, display: display || login });
const priv = (kind, login, extra = {}) => Object.assign({ kind, h: hash(login), at: Date.now() / 1000 }, extra);
const veiled = (login, display, kind, extra = {}) => Object.assign(real(login, display), { priv: priv(kind, login) }, extra);   // a snapshot entry
const pd = (kind, login, display, data = {}) => Object.assign({ user: real(login, display), priv: priv(kind, login) }, data);        // an event's data
const sync = (events, extra = {}) => bridge.ingest(Object.assign({ events, rooms: [], bridge_hidden_h: [], incog_hidden_h: [] }, extra), { v2: true });
const snap = (members, mic = [], room = ROOM) => ({ room, members, mic, count: members.length, transcripts: true });
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const privacy = (login, scope, lists) => bridge.ingest(Object.assign({ events: [{ op: "event", id: "vl-p-" + (++seq), ts: new Date().toISOString(), type: "privacy.hidden",
                                                                                 scope: { platform: "camfrog" }, data: { h: hash(login), scope } }], rooms: [] }, lists));
const goIncognito = (login) => privacy(login, "incognito", { bridge_hidden_h: [], incog_hidden_h: [hash(login)] });
const goHidden = (login) => privacy(login, "bridge", { bridge_hidden_h: [hash(login)], incog_hidden_h: [] });
const R = () => bridge._rooms.get(ROOM.id);
const of = (login) => R().feed.filter((x) => x._vz && x._vz.login === login);

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class) VALUES ('id-adm', 'adm', 'adm', 'x', 'Admin')`);
  await require(path.join(repo, "inbox")).ready;
  await rooms.init();
  CL._setClock(() => Date.now() - 8 * 864e5);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  for (const s of ["archive", "history", "search"]) await CL.setSwitch(s, true, "test");
  await PW.init();
  await PW.setOn(true, { userId: "id-adm", username: "adm" });
  await sync([], { rooms: [snap([real("zqcharlie", "ZqCharlieDisp")])] });
  await settle();
  await CV.init();
  CV._clearCaches();
})();

test("staging repro (bridge_feed 157809 / 157816 / 157827): incognito 'Bouncy Paddler' leaves and comes back HIDDEN within the hour - the hidden line never carries the incognito frog name", async () => {
  await setup;
  const t0 = Date.now() + 1000;
  assert.ok(t0 > PW.gAt());
  const B = (kind, data) => pd(kind, "zqbravo2", "ZqBravoDisp", data);
  await sync([ev("member.join", B("incognito"), t0)]);
  await sync([ev("message", B("incognito", { text: "s2 bravo hello from slot two qz6" }), t0 + 1000)]);
  const first = of("zqbravo2").find((x) => x.text === "s2 bravo hello from slot two qz6");
  assert.ok(first && first.u.alias, "incognito: a frog name (157809)");
  const A = first.u.alias;
  await sync([ev("mic.grab", { user: Object.assign(real("zqbravo2", "ZqBravoDisp"), { proven: true, since: (t0 + 1500) / 1000 }), priv: priv("incognito", "zqbravo2"), hold: "hd-1a1583a5aa7c" }, t0 + 1500)]);
  await sync([ev("mic.release", B("incognito", { hold: "hd-1a1583a5aa7c", held_ms: 8912 }), t0 + 10000)]);
  await sync([ev("message", B("incognito", { text: "s2 bravo says bye qz9" }), t0 + 12000)]);
  assert.equal(of("zqbravo2").find((x) => x.text === "s2 bravo says bye qz9").u.alias, A, "the same name while incognito (157816)");
  await sync([ev("member.leave", B("incognito"), t0 + 14000)]);
  // back within the hour, now !bridge hide - the staging sim sent no privacy event, only the hidden-kind line (157827)
  await sync([ev("message", { user: real("zqbravo2", "ZqBravoDisp"), priv: priv("hidden", "zqbravo2", { words: "s3 bravo hidden now" }) }, t0 + 26000)]);
  const h = of("zqbravo2").filter((x) => x.u.veil === "hidden").pop();
  assert.ok(h, "the hidden line is there (a bar)");
  assert.notEqual(h.u.alias, A, "never the incognito frog name (157827 showed 'Bouncy Paddler')");
  assert.equal(h.u.alias, undefined, "the masked form: no frog name for the switch's 15 minutes");
  assert.ok(!JSON.stringify(h).includes("s3 bravo") && h.mask, "a bar, no words");
  const cur = FN.current(ROOM.id, "zqbravo2");
  assert.ok(cur && cur.alias === null, "the open session is a new, alias-less one");
});

test("a per-line priv change incognito -> hidden (no event, no leave) ends the session at once; hidden -> incognito keeps the alias-less one", async () => {
  await setup;
  const t0 = Date.now() + 2000;
  await sync([ev("message", pd("incognito", "perline1", "Perline", { text: "per line incognito" }), t0)]);
  const A = of("perline1")[0].u.alias;
  assert.ok(A, "a frog name");
  await sync([ev("message", { user: real("perline1", "Perline"), priv: priv("hidden", "perline1", { words: "per line hidden words" }) }, t0 + 500)]);
  const h = of("perline1").pop();
  assert.equal(h.u.veil, "hidden");
  assert.ok(h.u.alias === undefined && h.u.id === undefined, "the next hidden line: no name, no session id");
  await sync([ev("message", { user: real("perline1", "Perline"), text: "per line back to incognito", priv: priv("incognito", "perline1") }, t0 + 1000)]);
  const back = of("perline1").pop();
  assert.ok(back.u.veil === "incognito" && back.u.alias === undefined, "hidden -> incognito keeps the (alias-less) session - never the old name back");
});

test("the real !bridge hide path (Pepe's privacy.hidden) ends the session AT ONCE - no named line since G, no further line - and the next roster entry has no frog name", async () => {
  await setup;
  const t0 = Date.now() + 3000;
  await goIncognito("quietone");
  await settle();
  await sync([], { rooms: [snap([real("zqcharlie", "ZqCharlieDisp"), veiled("quietone", "QuietDisp", "incognito")])] });
  await sync([ev("message", pd("incognito", "quietone", "QuietDisp", { text: "quiet one talks incognito" }), t0)]);
  const A = of("quietone").pop().u.alias;
  assert.ok(A && FN.current(ROOM.id, "quietone").alias === A, "incognito: a frog name, in the roster too");
  assert.equal(R().members.find((e) => e.anon && e.alias === A) ? true : false, true);
  await goHidden("quietone");
  await settle(100);
  assert.equal(FN.current(ROOM.id, "quietone"), null, "privacy.hidden ended the frog-name session at once (no line needed)");
  await sync([], { rooms: [snap([real("zqcharlie", "ZqCharlieDisp"), veiled("quietone", "QuietDisp", "hidden")])] });
  const e = R().members.find((x) => x.anon && x.veil === "hidden");
  assert.ok(e && e.alias === undefined, "the next roster entry: hidden, no frog name");
  assert.ok(!R().members.some((x) => x.alias === A), "the incognito name is gone from the people list");
  await sync([ev("message", { user: real("quietone", "QuietDisp"), priv: priv("hidden", "quietone", { words: "quiet hidden" }) }, t0 + 5000)]);
  assert.equal(of("quietone").pop().u.alias, undefined, "the next line: no frog name");
});

test("a 'hidden' leave of someone whose session is incognito never carries the incognito frog name", async () => {
  await setup;
  const t0 = Date.now() + 4000;
  await sync([ev("message", pd("incognito", "leaver9", "Leaver", { text: "leaver incognito" }), t0)]);
  const A = of("leaver9")[0].u.alias;
  assert.ok(A);
  await sync([ev("member.leave", pd("hidden", "leaver9", "Leaver"), t0 + 500)]);
  const lv = of("leaver9").pop();
  assert.ok(lv.k === "leave" && lv.u.veil === "hidden" && lv.u.alias === undefined, "the leave: hidden, no frog name");
  assert.equal(FN.current(ROOM.id, "leaver9"), null);
});

test("a hold begun incognito whose holder switches to hidden mid-hold: the release and its 🎙 line never show the grab's frog name", async () => {
  await setup;
  const t0 = Date.now() + 5000;
  const grab = Object.assign(real("holder7", "Holder"), { proven: true, since: t0 / 1000 });
  await sync([ev("mic.grab", { user: grab, priv: priv("incognito", "holder7"), hold: "hd-00aa11bb22cc" }, t0)]);
  const g = of("holder7").pop();
  assert.ok(g.k === "mic" && g.u.alias, "the grab: a frog name");
  const A = g.u.alias;
  // mid-hold the 🎙 line arrives hidden (Pepe sends the level they are NOW for a line), then the release of the same hold
  await sync([ev("x.pepe.transcript", { user: real("holder7", "Holder"), id: "tx-0011223344556677", said_at: (t0 + 2000) / 1000, hold: "hd-00aa11bb22cc",
                                         priv: priv("hidden", "holder7", { words: "words said on the mic" }) }, t0 + 3000)]);
  await sync([ev("mic.release", { user: real("holder7", "Holder"), hold: "hd-00aa11bb22cc", held_ms: 4000, priv: priv("hidden", "holder7") }, t0 + 4000)]);
  const after = of("holder7").slice(1);
  assert.ok(after.length >= 1, "the hidden items are there");
  for (const x of after) assert.ok(x.u.alias !== A && x.u.alias === undefined, `${x.k}: never the grab's incognito name`);
});

// ── privacy fix (C, spec B.2 / B.4 "named-then-veiled hold"): a mid-hold release is never dropped for everyone, never named ──
const anonRef = (ref) => ({ id: ref, display: "someone", anonymous: true });
const shown = (it) => { const o = CV.dress([it], { view: null })[0]; return { p: CV.privacyOf(it), o }; };

test("C: the staging 157841 shape - a NAMED grab, the holder unresolved and private mid-hold, the release in today's anonymous form with the hold id: 'someone dropped the mic', no hold, no name", async () => {
  await setup;
  const t0 = Date.now() + 6000;
  await sync([ev("mic.grab", { user: real("zqEchoHold", "zqEchoHold"), holders: [], hold: "hd-0c93e4480436" }, t0)]);
  assert.ok(R().feed.some((x) => x.k === "mic" && x.u.login === "zqEchoHold"), "the named grab (157833)");
  await sync([ev("mic.release", { user: anonRef("anon-6921a48a"), reason: "released", held_ms: 7415, holders: [], hold: "hd-0c93e4480436" }, t0 + 7415)]);
  const rel = R().feed.filter((x) => x.k === "unmic" && x.ar === "anon-6921a48a").pop();
  assert.ok(rel && rel.k3 === 1, "stamped showable (157841 was dropped for everyone)");
  const { p, o } = shown(rel);
  assert.equal(p, "anon", "shown as 'someone'");
  assert.deepEqual(o.u, { anon: true, display: "someone" }, "plain 'someone' - no name, no veil kind, no frog name");
  assert.equal(o.hold, undefined, "the page never gets the hold id (it would pair the release with the named grab)");
  assert.equal(o.ms, 7415, "...dropped the mic after 7s");
  assert.ok(!JSON.stringify(o).includes("zqEcho") && !JSON.stringify(o).includes("anon-6921a48a"), "nothing ties it to the holder");
});

test("C: fails closed - an anonymous release whose hold never came named (or has no hold id) stays out; after a restart the live feed still pairs it", async () => {
  await setup;
  const t0 = Date.now() + 7000;
  await sync([ev("mic.release", { user: anonRef("anon-11112222"), reason: "released", held_ms: 1000, holders: [], hold: "hd-99990000aaaa" }, t0)]);
  const a = R().feed.filter((x) => x.ar === "anon-11112222").pop();
  assert.ok(a && a.k3 !== 1 && CV.privacyOf(a) === "out", "an unknown hold: left out, as before");
  await sync([ev("mic.release", { user: anonRef("anon-33334444"), reason: "released", held_ms: 1000, holders: [] }, t0 + 10)]);
  const b = R().feed.filter((x) => x.ar === "anon-33334444").pop();
  assert.ok(b && b.k3 !== 1 && CV.privacyOf(b) === "out", "no hold id: left out, as before");
  // a named grab, then the site restarts (its hold maps are memory) - the grab is still in the live feed
  await sync([ev("mic.grab", { user: real("restarter", "Restarter"), holders: [], hold: "hd-5555aaaa6666" }, t0 + 20)]);
  require(path.join(repo, "veil"))._beganNamed.clear();
  require(path.join(repo, "veil"))._holds.clear();
  await sync([ev("mic.release", { user: anonRef("anon-77778888"), reason: "released", held_ms: 3000, holders: [], hold: "hd-5555aaaa6666" }, t0 + 3020)]);
  const c = R().feed.filter((x) => x.ar === "anon-77778888").pop();
  assert.ok(c && c.k3 === 1 && CV.privacyOf(c) === "anon", "paired from the live feed after a restart");
});

test("C: a resolved holder who grabbed named and went incognito / hidden mid-hold (priv + began_named): 'someone dropped the mic', never a frog name", async () => {
  await setup;
  const t0 = Date.now() + 8000;
  for (const [login, kind, hold] of [["midincog", "incognito", "hd-abab0000cdcd"], ["midhidden", "hidden", "hd-efef1111abab"]]) {
    await sync([ev("mic.grab", { user: Object.assign(real(login, login.toUpperCase()), { proven: true, since: t0 / 1000 }), holders: [], hold }, t0)]);
    await sync([ev("message", { user: real(login, login.toUpperCase()), text: "said while " + kind, priv: priv(kind, login, kind === "hidden" ? { words: "w" } : {}) }, t0 + 500)]);
    await sync([ev("mic.release", { user: real(login, login.toUpperCase()), reason: "released", held_ms: 2000, holders: [], hold, priv: priv(kind, login), began_named: true }, t0 + 2000)]);
    const rel = R().feed.filter((x) => x.k === "unmic" && x._vz && x._vz.login === login).pop();
    assert.ok(rel, `${kind}: the release is there`);
    const { p, o } = shown(rel);
    assert.notEqual(p, "out", `${kind}: shown`);
    assert.ok(o.u.anon && o.u.display === "someone" && !o.u.alias && o.hold === undefined, `${kind}: 'someone', no frog name, no hold`);
    assert.ok(!JSON.stringify(o).includes(login) && !JSON.stringify(o).includes(login.toUpperCase()), `${kind}: never named`);
  }
});
