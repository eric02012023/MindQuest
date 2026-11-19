/**
 * File: public/sw.js
 * Purpose: Removes the old browser-installed app (PWA) from devices that have it.
 *
 * MindQuest used to be installable from the browser. That is withdrawn — the
 * Install App button now gives students the real Android app — but a service
 * worker already on someone's phone or computer stays there until it is told
 * to go. This is that instruction: the next time the browser checks /sw.js it
 * gets this file, which deletes every cache the old worker kept and then
 * unregisters itself. It handles no requests, so pages load straight from the
 * network as in any normal tab.
 *
 * Keep serving this file for a few months before deleting it, so devices that
 * are opened only rarely still receive it.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
      await self.registration.unregister();
    })()
  );
});
