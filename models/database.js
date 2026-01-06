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

module.exports = { initDatabase, userOps, settingsOps, dataDir };
