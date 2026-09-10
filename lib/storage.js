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

/**
 * ── When the remote backend is unreachable ──────────────────────────────────
 *
 * A configured bucket is not a reachable bucket. The project can be deleted,
 * paused, renamed, or simply unreachable from wherever this process is running —
 * and the failure lands on `fetch`, deep inside an upload, where the only thing
 * the admin sees is the 500 page. That happened here: the configured project
 * host stopped resolving, so *every* upload in the app died at once with no
 * indication of why.
 *
 * So a remote failure is not fatal any more. The bytes go to local disk instead
 * and the app keeps working. That is a genuine downgrade — a container with an
 * ephemeral filesystem loses those files on restart — so it is never silent:
 * it is logged the moment it happens, reported at boot, and `storageStatus()`
 * lets a route tell the admin plainly which backend actually took their file.
 *
 * The cool-off exists because the common failure is DNS, and a dead lookup costs
 * seconds. Without it, an upload of ten handouts would pay that ten times over
 * before falling back. One failure parks the remote backend for a minute; the
 * next write after that tries it again, so recovery needs no restart.
 */
const REMOTE_RETRY_AFTER_MS = 60 * 1000;

/**
 * `fetch` waits forever by default, and a host that accepts a connection and then
 * says nothing is a worse failure than one that refuses outright: the boot probe
 * would hang the server before it ever listened, and an upload would hold the
 * admin's request open with no way to fall back. Every remote call is therefore
 * bounded. The write budget is the largest because a 25 MB handout on a slow link
 * is a legitimate slow request, not a stall.
 */
const REMOTE_TIMEOUT_MS = { probe: 8 * 1000, read: 30 * 1000, write: 120 * 1000 };

let remoteDownUntil = 0;
let remoteDownReason = '';
let remoteEverFailed = false;

function remoteAvailable() {
  return usingSupabase && Date.now() >= remoteDownUntil;
}

/**
 * The useful half of a failed fetch.
 *
 * Node reports every network failure as the bare string "fetch failed" and hangs
 * the real problem off `cause`. Logging the outer message alone turns "the
 * project host does not exist" and "the connection was refused" into the same
 * unactionable line, which is most of the reason this outage was hard to place.
 */
function describeFetchError(error) {
  const outer = (error && error.message) || String(error);
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'the storage host accepted the connection but did not answer in time';
  }
  const cause = error && error.cause;
  if (!cause) return outer;
  const inner = cause.message || String(cause);
  if (cause.code === 'ENOTFOUND') {
    return `${cause.hostname || 'the storage host'} does not exist (DNS lookup failed) — `
      + 'the Supabase project may have been deleted, or SUPABASE_URL is wrong';
  }
  return inner === outer ? outer : `${outer}: ${inner}`;
}

function markRemoteDown(error) {
  const reason = describeFetchError(error);
  // Announce a change of state, not every retry: a bucket that is down stays
  // down for the whole cool-off, and one line per failed upload buries the log.
  if (!remoteDownReason) {
    console.error(
      `[storage] Supabase is unreachable, so uploads are being written to local disk instead.\n`
      + `          reason: ${reason}\n`
      + `          Files stored this way are lost if this server's filesystem is not persistent.\n`
      + `          Fix SUPABASE_URL / SUPABASE_SERVICE_KEY, or unset them to use local storage on purpose.`
    );
  }
  remoteDownReason = reason;
  remoteEverFailed = true;
  remoteDownUntil = Date.now() + REMOTE_RETRY_AFTER_MS;
}

function markRemoteUp() {
  if (remoteDownReason) {
    console.log('[storage] Supabase is reachable again; uploads are going back to the bucket.');
  }
  remoteDownReason = '';
  remoteDownUntil = 0;
}

/**
 * What the backend is doing right now, for the boot banner and for routes that
 * need to tell an admin where their file actually landed.
 */
function storageStatus() {
  if (!usingSupabase) {
    return {
      backend: 'local',
      healthy: true,
      degraded: false,
      detail: 'local filesystem (lost on every restart if the disk is not persistent)'
    };
  }
  if (remoteDownReason) {
    return {
      backend: 'local',
      healthy: false,
      degraded: true,
      reason: remoteDownReason,
      detail: `Supabase bucket "${SUPABASE_BUCKET}" is UNREACHABLE — falling back to local disk (${remoteDownReason})`
    };
  }
  return {
    backend: 'supabase',
    healthy: true,
    degraded: false,
    detail: `Supabase Storage, bucket "${SUPABASE_BUCKET}" (survives restarts)`
      + (remoteEverFailed ? ' — recovered after an earlier outage' : '')
  };
}

/** What the boot log prints, so the running configuration is never a guess. */
function describeBackend() {
  return storageStatus().detail;
}

/**
 * Ask the bucket whether it is really there, once, at boot.
 *
 * Without this the boot banner reports the *intended* backend and calls it
 * "survives restarts" even when the project behind it no longer exists — the
 * configuration is printed back rather than checked. The first person to learn
 * the truth is then whoever tries to upload a file.
 *
 * A miss on the probe object is a success: it proves the bucket answered.
 */
async function checkBackend() {
  if (!usingSupabase) return storageStatus();
  try {
    const response = await fetch(supabaseObjectUrl('.mindquest-storage-check'), {
      method: 'GET',
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS.probe),
      headers: supabaseHeaders()
    });
    // 404/400 mean "no such object", which is the expected answer and still
    // proves the bucket is reachable and the key was accepted.
    if (response.status === 401 || response.status === 403) {
      markRemoteDown(new Error(`the service key was rejected (HTTP ${response.status})`));
    } else {
      markRemoteUp();
    }
  } catch (error) {
    markRemoteDown(error);
  }
  return storageStatus();
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
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS.write),
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
  const response = await fetch(supabaseObjectUrl(key), {
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS.read),
    headers: supabaseHeaders()
  });
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
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS.read),
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
 *
 * The path returned is the same under either backend, so a file that had to go
 * to local disk during an outage is still described by the row that points at
 * it, and getFile() below finds it wherever it ended up.
 *
 * @returns {Promise<string>} e.g. "/uploads/handouts/1699-uuid.pdf"
 */
async function putFile(folder, filename, buffer, contentType) {
  if (remoteAvailable()) {
    try {
      await supabasePut(`${folder}/${filename}`, buffer, contentType);
      markRemoteUp();
      return publicPath(folder, filename);
    } catch (error) {
      // Losing the bucket must not lose the upload. Keep the bytes on disk and
      // carry on; markRemoteDown says loudly what just happened.
      markRemoteDown(error);
    }
  }
  await localPut(folder, filename, buffer);
  return publicPath(folder, filename);
}

/**
 * Read a stored file back.
 *
 * Both backends are consulted, remote first, because the two can legitimately
 * hold different files at the same time: anything uploaded while the bucket was
 * unreachable is on disk, everything else is in the bucket. Checking only the
 * configured backend would 404 half the library after a single outage.
 *
 * @returns {Promise<{buffer: Buffer, contentType: string|null}|null>} null when
 * the file does not exist — callers already handle a missing file, and a deleted
 * object should not become a 500.
 */
async function getFile(storedPath) {
  const key = toObjectKey(storedPath);
  if (!key) return null;

  if (remoteAvailable()) {
    try {
      const found = await supabaseGet(key);
      markRemoteUp();
      if (found) return found;
    } catch (error) {
      markRemoteDown(error);
    }
  }
  return localGet(storedPath);
}

/**
 * Remove a stored file. Succeeds quietly when it is already gone.
 *
 * Both backends are cleared for the same reason getFile() reads both: the copy
 * being deleted may be on either side of an outage, and leaving one behind would
 * resurrect a "deleted" handout the next time the other backend was consulted.
 */
async function deleteFile(storedPath) {
  const key = toObjectKey(storedPath);
  if (!key) return;

  if (remoteAvailable()) {
    try {
      await supabaseDelete(key);
      markRemoteUp();
    } catch (error) {
      // A file that cannot be reached cannot be deleted, and failing here would
      // block the row's own removal. Record the outage and clear the local copy.
      markRemoteDown(error);
    }
  }
  await localDelete(storedPath);
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
  checkBackend,
  storageStatus,
  toObjectKey,
  publicPath,
  putFile,
  getFile,
  deleteFile,
  fileExists,
  SUPABASE_BUCKET
};
