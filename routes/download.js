const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { setFlash } = require('../lib/utils');

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

    // Protect against directory traversal
    const normalizedUrl = path.normalize(fileUrlPath).replace(/^(\.\.[\/\\])+/, '');
    
    // Only allow downloads from /uploads directory
    if (!normalizedUrl.startsWith('\\uploads\\') && !normalizedUrl.startsWith('/uploads/')) {
       setFlash(req, 'error', 'Invalid file path.');
       return res.redirect('back');
    }

    const absolutePath = path.join(__dirname, '..', 'public', normalizedUrl);

    if (!fs.existsSync(absolutePath)) {
      setFlash(req, 'error', 'File not found or has been removed from the server.');
      return res.redirect('back');
    }

    res.download(absolutePath);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
