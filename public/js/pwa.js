/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: public/js/pwa.js
 * Purpose: Turns MindQuest into an app the user can install, and drives the
 *          "Install App" buttons in the topbar, the login page and the landing
 *          page header.
 * Notes: Loaded on every page from views/partials/head.ejs.
 *
 * Installing is always optional. Nothing here changes how the website works —
 * a person who never presses the button keeps using MindQuest exactly as before,
 * and a person who installs it gets the same pages in their own window with an
 * icon on their home screen or desktop. All four roles may install it.
 *
 * The button is hidden until the browser tells us an install is actually
 * possible, because the three cases look very different:
 *
 *   Chrome / Edge / Android   fire `beforeinstallprompt`. We keep that event and
 *                             replay it when the button is pressed, which opens
 *                             the browser's own install dialog.
 *   iPhone / iPad (Safari)    never fire it — Apple only offers "Add to Home
 *                             Screen" from the share sheet — so we show the
 *                             button anyway and explain where that is.
 *   Already installed         nothing to offer, so the button stays hidden.
 */

(function () {
  'use strict';

  var SUPPORTS_SERVICE_WORKER = 'serviceWorker' in navigator;

  /* ---------------------------------------------------------------------
     1. Register the service worker.
     It is what makes the app installable at all, and it is what shows the
     offline page instead of the browser's dinosaur when the network drops.
     A failure here is not worth an error message: the website still works,
     it simply cannot be installed.
     ------------------------------------------------------------------ */

  if (SUPPORTS_SERVICE_WORKER) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {
        /* no service worker, no install — the site itself is unaffected */
      });
    });
  }

  /* ---------------------------------------------------------------------
     2. Work out what we can offer this browser.
     ------------------------------------------------------------------ */

  function isRunningInstalled() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: minimal-ui)').matches ||
      navigator.standalone === true
    );
  }

  function isAppleMobile() {
    var ua = navigator.userAgent || '';
    // iPadOS 13+ reports itself as a Mac, so a Mac with a touch screen is an iPad.
    var iPadOnDesktopUa = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    return /iPhone|iPad|iPod/.test(ua) || iPadOnDesktopUa;
  }

  var deferredPrompt = null;

  function installButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-pwa-install]'));
  }

  function showInstallButtons() {
    installButtons().forEach(function (button) {
      button.hidden = false;
    });
  }

  function hideInstallButtons() {
    installButtons().forEach(function (button) {
      button.hidden = true;
    });
  }

  // Already an app on this device — there is nothing left to install.
  if (isRunningInstalled()) return;

  window.addEventListener('beforeinstallprompt', function (event) {
    // Hold the event back so the button decides when the dialog appears,
    // rather than the browser interrupting the page on its own.
    event.preventDefault();
    deferredPrompt = event;
    showInstallButtons();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    hideInstallButtons();
  });

  // Safari never fires the event above, so on an iPhone or iPad the button is
  // revealed on its own and explains the share-sheet route instead.
  if (isAppleMobile()) {
    document.addEventListener('DOMContentLoaded', showInstallButtons);
  }

  /* ---------------------------------------------------------------------
     3. The button itself.
     Delegated from the document so it works for a button rendered by any
     template, in any role's shell, without each page wiring it up.
     ------------------------------------------------------------------ */

  document.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('[data-pwa-install]') : null;
    if (!button) return;
    event.preventDefault();

    if (deferredPrompt) {
      var prompt = deferredPrompt;
      // The stored event may only be replayed once.
      deferredPrompt = null;
      prompt.prompt();
      prompt.userChoice
        .then(function (choice) {
          if (choice && choice.outcome === 'accepted') hideInstallButtons();
          else showInstallButtons();
        })
        .catch(function () {
          showInstallButtons();
        });
      return;
    }

    openIosInstructions();
  });

  /* ---------------------------------------------------------------------
     4. The iPhone / iPad instructions.
     Built here rather than in a template so every page gets it from the one
     script, and styled by /css/pwa.css so it does not depend on the modal
     styles that only some pages load.
     ------------------------------------------------------------------ */

  function openIosInstructions() {
    var existing = document.querySelector('.mq-pwa-sheet');
    if (existing) {
      existing.classList.add('is-open');
      return;
    }

    var sheet = document.createElement('div');
    sheet.className = 'mq-pwa-sheet is-open';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'How to install MindQuest');

    var steps = isAppleMobile()
      ? [
          'Open MindQuest in <strong>Safari</strong>.',
          'Tap the <strong>Share</strong> button at the bottom of the screen — the square with an arrow pointing up.',
          'Scroll down and tap <strong>Add to Home Screen</strong>.',
          'Tap <strong>Add</strong>. MindQuest now has its own icon on your home screen.'
        ]
      : [
          'Open MindQuest in <strong>Chrome</strong> or <strong>Microsoft Edge</strong>.',
          'Open the browser menu — the <strong>⋮</strong> button at the top right.',
          'Choose <strong>Install app</strong> (on a phone it may say <strong>Add to Home screen</strong>).',
          'Confirm, and MindQuest opens in its own window from then on.'
        ];

    sheet.innerHTML =
      '<div class="mq-pwa-card">' +
      '<button type="button" class="mq-pwa-close" data-pwa-close aria-label="Close">&times;</button>' +
      '<img class="mq-pwa-logo" src="/assets/icon-192.png" alt="" />' +
      '<h3>Install MindQuest</h3>' +
      '<p class="mq-pwa-lead">Add MindQuest to this device to open it like any other app — same account, same pages, no browser tabs.</p>' +
      '<ol class="mq-pwa-steps">' +
      steps
        .map(function (step) {
          return '<li>' + step + '</li>';
        })
        .join('') +
      '</ol>' +
      '<button type="button" class="mq-pwa-done" data-pwa-close>Got it</button>' +
      '</div>';

    document.body.appendChild(sheet);
  }

  document.addEventListener('click', function (event) {
    var sheet = document.querySelector('.mq-pwa-sheet.is-open');
    if (!sheet) return;
    var closer = event.target.closest ? event.target.closest('[data-pwa-close]') : null;
    if (closer || event.target === sheet) sheet.classList.remove('is-open');
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var sheet = document.querySelector('.mq-pwa-sheet.is-open');
    if (sheet) sheet.classList.remove('is-open');
  });
})();
