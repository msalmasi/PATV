// 1.99?? (bot 1.99aik): /admin/pepe/livecams - the page script (views/admin/pepeLivecams.ejs), run in a vm with a small fake DOM:
// each cam's Bitrate cell says what it really costs ("768 kbit/s (clamped from 2000)" when Pepe clamped a re-encode to the cam's
// 1/3 bit per pixel per frame), a relay's ffmpeg errors (err_first) sit on its row, failed relays are listed; and the settings
// explain the clamp and the mic-stage pass-through.
//   node --test test/livecam-admin-page.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "livecam-admin-page-")));   // (livecam -> dbUtils opens ./myapp.db)
const EJS = fs.readFileSync(path.join(repo, "views", "admin", "pepeLivecams.ejs"), "utf8");
const LC = require(path.join(repo, "livecam"));

/** The page's own script (the one that reads the view, V), with the view put in. */
function pageScript() {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(EJS))) if (m[1].includes("var V = <%-")) return m[1].replace(/<%-[\s\S]*?%>/, "__V__");
  throw new Error("no page script");
}

function El(tag, id) {
  let own = "";
  const e = { tag, id, children: [], className: "", hidden: false, colSpan: 0, type: "", value: "", checked: false, _l: {},
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    appendChild(c) { this.children.push(c); return c; },
    remove() {}, closest() { return this._label || (this._label = El("label")); },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {} } };
  Object.defineProperty(e, "textContent", { get() { return own + e.children.map((c) => c.textContent).join(""); }, set(v) { own = String(v); e.children = []; } });
  return e;
}

function boot(view) {
  const els = {};
  const byId = (i) => els[i] || (els[i] = El("div", i));
  const form = byId("lcForm");
  const inputs = {};
  form.elements = new Proxy(inputs, { get: (o, k) => (typeof k === "string" ? o[k] || (o[k] = Object.assign(El("input"), { type: "number" })) : undefined) });
  const document = { getElementById: byId, createElement: (t) => El(t), hidden: false };
  const fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) });
  vm.runInNewContext(pageScript(), { __V__: JSON.parse(JSON.stringify(view)), document, fetch, setInterval: () => 0, confirm: () => true, console });
  return els;
}

const SESS = (o) => Object.assign({ key: "Room.One|x", room: "Room.One", login: "x", display: "x", state: "live", since: 1, viewers: [], readers: 0,
                                    botState: "live", botWhy: null, outKbps: 0, err_first: null }, o);
function view(sessions, failed) {
  return { now: 2, v: 1, cfg: { ...LC.DEFAULTS, enabled: true }, defaults: { ...LC.DEFAULTS }, fields: LC.FIELDS, updated_at: null, updated_by: null, webrtc: true,
           bot: { at: 1, online: true, pool: null, cfgFrom: "" }, sessions,
           usage: { viewers: 0, viewerCap: 333, mbps: 0, budget_mbps: 100, live: sessions.length, max_live: 4, publishMbps: 0 },
           optouts: 0, camviewers: null, ghost: { on: [], views: [], log: [] }, audit: [], recent: [], failed };
}

test("each cam's Bitrate: measured / encoded / clamped from the setting / configured; its ffmpeg errors on its row", () => {
  const ERR = "[whip @ 0x1] Failed to send packet: Resource temporarily unavailable";
  const els = boot(view([
    SESS({ login: "pt", kbps: 40, rate: "measured", measured: true, bot: { source: "passthrough", fps: 30, kbps: 40 } }),
    SESS({ login: "cl", kbps: 768, rate: "encoded", bot: { source: "reencode", grab_fps: 15, grab_ms: 0.1, kbps: 768, kbps_cfg: 2000, kbps_cap: 768 }, err_first: { text: ERR, at: 5 } }),
    SESS({ login: "en", kbps: 300, rate: "encoded", bot: { source: "reencode", grab_fps: 15, grab_ms: 0.1, kbps: 300, kbps_cfg: 300, kbps_cap: 768 } }),
    SESS({ login: "old", kbps: 300, rate: "configured", bot: { source: "reencode", grab_fps: 15, grab_ms: 0.1, kbps: 300 } }),
  ], []));
  const rows = els.usRows.children.map((tr) => tr.children.map((td) => td.textContent));
  assert.equal(rows.length, 4);
  assert.match(rows[0][4], /^40 kbit\/s measured/);
  assert.match(rows[1][4], /^768 kbit\/s \(clamped from 2000\)/);
  assert.match(rows[2][4], /^300 kbit\/s encoded/);
  assert.match(rows[3][4], /^300 kbit\/s configured/);
  assert.ok(rows[1][1].includes("⚠ ffmpeg's first errors (") && rows[1][1].endsWith("): " + ERR), rows[1][1]);
  assert.ok(!rows[0][1].includes("ffmpeg") && !rows[3][1].includes("ffmpeg"), "no errors, no line");
  assert.equal(els.usFail.hidden, true, "no failed relays: no list");
});

test("relays that failed are listed with ffmpeg's first errors, named as their rows were", () => {
  const els = boot(view([], [{ at: 5, why: "failed", room: "Room.One", login: null, display: "Moss Frog (incognito)", veiled: true, err_first: "Conversion failed!", err_at: 4 }]));
  assert.equal(els.usFail.hidden, false);
  const li = els.usFailList.children.map((x) => x.textContent);
  assert.equal(li.length, 1);
  assert.ok(li[0].endsWith(" · Moss Frog (incognito) · Room.One · failed · Conversion failed!"), li[0]);
});

test("the settings explain the clamp, the re-encode rate in the budget, and the mic-stage pass-through", () => {
  const strip = (s) => s.replace(/<[^>]+>/g, "");
  const text = strip(EJS);
  assert.ok(text.includes("Video bitrate per cam (kbps) - re-encode only. Pepe never encodes a cam at more than 1/3 bit per pixel per frame (768 kbps for a 320x240 cam at 30 fps, 384 at 15): a higher setting is clamped to that, and the cam's row under Now says so"));
  assert.ok(text.includes("(pass-through: measured; re-encode: the rate Pepe encodes at - the bitrate above, or less where a cam is clamped)"));
  assert.ok(text.includes("Mic-stage cams are re-encoded, unless Pepe's mic-stage pass-through is on (!livecam passthru exact on in Camfrog, admins; off by default). Then, under Pass-through or Auto, a mic-stage cam goes out untouched when Pepe proves its stream with that cam's own setup token - anything less is still re-encoded."));
  assert.equal(LC.FIELDS.kbps.min, 80);
  assert.equal(LC.FIELDS.kbps.max, 2000, "the range is unchanged");
});
