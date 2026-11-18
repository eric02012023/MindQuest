/**
 * File: src/lib/config.js
 * Purpose: Where the server is, and the app's colours.
 *
 * The server address comes from app.json -> expo.extra.apiUrl, so the same
 * code runs against the live site or a laptop on the same Wi-Fi (see README).
 */
import Constants from 'expo-constants';

/** "https://mindquesttutorial.com" (no trailing slash, and no "www.": that address only redirects here, and Android drops the token on a redirect to another host). */
export const API_URL = String((Constants.expoConfig && Constants.expoConfig.extra && Constants.expoConfig.extra.apiUrl) || '')
  .trim()
  .replace(/\/+$/, '');

/**
 * A release build talks to the server over HTTPS only: a password or a login
 * code must never cross the network in plain text. Plain http:// is accepted
 * only while developing (Expo Go on the same Wi-Fi as the laptop).
 */
export const API_URL_ALLOWED = __DEV__ ? /^https?:\/\//.test(API_URL) : /^https:\/\//.test(API_URL);

/** The website, for Register and Forgot password (they stay on the website). */
export const WEBSITE_URL = API_URL;

/** Sent as the User-Agent. It is part of the trusted-phone fingerprint on the
 *  server, so it must not change between app versions. */
export const APP_USER_AGENT = 'MindQuestStudentApp (Android)';

/** How long any request may take. The Pre-Assessment is written by AI the
 *  first time it is opened, which can take a while. */
export const REQUEST_TIMEOUT_MS = 90 * 1000;

/** MindQuest green, as on the website. */
export const COLORS = {
  green: '#1c9a22',
  greenDark: '#064c02',
  greenSoft: '#e8f6e9',
  text: '#1d2a1f',
  muted: '#5f6f62',
  border: '#dfe7e0',
  background: '#f4f7f4',
  card: '#ffffff',
  danger: '#c62828',
  dangerSoft: '#fdecea',
  warning: '#b26a00',
  warningSoft: '#fff4e0',
  info: '#1565c0',
  infoSoft: '#e8f1fb'
};
