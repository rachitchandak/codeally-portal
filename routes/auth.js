const express = require('express');
const router = express.Router();
const { userOps } = require('../models/database');
const { generateToken, verifyToken } = require('../middleware/auth');

// Sign up - always creates a regular user (no role selection)
router.post('/signup', (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        const user = userOps.create(email, password);

        if (!user) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        res.status(201).json({
            message: 'Account created successfully. Please wait for admin approval.',
            user: { id: user.id, email: user.email, role: user.role }
        });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Sign in
router.post('/signin', (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = userOps.findByEmail(email);

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (!userOps.verifyPassword(user, password)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = generateToken(user.id);

        // Set HTTP-only cookie
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });

        res.json({
            message: 'Signed in successfully',
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
                isApproved: user.isApproved,
                apiKey: user.apiKey
            },
            token
        });
    } catch (error) {
        console.error('Signin error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Sign out
router.post('/signout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Signed out successfully' });
});

// Get current user
router.get('/me', verifyToken, (req, res) => {
    res.json({ user: req.user });
});

module.exports = router;
