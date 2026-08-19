/**
 * File: lib/paths.js
 * Purpose: One place that decides where uploaded files live on disk.
 *
 * Why this exists: on Render (and most container hosts) the application's own
 * filesystem is **ephemeral** — it is rebuilt from the repository on every deploy
 * and every restart. Anything written into `public/uploads` at runtime is gone the
 * next time the service restarts, while the database rows that point at those
 * files survive. The result is handouts that exist in the UI and 404 on disk, and
 * assessments generated from text whose source file has vanished.
 *
 * Setting UPLOAD_ROOT to a mounted persistent disk (Render: Disks → mount path,
 * e.g. /var/data/uploads) moves every upload there without touching any code.
 * Left unset, everything behaves exactly as before: <project>/public/uploads.
 *
 * Stored paths in the database stay in their public form ("/uploads/handouts/x.pdf")
 * either way — only the mapping to disk changes.
 */

const path = require('path');
const fs = require('fs');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const UPLOADS_ROOT = process.env.UPLOAD_ROOT
  ? path.resolve(process.env.UPLOAD_ROOT)
  : path.join(PUBLIC_DIR, 'uploads');

/** True when uploads live outside the repo, i.e. on a persistent disk. */
const usingExternalUploadRoot = path.resolve(UPLOADS_ROOT) !== path.join(PUBLIC_DIR, 'uploads');

/** The directory for one upload folder ("handouts", "profiles", ...). */
function uploadFolder(folder) {
  return path.join(UPLOADS_ROOT, folder);
}

/**
 * Map a stored public path to a real file on disk.
 *
 * Accepts what the database holds — "/uploads/handouts/x.pdf" — as well as a bare
 * "handouts/x.pdf", and anything else under public/ (legacy rows point at other
 * folders). Returns null for a path that tries to climb out of its root, so a
 * crafted file_path cannot read arbitrary files off the server.
 */
function resolveUploadPath(storedPath) {
  const raw = String(storedPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw) return null;

  const isUpload = raw.startsWith('uploads/');
  const base = isUpload ? UPLOADS_ROOT : PUBLIC_DIR;
  const relative = isUpload ? raw.slice('uploads/'.length) : raw;

  const resolved = path.resolve(base, relative);
  // Containment check: resolve() has already collapsed any ".." segments, so a
  // path that escaped its base is visible here and refused.
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function ensureDir(target) {
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
}

module.exports = {
  PUBLIC_DIR,
  UPLOADS_ROOT,
  usingExternalUploadRoot,
  uploadFolder,
  resolveUploadPath,
  ensureDir
};
