const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// Determine data directory - use /home/data in Azure, ./data locally
const isAzure = process.env.WEBSITE_SITE_NAME !== undefined;
const dataDir = isAzure ? '/home/data' : path.join(__dirname, '..', 'data');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'database.sqlite');

let db = null;
let SQL = null;

// Initialize database
async function initDatabase() {
    if (db) return db;

    SQL = await initSqlJs();

    // Load existing database or create new one
    if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    // Create tables
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'user' CHECK(role IN ('user', 'admin')),
            isApproved INTEGER DEFAULT 0,
            apiKey TEXT,
            azureResourceName TEXT,
            azureDeployment TEXT,
            azureApiVersion TEXT,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Migration: Add new columns if they don't exist (for existing databases)
    try {
        db.run(`ALTER TABLE users ADD COLUMN azureResourceName TEXT`);
    } catch (e) { /* column already exists */ }
    try {
        db.run(`ALTER TABLE users ADD COLUMN azureDeployment TEXT`);
    } catch (e) { /* column already exists */ }
    try {
        db.run(`ALTER TABLE users ADD COLUMN azureApiVersion TEXT`);
    } catch (e) { /* column already exists */ }

    db.run(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `);

    // LLM Logging tables
    db.run(`
        CREATE TABLE IF NOT EXISTS llm_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            threadId TEXT UNIQUE NOT NULL,
            assistantId TEXT NOT NULL,
            userId INTEGER NOT NULL,
            userEmail TEXT NOT NULL,
            startedAt TEXT DEFAULT CURRENT_TIMESTAMP,
            lastActivityAt TEXT,
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'error')),
            errorMessage TEXT,
            totalRequests INTEGER DEFAULT 0,
            totalInputTokens INTEGER DEFAULT 0,
            totalOutputTokens INTEGER DEFAULT 0,
            FOREIGN KEY (userId) REFERENCES users(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS llm_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sessionId INTEGER NOT NULL,
            requestType TEXT NOT NULL CHECK(requestType IN ('chat', 'tool_output')),
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
            inputTokens INTEGER DEFAULT 0,
            outputTokens INTEGER DEFAULT 0,
            toolCallCount INTEGER DEFAULT 0,
            status TEXT DEFAULT 'success' CHECK(status IN ('success', 'error')),
            errorMessage TEXT,
            FOREIGN KEY (sessionId) REFERENCES llm_sessions(id)
        )
    `);

    // Create default admin account if it doesn't exist
    const defaultAdminEmail = 'admin@codeally.com';
    const defaultAdminPassword = 'Admin@123';

    const existingAdmin = db.exec(`SELECT id FROM users WHERE email = '${defaultAdminEmail}'`);
    if (existingAdmin.length === 0) {
        const hashedPassword = bcrypt.hashSync(defaultAdminPassword, 10);
        db.run(`
            INSERT INTO users (email, password, role, isApproved) 
            VALUES ('${defaultAdminEmail}', '${hashedPassword}', 'admin', 1)
        `);
        console.log('Default admin account created: admin@codeally.com / Admin@123');
    }

    // Save database
    saveDatabase();

    return db;
}

// Save database to file
function saveDatabase() {
    if (!db) return;
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
}

// User operations
const userOps = {
    findByEmail: (email) => {
        const result = db.exec(`SELECT * FROM users WHERE email = ?`, [email]);
        if (result.length === 0 || result[0].values.length === 0) return null;
        const columns = result[0].columns;
        const values = result[0].values[0];
        return columns.reduce((obj, col, i) => ({ ...obj, [col]: values[i] }), {});
    },

    findById: (id) => {
        const result = db.exec(`SELECT id, email, role, isApproved, apiKey, azureResourceName, azureDeployment, azureApiVersion, createdAt FROM users WHERE id = ?`, [parseInt(id)]);
        if (result.length === 0 || result[0].values.length === 0) return null;
        const columns = result[0].columns;
        const values = result[0].values[0];
        return columns.reduce((obj, col, i) => ({ ...obj, [col]: values[i] }), {});
    },

    create: (email, password) => {
        const hashedPassword = bcrypt.hashSync(password, 10);
        try {
            db.run(`
                INSERT INTO users (email, password, role, isApproved) 
                VALUES (?, ?, 'user', 0)
            `, [email, hashedPassword]);
            saveDatabase();

            const result = db.exec(`SELECT last_insert_rowid() as id`);
            const id = result[0].values[0][0];
            return { id, email, role: 'user', isApproved: 0 };
        } catch (error) {
            if (error.message.includes('UNIQUE constraint failed')) {
                return null; // Email already exists
            }
            throw error;
        }
    },

    getAll: () => {
        const result = db.exec(`SELECT id, email, role, isApproved, createdAt FROM users ORDER BY createdAt DESC`);
        if (result.length === 0) return [];
        const columns = result[0].columns;
        return result[0].values.map(row =>
            columns.reduce((obj, col, i) => ({ ...obj, [col]: row[i] }), {})
        );
    },

    approve: (id) => {
        db.run(`UPDATE users SET isApproved = 1 WHERE id = ?`, [parseInt(id)]);
        saveDatabase();
        return { changes: 1 };
    },

    deny: (id) => {
        db.run(`UPDATE users SET isApproved = 0 WHERE id = ?`, [parseInt(id)]);
        saveDatabase();
        return { changes: 1 };
    },

    makeAdmin: (id) => {
        db.run(`UPDATE users SET role = 'admin' WHERE id = ?`, [parseInt(id)]);
        saveDatabase();
        return { changes: 1 };
    },

    removeAdmin: (id) => {
        db.run(`UPDATE users SET role = 'user' WHERE id = ?`, [parseInt(id)]);
        saveDatabase();
        return { changes: 1 };
    },

    setAzureConfig: (id, config) => {
        db.run(`UPDATE users SET apiKey = ?, azureResourceName = ?, azureDeployment = ?, azureApiVersion = ? WHERE id = ?`,
            [config.apiKey, config.resourceName, config.deploymentName, config.apiVersion, parseInt(id)]);
        saveDatabase();
        return { changes: 1 };
    },

    delete: (id) => {
        db.run(`DELETE FROM users WHERE id = ?`, [parseInt(id)]);
        saveDatabase();
        return { changes: 1 };
    },

    verifyPassword: (user, password) => {
        return bcrypt.compareSync(password, user.password);
    }
};

// Settings operations
const settingsOps = {
    get: (key) => {
        const result = db.exec(`SELECT value FROM settings WHERE key = ?`, [key]);
        if (result.length === 0 || result[0].values.length === 0) return null;
        return result[0].values[0][0];
    },

    set: (key, value) => {
        db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
        saveDatabase();
        return { changes: 1 };
    }
};

// LLM Logging operations
const llmLogOps = {
    createSession: (threadId, assistantId, userId, userEmail) => {
        try {
            db.run(`
                INSERT INTO llm_sessions (threadId, assistantId, userId, userEmail, startedAt, lastActivityAt)
                VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
            `, [threadId, assistantId, parseInt(userId), userEmail]);
            saveDatabase();

            const result = db.exec(`SELECT last_insert_rowid() as id`);
            return result[0].values[0][0];
        } catch (error) {
            console.error('Error creating LLM session:', error);
            throw error;
        }
    },

    getSessionByThreadId: (threadId) => {
        const result = db.exec(`SELECT * FROM llm_sessions WHERE threadId = ?`, [threadId]);
        if (result.length === 0 || result[0].values.length === 0) return null;
        const columns = result[0].columns;
        const values = result[0].values[0];
        return columns.reduce((obj, col, i) => ({ ...obj, [col]: values[i] }), {});
    },

    logRequest: (threadId, requestType, toolCallCount = 0, inputTokens = 0, outputTokens = 0, status = 'success', errorMessage = null) => {
        try {
            const session = llmLogOps.getSessionByThreadId(threadId);
            if (!session) {
                console.error('Session not found for threadId:', threadId);
                return null;
            }

            db.run(`
                INSERT INTO llm_requests (sessionId, requestType, timestamp, inputTokens, outputTokens, toolCallCount, status, errorMessage)
                VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?)
            `, [session.id, requestType, inputTokens, outputTokens, toolCallCount, status, errorMessage]);

            // Update session totals
            db.run(`
                UPDATE llm_sessions 
                SET lastActivityAt = datetime('now'),
                    totalRequests = totalRequests + 1,
                    totalInputTokens = totalInputTokens + ?,
                    totalOutputTokens = totalOutputTokens + ?
                WHERE id = ?
            `, [inputTokens, outputTokens, session.id]);

            saveDatabase();

            const result = db.exec(`SELECT last_insert_rowid() as id`);
            return result[0].values[0][0];
        } catch (error) {
            console.error('Error logging LLM request:', error);
            throw error;
        }
    },

    updateSessionStatus: (threadId, status, errorMessage = null) => {
        try {
            db.run(`
                UPDATE llm_sessions 
                SET status = ?, errorMessage = ?, lastActivityAt = datetime('now')
                WHERE threadId = ?
            `, [status, errorMessage, threadId]);
            saveDatabase();
        } catch (error) {
            console.error('Error updating session status:', error);
        }
    },

    getSessions: (page = 1, limit = 50, userId = null) => {
        const offset = (page - 1) * limit;
        let query = `SELECT * FROM llm_sessions`;
        let params = [];

        if (userId) {
            query += ` WHERE userId = ?`;
            params.push(parseInt(userId));
        }

        query += ` ORDER BY startedAt DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const result = db.exec(query, params);
        if (result.length === 0) return [];
        const columns = result[0].columns;
        return result[0].values.map(row =>
            columns.reduce((obj, col, i) => ({ ...obj, [col]: row[i] }), {})
        );
    },

    getSessionDetails: (sessionId) => {
        const sessionResult = db.exec(`SELECT * FROM llm_sessions WHERE id = ?`, [parseInt(sessionId)]);
        if (sessionResult.length === 0 || sessionResult[0].values.length === 0) return null;

        const sessionColumns = sessionResult[0].columns;
        const session = sessionColumns.reduce((obj, col, i) => ({ ...obj, [col]: sessionResult[0].values[0][i] }), {});

        const requestsResult = db.exec(`SELECT * FROM llm_requests WHERE sessionId = ? ORDER BY timestamp ASC`, [parseInt(sessionId)]);
        let requests = [];
        if (requestsResult.length > 0) {
            const requestColumns = requestsResult[0].columns;
            requests = requestsResult[0].values.map(row =>
                requestColumns.reduce((obj, col, i) => ({ ...obj, [col]: row[i] }), {})
            );
        }

        return { session, requests };
    },

    getStats: (startDate = null, endDate = null) => {
        let dateFilter = '';
        let params = [];

        if (startDate && endDate) {
            dateFilter = ` WHERE startedAt >= ? AND startedAt <= ?`;
            params = [startDate, endDate];
        }

        const totalSessionsResult = db.exec(`SELECT COUNT(*) as count FROM llm_sessions${dateFilter}`, params);
        const totalSessions = totalSessionsResult[0]?.values[0]?.[0] || 0;

        const totalTokensResult = db.exec(`SELECT COALESCE(SUM(totalInputTokens), 0) as input, COALESCE(SUM(totalOutputTokens), 0) as output FROM llm_sessions${dateFilter}`, params);
        const totalInputTokens = totalTokensResult[0]?.values[0]?.[0] || 0;
        const totalOutputTokens = totalTokensResult[0]?.values[0]?.[1] || 0;

        const totalRequestsResult = db.exec(`SELECT COUNT(*) as count FROM llm_requests r JOIN llm_sessions s ON r.sessionId = s.id${dateFilter.replace('startedAt', 's.startedAt')}`, params);
        const totalRequests = totalRequestsResult[0]?.values[0]?.[0] || 0;

        const errorSessionsResult = db.exec(`SELECT COUNT(*) as count FROM llm_sessions WHERE status = 'error'${dateFilter ? ' AND' + dateFilter.replace('WHERE', '') : ''}`, params);
        const errorSessions = errorSessionsResult[0]?.values[0]?.[0] || 0;

        // Get per-user stats
        const userStatsResult = db.exec(`
            SELECT userId, userEmail, COUNT(*) as sessions, 
                   COALESCE(SUM(totalInputTokens), 0) as inputTokens, 
                   COALESCE(SUM(totalOutputTokens), 0) as outputTokens
            FROM llm_sessions${dateFilter}
            GROUP BY userId, userEmail
            ORDER BY sessions DESC
        `, params);

        let userStats = [];
        if (userStatsResult.length > 0) {
            const columns = userStatsResult[0].columns;
            userStats = userStatsResult[0].values.map(row =>
                columns.reduce((obj, col, i) => ({ ...obj, [col]: row[i] }), {})
            );
        }

        return {
            totalSessions,
            totalRequests,
            totalInputTokens,
            totalOutputTokens,
            errorSessions,
            userStats
        };
    },

    getTotalSessionCount: (userId = null) => {
        let query = `SELECT COUNT(*) as count FROM llm_sessions`;
        let params = [];
        if (userId) {
            query += ` WHERE userId = ?`;
            params.push(parseInt(userId));
        }
        const result = db.exec(query, params);
        return result[0]?.values[0]?.[0] || 0;
    }
};

module.exports = { initDatabase, userOps, settingsOps, llmLogOps, dataDir };
