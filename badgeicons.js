// badgeicons.js - 1.99aek: the badge pictures the chat hub's widget draws, all served by v1.
//
// A look's badge is {id, icon, label_key} (userlook.buildLooks; seam plan §12.4) and the widget draws `<assets><icon>.png`,
// assets = /public/img/ (chatwidget.js's page config; chat-core badgeLooks). The icons userlook sends:
//   badges/supporter-<tier>   public/img/badges/supporter-{bronze,silver,gold}.png   (supporter.js TIERS)
//   badges/bot                public/img/badges/bot.png                              (userlook.BOT_BADGE: Pepe)
//   ach/<id>                  public/img/badges/ach/<id>.png                         (achievements.json - the art lives
//                             under badges/ach/, where the site's own pages have always read it; /public/img/ach/ serves
//                             the same files, so the seam's key stays as the golden rows and the hub have it)
// Before 1.99aek none of the supporter / bot files existed and /public/img/ach/ was no route: a line from a supporter, from
// Pepe or from anyone showcasing an achievement asked for a 404 (tools/gen-badge-art.py draws the missing four).
//
//   register(app)   GET /public/img/ach/<id>.png -> public/img/badges/ach/<id>.png (static, before the general /public)
//   iconFile(icon)  the file a badge icon key is drawn from, or null (a key the widget would refuse, or no such file)
//   iconKeys()      every icon key userlook can send today (the supporter tiers, the bot badge, every achievement)
"use strict";
const fs = require("fs");
const path = require("path");

const IMG = path.join(__dirname, "public", "img");
const ACH_DIR = path.join(IMG, "badges", "ach");
// chat-core badgeLooks' own test for an icon key: [a-z0-9] then [a-z0-9_./-], no empty / "." / ".." segment
const ICON_RE = /^[a-z0-9][a-z0-9_./-]{0,127}$/;

function register(app) {
  const express = require("express");
  app.use("/public/img/ach", express.static(ACH_DIR, { index: false, redirect: false, maxAge: "7d" }));
}

function iconFile(icon) {
  const k = String(icon == null ? "" : icon);
  if (!ICON_RE.test(k) || k.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  const f = k.startsWith("ach/") ? path.join(ACH_DIR, k.slice(4) + ".png") : path.join(IMG, k + ".png");
  try { return fs.statSync(f).isFile() ? f : null; } catch (e) { return null; }
}

function iconKeys() {
  const keys = [require("./userlook").BOT_BADGE.icon];
  for (const t of require("./supporter").TIERS) keys.push("badges/supporter-" + t.id);
  let ach = [];
  try { ach = JSON.parse(fs.readFileSync(path.join(__dirname, "achievements.json"), "utf8")).achievements || []; } catch (e) { ach = []; }
  for (const a of ach) if (a && typeof a.id === "string") keys.push("ach/" + a.id);
  return keys;
}

module.exports = { register, iconFile, iconKeys, ACH_DIR };
