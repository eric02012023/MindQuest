/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: lib/uploads.js
 * Purpose: Multer upload helper. This file ensures upload folders exist and returns configured upload middleware.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

// Function: ensureDir

// Role: Provides helper logic for this file.

function ensureDir(target) {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
}

// Function: createUploader

// Role: Provides helper logic for this file.

function createUploader(relativeFolder) {
  const root = path.join(__dirname, '..', 'public', 'uploads', relativeFolder);
  ensureDir(root);
  const storage = multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, root);
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || '');
      cb(null, `${Date.now()}-${uuidv4()}${ext}`);
    }
  });
  return multer({ storage });
}

module.exports = { createUploader };
