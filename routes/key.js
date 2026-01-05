const express = require('express');
const router = express.Router();
const { userOps } = require('../models/database');
const { verifyToken } = require('../middleware/auth');

/**
 * GET /api/key
 * Securely fetch the user's API key.
 * Requires valid JWT authentication.
 */
router.get('/', verifyToken, (req, res) => {
    try {
        const user = userOps.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (!user.apiKey) {
            return res.status(404).json({ error: 'No API key configured' });
        }

        res.json({ apiKey: user.apiKey });
    } catch (error) {
        console.error('Key fetch error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
