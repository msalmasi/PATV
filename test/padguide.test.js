// Offline tests for the pad owners guide (padguide.js, views/padGuide.ejs, 1.99uj):
//   * /pads/owners is public, renders every section and has no raw i18n keys
//   * every goal card links to each connected service's command guide and to the owner reference's entry, and every
//     reference anchor exists in the capability list (/pads/owner-guide#cap-<id>)
//   * every string the page uses is in en.json; numbers come from the live facts (recipe slices, prices)
//   * the reference page links back, and the signed-in owner gets "Manage your pad"
//   NODE_PATH=G:/PATV/node_modules node --test test/padguide.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "padguide-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PG = require(path.join(repo, "padguide"));
const PO = require(path.join(repo, "padowner"));
const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));

let base, server;
const users = {};
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 0,
                  avatar TEXT, archived_at INTEGER)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u1', 'pb', 'pb', 'x', 'foamy1111')");
  users.owner = { userId: "u1", username: "pb", class: "pleb" };
  await rooms.init();
  await rooms.setOwner("plant_based_chatting", "foamy1111", "test");
  const app = express();
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const addUser = (req, res, next) => { req.user = users[req.get("x-test-user")] || null; next(); };
  PG.register(app, { addUser });
  PO.register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
const page = (p, u) => fetch(base + p, { headers: u ? { "x-test-user": u } : {}, redirect: "manual" }).then(async (r) => ({ status: r.status, text: await r.text() }));

test("the guide is public, renders every section, no raw keys", async () => {
  const r = await page("/pads/owners", null);
  assert.equal(r.status, 200, r.text.slice(0, 400));
  for (const id of ['id="what"', 'id="earn"', 'id="pepe"', 'id="can"', 'id="tiers"', 'href="/pads/new"', 'href="/pads/owner-guide"', 'href="/premium"']) {
    assert.ok(r.text.includes(id), id);
  }
  const body = r.text.replace(/<script[\s\S]*?<\/script>/g, "");
  assert.ok(!/\bowners\.[a-z_]+(\.[a-z0-9_]+)*\b(?![^<]*>)/.test(body.replace(/href="[^"]*"/g, "")), "no raw owners.* keys");
  // the recipe's slices come from the facts (defaults when Pepe never synced)
  const F = await PG.facts();
  assert.ok(r.text.includes(`owner ${F.owner}%`) && r.text.includes(`regulars ${F.people}%`));
  assert.ok(!/\bmoney\b/i.test(body.replace(/<[^>]+>/g, " ")), "PAT is points: the page never says money");
});

test("every goal links each service's command guide and a real owner-reference entry", async () => {
  const r = await page("/pads/owners", null);
  const caps = new Set(PO.capabilities().capabilities.map((c) => c.id).concat(PO.WEB_CAPS.map((c) => c.id)));
  for (const g of PG.GOALS) {
    assert.ok(caps.has(g.cap), "reference entry exists: " + g.cap);
    assert.ok(r.text.includes(`href="/pads/owner-guide#cap-${g.cap}"`), g.id);
    assert.ok(en["owners.goal." + g.id + ".t"] && en["owners.goal." + g.id + ".d"], g.id);
    for (let i = 1; i <= g.items; i++) assert.ok(en["owners.goal." + g.id + ".i" + i], g.id + i);
    for (const s of PG.SERVICES) assert.ok(r.text.includes(`href="${s.help}${s.cats[g.id] || ""}"`), s.id + " " + g.id);
  }
  for (const s of PG.SERVICES) {
    assert.ok(en["owners.svc." + s.id + "_d"], "service blurb " + s.id);
    assert.ok(r.text.includes(`id="svc-${s.id}"`));
  }
});

test("the reference links back; an owner gets Manage your pad", async () => {
  let r = await page("/pads/owner-guide", null);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('href="/pads/owners"'), "reference -> guide");
  assert.ok(r.text.includes(en["owner.guide_title"]));
  r = await page("/pads/owners", "owner");
  assert.equal(r.status, 200);
  assert.ok(/href="\/p\/[^"]+\/owner"/.test(r.text), "Manage your pad for the owner");
});

test("1.99uu: earning needs no tier and no chat connection; Plus is about connecting a Camfrog room; profile vaults once on", async () => {
  const RV = require(path.join(repo, "roomvaults"));
  const text = (r) => r.text.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  RV._setProfileVaults(false);
  const off = text(await page("/pads/owners", null));
  assert.ok(!/vaults run for pads connected/i.test(off) && !/Connecting one takes/i.test(off), "no 'vaults need a connected room / Plus'");
  assert.ok(off.includes("No tier and no chat connection needed"), "basic pads earn");
  assert.ok(off.includes("a basic pad has a feed, a stage and a vault"), "the earn lead says what a basic pad has");
  assert.ok(off.includes("connecting your pad to a live Camfrog chat room with Pepe in it"), "Plus adds the Camfrog connection");
  assert.ok(off.includes("Prime Time chip-ins") && en["owners.earn.launch"].includes("newcomers get a welcome gift"), "the approved wording stays");
  assert.ok(!off.includes("Your profile has a vault too"), "profile vaults off: not mentioned");
  assert.equal(en["owners.earn.needs_plus"], undefined, "the 'needs Plus' string is gone");
  // profile vaults on (Pepe's sync) and pad vaults live: the guide mentions them
  await RV.sync({ on: true, profile_vaults: true, rooms: [] });
  const on = text(await page("/pads/owners", null));
  assert.ok(on.includes("Your profile has a vault too"), "profile vaults on: mentioned");
  RV._setProfileVaults(false);
});
