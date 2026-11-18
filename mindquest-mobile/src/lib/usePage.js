/**
 * File: src/lib/usePage.js
 * Purpose: Load one student page from the server and keep it fresh.
 *
 *   const page = usePage('/subjects/5');
 *   page.data       the whitelisted fields of that page (lib/mobileSerializers.js on the server)
 *   page.loading    first load in progress
 *   page.error      a sentence to show with a Retry button
 *   page.refresh()  pull-to-refresh
 *   page.reload()   load again quietly (after an action)
 *   page.flash      the message to show on top (from the server or the previous action)
 *
 * The page reloads every time its screen comes back into view, so what the
 * student sees is never older than the last time they looked.
 * When the server answers with a redirect instead (a gate: "complete the
 * Pre-Assessment first"), the app goes there and shows the reason.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { getPage } from './api';
import { followAnswer } from './navigation';
import { setNotificationCount, takeFlash } from './store';

/**
 * @param {string} path            the app path (= the website's student path)
 * @param {object} [options]
 * @param {boolean} [options.once] load once, not on every return to the screen
 *                                 (an assessment being answered: reloading it
 *                                 would start a new sitting)
 */
export function usePage(path, { once = false } = {}) {
  const router = useRouter();
  const [state, setState] = useState({ loading: true, error: '', data: null, title: '', view: '' });
  const [refreshing, setRefreshing] = useState(false);
  const [flash, setFlash] = useState(null);
  const alive = useRef(true);
  const loadedOnce = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async ({ quiet = false, at = path } = {}) => {
    if (!quiet && !loadedOnce.current) setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      const answer = await getPage(at);
      if (!alive.current) return;
      if (answer.redirect || answer.external) {
        // This page is not for them (yet): the server says where to go and why.
        await followAnswer(router, answer, { current: '', replace: true });
        return;
      }
      loadedOnce.current = true;
      setNotificationCount(answer.notificationCount);
      setState({ loading: false, error: '', data: answer.data, title: answer.title, view: answer.view });
      const waiting = takeFlash();
      if (waiting || answer.flash) setFlash(answer.flash || waiting);
    } catch (error) {
      if (!alive.current) return;
      if (error && error.auth === false) return; // logged out: the root layout shows Login
      // Keep what is on screen after a failed refresh; say so on the first load.
      setState((s) => ({ ...s, loading: false, error: loadedOnce.current ? '' : error.message }));
      if (loadedOnce.current) setFlash({ type: 'error', message: error.message });
    }
  }, [path, router]);

  // Load on focus: first open, and every return to this screen.
  useFocusEffect(useCallback(() => {
    if (!once || !loadedOnce.current) load({ quiet: true });
  }, [load, once]));

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load({ quiet: true });
    if (alive.current) setRefreshing(false);
  }, [load]);

  const retry = useCallback(() => {
    loadedOnce.current = false;
    return load();
  }, [load]);

  return {
    ...state,
    refreshing,
    refresh,
    retry,
    reload: (options) => load({ quiet: true, ...(options || {}) }),
    flash,
    setFlash,
    path
  };
}
