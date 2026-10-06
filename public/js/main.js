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

  const dropdownButton = event.target.closest('[data-dropdown-toggle]');
  if (dropdownButton) {
    const panel = dropdownButton.parentElement.querySelector('[data-dropdown-panel]');
    if (panel) panel.classList.toggle('is-open');
  } else {
    document.querySelectorAll('[data-dropdown-panel].is-open').forEach((panel) => panel.classList.remove('is-open'));
  }
});

document.querySelectorAll('.global-modal[data-force-open="true"]').forEach(openModal);


// Function: ensureConfirmModal


// Role: Provides helper logic for this file.


function ensureConfirmModal() {
  let modal = document.querySelector('#global-confirm-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.className = 'global-modal global-confirm-modal';
  modal.id = 'global-confirm-modal';
  modal.innerHTML = `
    <div class="global-modal-card small">
      <button type="button" class="modal-close" data-close-modal>&times;</button>
      <h3>Confirm Action</h3>
      <p id="global-confirm-message">Are you sure?</p>
      <div class="confirm-actions">
        <button type="button" class="btn btn-secondary" data-close-modal>Cancel</button>
        <button type="button" class="btn btn-primary" id="global-confirm-ok">Accept</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

let confirmAction = null;
document.addEventListener('click', (event) => {
  const confirmOpenButton = event.target.closest('[data-confirm-open]');
  if (confirmOpenButton) {
    event.preventDefault();
    const modal = ensureConfirmModal();
    modal.querySelector('#global-confirm-message').textContent = confirmOpenButton.getAttribute('data-confirm-message') || 'Continue?';
    confirmAction = () => {
      modal.classList.remove('is-open');
      document.querySelectorAll('.global-modal.is-open').forEach((item) => item.classList.remove('is-open'));
      openModal(document.querySelector(confirmOpenButton.getAttribute('data-confirm-open')));
    };
    modal.classList.add('is-open');
  }

  const ok = event.target.closest('#global-confirm-ok');
  if (ok && confirmAction) {
    confirmAction();
    confirmAction = null;
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const message = form.getAttribute('data-confirm-message');
  if (!message || form.dataset.confirmed === 'true') return;
  event.preventDefault();
  const modal = ensureConfirmModal();
  modal.querySelector('#global-confirm-message').textContent = message;
  confirmAction = () => {
    modal.classList.remove('is-open');
    form.dataset.confirmed = 'true';
    form.requestSubmit();
    setTimeout(() => { form.dataset.confirmed = 'false'; }, 0);
  };
  modal.classList.add('is-open');
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

// ============================================================================
// Real-time Assessment Request Notifications (Socket.IO)
// ============================================================================
(function () {
  if (typeof io === 'undefined' || !window.mqtcUser) return;
  const socket = io();
  socket.emit('register-user', window.mqtcUser.id);

  // Create toast notification container
  function ensureToastContainer() {
    let container = document.getElementById('mqtc-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'mqtc-toast-container';
      container.style.cssText = 'position:fixed;top:80px;right:24px;z-index:9999;display:grid;gap:12px;max-width:380px;width:100%;pointer-events:none;';
      document.body.appendChild(container);
    }
    return container;
  }

  // Show a toast notification
  function showToast(title, message, type) {
    const container = ensureToastContainer();
    const toast = document.createElement('div');
    const bgColor = type === 'success' ? 'linear-gradient(135deg, #059669, #10b981)' :
                     type === 'warning' ? 'linear-gradient(135deg, #d97706, #f59e0b)' :
                     type === 'info' ? 'linear-gradient(135deg, #0284c7, #38bdf8)' :
                     'linear-gradient(135deg, #dc2626, #f87171)';
    const icon = type === 'success' ? '✅' : type === 'warning' ? '⏳' : type === 'info' ? '📋' : '❌';

    toast.style.cssText = `
      pointer-events:auto;background:${bgColor};color:#fff;padding:16px 20px;border-radius:16px;
      box-shadow:0 12px 32px rgba(0,0,0,.18);backdrop-filter:blur(8px);
      animation:mqtcToastIn .35s ease forwards;cursor:pointer;
      border:1px solid rgba(255,255,255,.2);
    `;
    toast.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:12px;">
        <span style="font-size:22px;line-height:1;">${icon}</span>
        <div style="flex:1;min-width:0;">
          <strong style="display:block;margin-bottom:4px;font-size:14px;">${title}</strong>
          <p style="margin:0;font-size:13px;opacity:.92;line-height:1.4;word-wrap:break-word;">${message}</p>
        </div>
        <span style="font-size:18px;opacity:.7;cursor:pointer;line-height:1;" onclick="this.parentElement.parentElement.remove()">✕</span>
      </div>
    `;
    container.appendChild(toast);

    // Update bell count
    const bellCount = document.querySelector('.notification-pill .count');
    if (bellCount) {
      const current = parseInt(bellCount.textContent, 10) || 0;
      bellCount.textContent = current + 1;
    }

    // Auto-dismiss after 8 seconds
    setTimeout(() => {
      toast.style.animation = 'mqtcToastOut .3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, 8000);

    // Click to dismiss
    toast.addEventListener('click', () => {
      toast.style.animation = 'mqtcToastOut .3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    });
  }

  // Add toast animation styles
  if (!document.getElementById('mqtc-toast-styles')) {
    const style = document.createElement('style');
    style.id = 'mqtc-toast-styles';
    style.textContent = `
      @keyframes mqtcToastIn {
        from { opacity:0; transform:translateX(40px) scale(.95); }
        to   { opacity:1; transform:translateX(0) scale(1); }
      }
      @keyframes mqtcToastOut {
        from { opacity:1; transform:translateX(0) scale(1); }
        to   { opacity:0; transform:translateX(40px) scale(.95); }
      }
    `;
    document.head.appendChild(style);
  }

  // Student receives: tutor approved/declined their assessment request
  socket.on('assessment-request-update', (data) => {
    if (data.status === 'accepted') {
      showToast('Assessment Approved! ✓', `${data.tutorName} approved your assessment request. You can now take the assessment!`, 'success');
    } else {
      showToast('Assessment Request Declined', data.message || `${data.tutorName} declined your assessment request.`, 'error');
    }
    // Play notification sound
    try { new Audio('/assets/notification.mp3').play().catch(() => {}); } catch (e) {}
  });

  // Tutor receives: student submitted a new assessment request
  socket.on('new-assessment-request', (data) => {
    showToast('New Assessment Request', data.message || `${data.studentName} has requested assessment approval.`, 'info');
    // Play notification sound
    try { new Audio('/assets/notification.mp3').play().catch(() => {}); } catch (e) {}
  });
})();
