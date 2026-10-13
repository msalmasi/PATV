// 1.99sn: the public 💰 Pad vault card on a pad's About tab + "Donate to this pad's vault" (roomvaults.js donate / card,
// views/partials/pad-vault-card.ejs, public/js/pad-vault.js):
//   * Pepe's sync carries the latest donors ({who} or {anon}); junk is cleaned; an older Pepe (no donors key) keeps them;
//     a deposit's history row says who gave (or anon)
//   * the card: the recipe's slices (Pepe's cfg, the E-4 defaults 15/15/25/35/10 until synced), the last payout days'
//     summary when there are any, the viewer's balance
//   * POST /api/rooms/:slug/vault/donate: ANY signed-in account (no Camfrog link needed), a KEYED website action
//     "roomvault.deposit" (Pepe's !padvault deposit), anon passed on; refused signed out / not live / under the minimum /
//     past the cap / over the balance / a site pad; the same key twice is one action
//   * the card renders: the name "Pad vault" (never "room vault"), payouts "coming soon" while the recipe is off, the
//     week's numbers when it's on, "Anonymous" donors, a sign-in link when signed out, the donate form when live
//   NODE_PATH=G:/PATV/node_modules node --test test/pad-vault-public.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-vault-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const RV = require(path.join(repo, "roomvaults"));
const rooms = require(path.join(repo, "rooms"));

const PLANT = "plant_based_chatting", LOUNGE = "patv:lounge";
let n = 0;
async function mkUser(extra = {}) {
  const id = "v" + (++n);
  const name = extra.username || "user" + n;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername, class)
                  VALUES (?, ?, ?, 'x', ?, ?, ?)`, [id, name, name, extra.bal != null ? extra.bal : 1000000, extra.camfrog || null, extra.cls || "pleb"]);
  return { userId: id, username: name, class: extra.cls || "pleb" };
}
let base, server, owner, fan, nolink, poor;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  owner = await mkUser({ username: "pb", camfrog: "foamy1111" });
  fan = await mkUser({ username: "fan", camfrog: "fanguy" });
  nolink = await mkUser({ username: "nolink" });
  poor = await mkUser({ username: "poor", bal: 1500 });
  await rooms.init();
  await RV.init();
  await rooms.setOwner(PLANT, "foamy1111", "test");
  require(path.join(repo, "actions"));
  await new Promise((r) => setTimeout(r, 200));            // actions.js creates pepe_actions on load
  const app = express();
  app.use(express.json());
  const isBotToken = (t) => t === "bot-token";
  const users = { owner, fan, nolink, poor };
  const addUser = (req, res, next) => { req.user = users[req.get("x-test-user")] || null; next(); };
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
const post = (p, u, body) => fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, d: await r.json() }));
const sync = (body) => post("/api/g/roomvaults/sync", null, Object.assign({ password: "bot-token" }, body));
const actions = () => getQuery("SELECT * FROM pepe_actions ORDER BY id");
const key = () => "pv" + Math.random().toString(36).slice(2, 14);
const render = (rv, signed) => ejs.renderFile(path.join(repo, "views", "partials", "pad-vault-card.ejs"),
  { rv, room: { name: "Houseplants", slug: PLANT }, slug: PLANT, signed, siteOnly: false, num: (x) => Math.round(Number(x) || 0).toLocaleString("en-US") });

test("Pepe's sync: the donors list (a name or anonymous, junk cleaned), kept when an older Pepe sends none", async () => {
  const r = await sync({ on: true, cap: 50000000, rooms: [{ id: PLANT, balance: 200000, days: {},
    history: [{ ts: 5, kind: "deposit", flow: "deposit", amount: 5000, who: "fan<b>guy", anon: false }, { ts: 4, kind: "deposit", amount: 2000, anon: true, who: "secret" },
              { ts: 3, kind: "flow", flow: "ask", amount: 450, who: "leak" }],
    donors: [{ ts: 5, amount: 5000, who: "fan<b>guy" }, { ts: 4, amount: 2000, anon: true, who: "secret" }, { ts: 3, amount: -9, who: "x" }] }] });
  assert.equal(r.status, 200);
  let c = await RV.card(PLANT, fan, {});
  assert.deepEqual(c.donors, [{ ts: 5, amount: 5000, who: "fanbguy" }, { ts: 4, amount: 2000, anon: true }], "markup stripped, an anon donor's name never stored");
  assert.deepEqual([c.history[0].who, c.history[1].anon, c.history[1].who, c.history[2].who], ["fanbguy", true, undefined, undefined],
                   "deposit rows say who gave (or anon); other rows carry no name");
  await sync({ on: true, cap: 50000000, rooms: [{ id: PLANT, balance: 210000, days: {}, history: [] }] });
  c = await RV.card(PLANT, fan, {});
  assert.equal(c.donors.length, 2, "an older Pepe (no donors key) keeps the last list");
  assert.equal(c.balance, 210000);
});

test("the card: the recipe's slices, the last payout days' summary, the viewer's balance", async () => {
  let c = await RV.card(PLANT, fan, {});
  assert.deepEqual(c.split, { owner: 15, gang: 15, streamers: 25, people: 35, games: 10 }, "the E-4 defaults until Pepe sends his cfg");
  assert.equal(c.week, null, "no payout day yet");
  assert.deepEqual(c.viewer, { balance: 1000000, linked: true });
  assert.equal((await RV.card(PLANT, null, {})).viewer, null, "signed out: no viewer");
  const ep = (day, o) => Object.assign({ day, B: 10000, owner: 1000, gang: 0, streamers: 2000, people: 3000, paid: 6000, stays: 4000 }, o || {});
  await sync({ on: true, cap: 50000000, recipe: { on: true, cfg: { owner_pct: 0.2, gang_pct: 0.1, streamer_pct: 0.25, people_pct: 0.35, games_pct: 0.1 } },
               rooms: [{ id: PLANT, balance: 210000, days: {}, history: [], recipe: { epochs: [ep("2026-10-10"), ep("2026-10-11", { gang: 500, paid: 6500, stays: 3500 })] } }] });
  c = await RV.card(PLANT, nolink, {});
  assert.equal(c.recipe.live, true);
  assert.deepEqual(c.split, { owner: 20, gang: 10, streamers: 25, people: 35, games: 10 }, "Pepe's cfg");
  assert.deepEqual([c.week.days, c.week.paid, c.week.stays, c.week.owner, c.week.gang, c.week.streamers, c.week.people],
                   [2, 12500, 7500, 2000, 500, 4000, 6000]);
  assert.deepEqual(c.viewer, { balance: 1000000, linked: false });
});

test("donate: any signed-in account, a keyed roomvault.deposit action, anon passed on; the refusals", async () => {
  const slug = (await rooms.get(PLANT)).slug || PLANT;
  const D = (u, body) => post(`/api/rooms/${encodeURIComponent(slug)}/vault/donate`, u, body);
  assert.equal((await D(null, { amount: 5000, idem: key() })).status, 401, "signed out");
  assert.equal((await D("fan", { amount: 5000, idem: "x" })).status, 400, "no key");
  assert.equal((await D("fan", { amount: 999, idem: key() })).status, 400, "under the minimum");
  assert.match((await D("fan", { amount: 50000000, idem: key() })).d.error, /can take 49,790,000 PAT more/, "past the cap");
  assert.match((await D("poor", { amount: 2000, idem: key() })).d.error, /don't have that many/, "over the balance");
  const k = key();
  const a = await D("fan", { amount: 5000, idem: k });
  assert.equal(a.status, 200);
  const b = await D("fan", { amount: 5000, idem: k });
  assert.deepEqual([b.d.id, b.d.duplicate], [a.d.id, true], "the same key is the same action (a double click is one donation)");
  const c = await D("nolink", { amount: 2500, idem: key(), anon: true });
  assert.equal(c.status, 200, "no Camfrog name linked: still allowed (Pepe charges the PATV account)");
  const rows = (await actions()).filter((x) => x.kind === "roomvault.deposit");
  const last = rows[rows.length - 1];
  assert.deepEqual(JSON.parse(last.args), [PLANT, "2500", "anon"], "anon goes to Pepe");
  assert.equal(last.tag, "vault");
  assert.match(last.label, /donate 2,500 PAT to the pad vault \(anonymously\)/);
  assert.deepEqual(JSON.parse(rows.find((x) => x.id === a.d.id).args), [PLANT, "5000"]);
  const sd = await RV.donate(LOUNGE, fan, { amount: 5000, idem: key() });
  assert.ok(sd.id, "1.99uu: a site pad has a pad vault too - donations are queued like any pad's");
  await sync({ on: false, rooms: [{ id: PLANT, balance: 210000, days: {}, history: [] }] });
  assert.equal((await D("fan", { amount: 5000, idem: key() })).status, 409, "pad vaults not open: refused, nothing queued");
  await sync({ on: true, cap: 50000000, rooms: [{ id: PLANT, balance: 210000, days: {}, history: [] }] });
});

test("the card renders: Pad vault, coming soon / the week, anonymous donors, sign in or the donate form", async () => {
  await sync({ on: true, cap: 50000000, recipe: { on: false }, rooms: [{ id: PLANT, balance: 210000, days: {}, history: [{ ts: 1759990000, kind: "deposit", flow: "deposit", amount: 3000 }],
    donors: [{ ts: 1760000000, amount: 5000, who: "fanguy" }, { ts: 1760000001, amount: 2000, anon: true }] }] });
  let rv = await RV.card(PLANT, fan, {});
  let html = await render(rv, true);
  assert.match(html, /💰 Pad vault/);
  assert.doesNotMatch(html, /[Rr]oom vault|!roomvault/, "users see 'pad vault' only");
  assert.match(html, /coming soon/);
  assert.match(html, /15% the owner/);
  assert.match(html, /35% active people/);
  assert.match(html, /10% room-game prizes/);
  assert.match(html, /Payouts start when the payout recipe goes live/);
  assert.match(html, /fanguy[\s\S]*Anonymous/, "donors: a name, then Anonymous");
  assert.match(html, /id="rvDonate"/);
  assert.doesNotMatch(html, /deposit \/ donation · Anonymous/, "an older deposit with no name isn't called anonymous");
  assert.match(html, /data-min="1000" data-room="49790000" data-bal="1000000"/);
  assert.match(html, /id="rvAnon"/);
  assert.match(html, /never raises the owner&#39;s share|never raises the owner's share/);
  html = await render(await RV.card(PLANT, null, {}), false);
  assert.doesNotMatch(html, /id="rvDonate"/);
  assert.match(html, /Sign in to donate/);
  // the recipe on: the last payout days instead of "coming soon"
  await sync({ on: true, cap: 50000000, recipe: { on: true }, rooms: [{ id: PLANT, balance: 210000, days: {}, history: [],
    recipe: { epochs: [{ day: "2026-10-11", B: 10000, owner: 1500, gang: 0, streamers: 2500, people: 3500, paid: 7500, stays: 2500 }] } }] });
  rv = await RV.card(PLANT, fan, {});
  html = await render(rv, true);
  assert.doesNotMatch(html, /coming soon/);
  assert.match(html, /7,500 PAT paid out, 2,500 PAT stayed in the vault/);
  // not open: no form
  await sync({ on: false, rooms: [{ id: PLANT, balance: 210000, days: {}, history: [] }] });
  html = await render(await RV.card(PLANT, fan, {}), true);
  assert.doesNotMatch(html, /id="rvDonate"/);
  assert.match(html, /Donations open when pad vaults do/);
});
