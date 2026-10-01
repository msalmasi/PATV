// The login cookie: one place that issues, renews and clears it.
//
// Logins used to die fast: Twitch/Discord sign-ins got a 1-hour token, password sign-ins 7 days,
// and none of the cookies had an expiry date, so the browser dropped them whenever it closed
// (phones close browsers constantly). Now every login is a LOGIN_DAYS token in a cookie that
// lives as long, and it SLIDES: once a token is over RENEW_AFTER old, the next visit swaps it
// for a fresh one. Anyone who comes back within LOGIN_DAYS stays signed in indefinitely; a
// device nobody uses for LOGIN_DAYS signs itself out.
const jwt = require("jsonwebtoken");

const LOGIN_DAYS = 90;
const RENEW_AFTER = 24 * 3600; // seconds - renew at most once a day per browser

function cookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: LOGIN_DAYS * 24 * 3600 * 1000,
  };
}

// Sign a user in: user needs userId, username, class.
function issueLogin(res, user) {
  const token = jwt.sign(
    { userId: user.userId, username: user.username, class: user.class },
    process.env.SECRET_KEY,
    { expiresIn: `${LOGIN_DAYS}d` }
  );
  res.cookie("jwt", token, cookieOptions());
  return token;
}

// Call with the DECODED token of a request that's already verified. Renews it once less than
// LOGIN_DAYS minus RENEW_AFTER is left: a fresh token after a day of use, and the old 1-hour /
// 7-day tokens straight away on their next use (by time LEFT, not age - a half-hour-old 1h token
// is young, but about to die).
function renewLogin(res, decoded) {
  if (!decoded || !decoded.userId || !decoded.exp) return;
  const left = decoded.exp - Math.floor(Date.now() / 1000);
  if (left < LOGIN_DAYS * 24 * 3600 - RENEW_AFTER) {
    try {
      issueLogin(res, decoded);
    } catch (e) {
      console.error("login renewal failed:", e.message);
    }
  }
}

function clearLogin(res) {
  // Same path as when it was set (the default "/"), or the browser keeps it.
  res.clearCookie("jwt", { httpOnly: true, secure: true, sameSite: "Lax" });
}

module.exports = { issueLogin, renewLogin, clearLogin, LOGIN_DAYS };
