const jwt = require('jsonwebtoken');
const { userOps } = require('../models/database');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key';

// Verify JWT token from cookie or Authorization header
const verifyToken = (req, res, next) => {
    const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = userOps.findById(decoded.userId);

        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        req.user = user;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// Require admin role
const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

// Require approved status
const requireApproved = (req, res, next) => {
    if (!req.user.isApproved) {
        return res.status(403).json({ error: 'Account not approved' });
    }
    next();
};

// Generate JWT token
const generateToken = (userId) => {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
};

module.exports = { verifyToken, requireAdmin, requireApproved, generateToken };
