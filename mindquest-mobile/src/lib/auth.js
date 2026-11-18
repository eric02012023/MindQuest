/**
 * File: src/lib/auth.js
 * Purpose: Who is logged in, and the login / code / logout steps.
 *
 *   1. login(email, password)  -> logged in at once on a phone verified before,
 *                                 or { otpRequired, pendingToken, maskedEmail }
 *   2. verifyOtp(code)          -> logged in; this phone is trusted next time
 *   3. logout()                 -> the server stops trusting this phone, and the
 *                                 token is forgotten
 * Whenever the server answers 401 { auth: false } (expired, archived, not a
 * student), the app logs out by itself and shows the reason on the Login screen.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { request, setLoggedOutHandler } from './api';
import { clearSession, getDeviceToken, loadSession, saveSession } from './session';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ ready: false, user: null, signedIn: false, notice: '' });

  // On start: is there a saved login on this phone?
  useEffect(() => {
    let alive = true;
    loadSession()
      .then((saved) => {
        if (alive) setState({ ready: true, user: saved.user, signedIn: !!saved.token, notice: '' });
      })
      .catch(() => {
        if (alive) setState({ ready: true, user: null, signedIn: false, notice: '' });
      });
    return () => { alive = false; };
  }, []);

  // The server said the login is over: forget it (the trusted phone stays).
  useEffect(() => {
    setLoggedOutHandler((message) => {
      clearSession().catch(() => {});
      setState((previous) => (previous.signedIn
        ? { ready: true, user: null, signedIn: false, notice: message || 'Please log in again.' }
        : previous));
    });
    return () => setLoggedOutHandler(null);
  }, []);

  const finish = useCallback(async (answer) => {
    await saveSession({ token: answer.token, deviceToken: answer.deviceToken, user: answer.user });
    setState({ ready: true, user: answer.user, signedIn: true, notice: '' });
  }, []);

  const login = useCallback(async (email, password) => {
    const deviceToken = await getDeviceToken();
    const answer = await request('POST', '/auth/login', {
      auth: false,
      body: { email: String(email || '').trim(), password, deviceToken: deviceToken || undefined }
    });
    if (answer.token) {
      await finish(answer);
      return { done: true };
    }
    return {
      otpRequired: true,
      pendingToken: answer.pendingToken,
      maskedEmail: answer.maskedEmail,
      message: answer.message,
      emailSent: answer.emailSent !== false
    };
  }, [finish]);

  const verifyOtp = useCallback(async (pendingToken, otp) => {
    const answer = await request('POST', '/auth/verify-otp', { auth: false, body: { pendingToken, otp } });
    await finish(answer);
  }, [finish]);

  const resendOtp = useCallback(
    (pendingToken) => request('POST', '/auth/resend-otp', { auth: false, body: { pendingToken } }),
    []
  );

  const logout = useCallback(async () => {
    const deviceToken = await getDeviceToken();
    try {
      await request('POST', '/auth/logout', { body: { deviceToken: deviceToken || undefined } });
    } catch (_error) {
      // Logging out works offline too: the phone forgets the login either way.
    }
    await clearSession({ forgetDevice: true });
    setState({ ready: true, user: null, signedIn: false, notice: '' });
  }, []);

  const clearNotice = useCallback(() => setState((previous) => ({ ...previous, notice: '' })), []);

  const value = useMemo(
    () => ({ ...state, login, verifyOtp, resendOtp, logout, clearNotice }),
    [state, login, verifyOtp, resendOtp, logout, clearNotice]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}
