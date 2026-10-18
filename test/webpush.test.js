// 1.99acd: browser notifications (webpush.js, QW-1) - keys from the env (off + one log line without them), the kill switch and
// the audience (by the DB class), the user APIs' guards (same site, fetch, JSON, signed in, a sign-in session), the endpoint
// allow-list (SSRF, exact extra names, the pinned lookup), subscriptions (session-bound, coarse UA, one browser = one account,
// 10 per account, kinds, the instance), the sender (claimed before sending; 2xx / 404 / 410 remove / 401 / 403 keep / 429 +
// Retry-After / 5xx / timeouts / redirects / a sign-in that can't be checked), the content-free encrypted, padded payload and
// its headers (a Topic keyed per browser), localisation, sign-out ending pushes, dedupe / hourly cap / DM gap / grace + read-cancel, per-browser kinds, the
// admin page + settings (Admins only, cleaned, audited), the test pushes, /sw.js, the settings-hub row, health and export.
//   node --test test/webpush.test.js      (temp DB, an injected push-service transport and clock)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "webpush-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) delete process.env[k];
const LOGS = [];
const realLog = console.log;
console.log = (...a) => { LOGS.push(a.join(" ")); realLog(...a); };

const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const C = require(path.join(repo, "webpushcrypto"));
const W = require(path.join(repo, "webpush"));
const S = require(path.join(repo, "sessions"));
const dm = require(path.join(repo, "messages"));
const inbox = require(path.join(repo, "inbox"));
const i18n = require(path.join(repo, "i18n"));

let T = Date.now();
W._setClock(() => T);
const KEYS = C.generate();
const ENV = { VAPID_PUBLIC_KEY: KEYS.publicKey, VAPID_PRIVATE_KEY: KEYS.privateKey, VAPID_SUBJECT: "mailto:ops@example.com" };
const UA_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// the push services: every request recorded; the answer per endpoint (default 201); ON_SEND(url, opts) runs first when set
const SENT = [];
const ANSWER = new Map();
let ON_SEND = null;
const FAKE = async (url, opts) => {
  if (ON_SEND) await ON_SEND(url, opts);
  SENT.push({ url, opts });
  const a = ANSWER.has(url) ? ANSWER.get(url) : 201;
  if (a === "timeout") { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }
  if (a === "net") throw new TypeError("fetch failed");
  const r = typeof a === "object" ? a : { status: a };
  return { status: r.status, headers: { get: (k) => (r.headers || {})[String(k).toLowerCase()] || null } };
};
W._setTransport(FAKE);

// a browser: a push endpoint + its p256dh / auth (and the private key, to read what we sent it)
let EPN = 0;
function browser(host = "fcm.googleapis.com") {
  const e = crypto.createECDH("prime256v1");
  e.generateKeys();
  const endpoint = host === "fcm.googleapis.com" ? `https://fcm.googleapis.com/fcm/send/t${++EPN}:${crypto.randomBytes(12).toString("base64url")}`
                                                 : `https://${host}/push/v2/${++EPN}${crypto.randomBytes(6).toString("hex")}`;
  return { endpoint, priv: e.getPrivateKey(), sub: { endpoint, expirationTime: null, keys: { p256dh: e.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } } };
}
/** What a browser would read from one of our request bodies (RFC 8291, receiver side). */
function open(body, b) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(b.priv);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdh.computeSecret(asPublic), Buffer.from(b.sub.keys.auth, "base64url"),
    Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = out.length - 1;
  while (end >= 0 && out[end] === 0) end--;                 // the padding (zero bytes after the 0x02 delimiter)
  assert.equal(out[end], 0x02, "the last-record delimiter");
  return JSON.parse(out.subarray(0, end).toString("utf8"));
}
const sentTo = (b) => SENT.filter((s) => s.url === b.endpoint);

const U = {}, SID = {};
async function mkUser(name, cls = "pleb") {
  const id = "u_" + name;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cls, name + "cf"]);
  U[name] = { userId: id, username: name, class: cls };
  SID[name] = (await S.create({ get: (h) => (String(h).toLowerCase() === "user-agent" ? UA_CHROME : "") }, id, "password")).id;
}
let base, server;
async function call(p, body, who, o = {}) {
  const h = { "content-type": "application/json", "x-requested-with": "fetch", "user-agent": UA_CHROME };
  Object.assign(h, o.headers || {});
  if (who) { h["x-test-user"] = U[who].userId; if (o.session !== false) h["x-test-session"] = o.session || SID[who]; }
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  const r = await fetch(base + p, { method: o.method || "POST", headers: h, redirect: "manual",
                                    body: (o.method || "POST") === "GET" ? undefined : o.raw !== undefined ? o.raw : JSON.stringify(body === undefined ? {} : body) });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, headers: r.headers };
}
const subRow = async (b) => (await getQuery("SELECT * FROM webpush_subs WHERE endpoint = ?", [b.endpoint]))[0];
const lastRow = async (name) => (await getQuery("SELECT * FROM webpush_outbox WHERE user_id = ? ORDER BY id DESC LIMIT 1", [U[name].userId]))[0];
const rows = async (name) => getQuery("SELECT * FROM webpush_outbox WHERE user_id = ? ORDER BY id", [U[name].userId]);
let CONV = 0;
/** A DM for `name` in a new conversation they're a member of (as messages.js would hand it over). -> the conversation id */
async function dmTo(name, conv = null, mid = null) {
  const c = conv || "conv" + (++CONV);
  await runQuery("INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)", [c, U[name].userId, T]);
  W.onDm(U[name].userId, { conversationId: c, messageId: mid || 1000 + (++CONV) });
  await W._idle();
  return c;
}
const set = (patch) => W.saveSettings(patch, U.boss);

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 5, xp INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0)`);
  await S.init();
  await inbox.ready;
  await dm.init();
  await i18n.ensure();
  await mkUser("boss", "Admin");
  await mkUser("mod", "Staff");
  for (const n of ["ann", "bob", "cat", "dan", "eve", "fay", "gus", "hal", "ivy"]) await mkUser(n);
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.lang = req.get("x-lang") || "en"; next(); });
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    const s = req.get("x-test-session");
    if (u && s) req.loginSession = { id: s, userId: u };
    next();
  };
  app.get("/sw.js", W.serveWorker);                            // index.js mounts it before the session middleware
  W.register(app, { addUser, noTimers: true });
  dm.register(app, { addUser, isBotToken: () => false });       // the /messages page (its ⚙ dialog hosts the widget)
  await W.init();
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { console.log = realLog; if (server) server.close(); });

test("no keys: one clear log line, nothing available, the APIs answer E_OFF", async () => {
  const off = LOGS.filter((l) => l.startsWith("[webpush] off:"));
  assert.equal(off.length, 1, LOGS.join("\n"));
  assert.match(off[0], /^\[webpush\] off: no VAPID key pair \(VAPID_PUBLIC_KEY \/ VAPID_PRIVATE_KEY \/ VAPID_SUBJECT not set\) - node tools\/vapid-keys\.js makes one$/);
  assert.equal(W.keyStatus().configured, false);
  await set({ webpush_enabled: 1 });
  assert.equal(await W.available(U.boss), false, "switched on but no keys");
  const r = await call("/api/push/state", {}, "boss");
  assert.equal(r.status, 404);
  assert.equal(r.d.code, "E_OFF");
  assert.equal(await W.clientConfig(U.boss), null);
  // the admin Overview says so (admins only)
  const AW = require(path.join(repo, "adminweb"));
  const ov = await AW.overview({ userId: "u_boss", class: "Admin" });
  assert.ok(ov.alerts.some((a) => a.level === "warn" && a.href === "/admin/push" && /Web Push is on but has no VAPID keys \(missing\)/.test(a.text)), JSON.stringify(ov.alerts));
  assert.ok(!(await AW.overview({ userId: "u_mod", class: "Staff" })).alerts.some((a) => a.href === "/admin/push"), "not for staff");
  await set({ webpush_enabled: 0 });
  assert.ok(!(await AW.overview({ userId: "u_boss", class: "Admin" })).alerts.some((a) => a.href === "/admin/push"), "off: nothing to say");
});

test("keys loaded; the switch (default off) and the audience decide who gets it (the DB class)", async () => {
  await W._loadKeys(ENV);
  assert.deepEqual(W.keyStatus(), { configured: true, why: null, reason: null, kid: KEYS.kid });
  assert.equal(W.DEFAULTS.webpush_enabled, 0, "ships off");
  assert.equal(await W.available(U.boss), false, "switch off");
  assert.equal((await call("/api/push/state", {}, "boss")).d.code, "E_OFF");
  await set({ webpush_enabled: 1 });
  assert.equal(await W.available(U.boss), true);
  assert.equal(await W.available(U.mod), false, "admins only by default");
  assert.equal(await W.available(U.ann), false);
  assert.equal(await W.available({ userId: "u_ann", class: "Admin" }), false, "the class comes from the database, not the request");
  const st = await call("/api/push/state", {}, "boss");
  assert.equal(st.status, 200);
  assert.deepEqual(st.d, { ok: true, key: KEYS.publicKey, kid: KEYS.kid, kinds: ["dm", "mention", "keyword"], mine: null, others: 0 });
  assert.equal((await call("/api/push/state", {}, "ann")).status, 404);
  await set({ webpush_audience: "staff" });
  assert.equal(await W.available(U.mod), true);
  assert.equal(await W.available(U.ann), false);
  await set({ webpush_audience: "everyone" });
  assert.equal(await W.available(U.ann), true);
  assert.deepEqual(await W.clientConfig(U.ann), { key: KEYS.publicKey, kid: KEYS.kid, kinds: ["dm", "mention", "keyword"] });
});

test("guards: same site, X-Requested-With, JSON, signed in, a sign-in session", async () => {
  assert.equal((await call("/api/push/state", {}, "bob", { headers: { "x-requested-with": "" } })).status, 403);
  assert.equal((await call("/api/push/state", {}, "bob", { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("/api/push/state", null, "bob", { raw: "x", headers: { "content-type": "text/plain" } })).status, 415);
  const out = await call("/api/push/state", {}, null);
  assert.equal(out.status, 401);
  assert.equal(out.d.error, "Sign in first.");
  const nos = await call("/api/push/state", {}, "bob", { session: false });
  assert.equal(nos.status, 401);
  assert.equal(nos.d.error, "Sign in again.");
  assert.equal((await call("/api/push/state", {}, "bob")).headers.get("cache-control"), "no-store");
});

test("endpoints: only known push services over https (an SSRF guard); webpush_hosts_extra adds one", async () => {
  const cfg = await W.config();
  for (const bad of ["http://fcm.googleapis.com/fcm/send/x", "https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://[::1]/x",
                     "https://fcm.googleapis.com:8443/fcm/send/x", "https://evil.example/x", "https://user:pw@fcm.googleapis.com/fcm/send/x",
                     "https://fcm.googleapis.com/x#frag", "https://notify.windows.com/w", "https://evilnotify.windows.com/w", "https://push.apple.com.evil.example/x",
                     "javascript:alert(1)", "", null, 42, "https://fcm.googleapis.com/" + "a".repeat(1100)]) {
    assert.equal(W.endpointOk(bad, cfg), false, String(bad).slice(0, 60));
  }
  for (const good of ["https://fcm.googleapis.com/fcm/send/abc:def", "https://fcm.googleapis.com:443/wp/abc", "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
                      "https://web.push.apple.com/QHvK1", "https://api.push.apple.com/3/x", "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB"]) {
    assert.equal(W.endpointOk(good, cfg), true, good);
  }
  const r = await call("/api/push/subscribe", { subscription: { endpoint: "https://evil.example/x", keys: browser().sub.keys }, kinds: ["dm"] }, "bob");
  assert.equal(r.status, 400);
  assert.equal(r.d.code, "E_ENDPOINT");
  await set({ webpush_hosts_extra: "push.example.net, push2.example.org" });
  assert.equal(W.endpointOk("https://push.example.net/x", await W.config()), true);
  assert.equal(W.endpointOk("https://push2.example.org/x", await W.config()), true);
  assert.equal(W.endpointOk("https://eu.push.example.net/x", await W.config()), false, "exact names: no sub-domains");
  // never a wildcard (*.nip.io / *.ts.net would let a member pick a name that resolves to any address)
  for (const w of ["*.push.example.org", "*.nip.io", "*.ts.net"]) await assert.rejects(set({ webpush_hosts_extra: w }), (e) => e.status === 400 && /no wildcards/.test(e.message), w);
  assert.deepEqual(W.cleanHosts("*.nip.io, push.example.net"), { ok: ["push.example.net"], bad: ["*.nip.io"] }, "a stored wildcard is dropped");
  await assert.rejects(set({ webpush_hosts_extra: "10.0.0.1" }), (e) => e.status === 400 && /10\.0\.0\.1/.test(e.message));
  await assert.rejects(set({ webpush_hosts_extra: "push.example.net:8443" }), (e) => e.status === 400);
  await set({ webpush_hosts_extra: "" });
  assert.equal(W.endpointOk("https://push.example.net/x", await W.config()), false);
});

test("subscribe: bound to the sign-in, coarse browser, language, key id; kinds checked; one browser = one account; 10 per account", async () => {
  const b1 = browser();
  const r = await call("/api/push/subscribe", { subscription: b1.sub, kinds: ["keyword", "dm", "mention"] }, "ann", { headers: { "x-lang": "es" } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.d, { ok: true, kinds: ["dm", "mention", "keyword"], others: 0 });
  const row = await subRow(b1);
  assert.equal(row.user_id, "u_ann");
  assert.equal(row.session_id, SID.ann);
  assert.equal(row.ua, "Chrome on Windows", "never the raw user agent");
  assert.equal(row.locale, "es");
  assert.equal(row.vapid_kid, KEYS.kid);
  assert.equal(row.kinds, "dm,mention,keyword");
  assert.ok(W._subsUsers.has("u_ann"));
  const st = await call("/api/push/state", { endpoint: b1.endpoint }, "ann");
  assert.deepEqual(st.d.mine, { known: true, kinds: ["dm", "mention", "keyword"] });
  // kinds: a non-empty subset of what's offered
  for (const kinds of [[], ["reply"], ["dm", "test"], "dm", null]) {
    const k = await call("/api/push/subscribe", { subscription: b1.sub, kinds }, "ann");
    assert.equal(k.status, 400, JSON.stringify(kinds));
    assert.equal(k.d.code, "E_KINDS");
  }
  assert.deepEqual((await call("/api/push/subscribe", { subscription: b1.sub, kinds: ["dm", "dm"] }, "ann")).d.kinds, ["dm"]);
  const bad = await call("/api/push/subscribe", { subscription: { endpoint: b1.endpoint, keys: { p256dh: "AAAA", auth: b1.sub.keys.auth } }, kinds: ["dm"] }, "ann");
  assert.equal(bad.d.code, "E_KEYS");
  // the same browser, now signed in as cat: it's cat's (a new created), and no longer ann's
  const created0 = (await subRow(b1)).created;
  T += 5000;
  assert.equal((await call("/api/push/subscribe", { subscription: b1.sub, kinds: ["dm", "mention"] }, "cat")).status, 200);
  const moved = await subRow(b1);
  assert.equal(moved.user_id, "u_cat");
  assert.equal(moved.session_id, SID.cat);
  assert.ok(moved.created > created0);
  assert.ok(!W._subsUsers.has("u_ann"), "ann has no browser left");
  assert.equal((await call("/api/push/state", { endpoint: b1.endpoint }, "cat")).d.mine.known, true);
  // (ann asking about that endpoint now would mean the browser changed hands back - see the hand-over test)
  // 10 per account: the 11th pushes out the one used longest ago
  const hal = [];
  for (let i = 0; i < 11; i++) {
    T += 1000;
    const b = browser(i % 2 ? "updates.push.services.mozilla.com" : "fcm.googleapis.com");
    hal.push(b);
    assert.equal((await call("/api/push/subscribe", { subscription: b.sub, kinds: ["dm"] }, "hal")).status, 200);
  }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM webpush_subs WHERE user_id = 'u_hal'"))[0].n, W.SUBS_MAX);
  assert.equal(await subRow(hal[0]), undefined, "the oldest went");
  assert.ok(await subRow(hal[10]));
  assert.equal((await call("/api/push/state", { endpoint: hal[10].endpoint }, "hal")).d.others, 9);
});

test("unsubscribe: this browser, or every browser of the account - never someone else's", async () => {
  const d1 = browser(), d2 = browser(), e1 = browser();
  await call("/api/push/subscribe", { subscription: d1.sub, kinds: ["dm"] }, "dan");
  await call("/api/push/subscribe", { subscription: d2.sub, kinds: ["dm"] }, "dan");
  await call("/api/push/subscribe", { subscription: e1.sub, kinds: ["dm"] }, "eve");
  assert.equal((await call("/api/push/unsubscribe", { endpoint: e1.endpoint }, "dan")).d.removed, 0);
  assert.ok(await subRow(e1), "eve's browser is untouched");
  assert.equal((await call("/api/push/unsubscribe", { endpoint: d1.endpoint }, "dan")).d.removed, 1);
  assert.equal((await call("/api/push/unsubscribe", { all: true }, "dan")).d.removed, 1);
  assert.equal(await subRow(d2), undefined);
  assert.ok(!W._subsUsers.has("u_dan"));
  assert.equal((await call("/api/push/unsubscribe", {}, "dan")).status, 400);
});

test("the sender: 201 = sent (last_ok, devices), with an encrypted, content-free payload and the right headers", async () => {
  const f1 = browser();
  await call("/api/push/subscribe", { subscription: f1.sub, kinds: ["dm", "mention", "keyword"] }, "fay");
  SENT.length = 0;
  const c = await dmTo("fay");
  assert.equal(SENT.length, 0, "nothing goes out before the sender runs");
  await W.drain();
  const row = await lastRow("fay");
  assert.equal(row.outcome, "sent");
  assert.equal(row.devices, 1);
  assert.equal(row.src_key, `dm:${c}:${1000 + CONV}`);
  assert.equal((await subRow(f1)).last_ok, T);
  const req = sentTo(f1)[0];
  assert.equal(req.opts.method, "POST");
  assert.equal(req.opts.redirect, "manual", "redirects are never followed");
  const h = req.opts.headers;
  assert.equal(h.TTL, "86400");
  assert.equal(h.Urgency, "high");
  assert.match(h.Topic, /^[A-Za-z0-9_-]{1,32}$/);
  assert.equal(h["Content-Encoding"], "aes128gcm");
  assert.equal(h["Content-Type"], "application/octet-stream");
  assert.match(h.Authorization, new RegExp("^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=" + KEYS.publicKey + "$"));
  assert.ok(!JSON.stringify(h).includes(KEYS.privateKey));
  const p = open(req.opts.body, f1);
  assert.deepEqual(Object.keys(p).sort(), ["b", "d", "k", "t", "tag", "ts", "u", "v"]);
  assert.deepEqual({ v: p.v, k: p.k, t: p.t, b: p.b, u: p.u, tag: p.tag, d: p.d },
                   { v: 1, k: "dm", t: "New message", b: "Open PATV to see it.", u: `/messages/c/${c}`, tag: `dm:${c}`, d: "ltr" });
  assert.equal(p.ts, row.created);
});

test("the sender: 404 / 410 remove the subscription; 401 / 403 keep it (our VAPID signature refused); 302 is not followed", async () => {
  for (const status of [410, 404]) {
    const b = browser();
    await call("/api/push/subscribe", { subscription: b.sub, kinds: ["dm"] }, "gus");
    ANSWER.set(b.endpoint, status);
    await dmTo("gus");
    await W.drain();
    assert.equal((await lastRow("gus")).outcome, "gone", String(status));
    assert.equal(await subRow(b), undefined, status + " removes it");
  }
  // 403: Apple BadJwtToken / ExpiredJwtToken, WNS and FCM credential errors - OUR side (subject, key, clock). Kept, counted,
  // alerted, logged: a signing problem must never wipe every Safari / Edge subscription.
  const AW = require(path.join(repo, "adminweb"));
  const b3 = browser("web.push.apple.com");
  await call("/api/push/subscribe", { subscription: b3.sub, kinds: ["dm"] }, "gus");
  ANSWER.set(b3.endpoint, { status: 403, headers: {} });
  await dmTo("gus");
  await W.drain();
  assert.equal((await lastRow("gus")).outcome, "failed");
  const k3 = await subRow(b3);
  assert.ok(k3, "403 never removes the subscription");
  assert.equal(k3.fail_count, 1, "counted (the long-dead sweep can still clear a row that only ever gets 403)");
  assert.equal(k3.last_error, "403");
  let h = await W.health();
  assert.equal(h.vapidErrorAt, T);
  assert.equal(h.vapidErrorStatus, 403);
  assert.equal(h.removed["403"], undefined);
  assert.ok(LOGS.some((l) => /^\[webpush\] web\.push\.apple\.com refused our VAPID signature \(403\) .*the subscription is kept$/.test(l)));
  assert.ok((await AW.overview({ userId: "u_boss", class: "Admin" })).alerts.some((a) => a.text === "A push service refused our VAPID signature (403) in the last hour"));
  T += 31e3;
  await dmTo("gus");
  await W.drain();
  assert.equal((await subRow(b3)).fail_count, 2, "still kept");
  await call("/api/push/unsubscribe", { endpoint: b3.endpoint }, "gus");
  const b = browser();
  await call("/api/push/subscribe", { subscription: b.sub, kinds: ["dm"] }, "gus");
  ANSWER.set(b.endpoint, 401);
  await dmTo("gus");
  await W.drain();
  assert.equal((await lastRow("gus")).outcome, "failed");
  const kept = await subRow(b);
  assert.ok(kept, "401 is our problem - the row stays");
  assert.equal(kept.fail_count, 0);
  h = await W.health();
  assert.equal(h.vapidErrorAt, T);
  assert.equal(h.vapidErrorStatus, 401);
  assert.ok(LOGS.some((l) => /refused our VAPID signature \(401\)/.test(l)));
  ANSWER.set(b.endpoint, 302);
  SENT.length = 0;
  await dmTo("gus");
  await W.drain();
  assert.equal((await lastRow("gus")).outcome, "failed");
  assert.equal(sentTo(b).length, 1, "one request, the redirect not followed");
  assert.equal((await subRow(b)).fail_count, 1);
  assert.equal((await subRow(b)).last_error, "302");
  await call("/api/push/unsubscribe", { all: true }, "gus");
});

test("the sender: 429 (Retry-After) / 5xx / timeouts retry at 30 s, 2 min, 10 min, then give up", async () => {
  await call("/api/push/unsubscribe", { all: true }, "eve");
  const b = browser("updates.push.services.mozilla.com");
  await call("/api/push/subscribe", { subscription: b.sub, kinds: ["dm"] }, "eve");
  ANSWER.set(b.endpoint, { status: 429, headers: { "retry-after": "120" } });
  SENT.length = 0;
  await dmTo("eve");
  await W.drain();
  let r = await lastRow("eve");
  assert.equal(r.sent_at, null);
  assert.equal(r.tries, 1);
  assert.equal(r.due_at, T + 120e3, "Retry-After (120 s) beats the 30 s step");
  T += 60e3;
  await W.drain();
  assert.equal(sentTo(b).length, 1, "not due yet");
  T += 60e3;
  ANSWER.set(b.endpoint, 500);
  await W.drain();
  r = await lastRow("eve");
  assert.equal(r.tries, 2);
  assert.equal(r.due_at, T + W.RETRY_STEPS[1]);
  T += W.RETRY_STEPS[1];
  ANSWER.set(b.endpoint, "timeout");
  await W.drain();
  r = await lastRow("eve");
  assert.equal(r.tries, 3);
  assert.equal(r.due_at, T + W.RETRY_STEPS[2]);
  assert.equal((await subRow(b)).last_error, "timeout");
  T += W.RETRY_STEPS[2];
  ANSWER.set(b.endpoint, 503);
  await W.drain();
  r = await lastRow("eve");
  assert.equal(r.outcome, "failed");
  assert.equal(r.tries, 4);
  assert.equal(sentTo(b).length, 4);
  assert.equal((await subRow(b)).fail_count, 4, "kept, counted");
  // a timeout, then the push service is back: sent on the retry
  ANSWER.set(b.endpoint, "net");
  await dmTo("eve");
  await W.drain();
  assert.equal((await lastRow("eve")).tries, 1);
  ANSWER.delete(b.endpoint);
  T += W.RETRY_STEPS[0];
  await W.drain();
  assert.equal((await lastRow("eve")).outcome, "sent");
  assert.equal((await subRow(b)).fail_count, 0);
});

test("localised per device: the account's language (a translated title), RTL for Arabic, English as the fallback", async () => {
  const b = browser();
  await call("/api/push/subscribe", { subscription: b.sub, kinds: ["dm"] }, "gus", { headers: { "x-lang": "fr" } });
  assert.equal(i18n.setOverrides({ es: { "push.generic.dm": "Nuevo mensaje" } }), 1);
  await i18n.savePref("u_gus", "es");
  SENT.length = 0;
  await dmTo("gus");
  await W.drain();
  assert.equal(open(sentTo(b)[0].opts.body, b).t, "Nuevo mensaje");
  await i18n.savePref("u_gus", "ar");
  T += 31e3;
  await dmTo("gus");
  await W.drain();
  const ar = open(sentTo(b)[1].opts.body, b);
  assert.equal(ar.d, "rtl");
  assert.equal(typeof ar.t, "string");
  await i18n.savePref("u_gus", null);
  i18n.setOverrides({});
  T += 31e3;
  await dmTo("gus");
  await W.drain();
  const fr = open(sentTo(b)[2].opts.body, b);
  assert.equal(fr.d, "ltr");
  assert.ok(fr.t.length > 0, "the browser's language at subscribe time (fr), English where it isn't translated yet");
  await call("/api/push/unsubscribe", { all: true }, "gus");
});

test("signing a browser out ends its pushes; the sweep removes subscriptions of ended sign-ins", async () => {
  const b = browser();
  await call("/api/push/subscribe", { subscription: b.sub, kinds: ["dm"] }, "ivy");
  await S.revoke("u_ivy", SID.ivy);
  SENT.length = 0;
  await dmTo("ivy");
  await W.drain();
  assert.equal(sentTo(b).length, 0, "nothing sent to a signed-out browser");
  assert.equal((await lastRow("ivy")).outcome, "nodevice");
  assert.equal(await subRow(b), undefined);
  // the sweep: a session that expired (or was revoked) in another process
  const e = browser();
  await call("/api/push/subscribe", { subscription: e.sub, kinds: ["dm"] }, "eve");
  await runQuery("UPDATE sessions SET expires = ? WHERE id = ?", [T - 1000, SID.eve]);
  const keep = browser();
  await call("/api/push/subscribe", { subscription: keep.sub, kinds: ["dm"] }, "bob");
  await W.sweep(T);
  assert.equal(await subRow(e), undefined);
  assert.ok(await subRow(keep), "a live sign-in's browser stays");
  assert.ok(!W._subsUsers.has("u_eve"));
});

test("dedupe, the hourly cap, one DM push per conversation per gap, the grace and read-cancel", async () => {
  // bob has a browser (previous test)
  const m = { kind: "mention", roomId: null, ctx: "post", url: "/feed/p/1", srcKey: "fmention:p:1:u_bob" };
  W.onMention("u_bob", m);
  W.onMention("u_bob", m);
  await W._idle();
  assert.equal((await rows("bob")).filter((r) => r.src_key === m.srcKey).length, 1, "same src_key: one row");
  // the DM gap
  const before = (await rows("bob")).length;
  await dmTo("bob", "gapc", 1);
  await dmTo("bob", "gapc", 2);
  assert.equal((await rows("bob")).length, before + 1, "a burst in one conversation: one push");
  T += 31e3;
  await dmTo("bob", "gapc", 3);
  assert.equal((await rows("bob")).length, before + 2, "after the gap: another");
  // the hourly cap
  const n = (await getQuery("SELECT COUNT(*) AS n FROM webpush_outbox WHERE user_id = 'u_bob' AND created > ? AND kind != 'test'", [T - 3600e3]))[0].n;
  await set({ webpush_hour_max: n + 1 });
  await dmTo("bob");
  await dmTo("bob");
  assert.equal((await rows("bob")).length, before + 3, "one more, then capped");
  await set({ webpush_hour_max: 60 });
  await W.drain();
  // grace + read-cancel
  await set({ webpush_grace_dm_s: 10 });
  SENT.length = 0;
  await dmTo("bob", "graceC", 500);
  let r = await lastRow("bob");
  assert.equal(r.due_at, T + 10e3);
  await W.drain();
  assert.equal(SENT.length, 0, "waits for the grace");
  await runQuery("UPDATE conversation_members SET last_read_id = 500 WHERE conversation_id = 'graceC' AND user_id = 'u_bob'");
  T += 11e3;
  await W.drain();
  r = await lastRow("bob");
  assert.equal(r.outcome, "read");
  assert.equal(SENT.length, 0, "read on the site first: no push");
  // muted by the time it's due: no push either
  await dmTo("bob", "muteC", 600);
  await runQuery("UPDATE conversation_members SET muted = 1 WHERE conversation_id = 'muteC' AND user_id = 'u_bob'");
  T += 11e3;
  await W.drain();
  assert.equal((await lastRow("bob")).outcome, "read");
  await set({ webpush_grace_dm_s: 0 });
});

test("per-browser kinds, the per-kind switches and the kill switch; the admin test works while it's off", async () => {
  const d3 = browser();
  await call("/api/push/subscribe", { subscription: d3.sub, kinds: ["dm"] }, "dan");
  W.onMention("u_dan", { kind: "mention", roomId: null, ctx: "comment", url: "/feed/p/2", srcKey: "fmention:c:9:u_dan" });
  await W._idle();
  assert.equal((await lastRow("dan")).due_at, T + 15e3, "a mention waits its grace (15 s)");
  SENT.length = 0;
  T += 15e3;
  await W.drain();
  assert.equal((await lastRow("dan")).outcome, "nodevice", "a dm-only browser gets no mention push");
  assert.equal(SENT.length, 0);
  await set({ webpush_kind_mention: 0 });
  const k0 = (await rows("dan")).length;
  W.onMention("u_dan", { kind: "mention", roomId: null, ctx: "post", url: "/feed/p/3", srcKey: "fmention:p:3:u_dan" });
  await W._idle();
  assert.equal((await rows("dan")).length, k0, "an off kind isn't queued");
  assert.deepEqual((await call("/api/push/state", {}, "dan")).d.kinds, ["dm", "keyword"], "nor offered");
  await set({ webpush_kind_mention: 1 });
  // the admin's own browser, made while it's on
  const bb = browser();
  await call("/api/push/subscribe", { subscription: bb.sub, kinds: ["dm"] }, "boss");
  // a due push, then the kill switch: dropped as "off"
  await dmTo("dan");
  await set({ webpush_enabled: 0 });
  SENT.length = 0;
  await W.drain();
  assert.equal((await lastRow("dan")).outcome, "off");
  assert.equal(SENT.length, 0);
  assert.equal((await call("/api/push/state", {}, "dan")).d.code, "E_OFF");
  assert.ok(await subRow(d3), "subscriptions are kept while off");
  const t = await call("/api/admin/push/test", {}, "boss");
  assert.equal(t.status, 200, t.text);
  assert.equal(t.d.devices, 1);
  await W.drain();
  const p = open(sentTo(bb)[0].opts.body, bb);
  assert.equal(p.k, "test");
  assert.equal(p.u, "/messages?settings=1#push");
  assert.equal(p.t, "PATV notifications work");
  assert.equal(sentTo(bb)[0].opts.headers.TTL, "60");
  await set({ webpush_enabled: 1 });
});

test("a member's test push: their own browser only, 3 per 10 minutes", async () => {
  const c1 = (await getQuery("SELECT endpoint FROM webpush_subs WHERE user_id = 'u_cat'"))[0].endpoint;
  assert.equal((await call("/api/push/test", { endpoint: c1 }, "ann")).status, 404, "not ann's browser");
  for (let i = 0; i < 3; i++) assert.equal((await call("/api/push/test", { endpoint: c1 }, "cat")).d.queued, true);
  const fourth = await call("/api/push/test", { endpoint: c1 }, "cat");
  assert.equal(fourth.status, 429);
  assert.equal(fourth.d.code, "E_RATE");
  await W.drain();
});

test("admin: Admins only (page + settings API), settings cleaned + audited + logged", async () => {
  for (const who of ["mod", "ann"]) {
    assert.equal((await call("/api/admin/push/settings", { settings: { webpush_enabled: 0 } }, who)).status, 403, who);
    assert.equal((await call("/admin/push", null, who, { method: "GET" })).status, 403, who);
    assert.equal((await call("/api/admin/push/test", {}, who)).status, 403, who);
  }
  assert.equal((await call("/admin/push", null, null, { method: "GET" })).status, 302, "signed out -> sign in");
  const page = await call("/admin/push", null, "boss", { method: "GET" });
  assert.equal(page.status, 200);
  assert.match(page.text, /Web Push/);
  assert.match(page.text, new RegExp("key id " + KEYS.kid));
  assert.match(page.text, /id="settings"/);
  assert.match(page.text, /id="health"/);
  assert.match(page.text, /id="test"/);
  assert.ok(!page.text.includes(KEYS.privateKey), "never the private key");
  assert.ok(!/fcm\/send\//.test(page.text), "never an endpoint");
  assert.equal((await call("/api/admin/push/settings", { settings: {} }, "boss", { headers: { "x-requested-with": "" } })).status, 403);
  const s = await call("/api/admin/push/settings", { settings: { webpush_grace_mention_s: 9999, webpush_hour_max: "0", webpush_late_s: 5, webpush_kind_keyword: false } }, "boss");
  assert.equal(s.status, 200, s.text);
  assert.equal(s.d.settings.webpush_grace_mention_s, 600, "clamped");
  assert.equal(s.d.settings.webpush_hour_max, 1);
  assert.equal(s.d.settings.webpush_late_s, 30);
  assert.equal(s.d.settings.webpush_kind_keyword, 0);
  assert.equal((await W.settingsView()).webpush_grace_mention_s, 600);
  assert.equal((await call("/api/admin/push/settings", { settings: { webpush_hosts_extra: "169.254.169.254" } }, "boss")).status, 400);
  assert.equal((await call("/api/admin/push/settings", { settings: { webpush_audience: "anyone" } }, "boss")).status, 400);
  const a = await getQuery("SELECT * FROM admin_audit WHERE action = 'webpush.settings' ORDER BY id DESC LIMIT 1");
  assert.equal(a[0].admin_id, "u_boss");
  assert.deepEqual(JSON.parse(a[0].detail).changes.webpush_grace_mention_s, [15, 600]);
  assert.ok(LOGS.some((l) => /^\[webpush\] settings saved by boss: .*grace_mention_s 15->600/.test(l)));
  assert.ok(LOGS.some((l) => /^\[webpush\] settings saved by boss: enabled off->on/.test(l)));
  await set({ webpush_grace_mention_s: 15, webpush_hour_max: 60, webpush_late_s: 120, webpush_kind_keyword: 1 });
});

test("the /messages page: the ⚙ dialog's Browser notifications section + its script only while it's offered", async () => {
  const on = await call("/messages", null, "cat", { method: "GET" });
  assert.equal(on.status, 200, on.text.slice(0, 300));
  assert.match(on.text, new RegExp('<fieldset id="push" data-push data-key="' + KEYS.publicKey + '" data-kid="' + KEYS.kid + '" data-kinds="dm,mention,keyword">'));
  for (const k of ["dm", "mention", "keyword"]) assert.match(on.text, new RegExp('<input type="checkbox" data-kind="' + k + '" checked>'));
  assert.match(on.text, /<script src="\/public\/js\/webpush\.js\?v=1" defer><\/script>/);
  assert.match(on.text, /Browser notifications/);
  await set({ webpush_audience: "admins" });
  const off = await call("/messages", null, "cat", { method: "GET" });
  assert.equal(off.status, 200);
  assert.doesNotMatch(off.text, /data-key=|data-kinds=/, "not offered: no widget");
  assert.match(off.text, /<fieldset id="push" data-push data-push-off>/, "but cat still has a browser saved: only Turn off everywhere");
  assert.match(off.text, /1 browser of yours is still saved/);
  const none = await call("/messages", null, "ann", { method: "GET" });
  assert.doesNotMatch(none.text, /data-push|public\/js\/webpush\.js/, "not offered, nothing saved: nothing on the page");
  await set({ webpush_audience: "everyone" });
});

test("the admin nav: a Web Push section whose links are admin-only", () => {
  const nav = fs.readFileSync(path.join(repo, "views", "partials", "admin-nav.ejs"), "utf8");
  assert.match(nav, /\['push', '\/admin\/push', '🔔', 'Web Push', \[\['#settings', 'Settings', 1\], \['#health', 'Delivery', 1\], \['#test', 'Test', 1\]\]\]/);
});

test("GET /sw.js: the service worker at the root, JavaScript, revalidated every time", async () => {
  const r = await call("/sw.js", null, null, { method: "GET" });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^application\/javascript/);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.text, /addEventListener\('push'/);
});

test("the /settings hub: a Browser notifications row only while it's offered, linking to the dialog's #push", async () => {
  const HUB = require(path.join(repo, "settingshub"));
  const find = async (u) => (await HUB.hub(u)).find((s) => s.id === "notify").entries.find((e) => e.id === "push");
  const e = await find(U.cat);
  assert.ok(e, "cat has it");
  assert.equal(e.href, "/messages?settings=1#push");
  assert.equal(e.state.k, "sethub.st.push_n");
  assert.equal(e.state.v.count, 1);
  assert.equal((await find(U.ann)).state.k, "sethub.st.off", "no browser on yet: Off");
  await set({ webpush_audience: "admins" });
  const out = await find(U.cat);
  assert.ok(out, "out of the audience but a browser saved: the row stays, so it can be turned off");
  assert.equal(out.state.k, "sethub.st.push_n");
  assert.equal(out.state.v.count, 1);
  assert.equal(await find(U.ann), undefined, "out of the audience, nothing saved: no row");
  await set({ webpush_audience: "everyone" });
  assert.match(fs.readFileSync(path.join(repo, "views", "messages.ejs"), "utf8"), /<fieldset id="push" data-push/, "the #push target exists");
});

test("health and the data export: plain numbers, the push service's host - never an endpoint path or a key", async () => {
  const h = await W.health();
  assert.equal(h.keys.configured, true);
  assert.ok(h.totals.sent >= 3);
  assert.ok(h.subs.total >= 3);
  assert.ok(h.subs.browsers.Chrome >= 1);
  assert.ok(h.hosts.fcm["2xx"] >= 1);
  const hs = JSON.stringify(h);
  assert.ok(!/fcm\/send|p256dh|auth"/.test(hs));
  const x = await W.exportFor("u_cat");
  assert.equal(x.length, 1);
  assert.deepEqual(Object.keys(x[0]).sort(), ["browser", "created", "id", "kinds", "last_ok", "locale", "push_service"]);
  assert.equal(x[0].push_service, "fcm.googleapis.com");
  assert.equal(x[0].browser, "Chrome on Windows");
  assert.ok(!JSON.stringify(x).includes("/fcm/send/"));
});

// ── review fixes (1.99acd) ──

test("GET /sw.js is mounted before the session / activity middleware: a browser's own fetch never extends a sign-in", async () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const sw = src.indexOf('app.get("/sw.js", require("./webpush").serveWorker)');
  assert.ok(sw > 0, "index.js mounts serveWorker");
  for (const later of ["app.use(cookieParser(", "app.use(loginSessions.gate)", "app.use(inbox.navCount)", "app.use(messages.navCount)",
                       "app.use(require(\"./follows\").navPads)", "app.use(welcome.middleware(", "app.use(stale.noticeMiddleware(", "app.use(i18n.middleware(",
                       "app.use(tz.middleware("]) {
    const i = src.indexOf(later);
    assert.ok(i > sw, later + " comes after /sw.js");
  }
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "webpush.js"), "utf8"), /app\.get\("\/sw\.js"/, "register() no longer mounts it (late, after the middleware)");
  // the same order on a small app: a valid sign-in cookie on /sw.js leaves the session alone; a page view touches it (the control)
  const cookieParser = require("cookie-parser");
  const jwt = require("jsonwebtoken");
  const s = await S.create({ get: () => "" }, "u_boss", "password");
  const old = Date.now() - 2 * 86400e3;
  await runQuery("UPDATE sessions SET last_seen = ?, expires = ? WHERE id = ?", [old, old + 30 * 86400e3, s.id]);
  S._clearCache();
  const app2 = express();
  app2.get("/sw.js", W.serveWorker);
  app2.use(cookieParser());
  app2.use(S.gate);
  app2.get("/page", (req, res) => res.send(req.loginSession ? "in" : "out"));
  const srv = app2.listen(0);
  const b2 = "http://127.0.0.1:" + srv.address().port;
  const cookie = "jwt=" + jwt.sign({ userId: "u_boss", username: "boss", class: "Admin", sid: s.sid }, process.env.SECRET_KEY);
  try {
    const r = await fetch(b2 + "/sw.js", { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /addEventListener\('push'/);
    assert.equal(r.headers.get("set-cookie"), null);
    await new Promise((ok) => setTimeout(ok, 50));
    let row = (await getQuery("SELECT last_seen, expires FROM sessions WHERE id = ?", [s.id]))[0];
    assert.equal(row.last_seen, old, "/sw.js doesn't touch the sign-in");
    assert.equal(row.expires, old + 30 * 86400e3, "nor push its expiry out");
    const p = await fetch(b2 + "/page", { headers: { cookie } });
    assert.equal(await p.text(), "in");
    await new Promise((ok) => setTimeout(ok, 50));               // touchSeen is fire-and-forget
    row = (await getQuery("SELECT last_seen FROM sessions WHERE id = ?", [s.id]))[0];
    assert.ok(row.last_seen > old, "a page view does");
  } finally { srv.close(); }
});

test("the sender claims a row before it sends: a failed write after the push service took it never sends it twice; the sweep closes it", async () => {
  await mkUser("kim");
  const b = browser();
  await call("/api/push/subscribe", { subscription: b.sub, kinds: ["dm"] }, "kim");
  // claimed (sending, sent_at set) by the time the push service is asked
  let seen = null;
  ON_SEND = async (url) => { if (url === b.endpoint) seen = await lastRow("kim"); };
  await dmTo("kim");
  await W.drain();
  ON_SEND = null;
  assert.equal(seen.outcome, "sending");
  assert.ok(seen.sent_at > 0);
  assert.equal((await lastRow("kim")).outcome, "sent");
  // every write after the claim fails (SQLITE_BUSY past the retries, a rolled-back transaction): the row stays taken
  await runQuery(`CREATE TRIGGER wp_test_busy BEFORE UPDATE OF outcome ON webpush_outbox WHEN NEW.outcome IS NOT 'sending'
                  BEGIN SELECT RAISE(ABORT, 'test: the write failed'); END`);
  try {
    SENT.length = 0;
    T += 31e3;
    await dmTo("kim");
    await W.drain();
    assert.equal(sentTo(b).length, 1, "sent once");
    const r = await lastRow("kim");
    assert.equal(r.outcome, "sending", "the finishing write failed");
    assert.ok(r.sent_at > 0);
    await W.drain();
    T += 5000;
    await W.drain();
    assert.equal(sentTo(b).length, 1, "never re-picked: no duplicate buzz");
  } finally { await runQuery("DROP TRIGGER IF EXISTS wp_test_busy"); }
  const stuck = await lastRow("kim");
  await W.sweep(T + 60e3);
  assert.equal((await getQuery("SELECT outcome FROM webpush_outbox WHERE id = ?", [stuck.id]))[0].outcome, "sending", "not yet");
  await W.sweep(Number(stuck.sent_at) + W.STUCK_MS + 1);
  assert.equal((await getQuery("SELECT outcome FROM webpush_outbox WHERE id = ?", [stuck.id]))[0].outcome, "failed", "closed by the sweep");
  // a row another process already claimed is left alone
  await runQuery(`INSERT INTO webpush_outbox (user_id, kind, src_key, url, tag, check_ref, due_at, created, sent_at, outcome)
                  VALUES ('u_kim', 'dm', 'dm:other:1', '/messages/c/other', 'dm:other', 'dm:other:1', ?, ?, ?, 'sending')`, [T, T, T]);
  SENT.length = 0;
  await W.drain();
  assert.equal(sentTo(b).length, 0);
});

test("the Topic header is keyed per browser: one conversation's members get unrelated values, one browser keeps its own; payloads are one size", async () => {
  const x = browser(), y = browser();
  await call("/api/push/subscribe", { subscription: x.sub, kinds: ["dm"] }, "ann");
  await call("/api/push/subscribe", { subscription: y.sub, kinds: ["dm"] }, "mod");
  SENT.length = 0;
  await dmTo("ann", "topicC", 7001);
  await dmTo("mod", "topicC", 7001);
  await W.drain();
  const tx = sentTo(x)[0].opts.headers.Topic, ty = sentTo(y)[0].opts.headers.Topic;
  assert.match(tx, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(tx, ty, "the same conversation, two members: unrelated topics");
  assert.equal(tx, W._topicOf("dm:topicC", x.sub.keys.auth), "HMAC(this browser's auth, tag): the same browser + tag collapse");
  assert.notEqual(tx, crypto.createHash("sha256").update("dm:topicC").digest("base64url").slice(0, 32), "never the plain hash of the tag");
  assert.notEqual(W._topicOf("mention:Mention.Room", x.sub.keys.auth), W._topicOf("mention:Mention.Room", y.sub.keys.auth));
  // the body length doesn't follow the payload: a DM and a test push (longer text) are the same size
  assert.equal(sentTo(x)[0].opts.body.length, 86 + W.PAD_TO + 16);
  await W.queueTest("u_ann");
  await W.drain();
  assert.equal(sentTo(x)[1].opts.body.length, sentTo(x)[0].opts.body.length);
  assert.equal(open(sentTo(x)[1].opts.body, x).k, "test");
});

test("the transport: a push service name resolving to a private address is refused before connecting (addr, not retried)", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.4", "192.168.0.20", "169.254.169.254", "100.64.0.1", "100.127.255.254", "0.0.0.0", "::1", "::",
                    "fd00::1", "fc12::5", "fe80::1", "::ffff:10.0.0.5", "::ffff:7f00:1", "224.0.0.1", "255.255.255.255", "", "junk"]) {
    assert.equal(W.blockedAddr(ip), true, ip);
  }
  for (const ip of ["142.250.80.42", "17.253.144.10", "2607:f8b0:4004:c07::5f", "::ffff:8.8.8.8", "100.128.0.1", "172.32.0.1"]) assert.equal(W.blockedAddr(ip), false, ip);
  // the lookup keeps only public answers, and refuses a name with none
  W._setLookup((host, o, cb) => cb(null, [{ address: "10.0.0.5", family: 4 }, { address: "93.184.216.34", family: 4 }]));
  const pick = await new Promise((ok, no) => W._pinnedLookup("push.example.net", { all: true }, (e, a) => (e ? no(e) : ok(a))));
  assert.deepEqual(pick, [{ address: "93.184.216.34", family: 4 }]);
  W._setLookup((host, o, cb) => cb(null, [{ address: "10.0.0.5", family: 4 }, { address: "fd00::7", family: 6 }]));
  await assert.rejects(new Promise((ok, no) => W._pinnedLookup("push.example.net", {}, (e, a) => (e ? no(e) : ok(a)))), (e) => e.code === "E_ADDR");
  // the real request: refused at the lookup, nothing connects
  await assert.rejects(W._pushRequest("https://push.example.net/x", { headers: {}, body: Buffer.from("x"), signal: AbortSignal.timeout(5000) }), (e) => e.code === "E_ADDR");
  // end to end: an admin-added exact host whose name resolves privately -> failed at once, last_error addr
  await set({ webpush_hosts_extra: "push.example.net" });
  W._setTransport(null);                                          // the real transport (the lookup above refuses every answer)
  try {
    await call("/api/push/unsubscribe", { all: true }, "kim");
    const b = browser("push.example.net");
    await call("/api/push/subscribe", { subscription: b.sub, kinds: ["dm"] }, "kim");
    T += 31e3;
    await dmTo("kim");
    await W.drain();
    const r = await lastRow("kim");
    assert.equal(r.outcome, "failed");
    assert.equal(r.tries, 0, "never retried");
    const sr = await subRow(b);
    assert.equal(sr.last_error, "addr");
    assert.equal(sr.fail_count, 1);
    assert.equal((await W.health()).hosts.other.addr, 1);
    assert.ok(LOGS.some((l) => l === "[webpush] push.example.net resolves to no public address - refused, not retried"));
    await call("/api/push/unsubscribe", { all: true }, "kim");
  } finally {
    W._setTransport(FAKE);
    W._setLookup(null);
    await set({ webpush_hosts_extra: "" });
  }
});

test("turning notifications off never needs them on: unsubscribe answers while switched off or out of the audience; the dialog offers only that", async () => {
  await mkUser("lee");
  const c1 = (await getQuery("SELECT endpoint FROM webpush_subs WHERE user_id = 'u_cat'"))[0].endpoint;
  await set({ webpush_enabled: 0 });
  try {
    assert.equal((await call("/api/push/state", {}, "cat")).d.code, "E_OFF", "everything else stays off");
    assert.equal((await call("/api/push/test", { endpoint: c1 }, "cat")).d.code, "E_OFF");
    assert.deepEqual(await W.clientConfig(U.cat), { off: true, count: 1 });
    assert.equal(await W.clientConfig(U.lee), null, "nothing saved: nothing to show");
    const page = await call("/messages", null, "cat", { method: "GET" });
    assert.match(page.text, /<fieldset id="push" data-push data-push-off>/);
    assert.doesNotMatch(page.text, /data-key=/);
    assert.match(page.text, /<script src="\/public\/js\/webpush\.js\?v=1" defer><\/script>/);
    assert.doesNotMatch((await call("/messages", null, "lee", { method: "GET" })).text, /data-push/);
    const HUB = require(path.join(repo, "settingshub"));
    const row = (await HUB.hub(U.cat)).find((s) => s.id === "notify").entries.find((e) => e.id === "push");
    assert.equal(row.state.k, "sethub.st.push_n");
    // the guards still apply
    assert.equal((await call("/api/push/unsubscribe", { all: true }, "cat", { headers: { "x-requested-with": "" } })).status, 403);
    assert.equal((await call("/api/push/unsubscribe", { all: true }, "cat", { session: false })).status, 401);
    const r = await call("/api/push/unsubscribe", { all: true }, "cat");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.d.removed, 1);
    assert.equal(await W.clientConfig(U.cat), null);
    assert.doesNotMatch((await call("/messages", null, "cat", { method: "GET" })).text, /data-push/);
  } finally { await set({ webpush_enabled: 1 }); }
  // out of the audience (admins only): dan (a member) removes his browser
  const d = await getQuery("SELECT endpoint FROM webpush_subs WHERE user_id = 'u_dan'");
  assert.ok(d.length >= 1);
  await set({ webpush_audience: "admins" });
  try {
    assert.equal((await call("/api/push/unsubscribe", { endpoint: d[0].endpoint }, "dan")).d.removed, 1);
  } finally { await set({ webpush_audience: "everyone" }); }
});

test("a sign-in that can't be checked right now (the database busy): not sent, not dropped - the push retries; /state says not known", async () => {
  const b = browser();
  await call("/api/push/subscribe", { subscription: b.sub, kinds: ["dm", "mention"] }, "lee");
  const realIsLive = S.isLive;
  S.isLive = async () => { throw new Error("SQLITE_BUSY: database is locked"); };
  try {
    SENT.length = 0;
    T += 31e3;
    await dmTo("lee");
    await W.drain();
    const r = await lastRow("lee");
    assert.equal(r.outcome, null, "back in the queue");
    assert.equal(r.sent_at, null);
    assert.equal(r.tries, 1);
    assert.equal(r.due_at, T + W.RETRY_STEPS[0]);
    assert.equal(sentTo(b).length, 0, "never sent blind");
    assert.ok(await subRow(b), "never dropped on an unknown");
    // /state from another sign-in of the account: not known while it can't be checked
    const st = await call("/api/push/state", { endpoint: b.endpoint }, "lee", { session: "another-sign-in" });
    assert.equal(st.status, 200);
    assert.equal(st.d.mine.known, false);
    assert.equal((await call("/api/push/state", { endpoint: b.endpoint }, "lee")).d.mine.known, true, "this very sign-in: known without asking");
  } finally { S.isLive = realIsLive; }
  T += W.RETRY_STEPS[0];
  await W.drain();
  assert.equal((await lastRow("lee")).outcome, "sent", "checked again: sent");
  assert.equal(sentTo(b).length, 1);
});

test("a browser that changed hands: /state as another account removes the old account's row; another account signing in ends the replaced sign-in", async () => {
  const b = browser();
  await call("/api/push/subscribe", { subscription: b.sub, kinds: ["dm"] }, "ann");
  assert.equal((await subRow(b)).user_id, "u_ann");
  const st = await call("/api/push/state", { endpoint: b.endpoint }, "mod");
  assert.equal(st.status, 200);
  assert.deepEqual(st.d.mine, { known: false, kinds: [] });
  assert.equal(await subRow(b), undefined, "ann's pushes no longer show in this browser");
  assert.equal((await W.health()).removed.handover, 1);
  // sessions.signIn: B signing in over A's live sign-in (a !signin link redeemed while signed in) ends A's
  const a = await S.create({ get: () => "" }, "u_ann", "password");
  const res = { cookie: () => {} };
  const req = { loginSession: { id: a.id, userId: "u_ann" }, get: () => "", cookies: {}, headers: {} };
  await S.signIn(req, res, { userId: "u_mod", username: "mod", class: "Staff" }, "chat");
  assert.equal(await S.isLive(a.id, "u_ann"), false, "the replaced sign-in is ended");
  assert.equal((await getQuery("SELECT revoked_why FROM sessions WHERE id = ?", [a.id]))[0].revoked_why, "another account signed in");
  assert.equal(req.loginSession.userId, "u_mod");
  // the same account signing in again leaves its other sign-in alone
  const m1 = req.loginSession.id;
  const req2 = { loginSession: { id: m1, userId: "u_mod" }, get: () => "", cookies: {}, headers: {} };
  await S.signIn(req2, res, { userId: "u_mod", username: "mod", class: "Staff" }, "chat");
  assert.equal(await S.isLive(m1, "u_mod"), true);
});

test("the DM gap: an unread push holds the next one back; a read (or a push that never went out) doesn't; leaving cancels a due push", async () => {
  const b = (await getQuery("SELECT endpoint FROM webpush_subs WHERE user_id = 'u_lee'"))[0];
  assert.ok(b);
  await set({ webpush_dm_gap_s: 30, webpush_grace_dm_s: 0 });
  const read = (mid) => runQuery("UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = 'gapR' AND user_id = 'u_lee'", [mid]);
  T += 31e3;
  const n0 = (await rows("lee")).length;
  await dmTo("lee", "gapR", 1);
  await W.drain();
  assert.equal((await lastRow("lee")).outcome, "sent");
  T += 5e3;
  await dmTo("lee", "gapR", 2);
  assert.equal((await rows("lee")).length, n0 + 1, "DM 1 unread: DM 2 is a burst (the device already shows it)");
  await read(2);                                                // read in a focused tab, then off to another app
  T += 5e3;
  await dmTo("lee", "gapR", 3);
  assert.equal((await rows("lee")).length, n0 + 2, "read since: the reply 10 s later pushes");
  await W.drain();
  // a push cancelled as read during its grace doesn't hold the next one back either
  await read(3);
  await set({ webpush_grace_dm_s: 10 });
  T += 2e3;
  await dmTo("lee", "gapR", 4);
  assert.equal((await rows("lee")).length, n0 + 3);
  await read(4);
  T += 11e3;
  await W.drain();
  assert.equal((await lastRow("lee")).outcome, "read");
  T += 2e3;
  await dmTo("lee", "gapR", 5);
  assert.equal((await rows("lee")).length, n0 + 4, "the read one doesn't count");
  T += 11e3;
  await W.drain();
  // leaving the conversation before the push is due: cancelled (outcome read), nothing sent
  T += 31e3;
  await dmTo("lee", "leftC", 600);
  await runQuery("UPDATE conversation_members SET left_at = ? WHERE conversation_id = 'leftC' AND user_id = 'u_lee'", [T]);
  const due = await lastRow("lee");
  assert.equal(due.src_key, "dm:leftC:600");
  SENT.length = 0;
  T += 11e3;
  await W.drain();
  assert.equal((await getQuery("SELECT outcome FROM webpush_outbox WHERE id = ?", [due.id]))[0].outcome, "read");
  assert.equal(sentTo(b).length, 0);
  // and after leaving, nothing is queued at all
  const n1 = (await rows("lee")).length;
  T += 31e3;
  await dmTo("lee", "leftC", 601);
  assert.equal((await rows("lee")).length, n1);
  await set({ webpush_grace_dm_s: 0 });
});

test("resubscribe (the service worker's pushsubscriptionchange): the new endpoint replaces the old row with its kinds; foreign / unknown / bad refused", async () => {
  const o = browser(), n = browser("updates.push.services.mozilla.com");
  await call("/api/push/subscribe", { subscription: o.sub, kinds: ["dm", "keyword"] }, "lee");
  const r = await call("/api/push/resubscribe", { old_endpoint: o.endpoint, subscription: n.sub }, "lee");
  assert.equal(r.status, 200, r.text);
  assert.equal(await subRow(o), undefined, "the old row is gone");
  const nr = await subRow(n);
  assert.equal(nr.user_id, "u_lee");
  assert.equal(nr.kinds, "dm,keyword", "the kinds carried over");
  assert.equal(nr.session_id, SID.lee);
  assert.equal(nr.p256dh, n.sub.keys.p256dh);
  // someone else's old endpoint, or one we don't know: 404, nothing changes
  const e2 = browser();
  const foreign = await call("/api/push/resubscribe", { old_endpoint: n.endpoint, subscription: e2.sub }, "kim");
  assert.equal(foreign.status, 404);
  assert.equal(foreign.d.code, "E_NODEVICE");
  assert.equal((await subRow(n)).user_id, "u_lee", "lee's row untouched");
  assert.equal(await subRow(e2), undefined);
  assert.equal((await call("/api/push/resubscribe", { old_endpoint: "https://fcm.googleapis.com/fcm/send/unknown", subscription: e2.sub }, "lee")).status, 404);
  // the new subscription is checked like a subscribe (and a refused one leaves the old row)
  const bad = await call("/api/push/resubscribe", { old_endpoint: n.endpoint, subscription: { endpoint: "https://evil.example/x", keys: n.sub.keys } }, "lee");
  assert.equal(bad.status, 400);
  assert.equal(bad.d.code, "E_ENDPOINT");
  const badKeys = await call("/api/push/resubscribe", { old_endpoint: n.endpoint, subscription: { endpoint: e2.endpoint, keys: { p256dh: "AAAA", auth: "x" } } }, "lee");
  assert.equal(badKeys.d.code, "E_KEYS");
  assert.ok(await subRow(n), "kept when the new one is refused");
  // the same endpoint with new keys: one row, the keys updated
  const k2 = browser();
  const same = await call("/api/push/resubscribe", { old_endpoint: n.endpoint, subscription: { endpoint: n.endpoint, keys: k2.sub.keys } }, "lee");
  assert.equal(same.status, 200);
  assert.equal((await subRow(n)).p256dh, k2.sub.keys.p256dh);
  assert.equal((await getQuery("SELECT COUNT(*) AS c FROM webpush_subs WHERE endpoint = ?", [n.endpoint]))[0].c, 1);
});

test("a subscription made on another instance (a copied database) is never sent to, and goes; the staging refresh scrubs them", async () => {
  const b = browser();
  await call("/api/push/subscribe", { subscription: b.sub, kinds: ["dm"] }, "kim");
  assert.equal((await subRow(b)).instance, "prod", "made on this instance (no STAGING env)");
  await runQuery("UPDATE webpush_subs SET instance = 'staging' WHERE endpoint = ?", [b.endpoint]);
  SENT.length = 0;
  T += 31e3;
  await dmTo("kim");
  await W.drain();
  assert.equal(sentTo(b).length, 0);
  assert.equal(await subRow(b), undefined);
  assert.equal((await lastRow("kim")).outcome, "nodevice");
  const c = browser();
  await call("/api/push/subscribe", { subscription: c.sub, kinds: ["dm"] }, "kim");
  await runQuery("UPDATE webpush_subs SET instance = 'staging' WHERE endpoint = ?", [c.endpoint]);
  await W.sweep(T);
  assert.equal(await subRow(c), undefined, "the sweep too");
  // deploy/refresh-staging-db.sh: prod's copy loses its subscriptions + outbox and the switch, after the integrity check
  const sh = fs.readFileSync(path.join(repo, "deploy", "refresh-staging-db.sh"), "utf8");
  const ic = sh.indexOf("PRAGMA integrity_check"), mv = sh.indexOf('mv "$S/myapp.db.new" "$S/myapp.db"');
  for (const sql of ["DELETE FROM webpush_subs;", "DELETE FROM webpush_outbox;", "UPDATE webpush_cfg SET value = '0' WHERE key = 'webpush_enabled';"]) {
    const i = sh.indexOf(sql);
    assert.ok(i > ic && i < mv, sql + " runs on the copy, after the integrity check, before it goes live");
  }
});

test(".env.example lists the VAPID keys (commented, no values) and points at the tool", () => {
  const env = fs.readFileSync(path.join(repo, ".env.example"), "utf8");
  for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) assert.match(env, new RegExp("^# " + k + "=$", "m"), k);
  assert.match(env, /node tools\/vapid-keys\.js --env \.env --subject mailto:/);
});
