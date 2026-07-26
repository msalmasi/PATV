require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const fs = require("fs");
const path = require("path");
const port = 3000;
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
function addUser(req, res, next) {
  // Always define req.user (null when not logged in) so callers can test it consistently — it used
  // to be left *undefined* when there was no cookie at all, which reads differently from null.
  // Verified synchronously: the old callback form called next() outside the callback, which only
  // happens to work because jwt.verify is synchronous for a string secret.
  req.user = null;
  const token = req.cookies.jwt;
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.SECRET_KEY);
    } catch (err) {
      req.user = null; // expired or tampered — treat as logged out
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
app.use(express.json()); // Middleware to parse JSON bodies
app.use(express.urlencoded({ extended: true }));

let clients = []; // Keep track of connected clients for SSE

// Serve static files from the public directory
app.use("/public", express.static("public"));

// Homepage
app.get("/", addUser, async (req, res) => {
  const username = req.user ? req.user.username : null; // Fallback to null if no user in session
  const sql =
    "SELECT username, displayname, class, level, xp, avatar, email, points_balance FROM users WHERE username = ?";

  try {
    const results = await getQuery(sql, [username]);
      const user = results[0]; // Extract user data
      if (username) {
      res.render("home", {
        // Render profile.ejs with user data
        username: user.username,
        displayname: user.displayname,
        classh: user.class,
        level: user.level,
        xp: Math.round(user.xp),
        avatar: user.avatar,
        email: user.email,
        points_balance: user.points_balance,
        xpForNextLevel: xpForNextLevel
      });
    }

    else {
        res.render("home", {
            username: username
        });
    }
    // Proceed with fetching user data and generating wheel
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error });
  }
});

// Admin Panel Endpoint
app.get("/admin/panel", addUser, (req, res) => {
  console.log(req.user);
  const userType = req.user ? req.user.class : null;
  const username = req.user ? req.user.username : null;
  if (userType === "Admin" || userType === "Staff") {
    let errorMessages = req.flash("error");
    let successMessages = req.flash("success");
    res.render("adminPanel", {
      user: username,
      errors: errorMessages,
      success: successMessages,
    });
  } else {
    req.flash(
      "error",
      "Access denied. You must be an admin or staff to access this page."
    );
    return res.redirect("/login");
  }
});

// Just for fun
app.get("/friendo", (req, res) => {
  res.render("friendo", { title: "friendo" });
});

// Example route with authentication middleware
app.get("/protected", authenticateToken, (req, res) => {
  res.json({ message: "Protected route accessed successfully." });
});

app.get("/register", addUser, async (req, res) => {
  const username = req.user ? req.user.username : null; // Fallback to null if no user in session
  let errorMessages = req.flash("error");
  let successMessages = req.flash("success");
  res.render("register", {
    user: username,
    errors: errorMessages,
    success: successMessages,
  });
});

app.get("/login", (req, res) => {
  // Retrieve flash messages and pass them to the EJS template
  let errorMessages = req.flash("error");
  let successMessages = req.flash("success");
  res.render("login", {
    errors: errorMessages,
    success: successMessages,
  });
});

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
  const twitchAuthUrl = `https://id.twitch.tv/oauth2/authorize?${querystring.stringify(
    {
      client_id: process.env.TWITCH_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "user:read:email user:read:subscriptions",
    }
  )}`;
  res.redirect(twitchAuthUrl);
});

app.get("/auth/twitch/callback", async (req, res) => {
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
    console.log(userProfileResponse);
    console.log(twitchUser);

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
        };
        return res.redirect("/resolve-twitch-conflict"); // Redirect to a page to handle the decision
      } else {
        // No conflict, update current user with Twitch ID
        bonus = await getQuery(`SELECT twitchBonus FROM users WHERE userId = ?`, [currentUser.userId]);
        if (bonus[0].twitchBonus === 0) {
          const badgeId = 'twitch-user'; // Replace with your actual badge ID
          await awardBadge(currentUser.userId, badgeId);
          await awardBonus(currentUser.userId, "twitch connect", 50000)
        }
        await runQuery(
          "UPDATE users SET twitchId = ?, twitchDisplayname = ?, twitchBonus = ?, twitchBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
          [twitchUser.id, twitchUser.display_name, 1, currentUser.userId]
        );
        // Award Badge
        return res.redirect(`/u/${currentUser.username}/profile/edit`);
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
        const existingTwitchEmail = await getQuery(
          "SELECT * FROM users WHERE email = ?",
          [twitchUser.email]
        );
        if (existingTwitchEmail.length > 0) {
          bonus = await getQuery(`SELECT twitchBonus FROM users WHERE userId = ?`, [existingTwitchEmail[0].userId]);
          console.log(existingTwitchEmail[0]);
          console.log(bonus[0]);
          if (bonus[0].twitchBonus === 0) {
            const badgeId = 'twitch-user'; // Replace with your actual badge ID
            await awardBadge(existingTwitchEmail[0].userId, badgeId);
            await awardBonus(existingTwitchEmail[0].userId, "twitch connect", 50000)
          }
          await runQuery(
            "UPDATE users SET twitchId = ?, twitchDisplayname = ?, twitchBonus = ?, twitchBonus_at = CURRENT_TIMESTAMP WHERE email = ?",
            [twitchUser.id, twitchUser.display_name, 1, twitchUser.email]
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
            displayname: twitchUser.display_name,
            email: twitchUser.email,
            password: hashedPassword,
            twitchId: twitchUser.id,
            twitchDisplayname: twitchUser.display_name,
            avatar: twitchUser.profile_image_url,
            points_balance: 5000,
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
          bonus = await getQuery(`SELECT twitchBonus FROM users WHERE userId = ?`, [newUser.userId]);
          if (bonus[0].twitchBonus === 0) {
            const newUserBadgeId = 'fresh_meat'; // Ensure this ID matches the one in your badges table
            await awardBadge(newUser.userId, newUserBadgeId);
            const badgeId = 'twitch-user'; // Replace with your actual badge ID
            await awardBadge(newUser.userId, badgeId);
            await awardBonus(newUser.userId, "twitch connect", 50000)
          }
          await runQuery(
            "UPDATE users SET twitchBonus = ?, twitchBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
            [1, newUser.userId]
          );
          currentUser = newUser;
        }
      }
      // Create JWT for the new or found user and set as cookie
      const token = jwt.sign(
        {
          userId: currentUser.userId,
          username: currentUser.username,
          class: currentUser.class,
        },
        process.env.SECRET_KEY,
        { expiresIn: "1h" }
      );
      res.cookie("jwt", token, { httpOnly: true, secure: true });
      res.redirect("/");
    }
  } catch (error) {
    console.error("Failed to authenticate with Twitch:", error);
    res.status(500).send("Authentication failed");
  }
});

app.get("/resolve-twitch-conflict", (req, res) => {
  // Check if there is a conflict information stored in the session
  if (!req.session.conflict) {
    // No conflict data found, redirect to a safe default, e.g., user profile or dashboard
    return res.redirect("/");
  }

  const {
    existingUserId,
    existingPAT,
    currentUserId,
    currentUserUsername,
    twitchId,
    twitchDisplayname,
  } = req.session.conflict;
  res.render("resolve-twitch-conflict", {
    existingUserId: existingUserId,
    existingPAT: existingPAT,
    currentUserId: currentUserId,
    currentUserUsername: currentUserUsername,
    twitchId: twitchId,
    twitchDisplayname: twitchDisplayname,
  });
});

// Endpoint to resolve Twitch account conflicts
app.post("/merge-accounts-twitch", async (req, res) => {
  const decision = req.body.decision;
  const {
    existingUserId,
    currentUserUsername,
    currentUserId,
    twitchId,
    twitchDisplayname,
  } = req.session.conflict;

  if (decision === "yes") {
    // User decided to merge accounts
    try {
      // Import points_balance and other necessary data
      const results = await getQuery("SELECT * FROM users WHERE userId = ?", [
        existingUserId,
      ]);
      const currentResults = await getQuery(
        "SELECT discordId FROM users WHERE userId = ?",
        [currentUserId]
      );
      const points_balance =
        results.length > 0 ? results[0].points_balance : 0;
      const discordId = results.length > 0 ? results[0].discordId : null;
      const discordUsername =
        results.length > 0 ? results[0].discordUsername : null;
      const currentDiscordId =
        results.length > 0 ? currentResults[0].discordId : null;
      if (!currentDiscordId) {
        await runQuery(
          "UPDATE users SET discordId = ?, discordUsername = ? WHERE userId = ?",
          [discordId, discordUsername, currentUserId]
        );
      }
      await runQuery(
        "UPDATE users SET points_balance = points_balance + ? WHERE userId = ?",
        [points_balance, currentUserId]
      );
      await runQuery(
        "UPDATE users SET twitchId = ?, twitchDisplayname = ? WHERE userId = ?",
        [twitchId, twitchDisplayname, currentUserId]
      );
      await runQuery("DELETE FROM users WHERE userId = ?", [existingUserId]);
      bonus = await getQuery(`SELECT twitchBonus FROM users WHERE userId = ?`, [currentUserId]);
      if (bonus[0].twitchBonus === 0) {
        const badgeId = 'twitch-user'; // Replace with your actual badge ID
        await awardBadge(currentUserId, badgeId);
        await awardBonus(currentUserId, "twitch connect", 50000)
      }
      await runQuery(
        "UPDATE users SET twitchBonus = ?, twitchBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
        [1, currentUserId]
      );
      res.redirect(`/u/${currentUserUsername}/profile/edit`);
    } catch (error) {
      console.error("Error merging accounts:", error);
      res.status(500).send("Failed to merge accounts");
    }
  } else {
    // User decided not to merge accounts
    res.redirect(`/u/${currentUserUsername}/profile/edit`);
  }
});

// Endpoint for Discord auth
app.get("/auth/discord", (req, res) => {
  const redirectUri = process.env.DISCORD_AUTH_CALLBACK;
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?${querystring.stringify(
    {
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify email",
    }
  )}`;
  res.redirect(discordAuthUrl);
});

app.get("/auth/discord/callback", async (req, res) => {
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
    console.log(userProfileResponse);
    console.log(discordUser);

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
        bonus = await getQuery(`SELECT discordBonus FROM users WHERE userId = ?`, [currentUser.userId]);
        if (bonus[0].discordBonus === 0) {
          const badgeId = 'discord-user'; // Replace with your actual badge ID
          await awardBadge(currentUser.userId, badgeId);
          await awardBonus(currentUser.userId, "discord connect", 50000)
        }
        await runQuery(
          "UPDATE users SET discordId = ?, discordUsername = ?, discordBonus = ?, discordBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
          [discordUser.id, discordUser.username, 1, currentUser.userId]
        );
        return res.redirect(`/u/${currentUser.username}/profile/edit`);
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
        const existingDiscordEmail = await getQuery(
          "SELECT * FROM users WHERE email = ?",
          [discordUser.email]
        );
        if (existingDiscordEmail.length > 0) {
          bonus = await getQuery(`SELECT discordBonus FROM users WHERE userId = ?`, [existingDiscordEmail[0].userId]);
          if (bonus[0].discordBonus === 0) {
            const badgeId = 'discord-user'; // Replace with your actual badge ID
            await awardBadge(existingDiscordEmail[0].userId, badgeId);
            await awardBonus(existingDiscordEmail[0].userId, "discord connect", 50000)
          }
          await runQuery(
            "UPDATE users SET discordId = ?, discordUsername = ?, discordBonus = ?, discordBonus_at = CURRENT_TIMESTAMP WHERE email = ?",
            [discordUser.id, discordUser.username, 1, discordUser.email]
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
            displayname: discordUser.username,
            email: discordUser.email, // Discord email
            password: hashedPassword,
            avatar: `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`,
            discordId: discordUser.id,
            discordUsername: discordUser.username,
            points_balance: 5000,
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
          bonus = await getQuery(`SELECT discordBonus FROM users WHERE userId = ?`, [newUser.userId]);
          if (bonus[0].discordBonus === 0) {
            const newUserBadgeId = 'fresh_meat'; // Ensure this ID matches the one in your badges table
            await awardBadge(newUser.userId, newUserBadgeId);
            const badgeId = 'discord-user'; // Replace with your actual badge ID
            await awardBadge(newUser.userId, badgeId);
            await awardBonus(newUser.userId, "discord connect", 50000)
          }
          await runQuery(
            "UPDATE users SET discordBonus = ?, discordBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
            [1, newUser.userId]
          );
          currentUser = newUser;
        }
      }
      // Create JWT for the new or found user and set as cookie
      const token = jwt.sign(
        {
          userId: currentUser.userId,
          username: currentUser.username,
          class: currentUser.class,
        },
        process.env.SECRET_KEY,
        { expiresIn: "1h" }
      );
      res.cookie("jwt", token, { httpOnly: true, secure: true });
      res.redirect("/");
    }
  } catch (error) {
    console.error("Failed to authenticate with Discord:", error);
    res.status(500).send("Authentication failed");
  }
});

// Page for resolving Discord conflicts
app.get("/resolve-discord-conflict", (req, res) => {
  if (!req.session.conflict) {
    return res.redirect("/");
  }
  const {
    existingUserId,
    existingPAT,
    currentUserId,
    currentUserUsername,
    discordId,
    discordUsername,
  } = req.session.conflict;
  res.render("resolve-discord-conflict", {
    existingUserId,
    currentUserId,
    existingPAT,
    currentUserUsername,
    discordId,
    discordUsername,
  });
});

// Endpoint to resolve Discord account conflicts
app.post("/merge-accounts-discord", async (req, res) => {
  const decision = req.body.decision;
  const {
    existingUserId,
    currentUserId,
    currentUserUsername,
    discordId,
    discordUsername,
  } = req.session.conflict;

  if (decision === "yes") {
    try {
      // Merge logic here
      const results = await getQuery("SELECT * FROM users WHERE userId = ?", [
        existingUserId,
      ]);
      const currentResults = await getQuery(
        "SELECT twitchId FROM users WHERE userId = ?",
        [currentUserId]
      );
      console.log(results[0]);
      const points_balance =
        results.length > 0 ? results[0].points_balance : 0;
      const twitchId = results.length > 0 ? results[0].twitchId : null;
      const twitchDisplayname =
        results.length > 0 ? results[0].twitchDisplayname : null;
      const currentTwitchId =
        results.length > 0 ? currentResults[0].twitchId : null;
      if (!currentTwitchId) {
        await runQuery(
          "UPDATE users SET twitchId = ?, twitchDisplayname = ? WHERE userId = ?",
          [twitchId, twitchDisplayname, currentUserId]
        );
      }
      await runQuery(
        "UPDATE users SET points_balance = points_balance + ? WHERE userId = ?",
        [points_balance, currentUserId]
      );
      await runQuery(
        "UPDATE users SET discordId = ?, discordUsername = ? WHERE userId = ?",
        [discordId, discordUsername, currentUserId]
      );
      await runQuery("DELETE FROM users WHERE userId = ?", [existingUserId]);
      bonus = await getQuery(`SELECT discordBonus FROM users WHERE userId = ?`, [currentUserId]);
      if (bonus[0].discordBonus === 0) {
        const badgeId = 'discord-user'; // Replace with your actual badge ID
        await awardBadge(currentUserId, badgeId);
        await awardBonus(currentUserId, "discord connect", 50000)
      }
      await runQuery(
        "UPDATE users SET discordBonus = ?, discordBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
        [1, currentUserId]
      );
      res.redirect(`/u/${currentUserUsername}/profile/edit`);
    } catch (error) {
      console.error("Error merging accounts:", error);
      res.status(500).send("Failed to merge accounts");
    }
  } else {
    // User decided not to merge accounts
    res.redirect(`/u/${currentUserUsername}/profile/edit`);
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

// HTTP POST endpoint to reset password
app.post("/reset-password/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { password, confirm_password } = req.body;

    if (password !== confirm_password) {
      req.flash("error", "Passwords do not match.");
      return res.redirect("back");
    }

    const user = await db.get(
      "SELECT * FROM users WHERE resetPasswordToken = ? AND resetPasswordExpires > ?",
      [token, Date.now()]
    );
    if (!user) {
      req.flash("error", "Password reset token is invalid or has expired.");
      return res.redirect("back");
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    await db.run(
      "UPDATE users SET password = ?, resetPasswordToken = NULL, resetPasswordExpires = NULL WHERE resetPasswordToken = ?",
      [hashedPassword, token]
    );

    req.flash("success", "Success! Your password has been changed.");
    res.redirect("/login");
  } catch (error) {
    console.error("Reset Password Error:", error);
    req.flash("error", "Error resetting password.");
    res.redirect("back");
  }
});

// HTTP POST endpoint to send a password reset link
app.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  const token = crypto.randomBytes(20).toString("hex"); // Generate a token
  const expires = new Date(Date.now() + 3600000); // Token expires in 1 hour

  try {
    const user = await db.get("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      req.flash("error", "No account with that email address exists.");
      return res.redirect("/forgot-password");
    }

    // Store the token and expiration time in the database
    await db.run(
      "UPDATE users SET resetPasswordToken = ?, resetPasswordExpires = ? WHERE email = ?",
      [token, expires, email]
    );

    // Send email with the reset link
    const resetUrl = `https://${req.headers.host}/reset-password/${token}`;
    const msg = {
      to: email,
      from: "no-reply@publicaccess.tv",
      subject: "Password Reset",
      text: `You are receiving this because you (or someone else) have requested the reset of the password for your account.\n\n
                   Please click on the following link, or paste this into your browser to complete the process:\n\n
                   ${resetUrl} \n\n
                   If you did not request this, please ignore this email and your password will remain unchanged.\n`,
    };

    await instanceResend.emails.send(msg);
    req.flash(
      "success",
      "An e-mail has been sent to " + email + " with further instructions."
    );
    res.redirect("/forgot-password");
  } catch (error) {
    console.error("Forgot Password Error:", error);
    req.flash("error", "Error resetting password.");
    res.redirect("/forgot-password");
  }
});

app.get("/forgot-password", (req, res) => {
  // Retrieve flash messages and pass them to the EJS template
  let errorMessages = req.flash("error");
  let successMessages = req.flash("success");
  res.render("forgotPassword", {
    errors: errorMessages,
    success: successMessages,
  });
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

app.get("/shop", addUser, (req, res) => {
  const username = req.user ? req.user.username : null; // Fallback to null if no user in session
  // Retrieve flash messages and pass them to the EJS template
  let errorMessages = req.flash("error");
  let successMessages = req.flash("success");
  res.render("shop", {
    user: username,
    errors: errorMessages,
    success: successMessages,
  });
});

app.get("/reset-password/:token", async (req, res) => {
  const { token } = req.params;
  let errorMessages = req.flash("error");
  let successMessages = req.flash("success");
  // Optionally, validate the token before rendering the reset form
  try {
    const user = await db.get(
      "SELECT * FROM users WHERE resetPasswordToken = ? AND resetPasswordExpires > ?",
      [token, new Date()]
    );
    if (!user) {
      req.flash("error", "Password reset token is invalid or has expired.");
      return res.redirect("/forgot-password");
    }
    res.render("resetPassword", {
      token: token,
      errors: errorMessages,
      success: successMessages,
    });
  } catch (error) {
    req.flash("error", "Error accessing reset form.");
    res.redirect("/forgot-password");
  }
});

// HTTP GET endpoint to retrieve the leaderboards.
app.get("/rankings", addUser, async (req, res) => {
  const username = req.user ? req.user.username : null; // Fallback to null if no user in session

  const sql = `
        SELECT username, points_balance, displayname
        FROM users
        ORDER BY points_balance DESC
        LIMIT 100
    `;

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
    const jackpots = await getQuery(jackpotSql);
    // Current jackpot pot total
    const potRow = await getQuery(`SELECT SUM(amount) AS pot FROM jackpot_rakes`);
    const currentPot = (potRow[0] && potRow[0].pot) || 0;
    res.render("leaderboard", { user: username, users, jackpots, currentPot });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).send("Failed to fetch rankings.");
  }
});

// HTTP POST endpoint for registering a new user.
app.post("/register", registerUser);

// HTTP POST endpoint for logging in.
app.post("/login", loginUser);

// HTTP POST endpoint for logging out.
app.post("/logout", (req, res) => {
  res.clearCookie("jwt");
  res.redirect("/");
});

// Get user profile
app.get("/u/:username/profile", addUser, async (req, res) => {
  const username = req.user ? req.user.username : null; // Fallback to null if no user in session
  const usernameProfile = req.params.username; // Fallback to null if no user in session
  const sql =
    "SELECT userId, username, displayname, class, level, xp, avatar, email, points_balance FROM users WHERE username = ?";

  try {
    const results = await getQuery(sql, [usernameProfile]);
    if (results.length > 0) {
      const user = results[0]; // Extract user data
      const badges = await getQuery('SELECT b.* FROM badges b JOIN user_badges ub ON b.badgeId = ub.badgeId WHERE ub.userId = ?', [user.userId]);
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
        xpForNextLevel: xpForNextLevel
      });
    } else {
      res.clearCookie("jwt");
      res.redirect("/");
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
      const user = await getQuery('SELECT * FROM users WHERE discordId = ?', [discordId]);

      if (user.length === 0) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json({ user: user[0] });

    } catch (error) {
      res.status(500).json({ error: 'Failed to retrieve user' });
    }
  });

// This endpoint checks if a user with the given twitchId exists.
app.get('/api/users/twitch/:twitchId', async (req, res) => {
    const { twitchId } = req.params;
    try {
      const user = await getQuery('SELECT * FROM users WHERE twitchId = ?', [twitchId]);
      if (user.length === 0) {
        return res.status(404).json({ message: "User not found" });
      }

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
    const { username, displayname, email, twitchId, profileImage, twitchDisplayname, avatar, points_balance } = req.body;
    const userId = uuidv4();

    try {
      const password = Math.random().toString(36).substring(2, 15);
      const hashedPassword = await bcrypt.hash(password, 12);
      await runQuery(
        'INSERT INTO users (userId, username, displayname, email, password, twitchId, twitchDisplayname, avatar, points_balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, username, displayname, email, hashedPassword, twitchId, twitchDisplayname, avatar, points_balance]
      );
      bonus = await getQuery(`SELECT twitchBonus FROM users WHERE userId = ?`, [userId]);
      if (bonus[0].twitchBonus === 0) {
        const newUserBadgeId = 'fresh_meat'; // Ensure this ID matches the one in your badges table
        await awardBadge(userId, newUserBadgeId);
        const badgeId = 'twitch-user'; // Replace with your actual badge ID
        await awardBadge(userId, badgeId);
        await awardBonus(userId, "twitch connect", 50000)
      }
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
    const { username, displayname, email, discordId, profileImage, discordUsername, avatar, points_balance } = req.body;
    const userId = uuidv4();
  
    try {
      const password = Math.random().toString(36).substring(2, 15);
      const hashedPassword = await bcrypt.hash(password, 12);
      await runQuery(
        'INSERT INTO users (userId, username, displayname, email, password, discordId, discordUsername, avatar, points_balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, username, displayname, email, hashedPassword, discordId, discordUsername, avatar, points_balance]
      );
      bonus = await getQuery(`SELECT discordBonus FROM users WHERE userId = ?`, [userId]);
      if (bonus[0].discordBonus === 0) {
        const newUserBadgeId = 'fresh_meat'; // Ensure this ID matches the one in your badges table
        await awardBadge(userId, newUserBadgeId);
        const badgeId = 'discord-user'; // Replace with your actual badge ID
        await awardBadge(userId, badgeId);
        await awardBonus(userId, "discord connect", 50000)
      }
      await runQuery(
        "UPDATE users SET discordBonus = ?, discordBonus_at = CURRENT_TIMESTAMP WHERE userId = ?",
        [1, userId]
      );
      res.json({ user: { userId, username, displayname, points_balance } });
    } catch (error) {
      res.status(500).json({ error: 'Failed to create new user' });
    }
  });

// Get user profile
app.get("/u/:username/tip", addUser, async (req, res) => {
  const username = req.user ? req.user.username : null; // Fallback to null if no user in session
  const usernameProfile = req.params.username; // Fallback to null if no user in session
  const sql =
    "SELECT username, displayname, class, avatar, email, points_balance FROM users WHERE username = ?";

  try {
    const results = await getQuery(sql, [usernameProfile]);
    if (results.length > 0) {
      const user = results[0]; // Extract user data
      res.render("tip", {
        // Render profile.ejs with user data
        username: username,
        usernameProfile: user.username,
        displayname: user.displayname,
        classh: user.class,
        avatar: user.avatar,
        email: user.email,
        points_balance: user.points_balance,
      });
    } else {
      res.status(404).send("User not found.");
    }
  } catch (error) {
    console.error("Failed to retrieve user data:", error);
    res.status(500).send("Internal Server Error.");
  }
});

// Shared, overdraft-safe PAT transfer used by both tip endpoints.
// The debit is a single atomic conditional UPDATE (check + deduct in one statement),
// so concurrent tips can never overdraw a balance or mint PAT — this is what the old
// read-then-check-then-update flow got wrong (a TOCTOU race that created PAT).
// Returns { ok, status, msg }.
async function transferPat(senderUsername, recipientUsername, rawAmount) {
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

  // Ledger entries.
  await runQuery(
    "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
    [uuidv4(), sender.userId, "tip sent", -amount]
  );
  await runQuery(
    "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
    [uuidv4(), recipient.userId, "tip received", amount]
  );

  return { ok: true, status: 200, msg: "Tip sent successfully." };
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
  try {
    const r = await transferPat(senderUsername, req.params.username, req.body.amount);
    if (!r.ok) return res.status(r.status).send(r.msg);
    res.json({ message: r.msg });
  } catch (error) {
    console.error("Failed to process tip:", error);
    res.status(500).send("Failed to process tip");
  }
});

// ── Wager escrow for bot-run games (duels, brawls) ──
// charge = atomically lock a stake (can't be tipped out afterward); payout = release
// winnings/refund. Bot-token gated. The atomic conditional debit is what makes escrow safe.
app.post("/api/wager/charge", async (req, res) => {
  const { username, password } = req.body || {};
  const amount = Math.floor(Number(req.body && req.body.amount));
  const reason = ((req.body && req.body.reason) || "Wager").toString().slice(0, 40);
  if (password !== process.env.TWITCH_BOT_TOKEN) return res.status(403).json({ ok: false, error: "unauthorized" });
  if (!username || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "bad_request" });
  try {
    const users = await getQuery("SELECT userId, casino_banned FROM users WHERE username = ?", [username]);
    if (!users.length) return res.status(404).json({ ok: false, error: "no_user" });
    const userId = users[0].userId;
    // Casino-banned users can't be charged for casino games (blackjack/hold'em/poker/wheel).
    if (users[0].casino_banned && /^(blackjack|holdem|poker|wheel)/i.test(reason)) {
      return res.status(403).json({ ok: false, error: "casino_banned" });
    }
    // Atomic conditional debit: only succeeds if the balance covers it RIGHT NOW.
    const debit = await runQuery(
      "UPDATE users SET points_balance = points_balance - ? WHERE userId = ? AND points_balance >= ?",
      [amount, userId, amount]
    );
    if (!debit || debit.changes === 0) return res.status(402).json({ ok: false, error: "insufficient" });
    await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)", [uuidv4(), userId, reason, -amount]);
    res.json({ ok: true });
  } catch (e) {
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
  try {
    const users = await getQuery("SELECT userId FROM users WHERE username = ?", [username]);
    if (!users.length) return res.status(404).json({ ok: false, error: "no_user" });
    await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [amount, users[0].userId]);
    await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)", [uuidv4(), users[0].userId, reason, amount]);
    res.json({ ok: true });
  } catch (e) {
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

// Get user profile editor
app.get(
  "/u/:username/profile/edit",
  authenticateToken,
  addUser,
  async (req, res) => {
    const username = req.user ? req.user.username : null; // Fallback to null if no user in session
    const usernameProfile = req.params.username; // Fallback to null if no user in session
    const sql =
      "SELECT username, displayname, twitchDisplayname, discordUsername, camfrogUsername, avatar, email, points_balance FROM users WHERE username = ?";

    try {
      if (username == usernameProfile) {
        const results = await getQuery(sql, [usernameProfile]);
        if (results.length > 0) {
          const user = results[0]; // Extract user data
          let errorMessages = req.flash("error");
          let successMessages = req.flash("success");
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
            errors: errorMessages,
            success: successMessages,
          });
        } else {
          res.status(404).send("User not found.");
        }
      } else {
        res.redirect(`/u/${username}/profile/edit`);
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
    await runQuery("UPDATE users SET points_balance = 0 WHERE userId = ?", [userId]);
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
    const results = await getQuery(
      "SELECT userId, username, displayname, camfrogUsername, discordId, discordUsername, points_balance, xp, level FROM users WHERE LOWER(camfrogUsername) = LOWER(?)",
      [camfrogUsername]
    );
    if (results.length > 0) {
      res.json({ user: results[0] });
    } else {
      res.status(404).json({ message: "User not found" });
    }
  } catch (error) {
    console.error("Error finding Camfrog user:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// This endpoint creates a new Camfrog user
app.post('/api/users/camfrog/register', async (req, res) => {
  const { username, displayname, email, password, camfrogUsername, avatar, points_balance } = req.body;
  const userId = uuidv4();

  try {
    await runQuery(
      'INSERT INTO users (userId, username, displayname, email, password, camfrogUsername, avatar, points_balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, username, displayname, email, password, camfrogUsername, avatar, points_balance || 5000]
    );
    const newUserBadgeId = 'fresh_meat';
    await awardBadge(userId, newUserBadgeId);
    res.json({ user: { userId, username, displayname, camfrogUsername, points_balance: points_balance || 5000 } });
  } catch (error) {
    console.error('Error creating Camfrog user:', error.message);
    res.status(500).json({ error: 'Failed to create new user' });
  }
});

// HTTP post endpoint to shop
app.post("/shop", addUser, requireUser, async (req, res) => {
  const { product } = req.body;
  const userId = req.user.userId; // guaranteed by requireUser
  const username = req.user.username;
  try {
    // Check if the prize exists and get its cost and quantity
    const prizes = await getQuery(
      "SELECT prizeId, cost, prize, quantity FROM prizes WHERE prizeId = ?",
      [product]
    );

    if (prizes.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "That item isn't in the shop any more." });
    }
    const prize = prizes[0];

    // Check if the prize is in stock
    if (prize.quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: `${prize.prize} is out of stock — check back later.`,
      });
    }

    // Check if the user has enough points
    const users = await getQuery(
      "SELECT points_balance FROM users WHERE userId = ?",
      [userId]
    );
    if (users.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "We couldn't find your account — try logging in again." });
    }
    const balance = users[0].points_balance || 0;
    if (balance < prize.cost) {
      // Tell them exactly how short they are — "Insufficient coins" left people guessing.
      const short = prize.cost - balance;
      return res.status(400).json({
        success: false,
        message: `${prize.prize} costs ${prize.cost.toLocaleString()} PAT and you have ` +
                 `${balance.toLocaleString()} — ${short.toLocaleString()} short.`,
        balance,
        cost: prize.cost,
      });
    }

    // Start a transaction (if supported)
    await runQuery("BEGIN TRANSACTION");

    // Deduct the prize cost from the user's points balance
    await runQuery(
      "UPDATE users SET points_balance = points_balance - ? WHERE userId = ?",
      [prize.cost, userId]
    );

    // Digital prize effect: the spin boost permanently raises this user's daily gold-spin
    // cap by 100 (stackable — buy it again for another +100/day).
    if (prize.prizeId === "spinboost100") {
      await runQuery(
        "UPDATE users SET extra_daily_spins = COALESCE(extra_daily_spins, 0) + 100 WHERE userId = ?",
        [userId]
      );
    }

    // Decrement the prize quantity
    await runQuery(
      "UPDATE prizes SET quantity = quantity - 1 WHERE prizeId = ?",
      [prize.prizeId]
    );

    // Log the transaction
    const transactionId = uuidv4();
    await runQuery(
      "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
      [transactionId, userId, `purchase of ${prize.prize}`, -prize.cost]
    );

    // Commit the transaction
    await runQuery("COMMIT");

    // Confirm to the user FIRST. The notification email is not part of the purchase: it used to be
    // awaited inside this try, so a mail outage threw, hit the catch, ran a ROLLBACK that does
    // nothing after COMMIT, and told a user who had genuinely been charged that it failed.
    const remaining = balance - prize.cost;
    res.json({
      success: true,
      message: `Bought ${prize.prize} for ${prize.cost.toLocaleString()} PAT. ` +
               `Balance: ${remaining.toLocaleString()} PAT.`,
      prize: prize.prize,
      cost: prize.cost,
      balance: remaining,
      remaining_stock: Math.max(0, (prize.quantity || 1) - 1),
    });

    // Fire-and-forget notification — never let it affect the purchase result.
    instanceResend.emails
      .send({
        to: "pb@publicaccess.tv",
        from: "no-reply@publicaccess.tv",
        subject: "Purchase Notification",
        text: `User ${username} purchased ${prize.prize} for ${prize.cost} coins.`,
        html: `<strong>User ${username} purchased ${prize.prize} for ${prize.cost} coins.</strong>`,
      })
      .catch((e) => console.error("Purchase email failed (purchase itself was fine):", e.message));
  } catch (error) {
    console.error("Shop purchase error:", error);
    try {
      await runQuery("ROLLBACK");
    } catch (e) {
      /* nothing to roll back */
    }
    // JSON, not text — the page parses JSON and would otherwise show a generic failure.
    res
      .status(500)
      .json({ success: false, message: "Something went wrong buying that — you have not been charged." });
  }
});


// HTTP post endpoint to shop
app.post("/chatshop", async (req, res) => {
    const { product, username, userId, password } = req.body;
    
    if (password !== process.env.TWITCH_BOT_TOKEN) {
        return res.status(403).send("Access denied");
    }

    try {
      // Check if the prize exists and get its cost
      const prizes = await getQuery(
        "SELECT prizeId, cost, prize FROM prizes WHERE prizeId = ?",
        [product]
      );
  
      if (prizes.length === 0) {
        return res
          .status(404)
          .json({ success: false, message: "Prize not found" });
      }
      const prize = prizes[0];
  
      // Check if the user has enough points
      const users = await getQuery(
        "SELECT points_balance FROM users WHERE userId = ?",
        [userId]
      );
      if (users.length === 0 || users[0].points_balance < prize.cost) {
        return res
          .status(400)
          .json({ success: false, message: "Insufficient coins" });
      }
  
      // Deduct the prize cost from the user's points balance
      await runQuery(
        "UPDATE users SET points_balance = points_balance - ? WHERE userId = ?",
        [prize.cost, userId]
      );
  
      // Log the transaction
      const transactionId = uuidv4();
      await runQuery(
        "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
        [transactionId, userId, `purchase of ${prize.prize}`, -prize.cost]
      );
  
      // Send an email notification
      const msg = {
        to: "pb@publicaccess.tv", // Recipient email address
        from: "no-reply@publicaccess.tv", // Your verified sender
        subject: "Purchase Notification",
        text: `User ${username} purchased ${prize.prize} for ${prize.cost} coins.`,
        html: `<strong>User ${username} purchased ${prize.prize} for ${prize.cost} coins.</strong>`,
      };
      await instanceResend.emails.send(msg);
  
      // Respond to the user
      res.json({ success: true, message: "Purchase successful" });
    } catch (error) {
      console.error("Server error:", error);
      res.status(500).send("Failed to process the purchase.");
    }
  });

// Function to get the total jackpot
function getJackpotTotal(req, res) {
  db.get("SELECT SUM(amount) AS total FROM jackpot_rakes", (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    return res.json({ jackpotTotal: row.total || 0 }); // Return 0 if null
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

// HTTP GET endpoint to get the list of prizes with their costs
app.get("/api/prizes", async (req, res) => {
  const sql = "SELECT prizeId, prize, cost, quantity FROM prizes"; // Updated SQL to fetch the cost as well
  try {
    db.all(sql, [], (err, rows) => {
      if (err) {
        console.error(err.message);
        res.status(500).send("Failed to retrieve prizes.");
        return;
      }
      // Send an array of objects with both prize names and costs
      res.json(
        rows.map((row) => {
          return { prize: row.prize, cost: row.cost, prizeId: row.prizeId, quantity: row.quantity };
        })
      );
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Failed to retrieve prizes.");
  }
});

// HTTP GET endpoint to get top balances (JSON)
app.get("/api/rankings/top", async (req, res) => {
  const limit = parseInt(req.query.limit) || 5;
  const sql = `SELECT username, displayname, points_balance FROM users ORDER BY points_balance DESC LIMIT ?`;
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

      // Deduct the wager from the user's balance
      const transactionId = uuidv4();
      await runQuery(
        "UPDATE users SET points_balance = points_balance - ? WHERE userId = ?",
        [wager, userId]
      );
  
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
  
      // Add the payout to the user's balance
      await runQuery(
        "UPDATE users SET points_balance = points_balance + ? WHERE userId = ?",
        [payout, userId]
      );
  
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
  
// Route to render the manage prizes page
app.get('/admin/manage-prizes', addUser, (req, res) => {
  const userType = req.user ? req.user.class : null;
  const username = req.user ? req.user.username : null;
  if (userType === "Admin" || userType === "Staff") {
    res.render('managePrizes', { user: username });
  } else {
    req.flash("error", "Access denied. You must be an admin or staff to access this page.");
    res.redirect("/login");
  }
});

// HTTP POST endpoint to edit the list of prizes.
app.post("/api/prizes/edit", addUser, async (req, res) => {
  const userType = req.user ? req.user.class : null;
  if (userType === "Admin" || userType === "Staff") {
    const { action, prizeId, prizeName, cost, quantity } = req.body;

    try {
      if (action === "add") {
        if (prizeId) {
          // Update existing prize
          const updateSql = "UPDATE prizes SET prize = ?, cost = ?, quantity = ? WHERE prizeId = ?";
          await runQuery(updateSql, [prizeName, cost, quantity, prizeId]);
          res.json({ message: "Prize updated successfully." });
        } else {
          // Add new prize
          const newPrizeId = uuidv4();
          const insertSql =
            "INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES (?, ?, ?, ?)";
          await runQuery(insertSql, [newPrizeId, prizeName, cost, quantity]);
          res.json({ message: "Prize added successfully." });
        }
      } else if (action === "remove") {
        const deleteSql = "DELETE FROM prizes WHERE prize = ?";
        const result = await runQuery(deleteSql, [prizeName]);
        if (result.changes) {
          res.json({ message: "Prize removed successfully." });
        } else {
          res.status(404).send("Prize not found.");
        }
      } else {
        res.status(400).send("Invalid action specified.");
      }
    } catch (error) {
      console.error(error);
      res.status(500).send("Failed to process prize.");
    }
  } else {
    req.flash(
      "error",
      "Access denied. You must be an admin or staff to access this page."
    );
    return res.redirect("/login");
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
    const outcome = await computeSpinResult(1 + spinnerLevel * 0.01 - 0.01);

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
      [jackpotId, spinId, spinDetails[0].userId, 500]
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

    // Public/OBS wheel prizes are fixed (level-20 multiplier), same as publicwheel.js.
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
      [jackpotId, spinId, spinDetails[0].userId, 500]
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

    res.json({
      success: true,
      message: `public spinid ${spinId} from ${username}`,
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
            [jackpotId, spinId, userId, -500],
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
// ── Jackpot odds config ──
// The jackpot rate is gated by a secondary server-side roll so we can tune it
// independently of the visual wheel slice (which can't be shrunk below a landable size).
// The jackpot slice is landed on ~1 in 467 spins (slice weight 0.05 / total weight 23.35).
// Overall jackpot odds = sliceOdds / targetOdds  =>  ~1 in 5000 spins (~weekly at current volume).
const JACKPOT_TARGET_ODDS = 5000;   // tune this to make the jackpot more/less frequent
const JACKPOT_SLICE_ODDS = 467;     // ~1 in N spins land on the visual jackpot slice
const JACKPOT_CONFIRM_CHANCE = JACKPOT_SLICE_ODDS / JACKPOT_TARGET_ODDS; // ~0.0934
// Near-miss consolation = the largest wheel prize.
// Largest base prize 50000 * multiplier 1.2 = 60000  =>  consolation 60000.
// Keep SPIN_MULTIPLIER / LARGEST_BASE_PRIZE in sync with public/publicwheel.js + public/script.js.
const SPIN_MULTIPLIER = 1 + (20 * 0.01);
const LARGEST_BASE_PRIZE = 50000;
const JACKPOT_CONSOLATION = Math.round(LARGEST_BASE_PRIZE * SPIN_MULTIPLIER);
// Minimum jackpot floor — after the whole pot is won, it reseeds to this instead of 0.
const JACKPOT_MINIMUM = 100000;

// Landing the jackpot slice triggers a second roll that decides what PERCENT of the
// current pot you win. Skewed low so most hits are modest and the full 100% (GRAND) is
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
const PUBLIC_WHEEL_MULTIPLIER = 1 + (20 * 0.01); // 1.2 — the public/OBS wheel is fixed at level 20
const WHEEL_SEGMENTS = [
  { color: '#FF6347', base: 3000,  size: 1 },
  { color: '#FFD700', base: 6000,  size: 1 },
  { color: '#ADFF2F', base: 4000,  size: 1 },
  { color: '#00FA9A', base: 8500,  size: 0.9 },
  { color: '#1E90FF', base: 750,   size: 1 },
  { color: '#EE82EE', base: 0,     size: 1 },
  { color: '#FF69B4', base: 25000, size: 0.5 },
  { color: '#20B2AA', base: 1000,  size: 1 },
  { color: '#FFA500', base: 6500,  size: 1 },
  { color: '#B22222', base: 5000,  size: 1 },
  { color: '#8A2BE2', base: 4500,  size: 1 },
  { color: '#5F9EA0', base: 1500,  size: 1 },
  { color: '#EE82EE', base: 0,     size: 1 },
  { color: '#FFD700', base: 50000, size: 0.1 },
  { color: '#DB7093', base: 2500,  size: 1 },
  { color: '#3CB371', base: 500,   size: 1 },
  { color: '#4682B4', base: 2000,  size: 1 },
  { color: '#FF1493', base: 12500, size: 0.8 },
  { color: '#00CED1', base: 0,     size: 1 },
  { color: '#FFD700', base: 7500,  size: 1 },
  { color: '#3CB371', base: 5500,  size: 1 },
  { color: '#4682B4', base: 3500,  size: 1 },
  { color: '#FF1493', base: 9000,  size: 1 },
  { color: '#8A2BE2', base: 10000, size: 1 },
  { color: '#00CED1', base: 0,     size: 1 },
  { color: '#FFD700', jackpot: true, label: '🏆🏆🏆JACKPOT🏆🏆🏆', size: 0.05 },
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
// the gold wheel uses the spinner's level, the public/OBS wheel is fixed at level 20. The
// jackpot slice is pot-based (rolls a % of the pot) and unaffected by the multiplier.
async function computeSpinResult(multiplier) {
  const idx = pickSegment();
  const seg = WHEEL_SEGMENTS[idx];
  if (seg.jackpot) {
    const pot = await getJackpotPot();
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
  const payout = spin.payout || 0;

  if (payout > 0) {
    await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [payout, spin.userId]);
  }
  if (isJackpot) {
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)", [uuidv4(), spinId, spin.userId, -payout]);
    if (grand) {
      await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)", [uuidv4(), spinId, spin.userId, JACKPOT_MINIMUM]);
    }
  }
  const txnType = isJackpot
    ? (grand ? "Jackpot Win" : "Jackpot Win (partial)")
    : (spin.type === 'gold' ? "Reward: Gold Spin" : "Reward: Public Spin");
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)", [uuidv4(), spin.userId, txnType, payout]);

  const xp = payout * 0.005;
  const levelUpInfo = await updateLevel(spin.userId, xp);
  const out = { result: payout, jackpot: isJackpot, jackpotPct: spin.jackpot_pct || 0, grand, xp, levelUp: levelUpInfo };
  sendEvent("results", spinId, out);
  return { ok: true, ...out };
}

// Client renders the wheel from this so its visuals match the authoritative weights.
app.get("/api/wheel/config", (req, res) => {
  // Optional ?level=N returns the gold wheel's level-scaled labels; otherwise the fixed public wheel.
  const level = parseInt(req.query.level);
  const multiplier = Number.isFinite(level) ? (1 + level * 0.01 - 0.01) : PUBLIC_WHEEL_MULTIPLIER;
  res.json({
    multiplier,
    segments: WHEEL_SEGMENTS.map((s) => ({
      color: s.color,
      size: s.size,
      jackpot: !!s.jackpot,
      label: s.jackpot ? s.label : String(Math.round(s.base * multiplier)),
    })),
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

app.get("/events", (req, res) => {
  const { type, identifier } = req.query; // 'type' could be 'spin' or 'results'

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

// Fetch all active Poker Now games from the database
app.get("/poker", addUser, async (req, res) => {
  const username = req.user ? req.user.username : null; // Fallback to null if no user in session
  const sql =
  "SELECT username, displayname, twitchDisplayname, discordUsername, avatar, email, points_balance FROM users WHERE username = ?";
  try {
    const results = await getQuery(sql, [username]);
    const user = results[0];
    const discordUsername = user ? user.discordUsername : null;
      const games = await getQuery(`
          SELECT p.pokerNowId, p.url, p.blinds, p.date_created, u.displayname, u.username 
          FROM poker_now_games p 
          JOIN users u ON p.userId = u.userId
          ORDER BY p.date_created DESC
      `);
      res.render("activeGames", { games, user: username, discordUsername });
  } catch (error) {
      console.error("Failed to load games:", error.message);
      res.status(500).send("Failed to load games.");
  }
});

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
      `SELECT username, points_balance, xp, level FROM users WHERE points_balance > 0 ORDER BY points_balance DESC LIMIT ?`,
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
      `SELECT username, xp, level FROM users WHERE xp > 0 ORDER BY xp DESC LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (error) {
    console.error("XP stats error:", error);
    res.status(500).json({ error: "Failed to fetch XP stats" });
  }
});

app.listen(port, () => {
  console.log(`Server running on port   ${port}`);
});

