/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: public/js/main.js
 * Purpose: Shared front-end UI utilities such as modals, confirmation dialogs, and print helpers.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

document.addEventListener('click', (event) => {
  const modalTargetButton = event.target.closest('[data-modal-target]');
  if (modalTargetButton) {
    const selector = modalTargetButton.getAttribute('data-modal-target');
    const modal = document.querySelector(selector);
    if (modal) modal.classList.add('is-open');
  }

  if (event.target.matches('[data-open-logo]') || event.target.closest('[data-open-logo]')) {
    const modal = document.querySelector('[data-logo-modal]');
    if (modal) modal.classList.add('is-open');
  }

  if (event.target.matches('[data-close-modal]') || event.target.closest('[data-close-modal]')) {
    const modal = event.target.closest('.global-modal');
    if (modal) modal.classList.remove('is-open');
  }

  if (event.target.classList.contains('global-modal')) {
    event.target.classList.remove('is-open');
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

document.querySelectorAll('.global-modal[data-force-open="true"]').forEach((modal) => {
  modal.classList.add('is-open');
});


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
      const target = document.querySelector(confirmOpenButton.getAttribute('data-confirm-open'));
      if (target) target.classList.add('is-open');
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
