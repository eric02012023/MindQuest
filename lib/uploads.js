/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: lib/uploads.js
 * Purpose: Multer upload helper. This file ensures upload folders exist and returns configured upload middleware.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { putFile } = require('./storage');

// Function: createUploader

// Role: Provides helper logic for this file.

const MB = 1024 * 1024;

const DOCUMENT_EXTS = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

/**
 * Extensions a browser will execute in the page's own origin.
 *
 * Chat attachments are served from this app's own domain, so an uploaded .html
 * or .svg does not just sit there — opening it runs its script as if the app had
 * written it, with the viewer's session attached. That is stored XSS, and the
 * attacker only needs to be able to send a message.
 *
 * These are blocked rather than the whole allow-list being narrowed, so students
 * and tutors can still attach whatever ordinary file they need to.
 */
const EXECUTABLE_IN_BROWSER = [
  '.html', '.htm', '.xhtml', '.shtml', '.mhtml', '.mht',
  '.svg', '.svgz', '.xml', '.xsl', '.xslt',
  '.js', '.mjs', '.jsm', '.swf', '.hta'
];

/**
 * Per-folder upload rules. `exts: null` means "accept any extension" — used for
 * chat attachments, where restricting the type would break existing messaging.
 * `blocked` narrows that back down to what is safe to serve. A size cap always
 * applies, even where the type is otherwise unrestricted.
 */
const FOLDER_RULES = {
  modules: { exts: DOCUMENT_EXTS, maxBytes: 25 * MB },
  resources: { exts: DOCUMENT_EXTS, maxBytes: 25 * MB },
  'ai-modules': { exts: DOCUMENT_EXTS, maxBytes: 25 * MB },
  handouts: { exts: DOCUMENT_EXTS, maxBytes: 25 * MB },
  profiles: { exts: IMAGE_EXTS, maxBytes: 5 * MB },
  messages: { exts: null, blocked: EXECUTABLE_IN_BROWSER, maxBytes: 15 * MB }
};

const DEFAULT_RULE = { exts: [...DOCUMENT_EXTS, ...IMAGE_EXTS], maxBytes: 15 * MB };

// Function: createUploader

// Role: Provides helper logic for this file.

/**
 * @param {string} relativeFolder folder under public/uploads
 * @param {{exts?: string[]|null, maxBytes?: number}} [overrides] per-call rule override
 */
function createUploader(relativeFolder, overrides = {}) {
  const rule = { ...(FOLDER_RULES[relativeFolder] || DEFAULT_RULE), ...overrides };

  // Files are held in memory, then handed to lib/storage.js — which decides
  // whether they land on this container's disk or in Supabase. Memory rather than
  // disk because a remote backend has nothing to stream from a temp file, and the
  // per-folder size caps below (25 MB at most) bound what is held at once.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: rule.maxBytes },
    // Reject unwanted types BEFORE anything is written to disk, so a bad upload
    // does not leave an orphan file behind. Rejection is reported via
    // req.uploadRejections rather than an error, so routes keep their existing
    // "no file was received" handling instead of hitting the 500 page.
    fileFilter(req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase();

      // A blocked extension loses even where the folder otherwise accepts
      // anything — this is the stored-XSS guard, not a convenience filter.
      if ((rule.blocked || []).includes(ext)) {
        req.uploadRejections = req.uploadRejections || [];
        req.uploadRejections.push({
          field: file.fieldname,
          originalName: file.originalname || '',
          reason: 'blocked',
          allowed: null
        });
        return cb(null, false);
      }

      if (!rule.exts) return cb(null, true);
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

  /**
   * Write what multer buffered into the configured backend, then reshape each
   * file to look exactly like multer's own diskStorage result.
   *
   * Routes read `req.file.filename` and build "/uploads/<folder>/<filename>"
   * themselves. Preserving that field is what lets the storage backend change
   * without touching a single route. `file.buffer` is deliberately left in place:
   * the resource-upload route extracts text from the file it just received, and
   * reading the buffer it already has beats fetching the object straight back.
   */
  async function flushToStorage(req, _res, next) {
    // .single() sets req.file; .array() sets req.files to an array; .fields()
    // sets it to an object of field name -> array. Flatten all three.
    let files = [];
    if (req.file) files = [req.file];
    else if (Array.isArray(req.files)) files = req.files;
    else if (req.files && typeof req.files === 'object') files = Object.values(req.files).flat();
    try {
      for (const file of files) {
        const ext = path.extname(file.originalname || '');
        const filename = `${Date.now()}-${uuidv4()}${ext}`;
        const stored = await putFile(relativeFolder, filename, file.buffer, file.mimetype);
        file.filename = filename;
        file.path = stored;
        file.destination = `/uploads/${relativeFolder}`;
      }
      return next();
    } catch (error) {
      // A storage outage must not read as "no file was received", which is how a
      // silent failure here would surface — the row would be written with a path
      // to an object that was never stored.
      return next(error);
    }
  }

  // Express accepts an array of middleware wherever one is expected, so routes
  // keep calling `.single('image')` / `.array('handouts', 10)` unchanged.
  return {
    single: (field) => [upload.single(field), flushToStorage],
    array: (field, maxCount) => [upload.array(field, maxCount), flushToStorage],
    fields: (spec) => [upload.fields(spec), flushToStorage]
  };
}

/**
 * Human-readable message for a rejected upload, for use in a flash.
 * Returns null when nothing was rejected.
 */
function describeUploadRejection(req) {
  const rejection = (req.uploadRejections || [])[0];
  if (!rejection) return null;
  if (rejection.reason === 'blocked') {
    return `"${rejection.originalName}" was not accepted: web page and script files cannot be attached, `
      + 'because they would run inside MindQuest when someone opens them. Send it as a PDF or an image instead.';
  }
  return `"${rejection.originalName}" was not accepted. Allowed file types: ${(rejection.allowed || [])
    .map((e) => e.replace('.', '').toUpperCase())
    .join(', ')}.`;
}

module.exports = {
  createUploader,
  describeUploadRejection,
  DOCUMENT_EXTS,
  IMAGE_EXTS,
  EXECUTABLE_IN_BROWSER
};
