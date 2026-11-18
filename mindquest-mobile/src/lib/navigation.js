/**
 * File: src/lib/navigation.js
 * Purpose: Follow what the server says after an action.
 *
 * The server answers an action the way the website does — "go to this page" —
 * and the app path it names is a screen of the same name here (the routing
 * rule in src/lib/api.js). This file turns that answer into navigation.
 */
import { Alert } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { leaveFlash } from './store';
import { COLORS } from './config';

/** The five tabs: going to one switches tab instead of stacking a copy. */
const TAB_PATHS = ['/', '/subjects', '/progress', '/billing', '/profile'];

/** Every screen the app has, as the website path it mirrors. */
const SCREENS = [
  /^\/$/,
  /^\/subjects$/,
  /^\/progress$/,
  /^\/billing$/,
  /^\/profile$/,
  /^\/billing\/slip$/,
  /^\/notifications$/,
  /^\/notifications\/archive$/,
  /^\/notifications\/history$/,
  /^\/subjects\/\d+$/,
  /^\/subjects\/\d+\/(pre|post)-assessment$/,
  /^\/tutors\/\d+$/,
  /^\/modules\/\d+$/,
  /^\/level-modules\/\d+$/,
  /^\/path-modules\/\d+$/,
  /^\/path-modules\/\d+\/assessment$/,
  /^\/tutor-assessments\/\d+$/,
  /^\/results\/\d+$/,
  /^\/assessment-result\/\d+$/
];

/** "/billing?payment=success" -> { pathname: "/billing", search: "?payment=success" } */
export function splitPath(path) {
  const text = String(path || '/');
  const at = text.indexOf('?');
  return at === -1 ? { pathname: text, search: '' } : { pathname: text.slice(0, at), search: text.slice(at) };
}

/** Does the app have a screen for this website path? */
export function hasScreen(path) {
  const { pathname } = splitPath(path);
  return SCREENS.some((pattern) => pattern.test(pathname));
}

/**
 * Go to an app path.
 * @param {object} router         expo-router's router
 * @param {string} path           e.g. "/subjects/5"
 * @param {object} [options]
 * @param {boolean} [options.replace]  replace the current screen (after submitting a form)
 */
export function goTo(router, path, { replace = false } = {}) {
  const target = hasScreen(path) ? path : '/';
  const { pathname } = splitPath(target);
  if (TAB_PATHS.includes(pathname)) {
    // Tabs: switch to it (and drop any screens stacked on top).
    if (router.canDismiss && router.canDismiss()) router.dismissAll();
    router.navigate(target);
    return;
  }
  if (replace) router.replace(target);
  else router.push(target);
}

/**
 * Act on the server's answer to an action.
 *
 * @param {object} router
 * @param {object} answer          { redirect, external, flash }
 * @param {object} context
 * @param {string} context.current     the app path of the screen that sent it
 * @param {Function} [context.reload]  reload that screen (when it is sent back to itself)
 * @param {Function} [context.onFlash] show a message on that screen
 * @param {boolean} [context.replace]  leave the current screen for good (a submitted form)
 */
export async function followAnswer(router, answer, { current, reload, onFlash, replace = false } = {}) {
  if (!answer) return;
  if (answer.external) {
    // PayMongo's checkout runs in the phone's browser (a Custom Tab), never
    // inside the app: the student types card or e-wallet details on PayMongo.
    await WebBrowser.openBrowserAsync(answer.external, { toolbarColor: COLORS.greenDark, showTitle: true });
    return;
  }
  if (answer.redirect) {
    const back = splitPath(answer.redirect).pathname === splitPath(current || '').pathname;
    if (back && !replace) {
      // Sent back to the same screen: reload it and show the message there.
      if (onFlash) onFlash(answer.flash || null);
      if (reload) await reload();
      return;
    }
    leaveFlash(answer.flash);
    goTo(router, answer.redirect, { replace });
    return;
  }
  if (answer.flash && onFlash) onFlash(answer.flash);
}

/** Ask before doing something, with Cancel. */
export function confirm(title, message, confirmText = 'Continue') {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmText, onPress: () => resolve(true) }
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}
