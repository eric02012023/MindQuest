/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: public/js/main.js
 * Purpose: Shared front-end UI utilities such as modals, confirmation dialogs, and print helpers.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

/**
 * Open a dialog, and make sure it covers the screen rather than part of a page.
 *
 * A dialog is position: fixed, which means "relative to the screen" only while
 * no ancestor has a transform, a filter or a backdrop-filter. Any one of those
 * makes that ancestor the frame instead, and the dialog is centred on it — on
 * the Student Profile it was centred on the whole tall profile and opened below
 * the fold. The shared animations no longer leave a transform behind
 * (css/mq-brand.css, section 5), but a card that lifts on hover does the same.
 * So an open dialog whose overlay does not start at the top-left corner of the
 * screen is moved to <body>, where nothing can trap it. One inside a <form>
 * stays where it is: moving it would take its fields out of that form.
 */
function openModal(modal) {
  if (!modal) return;
  modal.classList.add('is-open');
  if (modal.parentElement === document.body || modal.parentElement.closest('form')) return;
  const box = modal.getBoundingClientRect();
  if (Math.abs(box.top) > 1 || Math.abs(box.left) > 1) document.body.appendChild(modal);
}

document.addEventListener('click', (event) => {
  const modalTargetButton = event.target.closest('[data-modal-target]');
  if (modalTargetButton) {
    const selector = modalTargetButton.getAttribute('data-modal-target');
    openModal(document.querySelector(selector));
  }

  if (event.target.matches('[data-open-logo]') || event.target.closest('[data-open-logo]')) {
    openModal(document.querySelector('[data-logo-modal]'));
  }

  if (event.target.matches('[data-close-modal]') || event.target.closest('[data-close-modal]')) {
    const modal = event.target.closest('.global-modal');
    if (modal) modal.classList.remove('is-open');
  }

  if (event.target.classList.contains('global-modal')) {
    if (!event.target.hasAttribute('data-no-backdrop-close')) {
      event.target.classList.remove('is-open');
    }
  }

  const scrollTarget = event.target.closest('[data-scroll-target]');
  if (scrollTarget) {
    const target = document.querySelector(scrollTarget.getAttribute('data-scroll-target'));
    if (target) target.scrollIntoView({ behavior: 'smooth' });
  }

  // Dropdowns (the bell, the ☰ menu): one open at a time, and a click inside an
  // open one — reading a notification, pressing its × — leaves it open.
  const dropdownButton = event.target.closest('[data-dropdown-toggle]');
  if (dropdownButton) {
    const panel = dropdownButton.parentElement.querySelector('[data-dropdown-panel]');
    document.querySelectorAll('[data-dropdown-panel].is-open').forEach((open) => {
      if (open !== panel) open.classList.remove('is-open');
    });
    if (panel) panel.classList.toggle('is-open');
  } else if (!event.target.closest('[data-dropdown-panel]')) {
    document.querySelectorAll('[data-dropdown-panel].is-open').forEach((panel) => panel.classList.remove('is-open'));
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('[data-dropdown-panel].is-open').forEach((panel) => panel.classList.remove('is-open'));
});

// ============================================================================
// The bell's × — mark one notification read without leaving the page
//
// Sent in the background; the item leaves the list and the count drops. If the
// request cannot be made, the same address is posted as an ordinary form, so it
// still happens — just with a page load.
// ============================================================================
(function () {
  function setCount(next) {
    document.querySelectorAll('[data-notification-count]').forEach((badge) => {
      badge.textContent = next > 99 ? '99+' : String(next);
      badge.hidden = next <= 0;
    });
    document.querySelectorAll('[data-bell-new]').forEach((label) => {
      label.textContent = next > 0 ? `${next} new` : '';
    });
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-bell-dismiss]');
    if (!button) return;
    event.preventDefault();
    const url = button.getAttribute('data-bell-dismiss');
    const item = button.closest('[data-bell-item]');
    button.disabled = true;
    try {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'fetch' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const list = item ? item.parentElement : null;
      if (item) item.remove();
      const left = list ? list.querySelectorAll('[data-bell-item]').length : 0;
      setCount(left);
      const empty = list ? list.querySelector('[data-bell-empty]') : null;
      if (empty) empty.hidden = left > 0;
    } catch (_error) {
      const form = document.createElement('form');
      form.method = 'post';
      form.action = url;
      document.body.appendChild(form);
      form.submit();
    }
  });
})();

document.querySelectorAll('.global-modal[data-force-open="true"]').forEach(openModal);

// ============================================================================
// Side tabs (.mq-vtabs, css/mq-data.css 12c) — one section of a page at a time
//
// The tab list runs down the left; clicking one shows its section and hides the
// rest. The open tab is kept in the address (#payment-history), so a reload, a
// form that comes back to the page, or the Back button lands on it again.
// A section becoming visible fires `mq:vtab-shown` on it, which is when a chart
// inside it can be drawn — a chart drawn while hidden has no size.
// ============================================================================
(function () {
  document.querySelectorAll('[data-vtabs]').forEach((root) => {
    const tabs = Array.from(root.querySelectorAll('[data-vtab]'));
    const panels = Array.from(root.querySelectorAll('[data-vtab-panel]'));
    if (!tabs.length) return;
    const keyOf = (el) => el.getAttribute('data-vtab');

    const show = (wanted, remember) => {
      const key = tabs.some((tab) => keyOf(tab) === wanted) ? wanted : keyOf(tabs[0]);
      tabs.forEach((tab) => {
        const on = keyOf(tab) === key;
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
      });
      panels.forEach((panel) => {
        const on = panel.getAttribute('data-vtab-panel') === key;
        const wasHidden = panel.hidden;
        panel.hidden = !on;
        if (on && wasHidden) panel.dispatchEvent(new CustomEvent('mq:vtab-shown', { bubbles: true }));
      });
      if (remember && window.history && window.history.replaceState) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${key}`);
      }
      return key;
    };

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => {
        show(keyOf(tab), true);
        // On a phone the section is below the row of tabs: bring it into view.
        if (window.innerWidth <= 860) {
          const panel = panels.find((p) => !p.hidden);
          if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
      tab.addEventListener('keydown', (event) => {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
        let next = null;
        if (step) next = tabs[(index + step + tabs.length) % tabs.length];
        else if (event.key === 'Home') next = tabs[0];
        else if (event.key === 'End') next = tabs[tabs.length - 1];
        if (!next) return;
        event.preventDefault();
        next.focus();
        show(keyOf(next), true);
      });
    });

    const fromHash = () => decodeURIComponent((window.location.hash || '').replace(/^#/, ''));
    show(fromHash() || root.getAttribute('data-vtab-default') || keyOf(tabs[0]), false);
    window.addEventListener('hashchange', () => { if (fromHash()) show(fromHash(), false); });
  });
})();


// Function: ensureConfirmModal


// Role: Provides helper logic for this file.


/**
 * The app's own confirmation dialog — never the browser's.
 *
 * window.confirm() shows "mindquesttutorial.com says" in the browser's own grey
 * box, which looks like an error from somewhere else and cannot be styled. Every
 * "are you sure?" goes through this instead:
 *
 *   <form data-confirm-message="Submit your answers?"
 *         data-confirm-title="Submit assessment?"     (optional)
 *         data-confirm-ok="Submit"                    (optional, the OK label)
 *         data-confirm-unanswered>                    (optional, see below)
 *
 * data-confirm-unanswered counts the questions left blank (inputs named
 * answer_<id>) and says so in the dialog, so a student is not surprised by a
 * blank marked wrong. Scripts can ask the same dialog with mqConfirm().
 */
function ensureConfirmModal() {
  let modal = document.querySelector('#global-confirm-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.className = 'global-modal global-confirm-modal';
  modal.id = 'global-confirm-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'global-confirm-title');
  modal.innerHTML = `
    <div class="global-modal-card small">
      <button type="button" class="modal-close" data-close-modal aria-label="Close">&times;</button>
      <h3 id="global-confirm-title">Confirm Action</h3>
      <p id="global-confirm-message">Are you sure?</p>
      <p id="global-confirm-extra" class="confirm-extra" hidden></p>
      <div class="confirm-actions">
        <button type="button" class="btn btn-secondary" data-close-modal id="global-confirm-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="global-confirm-ok">Accept</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

let confirmAction = null;

/**
 * Ask the app's confirmation dialog.
 * @param {{title?: string, message: string, extra?: string, ok?: string, cancel?: string}} options
 * @param {() => void} onConfirm
 */
function mqConfirm(options, onConfirm) {
  const modal = ensureConfirmModal();
  const opts = typeof options === 'string' ? { message: options } : (options || {});
  modal.querySelector('#global-confirm-title').textContent = opts.title || 'Confirm Action';
  modal.querySelector('#global-confirm-message').textContent = opts.message || 'Are you sure?';
  const extra = modal.querySelector('#global-confirm-extra');
  extra.textContent = opts.extra || '';
  extra.hidden = !opts.extra;
  modal.querySelector('#global-confirm-ok').textContent = opts.ok || 'Accept';
  modal.querySelector('#global-confirm-cancel').textContent = opts.cancel || 'Cancel';
  confirmAction = () => {
    modal.classList.remove('is-open');
    if (typeof onConfirm === 'function') onConfirm();
  };
  openModal(modal);
  const okButton = modal.querySelector('#global-confirm-ok');
  if (okButton && okButton.focus) okButton.focus();
}
window.mqConfirm = mqConfirm;

/** Questions in a form left with no answer: radio groups unticked, text left empty. */
function countUnanswered(form) {
  const groups = new Map();
  form.querySelectorAll('[name^="answer_"]').forEach((field) => {
    const name = field.getAttribute('name');
    const answered = field.type === 'radio' || field.type === 'checkbox'
      ? field.checked
      : String(field.value || '').trim() !== '';
    groups.set(name, (groups.get(name) || false) || answered);
  });
  let blank = 0;
  groups.forEach((answered) => { if (!answered) blank += 1; });
  return blank;
}

document.addEventListener('click', (event) => {
  const confirmOpenButton = event.target.closest('[data-confirm-open]');
  if (confirmOpenButton) {
    event.preventDefault();
    mqConfirm({
      title: confirmOpenButton.getAttribute('data-confirm-title') || undefined,
      message: confirmOpenButton.getAttribute('data-confirm-message') || 'Continue?',
      ok: confirmOpenButton.getAttribute('data-confirm-ok') || undefined
    }, () => {
      document.querySelectorAll('.global-modal.is-open').forEach((item) => item.classList.remove('is-open'));
      openModal(document.querySelector(confirmOpenButton.getAttribute('data-confirm-open')));
    });
  }

  const ok = event.target.closest('#global-confirm-ok');
  if (ok && confirmAction) {
    const action = confirmAction;
    confirmAction = null;
    action();
  }
  if (event.target.closest('#global-confirm-modal [data-close-modal]')) confirmAction = null;
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // Escape is Cancel on the app's own dialogs, as it is on the browser's.
  ['#global-confirm-modal', '#global-simple-modal'].forEach((selector) => {
    const modal = document.querySelector(`${selector}.is-open`);
    if (modal) modal.classList.remove('is-open');
  });
  confirmAction = null;
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const message = form.getAttribute('data-confirm-message');
  if (!message || form.dataset.confirmed === 'true') return;
  event.preventDefault();
  let extra = '';
  if (form.hasAttribute('data-confirm-unanswered')) {
    const blank = countUnanswered(form);
    if (blank) extra = `You have ${blank} unanswered question${blank === 1 ? '' : 's'}. A question left blank is marked wrong.`;
  }
  mqConfirm({
    title: form.getAttribute('data-confirm-title') || undefined,
    message,
    extra,
    ok: form.getAttribute('data-confirm-ok') || undefined
  }, () => {
    form.dataset.confirmed = 'true';
    form.requestSubmit();
    setTimeout(() => { form.dataset.confirmed = 'false'; }, 0);
  });
});

document.querySelectorAll('.billing-edit-form').forEach((form) => {
  const full = form.querySelector('[data-full-bill]');
  const partial = form.querySelector('[data-partial-payment]');
  const settlement = form.querySelector('[data-for-settlement]');
  const update = () => {
    const fullValue = Number(full?.value || 0);
    const partialValue = Number(partial?.value || 0);
    const total = Math.max(fullValue - partialValue, 0);
    if (settlement) settlement.value = total.toFixed(2);
  };
  full?.addEventListener('input', update);
  partial?.addEventListener('input', update);
  update();
});


// Function: printBillModal


// Role: Provides helper logic for this file.


function printBillModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  const content = modal.querySelector('.bill-print-area');
  if (!content) return;
  const clone = content.cloneNode(true);
  clone.querySelectorAll('.print-hide').forEach((node) => node.remove());
  const printWindow = window.open('', '_blank', 'width=900,height=700');
  printWindow.document.write(`<!doctype html><html><head><title>Print Bill</title><style>
    body{font-family:Arial,sans-serif;padding:24px;color:#111827}
    .bill-print-area{max-width:900px;margin:0 auto}
    .soa-header-block{margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #d1d5db}
    .plain-soa-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px}
    .plain-soa-row{padding:6px 0;border-bottom:1px solid #f0f0f0}
    .plain-soa-row span{display:block;font-size:12px;color:#6b7280;margin-bottom:4px}
    .plain-soa-row strong{font-size:14px;color:#111827}
  </style></head><body>${clone.outerHTML}</body></html>`);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
  setTimeout(() => printWindow.close(), 300);
}

document.addEventListener('input', (event) => {
  const birthInput = event.target.closest('[data-auto-age-birth]');
  if (birthInput) {
    const container = birthInput.closest('form') || document;
    const ageInput = container.querySelector('[data-auto-age-target]');
    if (ageInput && birthInput.value) {
      const birth = new Date(birthInput.value);
      if (!Number.isNaN(birth.getTime())) {
        const today = new Date();
        let age = today.getFullYear() - birth.getFullYear();
        const m = today.getMonth() - birth.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age -= 1;
        ageInput.value = age >= 0 ? age : '';
      }
    }
  }
});

// ============================================================================
// Never more than is owed
//
// An amount field marked data-balance="3600.00" warns the moment the amount
// typed is larger than the balance — "₱4,000.00 is more than the remaining
// balance of ₱3,600.00 …" — and the form will not submit until it is fixed
// (setCustomValidity). The server refuses the same thing (lib/billing.js,
// overpaymentError), so this only saves a round trip and says it plainly.
// data-balance-audience="student" words it for the student.
// Delegated, so a dialog fetched later (Student Bill) is covered too.
// ============================================================================
(function () {
  function peso(value) {
    return '₱' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function checkBalance(input) {
    var balance = Number(input.getAttribute('data-balance'));
    if (!isFinite(balance)) return;
    var raw = String(input.value || '').trim();
    var amount = Number(raw);
    var hint = input.parentElement.querySelector('[data-balance-warning]');
    if (!hint) {
      hint = document.createElement('small');
      hint.className = 'mq-field-hint mq-field-hint-error';
      hint.setAttribute('data-balance-warning', '');
      hint.setAttribute('role', 'alert');
      hint.hidden = true;
      input.insertAdjacentElement('afterend', hint);
    }
    var forStudent = input.getAttribute('data-balance-audience') === 'student';
    var message = '';
    if (raw && isFinite(amount) && Math.round(amount * 100) > Math.round(balance * 100)) {
      if (balance > 0) {
        message = forStudent
          ? peso(amount) + ' is more than your remaining balance of ' + peso(balance) + '. Please enter the exact amount: ' + peso(balance) + '.'
          : peso(amount) + ' is more than the remaining balance of ' + peso(balance) + '. Enter the exact amount (' + peso(balance) + ') or less.';
      } else {
        message = 'This account is already fully paid — there is nothing left to pay.';
      }
    }
    input.setCustomValidity(message);
    hint.textContent = message;
    hint.hidden = !message;
  }

  document.addEventListener('input', function (event) {
    var input = event.target && event.target.closest ? event.target.closest('input[data-balance]') : null;
    if (input) checkBalance(input);
  });
  // A form opened with an amount already over (a stale slip) says so at once.
  document.addEventListener('focusin', function (event) {
    var input = event.target && event.target.closest ? event.target.closest('input[data-balance]') : null;
    if (input) checkBalance(input);
  });
  document.querySelectorAll('input[data-balance]').forEach(checkBalance);
  window.mqCheckBalance = checkBalance;
})();

// Profile pages: a photo picked with "Change photo" shows in the avatar at
// once, so the person sees it before they press Save.
document.addEventListener('change', (event) => {
  const input = event.target.closest && event.target.closest('[data-avatar-input]');
  const file = input?.files?.[0];
  if (!file || !/^image\//.test(file.type)) return;
  const slot = document.querySelector('[data-avatar-preview]');
  if (slot) {
    const current = slot.querySelector('.mq-avatar');
    const preview = document.createElement('img');
    preview.className = current ? current.className.replace('mq-avatar-initials', '').trim() : 'mq-avatar mq-avatar-xl';
    preview.alt = 'New profile photo';
    preview.src = URL.createObjectURL(file);
    if (current) current.replaceWith(preview);
    else slot.appendChild(preview);
  }
  const note = input.form?.querySelector('[data-avatar-note]');
  if (note) {
    note.textContent = `New photo chosen (${file.name}) — press Save to keep it.`;
    note.classList.add('is-ready');
  }
});

document.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-profile-edit-toggle]');
  if (toggle) {
    const form = document.querySelector(toggle.getAttribute('data-profile-edit-toggle'));
    form?.querySelectorAll('[data-profile-editable]').forEach((input) => {
      if (input.matches('[data-multi-select]')) {
        const trigger = input.querySelector('[data-multi-select-trigger]');
        const checkboxes = input.querySelectorAll('input[type="checkbox"]');
        const isDisabled = trigger?.disabled;
        if (trigger) trigger.disabled = !isDisabled;
        checkboxes.forEach((checkbox) => {
          checkbox.disabled = !isDisabled;
        });
        return;
      }
      if (input.tagName === 'SELECT') {
        input.disabled = !input.disabled;
      } else if (input.type === 'file') {
        input.disabled = !input.disabled;
      } else {
        input.readOnly = !input.readOnly;
      }
    });
  }

  const multiTrigger = event.target.closest('[data-multi-select-trigger]');
  if (multiTrigger && !multiTrigger.disabled) {
    const container = multiTrigger.closest('[data-multi-select]');
    document.querySelectorAll('[data-multi-select].is-open').forEach((item) => {
      if (item !== container) item.classList.remove('is-open');
    });
    container?.classList.toggle('is-open');
    return;
  }

  if (!event.target.closest('[data-multi-select]')) {
    document.querySelectorAll('[data-multi-select].is-open').forEach((item) => item.classList.remove('is-open'));
  }
});

document.querySelectorAll('[data-multi-select]').forEach((container) => {
  const triggerLabel = container.querySelector('[data-multi-select-label]');
  const hiddenBranchInput = container.parentElement?.querySelector('[data-primary-branch-input]');
  const hiddenYearInput = container.parentElement?.querySelector('[data-year-level-display-input]');
  const sync = () => {
    const checked = [...container.querySelectorAll('input[type="checkbox"]:checked')];
    const values = checked.map((input) => input.value);
    const labels = checked.map((input) => (input.parentElement?.textContent || '').trim()).filter(Boolean);
    if (triggerLabel) triggerLabel.textContent = labels.join(', ') || container.getAttribute('data-placeholder') || 'Select option(s)';
    if (hiddenBranchInput && checked.length) hiddenBranchInput.value = values[0];
    if (hiddenYearInput) hiddenYearInput.value = values.join(', ');
  };
  container.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => checkbox.addEventListener('change', sync));
  sync();
});

document.querySelectorAll('[data-assessment-builder]').forEach((form) => {
  const studentSelect = form.querySelector('select[name="assigned_student_id"]');
  const branchInput = form.querySelector('[data-assessment-branch-name]');
  const syncBranch = () => {
    const opt = studentSelect?.selectedOptions?.[0];
    if (branchInput && opt) branchInput.value = opt.getAttribute('data-branch-name') || '';
  };
  studentSelect?.addEventListener('change', syncBranch);
  syncBranch();
});

document.addEventListener('click', async (event) => { const phone = event.target.closest('[data-copy-phone]'); if (phone) { const value = phone.getAttribute('data-copy-phone'); try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); } } catch (_) {} showSimpleModal('Phone number', `Copied: ${value}`); } });

// Function: showSimpleModal

// Role: Provides helper logic for this file.

function showSimpleModal(title, message) {
  let modal = document.querySelector('#global-simple-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'global-modal';
    modal.id = 'global-simple-modal';
    modal.innerHTML = `
      <div class="global-modal-card small">
        <button type="button" class="modal-close" data-close-modal>&times;</button>
        <h3 id="global-simple-title"></h3>
        <p id="global-simple-message"></p>
        <div class="confirm-actions"><button type="button" class="btn btn-primary" data-close-modal>OK</button></div>
      </div>`;
    document.body.appendChild(modal);
  }
  modal.querySelector('#global-simple-title').textContent = title || 'Notice';
  modal.querySelector('#global-simple-message').textContent = message || '';
  modal.classList.add('is-open');
}

/** The app's own message box, for scripts — in place of the browser's alert(). */
window.mqAlert = function mqAlert(message, title) {
  showSimpleModal(title || 'Notice', message);
};


// Dashboard sidebar mobile controls

(function () {
  const body = document.body;
  const sidebar = document.querySelector('[data-dashboard-sidebar]');
  const openButton = document.querySelector('[data-sidebar-open]');
  const closeButton = document.querySelector('[data-sidebar-close]');
  const overlay = document.querySelector('[data-sidebar-overlay]');

  if (!sidebar || !openButton || !closeButton || !overlay) return;

  const closeSidebar = () => body.classList.remove('dashboard-sidebar-open');
  const openSidebar = () => body.classList.add('dashboard-sidebar-open');

  openButton.addEventListener('click', openSidebar);
  closeButton.addEventListener('click', closeSidebar);
  overlay.addEventListener('click', closeSidebar);

  sidebar.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 1100) closeSidebar();
    });
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 1100) closeSidebar();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSidebar();
  });
})();

// ============================================================================
// Tables that fit a phone
//
// A plain <table> keeps its desktop width on a phone and scrolls sideways, so
// only the first two or three columns are on screen and the rest — a status, a
// date, the button to open the record — are simply not seen. On narrow screens
// the CSS (ui-polish.css, "Tables on a phone") lays each row out as a small
// record instead; this copies every column heading onto its cells so each value
// is still labelled once the header row is gone.
//
// A table opts out with data-no-stack. Rows whose only cell spans the whole
// table (an empty-state line) are left unlabelled.
// ============================================================================
(function () {
  document.querySelectorAll('.table-wrap table').forEach((table) => {
    if (table.hasAttribute('data-no-stack')) return;
    const headings = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim());
    if (!headings.length) return;
    table.querySelectorAll('tbody tr').forEach((row) => {
      let column = 0;
      Array.from(row.children).forEach((cell) => {
        const span = Number(cell.getAttribute('colspan')) || 1;
        if (span < headings.length && !cell.hasAttribute('data-label') && headings[column]) {
          cell.setAttribute('data-label', headings[column]);
        }
        column += span;
      });
    });
    table.classList.add('is-stackable');
  });
})();
