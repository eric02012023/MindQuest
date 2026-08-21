/**
 * File: public/js/anti-cheat.js
 * Purpose: Watch an assessment sitting for the actions that indicate cheating,
 *          warn three times, then submit whatever the student has answered.
 *
 * HOW IT IS WIRED
 * A page opts in by putting one element on it:
 *
 *   <div id="mq-anti-cheat"
 *        data-endpoint="/student/assessments/12/violation"
 *        data-session="a1b2c3"
 *        data-form="#assessment-form"
 *        data-limit="3"
 *        data-start-count="0"></div>
 *
 * WHY THE SERVER COUNTS THE STRIKES
 * The count that matters comes back from the endpoint on every event. If this
 * script kept its own tally, a reload would reset it to zero and devtools could
 * set it to anything — so the number in front of the student would be a number
 * they control. Here the browser only REPORTS; the server decides which warning
 * this is and whether the sitting is over.
 *
 * WHY MODALS
 * The warnings are blocking dialogs that must be acknowledged, not toasts. A
 * toast can be missed, and "I never saw a warning" is exactly the dispute this
 * feature exists to prevent.
 *
 * WHAT IT WATCHES
 *   tab_switch       the page became hidden (another tab, another app)
 *   window_blur      the window lost focus
 *   copy / paste     text taken out of, or pushed into, the assessment
 *   context_menu     right-click
 *   devtools         F12, Ctrl/Cmd+Shift+I/J/C, Ctrl/Cmd+U
 *   print            Ctrl/Cmd+P
 *
 * Blur and visibilitychange both fire for a single alt-tab, so events are
 * de-duplicated inside a short window: one action must cost one strike, not two.
 */
(function () {
  var mount = document.getElementById('mq-anti-cheat');
  if (!mount) return;

  var endpoint = mount.getAttribute('data-endpoint');
  var sessionKey = mount.getAttribute('data-session') || '';
  var form = document.querySelector(mount.getAttribute('data-form') || '#assessment-form');
  var limit = Number(mount.getAttribute('data-limit')) || 3;
  var strikes = Number(mount.getAttribute('data-start-count')) || 0;

  if (!endpoint || !form) return;

  var finished = false;      // set once the sitting ends, to stop all reporting
  var reporting = false;     // one request in flight at a time
  var lastEventAt = 0;
  var DEDUPE_MS = 1200;

  // ---------------------------------------------------------------- the modal

  var overlay = document.createElement('div');
  overlay.className = 'mq-ac-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML =
    '<div class="mq-ac-card">'
    + '<div class="mq-ac-icon" aria-hidden="true">!</div>'
    + '<h2 class="mq-ac-title"></h2>'
    + '<p class="mq-ac-body"></p>'
    + '<p class="mq-ac-count"></p>'
    + '<button type="button" class="mq-ac-btn">I understand</button>'
    + '</div>';
  document.body.appendChild(overlay);

  var titleEl = overlay.querySelector('.mq-ac-title');
  var bodyEl = overlay.querySelector('.mq-ac-body');
  var countEl = overlay.querySelector('.mq-ac-count');
  var buttonEl = overlay.querySelector('.mq-ac-btn');

  function showModal(options) {
    titleEl.textContent = options.title;
    bodyEl.textContent = options.body;
    countEl.textContent = options.count || '';
    buttonEl.textContent = options.button || 'I understand';
    overlay.classList.add('is-open');
    overlay.classList.toggle('is-final', !!options.final);
    // Focus the only control, so Enter or Space dismisses it. A dialog the
    // keyboard cannot reach is not a dialog anyone has to acknowledge.
    buttonEl.focus();

    buttonEl.onclick = function () {
      overlay.classList.remove('is-open');
      if (options.onAcknowledge) options.onAcknowledge();
    };
  }

  // ------------------------------------------------------------- auto-submit

  /**
   * Submit the sitting with whatever has been answered.
   *
   * `required` is stripped first: the browser refuses to submit a form with an
   * empty required field, which would leave a student stuck on a page that has
   * just told them the assessment is over. The brief is explicit that the
   * partial answers are kept, so the constraint has to come off.
   */
  function autoSubmit(reason) {
    if (finished) return;
    finished = true;

    form.querySelectorAll('[required]').forEach(function (field) {
      field.removeAttribute('required');
    });

    var marker = document.createElement('input');
    marker.type = 'hidden';
    marker.name = 'auto_submitted';
    marker.value = reason || 'anti_cheat_limit';
    form.appendChild(marker);

    // The form's own confirm dialog must not stand in the way of a submit the
    // student did not ask for.
    form.removeAttribute('data-confirm-message');
    form.dataset.confirmed = 'true';

    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
  }

  // ----------------------------------------------------------------- reporting

  function report(type, detail) {
    if (finished || reporting) return;

    var now = Date.now();
    if (now - lastEventAt < DEDUPE_MS) return;
    lastEventAt = now;
    reporting = true;

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ type: type, detail: detail || null, session_key: sessionKey })
    })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        reporting = false;
        if (!data || data.ok === false) return;

        strikes = Number(data.count) || strikes + 1;
        var remaining = Math.max(0, limit - strikes);

        if (data.autoSubmit || strikes >= limit) {
          showModal({
            title: 'Assessment ended',
            body: (data.label || 'Suspicious activity') + ' — that was your final warning. '
              + 'Your assessment is being submitted now with the answers you have completed so far.',
            count: 'Violation ' + strikes + ' of ' + limit,
            button: 'Submit my answers',
            final: true,
            onAcknowledge: function () { autoSubmit('anti_cheat_limit'); }
          });
          // Submit even if the dialog is never acknowledged — a student who
          // walks away must not leave the sitting open indefinitely.
          window.setTimeout(function () { autoSubmit('anti_cheat_limit'); }, 8000);
          return;
        }

        showModal({
          title: strikes === 1 ? 'Warning: stay on this page' : 'Second warning',
          body: (data.label || 'Suspicious activity') + ' was detected. '
            + 'Leaving the assessment, copying its contents or opening other tools is not allowed. '
            + (remaining === 1
              ? 'One more violation will end your assessment and submit your current answers automatically.'
              : 'After ' + limit + ' violations your assessment is submitted automatically.'),
          count: 'Violation ' + strikes + ' of ' + limit
        });
      })
      .catch(function () {
        reporting = false;
      });
  }

  // -------------------------------------------------------------- the watchers

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) report('tab_switch', 'The assessment tab was hidden.');
  });

  window.addEventListener('blur', function () {
    // Focus moving to an element inside the page is not leaving the page.
    if (document.hasFocus()) return;
    report('window_blur', 'The assessment window lost focus.');
  });

  document.addEventListener('copy', function () {
    report('copy', 'Text was copied from the assessment.');
  });

  document.addEventListener('paste', function () {
    report('paste', 'Text was pasted into the assessment.');
  });

  document.addEventListener('contextmenu', function (event) {
    event.preventDefault();
    report('context_menu', 'The right-click menu was opened.');
  });

  document.addEventListener('keydown', function (event) {
    var key = String(event.key || '').toLowerCase();
    var mod = event.ctrlKey || event.metaKey;

    if (key === 'f12') {
      event.preventDefault();
      report('devtools', 'F12 was pressed.');
      return;
    }
    if (mod && event.shiftKey && ['i', 'j', 'c'].indexOf(key) !== -1) {
      event.preventDefault();
      report('devtools', 'A developer-tools shortcut was pressed.');
      return;
    }
    if (mod && key === 'u') {
      event.preventDefault();
      report('devtools', 'View-source was requested.');
      return;
    }
    if (mod && key === 'p') {
      event.preventDefault();
      report('print', 'Printing was requested.');
    }
  });

  // A normal submit ends the sitting: no warning should fire while the page is
  // unloading, or the student would see a violation for finishing properly.
  form.addEventListener('submit', function () { finished = true; });
})();
