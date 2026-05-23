const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { setFlash } = require('../middleware/auth');

// Require authentication for all downloads
router.use((req, res, next) => {
  if (!req.session.user) {
    return res.status(401).send('Unauthorized. Please log in.');
  }
  next();
});

router.get('/', (req, res, next) => {
  try {
    const fileUrlPath = req.query.path;
    if (!fileUrlPath) {
      setFlash(req, 'error', 'No file specified.');
      return res.redirect('back');
    }

    // Decode the path first (it was encodeURIComponent'd in the template)
    const decoded = decodeURIComponent(fileUrlPath);

    // Protect against directory traversal
    const cleaned = decoded.replace(/\.\./g, '').replace(/\\/g, '/');

    // Only allow downloads from /uploads directory
    if (!cleaned.startsWith('/uploads/')) {
      setFlash(req, 'error', 'Invalid file path.');
      return res.redirect('back');
    }

    const absolutePath = path.join(__dirname, '..', 'public', cleaned);

    if (!fs.existsSync(absolutePath)) {
      setFlash(req, 'error', 'File not found or has been removed from the server.');
      return res.redirect('back');
    }

    // For AI-generated HTML modules, serve inline instead of download
    const ext = path.extname(absolutePath).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      return res.sendFile(absolutePath);
    }

    // For images, serve inline
    if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) {
      return res.sendFile(absolutePath);
    }

    // For PDFs, serve inline in browser
    if (ext === '.pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="' + path.basename(absolutePath) + '"');
      return res.sendFile(absolutePath);
    }

    // Everything else: download
    res.download(absolutePath);
  } catch (err) {
    console.error('[Download Route Error]', err);
    try {
      setFlash(req, 'error', 'An error occurred while accessing the file.');
      res.redirect('back');
    } catch (redirectErr) {
      res.status(500).send('File access error. Please go back and try again.');
    }
  }
});

module.exports = router;
