/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: public/js/dashboard.js
 * Purpose: Front-end dashboard utilities such as calendar rendering and multiselect controls.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

// Function: renderCalendar

// Role: Provides helper logic for this file.

function renderCalendar(target) {
  if (!target) return;

  const role = target.dataset.calendarRole || (document.body.className.includes('tutor-') ? 'tutor' : 'student');
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date();
  let viewDate = new Date(today.getFullYear(), today.getMonth(), 1);

  const getSummaryCards = (date) => {
    const totalDays = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    if (role === 'tutor') {
      return [
        { label: 'Teaching days', value: Math.max(12, Math.min(24, totalDays - 6)) },
        { label: 'Check-ins', value: Math.max(4, Math.min(10, Math.ceil(totalDays / 4))) },
        { label: 'This week', value: ['Plan review', 'Student updates', 'Attendance'][(date.getMonth() + date.getFullYear()) % 3] }
      ];
    }
    return [
      { label: 'Study days', value: Math.max(14, Math.min(26, totalDays - 4)) },
      { label: 'Focus blocks', value: Math.max(4, Math.min(9, Math.ceil(totalDays / 5))) },
      { label: 'Reminder', value: ['Review notes', 'Submit tasks', 'Ask tutor'][(date.getMonth() + date.getFullYear()) % 3] }
    ];
  };

  const buildDayCell = (dayNumber, muted = false) => {
    const cellDate = new Date(viewDate.getFullYear(), viewDate.getMonth(), dayNumber);
    const isToday = dayNumber === today.getDate()
      && viewDate.getMonth() === today.getMonth()
      && viewDate.getFullYear() === today.getFullYear()
      && !muted;
    const isWeekend = cellDate.getDay() === 0 || cellDate.getDay() === 6;
    const pill = isToday
      ? (role === 'tutor' ? 'Priority' : 'Today')
      : isWeekend
        ? (role === 'tutor' ? 'Prep' : 'Rest')
        : (role === 'tutor' && dayNumber % 3 === 0 ? 'Class' : (role !== 'tutor' && dayNumber % 4 === 0 ? 'Quiz' : ''));

    return `
      <div class="calendar-cell ${isToday ? 'today' : ''} ${muted ? 'is-muted' : ''}">
        <span class="calendar-date">${dayNumber}</span>
        ${pill ? `<span class="calendar-pill">${pill}</span>` : '<span></span>'}
      </div>
    `;
  };

  const render = () => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const previousLastDay = new Date(year, month, 0).getDate();
    const startIndex = firstDay.getDay();
    const totalDays = lastDay.getDate();
    const trailingCount = (7 - ((startIndex + totalDays) % 7)) % 7;
    const summaryCards = getSummaryCards(viewDate);

    let html = `
      <div class="calendar-shell calendar-shell-${role}">
        <div class="calendar-top">
          <span class="calendar-badge">${role === 'tutor' ? 'Tutor planner' : 'Student planner'}</span>
          <div class="calendar-meta">
            <span class="calendar-today-label">Today: ${today.toLocaleDateString()}</span>
            <div class="calendar-nav">
              <button type="button" data-calendar-prev aria-label="Previous month">‹</button>
              <button type="button" data-calendar-next aria-label="Next month">›</button>
            </div>
          </div>
        </div>
        <div class="calendar-head">
          <strong>${monthNames[month]} ${year}</strong>
        </div>
        <div class="calendar-grid">
          ${dayNames.map((day) => `<div class="calendar-cell is-weekday"><strong>${day}</strong></div>`).join('')}
    `;

    for (let i = 0; i < startIndex; i += 1) {
      html += buildDayCell(previousLastDay - startIndex + i + 1, true);
    }
    for (let day = 1; day <= totalDays; day += 1) {
      html += buildDayCell(day, false);
    }
    for (let i = 1; i <= trailingCount; i += 1) {
      html += buildDayCell(i, true);
    }

    html += `</div><div class="calendar-summary">${summaryCards.map((item) => `
      <div class="calendar-summary-card">
        <span>${item.label}</span>
        <strong>${item.value}</strong>
      </div>`).join('')}</div></div>`;

    target.innerHTML = html;
    target.querySelector('[data-calendar-prev]')?.addEventListener('click', () => {
      viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1);
      render();
    });
    target.querySelector('[data-calendar-next]')?.addEventListener('click', () => {
      viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
      render();
    });
  };

  render();
}

// Function: escapeHtml

// Role: Provides helper logic for this file.

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Function: setupMultiSelect

// Role: Provides helper logic for this file.

function setupMultiSelect(selectRoot) {
  const trigger = selectRoot.querySelector('[data-multi-select-trigger]');
  const menu = selectRoot.querySelector('[data-multi-select-menu]');
  const checkboxes = () => [...selectRoot.querySelectorAll('input[type="checkbox"]')];

  if (!trigger || !menu) return;

  const updateLabel = () => {
    const selectedBoxes = checkboxes().filter((input) => input.checked);
    const labels = selectedBoxes.map((input) => input.dataset.subjectLabel || input.value);
    const placeholder = trigger.dataset.placeholder || trigger.dataset.defaultLabel || trigger.textContent.trim();
    trigger.textContent = labels.length ? labels.join(', ') : placeholder;
  };

  trigger.dataset.defaultLabel = trigger.textContent.trim();

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    document.querySelectorAll('[data-multi-select].is-open').forEach((node) => {
      if (node !== selectRoot) node.classList.remove('is-open');
    });
    selectRoot.classList.toggle('is-open');
  });

  selectRoot.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  selectRoot.addEventListener('change', (event) => {
    const changedBox = event.target.closest('input[type="checkbox"]');
    if (!changedBox) return;
    if (changedBox.hasAttribute('data-single-select') && changedBox.checked) {
      checkboxes().forEach((box) => {
        if (box !== changedBox) box.checked = false;
      });
      selectRoot.classList.remove('is-open');
    }
    updateLabel();
  });

  updateLabel();
  return { updateLabel };
}

// Function: refreshMultiSelectLabel

// Role: Provides helper logic for this file.

function refreshMultiSelectLabel(selectRoot) {
  const trigger = selectRoot?.querySelector('[data-multi-select-trigger]');
  if (!selectRoot || !trigger) return;
  const selectedBoxes = [...selectRoot.querySelectorAll('input[type="checkbox"]')].filter((input) => input.checked);
  const labels = selectedBoxes.map((input) => input.dataset.subjectLabel || input.value);
  const placeholder = trigger.dataset.placeholder || trigger.dataset.defaultLabel || trigger.textContent.trim();
  trigger.textContent = labels.length ? labels.join(', ') : placeholder;
}

document.addEventListener('click', () => {
  document.querySelectorAll('[data-multi-select].is-open').forEach((node) => node.classList.remove('is-open'));
});

document.querySelectorAll('[data-calendar]').forEach(renderCalendar);
document.querySelectorAll('[data-multi-select]').forEach(setupMultiSelect);

document.querySelectorAll('[data-auto-expand]').forEach((el) => {
  const resize = () => {
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, 52)}px`;
  };
  resize();
  el.addEventListener('input', resize);
});

document.querySelectorAll('[data-assessment-builder]').forEach((form) => {
  const questionStack = form.querySelector('[data-question-stack]');
  const addButton = form.querySelector('[data-add-question]');
  const primarySubjectInput = form.querySelector('[data-primary-subject-input]');
  const primarySubjectMirror = form.querySelector('[data-primary-subject-mirror]');
  const subjectBoxes = [...form.querySelectorAll('[data-subject-option]')];
  const subjectSelect = form.querySelector('select[data-primary-subject-input]');
  const yearBoxes = [...form.querySelectorAll('[data-year-filter-option]')];
  const yearSelect = form.querySelector('select[data-year-filter-select]');
  const gradeMenu = form.querySelector('[data-grade-filter-menu]');
  const gradeSelect = form.querySelector('select[data-grade-filter-select]');
  const gradeMap = JSON.parse(form.dataset.gradeMap || '{}');
  const gradeSelectRoot = gradeMenu?.closest('[data-multi-select]');
  const gradeTrigger = gradeSelectRoot?.querySelector('[data-multi-select-trigger]');
  const typeCheckboxes = [...form.querySelectorAll('input[name="type_of_assessment"]')];

  const getAllowedTypes = () => {
    const selected = typeCheckboxes.filter((input) => input.checked).map((input) => input.value);
    return selected.length ? selected : ['Multiple Choice'];
  };

  const updateQuestionNumbers = () => {
    [...questionStack.querySelectorAll('[data-question-card]')].forEach((card, index) => {
      const title = card.querySelector('.question-card-head strong');
      if (title) title.textContent = `Question ${index + 1}`;
      const removeButton = card.querySelector('[data-remove-question]');
      if (removeButton) removeButton.hidden = index === 0;
    });
  };

  const buildDynamicFields = (type) => {
    const normalized = String(type || 'Multiple Choice').trim();
    if (normalized === 'Multiple Choice') {
      return `
        <div class="form-grid two-col">
          <label>A<input type="text" name="choice_a" required></label>
          <label>B<input type="text" name="choice_b" required></label>
          <label>C<input type="text" name="choice_c" required></label>
          <label>D<input type="text" name="choice_d" required></label>
        </div>
        <label>Correct Answer
          <select name="correct_answer" required>
            <option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option>
          </select>
        </label>`;
    }
    if (normalized === 'True or False') {
      return `
        <label>Correct Answer
          <select name="correct_answer" required>
            <option value="True">True</option>
            <option value="False">False</option>
          </select>
        </label>`;
    }
    if (normalized === 'Fill in the Blank') {
      return '<label>Correct Answer<input type="text" name="correct_answer" required></label>';
    }
    return '<label>Correct Answer<input type="text" name="correct_answer" required></label>';
  };

  const syncCardTypeUI = (card, forcedType) => {
    const picker = card.querySelector('[data-question-type-picker]');
    const hiddenType = card.querySelector('input[name="question_type"]');
    const fields = card.querySelector('[data-question-dynamic-fields]');
    const allowed = getAllowedTypes();
    const current = forcedType || hiddenType?.value || allowed[0] || 'Multiple Choice';
    const safeType = allowed.includes(current) ? current : (allowed[0] || 'Multiple Choice');
    if (hiddenType) hiddenType.value = safeType;

    if (picker) {
      if (allowed.length === 1) {
        picker.innerHTML = `<label>Question Type<input type="text" value="${escapeHtml(safeType)}" readonly></label>`;
      } else {
        picker.innerHTML = `
          <label>Question Type
            <select data-question-type-select>
              ${allowed.map((type) => `<option value="${escapeHtml(type)}" ${type === safeType ? 'selected' : ''}>${escapeHtml(type)}</option>`).join('')}
            </select>
          </label>`;
        const select = picker.querySelector('[data-question-type-select]');
        select?.addEventListener('change', () => syncCardTypeUI(card, select.value));
      }
    }

    if (fields) fields.innerHTML = buildDynamicFields(safeType);
  };

  const buildQuestionCard = (forcedType = null) => {
    const allowed = getAllowedTypes();
    const defaultType = forcedType || allowed[0] || 'Multiple Choice';
    const block = document.createElement('div');
    block.className = 'assessment-question-card';
    block.setAttribute('data-question-card', '');
    block.innerHTML = `
      <div class="question-card-head">
        <strong>Question</strong>
        <button type="button" class="btn btn-secondary btn-sm" data-remove-question>Cancel Question</button>
      </div>
      <div class="question-type-picker" data-question-type-picker></div>
      <label>Question<textarea name="question_text" rows="2" required></textarea></label>
      <input type="hidden" name="question_type" value="${escapeHtml(defaultType)}" />
      <div class="question-dynamic-fields" data-question-dynamic-fields></div>
    `;
    syncCardTypeUI(block, defaultType);
    return block;
  };

  const renderGradeOptions = () => {
    const selectedYearLevels = yearSelect ? [yearSelect.value].filter(Boolean) : yearBoxes.filter((input) => input.checked).map((input) => input.value);
    const gradeOptions = [...new Set(selectedYearLevels.flatMap((level) => gradeMap[level] || []))];
    if (gradeSelect) {
      const previousValue = gradeSelect.value;
      if (!gradeOptions.length) {
        gradeSelect.innerHTML = '<option value="">Select year level first</option>';
        return;
      }
      gradeSelect.innerHTML = ['<option value="">Select grade level</option>']
        .concat(gradeOptions.map((grade) => `<option value="${escapeHtml(grade)}"${previousValue === grade ? ' selected' : ''}>${escapeHtml(grade)}</option>`))
        .join('');
      return;
    }
    if (!gradeMenu) return;
    const selectedGradeValues = [...gradeMenu.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
    if (!gradeOptions.length) {
      gradeMenu.innerHTML = '<p class="empty-state">Select year level first.</p>';
      if (gradeTrigger && gradeTrigger.dataset.defaultLabel) gradeTrigger.textContent = gradeTrigger.dataset.defaultLabel;
      return;
    }
    gradeMenu.innerHTML = gradeOptions.map((grade) => {
      const checked = selectedGradeValues.includes(grade) ? ' checked' : '';
      return `<label><input type="checkbox" name="target_grade_levels" value="${escapeHtml(grade)}"${checked} /><span>${escapeHtml(grade)}</span></label>`;
    }).join('');
    refreshMultiSelectLabel(gradeSelectRoot);
  };

  addButton?.addEventListener('click', () => {
    const allowed = getAllowedTypes();
    questionStack.appendChild(buildQuestionCard(allowed[0] || 'Multiple Choice'));
    updateQuestionNumbers();
  });

  questionStack?.addEventListener('click', (event) => {
    const removeButton = event.target.closest('[data-remove-question]');
    if (!removeButton) return;
    const card = removeButton.closest('[data-question-card]');
    if (!card) return;
    card.remove();
    updateQuestionNumbers();
  });

  typeCheckboxes.forEach((input) => {
    input.addEventListener('change', () => {
      if (!getAllowedTypes().length) input.checked = true;
      [...questionStack.querySelectorAll('[data-question-card]')].forEach((card) => syncCardTypeUI(card));
    });
  });

  if (subjectSelect) {
    subjectSelect.addEventListener('change', () => {
      if (primarySubjectMirror) primarySubjectMirror.value = subjectSelect.value || '';
    });
  } else {
    subjectBoxes.forEach((input) => {
      input.addEventListener('change', () => {
        if (input.checked) {
          subjectBoxes.forEach((box) => { if (box !== input) box.checked = false; });
          if (primarySubjectInput) primarySubjectInput.value = input.value;
        } else if (primarySubjectInput && primarySubjectInput.value === input.value) {
          primarySubjectInput.value = '';
        }
      });
    });
  }

  if (yearSelect) yearSelect.addEventListener('change', renderGradeOptions);
  yearBoxes.forEach((input) => input.addEventListener('change', renderGradeOptions));

  form.addEventListener('submit', (event) => {
    const selectedSubject = subjectSelect ? { value: subjectSelect.value } : subjectBoxes.find((input) => input.checked);
    if (!selectedSubject || !selectedSubject.value) {
      event.preventDefault();
      if (typeof showSimpleModal === 'function') {
        showSimpleModal('Validation', 'Please select one subject before creating the assessment template.');
      } else {
        window.alert('Please select one subject before creating the assessment template.');
      }
      return;
    }
    if (primarySubjectInput) primarySubjectInput.value = selectedSubject.value;
    if (primarySubjectMirror) primarySubjectMirror.value = selectedSubject.value;
  });

  renderGradeOptions();
  [...questionStack.querySelectorAll('[data-question-card]')].forEach((card) => syncCardTypeUI(card));
  updateQuestionNumbers();
});

document.querySelectorAll('[data-assessment-builder]').forEach((form) => {
  const textInput = form.querySelector('[data-assessment-student-text]');
  const hiddenId = form.querySelector('[data-assessment-student-id]');
  const branchInput = form.querySelector('[data-assessment-branch-name]');
  const options = [...form.querySelectorAll('#assessment-students option')];
  const sync = () => {
    const match = options.find((opt) => opt.value === textInput?.value);
    if (match) {
      if (hiddenId) hiddenId.value = match.dataset.id || '';
      if (branchInput) branchInput.value = match.dataset.branchName || '';
    }
  };
  textInput?.addEventListener('change', sync);
  textInput?.addEventListener('input', sync);
  sync();
});
