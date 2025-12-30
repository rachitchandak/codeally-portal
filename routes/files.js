const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { settingsOps, dataDir } = require('../models/database');
const { verifyToken, requireAdmin, requireApproved } = require('../middleware/auth');

// Configure upload directory
const uploadsDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        // Keep original filename with timestamp prefix
        const timestamp = Date.now();
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `${timestamp}-${safeName}`);
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        // Only allow .vsix files
        if (path.extname(file.originalname).toLowerCase() === '.vsix') {
            cb(null, true);
        } else {
            cb(new Error('Only .vsix files are allowed'));
        }
    },
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    }
});

// Upload VSIX file (admin only)
router.post('/upload', verifyToken, requireAdmin, upload.single('vsix'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Delete old VSIX file if exists
        const oldFile = settingsOps.get('currentVsix');
        if (oldFile) {
            const oldPath = path.join(uploadsDir, oldFile);
            if (fs.existsSync(oldPath)) {
                fs.unlinkSync(oldPath);
            }
        }

        // Save current VSIX filename
        settingsOps.set('currentVsix', req.file.filename);
        settingsOps.set('vsixOriginalName', req.file.originalname);
        settingsOps.set('vsixUploadedAt', new Date().toISOString());

        res.json({
            message: 'VSIX uploaded successfully',
            file: {
                filename: req.file.filename,
                originalName: req.file.originalname,
                size: req.file.size
            }
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Get VSIX file info
router.get('/info', verifyToken, (req, res) => {
    try {
        const filename = settingsOps.get('currentVsix');
        const originalName = settingsOps.get('vsixOriginalName');
        const uploadedAt = settingsOps.get('vsixUploadedAt');

        if (!filename) {
            return res.json({ available: false });
        }

        const filePath = path.join(uploadsDir, filename);
        if (!fs.existsSync(filePath)) {
            return res.json({ available: false });
        }

        const stats = fs.statSync(filePath);
        res.json({
            available: true,
            originalName,
            uploadedAt,
            size: stats.size
        });
    } catch (error) {
        console.error('File info error:', error);
        res.status(500).json({ error: 'Failed to get file info' });
    }
});

// Download VSIX file (approved users only)
router.get('/download', verifyToken, requireApproved, (req, res) => {
    try {
        const filename = settingsOps.get('currentVsix');
        const originalName = settingsOps.get('vsixOriginalName') || 'extension.vsix';

        if (!filename) {
            return res.status(404).json({ error: 'No VSIX file available' });
        }

        const filePath = path.join(uploadsDir, filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'VSIX file not found' });
        }

        res.download(filePath, originalName);
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Download failed' });
    }
});

// Delete current VSIX (admin only)
router.delete('/delete', verifyToken, requireAdmin, (req, res) => {
    try {
        const filename = settingsOps.get('currentVsix');

        if (filename) {
            const filePath = path.join(uploadsDir, filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }

        settingsOps.set('currentVsix', '');
        settingsOps.set('vsixOriginalName', '');
        settingsOps.set('vsixUploadedAt', '');

        res.json({ message: 'VSIX file deleted' });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Delete failed' });
    }
});

module.exports = router;
