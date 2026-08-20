/**
 * File: lib/storage.js
 * Purpose: One place that stores and retrieves uploaded files, whichever backend
 * is in use.
 *
 * Why this exists: lib/paths.js solved "where on disk", which is enough when the
 * disk survives. On Render's free plan it does not — the filesystem is rebuilt on
 * every deploy AND every spin-down, and a persistent disk requires a paid
 * instance. A handout uploaded on Monday is listed in the UI on Tuesday and 404s.
 *
 * So the question is no longer "where on disk" but "on disk at all, or somewhere
 * that outlives this container". This module answers both behind one async API:
 *
 *   local     — <UPLOAD_ROOT or public/uploads>/<folder>/<file>, exactly as before
 *   supabase  — a private Supabase Storage bucket, over its REST API
 *
 * The backend is chosen by environment, not by code: set SUPABASE_URL and
 * SUPABASE_SERVICE_KEY and uploads go to Supabase; leave them unset and nothing
 * changes from before. That keeps local development on plain files, and makes the
 * switch reversible by removing two variables.
 *
 * Stored paths in the database stay in their public form ("/uploads/handouts/x.pdf")
 * under BOTH backends. No row has to be migrated, and no route has to care.
 *
 * ── On privacy ──────────────────────────────────────────────────────────────
 * The bucket is PRIVATE and must stay private. Handouts are gated by the
 * Pre-Assessment lock (spec Section 6) and a public bucket URL would walk right
 * past it — the same hole that was closed in Phase 0. Files are fetched
 * server-side with the service key and streamed to the browser only after the
 * guards in server.js have run. The service key is never sent to a client.
 */

const fs = require('fs');
const path = require('path');
const { uploadFolder, resolveUploadPath, ensureDir, UPLOADS_ROOT } = require('./paths');

/**
 * Accept either the full project URL or the bare project ref.
 *
 * The dashboard shows the ref on its own ("msfebreggptrhokjbvzs") and the URL
 * nowhere near it, so pasting just the ref is the obvious mistake to make — and
 * on a host it fails at the first upload, long after anyone is watching. Both
 * forms are normalised to the URL the REST API needs.
 */
function normaliseSupabaseUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}.supabase.co`;
}

const SUPABASE_URL = normaliseSupabaseUrl(process.env.SUPABASE_URL);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'mindquest-uploads';

/** True when uploads live in Supabase rather than on this container's disk. */
const usingSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);

/** What the boot log prints, so the running configuration is never a guess. */
function describeBackend() {
  if (usingSupabase) {
    return `Supabase Storage, bucket "${SUPABASE_BUCKET}" (survives restarts)`;
  }
  return 'local filesystem (lost on every restart if the disk is not persistent)';
}

// ---------------------------------------------------------------- path helpers

/**
 * Split a stored public path into the folder and file name the backends use.
 * Accepts "/uploads/handouts/x.pdf" and a bare "handouts/x.pdf".
 * Returns null for anything that tries to climb out with "..", so a crafted
 * file_path cannot reach another object — the same containment rule
 * resolveUploadPath() applies on disk.
 */
function toObjectKey(storedPath) {
  const raw = String(storedPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw) return null;
  const withoutPrefix = raw.startsWith('uploads/') ? raw.slice('uploads/'.length) : raw;
  if (!withoutPrefix) return null;
  // Reject traversal and absolute forms outright rather than normalising them:
  // there is no legitimate upload whose key contains "..".
  if (withoutPrefix.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  if (/^[a-zA-Z]:/.test(withoutPrefix)) return null;
  return withoutPrefix;
}

/** The public path stored in the database for a freshly written file. */
function publicPath(folder, filename) {
  return `/uploads/${folder}/${filename}`;
}

// ------------------------------------------------------------ supabase backend

function supabaseObjectUrl(key) {
  return `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/`
    + key.split('/').map(encodeURIComponent).join('/');
}

function supabaseHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${SUPABASE_KEY}`,
    // Supabase accepts the service key in either header; both are sent because
    // the storage API has historically wanted apikey and the gateway wants the
    // bearer token.
    apikey: SUPABASE_KEY,
    ...extra
  };
}

async function supabasePut(key, buffer, contentType) {
  const response = await fetch(supabaseObjectUrl(key), {
    method: 'POST',
    headers: supabaseHeaders({
      'Content-Type': contentType || 'application/octet-stream',
      // A generated name collides only if uuidv4 repeats, but an overwrite is
      // still the right resolution: the newer file is the one being uploaded.
      'x-upsert': 'true'
    }),
    body: buffer
  });
  if (!response.ok) {
    throw new Error(`Supabase upload failed (${response.status}): ${await response.text()}`);
  }
}

async function supabaseGet(key) {
  const response = await fetch(supabaseObjectUrl(key), { headers: supabaseHeaders() });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) {
    throw new Error(`Supabase download failed (${response.status}): ${await response.text()}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || null
  };
}

async function supabaseDelete(key) {
  const response = await fetch(supabaseObjectUrl(key), {
    method: 'DELETE',
    headers: supabaseHeaders()
  });
  // A file that is already gone is a success for the caller's purpose.
  if (!response.ok && response.status !== 404) {
    throw new Error(`Supabase delete failed (${response.status}): ${await response.text()}`);
  }
}

// --------------------------------------------------------------- local backend

async function localPut(folder, filename, buffer) {
  const dir = uploadFolder(folder);
  ensureDir(dir);
  await fs.promises.writeFile(path.join(dir, filename), buffer);
}

/**
 * Where a stored path could be on disk, most specific first.
 *
 * The object key is tried first so that the local and remote backends answer a
 * given path identically — a caller must not get a different file depending on
 * which backend is configured.
 *
 * resolveUploadPath() is kept as a second candidate because it resolves a path
 * that is NOT under uploads/ against public/ instead, which is how legacy
 * subject_resources rows pointing at other folders still read. That fallback has
 * no meaning remotely, where nothing but uploads exists.
 */
function localCandidates(storedPath) {
  const candidates = [];
  const key = toObjectKey(storedPath);
  if (key) candidates.push(path.join(UPLOADS_ROOT, key));
  const legacy = resolveUploadPath(storedPath);
  if (legacy && !candidates.includes(legacy)) candidates.push(legacy);
  return candidates;
}

async function localGet(storedPath) {
  for (const absolute of localCandidates(storedPath)) {
    if (fs.existsSync(absolute)) {
      return { buffer: await fs.promises.readFile(absolute), contentType: null };
    }
  }
  return null;
}

async function localDelete(storedPath) {
  for (const absolute of localCandidates(storedPath)) {
    if (fs.existsSync(absolute)) {
      await fs.promises.unlink(absolute);
      return;
    }
  }
}

// ------------------------------------------------------------------ public API

/**
 * Store one uploaded file and return the public path to record in the database.
 * @returns {Promise<string>} e.g. "/uploads/handouts/1699-uuid.pdf"
 */
async function putFile(folder, filename, buffer, contentType) {
  if (usingSupabase) {
    await supabasePut(`${folder}/${filename}`, buffer, contentType);
  } else {
    await localPut(folder, filename, buffer);
  }
  return publicPath(folder, filename);
}

/**
 * Read a stored file back.
 * @returns {Promise<{buffer: Buffer, contentType: string|null}|null>} null when
 * the file does not exist — callers already handle a missing file, and a deleted
 * object should not become a 500.
 */
async function getFile(storedPath) {
  const key = toObjectKey(storedPath);
  if (!key) return null;
  return usingSupabase ? supabaseGet(key) : localGet(storedPath);
}

/** Remove a stored file. Succeeds quietly when it is already gone. */
async function deleteFile(storedPath) {
  const key = toObjectKey(storedPath);
  if (!key) return;
  if (usingSupabase) await supabaseDelete(key);
  else await localDelete(storedPath);
}

/** True when the object is readable. Used where a route only needs existence. */
async function fileExists(storedPath) {
  try {
    return (await getFile(storedPath)) !== null;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  usingSupabase,
  describeBackend,
  toObjectKey,
  publicPath,
  putFile,
  getFile,
  deleteFile,
  fileExists,
  SUPABASE_BUCKET
};
