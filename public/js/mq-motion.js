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

  var figures = document.querySelectorAll('.stat-card strong, .mq-summary-item strong, .mq-kpi strong, .huge-number, .mq-profile-stat strong, .mq-hero-stat strong');
  if (figures.length) {
    if ('IntersectionObserver' in window) {
      var figureObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          figureObserver.unobserve(entry.target);
          countUp(entry.target);
        });
      }, { threshold: 0.4 });
      figures.forEach(function (el) { figureObserver.observe(el); });
    } else {
      figures.forEach(countUp);
    }
  }

  // ------------------------------------------------------------- scroll reveal
  // Cards, rows and landing sections that start BELOW the fold rise in as they
  // are scrolled to. Anything already on screen is left alone, so nothing the
  // reader can see ever disappears. Inside a card that will be revealed as a
  // whole, its rows are not revealed separately.
  var REVEAL_TARGETS = [
    '.mq-panel', '.panel-card', '.list-card', '.stat-card', '.mq-summary', '.mq-toolbar',
    '.subject-list-card', '.mq-row', '.table-wrap tbody tr', '.mq-item', '.mq-kpi',
    '.mq-landing-main .mq-copy-block', '.mq-landing-main .mq-image-block', '.step-item',
    '.mq-feature-grid article', '.mq-gradient-card', '.branch-grid article',
    '.mq-centered-title', '.mq-centered-subtitle', '.mq-centered-green', '.mq-card', '.mq-student-card'
  ].join(',');

  if ('IntersectionObserver' in window) {
    var fold = window.innerHeight * 0.92;
    var pending = [];
    document.querySelectorAll(REVEAL_TARGETS).forEach(function (el) {
      if (pending.length >= 240) return;
      if (el.closest('.global-modal, .mq-reveal')) return;
      var box = el.getBoundingClientRect();
      if (!box.height || box.top < fold) return;
      el.classList.add('mq-reveal');
      pending.push(el);
    });

    var finish = function (el) {
      el.classList.remove('mq-reveal', 'is-visible');
      el.style.removeProperty('--mq-reveal-delay');
    };
    var revealObserver = new IntersectionObserver(function (entries) {
      var batch = 0;
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        revealObserver.unobserve(el);
        // Things that come into view together follow one another.
        el.style.setProperty('--mq-reveal-delay', Math.min(batch++ * 0.05, 0.3) + 's');
        el.classList.add('is-visible');
        el.addEventListener('transitionend', function done(event) {
          if (event.target !== el || event.propertyName !== 'opacity') return;
          el.removeEventListener('transitionend', done);
          finish(el);
        });
        setTimeout(function () { finish(el); }, 1400);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 });
    pending.forEach(function (el) { revealObserver.observe(el); });
  }

  // ------------------------------------------------------------- spotlight and tilt
  // A soft light follows the pointer over a card; the count cards also tilt
  // toward it. Mouse and pen only — on a touch screen there is no hover.
  var SPOT_TARGETS = '.stat-card, .list-card, .subject-list-card, .mq-kpi, .mini-bubble, '
    + '.mq-summary-item, .mq-gradient-card, .step-item, .mq-feature-grid article, .branch-grid article, '
    + '.mq-profile-stat, .mq-tutor-feature, .mq-student-card';
  var TILT_TARGETS = '.stat-card, .mq-kpi, .step-item, .mq-feature-grid article';
  // The welcome banner is followed too, for its illustration's parallax.
  var TRACK_TARGETS = SPOT_TARGETS + ', .mq-hero';
  var canHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;

  if (canHover) {
    var active = null;
    var frame = 0;
    var lastEvent = null;

    var paint = function () {
      frame = 0;
      if (!active || !lastEvent) return;
      var box = active.getBoundingClientRect();
      var x = lastEvent.clientX - box.left;
      var y = lastEvent.clientY - box.top;
      active.style.setProperty('--mq-mx', x + 'px');
      active.style.setProperty('--mq-my', y + 'px');
      if (active.classList.contains('mq-tilt')) {
        active.style.setProperty('--mq-rx', ((0.5 - y / box.height) * 7).toFixed(2) + 'deg');
        active.style.setProperty('--mq-ry', ((x / box.width - 0.5) * 9).toFixed(2) + 'deg');
      }
      if (active.classList.contains('mq-hero')) {
        active.style.setProperty('--mq-px', ((x / box.width - 0.5) * 16).toFixed(1) + 'px');
        active.style.setProperty('--mq-py', ((y / box.height - 0.5) * 12).toFixed(1) + 'px');
      }
    };

    document.addEventListener('pointerover', function (event) {
      if (event.pointerType === 'touch') return;
      var card = event.target.closest ? event.target.closest(TRACK_TARGETS) : null;
      if (!card || card === active) return;
      if (card.matches(SPOT_TARGETS)) card.classList.add('mq-has-spot');
      if (card.matches(TILT_TARGETS)) card.classList.add('mq-tilt');
      active = card;
    }, { passive: true });

    document.addEventListener('pointermove', function (event) {
      if (!active) return;
      lastEvent = event;
      if (!frame) frame = window.requestAnimationFrame(paint);
    }, { passive: true });

    document.addEventListener('pointerout', function (event) {
      if (!active) return;
      if (event.relatedTarget && active.contains(event.relatedTarget)) return;
      ['--mq-rx', '--mq-ry', '--mq-px', '--mq-py'].forEach(function (name) { active.style.removeProperty(name); });
      active = null;
    }, { passive: true });
  }

  // ------------------------------------------------------------- the bell
  // Student and tutor: the bell rings when something new is waiting.
  document.querySelectorAll('.notification-pill').forEach(function (pill) {
    var count = pill.querySelector('.count');
    if (count && Number(count.textContent.trim()) > 0) pill.classList.add('has-new');
  });

  // ------------------------------------------------------------- landing header
  var header = document.querySelector('.mq-sticky-header');
  if (header) {
    var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 12); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
