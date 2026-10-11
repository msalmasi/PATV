// Offline tests for 1.99la: the 🔭 Scout / 🎟️ Curator store roles (requestroles.js), 🛠️ reporting a problem + the
// curators' manage view (mediaissues.js) and the request poster fix, against a mocked Seerr and a mocked Discord bridge:
//   * buying the role grants it (the shop sale hook) - PATV perks at once, Seerr + Discord as soon as they're linked
//   * Seerr: the bits added on top of the user's own (kept), the earlier permissions + quota stored, an explicit
//     unlimited quota for a Scout; revoke takes back only what was added and restores the quota
//   * linking: admin link -> Plex id -> verified email -> import-from-plex; no Plex link = waiting + a notice
//   * Discord: no Discord yet = waiting, given once linked; a role they already had is never removed
//   * Scout: no daily limit, no PAT, credits untouched; Curator: approve / decline as their own Seerr user
//   * issues: members only, Seerr media id, rate limits, your reports with status + comments, manage + resolve
//   * posters: the TMDB image URL, never the bare path; a placeholder when there's none
//   node --test test/request-roles.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rroles-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.SEERR_STAGING_WRITES;
process.env.SECRET_KEY = "test-secret";
process.env.OVERSEERR_API_KEY = "test-seerr-key";

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const shop = require(path.join(repo, "shop"));
const conf = require(path.join(repo, "mediaconf"));
const MR = require(path.join(repo, "mediarequests"));
const RR = require(path.join(repo, "requestroles"));
const MI = require(path.join(repo, "mediaissues"));

const SCOUT = "147ce895-37c2-4c43-98cc-9f7045de0cf3", CURATOR = "c0e57e08-6696-4c51-94ec-485f13a68cd8";

// ── a mock Seerr ──
const S = {
  users: [
    { id: 1, plexId: 111029, plexUsername: "owner", permissions: 2, email: "owner@example.com" },
    { id: 20, plexId: 5001, plexUsername: "scouty", permissions: 1048608, email: "scouty@example.com" },
    { id: 21, plexId: 5002, plexUsername: "cura", permissions: 1048608, email: "cura@example.com" },
    { id: 22, plexId: 5003, plexUsername: "mailmatch", permissions: 32, email: "mailmatch@example.com" },
  ],
  main: {}, posts: [], plexAccounts: { 5004: { email: "late@example.com", plexUsername: "latecomer" } }, nextUser: 30,
  requests: new Map(), nextReq: 100, issues: new Map(), nextIssue: 1,
};
for (const u of S.users) S.main[u.id] = { username: u.plexUsername, email: u.email, movieQuotaLimit: null, movieQuotaDays: null, tvQuotaLimit: null, tvQuotaDays: null };
const TITLES = {
  "movie/11": { id: 11, title: "Star Wars", releaseDate: "1977-05-25", posterPath: "/sw.jpg", mediaInfo: { id: 501, status: 5 } },
  "movie/12": { id: 12, title: "Not Here", releaseDate: "2020-01-01", posterPath: "/nh.jpg" },
  "movie/13": { id: 13, title: "Wanted", releaseDate: "2021-01-01", posterPath: "/w.jpg" },
  "tv/1399": { id: 1399, name: "Game of Thrones", firstAirDate: "2011-04-17", posterPath: "/got.jpg", seasons: [{ seasonNumber: 1, episodeCount: 10 }], mediaInfo: { id: 502, status: 4, seasons: [{ seasonNumber: 1, status: 5 }] } },
};
const userById = (id) => S.users.find((u) => u.id === Number(id));
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    const send = (st, j) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.headers["x-api-key"] !== "test-seerr-key") return send(403, { message: "bad key" });
    const asUser = req.headers["x-api-user"] ? Number(req.headers["x-api-user"]) : 1;
    const u = new URL(req.url, "http://x");
    const p = u.pathname.replace(/^\/api\/v1/, "");
    const b = body ? JSON.parse(body) : null;
    if (req.method !== "GET") S.posts.push({ method: req.method, p, b, asUser });
    let m;
    if (p === "/user" && req.method === "GET") return send(200, { pageInfo: { pages: 1 }, results: S.users });
    if (p === "/user/import-from-plex") {
      const made = [];
      for (const id of b.plexIds || []) {
        const acc = S.plexAccounts[id];
        if (acc && !S.users.some((x) => String(x.plexId) === String(id))) {
          const nu = { id: S.nextUser++, plexId: Number(id), plexUsername: acc.plexUsername, permissions: 1048608, email: acc.email };
          S.users.push(nu); S.main[nu.id] = { username: acc.plexUsername, email: acc.email, movieQuotaLimit: null, movieQuotaDays: null, tvQuotaLimit: null, tvQuotaDays: null };
          made.push(nu);
        }
      }
      return send(201, { createdUsers: made, refreshedUsers: [] });
    }
    if ((m = /^\/user\/(\d+)\/settings\/permissions$/.exec(p))) {
      const x = userById(m[1]);
      if (!x) return send(404, {});
      if (req.method === "GET") return send(200, { permissions: x.permissions });
      if (x.id === 1) return send(403, { message: "owner" });
      x.permissions = b.permissions;
      return send(200, { permissions: x.permissions });
    }
    if ((m = /^\/user\/(\d+)\/settings\/main$/.exec(p))) {
      const x = S.main[m[1]];
      if (!x) return send(404, {});
      if (req.method === "GET") return send(200, { ...x, globalMovieQuotaLimit: 10, globalTvQuotaLimit: 2 });
      for (const k of ["movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays"]) if (k in b) x[k] = b[k];
      return send(200, x);
    }
    if (p === "/search") return send(200, { results: Object.entries(TITLES).map(([k, t]) => ({ mediaType: k.split("/")[0], ...t })) });
    if ((m = /^\/(movie|tv)\/(\d+)$/.exec(p))) { const t = TITLES[`${m[1]}/${m[2]}`]; return t ? send(200, t) : send(404, {}); }
    if (p === "/media") return send(200, { results: [{ id: 501, mediaType: "movie", tmdbId: 11, status: 5 }, { id: 502, mediaType: "tv", tmdbId: 1399, status: 4 }] });
    if (p === "/request" && req.method === "POST") {
      const id = S.nextReq++;
      const auto = (userById(b.userId || 1).permissions & (128 | 2)) !== 0;   // ADMIN (the key's owner) auto-approves too
      const q = { id, status: auto ? 2 : 1, type: b.mediaType, media: { status: auto ? 3 : 2, tmdbId: b.mediaId, mediaType: b.mediaType }, requestedBy: { displayName: (userById(b.userId || 1) || {}).plexUsername }, createdAt: new Date().toISOString() };
      S.requests.set(id, q);
      return send(201, q);
    }
    if (p === "/request" && req.method === "GET") {
      const f = u.searchParams.get("filter");
      const list = [...S.requests.values()].filter((q) => f === "all" || (f === "pending" && q.status === 1) || (f === "approved" && q.status === 2));
      return send(200, { pageInfo: { pages: 1 }, results: list });
    }
    if ((m = /^\/request\/(\d+)\/(approve|decline)$/.exec(p))) {
      const q = S.requests.get(Number(m[1]));
      if (!q) return send(404, {});
      const who = userById(asUser);
      if (!who || !(who.permissions & (16 | 2))) return send(403, { message: "no MANAGE_REQUESTS" });
      q.status = m[2] === "approve" ? 2 : 3;
      return send(200, q);
    }
    if ((m = /^\/request\/(\d+)$/.exec(p))) { const q = S.requests.get(Number(m[1])); return q ? send(200, q) : send(404, {}); }
    if (p === "/issue" && req.method === "POST") {
      const id = S.nextIssue++;
      const iss = { id, issueType: b.issueType, status: 1, problemSeason: b.problemSeason, problemEpisode: b.problemEpisode, media: { id: b.mediaId, tmdbId: b.mediaId === 501 ? 11 : 1399, mediaType: b.mediaId === 501 ? "movie" : "tv" },
                    createdBy: { displayName: (userById(b.userId || 1) || {}).plexUsername }, createdAt: new Date().toISOString(), comments: [{ message: b.message, user: { displayName: "x" } }], _userId: b.userId };
      S.issues.set(id, iss);
      return send(201, iss);
    }
    if (p === "/issue" && req.method === "GET") return send(200, { pageInfo: { pages: 1 }, results: [...S.issues.values()].filter((i) => u.searchParams.get("filter") === "all" || (u.searchParams.get("filter") === "open") === (i.status === 1)) });
    if ((m = /^\/issue\/(\d+)\/comment$/.exec(p))) { const i = S.issues.get(Number(m[1])); i.comments.push({ message: b.message, user: { displayName: "PATV" } }); return send(200, i); }
    if ((m = /^\/issue\/(\d+)\/(resolved|open)$/.exec(p))) { const i = S.issues.get(Number(m[1])); i.status = m[2] === "resolved" ? 2 : 1; return send(200, i); }
    if ((m = /^\/issue\/(\d+)$/.exec(p))) { const i = S.issues.get(Number(m[1])); return i ? send(200, i) : send(500, { message: "Issue not found." }); }
    send(404, {});
  });
});

// ── a mock Discord bridge ──
const DB = { calls: [], members: new Set(["d-scout", "d-had"]), roles: { "d-had": new Set(["curator"]) } };
async function bridge(p, body) {
  DB.calls.push({ p, body });
  if (p === "/store/role-grant" || p === "/store/role-remove") {
    if (!DB.members.has(body.discordId)) return { ok: true, [p.endsWith("grant") ? "granted" : "removed"]: false, reason: "not_in_server" };
    const set = DB.roles[body.discordId] = DB.roles[body.discordId] || new Set();
    const had = set.has(body.role);
    if (p.endsWith("grant")) { set.add(body.role); return { ok: true, granted: true, already: had }; }
    set.delete(body.role); return { ok: true, removed: had, had };
  }
  if (p === "/store/role-members") return { role: body.role, discordIds: Object.entries(DB.roles).filter(([, s]) => s.has(body.role)).map(([id]) => id) };
  return { error: "not_found" };
}

let n = 0;
async function mkUser({ bal = 0, email = null, verified = 0, discordId = null, cls = "pleb" } = {}) {
  const id = "rr" + (++n);
  await runQuery("INSERT INTO users (userId, username, password, points_balance, level, email, isEmailVerified, discordId, class) VALUES (?, ?, 'x', ?, 5, ?, ?, ?, ?)",
                 [id, "rruser" + n, bal, email, verified, discordId, cls]);
  return { userId: id, username: "rruser" + n, class: cls };
}
const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const linkPlex = (userId, plexId, source = "self") => runQuery(`INSERT INTO plex_members (plex_id, username, on_server, pending, user_id, link_source, access, access_pinned, first_seen)
  VALUES (?, ?, 1, 0, ?, ?, 'manual', 1, 1) ON CONFLICT(plex_id) DO UPDATE SET user_id = excluded.user_id, link_source = excluded.link_source`, [String(plexId), "p" + plexId, userId, source]);
const row = async (userId, role) => (await getQuery("SELECT * FROM request_roles WHERE user_id = ? AND role = ?", [userId, role]))[0];
const buy = (u, prizeId) => shop.purchasePrize({ userId: u.userId, username: u.username, prizeId, source: "website" });
const settle = () => new Promise((r) => setTimeout(r, 60));

test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.OVERSEERR_URL = `http://127.0.0.1:${server.address().port}`;
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, granted_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (userId, role))");
  await shop.ready;
  await MR.init();
  await require(path.join(repo, "plexmembers")).init();
  await RR.init();
  await MI.init();
  RR._set({ discordBridge: bridge });
  const pb = await mkUser();
  await runQuery("UPDATE users SET username = 'pb' WHERE userId = ?", [pb.userId]);
  for (const [id, name] of [[SCOUT, "Scout Role"], [CURATOR, "Curator Role"]]) {
    await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity, status) VALUES (?, ?, 1000, 10, 'active')", [id, name]);
  }
  shop.onOfficialSale(RR.onSale);
  shop.onOfficialSale(MR.onSale);
  await conf.set({ requests_enabled: true, requests_per_day: 1, request_price_movie: 500, request_price_tv: 800 }, "test");
});
test.after(() => server.close());

test("buying Scout: role active at once; Seerr gets REQUEST on top of their own bits + an UNLIMITED quota; Discord role given", async () => {
  const u = await mkUser({ bal: 5000, discordId: "d-scout" });
  await linkPlex(u.userId, 5001);
  const r = await buy(u, SCOUT);
  assert.equal(r.success, true, r.message);
  await settle();
  assert.equal(await RR.isActive(u.userId, "scout"), true);
  assert.ok((await getQuery("SELECT 1 FROM user_roles WHERE userId = ? AND role = 'scout'", [u.userId]))[0], "the store's record");
  await RR.reconcile({ userId: u.userId });
  const x = await row(u.userId, "scout");
  assert.equal(x.seerr_state, "applied", x.seerr_note);
  assert.equal(x.seerr_user, 20);
  assert.equal(x.seerr_prev_perms, 1048608);
  assert.equal(x.seerr_added, 0, "REQUEST (32) was already in their default permissions - nothing added");
  assert.equal(userById(20).permissions, 1048608, "existing bits kept");
  assert.equal(S.main[20].movieQuotaLimit, 0, "0 = unlimited in Seerr");
  assert.equal(S.main[20].tvQuotaLimit, 0);
  assert.deepEqual(JSON.parse(x.seerr_prev_quota), { movieQuotaLimit: null, movieQuotaDays: null, tvQuotaLimit: null, tvQuotaDays: null });
  assert.equal(x.discord_state, "applied");
  assert.ok(DB.roles["d-scout"].has("scout"));
  const log = await getQuery("SELECT action FROM request_role_log WHERE user_id = ? ORDER BY id", [u.userId]);
  assert.deepEqual(log.map((l) => l.action), ["grant", "seerr_grant", "discord_grant"]);
  // a second purchase is refused by the store, as before
  assert.equal((await buy(u, SCOUT)).status, 409);
});

test("Scout on PATV: no daily limit, no PAT per request, credits untouched", async () => {
  const u = (await getQuery("SELECT userId, username FROM users WHERE discordId = 'd-scout'"))[0];
  await MR.addCredits(u.userId, "movie", 2);
  const before = await bal(u.userId);
  const a = await MR.request(u, { type: "movie", tmdb: 13 });
  assert.equal(a.paid_with, "scout");
  assert.equal(a.price, 0);
  assert.equal(S.posts.filter((x) => x.p === "/request").at(-1).b.userId, 20, "requested as their own (unlimited) Seerr user");
  delete TITLES["movie/13"].mediaInfo;
  S.requests.clear();
  TITLES["movie/14"] = { id: 14, title: "Another", releaseDate: "2022-01-01" };
  const b = await MR.request(u, { type: "movie", tmdb: 14 });
  assert.equal(b.paid_with, "scout", "past requests_per_day = 1");
  assert.equal(await bal(u.userId), before, "nothing charged");
  assert.equal((await MR.credits(u.userId)).movie, 2, "credits kept");
  // someone without the role still has the limit + price
  const v = await mkUser({ bal: 5000 });
  TITLES["movie/15"] = { id: 15, title: "Third", releaseDate: "2022-01-01" };
  const c = await MR.request(v, { type: "movie", tmdb: 15 });
  assert.equal(c.paid_with, "pat");
  TITLES["movie/16"] = { id: 16, title: "Fourth", releaseDate: "2022-01-01" };
  await assert.rejects(MR.request(v, { type: "movie", tmdb: 16 }), /most for now/);
});

test("Curator: AUTO_APPROVE + MANAGE_REQUESTS added, their requests approve themselves, they approve others as their own Seerr user", async () => {
  const u = await mkUser({ bal: 5000 });
  await linkPlex(u.userId, 5002);
  assert.equal((await buy(u, CURATOR)).success, true);
  await settle();
  await RR.reconcile({ userId: u.userId });
  const x = await row(u.userId, "curator");
  assert.equal(x.seerr_state, "applied");
  const want = 16 | 32 | 128 | 256 | 512 | 1048576;
  assert.equal(userById(21).permissions, 1048608 | want);
  assert.equal(x.seerr_added, want & ~1048608, "only the bits they didn't have");
  assert.equal(S.main[21].movieQuotaLimit, null, "a curator's quota isn't touched");
  assert.equal(x.discord_state, "no_discord", "no Discord linked yet - waiting");
  // a request made by them is approved at once (Seerr auto-approve for their user)
  TITLES["movie/17"] = { id: 17, title: "Fifth", releaseDate: "2022-01-01" };
  const own = await MR.request(u, { type: "movie", tmdb: 17 });
  assert.equal(own.status, "approved");
  // manage: another user's pending request, approved as the curator's Seerr user (X-API-User)
  const v = await mkUser({ bal: 5000, email: "mailmatch@example.com", verified: 1 });   // requests as Seerr user 22 (no auto-approve)
  MR._resetUsers();
  TITLES["movie/18"] = { id: 18, title: "Sixth", releaseDate: "2022-01-01" };
  await MR.request(v, { type: "movie", tmdb: 18 });
  const list = await MI.manageRequests("pending", 1);
  const it = list.requests.find((q) => q.tmdb === 18);
  assert.ok(it, "the pending request is listed");
  assert.equal(it.title, "Sixth");
  assert.equal(it.poster_url, null);
  const me = { userId: u.userId, username: u.username, class: "pleb" };
  assert.equal(await RR.canManage(me), true);
  assert.equal(await RR.canManage({ userId: v.userId, username: v.username, class: "pleb" }), false);
  await MI.decide(me, it.id, "approve");
  assert.equal(S.posts.at(-1).asUser, 21, "sent as the curator's Seerr user");
  assert.equal(S.requests.get(it.id).status, 2);
  assert.equal((await getQuery("SELECT status FROM media_requests WHERE overseerr_id = ?", [it.id]))[0].status, "approved", "the PATV row followed");
  const log = await getQuery("SELECT action, actor FROM request_role_log WHERE action = 'approve'");
  assert.equal(log.at(-1).actor, u.username);
});

test("Discord: bought before linking = waiting; given once they link; a role they already had is never removed", async () => {
  const u = (await getQuery("SELECT r.user_id AS userId FROM request_roles r WHERE role = 'curator'"))[0];
  await runQuery("UPDATE users SET discordId = 'd-had' WHERE userId = ?", [u.userId]);
  await runQuery("UPDATE request_roles SET discord_next = 0, granted_at = 1 WHERE user_id = ?", [u.userId]);   // bought long ago
  await RR.reconcile();
  const x = await row(u.userId, "curator");
  assert.equal(x.discord_state, "applied");
  assert.equal(x.discord_kept, 1, "they had it already");
  await RR.revoke(u.userId, "curator", { actor: "admin", reason: "test" });
  assert.ok(DB.roles["d-had"].has("curator"), "not removed: PATV didn't give it");
  const y = await row(u.userId, "curator");
  assert.equal(y.status, "revoked");
  assert.equal(y.seerr_state, "undone");
  assert.equal(userById(21).permissions, 1048608, "Seerr back to exactly what they had");
  assert.equal(await RR.isActive(u.userId, "curator"), false);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM user_roles WHERE userId = ? AND role = 'curator'", [u.userId]))[0].n, 0, "they could buy it again");
});

test("revoking Scout restores the quota and removes the Discord role PATV gave", async () => {
  const u = (await getQuery("SELECT userId FROM users WHERE discordId = 'd-scout'"))[0];
  S.users.find((x) => x.id === 20).permissions = 1048576;     // pretend REQUEST had to be added
  await runQuery("UPDATE request_roles SET seerr_state = 'pending', seerr_next = 0 WHERE user_id = ? AND role = 'scout'", [u.userId]);
  await RR.reconcile({ userId: u.userId });
  assert.equal((await row(u.userId, "scout")).seerr_added, 32);
  await RR.revoke(u.userId, "scout", { actor: "admin" });
  assert.equal(userById(20).permissions, 1048576, "REQUEST taken back");
  assert.equal(S.main[20].movieQuotaLimit, null, "quota back to the global default");
  assert.equal(DB.roles["d-scout"].has("scout"), false, "PATV gave it, PATV took it");
});

test("linking: verified email; no Plex link = waiting + a notice; a linked Plex account Seerr doesn't know is imported", async () => {
  const e = await mkUser({ email: "mailmatch@example.com", verified: 1 });
  await RR.grant(e.userId, "scout", { actor: "admin" });
  await RR.reconcile({ userId: e.userId });
  assert.equal((await row(e.userId, "scout")).seerr_user, 22);
  const none = await mkUser();
  await RR.grant(none.userId, "curator", { actor: "admin" });
  await RR.reconcile({ userId: none.userId });
  const w = await row(none.userId, "curator");
  assert.equal(w.seerr_state, "no_link");
  assert.ok(w.notified_link, "told to link Plex");
  await linkPlex(none.userId, 5004);
  await runQuery("UPDATE request_roles SET seerr_next = 0 WHERE user_id = ?", [none.userId]);
  await RR.reconcile({ userId: none.userId });
  const z = await row(none.userId, "curator");
  assert.equal(z.seerr_state, "applied", z.seerr_note);
  assert.match(z.seerr_note, /imported/);
  assert.ok(S.posts.some((x) => x.p === "/user/import-from-plex" && x.b.plexIds.includes("5004")));
  // the server owner's account is never written to
  const own = await mkUser();
  await linkPlex(own.userId, 111029, "owner");
  await RR.grant(own.userId, "curator", { actor: "admin" });
  await RR.reconcile({ userId: own.userId });
  assert.equal((await row(own.userId, "curator")).seerr_state, "owner");
});

test("staging: nothing is written to Seerr (dry run, logged)", async () => {
  process.env.STAGING = "1";
  try {
    const u = await mkUser();
    await linkPlex(u.userId, 5003);
    const writes = S.posts.length;
    await RR.grant(u.userId, "scout", { actor: "admin" });
    await RR.reconcile({ userId: u.userId });
    assert.equal((await row(u.userId, "scout")).seerr_state, "dry");
    assert.equal(S.posts.length, writes, "no POST to Seerr");
    assert.ok((await getQuery("SELECT 1 FROM request_role_log WHERE user_id = ? AND action = 'seerr_dry'", [u.userId]))[0]);
  } finally { delete process.env.STAGING; }
});

test("issues: Plex members only; made on the Seerr media id as their Seerr user; limits; your reports with status + comments", async () => {
  const outsider = await mkUser();
  assert.equal(await MI.mayReport(outsider), false);
  await assert.rejects(MI.report(outsider, { type: "movie", tmdb: 11, issue_type: "video", message: "broken picture" }), /Plex members/);
  const u = await mkUser();
  await linkPlex(u.userId, 5001);
  await require(path.join(repo, "plexmembers")).reload();
  assert.equal(await MI.mayReport(u), true);
  await assert.rejects(MI.report(u, { type: "movie", tmdb: 12, issue_type: "video", message: "broken picture" }), /isn't on our Plex server/);
  await assert.rejects(MI.report(u, { type: "movie", tmdb: 11, issue_type: "smell", message: "broken picture" }), /video, audio/);
  const r = await MI.report(u, { type: "movie", tmdb: 11, issue_type: "audio", message: "sound is out of sync" });
  const iss = S.issues.get(r.seerr_id);
  assert.equal(iss.media.id, 501, "Seerr's media id, not the TMDB id");
  assert.equal(iss.issueType, 2);
  assert.equal(iss._userId, 20, "on behalf of their Seerr user");
  await assert.rejects(MI.report(u, { type: "movie", tmdb: 11, issue_type: "video", message: "again" }), /already have an open report/);
  // the curator's side: list, comment, resolve -> the reporter sees it
  const admin = await mkUser({ cls: "Admin" });
  const all = await MI.manageIssues("open", 1);
  assert.equal(all.issues[0].title, "Star Wars");
  assert.equal(all.issues[0].poster_url, "https://image.tmdb.org/t/p/w185/sw.jpg");
  await MI.comment(admin, r.seerr_id, "looking into it", { manager: true });
  await MI.setIssueStatus(admin, r.seerr_id, "resolved");
  const mine = await MI.mine(u.userId);
  assert.equal(mine[0].status, "resolved");
  assert.ok(mine[0].comments.some((c) => /looking into it/.test(c.message)));
  // a TV report with season / episode
  await MI.report(u, { type: "tv", tmdb: 1399, issue_type: "subtitles", message: "subs missing", season: 1, episode: 3 });
  const tv = [...S.issues.values()].at(-1);
  assert.equal(tv.problemSeason, 1);
  assert.equal(tv.problemEpisode, 3);
  // 5 a day
  for (const t of [["movie", 11], ["tv", 1399], ["movie", 11]]) await runQuery("UPDATE media_issues SET status = 'resolved' WHERE user_id = ?", [u.userId]).then(() => MI.report(u, { type: t[0], tmdb: t[1], issue_type: "other", message: "another one" }));
  await assert.rejects(MI.report(u, { type: "movie", tmdb: 11, issue_type: "other", message: "too many now" }), /most for now/);
  // recently added + library search show only titles that are on Plex
  const rec = await MI.recent();
  assert.deepEqual(rec.map((x) => x.title), ["Star Wars", "Game of Thrones"]);
  const found = await MI.librarySearch("star");
  assert.ok(found.every((x) => ["Star Wars", "Game of Thrones"].includes(x.title)));
});

test("posters: the TMDB image URL (never the bare path), and the /plex hub shows it or a placeholder", async () => {
  assert.equal(MR.posterUrl("/fGRNCssTRrhYZxNzykGGCoMsAVq.jpg"), "https://image.tmdb.org/t/p/w185/fGRNCssTRrhYZxNzykGGCoMsAVq.jpg");
  assert.equal(MR.posterUrl(null), null);
  assert.equal(MR.posterUrl("https://evil.example/x.jpg"), null);
  const u = (await getQuery("SELECT userId, username FROM users WHERE discordId = 'd-scout'"))[0];
  const mine = await MR.mine(u.userId);
  const hub = require(path.join(repo, "plexhub"));
  const data = await hub.pageData({ userId: u.userId, username: u.username, class: "pleb" });
  data.requests.mine = [{ ...mine[0], poster: "/sw.jpg", poster_url: MR.posterUrl("/sw.jpg") }, { ...mine[0], id: 999, poster: null, poster_url: null, title: "No Poster" }];
  const html = await ejs.renderFile(path.join(repo, "views", "plex.ejs"), { user: u.username, title: "Plex", ...data });
  assert.match(html, /<img src="https:\/\/image\.tmdb\.org\/t\/p\/w185\/sw\.jpg"/);
  assert.doesNotMatch(html, /<img src="\/sw\.jpg"/, "the bare path is never an <img src>");
  assert.match(html, /class="rq-ph"/, "a placeholder for the title without a poster");
  // /requests lists them with thumbnails too
  const rq = await ejs.renderFile(path.join(repo, "views", "mediaRequests.ejs"), { user: u.username, on: true, signedIn: true, credits: { movie: 0, tv: 0 },
    mine: data.requests.mine, price: { movie: 500, tv: 800 }, perDay: 1, admin: false, roles: { scout: true, curator: false }, manage: false });
  assert.match(rq, /class="mr-thumb" src="https:\/\/image\.tmdb\.org/);
  assert.match(rq, /data-scout="1"/);
});

test("shop: every role item has a description (what, where, how long); the retired request items point to /plex", async () => {
  const t = new Function(fs.readFileSync(path.join(repo, "i18n-core.js"), "utf8"))()(JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8")));
  for (const role of Object.values(shop.ROLE_PRIZES)) {
    const k = role.replace(/\s+/g, "_");
    for (const part of ["short", "lead", "length"]) assert.ok(t.has(`shop.role.${k}.${part}`), `shop.role.${k}.${part}`);
    assert.ok(["patv", "seerr", "camfrog", "discord"].filter((w) => t.has(`shop.role.${k}.${w}`)).length >= 2, `${k}: where it applies`);
  }
  const base = { user: "x", me: null, msg: null, settings: { auto_complete_days: 7 }, sales: 0, more: [], sub: null, t, i18nT: t };
  const H = { fmt: (n) => String(n), lstatus: () => ({ label: "Paused", color: "#999" }) };
  const shopMod = require(path.join(repo, "shop"));
  const Hfull = Object.assign({}, shopMod.H, H);   // 1.99lz: the storefront helpers (cat / img / shelves) too
  // the view helpers live on the module's render base; rebuild the ones the view uses
  Hfull.roleKey = (p) => (p && !p.seller_id && shopMod.ROLE_PRIZES[p.prizeId] ? shopMod.ROLE_PRIZES[p.prizeId].replace(/\s+/g, "_") : null);
  Hfull.requestItem = (p) => !!p && !p.seller_id && shopMod.REQUEST_ITEMS.includes(p.prizeId);
  const html = await ejs.renderFile(path.join(repo, "views", "shopItem.ejs"), { ...base, H: Hfull, p: { prizeId: SCOUT, prize: "Scout Role", cost: 50000000, quantity: 2, status: "active", seller_id: null } });
  assert.match(html, /unlimited/i);
  assert.match(html, /doesn’t expire/);
  const old = await ejs.renderFile(path.join(repo, "views", "shopItem.ejs"), { ...base, H: Hfull, p: { prizeId: shopMod.REQUEST_ITEMS[0], prize: "10 Additional Movie Requests", cost: 15000, quantity: 5, status: "paused", seller_id: null } });
  assert.match(old, /href="\/plex#request"/);
});

test("audit (read-only): Discord holders vs store orders vs active vs Seerr", async () => {
  const a = await RR.audit();
  assert.ok(a.scout && a.curator);
  assert.ok(Array.isArray(a.curator.discord));
  assert.ok(a.curator.discord.some((d) => d.username), "the d-had holder maps to a PATV account");
  assert.ok(Array.isArray(a.scout.orders) && a.scout.orders.length >= 1);
  assert.ok(Array.isArray(a.curator.seerr));
});
