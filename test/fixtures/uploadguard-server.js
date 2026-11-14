// The child process of test/uploadguard.test.js (1.99anw): index.js's two multer routes - a member's profile photo and the admin
// badge form - built from the same pieces in the same order (the test pins index.js against this file), on 127.0.0.1. Its working
// folder is the test's temporary one (./myapp.db, ./uploads). S3 is faked (aws-sdk S3.prototype.upload). Prints "PORT <n>".
"use strict";
const path = require("path");
const repo = path.resolve(__dirname, "..", "..");
process.env.SECRET_KEY = process.env.SECRET_KEY || "uploadguard-test-secret";
process.env.S3_BUCKET_NAME = "test-bucket";
const AWS = require("aws-sdk");
const s3keys = [];
AWS.S3.prototype.upload = function (params) {
  s3keys.push(params.Key);
  return { promise: async () => ({ Location: "https://s3.amazonaws.com/test-bucket/" + params.Key }) };
};
const express = require("express");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const flash = require("connect-flash");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const sharp = require("sharp");
sharp.cache(false);   // index.js (review 1.99anw: no libvips operation cache)
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SP = require(path.join(repo, "siteperms"));
const authenticateToken = require(path.join(repo, "middleware", "authenticateToken"));
const UG = require(path.join(repo, "uploadguard"));
const { updateAvatar, avatarUpload, AVATAR_DECODES } = require(path.join(repo, "user.controller"));

// index.js's addUser, shortened: the login cookie's account (current class from the database), or null
async function addUser(req, res, next) {
  req.user = null;
  try {
    const d = jwt.verify(req.cookies.jwt || "", process.env.SECRET_KEY);
    const row = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [d.userId]))[0];
    req.user = row ? { ...d, username: row.username, class: row.class } : null;
  } catch (_) { req.user = null; }
  next();
}

// index.js (the test compares the two)
const upload = UG.badgeFormUpload(multer);
function badgeManager(req, res, next) {
  if (SP.can(req.user, "badges.manage")) return next();
  req.flash("error", "Access denied. You must be an admin or staff to access this page.");
  return res.redirect("/login");
}

(async () => {
  await runQuery("CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, class TEXT, avatar TEXT)");
  await runQuery("INSERT OR IGNORE INTO users (userId, username, class) VALUES ('u-member', 'member1', NULL), ('u-staff', 'staff1', 'Staff')");
  // review 1.99anw: members of their own for the decode-budget, type, burst and rate cases (AVATAR_RATE_MAX uploads a minute each)
  for (const n of ["bomb", "types", "burst", "rate", "rate2"]) await runQuery("INSERT OR IGNORE INTO users (userId, username, class) VALUES (?, ?, NULL)", ["u-" + n, n + "1"]);
  const app = express();
  app.use(cookieParser());
  app.use(session({ secret: "uploadguard-test", resave: false, saveUninitialized: false }));
  app.use(flash());
  app.post(
    "/api/u/:username/update/avatar",
    authenticateToken,
    addUser,
    UG.guard(avatarUpload.single("avatar"), UG.AVATAR, "avatar"),
    UG.safe(updateAvatar, "avatar")
  );
  // the badge INSERT itself (index.js) aside: what the handler would store
  app.post("/api/badges/add", authenticateToken, addUser, badgeManager, UG.guard(upload.none(), UG.BADGE_FORM, "badge form"), async (req, res) => {
    res.json({ message: "Badge created successfully.", body: { ...req.body } });
  });
  app.get("/test/s3", (req, res) => res.json({ keys: s3keys }));
  app.get("/test/decodes", (req, res) => res.json(AVATAR_DECODES.stats()));
  app.get("/test/sharpcache", (req, res) => res.json(sharp.cache()));
  app.get("/test/avatar/:userId", async (req, res) => res.json((await getQuery("SELECT avatar FROM users WHERE userId = ?", [req.params.userId]))[0] || {}));
  const server = app.listen(0, "127.0.0.1", () => process.stdout.write("PORT " + server.address().port + "\n"));
})().catch((e) => { console.error("setup failed:", e && e.message); process.exit(3); });
