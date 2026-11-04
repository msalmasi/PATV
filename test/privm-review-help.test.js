// 1.99aid (privacy controls, review fix DARK-2): a dark feature's help card (Pepe's !privacy card, help.js PV3_DARK_CARDS) is left out of
// EVERY public help surface until the privacy switchboard v3 is advertised - not only /help's page model: the prompter's search
// results (and so Pepe's candidates and the commands his answer may name) and the raw /api/help/data.
//   node --test test/privm-review-help.test.js     (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-review-help-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const HELP = require(path.join(repo, "help"));
const PW = require(path.join(repo, "privwire"));
const PS = require(path.join(repo, "privacystate"));

const BUNDLED = JSON.parse(fs.readFileSync(path.join(repo, "data", "help-commands.json"), "utf8"));
let server, base;
const ADM = { userId: "u_adm", username: "adm", class: "Admin" };

/** Pepe's data with his !privacy card in it (a card shaped like the bundled incognito card). */
function pepeData() {
  const d = JSON.parse(JSON.stringify(BUNDLED));
  d.entries = d.entries.filter((e) => e.id !== "privacy");   // 1.99aiw dock: the bundled copy (synced from the bot) has the real card - this one stands in for it
  const inc = d.entries.find((e) => e.id === "incognito");
  inc.pc = { incogcam: { swap: [["Your own switch", "UNAPPROVED WORDING"]] } };   // a card's privacy-text variant (bot pepe_privtext)
  d.entries.push(Object.assign({}, inc, { pc: undefined, id: "privacy", title: "!privacy", commands: ["!privacy"], aliases: [], syntax: ["!privacy"],
    summary: "Your website privacy settings in one private answer: name, chat, transcripts, cam. Change them in Settings → Privacy.",
    details: "Your website privacy settings in one private answer (name, chat, mic transcripts, cam, voice) and Pepe's memory.",
    keywords: ["privacy", "settings", "website", "what does the website show about me"] }));
  return d;
}
const ask = (q) => fetch(base + "/api/help/ask", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ q }) })
  .then((r) => r.json());
const data = () => fetch(base + "/api/help/data").then((r) => r.json());

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, level, created_at) VALUES ('u_adm', 'adm', 'adm', 'x', 'Admin', 5, '2026-01-01')`);
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  HELP.register(app, { addUser: (req, res, next) => { req.user = null; next(); }, isBotToken: (t) => t === "bot", clientIp: () => "10.0.0.9" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await HELP.sync({ hash: "pv3dark", version: "test", data: pepeData() });
});
test.after(() => { if (server) server.close(); HELP._reset(); });

test("switch off: the !privacy card is in no search result and not in /api/help/data", async () => {
  assert.equal(PS.advert(), false);
  for (const q of ["privacy settings", "what does the website show about me", "!privacy"]) {
    const r = await ask(q);
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(!r.results.some((c) => c.id === "privacy"), `"${q}": not a result - ` + r.results.map((c) => c.id).join(","));
  }
  const d = await data();
  assert.ok(d.ok && d.data.entries.length > 10);
  assert.ok(!d.data.entries.some((e) => e.id === "privacy"), "/api/help/data leaves it out");
  assert.equal(d.hash, "pv3dark", "the synced copy's hash as before");
  const m = await HELP.pageModel();
  assert.ok(!m.index.some((e) => e.id === "privacy"), "the page model, as before");
  assert.ok(!d.data.entries.some((e) => "pc" in e) && !JSON.stringify(d).includes("UNAPPROVED WORDING"), "no card's privacy-text variant is served");
  assert.ok(d.data.entries.find((e) => e.id === "incognito").summary.startsWith("Your own switch"), "the card's text as it is");
  // nothing else changes: every other card is still served
  assert.deepEqual(d.data.entries.map((e) => e.id), pepeData().entries.map((e) => e.id).filter((id) => id !== "privacy"));
});

test("advertised: the card is a result and in /api/help/data", async () => {
  await PW.init();
  await PW.setOn(true, ADM);
  await PS.init();
  await PS.setOn(true, ADM);
  assert.equal(PS.advert(), true);
  const r = await ask("!privacy");
  assert.equal(r.results[0] && r.results[0].id, "privacy", "the top result now");
  const d = await data();
  assert.ok(d.data.entries.some((e) => e.id === "privacy"), "served");
  await PS.setOn(false, ADM);
});
