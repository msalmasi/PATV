#!/usr/bin/env node
// tools/hubseam-driver.js — the v1 side of the v1 <-> hub contract suite (R-14, 1.99acm; seam plan §5.3). The hub repo's
// test/seam-contract.integration.test.ts spawns it with PATV_V1_DIR pointing at this checkout and drives v1's REAL modules
// (the outbox poster, sessions, incognito, the profile layout, hubhidden, account delete / export, forget-me and the inbound
// /internal/v1 routes) on a throwaway SQLite database against the hub's real intake.
//
//   node tools/hubseam-driver.js --dir <a fresh directory under the OS temp dir>
//
// It refuses any other directory (it creates myapp.db there and chdirs into it before loading a single site module, so it can
// never touch a real database); the same directory may be reused by a restarted driver (a marker file says it is ours).
// Environment: HUB_V1_URL, HUB_V1_KEY_ID / HUB_V1_KEY, HUB_V1_ENV, HUB_V1_IN_KEY_ID / HUB_V1_IN_KEY, CHAT_GENESIS_NS and
// (optional) CHAT_TICKET_KEY / CHAT_TICKET_KID - test values only. Protocol: JSON lines on stdin / stdout - {"id":n,"cmd":"…","args":{…}} -> {"id":n,"ok":true,"result":…} or
// {"id":n,"ok":false,"error":"…"}; the site's own logging goes to stderr. Commands:
//   ready {port?}               -> {inbound_url}    v1's Express app with hubinbound, on loopback (a restarted driver passes its old port)
//   switches {set}              -> {settings}       hubseam.<switch> values
//   account {user, login?}      -> {acct}           a users row (acct = chatticket.subjectOf)
//   session {user}              -> {id, sid}        a sessions row
//   revoke {user, id, why} | revokeAll {user, why, except?} | merge {from, into}       sessions.js (+ the merge log row)
//   incognito {user, on} | pepeSync {items}         incognito.request / incognito.sync
//   privateActivity {user, on}                      the profile layout's Analytics section hidden / shown
//   hiddenH {list, bridge?, incog?, events?, session?, sent?, explicit?}   hubhidden.noteSync (Pepe's hidden_h - sticky since
//                                                   1.99add - his kinded lists bridge_hidden_h / incog_hidden_h (refix 4: an
//                                                   incognito-only hash's hh: row carries scope "incognito"), his privacy.hidden /
//                                                   privacy.shown {h, scope} events, and the bridge session / sent time an older
//                                                   Pepe's same-run drop is read from)
//   deleteAccount {user}        -> {request}        accountdelete.schedule + execute (forced)
//   forget {user}               -> {ref}            pepeforget.request
//   exportAccount {user}        -> {id, state, error, hub_jsonl}   accountexport (done | waiting | failed; the zip's chat-hub.jsonl)
//   exportResume {id}           -> the same, for a job that was waiting for the hub (accountexport.run again)
//   ticket {user, id}           -> {token, claims}  a chat ticket for that session (chatticket.claimsFor + signJwt; CHAT_TICKET_KEY/KID)
//   sign {method, path, body, skew_s} -> {headers}  hubsign.sign with v1's outbound key, its clock skew_s seconds off (not sent)
//   hubGet {path}               -> {ok, status, error, body}   huboutbox.getSigned (a signed GET to the hub, streamed to a file)
//   flush                       -> {posted, pending}    the poster until nothing is pending (or ~15 s)
//   heartbeat                   -> {status}
//   faultAfter2xx {on}          -> {}               exit(137) between the hub's 2xx and posted_at (huboutbox._setFault)
// Never run it against anything but a test hub with test keys.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const zlib = require("zlib");

const repo = path.resolve(__dirname, "..");
const MARKER = ".hubseam-driver";

function fail(msg) { process.stderr.write("hubseam-driver: " + msg + "\n"); process.exit(2); }
// (taken out of process.argv: node-pre-gyp - bcrypt's loader - parses argv and reads --dir as its own --directory)
const argDir = (() => { const i = process.argv.indexOf("--dir"); if (i < 0) return null; const v = process.argv[i + 1]; process.argv.splice(i, 2); return v; })();
if (!argDir) fail("usage: node tools/hubseam-driver.js --dir <fresh directory under the OS temp dir>");
const real = (p) => { try { return fs.realpathSync(p); } catch (e) { return null; } };
const dir = real(path.resolve(argDir));
const tmp = real(os.tmpdir());
if (!dir || !tmp || !(dir + path.sep).toLowerCase().startsWith(tmp.toLowerCase() + path.sep) || dir.toLowerCase() === tmp.toLowerCase()) {
  fail("--dir must be an existing directory under " + os.tmpdir());
}
const entries = fs.readdirSync(dir);
const ours = entries.includes(MARKER);
if (entries.length && !ours) fail("--dir must be empty (or a directory this driver made)");
fs.writeFileSync(path.join(dir, MARKER), "hubseam-driver\n");
process.chdir(dir);

// the site's logs go to stderr; stdout carries the protocol only
const out = process.stdout.write.bind(process.stdout);
for (const k of ["log", "info", "warn", "debug"]) console[k] = (...a) => process.stderr.write(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
delete process.env.STAGING;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SECRET_KEY = process.env.SECRET_KEY || crypto.randomBytes(16).toString("hex");
process.env.ACCOUNT_EXPORT_DIR = path.join(dir, "account-exports");

/** The site's schema in the throwaway database (first run only): the staging dump + every CREATE TABLE in the code. */
async function buildSchema() {
  if (ours && fs.existsSync(path.join(dir, "myapp.db"))) return;
  const sqlite3 = require(path.join(repo, "node_modules", "sqlite3"));
  const { scanSource, schemaSql } = require(path.join(repo, "test", "fixtures", "schemascan"));
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  for (const c of ["archived_at INTEGER", "password_set INTEGER", "twitchLogin TEXT", "auto_source TEXT", "displayname_auto INTEGER"]) {
    await run(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  }
  await new Promise((r) => db.close(r));
}

const M = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null, inboundUrl = null;

async function boot() {
  if (M.ho) return;
  await buildSchema();
  const req = (n) => require(path.join(repo, n));
  Object.assign(M, { db: req("dbUtils"), ho: req("huboutbox"), sessions: req("sessions"), incognito: req("incognito"), pl: req("profilelayout"),
                     hidden: req("hubhidden"), del: req("accountdelete"), exp: req("accountexport"), forget: req("pepeforget"), ct: req("chatticket") });
  await M.ho.init();
  for (const m of [M.sessions, M.incognito, M.del, M.exp, M.forget, M.hidden]) await m.init();
  await req("messages").init();
  try { await req("ledger").ensure(); } catch (e) { /* optional */ }
  try { await req("staleaccounts").ensure(); } catch (e) { /* optional */ }
}

function unzipEntry(buf, want) {
  let o = 0;
  while (o + 30 <= buf.length && buf.readUInt32LE(o) === 0x04034b50) {
    const csize = buf.readUInt32LE(o + 18), nlen = buf.readUInt16LE(o + 26), xlen = buf.readUInt16LE(o + 28);
    const name = buf.slice(o + 30, o + 30 + nlen).toString("utf8");
    const data = buf.slice(o + 30 + nlen + xlen, o + 30 + nlen + xlen + csize);
    if (name === want) return zlib.inflateRawSync(data);
    o += 30 + nlen + xlen + csize;
  }
  return null;
}
const fakeReq = { get: (h) => (h === "user-agent" ? "hubseam-driver" : "") };
const pending = async () => (await M.db.getQuery("SELECT COUNT(*) AS n FROM hub_outbox WHERE posted_at IS NULL"))[0].n;
/** Runs an export job until it is ready, failed or waiting for the hub. */
async function exportWait(id) {
  const get = async () => (await M.db.getQuery("SELECT * FROM account_exports WHERE id = ?", [id]))[0];
  let job = null;
  for (let i = 0; i < 200; i++) {
    job = await get();
    if (!job) throw new Error("no such export");
    if (job.state === "ready" || job.state === "failed") break;
    if (job.state === "queued") {
      const r = await M.exp.run(id);
      if (r && r.waiting) { job = await get(); break; }
    }
    await sleep(100);
  }
  if (job.state !== "ready") return { id, state: job.state === "queued" ? "waiting" : job.state, error: job.hub_error || job.error || null, hub_jsonl: null };
  const zip = fs.readFileSync(path.join(process.env.ACCOUNT_EXPORT_DIR, path.basename(job.file)));
  const hub = unzipEntry(zip, "chat-hub.jsonl");
  return { id, state: "done", error: null, hub_jsonl: hub ? hub.toString("utf8") : null };
}

const CMDS = {
  async ready({ port } = {}) {
    await boot();
    if (!server) {
      const express = require(path.join(repo, "node_modules", "express"));
      const app = express();
      require(path.join(repo, "hubinbound")).register(app);
      // the ticket JWKS the hub's gateway fetches (chatticket's answer; its ticket route itself isn't used here)
      app.get("/.well-known/patv-jwks.json", (req, res) => {
        const j = M.ct.jwks();
        if (!j) return res.status(404).json({ ok: false });
        res.json(j);
      });
      app.use((req, res) => res.status(404).json({ ok: false }));
      await new Promise((resolve, reject) => { server = app.listen(Number(port) || 0, "127.0.0.1", resolve); server.once("error", reject); });
      inboundUrl = `http://127.0.0.1:${server.address().port}`;
    }
    return { inbound_url: inboundUrl };
  },
  async switches({ set }) { await boot(); return { settings: await M.ho.setSettings(set || {}) }; },
  async account({ user, login }) {
    await boot();
    await M.db.runQuery("INSERT OR IGNORE INTO users (userId, username, displayname, password, class, camfrogUsername, points_balance) VALUES (?, ?, ?, 'x', 'pleb', ?, 0)",
                        [String(user), String(user), String(user), login || null]);
    return { acct: M.ct.subjectOf(String(user)) };
  },
  async session({ user }) { await boot(); const s = await M.sessions.create(fakeReq, String(user), "password"); return { id: s.id, sid: s.id.slice(0, 32) }; },
  async revoke({ user, id, why }) { await boot(); return { n: await M.sessions.revoke(String(user), String(id), why || "signed out") }; },
  async revokeAll({ user, why, except }) {
    await boot();
    return { n: await M.sessions.revokeAll(String(user), { why: why || "signed out everywhere", except: except == null ? null : String(except) }) };
  },
  async merge({ from, into }) {
    await boot();
    await M.db.tx(async () => {
      await M.sessions.revokeForMerge(String(from), String(into));
      await M.db.runQuery("INSERT INTO account_merge_log (at, via, from_id, to_id) VALUES (?, 'driver', ?, ?)", [Date.now(), String(from), String(into)]);
    });
    return {};
  },
  async incognito({ user, on }) { await boot(); return M.incognito.request(String(user), on === true); },
  async pepeSync({ items }) { await boot(); return M.incognito.sync({ items: items || [] }); },
  async privateActivity({ user, on }) { await boot(); await M.pl.save(String(user), { hidden: on ? ["analytics"] : [] }); return {}; },
  async hiddenH({ list, bridge, incog, events, session, sent, explicit }) { await boot(); return M.hidden.noteSync({ list, bridge, incog, events, session, sent, explicit }); },
  async deleteAccount({ user }) {
    await boot();
    const u = (await M.db.getQuery("SELECT userId, username FROM users WHERE userId = ?", [String(user)]))[0];
    if (!u) throw new Error("no such user");
    await M.del.schedule(u, { by: "hubseam-driver" });
    const r = await M.del.execute(String(user), { force: true });
    if (!r.ok) throw new Error("deletion " + r.state);
    const d = (await M.db.getQuery("SELECT id FROM account_deletions WHERE user_id = ? AND state = 'done' ORDER BY id DESC LIMIT 1", [String(user)]))[0];
    return { request: String(d.id) };
  },
  async forget({ user }) { await boot(); const r = await M.forget.request(String(user)); return { ref: String(r.ref) }; },
  async exportAccount({ user }) {
    await boot();
    const r = await M.exp.request(String(user));
    if (!r.ok) throw new Error("export " + (r.code || "refused"));
    return exportWait(r.id);
  },
  async exportResume({ id }) { await boot(); return exportWait(String(id)); },
  async ticket({ user, id }) {
    await boot();
    const K = M.ct.keys();
    if (!K.cur) throw new Error("no ticket key (CHAT_TICKET_KEY / CHAT_TICKET_KID)");
    const u = (await M.db.getQuery("SELECT userId, class, level FROM users WHERE userId = ?", [String(user)]))[0];
    if (!u) throw new Error("no such user");
    const claims = await M.ct.claimsFor(u, String(id), K.cur.kid);
    return { token: M.ct.signJwt(claims, K.cur), claims };
  },
  async sign({ method, path: p, body, skew_s }) {
    await boot();
    const ts = Math.floor(Date.now() / 1000) + (Number(skew_s) || 0);
    const headers = require(path.join(repo, "hubsign")).sign({ method: String(method), path: String(p), body: body == null ? "" : String(body),
                                                               keyId: process.env.HUB_V1_KEY_ID, key: process.env.HUB_V1_KEY, ts });
    return { headers };
  },
  async hubGet({ path: p }) {
    await boot();
    const file = path.join(dir, `hubget-${crypto.randomBytes(4).toString("hex")}.out`);
    const r = await M.ho.getSigned(String(p), { toFile: file, maxBytes: 8 << 20, timeoutMs: 20000 });
    let body = null;
    try { body = fs.readFileSync(file, "utf8"); fs.unlinkSync(file); } catch (e) { body = null; }
    return { ok: !!r.ok, status: r.status, error: r.error || null, body };
  },
  async flush() {
    await boot();
    let posted = 0;
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const r = await M.ho.pumpOnce();
      posted += r.posted || 0;
      if (!(await pending())) break;
      if (r.failed || !r.posted) { await sleep(200); M.ho._resetPoster(); }
    }
    return { posted, pending: await pending() };
  },
  async heartbeat() { await boot(); const r = await M.ho.heartbeatOnce(); return { status: r ? r.status : 0, ok: !!(r && r.ok), error: r ? r.error : "off" }; },
  async faultAfter2xx({ on }) {
    await boot();
    M.ho._setFault(on ? () => process.exit(137) : null);
    return {};
  },
};

let chain = Promise.resolve();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  chain = chain.then(async () => {
    const fn = msg && CMDS[msg.cmd];
    try {
      if (!fn) throw new Error("unknown command " + (msg && msg.cmd));
      const result = await fn(msg.args || {});
      out(JSON.stringify({ id: msg.id, ok: true, result: result === undefined ? null : result }) + "\n");
    } catch (e) {
      process.stderr.write(`hubseam-driver: ${msg && msg.cmd}: ${(e && e.stack) || e}\n`);
      out(JSON.stringify({ id: msg.id, ok: false, error: String((e && e.message) || e).slice(0, 300) }) + "\n");
    }
  });
}).on("close", () => { chain.then(() => { if (server) server.close(); process.exit(0); }); });
