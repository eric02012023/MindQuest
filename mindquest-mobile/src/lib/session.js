/**
 * File: src/lib/session.js
 * Purpose: Keep the login on the phone, safely.
 *
 * The access token and the trusted-phone token live in expo-secure-store
 * (Android Keystore-encrypted), never in plain AsyncStorage: anyone holding
 * the access token could act as the student until it expires.
 */
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'mq_access_token';
const DEVICE_KEY = 'mq_device_token';
const USER_KEY = 'mq_user';

// The token is also kept in memory so each request does not read the Keystore.
let memoryToken = null;

export async function loadSession() {
  const [token, deviceToken, userText] = await Promise.all([
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(DEVICE_KEY),
    SecureStore.getItemAsync(USER_KEY)
  ]);
  memoryToken = token || null;
  let user = null;
  try { user = userText ? JSON.parse(userText) : null; } catch (_error) { user = null; }
  return { token: memoryToken, deviceToken: deviceToken || null, user };
}

/** After a successful login: the access token, this phone's trust token, the student. */
export async function saveSession({ token, deviceToken, user }) {
  memoryToken = token;
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  if (deviceToken) await SecureStore.setItemAsync(DEVICE_KEY, deviceToken);
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user || {}));
}

/**
 * Forget the login. The trusted-phone token is forgotten too when the student
 * logs out themselves (the server stops trusting the phone at the same time);
 * after an expired token it is kept, so the next login on this phone may skip
 * the emailed code.
 */
export async function clearSession({ forgetDevice = false } = {}) {
  memoryToken = null;
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
  if (forgetDevice) await SecureStore.deleteItemAsync(DEVICE_KEY);
}

export async function getDeviceToken() {
  return SecureStore.getItemAsync(DEVICE_KEY);
}

export function currentToken() {
  return memoryToken;
}
