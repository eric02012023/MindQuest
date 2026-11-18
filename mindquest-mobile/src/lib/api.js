/**
 * File: src/lib/api.js
 * Purpose: Every call the app makes to the MindQuest server.
 *
 * THE ROUTING RULE
 *   An app screen's path IS the website's student path without "/student":
 *   the app's /subjects/5 asks GET /api/mobile/student/subjects/5, and the
 *   server runs the website's own route for it (routes/mobileApi.js). So the
 *   app never decides who may see what — the server does, with the website's
 *   rules — and a new screen needs no new server code.
 *
 * WHAT COMES BACK (always JSON)
 *   { ok, view, title, notificationCount, flash, data }  a page to show
 *   { ok, redirect: '/x', flash }                        go to that app path
 *   { ok, external: 'https://…' }                         open in the browser (PayMongo)
 *   401 { auth: false }                                   logged out -> back to Login
 *
 * Every request carries the bearer token, gives up after 90 seconds, and
 * refuses to send anything over plain http in a release build.
 */
import { File, Directory, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { API_URL, API_URL_ALLOWED, APP_USER_AGENT, REQUEST_TIMEOUT_MS } from './config';
import { currentToken } from './session';

/** A request the server (or the network) refused, with a sentence to show. */
export class ApiError extends Error {
  constructor(message, { status = 0, auth = true } = {}) {
    super(message);
    this.status = status;
    this.auth = auth;
  }
}

// Called when the server says the login is over (set by the auth provider).
let onLoggedOut = null;
export function setLoggedOutHandler(handler) {
  onLoggedOut = handler;
}

/** "/subjects/5" -> "/student/subjects/5"; "/" -> "/student". */
export function studentPath(appPath) {
  const path = String(appPath || '/');
  if (path === '/' || path.startsWith('/?')) return `/student${path.slice(1)}`;
  return `/student${path}`;
}

function assertSafeServer() {
  if (!API_URL_ALLOWED) {
    throw new ApiError('The app is not set up with a secure (https://) server address. Please update the app.');
  }
}

/**
 * One request to /api/mobile.
 * @param {string} method
 * @param {string} path         under /api/mobile, e.g. "/auth/login" or "/student/subjects"
 * @param {object} [options]
 * @param {object} [options.body]      sent as JSON
 * @param {FormData} [options.form]    sent as multipart (the profile photo)
 * @param {string} [options.from]      the app path of the screen asking (see below)
 * @param {boolean} [options.auth]     send the token (default true)
 */
export async function request(method, path, { body, form, from, auth = true } = {}) {
  assertSafeServer();
  const headers = { Accept: 'application/json', 'User-Agent': APP_USER_AGENT };
  const token = currentToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  // A browser tells the website which page a form came from (Referer), and a
  // refused action goes back there with its reason. The app does the same, so
  // "back to the page it came from" means the screen the student is on.
  if (from) headers.Referer = `${API_URL}${studentPath(from)}`;
  let payload;
  if (form) {
    payload = form; // fetch sets the multipart boundary itself
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${API_URL}/api/mobile${path}`, { method, headers, body: payload, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new ApiError('The server took too long to answer. Please check your connection and try again.');
    }
    throw new ApiError('Cannot reach MindQuest. Please check your internet connection.');
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch (_error) { json = null; }

  // The login is over (expired, logged out elsewhere, archived, not a student).
  if (response.status === 401 || (json && json.auth === false)) {
    const message = (json && json.error) || 'Please log in again.';
    if (auth && onLoggedOut) onLoggedOut(message);
    throw new ApiError(message, { status: response.status, auth: false });
  }
  if (!json) {
    throw new ApiError(`The server answered in an unexpected way (HTTP ${response.status}). Please try again.`, { status: response.status });
  }
  if (!response.ok || json.ok === false) {
    throw new ApiError(json.error || `Something went wrong (HTTP ${response.status}).`, { status: response.status });
  }
  return json;
}

/** GET one student page (an app path). */
export function getPage(appPath) {
  return request('GET', studentPath(appPath));
}

/** POST a student action (an app path) from the screen at `from`. */
export function postAction(appPath, body = {}, { from } = {}) {
  return request('POST', studentPath(appPath), { body, from });
}

/** POST a multipart form (the profile and its photo). */
export function postForm(appPath, form, { from } = {}) {
  return request('POST', studentPath(appPath), { form, from });
}

/** The full address of a public picture (a profile photo), or null. */
export function imageUrl(path) {
  return path ? `${API_URL}${path}` : null;
}

/**
 * Open a protected file (a handout, the slip PDF, a module PDF).
 *
 * It is downloaded WITH the token into the app's cache, then shown in the
 * phone's viewer — or, when no app can show it, offered through the share
 * sheet. The server applies the website's own checks (Pre-Assessment lock,
 * grade, enrolment) before it sends a byte.
 *
 * @param {string} url   a path from the server, e.g. "/api/mobile/uploads/handouts/x.pdf"
 * @param {string} [name]  file name to save as
 */
export async function openProtectedFile(url, name) {
  assertSafeServer();
  const fileName = String(name || url.split('/').pop() || 'file').replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
  const folder = new Directory(Paths.cache, 'mindquest-files');
  if (!folder.exists) folder.create({ intermediates: true });
  const target = new File(folder, fileName);
  const headers = { 'User-Agent': APP_USER_AGENT };
  const token = currentToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let file;
  try {
    file = await File.downloadFileAsync(`${API_URL}${url}`, target, { headers, idempotent: true });
  } catch (_error) {
    // The download only says it failed; ask once more for the server's reason
    // (e.g. "Finish the Pre-Assessment first") so the student is told why.
    let reason = 'This file could not be opened.';
    try {
      const response = await fetch(`${API_URL}${url}`, { headers });
      const text = await response.text();
      try { reason = JSON.parse(text).error || reason; } catch (_e) { reason = text && text.length < 300 ? text : reason; }
      if (response.status === 401 && onLoggedOut) onLoggedOut('Please log in again.');
    } catch (_e) {
      reason = 'Cannot reach MindQuest. Please check your internet connection.';
    }
    throw new ApiError(reason);
  }

  const mimeType = file.type || (fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : undefined);
  try {
    if (await File.canPreview(file, { mimeType })) {
      await File.preview(file, { title: fileName, mimeType });
      return;
    }
  } catch (_error) {
    // No viewer: fall through to the share sheet.
  }
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: fileName });
    return;
  }
  throw new ApiError('No app on this phone can open this file.');
}
