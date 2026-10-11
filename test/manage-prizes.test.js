// Offline tests for 1.99qh: the legacy official-prize editor (/admin/manage-prizes, POST /api/prizes/edit).
//   * the server checks the values like a listing's: a one-line name of 1-80 characters, whole-number cost / quantity in range
//   * a name with HTML in it is stored as text, and every page that shows prize names escapes it (shop, item, shop admin)
//   * the page builds its table with the DOM (textContent) and addEventListener - no innerHTML, no inline onclick - and adding
//     a prize refreshes the table in place (it used to look for a #prizeList that isn't on the page)
//   node --test test/manage-prizes.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manageprizes-test-"));
process.chdir(tmp);
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const shop = require(path.join(repo, "shop"));

let server, base;
const EVIL = '<img src=x onerror="alert(1)">Prize';

async function post(body, as = "mp-staff") {
  const r = await fetch(base + "/api/prizes/edit", { method: "POST", headers: { "content-type": "application/json", "x-test-user": as }, body: JSON.stringify(body), redirect: "manual" });
  return { status: r.status, text: await r.text() };
}
const get = async (url, as) => {
  const r = await fetch(base + url, { headers: as ? { "x-test-user": as } : {}, redirect: "manual" });
  return { status: r.status, html: await r.text() };
};
const official = async (name) => (await getQuery("SELECT prizeId, prize, cost, quantity FROM prizes WHERE seller_id IS NULL AND prize = ?", [name]))[0];

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT, created_at TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await shop.ready;
  for (const [id, name, cls] of [["pb", "pb", "Admin"], ["mp-staff", "staffer", "Staff"], ["mp-pleb", "pleb", "pleb"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, level, class) VALUES (?, ?, 'x', 0, 5, ?)", [id, name, cls]);
  }
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { req.flash = () => []; next(); });
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  shop.register(app, { isBotToken: () => false, addUser, requireUser: (req, res, next) => (req.user ? next() : res.status(401).end()) });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

test("POST /api/prizes/edit: staff only; the name is one line of 1-80 characters, cost and quantity whole numbers in range", async () => {
  let r = await post({ action: "add", prizeName: "Nope", cost: "10", quantity: "1" }, "mp-pleb");
  assert.equal(r.status, 302, "a member is sent away");
  assert.equal(await official("Nope"), undefined);

  for (const [body, why] of [[{ prizeName: "   ", cost: "10", quantity: "1" }, "blank name"], [{ prizeName: "Fine", cost: "lots", quantity: "1" }, "cost not a number"],
                             [{ prizeName: "Fine", cost: "-5", quantity: "1" }, "negative cost"], [{ prizeName: "Fine", cost: "10", quantity: "99999999" }, "too many"],
                             [{ prizeName: "Fine", cost: "2000000000", quantity: "1" }, "cost over the max"]]) {
    r = await post({ action: "add", ...body });
    assert.equal(r.status, 400, why);
  }
  assert.equal(await official("Fine"), undefined, "nothing was stored");

  r = await post({ action: "add", prizeName: "  Movie\n  night   pass ", cost: "1,500", quantity: "3" });
  assert.equal(r.status, 200);
  const p = await official("Movie night pass");
  assert.ok(p, "the name is stored on one line, trimmed");
  assert.equal(p.cost, 1500); assert.equal(p.quantity, 3);

  r = await post({ action: "add", prizeId: p.prizeId, prizeName: "Movie night pass", cost: "1600", quantity: "x" });
  assert.equal(r.status, 400, "an edit is checked too");
  r = await post({ action: "add", prizeId: p.prizeId, prizeName: "Movie night pass", cost: "1600", quantity: "2" });
  assert.equal(r.status, 200);
  assert.equal((await official("Movie night pass")).cost, 1600);

  r = await post({ action: "remove", prizeName: "Movie night pass" });
  assert.equal(r.status, 200);
  assert.equal(await official("Movie night pass"), undefined);
});

test("a prize name with HTML is stored as text and every page that shows it escapes it", async () => {
  const r = await post({ action: "add", prizeName: EVIL, cost: "100", quantity: "2" });
  assert.equal(r.status, 200);
  const p = await official(EVIL);
  assert.ok(p, "stored verbatim, as text");

  const api = await (await fetch(base + "/api/prizes")).json();
  assert.ok(api.some((x) => x.prize === EVIL), "the JSON carries the text (the bots print it as text)");

  for (const [url, as] of [["/shop", "mp-pleb"], ["/shop/item/" + p.prizeId, "mp-pleb"], ["/shop/admin", "mp-staff"], ["/shop/admin/edit/" + p.prizeId, "mp-staff"]]) {
    const pg = await get(url, as);
    assert.equal(pg.status, 200, url);
    assert.doesNotMatch(pg.html, /<img src=x onerror/, url + " never prints the name as HTML");
    assert.match(pg.html, /&lt;img src=x onerror=/, url + " shows it escaped");
  }
});

test("the editor page builds its rows with the DOM and listeners; adding a prize refreshes the table", async () => {
  const src = fs.readFileSync(path.join(repo, "views", "managePrizes.ejs"), "utf8");
  assert.doesNotMatch(src, /innerHTML/, "no innerHTML");
  assert.doesNotMatch(src, /\sonclick=/, "no inline onclick (markup or generated)");
  assert.doesNotMatch(src, /getElementById\('prizeList'\)/, "no lookup of the missing #prizeList");
  assert.match(src, /td\.textContent = /, "cells are text");
  assert.match(src, /addEventListener\('click', onClick\)/, "row buttons use listeners");
  assert.match(src, /document\.getElementById\('prizeListForm'\)\.addEventListener\('submit'[\s\S]*?fetchPrizes\(\);/, "the add path refreshes the table");
  assert.doesNotMatch(src, /bootstrapcdn|bootstrap(\.min)?\.(css|js)|class="(modal|btn|form-control|container)/i, "off Bootstrap");
  for (const id of ["prizeListForm", "prizeName", "prizeCost", "prizeQty", "addPrizeBtn", "PrizeListStatus", "prizesTable", "editPrizeModal", "editPrizeForm",
                    "editPrizeId", "editPrizeName", "editPrizeCost", "editPrizeQuantity"]) {
    assert.match(src, new RegExp('id="' + id + '"'), id + " kept");
  }

  const pg = await get("/admin/manage-prizes", "mp-staff");
  assert.equal(pg.status, 200);
  assert.match(pg.html, /class="mp ds-page mid"/);
  assert.equal((await get("/admin/manage-prizes", "mp-pleb")).status, 302);
});
