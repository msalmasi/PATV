// middleware/authenticateToken.js

const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');

// Middleware to verify token
const authenticateToken = (req, res, next) => {
    const token = req.cookies.jwt;
    if (token == null) return res.redirect('/login'); // if there's no token

    try {
        const decoded = jwt.verify(token, process.env.SECRET_KEY);
        req.userId = decoded.userId;
        req.username = decoded.username;
        next();
      } catch (err) {
        return res.status(401).json({ message: 'Invalid token.' });
      }
}

module.exports = authenticateToken;