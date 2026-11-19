/**
 * File: public/js/install-app.js
 * Purpose: The "Install App" button — the student Android app download.
 * Notes: Loaded on every page from views/partials/head.ejs. The button itself
 *        is views/partials/install-app-button.ejs.
 *
 * Pressing the button opens a dialog first, because only students can log in
 * to the app: the dialog says so, and the download starts only from its own
 * button. On an iPhone or iPad, where an Android app cannot be installed, the
 * dialog says the app is for Android and offers no download.
 */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     1. Remove the old browser-installed app (PWA).
     MindQuest used to register a service worker so it could be installed
     from the browser. That is withdrawn, so any worker and cache it left on
     this device are cleared. /sw.js now serves a worker that does the same
     from its side, for devices that do not open a page soon.
     ------------------------------------------------------------------ */

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then(function (registrations) {
        registrations.forEach(function (registration) {
          registration.unregister();
        });
      })
      .catch(function () {});
  }

  if (window.caches && caches.keys) {
    caches
      .keys()
      .then(function (names) {
        names
          .filter(function (name) {
            return name.indexOf('mindquest-') === 0;
          })
          .forEach(function (name) {
            caches.delete(name);
          });
      })
      .catch(function () {});
  }

  /* ---------------------------------------------------------------------
     2. The dialog.
     ------------------------------------------------------------------ */

  function isAppleMobile() {
    var ua = navigator.userAgent || '';
    // iPadOS 13+ reports itself as a Mac, so a Mac with a touch screen is an iPad.
    var iPadOnDesktopUa = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    return /iPhone|iPad|iPod/.test(ua) || iPadOnDesktopUa;
  }

  var lastTrigger = null;

  function buildDialog(button) {
    var href = button.getAttribute('data-app-href') || '';
    var version = button.getAttribute('data-app-version') || '';
    var size = button.getAttribute('data-app-size') || '';
    var apple = isAppleMobile();

    var sheet = document.createElement('div');
    sheet.className = 'mq-app-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'mq-app-title');

    sheet.innerHTML =
      '<div class="mq-app-card">' +
      '<button type="button" class="mq-app-close" data-app-close aria-label="Close">&times;</button>' +
      '<img class="mq-app-logo" src="/assets/icon-192.png" alt="" />' +
      '<h3 id="mq-app-title">MindQuest Student App</h3>' +
      '<div class="mq-app-notice" role="note">' +
      '<span class="mq-app-badge">For students only</span>' +
      '<p><strong>Only students can log in to this app.</strong></p>' +
      '<p>Tutors, assistant admins and the admin keep using the website.</p>' +
      '</div>' +
      '<p class="mq-app-meta" data-app-meta></p>' +
      (apple
        ? '<p class="mq-app-apple">This app is for Android phones. On an iPhone or iPad, keep using this website.</p>' +
          '<div class="mq-app-actions">' +
          '<button type="button" class="mq-app-primary" data-app-close>OK</button>' +
          '</div>'
        : '<div class="mq-app-actions">' +
          '<a class="mq-app-primary" data-app-download download="MindQuest.apk">Download the app</a>' +
          '<button type="button" class="mq-app-secondary" data-app-close>Cancel</button>' +
          '</div>' +
          '<p class="mq-app-hint">When it has downloaded, open the file and tap <strong>Install</strong>.</p>') +
      '</div>';

    var meta = ['Android'];
    if (version) meta.push('Version ' + version);
    if (size) meta.push(size + ' MB');
    sheet.querySelector('[data-app-meta]').textContent = meta.join(' · ');

    var download = sheet.querySelector('[data-app-download]');
    if (download) download.setAttribute('href', href);

    document.body.appendChild(sheet);
    return sheet;
  }

  function openDialog(button) {
    lastTrigger = button;
    var sheet = document.querySelector('.mq-app-sheet') || buildDialog(button);
    sheet.classList.add('is-open');
    document.documentElement.classList.add('mq-app-sheet-open');
    var first = sheet.querySelector('[data-app-download]') || sheet.querySelector('.mq-app-primary');
    if (first) first.focus();
  }

  function closeDialog() {
    var sheet = document.querySelector('.mq-app-sheet.is-open');
    if (!sheet) return;
    sheet.classList.remove('is-open');
    document.documentElement.classList.remove('mq-app-sheet-open');
    if (lastTrigger && document.contains(lastTrigger)) lastTrigger.focus();
  }

  document.addEventListener('click', function (event) {
    if (!event.target.closest) return;

    var button = event.target.closest('[data-install-app]');
    if (button) {
      event.preventDefault();
      openDialog(button);
      return;
    }

    var sheet = document.querySelector('.mq-app-sheet.is-open');
    if (!sheet) return;

    // The download goes ahead as a normal link; the dialog just steps aside.
    if (event.target.closest('[data-app-download]')) {
      setTimeout(closeDialog, 300);
      return;
    }

    if (event.target.closest('[data-app-close]') || event.target === sheet) closeDialog();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeDialog();
  });
})();
