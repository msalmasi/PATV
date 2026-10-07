require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const fs = require("fs");
const path = require("path");
const port = Number(process.env.PORT) || 3000;
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const { fileURLToPath } = require("url");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const morgan = require("morgan");
const {
  registerUser,
  loginUser,
  updateUsername,
  updateEmail,
  updatePassword,
  updateDisplayname,
  updateAvatar,
  updateDiscordId,
  updateTwitchId,
  updateCamfrogUsername,
  verifyCamfrogLink,
  awardBadge,
  xpForNextLevel,
  updateLevel,
  awardBonus,
  generateUniqueUsername
} = require("./user.controller");
const { createTables, runQuery, getQuery } = require("./dbUtils");
const authenticateToken = require("./middleware/authenticateToken");
const { issueLogin, refreshLogin, clearLogin } = require("./middleware/loginCookie");
const guard = require("./middleware/authGuard");
const { moveUserRows } = require("./accountMerge");
const displaynames = require("./displaynames");
const stale = require("./staleaccounts");          // 1.99bm: archived (stale) accounts
stale.ensure();
stale.ensureNotice();                                // 1.99bs: the archive warning window
const twitchLogin = require("./twitchlogin");       // 1.99bu: users.twitchLogin, saved at Twitch sign-in
twitchLogin.ensure();
stale.startNoticeTimers();
setTimeout(() => require("./accountMerge").ensureCamfrogUnique(), 3000);   // 1.99bs: one account per Camfrog login
setTimeout(() => displaynames.ready().catch((e) => console.error("[displaynames] schema:", e.message)), 2000);
const cookieParser = require("cookie-parser");
const session = require("express-session");
const flash = require("connect-flash");
const crypto = require("crypto");
const sgMail = require("@sendgrid/mail");
const multer = require("multer");
const sharp = require("sharp");
const AWS = require("aws-sdk");
const upload = multer({ dest: "uploads/" });
const axios = require("axios");
const querystring = require("querystring");

const { Resend } = require("resend");
const instanceResend = new Resend(process.env.RESEND_API_KEY);

// AWS S3 configuration
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

let MemoryStore = session.MemoryStore;

// Cookie Parser Middleware
app.use(cookieParser(process.env.APP_SESSION_SECRET));

app.use(
  session({
    secret: process.env.APP_SESSION_SECRET,
    resave: true,
    saveUninitialized: true,
    cookie: { secure: "auto" }, // This should be set based on your environment.
  })
);

app.use(flash());

// // Sessuib
// app.use(session({
//     secret: process.env.APP_SESSION_SECRET,
//     resave: true,  // Forces the session to be saved back to the session store, even if the session was never modified
//     saveUninitialized: false,  // Don't create session until something stored
//     cookie: { secure: 'auto' }  // Use 'auto' to secure cookies only if the connection is secure
// }));

// Set the view engine to ejs
app.set("view engine", "ejs");

// Set the views directory
app.set("views", "./views");
// 1.99dt: <%- ul(name) %> / <%- padLink(room) %> in any view: names link to PATV profiles, rooms to pads (userlinks.js)
require("./userlinks").install(app);
// 1.99ek: <%- boostMark(activePat, cls) %> - the shared 🚀 boost badge (boostmark.js)
require("./boostmark").install(app);

// Set morgan logging
// app.use(morgan("combined"));

// Custom middleware test
// app.use((req, res, next) => {
//   console.log("Request method: ", req.params);
//   next();
// });

// Reject an API request that has no valid session, rather than letting the route dereference
// req.user and throw a 500. addUser deliberately proceeds regardless of token validity (pages need
// to render logged-out), so any route that actually REQUIRES a user has to say so.
// These are fetch/XHR endpoints, so answer with JSON — a redirect would be useless to the caller.
function requireUser(req, res, next) {
  if (!req.user || !req.user.userId) {
    return res
      .status(401)
      .json({ success: false, message: "Your session has expired — please log in again." });
  }
  next();
}

// Helper Middleware for Auth
async function addUser(req, res, next) {
  // Always define req.user (null when not logged in) so callers can test it consistently — it used
  // to be left *undefined* when there was no cookie at all, which reads differently from null.
  // Verified synchronously: the old callback form called next() outside the callback, which only
  // happens to work because jwt.verify is synchronous for a string secret.
  req.user = null;
  const token = req.cookies.jwt;
  if (token) {
    let decoded = null;
    try {
      decoded = jwt.verify(token, process.env.SECRET_KEY);
    } catch (err) {
      decoded = null; // expired or tampered — treat as logged out
    }
    if (decoded) {
      // Current name/class from the DB, sliding renewal, sign-out if the account is gone
      // (middleware/loginCookie.js). A DB hiccup keeps the token's view rather than logging out.
      try {
        req.user = await refreshLogin(res, decoded, getQuery);
      } catch (err) {
        console.error("login refresh failed:", err.message);
        req.user = decoded;
      }
    }
  }
  next(); // Proceed regardless of token validity; use requireUser to demand a session
}

// Connect to SQLite database
const db = new sqlite3.Database("./myapp.db", (err) => {
  if (err) {
    console.error("Error opening database " + err.message);
  } else {
    console.log("Database connected.");
    createTables();
  }
});

module.exports = db;

app.use(cors());
// Parse JSON bodies — except /api/media, which carries clips (several MB of base64) and parses
// with its own larger limit in media.js.
app.use((req, res, next) => (req.path === "/api/media" || req.path === "/api/staking/sync" || req.path === "/api/userstats/sync" || req.path === "/api/econ/charges" || req.path === "/api/econ/participation" || req.path === "/api/roomstats/sync" || req.path === "/api/bridge/sync" || req.path === "/api/bridge/audio" || req.path === "/api/bridge/snap" || req.path === "/api/feed/aigen/chunk" ? next() : express.json()(req, res, next)));
app.use(express.urlencoded({ extended: true }));
// link previews (og.js): every page knows its absolute URL for the Open Graph tags
const og = require("./og");
const userstats = require("./userstats");
const profileLayout = require("./profilelayout");
app.use((req, res, next) => { res.locals.ogBase = og.origin(req); res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
// the nav's inbox bell: unread count for signed-in page views (inbox.js, one indexed COUNT)
const inbox = require("./inbox");
app.use(inbox.navCount);
const messages = require("./messages");             // 1.99cp: direct messages (/messages)
app.use(messages.navCount);
// welcome bonus (welcome.js, 1.99bg): a device id for every browser + signed-in activity days
const welcome = require("./welcome");
const cookieUserId = (req) => {
  const token = req.cookies && req.cookies.jwt;
  if (!token || !process.env.SECRET_KEY) return null;
  try { return (require("jsonwebtoken").verify(token, process.env.SECRET_KEY) || {}).userId || null; } catch (e) { return null; }
};
app.use(welcome.middleware(cookieUserId));
welcome.start();
// 1.99bs: an account warned it'll be archived - a signed-in page view keeps it, with a one-time banner
app.use(stale.noticeMiddleware(cookieUserId));

let clients = []; // Keep track of connected clients for SSE

// Serve static files from the public directory
app.use("/public", express.static("public"));
// Cosmetics: res.locals.cosmeticName(username) for name colors on any page, + the profile's equipped items
const cosmetics = require("./cosmetics");
cosmetics.locals(app);

// Health check for the deploy pipeline: up, and the database answers.
app.get("/healthz", (req, res) => {
  db.get("SELECT 1 AS ok", (err) => {
    if (err) return res.status(503).json({ ok: false, error: "database" });
    res.json({ ok: true, uptime: Math.round(process.uptime()) });
  });
});

// Homepage (home.js): live stats, the live Camfrog room, games, top 5, personal strip
require("./home").register(app, { addUser, xpForNextLevel });
require("./terms").register(app, { addUser });   // 1.99cc: /terms, /privacy, POST /api/terms/accept
require("./guidelines").register(app, { addUser });   // 1.99dc: /guidelines - Padiquette, the site-wide community guidelines

// The admin area (adminweb.js, 1.99cu): /admin Overview + section pages in one shell; /admin/panel -> /admin.
// Same gate as the old /admin/panel: Admin or Staff, else a flash + /login.
require("./adminweb").register(app, { addUser });
// 1.99cy: the XP card's POST /api/admin/update-level (preview, then confirm; admins only; no level-up rewards; audited)
require("./adminxp").register(app, { addUser });

// Welcome bonus admin (welcome.js, 1.99bg): settings, the last decisions, "pay anyway". Admins only.
async function welcomeAdmin(req) {
  if (!req.user || !req.user.userId) return null;
  const u = (await getQuery("SELECT username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
  return u && u.class === "Admin" ? u : null;
}
app.get("/api/admin/welcome", addUser, async (req, res) => {
  try {
    if (!(await welcomeAdmin(req))) return res.status(403).json({ error: "admins only" });
    res.json(await welcome.adminView());
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/admin/welcome/config", addUser, async (req, res) => {
  try {
    if (!guard.sameSite(req)) return res.status(403).json({ error: "cross-site request refused" });
    const a = await welcomeAdmin(req);
    if (!a) return res.status(403).json({ error: "admins only" });
    const c = await welcome.setConfig(req.body || {});
    console.log(`[welcome] config set by ${a.username}: ${JSON.stringify(c)}`);
    res.json({ ok: true, config: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Stale-account cleanup (1.99bs): the warning window's dates and counts for the admin panel card.
app.get("/api/admin/stale", addUser, async (req, res) => {
  try {
    if (!(await welcomeAdmin(req))) return res.status(403).json({ error: "admins only" });
    res.json(await stale.noticeSummary());
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Pepe: the Camfrog logins still warned (he PMs them when he sees them), and "I saw this login"
// (they're active again: the warning is cleared).
app.get("/api/stale/notice-logins", async (req, res) => {
  if (!isBotToken(req.query.password)) return res.status(403).json({ error: "unauthorized" });
  try { res.json(await stale.pendingLogins()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/stale/seen", async (req, res) => {
  const b = req.body || {};
  if (!isBotToken(b.password)) return res.status(403).json({ error: "unauthorized" });
  try { res.json({ ok: true, cleared: await stale.seenLogin(b.login, "seen in Camfrog") }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/admin/welcome/pay", addUser, async (req, res) => {
  try {
    if (!guard.sameSite(req)) return res.status(403).json({ error: "cross-site request refused" });
    const a = await welcomeAdmin(req);
    if (!a) return res.status(403).json({ error: "admins only" });
    const r = await welcome.payout(String((req.body || {}).userId || ""), true);
    console.log(`[welcome] ${a.username} paid ${(req.body || {}).userId} anyway: ${JSON.stringify(r)}`);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Just for fun
app.get("/friendo", (req, res) => {
  res.render("friendo", { title: "friendo" });
});

// Example route with authentication middleware
app.get("/protected", authenticateToken, (req, res) => {
  res.json({ message: "Protected route accessed successfully." });
});

// ── Sign in / register / password reset pages (views/login.ejs, register.ejs, forgotPassword.ejs,
// resetPassword.ejs; handlers in user.controller.js; helpers in middleware/authGuard.js) ──
// Everything an auth page renders with: flash messages, what the visitor typed last time (never a
// password), and a safe "return to" path - ?next= when given, else the page they came from.
function authView(req, extra) {
  let form = {};
  // the newest one wins (two posts without a page view in between leave two)
  try { form = JSON.parse(req.flash("authForm").slice(-1)[0] || "{}") || {}; } catch (e) { form = {}; }
  return Object.assign({
    user: req.user ? req.user.username : null,
    errors: [...new Set(req.flash("error"))],   // repeated posts shouldn't stack the same message
    success: [...new Set(req.flash("success"))],
    form,
    next: guard.safeNext(req.query.next) || guard.refererNext(req) || "",
  }, extra || {});
}

app.get("/register", addUser, (req, res) => {
  if (req.user && req.user.username) return res.redirect(guard.safeNext(req.query.next) || `/u/${encodeURIComponent(req.user.username)}`);
  res.render("register", authView(req));
});

app.get("/login", addUser, (req, res) => {
  if (req.user && req.user.username) return res.redirect(guard.safeNext(req.query.next) || `/u/${encodeURIComponent(req.user.username)}`);
  res.render("login", authView(req));
});

// ── OAuth (Twitch / Discord) sign-in ──
// `state` ties the callback to the browser that started it: without it, someone could send you a
// callback link carrying THEIR code and link their Twitch/Discord to your account (or sign you in
// as them). The start route also remembers where to return to.
function oauthBegin(req, provider) {
  const state = crypto.randomBytes(18).toString("hex");
  req.session.oauth = { provider, state, next: guard.safeNext(req.query.next), at: Date.now() };
  return state;
}
function oauthCheck(req, provider) {
  const o = req.session && req.session.oauth;
  if (req.session) delete req.session.oauth;
  const got = typeof req.query.state === "string" ? req.query.state : "";
  if (!o || o.provider !== provider || !o.state || got.length !== o.state.length) return null;
  if (Date.now() - (o.at || 0) > 15 * 60 * 1000) return null;
  if (!crypto.timingSafeEqual(Buffer.from(got), Buffer.from(o.state))) return null;
  return o;
}
// The session cookie is per host: start on the same host the provider will call back to.
function oauthHostBounce(req, redirectUri) {
  try {
    const cb = new URL(redirectUri);
    if (cb.host && req.get("host") && cb.host !== req.get("host")) return cb.origin + req.originalUrl;
  } catch (e) { /* bad config: carry on */ }
  return null;
}
function oauthFail(req, res, msg) {
  req.flash("error", msg);
  return res.redirect("/login");
}

// HTTP GET endpoint for verifying endpoint
app.get("/verify-email", async (req, res) => {
  const { token } = req.query;
  const sql = `SELECT userId, tokenExpires FROM users WHERE emailVerificationToken = ?`;

  try {
    const results = await getQuery(sql, [token]);
    if (!results || results.length === 0) {
      req.flash("error", "Invalid or expired token");
      return res.redirect("/login");
    }

    const result = results[0];
    if (new Date(result.tokenExpires) < new Date()) {
      req.flash("error", "Token has expired");
      return res.redirect("/login");
    }

    const updateSql = `UPDATE users SET isEmailVerified = 1, emailVerificationToken = NULL, tokenExpires = NULL WHERE userId = ?`;
    const updateResult = await runQuery(updateSql, [result.userId]);
    if (updateResult.changes > 0) {
      // Award badge for email verification
      const badgeId = 'ilovespam'; // Replace with your actual badge ID
      await awardBadge(result.userId, badgeId);
      req.flash("success", "Email verified successfully!");
    } else {
      req.flash("error", "No changes made to the database.");
    }
    res.redirect("/login");
  } catch (error) {
    console.error("Failed to verify email", error);
    req.flash("error", "Server error");
    res.redirect("/login");
  }
});

app.get("/auth/twitch", (req, res) => {
  const redirectUri = process.env.TWITCH_AUTH_CALLBACK;
  if (!redirectUri || !process.env.TWITCH_CLIENT_ID) return oauthFail(req, res, "Twitch sign-in isn't available right now.");
  const bounce = oauthHostBounce(req, redirectUri);
  if (bounce) return res.redirect(bounce);
  const twitchAuthUrl = `https://id.twitch.tv/oauth2/authorize?${querystring.stringify(
    {
      client_id: process.env.TWITCH_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "user:read:email user:read:subscriptions",
      state: oauthBegin(req, "twitch"),
    }
  )}`;
  res.redirect(twitchAuthUrl);
});

app.get("/auth/twitch/callback", async (req, res) => {
  if (req.query.error || !req.query.code) return oauthFail(req, res, "Twitch sign-in was cancelled.");
  const oauth = oauthCheck(req, "twitch");
  if (!oauth) return oauthFail(req, res, "That Twitch sign-in expired or didn't start here. Please try again.");
  try {
    const code = req.query.code;
    const redirectUri = process.env.TWITCH_AUTH_CALLBACK;

    // Exchange code for an access token
    const tokenResponse = await axios.post(
      "https://id.twitch.tv/oauth2/token",
      querystring.stringify({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_SECRET_KEY,
        code: code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const accessToken = tokenResponse.data.access_token;

    // Use the access token to get user information from Twitch
    const userProfileResponse = await axios.get(
      "https://api.twitch.tv/helix/users",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Client-ID": "bkwg34x1vqv51507a603f0e0clpg4b",
        },
      }
    );

    const twitchUser = userProfileResponse.data.data[0];
    if (!twitchUser || !twitchUser.id) throw new Error("no Twitch user in the response");
    // 1.99bu: keep the real Twitch login (the channel name) fresh on whichever account holds this id;
    // saved again below once a link / new account exists
    await twitchLogin.save(twitchUser.id, twitchUser.login);

    // Attempt to decode the existing JWT from the cookie
    let currentUser;
    if (req.cookies.jwt) {
      try {
        currentUser = jwt.verify(req.cookies.jwt, process.env.SECRET_KEY);
      } catch (error) {
        console.error("JWT verification failed:", error);
      }
    }

    if (currentUser) {
      // Check if Twitch ID is already associated with another account
      const existingTwitchUser = await getQuery(
        "SELECT * FROM users WHERE twitchId = ? AND userId != ?",
        [twitchUser.id, currentUser.userId]
      );
      if (existingTwitchUser.length > 0) {
        // There is another user with the same Twitch ID
        // Temporarily store necessary info in session or another store
        req.session.conflict = {
          existingUserId: existingTwitchUser[0].userId,
          existingPAT: existingTwitchUser[0].points_balance,
          currentUserId: currentUser.userId,
          currentUserUsername: currentUser.username,
          twitchId: twitchUser.id,
          twitchDisplayname: twitchUser.display_name,
          twitchLogin: twitchLogin.clean(twitchUser.login),
        };
        return res.redirect("/resolve-twitch-conflict"); // Redirect to a page to handle the decision
      } else {
        // No conflict, update current user with Twitch ID
        const bonus = await getQuery(`SELECT twitchBonus FROM users WHERE userId = ?`, [currentUser.userId]);
        if (bonus[0].twitchBonus === 0) {
          const badgeId = 'twitch-user'; // Replace with your actual badge ID
          await awardBadge(currentUser.userId, badgeId);
          await welcome.connectBonus(currentUser.userId, "twitch", twitchUser.id, awardBonus)
        }
        await runQuery(
          "UPDATE users SET twitchId = ?, twitchDisplayname = ?, twitchBonus = ?, twitchBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
          [twitchUser.id, twitchUser.display_name, 1, currentUser.userId]
        );
        await twitchLogin.save(twitchUser.id, twitchUser.login);
        // Award Badge
        return res.redirect(`/u/${encodeURIComponent(currentUser.username)}/edit`);
      }
    } else {
      // Handle new or returning Twitch users
      const existingUser = await getQuery(
        "SELECT * FROM users WHERE twitchId = ?",
        [twitchUser.id]
      );

      // Returning User Found
      if (existingUser.length > 0) {
        currentUser = existingUser[0];
      } else {
        // No user found, check if there is a user with the same email.
        // (Twitch only reports a verified email address)
        const existingTwitchEmail = twitchUser.email ? await getQuery(
          "SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
          [twitchUser.email]
        ) : [];
        if (existingTwitchEmail.length > 0) {
          const bonus = await getQuery(`SELECT twitchBonus FROM users WHERE userId = ?`, [existingTwitchEmail[0].userId]);
          if (bonus[0].twitchBonus === 0) {
            const badgeId = 'twitch-user'; // Replace with your actual badge ID
            await awardBadge(existingTwitchEmail[0].userId, badgeId);
            await welcome.connectBonus(existingTwitchEmail[0].userId, "twitch", twitchUser.id, awardBonus)
          }
          await runQuery(
            "UPDATE users SET twitchId = ?, twitchDisplayname = ?, twitchBonus = ?, twitchBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
            [twitchUser.id, twitchUser.display_name, 1, existingTwitchEmail[0].userId]
          );
          currentUser = existingTwitchEmail[0];
        } else {
          //create a new user
          const newUserUsername = await generateUniqueUsername(twitchUser.display_name);
          const password = Math.random().toString(36).substring(2, 15);
          const hashedPassword = await bcrypt.hash(password, 12);
          const newUser = {
            userId: uuidv4(),
            username: newUserUsername,
            displayname: displaynames.usable(twitchUser.display_name) || newUserUsername,
            email: twitchUser.email,
            password: hashedPassword,
            twitchId: twitchUser.id,
            twitchDisplayname: twitchUser.display_name,
            avatar: twitchUser.profile_image_url,
            points_balance: 0,          // 1.99bg: the welcome bonus vests instead (welcome.js)
          };
          await runQuery(
            "INSERT INTO users (userId, username, displayname, email, password, twitchId, twitchDisplayname, avatar, points_balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              newUser.userId,
              newUser.username,
              newUser.displayname,
              newUser.email,
              newUser.password,
              newUser.twitchId,
              newUser.twitchDisplayname,
              newUser.avatar,
              newUser.points_balance,
            ]
          );
          await displaynames.markNewAccount(newUser.userId).catch(() => {});
          const bonus = await getQuery(`SELECT twitchBonus FROM users WHERE userId = ?`, [newUser.userId]);
          if (bonus[0].twitchBonus === 0) {
            const newUserBadgeId = 'fresh_meat'; // Ensure this ID matches the one in your badges table
            await awardBadge(newUser.userId, newUserBadgeId);
            const badgeId = 'twitch-user'; // Replace with your actual badge ID
            await awardBadge(newUser.userId, badgeId);
          }
          // 1.99bg: no connect bonus for an account this sign-in created - its welcome bonus vests
          await welcome.enroll(newUser.userId, "twitch", req, res);
          await runQuery(
            "UPDATE users SET twitchBonus = ?, twitchBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
            [1, newUser.userId]
          );
          currentUser = newUser;
        }
      }
      await twitchLogin.save(twitchUser.id, twitchUser.login);
      await stale.touch(currentUser.userId, "twitch sign-in");   // 1.99bm: an archived account comes back
      // Sign them in (90-day sliding login - see middleware/loginCookie.js)
      issueLogin(res, currentUser);
      res.redirect(oauth.next || "/");
    }
  } catch (error) {
    console.error("Failed to authenticate with Twitch:", error && error.message);
    if (!res.headersSent) oauthFail(req, res, "Twitch sign-in didn't work. Please try again.");
  }
});

// ── Twitch / Discord account conflicts ──
// Linking a Twitch/Discord that another PATV account already has: the callback stores the details
// in the session and sends you here to merge that account into yours (or keep them apart).
const LINKS = {
  twitch: { label: "Twitch", idCol: "twitchId", nameCol: "twitchDisplayname", id: (c) => c.twitchId, name: (c) => c.twitchDisplayname,
            bonusCol: "twitchBonus", badge: "twitch-user", bonusType: "twitch connect", otherIdCol: "discordId", otherNameCol: "discordUsername" },
  discord: { label: "Discord", idCol: "discordId", nameCol: "discordUsername", id: (c) => c.discordId, name: (c) => c.discordUsername,
             bonusCol: "discordBonus", badge: "discord-user", bonusType: "discord connect", otherIdCol: "twitchId", otherNameCol: "twitchDisplayname" },
};

// The pending conflict for this provider, only for the signed-in account it was made for.
function pendingConflict(req, provider) {
  const c = req.session && req.session.conflict;
  if (!c || !LINKS[provider].id(c)) return null;
  if (!req.user || req.user.userId !== c.currentUserId) return null;
  return c;
}

async function conflictPage(req, res, provider) {
  const L = LINKS[provider];
  const c = pendingConflict(req, provider);
  if (!c) return res.redirect(req.user ? `/u/${encodeURIComponent(req.user.username)}/edit` : "/login");
  try {
    const other = (await getQuery("SELECT username, displayname, points_balance FROM users WHERE userId = ?", [c.existingUserId]))[0];
    if (!other) {
      delete req.session.conflict;
      req.flash("error", `That ${L.label} account's other PATV account no longer exists. Try linking ${L.label} again.`);
      return res.redirect(`/u/${encodeURIComponent(req.user.username)}/edit`);
    }
    res.render("resolve-conflict", {
      user: req.user.username,
      provider,
      label: L.label,
      action: `/merge-accounts-${provider}`,
      linkedName: L.name(c) || "",
      currentUsername: req.user.username,
      otherUsername: other.username,
      otherPAT: Number(other.points_balance) || 0,
      errors: req.flash("error"),
    });
  } catch (e) {
    console.error(`[auth] ${provider} conflict page:`, e.message);
    res.status(500).send("Something went wrong. Please try again.");
  }
}

async function mergeConflict(req, res, provider) {
  const L = LINKS[provider];
  if (!guard.sameSite(req)) return res.status(403).send("Cross-site request refused");
  const c = pendingConflict(req, provider);
  if (!c) return res.redirect(req.user ? `/u/${encodeURIComponent(req.user.username)}/edit` : "/login");
  const body = req.body || {};
  if (body.decision === "yes" && body.confirm !== "1") {
    req.flash("error", "Tick the box to confirm the merge.");
    return res.redirect(`/resolve-${provider}-conflict`);
  }
  // one decision per conflict: a double-submit or a replay finds nothing pending
  delete req.session.conflict;
  const edit = `/u/${encodeURIComponent(req.user.username)}/edit`;
  if (body.decision !== "yes") {
    req.flash("success", `Kept separate - your ${L.label} stays linked to the other account.`);
    return res.redirect(edit);
  }
  const fromId = c.existingUserId, toId = c.currentUserId;
  try {
    const from = (await getQuery("SELECT * FROM users WHERE userId = ?", [fromId]))[0];
    const to = (await getQuery(`SELECT ${L.otherIdCol} AS otherId, camfrogUsername FROM users WHERE userId = ?`, [toId]))[0];
    if (!from || !to || fromId === toId) {
      req.flash("error", "That account no longer exists - nothing to merge.");
      return res.redirect(edit);
    }
    // the other provider's link and the Camfrog name come along when this account has none
    if (!to.otherId && from[L.otherIdCol]) {
      await runQuery(`UPDATE users SET ${L.otherIdCol} = ?, ${L.otherNameCol} = ? WHERE userId = ?`, [from[L.otherIdCol], from[L.otherNameCol], toId]);
    }
    if (!to.camfrogUsername && from.camfrogUsername) {
      await runQuery("UPDATE users SET camfrogUsername = NULL WHERE userId = ?", [fromId]);
      await runQuery("UPDATE users SET camfrogUsername = ? WHERE userId = ?", [from.camfrogUsername, toId]);
    }
    await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [Number(from.points_balance) || 0, toId]);
    await runQuery(`UPDATE users SET ${L.idCol} = ?, ${L.nameCol} = ? WHERE userId = ?`, [L.id(c), L.name(c), toId]);
    // 1.99bu: the Twitch login comes along with the Twitch id (this sign-in's, else the merged account's)
    if (provider === "twitch" && c.twitchLogin) await twitchLogin.save(L.id(c), c.twitchLogin);
    else if (from.twitchLogin && from.twitchId) await twitchLogin.save(from.twitchId, from.twitchLogin);
    // keep the merged account's PAT history with the balance it brings (else /history can't add up),
    // and everything else it owned (badges, cosmetics, spins, orders... - accountMerge.js)
    await runQuery("UPDATE transactions SET userId = ? WHERE userId = ?", [toId, fromId]);
    const moved = await moveUserRows(fromId, toId);
    console.log(`[auth] ${provider} merge ${fromId} -> ${toId}: +${Number(from.points_balance) || 0} PAT, ${JSON.stringify(moved)}`);
    await runQuery("DELETE FROM users WHERE userId = ?", [fromId]);
    const bonus = await getQuery(`SELECT ${L.bonusCol} AS b FROM users WHERE userId = ?`, [toId]);
    if (bonus[0] && bonus[0].b === 0) {
      try { await awardBadge(toId, L.badge); } catch (e) { /* already has it */ }
      await welcome.connectBonus(toId, provider, L.id(c), awardBonus);
    }
    await runQuery(`UPDATE users SET ${L.bonusCol} = 1, ${L.bonusCol}_at = CURRENT_TIMESTAMP WHERE userId = ?`, [toId]);
    req.flash("success", `Accounts merged - ${L.label} is linked here now and ${(Number(from.points_balance) || 0).toLocaleString("en-US")} PAT came with it.`);
    res.redirect(edit);
  } catch (error) {
    console.error(`[auth] ${provider} merge failed:`, error && error.message);
    req.flash("error", "Merging the accounts failed partway - please ask staff to check your account.");
    res.redirect(edit);
  }
}

app.get("/resolve-twitch-conflict", addUser, (req, res) => conflictPage(req, res, "twitch"));
app.post("/merge-accounts-twitch", addUser, (req, res) => mergeConflict(req, res, "twitch"));
app.get("/resolve-discord-conflict", addUser, (req, res) => conflictPage(req, res, "discord"));
app.post("/merge-accounts-discord", addUser, (req, res) => mergeConflict(req, res, "discord"));

// Endpoint for Discord auth
app.get("/auth/discord", (req, res) => {
  const redirectUri = process.env.DISCORD_AUTH_CALLBACK;
  if (!redirectUri || !process.env.DISCORD_CLIENT_ID) return oauthFail(req, res, "Discord sign-in isn't available right now.");
  const bounce = oauthHostBounce(req, redirectUri);
  if (bounce) return res.redirect(bounce);
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?${querystring.stringify(
    {
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify email",
      state: oauthBegin(req, "discord"),
    }
  )}`;
  res.redirect(discordAuthUrl);
});

app.get("/auth/discord/callback", async (req, res) => {
  if (req.query.error || !req.query.code) return oauthFail(req, res, "Discord sign-in was cancelled.");
  const oauth = oauthCheck(req, "discord");
  if (!oauth) return oauthFail(req, res, "That Discord sign-in expired or didn't start here. Please try again.");
  try {
    const code = req.query.code;
    const redirectUri = process.env.DISCORD_AUTH_CALLBACK;

    // Exchange the code for an access token
    const tokenResponse = await axios.post(
      "https://discord.com/api/oauth2/token",
      querystring.stringify({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_SECRET_KEY,
        code: code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const accessToken = tokenResponse.data.access_token;

    // Use the access token to get user information from Discord
    const userProfileResponse = await axios.get(
      "https://discord.com/api/users/@me",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const discordUser = userProfileResponse.data;
    if (!discordUser || !discordUser.id) throw new Error("no Discord user in the response");
    // Only trust a Discord email Discord has verified: it's used to find an existing account to sign
    // in to, so an unverified one would let anyone claim an account by its email.
    const discordEmail = discordUser.verified && discordUser.email ? discordUser.email : null;

    // Attempt to decode the existing JWT from the cookie
    let currentUser;
    if (req.cookies.jwt) {
      try {
        currentUser = jwt.verify(req.cookies.jwt, process.env.SECRET_KEY);
      } catch (error) {
        console.error("JWT verification failed:", error);
      }
    }

    if (currentUser) {
      // Update existing user record with Discord ID
      const existingDiscordUser = await getQuery(
        "SELECT * FROM users WHERE discordId = ? AND userId != ?",
        [discordUser.id, currentUser.userId]
      );
      if (existingDiscordUser.length > 0) {
        req.session.conflict = {
          existingUserId: existingDiscordUser[0].userId,
          existingPAT: existingDiscordUser[0].points_balance,
          currentUserId: currentUser.userId,
          currentUserUsername: currentUser.username,
          discordId: discordUser.id,
          discordUsername: discordUser.username,
        };
        return res.redirect("/resolve-discord-conflict");
      } else {
        const bonus = await getQuery(`SELECT discordBonus FROM users WHERE userId = ?`, [currentUser.userId]);
        if (bonus[0].discordBonus === 0) {
          const badgeId = 'discord-user'; // Replace with your actual badge ID
          await awardBadge(currentUser.userId, badgeId);
          await welcome.connectBonus(currentUser.userId, "discord", discordUser.id, awardBonus)
        }
        await runQuery(
          "UPDATE users SET discordId = ?, discordUsername = ?, discordBonus = ?, discordBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
          [discordUser.id, discordUser.username, 1, currentUser.userId]
        );
        return res.redirect(`/u/${encodeURIComponent(currentUser.username)}/edit`);
      }
    } else {
      // Handle new or returning Discord users
      const existingUser = await getQuery(
        "SELECT * FROM users WHERE discordId = ?",
        [discordUser.id]
      );
      if (existingUser.length > 0) {
        currentUser = existingUser[0];
      } else {
        // No user found, check if there is a user with the same email.
        const existingDiscordEmail = discordEmail ? await getQuery(
          "SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
          [discordEmail]
        ) : [];
        if (existingDiscordEmail.length > 0) {
          const bonus = await getQuery(`SELECT discordBonus FROM users WHERE userId = ?`, [existingDiscordEmail[0].userId]);
          if (bonus[0].discordBonus === 0) {
            const badgeId = 'discord-user'; // Replace with your actual badge ID
            await awardBadge(existingDiscordEmail[0].userId, badgeId);
            await welcome.connectBonus(existingDiscordEmail[0].userId, "discord", discordUser.id, awardBonus)
          }
          await runQuery(
            "UPDATE users SET discordId = ?, discordUsername = ?, discordBonus = ?, discordBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
            [discordUser.id, discordUser.username, 1, existingDiscordEmail[0].userId]
          );
          currentUser = existingDiscordEmail[0];
        } else {
          // Create a new user
          const password = Math.random().toString(36).substring(2, 15);
          const hashedPassword = await bcrypt.hash(password, 12);
          const newUserUsername = await generateUniqueUsername(discordUser.username);
          const newUser = {
            userId: uuidv4(),
            username: newUserUsername, // Discord username
            // the Discord display ("global") name, else their Discord username, else ours
            displayname: displaynames.usable(discordUser.global_name) || displaynames.usable(discordUser.username) || newUserUsername,
            email: discordEmail, // Discord email (verified only)
            password: hashedPassword,
            avatar: `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`,
            discordId: discordUser.id,
            discordUsername: discordUser.username,
            points_balance: 0,          // 1.99bg: the welcome bonus vests instead (welcome.js)
          };
          
          await runQuery(
            "INSERT INTO users (userId, username, displayname, email, password, avatar, discordId, discordUsername, points_balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              newUser.userId,
              newUser.username,
              newUser.displayname,
              newUser.email,
              newUser.password,
              newUser.avatar,
              newUser.discordId,
              newUser.discordUsername,
              newUser.points_balance,
            ]
          );
          await displaynames.markNewAccount(newUser.userId).catch(() => {});
          const bonus = await getQuery(`SELECT discordBonus FROM users WHERE userId = ?`, [newUser.userId]);
          if (bonus[0].discordBonus === 0) {
            const newUserBadgeId = 'fresh_meat'; // Ensure this ID matches the one in your badges table
            await awardBadge(newUser.userId, newUserBadgeId);
            const badgeId = 'discord-user'; // Replace with your actual badge ID
            await awardBadge(newUser.userId, badgeId);
          }
          // 1.99bg: no connect bonus for an account this sign-in created - its welcome bonus vests
          await welcome.enroll(newUser.userId, "discord", req, res);
          await runQuery(
            "UPDATE users SET discordBonus = ?, discordBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
            [1, newUser.userId]
          );
          currentUser = newUser;
        }
      }
      await stale.touch(currentUser.userId, "discord sign-in");   // 1.99bm: an archived account comes back
      // Sign them in (90-day sliding login - see middleware/loginCookie.js)
      issueLogin(res, currentUser);
      res.redirect(oauth.next || "/");
    }
  } catch (error) {
    console.error("Failed to authenticate with Discord:", error && error.message);
    if (!res.headersSent) oauthFail(req, res, "Discord sign-in didn't work. Please try again.");
  }
});

// Who's on the public/OBS wheel, with their equipped name colour (cosmetics.nameStyle is a cached
// lookup) - resolved ONCE here and carried on the events, never per viewer.
async function spinnerLook(userId) {
  try {
    const u = (await getQuery("SELECT username, displayname FROM users WHERE userId = ?", [userId]))[0];
    if (!u) return { name: "", display: "", nameCss: "" };
    // nameStyles() WAITS for the name cache; the sync nameStyle() returned "" on a cold cache (the first
    // spins after a site restart showed no colour on the stage / OBS wheel)
    const css = (await cosmetics.nameStyles([u.username]))[u.username] || "";
    return { name: u.username, display: u.displayname || u.username, nameCss: css };
  } catch (e) {
    return { name: "", display: "", nameCss: "" };
  }
}

// The stage wheel's "NOW SPINNING / LAST SPIN" line (homepage): the latest public spin as JSON.
app.get("/api/g/wheel/last.json", async (req, res) => {
  try {
    const r = (await getQuery("SELECT userId, result, payout, timestamp FROM wheel_spins WHERE type = 'public' AND result IN ('PENDING','SETTLED') ORDER BY timestamp DESC LIMIT 1"))[0];
    if (!r) return res.json({ spin: null });
    res.json({ spin: Object.assign({ state: r.result === "PENDING" ? "spinning" : "done", result: r.result === "SETTLED" ? Number(r.payout) || 0 : null, at: r.timestamp }, await spinnerLook(r.userId)) });
  } catch (e) {
    res.json({ spin: null });
  }
});

// HTTP GET endpoint to retrieve the last result.
app.get("/api/g/wheel/last-result", async (req, res) => {
  const sql = `
        SELECT userId, result
        FROM wheel_spins
        WHERE type = 'public'
        ORDER BY timestamp DESC
        LIMIT 1
    `;

  try {
    const lastResult = await getQuery(sql);
    if (!lastResult) {
      return res.status(404).send("No public spin results found.");
    }

    // Fetch username based on userId
    const userSql = `SELECT displayname FROM users WHERE userId = ?`;
    const user = await getQuery(userSql, [lastResult[0].userId]);
    console.log(user[0]);

    if (lastResult[0].result === "PENDING") {
      res.render("nowSpinning", { username: user[0].displayname });
    } else {
      res.render("lastSpinner", { username: user[0].displayname });
    }
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).send("Failed to fetch the last result.");
  }
});

// ── Forgot / reset password ──
// The emailed link carries a random token; the database keeps only its SHA-256, with an expiry
// (ms since epoch). The forgot form always answers the same way, so it can't be used to find out
// which emails have accounts, and the email goes out in the background (no timing hint either).
// (This used to call db.get/db.run as if they returned rows - they return the Database - so every
// reset link "worked", even made-up ones, expired tokens still changed the password, and a bad
// token reported "Success!" while changing nothing.)
const RESET_TTL_MS = 60 * 60 * 1000;
const forgotIpLimit = guard.limiter({ max: 6, windowMs: 60 * 60 * 1000 });
const forgotEmailLimit = guard.limiter({ max: 3, windowMs: 60 * 60 * 1000 });
const resetTokenOk = (t) => typeof t === "string" && /^[a-f0-9]{40,64}$/i.test(t);
const sha256 = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

// Links in emails point at the real site, never at whatever Host header the request carried.
function siteOrigin(req) {
  const h = String(req.get("host") || "").toLowerCase();
  return /^((www|staging)\.)?publicaccess\.tv$/.test(h) ? `https://${h}` : "https://publicaccess.tv";
}

async function sendResetMail(to, resetUrl) {
  const subject = "Reset your PATV password";
  const text = `Someone (hopefully you) asked to reset the password for your publicaccess.tv account.\n\n`
    + `Choose a new password here (the link works for 1 hour):\n${resetUrl}\n\n`
    + `If you didn't ask for this, ignore this email - your password stays the same.\n`;
  const html = `<p>Someone (hopefully you) asked to reset the password for your publicaccess.tv account.</p>`
    + `<p><a href="${resetUrl}">Choose a new password</a> - the link works for 1 hour.</p>`
    + `<p>If you didn't ask for this, ignore this email - your password stays the same.</p>`;
  if (process.env.RESEND_API_KEY) {
    const r = await instanceResend.emails.send({ from: "no-reply@publicaccess.tv", to, subject, text, html });
    if (r && r.error) throw new Error(r.error.message || "Resend refused the email");
    return "resend";
  }
  if (process.env.SENDGRID_API_KEY) {
    await sgMail.send({ from: "no-reply@publicaccess.tv", to, subject, text, html });
    return "sendgrid";
  }
  throw new Error("no mailer configured");
}

app.get("/forgot-password", addUser, (req, res) => {
  res.render("forgotPassword", authView(req));
});

app.post("/forgot-password", async (req, res) => {
  if (!guard.sameSite(req)) return res.status(403).send("Cross-site request refused");
  const email = String((req.body && req.body.email) || "").trim();
  const bad = guard.checkEmail(email);
  if (bad) {
    req.flash("error", bad);
    req.flash("authForm", JSON.stringify({ email: email.slice(0, 254), field: "email" }));
    return res.redirect("/forgot-password");
  }
  const ip = guard.clientIp(req);
  const wait = forgotIpLimit.blocked(ip);
  if (wait) {
    req.flash("error", `Too many reset requests. Try again in ${guard.waitText(wait)}.`);
    return res.redirect("/forgot-password");
  }
  forgotIpLimit.hit(ip);
  try {
    const key = email.toLowerCase();
    if (!forgotEmailLimit.blocked(key)) {
      forgotEmailLimit.hit(key);
      const rows = await getQuery("SELECT userId FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1", [email]);
      if (rows.length) {
        const token = crypto.randomBytes(32).toString("hex");
        await runQuery("UPDATE users SET resetPasswordToken = ?, resetPasswordExpires = ? WHERE userId = ?",
                       [sha256(token), Date.now() + RESET_TTL_MS, rows[0].userId]);
        if (guard.undeliverable(email)) {
          console.log("[auth] reset email skipped (reserved test domain)");
        } else {
          sendResetMail(email, `${siteOrigin(req)}/reset-password/${token}`)
            .then((via) => console.log(`[auth] reset email sent (${via})`))
            .catch((e) => console.error("[auth] reset email failed:", e.message));
        }
      }
    }
  } catch (error) {
    console.error("[auth] forgot-password error:", error.message);
  }
  req.flash("success", "If an account uses that email, a reset link is on its way. It works for 1 hour - check your spam folder too.");
  req.flash("authForm", JSON.stringify({ sent: true }));
  res.redirect("/forgot-password");
});

app.get("/reset-password/:token", addUser, async (req, res) => {
  const token = req.params.token;
  try {
    const ok = resetTokenOk(token) && (await getQuery(
      "SELECT userId FROM users WHERE resetPasswordToken = ? AND resetPasswordExpires > ? LIMIT 1", [sha256(token), Date.now()])).length > 0;
    if (!ok) {
      req.flash("error", "That reset link is invalid or has expired. Ask for a new one below.");
      return res.redirect("/forgot-password");
    }
    res.set("Referrer-Policy", "no-referrer");   // the token is in this URL
    res.render("resetPassword", authView(req, { token }));
  } catch (error) {
    console.error("[auth] reset page error:", error.message);
    req.flash("error", "Something went wrong opening that link. Please try again.");
    res.redirect("/forgot-password");
  }
});

app.post("/reset-password/:token", async (req, res) => {
  if (!guard.sameSite(req)) return res.status(403).send("Cross-site request refused");
  const token = req.params.token;
  const backHere = (msg, field) => {
    req.flash("error", msg);
    req.flash("authForm", JSON.stringify({ field }));
    return res.redirect(`/reset-password/${encodeURIComponent(token)}`);
  };
  const expired = () => {
    req.flash("error", "That reset link is invalid or has expired. Ask for a new one below.");
    return res.redirect("/forgot-password");
  };
  try {
    if (!resetTokenOk(token)) return expired();
    const hash = sha256(token);
    const rows = await getQuery(
      "SELECT userId, username FROM users WHERE resetPasswordToken = ? AND resetPasswordExpires > ? LIMIT 1", [hash, Date.now()]);
    if (!rows.length) return expired();
    const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";
    const problem = guard.checkPassword(password, rows[0].username);
    if (problem) return backHere(problem, "password");
    if (password !== (req.body && req.body.confirm_password)) return backHere("Those passwords don't match.", "confirm_password");
    const hashedPassword = await bcrypt.hash(password, 12);
    const r = await runQuery(
      "UPDATE users SET password = ?, resetPasswordToken = NULL, resetPasswordExpires = NULL WHERE userId = ? AND resetPasswordToken = ? AND resetPasswordExpires > ?",
      [hashedPassword, rows[0].userId, hash, Date.now()]);
    if (!r.changes) return expired();
    console.log(`[auth] password reset for ${rows[0].username}`);
    clearLogin(res);
    req.flash("success", "Password changed. Sign in with your new password.");
    req.flash("authForm", JSON.stringify({ username: rows[0].username }));
    res.redirect("/login");
  } catch (error) {
    console.error("[auth] reset password error:", error.message);
    backHere("Something went wrong changing your password. Please try again.");
  }
});

app.get("/info", addUser, (req, res) => {
  const username = req.user ? req.user.username : null; // Fallback to null if no user in session
  // Retrieve flash messages and pass them to the EJS template
  let errorMessages = req.flash("error");
  let successMessages = req.flash("success");
  res.render("info", {
    user: username,
    errors: errorMessages,
    success: successMessages,
  });
});

// ── PAT history: a readable transaction log (history.js). You see your own; admins/staff can
// look anyone up by username or Camfrog name. ──
// Clips & snaps (moved off Netlify) and prediction markets. The feed (1.99bv, feedweb.js) owns /feed:
// user posts to the main feed and to rooms, plus these captures.
// 1.99ck: "pads" (p/<slug>) - the 301s from the old /rooms/..., /feed/c/<slug> addresses come first
require("./pads").register(app);
require("./feedweb").register(app, { isBotToken, addUser });
require("./aigen").register(app, { isBotToken, addUser });   // 1.99di: AI pictures / videos for posts (Pepe's !imagine / !video from the composer)
require("./pepefeed").register(app, { isBotToken, addUser });   // 1.99cg: Pepe answers mentions / takes part on the feed (bot API + settings)
require("./feedautomod").register(app, { isBotToken, addUser });   // 1.99dc: Pepe's feed automod (verdicts, settings, reversals, notices)
require("./padrules").register(app, { addUser });   // 1.99dc: a pad's own rules (else Padiquette)
require("./padsettings").register(app, { addUser });   // 1.99dc: the pad settings hub /p/:slug/settings (was /manage + /mod)
require("./padlook").register(app, { addUser });       // 1.99es: a pad's look - avatar, banner, accent (/api/rooms/:slug/look, /media/pad/<file>)
require("./follows").register(app, { addUser });   // 1.99bz: following rooms + people
messages.register(app, { isBotToken, addUser });   // 1.99cp: direct messages + Pepe's Camfrog alerts for them
require("./stories").register(app, { addUser });   // 1.99bz: Pepe's captures as stories
require("./storykeep").register(app, { addUser });   // 1.99eq: stories -> 📌 Post to pad / 🔖 Save (/u/<me>/saved), "Remove me"
require("./hop").register(app, { addUser });   // 1.99eq: Hop - the full-screen media viewer (/hop, /p/<pad>/hop, /u/<user>/hop, /api/hop)
require("./media").register(app, { isBotToken, addUser });
require("./markets").register(app, { isBotToken, addUser });
const gtf = require("./gtf");
gtf.register(app, { isBotToken, addUser });
require("./bounties").register(app, { isBotToken, addUser });
// 1.99al: paid Main Stage slots (book, RTMP key / browser relay, per-minute billing, admin cut)
require("./mainstage").register(app, { isBotToken, addUser });
// 1.99cr: viewers snap / clip the stages (server-side from the HLS on disk) -> the pad's story
require("./stagecap").register(app, { isBotToken, addUser });
// 1.91: link previews — every page knows its absolute URL; og.js draws the preview images
og.register(app);
// 1.90: one action queue for everything started on the site, plus the new game pages
require("./actions").register(app, { isBotToken, addUser });
require("./lotto").register(app, { isBotToken, addUser });
require("./polls").register(app, { isBotToken, addUser });
require("./wagers").register(app, { isBotToken, addUser });
require("./wallet").register(app, { isBotToken, addUser });
require("./staking").register(app, { isBotToken, addUser });
inbox.register(app, { isBotToken, addUser });
require("./tables").register(app, { isBotToken, addUser });   // /casino /poker /blackjack: Pepe's live tables, playable from the web
require("./userstats").register(app, { isBotToken });
require("./econ").register(app, { isBotToken, addUser });       // economy v2 E-0: revenue attribution, watch-minutes, participation
require("./roomstats").register(app, { isBotToken, addUser });   // /p/:slug/analytics (before bridge: it adds the pad pages' analytics links)
require("./pepecontrol").register(app, { isBotToken, addUser });
require("./burns").register(app, { isBotToken, addUser });   // 1.99dk: PAT burning - the burn reserve's public log + admin burns   // admin-only Pepe control panel (homepage) + VM supervisor poll/ack
// 1.99bi: room owners + per-room stages + royalties (pad owner dashboard /p/:slug/manage, /pads/admin)
require("./roomsweb").register(app, { isBotToken, addUser });
require("./royalties").start();
const bridge = require("./bridge");
bridge.register(app, { isBotToken, addUser });   // Camfrog rooms live on PATV (read-only v1): /p (Pads), /p/:slug (pad page), /api/bridge/sync
require("./roomdj").register(app, { isBotToken, addUser });   // 1.99ba: the room pages' DJ panel (/api/dj/sync, /api/rooms/:slug/dj)
profileLayout.register(app, { addUser });   // profile section order + visibility (edit page)
cosmetics.register(app, { isBotToken, addUser });   // /cosmetics shop, market, inventory + bot API
app.get("/economy", addUser, (req, res) => res.render("economy", { user: req.user ? req.user.username : null }));

const history = require("./history");
app.get("/history", addUser, async (req, res) => {
  const me = req.user;
  const canLookup = !!me && (me.class === "Admin" || me.class === "Staff");
  const period = ["7d", "30d", "90d", "all"].includes(req.query.period) ? req.query.period : "30d";
  const cat = req.query.cat || null;
  const page = parseInt(req.query.page) || 1;
  const render = (o) => res.render("history", Object.assign({ user: me ? me.username : null, canLookup, period, cat,
                                                              target: null, targetId: null, own: false, data: null, error: null }, o));
  try {
    if (!me) return render({ error: "Log in to see your PAT history." });
    let target = me.username, userId = me.userId;
    const asked = String(req.query.user || "").trim();
    if (asked && asked.toLowerCase() !== me.username.toLowerCase()) {
      if (!canLookup) return render({ target: me.username, error: "You can only see your own history." });
      const u = await getQuery(
        `SELECT userId, username FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(camfrogUsername) = LOWER(?)
         ORDER BY CASE WHEN LOWER(username) = LOWER(?) THEN 0 ELSE 1 END LIMIT 1`, [asked, asked, asked]);
      if (!u.length) return render({ target: asked, error: `No user called "${asked}".` });
      target = u[0].username; userId = u[0].userId;
    }
    const data = await history.forUser(userId, { period, cat, page });
    const tu = await getQuery("SELECT username, camfrogUsername, discordUsername, twitchDisplayname FROM users WHERE userId = ?", [userId]);
    render({ target, targetId: history.identity(tu[0]), own: userId === me.userId, data });
  } catch (e) {
    console.error("[history]", e);
    render({ error: "Couldn't load the history." });
  }
});

// ── Camfrog achievements (achievements.js / achievements.json) ──
const achievements = require("./achievements");
app.get("/achievements", addUser, async (req, res) => {
  try {
    await achievements.ready;
    const holders = Object.fromEntries((await getQuery(
      "SELECT badgeId, COUNT(*) AS n FROM user_badges WHERE badgeId LIKE 'cf_%' GROUP BY badgeId")).map((r) => [r.badgeId, r.n]));
    let owned = null, viewing = null;
    // ?user=name shows that person's achievements (Pepe's !achievements links here); otherwise yours.
    const asked = String(req.query.user || "").trim();
    let who = req.user && req.user.userId ? { userId: req.user.userId, username: req.user.username } : null;
    if (asked) {
      const u = await getQuery(
        `SELECT userId, username, displayname FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(camfrogUsername) = LOWER(?)
         ORDER BY CASE WHEN LOWER(username) = LOWER(?) THEN 0 ELSE 1 END LIMIT 1`, [asked, asked, asked]);
      if (u.length) { who = u[0]; viewing = u[0].displayname || u[0].username; }
    }
    if (who) {
      owned = new Set((await getQuery("SELECT badgeId FROM user_badges WHERE userId = ?", [who.userId])).map((r) => r.badgeId));
    }
    // The original PATV badges (sign-up, email, Discord, Twitch, casino) sit alongside the Camfrog ones.
    const site = (await getQuery("SELECT badgeId, name, description, icon, points FROM badges WHERE badgeId NOT LIKE 'cf_%'"))
      .map((b) => ({ id: b.badgeId, name: b.name, desc: b.description, icon: b.icon, xp: b.points || 0, pat: 0,
                     tier: "common", site: true }));
    const siteHolders = Object.fromEntries((await getQuery(
      "SELECT badgeId, COUNT(*) AS n FROM user_badges WHERE badgeId NOT LIKE 'cf_%' GROUP BY badgeId")).map((r) => [r.badgeId, r.n]));
    res.render("achievements", { user: req.user ? req.user.username : null, viewing,
                                 own: !viewing || (req.user && who && who.userId === req.user.userId),
                                 achievements: site.concat(achievements.list()),
                                 holders: Object.assign({}, holders, siteHolders), owned });
  } catch (e) {
    console.error("[achievements] page:", e);
    res.status(500).send("Couldn't load achievements.");
  }
});
app.get("/api/achievements", async (req, res) => {
  res.json({ achievements: achievements.list() });
});
achievements.setUpdateLevel(updateLevel);
app.get("/api/g/achievement-feed", async (req, res) => {
  if (!isBotToken(req.query.password)) return res.status(403).json({ error: "unauthorized" });
  try { res.json({ feed: await achievements.feed() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/g/achievement-feed/ack", async (req, res) => {
  if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
  try { await achievements.ackFeed((req.body || {}).ids); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
// Pepe awards an achievement when he sees its threshold crossed in Camfrog.
app.post("/api/g/achievement", async (req, res) => {
  const b = req.body || {};
  if (!isBotToken(b.password)) return res.status(403).json({ error: "unauthorized" });
  try {
    const r = await achievements.award({ userId: b.userId, camfrogUsername: b.camfrogUsername, username: b.username },
                                       String(b.badgeId || ""), updateLevel, { silent: !!b.silent });
    res.status(r.ok ? 200 : 404).json(r);
  } catch (e) {
    console.error("[achievements] award:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// HTTP GET endpoint to retrieve the leaderboards.
app.get("/rankings", addUser, async (req, res) => {
  const username = req.user ? req.user.username : null; // Fallback to null if no user in session

  const cols = "u.userId, u.username, u.displayname, u.avatar, u.points_balance, u.xp, u.level";
  const sql = `SELECT ${cols} FROM users u WHERE ${stale.LIVE("u")} ORDER BY u.points_balance DESC LIMIT 100`;
  // xp is progress inside the current level, so level first
  const levelSql = `SELECT ${cols} FROM users u WHERE (u.level > 1 OR u.xp > 0) AND ${stale.LIVE("u")} ORDER BY u.level DESC, u.xp DESC LIMIT 100`;
  const badgeSql = `SELECT ${cols}, COUNT(*) AS badges FROM user_badges ub JOIN users u ON u.userId = ub.userId
        WHERE ${stale.LIVE("u")} GROUP BY ub.userId ORDER BY badges DESC, u.level DESC, u.xp DESC LIMIT 100`;

  // Recent jackpot winners — match both full ("Jackpot Win") and partial
  // ("Jackpot Win (partial)") payouts. Since 2026-07-19 wins record as partial,
  // so the old exact `= 'Jackpot Win'` match silently dropped every recent winner.
  const jackpotSql = `
        SELECT u.username, u.displayname, t.points AS amount, t.timestamp
        FROM transactions t
        JOIN users u ON t.userId = u.userId
        WHERE t.type LIKE 'Jackpot Win%'
        ORDER BY t.timestamp DESC
        LIMIT 50
    `;

  try {
    const users = await getQuery(sql);
    const byLevel = await getQuery(levelSql);
    let byBadges = [];
    try { byBadges = await getQuery(badgeSql); } catch (e) { console.error("rankings badges:", e.message); }
    const jackpots = await getQuery(jackpotSql);
    // Current jackpot pot total
    const potRow = await getQuery(`SELECT SUM(amount) AS pot FROM jackpot_rakes`);
    const currentPot = (potRow[0] && potRow[0].pot) || 0;
    let supply = null;
    try { supply = await patSupply(); } catch (e) { console.error("supply:", e.message); }
    // GTF pixel avatars for the podiums (top 3 of each board), rendered server-side like the profile's
    const gtfAvatars = {};
    const podium = new Set([users, byLevel, byBadges].flatMap((l) => l.slice(0, 3).map((u) => u.username)));
    for (const name of podium) {
      try {
        const av = userstats.avatarFor(await cosmetics.profileData(name));
        if (av && av.svg) gtfAvatars[name] = av.svg;
      } catch (e) { console.error("rankings avatar:", e.message); }
    }
    res.render("leaderboard", { user: username, users, byLevel, byBadges, gtfAvatars, jackpots, currentPot, supply, xpForNextLevel });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).send("Failed to fetch rankings.");
  }
});

// ── Total PAT supply ── every PAT is in a wallet or a pool. Wallets and the casino jackpot live
// here; Pepe holds the rest (Federal Reserve, turf stakes/tills, gang treasuries, escrow...) and
// posts a snapshot of them every few minutes.
const supplyReady = runQuery(`CREATE TABLE IF NOT EXISTS supply_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
app.post("/api/stats/supply", async (req, res) => {
  if ((req.body || {}).password !== process.env.TWITCH_BOT_TOKEN) return res.status(403).json({ ok: false });
  const pools = Array.isArray(req.body.pools) ? req.body.pools : [];
  const clean = pools.slice(0, 50).map((p) => ({ key: String(p.key || "").slice(0, 40), label: String(p.label || "").slice(0, 80),
                                                 amount: Math.max(0, Math.floor(Number(p.amount) || 0)) }));
  try {
    await supplyReady;
    await runQuery("INSERT INTO supply_snapshot (id, pools, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP) " +
                   "ON CONFLICT(id) DO UPDATE SET pools = excluded.pools, updated_at = CURRENT_TIMESTAMP", [JSON.stringify(clean)]);
    res.json({ ok: true });
  } catch (e) {
    console.error("supply snapshot:", e);
    res.status(500).json({ ok: false });
  }
});
async function patSupply() {
  await supplyReady;
  // every wallet counts toward supply (an archived one keeps only sub-1 PAT dust); the label counts live accounts
  const w = await getQuery(`SELECT COALESCE(SUM(points_balance), 0) AS w, SUM(CASE WHEN ${stale.LIVE()} THEN 1 ELSE 0 END) AS n FROM users`);
  const j = await getQuery("SELECT COALESCE(SUM(amount), 0) AS j FROM jackpot_rakes");
  const snap = await getQuery("SELECT pools, updated_at FROM supply_snapshot WHERE id = 1");
  let pools = [];
  try { pools = snap.length ? JSON.parse(snap[0].pools) : []; } catch (e) { pools = []; }
  // 1.99dk: burned PAT is gone - it's never a pool, whatever a snapshot says
  pools = pools.filter((p) => !/^burned/i.test(String(p.key || "")));
  const rows = [{ key: "wallets", label: `👛 Player wallets (${Number(w[0].n).toLocaleString()} accounts)`, amount: Math.floor(Number(w[0].w) || 0) },
                { key: "jackpot", label: "🎰 Casino jackpot", amount: Math.floor(Number(j[0].j) || 0) }, ...pools];
  // 1.99ee: the room-vault half of boosts and stage slot fees, held on the site for each pad until room vaults open (boosts.js)
  try {
    const rv = (await require("./boosts").escrow()).room_vault;
    if (rv > 0) rows.push({ key: "room_vault_escrow", label: "🚀 Room vault escrow (boosts + slot fees, held for the pads)", amount: Math.floor(rv) });
  } catch (e) { /* no boosts table yet */ }
  rows.sort((a, b) => b.amount - a.amount);
  // economy v2 E-1: each row's layer (Federal Reserve / Protocol Treasury / incentive layer / ...) - labels only
  const SL = require("./supplylayers");
  for (const r of rows) r.layer = SL.layerOf(r.key);
  const layers = SL.group(rows).map((g) => ({ key: g.key, label: g.label, blurb: g.blurb, amount: g.amount, rows: g.rows.map((r) => r.key) }));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  // the burn reserve still exists until it's burned, but it's out of circulation
  const outOfCirculation = rows.filter((r) => r.key === "vault:burn").reduce((s, r) => s + r.amount, 0);
  let burned = null;
  try { burned = await require("./burns").burned(); } catch (e) { burned = null; }
  return { total, circulating: total - outOfCirculation, outOfCirculation, burned, rows, layers, updated: snap.length ? snap[0].updated_at : null };
}
app.get("/api/stats/supply", async (req, res) => {
  try { res.json(await patSupply()); } catch (e) { res.status(500).json({ error: "failed" }); }
});
// the supply page, by economy layer, lives on the rankings page's Supply tab
app.get("/supply", (req, res) => res.redirect(302, "/rankings#supply"));

// HTTP POST endpoint for registering a new user.
app.post("/register", registerUser);

// HTTP POST endpoint for logging in.
app.post("/login", loginUser);

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function notFound(req, res, heading, message) {
  res.status(404).render("notFound", {
    user: req.user ? req.user.username : null,
    heading: heading || null,
    message: message || null,
  });
}

// HTTP POST endpoint for logging out.
app.post("/logout", (req, res) => {
  if (!guard.sameSite(req)) return res.status(403).send("Cross-site sign-out refused");
  clearLogin(res);
  res.redirect("/");
});

// 1.99dv: the profile is /u/<username> (was /u/<username>/profile) - its default tab (Posts) - and each tab is a path:
// /u/<username>/posts, /u/<username>/overview, /u/<username>/analytics; the editor is /u/<username>/edit. The old
// addresses (/profile, /profile?tab=, /profile/edit) 301 (pads.js).
// Get user profile
app.get(["/u/:username", "/u/:username/:tab(posts|overview|analytics)"], addUser, async (req, res) => {
  const username = req.user ? req.user.username : null; // Fallback to null if no user in session
  const usernameProfile = req.params.username; // Fallback to null if no user in session
  const sql =
    "SELECT userId, username, displayname, class, level, xp, avatar, email, points_balance, camfrogUsername FROM users WHERE username = ?";

  try {
    const results = await getQuery(sql, [usernameProfile]);
    if (results.length > 0) {
      const user = results[0]; // Extract user data
      const badges = await getQuery('SELECT b.* FROM badges b JOIN user_badges ub ON b.badgeId = ub.badgeId WHERE ub.userId = ?', [user.userId]);
      const isOwner = !!req.user && req.user.username === user.username;
      const isAdmin = !!req.user && req.user.class === "Admin";
      // ?preview=visitor: the owner sees their page exactly as a signed-out visitor would
      const preview = isOwner && req.query.preview === "visitor";
      let layout = null;
      try { layout = await profileLayout.get(user.userId); } catch (e) {
        // can't read their choices: fail closed (privacy panels owner/admin-only), never open
        console.error("profile layout:", e.message);
        layout = { priv: profileLayout.PRIV_IDS };
      }
      const L = profileLayout.view(layout, { owner: isOwner, admin: isAdmin, preview });
      res.render("profile", {
        // Render profile.ejs with user data
        username: username,
        usernameProfile: user.username,
        displayname: user.displayname,
        classh: user.class,
        level: user.level,
        xp: Math.round(user.xp),
        avatar: user.avatar,
        email: user.email,
        points_balance: user.points_balance,
        badges: badges,
        xpForNextLevel: xpForNextLevel,
        // PAT history is private: the owner, plus site Admin/Staff (same rule as /history)
        canSeeHistory: !preview && !!req.user && (req.user.username === user.username || ["Admin", "Staff"].includes(req.user.class)),
        heistSheet: await gtf.sheetFor(user.camfrogUsername),
        gtf: gtf.LINKS,
        camfrog: user.camfrogUsername || null,
        // GTF avatar, server-rendered with the equipped cosmetic layers (userstats.js -> avatar.js)
        gtfAvatar: userstats.avatarFor(res.locals.profileCosmetics),
        // Camfrog activity analytics (userstats.js). The privacy panels (top words, moderated against,
        // itemised mod list, mod commands) follow the user's layout: only data this viewer may see is loaded.
        analytics: await userstats.forProfile(user.camfrogUsername, {
          owner: isOwner && !preview,
          admin: isAdmin && !preview,
          show: L.show,
        }),
        // section order + visibility (profilelayout.js)
        layout: L,
        // 1.99du: the profile's tabs (profilelayout.tabsFor / pickTab) - ?tab= picks the open one, Posts by default
        profileLayoutMod: profileLayout,
        profileTab: String(req.params.tab || req.query.tab || "").slice(0, 20),     // 1.99dv: the path picks the tab
        // 1.99bz: the Posts panel (layout section "posts") + follower counts and the Follow button
        // 1.99df: the Posts panel is the profile feed (sorts, the owner's composer) - its query string and the host for embeds
        social: await require("./feedweb").profileSocial(user, preview ? null : req.user, { show: L.show("posts"), query: req.query, host: req.hostname || "publicaccess.tv" })
          .catch((e) => { console.error("profile social:", e.message); return null; }),
        previewVisitor: preview,
        // the owner's recent "New avatar" requests (website action queue, tag "avatar")
        avatarActs: isOwner && !preview ? await require("./actions").recentFor(req.user.userId, "avatar", 3) : [],
        avatarMsg: isOwner && !preview ? String(req.query.msg || "").slice(0, 200) : "",
        // "N new tips" on the owner's tip-jar button (since they last opened it)
        tipJarNew: isOwner && !preview ? await tipJarNewCount(user.userId).catch(() => 0) : 0,
        og: og.forProfile(req, user)
      });
    } else {
      // A profile that doesn't exist is a 404 - it used to log the visitor out (clearLogin).
      notFound(req, res, "No such profile",
        "There's no PATV account called <code>" + escHtml(usernameProfile) + "</code>.");
    }
  } catch (error) {
    console.error("Failed to retrieve user data:", error);
    res.status(500).send("Internal Server Error.");
  }
});

// This endpoint checks if a user with the given discordId exists.
app.get('/api/users/discord/:discordId', async (req, res) => {
    const { discordId } = req.params;
    try {
      let user = await getQuery('SELECT * FROM users WHERE discordId = ?', [discordId]);

      if (user.length === 0) {
        return res.status(404).json({ message: "User not found" });
      }
      if (await stale.touch(user[0], "discord")) user = await getQuery('SELECT * FROM users WHERE discordId = ?', [discordId]);

      res.json({ user: user[0] });

    } catch (error) {
      res.status(500).json({ error: 'Failed to retrieve user' });
    }
  });

// This endpoint checks if a user with the given twitchId exists.
app.get('/api/users/twitch/:twitchId', async (req, res) => {
    const { twitchId } = req.params;
    try {
      let user = await getQuery('SELECT * FROM users WHERE twitchId = ?', [twitchId]);
      if (user.length === 0) {
        return res.status(404).json({ message: "User not found" });
      }
      if (await stale.touch(user[0], "twitch")) user = await getQuery('SELECT * FROM users WHERE twitchId = ?', [twitchId]);

      res.json({ user: user[0] });

    } catch (error) {
      res.status(500).json({ error: 'Failed to retrieve user' });
    }
  });

// Endpoint to get user by Twitch display name
app.get("/api/users/twitch/displayname/:displayName", async (req, res) => {
    const { displayName } = req.params;
  
    try {
      const user = await getQuery("SELECT * FROM users WHERE twitchDisplayname = ?", [displayName]);
  
      if (user.length === 0) {
        return res.status(404).json({ message: "User not found" });
      }
  
      res.json({ user: user[0] });
    } catch (error) {
      console.error("Error fetching user by Twitch display name:", error);
      res.status(500).json({ message: "Failed to retrieve user" });
    }
  });

// This endpoint checks if a user with the given username exists.
app.get('/api/users/username/:username', async (req, res) => {
    const { username } = req.params;
    try {
      const user = await getQuery('SELECT username FROM users WHERE LOWER(username) = LOWER(?)', [username]);
      if (user && user.length > 0) {
        res.json({ exists: true });
      } else {
        res.json({ exists: false });
      }
    } catch (error) {
      console.error('Error checking username:', error.message);
      res.status(500).send('Server error');
    }
  });

// This endpoint creates a new Twitch user based on the info sent from the bot.
app.post('/api/users/twitch/register', async (req, res) => {
    // Bot-only (it used to take ANY caller, with the starting balance from the request body).
    // New accounts start at 0; their welcome bonus vests (welcome.js, 1.99bg).
    if (!isPlatformBot((req.body || {}).botToken)) {
      return res.status(403).json({ error: "unauthorized" });
    }
    const { username, email, twitchId, profileImage, twitchDisplayname, avatar } = req.body;
    const displayname = displaynames.usable(req.body.displayname) || displaynames.usable(twitchDisplayname) || username;
    const points_balance = 0;
    const userId = uuidv4();

    try {
      // 1.99bs: racing chat messages could register one Twitch id twice - hand back the account instead
      const had = twitchId ? (await getQuery("SELECT userId, username, displayname, points_balance FROM users WHERE twitchId = ? LIMIT 1", [String(twitchId)]))[0] : null;
      if (had) return res.json({ user: had, existing: true });
      const password = Math.random().toString(36).substring(2, 15);
      const hashedPassword = await bcrypt.hash(password, 12);
      await runQuery(
        'INSERT INTO users (userId, username, displayname, email, password, twitchId, twitchDisplayname, avatar, points_balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, username, displayname, email, hashedPassword, twitchId, twitchDisplayname, avatar, points_balance]
      );
      await displaynames.markNewAccount(userId).catch(() => {});
      const bonus = await getQuery(`SELECT twitchBonus FROM users WHERE userId = ?`, [userId]);
      if (bonus[0].twitchBonus === 0) {
        const newUserBadgeId = 'fresh_meat'; // Ensure this ID matches the one in your badges table
        await awardBadge(userId, newUserBadgeId);
        const badgeId = 'twitch-user'; // Replace with your actual badge ID
        await awardBadge(userId, badgeId);
      }
      await welcome.enroll(userId, "twitch-bot");    // 1.99bg: the welcome bonus vests (no instant connect bonus)
      await runQuery(
        "UPDATE users SET twitchBonus = ?, twitchBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
        [1, userId]
      );
      res.json({ user: { userId, username, displayname, points_balance } });
    } catch (error) {
      res.status(500).json({ error: 'Failed to create new user' });
    }
  });

  // This endpoint creates a new Discord user based on the info sent from the bot.
app.post('/api/users/discord/register', async (req, res) => {
    // Bot-only (it used to take ANY caller, with the starting balance from the request body).
    // New accounts start at 0; their welcome bonus vests (welcome.js, 1.99bg).
    if (!isPlatformBot((req.body || {}).botToken)) {
      return res.status(403).json({ error: "unauthorized" });
    }
    const { username, email, discordId, profileImage, discordUsername, avatar } = req.body;
    const displayname = displaynames.usable(req.body.displayname) || displaynames.usable(discordUsername) || username;
    const points_balance = 0;
    const userId = uuidv4();

    try {
      // 1.99bs: racing messages could register one Discord id twice - hand back the account instead
      const had = discordId ? (await getQuery("SELECT userId, username, displayname, points_balance FROM users WHERE discordId = ? LIMIT 1", [String(discordId)]))[0] : null;
      if (had) return res.json({ user: had, existing: true });
      const password = Math.random().toString(36).substring(2, 15);
      const hashedPassword = await bcrypt.hash(password, 12);
      await runQuery(
        'INSERT INTO users (userId, username, displayname, email, password, discordId, discordUsername, avatar, points_balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, username, displayname, email, hashedPassword, discordId, discordUsername, avatar, points_balance]
      );
      await displaynames.markNewAccount(userId).catch(() => {});
      const bonus = await getQuery(`SELECT discordBonus FROM users WHERE userId = ?`, [userId]);
      if (bonus[0].discordBonus === 0) {
        const newUserBadgeId = 'fresh_meat'; // Ensure this ID matches the one in your badges table
        await awardBadge(userId, newUserBadgeId);
        const badgeId = 'discord-user'; // Replace with your actual badge ID
        await awardBadge(userId, badgeId);
      }
      await welcome.enroll(userId, "discord-bot");   // 1.99bg: the welcome bonus vests (no instant connect bonus)
      await runQuery(
        "UPDATE users SET discordBonus = ?, discordBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
        [1, userId]
      );
      res.json({ user: { userId, username, displayname, points_balance } });
    } catch (error) {
      res.status(500).json({ error: 'Failed to create new user' });
    }
  });

// The tip page (views/tip.ejs): the recipient's card (GTF avatar, equipped name colour, level,
// pinned badges), the viewer's own balance and the recent tips between the two of them.
// The recipient's PAT balance is NOT shown here - it's a profile privacy option (stats_balance).
app.get("/u/:username/tip", addUser, async (req, res) => {
  const viewer = req.user ? req.user.username : null;
  try {
    const rows = await getQuery(
      "SELECT userId, username, displayname, class, level, avatar, camfrogUsername FROM users WHERE username = ?",
      [req.params.username]);
    if (!rows.length) {
      return notFound(req, res, "No such profile",
        "There's no PATV account called <code>" + escHtml(req.params.username) + "</code> to tip.");
    }
    const r = rows[0];
    let pc = null;
    try { pc = await cosmetics.profileData(r.username); } catch (e) { console.error("tip cosmetics:", e.message); }
    let badgeCount = 0;
    try {
      const b = await getQuery("SELECT COUNT(*) AS n FROM user_badges WHERE userId = ?", [r.userId]);
      badgeCount = b.length ? b[0].n || 0 : 0;
    } catch (e) { /* cosmetic only */ }
    let balance = null, recent = [], sentTotal = 0, recvTotal = 0, jar = null;
    const isSelf = !!viewer && viewer === r.username;
    if (isSelf) {
      // The owner's own tip jar: a dashboard of what they've received/sent (owner-only data).
      try { jar = await tipJarData(req.user.userId); } catch (e) { console.error("tip jar:", e.message); }
    }
    if (req.user && !isSelf) {
      const me = await getQuery("SELECT points_balance FROM users WHERE userId = ?", [req.user.userId]);
      balance = me.length ? Math.floor(me[0].points_balance || 0) : 0;
      await tipNoteReady;
      // The viewer's own ledger rows with this person (both directions live on the viewer's side).
      recent = await getQuery(
        `SELECT type, points, timestamp, note FROM transactions
          WHERE userId = ? AND counterparty = ? AND type IN ('tip sent', 'tip received')
          ORDER BY timestamp DESC, rowid DESC LIMIT 8`, [req.user.userId, r.userId]);
      const tot = await getQuery(
        `SELECT type, COALESCE(SUM(ABS(points)), 0) AS total FROM transactions
          WHERE userId = ? AND counterparty = ? AND type IN ('tip sent', 'tip received') GROUP BY type`,
        [req.user.userId, r.userId]);
      for (const t of tot) { if (t.type === "tip sent") sentTotal = t.total; else recvTotal = t.total; }
    }
    res.render("tip", {
      username: viewer,
      usernameProfile: r.username,
      displayname: r.displayname,
      classh: r.class,
      level: r.level || 0,
      avatar: r.avatar,
      camfrog: r.camfrogUsername || null,
      badgeCount,
      profileCosmetics: pc,
      gtfAvatar: userstats.avatarFor(pc),
      isSelf,
      balance,
      recent,
      sentTotal,
      recvTotal,
      jar,
      noteMax: TIP_NOTE_MAX,
    });
  } catch (error) {
    console.error("Failed to load tip page:", error);
    res.status(500).send("Internal Server Error.");
  }
});

// ── Tip jar (owner-only dashboard on /u/<you>/tip) ──
// Per-user "last opened my tip jar" time, for the "N new tips" count on the profile. Its own
// tiny table so the users table stays untouched.
const tipJarReady = runQuery(`CREATE TABLE IF NOT EXISTS tipjar_seen (
  userId TEXT PRIMARY KEY, seen_at TEXT NOT NULL)`).catch((e) => console.error("tipjar_seen:", e.message));
const TIPJAR_PAGE = 20;
/** Tips received since the owner last opened their jar (first visit: the last 7 days). */
async function tipJarNewCount(userId) {
  await tipJarReady;
  const s = await getQuery("SELECT seen_at FROM tipjar_seen WHERE userId = ?", [userId]);
  const since = s.length ? s[0].seen_at : null;
  const r = await getQuery(
    `SELECT COUNT(*) AS n FROM transactions WHERE userId = ? AND type = 'tip received' AND timestamp > `
      + (since ? "?" : "datetime('now', '-7 days')"), since ? [userId, since] : [userId]);
  return r.length ? r[0].n || 0 : 0;
}
// Who was on the other end of a tip row `t`. Most older tips (Camfrog !tip before Oct 2026) have no
// counterparty stored, but every transfer writes its two ledger rows back to back (sent, then
// received, same amount), so the partner row sits at rowid -1 / +1. Read-only: nothing is rewritten.
const TIP_PARTNER_JOIN = `LEFT JOIN transactions p
      ON p.rowid = (CASE WHEN t.type = 'tip received' THEN t.rowid - 1 ELSE t.rowid + 1 END)
     AND p.type = (CASE WHEN t.type = 'tip received' THEN 'tip sent' ELSE 'tip received' END)
     AND p.points = -t.points`;
const TIP_CP = "COALESCE(t.counterparty, p.userId)";
/** One page of the owner's received or sent tips, with who was on the other end. */
async function tipJarPage(userId, kind, offset) {
  await tipNoteReady;
  const type = kind === "sent" ? "tip sent" : "tip received";
  const rows = await getQuery(
    `SELECT t.points, t.timestamp, t.note, u.username, u.displayname, u.avatar
       FROM transactions t ${TIP_PARTNER_JOIN} LEFT JOIN users u ON u.userId = ${TIP_CP}
      WHERE t.userId = ? AND t.type = ?
      ORDER BY t.timestamp DESC, t.rowid DESC LIMIT ? OFFSET ?`,
    [userId, type, TIPJAR_PAGE + 1, Math.max(0, offset | 0)]);
  return { items: rows.slice(0, TIPJAR_PAGE), more: rows.length > TIPJAR_PAGE };
}
async function tipJarData(userId) {
  await tipJarReady; await tipNoteReady;
  const seenRow = await getQuery("SELECT seen_at FROM tipjar_seen WHERE userId = ?", [userId]);
  const seenAt = seenRow.length ? seenRow[0].seen_at : null;
  const [tot] = await getQuery(
    `SELECT COALESCE(SUM(CASE WHEN t.type = 'tip received' THEN t.points END), 0) AS recv,
            COALESCE(SUM(CASE WHEN t.type = 'tip received' AND t.timestamp >= datetime('now', '-7 days') THEN t.points END), 0) AS week,
            COALESCE(SUM(CASE WHEN t.type = 'tip received' AND t.timestamp >= datetime('now', '-30 days') THEN t.points END), 0) AS month,
            COUNT(CASE WHEN t.type = 'tip received' THEN 1 END) AS recvCount,
            COUNT(DISTINCT CASE WHEN t.type = 'tip received' THEN ${TIP_CP} END) AS tippers,
            COALESCE(-SUM(CASE WHEN t.type = 'tip sent' THEN t.points END), 0) AS sent,
            COUNT(CASE WHEN t.type = 'tip sent' THEN 1 END) AS sentCount
       FROM transactions t ${TIP_PARTNER_JOIN}
      WHERE t.userId = ? AND t.type IN ('tip received', 'tip sent')`, [userId]);
  const top = await getQuery(
    `SELECT u.username, u.displayname, u.avatar, SUM(t.points) AS total, COUNT(*) AS n, MAX(t.timestamp) AS last
       FROM transactions t ${TIP_PARTNER_JOIN} JOIN users u ON u.userId = ${TIP_CP}
      WHERE t.userId = ? AND t.type = 'tip received'
      GROUP BY u.userId ORDER BY total DESC LIMIT 5`, [userId]);
  // GTF pixel avatars for the top tippers (server-rendered like the rankings podium)
  const avatars = {};
  for (const t of top) {
    try {
      const av = userstats.avatarFor(await cosmetics.profileData(t.username));
      if (av && av.svg) avatars[t.username] = av.svg;
    } catch (e) { /* cosmetic only */ }
  }
  const received = await tipJarPage(userId, "received", 0);
  const sent = await tipJarPage(userId, "sent", 0);
  const newCount = received.items.filter((t) => seenAt ? t.timestamp > seenAt : false).length;
  // Opening the jar marks everything as seen (the profile's "new" count resets).
  await runQuery(
    `INSERT INTO tipjar_seen (userId, seen_at) VALUES (?, datetime('now'))
     ON CONFLICT(userId) DO UPDATE SET seen_at = excluded.seen_at`, [userId]).catch((e) => console.error("tipjar seen:", e.message));
  return { totals: tot || {}, top, avatars, received, sent, seenAt, newCount, pageSize: TIPJAR_PAGE };
}
// "Load more" for the tip jar lists. Owner-only by construction: it only ever reads req.user's rows.
app.get("/api/tipjar", addUser, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Sign in" });
  try {
    const kind = req.query.kind === "sent" ? "sent" : "received";
    const page = await tipJarPage(req.user.userId, kind, parseInt(req.query.offset, 10) || 0);
    await cosmetics.nameStyles(page.items.map((t) => t.username).filter(Boolean));
    res.set("Cache-Control", "no-store").json({
      more: page.more,
      items: page.items.map((t) => ({
        username: t.username || null, displayname: t.displayname || null, avatar: t.avatar || null,
        nameCss: t.username ? cosmetics.nameStyle(t.username) : "",
        points: Math.abs(Math.floor(t.points || 0)), timestamp: t.timestamp, note: t.note || null,
      })),
    });
  } catch (e) {
    console.error("tipjar api:", e.message);
    res.status(500).json({ error: "Failed to load tips" });
  }
});

// Optional short message riding on a web tip, stored on both ledger rows (transactions.note) and
// shown to the recipient on their history and on the tip page. Plain text, one line, capped.
const TIP_NOTE_MAX = 80;
const tipNoteReady = runQuery("ALTER TABLE transactions ADD COLUMN note TEXT").catch(() => {});
function cleanTipNote(v) {
  const s = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
  return s ? Array.from(s).slice(0, TIP_NOTE_MAX).join("") : null;
}

// Shared, overdraft-safe PAT transfer used by both tip endpoints.
// The debit is a single atomic conditional UPDATE (check + deduct in one statement),
// so concurrent tips can never overdraw a balance or mint PAT — this is what the old
// read-then-check-then-update flow got wrong (a TOCTOU race that created PAT).
// Returns { ok, status, msg }.
async function transferPat(senderUsername, recipientUsername, rawAmount, note = null) {
  const amount = Math.floor(Number(rawAmount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, status: 400, msg: "Invalid tip amount" };
  }
  if (!senderUsername || !recipientUsername) {
    return { ok: false, status: 400, msg: "Missing sender or recipient" };
  }
  if (senderUsername === recipientUsername) {
    return { ok: false, status: 400, msg: "Cannot tip oneself" };
  }

  const users = await getQuery(
    "SELECT username, userId, points_balance FROM users WHERE username IN (?, ?)",
    [senderUsername, recipientUsername]
  );
  const sender = users.find((u) => u.username === senderUsername);
  const recipient = users.find((u) => u.username === recipientUsername);
  if (!sender || !recipient) {
    return { ok: false, status: 404, msg: "One or both users not found" };
  }

  // Atomic conditional debit: the balance check and the deduction are the SAME statement.
  // If the balance is insufficient, no row changes and nothing is deducted.
  const debit = await runQuery(
    "UPDATE users SET points_balance = points_balance - ? WHERE userId = ? AND points_balance >= ?",
    [amount, sender.userId, amount]
  );
  if (!debit || debit.changes === 0) {
    return { ok: false, status: 400, msg: "Insufficient balance" };
  }

  // Credit recipient (atomic single statement).
  await runQuery(
    "UPDATE users SET points_balance = points_balance + ? WHERE userId = ?",
    [amount, recipient.userId]
  );

  // Ledger entries (note = the optional web-tip message, null otherwise).
  await tipNoteReady;
  await runQuery(
    "INSERT INTO transactions (transactionId, userId, type, points, counterparty, note) VALUES (?, ?, ?, ?, ?, ?)",
    [uuidv4(), sender.userId, "tip sent", -amount, recipient.userId, note]
  );
  await runQuery(
    "INSERT INTO transactions (transactionId, userId, type, points, counterparty, note) VALUES (?, ?, ?, ?, ?, ?)",
    [uuidv4(), recipient.userId, "tip received", amount, sender.userId, note]
  );

  // the recipient's inbox (1.99au): who, how much, and the note if there was one
  inbox.addSafe(recipient.userId, { kind: "tip", title: `${sender.username} tipped you PAT ${amount.toLocaleString("en-US")}`,
                                    body: note ? `"${note}"` : "", link: "/history" });

  achievements.checkWeb(sender.userId);            // tipped / tips-received achievements
  achievements.checkWeb(recipient.userId);
  const after = await getQuery("SELECT points_balance FROM users WHERE userId = ?", [sender.userId]);
  return { ok: true, status: 200, msg: "Tip sent successfully.", amount,
           balance: after.length ? Math.floor(after[0].points_balance || 0) : null };
}

// Tip another user through a chatbot
app.post("/u/:username/chattip", async (req, res) => {
  if (req.body.password !== process.env.TWITCH_BOT_TOKEN) {
    return res.status(403).send("Access denied");
  }
  try {
    const r = await transferPat(req.body.sender, req.body.recipient, req.body.amount);
    if (!r.ok) return res.status(r.status).send(r.msg);
    res.json({ message: r.msg });
  } catch (error) {
    console.error("Failed to process tip:", error);
    res.status(500).send("Failed to process tip");
  }
});

// Tip another user
app.post("/u/:username/tip", authenticateToken, addUser, async (req, res) => {
  const senderUsername = req.user ? req.user.username : null; // Logged in user's username
  if (!senderUsername) {
    return res.status(401).send("Authentication required");
  }
  // Same-origin only (the login cookie is SameSite=Lax; this is a second check where the browser
  // sends Origin/Referer).
  const host = req.get("host"), src = req.get("origin") || req.get("referer");
  if (src && host) {
    let same = false;
    try { same = new URL(src).host === host; } catch (e) { same = false; }
    if (!same) return res.status(403).send("Cross-site tip refused");
  }
  // The page sends a per-attempt idempotency key so a double-click / retried request can't send
  // twice. Keys are namespaced by sender so one user's key can never replay another user's result.
  req.body = req.body || {};
  const rawKey = req.body.idempotency_key || req.get("Idempotency-Key");
  if (rawKey) req.body.idempotency_key = `tip:${senderUsername}:${String(rawKey).slice(0, 64)}`;
  const idem = await idemBegin(req, res, "tip");
  if (idem.replay) return;
  try {
    const r = await transferPat(senderUsername, req.params.username, req.body.amount, cleanTipNote(req.body.note));
    if (!r.ok) { idem.fail(); return res.status(r.status).send(r.msg); }
    const body = { message: r.msg, amount: r.amount, balance: r.balance };
    idem.done(200, body);
    res.json(body);
  } catch (error) {
    idem.fail();
    console.error("Failed to process tip:", error);
    res.status(500).send("Failed to process tip");
  }
});

// The other person a bot-moved PAT row was with (duel opponent, loan lender/borrower, wager
// opponent), sent by Pepe as a username or Camfrog name. Stored as their userId in
// transactions.counterparty so /history can say "Won a duel vs bob". Unknown -> null.
async function resolveCounterparty(name) {
  if (!name) return null;
  try {
    const r = await getQuery(
      "SELECT userId FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(camfrogUsername) = LOWER(?) LIMIT 1",
      [String(name), String(name)]);
    return r.length ? r[0].userId : null;
  } catch (e) {
    return null;
  }
}

// ── Idempotency for bot money routes ──
// A bot that retries a request whose response it never saw (timeout, restart) must not move PAT
// twice. Callers may send `idempotency_key` (or an Idempotency-Key header); the first request with a
// key claims it, and any repeat gets the original response back instead of running again.
const idemReady = runQuery(`CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY, endpoint TEXT NOT NULL, status INTEGER, body TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
function idemKey(req) {
  const k = (req.body && req.body.idempotency_key) || req.get("Idempotency-Key");
  return k ? String(k).slice(0, 120) : null;
}
// Returns {replay: true} after sending the stored response, or {replay: false, done(status, body)}.
async function idemBegin(req, res, endpoint) {
  const key = idemKey(req);
  if (!key) return { replay: false, done: () => {}, fail: () => {} };
  await idemReady;
  const claimed = await runQuery("INSERT OR IGNORE INTO idempotency_keys (key, endpoint) VALUES (?, ?)", [key, endpoint]);
  if (!claimed || claimed.changes === 0) {
    const prev = await getQuery("SELECT status, body FROM idempotency_keys WHERE key = ?", [key]);
    if (prev.length && prev[0].status) {
      res.status(prev[0].status).json(JSON.parse(prev[0].body || "{}"));
    } else {
      res.status(409).json({ ok: false, error: "in_progress" });   // the first attempt is still running
    }
    return { replay: true };
  }
  return {
    replay: false,
    done: (status, body) => runQuery("UPDATE idempotency_keys SET status = ?, body = ? WHERE key = ?",
                                     [status, JSON.stringify(body || {}), key]).catch(() => {}),
    // a crash releases the key so a retry can run (nothing was committed)
    fail: () => runQuery("DELETE FROM idempotency_keys WHERE key = ? AND status IS NULL", [key]).catch(() => {}),
  };
}

// ── Wager escrow for bot-run games (duels, brawls) ──
// charge = atomically lock a stake (can't be tipped out afterward); payout = release
// winnings/refund. Bot-token gated. The atomic conditional debit is what makes escrow safe.
app.post("/api/wager/charge", async (req, res) => {
  const { username, password } = req.body || {};
  const amount = Math.floor(Number(req.body && req.body.amount));
  const reason = ((req.body && req.body.reason) || "Wager").toString().slice(0, 40);
  if (password !== process.env.TWITCH_BOT_TOKEN) return res.status(403).json({ ok: false, error: "unauthorized" });
  if (!username || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "bad_request" });
  const idem = await idemBegin(req, res, "wager/charge");
  if (idem.replay) return;
  const reply = (status, body) => { idem.done(status, body); return res.status(status).json(body); };
  try {
    const users = await getQuery("SELECT userId, casino_banned FROM users WHERE username = ?", [username]);
    if (!users.length) return reply(404, { ok: false, error: "no_user" });
    const userId = users[0].userId;
    // Casino-banned users can't be charged for casino games (blackjack/hold'em/poker/wheel).
    if (users[0].casino_banned && /^(blackjack|holdem|poker|wheel)/i.test(reason)) {
      return reply(403, { ok: false, error: "casino_banned" });
    }
    // Atomic conditional debit: only succeeds if the balance covers it RIGHT NOW.
    const debit = await runQuery(
      "UPDATE users SET points_balance = points_balance - ? WHERE userId = ? AND points_balance >= ?",
      [amount, userId, amount]
    );
    if (!debit || debit.changes === 0) return reply(402, { ok: false, error: "insufficient" });
    const cp = await resolveCounterparty(req.body.counterparty);
    await runQuery("INSERT INTO transactions (transactionId, userId, type, points, counterparty) VALUES (?, ?, ?, ?, ?)", [uuidv4(), userId, reason, -amount, cp]);
    reply(200, { ok: true });
  } catch (e) {
    idem.fail();
    console.error("wager charge error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/wager/payout", async (req, res) => {
  const { username, password } = req.body || {};
  const amount = Math.floor(Number(req.body && req.body.amount));
  const reason = ((req.body && req.body.reason) || "Winnings").toString().slice(0, 40);
  if (password !== process.env.TWITCH_BOT_TOKEN) return res.status(403).json({ ok: false, error: "unauthorized" });
  if (!username || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "bad_request" });
  const idem = await idemBegin(req, res, "wager/payout");
  if (idem.replay) return;
  try {
    const users = await getQuery("SELECT userId FROM users WHERE username = ?", [username]);
    if (!users.length) { idem.done(404, { ok: false, error: "no_user" }); return res.status(404).json({ ok: false, error: "no_user" }); }
    await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [amount, users[0].userId]);
    const cp = await resolveCounterparty(req.body.counterparty);
    await runQuery("INSERT INTO transactions (transactionId, userId, type, points, counterparty) VALUES (?, ?, ?, ?, ?)", [uuidv4(), users[0].userId, reason, amount, cp]);
    idem.done(200, { ok: true });
    res.json({ ok: true });
  } catch (e) {
    idem.fail();
    console.error("wager payout error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ── Casino ban ── one flag (users.casino_banned) blocks a user from ALL casino play:
// the web wheel & blackjack, the chat games, and Discord (which routes to the web). Every
// casino money endpoint checks it. Admin sets it via the bot token.
app.post("/api/admin/casino-ban", async (req, res) => {
  const { username, banned, password } = req.body || {};
  if (password !== process.env.TWITCH_BOT_TOKEN) return res.status(403).json({ ok: false, error: "unauthorized" });
  if (!username) return res.status(400).json({ ok: false, error: "bad_request" });
  try {
    const r = await runQuery(
      "UPDATE users SET casino_banned = ? WHERE LOWER(username) = LOWER(?) OR LOWER(camfrogUsername) = LOWER(?)",
      [banned ? 1 : 0, username, username]
    );
    if (!r || r.changes === 0) return res.status(404).json({ ok: false, error: "no_user" });
    res.json({ ok: true, banned: !!banned });
  } catch (e) {
    console.error("casino-ban error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Everyone currently casino-banned — for the bot's admin panel, which needs to SHOW the list, not
// just probe one user at a time. Same bot-token auth as the setter; sent as a POST so the token
// isn't sitting in a URL/query string.
app.post("/api/admin/casino-bans", async (req, res) => {
  const { password } = req.body || {};
  if (password !== process.env.TWITCH_BOT_TOKEN) return res.status(403).json({ ok: false, error: "unauthorized" });
  try {
    const rows = await getQuery(
      "SELECT username, camfrogUsername FROM users WHERE casino_banned = 1 ORDER BY LOWER(username)"
    );
    res.json({ ok: true, users: rows || [] });
  } catch (e) {
    console.error("casino-bans list error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Is a user banned from the casino? (chat/Discord bots use this for a clean message)
app.get("/api/u/:username/casino-banned", async (req, res) => {
  try {
    const u = await getQuery(
      "SELECT casino_banned FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(camfrogUsername) = LOWER(?)",
      [req.params.username, req.params.username]
    );
    res.json({ banned: !!(u.length && u[0].casino_banned) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get the user avatar
app.get("/api/u/:username/avatar", addUser, async (req, res) => {
  const username = req.user ? req.user.username : null; // Fallback to null if no user in session
  const userId = req.user ? req.user.userId : null; // Fallback to null if no user in session
  const sql = "SELECT avatar FROM users WHERE userId = ?";
  try {
    const user = await getQuery(sql, [userId]);
    if (user) {
      res.json({ avatar: user[0].avatar });
    } else {
      res.status(404).json({ error: "User not found" });
    }
  } catch (error) {
    console.error("Failed to retrieve avatar:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get user profile editor (1.99dv: was /u/:username/profile/edit)
app.get(
  "/u/:username/edit",
  authenticateToken,
  addUser,
  async (req, res) => {
    const username = req.user ? req.user.username : null; // Fallback to null if no user in session
    const usernameProfile = req.params.username; // Fallback to null if no user in session
    const sql =
      "SELECT userId, username, displayname, class, level, twitchDisplayname, discordUsername, camfrogUsername, avatar, email, points_balance FROM users WHERE username = ?";

    try {
      if (username == usernameProfile) {
        const results = await getQuery(sql, [usernameProfile]);
        if (results.length > 0) {
          const user = results[0]; // Extract user data
          let errorMessages = req.flash("error");
          let successMessages = req.flash("success");
          let pc = null, layout = profileLayout.sanitize(profileLayout.DEFAULT);
          try { pc = await cosmetics.profileData(user.username); } catch (e) { console.error("edit profile cosmetics:", e.message); }
          try { layout = await profileLayout.get(user.userId); } catch (e) { console.error("edit profile layout:", e.message); }
          res.render("editProfile", {
            // Render profile.ejs with user data
            username: user.username,
            displayname: user.displayname,
            twitchDisplayname: user.twitchDisplayname,
            discordUsername: user.discordUsername,
            camfrogUsername: user.camfrogUsername,
            avatar: user.avatar,
            email: user.email,
            points_balance: user.points_balance,
            level: user.level,
            classh: user.class,
            profileCosmetics: pc,
            layout,
            sections: profileLayout.SECTIONS,
            subSections: profileLayout.SUBS,
            privPanels: profileLayout.PRIV,
            errors: errorMessages,
            success: successMessages,
          });
        } else {
          res.status(404).send("User not found.");
        }
      } else {
        res.redirect(`/u/${encodeURIComponent(username || "")}/edit`);
      }
    } catch (error) {
      console.error("Failed to retrieve user data:", error);
      res.status(500).send("Internal Server Error.");
    }
  }
);

// Fetch user profile
app.get("/api/u/:username/profile", async (req, res) => {
  const username = req.params.username;
  const sql =
    "SELECT username, class, displayname, avatar, points_balance FROM users WHERE username = ?";

  getQuery(sql, [username])
    .then((results) => {
      if (results.length > 0) {
        res.json(results[0]);
      } else {
        res.status(404).send("User not found.");
      }
    })
    .catch((error) => {
      console.error("Failed to retrieve user data:", error);
      res.status(500).send("Failed to retrieve user data.");
    });
});

// Update user profile
// app.post('/api/u/:username/profile', addUser, async (req, res) => {
//     const { username, displayname, avatar, email, password } = req.body;
//     const userId = req.user ? req.user.userId : null;  // Fallback to null if no user in session

//     try {
//         // Handle password update separately if provided
//         if (password) {
//             const hashedPassword = await bcrypt.hash(password, 10);
//             await runQuery('UPDATE users SET password = ? WHERE userId = ?', [hashedPassword, userId]);
//         }

//         const updateSql = 'UPDATE users SET username = ?, displayname = ?, avatar = ?, email = ? WHERE userId = ?';
//         const result = await runQuery(updateSql, [username, displayname, avatar, email, userId]);

//         if (result.changes > 0) {
//             res.send("Profile updated successfully.");
//         } else {
//             res.status(404).send("No updates made. User not found.");
//         }
//     } catch (error) {
//         console.error("Failed to update profile:", error);
//         res.status(500).send("Failed to update profile.");
//     }
// });

app.post(
  "/api/u/:username/update/username",
  authenticateToken,
  addUser,
  updateUsername
);

app.post(
  "/api/u/:username/update/displayname",
  authenticateToken,
  addUser,
  updateDisplayname
);

app.post(
  "/api/u/:username/update/email",
  authenticateToken,
  addUser,
  updateEmail
);

app.post(
  "/api/u/:username/update/password",
  authenticateToken,
  addUser,
  updatePassword
);

app.post(
  "/api/u/:username/update/avatar",
  authenticateToken,
  addUser,
  upload.single("avatar"),
  updateAvatar
);

app.post(
  "/api/u/:username/update/camfrog",
  authenticateToken,
  addUser,
  updateCamfrogUsername
);

// Verify a pending Camfrog link — called by the bot when a user types !verify CODE
app.post("/api/users/camfrog/verify", verifyCamfrogLink);

// Zero out a user's balance (for account merging)
app.post("/api/users/zero-balance", async (req, res) => {
  const { userId, password } = req.body;
  if (password !== process.env.TWITCH_BOT_TOKEN) {
    return res.status(403).send("Access denied");
  }
  try {
    const before = await getQuery("SELECT points_balance FROM users WHERE userId = ?", [userId]);
    await runQuery("UPDATE users SET points_balance = 0 WHERE userId = ?", [userId]);
    const was = before.length ? Number(before[0].points_balance) || 0 : 0;
    if (was) {   // logged, so the ledger still adds up to the balance
      await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
        [uuidv4(), userId, "balance-zeroed", -was]);
    }
    res.json({ message: "Balance zeroed" });
  } catch (error) {
    console.error("Error zeroing balance:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Lookup user by Camfrog username
app.get("/api/users/camfrog/:camfrogUsername", async (req, res) => {
  const { camfrogUsername } = req.params;
  try {
    const sql = "SELECT userId, username, displayname, camfrogUsername, discordId, discordUsername, points_balance, xp, level, created_at FROM users WHERE LOWER(camfrogUsername) = LOWER(?)";
    let results = await getQuery(sql, [camfrogUsername]);
    // Pepe looks a login up when the person is active in a room again: an archived account comes back
    // with its balance (1.99bm)
    let restored = false;
    for (const r of results) if (await stale.touch(r.userId, "camfrog")) restored = true;
    if (restored) results = await getQuery(sql, [camfrogUsername]);
    if (results.length > 0) {
      // roles: what they own from the store (Pepe reads "high roller" for uncapped blackjack)
      res.json({ user: { ...results[0], roles: await userRoles(results[0].userId) } });
    } else {
      res.status(404).json({ message: "User not found" });
    }
  } catch (error) {
    console.error("Error finding Camfrog user:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Bot-only: rename the publicaccess.tv username of the account linked to a Camfrog login.
// Used by Pepe's !patv set (a player renaming themselves, or an admin renaming a player). The
// website's own /update/username needs that user's login cookie, which the bot can't have.
// Every other table references users by userId, so only users.username changes.
app.post("/api/users/camfrog/rename", async (req, res) => {
  const { camfrogUsername, newUsername, password } = req.body || {};
  if (!isBotToken(password)) {
    return res.status(403).json({ ok: false, error: "unauthorized" });
  }
  const name = String(newUsername || "").trim();
  if (!/^[A-Za-z0-9_.-]{3,24}$/.test(name)) {
    return res.status(400).json({ ok: false, error: "usernames are 3-24 characters: letters, numbers, _ . -" });
  }
  try {
    const rows = await getQuery(
      "SELECT userId, username FROM users WHERE LOWER(camfrogUsername) = LOWER(?)",
      [camfrogUsername]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: "no account for that Camfrog user" });
    }
    const user = rows[0];
    const taken = await getQuery(
      "SELECT userId FROM users WHERE LOWER(username) = LOWER(?) AND userId != ?",
      [name, user.userId]
    );
    if (taken.length > 0) {
      return res.status(409).json({ ok: false, error: "that username is taken" });
    }
    await runQuery("UPDATE users SET username = ? WHERE userId = ?", [name, user.userId]);
    res.json({ ok: true, old: user.username, username: name });
  } catch (error) {
    console.error("Error renaming Camfrog user:", error);
    res.status(500).json({ ok: false, error: "internal server error" });
  }
});

// This endpoint creates a new Camfrog user
// Bot-only routes: the caller must present the bot token. An unset token
// never matches, so a server without one (staging) refuses them all.
const funding = require("./funding");

// ── Funded payouts (1.63): Pepe syncs the Reserve balance + which vault pays each website payout
// flow, and settles the Reserve claims the website records. See funding.js.
app.post("/api/g/funding-sync", (req, res) => {
  if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
  funding.sync(req.body || {});
  require("./burns").sync((req.body || {}).burn);     // 1.99dk: Pepe's burn reserve + settings for the admin card
  res.json({ ok: true });
});
app.get("/api/g/reserve-claims", async (req, res) => {
  if (!isBotToken(req.query.password)) return res.status(403).json({ error: "unauthorized" });
  try { res.json({ claims: await funding.claims() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/g/reserve-claims/settle", async (req, res) => {
  if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
  try { res.json({ settled: await funding.settle((req.body || {}).ids) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// The Discord/Twitch bots authenticate with their own shared token (same .env as this server).
function isPlatformBot(token) {
  if (isBotToken(token)) return true;
  const d = process.env.DISCORD_BOT_TOKEN;
  return typeof d === "string" && d.length > 0 && token === d;
}

function isBotToken(token) {
  const expected = process.env.TWITCH_BOT_TOKEN;
  return typeof expected === "string" && expected.length > 0 && token === expected;
}

// Pepe registers new Camfrog users here. It can set a PAT balance, so it's bot-only.
// ("password" in the body is the new account's hashed password, not the token.)
app.post('/api/users/camfrog/register', async (req, res) => {
  if (!isBotToken((req.body || {}).botToken)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { username, email, password, camfrogUsername, avatar } = req.body;
  // Pepe's Camfrog display name for them (markup stripped), else their Camfrog login - never the
  // random CF account name.
  const displayname = displaynames.usable(req.body.displayname) || displaynames.usable(camfrogUsername, true) || username;
  const userId = uuidv4();
  // 1.99bs: one account per Camfrog login. Two racing calls used to make two "CF…" accounts; now the
  // second gets the first's account back (check first, and the unique index catches a true race).
  const { accountForLogin } = require("./accountMerge");
  const existing = async () => {
    const u = await accountForLogin(camfrogUsername);
    return u ? res.json({ user: { userId: u.userId, username: u.username, displayname: u.displayname, camfrogUsername: u.camfrogUsername,
                                   points_balance: u.points_balance }, existing: true }) : null;
  };

  try {
    if (await existing()) return;
    try {
      await runQuery(
        'INSERT INTO users (userId, username, displayname, email, password, camfrogUsername, avatar, points_balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, username, displayname, email, password, camfrogUsername, avatar, 0]
      );
    } catch (e) {
      if (/UNIQUE/i.test(e.message) && await existing()) return;
      throw e;
    }
    await displaynames.markNewAccount(userId).catch(() => {});
    // 1.99bg: no welcome cash at sign-up (it was farmable with alts). The welcome bonus vests once
    // the account has really been used, once per person - welcome.js. `identity` is Pepe's alias
    // identity for this login (one person, several Camfrog logins). points_balance is ignored.
    await welcome.enroll(userId, "camfrog", null, null, typeof req.body.identity === "string" ? req.body.identity.slice(0, 60) : null);
    const newUserBadgeId = 'fresh_meat';
    await awardBadge(userId, newUserBadgeId);
    await inbox.attachPendingSafe(userId, camfrogUsername);   // notices Pepe sent before the account existed
    res.json({ user: { userId, username, displayname, camfrogUsername, points_balance: 0 } });
  } catch (error) {
    console.error('Error creating Camfrog user:', error.message);
    res.status(500).json({ error: 'Failed to create new user' });
  }
});

// Pepe's Camfrog display names (1.99az): [{login, display}] from his room user lists, batched and
// only when they change. Refreshes AUTOMATIC display names only - never one a user chose.
app.post("/api/users/camfrog/displaynames", async (req, res) => {
  const body = req.body || {};
  if (!isBotToken(body.password)) return res.status(403).json({ error: "unauthorized" });
  try { res.json(Object.assign({ ok: true }, await displaynames.applyCamfrogNames(body.names))); }
  catch (e) { console.error("[displaynames] camfrog sync:", e.message); res.status(500).json({ error: "failed" }); }
});

// Pepe's !displayname (1.99bc): a Camfrog user reads / sets / resets the display name of the PATV
// account linked to their Camfrog login. {login, action: get|set|reset, name, actor, admin,
// camfrogDisplay}. Same rules as the profile page (displaynames.validate), one self-change an hour,
// every change in displayname_log. A set name is the user's own (displayname_auto = 0).
app.post("/api/users/camfrog/displayname", async (req, res) => {
  const body = req.body || {};
  if (!isBotToken(body.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
  try {
    const r = await displaynames.camfrogChange({
      login: body.login, action: String(body.action || "get"), name: body.name,
      actor: body.actor ? String(body.actor).slice(0, 64) : null, admin: body.admin === true,
      camfrogDisplay: body.camfrogDisplay,
    });
    res.status(r.status).json(r.body);
  } catch (e) {
    console.error("[displaynames] camfrog set:", e.message);
    res.status(500).json({ ok: false, error: "failed" });
  }
});

// ─── Prize store ──────────────────────────────────────────────────────────────────────────────
// The shop (official prize store + user marketplace) lives in shop.js: the purchase path for the
// website (/shop), the Discord bot (/chatshop) and Pepe (/api/shop/camfrog/buy), listings, orders,
// seller/buyer dashboards and the shop admin. userRoles + discordBridge stay here (used elsewhere).
async function userRoles(userId) {
  const rows = await getQuery("SELECT role FROM user_roles WHERE userId = ?", [userId]);
  return rows.map((r) => r.role);
}

// The Discord bot's local bridge (discord-bot/botBridge.js): announce a purchase in the
// purchases channel and grant a role there. Prod only - unset on staging, where it's skipped.
// Never throws; resolves to the bridge's answer or {error}.
function discordBridge(path, body, timeoutMs = 8000) {
  // BOT_BRIDGE_*; the earlier STORE_BRIDGE_* names still work.
  const secret = process.env.BOT_BRIDGE_SECRET || process.env.STORE_BRIDGE_SECRET;
  const url = process.env.BOT_BRIDGE_URL || process.env.STORE_BRIDGE_URL || "http://127.0.0.1:3020";
  if (!secret) return Promise.resolve({ error: "bridge not configured" });
  return axios
    .post(url + path, body, { headers: { "x-bot-secret": secret }, timeout: timeoutMs })
    .then((r) => r.data)
    .catch((e) => {
      const data = e.response && e.response.data;
      console.error(`discord bridge ${path} failed:`, (data && data.error) || e.message);
      return data && data.error ? data : { error: e.message };
    });
}

const shop = require("./shop");
shop.register(app, { isBotToken, addUser, requireUser, achievements, discordBridge, userRoles });

// Function to get the total jackpot
function getJackpotTotal(req, res) {
  db.get("SELECT SUM(amount) AS total FROM jackpot_rakes", (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    const total = row.total || 0;
    // jackpotTotal = the whole casino pot (Pepe's vault reads this). wheelJackpot = what the wheel's
    // jackpot slice rolls against: the pot, capped.
    return res.json({ jackpotTotal: total, wheelJackpot: Math.min(Math.max(0, total), WHEEL_JACKPOT_CAP),
                      wheelJackpotCap: WHEEL_JACKPOT_CAP });
  });
}

// Function to get the username from a userId
function getUsername(userId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT username FROM users WHERE userId = ?`,
      [userId],
      (err, row) => {
        if (err) {
          reject(err.message); // Reject the promise with the error
        } else if (row) {
          resolve(row.username); // Resolve the promise with the username
        } else {
          reject("User not found"); // Reject if no user is found
        }
      }
    );
  });
}

// Function to get the User Balance
function getUserBalance(req, res) {
  const username = req.params.username;
  db.get(
    `SELECT points_balance FROM users WHERE username = ?`,
    [username],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (row) {
        return res.json({ balance: row.points_balance });
      } else {
        return res.status(404).json({ error: "User not found" });
      }
    }
  );
}

// Function to get the User Level
function getUserLevel (req, res) {
    const username = req.params.username;
    db.get(
      `SELECT xp, level FROM users WHERE username = ?`,
      [username],
      (err, row) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        if (row) {
          return res.json({ xp: row.xp, level: row.level });
        } else {
          return res.status(404).json({ error: "User not found" });
        }
      }
    );
  }

// HTTP GET endpoint to get the list of classes
app.get("/api/classes", async (req, res) => {
  const sql = "SELECT class FROM classes";
  try {
    db.all(sql, [], (err, rows) => {
      if (err) {
        console.error(err.message);
        res.status(500).send("Failed to retrieve classes.");
        return;
      }
      // Ensure to send an array of class names
      const classNames = rows.map((row) => row.class);
      res.json(classNames);
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Failed to retrieve classes.");
  }
});

// HTTP GET endpoint to get top balances (JSON)
app.get("/api/rankings/top", async (req, res) => {
  const limit = parseInt(req.query.limit) || 5;
  const sql = `SELECT username, displayname, points_balance FROM users WHERE ${stale.LIVE()} ORDER BY points_balance DESC LIMIT ?`;
  try {
    const users = await getQuery(sql, [limit]);
    res.json({ users });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to fetch rankings" });
  }
});

// HTTP GET endpoint to get user balance
app.get("/api/u/:username/balance", getUserBalance);

// HTTP GET endpoint to get user balance
app.get("/api/u/:username/level", getUserLevel);

// HTTP GET endpoint to get user transaction history
app.get("/api/u/:username/transactions", async (req, res) => {
  const { username } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  try {
    // Find user by username or camfrogUsername (case-insensitive)
    const userRows = await getQuery(
      "SELECT userId FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(camfrogUsername) = LOWER(?)",
      [username, username]
    );
    if (!userRows || userRows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const userId = userRows[0].userId;
    const transactions = await getQuery(
      "SELECT type, points, timestamp FROM transactions WHERE userId = ? ORDER BY timestamp DESC LIMIT ?",
      [userId, limit]
    );
    res.json({ transactions });
  } catch (err) {
    console.error("Transaction history error:", err);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// HTTP GET endpoint to retrieve the jackpot total.
app.get("/api/jackpot", getJackpotTotal);

// HTTP GET endpoint to show the wheel.
app.get("/u/:username/wheel", authenticateToken, addUser, async (req, res) => {
  const username = req.params.username;
  const sql =
    "SELECT username, displayname, class, level, xp, avatar, email, points_balance FROM users WHERE username = ?";
  try {
    if (req.username !== username) {
      req.flash("error", "Invalid login.");
      return res.redirect("/login");
    }
    const results = await getQuery(sql, [username]);
    const user = results[0];
    res.render("wheel", { 
        user: req.username,
        level: user.level,
        xp: Math.round(user.xp),
        xpForNextLevel: xpForNextLevel
     });
    // Proceed with fetching user data and generating wheel
  } catch (error) {
    res.status(500).json({ error: error });
  }
});

// HTTP GET endpoint to show the public wheel.
app.get("/g/wheel", addUser, (req, res) => {
  const username = req.user ? req.user.username : null; // Fallback to null if no user in session
  res.render("publicwheel", { user: username });
  // Proceed with fetching user data and generating wheel
});

// Remaining gold spins for the day (10 per user level, plus any purchased +100 boosts).
app.get("/api/u/:username/wheel/spins-left", authenticateToken, async (req, res) => {
  try {
    const username = req.params.username;
    if (req.username !== username) return res.status(403).send("Access denied");
    const user = await getQuery(
      "SELECT userId, level, extra_daily_spins FROM users WHERE username = ?;",
      [username]
    );
    if (!user.length) return res.status(404).json({ error: "User not found" });
    const limit = 10 * (user[0].level || 1) + (user[0].extra_daily_spins || 0);
    const cnt = await getQuery(
      "SELECT COUNT(*) AS c FROM wheel_spins WHERE userId = ? AND type = 'gold' AND result != 'FAILED' AND date(timestamp) = date('now');",
      [user[0].userId]
    );
    const used = cnt[0].c;
    res.json({ used, limit, left: Math.max(0, limit - used) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// HTTP Post endpoint to update the jackpot
app.post("/api/g/wheel/jackpot", addUser, requireUser, async (req, res) => {
  const { amount } = req.body;
  const userId = req.user.userId; // guaranteed by requireUser
  const jackpotId = uuidv4(); // Function to generate a UUID v4
  const spinId = uuidv4();
  const userType = req.user ? req.user.class : null;
  const username = req.user ? req.user.username : null;
  if (userType === "Admin" || userType === "Staff") {
    const sql = `INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)`;
    try {
      await runQuery(sql, [jackpotId, spinId, userId, amount]);
      res.json({ message: "Jackpot updated successfully." });
      // req.flash('success', "Jackpot updated successfully.");
      // return res.redirect('/admin/panel');
    } catch (error) {
      console.error(error);
      res.json({ message: "Failed to update the jackpot." });
      // req.flash('error', "Failed to update the jackpot.");
      // return res.redirect('/admin/panel');
    }
  } else {
    req.flash(
      "error",
      "Access denied. You must be an admin or staff to access this page."
    );
    return res.redirect("/login");
  }
});

// HTTP Post Endpoint To Get Last 100 Spin Results
app.post("/api/g/wheel/results", async (req, res) => {
  const sql = `
        SELECT userId, result
        FROM wheel_spins
        ORDER BY timestamp DESC
        LIMIT 100
    `;

  try {
    const results = await getQuery(sql); // Assuming getQuery can handle multiple rows and is adjusted accordingly
    res.json(results);
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).send("Failed to retrieve wheel spin results.");
  }
});

// HTTP Post endpoint to update the user balance.
app.post(
  "/api/admin/transfer/:username",
  authenticateToken,
  addUser,
  async (req, res) => {
    const amount = req.body.amount;
    const username = req.params.username;
    const userType = req.user ? req.user.class : null;
    const transactionId = uuidv4(); // Function to generate a UUID v4

    if (userType === "Admin" || userType === "Staff") {
      // Begin transaction to ensure atomicity
      db.serialize(async () => {
        db.run("BEGIN TRANSACTION");
        try {
          // Update user's balance
          let sql = `UPDATE users SET points_balance = points_balance + ? WHERE username = ?`;
          await runQuery(sql, [amount, username]);

          // Log the transaction
          sql = `INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)`;
          const user = await getQuery(
            `SELECT userId FROM users WHERE username = ?`,
            [username]
          );
          console.log(user);
          await runQuery(sql, [
            transactionId,
            user[0].userId,
            "staff transfer",
            amount,
          ]);

          db.run("COMMIT");
          res.json({ message: "Points transferred successfully." });
        } catch (error) {
          db.run("ROLLBACK");
          console.error(error);
          res.status(500).send("Failed to transfer points.");
        }
      });
    } else {
      req.flash(
        "error",
        "Access denied. You must be an admin or staff to access this page."
      );
      return res.redirect("/login");
    }
  }
);

// HTTP POST endpoint to update a user class.
app.post("/api/u/:username/class/update", addUser, async (req, res) => {
  console.log(req.user);
  const userType = req.user ? req.user.class : null;
  const username = req.user ? req.user.username : null;
  if (userType === "Admin" || userType === "Staff") {
    const username = req.params.username;
    const userClass = req.body.class;

    const sql = "UPDATE users SET class = ? WHERE username = ?";
    try {
      const result = await runQuery(sql, [userClass, username]);
      if (result.changes) {
        res.json({ message: "User class updated successfully." });
      } else {
        res.status(404).send("User not found.");
      }
    } catch (error) {
      console.error(error);
      res.status(500).send("Failed to update user class.");
    }
  } else {
    req.flash(
      "error",
      "Access denied. You must be an admin or staff to access this page."
    );
    return res.redirect("/login");
  }
});

// HTTP POST endpoint to edit the list of classes.
app.post("/api/classes/edit", addUser, async (req, res) => {
  console.log(req.user);
  const userType = req.user ? req.user.class : null;
  const username = req.user ? req.user.username : null;
  if (userType === "Admin" || userType === "Staff") {
    const { action, className } = req.body;

    if (action === "add") {
      // First, check if the prize already exists
      const checkSql = "SELECT classId FROM classes WHERE class = ?";
      const result = await getQuery(checkSql, [className]);
      const existingPrize = result[0]; // Assuming getQuery returns an array of results

      if (existingPrize) {
        // If it exists, don't do anything.
        res.status(200).send("Class already exists.");
      } else {
        // If it does not exist, add new class
        const classId = uuidv4(); // Function to generate a UUID v4
        const sql = "INSERT INTO classes (classId, class) VALUES (?, ?)";
        try {
          await runQuery(sql, [classId, className]);
          res.json({ message: "Class added successfully." });
        } catch (error) {
          console.error(error);
          res.status(500).send("Failed to add class.");
        }
      }
    } else if (action === "remove") {
      const sql = "DELETE FROM classes WHERE class = ?";
      try {
        const result = await runQuery(sql, [className]);
        if (result.changes) {
          res.json({ message: "Class removed successfully." });
        } else {
          res.status(404).send("Class not found.");
        }
      } catch (error) {
        console.error(error);
        res.status(500).send("Failed to remove class.");
      }
    } else {
      res.status(400).send("Invalid action specified.");
    }
  } else {
    req.flash(
      "error",
      "Access denied. You must be an admin or staff to access this page."
    );
    return res.redirect("/login");
  }
});

// HTTP POST endpoint to edit the list of redemption codes.
app.post("/api/admin/redemption-codes", authenticateToken, addUser, async (req, res) => {
    const { code, points, uses_allowed, expiration_date } = req.body;
    const userType = req.user ? req.user.class : null;
    if (userType === "Admin" || userType === "Staff") {
        try {
            const existingCode = await getQuery("SELECT code FROM redemption_codes WHERE code = ?", [code]);
            if (existingCode.length > 0) {
                // Update existing code
                await runQuery("UPDATE redemption_codes SET points = ?, uses_allowed = ?, uses_remaining = ?, expiration_date = ? WHERE code = ?", [points, uses_allowed, uses_allowed, expiration_date, code]);
            } else {
                // Insert new code
                await runQuery("INSERT INTO redemption_codes (code, points, uses_allowed, uses_remaining, expiration_date) VALUES (?, ?, ?, ?, ?)", [code, points, uses_allowed, uses_allowed, expiration_date]);
            }
            res.json({ message: "Points transferred successfully." });
        } catch (error) {
            console.error("Failed to update redemption code:", error);
            res.status(500).send("Failed to update redemption code");
        }
    } else {
        req.flash(
          "error",
          "Access denied. You must be an admin or staff to access this page."
        );
        return res.redirect("/login");
      }
});

// HTTP GET end to list redemption codes.
app.get("/api/admin/redemption-codes", authenticateToken, addUser, async (req, res) => {
    const userType = req.user ? req.user.class : null;
    if (userType === "Admin" || userType === "Staff") {
        try {
            const codes = await getQuery("SELECT code, points, uses_remaining FROM redemption_codes WHERE uses_remaining > 0 ORDER BY created_at DESC");
            res.json(codes);
        } catch (error) {
            console.error("Error fetching redemption codes:", error);
            res.status(500).send("Failed to fetch redemption codes");
        }
    } else {
        req.flash(
        "error",
        "Access denied. You must be an admin or staff to access this page."
        );
        return res.redirect("/login");
    }
});

// HTTP DELETE endpoint for redemption code
app.delete("/api/admin/redemption-codes/:code", authenticateToken, addUser, async (req, res) => {
        const userType = req.user ? req.user.class : null;
        if (userType === "Admin" || userType === "Staff") {
        const { code } = req.params;
        try {
            await runQuery("DELETE FROM redemption_codes WHERE code = ?", [code]);
            res.send("Redemption code deleted successfully");
        } catch (error) {
            console.error("Error deleting redemption code:", error);
            res.status(500).send("Failed to delete redemption code");
        }
    } else {
        req.flash(
        "error",
        "Access denied. You must be an admin or staff to access this page."
        );
        return res.redirect("/login");
    }
});

// Get Users Who Redeemed a Code
app.get("/api/admin/redemption-codes/:code/users", authenticateToken, addUser, async (req, res) => {
    const { code } = req.params;
    const userType = req.user ? req.user.class : null;
    if (userType === "Admin" || userType === "Staff") {
        try {
            const users = await getQuery(
                "SELECT u.username, u.userId FROM user_redemptions ur JOIN users u ON ur.userId = u.userId WHERE ur.code = ?",
                [code]
            );
            res.json(users);
        } catch (error) {
            console.error("Failed to fetch users for code:", error);
            res.status(500).send("Failed to fetch users");
        }
} else {
    req.flash(
    "error",
    "Access denied. You must be an admin or staff to access this page."
    );
    return res.redirect("/login");
}
});

// HTTP POST endpoint to edit the list of redemption codes.
app.post("/api/redeem-code", authenticateToken, addUser, async (req, res) => {
    const { code } = req.body;
    const userId = req.user && req.user.userId; // authenticateToken ran first, but don't assume

    try {
        const codeData = await getQuery("SELECT * FROM redemption_codes WHERE code = ? AND (expiration_date IS NULL OR expiration_date > CURRENT_TIMESTAMP) AND uses_remaining > 0", [code]);
        const transactionId = uuidv4();
        // JSON, not text — the shop page parses JSON, so a text body meant these specific
        // reasons were swallowed and shown as one generic failure.
        if (codeData.length === 0) {
            return res.status(404).json({ success: false, message: "That code isn't valid, has expired, or has been fully used." });
        }

        const userRedemption = await getQuery("SELECT * FROM user_redemptions WHERE userId = ? AND code = ?", [userId, code]);
        if (userRedemption.length > 0) {
            return res.status(400).json({ success: false, message: "You've already redeemed that code." });
        }

        // 1.63: a code's PAT comes out of a vault ("redeem_codes" payout row), never minted.
        if (!(await funding.takeFunds("redeem_codes", codeData[0].points, userId, `redemption (${codeData[0].code})`))) {
            return res.status(503).json({ success: false, message: "The bank can't cover codes right now — try again later." });
        }
        await runQuery("BEGIN TRANSACTION");
        await runQuery("INSERT INTO user_redemptions (userId, code) VALUES (?, ?)", [userId, code]);
        await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [codeData[0].points, userId]);
        await runQuery("UPDATE redemption_codes SET uses_remaining = uses_remaining - 1 WHERE code = ?", [code]);
        await runQuery(
            "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
            [transactionId, userId, `redemption (${codeData[0].code})`, codeData[0].points]
          );
        await runQuery("COMMIT");
        
        const gained = codeData[0].points || 0;
        const after = await getQuery("SELECT points_balance FROM users WHERE userId = ?", [userId]);
        const bal = after.length ? (after[0].points_balance || 0) : null;
        res.json({
            success: true,
            message: `Code redeemed successfully — +${gained.toLocaleString()} PAT` +
                     (bal === null ? "." : `. Balance: ${bal.toLocaleString()} PAT.`),
            points: gained,
            balance: bal,
        });
    } catch (error) {
        try { await runQuery("ROLLBACK"); } catch (e) { /* nothing to roll back */ }
        console.error("Failed to redeem code:", error);
        res.status(500).json({ success: false, message: "Something went wrong redeeming that code — no PAT was added." });
    }
});

// Get all badges
app.get("/api/badges", async (req, res) => {
    try {
      const badges = await getQuery("SELECT * FROM badges");
      console.log(badges);
      res.json(badges);
    } catch (error) {
      console.error("Failed to fetch badges:", error);
      res.status(500).send("Failed to retrieve badges");
    }
  });

// Create a new badge ADMIN
app.post("/api/badges/add", upload.none(), authenticateToken, addUser, async (req, res) => {
    const { name, description, icon, points, requirement } = req.body;
    const badgeId = uuidv4();
    const userType = req.user ? req.user.class : null;
    if (userType === "Admin" || userType === "Staff") {
    try {
      await runQuery("INSERT INTO badges (badgeId, name, description, icon, points, requirement) VALUES (?, ?, ?, ?, ?, ?)", [badgeId, name, description, icon, points, requirement]);
      res.json({ message: "Badge created successfully." });
    } catch (error) {
      console.error("Failed to create badge:", error);
      res.status(500).send("Failed to create badge");
    }
} else {
    req.flash(
    "error",
    "Access denied. You must be an admin or staff to access this page."
    );
    return res.redirect("/login");
}
  });

  // Delete a badge ADMIN
  app.delete("/api/badges/:badgeId", authenticateToken, addUser, async (req, res) => {
    const { badgeId } = req.params;
    const userType = req.user ? req.user.class : null;
    if (userType === "Admin" || userType === "Staff") {
    try {
      await runQuery("DELETE FROM badges WHERE badgeId = ?", [badgeId]);
      res.send("Badge deleted successfully");
    } catch (error) {
      console.error("Failed to delete badge:", error);
      res.status(500).send("Failed to delete badge");
    }
} else {
    req.flash(
    "error",
    "Access denied. You must be an admin or staff to access this page."
    );
    return res.redirect("/login");
}
  });

  // Get user badges
  app.get("/api/badges/:badgeId/users", authenticateToken, addUser, async (req, res) => {
    const { badgeId } = req.params;
    console.log(badgeId);
    try {
        const badgeUsers = await getQuery(
            "SELECT u.username, u.userId FROM user_badges ub JOIN users u ON ub.userId = u.userId WHERE ub.badgeId = ?",
            [badgeId]
        ); console.log(badgeUsers);
      res.json(badgeUsers);
    } catch (error) {
      console.error("Failed to fetch user badges:", error);
      res.status(500).send("Failed to retrieve user badges");
    }
  });

  // Endpoint to start a blackjack hand and record the wager
app.post("/api/blackjack/wager", async (req, res) => {
    const { userId, wager, password } = req.body;
  
    // Authentication check
    if (password !== process.env.BOT_TOKEN) {
      return res.status(403).send("Access denied");
    }
  
    // Input validation
    if (!userId || !wager || wager <= 0) {
      return res.status(400).json({ success: false, message: "Invalid inputs" });
    }
  
    try {
      await runQuery("BEGIN TRANSACTION");
  
      // Check if the user has enough balance
      const users = await getQuery("SELECT points_balance, casino_banned FROM users WHERE userId = ?", [userId]);
      if (users.length === 0 || users[0].points_balance < wager) {
        await runQuery("ROLLBACK");
        return res.status(400).json({ success: false, message: "Insufficient balance" });
      }
      if (users[0].casino_banned) {
        await runQuery("ROLLBACK");
        return res.status(403).json({ success: false, message: "You are banned from the casino." });
      }

      // 1.63: the table is banked by the casino jackpot - refuse a wager it couldn't pay out
      // (everything still in play x2), then the wager goes INTO the jackpot.
      const potRow = await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes");
      const openRow = await getQuery("SELECT COALESCE(SUM(wager),0) AS t FROM blackjack WHERE payout IS NULL");
      if (((potRow[0] && potRow[0].t) || 0) < 2 * (((openRow[0] && openRow[0].t) || 0) + Number(wager))) {
        await runQuery("ROLLBACK");
        return res.status(409).json({ success: false, message: "The casino jackpot can't cover that bet right now." });
      }
      // Deduct the wager from the user's balance
      const transactionId = uuidv4();
      await runQuery(
        "UPDATE users SET points_balance = points_balance - ? WHERE userId = ?",
        [wager, userId]
      );
      await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                     [uuidv4(), null, userId, Number(wager)]);
  
      // Log the transaction for the wager
      await runQuery(
        "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
        [transactionId, userId, "blackjack wager", -wager]
      );
  
      // Create a new blackjack row
      const blackjackId = uuidv4();
      await runQuery(
        "INSERT INTO blackjack (blackjackId, userId, wager, wagerTransactionId) VALUES (?, ?, ?, ?)",
        [blackjackId, userId, wager, transactionId]
      );
  
      await runQuery("COMMIT");
  
      return res.json({ success: true, message: "Blackjack wager recorded", blackjackId });
    } catch (error) {
      await runQuery("ROLLBACK");
      console.error("Failed to record blackjack wager:", error);
      return res.status(500).json({ success: false, message: "Failed to record blackjack wager" });
    }
  });

  // Endpoint to record blackjack results and payout
app.post("/api/blackjack/result", async (req, res) => {
    const { blackjackId, userId, payout, result, pvalue, spvalue, dvalue, password } = req.body;
  
    // Authentication check
    if (password !== process.env.BOT_TOKEN) {
      return res.status(403).send("Access denied");
    }
  
    // Input validation
    if (!blackjackId || !userId || payout == null || !result || pvalue == null || dvalue == null) {
      return res.status(400).json({ success: false, message: "Invalid inputs" });
    }
  
    try {
      await runQuery("BEGIN TRANSACTION");
  
      // Log the payout transaction
      const transactionId = uuidv4();
      await runQuery(
        "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
        [transactionId, userId, "blackjack payout", payout]
      );
  
      // Add the payout to the user's balance - paid OUT of the casino jackpot (1.63)
      await runQuery(
        "UPDATE users SET points_balance = points_balance + ? WHERE userId = ?",
        [payout, userId]
      );
      if (Number(payout) > 0) {
        await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                       [uuidv4(), null, userId, -Number(payout)]);
      }
  
      // Update the blackjack row with the payout and result
      await runQuery(
        "UPDATE blackjack SET payout = ?, result = ?, payoutTransactionId = ?, pvalue = ?, spvalue = ?, dvalue = ? WHERE blackjackId = ?",
        [payout, result, transactionId, pvalue, spvalue, dvalue, blackjackId]
      );
  
      await runQuery("COMMIT");
      xp = Math.abs(payout) * 0.005;
      const levelUpInfo = await updateLevel(userId, xp);
      return res.json({ success: true, message: "Blackjack result recorded", payout, levelUpInfo });
    } catch (error) {
      await runQuery("ROLLBACK");
      console.error("Failed to record blackjack result:", error);
      return res.status(500).json({ success: false, message: "Failed to record blackjack result" });
    }
  });

// Create an endpoint for awarding badges
app.post("/api/award-badge", async (req, res) => {
    const { userId, badgeId, password } = req.body;
  
    // Check for authentication
    if (password !== process.env.TWITCH_BOT_TOKEN) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
  
    // Validate the required fields
    if (!userId || !badgeId) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }
  
    try {
      // Call the awardBadge function to award the badge
      const result = await awardBadge(userId, badgeId);
  
      // Respond with success
      return res.json(result);
    } catch (error) {
      if (error.message === 'Badge not found') {
        return res.status(404).json({ success: false, message: "Badge not found" });
      } else if (error.message === 'Badge already awarded') {
        return res.status(400).json({ success: false, message: "Badge already awarded" });
      } else {
        console.error("Failed to award badge:", error);
        return res.status(500).json({ success: false, message: "Failed to award badge" });
      }
    }
  });
  
// HTTP POST endpoint to trigger wheel spin
app.post("/api/u/:username/wheel/spin", authenticateToken, async (req, res) => {
  const username = req.body.username;
  const pageId = req.body.pageId;

  if (req.username !== username) {
    return res.status(403).send("Access denied");
  }

  try {
    checkAndResolveStalledSpins();
    checkAndResolvePendingSpins();
    const user = await getQuery(
      `SELECT userId, points_balance, level, extra_daily_spins, casino_banned FROM users WHERE username = ?;`,
      [username]
    );

    if (!user.length || user[0].points_balance < 5000) {
      return res.status(400).send("Insufficient points or user not found");
    }
    if (user[0].casino_banned) {
      return res.status(403).send("You are banned from the casino.");
    }

    // Daily gold-spin cap: 10 per user level, plus any purchased "+100 Daily Gold Spins" boosts.
    const dailyLimit = 10 * (user[0].level || 1) + (user[0].extra_daily_spins || 0);
    const spunToday = await getQuery(
      `SELECT COUNT(*) AS c FROM wheel_spins WHERE userId = ? AND type = 'gold' AND result != 'FAILED' AND date(timestamp) = date('now');`,
      [user[0].userId]
    );
    if (spunToday[0].c >= dailyLimit) {
      return res.status(429).send(
        `Daily gold-spin limit reached (${dailyLimit}/day). Come back tomorrow, level up for more, or buy +100 Daily Gold Spins in the shop.`
      );
    }

    const pendingSpin = await getQuery(
      `SELECT * FROM wheel_spins WHERE result = 'PENDING' AND type = 'gold' AND userId = ? ORDER BY rowid DESC LIMIT 1;`,
      [user[0].userId]
    );

    if (pendingSpin.length) {
      return res.status(400).send("Spin in progress.");
    }

    const stalledSpin = await getQuery(
      `SELECT * FROM wheel_spins WHERE result = 'INTENT' AND type = 'gold' AND userId = ? ORDER BY rowid DESC LIMIT 1;`,
      [user[0].userId]
    );

    if (stalledSpin.length) {
      return res.status(400).send("Stalled spin.");
    }

    // Prepare a potential transaction but do not commit
    const spinId = uuidv4();
    const transactionId = uuidv4();

    // Log the intent to spin, pending client acknowledgment
    await runQuery(
      `INSERT INTO wheel_spins (spinId, userId, type, result, transactionId) VALUES (?, ?, ?, ?, ?);`,
      [spinId, user[0].userId, "gold", "INTENT", transactionId]
    );

    // Send the spin command to the client
    sendEvent("spin", pageId, {
      message: `Request: ${username}`,
      spinId: spinId, // Include the spin ID for tracking
      timestamp: new Date(),
    });

    res.json({ spinId });
  } catch (error) {
    console.error("Failed to prepare spin:", error);
    res.status(500).send("Failed to process spin");
  }
});

// Endpoint to finalize the spin after client acknowledgment
app.post("/api/u/acknowledge-spin", authenticateToken, async (req, res) => {
  const { spinId } = req.body;
  const transactionId = uuidv4();
  const jackpotId = uuidv4();

  try {
    const spinDetails = await getQuery(
      `SELECT userId FROM wheel_spins WHERE spinId = ? AND result = 'INTENT'`,
      [spinId]
    );

    if (!spinDetails.length) {
      return res.status(404).send("Spin not found or already processed");
    }

    // Gold wheel scales prizes by the spinner's level (matches the wheel's displayed values).
    const lvlRow = await getQuery("SELECT level FROM users WHERE userId = ?", [spinDetails[0].userId]);
    const spinnerLevel = (lvlRow[0] && lvlRow[0].level) || 0;
    const outcome = await computeSpinResult(goldWheelMultiplier(spinnerLevel));

    await runQuery("BEGIN TRANSACTION");

    await runQuery(
      `UPDATE users SET points_balance = points_balance - 5000 WHERE userId = ?`,
      [spinDetails[0].userId]
    );
    await runQuery(
      `INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?);`,
      [transactionId, spinDetails[0].userId, "Wager: Gold Spin", -5000]
    );
    await runQuery(
      `INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?);`,
      [jackpotId, spinId, spinDetails[0].userId, 5000]
    );
    await runQuery(
      `UPDATE wheel_spins SET result = 'PENDING', type = 'gold', segment_index = ?, payout = ?, jackpot_pct = ? WHERE spinId = ?`,
      [outcome.segmentIndex, outcome.payout, outcome.jackpotPct, spinId]
    );

    await runQuery("COMMIT");

    res.json({
      success: true,
      message: "Spin confirmed and points deducted",
      targetIndex: outcome.segmentIndex,
      display: spinDisplay({ segment_index: outcome.segmentIndex, payout: outcome.payout, jackpot_pct: outcome.jackpotPct }),
    });
  } catch (error) {
    await runQuery("ROLLBACK");
    console.error("Failed to finalize spin:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to finalize spin" });
  }
});

// Public-wheel spin cooldown — mirrors the Camfrog bot's !spin cooldown (in-memory, 60s per user,
// started only on a SUCCESSFUL spin so a rejected attempt doesn't lock anyone out). Kept separate
// from the bot (which uses /api/g/wheel/chatspin with its own in-memory cooldown), so the two never
// interfere. In-memory like the bot's — it simply resets if the server restarts.
const publicSpinCooldowns = new Map(); // userId -> last successful spin timestamp (ms)
const PUBLIC_SPIN_COOLDOWN_MS = 60 * 1000;

// HTTP POST endpoint to trigger a public wheel spin
app.post("/api/g/wheel/spin", authenticateToken, async (req, res) => {
  const username = req.body.username;
  const pageId = req.body.pageId;

  if (req.username !== username) {
    return res.status(403).send("Access denied");
  }

  try {
    checkAndResolveStalledPublicSpins();
    checkAndResolvePendingPublicSpins();
    const user = await getQuery(
      `SELECT userId, points_balance, casino_banned FROM users WHERE username = ?;`,
      [username]
    );

    if (!user.length || user[0].points_balance < 5000) {
      return res.status(400).send("Insufficient points or user not found");
    }
    if (user[0].casino_banned) {
      return res.status(403).send("You are banned from the casino.");
    }

    // Per-user cooldown (only started on a successful spin below).
    const lastSpin = publicSpinCooldowns.get(user[0].userId) || 0;
    const remainingMs = PUBLIC_SPIN_COOLDOWN_MS - (Date.now() - lastSpin);
    if (remainingMs > 0) {
      return res.status(429).send(`Slow down! You can spin again in ${Math.ceil(remainingMs / 1000)}s.`);
    }

    const pendingSpin = await getQuery(
      `SELECT * FROM wheel_spins WHERE result = 'PENDING' AND type = 'public' AND userId = ? ORDER BY rowid DESC LIMIT 1;`,
      [user[0].userId]
    );

    if (pendingSpin.length) {
      return res.status(400).send("Spin in progress.");
    }

    const stalledSpin = await getQuery(
      `SELECT * FROM wheel_spins WHERE result = 'INTENT' AND type = 'public' AND userId = ? ORDER BY rowid DESC LIMIT 1;`,
      [user[0].userId]
    );

    if (stalledSpin.length) {
      return res.status(400).send("Stalled spin.");
    }

    // Prepare a potential transaction but do not commit
    const spinId = uuidv4();
    const transactionId = uuidv4();

    // Log the intent to spin, pending client acknowledgment
    await runQuery(
      `INSERT INTO wheel_spins (spinId, userId, type, result, transactionId) VALUES (?, ?, ?, ?, ?);`,
      [spinId, user[0].userId, "public", "INTENT", transactionId]
    );

    // Send the spin command to the client
    sendEvent("spin", "public", {
      message: `Request: ${username}`,
      spinId: spinId, // Include the spin ID for tracking
      timestamp: new Date(),
    });

    // Spin accepted — NOW start this user's cooldown (same as the bot: only on success).
    publicSpinCooldowns.set(user[0].userId, Date.now());

    res.json({ spinId });
  } catch (error) {
    console.error("Failed to prepare spin:", error);
    res.status(500).send("Failed to process spin");
  }
});

// HTTP POST endpoint to trigger a chatbot spin
app.post("/api/g/wheel/chatspin", async (req, res) => {
    const username = req.body.username;
    const password = req.body.password;
    const pageId = req.body.pageId;
    if (password !== process.env.TWITCH_BOT_TOKEN) {
        return res.status(403).send("Access denied");
    }
    
    try {
      checkAndResolveStalledPublicSpins();
      checkAndResolvePendingPublicSpins();
      const user = await getQuery(
        `SELECT userId, points_balance, casino_banned FROM users WHERE username = ?;`,
        [username]
      );

      if (!user.length || user[0].points_balance < 5000) {
        return res.status(400).send("Insufficient points.");
      }
      if (user[0].casino_banned) {
        return res.status(403).send("You are banned from the casino.");
      }

      const pendingSpin = await getQuery(
        `SELECT * FROM wheel_spins WHERE result = 'PENDING' AND type = 'public' ORDER BY rowid DESC LIMIT 1;`
      );
  
      if (pendingSpin.length) {
        return res.status(400).send("Spin in progress.");
      }
  
      const stalledSpin = await getQuery(
        `SELECT * FROM wheel_spins WHERE result = 'INTENT' AND type = 'public' AND userId = ? ORDER BY rowid DESC LIMIT 1;`,
        [user[0].userId]
      );
  
      if (stalledSpin.length) {
        return res.status(400).send("Stalled spin.");
      }
  
      // Prepare a potential transaction but do not commit
      const spinId = uuidv4();
      const transactionId = uuidv4();
  
      // Log the intent to spin, pending client acknowledgment
      await runQuery(
        `INSERT INTO wheel_spins (spinId, userId, type, result, transactionId) VALUES (?, ?, ?, ?, ?);`,
        [spinId, user[0].userId, "public", "INTENT", transactionId]
      );
  
      // Send the spin command to the client
      sendEvent("spin", "public", {
        message: `Request: ${username}`,
        spinId: spinId, // Include the spin ID for tracking
        timestamp: new Date(),
      });
  
      res.json({ spinId });
    } catch (error) {
      console.error("Failed to prepare spin:", error);
      res.status(500).send("Failed to process spin");
    }
  });

  // On your backend, run once at server startup
setInterval(() => {
    // 'clients' is your object storing active SSE connections
    Object.values(clients).forEach(identifierMap => {
        Object.values(identifierMap).forEach(clientArray => {
            clientArray.forEach(client => {
                try {
                    // An SSE comment starts with a colon and is ignored by the onmessage handler
                    client.write(': keep-alive\n\n');
                } catch (e) { /* handle error if client is disconnected */ }
            });
        });
    });
}, 30000); // 30 seconds

// Endpoint to finalize the spin after client acknowledgment
app.post("/api/g/acknowledge-spin", async (req, res) => {
  const { spinId } = req.body;
  const transactionId = uuidv4();
  const jackpotId = uuidv4();

  try {
    const spinDetails = await getQuery(
      `SELECT userId FROM wheel_spins WHERE spinId = ? AND result = 'INTENT'`,
      [spinId]
    );
    if (!spinDetails.length) {
      return res.status(404).send("Spin not found or already processed");
    }
    const spinUser = await getQuery(
      "SELECT username FROM users WHERE userId = ?",
      [spinDetails[0].userId]
    );
    const username = spinUser[0].username;

    // Public/OBS wheel prizes are fixed (PUBLIC_WHEEL_MULTIPLIER), same as publicwheel.js.
    const outcome = await computeSpinResult(PUBLIC_WHEEL_MULTIPLIER);

    await runQuery("BEGIN TRANSACTION");

    await runQuery(
      `UPDATE users SET points_balance = points_balance - 5000 WHERE userId = ?`,
      [spinDetails[0].userId]
    );
    await runQuery(
      `INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?);`,
      [transactionId, spinDetails[0].userId, "Wager: Public Spin", -5000]
    );
    await runQuery(
      `INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?);`,
      [jackpotId, spinId, spinDetails[0].userId, 5000]
    );
    await runQuery(
      `UPDATE wheel_spins SET result = 'PENDING', type = 'public', segment_index = ?, payout = ?, jackpot_pct = ? WHERE spinId = ?`,
      [outcome.segmentIndex, outcome.payout, outcome.jackpotPct, spinId]
    );

    await runQuery("COMMIT");
    const spinData = {
      message: `public spinid ${spinId} from ${username}`,
      spinId: spinId, // Include the spin ID for tracking
      timestamp: new Date(),
    };
      const timeoutId = setTimeout(() => {
        sendEvent("spin", spinId, spinData);
    }, 500);

    const look = await spinnerLook(spinDetails[0].userId);
    sendEvent("spin", "watch", Object.assign({ type: "spinning", spinId }, look));   // homepage stage (not the OBS channel)
    res.json({
      success: true,
      message: `public spinid ${spinId} from ${username}`,
      spinner: look,
      targetIndex: outcome.segmentIndex,
      display: spinDisplay({ segment_index: outcome.segmentIndex, payout: outcome.payout, jackpot_pct: outcome.jackpotPct }),
    });
  } catch (error) {
    await runQuery("ROLLBACK");
    console.error("Failed to finalize spin:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to finalize spin" });
  }
});

// Prune pending/unresolved spins.
const checkAndResolvePendingSpins = () => {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 30000); // 30000 milliseconds = 30 seconds
  let sqliteTimestamp = oneMinuteAgo
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  console.log("Current time:", now);
  console.log("One minute ago:", oneMinuteAgo);

  db.all(
    `SELECT spinId, userId, timestamp FROM wheel_spins WHERE result = 'PENDING' AND type = 'gold' AND timestamp < ?`,
    [sqliteTimestamp],
    (err, spins) => {
      if (err) {
        console.error("Error fetching pending spins:", err);
        return;
      }

      if (spins.length === 0) {
        console.log("No pending spins older than one minute.");
        return;
      }

      console.log(`Found ${spins.length} pending spins to process.`);
      spins.forEach((spin) => {
        // Timeout auto-settle: the outcome was decided server-side at spin time, so credit
        // it even though the wheel page never pinged back (e.g. OBS was closed). Idempotent.
        settleSpin(spin.spinId).catch((e) =>
          console.error("Auto-settle failed for " + spin.spinId + ":", e && e.message)
        );
      });
    }
  );
};

// Prune pending/unresolved spins.
const checkAndResolveStalledSpins = () => {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 2000); // 2000 milliseconds = 2 seconds
  let sqliteTimestamp = oneMinuteAgo
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  console.log("Current time:", now);
  console.log("One minute ago:", oneMinuteAgo);

  db.all(
    `SELECT spinId, userId, timestamp FROM wheel_spins WHERE result = 'INTENT' AND type = 'gold' AND timestamp < ?`,
    [sqliteTimestamp],
    (err, spins) => {
      if (err) {
        console.error("Error fetching stalled spins:", err);
        return;
      }

      if (spins.length === 0) {
        console.log("No stalled spins older than 2 seconds.");
        return;
      }

      console.log(`Found ${spins.length} stalled spins to process.`);
      spins.forEach((spin) => {
        console.log(
          `Processing spin: ${spin.spinId}, Timestamp: ${spin.timestamp}`
        );
        // Update spin status to FAILED
        db.run(
          `UPDATE wheel_spins SET result = 'FAILED' WHERE spinId = ?`,
          [spin.spinId],
          (err) => {
            if (err) {
              console.error(
                "Error updating spin status for spin ID " + spin.spinId + ":",
                err
              );
              return;
            }
          }
        );
      });
    }
  );
};

// Prune pending/unresolved spins.
const checkAndResolvePendingPublicSpins = () => {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 30000); // 30000 milliseconds = 30 seconds
  let sqliteTimestamp = oneMinuteAgo
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  console.log("Current time:", now);
  console.log("One minute ago:", oneMinuteAgo);

  db.all(
    `SELECT spinId, userId, timestamp FROM wheel_spins WHERE result = 'PENDING' AND type = 'public' AND timestamp < ?`,
    [sqliteTimestamp],
    (err, spins) => {
      if (err) {
        console.error("Error fetching pending spins:", err);
        return;
      }

      if (spins.length === 0) {
        console.log("No pending spins older than one minute.");
        return;
      }

      console.log(`Found ${spins.length} pending spins to process.`);
      spins.forEach((spin) => {
        // Timeout auto-settle: the outcome was decided server-side at spin time, so credit
        // it even though the wheel page never pinged back (e.g. OBS was closed). Idempotent.
        settleSpin(spin.spinId).catch((e) =>
          console.error("Auto-settle failed for " + spin.spinId + ":", e && e.message)
        );
      });
    }
  );
};

// Prune pending/unresolved spins.
const checkAndResolveStalledPublicSpins = () => {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 2000); // 2000 milliseconds = 2 seconds
  let sqliteTimestamp = oneMinuteAgo
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  console.log("Current time:", now);
  console.log("One minute ago:", oneMinuteAgo);

  db.all(
    `SELECT spinId, userId, timestamp FROM wheel_spins WHERE result = 'INTENT' AND type = 'public' AND timestamp < ?`,
    [sqliteTimestamp],
    (err, spins) => {
      if (err) {
        console.error("Error fetching stalled spins:", err);
        return;
      }

      if (spins.length === 0) {
        console.log("No stalled spins older than 2 seconds.");
        return;
      }

      console.log(`Found ${spins.length} stalled spins to process.`);
      spins.forEach((spin) => {
        console.log(
          `Processing spin: ${spin.spinId}, Timestamp: ${spin.timestamp}`
        );
        // Update spin status to FAILED
        db.run(
          `UPDATE wheel_spins SET result = 'FAILED' WHERE spinId = ?`,
          [spin.spinId],
          (err) => {
            if (err) {
              console.error(
                "Error updating spin status for spin ID " + spin.spinId + ":",
                err
              );
              return;
            }
          }
        );
      });
    }
  );
};

// Function to handle refund
const refundUser = (userId, spinId) => {
  console.log(`Refunding user ${userId} for spin ${spinId}`);
  const transactionId = uuidv4();
  const transactionType = "Refund";
  const jackpotId = uuidv4();

  // Start a transaction
  db.serialize(() => {
    db.run("BEGIN");

    const updateTransaction = `INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)`;
    const updateBalance = `UPDATE users SET points_balance = points_balance + 5000 WHERE userId = ?`;
    const updateJackpot = `INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)`;

    db.run(
      updateTransaction,
      [transactionId, userId, transactionType, +5000],
      function (err) {
        if (err) {
          console.error("Error inserting transaction:", err);
          db.run("ROLLBACK");
          return;
        }

        db.run(updateBalance, [userId], function (err) {
          if (err) {
            console.error("Error updating user balance:", err);
            db.run("ROLLBACK");
            return;
          }

          db.run(
            updateJackpot,
            [jackpotId, spinId, userId, -5000],
            function (err) {
              if (err) {
                console.error("Error updating jackpot rakes:", err);
                db.run("ROLLBACK");
                return;
              }

              // If all operations are successful, commit the transaction
              db.run("COMMIT", (err) => {
                if (err) {
                  console.error("Error committing transaction:", err);
                  return;
                }
                console.log("Refund processed successfully for user", userId);
              });
            }
          );
        });
      }
    );
  });
};

// Set interval to run this cleanup function every minute
// setInterval(checkAndResolvePendingSpins, 5000);

// HTTP POST endpoint to record the result of a public wheel spin.
// ── Jackpot config ──
// The wheel is house-banked: every spin's 5,000 PAT goes into the casino jackpot and every prize
// (regular slices included) is paid out of it. The jackpot slice is a thin glowing sliver
// (~1 in 3,000 spins) and EVERY landing pays - there's no hidden second gate. What it pays is a
// rolled % of the WHEEL JACKPOT, which is the casino pot capped at WHEEL_JACKPOT_CAP; anything above
// the cap stays in the pot as the casino's bank (blackjack, the lottery, heists).
// Monte Carlo (Oct 2026, real spin mix): regular slices 90% + jackpot ~4.6% => ~95% total payback,
// pot grows ~1.5M / 2 weeks from the wheel alone; a hit is ~400k typical, 1 in 10 >= ~1.9M.
const WHEEL_JACKPOT_CAP = 5000000;
// Floor: if a win ever leaves the pot below this, it's topped back up (minted) so the wheel
// always shows a live jackpot. With the cap, a win can only empty the pot when it's under 5M.
const JACKPOT_MINIMUM = 100000;

// Landing the jackpot slice rolls what PERCENT of the wheel jackpot you win. Skewed low so most hits are modest and the full 100% (GRAND) is
// rare-but-possible, and the payout scales with (and is drawn from) the pot so the wheel
// self-regulates. [weight, minPct, maxPct]; weights sum to 1. Average ≈ 14% of the pot;
// GRAND ≈ 1 in 200 slice hits (~1 in 93k spins at current odds). Tune freely.
const JACKPOT_TIERS = [
  { w: 0.45,  min: 0.02, max: 0.06 },
  { w: 0.28,  min: 0.06, max: 0.14 },
  { w: 0.15,  min: 0.14, max: 0.28 },
  { w: 0.08,  min: 0.28, max: 0.50 },
  { w: 0.025, min: 0.50, max: 0.75 },
  { w: 0.010, min: 0.75, max: 0.99 },
  { w: 0.005, min: 1.00, max: 1.00 }, // GRAND — the whole pot
];
function rollJackpotPercent() {
  let r = Math.random();
  for (const t of JACKPOT_TIERS) {
    if (r < t.w) return t.min + Math.random() * (t.max - t.min);
    r -= t.w;
  }
  return JACKPOT_TIERS[0].min; // float-rounding fallback
}

// ─── Server-authoritative wheel ──────────────────────────────────────────────
// The wheel layout is the single source of truth here — the server weighted-picks
// the winning slice and computes the payout at spin time. The client only renders
// this config and animates to land on the chosen slice; it never decides or reports
// the prize. Keep this in sync with public/publicwheel.js + public/script.js visuals
// (served via GET /api/wheel/config so they can't drift).
const PUBLIC_WHEEL_MULTIPLIER = 1.10; // the public/OBS wheel's fixed bonus (~97.5% total payback - the max any spinner gets)
// The gold wheel's prizes grow 1% every TWO spinner levels, capped at level 20 (x1.09). Rule: no
// spinner gets back more than ~97.5% including the jackpot slice. With these slices: level 1 ~89%,
// level 20+ ~96.6%, the public wheel ~97.5%, and the real spin mix averages ~95%.
const GOLD_WHEEL_MAX_LEVEL = 20;
function goldWheelMultiplier(level) {
  const lv = Math.max(1, Math.min(GOLD_WHEEL_MAX_LEVEL, Math.floor(Number(level) || 1)));
  return 1 + Math.floor((lv - 1) / 2) * 0.01;
}
const WHEEL_SEGMENTS = [
  { color: '#FF6347', base: 2700,  size: 1 },
  { color: '#FFD700', base: 5350,  size: 1 },
  { color: '#ADFF2F', base: 3650,  size: 1 },
  { color: '#00FA9A', base: 7750,  size: 0.9 },
  { color: '#1E90FF', base: 700,   size: 1 },
  { color: '#EE82EE', base: 0,     size: 1 },
  { color: '#FF69B4', base: 22500, size: 0.5 },
  { color: '#20B2AA', base: 920,   size: 1 },
  { color: '#FFA500', base: 5950,  size: 1 },
  { color: '#B22222', base: 4550,  size: 1 },
  { color: '#8A2BE2', base: 4100,  size: 1 },
  { color: '#5F9EA0', base: 1400,  size: 1 },
  { color: '#EE82EE', base: 0,     size: 1 },
  { color: '#FFD700', base: 46000, size: 0.1 },
  { color: '#DB7093', base: 2250,  size: 1 },
  { color: '#3CB371', base: 430,   size: 1 },
  { color: '#4682B4', base: 1850,  size: 1 },
  { color: '#FF1493', base: 11500, size: 0.8 },
  { color: '#00CED1', base: 0,     size: 1 },
  { color: '#FFD700', base: 6900,  size: 1 },
  { color: '#3CB371', base: 4950,  size: 1 },
  { color: '#4682B4', base: 3250,  size: 1 },
  { color: '#FF1493', base: 8200,  size: 1 },
  { color: '#8A2BE2', base: 9200,  size: 1 },
  { color: '#00CED1', base: 0,     size: 1 },
  { color: '#FFD700', jackpot: true, label: '🏆 JACKPOT 🏆', size: 0.00777 },  // 23.3 / 0.00777 => 1 in 3,000
];
function segValue(seg, multiplier) { return seg.jackpot ? 0 : Math.round(seg.base * multiplier); }

// Weighted pick over slice `size`.
function pickSegment() {
  const total = WHEEL_SEGMENTS.reduce((a, s) => a + s.size, 0);
  let r = Math.random() * total;
  for (let i = 0; i < WHEEL_SEGMENTS.length; i++) {
    r -= WHEEL_SEGMENTS[i].size;
    if (r < 0) return i;
  }
  return WHEEL_SEGMENTS.length - 1;
}

function getJackpotPot() {
  return getQuery("SELECT COALESCE(SUM(amount),0) AS total FROM jackpot_rakes").then((r) => (r[0] ? r[0].total : 0) || 0);
}

// Compute the result for a spin: which slice + payout. `multiplier` scales the fixed prizes —
// the gold wheel uses the spinner's level, the public/OBS wheel is fixed at x1.10. The
// jackpot slice rolls a % of the wheel jackpot (the pot, capped) and ignores the multiplier.
async function computeSpinResult(multiplier) {
  const idx = pickSegment();
  const seg = WHEEL_SEGMENTS[idx];
  if (seg.jackpot) {
    const pot = Math.min(Math.max(0, await getJackpotPot()), WHEEL_JACKPOT_CAP);
    const pct = rollJackpotPercent();
    return { segmentIndex: idx, payout: Math.max(0, Math.round(pot * pct)), jackpotPct: Math.round(pct * 100) };
  }
  return { segmentIndex: idx, payout: segValue(seg, multiplier), jackpotPct: null };
}

function spinDisplay(spin) {
  const seg = WHEEL_SEGMENTS[spin.segment_index];
  const isJackpot = !!(seg && seg.jackpot);
  const grand = isJackpot && (spin.jackpot_pct >= 100);
  return { result: spin.payout || 0, jackpot: isJackpot, jackpotPct: spin.jackpot_pct || 0, grand };
}

// The ONLY crediting path for the wheel. Idempotent: the atomic PENDING->SETTLED claim
// guarantees a spin can only ever be credited once, no matter how many times it's called
// (client "landed" ping, the timeout sweep, a retry, or a forged request).
async function settleSpin(spinId) {
  const rows = await getQuery(
    "SELECT spinId, userId, type, result, segment_index, payout, jackpot_pct FROM wheel_spins WHERE spinId = ?",
    [spinId]
  );
  if (!rows.length) return { ok: false, status: 404, error: 'not_found' };
  let spin = rows[0];
  if (spin.result === 'SETTLED') return { ok: true, already: true, ...spinDisplay(spin) };
  if (spin.result !== 'PENDING') return { ok: false, status: 409, error: 'not_pending' };

  const claim = await runQuery("UPDATE wheel_spins SET result = 'SETTLED' WHERE spinId = ? AND result = 'PENDING'", [spinId]);
  if (!claim || claim.changes === 0) {
    const again = await getQuery("SELECT * FROM wheel_spins WHERE spinId = ?", [spinId]);
    return { ok: true, already: true, ...(again.length ? spinDisplay(again[0]) : {}) };
  }

  const seg = WHEEL_SEGMENTS[spin.segment_index];
  const isJackpot = !!(seg && seg.jackpot);
  const grand = isJackpot && (spin.jackpot_pct >= 100);
  let payout = spin.payout || 0;
  if (!isJackpot && payout > 0) {
    // Regular prizes are paid out of the casino jackpot (the house bank). Whatever the pot can't
    // cover comes from the "wheel_shortfall" vault (the Reserve) - or isn't paid; never minted.
    const fromPot = Math.min(payout, Math.max(0, await getJackpotPot()));
    if (fromPot > 0) {
      await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)", [uuidv4(), spinId, spin.userId, -fromPot]);
    }
    const short = payout - fromPot;
    if (short > 0 && !(await funding.takeFunds("wheel_shortfall", short, spin.userId, "wheel prize shortfall"))) {
      payout = fromPot;
      await runQuery("UPDATE wheel_spins SET payout = ? WHERE spinId = ?", [payout, spinId]);
    }
  }
  if (payout > 0) {
    await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [payout, spin.userId]);
  }
  if (isJackpot && payout > 0) {
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)", [uuidv4(), spinId, spin.userId, -payout]);
    const left = await getJackpotPot();
    if (left < JACKPOT_MINIMUM && await funding.takeFunds("wheel_shortfall", JACKPOT_MINIMUM - left, spin.userId, "wheel jackpot reseed")) {
      // the reseed comes from the Reserve (a claim Pepe settles), not from nowhere
      await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)", [uuidv4(), spinId, spin.userId, JACKPOT_MINIMUM - left]);
    }
  }
  const txnType = isJackpot
    ? (grand ? "Jackpot Win" : "Jackpot Win (partial)")
    : (spin.type === 'gold' ? "Reward: Gold Spin" : "Reward: Public Spin");
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)", [uuidv4(), spin.userId, txnType, payout]);

  const xp = payout * 0.005;
  const levelUpInfo = await updateLevel(spin.userId, xp);
  achievements.checkWeb(spin.userId);              // spins / wheel winnings / jackpot achievements
  const out = { result: payout, jackpot: isJackpot, jackpotPct: spin.jackpot_pct || 0, grand, xp, levelUp: levelUpInfo };
  // 1.99: a settled spin can drop a cosmetic - very rarely (the wheel runs ~850 times a day), the
  // jackpot slice more often (rare or better). Rates and the shared daily cap come from Pepe's table.
  // Once per spin: only the call that won the PENDING->SETTLED claim above gets here.
  const drop = isJackpot
    ? await cosmetics.rollDrop(spin.userId, "wheel_jackpot", spinId, { minRarity: "rare" })
    : await cosmetics.rollDrop(spin.userId, "wheel", spinId, { organic: true });
  if (drop) out.cosmetic = drop;
  sendEvent("results", spinId, out);
  if (spin.type === "public") {
    sendEvent("spin", "watch", Object.assign({ type: "result", spinId, result: payout, jackpot: isJackpot, grand }, await spinnerLook(spin.userId)));
  }
  return { ok: true, ...out };
}

// Client renders the wheel from this so its visuals match the authoritative weights.
app.get("/api/wheel/config", (req, res) => {
  // Optional ?level=N returns the gold wheel's level-scaled labels; otherwise the fixed public wheel.
  const level = parseInt(req.query.level);
  const multiplier = Number.isFinite(level) ? goldWheelMultiplier(level) : PUBLIC_WHEEL_MULTIPLIER;
  res.json({
    multiplier,
    segments: WHEEL_SEGMENTS.map((s) => ({
      color: s.color,
      size: s.size,
      jackpot: !!s.jackpot,
      label: s.jackpot ? s.label : String(Math.round(s.base * multiplier)),
    })),
    jackpotCap: WHEEL_JACKPOT_CAP,
  });
});

// Called by the wheel page when the animation LANDS. Carries only spinId — the payout
// was decided server-side at spin time, so nothing here is client-controlled.
app.post("/api/wheel/settle", async (req, res) => {
  const spinId = req.body && req.body.spinId;
  if (!spinId) return res.status(400).json({ error: 'missing spinId' });
  try {
    const r = await settleSpin(spinId);
    if (!r.ok) return res.status(r.status || 500).json(r);
    res.json(r);
  } catch (e) {
    console.error("settle error:", e);
    res.status(500).json({ error: 'settle failed' });
  }
});

// Back-compat shim: the client no longer decides the prize. Any posted `result` is
// ignored; we settle from the server-computed payout (so a stale wheel page still works).
app.post("/api/g/wheel/spin/result", async (req, res) => {
  const spinId = req.body && req.body.spinId;
  if (!spinId) return res.status(400).json({ error: 'missing spinId' });
  try {
    const r = await settleSpin(spinId);
    if (!r.ok) return res.status(r.status || 500).json(r);
    res.json(r);
  } catch (e) {
    console.error("spin/result settle error:", e);
    res.status(500).json({ error: 'settle failed' });
  }
});

// Back-compat shim (gold): ignores any posted `result`, settles server-side.
app.post(
  "/api/u/:username/wheel/spin/result",
  authenticateToken,
  async (req, res) => {
    const spinId = req.body && req.body.spinId;
    if (!spinId) return res.status(400).json({ error: 'missing spinId' });
    try {
      const r = await settleSpin(spinId);
      if (!r.ok) return res.status(r.status || 500).json(r);
      res.json(r);
    } catch (e) {
      console.error("gold spin/result settle error:", e);
      res.status(500).json({ error: 'settle failed' });
    }
  }
);

// -- Restored bonus/xp/jackpot endpoints (accidentally removed during the wheel refactor) --
app.post("/api/bonus/chatwinner", async (req, res) => {
    const { userId, type, amount } = req.body;
    const password = req.body.password;

    if (password !== process.env.TWITCH_BOT_TOKEN) {
        return res.status(403).send("Access denied");
    }
  
    if (!userId || !amount || !type) {
      return res.status(400).send("Missing required fields");
    }
    // 1.63: Discord/Twitch rewards are paid OUT of a vault ("platform_rewards"), never minted.
    // (Pepe's own credits through here are already paid for on his side.)
    if (Number(amount) > 0 && /^(discord|twitch)-/i.test(String(type))) {
      if (!(await funding.takeFunds("platform_rewards", amount, userId, type))) {
        return res.status(409).json({ success: false, skipped: true, message: "the bank can't cover it" });
      }
    }
  
    const cp = await resolveCounterparty(req.body.counterparty);
    const idem = await idemBegin(req, res, "bonus/chatwinner");
    if (idem.replay) return;
    try {
      // Start a transaction
      const transactionId = uuidv4();
      const bonusId = uuidv4();
      await runQuery("BEGIN TRANSACTION");
  
      // Credit, or debit only what the balance covers: a deduction can never take anyone below zero.
      const amt = Number(amount);
      const upd = amt < 0
        ? await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ? AND points_balance >= ?", [amt, userId, -amt])
        : await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [amt, userId]);
      if (!upd || upd.changes === 0) {
        await runQuery("ROLLBACK");
        const body = amt < 0 ? { success: false, error: "insufficient" } : { success: false, error: "no_user" };
        const status = amt < 0 ? 402 : 404;
        idem.done(status, body);
        return res.status(status).json(body);
      }
  
      // Insert into bonus_winners table   
      await runQuery(
        "INSERT INTO bonus_winners (bonusId, type, userId, transactionId, amount) VALUES (?, ?, ?, ?, ?)",
        [bonusId, type, userId, transactionId, amount]
      );
  
      // Log the transaction
      await runQuery(
        "INSERT INTO transactions (transactionId, userId, type, points, counterparty) VALUES (?, ?, ?, ?, ?)",
        [transactionId, userId, "bonus win", amount, cp]
      );
  
      // Commit the transaction
      await runQuery("COMMIT");
  
      idem.done(200, { message: "Bonus winner logged and points awarded successfully" });
      res.status(200).send({ message: "Bonus winner logged and points awarded successfully" });
    } catch (error) {
      // Rollback in case of error
      await runQuery("ROLLBACK");
      idem.fail();
      console.error("Failed to process bonus winner:", error);
      res.status(500).send("Failed to process bonus winner");
    }
  });

// Grant XP to a user (bot-authenticated) — used for duel/heist wins. Runs the same
// updateLevel path as the wheel, so level-ups and their bonuses behave identically.
app.post("/api/u/grant-xp", async (req, res) => {
  const { userId, xp, password } = req.body;
  if (password !== process.env.TWITCH_BOT_TOKEN) {
    return res.status(403).send("Access denied");
  }
  if (!userId || xp === undefined || xp === null || isNaN(Number(xp))) {
    return res.status(400).send("Missing or invalid userId/xp");
  }
  try {
    const info = await updateLevel(userId, Number(xp));
    res.status(200).json({ success: true, info });
  } catch (error) {
    console.error("grant-xp error:", error);
    res.status(500).send("Failed to grant XP");
  }
});

// Adjust the jackpot pool from the !heist game. Positive amount FEEDS the bank
// (e.g. busted heist wagers), negative DRAINS it (heist winnings paid out from the pot).
// Bot-authenticated (same token pattern as chatwinner). Returns the new pot total.
app.post("/api/g/heist/jackpot-adjust", async (req, res) => {
  const { amount, userId, password } = req.body;
  if (password !== process.env.TWITCH_BOT_TOKEN) {
    return res.status(403).send("Access denied");
  }
  if (amount === undefined || amount === null || isNaN(Number(amount))) {
    return res.status(400).send("Missing or invalid amount");
  }
  try {
    const jackpotId = uuidv4();
    const spinId = uuidv4();
    await runQuery(
      "INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
      [jackpotId, spinId, userId || null, Math.round(Number(amount))]
    );
    const rows = await getQuery("SELECT SUM(amount) AS pot FROM jackpot_rakes");
    const pot = (rows && rows[0] && rows[0].pot) || 0;
    res.status(200).json({ success: true, jackpotTotal: pot });
  } catch (error) {
    console.error("Heist jackpot-adjust error:", error);
    res.status(500).send("Failed to adjust jackpot");
  }
});

// HTTP POST endpoint to handle bonus winner
app.post("/api/bonus/winner", authenticateToken, addUser, async (req, res) => {
  const { userId, type, amount } = req.body;

  const userType = req.user ? req.user.class : null;
  if (userType !== "Admin" || userType !== "Staff") {
      return res.status(403).send("Access denied");
  }

  if (!userId || !amount || !type) {
    return res.status(400).send("Missing required fields");
  }

  try {
    // Start a transaction
    const transactionId = uuidv4();
    const bonusId = uuidv4();
    await runQuery("BEGIN TRANSACTION");

    // Add points to the winner's points balance
    await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [amount, userId]);

    // Insert into bonus_winners table   
    await runQuery(
      "INSERT INTO bonus_winners (bonusId, type, userId, transactionId, amount) VALUES (?, ?, ?, ?, ?)",
      [bonusId, type, userId, transactionId, amount]
    );

    // Log the transaction
    await runQuery(
      "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
      [transactionId, userId, "bonus win", amount]
    );

    // Commit the transaction
    await runQuery("COMMIT");

    res.status(200).send({ message: "Bonus winner logged and points awarded successfully" });
  } catch (error) {
    // Rollback in case of error
    await runQuery("ROLLBACK");
    console.error("Failed to process bonus winner:", error);
    res.status(500).send("Failed to process bonus winner");
  }
});

// Is a wheel page (the OBS "WheelSource") connected to receive spins? Pepe checks before a
// !spin and his OBS watchdog refreshes the source when nothing is listening.
app.get("/api/g/wheel/listeners", (req, res) => {
  const list = (clients.spin && clients.spin.public) || [];
  res.json({ listeners: list.length });
});

app.get("/events", (req, res) => {
  const { type, identifier } = req.query; // 'type' could be 'spin' or 'results'
  // 1.99cp: type=dm is the signed-in user's own direct-message stream (messages.js) - never keyed by the URL
  if (type === "dm") return messages.sse(req, res);

  console.log(`[${new Date().toISOString()}] HIT /events endpoint. Type: ${req.query.type}, Identifier: ${req.query.identifier}`);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader('X-Accel-Buffering', 'no');

  console.log(`[${new Date().toISOString()}] HEADERS SET. X-Accel-Buffering is:`, res.getHeader('X-Accel-Buffering'));

  res.flushHeaders(); // Flush the headers to establish SSE connection
  console.log(`[${new Date().toISOString()}] Headers flushed.`);

  // Register this connection to receive updates for the specified spinId
  registerClient(type, identifier, res);

  req.on("close", () => {
    unregisterClient(type, identifier, res); // Clean up when the client disconnects
    res.end();
  });
});

function registerClient(type, identifier, res) {
  if (!clients[type]) {
    clients[type] = {};
  }
  if (!clients[type][identifier]) {
    clients[type][identifier] = [];
  }
  clients[type][identifier].push(res);
}

function unregisterClient(type, identifier, res) {
  clients[type][identifier] = clients[type][identifier].filter(
    (client) => client !== res
  );
  if (clients[type][identifier].length === 0) {
    delete clients[type][identifier];
  }
  res.end();
}

// Function to send events to clients listening for them.
function sendEvent(type, identifier, message) {
  const data = JSON.stringify(message);
  if (clients[type] && clients[type][identifier]) {
    clients[type][identifier].forEach((client) =>
      client.write(`data: ${data}\n\n`)
    );
  }
}

// Function to add a new poker game
async function addPokerNowGame(pokerNowId, userId, url, blinds) {
  try {
      // Dedup: the game can be reported by both the selfbot and the Discord bot's
      // messageUpdate listener — only insert the first time.
      const existing = await getQuery("SELECT pokerNowId FROM poker_now_games WHERE pokerNowId = ?", [pokerNowId]);
      if (existing.length > 0) {
          console.log(`Poker game ${pokerNowId} already registered, skipping.`);
          return;
      }
      const insertSql = "INSERT INTO poker_now_games (pokerNowId, userId, url, blinds) VALUES (?, ?, ?, ?)";
      await runQuery(insertSql, [pokerNowId, userId, url, blinds]);
      console.log(`Poker game ${pokerNowId} added by user ${userId}`);
  } catch (error) {
      console.error("Failed to add PokerNow game:", error.message);
  }
}

// HTTP POST endpoint for Discord bot to add Poker Now game
app.post("/api/pokernow/add", async (req, res) => {
  const { pokerNowId, userId, url, blinds } = req.body;
  try {
      if (!pokerNowId || !userId || !url || !blinds) {
          return res.status(400).json({ error: "Missing required fields" });
      }
      await addPokerNowGame(pokerNowId, userId, url, blinds);
      res.status(200).json({ message: "Poker Now game added successfully" });
  } catch (error) {
      res.status(500).json({ error: "Failed to add Poker Now game" });
  }
});

// List active Poker Now games as JSON (for the Camfrog bot's !poker command)
app.get("/api/pokernow/games", async (req, res) => {
  try {
    const games = await getQuery(`
        SELECT p.pokerNowId, p.url, p.blinds, p.date_created, u.displayname, u.username
        FROM poker_now_games p
        JOIN users u ON p.userId = u.userId
        ORDER BY p.date_created DESC`);
    res.json({ games });
  } catch (error) {
    console.error("Failed to list poker games:", error.message);
    res.status(500).json({ error: "Failed to list games" });
  }
});

// Manually remove a Poker Now game from the list (host-triggered via the Camfrog bot).
app.post("/api/pokernow/remove", async (req, res) => {
  const { pokerNowId, password } = req.body;
  if (password !== process.env.TWITCH_BOT_TOKEN) {
    return res.status(403).json({ error: "Access denied" });
  }
  if (!pokerNowId) {
    return res.status(400).json({ error: "Missing pokerNowId" });
  }
  try {
    const result = await runQuery("DELETE FROM poker_now_games WHERE pokerNowId = ?", [pokerNowId]);
    const removed = result && typeof result.changes === "number" ? result.changes : 0;
    res.json({ message: "removed", removed });
  } catch (error) {
    console.error("Failed to remove poker game:", error.message);
    res.status(500).json({ error: "Failed to remove game" });
  }
});

// Function to get game stats from Poker Now API
async function getPokerNowGameStats(pokerNowId) {
  try {
      const response = await fetch(`https://www.pokernow.club/api/v2/games/${pokerNowId}`);
      const data = await response.json();
      return data;
  } catch (error) {
      console.error("Failed to fetch game stats:", error.message);
      return null;
  }
}

// /poker is Pepe's Hold'em table page now (tables.js); it still lists any Discord PokerNow tables.

// Function to clean up old Poker Now games (older than 12 hours)
async function cleanUpOldGames() {
  try {
      const deleteSql = `DELETE FROM poker_now_games WHERE date_created < datetime('now', '-12 hours')`;
      await runQuery(deleteSql);
      console.log("Old Poker Now games cleaned up successfully.");
  } catch (error) {
      console.error("Failed to clean up old games:", error.message);
  }
}

// Run cleanup every hour (3600000 ms)
setInterval(cleanUpOldGames, 3600000);  // Run cleanup every 1 hour

// ─── Bot Stats API ───

// Leaderboard: top balances
app.get("/api/leaderboard", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 15;
    const rows = await getQuery(
      `SELECT username, displayname, points_balance, xp, level FROM users WHERE points_balance > 0 AND ${stale.LIVE()} ORDER BY points_balance DESC LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (error) {
    console.error("Leaderboard error:", error);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

// Helper: parse "since" query param into a Date
function parseSince(s) {
  if (!s) return null;
  s = s.toLowerCase();
  if (s === "today") { const d = new Date(); d.setHours(0,0,0,0); return d; }
  if (s === "week") return new Date(Date.now() - 7 * 86400000);
  if (s === "month") return new Date(Date.now() - 30 * 86400000);
  if (s === "year") return new Date(Date.now() - 365 * 86400000);
  if (s.endsWith("h")) { const h = parseInt(s); if (!isNaN(h)) return new Date(Date.now() - h * 3600000); }
  if (s.endsWith("d")) { const d = parseInt(s); if (!isNaN(d)) return new Date(Date.now() - d * 86400000); }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Spin stats: top winners by total PAT won (includes jackpot winnings)
// Query params: limit, since, user
// Total tip volume (PAT) across the room over a recent window — used by the turf Laundering tap.
app.get("/api/stats/tips-volume", async (req, res) => {
  try {
    const minutes = Math.max(1, Math.min(20160, parseInt(req.query.minutes) || 1440));
    const row = await getQuery(
      "SELECT COALESCE(SUM(ABS(points)), 0) AS volume FROM transactions WHERE type = 'tip sent' AND timestamp >= datetime('now', ?)",
      [`-${minutes} minutes`]
    );
    res.json({ volume: (row[0] && row[0].volume) || 0, minutes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/stats/spins", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 15;
    const user = req.query.user;
    const sinceDate = parseSince(req.query.since);
    let sinceClause = "";
    let sinceTxClause = "";
    const params = [];
    const txParams = [];

    if (sinceDate) {
      sinceClause = " AND ws.timestamp >= ?";
      sinceTxClause = " AND t.timestamp >= ?";
      params.push(sinceDate.toISOString());
      txParams.push(sinceDate.toISOString());
    }

    let userClause = "";
    let userTxClause = "";
    if (user) {
      userClause = " AND u.username = ? COLLATE NOCASE";
      userTxClause = " AND u.username = ? COLLATE NOCASE";
      params.push(user);
      txParams.push(user);
    }

    // Get ALL spin data (no limit in SQL — we limit after merging with jackpots)
    const spinRows = await getQuery(
      `SELECT u.username, ws.userId,
              COUNT(ws.spinId) as total_spins,
              SUM(CASE WHEN ws.result = 'FAILED' THEN 1 ELSE 0 END) as failed_spins,
              SUM(CASE
                    WHEN ws.result = 'SETTLED' AND ws.jackpot_pct IS NULL THEN COALESCE(ws.payout,0)
                    WHEN ws.result NOT LIKE '%JACKPOT%' AND ws.result NOT IN ('PENDING','INTENT','FAILED','SETTLED') THEN CAST(ws.result AS INTEGER)
                    ELSE 0 END) as regular_won,
              MAX(CASE
                    WHEN ws.result = 'SETTLED' AND ws.jackpot_pct IS NULL THEN COALESCE(ws.payout,0)
                    WHEN ws.result NOT LIKE '%JACKPOT%' AND ws.result NOT IN ('PENDING','INTENT','FAILED','SETTLED') THEN CAST(ws.result AS INTEGER)
                    ELSE 0 END) as biggest_regular,
              SUM(CASE
                    WHEN ws.result = 'SETTLED' AND ws.jackpot_pct IS NOT NULL THEN 1
                    WHEN ws.result LIKE '%JACKPOT%' THEN 1
                    ELSE 0 END) as jackpot_count
       FROM wheel_spins ws
       JOIN users u ON ws.userId = u.userId
       WHERE ws.result NOT IN ('PENDING','INTENT')${sinceClause}${userClause}
       GROUP BY ws.userId`,
      params
    );

    // Get jackpot winnings from transactions table (full + partial jackpot wins)
    const jackpotRows = await getQuery(
      `SELECT u.username, SUM(t.points) as jackpot_won, MAX(t.points) as biggest_jackpot
       FROM transactions t
       JOIN users u ON t.userId = u.userId
       WHERE t.type LIKE 'Jackpot Win%'${sinceTxClause}${userTxClause}
       GROUP BY t.userId`,
      txParams
    );
    const jackpotMap = {};
    for (const jr of jackpotRows) {
      jackpotMap[jr.username] = { won: jr.jackpot_won || 0, biggest: jr.biggest_jackpot || 0 };
    }

    // Merge results
    const results = spinRows.map(r => {
      const jp = jackpotMap[r.username] || { won: 0, biggest: 0 };
      const total_won = (r.regular_won || 0) + jp.won;
      const paid_spins = (r.total_spins || 0) - (r.failed_spins || 0);  // FAILED spins are refunded
      const wager_cost = paid_spins * 5000;
      const net_profit = total_won - wager_cost;
      return {
        username: r.username,
        total_spins: r.total_spins,
        regular_won: r.regular_won || 0,
        jackpot_won: jp.won,
        jackpot_count: r.jackpot_count || 0,
        total_won,
        wager_cost,
        net_profit,
        biggest_win: Math.max(r.biggest_regular || 0, jp.biggest),
      };
    });

    // Sort by total_won (including jackpots) and THEN limit
    results.sort((a, b) => b.total_won - a.total_won);
    res.json(results.slice(0, limit));
  } catch (error) {
    console.error("Spin stats error:", error);
    res.status(500).json({ error: "Failed to fetch spin stats" });
  }
});

// Jackpot history
app.get("/api/stats/jackpots", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const sinceDate = parseSince(req.query.since);
    let sinceClause = "";
    const params = [];

    if (sinceDate) {
      sinceClause = " AND t.timestamp >= ?";
      params.push(sinceDate.toISOString());
    }

    params.push(limit);
    const rows = await getQuery(
      `SELECT u.username, t.points as amount, t.timestamp
       FROM transactions t
       JOIN users u ON t.userId = u.userId
       WHERE t.type = 'Jackpot Win'${sinceClause}
       ORDER BY t.timestamp DESC
       LIMIT ?`,
      params
    );

    // Current jackpot pot
    const potRow = await getQuery(`SELECT SUM(amount) as pot FROM jackpot_rakes`);
    const currentPot = potRow[0]?.pot || 0;

    // Total jackpots hit
    const countRow = await getQuery(
      `SELECT COUNT(*) as count FROM transactions WHERE type = 'Jackpot Win'${sinceClause}`,
      sinceDate ? [sinceDate.toISOString()] : []
    );

    res.json({
      current_pot: currentPot,
      total_jackpots: countRow[0]?.count || 0,
      recent: rows
    });
  } catch (error) {
    console.error("Jackpot stats error:", error);
    res.status(500).json({ error: "Failed to fetch jackpot stats" });
  }
});

// User spin history
app.get("/api/stats/spins/:username", async (req, res) => {
  try {
    const username = req.params.username;
    const user = await getQuery(`SELECT userId FROM users WHERE username = ? COLLATE NOCASE`, [username]);
    if (!user.length) return res.status(404).json({ error: "User not found" });

    const rows = await getQuery(
      `SELECT ws.result, ws.payout, ws.jackpot_pct, ws.timestamp
       FROM wheel_spins ws
       WHERE ws.userId = ? AND ws.type = 'public' AND ws.result NOT IN ('PENDING','INTENT')
       ORDER BY ws.timestamp DESC
       LIMIT 50`,
      [user[0].userId]
    );
    // New rows store the amount in `payout` (result='SETTLED'); old rows kept it in `result`.
    const wonOf = (r) => {
      if (r.result === 'SETTLED') return r.payout || 0;
      if (r.result === 'FAILED') return 0;
      const n = parseInt(r.result, 10);
      return Number.isFinite(n) ? n : 0;
    };
    const total_spins = rows.length;
    const total_won = rows.reduce((sum, r) => sum + wonOf(r), 0);
    const biggest = Math.max(0, ...rows.map(wonOf));
    res.json({ username, total_spins, total_won, biggest_win: biggest, recent: rows.slice(0, 10) });
  } catch (error) {
    console.error("User spin stats error:", error);
    res.status(500).json({ error: "Failed to fetch user spin stats" });
  }
});

// XP leaderboard
app.get("/api/stats/xp", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 15;
    const rows = await getQuery(
      `SELECT username, displayname, xp, level FROM users WHERE xp > 0 AND ${stale.LIVE()} ORDER BY xp DESC LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (error) {
    console.error("XP stats error:", error);
    res.status(500).json({ error: "Failed to fetch XP stats" });
  }
});

// Anything no route matched: a friendly 404 (keeps the visitor signed in).
app.use(addUser, (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not found" });
  notFound(req, res);
});

// 1.99cf: loopback only (nginx is the way in); BIND_HOST overrides. See listen.js.
require("./listen").listen(app, port, "site", () => {
  console.log(`Server running on ${require("./listen").bindHost()}:${port}`);
});

