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

const MB = 1024 * 1024;

const DOCUMENT_EXTS = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

/**
 * Per-folder upload rules. `exts: null` means "accept any extension" — used for
 * chat attachments, where restricting the type would break existing messaging.
 * A size cap always applies, even where the type is unrestricted.
 */
const FOLDER_RULES = {
  modules: { exts: DOCUMENT_EXTS, maxBytes: 25 * MB },
  resources: { exts: DOCUMENT_EXTS, maxBytes: 25 * MB },
  'ai-modules': { exts: DOCUMENT_EXTS, maxBytes: 25 * MB },
  handouts: { exts: DOCUMENT_EXTS, maxBytes: 25 * MB },
  profiles: { exts: IMAGE_EXTS, maxBytes: 5 * MB },
  messages: { exts: null, maxBytes: 15 * MB }
};

const DEFAULT_RULE = { exts: [...DOCUMENT_EXTS, ...IMAGE_EXTS], maxBytes: 15 * MB };

// Function: createUploader

// Role: Provides helper logic for this file.

/**
 * @param {string} relativeFolder folder under public/uploads
 * @param {{exts?: string[]|null, maxBytes?: number}} [overrides] per-call rule override
 */
function createUploader(relativeFolder, overrides = {}) {
  const root = path.join(__dirname, '..', 'public', 'uploads', relativeFolder);
  ensureDir(root);

  const rule = { ...(FOLDER_RULES[relativeFolder] || DEFAULT_RULE), ...overrides };

  const storage = multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, root);
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || '');
      cb(null, `${Date.now()}-${uuidv4()}${ext}`);
    }
  });

  return multer({
    storage,
    limits: { fileSize: rule.maxBytes },
    // Reject unwanted types BEFORE anything is written to disk, so a bad upload
    // does not leave an orphan file behind. Rejection is reported via
    // req.uploadRejections rather than an error, so routes keep their existing
    // "no file was received" handling instead of hitting the 500 page.
    fileFilter(req, file, cb) {
      if (!rule.exts) return cb(null, true);
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (rule.exts.includes(ext)) return cb(null, true);
      req.uploadRejections = req.uploadRejections || [];
      req.uploadRejections.push({
        field: file.fieldname,
        originalName: file.originalname || '',
        reason: 'type',
        allowed: rule.exts
      });
      return cb(null, false);
    }
  });
}

/**
 * Human-readable message for a rejected upload, for use in a flash.
 * Returns null when nothing was rejected.
 */
function describeUploadRejection(req) {
  const rejection = (req.uploadRejections || [])[0];
  if (!rejection) return null;
  return `"${rejection.originalName}" was not accepted. Allowed file types: ${rejection.allowed
    .map((e) => e.replace('.', '').toUpperCase())
    .join(', ')}.`;
}

module.exports = { createUploader, describeUploadRejection, DOCUMENT_EXTS, IMAGE_EXTS };
