/**
 * File: public/js/mq-motion.js
 * Purpose: The two animations CSS cannot do on its own (see css/mq-brand.css).
 *
 *   1. A ripple that spreads from the exact point a button was pressed, so a
 *      click is acknowledged where the finger or pointer actually landed.
 *   2. The numbers on the summary cards count up to their value when they
 *      come into view.
 *
 * Both are decoration: nothing on any page depends on this file, and both are
 * skipped entirely when the device asks for reduced motion.
 */
(function () {
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) return;

  // ------------------------------------------------------------- ripple
  var RIPPLE_TARGETS = [
    '.btn', '.mq-btn', '.mq-icon', '.sidebar-nav a', '.menu-toggle', '.sidebar-mobile-toggle',
    '.login-submit-btn', '.next-gradient-btn', '.registration-submit-btn', '.create-account-submit-btn',
    '.mq-gradient-btn', '.mq-login-btn', '.mq-pager-links a'
  ].join(',');

  document.addEventListener('pointerdown', function (event) {
    if (event.button && event.button !== 0) return;
    var target = event.target.closest ? event.target.closest(RIPPLE_TARGETS) : null;
    if (!target || target.disabled || target.hasAttribute('disabled')) return;

    var box = target.getBoundingClientRect();
    var size = Math.max(box.width, box.height) * 2.2;
    var ink = document.createElement('span');
    ink.className = 'mq-ripple';
    ink.setAttribute('aria-hidden', 'true');
    ink.style.width = size + 'px';
    ink.style.height = size + 'px';
    ink.style.left = (event.clientX - box.left - size / 2) + 'px';
    ink.style.top = (event.clientY - box.top - size / 2) + 'px';
    target.appendChild(ink);

    var remove = function () { if (ink.parentNode) ink.parentNode.removeChild(ink); };
    ink.addEventListener('animationend', remove);
    setTimeout(remove, 900);
  }, { passive: true });

  // ------------------------------------------------------------- count-up
  // Only plain figures are animated — "156", "15,498.00", "₱4,600.00", "45.3%".
  // Anything else ("1 / 6", "—", a date) is left exactly as the server wrote it,
  // and every animated number finishes on the server's own text.
  var NUMBER_PATTERN = /^([^\d\-]{0,3})(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%?)$/;

  function countUp(el) {
    var original = el.textContent.trim();
    var match = original.match(NUMBER_PATTERN);
    if (!match) return;
    var target = parseFloat((match[2] + (match[3] || '')).replace(/,/g, ''));
    if (!isFinite(target) || target === 0 || target > 1e9) return;

    var decimals = match[3] ? match[3].length - 1 : 0;
    var grouped = match[2].indexOf(',') !== -1 || target >= 1000;
    var format = function (value) {
      var text = grouped
        ? value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
        : value.toFixed(decimals);
      return match[1] + text + match[4];
    };

    var duration = 900;
    var started = null;
    var step = function (now) {
      if (started === null) started = now;
      var progress = Math.min(1, (now - started) / duration);
      var eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = progress < 1 ? format(target * eased) : original;
      if (progress < 1) window.requestAnimationFrame(step);
    };
    el.textContent = format(0);
    window.requestAnimationFrame(step);
  }

  var figures = document.querySelectorAll('.stat-card strong, .mq-summary-item strong, .mq-kpi strong, .huge-number');
  if (!figures.length) return;

  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        countUp(entry.target);
      });
    }, { threshold: 0.4 });
    figures.forEach(function (el) { observer.observe(el); });
  } else {
    figures.forEach(countUp);
  }
})();
