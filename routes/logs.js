const express = require('express');
const router = express.Router();
const { llmLogOps, userOps } = require('../models/database');
const { verifyToken, requireAdmin } = require('../middleware/auth');

/**
 * GET /api/logs/sessions
 * List all LLM sessions with pagination and optional filtering
 */
router.get('/sessions', verifyToken, requireAdmin, (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const userId = req.query.userId || null;

        const sessions = llmLogOps.getSessions(page, limit, userId);
        const total = llmLogOps.getTotalSessionCount(userId);

        res.json({
            sessions,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get sessions error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/logs/sessions/:id
 * Get detailed session info including all requests
 */
router.get('/sessions/:id', verifyToken, requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const details = llmLogOps.getSessionDetails(id);

        if (!details) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json(details);
    } catch (error) {
        console.error('Get session details error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/logs/stats
 * Get aggregated usage statistics
 */
router.get('/stats', verifyToken, requireAdmin, (req, res) => {
    try {
        const startDate = req.query.startDate || null;
        const endDate = req.query.endDate || null;

        const stats = llmLogOps.getStats(startDate, endDate);

        res.json(stats);
    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/logs/users
 * Get list of users for filter dropdown
 */
router.get('/users', verifyToken, requireAdmin, (req, res) => {
    try {
        const users = userOps.getAll();
        res.json({ users: users.map(u => ({ id: u.id, email: u.email })) });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
