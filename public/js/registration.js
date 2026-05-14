/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: public/js/registration.js
 * Purpose: Front-end registration validation and dynamic form behavior for age, grade selection, password validation, and duplicate-name checks.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

const yearToGradeMap = {
  'Pre School Level': ['Kinder 1', 'Kinder 2'],
  'Primary Level': ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'],
  'Junior High Level': ['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10'],
  'Senior High Level': ['Grade 11', 'Grade 12']
};

// Function: computeAge

// Role: Provides helper logic for this file.

function computeAge(value) {
  if (!value) return '';
  const birthDate = new Date(value);
  if (Number.isNaN(birthDate.getTime())) return '';
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age -= 1;
  }
  return age >= 0 ? age : '';
}

// Function: showValidationMessage

// Role: Provides helper logic for this file.

function showValidationMessage(message) {
  if (typeof showSimpleModal === 'function') {
    showSimpleModal('Validation', message);
    return;
  }
  window.alert(message);
}

// Function: isStrongPassword

// Role: Provides helper logic for this file.

function isStrongPassword(value) {
  const password = String(value || '');
  return password.length >= 8
    && /[A-Z]/.test(password)
    && /[a-z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

document.querySelectorAll('[data-registration-form]').forEach((form) => {
  const yearLevel = form.querySelector('[data-year-level]');
  const gradeLevel = form.querySelector('[data-grade-level]');
  const birthDateInput = form.querySelector('[data-birthdate]');
  const ageInput = form.querySelector('[data-age]');
  const previewInput = form.querySelector('[data-image-preview-input]');
  const previewImage = form.querySelector('[data-upload-preview-image]');
  const previewPlaceholder = form.querySelector('.upload-placeholder');
  const previewPlus = form.querySelector('.upload-plus');
  const registrationType = form.getAttribute('data-registration-type') || 'student';
  const passwordInput = form.querySelector('input[name="password"]');
  const confirmPasswordInput = form.querySelector('input[name="confirm_password"]');

  // Function: fillGradeOptions

  // Role: Provides helper logic for this file.

  function fillGradeOptions() {
    if (!yearLevel || !gradeLevel) return;
    const options = yearToGradeMap[yearLevel.value] || [];
    const selectedValue = gradeLevel.dataset.selectedValue || gradeLevel.value || '';
    gradeLevel.innerHTML = `<option value="" disabled>Select grade level</option>` + options.map((value) => {
      const selected = selectedValue === value ? ' selected' : '';
      return `<option value="${value}"${selected}>${value}</option>`;
    }).join('');
    if (!selectedValue) gradeLevel.selectedIndex = 0;
  }

  // Function: fillAge

  // Role: Provides helper logic for this file.

  function fillAge() {
    if (!birthDateInput || !ageInput) return;
    ageInput.value = computeAge(birthDateInput.value);
  }

  birthDateInput?.addEventListener('change', fillAge);
  previewInput?.addEventListener('change', () => {
    const file = previewInput.files && previewInput.files[0];
    if (!file || !previewImage) return;
    previewImage.src = URL.createObjectURL(file);
    previewImage.classList.add('has-image');
    previewPlaceholder?.classList.add('is-hidden');
    previewPlus?.classList.add('is-hidden');
  });
  yearLevel?.addEventListener('change', () => {
    gradeLevel.dataset.selectedValue = '';
    fillGradeOptions();
  });

  fillGradeOptions();
  fillAge();

  form.addEventListener('submit', (event) => {
    const selectedSubjects = form.querySelectorAll('[data-subject-checkbox]:checked').length;
    const age = Number(ageInput?.value || computeAge(birthDateInput?.value) || 0);
    const selectedTutorYearLevel = form.querySelector('[data-tutor-year-level-select]')?.value || '';
    const selectedGradeLevel = gradeLevel?.value || '';
    const selectedYearLevel = yearLevel?.value || '';

    if (!selectedSubjects) {
      event.preventDefault();
      showValidationMessage('Please select at least one subject field before submitting.');
      return;
    }

    if (registrationType === 'student') {
      if (!selectedYearLevel || !selectedGradeLevel) {
        event.preventDefault();
        showValidationMessage('Please select both year level and grade level.');
        return;
      }
      if (age < 3) {
        event.preventDefault();
        showValidationMessage('Learner registration is only allowed for 3 years old and above.');
        return;
      }
    }

    if (registrationType === 'tutor') {
      if (age < 18) {
        event.preventDefault();
        showValidationMessage('Tutor registration is only allowed for 18 years old and above.');
        return;
      }
      if (!selectedTutorYearLevel) {
        event.preventDefault();
        showValidationMessage('Please select a year level.');
        return;
      }
    }

    if (!isStrongPassword(passwordInput?.value || '')) {
      event.preventDefault();
      showValidationMessage('Password must be at least 8 characters and include uppercase, lowercase, number, and special character.');
      return;
    }

    if ((passwordInput?.value || '') !== (confirmPasswordInput?.value || '')) {
      event.preventDefault();
      showValidationMessage('Password and confirm password must match.');
    }
  });
});

document.querySelectorAll('[data-registration-form]').forEach((form) => {
  const first = form.querySelector('input[name="first_name"]');
  const middle = form.querySelector('input[name="middle_name"]');
  const last = form.querySelector('input[name="last_name"]');
  if (!first || !last) return;
  let note = document.createElement('p');
  note.className = 'name-check-note';
  note.style.margin = '0';
  note.style.fontWeight = '700';
  note.style.color = '#b91c1c';
  const wrap = form.querySelector('.registration-design-header div') || form;
  wrap.appendChild(note);
  let timer;
  let isDuplicate = false;
  const check = async () => {
    const firstName = first.value.trim();
    const middleName = middle?.value.trim() || '';
    const lastName = last.value.trim();
    if (!firstName || !lastName) {
      note.textContent = '';
      isDuplicate = false;
      return;
    }
    try {
      const params = new URLSearchParams({ first_name: firstName, middle_name: middleName, last_name: lastName });
      const response = await fetch('/register/check-name?' + params.toString());
      if (!response.ok) { isDuplicate = false; note.textContent = ''; return; }
      const data = await response.json();
      isDuplicate = data.exists === true;
      note.textContent = isDuplicate ? 'This complete name already exists and cannot be used.' : '';
    } catch (_err) {
      // Network error — do not block registration
      isDuplicate = false;
      note.textContent = '';
    }
  };
  [first, middle, last].filter(Boolean).forEach((el) => el.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(check, 500);
  }));
  form.addEventListener('submit', (event) => {
    if (isDuplicate) event.preventDefault();
  });
});

document.querySelectorAll('[data-password-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.getAttribute('data-password-toggle');
    const input = document.querySelector(`[data-password-toggle-target="${key}"]`);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });
});
