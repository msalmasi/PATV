// 1.99lv design pass: /gtf and /achievements render from the same locals as before (views only changed).
//   NODE_PATH=G:/PATV/node_modules node --test test/design-pages.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const view = (n) => path.join(repo, "views", n + ".ejs");
const LINKS = { heistHelp: "/help#cat-heists", turfHelp: "/help#cat-heists", turfGuide: "https://pepe.publicaccess.tv/turfwars",
                turfMap: "https://pepe.publicaccess.tv/turf", gangs: "https://pepe.publicaccess.tv/gangs", heistBoard: "https://pepe.publicaccess.tv/heist" };

test("/gtf: every guide link, the sheet card for each viewer state, the start commands", async () => {
  const withSheet = await ejs.renderFile(view("gtf"), { title: "x", user: "pb", links: LINKS, sheet: { url: "https://pepe.publicaccess.tv/sheet/pb", cls: "Hacker" } });
  for (const u of Object.values(LINKS).concat(["/bounties", "https://pepe.publicaccess.tv/seasons/season-2-london.html"])) assert.ok(withSheet.includes(`href="${u}"`), u);
  assert.match(withSheet, /href="https:\/\/pepe\.publicaccess\.tv\/sheet\/pb"/);
  assert.match(withSheet, /Hacker/);
  for (const c of ["!sheet", "!heist", "!gang", "!turf", "!bounty", "!gtf"]) assert.ok(withSheet.includes(`<code>${c}</code>`), c);
  const noSheet = await ejs.renderFile(view("gtf"), { title: "x", user: "pb", links: LINKS, sheet: null });
  assert.match(noSheet, /No sheet linked yet/);
  const anon = await ejs.renderFile(view("gtf"), { title: "x", user: null, links: LINKS, sheet: null });
  assert.match(anon, /href="\/login\?next=\/gtf"/);
  assert.doesNotMatch(anon + noSheet + withSheet, /gtf\.[a-z_]+\.[a-z_]+/, "no raw i18n keys");
});

test("/achievements: groups, unlocked/locked state, rarity, rewards, filter bar; anonymous view has no state", async () => {
  const list = [
    { id: "signup", name: "Fresh Meat", desc: "Signed up.", icon: "/a.png", xp: 100, pat: 0, tier: "common", site: true },
    { id: "cf_linked", name: "Frog Bridge", desc: "Linked.", icon: "/b.png", xp: 2000, pat: 25000, tier: "common" },
    { id: "cf_heist_1", name: "Ski Mask", desc: "First heist.", icon: "/c.png", xp: 1000, pat: 10000, tier: "legendary" },
  ];
  const html = await ejs.renderFile(view("achievements"), { user: "pb", viewing: null, own: true, achievements: list,
                                                           holders: { cf_linked: 2 }, owned: new Set(["signup", "cf_linked"]) });
  assert.match(html, /data-group="start"/);
  assert.match(html, /data-group="heists"/);
  assert.equal((html.match(/data-state="got"/g) || []).length, 2 + 1, "2 cards + the filter button");
  assert.match(html, /class="ach legendary locked"/);
  assert.match(html, /\+25,000 PAT/);
  assert.match(html, /2 players have it/);
  assert.match(html, /aria-valuenow="2"/);
  assert.match(html, /2,100 XP earned/);
  const anon = await ejs.renderFile(view("achievements"), { user: null, viewing: null, own: true, achievements: list, holders: {}, owned: null });
  assert.doesNotMatch(anon, /data-state="got"/);
  assert.match(anon, /href="\/login\?next=\/achievements"/);
  const theirs = await ejs.renderFile(view("achievements"), { user: "pb", viewing: "tsyko", own: false, achievements: list, holders: {}, owned: new Set(["cf_heist_1"]) });
  assert.match(theirs, /PLAYER: tsyko/);
  assert.doesNotMatch(anon + html + theirs, /ach\.[a-z_]+\.[a-z_]+/, "no raw i18n keys");
});
