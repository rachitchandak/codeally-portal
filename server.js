require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { initDatabase } = require('./models/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Page routes - serve HTML files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// VS Code extension login - dedicated route for OAuth-style flow
app.get('/vscode-login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'vscode-login.html'));
});

// Initialize database and start server
async function startServer() {
    try {
        // Initialize database first
        await initDatabase();
        console.log('Database initialized');

        // Load routes after database is ready
        const authRoutes = require('./routes/auth');
        const userRoutes = require('./routes/users');
        const fileRoutes = require('./routes/files');
        const keyRoutes = require('./routes/key');

        // API Routes
        app.use('/api/auth', authRoutes);
        app.use('/api/users', userRoutes);
        app.use('/api/files', fileRoutes);
        app.use('/api/key', keyRoutes);

        // 404 handler
        app.use((req, res) => {
            res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        // Error handler
        app.use((err, req, res, next) => {
            console.error('Server error:', err);
            res.status(500).json({ error: 'Internal server error' });
        });

        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
            console.log(`Default admin: admin@codeally.com / Admin@123`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
