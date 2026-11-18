/**
 * File: src/lib/store.js
 * Purpose: Two small pieces of state shared by every screen.
 *
 *   - the unread count on the bell (every page the server sends carries it);
 *   - the "flash" message an action leaves for the NEXT screen ("Payment slip
 *     PS-0012 is ready"), exactly like the website's flash after a redirect.
 */
import { useSyncExternalStore } from 'react';

let notificationCount = 0;
const listeners = new Set();

export function setNotificationCount(count) {
  const next = Number(count) || 0;
  if (next === notificationCount) return;
  notificationCount = next;
  listeners.forEach((listener) => listener());
}

/** React hook: the bell's number, re-rendering when it changes. */
export function useNotificationCount() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => notificationCount
  );
}

let pendingFlash = null;

/** Leave a message for the next screen that loads. */
export function leaveFlash(flash) {
  if (flash && flash.message) pendingFlash = flash;
}

/** Take the waiting message (once). */
export function takeFlash() {
  const flash = pendingFlash;
  pendingFlash = null;
  return flash;
}
