const express = require('express');
const router = express.Router();
const { userOps } = require('../models/database');
const { verifyToken, requireAdmin } = require('../middleware/auth');

// Get all users (admin only)
router.get('/', verifyToken, requireAdmin, (req, res) => {
    try {
        const users = userOps.getAll();
        res.json({ users });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Approve user (admin only)
router.put('/:id/approve', verifyToken, requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const user = userOps.findById(id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        userOps.approve(id);
        res.json({ message: 'User approved successfully' });
    } catch (error) {
        console.error('Approve user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Deny user access (admin only)
router.put('/:id/deny', verifyToken, requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const user = userOps.findById(id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        userOps.deny(id);
        res.json({ message: 'User access denied' });
    } catch (error) {
        console.error('Deny user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Make user an admin (admin only)
router.put('/:id/make-admin', verifyToken, requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const user = userOps.findById(id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        userOps.makeAdmin(id);
        // Also approve if not already approved
        userOps.approve(id);
        res.json({ message: 'User promoted to admin' });
    } catch (error) {
        console.error('Make admin error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Remove admin role (admin only)
router.put('/:id/remove-admin', verifyToken, requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const user = userOps.findById(id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Prevent removing own admin status
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot remove your own admin status' });
        }

        userOps.removeAdmin(id);
        res.json({ message: 'Admin role removed' });
    } catch (error) {
        console.error('Remove admin error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete user (admin only)
router.delete('/:id', verifyToken, requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const user = userOps.findById(id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Prevent deleting yourself
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        userOps.delete(id);
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
