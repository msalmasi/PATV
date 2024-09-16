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
app.use((req, res, next) => {
  console.log("Request method: ", req.params);
  next();
});

// Helper Middleware for Auth
function addUser(req, res, next) {
  const token = req.cookies.jwt;
  if (token) {
    jwt.verify(token, process.env.SECRET_KEY, (err, decoded) => {
      if (!err) {
        req.user = decoded; // Attach user details to request
      } else {
        req.user = null;
      }
    });
  }
  next(); // Proceed regardless of token validity
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
        xp: user.xp,
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
            points_balance: 50000,
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
            points_balance: 50000,
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
    const resetUrl = `http://${req.headers.host}/reset-password/${token}`;
    const msg = {
      to: email,
      from: "no-reply@publicaccess.tv",
      subject: "Password Reset",
      text: `You are receiving this because you (or someone else) have requested the reset of the password for your account.\n\n
                   Please click on the following link, or paste this into your browser to complete the process:\n\n
                   ${resetUrl} \n\n
                   If you did not request this, please ignore this email and your password will remain unchanged.\n`,
    };

    await sgMail.send(msg);
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

  try {
    const users = await getQuery(sql); // Adjust getQuery to handle multiple rows if needed
    res.render("leaderboard", { user: username, users });
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
        xp: user.xp,
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
      if (user && user.length > 0) {
        res.json({ user: user[0] });
      } else {
        res.json({ user: null });
      }
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
      const user = await getQuery('SELECT username FROM users WHERE username = ?', [username]);
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

// Tip another user through a chatbot
app.post("/u/:username/chattip", async (req, res) => {
    const { amount } = req.body;
    const senderUsername = req.body.sender;
    const recipientUsername = req.body.recipient;
    const password = req.body.password;

    if (password !== process.env.TWITCH_BOT_TOKEN) {
        return res.status(403).send("Access denied");
    }
  
    if (senderUsername === recipientUsername) {
      return res.status(400).send("Cannot tip oneself");
    }
  
    try {
      // Check both users exist and fetch their current balances
      const users = await getQuery(
        "SELECT username, userId, points_balance FROM users WHERE username IN (?, ?)",
        [senderUsername, recipientUsername]
      );
      if (users.length !== 2) {
        return res.status(404).send("One or both users not found");
      }
  
      const sender = users.find((user) => user.username === senderUsername);
      const recipient = users.find((user) => user.username === recipientUsername);
  
      if (sender.points_balance < amount) {
        return res.status(400).send("Insufficient balance");
      }
  
      // Deduct amount from sender's balance
      await runQuery(
        "UPDATE users SET points_balance = points_balance - ? WHERE userId = ?",
        [amount, sender.userId]
      );
  
      // Add amount to recipient's balance
      await runQuery(
        "UPDATE users SET points_balance = points_balance + ? WHERE userId = ?",
        [amount, recipient.userId]
      );
  
      // Log transaction for sender
      const transactionIdSender = uuidv4();
      await runQuery(
        "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
        [transactionIdSender, sender.userId, "tip sent", -amount]
      );
  
      // Log transaction for receiver
      const transactionIdReceiver = uuidv4();
      await runQuery(
        "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
        [transactionIdReceiver, recipient.userId, "tip received", amount]
      );
      console.log("Tip sent successfully.");
      res.json({ message: "Tip sent successfully." });
    } catch (error) {
      console.error("Failed to process tip:", error);
      res.status(500).send("Failed to process tip");
    }
  });

// Tip another user
app.post("/u/:username/tip", authenticateToken, addUser, async (req, res) => {
  const { amount } = req.body;
  const senderUsername = req.user ? req.user.username : null; // Logged in user's username
  const recipientUsername = req.params.username;

  if (!senderUsername) {
    return res.status(401).send("Authentication required");
  }

  if (senderUsername === recipientUsername) {
    return res.status(400).send("Cannot tip oneself");
  }

  try {
    // Check both users exist and fetch their current balances
    const users = await getQuery(
      "SELECT username, userId, points_balance FROM users WHERE username IN (?, ?)",
      [senderUsername, recipientUsername]
    );
    if (users.length !== 2) {
      return res.status(404).send("One or both users not found");
    }

    const sender = users.find((user) => user.username === senderUsername);
    const recipient = users.find((user) => user.username === recipientUsername);

    if (sender.points_balance < amount) {
      return res.status(400).send("Insufficient balance");
    }

    // Deduct amount from sender's balance
    await runQuery(
      "UPDATE users SET points_balance = points_balance - ? WHERE userId = ?",
      [amount, sender.userId]
    );

    // Add amount to recipient's balance
    await runQuery(
      "UPDATE users SET points_balance = points_balance + ? WHERE userId = ?",
      [amount, recipient.userId]
    );

    // Log transaction for sender
    const transactionIdSender = uuidv4();
    await runQuery(
      "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
      [transactionIdSender, sender.userId, "tip sent", -amount]
    );

    // Log transaction for receiver
    const transactionIdReceiver = uuidv4();
    await runQuery(
      "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
      [transactionIdReceiver, recipient.userId, "tip received", amount]
    );
    console.log("Tip sent successfully.");
    res.json({ message: "Tip sent successfully." });
  } catch (error) {
    console.error("Failed to process tip:", error);
    res.status(500).send("Failed to process tip");
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
      "SELECT username, displayname, twitchDisplayname, discordUsername, avatar, email, points_balance FROM users WHERE username = ?";

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

// HTTP post endpoint to shop
app.post("/shop", addUser, async (req, res) => {
  const { product } = req.body;
  const userId = req.user.userId; // Assuming userId is available from session or token
  const username = req.user ? req.user.username : null;
  try {
    // Check if the prize exists and get its cost and quantity
    const prizes = await getQuery(
      "SELECT prizeId, cost, prize, quantity FROM prizes WHERE prizeId = ?",
      [product]
    );

    if (prizes.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Prize not found" });
    }
    const prize = prizes[0];

    // Check if the prize is in stock
    if (prize.quantity <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Prize is out of stock" });
    }

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

    // Start a transaction (if supported)
    await runQuery("BEGIN TRANSACTION");

    // Deduct the prize cost from the user's points balance
    await runQuery(
      "UPDATE users SET points_balance = points_balance - ? WHERE userId = ?",
      [prize.cost, userId]
    );

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

    // Send an email notification
    const msg = {
      to: "pb@publicaccess.tv", // Recipient email address
      from: "no-reply@publicaccess.tv", // Your verified sender
      subject: "Purchase Notification",
      text: `User ${username} purchased ${prize.prize} for ${prize.cost} coins.`,
      html: `<strong>User ${username} purchased ${prize.prize} for ${prize.cost} coins.</strong>`,
    };
    await sgMail.send(msg);

    // Respond to the user
    res.json({ success: true, message: "Purchase successful" });
  } catch (error) {
    console.error("Server error:", error);

    // Rollback the transaction in case of error
    await runQuery("ROLLBACK");

    res.status(500).send("Failed to process the purchase.");
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
      await sgMail.send(msg);
  
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

// HTTP GET endpoint to get user balance
app.get("/api/u/:username/balance", getUserBalance);

// HTTP GET endpoint to get user balance
app.get("/api/u/:username/level", getUserLevel);

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
        xp: user.xp,
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

// HTTP Post endpoint to update the jackpot
app.post("/api/g/wheel/jackpot", addUser, async (req, res) => {
  const { amount } = req.body;
  const userId = req.user.userId; // Assuming this is set by the authenticateToken middleware
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
    const userId = req.user.userId; // Assuming you have user identification set up

    try {
        const codeData = await getQuery("SELECT * FROM redemption_codes WHERE code = ? AND (expiration_date IS NULL OR expiration_date > CURRENT_TIMESTAMP) AND uses_remaining > 0", [code]);
        const transactionId = uuidv4();
        if (codeData.length === 0) {
            return res.status(404).send("Invalid or expired code");
        }

        const userRedemption = await getQuery("SELECT * FROM user_redemptions WHERE userId = ? AND code = ?", [userId, code]);
        if (userRedemption.length > 0) {
            return res.status(400).send("Code has already been redeemed by you");
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
        
        res.json({ message: "Code redeemed successfully." });
    } catch (error) {
        await runQuery("ROLLBACK");
        console.error("Failed to redeem code:", error);
        res.status(500).send("Failed to redeem code");
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
      const users = await getQuery("SELECT points_balance FROM users WHERE userId = ?", [userId]);
      if (users.length === 0 || users[0].points_balance < wager) {
        return res.status(400).json({ success: false, message: "Insufficient balance" });
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
      `SELECT userId, points_balance FROM users WHERE username = ?;`,
      [username]
    );

    if (!user.length || user[0].points_balance < 5000) {
      return res.status(400).send("Insufficient points or user not found");
    }

    const pendingSpin = await getQuery(
      `SELECT * FROM wheel_spins WHERE result = 'PENDING' AND type = 'gold' AND userId = ? ORDER BY rowid DESC LIMIT 1;`,
      [user[0].userId]
    );

    if (pendingSpin.length) {
      return res.status(400).send("Free spin in progress.");
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

    //   sendEvent("spin", pageId, {
    //     message: `Spin: ${username}`,
    //     spinId: spinId, // Include the spin ID for tracking
    //     timestamp: new Date(),
    //   });

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
      `UPDATE wheel_spins SET result = 'PENDING', type = 'gold' WHERE spinId = ?`,
      [spinId]
    );

    await runQuery("COMMIT");

    res.json({ success: true, message: "Spin confirmed and points deducted" });
  } catch (error) {
    await runQuery("ROLLBACK");
    console.error("Failed to finalize spin:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to finalize spin" });
  }
});

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
      `SELECT userId, points_balance FROM users WHERE username = ?;`,
      [username]
    );

    if (!user.length || user[0].points_balance < 5000) {
      return res.status(400).send("Insufficient points or user not found");
    }

    const pendingSpin = await getQuery(
      `SELECT * FROM wheel_spins WHERE result = 'PENDING' AND type = 'public' AND userId = ? ORDER BY rowid DESC LIMIT 1;`,
      [user[0].userId]
    );

    if (pendingSpin.length) {
      return res.status(400).send("Free spin in progress.");
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
        `SELECT userId, points_balance FROM users WHERE username = ?;`,
        [username]
      );
  
      if (!user.length || user[0].points_balance < 5000) {
        return res.status(400).send("Insufficient points or user not found");
      }
  
      const pendingSpin = await getQuery(
        `SELECT * FROM wheel_spins WHERE result = 'PENDING' AND type = 'public' AND userId = ? ORDER BY rowid DESC LIMIT 1;`,
        [user[0].userId]
      );
  
      if (pendingSpin.length) {
        return res.status(400).send("Free spin in progress.");
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
    const spinUser = await getQuery(
      "SELECT username FROM users WHERE userId = ?",
      [spinDetails[0].userId]
    );
    const username = spinUser[0].username;
    if (!spinDetails.length) {
      return res.status(404).send("Spin not found or already processed");
    }

    //   sendEvent("spin", pageId, {
    //     message: `Spin: ${username}`,
    //     spinId: spinId, // Include the spin ID for tracking
    //     timestamp: new Date(),
    //   });

    await runQuery("BEGIN TRANSACTION");

    await runQuery(
      `UPDATE users SET points_balance = points_balance - 5000 WHERE userId = ?`,
      [spinDetails[0].userId]
    );
    console.log(spinDetails[0].userId);
    console.log(spinDetails);
    console.log(transactionId);
    console.log(spinId);
    console.log(jackpotId);
    await runQuery(
      `INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?);`,
      [transactionId, spinDetails[0].userId, "Wager: Public Spin", -5000]
    );
    await runQuery(
      `INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?);`,
      [jackpotId, spinId, spinDetails[0].userId, 500]
    );
    await runQuery(
      `UPDATE wheel_spins SET result = 'PENDING', type = 'public' WHERE spinId = ?`,
      [spinId]
    );

    await runQuery("COMMIT");
    const spinData = {
      message: `public spinid ${spinId} from ${username}`,
      spinId: spinId, // Include the spin ID for tracking
      timestamp: new Date(),
    };
    sendEvent("spin", spinId, spinData);
    res.json({
      success: true,
      message: `public spinid ${spinId} from ${username}`,
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
            // Refund logic here
            refundUser(spin.userId, spin.spinId);
          }
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
            // Refund logic here
            refundUser(spin.userId, spin.spinId);
          }
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
            [jackpotId, spinId, userId, -100],
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
app.post("/api/g/wheel/spin/result", (req, res) => {
  const { spinId, result } = req.body;
  const transactionType = "Reward: Public Spin";
  const transactionId = uuidv4();
  // Update the wheel spin table with the result.
  db.run("UPDATE wheel_spins SET result = ? WHERE spinId = ?", [
    result,
    spinId,
  ]);

  let userId = 0;

  db.serialize(() => {
    // Find the UserId associated with the Spin.
    db.get(
      `SELECT userId FROM wheel_spins WHERE spinId = ?;`,
      [spinId],
      (err, row) => {
        if (err) {
          console.error("Error executing SQL: " + err.message);
        } else {
          if (row) {
            console.log("UserId found:", row.userId);
            userId = row.userId;
            if (result.includes("JACKPOT") === true) {
              // Check if there is a JACKPOT.
              db.get(
                "SELECT SUM(amount) AS total FROM jackpot_rakes",
                (err, row) => {
                  if (err) {
                    return;
                  }
                  let jackpotTotal = row.total; // Return 0 if null
                  // Add jackpot to the user balance.
                  db.run(
                    `UPDATE users SET points_balance = points_balance + ${jackpotTotal} WHERE userId = ?`,
                    [userId]
                  );

                  // Clear the Jackpot.
                  db.run(
                    `INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)`,
                    [uuidv4(), spinId, userId, -jackpotTotal],
                    (err) => {
                      if (err) {
                        return res
                          .status(500)
                          .json({ error: "Failed to create spin record" });
                      }
                    }
                  );

                  // Log the transaction.
                  db.run(
                    "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                    [transactionId, userId, "Jackpot Win", jackpotTotal],
                    async (err) => {
                      if (err) {
                        return res
                          .status(500)
                          .json({ error: "Failed to create spin record" });
                      }
                      xp = jackpotTotal * 0.005;
                      const levelUpInfo = await updateLevel(userId, xp);
                      sendEvent("results", spinId, { result: jackpotTotal, xp: xp, levelUp: levelUpInfo });
                      res.status(200).json({
                        transactionId: transactionId,
                        result: jackpotTotal,
                        levelUp: levelUpInfo
                      });
                    }
                  );
                }
              );
            } else {
              // Add points to the user balance.
              db.run(
                `UPDATE users SET points_balance = points_balance + ${result} WHERE userId = ?`,
                [userId]
              );

              // Log the transaction.
              db.run(
                "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                [transactionId, userId, transactionType, result],
                async (err) => {
                  if (err) {
                    return res
                      .status(500)
                      .json({ error: "Failed to create spin record" });
                  }
                  console.log(transactionId);
                  // Send a message to connected clients to spin the wheel.
                  console.log("sending spin data to clients" + spinId + result);
                  xp = result * 0.005;
                  const levelUpInfo = await updateLevel(userId, xp);
                  sendEvent("results", spinId, { result: result, xp: xp, levelUp: levelUpInfo });
                  res
                    .status(200)
                    .json({ transactionId: transactionId, result: result, levelUp: levelUpInfo });
                }
              );
            }
          } else {
            console.log("No matching record found for the given spinId");
            return res
              .status(500)
              .json({ error: "Failed to create spin record" });
          }
        }
      }
    );
  });
});

// HTTP POST endpoint to handle adding XP
app.post('/api/update-level', async (req, res) => {
  const { userId, additionalXp, password } = req.body;
  const xp = parseInt(additionalXp);
  // Authentication check
  if (password !== process.env.TWITCH_BOT_TOKEN) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  // Input validation
  if (!userId || isNaN(additionalXp)) {
    return res.status(400).json({ success: false, message: 'Invalid inputs' });
  }

  try {
    // Call the updateLevel function
    await updateLevel(userId, xp);

    // Respond with success
    return res.json({ success: true, message: `User ${userId} level and XP updated.` });
  } catch (error) {
    console.error('Failed to update level:', error);
    return res.status(500).json({ success: false, message: 'Failed to update level' });
  }
});

// HTTP POST endpoint to handle adding XP
app.post('/api/admin/update-level', authenticateToken, addUser, async (req, res) => {
  const { username, additionalXp } = req.body;
  const userType = req.user ? req.user.class : null;
  const xp = parseInt(additionalXp);
  if (userType === "Admin" || userType === "Staff") {
    // Input validation
    // if (!username || typeof additionalXp !== 'number' || isNaN(additionalXp)) {
    //   return res.status(400).json({ success: false, message: 'Invalid inputs' });
    // }
      try {
        // Update user's balance
    // Call the updateLevel function
    const user = await getQuery(
      `SELECT userId FROM users WHERE username = ?`,
      [username]
    );
    await updateLevel(user[0].userId, xp);
        res.json({ message: "Xp added successfully." });
      } catch (error) {
        console.error(error);
        res.status(500).send("Failed to add xp.");
      }
  } else {
    req.flash(
      "error",
      "Access denied. You must be an admin or staff to access this page."
    );
    return res.redirect("/login");
  }

});

// HTTP POST endpoint to handle bonus winner
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

// HTTP POST endpoint to record the result of a wheel spin.
app.post(
  "/api/u/:username/wheel/spin/result",
  authenticateToken,
  (req, res) => {
    const { spinId, result } = req.body;
    const transactionType = "Reward: Gold Spin";
    const transactionId = uuidv4();
    // Update the wheel spin table with the result.
    db.run("UPDATE wheel_spins SET result = ? WHERE spinId = ?", [
      result,
      spinId,
    ]);

    let userId = 0;

    db.serialize(() => {
      // Find the UserId associated with the Spin.
      db.get(
        `SELECT userId FROM wheel_spins WHERE spinId = ?;`,
        [spinId],
        (err, row) => {
          if (err) {
            console.error("Error executing SQL: " + err.message);
          } else {
            if (row) {
              console.log("UserId found:", row.userId);
              userId = row.userId;
              if (result.includes("JACKPOT") === true) {
                // Check if there is a JACKPOT.
                db.get(
                  "SELECT SUM(amount) AS total FROM jackpot_rakes",
                  (err, row) => {
                    if (err) {
                      return;
                    }
                    let jackpotTotal = row.total; // Return 0 if null
                    // Add jackpot to the user balance.
                    db.run(
                      `UPDATE users SET points_balance = points_balance + ${jackpotTotal} WHERE userId = ?`,
                      [userId]
                    );

                    // Clear the Jackpot.
                    db.run(
                      `INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)`,
                      [uuidv4(), spinId, userId, -jackpotTotal],
                      (err) => {
                        if (err) {
                          return res
                            .status(500)
                            .json({ error: "Failed to create spin record" });
                        }
                      }
                    );

                    // Log the transaction.
                    db.run(
                      "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                      [transactionId, userId, "Jackpot Win", jackpotTotal],
                      async (err) => {
                        if (err) {
                          return res
                            .status(500)
                            .json({ error: "Failed to create spin record" });
                        }
                        const xp = jackpotTotal*0.005;
                        const levelUpInfo = await updateLevel(userId, xp);
                        res.status(200).json({
                          transactionId: transactionId,
                          result: jackpotTotal,
                          xp: xp,
                          levelUp: levelUpInfo
                        });
                      }
                    );
                  }
                );
              } else {
                // Add points to the user balance.
                db.run(
                  `UPDATE users SET points_balance = points_balance + ${result} WHERE userId = ?`,
                  [userId]
                );

                // Log the transaction.
                db.run(
                  "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                  [transactionId, userId, transactionType, result],
                  async (err) => {
                    if (err) {
                      return res
                        .status(500)
                        .json({ error: "Failed to create spin record" });
                    }
                    xp = result * 0.005;
                    const levelUpInfo = await updateLevel(userId, xp);
                    res
                      .status(200)
                      .json({ transactionId: transactionId, result: result, xp: xp, levelUp: levelUpInfo });
                  }
                );
              }
            } else {
              console.log("No matching record found for the given spinId");
              return res
                .status(500)
                .json({ error: "Failed to create spin record" });
            }
          }
        }
      );
    });
  }
);

// POST endpoint for buying or cashing out poker chips
app.post('/api/poker/cashier', async (req, res) => {
    const { userId, amount, action } = req.body;
  
    if (amount <= 0) {
      return res.status(400).send('Amount must be greater than 0.');
    }
  
    try {
      await runQuery('BEGIN TRANSACTION');
  
      // Get user's current points balance
      const userResult = await getQuery('SELECT points_balance FROM users WHERE userId = ?', [userId]);
      if (!userResult.length) {
        throw new Error('User not found');
      }
      const userBalance = userResult[0].points_balance;
  
      if (action === 'buyin') {
        // Check if user has enough points
        if (userBalance < amount) {
          throw new Error('Insufficient balance');
        }
  
        // Subtract points from user's balance
        await runQuery('UPDATE users SET points_balance = points_balance - ? WHERE userId = ?', [amount, userId]);
  
      } else if (action === 'cashout') {
        // Add points to user's balance
        await runQuery('UPDATE users SET points_balance = points_balance + ? WHERE userId = ?', [amount, userId]);
      } else {
        throw new Error('Invalid action');
      }
  
      // Log transaction
      const transactionId = uuidv4();
      const transactionType = action === 'buyin' ? 'Poker Buy-in' : 'Poker Cashout';
      await runQuery('INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)', 
                     [transactionId, userId, transactionType, action === 'buyin' ? -amount : amount]);
  
      // Create poker_cashier entry
      const cashierId = uuidv4();
      await runQuery('INSERT INTO poker_cashier (cashierId, userId, transactionId, amount, action) VALUES (?, ?, ?, ?, ?)', 
                     [cashierId, userId, transactionId, amount, action]);
  
      await runQuery('COMMIT');
      res.json({ message: `${action} successful`, balance: userBalance - (action === 'buyin' ? amount : -amount) });
  
    } catch (error) {
      await runQuery('ROLLBACK');
      console.error('Transaction failed:', error.message);
      res.status(500).send(error.message);
    }
  });

// Server-Sent Events setup to send commands to the client
app.get("/events", (req, res) => {
  const { type, identifier } = req.query; // 'type' could be 'spin' or 'results'

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.flushHeaders(); // Flush the headers to establish SSE connection

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

app.listen(port, () => {
  console.log(`Server running on port   ${port}`);
});

