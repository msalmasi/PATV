// middleware/authenticateToken.js

const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const { refreshLogin } = require('./loginCookie');
const { getQuery } = require('../dbUtils');

// Middleware to verify token
const authenticateToken = async (req, res, next) => {
    const token = req.cookies.jwt;
    if (token == null) return res.redirect('/login'); // if there's no token

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.SECRET_KEY);
    } catch (err) {
        req.flash('error', "Please login again.");
        return res.redirect('/login');
    }
    // Current name from the DB + sliding renewal (middleware/loginCookie.js).
    try {
        const cur = await refreshLogin(res, decoded, getQuery);
        if (!cur) {
            req.flash('error', "Please login again.");
            return res.redirect('/login');
        }
        decoded = cur;
    } catch (err) {
        console.error("login refresh failed:", err.message);   // DB hiccup: trust the token
    }
    req.userId = decoded.userId;
    req.username = decoded.username;
    next();
}

module.exports = authenticateToken;